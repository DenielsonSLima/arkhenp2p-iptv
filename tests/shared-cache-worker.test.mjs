import test from 'node:test';
import assert from 'node:assert/strict';
import {SharedCacheWorker,sanitizeSharedCatalog,sanitizeSharedEPG,sanitizeSharedGames,completeSharedCatalog} from '../lib/shared-cache-worker.mjs';
import {cloudSourceScope} from '../lib/supabase-cloud.mjs';

const now=Date.parse('2026-10-15T12:00:00Z'),provider='wplay',scope=cloudSourceScope(provider,'https://auth.example');
const item=(id='1',kind='live')=>({id,name:'Título',kind,categoryId:'cat',poster:'/api/image?ref=private-per-login',backdrop:'https://private.example/?token=private',year:'2026',rating:7.5,genre:'Ação',sources:[{address:'private-stream'}],password:'private-password',token:'private-token'});
const catalog=(type='live')=>({categories:[{id:'cat',name:'Categoria',url:'https://private.example'}],items:[item('1',type==='movies'?'movie':type)]});
const epg=()=>({list:[{title:'Programa',description:'Descrição',start:'2026-10-15T12:00:00Z',end:'2026-10-15T13:00:00Z',playbackUrl:'https://private.example'}]});
const game=()=>({available:true,date:'2026-10-15',timeZone:'America/Maceio',games:[{id:'game',title:'Jogo',start:'2026-10-15T13:40:00Z',status:'1',homeTeam:{id:'a',name:'A',logo:'https://private.example/?token=private'},awayTeam:{id:'b',name:'B'},channels:[{id:'1',name:'Canal',address:'private-stream'}],token:'private-token'}]});

test('an explicitly disabled source cannot publish an empty shared catalog over another account snapshot',async()=>{
  for(const type of ['live','movies','series'])await assert.rejects(completeSharedCatalog({authInfo:{service:{enabledLive:false,enabledVoD:false}},catalog:()=>assert.fail('A disabled source cannot be collected.')},type),{code:'CACHE_SOURCE_CAPABILITY_UNAVAILABLE'});
});

test('a source moved to cloud collection cannot be registered or claimed by the local worker',async()=>{
  const f=fixture();f.client.cloudCollection=true;assert.equal(f.worker.sourceActive(f.source),false);assert.throws(()=>f.worker.registerSource(f.source),{code:'CACHE_SOURCE_MANAGED_IN_CLOUD'});
  const result=await f.worker.tick();assert.equal(result.idle,true);assert.equal(f.calls.some(row=>row.name==='arkhen_claim_cache_jobs'),false);
});
function fixture(type='catalog',{payload={},rpc,client:clientOverrides={}}={}){
  const calls=[],jobs=[{id:'d243589c-25c5-4db0-b9aa-c087ace3d180',provider_key:scope.providerKey,scope_hash:scope.scopeHash,job_type:type,payload,attempts:1}],timers=new Map();let timerId=0;
  const cloud={ready:Promise.resolve(true),enabled:true,async rpc(name,args){calls.push({name,args});const override=await rpc?.(name,args);if(override!==undefined)return override;if(name==='arkhen_claim_cache_jobs')return jobs.splice(0,1);if(name==='arkhen_renew_cache_job')return true;if(name==='arkhen_epg_snapshot_state')return {state:'missing'};if(name==='arkhen_epg_snapshot_stage')return {state:'sealed'};if(name==='arkhen_epg_snapshot_publish')return {state:'published'};return null;}};
  const client={config:{server:'https://auth.example',password:'private-provider-password'},session:{connected:true,account:{status:'Active',expiresAt:'2026-11-01T00:00:00Z'}},authenticatedAt:now,
    catalog:async type=>catalog(type),catalogPage:async()=>assert.fail('No paged catalog expected'),epg:async()=>epg(),games:async()=>game(),
    stopPlayback:()=>assert.fail('The worker must not interrupt user playback'),...clientOverrides};
  const worker=new SharedCacheWorker({cloud,now:()=>now,workerId:'fixture-worker',schedule:(run,delay)=>{timers.set(++timerId,{run,delay});return timerId;},cancel:id=>timers.delete(id)});
  const source={client,session:{connected:true,account:{provider}},provider,...scope};worker.registerSource(source);
  return {worker,cloud,client,calls,jobs,timers,source,published:name=>calls.filter(call=>call.name===name),finish:()=>calls.find(call=>call.name==='arkhen_finish_cache_job')};
}

test('shared catalog, EPG and games snapshots whitelist metadata and remove session-bound artwork and source secrets',()=>{
  const clean=sanitizeSharedCatalog(catalog(),{type:'live'});assert.equal(clean.items[0].poster,'');assert.equal(clean.items[0].backdrop,'');assert.equal(clean.items[0].genre,'Ação');
  assert.doesNotMatch(JSON.stringify(clean),/private|https:|sources|password|token|"url"/);
  const mapped=sanitizeSharedCatalog(catalog(),{type:'live',mapImage:()=>'/api/shared-image/'+ 'b'.repeat(64)});assert.match(mapped.items[0].poster,/^\/api\/shared-image\/[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(sanitizeSharedEPG(epg())),/private|playbackUrl/);
  const games=sanitizeSharedGames(game());assert.equal(games.games[0].homeTeam.logo,'');assert.equal(games.games[0].start,'2026-10-15T13:40:00.000Z');assert.doesNotMatch(JSON.stringify(games),/private|address|token/);
});

test('global game snapshots preserve only opaque persistent sports-logo routes',()=>{
  const source=game(),route='/api/sports-image/'+'a'.repeat(64);source.games[0].homeTeam.logo=route;
  source.games[0].awayTeam.logo='/api/sports-image/../../private';
  const result=sanitizeSharedGames(source,{mapImage:value=>value});assert.equal(result.games[0].homeTeam.logo,route);assert.equal(result.games[0].awayTeam.logo,'');
});

test('shared catalog keeps only valid explicit external identities and authoritative restriction flags',()=>{
  const source=catalog('movies');source.categories[0].isAdult=true;Object.assign(source.items[0],{imdb_id:'tt0944947',tmdb_id:'1399',isAdult:true});
  const clean=sanitizeSharedCatalog(source,{type:'movies'});assert.equal(clean.categories[0].isAdult,true);assert.equal(clean.items[0].isAdult,true);assert.equal(clean.items[0].imdbId,'tt0944947');assert.equal(clean.items[0].tmdbId,1399);
  Object.assign(source.items[0],{imdbId:'https://private.example/tt123456',tmdbId:0});const invalid=sanitizeSharedCatalog(source,{type:'movies'});assert.equal(invalid.items[0].imdbId,undefined);assert.equal(invalid.items[0].tmdbId,undefined);
});

test('complete catalog traversal loads every category to its terminal page before returning',async()=>{
  const calls=[];let next=1,hasMore=true;const snapshot=()=>({...catalog('movies'),pagination:{mode:'category',byCategory:{cat:{nextPage:next,hasMore}}}});
  const client={catalog:async()=>snapshot(),catalogPage:async(type,category,page)=>{calls.push({type,category,page});next++;if(page===3)hasMore=false;return snapshot();}};
  const data=await completeSharedCatalog(client,'movies');assert.deepEqual(calls.map(call=>call.page),[1,2,3]);assert.equal(data.pagination.byCategory.cat.hasMore,false);
  const stalled={catalog:async()=>snapshot(),catalogPage:async()=>snapshot()};hasMore=true;next=1;
  await assert.rejects(completeSharedCatalog(stalled,'movies'),{code:'CACHE_PAGINATION_STALLED'});
  await assert.rejects(completeSharedCatalog({catalog:async()=>({...catalog('movies'),pagination:{mode:'category',byCategory:{}}})},'movies'),{code:'CACHE_PAGINATION_INVALID'});
});

test('one global catalog job publishes complete snapshots with its owned lease, never one job per user',async()=>{
  const f=fixture();const [a,b]=await Promise.all([f.worker.tick(),f.worker.tick()]);assert.deepEqual(a,b);assert.equal(a.succeeded,true);
  assert.equal(f.published('arkhen_claim_cache_jobs').length,1);assert.equal(f.published('arkhen_publish_catalog').length,3);
  for(const {args}of f.published('arkhen_publish_catalog')){assert.equal(args.p_complete,true);assert.equal(args.p_worker,'fixture-worker');assert.equal(args.p_job_id,'d243589c-25c5-4db0-b9aa-c087ace3d180');assert.equal(args.p_expires_at,'2026-10-16T12:00:00.000Z');assert.doesNotMatch(JSON.stringify(args),/private|sources|password/);}
  assert.equal(f.finish().args.p_success,true);assert.equal(f.timers.size,0);
});

test('incomplete or failed catalog pagination never publishes or deactivates existing cached titles',async()=>{
  const f=fixture('catalog',{payload:{media_type:'movies'},client:{catalog:async()=>({...catalog('movies'),pagination:{mode:'category',byCategory:{cat:{nextPage:1,hasMore:true}}}}),catalogPage:async()=>{throw Object.assign(new Error('private upstream details'),{code:'WPLAY_INVALID_CATALOG'});}}});
  const result=await f.worker.tick();assert.equal(result.succeeded,false);assert.equal(f.published('arkhen_publish_catalog').length,0);assert.equal(f.finish().args.p_success,false);assert.equal(f.finish().args.p_error_code,'WPLAY_INVALID_CATALOG');assert.doesNotMatch(JSON.stringify(result),/private/);
});

test('lost leases and stopping during source work forbid publication without stopping the provider player',async()=>{
  const lost=fixture('catalog',{rpc:name=>name==='arkhen_renew_cache_job'?false:undefined});assert.equal((await lost.worker.tick()).errorCode,'CACHE_LEASE_LOST');assert.equal(lost.published('arkhen_publish_catalog').length,0);
  let release,started;const entered=new Promise(resolve=>{started=resolve;}),pending=new Promise(resolve=>{release=resolve;});
  const f=fixture('catalog',{client:{catalog:async()=>{started();return pending;}}});const run=f.worker.tick();await entered;f.worker.stop();release(catalog());
  const result=await run;assert.equal(result.errorCode,'CACHE_LEASE_LOST');assert.equal(f.published('arkhen_publish_catalog').length,0);assert.equal(f.timers.size,0);
});

test('stopping while a job claim is in flight cannot start a newly returned job',async()=>{
  let release,entered;const started=new Promise(resolve=>{entered=resolve;}),claim=new Promise(resolve=>{release=resolve;});
  const f=fixture('games',{rpc:name=>{if(name==='arkhen_claim_cache_jobs'){entered();return claim;}}});
  const run=f.worker.tick();await started;f.worker.stop();release(f.jobs.splice(0,1));assert.equal((await run).errorCode,'CACHE_LEASE_LOST');assert.equal(f.published('arkhen_publish_games').length,0);
});

test('unregistering an authenticated source during its request prevents publication without stopping playback',async()=>{
  let release,entered;const started=new Promise(resolve=>{entered=resolve;}),pending=new Promise(resolve=>{release=resolve;});
  const f=fixture('catalog',{client:{catalog:async()=>{entered();return pending;}}});const run=f.worker.tick();await started;
  f.worker.unregisterSource(f.client);release(catalog());assert.equal((await run).errorCode,'CACHE_SOURCE_UNAVAILABLE');assert.equal(f.published('arkhen_publish_catalog').length,0);
});

test('non-native EPG collection uses at most two lookups and seals one complete snapshot before atomic publication',async()=>{
  let active=0,max=0,lookups=0;
  const f=fixture('epg',{client:{catalog:async()=>({categories:[],items:[1,2,3,4].map(id=>({id:String(id)}))}),epg:async()=>{active++;max=Math.max(max,active);lookups++;await new Promise(resolve=>setImmediate(resolve));active--;return epg();}}});
  const result=await f.worker.tick();assert.equal(result.succeeded,true);assert.equal(max,2);assert.equal(lookups,4);
  const staged=f.published('arkhen_epg_snapshot_stage');assert.equal(staged.length,1);assert.equal(staged[0].args.p_channels.length,4);assert.equal(staged[0].args.p_fetched_at,new Date(now).toISOString());assert.match(staged[0].args.p_content_hash,/^[a-f0-9]{64}$/);assert.equal(f.published('arkhen_epg_snapshot_publish').length,1);assert.equal(f.published('arkhen_publish_epg_batch').length,0);
});

test('an EPG lookup failure preserves the previous global guide instead of publishing an incomplete batch',async()=>{
  const f=fixture('epg',{client:{epg:async()=>{throw new Error('private-url-token');}}});const result=await f.worker.tick();assert.equal(result.succeeded,false);assert.equal(f.published('arkhen_epg_snapshot_stage').length,0);assert.equal(f.published('arkhen_epg_snapshot_publish').length,0);assert.equal(f.finish().args.p_error_code,'CACHE_REFRESH_FAILED');
});

test('games publish sanitized global metadata for sixty seconds and unavailable source clients claim no jobs',async()=>{
  const f=fixture('games');assert.equal((await f.worker.tick()).succeeded,true);const published=f.published('arkhen_publish_games')[0].args;
  assert.equal(published.p_game_date,'2026-10-15');assert.equal(published.p_time_zone,'America/Maceio');assert.equal(published.p_expires_at,'2026-10-15T12:01:00.000Z');assert.doesNotMatch(JSON.stringify(published),/private|token|address/);
  const expired=fixture('games');expired.client.session.account.status='Expired';assert.equal((await expired.worker.tick()).reason,'no-active-source');assert.equal(expired.calls.length,0);
});

test('start is idempotent, stop cancels local timers and unregister never closes a shared client',()=>{
  const f=fixture();f.worker.start();f.worker.start();assert.equal(f.timers.size,1);f.worker.stop();assert.equal(f.timers.size,0);f.worker.unregisterSource(f.client);assert.equal(f.worker.sources.size,0);
});


test('a sealed EPG candidate resumes publication without recapturing provider metadata',async()=>{
 const f=fixture('epg',{rpc:async name=>name==='arkhen_epg_snapshot_state'?{state:'sealed'}:undefined,client:{catalog:()=>assert.fail('A sealed capture is reused.'),epg:()=>assert.fail('No per-channel recapture.')}});
 assert.equal((await f.worker.tick()).succeeded,true);assert.equal(f.published('arkhen_epg_snapshot_stage').length,0);assert.equal(f.published('arkhen_epg_snapshot_publish').length,1);
});

test('an unsealed or rejected EPG candidate is never published as a completed guide',async()=>{
 const f=fixture('epg',{rpc:async name=>name==='arkhen_epg_snapshot_stage'?{state:'invalid'}:undefined});
 assert.equal((await f.worker.tick()).errorCode,'CACHE_EPG_PUBLICATION_INCOMPLETE');assert.equal(f.published('arkhen_epg_snapshot_publish').length,0);assert.equal(f.finish().args.p_success,false);
});
