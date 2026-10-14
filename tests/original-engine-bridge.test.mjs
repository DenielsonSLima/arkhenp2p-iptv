import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { OriginalEngineBridge } from '../lib/original-engine-bridge.mjs';
import { OriginalEngineRPC } from '../lib/original-engine-rpc.mjs';
import { NativeBridgeManager } from '../lib/native-bridge-manager.mjs';
import { readBody } from '../lib/upstream.mjs';

async function fixture(t) {
  const calls = [], mediaCalls = [];
  let account = true, current = null, channel = 123, wrongResult = null, redirect = false, hold = false;
  const media = http.createServer((req, res) => {
    mediaCalls.push(req.headers);
    if (redirect) return res.writeHead(302, { Location: 'http://127.0.0.1:62731/status' }).end();
    if (hold) { res.writeHead(200); res.write('#EXTM3U\n'); return; }
    res.end('#EXTM3U\nhls-seg-1.ts\n');
  });
  media.listen(0, '127.0.0.1'); await once(media, 'listening');
  const rpc = {
    closed: false,
    async ready() { return { attached: true }; },
    async call(op, values = {}) {
      calls.push({ op, values });
      if (op === 'verifyAccount') return account;
      if (op === 'status') return current || { attached: true, state: 'idle' };
      if (op === 'start') {
        current = { attached: true, state: 'playing', requestId: values.requestId, channelId: channel, identity: 'serialized-start-callback' };
        return { ...current, hls: 'http://127.0.0.1:8902/' + channel + '/index.m3u8', ...wrongResult };
      }
      if (op === 'stop') { current = null; return { stopped: true }; }
    },
    async close() { this.closed = true; current = null; },
  };
  const bridge = new OriginalEngineBridge({ mediaPort: media.address().port, rpcFactory: () => rpc });
  t.after(async () => { await bridge.shutdown(); media.closeAllConnections(); await new Promise(resolve => media.close(resolve)); });
  return { bridge, rpc, calls, mediaCalls,
    account: value => { account = value; }, external: () => { current = { attached: true, state: 'invalidated', requestId: null }; },
    channel: value => { channel = value; }, result: value => { wrongResult = value; },
    redirect: () => { redirect = true; }, hold: () => { hold = true; } };
}

test('requires original accepted account, never sends password, auth URL or control key', async t => {
  const f = await fixture(t); f.account(false);
  await assert.rejects(f.bridge.configure({ username: 'fixture', password: 'private-password', authUrl: 'https://secret.example', key: 'private-key' }), { code: 'NATIVE_ACCOUNT_MISMATCH' });
  assert.equal(f.rpc.closed, false);
  assert.deepEqual(f.calls, [{ op: 'verifyAccount', values: { username: 'fixture' } }]);
  await assert.rejects(f.bridge.start('tvbus://fixture'), { code: 'ENGINE_NOT_INITIALIZED' });
});

test('translates only verified original HLS and restricts media to known paths of its current channel', async t => {
  const f = await fixture(t);
  await f.bridge.configure({ username: 'fixture', password: 'private-password' });
  const source = await f.bridge.start('tvbus://private-channel');
  assert.equal(source.pathname, '/123/index.m3u8');
  assert.notEqual(source.port, '8902');
  const segment = new URL('hls-seg-1.ts', source);
  assert.equal(f.bridge.acceptsMediaURL(segment), true);
  for (const path of ['/124/index.m3u8', '/123/private', '/123/%2fsecret', '/123/main.m3u8?key=secret', '/123/segment.ts']) {
    assert.equal(f.bridge.acceptsMediaURL(new URL(path, source)), false);
  }
  assert.equal(f.bridge.acceptsMediaURL('http://127.0.0.1:8902/123/index.m3u8'), false);
  assert.match((await readBody(await f.bridge.fetchMedia(source))).toString(), /^#EXTM3U/);
  for (const name of ['authorization', 'x-bridge-key', 'cookie']) assert.equal(f.mediaCalls[0][name], undefined);
  assert.equal(JSON.stringify(await f.bridge.status()).includes('http'), false);
  await f.bridge.stop();
  assert.equal(f.bridge.acceptsMediaURL(source), false);
  await assert.rejects(f.bridge.fetchMedia(segment), { code: 'NATIVE_SOURCE_INVALID' });
});

test('rejects stale/mismatched callbacks and redirects without fetching their destination', async t => {
  const f = await fixture(t);
  await f.bridge.configure({ username: 'fixture' });
  f.result({ requestId: 'old-request' });
  await assert.rejects(f.bridge.start('tvbus://fixture'), { code: 'NATIVE_SOURCE_INVALID' });
  assert.equal(f.mediaCalls.length, 0);
  f.result(null);
  const source = await f.bridge.start('tvbus://fixture');
  f.redirect();
  await assert.rejects(f.bridge.fetchMedia(source), { code: 'NATIVE_SOURCE_INVALID' });
  assert.equal(f.mediaCalls.length, 1);
});

test('checks external channel and account changes before reading media', async t => {
  const f = await fixture(t);
  await f.bridge.configure({ username: 'fixture' });
  const first = await f.bridge.start('tvbus://fixture');
  f.external();
  await assert.rejects(f.bridge.fetchMedia(first), { code: 'EXTERNAL_CHANNEL_CHANGE' });
  assert.equal(f.bridge.acceptsMediaURL(first), false);
  const second = await f.bridge.start('tvbus://fixture');
  f.account(false);
  await assert.rejects(f.bridge.fetchMedia(second), { code: 'NATIVE_ACCOUNT_MISMATCH' });
  assert.equal(f.mediaCalls.length, 0);
});

test('stop revokes and aborts an in-flight media body', async t => {
  const f = await fixture(t);
  await f.bridge.configure({ username: 'fixture' });
  const source = await f.bridge.start('tvbus://fixture'); f.hold();
  const response = await f.bridge.fetchMedia(source);
  const reading = readBody(response);
  const rejected = assert.rejects(reading);
  await f.bridge.stop();
  await rejected;
  assert.equal(f.bridge.acceptsMediaURL(source), false);
});

test('aborting the playback owner revokes the prepared URL and stops owned playback', async t => {
  const f = await fixture(t), controller = new AbortController();
  await f.bridge.configure({ username: 'fixture' });
  const source = await f.bridge.start('tvbus://fixture', { signal: controller.signal });
  controller.abort();
  assert.equal(f.bridge.acceptsMediaURL(source), false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.filter(call => call.op === 'stop').length, 1);
});

test('manager isolates accounts and channel generations when used with the optional adapter', async t => {
  const f = await fixture(t), owner = {}, stranger = {};
  const manager = new NativeBridgeManager({ client: f.bridge });
  const first = await manager.start(owner, { username: 'fixture' }, 'tvbus://one');
  await assert.rejects(manager.start(stranger, { username: 'fixture' }, 'tvbus://two'), { code: 'NATIVE_BRIDGE_BUSY' });
  await assert.rejects(manager.fetchMedia(stranger, first), { code: 'NATIVE_SOURCE_INVALID' });
  f.channel(456);
  const second = await manager.start(owner, { username: 'fixture' }, 'tvbus://two');
  assert.equal(manager.acceptsMediaURL(owner, first), false);
  assert.equal(manager.acceptsMediaURL(owner, second), true);
  await manager.close(owner);
  assert.equal(manager.acceptsMediaURL(owner, second), false);
});

function fakeChild(respond) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.exitCode = null; child.killed = [];
  child.stdin = new Writable({ write(chunk, encoding, done) { respond(JSON.parse(chunk), child); done(); } });
  child.kill = signal => { child.killed.push(signal); child.exitCode = 0; queueMicrotask(() => child.emit('exit', 0)); return true; };
  child.reply = value => child.stdout.write(JSON.stringify(value) + '\n');
  queueMicrotask(() => child.reply({ ok: true, event: 'attached', result: { attached: true } }));
  return child;
}

test('JSONL transport keeps private values off argv/env and sanitizes remote exceptions', async () => {
  let spawned;
  const child = fakeChild((request, child) => child.reply({ ok: false, error: 'exception with private-password http://secret' }));
  const rpc = new OriginalEngineRPC({ cleanupGraceMs: 5, spawnProcess: (...args) => { spawned = args; return child; } });
  await rpc.ready();
  await assert.rejects(rpc.call('verifyAccount', { username: 'fixture' }), { code: 'ENGINE_RPC_FAILED' });
  assert.equal(spawned[2].shell, false);
  assert.deepEqual(spawned[2].stdio, ['pipe', 'pipe', 'ignore']);
  assert.deepEqual(Object.keys(spawned[2].env), ['PYTHONDONTWRITEBYTECODE', 'PYTHONNOUSERSITE']);
  assert.equal(JSON.stringify(spawned).includes('fixture'), false);
  await rpc.close();
  assert.deepEqual(child.killed, ['SIGINT']);
});

test('JSONL cancellation drains its response without unloading the original engine', async () => {
  const child = fakeChild(() => {});
  const rpc = new OriginalEngineRPC({ cleanupGraceMs: 5, spawnProcess: () => child });
  await rpc.ready();
  const controller = new AbortController();
  const result = rpc.call('start', { uri: 'tvbus://private-channel' }, { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(result, { code: 'PLAYBACK_CANCELLED' });
  assert.equal(rpc.closed, false);
  assert.deepEqual(child.killed, []);
  child.reply({ ok: true, op: 'start', result: {} });
  const status = rpc.call('status');
  await new Promise(resolve => setImmediate(resolve));
  child.reply({ ok: true, op: 'status', result: { attached: true } });
  assert.deepEqual(await status, { attached: true });
  await rpc.close();
  await assert.rejects(rpc.call('status'), { code: 'ENGINE_CONTROL_CLOSED' });
  assert.deepEqual(child.killed, ['SIGINT']);
});

test('an idle JSONL client receives EOF and exits without an interrupt', async () => {
  const child = fakeChild(() => {});
  child.stdin.once('finish', () => {
    child.exitCode = 0;
    queueMicrotask(() => child.emit('exit', 0));
  });
  const rpc = new OriginalEngineRPC({ cleanupGraceMs: 10, spawnProcess: () => child });
  await rpc.ready();
  await rpc.close();
  assert.equal(child.stdin.writableEnded, true);
  assert.deepEqual(child.killed, []);
});

test('a queued channel switch stops a cancelled pending start and keeps the same engine attached', async () => {
  const children = [];
  let starts = 0, notifyFirst, finishFirst;
  const firstRequested = new Promise(resolve => { notifyFirst = resolve; });
  const bridge = new OriginalEngineBridge({ rpcFactory: () => new OriginalEngineRPC({
    cleanupGraceMs: 5,
    spawnProcess: () => {
      let current = { attached: true, state: 'observing' };
      const child = fakeChild((request, child) => {
        let result;
        if (request.op === 'verifyAccount') result = true;
        else if (request.op === 'status') result = current;
        else if (request.op === 'stop') { current = { attached: true, state: 'idle' }; result = current; }
        else if (request.op === 'start') {
          starts++;
          if (starts === 1) {
            finishFirst = () => {
              current = { attached: true, state: 'playing', requestId: request.requestId, channelId: 123, identity: 'serialized-start-callback' };
              child.reply({ ok: true, op: request.op, result: { ...current, hls: 'http://127.0.0.1:8902/123/index.m3u8' } });
            };
            notifyFirst(); return;
          }
          current = { attached: true, state: 'playing', requestId: request.requestId, channelId: 456, identity: 'serialized-start-callback' };
          result = { ...current, hls: 'http://127.0.0.1:8902/456/index.m3u8' };
        }
        child.reply({ ok: true, op: request.op, result });
      });
      children.push(child); return child;
    },
  }) });
  const manager = new NativeBridgeManager({ client: bridge }), owner = {};
  try {
    const first = manager.start(owner, { username: 'fixture' }, 'tvbus://one');
    const cancelled = assert.rejects(first, { code: 'PLAYBACK_CANCELLED' });
    await firstRequested;
    const second = manager.start(owner, { username: 'fixture' }, 'tvbus://two');
    await cancelled;
    finishFirst();
    const source = await second;
    assert.equal(source.pathname, '/456/index.m3u8');
    assert.equal(children.length, 1);
    assert.deepEqual(children[0].killed, []);
    assert.equal(manager.acceptsMediaURL(owner, source), true);
  } finally { await manager.shutdown(); }
});

test('logout revokes playback and account while reusing the engine for a verified next session', async t => {
  const f = await fixture(t), manager = new NativeBridgeManager({ client: f.bridge });
  const firstOwner = {}, nextOwner = {};
  const first = await manager.start(firstOwner, { username: 'first' }, 'tvbus://one');
  await manager.close(firstOwner);
  assert.equal(f.rpc.closed, false);
  assert.equal(f.calls.filter(call => call.op === 'stop').length, 1);
  await assert.rejects(f.bridge.start('tvbus://two'), { code: 'ENGINE_NOT_INITIALIZED' });
  assert.equal(manager.acceptsMediaURL(firstOwner, first), false);
  f.account(false);
  await assert.rejects(manager.start(nextOwner, { username: 'other' }, 'tvbus://two'), { code: 'NATIVE_ACCOUNT_MISMATCH' });
  assert.equal(f.rpc.closed, false);
  f.account(true); f.channel(456);
  const second = await manager.start(nextOwner, { username: 'first' }, 'tvbus://two');
  assert.equal(manager.acceptsMediaURL(firstOwner, second), false);
  assert.equal(manager.acceptsMediaURL(nextOwner, second), true);
  await manager.shutdown();
  assert.equal(f.rpc.closed, true);
  assert.equal(manager.acceptsMediaURL(nextOwner, second), false);
});
