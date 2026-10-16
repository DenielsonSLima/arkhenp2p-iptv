import test from 'node:test';
import assert from 'node:assert/strict';
import { artworkURL, loadChannelLogos, logoGeometry } from '../web/channel-artwork.js';
import {preloadArtwork} from '../web/login/capas.js';

const alagoas = '/assets/channels/globo-alagoas-0123456789abcdef.webp';
const sergipe = '/assets/channels/globo-sergipe-fedcba9876543210.webp';
const bbc = '/assets/channels/bbc-one-1234567890abcdef.webp';
const shifted = '/assets/channels/bbc-one-plus2-abcdef0123456789.webp';
const camera1 = '/assets/channels/bbb-camera1-12345678abcdef90.webp';
const camera2 = '/assets/channels/bbb-camera2-abcdef9012345678.webp';
const channel = (id, name, kind = 'live') => ({id, name, kind});
const resolverFor = channels => loadChannelLogos(async () => ({ok: true, json: async () => ({version: 1, channels})}));

test('artwork accepts authenticated image refs and bounded local WebP logos', () => {
  for (const value of [alagoas, '/api/image?ref=private_123-abc', '/assets/channels/tv-12345678.webp']) assert.equal(artworkURL(value), value);
  for (const value of [null, {}, '', 'https://example.com/logo.webp', '//example.com/a', 'data:image/png;base64,a', 'javascript:alert(1)',
    '/assets/channels/../brand/symbol.webp', '/assets/channels/%2e%2e/a-12345678.webp', '/assets/channels/a%2fb-12345678.webp',
    '/assets/channels/Globo-12345678.webp', '/assets/channels/globo-12345678.png', '/assets/channels/globo.webp',
    alagoas + '?v=1', alagoas + '#fragment', alagoas + '\n', '/assets/channels/' + 'a'.repeat(71) + '-12345678.webp',
    '/api/image?', '/api/image?ref=a#fragment', '/api/image?ref=a b', '/api/image?ref=a\\b', '/api/image?ref=' + 'a'.repeat(2048)]) {
    assert.equal(artworkURL(value), '', String(value));
  }
});

test('quality variants normalize terminal tags, accents and punctuation while retaining identity', async () => {
  const resolver = await resolverFor([{file: alagoas, ids: ['10'], names: ['Globo TV Gazeta Alagoas HD']}]);
  for (const name of ['Globo TV Gazeta Alagoas', 'GLOBO – TV GAZETA ALÁGOAS FHD', 'Globo TV Gazeta Alagoas [4K] HEVC H.265', 'Globo TV Gazeta Alagoas UHD HD']) {
    assert.equal(resolver.resolve(channel('10', name)), alagoas);
    assert.equal(resolver.resolve(channel('999', name)), alagoas);
  }
  assert.equal(resolver.resolve(channel(10, 'Globo TV Gazeta Alagoas SD')), alagoas);
  for (const name of ['Globo TV Gazeta', 'Globo TV Gazeta Alagoas HD Extra', 'Globo TV Gazeta Alagoas HD 1', 'Globo TV Gazeta Alagoas +2']) {
    assert.equal(resolver.resolve(channel('10', name)), '');
  }
});

test('an existing ID requires a compatible name and never aliases regional affiliates', async () => {
  const resolver = await resolverFor([
    {file: alagoas, ids: ['10'], names: ['Globo TV Gazeta Alagoas HD']},
    {file: sergipe, ids: ['11'], names: ['Globo TV Sergipe HD']}
  ]);
  assert.equal(resolver.resolve(channel('10', 'Globo TV Sergipe HD')), '');
  assert.equal(resolver.resolve(channel('11', 'Globo TV Gazeta Alagoas HD')), '');
  assert.equal(resolver.resolve(channel('999', 'Globo TV Sergipe FHD')), sergipe);
  assert.equal(resolver.resolve(channel('999', 'Globo TV Gazeta São Paulo HD')), '');
  assert.equal(resolver.resolve(channel('999', 'Globo')), '');
});

test('observed APK and OTT spellings match the main network without mixing numbered or regional channels', async () => {
  const resolver = await resolverFor([
    {file: bbc, ids:['100'], names:['SporTV', 'SporTV 4K']},
    {file: shifted, ids:['101'], names:['SporTV 2']},
    {file: camera1, ids:['102'], names:['Rede TV']}
  ]);
  assert.equal(resolver.resolve(channel('999', 'SporTV 1 HD')), bbc);
  assert.equal(resolver.resolve(channel('999', 'SporTV 2 HD')), shifted);
  assert.equal(resolver.resolve(channel('999', 'SporTV 3 HD')), '');
  assert.equal(resolver.resolve(channel('999', 'RedeTV! 4K')), camera1);
  assert.equal(resolver.resolve(channel('999', 'RedeTV Paraíba HD')), '');
  assert.equal(resolver.resolve(channel('101', 'SporTV 1 HD')), '');
});

test('time-shift markers and camera numbers remain distinct across quality variants', async () => {
  const resolver = await resolverFor([
    {file: bbc, ids: ['20'], names: ['BBC One HD']},
    {file: shifted, ids: ['21'], names: ['BBC One +2 HD']},
    {file: camera1, ids: ['30'], names: ['BBB – Câmera 1 HD']},
    {file: camera2, ids: ['31'], names: ['BBB – Câmera 2 HD']}
  ]);
  assert.equal(resolver.resolve(channel('999', 'BBC One + 2 FHD')), shifted);
  assert.equal(resolver.resolve(channel('20', 'BBC One +2 HD')), '');
  assert.equal(resolver.resolve(channel('999', 'BBC One 2 HD')), '');
  assert.equal(resolver.resolve(channel('999', 'BBB CÂMERA 1 UHD')), camera1);
  assert.equal(resolver.resolve(channel('999', 'BBB Câmera 2 HEVC')), camera2);
  assert.equal(resolver.resolve(channel('30', 'BBB Câmera 2 HD')), '');
});

test('name fallback resolves only an unambiguous file and conflicting IDs also stay unresolved', async () => {
  const ambiguous = await resolverFor([
    {file: bbc, ids: ['20'], names: ['BBC One HD']},
    {file: shifted, ids: ['21'], names: ['BBC One FHD']}
  ]);
  assert.equal(ambiguous.resolve(channel('999', 'BBC One UHD')), '');
  assert.equal(ambiguous.resolve(channel('20', 'BBC One FHD')), bbc);
  const sameFile = await resolverFor([
    {file: bbc, ids: ['20'], names: ['BBC One HD']},
    {file: bbc, ids: ['21'], names: ['BBC One FHD']}
  ]);
  assert.equal(sameFile.resolve(channel('999', 'BBC One UHD')), bbc);
  const conflictingID = await resolverFor([
    {file: bbc, ids: ['20'], names: ['BBC One HD']},
    {file: shifted, ids: ['20'], names: ['BBC One FHD']}
  ]);
  assert.equal(conflictingID.resolve(channel('20', 'BBC One')), '');
});

test('malformed manifest rows are ignored without blocking valid logos', async () => {
  const invalid = [
    {file: bbc, ids: [20], names: ['BBC One']}, {file: bbc, ids: ['-20'], names: ['BBC One']},
    {file: bbc, ids: ['20x'], names: ['BBC One']}, {file: bbc, ids: ['1234567890123'], names: ['BBC One']},
    {file: bbc, ids: [], names: ['BBC One']}, {file: bbc, ids: ['20'], names: []},
    {file: bbc, ids: ['20'], names: ['HD']}, {file: bbc, ids: ['20'], names: [22]},
    {file: bbc, ids: ['20'], names: ['a'.repeat(301)]}, {file: '/api/image?ref=a', ids: ['20'], names: ['BBC One']},
    {file: bbc + '?v=1', ids: ['20'], names: ['BBC One']}, {file: '/assets/channels/../bad-12345678.webp', ids: ['20'], names: ['BBC One']}, null
  ];
  const resolver = await resolverFor([...invalid, {file: alagoas, ids: ['10'], names: ['Globo TV Gazeta Alagoas']}]);
  assert.equal(resolver.resolve(channel('20', 'BBC One')), '');
  assert.equal(resolver.resolve(channel('10', 'Globo TV Gazeta Alagoas HD')), alagoas);
  for (const manifest of [null, {}, {version: 2, channels: []}, {version: 1, channels: {}}, {version: 1, channels: new Array(10001)}]) {
    const empty = await loadChannelLogos(async () => ({ok: true, json: async () => manifest}));
    assert.equal(empty.resolve(channel('10', 'Globo TV Gazeta Alagoas')), '');
  }
});

test('only valid live catalogue items can resolve channel logos', async () => {
  const resolver = await resolverFor([{file: bbc, ids: ['20'], names: ['BBC One']}]);
  for (const item of [null, channel('20', 'BBC One', 'movie'), channel('20', 'BBC One', 'series'),
    channel('', 'BBC One'), channel(undefined, 'BBC One'), channel('abc', 'BBC One'), channel(-20, 'BBC One'),
    channel(20.5, 'BBC One'), channel('20', null), channel('20', 'HD')]) assert.equal(resolver.resolve(item), '');
});

test('manifest loading is optional and failed fetch, HTTP or JSON responses return an empty resolver', async () => {
  let requested;
  const good = await loadChannelLogos(async (path, options) => {requested = {path, options}; return {ok: true, json: async () => ({version: 1, channels: [{file: bbc, ids: ['20'], names: ['BBC One']}]})};});
  assert.deepEqual(requested, {path: '/assets/channels/manifest.json', options: {cache: 'no-store'}});
  assert.equal(good.resolve(channel('20', 'BBC One')), bbc);
  for (const fetchFn of [null, async () => {throw new Error('offline');}, async () => ({ok: false}), async () => ({ok: true, json: async () => {throw new Error('bad JSON');}})]) {
    const empty = await loadChannelLogos(fetchFn); assert.equal(empty.resolve(channel('20', 'BBC One')), '');
  }
});

test('opening artwork preparation warms local logos alongside proxy images and skips unsafe paths', async () => {
  const requested = [], createImage = () => ({decode: async () => {}, set src(value) {requested.push(value); setImmediate(() => this.onload?.());}});
  const result = await preloadArtwork([alagoas, alagoas, '/api/image?ref=existing', alagoas + '?v=1', '/assets/brand/symbol.svg'], {createImage});
  assert.deepEqual(requested, [alagoas, '/api/image?ref=existing']);
  assert.deepEqual(result, {completed: 2, loaded: 2, total: 2});
});

test('logo framing removes transparent padding while preserving the visible aspect ratio', () => {
  const geometry = logoGeometry({width:256,height:256,bounds:[62,95,135,75]});
  const width = parseFloat(geometry.width) / 100 * 3, height = parseFloat(geometry.height) / 100 * 2;
  assert.ok(Math.abs(width / height - 1) < 0.00001);
  assert.ok(Math.abs(width * 135 / 256 - 2.46) < 0.00001);
  assert.ok(Math.abs(parseFloat(geometry.left) / 100 * 3 + width * (62 + 135 / 2) / 256 - 1.5) < 0.00001);
  assert.ok(Math.abs(parseFloat(geometry.top) / 100 * 2 + height * (95 + 75 / 2) / 256 - 1) < 0.00001);
});

test('invalid logo bounds cannot create unbounded transforms and valid rows remain optional', async () => {
  for(const value of [null,{}, {width:256,height:256,bounds:[-1,0,20,20]}, {width:256,height:256,bounds:[0,0,257,20]}, {width:256,height:256,bounds:[0,0,0,20]}, {width:256,height:256,bounds:[0,0,'20',20]}]) assert.equal(logoGeometry(value),null);
  const resolver = await resolverFor([{file:bbc,ids:['20'],names:['BBC One'],artwork:{width:256,height:256,bounds:[62,95,135,75]}}]);
  assert.equal(resolver.resolve(channel('20','BBC One')),bbc);
  assert.ok(resolver.geometry(bbc));
  assert.equal(resolver.geometry('/api/image?ref=remote'),null);
});
