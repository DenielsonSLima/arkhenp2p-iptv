import test from 'node:test';
import assert from 'node:assert/strict';
import { createOriginalEngine, localPlaylist, numericDiagnostics } from './engine.mjs';

function fixture(options = {}) {
  const calls = [], callbackCalls = [];
  function method(fn = () => {}) {
    return { implementation: null, call(self, ...args) { return fn.apply(self, args); },
      invoke(self, ...args) { return (this.implementation ?? fn).apply(self, args); } };
  }
  const callbacks = Object.fromEntries(['onInfo', 'onInited', 'onPrepared', 'onQuit', 'onStart', 'onStop']
    .map(name => [name, method(function () { callbackCalls.push(name); return 'original-result'; })]));
  const Listener = Object.fromEntries(Object.entries(callbacks).map(([name, m]) => [name, { overload: () => m }]));
  const callback = (name, value) => callbacks[name].invoke({}, JSON.stringify(value));
  let autoPrepare = true, autoStop = true, stopPayload = { errno: '0' };
  const startOne = method(uri => {
    calls.push('start');
    if (autoPrepare) queueMicrotask(() => {
      callback('onStart', { peers: '3' });
      callback('onPrepared', { hls: 'http://127.0.0.1:8902/123/index.m3u8', secret: 'DO_NOT_RETURN' });
    });
  });
  const stop = method(() => { calls.push('stop'); if (autoStop) queueMicrotask(() => callback('onStop', stopPayload)); });
  const instance = { tvListener: { value: { getClass: () => ({ getName: () => 'fixture.Listener' }) } }, $dispose() {} };
  const Core = { inst: { value: instance }, nativeHandle: { value: 1 },
    start: { overload: (...args) => args.length === 1 ? startOne : method() },
    stop: { overload: (...args) => args.length === 0 ? stop : method() } };
  const Auth = { d: { value: { code: { value: 0 }, user: { value: { user_name: { value: 'fixture@wareztv.io' } } } } } };
  Auth.class = { getDeclaredField: name => {
    assert.equal(name, 'd'); return { get: target => { assert.equal(target, null); return Auth.d.value; } };
  } };
  const Java = { available: true, perform: fn => fn(), retain: x => x, cast: x => x,
    use: name => name === 'com.tvbus.engine.TVCore' ? Core : name === 'td.m' ? Auth : Listener };
  return { engine: createOriginalEngine(Java, options), calls, callbackCalls, callback, Core, Auth,
    externalStart: () => startOne.invoke(instance, 'tvbus://different-channel'),
    noAutoPrepare: () => { autoPrepare = false; }, noAutoStop: () => { autoStop = false; },
    stopPayload: value => { stopPayload = value; } };
}

test('fixed local playlist validation excludes other files, traversal and authorities', () => {
  assert.deepEqual(localPlaylist('http://127.0.0.1:8902/123/main.m3u8'),
    { hls: 'http://127.0.0.1:8902/123/main.m3u8', channelId: 123 });
  for (const value of ['http://127.0.0.1:8902/mpegts_live', 'http://127.0.0.1:8902/123/index.m3u8?key=secret',
    'http://localhost:8902/123/index.m3u8', 'http://127.0.0.1:62731/123/index.m3u8',
    'http://127.0.0.1:8902/4294967296/index.m3u8', 'http://127.0.0.1:8902/123/../index.m3u8']) {
    assert.equal(localPlaylist(value), null);
  }
});

test('diagnostics return only numeric values on explicit fields', () => {
  assert.deepEqual(numericDiagnostics({ auth: '0', errno: '-120', peers: 'http://secret', uri: 'secret', tvcore: {} }),
    { auth: 0, errno: -120 });
});

test('preserves original callbacks, fences start with stop, returns HLS only from start', async () => {
  const f = fixture();
  await f.engine.attach();
  assert.equal(f.callback('onInfo', { uri: 'private-value' }), 'original-result');
  const result = await f.engine.start({ requestId: 'r1', uri: 'tvbus://test-only' });
  assert.deepEqual(f.calls, ['stop', 'start']);
  assert.deepEqual(f.callbackCalls, ['onInfo', 'onStop', 'onStart', 'onPrepared']);
  assert.equal(result.channelId, 123);
  assert.equal(result.requestId, 'r1');
  assert.ok(!JSON.stringify(result).includes('DO_NOT_RETURN'));
  const status = f.engine.status();
  assert.equal(status.state, 'playing');
  assert.ok(!JSON.stringify(status).includes('http'));
  await assert.rejects(f.engine.stop('wrong'), /REQUEST_NOT_OWNER/);
  await f.engine.stop('r1');
  assert.equal(f.engine.status().state, 'idle');
  await f.engine.detach();
});

test('external channel change revokes current request and stale callbacks cannot restore it', async () => {
  const f = fixture();
  await f.engine.attach();
  await f.engine.start({ requestId: 'r1', uri: 'tvbus://test-only' });
  f.externalStart();
  await Promise.resolve();
  assert.equal(f.engine.status().state, 'invalidated');
  assert.equal(f.engine.status().requestId, null);
  assert.equal(f.engine.status().channelId, null);
  await assert.rejects(f.engine.stop('r1'), /REQUEST_NOT_OWNER/);
  await f.engine.detach();
});

test('callback without onStart cannot release media; stop rejection remains explicit', async () => {
  const f = fixture();
  f.noAutoPrepare();
  await f.engine.attach();
  const result = f.engine.start({ requestId: 'r2', uri: 'tvbus://test-only' });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  f.callback('onPrepared', { hls: 'http://127.0.0.1:8902/123/index.m3u8' });
  assert.equal(f.engine.status().state, 'starting');
  f.callback('onStop', { errno: '-120' });
  await assert.rejects(result, /NATIVE_ENGINE_CERTIFICATION_REQUIRED/);
  assert.equal(f.engine.status().channelId, null);
  await f.engine.detach();
});

test('attaching to an uninitialized app does not create an engine', async () => {
  const f = fixture();
  f.Core.inst.value = null;
  await assert.rejects(f.engine.attach(), /ENGINE_NOT_INITIALIZED/);
  assert.deepEqual(f.calls, []);
});

test('account verification checks the accepted original response and exports only a boolean', async () => {
  const f = fixture();
  await f.engine.attach();
  assert.equal(await f.engine.verifyAccount(' fixture '), true);
  assert.equal(await f.engine.verifyAccount('other'), false);
  f.Auth.d.value.code.value = -10;
  assert.equal(await f.engine.verifyAccount('fixture'), false);
  assert.equal(JSON.stringify(f.engine.status()).includes('fixture'), false);
  await f.engine.detach();
});

test('failed preparation retains owned cleanup identity until the stop callback', async () => {
  const f = fixture(); f.noAutoPrepare();
  await f.engine.attach();
  const pending = f.engine.start({ requestId: 'failed-start', uri: 'tvbus://test-only' });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  f.callback('onStart', {});
  f.callback('onPrepared', { hls: 'http://external.invalid/video' });
  await assert.rejects(pending, /LOCAL_HLS_UNAVAILABLE/);
  assert.equal(f.engine.status().requestId, 'failed-start');
  assert.equal(f.engine.status().channelId, null);
  await f.engine.stop('failed-start');
  assert.deepEqual(f.calls, ['stop', 'start', 'stop']);
  assert.equal(f.engine.status().requestId, null);
  await f.engine.detach();
});

test('scalar stop callbacks release the fence and safe shape diagnostics omit payload values', async () => {
  const f = fixture(); f.stopPayload(0);
  await f.engine.attach();
  await f.engine.start({ requestId: 'r-scalar', uri: 'tvbus://test-only' });
  f.callback('onInfo', { uri: 'private-source', token: 'private-token', peers: '2' });
  const status = f.engine.status();
  assert.equal(status.callbackCounts.onStop, 1);
  assert.deepEqual(status.callbackShapes.onStop, { format: 'number', fields: {}, scalarNumber: 0 });
  assert.equal(status.callbackShapes.onInfo.fields.peers, 'numeric-string');
  assert.equal(JSON.stringify(status).includes('private'), false);
  await f.engine.stop('r-scalar'); await f.engine.detach();
});

test('native queue acknowledgement releases an idle stop without a fabricated callback', async () => {
  let onIdle, armed = false, disposed = false;
  const f = fixture({ idleObserverFactory: (handle, acknowledge) => {
    assert.equal(handle, '1'); onIdle = acknowledge;
    return { arm() { assert.equal(f.calls.at(-1), 'stop'); armed = true; },
      cancel() { armed = false; }, close() { disposed = true; }, status() { return { buildVerified: true }; } };
  } });
  f.noAutoStop(); await f.engine.attach();
  const pending = f.engine.start({ requestId: 'idle-start', uri: 'tvbus://test-only' });
  await Promise.resolve();
  assert.equal(armed, true);
  assert.deepEqual(f.calls, ['stop']);
  onIdle({ state: 1, consumed: true });
  await pending;
  assert.deepEqual(f.calls, ['stop', 'start']);
  assert.equal(f.engine.status().callbackCounts.onStop, undefined);
  const stopping = f.engine.stop('idle-start');
  await Promise.resolve(); onIdle({ state: 1, consumed: true });
  await stopping; await f.engine.detach();
  assert.equal(disposed, true);
});

test('direct TS readiness waits for the later channel-bound HLS callback', async () => {
  const f = fixture(); f.noAutoPrepare(); await f.engine.attach();
  const pending = f.engine.start({ requestId: 'hls-after-ts', uri: 'tvbus://test-only' });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  f.callback('onStart', {});
  f.callback('onPrepared', { http: 'http://127.0.0.1:8902/mpegts_live', expr: '0' });
  assert.equal(f.engine.status().state, 'starting');
  assert.equal(f.engine.status().channelId, null);
  assert.equal(JSON.stringify(f.engine.status()).includes('mpegts_live'), false);
  f.callback('onPrepared', { hls: 'http://127.0.0.1:8902/456/main.m3u8' });
  assert.equal((await pending).channelId, 456);
  await f.engine.stop('hls-after-ts'); await f.engine.detach();
});
