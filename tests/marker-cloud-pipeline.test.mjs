import test from 'node:test';
import assert from 'node:assert/strict';
import {LICENSE,normalizeGlobalDump,selectSeriesIdentity,explicitIdentity,episodeInventory,inspectSegments,catalogTitle} from '../supabase/functions/series-markers-sync/metadata.mjs';
import {MarkerProviders,readPublicDump} from '../supabase/functions/series-markers-sync/providers.mjs';
import {MarkerStore} from '../supabase/functions/series-markers-sync/store.mjs';
import {parseRawRange,advanceIncrementalSource} from '../supabase/functions/series-markers-sync/incremental.mjs';
import {runMarkerPipeline,publicArtifactStream} from '../supabase/functions/series-markers-sync/pipeline.mjs';
import {createMarkerSyncHandler} from '../supabase/functions/series-markers-sync/handler.mjs';
import {markerSeriesFromIdentity} from '../web/series-markers/registry.js';

const NOW=Date.parse('2026-10-15T12:00:00Z'),imdb='tt1234567';
const segment=(extra={})=>({id:1,status:'approved',media_type:'series',imdb_id:imdb,season:1,episode:1,segment_type:'intro',start_ms:10000,end_ms:60000,duration_ms:600000,submitted_by:'private-contributor',...extra});
const dump=segments=>({license:LICENSE,license_url:'https://skipdb.tv/license',generated_at:'2026-10-15T10:00:00Z',count:segments.length,segments});
const payload=(extra={})=>({imdb_id:imdb,season:1,episode:1,intro:{start_ms:10000,end_ms:60000,confidence:1},outro:null,...extra});

test('edition suffixes preserve the release year and homonymous One Piece adaptations stay separate',()=>{
  for(const suffix of ['(LEG)','[DUB]','HD','(LEG) [HD]'])assert.deepEqual(catalogTitle('Vikings - 2013 '+suffix),{name:'Vikings',year:2013});
  assert.equal(explicitIdentity({catalog_name:'Vikings - 2013 (LEG)'}).imdb_id,'tt2306299');
  assert.equal(explicitIdentity({catalog_name:'Vikings Valhalla - 2022'}).imdb_id,'tt11311302');
  assert.equal(explicitIdentity({catalog_name:'One Piece - 1999 (LEG)'}).imdb_id,'tt0388629');
  assert.equal(explicitIdentity({catalog_name:'One Piece - 2023'}).imdb_id,'tt11737520');
  assert.equal(explicitIdentity({catalog_name:'One Piece'}),null);
  assert.equal(explicitIdentity({catalog_name:'Game of Thrones - 17 (LEG)'}),null);
  assert.equal(explicitIdentity({catalog_name:'ONE PIECE A Serie Conteudo Extra - 2026'}),null);
  assert.throws(()=>explicitIdentity({catalog_name:'One Piece - 1999',catalog_metadata:{year:2023}}),{code:'CATALOG_YEAR_CONFLICT'});
  assert.throws(()=>explicitIdentity({catalog_name:'One Piece - 2005',catalog_metadata:{imdb_id:'tt0388629',year:2005}}),{code:'CATALOG_YEAR_CONFLICT'});
  assert.throws(()=>explicitIdentity({catalog_name:'Vikings - 2013',catalog_metadata:{imdb_id:'tt2306299',tmdb_id:61856}}),{code:'CATALOG_IDENTITY_CONFLICT'});
  assert.equal(selectSeriesIdentity({catalog_name:'Vikings - 2013'},{local:[{name:'Vikings',year:2013,media_type:'series',imdb_id:'tt2306299',tmdb_id:61856}]}).status,'unresolved');
  const row={status:'resolved',media_id:'one',catalog_name:'One Piece - 1999',series_slug:'imdb-tt0388629',imdb_id:'tt0388629',tmdb_id:37854};
  assert.equal(markerSeriesFromIdentity(row,{id:'one',kind:'series',name:row.catalog_name}).year,1999);
  assert.equal(markerSeriesFromIdentity(row,{id:'one',kind:'series',name:'One Piece - 2023'}),null);
});

test('source episode numbers remain absolute where supplied and cannot be inferred from array position',()=>{
  const rows=episodeInventory({imdb_id:imdb,media_type:'series',episodes:[{season:2,episode:62,runtimeMs:null},{season:2,episode:63,runtimeMs:null}]},imdb);
  assert.deepEqual(rows.map(row=>[row.season,row.episode]),[[2,62],[2,63]]);
});

test('explicit audit priority includes existing ready rows, preserves editions and finishes only successful source checks',async()=>{
  for(const failed of [false,true]){
    const episode={imdb_id:imdb,series_slug:'imdb-'+imdb,season:1,episode:1,status:'ready',source:'skipdb',audit_priority:100,audit_requested_at:new Date(NOW-1000).toISOString(),evidence:{manualReview:{editionVerified:false},skipdb:{intro:{start_ms:1000,end_ms:50000}}}};
    const store=storeFixture({state:{dump_object:'fixture.jsonl',dump_refreshed_at:new Date(NOW).toISOString(),dump_completed_at:new Date(NOW).toISOString()},episodes:[episode]});
    store.auditDue=async(_now,limit)=>{assert.equal(limit,10);return [episode];};
    store.due=async()=>assert.fail('A requested audit reserves this bounded cycle before dump, inventory and discovery lookups.');
    const sources=[],providers={cooldowns:{},async segments(source){sources.push(source);if(failed&&source==='skipdb')throw Object.assign(new Error('private'),{code:'PROVIDER_NETWORK_FAILED'});return {status:'ok',payload:source==='skipdb'?{imdb_id:imdb,season:1,episode:1,segments:{intro:payload().intro}}:payload()};}};
    await runMarkerPipeline({store,providers,now:()=>NOW});
    const patch=store.saved.find(row=>row.table==='coverage').patch;
    assert.equal(patch.status,'ready');assert.equal(patch.evidence.manualReview.editionVerified,false);assert.equal(patch.evidence.audit.editionVerified,false);
    assert.equal(patch.audit_priority,failed?undefined:0);assert.equal(patch.evidence.audit.completed,!failed);
    assert.equal(patch.audit_checked_at,failed?undefined:new Date(NOW).toISOString());
    assert.deepEqual(sources,['skipdb','introdb']);
    assert.equal(store.calls.some(([name])=>name==='arkhen_marker_publish'),false);
  }
});

test('the cloud dump normalizer accepts every approved series IMDb, preserves original durations and drops contributor data',async()=>{
  const value=await normalizeGlobalDump(dump([segment(),segment({id:2,segment_type:'outro',start_ms:560000,end_ms:600000}),segment({id:3,status:'pending'}),segment({id:4,imdb_id:'tt9876543',duration_ms:620000}),segment({id:5,duration_ms:null})]),{now:NOW});
  assert.equal(value.records.length,2);assert.equal(value.missingDuration,1);assert.equal(value.records[0].series_slug,'imdb-'+imdb);assert.equal(value.records[0].title,null);
  assert.equal(value.records[0].duration_seconds,600);assert.equal(value.records[0].markers.creditsStart,560);assert.equal(value.records[0].verification,'community-reference');
  assert.doesNotMatch(JSON.stringify(value),/private-contributor|submitted_by/);
  await assert.rejects(normalizeGlobalDump(dump([segment({id:{private:'bad'}})])),{code:'INVALID_DUMP_SEGMENT'});
});

test('conflicting editions and post-credit scenes remain blocked without choosing the first runtime',async()=>{
  const value=await normalizeGlobalDump(dump([segment(),segment({id:2,duration_ms:601000,end_ms:80000}),segment({id:3,segment_type:'outro',start_ms:550000,end_ms:580000}),segment({id:4,segment_type:'preview',start_ms:580000,end_ms:600000})]),{now:NOW});
  for(const row of value.records)assert.equal(row.markers.openingEnd,undefined);
  assert.equal(value.records[0].markers.creditsStart,undefined);assert.equal(value.records[0].provenance.verification.blockEarlyNext,true);
});

test('identity resolution requires an exact unique series match, including a supplied release year',()=>{
  const row={catalog_name:'Uma Série Nova - 2020',catalog_metadata:{}};
  const matching={imdb_id:imdb,name:'Uma Serie Nova',year:2020,mediaType:'series'};
  assert.equal(selectSeriesIdentity(row,{local:[matching]}).identity.imdb_id,imdb);
  for(const candidate of [{...matching,name:'Uma Série Nova: Especial'},{...matching,year:2019},{...matching,mediaType:'movie'},{...matching,imdb_id:null,tmdbId:123}])assert.equal(selectSeriesIdentity(row,{results:[candidate]}).status,'unresolved');
  assert.equal(selectSeriesIdentity(row,{local:[matching,{...matching,imdb_id:'tt7654321'}]}).status,'ambiguous');
  assert.equal(explicitIdentity({catalog_name:'Outro',metadata:{id:'12345'}}),null);assert.equal(explicitIdentity({catalog_name:'Outro',metadata:{imdb_id:imdb}}).imdb_id,imdb);
  const item={kind:'series',id:'55',name:row.catalog_name},record={status:'resolved',media_id:'55',catalog_name:row.catalog_name,series_slug:'imdb-'+imdb,imdb_id:imdb};
  assert.equal(markerSeriesFromIdentity(record,item).imdbId,imdb);assert.equal(markerSeriesFromIdentity({...record,media_id:'66'},item),null);
});

test('episode inventories use real numbers and APIs without source runtime stay explicitly unverified',()=>{
  const inventory=episodeInventory({imdb_id:imdb,media_type:'series',episodes:[{season:5,episode:1,runtimeMs:3180000},{season:'5',episode:2}]},imdb);assert.equal(inventory.length,1);assert.equal(inventory[0].runtime_hint_seconds,3180);
  const result=inspectSegments('introdb',payload({outro:{start_ms:550000,end_ms:580000},post_credits:{start_ms:580000,end_ms:600000}}),{imdb_id:imdb,season:1,episode:1});
  assert.equal(result.status,'unverified');assert.equal(result.reason,'SOURCE_EDITION_DURATION_UNAVAILABLE');assert.equal(result.markers,undefined);
  assert.throws(()=>inspectSegments('introdb',payload({imdb_id:'tt7654321'}),{imdb_id:imdb,season:1,episode:1}),{code:'SOURCE_IDENTITY_MISMATCH'});
});

test('streaming dump parsing handles boundaries and escaped braces while discarding unapproved contributor objects',async()=>{
  const source={...dump([segment({notes:'escaped } { \\"文字'}),segment({id:2,status:'rejected',submitted_by:{never:'copy'}})]),tail:'done'},bytes=new TextEncoder().encode(JSON.stringify(source));let offset=0;
  const request=async()=>new Response(new ReadableStream({pull(controller){if(offset>=bytes.length){controller.close();return;}controller.enqueue(bytes.slice(offset,offset+13));offset+=13;}}));
  const result=await readPublicDump(request);assert.equal(result.sourceCount,2);assert.equal(result.segments.length,1);assert.equal(result.count,1);assert.equal(result.sourceBytes,bytes.length);assert.doesNotMatch(JSON.stringify(result),/private-contributor|never|notes/);
  const bad={...source,count:99};await assert.rejects(readPublicDump(async()=>new Response(JSON.stringify(bad))),{code:'DUMP_COUNT_MISMATCH'});
  await assert.rejects(readPublicDump(async()=>new Response('',{status:302,headers:{location:'https://untrusted.invalid/dump'}})),{code:'DUMP_REDIRECT_REJECTED'});
});

test('incremental raw pages resume at complete object byte boundaries and never persist contributor data',()=>{
  const source=dump(Array.from({length:12},(_,index)=>segment({id:index+1,episode:index+1,notes:'文字 { } \\"'}))),bytes=new TextEncoder().encode(JSON.stringify(source));
  let offset=0,metadata=null,count=0;const rows=[];
  for(let calls=0;calls<50;calls++){
    const page=parseRawRange(bytes.slice(offset,offset+512),{offset,metadata});assert.ok(page.next>offset);offset=page.next;metadata=page.metadata;count+=page.count;rows.push(...page.rows);if(page.complete)break;
  }
  assert.equal(count,12);assert.equal(rows.length,12);assert.doesNotMatch(JSON.stringify(rows),/submitted_by|private-contributor|notes/);assert.equal(metadata.count,12);
});

test('the deployed incremental source copies raw bytes privately and postpones transformation to later bounded runs',async()=>{
  const state={dump_object:'old.jsonl',dump_completed_at:new Date(NOW-2*86400000).toISOString(),dump_refreshed_at:new Date(NOW-2*86400000).toISOString()},store=storeFixture();let copied=false;
  store.uploadRaw=async(key,body)=>{assert.match(key,/^skipdb-raw-/);assert.ok((await new Response(body).text()).includes('private-contributor'));copied=true;};
  await advanceIncrementalSource({store,state,owner:'fixture',request:async()=>new Response(JSON.stringify(dump([segment()]))),now:()=>NOW,room:()=>true,artifactStream:()=>assert.fail('No full transformation'),result:{}});
  assert.equal(copied,true);assert.equal(state.source_mode,'incremental');assert.equal(state.raw_cursor,0);assert.equal(state.dump_completed_at,null,'Starting a new generation revokes permission to retain/delete finalized caches.');assert.equal(store.calls.some(([name])=>name==='arkhen_marker_publish'),false);
});

test('a dense conflicting edition cluster remains bounded and cannot create an automatic opening',async()=>{
  const normalized=await normalizeGlobalDump(dump(Array.from({length:200},(_,index)=>segment({id:index+1,duration_ms:600000+index,end_ms:60000+index*100}))));
  assert.equal(normalized.records.length,200);assert.ok(normalized.records.every(row=>row.markers.openingEnd===undefined));
  assert.ok(normalized.records.every(row=>!row.provenance.verification.openingCandidates));assert.ok(JSON.stringify(normalized.records).length<250000);
});

test('incremental complete episode groups publish licensed parts before DB rows and finish the public index on a later empty batch',async()=>{
  const state={raw_object:'skipdb-raw-20261015T100000Z.json',raw_generation:'20261015T100000Z',raw_complete_at:new Date(NOW).toISOString(),raw_metadata:{generated_at:new Date(NOW).toISOString()},dump_refreshed_at:new Date(NOW).toISOString(),source_mode:'incremental'};
  const store=storeFixture();store.url='https://fixture.supabase.co';let batches=0;const groups=[{imdb_id:imdb,season:1,episode:1}],parts=[];
  store.rpc=async(name,args)=>{store.calls.push([name,args]);if(name==='arkhen_marker_source_batch')return ++batches===1?{groups,segments:[segment()]}:{groups:[],segments:[]};if(name==='arkhen_marker_source_index')return parts;if(name==='arkhen_marker_source_done')parts.push(args.p_export_key);return 1;};
  const result={published:0};await advanceIncrementalSource({store,state,owner:'fixture',now:()=>NOW,room:()=>true,artifactStream:publicArtifactStream,result});
  assert.equal(result.published,1);assert.equal(result.dumpComplete,true);assert.equal(result.cacheChanged,true);
  assert.ok(store.calls.findIndex(([name])=>name==='export')<store.calls.findIndex(([name])=>name==='arkhen_marker_publish'));
  assert.equal(store.calls.at(-1)[1],'skipdb-current.json');assert.ok(state.dump_completed_at);
  const count=store.calls.length;await advanceIncrementalSource({store,state,owner:'fixture',now:()=>NOW,room:()=>true,artifactStream:publicArtifactStream,result});assert.equal(store.calls.length,count,'A completed current generation is not read/finalized repeatedly.');
});

test('modern Supabase secrets use apikey only, while legacy JWT credentials retain Bearer authorization',async()=>{
  for(const key of ['sb_secret_private-fixture','eyJ.legacy.fixture']){
    const store=new MarkerStore({url:'https://fixture.supabase.co',key,fetch:async(_url,options)=>{assert.equal(options.headers.apikey,key);assert.equal(options.headers.Authorization,key.startsWith('eyJ')?'Bearer '+key:undefined);return new Response('[]');}});
    await store.call('/rest/v1/series_marker_titles');await store.uploadDump('fixture.jsonl','{}');
  }
});

test('provider auth only uses headers and 429 persists a cooldown while an empty response remains distinct from a failure',async()=>{
  let clock=NOW,calls=0;const providers=new MarkerProviders({now:()=>clock,sleep:async ms=>{clock+=ms;},skipdbKey:'fixture-secret',fetch:async(url,options)=>{
    calls++;assert.doesNotMatch(url,/fixture-secret/);assert.equal(options.headers['X-API-Key'],'fixture-secret');return new Response('',{status:429,headers:{'Retry-After':'120'}});
  }});
  await assert.rejects(providers.segments('skipdb',{imdb_id:imdb,season:1,episode:1}),{code:'PROVIDER_RATE_LIMITED'});assert.ok(providers.cooldowns.skipdb>=NOW+120000);
  await assert.rejects(providers.search('Nova série'),{code:'PROVIDER_COOLDOWN'});assert.equal(calls,1);
  const empty=new MarkerProviders({sleep:async()=>{},fetch:async()=>new Response('',{status:404})});assert.equal((await empty.inventory(imdb)).status,'empty');
  const broken=new MarkerProviders({sleep:async()=>{},fetch:async()=>new Response('not-json')});await assert.rejects(broken.inventory(imdb),{code:'PROVIDER_RESPONSE_INVALID'});
});

function storeFixture({state={},episodes=[],failUpload=false}={}){
  const calls=[],saved=[],checkpoints=[];let records=[];
  const store={state:{claimed:true,...state},calls,saved,checkpoints,
    async claim(){return {...this.state};},async release(owner,result,cooldowns){calls.push(['release',owner,result,cooldowns]);},async discover(){return 0;},
    async save(table,rows,_conflict,options){saved.push({table,rows,options});},async update(){},async identity(){},async title(){},async coverage(row,patch){saved.push({table:'coverage',row,patch});},
    async due(table){return table==='series_marker_coverage'?episodes:[];},async call(){return [];},
    async checkpoint(owner,patch){Object.assign(this.state,patch);checkpoints.push(patch);},
    async uploadDump(key,body){if(failUpload)throw Object.assign(new Error('failed'),{code:'MARKER_EXPORT_FAILED'});const text=await new Response(body).text();records=text.trim().split('\n').map(line=>JSON.parse(line)).filter(row=>row.type!=='metadata');calls.push(['export',key]);},
    async dumpPage(_key,offset){const start=offset/10;return {records:records.slice(start),offsets:records.slice(start).map((_,index)=>(start+index+1)*10),next:records.length*10,done:true};},
    async rpc(name,args){calls.push([name,args]);return args.p_rows?.length||0;}
  };return store;
}

test('a global run publishes the licensed artifact before many resumable 200-edition batches, without a user/catalog prerequisite',async()=>{
  const store=storeFixture(),segments=Array.from({length:450},(_,index)=>segment({id:index+1,episode:index+1}));
  const result=await runMarkerPipeline({store,now:()=>NOW,loadDump:async()=>dump(segments),providers:{cooldowns:{}}});
  assert.equal(result.published,450);assert.equal(result.dumpComplete,true);assert.equal(store.calls[0][0],'export');
  assert.deepEqual(store.calls.filter(([name])=>name==='arkhen_marker_publish').map(([,args])=>args.p_rows.length),[200,200,50]);
  assert.ok(store.calls.filter(([name])=>name==='arkhen_marker_publish').every(([,args])=>args.p_owner&&args.p_generation));assert.ok(store.checkpoints.some(patch=>patch.dump_cursor===4500));assert.ok(store.checkpoints.at(-1).dump_completed_at);
});

test('an export failure does not publish/deactivate existing rows or report an empty successful snapshot',async()=>{
  const store=storeFixture({failUpload:true}),result=await runMarkerPipeline({store,now:()=>NOW,loadDump:async()=>dump([segment()]),providers:{cooldowns:{}}});
  assert.equal(result.state,'partial');assert.equal(result.dumpError,'MARKER_EXPORT_FAILED');assert.equal(store.calls.some(([name])=>name==='arkhen_marker_publish'||name==='arkhen_marker_finalize'),false);assert.ok(store.checkpoints.some(patch=>patch.dump_retry_at));
});

test('artifact publication stops at four thousand records and resumes the precise next record in another invocation',async()=>{
  const store=storeFixture(),segments=Array.from({length:4050},(_,index)=>segment({id:index+1,episode:index+1}));
  const options={store,now:()=>NOW,loadDump:async()=>dump(segments),providers:{cooldowns:{}}};
  const first=await runMarkerPipeline(options);assert.equal(first.published,4000);assert.equal(first.dumpComplete,false);assert.equal(store.state.dump_cursor,40000);
  assert.equal(store.calls.some(([name])=>name==='arkhen_marker_finalize'),false);
  const second=await runMarkerPipeline(options);assert.equal(second.published,50);assert.equal(second.dumpComplete,true);assert.equal(store.state.dump_cursor,40500);
});

test('missing or failed preferred data selectively calls IntroDB and persists negative/unverified outcomes globally',async()=>{
  const episode={imdb_id:imdb,series_slug:'imdb-'+imdb,season:1,episode:1},store=storeFixture({state:{dump_refreshed_at:new Date(NOW).toISOString(),dump_retry_at:new Date(NOW+60000).toISOString()},episodes:[episode]});
  const sources=[],providers={cooldowns:{},async segments(source){sources.push(source);if(source==='skipdb')throw Object.assign(new Error('network'),{code:'PROVIDER_NETWORK_FAILED'});return {status:'ok',payload:payload()};}};
  const result=await runMarkerPipeline({store,now:()=>NOW,providers});assert.deepEqual(sources,['skipdb','introdb']);assert.equal(result.introdb,1);
  const written=store.saved.find(value=>value.table==='coverage');assert.equal(written.patch.status,'unverified');assert.equal(written.patch.skipdb_status,'failed');assert.equal(written.patch.introdb_status,'unverified');assert.equal(result.failures,1);assert.equal(written.patch.evidence.introdb.intro.end_ms,60000);
});

test('identity batches stay bounded to eight and negative episode cache stops subsequent provider work',async()=>{
  const episode={imdb_id:imdb,series_slug:'imdb-'+imdb,season:1,episode:1,next_check_at:new Date(NOW-1).toISOString()},store=storeFixture({state:{dump_object:'fixture.jsonl',dump_refreshed_at:new Date(NOW).toISOString(),dump_completed_at:new Date(NOW).toISOString()}});
  let identities=true,requests=0;const limits=[];
  store.due=async(table,_field,_now,limit)=>{limits.push([table,limit]);if(table==='series_marker_identities'&&identities){identities=false;return Array.from({length:limit},(_,index)=>({provider_key:'fixture',scope_hash:'fixture',media_id:String(index),catalog_name:'Fixture',catalog_metadata:{imdbId:imdb}}));}return table==='series_marker_coverage'&&Date.parse(episode.next_check_at)<=NOW?[episode]:[];};
  store.coverage=async(_row,patch)=>Object.assign(episode,patch);
  const providers={cooldowns:{},async segments(){requests++;return {status:'empty'};}};
  const first=await runMarkerPipeline({store,now:()=>NOW,providers});assert.equal(first.identities,8);assert.equal(first.episodesChecked,1);assert.equal(episode.status,'empty');assert.ok(Date.parse(episode.next_check_at)>NOW);assert.equal(requests,2);
  assert.ok(limits.some(([table,limit])=>table==='series_marker_identities'&&limit===8));assert.ok(limits.every(([,limit])=>limit<=10));
  const second=await runMarkerPipeline({store,now:()=>NOW,providers});assert.equal(second.episodesChecked,0);assert.equal(second.identities,0);assert.equal(requests,2,'A cached empty episode cannot trigger either provider again before its deadline.');
});

test('range checkpoints preserve UTF-8 byte positions and never request the original provider dump again',async()=>{
  const text=JSON.stringify({type:'metadata',license:LICENSE})+'\n'+JSON.stringify({edition_id:'abc',name:'ação'})+'\n',bytes=new TextEncoder().encode(text);
  const store=new MarkerStore({url:'https://fixture.supabase.co',key:'private-fixture',fetch:async(url,options)=>{assert.match(url,/\/storage\/v1\/object\/public\//);assert.equal(options.headers.Range,'bytes=0-524287');return new Response(bytes,{status:206,headers:{'Content-Range':`bytes 0-${bytes.length-1}/${bytes.length}`}});}});
  const page=await store.dumpPage('skipdb-fixture.jsonl',0);assert.equal(page.records[0].name,'ação');assert.equal(page.offsets[0],bytes.length);assert.equal(page.next,bytes.length);assert.equal(page.done,true);
});

test('the Edge handler rejects absent/wrong capabilities and never accepts client-controlled options or credentials',async()=>{
  const secret='fixture-'.repeat(8),env=name=>({ARKHEN_MARKER_SYNC_SECRET:secret,SKIPDB_API_KEY:'private-fixture'})[name];let calls=0;
  const handler=createMarkerSyncHandler({environment:env,store:{},pipeline:async options=>{calls++;assert.equal(options.skipdbKey,'private-fixture');return {state:'ready'};}});
  assert.equal((await handler(new Request('https://fixture.test',{method:'POST',body:'{}'}))).status,401);
  assert.equal((await handler(new Request('https://fixture.test',{method:'POST',headers:{'x-arkhen-marker-secret':secret},body:'{"url":"https://untrusted.invalid"}'}))).status,400);
  const response=await handler(new Request('https://fixture.test',{method:'POST',headers:{'x-arkhen-marker-secret':secret},body:'{}'}));assert.equal(response.status,200);assert.equal(calls,1);assert.doesNotMatch(await response.text(),/private-fixture|fixture-fixture/);
});

test('a checkpointed worker schedules one authenticated continuation after eleven seconds and completed generations stop it',async()=>{
  const secret='fixture-'.repeat(8),background=[],delays=[],requests=[];
  const env=name=>({ARKHEN_MARKER_SYNC_SECRET:secret,SUPABASE_URL:'https://fixture.supabase.co'})[name];
  const options={environment:env,store:{},waitUntil:work=>background.push(work),sleep:async delay=>{delays.push(delay);},fetch:async(url,options)=>{requests.push({url,options});return new Response('{}');}};
  const request=()=>new Request('https://fixture.test',{method:'POST',headers:{'x-arkhen-marker-secret':secret},body:'{}'});
  await createMarkerSyncHandler({...options,pipeline:async()=>({state:'ready',published:4000,dumpComplete:false})})(request());await Promise.all(background);
  assert.deepEqual(delays,[11000]);assert.equal(requests.length,1);assert.equal(requests[0].url,'https://fixture.supabase.co/functions/v1/series-markers-sync');assert.equal(requests[0].options.headers['x-arkhen-marker-secret'],secret);assert.equal(requests[0].options.body,'{}');
  await createMarkerSyncHandler({...options,pipeline:async()=>({state:'ready',published:1,dumpComplete:true})})(request());assert.equal(background.length,1);
  await createMarkerSyncHandler({...options,pipeline:async()=>({state:'ready',published:0,dumpComplete:true,episodesChecked:10})})(request());await Promise.all(background);assert.equal(background.length,2,'Catalog fallback work continues after source publication is complete.');
  await createMarkerSyncHandler({...options,pipeline:async()=>({state:'partial',published:0,dumpComplete:true,failures:1,episodesChecked:0,identities:0,unresolved:0,inventories:0})})(request());assert.equal(background.length,2,'An idle or failing run with no checkpointed lookup progress stops the chain.');
});

for(const preferred of ['network','404','empty','cooldown','wrong-identity','intro'])test('provider fallback and registry telemetry: '+preferred,async()=>{
  const episode={imdb_id:imdb,series_slug:'imdb-'+imdb,season:1,episode:1},requests=[];
  const state={dump_object:'fixture.jsonl',dump_refreshed_at:new Date(NOW).toISOString(),dump_completed_at:new Date(NOW).toISOString(),
    ...(preferred==='cooldown'?{skipdb_cooldown_until:new Date(NOW+60000).toISOString()}:{}),
    last_result:{providerStatus:{skipdb:{lastSuccessAt:'2026-10-14T12:00:00.000Z',secret:'never-copy'},introdb:{}}}};
  const store=storeFixture({state,episodes:[episode]});
  const providers=new MarkerProviders({now:()=>NOW,sleep:async()=>{},skipdbKey:'private-skipdb-key',state,fetch:async(url,options)=>{
    const source=new URL(url).hostname==='api.introdb.app'?'introdb':'skipdb';requests.push(source);
    assert.equal(options.headers['X-API-Key'],source==='skipdb'?'private-skipdb-key':undefined);
    if(source==='introdb')return new Response(JSON.stringify(payload({intro:{start_ms:20000,end_ms:80000,confidence:1}})));
    if(preferred==='network')throw new Error('Do not record https://private.example?token=secret');
    if(preferred==='404')return new Response('',{status:404});
    const segments={intro:preferred==='empty'?null:{start_ms:10000,end_ms:60000,confidence:1},outro:null,recap:null,preview:null};
    return new Response(JSON.stringify({imdb_id:preferred==='wrong-identity'?'tt7654321':imdb,season:1,episode:1,segments}));
  }});
  const result=await runMarkerPipeline({store,providers,now:()=>NOW,loadDump:async()=>assert.fail('Fresh dump does not reload')});
  assert.deepEqual(requests,preferred==='intro'?['skipdb']:preferred==='cooldown'?['introdb']:['skipdb','introdb']);
  const written=store.saved.find(value=>value.table==='coverage').patch;
  assert.equal(written.source,preferred==='intro'?'skipdb':'introdb');
  assert.equal(written.evidence[written.source].intro.end_ms,preferred==='intro'?60000:80000);
  assert.equal(written.status,'unverified','An API response without source runtime is never promoted to verified IPTV markers.');
  assert.equal(result.providerStatus.skipdb.configured,true);assert.equal(result.providerStatus.introdb.configured,false);
  assert.doesNotMatch(JSON.stringify(result.providerStatus),/private-skipdb-key|never-copy|token|https:/);
  if(preferred==='intro')assert.equal(written.evidence.introdb,undefined,'A fallback cannot mix timestamps into a usable preferred intro.');
  if(preferred==='network')assert.equal(result.providerStatus.skipdb.errorCode,'PROVIDER_NETWORK_FAILED');
  if(preferred==='404')assert.equal(result.providerStatus.skipdb.errorCode,null,'A valid empty response is healthy availability, not a network failure.');
  if(preferred==='cooldown'){assert.equal(result.providerStatus.skipdb.lastCheckedAt,undefined);assert.equal(result.providerStatus.skipdb.lastSuccessAt,'2026-10-14T12:00:00.000Z');}
});
