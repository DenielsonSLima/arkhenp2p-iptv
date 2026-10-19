import test from 'node:test';
import assert from 'node:assert/strict';
import {CloudRuntime} from '../lib/cloud-runtime.mjs';
import {runtimeSessionContext,withRuntimeSession} from '../lib/runtime-session-context.mjs';
import {runtimeSessionReadPolicy} from '../lib/runtime-session-read-policy.mjs';

const hash='a'.repeat(64);
const now=1700000000000;
const freshCloud=()=>({cloud:{session:{access_token:'synthetic-fresh'}},cloudExpiresAt:now+3600000});
function policy(method,path){return runtimeSessionReadPolicy({method},new URL(path,'https://fixture.invalid'),{now:()=>now});}
function permits(method,path,state={}){
  const selected=policy(method,path);
  return typeof selected==='function'?selected(state):selected;
}
function assetState(asset,options={}){
  const playback=Object.hasOwn(options,'playback')?options.playback:{key:'live:42'};
  return {client:{assets:new Map(asset?[['segment',asset]]:[]),playback}};
}

test('only a registered positive-duration segment owned by the active playback is a reader',()=>{
  for(const method of ['GET','HEAD']){
    assert.equal(permits(method,'/api/asset/segment',assetState({key:'live:42',mediaDurationSeconds:6})),true);
    for(const duration of [undefined,null,0,-1,NaN,Infinity,-Infinity,'6'])
      assert.equal(permits(method,'/api/asset/segment',assetState({key:'live:42',mediaDurationSeconds:duration})),false,`${method} duration ${String(duration)}`);
    assert.equal(permits(method,'/api/asset/segment',assetState({key:'live:43',mediaDurationSeconds:6})),false);
    assert.equal(permits(method,'/api/asset/unknown',assetState({key:'live:42',mediaDurationSeconds:6})),false);
    assert.equal(permits(method,'/api/asset/segment',assetState(null)),false);
    assert.equal(permits(method,'/api/asset/segment',{}),false);
    for(const playback of [null,undefined,{},{key:''}])
      assert.equal(permits(method,'/api/asset/segment',assetState({key:playback?.key,mediaDurationSeconds:6},{playback})),false,`${method} requires active playback key`);
  }
});

test('manifest and encryption-key assets require a writer even when registered for current playback',()=>{
  const client={playback:{key:'live:42'},assets:new Map([
    ['manifest',{key:'live:42',contentType:'application/vnd.apple.mpegurl',mediaDurationSeconds:null}],
    ['key',{key:'live:42',contentType:'application/octet-stream'}]
  ])};
  for(const method of ['GET','HEAD'])for(const id of ['manifest','key'])
    assert.equal(permits(method,'/api/asset/'+id,{client}),false);
});

test('selected shared metadata, artwork and Home reads require a fresh attached cloud',()=>{
  const paths=[`/api/shared-image/${hash}`,`/api/sports-image/${hash}`,
    '/api/catalog/read-model?type=movies','/api/catalog/revision?type=series',
    '/api/tv/guide?ids=42','/api/catalog?type=live','/api/catalog?type=movies&refresh=0'];
  for(const method of ['GET','HEAD'])for(const path of paths){
    assert.equal(permits(method,path,freshCloud()),true,`${method} ${path}`);
    assert.equal(permits(method,path,{}),false,`${method} ${path} without cloud`);
    assert.equal(permits(method,path,{cloud:null}),false,`${method} ${path} detached cloud`);
  }
  for(const path of ['/api/home/library','/api/tv/home']){
    assert.equal(permits('POST',path,freshCloud()),true);
    assert.equal(permits('POST',path,{}),false);
    assert.equal(permits('POST',path,{cloud:null}),false);
  }
});

test('expired, nearly expired, legacy and malformed cloud attachments require a writer',()=>{
  const requests=[['GET','/api/tv/guide'],['HEAD',`/api/shared-image/${hash}`],['GET',`/api/sports-image/${hash}`],
    ['GET','/api/catalog'],['GET','/api/catalog/read-model'],['GET','/api/catalog/revision'],
    ['POST','/api/home/library'],['POST','/api/tv/home']];
  for(const [method,path]of requests){
    for(const expiry of [undefined,null,0,now-1,now,now+59999,now+60000,NaN,Infinity,String(now+3600000)])
      assert.equal(permits(method,path,{...freshCloud(),cloudExpiresAt:expiry}),false,`${path}: ${String(expiry)}`);
    for(const cloud of [{},{session:{}},{session:{access_token:''}},{session:{access_token:42}}])
      assert.equal(permits(method,path,{cloud,cloudExpiresAt:now+3600000}),false,path);
    assert.equal(permits(method,path,{...freshCloud(),cloudExpiresAt:now+60001}),true,path);
  }
});

test('cloud expiry cannot send authorized media segments or local artwork through cloud refresh',()=>{
  const state={...freshCloud(),cloudExpiresAt:now-1,...assetState({key:'live:42',mediaDurationSeconds:6})};
  for(const method of ['GET','HEAD'])for(const path of ['/api/asset/segment','/api/image?ref=local','/api/playback/status'])
    assert.equal(permits(method,path,state),true,`${method} ${path}`);
  state.client.playback.controller=new AbortController();state.client.playback.controller.abort();
  assert.equal(permits('GET','/api/asset/segment',state),false,'cloud freshness never bypasses cancellation');
});

test('an expired cloud JWT selects a writer, refreshes via attachment and becomes eligible for readonly metadata',async()=>{
  const client={libraryProvider:'wplay',authenticatedAt:now,session:{connected:true,account:{status:'Active',libraryId:hash}}};
  const state={...freshCloud(),cloudExpiresAt:now-1,client,cloudClient:client,authGeneration:1};
  state.cloud.libraryId=hash;
  let bootstraps=0;
  const cloud={ready:Promise.resolve(true),enabled:true,bootstrap:async()=>{
    assert.equal(runtimeSessionContext().readOnly,false,'JWT renewal must own the writer context');
    bootstraps++;return {providerKey:'b'.repeat(64),scopeHash:'c'.repeat(64),session:{access_token:'synthetic-renewed',expires_in:3600}};
  }};
  const runtime=new CloudRuntime({cloud,workerEnabled:false,now:()=>now});
  try{
    for(const [method,path]of [['GET','/api/tv/guide'],['GET',`/api/shared-image/${hash}`],
      ['GET','/api/catalog'],['GET','/api/catalog/revision'],['POST','/api/home/library'],['POST','/api/tv/home']]){
      state.cloudExpiresAt=now-1;
      assert.equal(permits(method,path,state),false,path);
      await withRuntimeSession({readOnly:permits(method,path,state)},()=>runtime.attach(state,client.session,client));
      assert.equal(state.cloud.session.access_token,'synthetic-renewed');
      assert.equal(state.cloudExpiresAt,now+3600000);
      assert.equal(permits(method,path,state),true,path);
      const previous=bootstraps;
      await withRuntimeSession({readOnly:permits(method,path,state)},async()=>{
        if(!runtimeSessionContext().readOnly)await runtime.attach(state,client.session,client);
      });
      assert.equal(bootstraps,previous,'fresh metadata must continue on the readonly path');
    }
  }finally{runtime.close();}
});

test('local artwork and playback status can read the committed state without cloud',()=>{
  for(const method of ['GET','HEAD'])for(const path of ['/api/image?ref=local','/api/playback/status'])
    assert.equal(permits(method,path,{}),true);
});

test('authentication, PIN, playback control, source selection, details and forced catalog refresh remain writers',()=>{
  const state={cloud:{},client:{assets:new Map(),playback:{key:'live:42'}}};
  const requests=[
    ['POST','/api/login'],['POST','/api/logout'],['GET','/api/session'],
    ['GET','/api/parental'],['POST','/api/parental/unlock'],['POST','/api/parental/lock'],
    ['POST','/api/stop'],['GET','/api/play/live/42.m3u8'],
    ['GET','/api/play/movie/42.mp4'],['GET','/api/play/series/42.mp4'],
    ['GET','/api/details?kind=movie&id=42'],['GET','/api/details?kind=series&id=42'],
    ['GET','/api/live/sources?id=42'],['GET','/api/catalog?type=movies&refresh=1'],
    ['HEAD','/api/catalog?type=live&refresh=1'],['POST','/api/recommendations/movie'],
    ['POST','/api/search'],['GET','/api/epg?id=42']
  ];
  for(const [method,path]of requests)assert.equal(permits(method,path,state),false,`${method} ${path}`);
});

test('unlisted methods, malformed artwork references and nearby paths cannot become readers',()=>{
  const state={cloud:{},client:{assets:new Map([['segment',{key:'live:42',mediaDurationSeconds:6}]]),playback:{key:'live:42'}}};
  for(const method of ['POST','PUT','PATCH','DELETE','OPTIONS','get'])
    for(const path of ['/api/asset/segment','/api/image','/api/playback/status',`/api/shared-image/${hash}`,'/api/catalog','/api/tv/guide'])
      assert.equal(permits(method,path,state),false,`${method} ${path}`);
  for(const method of ['GET','HEAD','PUT','DELETE','OPTIONS'])
    for(const path of ['/api/home/library','/api/tv/home'])assert.equal(permits(method,path,state),false,`${method} ${path}`);
  for(const path of ['/api/shared-image/short',`/api/shared-image/${'A'.repeat(64)}`,`/api/shared-image/${hash}/extra`,
    `/api/sports-image/${hash.slice(1)}`,'/api/catalog/','/api/catalog/revision/extra','/api/tv/guide/extra','/api/unknown'])
    assert.equal(permits('GET',path,state),false,path);
});
