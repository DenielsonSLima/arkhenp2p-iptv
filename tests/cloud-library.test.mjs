import test from 'node:test';
import assert from 'node:assert/strict';
import {QueryClient} from '@tanstack/query-core';
import {CloudLibrary} from '../web/cloud-library.js';
import {cloudBootstrap} from '../web/cloud-library-records.js';

const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const NOW=Date.parse('2026-10-15T04:00:00Z');
const bootstrap=(userId=A,extra={})=>({url:'https://fixture.supabase.co',publishableKey:'sb_publishable_fixture_public_only',session:{access_token:`access-${userId}`,refresh_token:`refresh-${userId}`},userId,provider:'wplay',providerKey:'provider-fixture',scopeHash:'entitlement-fixture',libraryId:`library-${userId}`,...extra});
const item=(id='1',extra={})=>({id,kind:'movie',name:`Filme ${id}`,poster:'/api/image?ref=old-session',...extra});
const row=(value,extra={})=>({user_id:A,provider:'wplay',item_key:`${value.kind}:${value.id}`,item:value,deleted_at:null,updated_at:new Date(NOW).toISOString(),...extra});
const progress=(id='1',episode=null)=>({item:item(id,episode?{kind:'series'}:{}),episode,time:60,duration:120,updated:NOW});
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function clock(){let now=NOW,serial=0;const jobs=new Map();return {now:()=>now,schedule:(fn,delay)=>{const id=++serial;jobs.set(id,{fn,at:now+delay});return id;},cancel:id=>jobs.delete(id),jobs,
  async advance(ms){const end=now+ms;for(;;){const next=[...jobs].filter(([,job])=>job.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;jobs.delete(next[0]);now=next[1].at;next[1].fn();await flush();}now=end;await flush();}};}
const identity=(table,value)=>table==='user_favorites'?value.item_key:table==='user_progress'?JSON.stringify([value.item_key,value.episode_id]):table==='user_preferences'?value.key:value.id;
function transport(){
  const tables=new Map(),calls=[],channels=[],clients=[],writes=[];let interceptWrite=null;
  const data=table=>{if(!tables.has(table))tables.set(table,[]);return tables.get(table);};
  const createClient=(url,key,options)=>{
    const userId=options.auth.storageKey.endsWith(B)?B:A,events={};
    const client={url,key,options,userId,events,
      auth:{
        async getSession(){return {data:{session:null},error:null};},
        async setSession(session){calls.push({operation:'setSession',userId});return {data:{session:{...session,user:{id:userId}}},error:null};},
        async getUser(){calls.push({operation:'getUser',userId});return {data:{user:{id:userId}},error:null};},
        onAuthStateChange(callback){events.auth=callback;return {data:{subscription:{unsubscribe(){events.auth=null;}}}};},
        async signOut(options){calls.push({operation:'signOut',userId,options});return {error:null};}
      },
      channel(name){const channel={name,listeners:[],on(event,filter,callback){this.listeners.push({event,filter,callback});return this;},subscribe(callback){this.status=callback;return this;}};channels.push(channel);return channel;},
      async removeChannel(channel){channel.removed=true;},
      from(table){const filters=[],settings={table,filters};let value=null,range=null,single=false,signal=null;
        const builder={select(){return this;},eq(key,value){filters.push([key,value]);return this;},order(){return this;},range(start,end){range=[start,end];return this;},maybeSingle(){single=true;return this;},abortSignal(value){signal=value;return this;},upsert(row,options){value=row;settings.conflict=options.onConflict;return this;},then(resolve,reject){
          const work=async()=>{
            calls.push({operation:value?'upsert':'select',userId,...settings});if(signal?.aborted)throw new Error('Aborted');
            if(value){
              writes.push({table,row:value});if(interceptWrite){const result=await interceptWrite(table,value);if(result)return result;}
              if(signal?.aborted)throw new Error('Aborted');
              const rows=data(table),same=entry=>entry.user_id===value.user_id&&entry.provider===value.provider&&identity(table,entry)===identity(table,value),old=rows.find(same);
              if(old&&Date.parse(old.updated_at)>Date.parse(value.updated_at))return {data:[],error:null};
              tables.set(table,[...rows.filter(entry=>!same(entry)),structuredClone(value)]);return {data:[structuredClone(value)],error:null};
            }
            let rows=data(table).filter(row=>filters.every(([key,value])=>row[key]===value));if(range)rows=rows.slice(range[0],range[1]+1);return {data:structuredClone(single?rows[0]||null:rows),error:null};
          };return work().then(resolve,reject);
        }};return builder;
      }};clients.push(client);return client;
  };
  return {tables,calls,channels,clients,writes,createClient,QueryClient,intercept:fn=>{interceptWrite=fn;},emit(table,row){for(const channel of channels)for(const listener of channel.listeners)if(listener.filter.table===table)listener.callback({eventType:'UPDATE',new:row,old:{}});}};
}
function fixture(t,options={}){
  const sdk=options.sdk||transport(),time=clock(),updates=[],statuses=[],shared=[],handlers={};
  sdk.tables.set('profiles',[A,B].map(id=>({id,provider:'wplay',provider_key:'provider-fixture',scope_hash:'entitlement-fixture',status:'active',access_expires_at:null,last_validated_at:new Date(NOW).toISOString()})));
  const pageTarget={addEventListener:(name,callback)=>{handlers[name]=callback;},removeEventListener:name=>{delete handlers[name];}};
  const library=new CloudLibrary({...time,pageTarget,loadSDK:async()=>sdk,onUpdate:value=>updates.push(value),onStatus:value=>statuses.push(value),onSharedUpdate:value=>shared.push(value),...options});
  t.after(async()=>{const queryClient=library.queryClient;await queryClient?.cancelQueries();await library.dispose();queryClient?.clear();queryClient?.unmount();});return {library,sdk,time,updates,statuses,shared,handlers};
}

test('missing bootstrap reports only sanitized backend phase, status and elapsed time without loading a private library',async t=>{
  const diagnostics=[],f=fixture(t,{onDiagnostic:value=>diagnostics.push(value)});
  await f.library.resume({libraryId:'local-account',code:'CLOUD_TIMEOUT',stage:'arkhen_identity_lookup',remoteStatus:504,elapsedMs:15003});
  assert.deepEqual(diagnostics,[{code:'CLOUD_TIMEOUT',stage:'arkhen_identity_lookup',status:504,elapsedMs:15003}]);
  assert.deepEqual(f.library.getConnectionFailure(),{code:'CLOUD_BOOTSTRAP_UNAVAILABLE',stage:'bootstrap',authRecoveryRequired:false,
    backendCode:'CLOUD_TIMEOUT',backendStage:'arkhen_identity_lookup',status:504,elapsedMs:15003});
  assert.equal(f.sdk.calls.length,0);assert.equal(f.library.ready,false);
  await f.library.resume({libraryId:'local-account',code:'CLOUD_TIMEOUT',stage:'https://private.example/token',remoteStatus:900,elapsedMs:-1});
  assert.deepEqual(diagnostics.at(-1),{code:'CLOUD_TIMEOUT',stage:'bootstrap'});
  assert.doesNotMatch(JSON.stringify(f.library.getConnectionFailure()),/private|https|900|-1/);
});

test('adult classification arriving before flush removes only protected progress from the queue and snapshot',async t=>{
  const blocked=new Set(),f=fixture(t,{canRemember:value=>!blocked.has(value.id)});await f.library.connect(bootstrap());
  await f.library.saveFavorite(item('1'));await f.library.saveProgress(progress('1'));await f.library.saveProgress(progress('2'));
  blocked.add('1');await f.library.flushProgress();await flush();
  assert.deepEqual(f.sdk.writes.filter(value=>value.table==='user_progress').map(value=>value.row.item_key),['movie:2']);
  assert.deepEqual(f.library.snapshot().history.map(value=>value.item.id),['2']);assert.deepEqual(f.library.snapshot().favorites.map(value=>value.id),['1']);
  assert.equal(f.library.progressQueue.size,0);assert.equal(f.library.outbox.entries().length,0);assert.equal(f.time.jobs.size,0);
});

test('adult SQL refusal is terminal, removes optimistic data and notifies once without retrying normal records',async t=>{
  const blocked=[],f=fixture(t,{onHistoryBlocked:value=>blocked.push(value.id)});await f.library.connect(bootstrap());
  await f.library.saveFavorite(item('1'));await f.library.saveProgress(progress('2'),{force:true});
  f.sdk.intercept(async(table,value)=>table==='user_progress'&&value.item_key==='movie:1'?{data:null,error:{code:'P0001',message:'ARKHEN_ADULT_PROGRESS_DISABLED'}}:null);
  assert.equal(await f.library.saveProgress(progress('1'),{force:true}),true);await flush();
  assert.deepEqual(blocked,['1']);assert.equal(f.library.progressQueue.size,0);assert.equal(f.library.outbox.entries().length,0);assert.equal(f.time.jobs.size,0);
  assert.equal(await f.library.saveProgress(progress('1'),{force:true}),false);
  const writes=f.sdk.writes.length;await f.time.advance(60000);assert.equal(f.sdk.writes.length,writes);
  assert.deepEqual(f.library.snapshot().history.map(value=>value.item.id),['2']);assert.deepEqual(f.library.snapshot().favorites.map(value=>value.id),['1']);
  const cached=f.library.queryClient.getQueryCache().getAll().find(query=>query.queryKey[4]==='user_progress').state.data;
  assert.deepEqual(cached.map(value=>value.item_key),['movie:2']);
});

test('a successful in-flight response cannot restore progress reclassified as adult while the request waited',async t=>{
  const blocked=new Set(),pending=deferred(),f=fixture(t,{canRemember:value=>!blocked.has(value.id)});await f.library.connect(bootstrap());
  await f.library.saveFavorite(item('1'));await f.library.saveProgress(progress('2'),{force:true});
  f.sdk.intercept(async(table,value)=>table==='user_progress'&&value.item_key==='movie:1'?pending.promise:null);
  const saving=f.library.saveProgress(progress('1'),{force:true});await flush();assert.equal(f.sdk.writes.at(-1).row.item_key,'movie:1');
  blocked.add('1');f.library.purgeHistory();const updates=f.updates.length;pending.resolve(null);assert.equal(await saving,true);await flush();
  await f.library.load({force:true});await flush();
  for(const snapshot of f.updates.slice(updates))assert.equal(snapshot.progressRecords.some(value=>value.item_key==='movie:1'),false);
  assert.deepEqual(f.library.snapshot().history.map(value=>value.item.id),['2']);assert.deepEqual(f.library.snapshot().favorites.map(value=>value.id),['1']);
  for(const query of f.library.queryClient.getQueryCache().getAll().filter(query=>query.queryKey[4]==='user_progress'))assert.equal(query.state.data.some(value=>value.item_key==='movie:1'),false);
  assert.equal(f.library.outbox.entries().length,0);assert.equal(f.time.jobs.size,0);
});

test('an in-flight network failure after adult classification cannot requeue or retry private progress',async t=>{
  const blocked=new Set(),pending=deferred(),f=fixture(t,{canRemember:value=>!blocked.has(value.id)});await f.library.connect(bootstrap());
  f.sdk.intercept(async()=>pending.promise);const saving=f.library.saveProgress(progress('1'),{force:true});await flush();
  blocked.add('1');pending.resolve({data:null,error:{message:'offline'}});assert.equal(await saving,true);await flush();
  assert.equal(f.library.progressQueue.size,0);assert.equal(f.library.outbox.entries().length,0);assert.equal(f.time.jobs.size,0);
  assert.deepEqual(f.library.snapshot().history,[]);const writes=f.sdk.writes.length;await f.time.advance(60000);assert.equal(f.sdk.writes.length,writes);
});

test('a late adult refusal from the previous account cannot block the same ID in the next account',async t=>{
  const callbacks=[],pending=deferred(),f=fixture(t,{onHistoryBlocked:value=>callbacks.push(value.id)});await f.library.connect(bootstrap());
  f.sdk.intercept(async(table,value)=>value.user_id===A?pending.promise:null);
  const saving=f.library.saveProgress(progress('1'),{force:true});await flush();await f.library.connect(bootstrap(B));
  pending.resolve({data:null,error:{code:'P0001',message:'ARKHEN_ADULT_PROGRESS_DISABLED'}});await saving;await flush();
  assert.deepEqual(callbacks,[]);assert.equal(f.library.scope.userId,B);assert.equal(await f.library.saveProgress(progress('1'),{force:true}),true);
  assert.equal(f.library.snapshot().history[0].item.id,'1');assert.equal(f.library.snapshot().history[0].libraryId,`library-${B}`);
});

test('a rejected mixed keepalive batch identifies adult progress without losing its safe companion',async t=>{
  const callbacks=[],requests=[],f=fixture(t,{onHistoryBlocked:value=>callbacks.push(value.id),fetch:async(url,options)=>{requests.push({url,options});return {ok:false,json:async()=>({code:'P0001',message:'ARKHEN_ADULT_PROGRESS_DISABLED'})};}});
  await f.library.connect(bootstrap());
  f.sdk.intercept(async(table,value)=>table==='user_progress'&&value.item_key==='movie:1'?{data:null,error:{code:'P0001',message:'ARKHEN_ADULT_PROGRESS_DISABLED'}}:null);
  await f.library.saveProgress(progress('1'));await f.library.saveProgress(progress('2'));
  assert.equal(await f.library.flushProgress({keepalive:true}),true);await flush();
  assert.equal(requests.length,1);assert.equal(JSON.parse(requests[0].options.body).length,2);assert.deepEqual(callbacks,['1']);
  assert.deepEqual(f.library.snapshot().history.map(value=>value.item.id),['2']);assert.equal(f.library.outbox.entries().length,0);assert.equal(f.library.progressQueue.size,0);assert.equal(f.time.jobs.size,0);
});

test('hydration and Realtime do not reintroduce adult progress or remove explicit favorites',async t=>{
  const blocked=new Set(['3']),f=fixture(t,{canRemember:value=>!blocked.has(value.id)});
  const entries=[progress('1'),{...progress('2'),isAdult:true},progress('3'),progress('4',{id:'ep',adult:true})];
  f.sdk.tables.set('user_progress',entries.map(entry=>({user_id:A,provider:'wplay',item_key:`${entry.item.kind}:${entry.item.id}`,episode_id:entry.episode?.id||'',entry,updated_at:new Date(NOW).toISOString(),deleted_at:null})));
  f.sdk.tables.set('user_favorites',[row(item('3'))]);await f.library.connect(bootstrap());
  const favoritesMap=new Map(),historyMap=new Map([['movie:3',progress('3')]]),purged=[];
  f.library.hydrate({favoritesMap,historyMap,episodeProgress:{purge:value=>purged.push(value.id),read:()=>null,save:()=>assert.fail('No adult episode may hydrate.')}});
  assert.deepEqual([...historyMap.keys()],['movie:1']);assert.deepEqual([...favoritesMap.keys()],['movie:3']);assert.deepEqual(purged,['3']);
  f.sdk.emit('user_progress',f.sdk.tables.get('user_progress')[1]);await flush();f.library.hydrate({historyMap});
  assert.deepEqual([...historyMap.keys()],['movie:1']);assert.deepEqual(f.library.snapshot().progressRecords.map(value=>value.item_key),['movie:1']);
});

test('one small global marker revision invalidates all marker caches without subscribing to individual editions',async t=>{
  const f=fixture(t);await f.library.connect(bootstrap());
  const listeners=f.sdk.channels.at(-1).listeners.map(listener=>listener.filter);
  assert.equal(listeners.some(filter=>filter.table==='episode_skip_markers'),false);
  assert.ok(listeners.some(filter=>filter.table==='marker_cache_versions'&&filter.filter==='name=eq.global'));
  for(const table of ['episode_skip_markers','series_marker_identities','series_marker_coverage'])f.library.queryClient.setQueryData(['arkhen-cloud','https://fixture.supabase.co','wplay',A,table,'provider-fixture','entitlement-fixture','fixture'],[]);
  f.sdk.emit('marker_cache_versions',{name:'global',generation:'one-run'});await flush();
  for(const cached of f.library.queryClient.getQueryCache().getAll().filter(query=>['episode_skip_markers','series_marker_identities','series_marker_coverage'].includes(query.queryKey[4])))assert.equal(cached.state.isInvalidated,true);
  assert.equal(f.shared.at(-1).table,'episode_skip_markers');
});

test('small committed generation notices invalidate only their type and ignore another entitlement partition',async t=>{
  const f=fixture(t);await f.library.connect(bootstrap());
  const filters=f.sdk.channels.at(-1).listeners.map(listener=>listener.filter);assert.ok(filters.some(filter=>filter.table==='catalog_visible_generations'&&filter.filter==='provider_key=eq.provider-fixture'));
  for(const table of ['provider_catalog_cache','catalog_media','catalog_categories','catalog_artwork_refs'])assert.equal(filters.some(filter=>filter.table===table),false,'Large catalog metadata must not be subscribed over Realtime.');
  const key=type=>['arkhen-cloud','https://fixture.supabase.co','wplay',A,'provider_catalog_cache','provider-fixture','entitlement-fixture',type];
  for(const type of ['live','movies','series'])f.library.queryClient.setQueryData(key(type),[]);
  const event={provider_key:'provider-fixture',scope_hash:'entitlement-fixture',media_type:'series',updated_at:'2026-10-15T15:00:00Z'};
  f.sdk.emit('catalog_visible_generations',{...event,scope_hash:'other-partition'});await flush();assert.equal(f.shared.length,0);
  f.sdk.emit('catalog_visible_generations',event);await flush();assert.deepEqual(f.shared.at(-1),{table:'provider_catalog_cache',type:'series',revision:event.updated_at});
  for(const query of f.library.queryClient.getQueryCache().getAll().filter(query=>query.queryKey[4]==='provider_catalog_cache'))assert.equal(query.state.isInvalidated,query.queryKey.at(-1)==='series');
  const count=f.shared.length,queries=f.library.queryClient;await queries.cancelQueries();await f.library.logout();queries.clear();f.sdk.emit('catalog_visible_generations',event);await flush();assert.equal(f.shared.length,count);
});

test('invalid bootstrap never loads an SDK, accepts only publishable keys and validates the authenticated user',async t=>{
  let loads=0;const f=fixture(t,{loadSDK:async()=>{loads++;throw new Error('Do not load');}});
  for(const value of [null,bootstrap(A,{url:'http://fixture.supabase.co'}),bootstrap(A,{publishableKey:'sb_secret_private'}),bootstrap(A,{userId:'other'}),bootstrap(A,{session:{access_token:'token'}})])assert.equal(await f.library.connect(value),null);
  assert.equal(loads,0);assert.equal(cloudBootstrap(bootstrap()).provider,'wplay');
  const other=fixture(t);other.sdk.createClient=(...args)=>{throw new Error('override forbidden fixture');};
  assert.equal(await other.library.connect(bootstrap()),null);assert.equal(other.library.ready,false);
});

test('real TanStack queries load all user data only after auth and keep project/provider/user in every cache key',async t=>{
  const f=fixture(t);f.sdk.tables.set('user_favorites',[row(item()),row(item('2'),{user_id:B})]);
  const snapshot=await f.library.connect(bootstrap());assert.equal(snapshot.favorites.length,1);assert.equal(snapshot.favorites[0].poster,'');
  assert.ok(f.library.queryClient instanceof QueryClient);assert.deepEqual(f.sdk.calls.slice(0,2).map(call=>call.operation),['setSession','getUser']);
  for(const query of f.library.queryClient.getQueryCache().getAll())assert.deepEqual(query.queryKey.slice(0,4),['arkhen-cloud','https://fixture.supabase.co','wplay',A]);
  assert.equal(f.sdk.clients[0].options.auth.persistSession,true);assert.match(f.sdk.clients[0].options.auth.storageKey,new RegExp(A));
  assert.equal(f.library.getStatus().state,'synced');
});

test('favorite writes strip source credentials, use soft deletion and synchronize the server record',async t=>{
  const f=fixture(t);await f.library.connect(bootstrap());
  assert.equal(await f.library.saveFavorite(item('3',{address:'private-stream',password:'private-password',poster:'/assets/channels/test-1234567890abcdef.webp'})),true);await flush();
  const write=f.sdk.writes.at(-1);assert.equal(write.table,'user_favorites');assert.equal(write.row.user_id,A);assert.equal(write.row.item_key,'movie:3');
  assert.doesNotMatch(JSON.stringify(write.row),/private-stream|private-password|password|address/);
  assert.equal(write.row.item.poster,'/assets/channels/test-1234567890abcdef.webp');assert.equal(f.library.snapshot().favorites.length,1);
  assert.equal(await f.library.saveFavorite(item('3'),false),true);await flush();assert.ok(f.sdk.writes.at(-1).row.deleted_at);assert.equal(f.library.snapshot().favorites.length,0);
});

test('rolling back one failed favorite cannot remove another concurrently saved favorite',async t=>{
  const f=fixture(t),pending=deferred();await f.library.connect(bootstrap());
  f.sdk.intercept(async(table,row)=>row.item_key==='movie:1'?pending.promise:null);
  const first=f.library.saveFavorite(item('1'));await flush();await f.library.saveFavorite(item('2'));await flush();
  pending.resolve({error:{message:'private-server-error'},data:null});assert.equal(await first,false);await flush();
  const cached=f.library.queryClient.getQueryCache().getAll().find(query=>query.queryKey[4]==='user_favorites').state.data;
  assert.deepEqual(cached.map(row=>row.item.id),['2']);
  assert.deepEqual(f.library.snapshot().favorites.map(item=>item.id).sort(),['1','2'],'The failed local change remains explicitly queued for a later retry.');
  assert.equal(f.statuses.some(status=>status.message.includes('private-server-error')),false);
});

test('a failed favorite retries its durable outbox without needing a browser online event',async t=>{
  const f=fixture(t);await f.library.connect(bootstrap());let failed=true;
  f.sdk.intercept(async()=>failed?{data:null,error:{message:'Offline'}}:null);
  assert.equal(await f.library.saveFavorite(item('4')),false);assert.equal(f.library.outbox.entries().length,1);
  failed=false;await f.time.advance(5000);await flush();
  assert.equal(f.sdk.tables.get('user_favorites')[0].item.id,'4');assert.equal(f.library.outbox.entries().length,0);assert.equal(f.library.getStatus().state,'synced');assert.equal(f.time.jobs.size,0);
});

test('library status stays syncing until pending writes and queued progress are acknowledged',async t=>{
  const f=fixture(t),pending=deferred();await f.library.connect(bootstrap());f.sdk.intercept(async()=>pending.promise);
  const saving=f.library.saveFavorite(item('4'));await flush();assert.equal(f.library.getStatus().state,'syncing');
  await f.library.load({force:true});assert.equal(f.library.getStatus().state,'syncing','A successful read cannot acknowledge a pending write.');
  pending.resolve(null);await saving;assert.equal(f.library.getStatus().state,'synced');f.sdk.intercept(null);
  await f.library.saveProgress(progress());assert.equal(f.library.getStatus().state,'syncing');await f.time.advance(5000);await flush();assert.equal(f.library.getStatus().state,'synced');
});

test('progress coalesces for five seconds, preserves exact episode IDs and force flushes without waiting',async t=>{
  const f=fixture(t);await f.library.connect(bootstrap());
  const episode={id:'episode-4',season:6,number:4,title:'S06E004'};
  await f.library.saveProgress(progress('9',episode));await f.library.saveProgress({...progress('9',episode),time:90});
  assert.equal(f.sdk.writes.length,0);await f.time.advance(4999);assert.equal(f.sdk.writes.length,0);await f.time.advance(1);await flush();
  assert.equal(f.sdk.writes.length,1);assert.equal(f.sdk.writes[0].row.episode_id,'episode-4');assert.equal(f.sdk.writes[0].row.entry.time,90);
  await f.library.saveProgress(progress('9',{...episode,id:'episode-5',number:5}),{force:true});assert.equal(f.sdk.writes.length,2);
  assert.equal(f.library.snapshot().episodes.length,2);assert.equal(f.library.snapshot().history.length,1);
});

test('pagehide starts one keepalive Data API request with the current user token and no provider password',async t=>{
  const requests=[],f=fixture(t,{fetch:async(url,options)=>{requests.push({url,...options});return {ok:true};}});await f.library.connect(bootstrap());
  await f.library.saveProgress(progress());f.handlers.pagehide();await flush();
  assert.equal(requests.length,1);assert.equal(requests[0].keepalive,true);assert.equal(requests[0].headers.Authorization,`Bearer access-${A}`);
  assert.equal(JSON.parse(requests[0].body)[0].user_id,A);assert.equal(f.sdk.writes.length,0);assert.equal(f.time.jobs.size,0);
});

test('Realtime invalidation observes favorite tombstones and old callbacks become inert after logout',async t=>{
  const f=fixture(t);f.sdk.tables.set('user_favorites',[row(item())]);await f.library.connect(bootstrap());
  const deleted={...row(item()),deleted_at:new Date(NOW+1000).toISOString(),updated_at:new Date(NOW+1000).toISOString()};f.sdk.tables.set('user_favorites',[deleted]);f.sdk.emit('user_favorites',deleted);await flush();
  assert.equal(f.library.snapshot().favorites.length,0);assert.equal(f.sdk.channels[0].listeners.find(listener=>listener.filter.table==='user_favorites').filter.filter,`user_id=eq.${A}`);
  const channel=f.sdk.channels[0];await f.library.logout();const count=f.sdk.calls.length;for(const listener of channel.listeners)listener.callback({new:deleted});await flush();
  assert.equal(f.sdk.calls.length,count);assert.equal(channel.removed,true);assert.equal(f.library.queryClient,null);
  assert.deepEqual(f.sdk.calls.find(call=>call.operation==='signOut').options,{scope:'local'});
});

test('two independent browser sessions share favorites, deletions and exact episode progress through Realtime',async t=>{
  const first=fixture(t),second=fixture(t,{sdk:{...first.sdk,createClient:(...args)=>first.sdk.createClient(...args)}});await first.library.connect(bootstrap());
  await first.library.saveFavorite(item('8'));const episode={id:'episode-4',season:5,number:1,title:'S05E01'};
  await first.library.saveProgress({...progress('9',episode),time:420,duration:3600},{force:true});
  await second.library.connect(bootstrap());
  const favoritesMap=new Map(),historyMap=new Map(),episodes=[];
  second.library.hydrate({favoritesMap,historyMap,episodeProgress:{read:()=>null,save:entry=>episodes.push(entry)}});
  assert.equal(favoritesMap.get('movie:8').name,'Filme 8');assert.equal(historyMap.get('series:9').time,420);assert.equal(episodes[0].episode.id,'episode-4');
  await first.library.saveFavorite(item('8'),false);first.sdk.emit('user_favorites',first.sdk.tables.get('user_favorites')[0]);await flush();
  second.library.hydrate({favoritesMap,historyMap});assert.equal(favoritesMap.size,0);
  await first.library.saveProgress({...progress('9',episode),time:600,duration:3600},{force:true});first.sdk.emit('user_progress',first.sdk.tables.get('user_progress')[0]);await flush();
  second.library.hydrate({historyMap});assert.equal(historyMap.get('series:9').time,600);
});

test('Realtime rejoin refreshes missed changes and clears a recovered offline status',async t=>{
  const f=fixture(t);await f.library.connect(bootstrap());const channel=f.sdk.channels[0];channel.status('CHANNEL_ERROR');assert.equal(f.library.getStatus().state,'offline');
  f.sdk.tables.set('user_favorites',[row(item('7'))]);channel.status('SUBSCRIBED');await flush();await flush();
  assert.equal(f.library.snapshot().favorites[0].id,'7');assert.equal(f.library.getStatus().state,'synced');
});

test('switching accounts clears old cache, queues and subscriptions before reading the next account',async t=>{
  const f=fixture(t);f.sdk.tables.set('user_favorites',[row(item()),row(item('2'),{user_id:B})]);await f.library.connect(bootstrap());const old=f.library.queryClient;
  await f.library.saveProgress(progress());await f.library.connect(bootstrap(B));assert.equal(old.getQueryCache().getAll().length,0);assert.equal(f.time.jobs.size,0);
  assert.deepEqual(f.library.snapshot().favorites.map(item=>item.id),['2']);assert.equal(f.sdk.channels[0].removed,true);assert.equal(f.library.progressQueue.size,0);
});

test('shared cache checks complete snapshots, expiry and entitlement filters and reconstructs marker manifests',async t=>{
  const f=fixture(t);await f.library.connect(bootstrap());const common={provider_key:'provider-fixture',scope_hash:'entitlement-fixture',expires_at:new Date(NOW+60000).toISOString()};
  f.sdk.tables.set('provider_catalog_cache',[{...common,media_type:'movies',payload:{items:[item()]},is_complete:false},{...common,media_type:'series',payload:{items:[]},is_complete:true}]);
  assert.equal(await f.library.cachedCatalog('movies'),null);assert.deepEqual(await f.library.cachedCatalog('series'),{items:[]});
  f.sdk.tables.set('provider_epg_cache',[{...common,channel_id:'10',payload:{list:[]},expires_at:new Date(NOW-1).toISOString()}]);assert.equal(await f.library.epg('10'),null);
  f.sdk.tables.set('provider_games_cache',[{...common,game_date:'2026-10-15',time_zone:'America/Maceio',payload:{available:true,games:[]}}]);assert.deepEqual(await f.library.games('2026-10-15','America/Maceio'),{available:true,games:[]});
  const marker={series_slug:'game-of-thrones',season:6,episode:4,edition_id:'reference',tmdb_id:1399,imdb_id:'tt0944947',duration_seconds:3521.7,tolerance_seconds:3,verification:'community-reference',markers:{openingStart:6,openingEnd:113.458,creditsStart:3442.6},provenance:{sources:[{url:'https://api.introdb.app/',title:'IntroDB'}],edition:{sourceFingerprint:'a'.repeat(16)},verification:{blockEarlyNext:true}},data_version:'fixture',is_active:true};
  f.sdk.tables.set('episode_skip_markers',[marker,{...marker,edition_id:'wrong-series',imdb_id:'tt9999999'}]);
  const manifest=await f.library.markerManifest('game-of-thrones');assert.equal(manifest.records.length,1);assert.equal(manifest.records[0].markers.creditsStart,3442.6);assert.equal(manifest.records[0].verification.status,'community-reference');assert.equal(manifest.records[0].verification.blockEarlyNext,true);assert.equal(manifest.records[0].edition.sourceFingerprint,'a'.repeat(16));
  const query=f.sdk.calls.find(call=>call.table==='provider_games_cache');assert.deepEqual(query.filters.slice(0,2),[['provider_key','provider-fixture'],['scope_hash','entitlement-fixture']]);
});

test('catalog identities resolve series outside the original registry and expose a cached manual IntroDB reference without a provider call',async t=>{
  const f=fixture(t);await f.library.connect(bootstrap());const value={id:'55',kind:'series',name:'Uma série nova - 2020'},imdb='tt1234567';
  f.sdk.tables.set('series_marker_identities',[{provider_key:'provider-fixture',scope_hash:'entitlement-fixture',media_id:'55',catalog_name:value.name,status:'resolved',imdb_id:imdb,series_slug:'imdb-'+imdb,tmdb_id:null}]);
  f.sdk.tables.set('series_marker_coverage',[{imdb_id:imdb,season:1,episode:1,status:'unverified',evidence:{introdb:{intro:{start_ms:6000,end_ms:60000}}}}]);
  const identity=await f.library.markerSeriesIdentity(value);assert.equal(identity.imdbId,imdb);assert.equal(identity.slug,'imdb-'+imdb);
  const manifest=await f.library.markerManifest(identity.slug,{season:1,episode:1});assert.equal(manifest.records.length,0);assert.equal(manifest.episodeEvidence.evidence.introdb.intro.end_ms,60000);
  const query=f.sdk.calls.find(call=>call.table==='series_marker_identities');assert.deepEqual(query.filters.slice(0,3),[['provider_key','provider-fixture'],['scope_hash','entitlement-fixture'],['media_id','55']]);
});

test('hydration applies remote deletions, preserves newer local progress and restores each exact episode',async t=>{
  const f=fixture(t),favoritesMap=new Map([['movie:1',{...item(),savedAt:NOW-1000}],['movie:2',{...item('2'),savedAt:NOW+1000}]]),historyMap=new Map([['movie:3',{...progress('3'),time:90,updated:NOW+1000}]]),saved=[];
  f.sdk.tables.set('user_favorites',[row(item(),{deleted_at:new Date(NOW).toISOString()}),row(item('2'),{deleted_at:new Date(NOW).toISOString()})]);
  const episode={id:'ep4',season:6,number:4,title:'Episode'};
  f.sdk.tables.set('user_progress',[{...row(item('3')),episode_id:'',entry:progress('3')},{...row(item('9',{kind:'series'})),episode_id:'ep4',entry:progress('9',episode)}]);
  await f.library.connect(bootstrap());f.library.hydrate({favoritesMap,historyMap,episodeProgress:{read:()=>null,save:entry=>saved.push(entry)}});
  assert.equal(favoritesMap.has('movie:1'),false);assert.equal(favoritesMap.has('movie:2'),true);assert.equal(historyMap.get('movie:3').time,90);assert.equal(saved[0].episode.id,'ep4');assert.equal(saved[0].libraryId,`library-${A}`);
});

test('preferences reject credential fields and collections retain soft deletions',async t=>{
  const f=fixture(t);await f.library.connect(bootstrap());assert.equal(await f.library.savePreference('password','secret'),false);assert.equal(await f.library.savePreference('settings',{access_token:'secret'}),false);
  assert.equal(await f.library.savePreference('series-playback',{autoNext:true}),true);
  assert.equal(await f.library.saveCollection({id:'action-list',name:'Ação',collection_type:'movies',item_keys:['movie:1','https://private.example']}),true);
  assert.deepEqual(f.sdk.writes.at(-1).row.item_keys,['movie:1']);await f.library.removeCollection({id:'action-list',name:'Ação',collection_type:'movies'});assert.ok(f.sdk.writes.at(-1).row.deleted_at);
});

test('a mismatched authenticated user or inactive profile cannot query private library rows',async t=>{
  const f=fixture(t),create=f.sdk.createClient;
  f.sdk.createClient=(...args)=>{const client=create(...args);client.auth.getUser=async()=>({data:{user:{id:B}},error:null});return client;};
  assert.equal(await f.library.connect(bootstrap()),null);assert.equal(f.sdk.calls.some(call=>call.table==='user_favorites'),false);assert.equal(f.sdk.calls.filter(call=>call.operation==='signOut').length,1);
  const other=fixture(t);other.sdk.tables.get('profiles')[0].status='disabled';assert.equal(await other.library.connect(bootstrap()),null);assert.equal(other.sdk.calls.some(call=>call.table==='user_favorites'),false);assert.equal(other.sdk.calls.filter(call=>call.operation==='signOut').length,1);
});

test('a transient initial profile failure preserves the rotated Auth session and reconnects with the same backend bootstrap',async t=>{
  const f=fixture(t),create=f.sdk.createClient,captured=[],revoked=new Set();let persisted=null,firstRead=true,disposed=0;
  f.sdk.createClient=(...args)=>{
    const client=create(...args),set=client.auth.setSession,from=client.from;
    client.auth.getSession=async()=>({data:{session:persisted},error:null});
    client.auth.setSession=async credentials=>{
      captured.push(credentials);if(revoked.has(credentials.refresh_token))return {data:{session:null},error:{status:401}};
      const result=await set(credentials);persisted={...result.data.session,access_token:'rotated-access',refresh_token:'rotated-refresh'};return {data:{session:persisted},error:null};
    };
    client.auth.signOut=async()=>{f.sdk.calls.push({operation:'signOut'});revoked.add(persisted?.refresh_token);persisted=null;return {error:null};};
    client.auth.dispose=async()=>{disposed++;};
    client.from=table=>{
      if(table!=='profiles'||!firstRead)return from(table);firstRead=false;
      return {select(){return this;},eq(){return this;},async maybeSingle(){return {data:null,error:{status:503}};}};
    };
    return client;
  };
  assert.equal(await f.library.connect(bootstrap()),null);assert.equal(f.library.getStatus().state,'offline');
  assert.equal(f.sdk.calls.filter(call=>call.operation==='signOut').length,0,'Data API outage must not revoke a reusable Auth session.');assert.equal(disposed,0,'A transient outage retains the realm Auth client and its token-to-Realtime listener.');
  assert.equal((await f.library.connect(bootstrap())).userId,A);assert.equal(captured.length,1,'The rotated persisted session is reused without replaying setSession.');assert.equal(f.library.accessToken,'rotated-access');assert.equal(f.sdk.clients.length,1);assert.equal(f.library.ready,true);
  await f.library.logout({flush:false});assert.equal(f.sdk.calls.filter(call=>call.operation==='signOut').length,1,'Explicit logout still revokes this device session.');assert.equal(disposed,0,'Explicit logout revokes local credentials without destroying the reusable Auth client.');
});

test('a persisted rotated refresh session takes precedence over an older backend bootstrap',async t=>{
  const f=fixture(t),create=f.sdk.createClient,captured=[];
  f.sdk.createClient=(...args)=>{
    const client=create(...args),set=client.auth.setSession;
    client.auth.getSession=async()=>({data:{session:{access_token:'rotated-access',refresh_token:'rotated-refresh',user:{id:A}}},error:null});
    client.auth.setSession=async value=>{captured.push(value);return set(value);};return client;
  };
  await f.library.connect(bootstrap());assert.deepEqual(captured,[],'A valid persisted session must not be reset by the stale bootstrap.');assert.equal(f.library.accessToken,'rotated-access');
  const clients=f.sdk.clients.length;await f.library.connect(bootstrap());assert.equal(f.sdk.clients.length,clients);assert.equal(f.sdk.calls.some(call=>call.operation==='signOut'),false);
});

test('a rejected Auth session requests recovery without revocation and a recovered bootstrap overrides stale browser credentials',async t=>{
  const diagnostics=[],f=fixture(t,{onDiagnostic:event=>diagnostics.push(event)}),create=f.sdk.createClient,captured=[];let verifies=0,sessionReads=0;
  f.sdk.createClient=(...args)=>{const client=create(...args),set=client.auth.setSession;client.auth.getSession=async()=>{sessionReads++;return {data:{session:{access_token:'stale-access',refresh_token:'stale-refresh',user:{id:A}}},error:null};};client.auth.setSession=async value=>{captured.push(value);return set(value);};client.auth.getUser=async()=>++verifies===1?{data:{user:null},error:{status:401,message:'private-token-never-log'}}:{data:{user:{id:A}},error:null};return client;};
  assert.equal(await f.library.connect(bootstrap()),null);assert.equal(f.library.getConnectionFailure().authRecoveryRequired,true);assert.equal(f.library.getConnectionFailure().status,401);assert.equal(f.sdk.calls.some(call=>call.operation==='signOut'),false);
  const recovered=bootstrap(A,{session:{access_token:'fresh-access',refresh_token:'fresh-refresh'}});assert.equal((await f.library.connect(recovered,{preferBootstrap:true})).userId,A);assert.equal(sessionReads,1);assert.equal(captured.length,1);assert.equal(captured[0].refresh_token,'fresh-refresh');assert.equal(f.library.getConnectionFailure(),null);assert.doesNotMatch(JSON.stringify(diagnostics),/private-token|stale-|fresh-/);
});

test('UI subscriber and status callback failures cannot revoke or fail a valid Auth connection',async t=>{
  const diagnostics=[],f=fixture(t,{onStatus:()=>{throw Object.assign(new Error('private-ui-state'),{status:401});},onDiagnostic:event=>diagnostics.push(event)});f.library.subscribe(()=>{throw Object.assign(new Error('private-ui-state'),{status:401});});
  assert.equal((await f.library.connect(bootstrap())).userId,A);assert.equal(f.library.ready,true);assert.equal(f.library.getConnectionFailure(),null);assert.equal(f.sdk.calls.some(call=>call.operation==='signOut'),false);assert.ok(diagnostics.some(event=>event.code==='CLOUD_UI_CALLBACK_FAILED'));assert.doesNotMatch(JSON.stringify(diagnostics),/private-ui-state|access-|refresh-/);
});

test('offline favorite tombstones persist without auth secrets, survive reload and never cross accounts',async t=>{
  const saved=new Map(),storage={getItem:key=>saved.get(key)||null,setItem:(key,value)=>saved.set(key,value)},first=fixture(t,{storage});
  first.sdk.tables.set('user_favorites',[row(item())]);await first.library.connect(bootstrap());first.sdk.intercept(async()=>({data:null,error:{message:'Offline'}}));
  assert.equal(await first.library.saveFavorite(item(),false),false);await flush();assert.equal(first.library.snapshot().favorites.length,0);assert.equal(first.library.outbox.entries().length,1);
  assert.doesNotMatch([...saved.values()].join(''),/access_token|refresh_token|sb_publishable|password|old-session/);await first.library.logout({flush:false});
  const second=fixture(t,{storage});second.sdk.tables.set('user_favorites',[row(item())]);await second.library.connect(bootstrap(B));assert.equal(second.sdk.writes.length,0);
  await second.library.connect(bootstrap());assert.equal(second.sdk.writes.length,1);assert.ok(second.sdk.writes[0].row.deleted_at);assert.equal(second.library.snapshot().favorites.length,0);assert.equal(second.library.outbox.entries().length,0);
});

test('logout while the SDK is loading prevents a late connection from creating a client or querying data',async t=>{
  const pending=deferred(),f=fixture(t,{loadSDK:()=>pending.promise});const connecting=f.library.connect(bootstrap());await flush();await f.library.logout({flush:false});
  pending.resolve(f.sdk);assert.equal(await connecting,null);assert.equal(f.sdk.clients.length,0);assert.equal(f.library.ready,false);
});

test('importing local data needs the exact account scope and cannot resurrect a newer remote deletion',async t=>{
  const f=fixture(t);f.sdk.tables.set('user_favorites',[row(item(),{deleted_at:new Date(NOW).toISOString()})]);await f.library.connect(bootstrap());
  const favoritesMap=new Map([['movie:1',{...item(),savedAt:NOW-1000}],['movie:2',{...item('2'),savedAt:NOW-1000}]]);
  assert.equal(await f.library.syncLocal({libraryId:'wrong-account',favoritesMap}),false);assert.equal(f.sdk.writes.length,0);
  assert.equal(await f.library.syncLocal({libraryId:`library-${A}`,favoritesMap}),true);assert.deepEqual(f.sdk.writes.map(write=>write.row.item_key),['movie:2']);
});

test('local import picks the newest progress once when history and episode storage contain the same episode',async t=>{
  const f=fixture(t);await f.library.connect(bootstrap());const episode={id:'ep4',season:5,number:1,title:'Episode'},latest={...progress('9',episode),time:600,duration:3600,updated:NOW+1000};
  const historyMap=new Map([['series:9',latest]]),episodeEntries=[{...latest,time:120,updated:NOW-1000}];
  await f.library.syncLocal({libraryId:`library-${A}`,historyMap,episodeEntries});await flush();
  assert.equal(f.sdk.writes.filter(value=>value.table==='user_progress').length,1);assert.equal(f.sdk.writes.at(-1).row.entry.time,600);
});

test('an account disabled through Realtime stops cloud reads and clears its in-memory cache',async t=>{
  const f=fixture(t);await f.library.connect(bootstrap());const queryClient=f.library.queryClient;
  f.sdk.emit('profiles',{...f.sdk.tables.get('profiles')[0],status:'disabled'});await flush();assert.equal(f.library.ready,false);assert.equal(queryClient.getQueryCache().getAll().length,0);assert.equal(f.library.getStatus().state,'restricted');
  assert.equal(f.sdk.channels[0].listeners.some(listener=>listener.filter.event==='*'||listener.filter.event==='DELETE'),false);
});

test('a new account waits for the previous SDK sign-out and a late logout cannot erase its cache',async t=>{
  const f=fixture(t),cleanup=deferred();await f.library.connect(bootstrap());
  const old=f.sdk.clients[0];old.auth.signOut=async()=>cleanup.promise;
  const leaving=f.library.logout({flush:false});await flush();const entering=f.library.connect(bootstrap(B));await flush();
  assert.equal(f.sdk.clients.length,1,'The old auth store finishes cleanup before creating a new SDK client.');
  cleanup.resolve({error:null});await leaving;assert.equal((await entering).userId,B);assert.equal(f.library.ready,true);assert.equal(f.library.scope.userId,B);
  assert.ok(f.library.queryClient.getQueryCache().getAll().every(query=>query.queryKey[3]===B));
});


test('two library owners in one JavaScript realm cannot compete for the same Auth client',async t=>{
 const first=fixture(t),second=fixture(t,{sdk:first.sdk});await first.library.connect(bootstrap());
 assert.equal(await second.library.connect(bootstrap()),null);assert.equal(first.sdk.clients.length,1);assert.equal(first.library.ready,true);
 assert.equal(first.sdk.calls.some(call=>call.operation==='signOut'),false,'A rejected second owner cannot revoke the active owner.');
});
