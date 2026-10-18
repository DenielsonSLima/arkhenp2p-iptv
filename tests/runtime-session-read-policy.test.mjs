import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeSessionReadPolicy} from '../lib/runtime-session-read-policy.mjs';

const hash='a'.repeat(64);
function policy(method,path){return runtimeSessionReadPolicy({method},new URL(path,'https://fixture.invalid'));}
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

test('selected shared metadata, artwork and Home reads require an attached cloud',()=>{
  const paths=[`/api/shared-image/${hash}`,`/api/sports-image/${hash}`,
    '/api/catalog/read-model?type=movies','/api/catalog/revision?type=series',
    '/api/tv/guide?ids=42','/api/catalog?type=live','/api/catalog?type=movies&refresh=0'];
  for(const method of ['GET','HEAD'])for(const path of paths){
    assert.equal(permits(method,path,{cloud:{}}),true,`${method} ${path}`);
    assert.equal(permits(method,path,{}),false,`${method} ${path} without cloud`);
    assert.equal(permits(method,path,{cloud:null}),false,`${method} ${path} detached cloud`);
  }
  for(const path of ['/api/home/library','/api/tv/home']){
    assert.equal(permits('POST',path,{cloud:{}}),true);
    assert.equal(permits('POST',path,{}),false);
    assert.equal(permits('POST',path,{cloud:null}),false);
  }
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
