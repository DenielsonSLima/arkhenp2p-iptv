import test from 'node:test';
import assert from 'node:assert/strict';
import {CloudRuntime} from '../lib/cloud-runtime.mjs';
import {catalogReadFixture} from './helpers/catalog-read-fixture.mjs';

const providerKey='a'.repeat(64),scopeHash='b'.repeat(64),libraryId='c'.repeat(64),userId='d243589c-25c5-4db0-b9aa-c087ace3d180';
const config={url:'https://wnicimkmzswksaqdtgdv.supabase.co',publishableKey:'sb_publishable_fixture_1234567890'};
function fixture(){
  const calls=[],client={libraryProvider:'wplay',authenticatedAt:Date.now(),session:{connected:true,account:{status:'Active'}},images:new Map([['one','https://images.example/poster.jpg?t=first-private-token']]),upstreamHeaders:()=>({'User-Agent':'fixture'})};
  const session={connected:true,account:{libraryId,status:'Active'}},state={client,authGeneration:1};
  const worker={registerSource:value=>calls.push(['register',value]),start:()=>calls.push(['start']),tick:async()=>calls.push(['tick']),unregisterSource:value=>calls.push(['unregister',value]),stop:()=>calls.push(['stop'])};
  const cloud={ready:Promise.resolve(true),enabled:true,publicConfig:()=>config,bootstrap:async()=>({...config,userId,providerKey,scopeHash,session:{access_token:'access-fixture',refresh_token:'refresh-fixture',expires_in:3600}}),revoke:async token=>calls.push(['revoke',token]),request:async()=>[{is_complete:true,payload:{categories:[],items:[]}}],rpc:async(name,args)=>calls.push(['rpc',name,args])};
  const runtime=new CloudRuntime({cloud,worker});return {runtime,cloud,worker,state,session,client,calls};
}
test('cloud attachment adds the frontend account contract, registers RAM metadata source and reuses a healthy session',async()=>{
  const f=fixture();await f.runtime.attach(f.state,f.session,f.client);assert.equal(f.state.cloud.provider,'wplay');assert.equal(f.state.cloud.libraryId,libraryId);assert.equal(f.state.cloud.userId,userId);
  await f.runtime.attach(f.state,f.session,f.client);assert.equal(f.calls.filter(call=>call[0]==='register').length,1);assert.deepEqual(f.runtime.fields(f.state).cloudStatus,{state:'ready'});
  f.runtime.detach(f.state);await Promise.resolve();assert.equal(f.state.cloud,null);assert.equal(f.calls.filter(call=>call[0]==='revoke').length,1);
});

test('a cloud-collected provider wakes the cloud queue after bootstrap and never starts a local collector',async()=>{
  const f=fixture();f.client.cloudCollection=true;f.cloud.kickCollector=async()=>f.calls.push(['kick']);
  await f.runtime.attach(f.state,f.session,f.client);await Promise.resolve();
  assert.equal(f.state.cloudStatus.state,'ready');assert.equal(f.calls.some(row=>['register','start','tick'].includes(row[0])),false);assert.equal(f.calls.filter(row=>row[0]==='kick').length,1);
  await f.runtime.refresh(f.state,'catalog',{media_type:'movies'});await Promise.resolve();assert.equal(f.calls.filter(row=>row[0]==='kick').length,2);assert.equal(f.calls.some(row=>row[0]==='tick'),false);
  f.cloud.artwork=async args=>{f.calls.push(['artwork',args]);return config.url+'/storage/v1/object/public/fixture';};
  assert.match(await f.runtime.cloudArtwork(f.state,'d'.repeat(64)),/storage/);await f.runtime.cloudArtwork(f.state,'d'.repeat(64));assert.equal(f.calls.filter(row=>row[0]==='artwork').length,1);
  f.runtime.close();
});

test('a verified lazy artwork source replaces a cached miss and concurrent mirror writes share one request',async()=>{
  const f=fixture();await f.runtime.attach(f.state,f.session,f.client);let release;const gate=new Promise(resolve=>{release=resolve;}),calls=[],ref='d'.repeat(64),url=config.url+'/storage/v1/object/public/fixture';
  f.cloud.artwork=async args=>{calls.push(args);if(!args.source)return null;await gate;return url;};
  assert.equal(await f.runtime.cloudArtwork(f.state,ref),null);
  const source={url:'https://covers.arkhen.media/poster.jpg?t=private',userAgent:'FixtureAndroid'};
  const first=f.runtime.cloudArtwork(f.state,ref,{source}),second=f.runtime.cloudArtwork(f.state,ref,{source});assert.equal(calls.length,2);release();
  assert.deepEqual(await Promise.all([first,second]),[url,url]);assert.deepEqual(calls[1],{providerKey,scopeHash,ref,source});
  assert.equal(await f.runtime.cloudArtwork(f.state,ref),url);assert.equal(calls.length,2);assert.doesNotMatch(JSON.stringify(f.runtime.fields(f.state)),/covers\.arkhen\.media|FixtureAndroid|\?t=private/);f.runtime.close();
});

test('an authenticated bootstrap recovery coalesces calls, rate-limits minting and preserves other Auth sessions',async()=>{
  const f=fixture();let clock=Date.now(),count=0,release;const original=f.cloud.bootstrap;
  f.runtime.now=()=>clock;f.cloud.bootstrap=async args=>{count++;return {...await original(args),session:{access_token:'fresh-'+count,refresh_token:'refresh-'+count,expires_in:3600}};};
  await f.runtime.attach(f.state,f.session,f.client);assert.equal(count,1);
  const gate=new Promise(resolve=>{release=resolve;}),mint=f.cloud.bootstrap;f.cloud.bootstrap=async args=>{await gate;return mint(args);};
  const first=f.runtime.recoverSession(f.state,f.session,f.client),second=f.runtime.recoverSession(f.state,f.session,f.client);release();
  const values=await Promise.all([first,second]);assert.equal(count,2);assert.equal(values[0].session.access_token,'fresh-2');assert.equal(values[1].session.access_token,'fresh-2');
  await f.runtime.recoverSession(f.state,f.session,f.client);assert.equal(count,2);assert.equal(f.calls.some(row=>row[0]==='revoke'),false);
  clock+=30001;await f.runtime.recoverSession(f.state,f.session,f.client);assert.equal(count,3);assert.equal(f.state.cloud.session.access_token,'fresh-3');
  f.session.account.status='Disabled';assert.equal(await f.runtime.recoverSession(f.state,f.session,f.client),null);assert.equal(count,3);assert.equal(f.state.cloud,null);assert.equal(f.calls.some(row=>row[0]==='rpc'&&row[1]==='arkhen_validate_account'&&row[2].p_status==='disabled'),true,'The recovery rate-limit cache cannot override a new provider denial.');
  f.state.authGeneration++;assert.equal(await f.runtime.recoverSession(f.state,f.session,f.client,f.state.authGeneration-1),null);assert.equal(count,3);f.runtime.close();
});

test('cumulative fallback pages are coalesced only while in flight and cannot retain every catalog revision',async()=>{
  const f=fixture();await f.runtime.attach(f.state,f.session,f.client);let release,calls=0;const gate=new Promise(resolve=>{release=resolve;});
  const load=async()=>{calls++;await gate;return {categories:[],items:[]};};
  const first=f.runtime.fallback(f.state,'catalog',['movies','1',1],load),same=f.runtime.fallback(f.state,'catalog',['movies','1',1],load);release();await Promise.all([first,same]);assert.equal(calls,1);assert.equal(f.runtime.fallbacks.size,0);
  const items=[];for(let page=1;page<=100;page++){
    for(let index=0;index<25;index++)items.push({id:String(items.length),name:'Fixture film',kind:'movie',poster:'',backdrop:'',plot:'x'.repeat(300)});
    const data=await f.runtime.fallback(f.state,'catalog',['movies','1',page],async()=>({categories:[],items}));assert.equal(data.items.length,page*25);assert.equal(f.runtime.fallbacks.size,0,'Completed cumulative pages must be collectible after their HTTP response.');
  }f.runtime.close();
});

test('shared reads and small fallback entries evict expired results and respect bounded caches',async()=>{
  const f=fixture();await f.runtime.attach(f.state,f.session,f.client);let clock=Date.now();f.runtime.now=()=>clock;f.runtime.maxReadEntries=8;f.runtime.maxFallbackEntries=4;f.cloud.request=async()=>[];
  for(let index=0;index<30;index++)await f.runtime.parentalCatalogItem(f.state,'movie',String(index));assert.equal(f.runtime.reads.size,8);
  clock+=6000;await f.runtime.parentalCatalogItem(f.state,'movie','30');assert.equal(f.runtime.reads.size,1);
  for(let index=0;index<30;index++)await f.runtime.fallback(f.state,'epg',[String(index)],async()=>({list:[]}));assert.equal(f.runtime.fallbacks.size,4);
  clock+=31000;await f.runtime.fallback(f.state,'epg',['fresh'],async()=>({list:[]}));assert.equal(f.runtime.fallbacks.size,1);f.runtime.close();
});

test('a running provider session attaches after cloud configuration becomes available',async()=>{
  const f=fixture();f.cloud.enabled=false;f.cloud.ready=Promise.resolve(false);
  let configured=false;f.cloud.refreshConfiguration=async()=>{f.cloud.enabled=configured;return configured;};
  await f.runtime.attach(f.state,f.session,f.client);
  assert.deepEqual(f.runtime.fields(f.state).cloudStatus,{state:'disabled',code:'CLOUD_NOT_CONFIGURED'});
  assert.equal(f.calls.some(call=>call[0]==='register'),false);
  configured=true;await f.runtime.attach(f.state,f.session,f.client);
  assert.equal(f.state.cloud.userId,userId);assert.equal(f.state.cloud.libraryId,libraryId);
  assert.equal(f.state.client,f.client);assert.equal(f.state.authGeneration,1);assert.deepEqual(f.runtime.fields(f.state).cloudStatus,{state:'ready'});
});

test('repaired configuration clears its previous failure without replacing provider authentication',async()=>{
  const f=fixture();f.cloud.enabled=false;f.cloud.ready=Promise.reject(Object.assign(new Error('private config contents'),{code:'CLOUD_CONFIG_INVALID'}));
  const runtime=new CloudRuntime({cloud:f.cloud,worker:f.worker});
  await runtime.attach(f.state,f.session,f.client);
  assert.equal(runtime.fields(f.state).cloudStatus.code,'CLOUD_CONFIG_INVALID');
  f.cloud.refreshConfiguration=async()=>{f.cloud.enabled=true;return true;};
  await runtime.attach(f.state,f.session,f.client);
  assert.equal(runtime.configurationError,null);assert.equal(f.state.cloud.userId,userId);assert.equal(f.state.client,f.client);
});
test('a cancelled bootstrap revokes its late token without registering a source or restoring logged-out state',async()=>{
  const f=fixture();let release;f.cloud.bootstrap=()=>new Promise(resolve=>{release=resolve;});const pending=f.runtime.attach(f.state,f.session,f.client);await f.runtime.ready;await Promise.resolve();
  f.state.authGeneration++;f.runtime.detach(f.state);f.state.client=null;release({...config,userId,providerKey,scopeHash,session:{access_token:'late-access'}});await pending;await Promise.resolve();
  assert.equal(f.state.cloud,null);assert.equal(f.calls.some(call=>call[0]==='register'),false);assert.equal(f.calls.some(call=>call[0]==='revoke'&&call[1]==='late-access'),true);
});
test('image binding is global, opaque, scoped and stable across changing query credentials',async()=>{
  const f=fixture();await f.runtime.attach(f.state,f.session,f.client);
  const first=f.runtime.registerImage('/api/image?ref=one',{client:f.client,providerKey,scopeHash});assert.match(first,/^\/api\/shared-image\/[a-f0-9]{64}$/);assert.doesNotMatch(first,/private|images\.example/);
  f.client.images.set('two','https://images.example/poster.jpg?t=second-private-token');const second=f.runtime.registerImage('/api/image?ref=two',{client:f.client,providerKey,scopeHash});assert.equal(first,second);
  const ref=first.split('/').at(-1);assert.match(f.runtime.imageSource(f.state,ref).source,/second-private-token/);
  assert.equal(f.runtime.imageSource({cloud:{providerKey:'d'.repeat(64),scopeHash},client:f.client},ref),null);
  f.runtime.images.clear();assert.ok(f.runtime.imageSource(f.state,ref),'Current registered image refs can hydrate old stable keys after a restart.');
});
test('cloud errors preserve connected local behavior and cache misses remain explicit',async()=>{
  const f=fixture();f.cloud.bootstrap=async()=>{throw Object.assign(new Error('private secret upstream'),{code:'CLOUD_REQUEST_FAILED'});};
  assert.equal(await f.runtime.attach(f.state,f.session,f.client),null);assert.deepEqual(f.runtime.fields(f.state).cloudStatus,{state:'unavailable',code:'CLOUD_REQUEST_FAILED'});assert.equal(await f.runtime.catalog(f.state,'movies'),null);
  assert.doesNotMatch(JSON.stringify(f.runtime.fields(f.state)),/private|secret/);
});

test('cached cloud sessions are revoked and RLS status updated when the provider account becomes disabled or expired',async()=>{
  for(const change of [{status:'Disabled'},{expiresAt:'2000-01-01T00:00:00Z'}]){
    const f=fixture();await f.runtime.attach(f.state,f.session,f.client);Object.assign(f.session.account,change);
    assert.equal(await f.runtime.attach(f.state,f.session,f.client),null);assert.equal(f.state.cloud,null);
    assert.equal(f.calls.some(call=>call[0]==='unregister'),true);assert.equal(f.calls.some(call=>call[0]==='revoke'),true);
    const update=f.calls.find(call=>call[0]==='rpc'&&call[1]==='arkhen_validate_account');
    assert.equal(update[2].p_status,change.status?'disabled':'expired');assert.equal(update[2].p_user_id,userId);
    assert.equal(f.runtime.fields(f.state).cloudStatus.code,'CLOUD_PROVIDER_VALIDATION_REQUIRED');
  }
});

test('new provider validation and access expiry update RLS without creating another cloud session',async()=>{
  const f=fixture();let bootstraps=0;const bootstrap=f.cloud.bootstrap;f.cloud.bootstrap=async value=>{bootstraps++;return bootstrap(value);};
  await f.runtime.attach(f.state,f.session,f.client);f.client.authenticatedAt+=1;f.session.account.expiresAt='2070-01-01T00:00:00Z';
  await f.runtime.attach(f.state,f.session,f.client);assert.equal(bootstraps,1);assert.equal(f.state.cloud.session.access_token,'access-fixture');
  const update=f.calls.find(call=>call[0]==='rpc'&&call[1]==='arkhen_validate_account');assert.equal(update[2].p_status,'active');assert.equal(update[2].p_expires_at,'2070-01-01T00:00:00Z');
  f.client.authenticatedAt=Date.now()-86400001;assert.equal(await f.runtime.attach(f.state,f.session,f.client),null);
  assert.equal(f.calls.filter(call=>call[0]==='rpc'&&call[1]==='arkhen_validate_account').length,1,'Old local proof alone cannot disable an account used on another device.');
});

test('cold image registry hydrates once per provider scope and resolves a cover before remaining catalog pages finish',async()=>{
  const f=fixture(),context={client:f.client,providerKey,scopeHash};
  const stable=f.runtime.registerImage('/api/image?ref=one',context),ref=stable.split('/').at(-1);f.runtime.images.clear();f.client.images.clear();
  let releaseMovies,releaseSeries;const movies=new Promise(resolve=>{releaseMovies=resolve;}),series=new Promise(resolve=>{releaseSeries=resolve;});
  const calls=[];let invalidations=0;
  f.client.invalidateCatalog=()=>{invalidations++;};
  f.client.catalog=async type=>{calls.push(type);if(type==='live')return {categories:[],items:[]};return type==='movies'?movies:series;};
  f.worker.sources=new Map();f.worker.sourceActive=()=>true;f.worker.registerSource=source=>f.worker.sources.set(source.client,source);f.worker.unregisterSource=client=>f.worker.sources.delete(client);
  await f.runtime.attach(f.state,f.session,f.client);assert.deepEqual(calls,[]);
  void f.runtime.warmImages(f.worker.sources.get(f.client));assert.deepEqual(calls,['live','movies','series']);
  const other={...f.client,catalog:()=>assert.fail('Another user cannot create a second image catalog warmup.')};
  const otherSource={session:f.session,client:other,provider:'wplay',providerKey,scopeHash};f.worker.registerSource(otherSource);void f.runtime.warmImages(otherSource);
  const pending=f.runtime.ensureImageSource(f.state,ref,{waitMs:1000});
  f.client.images.set('new-session-ref','https://images.example/poster.jpg?t=new-login-private-token');
  releaseMovies({categories:[],items:[{poster:'/api/image?ref=new-session-ref'}]});
  const binding=await pending;assert.match(binding.source,/new-login-private-token/);assert.equal(f.runtime.imageWarmups.get(providerKey+':'+scopeHash).done,false);
  releaseSeries({categories:[],items:[]});await f.runtime.warmImages(otherSource);assert.equal(invalidations,0);assert.equal(calls.length,3);f.runtime.close();
});

test('expired guides and agendas fall back while a complete stale catalog stays visible and requests a refresh',async()=>{
  const f=fixture();await f.runtime.attach(f.state,f.session,f.client);
  const read=catalogReadFixture({expires_at:'2000-01-01T00:00:00Z'});
  f.cloud.request=async path=>/provider_(epg|games)_cache/.test(path)?[{expires_at:'2000-01-01T00:00:00Z',payload:{list:[],games:[]}}]:read(path);
  assert.equal(await f.runtime.epg(f.state,'1'),null);assert.equal(await f.runtime.games(f.state,{date:'2026-10-15',timeZone:'UTC'}),null);
  assert.deepEqual((await f.runtime.catalog(f.state,'movies')).items,[]);await Promise.resolve();
  assert.equal(f.calls.some(call=>call[0]==='rpc'&&call[1]==='arkhen_request_cache_refresh'),true);
});

test('a committed catalog event can bypass the short read cache without scheduling another provider collection',async()=>{
  const f=fixture();await f.runtime.attach(f.state,f.session,f.client);
  let revision='old',reads=0;
  f.cloud.request=async path=>{if(path.includes('/provider_catalog_cache?'))reads++;return catalogReadFixture({items:[{id:revision,kind:'movie'}]})(path);};
  assert.equal((await f.runtime.catalog(f.state,'movies')).items[0].id,'old');
  revision='new';
  assert.equal((await f.runtime.catalog(f.state,'movies')).items[0].id,'old');
  assert.equal((await f.runtime.catalog(f.state,'movies',{fresh:true})).items[0].id,'new');
  assert.equal((await f.runtime.catalog(f.state,'movies')).items[0].id,'new');
  assert.equal(reads,4);assert.equal(f.calls.some(call=>call[0]==='rpc'),false);f.runtime.close();
});

test('cloud catalog pages use the viewer JWT and share only the same partition and parental visibility',async()=>{
  const f=fixture();await f.runtime.attach(f.state,f.session,f.client);const requests=[];
  f.cloud.request=async(path,options)=>{requests.push({path,options});return {categories:[],items:[{id:String(requests.length)}],pagination:{source:'supabase',expiresAt:'2070-01-01T00:00:00Z'}};};
  const first=await f.runtime.catalogPage(f.state,'movies');assert.equal(first.items[0].id,'1');
  assert.equal((await f.runtime.catalogPage({...f.state},'movies')).items[0].id,'1');assert.equal(requests.length,1);
  assert.equal(requests[0].path,'/rest/v1/rpc/arkhen_catalog_page');assert.equal(requests[0].options.accessToken,'access-fixture');assert.equal(requests[0].options.publicKey,true);assert.equal(requests[0].options.body.p_limit,120);assert.equal(requests[0].options.body.p_after,-1);assert.equal(requests[0].options.body.p_include_adult,false);
  assert.equal((await f.runtime.catalogPage(f.state,'movies',{includeAdult:true})).items[0].id,'2');
  assert.equal((await f.runtime.catalogPage(f.state,'movies',{fresh:true})).items[0].id,'3');
  assert.equal(await f.runtime.catalogPage(f.state,'movies',{cursor:-2}),null);assert.equal(requests.length,3);
});

test('a failed complete refresh retains server data and original freshness but reports failure to the browser',async t=>{
  const f=fixture();t.after(()=>f.runtime.close());await f.runtime.attach(f.state,f.session,f.client);
  f.cloud.request=async path=>catalogReadFixture({items:[{id:'one',kind:'movie'}]})(path);
  const first=await f.runtime.catalog(f.state,'movies'),entry=[...f.runtime.reads.values()].find(value=>value.data===first),expires=entry.expiresAt;
  f.cloud.request=async()=>{throw new Error('database unavailable');};
  assert.equal(await f.runtime.catalog(f.state,'movies',{fresh:true}),null,'A failed read cannot look like a successful fresh fetch and extend browser TTL.');
  assert.equal(entry.expiresAt,expires);assert.equal(await f.runtime.catalog(f.state,'movies'),first);
});

test('another active viewer retries once when the owner of a shared catalog read logs out',async t=>{
  const f=fixture();t.after(()=>f.runtime.close());await f.runtime.attach(f.state,f.session,f.client);
  const other={...f.state,cloud:{...f.state.cloud,userId:'viewer-two',libraryId:'e'.repeat(64)}};let release,started,headers=0;
  const entered=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve),read=catalogReadFixture({items:[{id:'one',kind:'movie'}]});
  f.cloud.request=async path=>{if(path.includes('/provider_catalog_cache?')&&++headers===1){started();await gate;}return read(path);};
  const first=f.runtime.catalog(f.state,'movies');await entered;const second=f.runtime.catalog(other,'movies');f.state.cloud=null;f.state.authGeneration++;release();
  assert.equal(await first,null);assert.equal((await second).items.length,1);assert.equal(headers,3);
});

test('a complete unpaged read preserves the committed header revision without trusting payload pagination',async t=>{
  const f=fixture();t.after(()=>f.runtime.close());await f.runtime.attach(f.state,f.session,f.client);
  const payload={categories:[{id:'1',name:'Cinema'}],items:[{id:'42',kind:'movie',name:'Published film'}],pagination:{source:'preparing',revisionAt:'2000-01-01T00:00:00Z'}};
  const requests=[];
  f.cloud.request=async(path,options)=>{requests.push({path,options});return catalogReadFixture(payload)(path);};
  const catalog=await f.runtime.catalog(f.state,'movies');
  assert.equal(catalog.catalogComplete,true);assert.equal(catalog.preparing,false);assert.equal(catalog.pagination.mode,'complete');assert.equal(catalog.pagination.source,'supabase');
  assert.equal(catalog.pagination.snapshotId,userId);assert.equal(catalog.pagination.revisionAt,'2026-10-15T15:00:00.000Z');assert.equal(catalog.pagination.total,1);
  assert.equal(payload.pagination.source,'preparing','Header enrichment must not mutate stored metadata.');
  assert.equal(requests[0].options.accessToken,'access-fixture');assert.equal(requests[0].options.publicKey,true);
  const url=new URL(requests[0].path,config.url);assert.match(url.searchParams.get('select'),/snapshot_id,index_generation,updated_at,expires_at,item_count,safe_item_count/);assert.doesNotMatch(url.searchParams.get('select'),/payload/);assert.equal(url.searchParams.get('media_type'),'eq.movies');
});

test('cold artwork uses one global opaque lookup and one item detail without enumerating provider catalogs',async()=>{
  const f=fixture(),context={client:f.client,providerKey,scopeHash};
  const route=f.runtime.registerImage('/api/image?ref=one',context),ref=route.split('/').at(-1);f.runtime.images.clear();f.client.images.clear();
  let details=0,lookups=0;f.client.catalog=()=>assert.fail('Artwork cannot download a provider catalog.');
  f.cloud.request=async(path,options)=>{lookups++;assert.match(path,/catalog_artwork_refs/);assert.equal(options.accessToken,'access-fixture');return [{media_type:'movies',media_id:'42',field:'poster'}];};
  f.client.artworkMetadata=async(kind,id)=>{details++;assert.equal(kind,'movie');assert.equal(id,'42');f.client.images.set('fresh','https://images.example/poster.jpg?t=fresh-private-token');return {poster:'/api/image?ref=fresh'};};
  await f.runtime.attach(f.state,f.session,f.client);assert.equal(details,0);
  const [a,b]=await Promise.all([f.runtime.ensureImageSource(f.state,ref),f.runtime.ensureImageSource(f.state,ref)]);
  assert.match(a.source,/fresh-private-token/);assert.equal(a,b);assert.equal(details,1);assert.equal(lookups,1);f.runtime.close();
});

test('artwork details with a different canonical image cannot satisfy an opaque shared reference',async()=>{
  const f=fixture(),route=f.runtime.registerImage('/api/image?ref=one',{client:f.client,providerKey,scopeHash});f.runtime.images.clear();f.client.images.clear();
  f.cloud.request=async()=>[{media_type:'movies',media_id:'42',field:'poster'}];f.client.artworkMetadata=async()=>{f.client.images.set('other','https://images.example/other.jpg');return {poster:'/api/image?ref=other'};};
  await f.runtime.attach(f.state,f.session,f.client);assert.equal(await f.runtime.ensureImageSource(f.state,route.split('/').at(-1)),null);f.runtime.close();
});

test('parental lookup reads one indexed global title and its classification before a provider catalog is needed',async()=>{
  const f=fixture();await f.runtime.attach(f.state,f.session,f.client);let reads=0;
  f.client.catalog=()=>assert.fail('A cached title lookup cannot enumerate provider catalogs.');
  f.cloud.request=async(path,options)=>{reads++;assert.match(path,/catalog_media\?/);const params=new URL(path,'https://fixture.example').searchParams;assert.equal(params.get('media_id'),'eq.900');assert.equal(params.get('limit'),'1');assert.equal(options.accessToken,'access-fixture');return [{metadata:{id:'900',name:'Protected',kind:'movie'},is_adult:true}];};
  const result=await f.runtime.parentalCatalogItem(f.state,'movie','900');assert.equal(result.items[0].isAdult,true);assert.deepEqual(result.categories,[]);
  assert.equal((await f.runtime.parentalCatalogItem(f.state,'movie','900')).items[0].id,'900');assert.equal(reads,1);f.runtime.close();
});
