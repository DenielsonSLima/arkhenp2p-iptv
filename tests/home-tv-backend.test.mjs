import test from 'node:test';
import assert from 'node:assert/strict';
import {ConectorHomeTvSupabase} from '../lib/tv/home-conector-supabase.mjs';

const channel = (id, name = `Canal ${id}`) => ({id, name, kind: 'live', isAdult: false});
const projection = () => ({schemaVersion: 1, source: 'rpc', revision: 1, generatedAt: '2026-10-17T01:00:00Z',
  snapshotVersion: '11111111-1111-4111-8111-111111111111', featuredId: '1', mostWatchedId: null,
  items: [{item: channel('1', 'TV Globo HD'), reason: 'default-globo', watchedSeconds: 0, lastWatchedAt: null},
    ...['2', '3', '4', '5'].map(id => ({item: channel(id), reason: 'recent', watchedSeconds: 0, lastWatchedAt: '2026-10-17T00:00:00Z'}))]});
function fixture() {
  const value = projection(), calls = [], state = {authGeneration: 1, cloud: {providerKey: 'a'.repeat(64), scopeHash: 'b'.repeat(64),
    session: {access_token: 'synthetic-only'}}, client: {session: {connected: true}}};
  const runtime = {enabled: true, catalog: async () => ({items: value.items.map(row => row.item), categories: []}),
    cloud: {request: async (path, options) => {calls.push({path, options}); return value; }}};
  return {value, calls, state, runtime, connector: new ConectorHomeTvSupabase({runtime})};
}
const input = {hidden: [], hiddenItems: []};

test('backend accepts ordered five-card RPC projection without creating watch history', async () => {
  const f = fixture();
  assert.equal(await f.connector.read(f.state, input), f.value);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].path, '/rest/v1/rpc/arkhen_home_tv_catalog');
  assert.equal('p_channel_ids' in f.calls[0].options.body,false);
  assert.equal('live' in f.calls[0].options.body,false);
});

test('a default cannot bypass hidden channels or malformed history semantics', async () => {
  const f = fixture();
  await assert.rejects(() => f.connector.read(f.state, {...input, hiddenItems: ['1']}), {code: 'TV_HOME_UNAVAILABLE'});
  f.value.items[0].lastWatchedAt = '2026-10-17T00:00:00Z';
  await assert.rejects(() => f.connector.read(f.state, input), {code: 'TV_HOME_UNAVAILABLE'});
});

test('an old account response is discarded before it can publish default or recent cards', async () => {
  const f = fixture();
  f.runtime.cloud.request = async () => { f.state.cloud = {...f.state.cloud}; return f.value; };
  await assert.rejects(() => f.connector.read(f.state, input), {code: 'TV_WATCH_INACTIVE'});
});
