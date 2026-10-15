import test from 'node:test';
import assert from 'node:assert/strict';
import {EpisodeMarkerCatalog,markerEpisodeNumbers,resolveMarkerSeries} from '../web/series-markers/index.js';

const series={id:'provider-123',kind:'series',name:'Game Of Thrones - 2011'};
const episode={id:'provider-456',season:6,number:4};
const fingerprint='a'.repeat(16);
const reference=()=>({season:6,episode:4,edition:{id:'community-got-s06e04',durationSeconds:3521.7,toleranceSeconds:3},
  verification:{status:'community-reference'},markers:{openingStart:6,openingEnd:113.458,creditsStart:3442.6},
  sources:[{url:'https://api.introdb.app/segments?imdb_id=tt0944947&season=6&episode=4',title:'IntroDB.app'}]});
const manifest=(records=[reference()])=>({schemaVersion:1,dataVersion:'test.1',series:{slug:'game-of-thrones',tmdbId:1399,imdbId:'tt0944947'},records});
const context=(extra={})=>({item:series,episode,duration:3520,...extra});
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};

test('series identity uses exact aliases or explicit external IDs, never provider IDs or title fragments',()=>{
  for(const name of ['Game of Thrones','Game Of Thrones - 2011','Guerra dos Tronos (2011)','Game of Thrones - 2011 4K'])assert.equal(resolveMarkerSeries({...series,name}).slug,'game-of-thrones');
  assert.equal(resolveMarkerSeries({...series,name:'Outro nome',tmdbId:1399}).slug,'game-of-thrones');
  assert.equal(resolveMarkerSeries({...series,name:'Outro nome',imdb_id:'tt0944947'}).slug,'game-of-thrones');
  assert.equal(resolveMarkerSeries({...series,name:'Outro nome',tmdb_id:84773}).slug,'the-rings-of-power');
  assert.equal(resolveMarkerSeries({...series,name:'O Senhor dos Anéis - Os Anéis de Poder - 2022'}).slug,'the-rings-of-power');
  assert.equal(resolveMarkerSeries({...series,name:'Breaking Bad: A Química do Mal - 2008'}).slug,'breaking-bad');
  assert.equal(resolveMarkerSeries({...series,name:'Breaking Bad: A Química do Mal L - 2008'}).slug,'breaking-bad');
  assert.equal(resolveMarkerSeries({...series,name:'Homens de Terno - Suits - 2011'}).slug,'suits');
  assert.equal(resolveMarkerSeries({...series,name:'Wandinha - 2022'}).slug,'wednesday');
  assert.equal(resolveMarkerSeries({...series,name:'A Casa do Dragão - 2022'}).slug,'house-of-the-dragon');
  for(const value of [{...series,id:'1399',name:'Outra série'},{...series,name:'Game of Thrones House of the Dragon'},{...series,name:'Making of Game of Thrones'},
    {...series,tmdbId:9999},{...series,imdb_id:'tt99999'},{...series,kind:'movie'},{...series,name:'Os Anéis de Poder',tmdb_id:1399}])assert.equal(resolveMarkerSeries(value),null);
});

test('episode matching accepts actual season and episode numbers without guessing from a title or provider ID',()=>{
  assert.deepEqual(markerEpisodeNumbers({season:'6',number:'4'}),{season:6,episode:4});
  assert.deepEqual(markerEpisodeNumbers({season_number:0,episode_number:1}),{season:0,episode:1});
  for(const value of [{id:'604',title:'S06E004'},{season:6,number:0},{season:6,number:4.5},{season:'6abc',number:4},null])assert.equal(markerEpisodeNumbers(value),null);
});

test('community references are opt-in, runtime bounded and honestly identified',async()=>{
  let requests=0;const catalog=new EpisodeMarkerCatalog({request:async url=>{requests++;assert.equal(url,'/series-markers/game-of-thrones/manifest.json');return manifest();}});
  assert.equal((await catalog.lookup(context())).status,'unverified');
  const accepted=await catalog.lookup(context({allowReferenceMarkers:true}));assert.equal(accepted.status,'matched');assert.equal(accepted.confidence,'community-reference');assert.equal(accepted.markers.openingEnd,113.458);
  assert.equal((await catalog.lookup(context({duration:3518.6,allowReferenceMarkers:true}))).status,'edition-mismatch');
  assert.equal((await catalog.lookup(context({editionId:'known-other-cut',allowReferenceMarkers:true}))).status,'edition-mismatch');assert.equal(requests,1);
});

test('verified data requires edition or source proof in addition to duration',async()=>{
  const record=reference();record.verification.status='verified';record.edition.toleranceSeconds=.5;record.edition.sourceFingerprint=fingerprint;
  const catalog=new EpisodeMarkerCatalog({request:async()=>manifest([record])});
  assert.equal((await catalog.lookup(context({duration:3521.7}))).status,'edition-unverified');
  assert.equal((await catalog.lookup(context({duration:3521.7,sourceFingerprint:fingerprint}))).status,'matched');
  assert.equal((await catalog.lookup(context({duration:3521.7,editionId:record.edition.id}))).status,'matched');
  assert.equal((await catalog.lookup(context({duration:3521.7,sourceFingerprint:'b'.repeat(16),editionId:record.edition.id}))).status,'edition-mismatch');
});

test('a source-proven edition takes priority over an earlier matching community reference',async()=>{
  const community=reference(),verified=reference();verified.edition={...verified.edition,id:'actual-edition',toleranceSeconds:.5,sourceFingerprint:fingerprint};verified.verification.status='verified';verified.markers.openingEnd=114;
  const catalog=new EpisodeMarkerCatalog({request:async()=>manifest([community,verified])});
  const value=await catalog.lookup(context({duration:3521.7,sourceFingerprint:fingerprint,allowReferenceMarkers:true}));
  assert.equal(value.status,'matched');assert.equal(value.confidence,'edition-verified');assert.equal(value.markers.openingEnd,114);
});

test('a compatible sourced final-content policy remains active without inventing a skip window',async()=>{
  const record=reference();record.markers={};record.verification.blockEarlyNext=true;
  const catalog=new EpisodeMarkerCatalog({request:async()=>manifest([record])});
  const matched=await catalog.lookup(context({allowReferenceMarkers:true}));assert.equal(matched.status,'matched');assert.deepEqual(matched.markers,{});assert.equal(matched.blockEarlyNext,true);
  assert.equal((await catalog.lookup(context())).markers,null,'Community policy still requires the explicit test opt-in.');
  assert.equal((await catalog.lookup(context({duration:3500,allowReferenceMarkers:true}))).status,'edition-mismatch');
  const unsourced=structuredClone(record);unsourced.sources=[];const other=new EpisodeMarkerCatalog({request:async()=>manifest([unsourced])});assert.equal((await other.lookup(context({allowReferenceMarkers:true}))).status,'unverified');
});

test('a matching preserve-final-content reference wins over ambiguous community credits of the same runtime',async()=>{
  const credits=reference(),preserve=reference();preserve.edition.id='post-credits-reference';preserve.markers={};preserve.verification.blockEarlyNext=true;
  const catalog=new EpisodeMarkerCatalog({request:async()=>manifest([credits,preserve])});
  const value=await catalog.lookup(context({allowReferenceMarkers:true}));assert.equal(value.blockEarlyNext,true);assert.deepEqual(value.markers,{});
});

test('invalid schema, conflicting series identities and missing episode coverage cannot activate marks',async()=>{
  const values=[{...manifest(),schemaVersion:2},{...manifest(),series:{slug:'the-rings-of-power'}},{...manifest(),series:{slug:'game-of-thrones',imdbId:'tt9999999'}},
    {...manifest(),dataVersion:''},{...manifest(),records:'invalid'}];
  for(const value of values){const catalog=new EpisodeMarkerCatalog({request:async()=>value});const lookup=await catalog.lookup(context({allowReferenceMarkers:true}));assert.equal(lookup.markers,null);assert.equal(lookup.reason,'invalid-manifest');}
  const catalog=new EpisodeMarkerCatalog({request:async()=>manifest()});assert.equal((await catalog.lookup(context({episode:{season:6,number:5},allowReferenceMarkers:true}))).reason,'episode-not-indexed');
});

test('missing provenance, nonnumeric marks, contradictory intervals and oversized tolerance stay inactive',async()=>{
  for(const modify of [record=>record.sources=[],record=>record.markers.openingEnd='113',record=>record.markers.openingEnd=5,
    record=>record.markers.creditsStart=100,record=>record.edition.toleranceSeconds=4,record=>record.sources=[{url:'javascript:alert(1)',title:'Invalid'}]]){
    const record=reference();modify(record);const catalog=new EpisodeMarkerCatalog({request:async()=>manifest([record])});assert.equal((await catalog.lookup(context({allowReferenceMarkers:true}))).markers,null);
  }
});

test('unknown identities and absent decoded runtime do not make network requests',async()=>{
  let requests=0;const catalog=new EpisodeMarkerCatalog({request:async()=>{requests++;return manifest();}});
  for(const value of [context({item:{...series,name:'Other'}}),context({episode:{id:'604'}}),context({duration:Infinity}),context({duration:0})])assert.equal((await catalog.lookup(value)).markers,null);
  assert.equal(requests,0);
});

test('shared requests support independent cancellation, cache and reset invalidates old responses',async()=>{
  const delayed=deferred();let requests=0,requestSignal;
  const catalog=new EpisodeMarkerCatalog({request:async(_url,{signal})=>{requests++;requestSignal=signal;return delayed.promise;}});
  const controller=new AbortController(),first=catalog.lookup(context({signal:controller.signal})),second=catalog.lookup(context({allowReferenceMarkers:true}));
  await Promise.resolve();controller.abort();assert.equal((await first).status,'cancelled');assert.equal(requestSignal.aborted,false);
  delayed.resolve(manifest());assert.equal((await second).status,'matched');assert.equal((await catalog.lookup(context())).status,'unverified');assert.equal(requests,1);
  catalog.reset();await catalog.lookup(context());assert.equal(requests,2);
  const stale=deferred(),other=new EpisodeMarkerCatalog({request:()=>stale.promise});const pending=other.lookup(context());await Promise.resolve();other.reset();
  assert.equal((await pending).status,'cancelled');stale.resolve(manifest());await Promise.resolve();assert.equal(other.cache.size,0);
});

test('deadline releases lookup even if the transport ignores abort, and later results are discarded',async()=>{
  let deadline;const delayed=deferred(),catalog=new EpisodeMarkerCatalog({request:()=>delayed.promise,schedule:callback=>{deadline=callback;return 1;},cancel:()=>{}});
  const pending=catalog.lookup(context());await Promise.resolve();deadline();assert.equal((await pending).reason,'timeout');
  delayed.resolve(manifest());await Promise.resolve();await Promise.resolve();assert.equal(catalog.cache.size,0);
});

test('failed requests are not cached and an already cancelled caller cannot start a request',async()=>{
  let requests=0;const catalog=new EpisodeMarkerCatalog({request:async()=>{requests++;if(requests===1)throw new Error('offline');return {ok:true,json:async()=>manifest()};}});
  const controller=new AbortController();controller.abort();assert.equal((await catalog.lookup(context({signal:controller.signal}))).status,'cancelled');assert.equal(requests,0);
  assert.equal((await catalog.lookup(context())).reason,'load-failed');assert.equal((await catalog.lookup(context())).status,'unverified');assert.equal(requests,2);
});
