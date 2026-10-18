import test from 'node:test';
import assert from 'node:assert/strict';
import {CloudRuntime} from '../lib/cloud-runtime.mjs';
import {ConectorHomeTvSupabase} from '../lib/tv/home-conector-supabase.mjs';
import {catalogReadFixture,catalogSnapshotId} from './helpers/catalog-read-fixture.mjs';

const input={hidden:[],hiddenItems:[]},item={id:'1',kind:'live',name:'TV Globo HD',isAdult:false};
const deferred=()=>{let resolve;return{promise:new Promise(done=>{resolve=done;}),resolve:()=>resolve()};};
function fixture(t){
 let now=Date.now(),rpcCalls=0,reads=0,handler=catalogReadFixture({items:[item],categories:[]});
 const cloud={enabled:true,ready:Promise.resolve(),async request(path,options){
  if(path==='/rest/v1/rpc/arkhen_home_tv_catalog'){rpcCalls++;return{schemaVersion:1,source:'rpc',revision:1,
   generatedAt:new Date(now).toISOString(),snapshotVersion:catalogSnapshotId,featuredId:'1',mostWatchedId:null,
   items:[{item,reason:'default-globo',watchedSeconds:0,lastWatchedAt:null}]};}
  reads++;return handler(path,options);
 }};
 const runtime=new CloudRuntime({cloud,now:()=>now,maxReadEntries:2,worker:{stop(){},unregisterSource(){}}});t.after(()=>runtime.close());
 const state={authGeneration:1,client:{session:{connected:true}},cloud:{providerKey:'a'.repeat(64),scopeHash:'b'.repeat(64),
  userId:'synthetic-owner',libraryId:'synthetic-library',session:{access_token:'synthetic'}}};
 return{runtime,state,connector:new ConectorHomeTvSupabase({runtime}),setHandler:value=>{handler=value;},advance:ms=>{now+=ms;},
  get rpcCalls(){return rpcCalls;},get reads(){return reads;}};
}

test('Home TV reads its five cards without loading a cold catalog or waiting for revalidation',async t=>{
 const f=fixture(t);
 f.setHandler(()=>{throw new Error('Catalog is unavailable');});
 const reply=await f.connector.read(f.state,input);
 assert.equal(reply.items[0].item.id,'1');assert.equal(f.rpcCalls,1);assert.equal(f.reads,0);
});

test('a pending full catalog read does not hold the TV Home RPC',async t=>{
 const f=fixture(t),gate=deferred(),entered=deferred();
 const read=catalogReadFixture({items:[item],categories:[]});
 f.setHandler(async path=>{entered.resolve();await gate.promise;return read(path);});
 const catalogue=f.runtime.catalog(f.state,'live');await entered.promise;
 try{assert.equal((await f.connector.read(f.state,input)).items[0].item.id,'1');assert.equal(f.rpcCalls,1);}
 finally{gate.resolve();await catalogue;}
});

test('partial or empty refresh cannot replace the complete catalogue retained for the private projection',async t=>{
 const f=fixture(t);await f.runtime.catalog(f.state,'live');
 for(const next of [catalogReadFixture({items:[item],is_complete:false}),catalogReadFixture({items:[]})]){
  f.advance(60001);f.setHandler(next);await f.runtime.catalog(f.state,'live',{fresh:true});
  assert.equal((await f.runtime.catalogForProjection(f.state,'live')).items[0].id,'1');
 }
});

test('projection catalogue cache is bounded and cannot survive expiry, scope or PIN changes',async t=>{
 const f=fixture(t);await f.runtime.catalog(f.state,'live');
 for(const hash of ['c','d']){const state={...f.state,cloud:{...f.state.cloud,providerKey:hash.repeat(64)}};await f.runtime.catalog(state,'live');}
 assert.equal(f.runtime.catalogSnapshots.size,2);
 f.advance(86400001);f.setHandler(()=>[]);
 assert.equal(await f.runtime.catalogForProjection(f.state,'live'),null);assert.equal(f.runtime.catalogSnapshots.size,0);
 const gate=deferred(),entered=deferred(),read=catalogReadFixture({items:[item]});
 f.advance(30001); // A failed full read intentionally shares a 30s cooldown.
 f.setHandler(async path=>{entered.resolve();await gate.promise;return read(path);});
 f.state.parental={unlocked:false};
 const pending=f.runtime.catalogForProjection(f.state,'live');await entered.promise;
 f.state.parental.unlocked=true;gate.resolve();assert.equal(await pending,null);
});

test('a cold projection catalogue cannot return into another account or authentication generation',async t=>{
 for(const mutate of [state=>{state.cloud={...state.cloud};},state=>{state.authGeneration++;},state=>{state.client={session:{connected:true}};}]){
  const f=fixture(t),gate=deferred(),entered=deferred(),read=catalogReadFixture({items:[item]});
  f.setHandler(async path=>{entered.resolve();await gate.promise;return read(path);});
  const pending=f.runtime.catalogForProjection(f.state,'live');await entered.promise;
  mutate(f.state);gate.resolve();assert.equal(await pending,null);
 }
});
