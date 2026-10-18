import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareTVOpening} from '../web/tv/player/abertura.js';
import {ChannelSwitchService} from '../web/player/troca-canal/servico.js';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => {resolve=yes;reject=no;}); return {promise,resolve,reject}; };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('source metadata overlaps STOP but never releases playback before STOP confirmation', async () => {
  const stop=deferred(), metadata=deferred(); let started=false, released=false;
  const opening=prepareTVOpening({stopped:[stop.promise],prepare:()=>{started=true;return metadata.promise;}})
    .then(value=>{released=true;return value;});
  await tick();assert.equal(started,true);assert.equal(released,false);
  metadata.resolve({sources:[],sourceId:''});await tick();assert.equal(released,false);
  stop.resolve();assert.deepEqual(await opening,{sources:[],sourceId:''});
});

test('source errors are retained, without starting a second lookup after STOP', async () => {
  for(const status of [401,403,404,409,429,503]) {
    const stop=deferred(), error=Object.assign(new Error('fixture'),{status});let calls=0;
    const opening=prepareTVOpening({stopped:[stop.promise],prepare:()=>{calls++;throw error;}});
    const result=assert.rejects(opening,value=>value===error);
    await tick();stop.resolve();await result;assert.equal(calls,1);
  }
});

test('failed STOP cancels metadata and keeps its actionable error', async () => {
  const stop=deferred();let signal;
  const opening=prepareTVOpening({stopped:[stop.promise],prepare:options=>{
    signal=options.signal;return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  }});
  const result=assert.rejects(opening,{code:'LIVE_PREVIOUS_STOP_FAILED'});
  await tick();stop.reject(new Error('stop failed'));await result;assert.equal(signal.aborted,true);
});

test('superseded opening cannot release stale descriptors', async () => {
  const controller=new AbortController(), metadata=deferred();
  const opening=prepareTVOpening({signal:controller.signal,prepare:()=>metadata.promise});
  const result=assert.rejects(opening,{name:'AbortError'});
  await tick();controller.abort();metadata.resolve({sources:[]});await result;
});

test('legitimate cold discovery can finish after five seconds instead of being cancelled at four',async t=>{
  const deadlines=[];t.mock.method(AbortSignal,'timeout',delay=>{const controller=new AbortController();deadlines.push({delay,controller});return controller.signal;});
  const gate=deferred(),expected={sources:[],sourceId:''},service=new ChannelSwitchService({preparePlayback:()=>gate.promise});
  const pending=service.prepare({id:'1',kind:'live'});
  for(const deadline of deadlines)if(deadline.delay<=5000)deadline.controller.abort(new DOMException('Synthetic deadline','TimeoutError'));
  gate.resolve(expected);assert.deepEqual(await pending,expected);
});

test('cold discovery remains bounded and a newer user intent still cancels immediately',async t=>{
  const deadlines=[];t.mock.method(AbortSignal,'timeout',delay=>{const controller=new AbortController();deadlines.push({delay,controller});return controller.signal;});
  const service=new ChannelSwitchService({preparePlayback:(_item,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))});
  const slow=service.prepare({id:'1',kind:'live'}),bounded=assert.rejects(slow,{name:'TimeoutError'});
  for(const deadline of deadlines)if(deadline.delay<=41000)deadline.controller.abort(new DOMException('Synthetic deadline','TimeoutError'));
  await bounded;const controller=new AbortController(),next=service.prepare({id:'2',kind:'live'},{signal:controller.signal});
  const cancelled=assert.rejects(next,{name:'AbortError'});controller.abort();await cancelled;
});
