import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { createApp } from '../lib/app-server.mjs';
import { WplayOTTProviderClient, WPLAY_OTT_RPC } from '../lib/wplay/ott/provedor.mjs';
import { encodeRPC, decodeRPC } from '../lib/wplay/ott/rpc.mjs';

function mp4(seconds) {
  const atom = (type, body) => {
    const header = Buffer.alloc(8);header.writeUInt32BE(body.length + 8);header.write(type, 4);
    return Buffer.concat([header, body]);
  };
  const mvhd = Buffer.alloc(20);mvhd.writeUInt32BE(1000, 12);mvhd.writeUInt32BE(seconds * 1000, 16);
  return Buffer.concat([atom('ftyp', Buffer.from('isom\0\0\0\0isom')), atom('mdat', Buffer.alloc(128 * 1024)), atom('moov', atom('mvhd', mvhd))]);
}

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject);server.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture({ knownDuration = false, holdMovie = false, score = 72 } = {}) {
  const requests = [], transfers = [];
  let entered, disconnected;
  const movieRequested = new Promise(resolve => { entered = resolve; });
  const movieClosed = new Promise(resolve => { disconnected = resolve; });
  const files = { '/movie.mp4': mp4(9960), '/episode.mp4': mp4(2400), '/episode-two.mp4': mp4(3600) };
  const server = http.createServer(async (req, res) => {
    const text = [];for await (const chunk of req) text.push(chunk);
    const body = Buffer.concat(text).toString(), data = body ? decodeRPC(JSON.parse(body)).data : undefined;
    const path = new URL(req.url, 'http://localhost').pathname;
    requests.push({ path, headers: req.headers });
    const id = path.split('/').pop();
    let result;
    if (id === WPLAY_OTT_RPC.login) {
      res.setHeader('Set-Cookie', 'private_session=metadata-fixture; Path=/; HttpOnly');
      result = { authenticated: true, accessToken: 'synthetic-access-token' };
    } else if (req.headers.cookie !== 'private_session=metadata-fixture' || req.headers.authorization !== 'Bearer synthetic-access-token') {
      res.writeHead(401).end();return;
    } else if (id === WPLAY_OTT_RPC.catalog) {
      result = { rows: [
        { title: 'Cinema', kind: 'Filme', items: [{ id: 'movie-fixture', title: 'Filme', description: 'compressible metadata '.repeat(8000), score, playbackUrl: '/movie.mp4', ...(knownDuration ? { durationSeconds: 9960 } : {}) }] },
        { title: 'Séries', kind: 'Série', items: [{ id: 'series-fixture', title: 'Série' }] }
      ] };
    } else if (id === WPLAY_OTT_RPC.artwork) {
      result = { artwork: knownDuration && data.kind === 'Filme' ? { durationMinutes: 106, score: 81 } : null };
    } else if (id === WPLAY_OTT_RPC.episodes) {
      result = { episodes: [
        { id: 'episode-one', title: 'Piloto', season: 1, episode: 1, playbackUrl: '/episode.mp4', ...(knownDuration ? { duration_seconds: '2400' } : {}) },
        { id: 'episode-two', title: 'Segundo', season: 1, episode: 2, playbackUrl: '/episode-two.mp4' }
      ] };
    } else if (files[path]) {
      if (path === '/movie.mp4') {
        entered();res.once('close', disconnected);
        if (holdMovie) return;
      }
      const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
      assert.ok(match, 'Metadata reads must never start unrestricted playback.');
      const file = files[path], start = Number(match[1]), end = Math.min(Number(match[2]), file.length - 1);
      res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${start}-${end}/${file.length}` }).end(file.subarray(start, end + 1));
      return;
    } else { res.writeHead(404).end();return; }
    const plain = Buffer.from(encodeRPC({ result })), compressed = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    const wire = compressed ? gzipSync(plain) : plain;
    transfers.push({ id, plain: plain.length, wire: wire.length, compressed });
    res.writeHead(200, { 'Content-Type': 'application/json', 'x-tss-serialized': 'true', ...(compressed ? { 'Content-Encoding': 'gzip' } : {}) }).end(wire);
  });
  const origin = await listen(server);
  const client = new WplayOTTProviderClient({ server: origin, username: 'metadata-fixture', password: 'synthetic-secret' }, { allowPrivate: true });
  return {
    client, origin, requests, transfers, movieRequested, movieClosed,
    releaseMovie() { holdMovie = false; },
    async close() { await client.stopPlayback();server.closeAllConnections();await new Promise(resolve => server.close(resolve)); }
  };
}

test('RPC metadata uses compressed delivery and preserves explicit catalog, artwork and episode durations', async () => {
  const mock = await fixture({ knownDuration: true });
  try {
    const movies = await mock.client.catalog('movies'), series = await mock.client.catalog('series');
    assert.equal(movies.items[0].duration, '2 h 46 min');
    assert.equal(movies.items[0].durationSeconds, 9960);
    assert.equal(movies.items[0].rating, 7.2);
    const movie = await mock.client.details('movie', movies.items[0].id, { probeDuration: true });
    assert.equal(movie.duration, '1 h 46 min');assert.equal(movie.durationSeconds, 6360);
    assert.equal(movie.rating, 8.1);
    const show = await mock.client.details('series', series.items[0].id, { probeDuration: true });
    assert.equal(show.seasons[0].episodes[0].duration, '40 min');
    assert.equal(show.seasons[0].episodes[0].durationSeconds, 2400);
    assert.equal(show.duration, '');assert.equal(show.durationLabel, undefined);
    assert.equal(mock.requests.filter(request => request.headers.range).length, 0);
    const catalog = mock.transfers.find(transfer => transfer.id === WPLAY_OTT_RPC.catalog);
    assert.ok(catalog.compressed);assert.ok(catalog.wire < catalog.plain / 10);
  } finally { await mock.close(); }
});

test('OTT relevance values outside its observed 0–100 scale do not become star ratings', async () => {
  for (const score of [-1, 101, 'invalid']) {
    const mock = await fixture({ score });
    try { assert.equal((await mock.client.catalog('movies')).items[0].rating, 0); }
    finally { await mock.close(); }
  }
});

test('duration probes require an explicit preview, reuse private cache and leave normal details unchanged', async () => {
  const mock = await fixture();
  try {
    const movie = (await mock.client.catalog('movies')).items[0], series = (await mock.client.catalog('series')).items[0];
    assert.equal((await mock.client.details('movie', movie.id)).duration, '');
    assert.equal(mock.requests.filter(request => request.headers.range).length, 0);
    const preview = await mock.client.details('movie', movie.id, { probeDuration: true });
    assert.equal(preview.duration, '2 h 46 min');assert.equal(preview.durationSeconds, 9960);
    const reads = mock.requests.filter(request => request.path === '/movie.mp4').length;
    assert.equal((await mock.client.details('movie', movie.id)).duration, '');
    assert.equal((await mock.client.details('movie', movie.id, { probeDuration: true })).durationSeconds, 9960);
    assert.equal(mock.requests.filter(request => request.path === '/movie.mp4').length, reads);
    const show = await mock.client.details('series', series.id, { probeDuration: true });
    assert.equal(show.duration, '');assert.equal(show.durationLabel, undefined);
    assert.equal(show.seasons[0].episodes[0].durationSeconds, null);
    assert.equal(mock.requests.filter(request => request.path === '/episode.mp4').length, 0);
    assert.equal(show.seasons[0].episodes[1].duration, '');
    assert.equal(mock.requests.filter(request => request.path === '/episode-two.mp4').length, 0);
    const unchanged = await mock.client.details('series', series.id);
    assert.equal(unchanged.duration, '');assert.equal(unchanged.durationLabel, undefined);
    assert.ok(!JSON.stringify([preview, show]).includes(mock.origin));
  } finally { await mock.close(); }
});

test('beginning playback aborts the preview probe and does not cache an unknown duration', async () => {
  const mock = await fixture({ holdMovie: true });
  try {
    const movie = (await mock.client.catalog('movies')).items[0];
    const pending = mock.client.details('movie', movie.id, { probeDuration: true });
    await mock.movieRequested;
    mock.client.beginPlayback('movie:' + movie.id);
    assert.equal((await pending).duration, '');await mock.movieClosed;
    assert.equal(mock.client.durationProbe, null);
    await mock.client.stopPlayback();mock.releaseMovie();
    assert.equal((await mock.client.details('movie', movie.id, { probeDuration: true })).durationSeconds, 9960);
  } finally { await mock.close(); }
});

test('a fast preview reopen starts a new duration read before the aborted cached promise rejects', async () => {
  const mock = await fixture({ holdMovie: true });
  try {
    await mock.client.connect();
    const source = new URL('/movie.mp4', mock.origin), controller = new AbortController();
    const first = mock.client.durationForSource(source, controller.signal);
    await mock.movieRequested;
    mock.releaseMovie();controller.abort();
    // Reopen in the same turn, before the old request's error/catch can remove
    // its memo entry. Its rejection must also leave the new memo entry intact.
    const reopened = mock.client.durationForSource(source);
    assert.equal(await reopened, 9960);
    assert.equal(await first, null);
    const reads = mock.requests.filter(request => request.path === '/movie.mp4').length;
    assert.equal(await mock.client.durationForSource(source), 9960);
    assert.equal(mock.requests.filter(request => request.path === '/movie.mp4').length, reads);
  } finally { await mock.close(); }
});

test('app details only probes duration=1 and cancels upstream metadata when its preview request closes', async t => {
  const mock = await fixture({ holdMovie: true });
  const originalConnect = WplayOTTProviderClient.prototype.connect;
  t.mock.method(WplayOTTProviderClient.prototype, 'connect', function () {
    this.rpc.base = new URL(mock.origin + '/');return originalConnect.call(this);
  });
  const app = createApp({ connection: { server: mock.origin }, allowPrivateUpstream: true });
  const base = await listen(app);
  try {
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ provider:'wplay-ott', username: 'metadata-fixture', password: 'synthetic-secret' }) });
    assert.equal(login.status, 200);await login.json();
    const headers = { Cookie: login.headers.get('set-cookie').split(';')[0] };
    const catalog = await (await fetch(base + '/api/catalog?type=movies', { headers })).json();
    const route = `/api/details?type=movie&id=${catalog.items[0].id}`;
    const normal = await fetch(base + route, { headers });assert.equal(normal.status, 200);await normal.json();
    assert.equal(mock.requests.filter(request => request.headers.range).length, 0);
    const controller = new AbortController();
    const duration = fetch(base + route + '&duration=1', { headers, signal: controller.signal });
    await mock.movieRequested;controller.abort();
    await assert.rejects(duration, error => error.name === 'AbortError');await mock.movieClosed;
    mock.releaseMovie();
    const retried = await fetch(base + route + '&duration=1', { headers });
    assert.equal(retried.status, 200);assert.equal((await retried.json()).durationSeconds, 9960);
  } finally {
    app.closeAllConnections();await new Promise(resolve => app.close(resolve));await mock.close();
  }
});
