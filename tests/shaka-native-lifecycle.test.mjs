import test from 'node:test';
import assert from 'node:assert/strict';
import {createShakaHlsClass} from '../web/player/motores/shaka/index.js';
import {readNativePlaybackFailure} from '../web/player/motores/shaka/erros-nativos.js';

const origin = 'http://localhost';
const source = origin + '/api/play/movie/123.mp4?attempt=opening_1';
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve};};
const HlsClass = {Events: {ERROR: 'error', MEDIA_ATTACHED: 'attached', MEDIA_DETACHED: 'detached', DESTROYING: 'destroying', MANIFEST_LOADING: 'loading', MANIFEST_PARSED: 'parsed'},
  ErrorTypes: {NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError', OTHER_ERROR: 'otherError'},
  ErrorDetails: {FRAG_LOAD_ERROR: 'fragLoadError', LEVEL_LOAD_ERROR: 'levelLoadError', MANIFEST_LOAD_ERROR: 'manifestLoadError', BUFFER_APPEND_ERROR: 'bufferAppendError', INTERNAL_EXCEPTION: 'internalException'}};

class Media extends EventTarget {
  src = ''; srcObject = null; currentTime = 0; pauses = 0; loads = 0;
  getAttribute(name) { return name === 'src' ? this.src : null; }
  removeAttribute(name) { if (name === 'src') this.src = ''; }
  pause() { this.pauses++; }
  load() { this.loads++; }
}

function fixture({readNativeFailure, destroyGate} = {}) {
  const players = [];
  class Player extends EventTarget {
    static LoadMode = {SRC_EQUALS: 3};
    static isBrowserSupported() { return true; }
    constructor() {
      super(); players.push(this);
      this.network = {requests: new Set(), responses: new Set(),
        registerRequestFilter: fn => this.network.requests.add(fn), registerResponseFilter: fn => this.network.responses.add(fn),
        unregisterRequestFilter: fn => this.network.requests.delete(fn), unregisterResponseFilter: fn => this.network.responses.delete(fn)};
    }
    async attach(media) { this.media = media; }
    configure() {}
    async load(url) { this.url = url; this.media.src = url; }
    getLoadMode() { return Player.LoadMode.SRC_EQUALS; }
    getNetworkingEngine() { return this.network; }
    getVariantTracks() { return []; }
    getTextTracks() { return []; }
    async destroy() {
      this.destroys = (this.destroys || 0) + 1;
      if (destroyGate) {
        await destroyGate.promise;
        // A pending native setup may assign src before destroy settles.
        this.media.src = this.url;
      }
    }
    error(error) { const event = new Event('error'); event.detail = error; this.dispatchEvent(event); }
  }
  const shaka = {Player, util: {Error: {Code: {VIDEO_ERROR: 3016, BAD_HTTP_STATUS: 1001},
    Category: {MEDIA: 3, NETWORK: 1}, Severity: {RECOVERABLE: 1, CRITICAL: 2}}}, net: {NetworkingEngine: {RequestType: {SEGMENT: 1}}}};
  const Adapter = createShakaHlsClass({shaka, HlsClass, ...(readNativeFailure ? {readNativeFailure} : {})});
  const nativeError = {code: 3016, category: 3, severity: 2, data: [4, '', 'private upstream details']};
  return {Adapter, players, nativeError};
}

test('native diagnostic reads only the same local attempt and sanitizes the returned failure', async () => {
  const calls = [];
  const result = await readNativePlaybackFailure(source + '&sourceId=private', {fetchRequest: async (url, options) => {
    calls.push({url, options});
    return {ok: true, text: async () => JSON.stringify({failure: {status: 429, code: 'private-code', retryAfterSeconds: 47,
      error: 'private upstream details', url: 'https://private.example/video'}})};
  }});
  assert.deepEqual(result, {status: 429, code: 'PLAYBACK_RATE_LIMITED', retryAfterSeconds: 47});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/playback/status?kind=movie&id=123&attempt=opening_1');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.doesNotMatch(JSON.stringify(result), /private|https/);
  for (const url of ['https://external.example/api/play/movie/123.mp4?attempt=a', origin + '/api/asset/token', origin + '/api/play/movie/123.mp4']) {
    assert.equal(await readNativePlaybackFailure(url, {fetchRequest: () => assert.fail('No media or foreign diagnostic may be fetched.')}), null);
  }
});

test('native status ignores a response that belongs to a canceled opening', async () => {
  const controller = new AbortController(), gate = deferred();
  const reading = readNativePlaybackFailure(source, {signal: controller.signal, fetchRequest: async (_url, options) => {
    assert.equal(options.signal.aborted, false); await gate.promise;
    return {ok: true, text: async () => JSON.stringify({failure: {status: 429, retryAfterSeconds: 30}})};
  }});
  controller.abort(); gate.resolve();
  assert.equal(await reading, null);
});

test('native status rejects unknown, malformed or oversized diagnostics without reflecting private text', async () => {
  for (const body of ['not-json', 'x'.repeat(16385), JSON.stringify({failure: {status: 503, code: 'UNKNOWN_PRIVATE_CODE', message: 'private'}}),
    JSON.stringify({failure: {status: 200, code: 'ENGINE_STOPPED'}})]) {
    assert.equal(await readNativePlaybackFailure(source, {fetchRequest: async () => ({ok: true, text: async () => body})}), null);
  }
});

test('one native error detaches immediately and turns the backend cooldown into a terminal HTTP event', async () => {
  const gate = deferred(), calls = [], events = [];
  const f = fixture({readNativeFailure: async (url, options) => {calls.push({url, options}); return gate.promise;}});
  const media = new Media(), adapter = new f.Adapter();
  adapter.on(HlsClass.Events.ERROR, (_name, data) => events.push(data));
  adapter.loadSource(source); adapter.attachMedia(media); await tick();
  assert.equal(media.src, source);
  f.players[0].error(f.nativeError);
  assert.equal(media.src, '');
  assert.ok(media.pauses > 0);
  for (let index = 0; index < 100; index++) f.players[0].error(f.nativeError);
  await tick(); assert.equal(calls.length, 1);
  gate.resolve({status: 429, code: 'PLAYBACK_RATE_LIMITED', retryAfterSeconds: 47}); await tick();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'networkError');
  assert.equal(events[0].response.code, 429);
  assert.equal(events[0].response.headers['retry-after'], '47');
  assert.equal(events[0].fatal, true);
  assert.doesNotMatch(JSON.stringify(events), /private upstream/);
  await adapter.destroy();
});

test('stop aborts the native status read and a late response cannot emit or restore the retired source', async () => {
  const gate = deferred(), events = [], calls = [];
  const f = fixture({readNativeFailure: async (_url, options) => {calls.push(options); return gate.promise;}});
  const media = new Media(), adapter = new f.Adapter();
  adapter.on(HlsClass.Events.ERROR, (_name, data) => events.push(data));
  adapter.loadSource(source); adapter.attachMedia(media); await tick();
  f.players[0].error(f.nativeError); await tick();
  const stopped = adapter.destroy();
  assert.equal(calls[0].signal.aborted, true);
  gate.resolve({status: 429, code: 'PLAYBACK_RATE_LIMITED', retryAfterSeconds: 30});
  await stopped; await tick();
  assert.equal(events.length, 0); assert.equal(media.src, '');
});

test('an unavailable native diagnostic still reports one failure and keeps the source detached', async () => {
  let calls = 0; const events = [];
  const f = fixture({readNativeFailure: async () => {calls++; throw new Error('private server details');}});
  const media = new Media(), adapter = new f.Adapter();
  adapter.on(HlsClass.Events.ERROR, (_name, data) => events.push(data));
  adapter.loadSource(source); adapter.attachMedia(media); await tick();
  f.players[0].error(f.nativeError); await tick();
  for (let index = 0; index < 100; index++) f.players[0].error(f.nativeError);
  await tick();
  assert.equal(calls, 1); assert.equal(events.length, 1); assert.equal(events[0].fatal, true);
  assert.equal(media.src, ''); assert.equal(f.players.length, 1);
  assert.doesNotMatch(JSON.stringify(events), /private/);
  await adapter.destroy();
});

test('async destroy clears native src immediately and again before a new owner can start', async () => {
  const destroyGate = deferred(), f = fixture({destroyGate}), media = new Media();
  const first = new f.Adapter(); first.loadSource(source); first.attachMedia(media); await tick();
  const stopped = first.destroy();
  assert.equal(media.src, '');
  const nextSource = origin + '/api/play/movie/456.mp4?attempt=opening_2';
  const next = new f.Adapter(); next.loadSource(nextSource); next.attachMedia(media); await tick();
  assert.equal(f.players.length, 1);
  for (const filter of f.players[0].network.requests) assert.throws(() => filter(0, {uris: [source]}), {name: 'AbortError'});
  destroyGate.resolve(); await stopped; await tick();
  assert.equal(f.players.length, 2); assert.equal(media.src, nextSource);
  assert.equal(f.players[0].destroys, 1);
  await next.destroy(); assert.equal(media.src, '');
});
