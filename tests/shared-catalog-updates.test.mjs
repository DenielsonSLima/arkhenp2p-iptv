import test from 'node:test';
import assert from 'node:assert/strict';
import {SharedCatalogUpdates} from '../web/sistema/catalogo/realtime.js';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};
function fixture({reload}={}){
  const timers=new Map(),calls=[];let serial=0,generation=1,connected=true;
  const updates=new SharedCatalogUpdates({reload:(type,options)=>{calls.push({type,...options});return reload?.(type,options);},getGeneration:()=>generation,isConnected:()=>connected,
    schedule:callback=>{const id=++serial;timers.set(id,callback);return id;},cancel:id=>timers.delete(id)});
  return {updates,calls,timers,setGeneration:value=>{generation=value;},setConnected:value=>{connected=value;},async drain(){const jobs=[...timers.values()];timers.clear();for(const job of jobs)job();await tick();}};
}

test('a publication burst coalesces reads to one request per catalog type',async()=>{
  const f=fixture();
  for(let index=0;index<30;index++)for(const type of ['live','movies','series'])f.updates.notify(type);
  assert.equal(f.timers.size,1);await f.drain();
  assert.deepEqual(f.calls.map(call=>call.type),['live','movies','series']);
});

test('a publication during a read schedules one later read after the current snapshot settles',async()=>{
  const work=deferred(),f=fixture({reload:()=>work.promise});
  f.updates.notify('movies');await f.drain();
  for(let index=0;index<10;index++)f.updates.notify('movies');
  assert.equal(f.calls.length,1);assert.equal(f.timers.size,0);
  work.resolve();await tick();assert.equal(f.timers.size,1);await f.drain();
  assert.equal(f.calls.length,2);assert.equal(f.timers.size,0);
});

test('logout and a changed account cancel queued events and do not replay old publications',async()=>{
  const f=fixture();f.updates.notify('movies');f.updates.reset();await f.drain();assert.equal(f.calls.length,0);
  f.updates.notify('movies');f.setGeneration(2);await f.drain();assert.equal(f.calls.length,0);
  f.setConnected(false);f.updates.notify();assert.equal(f.timers.size,0);
  f.setConnected(true);f.updates.notify('series');await f.drain();assert.deepEqual(f.calls,[{type:'series',generation:2}]);
});

test('unknown changes never fan out, and repeated typed revisions are ignored after success',async()=>{
  const f=fixture();f.updates.notify();assert.equal(f.timers.size,0);
  f.updates.notify('series',{revision:'revision-1'});await f.drain();
  f.updates.notify('series',{revision:'revision-1'});assert.equal(f.timers.size,0);assert.equal(f.calls.length,1);
  f.updates.notify('movies',{revision:'revision-1'});await f.drain();assert.deepEqual(f.calls.map(call=>call.type),['series','movies']);
});

test('a failed read does not loop or prevent the next publication from revalidating',async()=>{
  let fail=true;const f=fixture({reload:async()=>{if(fail)throw new Error('offline');}});
  f.updates.notify('live');await f.drain();assert.equal(f.timers.size,0);
  fail=false;f.updates.notify('live');await f.drain();assert.equal(f.calls.length,2);
});
