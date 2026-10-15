import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../lib/app-server.mjs';
import { WplayOTTProviderClient, WPLAY_OTT_RPC } from '../lib/wplay-ott-provider.mjs';
import { decodeRPC, encodeRPC } from '../lib/ott-rpc.mjs';

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t, { logoutFailure = false } = {}) {
  const requests = [];
  let origin, cdnOrigin, generation = 0, expired = false;
  const cdn = http.createServer((req, res) => {
    requests.push({ service: 'cdn', url: req.url, headers: req.headers });
    if (expired && req.url === '/session/1/index.m3u8') {
      res.writeHead(410).end('Expired playback session');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' })
      .end('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nsegment.ts\n');
  });
  cdnOrigin = await listen(cdn);
  const provider = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString();
    const data = text ? decodeRPC(JSON.parse(text)).data : undefined;
    const url = new URL(req.url, origin);
    requests.push({ service: 'provider', path: url.pathname, method: req.method, headers: req.headers });
    const account = req.headers.cookie?.match(/private_session=([^;]+)/)?.[1];
    const authenticated = account && req.headers.authorization === `Bearer token-${account}`;
    let result;
    if (url.pathname.endsWith(WPLAY_OTT_RPC.login)) {
      res.setHeader('Set-Cookie', `private_session=${data.identifier}; Path=/; HttpOnly`);
      result = { authenticated: true, accessToken: `token-${data.identifier}`, refreshToken: 'synthetic-refresh' };
    } else if (url.pathname.endsWith(WPLAY_OTT_RPC.logout)) {
      if (logoutFailure) { res.writeHead(503).end('Synthetic logout failure'); return; }
      result = { success: true };
    } else if (!authenticated) {
      res.writeHead(401).end('Synthetic authentication required');
      return;
    } else if (url.pathname.endsWith(WPLAY_OTT_RPC.catalog)) {
      result = { rows: [
        { title: 'Cinema', kind: 'Filme', items: [{ id: 'movie-fixture', title: 'Filme', image: '/art/shared.png', playbackUrl: '/film.mp4' }] },
        { title: 'TV', kind: 'Canal', items: [{ id: 'live-fixture', title: 'Canal', playbackUrl: '/live/start.m3u8' }] }
      ] };
    } else if (url.pathname === '/art/shared.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' }).end(`image-for-${account}`);
      return;
    } else if (url.pathname === '/live/start.m3u8') {
      if (req.method === 'POST') { res.writeHead(204).end(); return; }
      generation++;
      res.writeHead(302, { Location: `${cdnOrigin}/session/${generation}/index.m3u8` }).end();
      return;
    } else {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'x-tss-serialized': 'true' }).end(encodeRPC({ result }));
  });
  origin = await listen(provider);
  // Keep the production route and real OTT authentication/catalog/media logic;
  // redirect only its RPC transport to this local synthetic provider.
  const originalConnect = WplayOTTProviderClient.prototype.connect;
  t.mock.method(WplayOTTProviderClient.prototype, 'connect', function () {
    this.rpc.base = new URL(origin + '/');
    return originalConnect.call(this);
  });
  const app = createApp({ connection: { server: origin }, allowPrivateUpstream: true });
  const base = await listen(app);
  const browser = async username => {
    const response = await fetch(base + '/api/login', {
      method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider:'wplay-ott', username, password: 'synthetic-secret' })
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).connected, true);
    const cookie = response.headers.get('set-cookie').split(';')[0];
    return {
      get: route => fetch(base + route, { headers: { Cookie: cookie } }),
      logout: () => fetch(base + '/api/logout', { method: 'POST', headers: { Cookie: cookie, Origin: base }, body: '{}' })
    };
  };
  return {
    browser, requests, expireManifest: () => { expired = true; },
    async close() {
      for (const server of [app, provider, cdn]) {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
    }
  };
}

test('public session keeps account library identities stable and separates accounts with the same masked username', async t => {
  const mock = await fixture(t);
  try {
    const first = await mock.browser('first1234'), second = await mock.browser('other1234');
    const a = await (await first.get('/api/session')).json(), b = await (await second.get('/api/session')).json();
    assert.equal(a.account.usernameMasked,b.account.usernameMasked);
    assert.match(a.account.libraryId,/^[a-f0-9]{64}$/);
    assert.deepEqual(a.capabilities,{games:true,accountLibrary:true,cloud:false});
    assert.notEqual(a.account.libraryId,b.account.libraryId);
    assert.equal((await (await first.get('/api/session')).json()).account.libraryId,a.account.libraryId);
    assert.equal(JSON.stringify(a).includes('first1234'),false);
    assert.equal(JSON.stringify(a).includes('synthetic-secret'),false);
  } finally { await mock.close(); }
});

test('local logout succeeds and blocks catalog/media even when remote OTT logout fails', async t => {
  const mock = await fixture(t, { logoutFailure: true });
  try {
    const account = await mock.browser('logout-fixture');
    const catalog = await (await account.get('/api/catalog?type=live')).json();
    const play = `/api/play/live/${catalog.items[0].id}/index.m3u8`;
    const playing = await account.get(play);
    assert.equal(playing.status, 200);
    await playing.text();
    const logout = await account.logout();
    assert.equal(logout.status, 200);
    assert.deepEqual(await logout.json(), { connected: false });
    assert.equal((await (await account.get('/api/session')).json()).connected, false);
    for (const route of ['/api/catalog?type=live', play]) {
      const rejected = await account.get(route);
      assert.equal(rejected.status, 401);
      await rejected.json();
    }
    assert.equal(mock.requests.filter(request => request.path?.endsWith(WPLAY_OTT_RPC.logout)).length, 1);
  } finally { await mock.close(); }
});

test('same image URL is cached within a client and isolated across authenticated clients', async t => {
  const mock = await fixture(t);
  try {
    const first = await mock.browser('image-first');
    const second = await mock.browser('image-second');
    const poster = async account => (await (await account.get('/api/catalog?type=movies')).json()).items[0].poster;
    const firstPoster = await poster(first), secondPoster = await poster(second);
    assert.equal(await (await first.get(firstPoster)).text(), 'image-for-image-first');
    assert.equal(await (await first.get(firstPoster)).text(), 'image-for-image-first');
    assert.equal(await (await second.get(secondPoster)).text(), 'image-for-image-second');
    assert.equal(await (await second.get(secondPoster)).text(), 'image-for-image-second');
    const images = mock.requests.filter(request => request.path === '/art/shared.png');
    assert.equal(images.length, 2, 'Each client fetches its own image once.');
    assert.deepEqual(images.map(request => request.headers.cookie), ['private_session=image-first', 'private_session=image-second']);
  } finally { await mock.close(); }
});

test('expired cross-origin manifest returns to its entry URL with the portal credentials', async t => {
  const mock = await fixture(t);
  try {
    const account = await mock.browser('manifest-fixture');
    const catalog = await (await account.get('/api/catalog?type=live')).json();
    const play = `/api/play/live/${catalog.items[0].id}/index.m3u8`;
    const first = await account.get(play);
    assert.equal(first.status, 200);
    assert.match(await first.text(), /^#EXTM3U/);
    mock.expireManifest();
    const recovered = await account.get(play);
    assert.equal(recovered.status, 200);
    assert.match(await recovered.text(), /^#EXTM3U/);
    const entries = mock.requests.filter(request => request.path === '/live/start.m3u8' && request.method === 'GET');
    assert.equal(entries.length, 2);
    for (const entry of entries) {
      assert.equal(entry.headers.cookie, 'private_session=manifest-fixture');
      assert.equal(entry.headers.authorization, 'Bearer token-manifest-fixture');
    }
    assert.ok(mock.requests.some(request => request.service === 'cdn' && request.url === '/session/2/index.m3u8'));
    for (const request of mock.requests.filter(request => request.service === 'cdn')) {
      assert.equal(request.headers.cookie, undefined);
      assert.equal(request.headers.authorization, undefined);
    }
  } finally { await mock.close(); }
});
