import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {EpisodeMarkerReader} from '../web/serie/marcadores/orquestrador.js';
const manifest=()=>({schemaVersion:1,dataVersion:'fixture',series:{slug:'game-of-thrones',tmdbId:1399,imdbId:'tt0944947'},records:[{season:1,episode:1,edition:{id:'test',durationSeconds:600,toleranceSeconds:.5},verification:{status:'verified'},markers:{openingStart:10,openingEnd:60},sources:[{url:'https://api.introdb.app/reference',title:'Fixture'}]}]});
const context=()=>({item:{kind:'series',name:'Game of Thrones'},episode:{season:1,number:1},duration:600,editionId:'test'});
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

test('an unverified cloud record cannot mask a verified local edition with an exact binding',async()=>{
  const unverified=manifest();unverified.records[0].verification.status='unverified';
  const reader=new EpisodeMarkerReader({getCloud:()=>({markerManifest:async()=>unverified}),allowReferenceMarkers:true,request:async()=>manifest()});
  assert.equal((await reader.lookup(context())).confidence,'edition-verified');
  assert.equal((await reader.lookup({...context(),allowReferenceMarkers:false})).confidence,'edition-verified');
  assert.equal((await reader.lookup({...context(),editionId:undefined})).markers,null,'Duration alone cannot bind the local edition.');
});

test('open-data imports precede original files, and an incomplete imported episode can still use the original reference',async()=>{
  const calls=[],partial=manifest();partial.records[0].episode=2;
  const reader=new EpisodeMarkerReader({allowReferenceMarkers:true,request:async url=>{calls.push(url);return url.includes('/open-data/')?partial:manifest();}});
  assert.equal((await reader.lookup(context())).status,'matched');assert.deepEqual(calls,['/series-markers/open-data/game-of-thrones/manifest.json','/series-markers/game-of-thrones/manifest.json']);
});

test('local runtime diagnostics survive an unavailable cloud instead of claiming the episode has no data',async()=>{
  const reader=new EpisodeMarkerReader({allowReferenceMarkers:true,request:async()=>manifest()});
  const result=await reader.lookup({...context(),duration:610});assert.equal(result.status,'edition-mismatch');assert.equal(result.markers,null);
});

test('GoT S05E001 at 52:09 cannot execute community timestamps or their former intersection',async()=>{
  const reader=new EpisodeMarkerReader({allowReferenceMarkers:true,request:async url=>JSON.parse(await readFile(new URL('../web'+url,import.meta.url),'utf8'))});
  const input={item:{kind:'series',name:'Game Of Thrones - 2011'},episode:{id:'501',season:5,number:1,title:'S05E001'},duration:3129.9};
  const value=await reader.lookup(input);assert.notEqual(value.status,'matched');assert.equal(value.markers,null);
  assert.equal(value.openingConsensus,undefined);assert.equal(value.referenceOpening,undefined);
  assert.equal((await reader.lookup({...input,duration:3100})).markers,null);
  assert.equal((await reader.lookup({...input,editionId:'different-cut'})).markers,null);
  assert.equal((await reader.lookup({...input,allowReferenceMarkers:false})).markers,null);
});

test('community sources never fill each other even when their opening windows overlap',async()=>{
  for(const opening of [{openingStart:200,openingEnd:260},{openingStart:10,openingEnd:80}]){
    const partial=manifest(),local=manifest();partial.records[0].verification.status='community-reference';local.records[0].verification.status='community-reference';partial.records[0].markers={creditsStart:550};partial.records[0].verification.openingCandidates=[
      {openingStart:10,openingEnd:61,durationSeconds:600},{openingStart:10,openingEnd:60,durationSeconds:601}];local.records[0].markers=opening;
    const reader=new EpisodeMarkerReader({allowReferenceMarkers:true,getCloud:()=>({markerManifest:async()=>partial}),request:async url=>url.includes('/open-data/')?partial:local});
    const value=await reader.lookup(context());assert.equal(value.markers,null);assert.equal(value.openingConsensus,undefined);
  }
});

test('resolved cloud catalog identities work outside the seed registry and raw fallback evidence never becomes an automatic edition',async()=>{
  const item={kind:'series',id:'55',name:'Uma série nova - 2020'},imdbId='tt1234567',slug='imdb-'+imdbId,calls=[];
  const cloud={markerSeriesIdentity:async()=>({resolved:true,slug,imdbId,tmdbId:null,title:item.name,aliases:[item.name]}),markerManifest:async(value,episode)=>{
    calls.push({value,episode});return {schemaVersion:1,dataVersion:'cloud-reference',series:{slug,imdbId},records:[],episodeEvidence:{imdb_id:imdbId,season:1,episode:1,evidence:{introdb:{intro:{start_ms:6000,end_ms:60000}}}}};
  }};
  const reader=new EpisodeMarkerReader({getCloud:()=>cloud,allowReferenceMarkers:true,request:async()=>({ok:false})}),value=await reader.lookup({item,episode:{season:1,number:1},duration:600});
  assert.equal(value.markers,null);assert.equal(value.referenceOpening,undefined);assert.deepEqual(value.references,[{openingStart:6,openingEnd:60,source:'IntroDB',reason:'edition-verification-required'}]);assert.equal(calls[0].value,slug);assert.deepEqual(calls[0].episode,{season:1,episode:1});
  const disabled=await reader.lookup({item,episode:{season:1,number:1},duration:600,allowReferenceMarkers:false});assert.equal(disabled.references,undefined);
});

test('a verified cloud conflict cannot be masked by an older local manifest',async()=>{
  const conflicting=manifest(),second=structuredClone(conflicting.records[0]);second.markers.openingEnd=198;conflicting.records.push(second);
  let local=0;const reader=new EpisodeMarkerReader({getCloud:()=>({markerManifest:async()=>conflicting}),request:async()=>{local++;return manifest();}});
  const value=await reader.lookup(context());assert.equal(value.status,'edition-conflict');assert.equal(value.markers,null);assert.equal(local,0);
});
