import test from 'node:test';
import assert from 'node:assert/strict';
import {runCloudCollector} from '../supabase/functions/arkhen-catalog-sync/collector.mjs';
import {createCollectorHandler} from '../supabase/functions/arkhen-catalog-sync/handler.mjs';
import {CollectorStore} from '../supabase/functions/arkhen-catalog-sync/store.mjs';

const provider='a'.repeat(64),scope='b'.repeat(64),timestamp=Date.now(),secret='fixture_collector_secret_1234567890';
function fixture(jobType='catalog'){
  const calls=[],job={id:'fixture-job',provider_key:provider,scope_hash:scope,job_type:jobType,payload:{media_type:'movies'}};
  let state={};
  const store={claim:async()=>[job],source:async()=>({expires_at:new Date(timestamp+900000).toISOString()}),state:async()=>state,
    checkpoint:async(j,w,value)=>{calls.push(['checkpoint',value]);state={...state,...value.progress};},
    publish:async(j,w,type)=>{calls.push(['publish',type]);delete state.typeReady;state={...state,publishedTypes:[...state.publishedTypes||[],type]};return state;},
    yield:async(j,w,value)=>{calls.push(['yield',value]);state={...state,...value};},finish:async(j,w,success,error)=>calls.push(['finish',success,error]),
    artworks:async rows=>calls.push(['artworks',rows]),rpc:async(name,args)=>calls.push(['rpc',name,args])};
  const source={provider:'wplay',userAgent:'FixtureUA',service:{token:'private-token'},expiresAt:new Date(timestamp+900000).toISOString()};
  const options={store,worker:'fixture-worker',now:()=>timestamp,encryptionKey:'fixture-key',decrypt:async()=>source,encrypt:async()=>({version:1,iv:'encrypted-iv',ciphertext:'encrypted-data'})};
  return {calls,job,source,store,options,get state(){return state;},set state(value){state=value;}};
}
const page=(id,next,complete=false)=>({categories:[{id:'1',name:'Filmes'}],items:id?[{id,name:'Filme '+id,kind:'movie',categoryId:'1',categoryIds:['1']}]:[],next,complete});

test('collector checkpoints pages, releases the lease and resumes before publishing a complete catalog',async()=>{
  const f=fixture(),cursors=[];
  const createSource=()=>({catalogStep:async(type,cursor)=>{cursors.push(cursor);return cursor.page===1?page('10',{categoryIndex:0,page:2}):page(null,null,true);}});
  const first=await runCloudCollector({...f.options,createSource,maxSteps:1});
  assert.equal(first.state,'checkpointed');assert.equal(f.calls.some(row=>row[0]==='publish'),false);assert.equal(f.calls.some(row=>row[0]==='finish'),false);
  const second=await runCloudCollector({...f.options,createSource,maxSteps:1});assert.equal(second.state,'ready');
  assert.deepEqual(cursors,[{categoryIndex:0,page:1},{categoryIndex:0,page:2}]);assert.deepEqual(f.calls.filter(row=>row[0]==='publish'),[['publish','movies']]);
  assert.equal(f.calls.at(-1)[1],true);assert.equal(f.state.publishedTypes.includes('movies'),true);
});

test('collector recovers a crash between final checkpoint and publication without refetching the provider',async()=>{
  const f=fixture();f.state={type:'movies',typeReady:'movies',cursor:{categoryIndex:9,page:8}};
  const result=await runCloudCollector({...f.options,createSource:()=>({catalogStep:()=>assert.fail('Final pages are already staged.')}),maxSteps:1});
  assert.equal(result.state,'ready');assert.equal(f.calls.filter(row=>row[0]==='publish').length,1);
});

test('bounded private publication batches resume without claiming completeness or refetching provider pages',async()=>{
  const f=fixture();f.state={type:'movies',typeReady:'movies'};let calls=0;
  f.store.publish=async()=>{calls++;if(calls<3){f.state={...f.state,publicationCursors:{movies:calls*12}};return f.state;}f.state={...f.state,publishedTypes:['movies']};delete f.state.typeReady;return f.state;};
  const createSource=()=>({catalogStep:()=>assert.fail('Completed provider pages are already staged.')} );
  assert.equal((await runCloudCollector({...f.options,createSource,maxSteps:1})).state,'checkpointed');
  assert.deepEqual(f.state.publicationCursors,{movies:12});assert.equal(f.calls.some(row=>row[0]==='finish'),false);
  assert.equal((await runCloudCollector({...f.options,createSource,maxSteps:2})).state,'ready');assert.equal(calls,3);
  assert.equal(f.calls.at(-1)[1],true);
});

test('a private database publication timeout reports its sanitized phase and preserves completed provider pages',async()=>{
  const f=fixture();f.state={typeReady:'movies'};f.store.publish=async()=>({...f.state,publicationFailure:{type:'movies',code:'57014',stage:'artwork_cleanup'}});
  const result=await runCloudCollector({...f.options,createSource:()=>({catalogStep:()=>assert.fail('Finished provider pages must not be downloaded again.')}),maxSteps:1});
  assert.equal(result.code,'COLLECTOR_PUBLICATION_ARTWORK_CLEANUP_57014');assert.equal(result.state,'failed');assert.equal(f.calls.at(-1)[1],false);
});

test('snapshot preparation yields before the final publication transaction',async()=>{
  const f=fixture();f.state={typeReady:'movies'};let calls=0;
  f.store.publish=async()=>{calls++;if(calls===1){f.state={...f.state,publicationPreparedTypes:['movies']};return f.state;}f.state={...f.state,publishedTypes:['movies']};delete f.state.typeReady;return f.state;};
  const createSource=()=>({catalogStep:()=>assert.fail('Prepared movies do not need another provider request.')} );
  assert.equal((await runCloudCollector({...f.options,createSource,maxSteps:12})).state,'checkpointed');assert.equal(calls,1);
  assert.equal((await runCloudCollector({...f.options,createSource,maxSteps:12})).state,'ready');assert.equal(calls,2);
});

test('catalog collection alternates independent cursors and resumes a legacy movie import without starving series',async()=>{
  const f=fixture(),visited=[];f.job.payload={};f.state={publishedTypes:['live'],type:'movies',cursor:{categoryIndex:18,page:7}};
  const createSource=()=>({catalogStep:async(type,cursor)=>{
    visited.push([type,{...cursor}]);return type==='series'?{categories:[],items:[],next:null,complete:true}:page('10',{categoryIndex:cursor.categoryIndex,page:cursor.page+1});
  }});
  assert.equal((await runCloudCollector({...f.options,createSource,maxSteps:2})).state,'checkpointed');
  assert.deepEqual(visited,[['movies',{categoryIndex:18,page:7}],['series',{categoryIndex:0,page:1}]]);
  assert.deepEqual(f.calls.filter(row=>row[0]==='publish'),[['publish','series']]);
  assert.deepEqual(f.state.cursors.movies.cursor,{categoryIndex:18,page:8});
  await runCloudCollector({...f.options,createSource,maxSteps:1});
  assert.deepEqual(visited.at(-1),['movies',{categoryIndex:18,page:8}]);
  assert.deepEqual(f.state.cursors.movies.cursor,{categoryIndex:18,page:9});
});

test('first-page previews are bounded, seeded once per job and do not advance collection cursors',async()=>{
  const f=fixture(),visited=[],seeds=[];let clock=timestamp;
  f.job.payload={};f.state={type:'movies',cursor:{categoryIndex:18,page:7}};
  f.store.seed=async(j,w,type,payload)=>{seeds.push([type,payload]);if(type==='series')clock+=36000;};
  const createSource=()=>({catalogStep:async(type,cursor)=>{visited.push([type,{...cursor}]);return {categories:[],items:Array.from({length:180},(_,id)=>({id:String(id),name:'Title',kind:type==='movies'?'movie':type})),next:{categoryIndex:cursor.categoryIndex,page:cursor.page+1},complete:false};}});
  const first=await runCloudCollector({...f.options,now:()=>clock,createSource,maxSteps:1});
  assert.equal(first.state,'checkpointed');assert.equal(first.steps,0);
  assert.deepEqual(seeds.map(row=>[row[0],row[1].items.length]),[['live',120],['movies',120],['series',120]]);
  assert.deepEqual(f.state.previewSeeded,['live','movies','series']);assert.deepEqual(f.state.cursor,{categoryIndex:18,page:7});
  assert.equal(f.calls.some(row=>row[0]==='publish'||row[0]==='finish'),false);
  await runCloudCollector({...f.options,now:()=>clock,createSource,maxSteps:1});
  assert.equal(seeds.length,3,'A fresh invocation uses durable seed flags instead of probing every type again.');
  assert.equal(visited.length,4);assert.deepEqual(visited.at(-1),['live',{categoryIndex:0,page:1}]);
  assert.deepEqual(f.state.cursors.movies.cursor,{categoryIndex:18,page:7},'The first-page preview did not reset the long-running movie cursor.');
});

test('a pending completed type publishes before another cursor and disabled types are never previewed',async()=>{
  const f=fixture();f.job.payload={};f.source.service.enabledVoD=false;f.state={type:'live',typeReady:'live',nextType:'movies'};
  f.store.seed=()=>assert.fail('A completed live type and disabled VOD types need no provider probes.');
  const result=await runCloudCollector({...f.options,createSource:()=>({catalogStep:()=>assert.fail('The complete type is already staged.')}),maxSteps:1});
  assert.equal(result.state,'deferred');assert.deepEqual(f.calls.filter(row=>row[0]==='publish'),[['publish','live']]);
});

test('large pages can resume at a durable chunk within the invocation budget',async()=>{
  const f=fixture();let clock=timestamp,reads=0;const checkpoint=f.store.checkpoint;
  f.store.checkpoint=async(...args)=>{await checkpoint(...args);clock+=36000;};
  const createSource=()=>({catalogStep:async()=>{reads++;return {categories:[{id:'1',name:'Filmes'}],items:Array.from({length:180},(_,id)=>({id:String(id),name:'Filme',kind:'movie',plot:'a'.repeat(20000)})),complete:true,next:null};}});
  assert.equal((await runCloudCollector({...f.options,now:()=>clock,createSource})).state,'checkpointed');assert.equal(f.state.pageChunk.next,1);
  assert.equal((await runCloudCollector({...f.options,now:()=>clock,createSource})).state,'ready');
  assert.equal(reads,2);assert.deepEqual(f.calls.filter(row=>row[0]==='checkpoint').map(row=>row[1].step),['movies:0:1:0','movies:0:1:1']);
});

test('a changed page fingerprint restarts its chunks instead of combining different provider revisions',async()=>{
  const f=fixture();let clock=timestamp,revision=1;const checkpoint=f.store.checkpoint;
  f.store.checkpoint=async(...args)=>{await checkpoint(...args);clock+=36000;};
  const createSource=()=>({catalogStep:async()=>({categories:[],items:Array.from({length:180},(_,id)=>({id:String(id),name:'Revision '+revision,kind:'movie',plot:'a'.repeat(20000)})),complete:true,next:null})});
  assert.equal((await runCloudCollector({...f.options,now:()=>clock,createSource})).state,'checkpointed');const previous=f.state.pageChunk.pageHash;revision=2;
  assert.equal((await runCloudCollector({...f.options,now:()=>clock,createSource})).state,'checkpointed');assert.notEqual(f.state.pageChunk.pageHash,previous);
  assert.deepEqual(f.calls.filter(row=>row[0]==='checkpoint').map(row=>row[1].step),['movies:0:1:0','movies:0:1:0']);
});

test('a source with VOD disabled preserves global snapshots and defers those types until an eligible source appears',async()=>{
  const f=fixture();f.source.service.enabledVoD=false;
  const result=await runCloudCollector({...f.options,createSource:()=>({catalogStep:()=>assert.fail('Disabled services cannot replace shared catalogs with empty results.')}),maxSteps:1});
  assert.equal(result.state,'deferred');assert.deepEqual(result.skippedTypes,['movies']);assert.deepEqual(f.state.skippedTypes,['movies']);assert.equal(f.calls.some(row=>row[0]==='publish'),false);
  assert.deepEqual(f.calls.at(-1),['finish',false,'COLLECTOR_CAPABILITY_UNAVAILABLE']);
  f.source.service.enabledVoD=true;
  assert.equal((await runCloudCollector({...f.options,createSource:()=>({catalogStep:async()=>page('10',null,true)}),maxSteps:1})).state,'ready');assert.deepEqual(f.state.skippedTypes,[]);
});

test('collector stores artwork origins only as encrypted rows and stages opaque partition-bound references',async()=>{
  const f=fixture();let encrypted;
  const result=await runCloudCollector({...f.options,maxSteps:1,encrypt:async value=>{encrypted=value;return {version:1,iv:'encrypted-iv',ciphertext:'encrypted-data'};},
    createSource:({mapImage})=>({catalogStep:async()=>{const data=page('10',null,true);data.items[0].poster=await mapImage('https://covers.arkhen.media/poster.jpg?t=private-token',{userAgent:'FixtureUA'});return data;}})});
  assert.equal(result.state,'ready');assert.equal(encrypted.source.url,'https://covers.arkhen.media/poster.jpg?t=private-token');
  const artwork=f.calls.find(row=>row[0]==='artworks')[1][0];assert.match(artwork.ref,/^[a-f0-9]{64}$/);assert.equal(artwork.provider_key,provider);
  assert.equal(artwork.expires_at,f.source.expiresAt,'Tokenized artwork cannot outlive the validated source capability.');
  const staged=f.calls.find(row=>row[0]==='checkpoint')[1].payload;assert.equal(staged.items[0].poster,'/api/shared-image/'+artwork.ref);
  assert.doesNotMatch(JSON.stringify(f.calls),/private-token|covers\.arkhen\.media|FixtureUA/);
});

test('artwork without authentication parameters can be mirrored lazily throughout the catalog lifetime',async()=>{
  const f=fixture();await runCloudCollector({...f.options,maxSteps:1,createSource:({mapImage})=>({catalogStep:async()=>{const data=page('10',null,true);data.items[0].poster=await mapImage('https://covers.arkhen.media/public-poster.jpg');return data;}})});
  const artwork=f.calls.find(row=>row[0]==='artworks')[1][0];assert.equal(Date.parse(artwork.expires_at),timestamp+86400000);
});

test('tokenized artwork follows the validated metadata lease with a two-hour upper bound',async()=>{
  const f=fixture();f.source.expiresAt=new Date(timestamp+7200000).toISOString();f.store.source=async()=>({expires_at:f.source.expiresAt});
  await runCloudCollector({...f.options,maxSteps:1,createSource:({mapImage})=>({catalogStep:async()=>{const data=page('10',null,true);data.items[0].poster=await mapImage('https://covers.arkhen.media/private-poster.jpg?t=private-token');return data;}})});
  const artwork=f.calls.find(row=>row[0]==='artworks')[1][0];assert.equal(Date.parse(artwork.expires_at),timestamp+7200000);
});

test('expired sources, stalled cursors and private image origins produce sanitized failures without publication',async()=>{
  for(const mode of ['expired','stalled','private']){
    const f=fixture();if(mode==='expired')f.source.expiresAt=new Date(timestamp-1).toISOString();
    const result=await runCloudCollector({...f.options,createSource:({mapImage})=>({catalogStep:async()=>{if(mode==='private')await mapImage('http://127.0.0.1/secret');return page('10',{categoryIndex:0,page:1});}})});
    assert.equal(result.state,'failed');assert.equal(f.calls.some(row=>row[0]==='publish'),false);assert.equal(f.calls.at(-1)[1],false);assert.doesNotMatch(JSON.stringify(result),/127\.0\.0\.1|secret|private-token/);
  }
});

test('EPG publication respects bounded batches and persists completed channels before yielding',async()=>{
  const f=fixture('epg');f.job.payload={};const channels=Array.from({length:230},(_,id)=>({channel_id:String(id),payload:{list:[]}}));
  const createSource=()=>({epg:async()=>({channels})});
  const first=await runCloudCollector({...f.options,createSource,maxSteps:1});assert.equal(first.state,'checkpointed');assert.equal(f.state.epgDone.length,100);
  const second=await runCloudCollector({...f.options,createSource,maxSteps:2});assert.equal(second.state,'ready');
  const batches=f.calls.filter(row=>row[0]==='rpc').map(row=>row[2].p_channels);assert.deepEqual(batches.map(row=>row.length),[100,100,30]);
  assert.equal(new Set(batches.flat().map(row=>row.channel_id)).size,230);
});

test('game logos publish local sports-image routes with encrypted shared origins',async()=>{
  const f=fixture('games');await runCloudCollector({...f.options,createSource:({mapImage})=>({games:async()=>({available:true,date:'2026-10-15',timeZone:'UTC',games:[{id:'1',league:{name:'Liga',logo:await mapImage('https://covers.arkhen.media/league.png',{kind:'sports-logo'})}}]})})});
  const data=f.calls.find(row=>row[0]==='rpc'&&row[1]==='arkhen_publish_games')[2].p_payload;assert.match(data.games[0].league.logo,/^\/api\/sports-image\/[a-f0-9]{64}$/);
  assert.equal(data.games[0].league.logo.split('/').at(-1),f.calls.find(row=>row[0]==='artworks')[1][0].ref);assert.doesNotMatch(JSON.stringify(f.calls),/covers\.arkhen\.media/);
});

test('collector entrypoint denies browsers, unsigned requests and caller-selected options before database access',async()=>{
  let calls=0;const handler=createCollectorHandler({environment:name=>({ARKHEN_COLLECTOR_SECRET:secret,ARKHEN_SOURCE_ENCRYPTION_KEY:'fixture-key'})[name],store:{},pipeline:async()=>{calls++;return {state:'idle'};}});
  const request=(headers={},body='{}',method='POST')=>handler(new Request('https://function.arkhen.media',{method,headers,...(method==='POST'?{body}:{})}));
  assert.equal((await request()).status,401);assert.equal((await request({'x-arkhen-collector-secret':secret,Origin:'https://browser.arkhen.media'})).status,403);
  assert.equal((await request({'x-arkhen-collector-secret':secret},'{"host":"http://127.0.0.1"}')).status,400);
  assert.equal((await request({'x-arkhen-collector-secret':secret},'x'.repeat(1025))).status,413);
  assert.equal((await request({'x-arkhen-collector-secret':secret})).status,200);assert.equal(calls,1);
});

test('Edge continuation wakes only after cooldown and uses the service-only fixed kick RPC',async()=>{
  const calls=[],pending=[];const handler=createCollectorHandler({environment:name=>({ARKHEN_COLLECTOR_SECRET:secret,ARKHEN_SOURCE_ENCRYPTION_KEY:'fixture-key'})[name],store:{rpc:async(...args)=>calls.push(args)},pipeline:async()=>({state:'checkpointed'}),waitUntil:value=>pending.push(value),delay:async ms=>calls.push(['delay',ms])});
  const result=await handler(new Request('https://function.arkhen.media',{method:'POST',headers:{'x-arkhen-collector-secret':secret},body:'{}'}));
  assert.equal(result.status,200);await Promise.all(pending);assert.deepEqual(calls,[['delay',11000],['arkhen_kick_cloud_collector',{}]]);
});

test('the Edge pipeline is registered as background work before an HTTP response can finish', {timeout:2000},async()=>{
  let finishPipeline,registered;const registration=new Promise(resolve=>{registered=resolve;});
  const handler=createCollectorHandler({environment:name=>({ARKHEN_COLLECTOR_SECRET:secret,ARKHEN_SOURCE_ENCRYPTION_KEY:'fixture-key'})[name],store:{},pipeline:()=>new Promise(resolve=>{finishPipeline=resolve;}),waitUntil:promise=>registered({promise})});
  const response=handler(new Request('https://function.arkhen.media',{method:'POST',headers:{'x-arkhen-collector-secret':secret},body:'{}'}));
  const background=await registration;assert.equal(typeof finishPipeline,'function');finishPipeline({state:'idle'});
  await background.promise;assert.equal((await response).status,200);
});

test('collector store confines destinations and uses modern secret keys only in apikey',async()=>{
  const calls=[],store=new CollectorStore({key:'sb_secret_fixture',fetch:async(url,options)=>{calls.push({url,options});return new Response(null,{status:204});}});
  await store.claim('worker');assert.match(calls[0].url,/^https:\/\/wnicimkmzswksaqdtgdv\.supabase\.co\/rest\/v1\/rpc\/arkhen_claim_cloud_cache_jobs$/);
  assert.equal(calls[0].options.headers.apikey,'sb_secret_fixture');assert.equal(calls[0].options.headers.Authorization,undefined);assert.equal(calls[0].options.redirect,'error');
  await assert.rejects(store.rpc('../sql',{}),{code:'COLLECTOR_RPC_INVALID'});
  const legacy=new CollectorStore({key:'ey.fixture.signature',fetch:async(url,options)=>{assert.equal(options.headers.Authorization,'Bearer ey.fixture.signature');return new Response(null,{status:204});}});await legacy.claim('worker');
});

test('database failures preserve only a bounded SQLSTATE and never expose raw metadata or credentials',async()=>{
  const store=new CollectorStore({key:'sb_secret_fixture',fetch:async()=>Response.json({code:'57014',message:'password=private-password raw metadata'},{status:500})});
  await assert.rejects(store.claim('worker'),error=>error.code==='COLLECTOR_DATABASE_SQL_57014'&&!/private-password|metadata/.test(String(error)));
  const invalid=new CollectorStore({key:'sb_secret_fixture',fetch:async()=>Response.json({code:'secret-value',message:'private-password'},{status:500})});
  await assert.rejects(invalid.claim('worker'),{code:'COLLECTOR_DATABASE_HTTP_500'});
});

test('numeric DOMException codes cannot mask database cancellation or leak messages',async()=>{
  const store=new CollectorStore({key:'sb_secret_fixture',fetch:async(url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('private-password','AbortError'))))});
  await assert.rejects(store.rpc('arkhen_claim_cloud_cache_jobs',{}, {timeoutMs:5}),error=>error.code==='COLLECTOR_DATABASE_TIMEOUT'&&!String(error).includes('private-password'));
  const unavailable=new CollectorStore({key:'sb_secret_fixture',fetch:async()=>{throw Object.assign(new Error('private-token'),{code:20});}});
  await assert.rejects(unavailable.claim('worker'),{code:'COLLECTOR_DATABASE_UNAVAILABLE'});
});

test('unexpected runtime failures report only a fixed operation phase',async()=>{
  const f=fixture();f.state={typeReady:'movies'};f.store.publish=async()=>{throw new TypeError('password=private-secret');};
  const result=await runCloudCollector({...f.options,createSource:()=>({catalogStep:()=>assert.fail('Provider collection already completed.')}),maxSteps:1});
  assert.equal(result.code,'COLLECTOR_PUBLISH_FAILED');assert.doesNotMatch(JSON.stringify(result),/password|private-secret|TypeError/);
});
