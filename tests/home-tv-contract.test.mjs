import test from 'node:test';
import assert from 'node:assert/strict';
import {homeTVReply, genericGloboName, defaultGloboName} from '../web/inicio/lista-canais/contrato.js';

const entry = (id, reason = 'recent') => ({item: {id, kind: 'live', name: `Canal ${id}`, isAdult: false},
  reason, watchedSeconds: 10, lastWatchedAt: '2026-10-17T00:00:00Z'});
const reply = () => ({schemaVersion: 1, source: 'rpc', revision: 3,
  generatedAt: '2026-10-17T01:00:00Z', snapshotVersion: '11111111-1111-4111-8111-111111111111',
  featuredId: '1', mostWatchedId: '1', items: [entry('1', 'most-watched'), ...['2', '3', '4', '5'].map(id => entry(id))]});
const fallback = () => ({...reply(), mostWatchedId: null, items: [{
  item: {id: '1', kind: 'live', name: 'TV Globo [HD]', isAdult: false}, reason: 'default-globo',
  watchedSeconds: 0, lastWatchedAt: null}, ...['2', '3', '4', '5'].map(id => entry(id))]});

test('weekly feature plus four distinct recent channels retains RPC order', () => {
  const value = reply();
  assert.equal(homeTVReply(value), value);
  assert.deepEqual(value.items.map(row => row.item.id), ['1', '2', '3', '4', '5']);
  const legacy = reply(); delete legacy.featuredId; legacy.items.pop();
  assert.equal(homeTVReply(legacy), legacy);
});

test('Globo default is explicitly featured without invented recency or measured time', () => {
  const value = fallback();
  assert.equal(homeTVReply(value), value);
  for (const change of [row => { row.watchedSeconds = 1; }, row => { row.lastWatchedAt = '2026-10-17T00:00:00Z'; },
    row => { row.item.name = 'Globo News'; }, row => { row.item.name = 'Globoplay Novelas'; }]) {
    const invalid = fallback(); change(invalid.items[0]);
    assert.throws(() => homeTVReply(invalid), {code: 'HOME_TV_RESPONSE_INVALID'});
  }
});

test('Globo identity keeps region, affiliate and other network names distinct', () => {
  for (const name of ['Globo', 'TV Globo [HD]', 'Rede Globo Full HD H.265', 'Globo 4K']) assert.equal(genericGloboName(name), true, name);
  for (const name of ['GloboNews', 'Globo News', 'Globoplay Novelas', 'Globo RJ', 'Globo TV Sergipe', 'TV Globo 2 HD']) {
    assert.equal(genericGloboName(name), false, name);
  }
  for (const name of ['Globo SP', 'Globo TV Sergipe']) assert.equal(defaultGloboName(name), true, name);
  for (const name of ['GloboNews', 'Globo News', 'Globoplay Novelas', 'Globo Play Novelas']) assert.equal(defaultGloboName(name), false, name);
  const editorial = fallback(); editorial.items[0].item.name = 'Globo SP';
  assert.equal(homeTVReply(editorial), editorial, 'A regional name stays intact when selected as the editorial catalogue default.');
});

test('projection rejects mismatched feature, duplicate IDs, five recents and mixed defaults', () => {
  const cases = [value => { value.featuredId = '2'; }, value => { value.items[4].item.id = '1'; },
    value => { value.items.push(entry('6')); }, value => { value.items[0] = entry('1'); },
    value => { value.items[1].lastWatchedAt = null; }, value => { value.items[1].reason = 'default-globo'; }];
  for (const mutate of cases) {
    const value = reply(); mutate(value);
    assert.throws(() => homeTVReply(value), {code: 'HOME_TV_RESPONSE_INVALID'});
  }
  const noFeature = {...reply(), featuredId: null, mostWatchedId: null, items: ['2', '3', '4', '5'].map(id => entry(id))};
  assert.equal(homeTVReply(noFeature), noFeature);
  noFeature.items.push(entry('6'));
  assert.throws(() => homeTVReply(noFeature), {code: 'HOME_TV_RESPONSE_INVALID'});
});
