import test from 'node:test';
import assert from 'node:assert/strict';
import {withRequestSignals} from '../web/request-signals.js';
function emulateTV(t){const descriptor=Object.getOwnPropertyDescriptor(AbortSignal,'any');Object.defineProperty(AbortSignal,'any',{...descriptor,value:undefined});t.after(()=>Object.defineProperty(AbortSignal,'any',descriptor));}
test('TV fallback cancels from either source and removes listeners after settling',async t=>{
  emulateTV(t);
  const first=new AbortController(),second=new AbortController(),adds=t.mock.method(first.signal,'addEventListener'),removes=t.mock.method(first.signal,'removeEventListener');
  const result=await withRequestSignals([first.signal,second.signal],async signal=>{assert.equal(signal.aborted,false);second.abort();assert.equal(signal.aborted,true);return 'done';});
  assert.equal(result,'done');assert.equal(adds.mock.calls.length,1);assert.equal(removes.mock.calls.length,1);
});
test('TV fallback detects already aborted sources and still cleans up after failures',async t=>{
  emulateTV(t);const first=new AbortController(),second=new AbortController();second.abort();
  const removes=t.mock.method(first.signal,'removeEventListener');
  await assert.rejects(withRequestSignals([first.signal,second.signal],async signal=>{assert.equal(signal.aborted,true);throw new Error('cancelled');}),/cancelled/);assert.equal(removes.mock.calls.length,1);
});
