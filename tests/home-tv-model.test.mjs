import test from 'node:test';
import assert from 'node:assert/strict';
import {QueryClient} from '@tanstack/query-core';
import {HomeTVModel} from '../web/inicio/lista-canais/tanstack-query.js';
import {homeChannelFeedback} from '../web/inicio/lista-canais/estado.js';

const response = () => ({schemaVersion: 1, source: 'rpc', revision: 7,
  generatedAt: '2026-10-16T20:00:00Z', snapshotVersion: '11111111-1111-4111-8111-111111111111',
  mostWatchedId: '91', items: ['91', '81', '1', '22'].map((id, index) => ({
    item: {id, kind: 'live', name: `Canal ${id}`, isAdult: false},
    reason: index ? 'recent' : 'most-watched', watchedSeconds: index ? 10 : 100,
    lastWatchedAt: '2026-10-16T19:00:00Z',
  }))});

function fixture(t, {available: initialAvailable = true} = {}) {
  let available = initialAvailable, scope = {account: 'account-A', epoch: 1}, calls = 0, changes = 0;
  let handler = async () => response();
  const model = new HomeTVModel({getScope: () => scope, isAvailable: () => available,
    loadQueryCore: async () => ({QueryClient}), onChange: () => changes++,
    request: async () => { calls++; return handler(); }});
  t.after(() => model.dispose());
  return {model, setAvailable: value => { available = value; }, setScope: value => { scope = value; },
    setHandler: value => { handler = value; }, get calls() { return calls; }, get changes() { return changes; }};
}

test('unavailable bootstrap exposes a waiting shelf without issuing or retrying RPCs', t => {
  const f = fixture(t, {available: false});
  for (let index = 0; index < 20; index++) f.model.ensure({force: true});
  assert.equal(f.calls, 0);
  assert.equal(f.changes, 1);
  assert.equal(f.model.state.waiting, true);
  assert.equal(f.model.timer, null);
  assert.equal(homeChannelFeedback(f.model.state).phase, 'waiting');
  assert.equal(homeChannelFeedback(f.model.state).retry, true);
});

test('a recovered bootstrap requests the server selection once and retains its exact four-card order', async t => {
  const f = fixture(t, {available: false});
  f.model.ensure();
  f.setAvailable(true);
  await f.model.ensure();
  for (let index = 0; index < 20; index++) f.model.ensure();
  assert.equal(f.calls, 1);
  assert.deepEqual(f.model.state.data.items.map(entry => entry.item.id), ['91', '81', '1', '22']);
  assert.equal(f.model.state.waiting, false);
  assert.equal(homeChannelFeedback(f.model.state, true).phase, 'ready');
});

test('a temporary cloud outage keeps the last RPC projection for the same account', async t => {
  const f = fixture(t);
  await f.model.ensure();
  const previous = f.model.state.data;
  f.setAvailable(false);
  f.model.ensure();
  assert.equal(f.model.state.data, previous);
  assert.equal(f.calls, 1);
  assert.match(homeChannelFeedback(f.model.state, true).message, /última seleção/);
  f.setAvailable(true);
  await f.model.ensure();
  assert.equal(f.model.state.data, previous);
  assert.equal(f.model.state.waiting, false);
  assert.equal(f.calls, 1);
});

test('an account change clears the previous private cards even while cloud is unavailable', async t => {
  const f = fixture(t);
  await f.model.ensure();
  f.setAvailable(false);
  f.setScope({account: 'account-B', epoch: 2});
  f.model.ensure();
  assert.equal(f.model.state.data, null);
  assert.equal(f.model.state.waiting, true);
  assert.equal(f.calls, 1);
});

test('a failed RPC retains cards and ordinary renders do not repeat the failure', async t => {
  const f = fixture(t);
  await f.model.ensure();
  const previous = f.model.state.data;
  f.setHandler(async () => { throw new Error('synthetic unavailable'); });
  await f.model.ensure({force: true});
  for (let index = 0; index < 20; index++) f.model.ensure();
  assert.equal(f.calls, 2);
  assert.equal(f.model.state.data, previous);
  assert.equal(homeChannelFeedback(f.model.state, true).phase, 'error');
  assert.equal(f.model.timer, null);
});

test('initial and valid empty selections remain visible without filling slots locally', () => {
  assert.equal(homeChannelFeedback().phase, 'initial');
  assert.equal(homeChannelFeedback({data: {items: []}}).phase, 'empty');
  assert.equal(homeChannelFeedback({data: {items: []}}).retry, false);
});
