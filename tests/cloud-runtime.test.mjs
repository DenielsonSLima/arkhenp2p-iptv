import test from 'node:test';
import assert from 'node:assert/strict';
import {CloudRuntime} from '../lib/cloud-runtime.mjs';

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
  await f.runtime.attach(f.state,f.session,f.client);assert.deepEqual(calls,['live','movies','series']);
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
  f.cloud.request=async()=>[{expires_at:'2000-01-01T00:00:00Z',is_complete:true,payload:{categories:[],items:[],list:[],games:[]}}];
  assert.equal(await f.runtime.epg(f.state,'1'),null);assert.equal(await f.runtime.games(f.state,{date:'2026-10-15',timeZone:'UTC'}),null);
  assert.deepEqual((await f.runtime.catalog(f.state,'movies')).items,[]);await Promise.resolve();
  assert.equal(f.calls.some(call=>call[0]==='rpc'&&call[1]==='arkhen_request_cache_refresh'),true);
});

test('a committed catalog event can bypass the short read cache without scheduling another provider collection',async()=>{
  const f=fixture();await f.runtime.attach(f.state,f.session,f.client);
  let revision='old',reads=0;
  f.cloud.request=async()=>{reads++;return [{expires_at:'2070-01-01T00:00:00Z',is_complete:true,payload:{categories:[],items:[{id:revision}]}}];};
  assert.equal((await f.runtime.catalog(f.state,'movies')).items[0].id,'old');
  revision='new';
  assert.equal((await f.runtime.catalog(f.state,'movies')).items[0].id,'old');
  assert.equal((await f.runtime.catalog(f.state,'movies',{fresh:true})).items[0].id,'new');
  assert.equal((await f.runtime.catalog(f.state,'movies')).items[0].id,'new');
  assert.equal(reads,2);assert.equal(f.calls.some(call=>call[0]==='rpc'),false);f.runtime.close();
});
