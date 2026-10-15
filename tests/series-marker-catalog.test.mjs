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

test('homonyms require a consistent year or explicit identity and never depend on registry order',()=>{
  const anime={slug:'one-piece-anime',title:'One Piece',year:1999,aliases:['One Piece'],tmdbId:37854,imdbId:'tt0388629'};
  const adaptation={slug:'one-piece-live',title:'One Piece',year:2023,aliases:['One Piece'],tmdbId:111110,imdbId:'tt11737520'};
  for(const registry of [[anime,adaptation],[adaptation,anime]]){
    const item={kind:'series',name:'One Piece'};
    assert.equal(resolveMarkerSeries(item,registry),null);
    assert.equal(resolveMarkerSeries({...item,name:'One Piece - 1999 HD'},registry)?.slug,anime.slug);
    assert.equal(resolveMarkerSeries({...item,name:'One Piece (2023)'},registry)?.slug,adaptation.slug);
    assert.equal(resolveMarkerSeries({...item,year:'2023'},registry)?.slug,adaptation.slug);
    assert.equal(resolveMarkerSeries({...item,imdbId:adaptation.imdbId},registry)?.slug,adaptation.slug);
    assert.equal(resolveMarkerSeries({...item,tmdbId:anime.tmdbId},registry)?.slug,anime.slug);
    for(const bad of [{year:2022},{year:2023,imdbId:anime.imdbId},{year:1999,tmdbId:adaptation.tmdbId},
      {imdbId:anime.imdbId,tmdbId:adaptation.tmdbId},{name:'One Piece - 1999',year:2023}])assert.equal(resolveMarkerSeries({...item,...bad},registry),null);
  }
});

test('Vikings and Valhalla remain separate identities and episode numbering is not converted',()=>{
  const original={slug:'vikings',title:'Vikings',year:2013,aliases:['Vikings'],tmdbId:44217,imdbId:'tt2306299'};
  const valhalla={slug:'vikings-valhalla',title:'Vikings: Valhalla',year:2022,aliases:['Vikings Valhalla','Vikings: Valhalla'],tmdbId:116135,imdbId:'tt11311302'};
  const registry=[valhalla,original],item={kind:'series',name:'Vikings - 2013'};
  assert.equal(resolveMarkerSeries(item,registry)?.slug,'vikings');
  assert.equal(resolveMarkerSeries({...item,name:'Vikings: Valhalla - 2022'},registry)?.slug,'vikings-valhalla');
  for(const bad of [{name:'Vikings - 2012'},{name:'Vikings - 2022'},{imdbId:valhalla.imdbId},{tmdbId:valhalla.tmdbId}])assert.equal(resolveMarkerSeries({...item,...bad},registry),null);
  assert.deepEqual(markerEpisodeNumbers({season:2,number:1,absoluteNumber:62}),{season:2,episode:1});
});

test('the shipped registry separates both One Piece adaptations and rejects conflicting annotated years',()=>{
  const item={kind:'series',name:'One Piece'};
  assert.equal(resolveMarkerSeries(item),null);
  for(const [name,imdb] of [['One Piece - 1999 [HD]','tt0388629'],['ONE PIECE - 2023 (LEG)','tt11737520'],['Vikings - 2013 (DUB)','tt2306299'],['Vikings: Valhalla - 2022','tt11311302']]){
    assert.equal(resolveMarkerSeries({...item,name})?.imdbId,imdb);
  }
  assert.equal(resolveMarkerSeries({...item,name:'One Piece - 1999 (LEG)',imdbId:'tt11737520'}),null);
  assert.equal(resolveMarkerSeries({...item,name:'Game of Thrones - 2022 [HD]'}),null);
});

test('community references never become executable from runtime similarity, opt-in or an edition label',async()=>{
  let requests=0;const catalog=new EpisodeMarkerCatalog({request:async url=>{requests++;assert.equal(url,'/series-markers/game-of-thrones/manifest.json');return manifest();}});
  assert.equal((await catalog.lookup(context())).status,'unverified');
  for(const extra of [{allowReferenceMarkers:true},{allowReferenceMarkers:true,editionId:reference().edition.id}]){
    const rejected=await catalog.lookup(context(extra));assert.equal(rejected.status,'unverified');assert.equal(rejected.markers,null);
  }
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

test('nearby community windows remain diagnostics and cannot create an executable intersection',async()=>{
  const record=reference();record.markers={creditsStart:3442.6};record.verification.openingCandidates=[
    {openingStart:0,openingEnd:118.7,durationSeconds:3521.7},{openingStart:0,openingEnd:115.8,durationSeconds:3522.5}];
  const catalog=new EpisodeMarkerCatalog({request:async()=>manifest([record])});
  const found=await catalog.lookup(context({allowReferenceMarkers:true}));assert.equal(found.openingConsensus,undefined);
  assert.equal(found.markers,null,'A community consensus cannot identify the actual episode edit.');
  assert.equal((await catalog.lookup(context())).openingConsensus,undefined);assert.equal((await catalog.lookup(context({duration:3500,allowReferenceMarkers:true}))).openingConsensus,undefined);
  for(const candidates of [[{openingStart:0,openingEnd:118,durationSeconds:3521.7},{openingStart:0,openingEnd:100,durationSeconds:3522}],
    [{openingStart:0,openingEnd:118,durationSeconds:3521.7},{openingStart:0,openingEnd:115,durationSeconds:3530}],
    [{openingStart:0,openingEnd:118,durationSeconds:3521.7},{openingStart:200,openingEnd:250,durationSeconds:3522}]]){
    const invalid=structuredClone(record);invalid.verification.openingCandidates=candidates;const other=new EpisodeMarkerCatalog({request:async()=>manifest([invalid])});
    assert.equal((await other.lookup(context({allowReferenceMarkers:true}))).openingConsensus,undefined);
  }
});

test('a source-proven edition takes priority over an earlier matching community reference',async()=>{
  const community=reference(),verified=reference();verified.edition={...verified.edition,id:'actual-edition',toleranceSeconds:.5,sourceFingerprint:fingerprint};verified.verification.status='verified';verified.markers.openingEnd=114;
  const catalog=new EpisodeMarkerCatalog({request:async()=>manifest([community,verified])});
  const value=await catalog.lookup(context({duration:3521.7,sourceFingerprint:fingerprint,allowReferenceMarkers:true}));
  assert.equal(value.status,'matched');assert.equal(value.confidence,'edition-verified');assert.equal(value.markers.openingEnd,114);
});

test('conflicting verified records for the same bound edition fail closed instead of selecting by array order',async()=>{
  const first=reference();first.verification.status='verified';first.edition.toleranceSeconds=.5;first.edition.sourceFingerprint=fingerprint;
  const second=structuredClone(first);second.markers.openingEnd=198;
  for(const records of [[first,second],[second,first]]){
    const catalog=new EpisodeMarkerCatalog({request:async()=>manifest(records)});
    const value=await catalog.lookup(context({duration:3521.7,sourceFingerprint:fingerprint}));
    assert.equal(value.status,'edition-conflict');assert.equal(value.reason,'conflicting-verified-markers');assert.equal(value.markers,null);
  }
  const identical=new EpisodeMarkerCatalog({request:async()=>manifest([first,structuredClone(first)])});
  assert.equal((await identical.lookup(context({duration:3521.7,sourceFingerprint:fingerprint}))).status,'matched');
});

test('verified evidence cannot match a different season, episode or runtime through an opt-in',async()=>{
  const verified=reference();verified.verification.status='verified';verified.edition.toleranceSeconds=.5;
  const catalog=new EpisodeMarkerCatalog({request:async()=>manifest([verified])});
  for(const extra of [{episode:{season:5,number:4}},{episode:{season:6,number:5}},{duration:3530},{editionId:'wrong-edition'}]){
    const value=await catalog.lookup(context({duration:3521.7,editionId:verified.edition.id,allowReferenceMarkers:true,...extra}));
    assert.equal(value.markers,null);
  }
});

test('only a verified and bound final-content policy is executable without a skip window',async()=>{
  const record=reference();record.markers={};record.verification.blockEarlyNext=true;
  const catalog=new EpisodeMarkerCatalog({request:async()=>manifest([record])});
  const matched=await catalog.lookup(context({allowReferenceMarkers:true}));assert.equal(matched.status,'unverified');assert.equal(matched.markers,null);
  assert.equal((await catalog.lookup(context())).markers,null);
  assert.equal((await catalog.lookup(context({duration:3500,allowReferenceMarkers:true}))).status,'edition-mismatch');
  const verified=structuredClone(record);verified.verification.status='verified';verified.edition.toleranceSeconds=.5;
  const bound=new EpisodeMarkerCatalog({request:async()=>manifest([verified])});
  const policy=await bound.lookup(context({duration:3521.7,editionId:verified.edition.id}));assert.equal(policy.status,'matched');assert.deepEqual(policy.markers,{});assert.equal(policy.blockEarlyNext,true);
  const unsourced=structuredClone(record);unsourced.sources=[];const other=new EpisodeMarkerCatalog({request:async()=>manifest([unsourced])});assert.equal((await other.lookup(context({allowReferenceMarkers:true}))).status,'unverified');
});

test('ambiguous community credits and final-content references remain inactive',async()=>{
  const credits=reference(),preserve=reference();preserve.edition.id='post-credits-reference';preserve.markers={};preserve.verification.blockEarlyNext=true;
  const catalog=new EpisodeMarkerCatalog({request:async()=>manifest([credits,preserve])});
  const value=await catalog.lookup(context({allowReferenceMarkers:true}));assert.equal(value.blockEarlyNext,undefined);assert.equal(value.markers,null);
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
  delayed.resolve(manifest());assert.equal((await second).status,'unverified');assert.equal((await catalog.lookup(context())).status,'unverified');assert.equal(requests,1);
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
