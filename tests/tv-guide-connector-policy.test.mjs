import test from 'node:test';
import assert from 'node:assert/strict';
import {ConectorTvSupabase} from '../lib/tv/conector-supabase.mjs';
import {cloudSourceScope} from '../lib/supabase-cloud.mjs';

const stamp=Date.parse('2026-10-16T12:30:00Z');
const iso=offset=>new Date(stamp+offset).toISOString();
const program=(title,start,end)=>({title,description:'',start:iso(start),end:iso(end)});
const current=program('Atual',-1800000,1800000),next=program('Próximo',1800000,3600000),afterNext=program('Depois',3600000,5400000);
const projection=({rich=false,...overrides}={})=>({schemaVersion:1,revision:'11111111-1111-4111-8111-111111111111',projectionVersion:'revision:1',
  asOf:iso(0),serverTime:iso(0),nextRefreshAt:iso(60000),snapshotFetchedAt:iso(-60000),snapshotExpiresAt:iso(21600000),
  legacySnapshot:false,stale:false,timeZone:'America/Maceio',channels:{'1':{list:[current,next],window:{current,next,...(rich?{afterNext}:{})},...(rich?{schedule:[current,next,afterNext]}:{})}},...overrides});
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const flush=()=>new Promise(resolve=>setImmediate(resolve));

function fixture(t,{cloudEnabled=true,shared=projection(),expanded=null,recovered=projection({rich:true})}={}){
  const scope=cloudSourceScope('wplay','https://fixture.example'),calls={rpc:0,provider:0,expansion:0},requests=[];
  const client={libraryProvider:'wplay',config:{server:'https://fixture.example'},session:{connected:true},authInfo:{service:{enabledLive:true}}};
  const state={client,authGeneration:1,parental:{unlocked:false},cloudEpoch:1,
    cloud:cloudEnabled?{...scope,session:{access_token:'synthetic-session'}}:null};
  const cloud={enabled:cloudEnabled,request:async(path,options)=>{calls.rpc++;requests.push({path,options});return await shared;}};
  const connector=new ConectorTvSupabase({cloud,now:()=>stamp});
  connector.providerGuide.get=async options=>{calls.provider++;calls.providerOptions=options;return recovered;};
  connector.publishedSchedule.enrich=async()=>{calls.expansion++;return expanded;};
  t.after(()=>connector.close());return {connector,state,client,calls,requests};
}

test('fresh shared guide supplies the same published richer schedule without any WPLAY recovery capture',async t=>{
  const rich=projection({rich:true}),f=fixture(t,{expanded:rich});
  const result=await f.connector.guide(f.state,{ids:['1']});
  assert.equal(f.calls.rpc,1);assert.equal(f.calls.provider,0);assert.equal(f.calls.expansion,1);
  assert.equal(f.requests[0].path,'/rest/v1/rpc/arkhen_tv_guide');
  assert.equal(f.requests[0].options.body.p_channel_ids,null);
  assert.deepEqual(result.channels['1'].schedule,[current,next,afterNext]);
  assert.deepEqual(result.channels['1'].window.afterNext,afterNext);
  assert.equal(result.revision,rich.revision);
});

test('simultaneous fresh readers join the global RPC cache and never start a provider download',async t=>{
  const f=fixture(t,{expanded:projection({rich:true})});
  const results=await Promise.all([f.connector.guide(f.state),f.connector.guide(f.state,{ids:['1']}),f.connector.guide(f.state,{ids:['1']})]);
  assert.equal(f.calls.rpc,1);assert.equal(f.calls.provider,0);
  assert.equal(results.length,3);assert.ok(results.every(result=>result.channels['1'].schedule.length===3));
});

for(const [name,shared] of [
  ['stale',projection({stale:true})],['partial',projection({partial:true})],['legacy',projection({legacySnapshot:true})],
  ['expired',projection({snapshotExpiresAt:iso(-1)})],['without programme data',projection({channels:{'1':{list:[],window:{}}}})],
])test(`${name} shared guide permits authorized whole-snapshot recovery`,async t=>{
  const f=fixture(t,{shared});
  // The legacy adapter has its own tested read/publication policy. This test
  // isolates selection of recovery after a degraded primary projection.
  f.connector.legacyGuide.get=async()=>null;
  const result=await f.connector.guide(f.state,{ids:['1'],includeAdult:true});
  assert.equal(f.calls.provider,1);assert.equal(f.calls.providerOptions.client,f.client);
  assert.equal(f.calls.providerOptions.includeAdult,false);
  assert.deepEqual(f.calls.providerOptions.ids,['1']);
  assert.equal(result.channels['1'].schedule.length,3);
});

test('a missing cloud bootstrap immediately permits provider recovery and no cloud request',async t=>{
  const f=fixture(t,{cloudEnabled:false});
  const result=await f.connector.guide(f.state);
  assert.equal(f.calls.rpc,0);assert.equal(f.calls.provider,1);
  assert.deepEqual(result.channels['1'].schedule,[current,next,afterNext]);
});

test('a slow shared read starts recovery after one second instead of every healthy request',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const shared=deferred(),f=fixture(t,{shared:shared.promise});
  const pending=f.connector.guide(f.state);await flush();
  assert.equal(f.calls.rpc,1);assert.equal(f.calls.provider,0);
  t.mock.timers.tick(999);await flush();assert.equal(f.calls.provider,0);
  t.mock.timers.tick(1);await flush();assert.equal(f.calls.provider,1);
  t.mock.timers.tick(120);await flush();
  const result=await pending;assert.equal(result.channels['1'].schedule.length,3);
  shared.resolve(projection());await flush();
});

for(const change of ['account','PIN'])test(`${change} change while primary is pending prevents late provider recovery`,async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const shared=deferred(),f=fixture(t,{shared:shared.promise});
  const pending=f.connector.guide(f.state);await flush();
  if(change==='account')f.state.authGeneration++;else f.state.parental.unlocked=true;
  t.mock.timers.tick(1000);await flush();
  assert.equal(await pending,null);assert.equal(f.calls.provider,0);
  shared.resolve(projection());await flush();
});
