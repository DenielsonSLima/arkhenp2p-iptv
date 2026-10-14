import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { NativeBridgeClient } from '../lib/native-bridge.mjs';
import { readBody } from '../lib/upstream.mjs';

async function fixture(t) {
  const key = 'fixture-key-that-is-longer-than-thirty-two-bytes';
  let state = 'awaiting_configuration', playUrl = '', diagnostics = {}, redirect = false, startFailure = null;
  const calls = [], mediaCalls = [];
  const media = http.createServer((req, res) => { mediaCalls.push(req.headers); res.end('#EXTM3U\nsegment.ts\n'); });
  media.listen(0, '127.0.0.1'); await once(media, 'listening');
  const control = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    calls.push({ path: req.url, body: text ? JSON.parse(text) : undefined, headers: req.headers });
    if (redirect) { res.writeHead(302, { location: `http://127.0.0.1:${media.address().port}/collect` }).end(); return; }
    if (req.headers['x-bridge-key'] !== key) { res.writeHead(401).end(); return; }
    if (req.url === '/configure') { state = 'initialized'; diagnostics = { auth: 0, tvcore: 0, arbitrary: 'private-value', errorClass: 'Injected URI http://secret' }; }
    if (req.url === '/start') {
      state = startFailure ? 'playback_failed' : 'prepared';
      playUrl = startFailure ? '' : `http://127.0.0.1:${media.address().port}/1234/main.m3u8`;
      if (startFailure) diagnostics = startFailure;
    }
    if (req.url === '/stop') { state = 'stopped'; playUrl = ''; }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ state, diagnostics, playUrl, nativeLoaded: true }));
  });
  control.listen(0, '127.0.0.1'); await once(control, 'listening');
  t.after(async () => { control.closeAllConnections(); media.closeAllConnections(); await Promise.all([new Promise(resolve => control.close(resolve)), new Promise(resolve => media.close(resolve))]); });
  const bridge = new NativeBridgeClient({ key, controlPort: control.address().port, playPort: media.address().port });
  return { bridge, calls, mediaCalls, mediaPort: media.address().port, redirect: () => { redirect = true; }, failStart: value => { startFailure = value; }, setState: (next, nextDiagnostics) => { state = next; diagnostics = nextDiagnostics; } };
}

test('native bridge keeps SDK credentials in authenticated control requests and restricts media to the prepared stream', async t => {
  const f = await fixture(t);
  await f.bridge.configure({ authUrl: 'https://example.com/sdk-auth', username: 'fixture@wareztv.io', password: 'synthetic-secret' });
  assert.equal(f.calls[0].body.authUrl, 'https://example.com/sdk-auth');
  assert.deepEqual((await f.bridge.status()).diagnostics, { auth: 0, tvcore: 0 });
  const source = await f.bridge.start('tvbus://registered-fixture');
  assert.equal(source.pathname, '/1234/main.m3u8');
  assert.equal(f.bridge.acceptsMediaURL(`http://127.0.0.1:${f.mediaPort}/1234/segment.ts`), true);
  for (const path of ['/12345/segment.ts', '/1234/../private', '/1234/%2fprivate']) assert.equal(f.bridge.acceptsMediaURL(`http://127.0.0.1:${f.mediaPort}${path}`), false);
  assert.equal(f.bridge.acceptsMediaURL('http://127.0.0.1:62731/status'), false);
  assert.equal(f.bridge.acceptsMediaURL('https://example.com/1234/main.m3u8'), false);
  assert.match((await readBody(await f.bridge.fetchMedia(source))).toString(), /^#EXTM3U/);
  assert.equal(f.mediaCalls[0]['x-bridge-key'], undefined);
  assert.equal(f.mediaCalls[0].authorization, undefined);
  await f.bridge.stop();
  assert.equal(f.bridge.acceptsMediaURL(source), false);
  await assert.rejects(f.bridge.fetchMedia(source), { code: 'NATIVE_SOURCE_INVALID' });
});

test('native control does not follow redirects carrying the private key', async t => {
  const f = await fixture(t); f.redirect();
  await assert.rejects(f.bridge.status(), { code: 'NATIVE_BRIDGE_UNAVAILABLE' });
  assert.equal(f.mediaCalls.length, 0);
});

test('native bridge rejects non-catalog protocols before making control requests', async t => {
  const f = await fixture(t);
  for (const source of ['http://example.com/video', 'tvbus://with\nnewline', 'file:///etc/passwd']) await assert.rejects(f.bridge.start(source), { code: 'NATIVE_SOURCE_INVALID' });
  assert.equal(f.calls.length, 0);
});

test('native diagnostics omit arbitrary payloads and invalid error class strings', async t => {
  const f = await fixture(t); f.setState('authentication_failed', { auth: -205, errno: 'private-token', peers: 2, password: 'synthetic-secret', errorClass: 'java.lang.IllegalStateException',
    callbackShapes: { inited: { format: 'object', fields: { auth: 'numeric-string', data: 'object', password: 'synthetic-secret', 'http://secret': 'string' }, scalarNumber: 'private-token' }, unexpected: { format: 'string', fields: {} } } });
  const status = await f.bridge.status();
  assert.deepEqual(status.diagnostics, { auth: -205, peers: 2, errorClass: 'java.lang.IllegalStateException', callbackShapes: { inited: { format: 'object', fields: { auth: 'numeric-string', data: 'object' } } } });
  assert.equal(JSON.stringify(status).includes('synthetic-secret'), false);
});

test('native playback distinguishes SDK certificate rejection from account authentication and other errors', async t => {
  for (const [name, diagnostics, code, message] of [
    ['authenticated account', { auth: 0, tvcore: 0, errno: -120 }, 'NATIVE_ENGINE_CERTIFICATION_REQUIRED', /^Seu usuário e sua senha foram aceitos, mas a engine P2P não está autorizada para este aplicativo/],
    ['unconfirmed account', { errno: -120 }, 'NATIVE_ENGINE_CERTIFICATION_REQUIRED', /^A engine P2P não está autorizada para este aplicativo/],
    ['invalid source', { auth: 0, tvcore: 0, errno: -130 }, 'NATIVE_ENGINE_FAILED', /código -130/]
  ]) await t.test(name, async t => {
    const f = await fixture(t);
    await f.bridge.configure({ authUrl: 'https://example.com/sdk-auth', username: 'fixture@wareztv.io', password: 'synthetic-secret' });
    f.failStart(diagnostics);
    await assert.rejects(f.bridge.start('tvbus://registered-fixture'), failure => {
      assert.equal(failure.code, code);
      assert.match(failure.message, message);
      assert.equal(failure.message.includes('synthetic-secret'), false);
      return true;
    });
    assert.equal(f.calls.filter(call => call.path === '/start').length, 1);
    assert.equal(f.bridge.acceptsMediaURL(`http://127.0.0.1:${f.mediaPort}/1234/segment.ts`), false);
    assert.equal(f.mediaCalls.length, 0);
  });
});
