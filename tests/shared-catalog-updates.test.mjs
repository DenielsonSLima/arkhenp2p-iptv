import test from 'node:test';
import assert from 'node:assert/strict';
import {SharedCatalogUpdates} from '../web/sistema/catalogo/realtime.js';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};
const revision1='2026-10-17T16:00:00.000Z',revision2='2026-10-17T16:01:00.000Z';
function fixture({reload}={}){
  const timers=new Map(),calls=[];let serial=0,generation=1,connected=true,active=true;
  const updates=new SharedCatalogUpdates({reload:(type,options)=>{calls.push({type,...options});return reload?reload(type,options):true;},getGeneration:()=>generation,isConnected:()=>connected,isActive:()=>active,
    schedule:callback=>{const id=++serial;timers.set(id,callback);return id;},cancel:id=>timers.delete(id)});
  return {updates,calls,timers,setActive:value=>{active=value;},setGeneration:value=>{generation=value;},setConnected:value=>{connected=value;},async drain(){const jobs=[...timers.values()];timers.clear();for(const job of jobs)job();await tick();}};
}

test('a publication burst coalesces reads to one request per catalog type',async()=>{
  const f=fixture();
  for(let index=0;index<30;index++)for(const type of ['live','movies','series'])f.updates.notify(type);
  assert.equal(f.timers.size,1);await f.drain();
  assert.deepEqual(f.calls.map(call=>call.type),['live','movies','series']);
});

test('a publication during a read schedules one later read after the current snapshot settles',async()=>{
  const work=deferred(),f=fixture({reload:()=>work.promise});
  f.updates.notify('movies',{revision:revision1});await f.drain();
  for(let index=0;index<10;index++)f.updates.notify('movies',{revision:revision2});
  assert.equal(f.calls.length,1);assert.equal(f.timers.size,0);
  work.resolve(true);await tick();assert.equal(f.timers.size,1);await f.drain();
  assert.equal(f.calls.length,2);assert.equal(f.timers.size,0);
});

test('logout and a changed account cancel queued events and do not replay old publications',async()=>{
  const f=fixture();f.updates.notify('movies');f.updates.reset();await f.drain();assert.equal(f.calls.length,0);
  f.updates.notify('movies');f.setGeneration(2);await f.drain();assert.equal(f.calls.length,0);
  f.setConnected(false);f.updates.notify();assert.equal(f.timers.size,0);
  f.setConnected(true);f.updates.notify('series');await f.drain();assert.deepEqual(f.calls,[{type:'series',generation:2,revision:null,snapshotId:null}]);
});

test('unknown changes never fan out, and repeated typed revisions are ignored after success',async()=>{
  const f=fixture();f.updates.notify();assert.equal(f.timers.size,0);
  f.updates.notify('series',{revision:revision1});await f.drain();
  f.updates.notify('series',{revision:revision1});assert.equal(f.timers.size,0);assert.equal(f.calls.length,1);
  f.updates.notify('movies',{revision:revision1});await f.drain();assert.deepEqual(f.calls.map(call=>call.type),['series','movies']);
});

test('failed publication reads have three bounded retries and a later publication can recover',async()=>{
  let fail=true;const f=fixture({reload:async()=>{if(fail)throw new Error('offline');return true;}});
  f.updates.notify('live',{revision:revision1});await f.drain();assert.equal(f.calls.length,1);assert.equal(f.timers.size,1);
  for(let retry=0;retry<3;retry++){await f.drain();await f.drain();assert.equal(f.calls.length,retry+2);}
  assert.equal(f.timers.size,0,'Exhausted retries must not create a permanent read loop.');assert.equal(f.updates.revisions.has('live'),false);
  fail=false;f.updates.notify('live',{revision:revision1});await f.drain();assert.equal(f.calls.length,4,'Duplicate delivery cannot restart an exhausted retry loop.');
  f.updates.notify('live',{revision:revision2});await f.drain();assert.equal(f.calls.length,5);assert.equal(f.timers.size,0);
  assert.deepEqual(f.updates.revisions.get('live'),{revision:revision2,snapshotId:null});f.updates.notify('live',{revision:revision2});assert.equal(f.timers.size,0);
});

test('inactive screens defer publication reads and resume exactly one coalesced refresh',async()=>{
 const f=fixture();f.setActive(false);f.updates.notify('series',{revision:revision1});f.updates.notify('series',{revision:revision2});
 assert.equal(f.timers.size,0);assert.equal(f.calls.length,0);f.setActive(true);f.updates.resume();await f.drain();
 assert.deepEqual(f.calls,[{type:'series',generation:1,revision:revision2,snapshotId:null}]);assert.equal(f.timers.size,0);
});

test('reset cancels retry timers and a failed in-flight read cannot revive the old account',async()=>{
 const work=deferred(),f=fixture({reload:()=>work.promise});f.updates.notify('movies');await f.drain();f.updates.reset();f.setGeneration(2);work.resolve(null);await tick();
 assert.equal(f.timers.size,0);assert.equal(f.updates.pending.size,0);
});

test('duplicates during a read do not queue another read without a new publication',async()=>{
 const work=deferred(),f=fixture({reload:()=>work.promise});f.updates.notify('movies',{revision:revision1});await f.drain();
 for(let index=0;index<10;index++)f.updates.notify('movies',{revision:revision1});
 work.resolve(true);await tick();assert.equal(f.calls.length,1);assert.equal(f.timers.size,0);
});

test('an already queued old-generation callback cannot clear a new account publication',async()=>{
 const f=fixture();f.updates.notify('movies',{revision:revision1});const old=[...f.timers.values()][0];
 f.setGeneration(2);f.updates.notify('series',{revision:revision2});old();
 assert.equal(f.timers.size,1);await f.drain();assert.deepEqual(f.calls,[{type:'series',generation:2,revision:revision2,snapshotId:null}]);
});

test('failed revision reads preserve the acknowledged publication and never fan out',async()=>{
 let fail=false;const f=fixture({reload:async()=>{if(fail)throw new Error('503');return true;}});
 f.updates.notify('movies',{revision:revision1});await f.drain();const acknowledged=f.updates.revisions.get('movies');fail=true;
 f.updates.notify('movies',{revision:revision2});await f.drain();
 assert.equal(f.updates.revisions.get('movies'),acknowledged);assert.deepEqual(f.calls.map(call=>call.type),['movies','movies']);
 assert.equal(f.updates.notify('movies',{revision:'not-a-revision'}),false);assert.equal(f.updates.notify('live',{snapshotId:'invalid'}),false);
 f.updates.reset();
});
