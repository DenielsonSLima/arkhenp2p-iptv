import test from 'node:test';
import assert from 'node:assert/strict';
import {SeriesMarkerScheduler} from '../lib/series-marker-scheduler.mjs';

function fixture(sync){
  const timers=new Map(),events=[];let id=0;
  const scheduler=new SeriesMarkerScheduler({cloud:{enabled:true,ready:Promise.resolve()},sync,intervalMs:86400000,retryMs:900000,
    schedule:(callback,delay)=>{timers.set(++id,{callback,delay});return id;},cancel:key=>timers.delete(key),onStatus:value=>events.push(value)});
  return {scheduler,timers,events};
}
test('one global synchronization publishes to Supabase and schedules a daily refresh without user requests',async()=>{
  let calls=0,release;const f=fixture(async options=>{calls++;assert.equal(options.apply,true);assert.equal(options.cloud.enabled,true);await new Promise(resolve=>{release=resolve;});return {activeEditions:73};});
  const a=f.scheduler.start(),b=f.scheduler.start();await Promise.resolve();assert.equal(calls,1);assert.equal(a,b);release();await a;
  assert.deepEqual(f.events,[{state:'ready',editions:73}]);assert.equal([...f.timers.values()][0].delay,86400000);f.scheduler.stop();assert.equal(f.timers.size,0);
});
test('temporary provider failures retain existing data, expose no raw message and retry after fifteen minutes',async()=>{
  const f=fixture(async()=>{throw Object.assign(new Error('private raw response'),{code:'unsafe secret'});});await f.scheduler.start();
  assert.deepEqual(f.events,[{state:'unavailable',code:'SKIPDB_SYNC_FAILED'}]);assert.equal([...f.timers.values()][0].delay,900000);f.scheduler.stop();
});
test('shutdown aborts a running import and suppresses its late publication status and timers',async()=>{
  let release,signal;const f=fixture(async options=>{signal=options.signal;await new Promise(resolve=>{release=resolve;});return {activeEditions:1};});
  const pending=f.scheduler.start();await Promise.resolve();f.scheduler.stop();assert.equal(signal.aborted,true);release();await pending;assert.deepEqual(f.events,[]);assert.equal(f.timers.size,0);
});
test('a restarted scheduler waits for its cancelled import before starting a fresh generation',async()=>{
  let calls=0,release;const f=fixture(async()=>{calls++;if(calls===1)await new Promise(resolve=>{release=resolve;});return {activeEditions:calls};});
  const old=f.scheduler.start();await Promise.resolve();f.scheduler.stop();const next=f.scheduler.start();release();await old;await next;
  assert.equal(calls,2);assert.deepEqual(f.events,[{state:'ready',editions:2}]);assert.equal(f.timers.size,1);f.scheduler.stop();
});
test('an unconfigured cloud never downloads data or starts a background timer',async()=>{
  const f=fixture(()=>assert.fail('No cloud configured'));f.scheduler.cloud.enabled=false;await f.scheduler.start();assert.equal(f.timers.size,0);f.scheduler.stop();
});
