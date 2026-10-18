import test from 'node:test';
import assert from 'node:assert/strict';
import {HomeChannelPrograms} from '../web/inicio/lista-canais/programacao.js';

function fixture() {
  let scope = 'account-A', active = true, items = ['1', '2', '3', '4', '5'].map(id => ({id}));
  const calls = [], updates = [], callbacks = [];
  const guide = {state: {loading: false}, peek: id => ({window: {current: {title: `Program ${id}`}}}),
    subscribe(callback, {ids}) {
      calls.push(['subscribe', ids]); callbacks.push(callback); callback(this.state);
      const unsubscribe = () => calls.push(['unsubscribe']);
      unsubscribe.updateIds = ids => calls.push(['ids', ids]);
      return unsubscribe;
    }};
  const programs = new HomeChannelPrograms({guide, getItems: () => items, getScope: () => scope,
    isActive: () => active, onUpdate: (data, state) => updates.push({data, state})});
  return {programs, guide, calls, updates, callbacks, setItems: value => {items = value;},
    setScope: value => {scope = value;}, setActive: value => {active = value;}};
}

test('Home joins one shared guide selection for five cards without starting its own requests or timer', () => {
  const f = fixture();
  f.programs.sync(); f.programs.sync();
  assert.deepEqual(f.calls, [['subscribe', ['1', '2', '3', '4', '5']]]);
  assert.equal(f.updates.at(-1).data.get('1').window.current.title, 'Program 1');
  f.setItems([{id: '8'}, {id: '8'}, {id: 'invalid'}, {id: '2'}]);
  f.programs.sync();
  assert.deepEqual(f.calls.at(-1), ['ids', ['8', '2']]);
  assert.deepEqual([...f.updates.at(-1).data.keys()], ['8', '2']);
  f.programs.dispose();
});

test('leaving Home unsubscribes and ignores late guide callbacks; returning attaches only once', () => {
  const f = fixture(); f.programs.sync();
  const callback = f.callbacks[0];
  f.setActive(false); f.programs.sync();
  const count = f.updates.length;
  callback({error: 'late'});
  assert.equal(f.updates.length, count);
  assert.deepEqual(f.calls.at(-1), ['unsubscribe']);
  f.setActive(true); f.programs.sync(); f.programs.sync();
  assert.equal(f.calls.filter(([name]) => name === 'subscribe').length, 2);
  f.programs.dispose();
});

test('account changes clear programming and old callbacks cannot populate the new cards', () => {
  const f = fixture(); f.programs.sync();
  const callback = f.callbacks[0];
  f.setScope('account-B'); f.setItems([{id: '9'}]); f.programs.sync();
  assert.equal(f.updates.at(-2).data.size, 0);
  assert.deepEqual([...f.updates.at(-1).data.keys()], ['9']);
  const count = f.updates.length;
  callback({loading: false});
  assert.equal(f.updates.length, count);
  f.programs.dispose();
  f.programs.sync();
  assert.equal(f.calls.filter(([name]) => name === 'subscribe').length, 2);
});
