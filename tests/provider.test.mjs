import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../server.mjs';
import { ProviderClient } from '../lib/provider.mjs';

// Synthetic credentials are deliberately unlike the real local account.
const username = 'fixture-user-4821';
const password = 'fixture-password-8391';

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  server.closeAllConnections?.();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function loginFixture(mock, cookie) {
  return fetch(`${mock.base}/api/login`, {method:'POST',headers:{Origin:mock.base,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify({provider:"xtream",username,password})});
}

function sessionCookie(response) {
  const cookie = response.headers.get('set-cookie');
  assert.ok(cookie, 'The app must issue a session cookie.');
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
  return cookie.split(';')[0];
}

function assertPrivate(value, origin) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of [username, password, origin, 'player_api.php']) {
    assert.ok(!text.includes(secret), `The local API exposed ${secret === origin ? 'the provider origin' : 'provider connection data'}.`);
  }
}

async function fixture({ holdLiveStreams = false, failedSegment = false, reusedSegment = false, adultAvailable = true, bootstrapRedirect = false, truncatedSegment = false, secondChannel = false } = {}) {
  const requests = [];
  let releaseLive;
  let markLiveRequested;
  const liveGate = new Promise(resolve => { releaseLive = resolve; });
  const liveRequested = new Promise(resolve => { markLiveRequested = resolve; });
  let manifestSequence = 10;
  let segmentBody = 'first-generation';
  let bootstrapGeneration = 0;
  const expiredSessions = new Map();
  let allExpiredStatus = null;
  let origin;
  const provider = http.createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    requests.push({ path: url.pathname, action: url.searchParams.get('action'), range: req.headers.range });
    if (url.pathname === '/player_api.php') {
      if (url.searchParams.get('username') !== username || url.searchParams.get('password') !== password) {
        res.writeHead(401).end();
        return;
      }
      const image = `${origin}/art/poster.jpg?username=${username}&password=${password}`;
      const categories = [{ category_id: '1', category_name: 'Ação &amp; Aventura' }, ...(adultAvailable ? [{ category_id: '9', category_name: 'Conteúdo ADULTO' }] : [])];
      const responses = {
        '': { user_info: { auth: 1, status: 'Active', username, password, exp_date: String(Math.floor(Date.now() / 1000) + 86400), max_connections: '1', active_cons: '0' } },
        get_vod_categories: categories,
        get_vod_streams: [
          { stream_id: 201, category_id: '1', name: 'xXx2 &amp; Ação', stream_icon: image, container_extension: 'mp4', direct_source: `${origin}/private/${password}` },
          { stream_id: 202, category_id: '9', name: 'Conteúdo restrito', stream_icon: image },
          { stream_id: 203, category_id: '404', name: 'Categoria ausente', stream_icon: image }
        ],
        get_live_categories: [{ category_id: '2', category_name: 'Esportes' }],
        get_live_streams: [{ stream_id: 101, category_id: '2', name: 'Canal &amp; HD', stream_icon: image },...(secondChannel?[{stream_id:102,category_id:'2',name:'Outro canal',stream_icon:image}]:[])],
        get_series_categories: [{ category_id: '3', category_name: 'Drama' }],
        get_series: [{ series_id: 301, category_id: '3', name: 'Série &amp; Mistério', cover: image }],
        get_series_info: {
          info: { name: 'Série &amp; Mistério', plot: '<b>Uma história</b> &amp; suspense', cover: image },
          seasons: [{ season_number: 2, name: 'Temporada &amp; Dois' }, { season_number: 1, name: 'Primeira temporada' }],
          episodes: {
            2: [{ id: '402', title: 'Segundo &amp; final', episode_num: '2', season: '2', container_extension: 'mp4' }],
            1: [
              { id: '403', title: 'Depois', episode_num: '2', season: '1', container_extension: 'mp4' },
              { id: '401', title: 'Piloto &amp; chegada', episode_num: '1', season: '1', container_extension: 'mkv', info: { duration: '42:10' }, direct_source: `${origin}/${password}` },
              { id: '../invalid', title: 'Inválido', episode_num: 0 }
            ]
          }
        }
      };
      const action = url.searchParams.get('action') || '';
      if (!(action in responses)) { res.writeHead(404).end(); return; }
      if (action === 'get_live_streams') {
        markLiveRequested();
        if (holdLiveStreams) await liveGate;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(responses[action]));
      return;
    }
    if (url.pathname === `/series/${username}/${password}/401.mkv`) {
      res.writeHead(200, { 'Content-Type': 'video/x-matroska' }).end('synthetic-episode');
      return;
    }
    const entryPlaylist = [101,...(secondChannel?[102]:[])].some(id=>url.pathname === `/live/${username}/${password}/${id}.m3u8`);
    const sessionPlaylist = /^\/redirect-session\/(\d+)\/index\.m3u8$/.exec(url.pathname);
    if (entryPlaylist && bootstrapRedirect) {
      bootstrapGeneration++;
      res.writeHead(302, { Location: `/redirect-session/${bootstrapGeneration}/index.m3u8` }).end();
      return;
    }
    if (entryPlaylist || sessionPlaylist) {
      const expired = sessionPlaylist && (allExpiredStatus || expiredSessions.get(Number(sessionPlaylist[1])));
      if (expired) { res.writeHead(expired).end('Synthetic expired playback session'); return; }
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }).end([
        '#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:4', `#EXT-X-MEDIA-SEQUENCE:${manifestSequence}`,
        `#EXT-X-KEY:METHOD=AES-128,URI="key.bin?password=${password}"`,
        '#EXTINF:4.0,', `segments/first.ts?username=${username}&password=${password}`,
        '#EXTINF:4.0,', `${origin}/live/${username}/${password}/segments/second.ts`,
        ...(failedSegment ? ['#EXTINF:4.0,', 'segments/broken.ts'] : []),
        '#EXT-X-ENDLIST'
      ].join('\n'));
      return;
    }
    if (url.pathname === `/live/${username}/${password}/key.bin`) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(Buffer.alloc(16, 7));
      return;
    }
    if (url.pathname === `/live/${username}/${password}/segments/first.ts` || url.pathname === `/live/${username}/${password}/segments/second.ts`) {
      if (truncatedSegment && url.pathname.endsWith('/segments/first.ts')) {
        res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': '100000' });
        res.write(Buffer.alloc(188, 71));
        setTimeout(() => res.destroy(), 20);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'video/mp2t' }).end(url.pathname.endsWith('first.ts') ? reusedSegment ? segmentBody : 'first-segment' : 'second-segment');
      return;
    }
    if (url.pathname === `/live/${username}/${password}/segments/broken.ts`) {
      res.writeHead(503).end('Synthetic unavailable segment');
      return;
    }
    if (url.pathname === '/art/poster.jpg') {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' }).end('synthetic-poster');
      return;
    }
    res.writeHead(404).end();
  });
  origin = await listen(provider);
  let fixtureClient;
  const app = createApp({ connection: { server: origin, username, password }, allowPrivateUpstream: true,providerFactory:({config,options})=>(fixtureClient=new ProviderClient(config,options)) });
  let liveReads=0;app.on('request',req=>{if(req.url.startsWith('/api/play/live/'))liveReads++;});
  let base;
  try { base = await listen(app); } catch (error) { await close(provider); throw error; }
  return {
    base, origin, requests, liveRequested, releaseLive,playbackIntents:()=>fixtureClient?.playbackGeneration,liveReads:()=>liveReads,
    advanceManifest() { manifestSequence++; segmentBody = 'second-generation'; },
    enableAdultCatalog() { adultAvailable = true; },
    expireResolvedPlaylist(status = 410) { expiredSessions.set(bootstrapGeneration, status); },
    expireAllResolvedPlaylists(status = 410) { allExpiredStatus = status; },
    async close() { releaseLive(); await close(app); await close(provider); }
  };
}

test('the local player authenticates, sanitizes catalog data, and proxies only registered media', async t => {
  const mock = await fixture();
  let cookie;
  let poster;
  let asset;
  try {
    await t.test('a fresh browser requires credentials and login uses the configured server without exposing it', async () => {
      const initial = await fetch(`${mock.base}/api/session`);
      const initialCookie=sessionCookie(initial);
      assert.deepEqual(await initial.json(),{connected:false,capabilities:{games:true,accountLibrary:true,cloud:false},login:{configuredServer:true,defaultProvider:"wplay"},cloud:null,cloudStatus:{state:'disabled'}});
      assert.equal(mock.requests.length,0,'Opening sign-in must not authenticate with stored credentials.');
      const locked=await fetch(`${mock.base}/api/catalog?type=movies`,{headers:{Cookie:initialCookie}});
      assert.equal(locked.status,401);
      const response = await loginFixture(mock);
      assert.equal(response.status, 200);
      cookie = sessionCookie(response);
      const session = await response.json();
      assert.equal(session.connected, true);
      assert.equal(session.account.usernameMasked, '••••4821');
      assert.equal(session.account.maxConnections, 1);
      assertPrivate(session, mock.origin);
      assert.equal(mock.requests.filter(request => request.path === '/player_api.php' && !request.action).length, 1);
    });

    await t.test('movies include authorized adult categories and omit streams in categories the provider did not return', async () => {
      const locked=await fetch(`${mock.base}/api/catalog?type=movies`,{headers:{Cookie:cookie}});
      assert.equal(locked.status,200);const safe=await locked.json();assert.deepEqual(safe.categories.map(category=>category.id),['1']);assert.deepEqual(safe.items.map(item=>item.id),['201']);
      const unlock=await fetch(`${mock.base}/api/parental/unlock`,{method:'POST',headers:{Cookie:cookie,Origin:mock.base,'Content-Type':'application/json'},body:JSON.stringify({pin:'0000'})});assert.equal(unlock.status,200);assert.equal((await unlock.json()).unlocked,true);
      const response = await fetch(`${mock.base}/api/catalog?type=movies`, { headers: { Cookie: cookie } });
      assert.equal(response.status, 200);
      const catalog = await response.json();
      assert.deepEqual(catalog.categories, [{ id: '1', name: 'Ação & Aventura' }, { id: '9', name: 'Conteúdo ADULTO' }]);
      assert.deepEqual(catalog.items.map(item => item.id), ['201', '202']);
      assert.equal(catalog.items[0].id, '201');
      assert.equal(catalog.items[0].name, 'xXx2 & Ação');
      poster = catalog.items[0].poster;
      assert.match(poster, /^\/api\/image\?ref=[\w-]+$/);
      assertPrivate(catalog, mock.origin);
      const anonymousImage = await fetch(mock.base + poster);
      assert.equal(anonymousImage.status, 401);
      const image = await fetch(mock.base + poster, { headers: { Cookie: cookie } });
      assert.equal(image.status, 200);
      assert.equal(await image.text(), 'synthetic-poster');
    });

    await t.test('series details normalize seasons and register the actual episode container', async () => {
      const unregistered = await fetch(`${mock.base}/api/play/series/401.mp4`, { headers: { Cookie: cookie } });
      assert.ok(unregistered.status >= 400);
      assert.ok(!mock.requests.some(request => request.path.startsWith('/series/')));
      const response = await fetch(`${mock.base}/api/details?type=series&id=301`, { headers: { Cookie: cookie } });
      assert.equal(response.status, 200);
      const details = await response.json();
      assert.equal(details.plot, 'Uma história & suspense');
      assert.deepEqual(details.seasons.map(season => season.number), [1, 2]);
      assert.deepEqual(details.seasons[0].episodes.map(episode => episode.id), ['401', '403']);
      assert.equal(details.seasons[0].episodes[0].title, 'Piloto & chegada');
      assert.equal(details.seasons[0].episodes[0].container, 'mkv');
      assertPrivate(details, mock.origin);
      const playback = await fetch(`${mock.base}/api/play/series/401.mp4`, { headers: { Cookie: cookie } });
      assert.equal(playback.status, 200);
      assert.equal(await playback.text(), 'synthetic-episode');
      assert.ok(mock.requests.some(request => request.path === `/series/${username}/${password}/401.mkv`));
      assert.ok(!mock.requests.some(request => request.path === `/series/${username}/${password}/401.mp4`));
    });

    await t.test('HLS segments and encryption keys use opaque, session-protected local URLs', async () => {
      const response = await fetch(`${mock.base}/api/play/live/101/index.m3u8`, { headers: { Cookie: cookie } });
      assert.equal(response.status, 200);
      const manifest = await response.text();
      assert.match(manifest, /^#EXTM3U/);
      assertPrivate(manifest, mock.origin);
      const key = /#EXT-X-KEY:METHOD=AES-128,URI="([^\"]+)"/.exec(manifest)?.[1];
      const segments = manifest.split('\n').filter(line => line && !line.startsWith('#'));
      assert.equal(segments.length, 2);
      for (const url of [key, ...segments]) assert.match(url, /^\/api\/asset\/[\w-]+$/);
      asset = segments[0];
      const anonymous = await fetch(mock.base + asset);
      assert.equal(anonymous.status, 401);
      const encryptedKey = await fetch(mock.base + key, { headers: { Cookie: cookie } });
      assert.equal(encryptedKey.status, 200);
      assert.deepEqual(Buffer.from(await encryptedKey.arrayBuffer()), Buffer.alloc(16, 7));
      for (const [index, url] of segments.entries()) {
        const segment = await fetch(mock.base + url, { headers: { Cookie: cookie } });
        assert.equal(segment.status, 200);
        assert.equal(await segment.text(), index === 0 ? 'first-segment' : 'second-segment');
      }
    });

    await t.test('cached segments avoid duplicate upstream downloads and diagnostic probes remain metadata-only', async () => {
      const segmentPath = `/live/${username}/${password}/segments/first.ts`;
      const before = mock.requests.filter(request => request.path === segmentPath).length;
      const repeat = await fetch(mock.base + asset, { headers: { Cookie: cookie } });
      assert.equal(await repeat.text(), 'first-segment');
      assert.match(repeat.headers.get('server-timing'), /segmentcache/);
      assert.equal(mock.requests.filter(request => request.path === segmentPath).length, before);
      const metadataBefore = mock.requests.filter(request => request.path === '/player_api.php' && !request.action).length;
      const mediaBefore = mock.requests.filter(request => request.path.startsWith('/live/')).length;
      const responses = await Promise.all([1, 2].map(() => fetch(`${mock.base}/api/diagnostics`, { headers: { Cookie: cookie } })));
      for (const response of responses) assert.equal(response.status, 200);
      const reports = await Promise.all(responses.map(response => response.json()));
      assert.equal(mock.requests.filter(request => request.path === '/player_api.php' && !request.action).length - metadataBefore, 3);
      assert.equal(mock.requests.filter(request => request.path.startsWith('/live/')).length, mediaBefore);
      assert.deepEqual(reports[0], reports[1]);
      assert.equal(reports[0].playback.segmentSamples, 2, 'A cache hit must not inflate measured upstream throughput.');
      assertPrivate(reports[0], mock.origin);
    });

    await t.test('cross-origin writes and private configuration files are inaccessible', async () => {
      const rejected = await fetch(`${mock.base}/api/logout`, { method: 'POST', headers: { Cookie: cookie, Origin: 'https://untrusted.example', 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(rejected.status, 403);
      const catalog = await fetch(`${mock.base}/api/catalog?type=movies`, { headers: { Cookie: cookie } });
      assert.equal(catalog.status, 200, 'A denied logout must not remove the current session.');
      for (const path of ['/.local/connection.json', '/.local/provider.json', '/%2e%2e%2f.local/connection.json']) {
        const response = await fetch(mock.base + path);
        assert.ok([403, 404].includes(response.status));
      }
    });

    await t.test('logout invalidates media access and reconnecting requires credentials', async () => {
      const response = await fetch(`${mock.base}/api/logout`, { method: 'POST', headers: { Cookie: cookie, Origin: mock.base, 'Content-Type': 'application/json' }, body: '{}' });
      assert.ok([200, 204].includes(response.status));
      const oldCatalog = await fetch(`${mock.base}/api/catalog?type=movies`, { headers: { Cookie: cookie } });
      assert.equal(oldCatalog.status, 401);
      const oldAsset = await fetch(mock.base + asset, { headers: { Cookie: cookie } });
      assert.equal(oldAsset.status, 401);
      const disconnected = await fetch(`${mock.base}/api/session`, { headers: { Cookie: cookie } });
      assert.equal(disconnected.status, 200);
      assert.equal((await disconnected.json()).connected, false);
      const rejected = await fetch(`${mock.base}/api/login`, { method:'POST',headers:{Cookie:cookie,Origin:mock.base,'Content-Type':'application/json'},body:'{}' });
      assert.equal(rejected.status,400);
      const stillDisconnected=await fetch(`${mock.base}/api/session`,{headers:{Cookie:cookie}});
      assert.equal((await stillDisconnected.json()).connected,false);
      const login = await loginFixture(mock);
      assert.equal(login.status, 200);
      const nextCookie = sessionCookie(login);
      assert.notEqual(nextCookie, cookie);
      const account = await login.json();
      assert.equal(account.connected, true);
      assertPrivate(account, mock.origin);
      const restored = await fetch(`${mock.base}/api/catalog?type=movies`, { headers: { Cookie: nextCookie } });
      assert.equal(restored.status, 200);
    });
  } finally { await mock.close(); }
});

test('private upstream access is opt-in for fixtures', () => {
  const connection = { server: 'http://127.0.0.1:1234', username, password };
  assert.throws(() => new ProviderClient(connection), /servidor inválido/);
  assert.doesNotThrow(() => new ProviderClient(connection, { allowPrivate: true }));
});

test('startup scripts and their local module imports are served as JavaScript', async () => {
  const mock = await fixture();
  try {
    const page = await fetch(mock.base);
    assert.equal(page.status, 200);
    const html = await page.text();
    const pending = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)].map(match => new URL(match[1], mock.base).pathname);
    assert.ok(pending.includes('/app.js'));
    const visited = new Set();
    while (pending.length) {
      const path = pending.shift();
      if (visited.has(path)) continue;
      visited.add(path);
      const response = await fetch(mock.base + path);
      assert.equal(response.status, 200, `Startup dependency ${path} must exist.`);
      assert.match(response.headers.get('content-type'), /(?:text|application)\/javascript/, `Startup dependency ${path} must have a JavaScript MIME type.`);
      const source = await response.text();
      for (const match of source.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?:[^;]*?\sfrom\s*)?["']([^"']+)["']/g)) {
        if (/^(?:\.{1,2}\/|\/)/.test(match[1])) pending.push(new URL(match[1], mock.base + path).pathname);
      }
    }
    assert.ok(visited.has('/player-tools.js'), 'The player module must be checked through the app import graph.');
    for(const module of ['/login/tela.js','/sistema/conta/menu.js','/sistema/configuracoes/views.js','/catalog-renderer.js'])assert.ok(visited.has(module),`The new module ${module} must be included in the served import graph.`);
    assert.equal(mock.requests.length, 0, 'Checking startup assets must not contact the provider.');
  } finally { await mock.close(); }
});

test('a reused HLS URI with a new media sequence retrieves fresh segment content', async () => {
  const mock = await fixture({ reusedSegment: true });
  try {
    const session = await loginFixture(mock);
    const cookie = sessionCookie(session);
    await session.json();
    const segmentURL = async () => {
      const response = await fetch(`${mock.base}/api/play/live/101/index.m3u8`, { headers: { Cookie: cookie } });
      assert.equal(response.status, 200);
      return (await response.text()).split('\n').find(line => line && !line.startsWith('#'));
    };
    const first = await segmentURL();
    const original = await fetch(mock.base + first, { headers: { Cookie: cookie } });
    assert.equal(await original.text(), 'first-generation');
    const replay = await fetch(mock.base + first, { headers: { Cookie: cookie } });
    assert.equal(await replay.text(), 'first-generation');
    assert.match(replay.headers.get('server-timing'), /segmentcache/);
    mock.advanceManifest();
    const next = await segmentURL();
    const fresh = await fetch(mock.base + next, { headers: { Cookie: cookie } });
    assert.equal(await fresh.text(), 'second-generation');
    assert.equal(mock.requests.filter(request => request.path.endsWith('/segments/first.ts')).length, 2);
  } finally { await mock.close(); }
});

test('stopping while channel metadata loads prevents a late playback request from opening media', async () => {
  const mock = await fixture({ holdLiveStreams: true });
  try {
    const session = await loginFixture(mock);
    const cookie = sessionCookie(session);
    await session.json();
    const pending = fetch(`${mock.base}/api/play/live/101/index.m3u8`, { headers: { Cookie: cookie } });
    await mock.liveRequested;
    const stopped = await fetch(`${mock.base}/api/stop`, { method: 'POST', headers: { Cookie: cookie, Origin: mock.base } });
    assert.equal(stopped.status, 200);
    await stopped.json();
    mock.releaseLive();
    const stale = await pending;
    assert.equal(stale.status, 409);
    await stale.text();
    assert.ok(!mock.requests.some(request => request.path.startsWith('/live/')));
  } finally { await mock.close(); }
});

test('logout while parental metadata loads prevents a late playback request from opening media', async () => {
  const mock=await fixture({holdLiveStreams:true});
  try{
    const session=await loginFixture(mock),cookie=sessionCookie(session);await session.json();
    const pending=fetch(`${mock.base}/api/play/live/101/index.m3u8`,{headers:{Cookie:cookie}});await mock.liveRequested;
    const logout=await fetch(`${mock.base}/api/logout`,{method:'POST',headers:{Cookie:cookie,Origin:mock.base}});assert.equal(logout.status,200);await logout.json();mock.releaseLive();
    const stale=await pending;assert.equal(stale.status,409);await stale.text();assert.ok(!mock.requests.some(request=>request.path.startsWith('/live/')));
  }finally{await mock.close();}
});

test('a newer selection supersedes playback still waiting for parental metadata',async()=>{
  const mock=await fixture({holdLiveStreams:true,secondChannel:true});
  try{
    const session=await loginFixture(mock),cookie=sessionCookie(session);await session.json();
    const first=fetch(`${mock.base}/api/play/live/101/index.m3u8`,{headers:{Cookie:cookie}});await mock.liveRequested;const intent=mock.playbackIntents();
    const next=fetch(`${mock.base}/api/play/live/102/index.m3u8`,{headers:{Cookie:cookie}}),deadline=Date.now()+1000;
    while(mock.playbackIntents()===intent&&Date.now()<deadline)await new Promise(setImmediate);
    assert.ok(mock.playbackIntents()>intent,'The newer request must reserve its intent before metadata resolves.');mock.releaseLive();
    const [stale,current]=await Promise.all([first,next]);assert.equal(stale.status,409);await stale.text();assert.equal(current.status,200);assert.match(await current.text(),/^#EXTM3U/);
    assert.equal(mock.requests.filter(request=>request.path.startsWith('/live/')).length,1);
  }finally{await mock.close();}
});

test('overlapping live HEAD probes and GET retries share a selection while metadata loads',async t=>{
  for(const method of ['GET','HEAD'])await t.test(method,async()=>{
    const mock=await fixture({holdLiveStreams:true});
    try{
      const session=await loginFixture(mock),cookie=sessionCookie(session);await session.json();
      const url=`${mock.base}/api/play/live/101/index.m3u8`,headers={Cookie:cookie};
      const first=fetch(url,{method,headers});await mock.liveRequested;const intent=mock.playbackIntents();
      const next=fetch(url,{headers}),deadline=Date.now()+1000;
      while(mock.liveReads()<2&&Date.now()<deadline)await new Promise(setImmediate);
      assert.equal(mock.liveReads(),2);await new Promise(setImmediate);
      assert.equal(mock.playbackIntents(),intent,'Repeated readers must not become channel changes.');
      mock.releaseLive();const [a,b]=await Promise.all([first,next]);
      assert.equal(a.status,200);assert.equal(b.status,200);await a.text();assert.match(await b.text(),/^#EXTM3U/);
    }finally{await mock.close();}
  });
});

test('upstream HTTP failures for actual segments reach the playback assessment', async () => {
  const mock = await fixture({ failedSegment: true });
  try {
    const session = await loginFixture(mock);
    const cookie = sessionCookie(session);
    await session.json();
    const playlist = await fetch(`${mock.base}/api/play/live/101/index.m3u8`, { headers: { Cookie: cookie } });
    const segments = (await playlist.text()).split('\n').filter(line => line && !line.startsWith('#'));
    const failed = await fetch(mock.base + segments.at(-1), { headers: { Cookie: cookie } });
    assert.equal(failed.status, 502);
    await failed.json();
    const diagnostics = await fetch(`${mock.base}/api/diagnostics`, { headers: { Cookie: cookie } });
    const report = await diagnostics.json();
    assert.equal(report.playback.segmentSamples, 0);
    assert.equal(report.playback.throughputMbps, null);
    assert.equal(report.assessment.status, 'fair');
    assert.match(report.assessment.detail, /segmento recente falhou/);
  } finally { await mock.close(); }
});

test('refreshing the catalog includes categories newly released by a subscription change', async () => {
  const mock = await fixture({ adultAvailable: false });
  try {
    const session = await loginFixture(mock);
    const cookie = sessionCookie(session);
    await session.json();
    const readCatalog = async (refresh = false) => {
      const response = await fetch(`${mock.base}/api/catalog?type=movies${refresh ? '&refresh=1' : ''}`, { headers: { Cookie: cookie } });
      assert.equal(response.status, 200);
      return response.json();
    };
    const original = await readCatalog();
    assert.deepEqual(original.categories.map(category => category.id), ['1']);
    assert.deepEqual(original.items.map(item => item.id), ['201']);
    mock.enableAdultCatalog();
    const cached = await readCatalog();
    assert.deepEqual(cached.categories.map(category => category.id), ['1']);
    const refreshed = await readCatalog(true);
    assert.deepEqual(refreshed.categories.map(category=>category.id),['1']);assert.deepEqual(refreshed.items.map(item=>item.id),['201']);
    const unlock=await fetch(`${mock.base}/api/parental/unlock`,{method:'POST',headers:{Cookie:cookie,Origin:mock.base,'Content-Type':'application/json'},body:JSON.stringify({pin:'0000'})});assert.equal(unlock.status,200);assert.equal((await unlock.json()).unlocked,true);
    const authorized=await readCatalog();
    assert.deepEqual(authorized.categories.map(category => category.id), ['1', '9']);
    assert.deepEqual(authorized.items.map(item => item.id), ['201', '202']);
    assert.ok(!authorized.items.some(item => item.id === '203'));
    assert.equal(mock.requests.filter(request => request.action === 'get_vod_categories').length, 2);
    assert.equal(mock.requests.filter(request => request.action === 'get_vod_streams').length, 2);
    assertPrivate(refreshed, mock.origin);
  } finally { await mock.close(); }
});

test('live playlist reloads retain the resolved upstream session instead of restarting bootstrap', async () => {
  const mock = await fixture({ bootstrapRedirect: true });
  try {
    const session = await loginFixture(mock);
    const cookie = sessionCookie(session);
    await session.json();
    for (let reload = 0; reload < 2; reload++) {
      const response = await fetch(`${mock.base}/api/play/live/101/index.m3u8`, { headers: { Cookie: cookie } });
      assert.equal(response.status, 200);
      const manifest = await response.text();
      assert.match(manifest, /^#EXTM3U/);
      assertPrivate(manifest, mock.origin);
    }
    assert.equal(mock.requests.filter(request => request.path === `/live/${username}/${password}/101.m3u8`).length, 1);
    assert.equal(mock.requests.filter(request => request.path === '/redirect-session/1/index.m3u8').length, 2);
    assert.ok(!mock.requests.some(request => request.path === '/redirect-session/2/index.m3u8'));
  } finally { await mock.close(); }
});

test('an expired resolved playlist bootstraps once for each supported expiration response', async t => {
  for (const status of [401, 403, 404, 410]) await t.test(`HTTP ${status}`, async () => {
    const mock = await fixture({ bootstrapRedirect: true });
    try {
      const session = await loginFixture(mock);
      const cookie = sessionCookie(session);
      await session.json();
      const first = await fetch(`${mock.base}/api/play/live/101/index.m3u8`, { headers: { Cookie: cookie } });
      assert.equal(first.status, 200);
      await first.text();
      mock.expireResolvedPlaylist(status);
      const recovered = await fetch(`${mock.base}/api/play/live/101/index.m3u8`, { headers: { Cookie: cookie } });
      assert.equal(recovered.status, 200);
      assert.match(await recovered.text(), /^#EXTM3U/);
      assert.equal(mock.requests.filter(request => request.path === `/live/${username}/${password}/101.m3u8`).length, 2);
      assert.equal(mock.requests.filter(request => request.path === '/redirect-session/1/index.m3u8').length, 2);
      assert.equal(mock.requests.filter(request => request.path === '/redirect-session/2/index.m3u8').length, 1);
    } finally { await mock.close(); }
  });
});

test('a failed replacement playlist ends after one bootstrap retry without a session loop', async () => {
  const mock = await fixture({ bootstrapRedirect: true });
  try {
    const session = await loginFixture(mock);
    const cookie = sessionCookie(session);
    await session.json();
    const first = await fetch(`${mock.base}/api/play/live/101/index.m3u8`, { headers: { Cookie: cookie } });
    assert.equal(first.status, 200);
    await first.text();
    mock.expireAllResolvedPlaylists(403);
    const failed = await fetch(`${mock.base}/api/play/live/101/index.m3u8`, { headers: { Cookie: cookie } });
    assert.equal(failed.status, 502);
    assertPrivate(await failed.json(), mock.origin);
    assert.equal(mock.requests.filter(request => request.path === `/live/${username}/${password}/101.m3u8`).length, 2);
    assert.equal(mock.requests.filter(request => /^\/redirect-session\/\d+\/index\.m3u8$/.test(request.path)).length, 3);
  } finally { await mock.close(); }
});

test('a truncated upstream segment is recorded as a failure instead of a user cancellation', async () => {
  const mock = await fixture({ truncatedSegment: true });
  try {
    const session = await loginFixture(mock);
    const cookie = sessionCookie(session);
    await session.json();
    const playlist = await fetch(`${mock.base}/api/play/live/101/index.m3u8`, { headers: { Cookie: cookie } });
    const segment = (await playlist.text()).split('\n').find(line => line && !line.startsWith('#'));
    await assert.rejects(async () => {
      const response = await fetch(mock.base + segment, { headers: { Cookie: cookie } });
      assert.equal(response.status, 200);
      await response.arrayBuffer();
    }, /terminated|fetch failed|other side closed/i);
    const response = await fetch(`${mock.base}/api/diagnostics`, { headers: { Cookie: cookie } });
    const report = await response.json();
    assert.equal(report.playback.segmentSamples, 0);
    assert.equal(report.playback.throughputMbps, null);
    assert.equal(report.assessment.status, 'fair');
    assert.match(report.assessment.detail, /segmento recente falhou/);
    assertPrivate(report, mock.origin);
  } finally { await mock.close(); }
});
