import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { probeMP4Duration } from '../lib/mp4-duration.mjs';

function box(type, payload, extended = false) {
  const header = Buffer.alloc(extended ? 16 : 8);
  header.writeUInt32BE(extended ? 1 : header.length + payload.length);
  header.write(type, 4, 'ascii');
  if (extended) header.writeBigUInt64BE(BigInt(header.length + payload.length), 8);
  return Buffer.concat([header, payload]);
}

export function movieFile({ tail = false, extended = false, version = 0, seconds = 9960, timescale = 1000, ticks } = {}) {
  const header = Buffer.alloc(version === 0 ? 20 : 32);
  header[0] = version;
  header.writeUInt32BE(timescale, version === 0 ? 12 : 20);
  const duration = ticks ?? BigInt(Math.round(seconds * timescale));
  if (version === 0) header.writeUInt32BE(Number(duration), 16);
  else header.writeBigUInt64BE(duration, 24);
  const ftyp = box('ftyp', Buffer.from('isom\0\0\0\0isom'), extended);
  const moov = box('moov', box('mvhd', header, extended), extended);
  const mdat = box('mdat', Buffer.alloc(256 * 1024), extended);
  return Buffer.concat(tail ? [ftyp, mdat, moov] : [ftyp, moov, mdat]);
}

async function fixture(file, { refuse = false, corruptRange = false, truncate = false, hold = false } = {}) {
  const requests = [];
  let bytesSent = 0, entered, disconnected;
  const waiting = new Promise(resolve => { entered = resolve; });
  const closed = new Promise(resolve => { disconnected = resolve; });
  const server = http.createServer((req, res) => {
    requests.push(req.headers);
    res.once('close', disconnected);
    entered();
    if (hold) return;
    if (refuse) {
      res.writeHead(200, { 'Content-Length': file.length, 'Content-Type': 'video/mp4' });
      res.flushHeaders();
      const timer = setInterval(() => {
        const chunk = file.subarray(bytesSent, bytesSent + 8192);
        bytesSent += chunk.length;
        res.write(chunk);
        if (bytesSent === file.length) { clearInterval(timer);res.end(); }
      }, 1);
      res.once('close', () => clearInterval(timer));
      return;
    }
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    assert.ok(range, 'The duration probe must use a bounded byte range.');
    const start = Number(range[1]), end = Math.min(Number(range[2]), file.length - 1);
    const body = file.subarray(start, end + 1);
    res.writeHead(206, {
      'Content-Type': 'video/mp4',
      'Content-Range': `bytes ${start + (corruptRange ? 1 : 0)}-${end}/${file.length}`
    });
    const sent = truncate ? body.subarray(0, body.length - 1) : body;
    bytesSent += sent.length;
    res.end(sent);
  });
  await new Promise((resolve, reject) => { server.once('error', reject);server.listen(0, '127.0.0.1', resolve); });
  return {
    url: `http://127.0.0.1:${server.address().port}/movie.mp4`, requests, waiting, closed,
    get bytesSent() { return bytesSent; },
    async close() { server.closeAllConnections();await new Promise(resolve => server.close(resolve)); }
  };
}

test('MP4 duration reads front or tail moov, including extended boxes and version-one mvhd', async t => {
  for (const options of [{}, { tail: true }, { tail: true, extended: true, version: 1 }, { version: 1, seconds: 2400.5 }]) {
    await t.test(JSON.stringify(options), async () => {
      const file = movieFile(options), mock = await fixture(file);
      try {
        assert.equal(await probeMP4Duration(mock.url, { allowPrivate: true }), options.seconds ?? 9960);
        assert.ok(mock.requests.length <= 3);
        assert.ok(mock.bytesSent <= 64 * 1024 + 128, 'Only the head and box metadata are read.');
        assert.ok(mock.bytesSent < file.length);
      } finally { await mock.close(); }
    });
  }
});

test('invalid, truncated, unsupported and unknown MP4 durations stay absent', async t => {
  const invalidSize = movieFile();invalidSize.writeUInt32BE(7);
  for (const [name, file, options] of [
    ['invalid box size', invalidSize, {}],
    ['unsupported WebM', Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5]), {}],
    ['truncated response', movieFile(), { truncate: true }],
    ['incorrect Content-Range', movieFile(), { corruptRange: true }],
    ['zero timescale', movieFile({ timescale: 0 }), {}],
    ['unknown v0 duration', movieFile({ ticks: 0xffffffffn }), {}],
    ['unknown v1 duration', movieFile({ version: 1, ticks: 0xffffffffffffffffn }), {}],
    ['duration overflow', movieFile({ version: 1, timescale: 1, ticks: 0xffffffffffffffen }), {}]
  ]) {
    await t.test(name, async () => {
      const mock = await fixture(file, options);
      try { assert.equal(await probeMP4Duration(mock.url, { allowPrivate: true }), null); }
      finally { await mock.close(); }
    });
  }
});

test('range refusal aborts a large HTTP 200 body instead of downloading the movie', async () => {
  const file = Buffer.alloc(4 * 1024 * 1024), mock = await fixture(file, { refuse: true });
  try {
    assert.equal(await probeMP4Duration(mock.url, { allowPrivate: true }), null);
    await mock.closed;
    assert.ok(mock.bytesSent < file.length);
    assert.equal(mock.requests.length, 1);
  } finally { await mock.close(); }
});

test('box traversal stops after eight bounded requests without reading media payloads', async () => {
  const file = Buffer.concat(Array.from({ length: 12 }, () => box('free', Buffer.alloc(65536 - 8))));
  const mock = await fixture(file);
  try {
    assert.equal(await probeMP4Duration(mock.url, { allowPrivate: true }), null);
    assert.equal(mock.requests.length, 8);
    assert.ok(mock.bytesSent < 1024 * 1024);
  } finally { await mock.close(); }
});

test('external cancellation and the total deadline close a pending metadata request', async t => {
  for (const external of [true, false]) {
    await t.test(external ? 'preview cancelled' : 'deadline expired', async () => {
      const mock = await fixture(movieFile(), { hold: true }), controller = new AbortController();
      try {
        const probe = probeMP4Duration(mock.url, { allowPrivate: true, signal: controller.signal, timeout: external ? 1000 : 20 });
        await mock.waiting;
        if (external) controller.abort();
        assert.equal(await probe, null);
        await mock.closed;
      } finally { await mock.close(); }
    });
  }
});

test('a metadata redirect never sends portal credentials to the CDN on later range reads', async () => {
  const mock = await fixture(movieFile({ tail: true }));
  const portal = http.createServer((req, res) => res.writeHead(302, { Location: mock.url }).end());
  await new Promise(resolve => portal.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${portal.address().port}/movie.mp4`;
    assert.equal(await probeMP4Duration(url, { allowPrivate: true, headers: { Cookie: 'private=fixture', Authorization: 'Bearer synthetic-token' } }), 9960);
    assert.equal(mock.requests.length, 2);
    for (const request of mock.requests) {
      assert.equal(request.cookie, undefined);
      assert.equal(request.authorization, undefined);
    }
  } finally {
    portal.closeAllConnections();await new Promise(resolve => portal.close(resolve));await mock.close();
  }
});

test('redirect requests share the same eight-request budget', async () => {
  let requests = 0;
  const server = http.createServer((req, res) => { requests++;res.writeHead(302, { Location: '/loop.mp4' }).end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    assert.equal(await probeMP4Duration(`http://127.0.0.1:${server.address().port}/loop.mp4`, { allowPrivate: true }), null);
    assert.equal(requests, 8);
  } finally { server.closeAllConnections();await new Promise(resolve => server.close(resolve)); }
});
