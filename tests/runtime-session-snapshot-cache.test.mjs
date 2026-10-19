import test from 'node:test';
import assert from 'node:assert/strict';
import {RuntimeSessionSnapshotCache} from '../lib/runtime-session-snapshot-cache.mjs';

const key=index=>index.toString(16).padStart(64,'0');
const row=(cipher='synthetic-cipher')=>({cipher,mediaEpoch:'a'.repeat(64)});

test('snapshot hits and unchanged commits never renew the absolute two-second lifetime',()=>{
  let now=0;const cache=new RuntimeSessionSnapshotCache({now:()=>now,ttlMs:100000});
  assert.equal(cache.set(key(1),row()),true);const first=cache.get(key(1));
  assert.equal(Object.isFrozen(first),true);assert.equal(first.expiresAt,2000);
  now=1500;assert.equal(cache.get(key(1)),first);cache.set(key(1),row());cache.committed(key(1),row());
  assert.equal(cache.get(key(1)),first);assert.equal(first.expiresAt,2000);
  now=1999;assert.equal(cache.get(key(1)),first);
  now=2000;assert.equal(cache.get(key(1)),null);assert.equal(cache.size,0);assert.equal(cache.bytes,0);
  assert.equal(cache.set(key(1),row(),{createdAt:0}),false,'an old null-cipher commit cannot resurrect its checkpoint');
});

test('snapshot cache clamps retained entries and encrypted bytes to eight entries and eight MiB',()=>{
  const cache=new RuntimeSessionSnapshotCache({now:()=>0,maxEntries:100,maxBytes:100*1024*1024});
  for(let index=0;index<12;index++)cache.set(key(index),row());
  assert.equal(cache.size,8);assert.equal(cache.get(key(0)),null);assert.ok(cache.get(key(11)));
  const big=new RuntimeSessionSnapshotCache({now:()=>0});
  for(let index=0;index<12;index++)big.set(key(index),row('x'.repeat(1024*1024)));
  assert.ok(big.bytes<=8*1024*1024);assert.equal(big.size,7);
  const bytes=big.bytes;assert.equal(big.set(key(30),row('x'.repeat(8*1024*1024))),false);
  assert.equal(big.bytes,bytes);
});

test('generation fences reject late reads after a commit or an explicit invalidation',()=>{
  const cache=new RuntimeSessionSnapshotCache({now:()=>0}),generation=cache.generation;
  cache.committed(key(1),row('new'));
  assert.equal(cache.set(key(1),row('old'),{generation}),false);assert.equal(cache.get(key(1)).cipher,'new');
  const before=cache.generation;cache.invalidate(key(1));
  assert.equal(cache.set(key(1),row('late'),{generation:before}),false);assert.equal(cache.get(key(1)),null);
});

test('cache stores only ciphertext, epoch and bounded bookkeeping, never caller DTO references',()=>{
  const cache=new RuntimeSessionSnapshotCache({now:()=>0}),source={...row(),client:{},url:'synthetic-private'};
  cache.set(key(1),source);source.cipher='changed';
  assert.deepEqual(Object.keys(cache.get(key(1))).sort(),['bytes','cipher','expiresAt','mediaEpoch']);
  assert.equal(cache.get(key(1)).cipher,'synthetic-cipher');
  for(const bad of [{cipher:'x',mediaEpoch:null},{cipher:'x',mediaEpoch:'bad'},{cipher:'',mediaEpoch:'a'.repeat(64)}])
    assert.equal(cache.set(key(2),bad),false);
});
