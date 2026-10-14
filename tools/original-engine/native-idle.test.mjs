import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeIdleObserver } from './native-idle.mjs';

function fixture({ build = true } = {}) {
  let hook, state = 1, pending = false, closed = false;
  const context = { isNull: () => false, equals: p => p === context,
    add(offset) {
      if (offset === 0x14c) return { readU32: () => state };
      assert.equal(offset, 0x88);
      return { readU8: () => pending ? 8 : 0 };
    } };
  const base = { add(offset) {
    const signatures = { 0x318: build ? 'a96953714ac78cb1b426b35def41b801a56884e9' : '00'.repeat(20),
      0x135738: 'ff0303d1fd7b07a9fa6708a9f85f09a9' };
    return { readByteArray: () => Uint8Array.from(Buffer.from(signatures[offset], 'hex')).buffer };
  } };
  const runtime = { Process: { arch: 'arm64', getModuleByName: () => ({ base }) },
    ptr: () => ({ readPointer: () => context }),
    Interceptor: { attach(address, callbacks) { hook = callbacks; return { detach() { closed = true; } }; } } };
  return { runtime, state(value) { state = value; }, pending(value) { pending = value; },
    enter() { const invocation = {}; hook.onEnter.call(invocation, [context]); return () => hook.onLeave.call(invocation); },
    get closed() { return closed; }, get attached() { return !!hook; } };
}

test('idle acknowledgement requires a new queue cycle after arming and no pending channel', () => {
  const f = fixture(), acknowledgements = [], errors = [];
  const observer = createNativeIdleObserver('1', value => acknowledgements.push(value), code => errors.push(code), f.runtime);
  const previous = f.enter();
  observer.arm(); previous();
  assert.equal(acknowledgements.length, 0);
  f.state(2); f.enter()();
  assert.equal(acknowledgements.length, 0);
  f.state(1); f.pending(true); f.enter()();
  assert.equal(acknowledgements.length, 0);
  f.pending(false); f.enter()();
  assert.deepEqual(acknowledgements, [{ state: 1, consumed: true }]);
  f.enter()(); assert.equal(acknowledgements.length, 1);
  assert.deepEqual(errors, []);
  observer.close(); assert.equal(f.closed, true);
});

test('unknown original build and unrecognized state fail closed', () => {
  const wrong = fixture({ build: false });
  assert.throws(() => createNativeIdleObserver('1', () => {}, () => {}, wrong.runtime), /ENGINE_STATE_BUILD_UNSUPPORTED/);
  assert.equal(wrong.attached, false);
  const f = fixture(), errors = [];
  const observer = createNativeIdleObserver('1', () => assert.fail('Must not acknowledge'), code => errors.push(code), f.runtime);
  observer.arm(); f.state(22); f.enter()();
  assert.deepEqual(errors, ['ENGINE_STATE_UNAVAILABLE']);
  assert.throws(() => observer.arm(), /ENGINE_STATE_UNAVAILABLE/);
  observer.close();
});

test('cancellation invalidates already entered queue observations', () => {
  const f = fixture(); let acknowledged = false;
  const observer = createNativeIdleObserver('1', () => { acknowledged = true; }, () => {}, f.runtime);
  observer.arm(); const leave = f.enter(); observer.cancel(); leave();
  assert.equal(acknowledged, false);
  observer.close();
});
