import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WplayPlaybackProviderClient } from '../lib/wplay-playback.mjs';
import { WplayWebPlayback, WPLAY_WEB_ORIGIN, resolveWplayWebLiveItem } from '../lib/wplay-web-playback.mjs';
import { WplayOTTProviderClient, WPLAY_OTT_RPC } from '../lib/wplay-ott-provider.mjs';
import { accountLibrarySession } from '../lib/account-library.mjs';
import { encodeRPC } from '../lib/ott-rpc.mjs';
import { readBody } from '../lib/upstream.mjs';

const deferred = () => { let resolve; const promise = new Promise(ok => { resolve = ok; }); return { promise, resolve }; };
const live = (id, name) => ({ id, name, kind: 'live', categoryId: '1' });
const channel = (id, title, qualities = ['FHD', 'HD', 'SD']) => ({ id, title, kind: 'Canal', liveVariants: qualities.map(quality => ({ quality, playbackUrl: `/live/${id}-${quality}.m3u8?token=synthetic-stream` })) });

async function fixture(items, { loginGate, catalogGate, playbackGate, loginError } = {}) {
  const requests = [], factories = [], loginEntered = deferred(), catalogEntered = deferred(), playbackEntered = deferred(); let origin, client;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, origin); for await (const _ of req) { /* consume RPC body */ }
    requests.push({ method: req.method, url, headers: req.headers }); let result;
    const id = url.pathname.split('/').pop();
    if (id === WPLAY_OTT_RPC.login) {
      loginEntered.resolve(); await loginGate?.promise;
      if (loginError) { res.writeHead(401).end('synthetic-provider-secret'); return; }
      res.setHeader('Set-Cookie', 'web_session=synthetic-cookie; Path=/; HttpOnly');
      result = { authenticated: true, accessToken: 'synthetic-bearer', refreshToken: 'synthetic-refresh' };
    } else if (id === WPLAY_OTT_RPC.catalog) {
      catalogEntered.resolve(); await catalogGate?.promise; result = { rows: [{ title: 'Canais', kind: 'Canal', items }] };
    } else if (id === WPLAY_OTT_RPC.logout) result = { success: true };
    else if (url.pathname.startsWith('/live/') && req.method === 'POST') { res.writeHead(204).end(); return; }
    else if (url.pathname.startsWith('/live/')) { res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }).end('#EXTM3U\n#EXTINF:4,\nsegment.ts\n'); return; }
    else { res.writeHead(200).end('segment'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json', 'x-tss-serialized': 'true' }).end(encodeRPC({ result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  const createClient = config => {
    factories.push(config); client = new WplayOTTProviderClient({ ...config, server: origin }, { allowPrivate: true });
    const original = client.playbackURL.bind(client);
    client.playbackURL = async (...args) => { const source = await original(...args); playbackEntered.resolve(); await playbackGate?.promise; return source; };
    return client;
  };
  return { createClient, requests, factories, origin, loginEntered, catalogEntered, playbackEntered, get client() { return client; }, async close() {
    loginGate?.resolve(); catalogGate?.resolve(); playbackGate?.resolve();
    if (client) await client.logout().catch(() => {});
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  } };
}

function nativeClient(mock, { webPlayback = true, bridge = null } = {}) {
  const client = new WplayPlaybackProviderClient({ username: ' native-fixture ', password: ' synthetic-password ' }, { webPlayback, webPlaybackFactory: mock.createClient, bridge });
  client.libraryProvider = 'wplay'; client.authInfo = { service: { auth_url_sdk: 'https://sdk.example/auth' } };
  client.session = { connected: true, account: { status: 'Active', provider: 'wplay' } }; client.connect = async () => client.session;
  const items = [live('405', 'Globo SP'), live('406', 'Globo RJ'), live('407', 'São Paulo')];
  client.catalog = async () => ({ categories: [{ id: '1', name: 'Canais' }], items });
  for (const item of items) client.rawItems.set(`live:${item.id}`, { sources: [{ address: `tvbus://synthetic-${item.id}` }] });
  return client;
}

test('complete labels preserve regions, indices and accents; HD/default quality comes from the same unique provider ID', async () => {
  const mock = await fixture([channel('sp', 'Globo SP'), channel('rj', 'Globo RJ'), channel('farm17', 'A Fazenda 17'), channel('farm18', 'A Fazenda 18'), channel('accent', 'São Paulo'), channel('default', 'Default', ['FHD', 'SD'])]);
  const transport = new WplayWebPlayback({ username: 'fixture', password: 'synthetic' }, { createClient: mock.createClient });
  try {
    assert.match((await transport.start(live('405', ' GLOBO   SP '))).pathname, /sp-HD/);
    const catalog = await mock.client.catalog('live'), resolve = name => resolveWplayWebLiveItem(live('1', name), mock.client, catalog);
    assert.equal(resolve('Globo RJ').name, 'Globo RJ HD'); assert.equal(resolve('Globo SP FHD').name, 'Globo SP FHD');
    assert.equal(resolve('A Fazenda 18').name, 'A Fazenda 18 HD'); assert.equal(resolve('Default').name, 'Default FHD');
    assert.equal(resolve('Sa\u0303o Paulo').name, 'São Paulo HD');
    for (const name of ['Globo', 'Globo MG', 'A Fazenda 1', 'Sao Paulo']) assert.throws(() => resolve(name), { code: 'WPLAY_WEB_CHANNEL_NOT_FOUND' });
    assert.equal(mock.factories[0].server, WPLAY_WEB_ORIGIN);
  } finally { await transport.close(); await mock.close(); }
});

test('different raw IDs with identical complete labels are rejected; category duplicates of the same raw ID are safe', async () => {
  const mock = await fixture([channel('one', 'Globo SP'), channel('two', 'Globo SP')]); const client = nativeClient(mock);
  try {
    await assert.rejects(client.playbackURL('live', '405'), { code: 'WPLAY_WEB_CHANNEL_AMBIGUOUS', status: 409 });
    assert.equal(mock.client.liveSource, null); assert.equal(mock.requests.some(request => request.url.pathname.startsWith('/live/')), false);
    const catalog = await mock.client.catalog('live');
    const one = catalog.items.filter(item => mock.client.rawItems.get(`live:${item.id}`).id === 'one');
    assert.equal(resolveWplayWebLiveItem(live('405', 'Globo SP'), mock.client, { items: [...one, ...one] }).name, 'Globo SP HD');
  } finally { await client.logout(); await mock.close(); }
});

test('native HTTP and all VOD keep their own transport and never initialize OTT; constructor defaults off', async () => {
  let factories = 0; const mock = { createClient() { factories++; throw new Error('No external request permitted'); } };
  const client = nativeClient(mock);
  client.rawItems.set('live:405', { sources: [{ address: 'tvbus://unused' }, { address: 'https://video.example/live.m3u8' }] });
  client.details = async () => { client.rawItems.set('movie:1', { sources: [{ address: 'https://video.example/movie.mp4' }] }); };
  client.episodes.set('2', { source: { address: 'https://video.example/episode.mp4' } });
  try {
    assert.equal((await client.playbackURL('live', '405')).href, 'https://video.example/live.m3u8');
    assert.equal((await client.playbackURL('movie', '1')).href, 'https://video.example/movie.mp4');
    assert.equal((await client.playbackURL('series', '2')).href, 'https://video.example/episode.mp4'); assert.equal(factories, 0);
    client.episodes.set('3', { source: { address: 'tvbus://vod-must-not-use-web' } });
    await assert.rejects(client.playbackURL('series', '3'), { code: 'WPLAY_NATIVE_ENGINE_REQUIRED' }); assert.equal(factories, 0);
    const off = nativeClient(mock, { webPlayback: false });
    await assert.rejects(off.playbackURL('live', '405'), { code: 'NATIVE_BRIDGE_UNAVAILABLE' }); assert.equal(factories, 0); await off.logout();
  } finally { await client.logout(); }
});

test('web TV preserves native owner/catalog/library IDs, prefers web over an optional bridge, and reuses sid/gen', async () => {
  const mock = await fixture([channel('opaque-web-sp', 'Globo SP')]); let starts = 0;
  const bridge = { async stop() {}, async close() {}, acceptsMediaURL() { return false; }, async start() { starts++; throw new Error('Android must not start'); } };
  const client = nativeClient(mock, { bridge }), nativeSession = client.session, auth = client.authInfo;
  const before = accountLibrarySession(nativeSession, client.config, client.libraryProvider);
  try {
    const first = await client.playbackURL('live', '405'); client.beginPlayback('live:405');
    assert.equal((await client.playbackURL('live', '405')).href, first.href);
    assert.equal(first.searchParams.get('gen'), '1'); assert.ok(first.searchParams.get('sid')); assert.equal(starts, 0);
    assert.equal(client.playback.key, 'live:405'); assert.equal(client.libraryProvider, 'wplay'); assert.equal(client.session, nativeSession); assert.equal(client.authInfo, auth);
    assert.deepEqual(accountLibrarySession(nativeSession, client.config, client.libraryProvider), before);
    assert.equal(mock.factories.length, 1); assert.equal(mock.factories[0].username, 'native-fixture'); assert.equal(mock.factories[0].password, 'synthetic-password');
    assert.ok(client.rawItems.has('live:405')); assert.equal(client.rawItems.has('live:' + mock.client.liveSource.key.split(':')[1]), false);
    assert.equal(JSON.stringify(before).includes('opaque-web-sp'), false);
  } finally { await client.logout(); await mock.close(); }
});

test('only the web origin receives web credentials; HLS assets/CDN and native media retain their own boundary', async () => {
  const mock = await fixture([channel('sp', 'Globo SP')]); const client = nativeClient(mock); const cdnRequests = [];
  const cdn = http.createServer((req, res) => { cdnRequests.push(req.headers); res.writeHead(200).end('cdn-segment'); });
  await new Promise(resolve => cdn.listen(0, '127.0.0.1', resolve)); const cdnURL = `http://127.0.0.1:${cdn.address().port}/segment.ts`;
  try {
    const first = await client.playbackURL('live', '405'); client.beginPlayback('live:405');
    const playlist = await client.upstreamRequest(first, { headers: { Cookie: 'injected-native-cookie', Authorization: 'Bearer injected-native-token' } });
    const text = await readBody(playlist); assert.match(text.toString(), /^#EXTM3U/);
    const media = mock.requests.find(request => request.url.pathname.startsWith('/live/') && request.method === 'GET');
    assert.equal(media.headers.cookie, 'web_session=synthetic-cookie'); assert.equal(media.headers.authorization, 'Bearer synthetic-bearer'); assert.equal(media.headers['user-agent'], 'Mozilla/5.0');
    const rewritten = client.rewriteManifest(`#EXTM3U\n#EXTINF:4,\n${cdnURL}\n`, first, 'live:405'); assert.doesNotMatch(rewritten, /synthetic-stream|127\.0\.0\.1|cookie|bearer/);
    const asset = [...client.assets.values()][0]; assert.equal(client.isWebMediaURL(asset.url), true);
    const segment = await client.upstreamRequest(asset.url, { headers: { Cookie: 'injected-native-cookie', Authorization: 'Bearer injected-native-token', Range: 'bytes=0-3' } }); await readBody(segment);
    assert.equal(cdnRequests[0].cookie, undefined); assert.equal(cdnRequests[0].authorization, undefined); assert.equal(cdnRequests[0].range, 'bytes=0-3');
    assert.equal(client.upstreamHeaders('https://native.example/art.jpg').Authorization, undefined);
    await client.stopPlayback(); assert.equal(client.isWebMediaURL(first), false); assert.equal(client.isWebMediaURL(asset.url), false);
  } finally { await client.logout(); await mock.close(); cdn.closeAllConnections(); await new Promise(resolve => cdn.close(resolve)); }
});

test('channel changes preserve official remote stop sid/gen and never restart a polled manifest', async () => {
  const mock = await fixture([channel('sp', 'Globo SP'), channel('rj', 'Globo RJ')]); const client = nativeClient(mock);
  try {
    const first = await client.playbackURL('live', '405'); const second = await client.playbackURL('live', '406');
    assert.equal(second.searchParams.get('sid'), first.searchParams.get('sid')); assert.equal(second.searchParams.get('gen'), '2');
    assert.equal(client.isWebMediaURL(first), false); assert.equal(client.isWebMediaURL(second), true);
    const stops = () => mock.requests.filter(request => request.method === 'POST' && request.url.pathname.startsWith('/live/'));
    assert.equal(stops().length, 1); assert.match(stops()[0].url.pathname, /sp-HD/); assert.equal(stops()[0].url.searchParams.get('gen'), '1'); assert.equal(stops()[0].url.searchParams.get('stop'), '1');
    await client.playbackURL('live', '406'); assert.equal(stops().length, 1);
    await client.stopPlayback(); assert.equal(stops().length, 2); assert.match(stops()[1].url.pathname, /rj-HD/); assert.equal(stops()[1].url.searchParams.get('gen'), '2');
  } finally { await client.logout(); await mock.close(); }
});

test('a pending web login cannot block native VOD or start TV after stop', async () => {
  const loginGate = deferred(), mock = await fixture([channel('sp', 'Globo SP')], { loginGate }), client = nativeClient(mock);
  client.details = async () => { client.rawItems.set('movie:1', { sources: [{ address: 'https://video.example/movie.mp4' }] }); };
  const pending = client.playbackURL('live', '405'), rejected = assert.rejects(pending, { code: 'PLAYBACK_CANCELLED' });
  try {
    await mock.loginEntered.promise;
    // This resolves while the login HTTP response is still held by the fixture.
    assert.equal((await client.playbackURL('movie', '1')).href, 'https://video.example/movie.mp4');
    loginGate.resolve(); await rejected; assert.equal(mock.client.liveSource, null); assert.equal(mock.requests.some(request => request.url.pathname.startsWith('/live/')), false);
  } finally { loginGate.resolve(); await client.logout(); await mock.close(); }
});

test('stop cancels a pending OTT login before its HTTP response arrives',async()=>{
  const loginGate=deferred(),mock=await fixture([channel('sp','Globo SP')],{loginGate}),client=nativeClient(mock);
  const pending=client.playbackURL('live','405'),rejected=assert.rejects(pending,{code:'PLAYBACK_CANCELLED'});
  let timer;
  try{
    await mock.loginEntered.promise;await client.stopPlayback();
    await Promise.race([rejected,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Cancelled login still held the transport queue.')),500);})]);
    assert.equal(mock.requests.some(request=>request.url.pathname.startsWith('/live/')),false);
    assert.equal(mock.client.session,null);
  }finally{clearTimeout(timer);loginGate.resolve();await client.logout();await mock.close();}
});

test('one startup deadline aborts a slow OTT catalog and permits a clean retry',async()=>{
  const catalogGate=deferred(),mock=await fixture([channel('sp','Globo SP')],{catalogGate});
  const transport=new WplayWebPlayback({username:'fixture',password:'synthetic'},{createClient:mock.createClient,startupTimeoutMs:120});
  try{
    await assert.rejects(transport.start(live('405','Globo SP')),{code:'WPLAY_WEB_START_TIMEOUT',status:504});
    assert.equal(transport.active,false);assert.equal(mock.requests.some(request=>request.url.pathname.startsWith('/live/')),false);
    catalogGate.resolve();const source=await transport.start(live('405','Globo SP'));assert.match(source.pathname,/sp-HD/);assert.equal(transport.active,true);
  }finally{catalogGate.resolve();await transport.close();await mock.close();}
});

test('a late web playback response is stopped before the next channel can own media', async () => {
  const playbackGate = deferred(), mock = await fixture([channel('sp', 'Globo SP'), channel('rj', 'Globo RJ')], { playbackGate }), client = nativeClient(mock);
  const pending = client.playbackURL('live', '405'), rejected = assert.rejects(pending, { code: 'PLAYBACK_CANCELLED' });
  try {
    await mock.playbackEntered.promise; const next = client.playbackURL('live', '406'); playbackGate.resolve(); await rejected;
    const source = await next; assert.match(source.pathname, /rj-HD/); assert.equal(source.searchParams.get('gen'), '2'); assert.equal(client.isWebMediaURL(source), true);
    const stops = mock.requests.filter(request => request.method === 'POST' && request.url.pathname.startsWith('/live/'));
    assert.equal(stops.length, 1); assert.match(stops[0].url.pathname, /sp-HD/);
  } finally { playbackGate.resolve(); await client.logout(); await mock.close(); }
});

test('logout drains a late login/catalog and then erases web credentials without changing another owner', async () => {
  const catalogGate = deferred(), mock = await fixture([channel('sp', 'Globo SP')], { catalogGate }), client = nativeClient(mock);
  const pending = client.playbackURL('live', '405'), rejected = assert.rejects(pending, { code: 'PLAYBACK_CANCELLED' });
  try {
    await mock.catalogEntered.promise; const logout = client.logout(); catalogGate.resolve(); await rejected; await logout;
    assert.equal(client.session, null); assert.equal(client.config.password, ''); assert.equal(mock.client.session, null);
    assert.equal(mock.client.rpc.cookieJar.size, 0); assert.equal(mock.client.rpc.accessToken, null); assert.equal(mock.client.refreshToken, null); assert.equal(mock.client.config.password, '');
    assert.equal(mock.requests.some(request => request.url.pathname.startsWith('/live/')), false);
  } finally { catalogGate.resolve(); await client.logout(); await mock.close(); }
});

test('web authentication failure is sanitized and does not replace native authentication or its library', async () => {
  const mock = await fixture([channel('sp', 'Globo SP')], { loginError: true }), client = nativeClient(mock), session = client.session;
  try {
    await assert.rejects(client.playbackURL('live', '405'), error => error.code === 'WPLAY_WEB_AUTH_REJECTED' && error.status === 502 && !/synthetic|https?:/.test(error.message));
    assert.equal(client.session, session); assert.equal(client.libraryProvider, 'wplay'); assert.equal(client.config.username, 'native-fixture');
  } finally { await client.logout(); await mock.close(); }
});

test('web failure never starts an old configured Android bridge, including VOD without HTTP', async () => {
  const mock = await fixture([channel('sp', 'Globo SP')], { loginError: true }); let starts = 0;
  const bridge = { async stop() {}, async close() {}, acceptsMediaURL() { return false; }, async start() { starts++; throw new Error('Android must not start'); } };
  const client = nativeClient(mock, { bridge });
  try {
    await assert.rejects(client.playbackURL('live', '405'), { code: 'WPLAY_WEB_AUTH_REJECTED' });
    client.episodes.set('3', { source: { address: 'tvbus://vod-must-not-start-android' } });
    await assert.rejects(client.playbackURL('series', '3'), { code: 'WPLAY_NATIVE_ENGINE_REQUIRED' }); assert.equal(starts, 0);
  } finally { await client.logout(); await mock.close(); }
});

test('separate browser owners have independent web screen IDs and stopping one cannot revoke the other', async () => {
  const mock = await fixture([channel('sp', 'Globo SP')]), first = nativeClient(mock), second = nativeClient(mock);
  try {
    const one = await first.playbackURL('live', '405'), two = await second.playbackURL('live', '405');
    assert.notEqual(one.searchParams.get('sid'), two.searchParams.get('sid')); assert.equal(mock.factories.length, 2);
    assert.equal(first.isWebMediaURL(two), false); assert.equal(second.isWebMediaURL(one), false);
    await first.logout(); assert.equal(second.isWebMediaURL(two), true); assert.equal((await second.playbackURL('live', '405')).href, two.href);
    const stopped = mock.requests.filter(request => request.method === 'POST' && request.url.pathname.startsWith('/live/'));
    assert.equal(stopped.length, 1); assert.equal(stopped[0].url.searchParams.get('sid'), one.searchParams.get('sid'));
  } finally { await first.logout(); await second.logout(); await mock.close(); }
});

test('stopping active TV aborts its HTTP request and discards a response returned after cancellation', async () => {
  const mock = await fixture([channel('sp', 'Globo SP')]), responseGate = deferred(), entered = deferred(); let requestSignal, destroyed = false;
  const transport = new WplayWebPlayback({ username: 'fixture', password: 'synthetic' }, { createClient: mock.createClient, async request(value, options) {
    requestSignal = options.signal; entered.resolve(); await responseGate.promise;
    return { url: String(value), status: 200, body: { destroy() { destroyed = true; } } };
  } });
  try {
    const source = await transport.start(live('405', 'Globo SP'));
    const pending = transport.upstreamRequest(source), rejected = assert.rejects(pending, { code: 'PLAYBACK_CANCELLED' });
    await entered.promise; await transport.stop(); assert.equal(requestSignal.aborted, true);
    responseGate.resolve(); await rejected; assert.equal(destroyed, true); assert.equal(transport.active, false);
  } finally { responseGate.resolve(); await transport.close(); await mock.close(); }
});
