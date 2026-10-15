import test from 'node:test';
import assert from 'node:assert/strict';
import {EpisodeMarkerReader} from '../web/series-markers/reader.js';
const manifest=()=>({schemaVersion:1,dataVersion:'fixture',series:{slug:'game-of-thrones',tmdbId:1399,imdbId:'tt0944947'},records:[{season:1,episode:1,edition:{id:'test',durationSeconds:600,toleranceSeconds:3},verification:{status:'community-reference'},markers:{openingStart:10,openingEnd:60},sources:[{url:'https://api.introdb.app/reference',title:'Fixture'}]}]});
const context=()=>({item:{kind:'series',name:'Game of Thrones'},episode:{season:1,number:1},duration:600});
test('cloud manifest is preferred and a missing cloud manifest falls back to the local file',async()=>{
  let remote=0,local=0;const cloud={markerManifest:async slug=>{assert.equal(slug,'game-of-thrones');remote++;return manifest();}};
  const reader=new EpisodeMarkerReader({getCloud:()=>cloud,allowReferenceMarkers:true,request:async()=>{local++;return manifest();}});
  assert.equal((await reader.lookup(context())).status,'matched');assert.equal(remote,1);assert.equal(local,0);
  cloud.markerManifest=async()=>null;reader.reset();assert.equal((await reader.lookup(context())).status,'matched');assert.equal(local,1);
});
test('cloud deadline falls back locally without waiting for a stalled cloud and does not accept late account results',async()=>{
  let trigger,namespace='a',resolve;const cloudWork=new Promise(done=>resolve=done);
  const reader=new EpisodeMarkerReader({getNamespace:()=>namespace,getCloud:()=>({markerManifest:()=>cloudWork}),request:async()=>manifest(),allowReferenceMarkers:true,
    schedule:(callback,delay)=>{if(delay===1000)trigger=callback;return delay;},cancel:()=>{}});
  const pending=reader.lookup(context());await Promise.resolve();await Promise.resolve();trigger();assert.equal((await pending).status,'matched');
  reader.reset();const next=reader.lookup(context());await Promise.resolve();namespace='b';resolve(manifest());assert.equal((await next).status,'cancelled');
});
test('non-enumerable cancellation signal from the player is retained by the reader',async()=>{
  const controller=new AbortController(),input=context();Object.defineProperty(input,'signal',{value:controller.signal});
  let called=0;const reader=new EpisodeMarkerReader({request:async()=>{called++;return manifest();}});controller.abort();assert.equal((await reader.lookup(input)).status,'cancelled');assert.equal(called,0);
});

test('a partial cloud series still uses a compatible local episode without relaxing runtime or provenance guards',async()=>{
  let local=0;const partial=manifest();partial.records[0].episode=2;
  const reader=new EpisodeMarkerReader({getCloud:()=>({markerManifest:async()=>partial}),allowReferenceMarkers:true,request:async()=>{local++;return manifest();}});
  assert.equal((await reader.lookup(context())).status,'matched');assert.equal(local,1);
  assert.equal((await reader.lookup({...context(),duration:610})).markers,null,'Fallback does not make an incompatible runtime eligible.');
  assert.equal(local,2,'An incompatible imported edition also checks the original local fallback once.');
  assert.equal((await reader.lookup({...context(),duration:610})).markers,null);assert.equal(local,2,'Both local adapters reuse their cached manifest.');
});

test('an unverified cloud record cannot mask a sourced, runtime-compatible local reference',async()=>{
  const unverified=manifest();unverified.records[0].verification.status='unverified';
  const reader=new EpisodeMarkerReader({getCloud:()=>({markerManifest:async()=>unverified}),allowReferenceMarkers:true,request:async()=>manifest()});
  assert.equal((await reader.lookup(context())).confidence,'community-reference');
  assert.equal((await reader.lookup({...context(),allowReferenceMarkers:false})).markers,null,'A local fallback still requires the explicit community-data opt-in.');
});

test('open-data imports precede original files, and an incomplete imported episode can still use the original reference',async()=>{
  const calls=[],partial=manifest();partial.records[0].episode=2;
  const reader=new EpisodeMarkerReader({allowReferenceMarkers:true,request:async url=>{calls.push(url);return url.includes('/open-data/')?partial:manifest();}});
  assert.equal((await reader.lookup(context())).status,'matched');assert.deepEqual(calls,['/series-markers/open-data/game-of-thrones/manifest.json','/series-markers/game-of-thrones/manifest.json']);
});
