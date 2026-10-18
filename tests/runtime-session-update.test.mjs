import test from 'node:test';
import assert from 'node:assert/strict';
import {RuntimeSessionStore} from '../lib/runtime-session-store.mjs';
import {updateRuntimeSession} from '../lib/runtime-session-update.mjs';

const sessionHash='synthetic-runtime-session',epoch='synthetic-account-pin-playback';
class FakeCloud{
  constructor(){this.row={cipher:null,mediaEpoch:epoch,revision:4,fence:0,owner:null,leaseUntil:0};this.calls=[];}
  runtimeSessionKey(){return Buffer.alloc(32,41);}
  async runtimeSessionRPC(operation,args){
    this.calls.push({operation,...args});
    const row=this.row;
    if(operation==='acquire'){
      if(row.owner&&row.leaseUntil>Date.now())return {busy:true,retryAfterMs:25};
      row.owner=args.p_owner;row.fence++;row.leaseUntil=Date.now()+90000;
      return {cipher:row.cipher,revision:row.revision,fence:row.fence,leaseUntil:new Date(row.leaseUntil).toISOString()};
    }
    if(operation==='read')return {cipher:row.cipher,mediaEpoch:row.mediaEpoch};
    assert.equal(operation,'commit');
    if(row.owner!==args.p_owner||row.fence!==args.p_fence||row.revision!==args.p_revision||row.leaseUntil<=Date.now())return {ok:false,conflict:true};
    if(args.p_cipher!==null){row.cipher=args.p_cipher;row.revision++;}
    row.mediaEpoch=args.p_media_epoch;
    if(args.p_release){row.owner=null;row.leaseUntil=0;}
    return {ok:true,revision:row.revision,fence:row.fence};
  }
}
async function fixture(){
  const cloud=new FakeCloud(),store=new RuntimeSessionStore({cloud});
  const initial={epoch,backoff:null,concurrentValue:'latest writer',proofs:new Map([['private','preserved']])};
  cloud.row.cipher=await store.seal(initial,sessionHash);
  return {cloud,store,initial,options:{cloud,store,sessionHash,expectedEpoch:epoch,capture:state=>state,restore:state=>state,validate:state=>state.epoch}};
}
const decoded=async fixture=>fixture.store.openCipher(fixture.cloud.row.cipher,sessionHash);

test('failure update restores the latest snapshot and releases a new fenced owner after commit',async()=>{
  const f=await fixture(),staleReader={epoch,concurrentValue:'older reader',proofs:new Map()};
  const result=await updateRuntimeSession({...f.options,update:async state=>{
    assert.notEqual(state,staleReader);assert.equal(state.concurrentValue,'latest writer');
    state.backoff={attempts:1,retryAt:Date.now()+1000};return 'persisted';
  }});
  assert.equal(result,'persisted');
  const state=await decoded(f);
  assert.equal(state.concurrentValue,'latest writer');assert.equal(state.proofs.get('private'),'preserved');assert.equal(state.backoff.attempts,1);
  assert.equal(f.cloud.row.owner,null);assert.equal(f.cloud.row.mediaEpoch,epoch);assert.equal(f.cloud.row.revision,5);
  assert.deepEqual(f.cloud.calls.map(call=>call.operation),['acquire','read','commit']);
  assert.equal(f.cloud.calls[0].p_create,false);assert.equal(f.cloud.calls.at(-1).p_release,true);
});

test('a newer account/PIN/playback epoch rejects the callback and releases without changing its epoch',async()=>{
  const f=await fixture();f.cloud.row.mediaEpoch='newer-epoch';const original=f.cloud.row.cipher;
  await assert.rejects(updateRuntimeSession({...f.options,update:()=>assert.fail('stale callback ran')}),{code:'RUNTIME_SESSION_SCOPE_CHANGED'});
  assert.equal(f.cloud.row.cipher,original);assert.equal(f.cloud.row.mediaEpoch,'newer-epoch');assert.equal(f.cloud.row.owner,null);
  assert.equal(f.cloud.calls.at(-1).p_cipher,null);
});

test('callbacks cannot change authorization and an async rejection never persists partial state',async()=>{
  for(const changesEpoch of [true,false]){
    const f=await fixture(),original=f.cloud.row.cipher,error=new Error('synthetic callback failed');
    const task=updateRuntimeSession({...f.options,update:async state=>{
      state.backoff={attempts:77};await Promise.resolve();
      if(changesEpoch)state.epoch='unauthorized';else throw error;
    }});
    await assert.rejects(task,changesEpoch?{code:'RUNTIME_SESSION_SCOPE_CHANGED'}:error);
    assert.equal(f.cloud.row.cipher,original);assert.equal(f.cloud.row.mediaEpoch,epoch);assert.equal(f.cloud.row.owner,null);
  }
});

test('decode failure releases the proven original epoch; a failed read does not guess it',async()=>{
  for(const failedRead of [false,true]){
    const f=await fixture(),original=f.cloud.row.cipher;
    if(failedRead){
      const rpc=f.cloud.runtimeSessionRPC.bind(f.cloud);
      f.cloud.runtimeSessionRPC=(operation,args)=>operation==='read'?Promise.reject(new Error('unavailable')):rpc(operation,args);
    }else f.store.openCipher=async()=>{throw Object.assign(new Error('invalid'),{code:'RUNTIME_SESSION_INVALID'});};
    await assert.rejects(updateRuntimeSession({...f.options,update:()=>assert.fail('callback ran')}),{code:failedRead?'RUNTIME_SESSION_UNAVAILABLE':'RUNTIME_SESSION_INVALID'});
    assert.equal(f.cloud.row.cipher,original);assert.equal(f.cloud.row.mediaEpoch,epoch);
    assert.equal(f.cloud.row.owner===null,!failedRead);
    assert.equal(f.cloud.calls.some(call=>call.operation==='commit'),!failedRead);
  }
});

test('ciphertext read mismatch and a lost CAS cannot overwrite a newer writer',async()=>{
  for(const readMismatch of [true,false]){
    const f=await fixture(),original=f.cloud.row.cipher,newer=await f.store.seal({...f.initial,concurrentValue:'even newer'},sessionHash);
    if(readMismatch){
      const rpc=f.cloud.runtimeSessionRPC.bind(f.cloud);
      f.cloud.runtimeSessionRPC=async(operation,args)=>operation==='read'?{cipher:newer,mediaEpoch:'newer-epoch'}:rpc(operation,args);
    }
    await assert.rejects(updateRuntimeSession({...f.options,update:state=>{
      assert.equal(readMismatch,false);state.backoff={attempts:1};f.cloud.row.cipher=newer;f.cloud.row.owner='new writer';f.cloud.row.fence++;f.cloud.row.revision++;
    }}),{code:readMismatch?'RUNTIME_SESSION_INVALID':'RUNTIME_SESSION_LEASE_LOST'});
    assert.equal(f.cloud.row.cipher,readMismatch?original:newer);
    assert.equal(f.cloud.calls.some(call=>call.operation==='commit'&&call.p_cipher===null),!readMismatch);
  }
});

test('cancellation and expired callback deadline release without committing mutated state',async()=>{
  for(const cancelled of [true,false]){
    const f=await fixture(),controller=new AbortController(),original=f.cloud.row.cipher;let clock=Date.now();
    await assert.rejects(updateRuntimeSession({...f.options,signal:controller.signal,now:()=>clock,update:async state=>{
      state.backoff={attempts:1};await Promise.resolve();if(cancelled)controller.abort();else clock+=100000;
    }}),{code:cancelled?'RUNTIME_SESSION_CANCELLED':'RUNTIME_SESSION_LEASE_LOST'});
    assert.equal(f.cloud.row.cipher,original);assert.equal(f.cloud.row.mediaEpoch,epoch);assert.equal(f.cloud.row.owner,null);
  }
});

test('busy acquisition is bounded and cancelled waiters do not acquire or invoke updates',async()=>{
  const f=await fixture();f.cloud.row.owner='another writer';f.cloud.row.leaseUntil=Date.now()+90000;
  await assert.rejects(updateRuntimeSession({...f.options,timeoutMs:0,update:()=>assert.fail('busy callback ran')}),{code:'RUNTIME_SESSION_BUSY'});
  const controller=new AbortController();controller.abort();const calls=f.cloud.calls.length;
  await assert.rejects(updateRuntimeSession({...f.options,signal:controller.signal,update:()=>assert.fail('cancelled callback ran')}),{code:'RUNTIME_SESSION_CANCELLED'});
  assert.equal(f.cloud.calls.length,calls);assert.equal(f.cloud.row.owner,'another writer');
});

test('a busy waiter retries with one owner and cancellation interrupts its wait',async()=>{
  const f=await fixture(),rpc=f.cloud.runtimeSessionRPC.bind(f.cloud),owners=[];let attempts=0;
  f.cloud.runtimeSessionRPC=async(operation,args)=>{
    if(operation==='acquire'){owners.push(args.p_owner);if(++attempts===1)return {busy:true,retryAfterMs:25};}
    return rpc(operation,args);
  };
  await updateRuntimeSession({...f.options,update:state=>{state.backoff={attempts:1};}});
  assert.equal(attempts,2);assert.equal(new Set(owners).size,1);
  f.cloud.row.owner='another writer';f.cloud.row.leaseUntil=Date.now()+90000;
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5);
  try{await assert.rejects(updateRuntimeSession({...f.options,signal:controller.signal,update:()=>assert.fail('cancelled waiter ran')}),{code:'RUNTIME_SESSION_CANCELLED'});}
  finally{clearTimeout(timer);}
  assert.equal(f.cloud.row.owner,'another writer');
});
