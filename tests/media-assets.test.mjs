import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaAssets } from '../lib/media-assets.mjs';
import { ProviderClient } from '../lib/provider.mjs';

const base = 'https://provider.invalid/live/private/index.m3u8';
const makeClient = () => new ProviderClient({ server: 'https://provider.invalid', username: 'fixture-user', password: 'fixture-password' });
const playlist = (sequence, segments) => ['#EXTM3U', '#EXT-X-TARGETDURATION:1',
  '#EXT-X-MEDIA-SEQUENCE:' + sequence, ...segments.flatMap(id => ['#EXTINF:1,', `hls-seg-${id}.ts`]), ''].join('\n');
const segments = value => value.split('\n').filter(line => line && !line.startsWith('#'));

test('live playlist reloads retain each overlapping segment URI and do not grow the registry', () => {
  const client = makeClient(); client.beginPlayback('live:12');
  const first = segments(client.rewriteManifest(playlist(40, [40, 41, 42]), base, 'live:12'));
  const same = segments(client.rewriteManifest(playlist(40, [40, 41, 42]), base, 'live:12'));
  assert.deepEqual(same, first);
  assert.equal(client.assets.size, 3);
  const next = segments(client.rewriteManifest(playlist(41, [41, 42, 43]), base, 'live:12'));
  assert.deepEqual(next.slice(0, 2), first.slice(1));
  assert.equal(client.assets.size, 4);
  assert.doesNotMatch(next.join(''), /provider|private|hls-seg|fixture/);
});

test('segment name reuse at a new sequence or discontinuity does not reuse cached media identity', () => {
  const client = makeClient(); client.beginPlayback('live:12');
  const a = client.rewriteManifest(playlist(40, [1]), base, 'live:12');
  const b = client.rewriteManifest(playlist(41, [1]), base, 'live:12');
  const c = client.rewriteManifest(playlist(40, [1]).replace('#EXTINF', '#EXT-X-DISCONTINUITY\n#EXTINF'), base, 'live:12');
  assert.notEqual(segments(a)[0], segments(b)[0]);
  assert.notEqual(segments(a)[0], segments(c)[0]);
});

test('keys, init sections and variant playlists also have stable private URIs', () => {
  const client = makeClient(); client.beginPlayback('live:12');
  const manifest = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin?secret=fixture"\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-STREAM-INF:BANDWIDTH=100000\nvideo.m3u8\n';
  const a = client.rewriteManifest(manifest, base, 'live:12');
  assert.equal(client.rewriteManifest(manifest, base, 'live:12'), a);
  assert.equal(client.assets.size, 3);
  assert.doesNotMatch(a, /provider|secret|fixture|key.bin|init.mp4|video.m3u8/);
});

test('tokens are isolated by account instance and revoked on stop, channel change or clear', () => {
  const client = makeClient(), other = makeClient();
  client.beginPlayback('live:12'); other.beginPlayback('live:12');
  const create = instance => segments(instance.rewriteManifest(playlist(40, [40]), base, 'live:12'))[0];
  const a = create(client);
  assert.notEqual(create(other), a);
  client.stopPlayback();
  assert.equal(client.assets.get(a.slice('/api/asset/'.length)), undefined);
  client.beginPlayback('live:12'); assert.notEqual(create(client), a);
  const b = create(client); client.beginPlayback('live:13'); client.beginPlayback('live:12');
  assert.notEqual(create(client), b);
  const c = create(client); client.assets.clear(); assert.notEqual(create(client), c);
});

test('registry has a hard bound and keeps recently reloaded assets', () => {
  const assets = new MediaAssets();
  const first = assets.register('https://provider.invalid/0.ts', 'live:1');
  for (let i = 1; i < 3000; i++) assets.register(`https://provider.invalid/${i}.ts`, 'live:1');
  assert.equal(assets.register('https://provider.invalid/0.ts', 'live:1'), first);
  assets.register('https://provider.invalid/3000.ts', 'live:1');
  assert.equal(assets.size, 3000);
  assert.ok(assets.has(first.slice('/api/asset/'.length)));
});
