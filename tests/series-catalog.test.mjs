import test from 'node:test';
import assert from 'node:assert/strict';
import {SeriesServices} from '../web/serie/services.js';
import {SeriesSearch} from '../web/serie/busca.js';
import {SeriesQueries} from '../web/serie/tanstack-query.js';
import {SeriesRealtime} from '../web/serie/realtime.js';
import {SeriesSupabase} from '../web/serie/supabase.js';
import {SeriesFeature} from '../web/serie/orquestrador.js';
import {seriesScopeKey,seriesMetadataScopeKey} from '../web/serie/scope.js';

const item={kind:'series',id:'42',name:'Fixture series'},details={...item,seasons:[{season:1,episodes:[{id:'91',number:1,season:1}]}]};
const account=()=>({account:'fixture-account',epoch:1,hidden:{series:[],movies:['movie-category'],live:[]},hiddenItems:{series:[],movies:[],live:[]}});
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
function borrowedQueries(){
  const values=new Map(),invalidations=[];let clock=0;const times=new Map();
  return {values,invalidations,getQueryData:key=>values.get(JSON.stringify(key)),setQueryData:(key,value)=>values.set(JSON.stringify(key),value),
    getQueryCache:()=>({getAll:()=>[...values.keys()].map(key=>({queryKey:JSON.parse(key),state:{dataUpdatedAt:times.get(key)||(times.set(key,++clock),clock)}}))}),
    invalidateQueries:options=>{invalidations.push(options);return Promise.resolve();},
    removeQueries:({queryKey})=>{for(const key of values.keys())if(JSON.parse(key).slice(0,queryKey.length).every((value,index)=>value===queryKey[index]))values.delete(key);}};
}

test('series metadata scope ignores other domains and late cloud attachment but follows account, epoch, PIN and visibility',()=>{
  const scope=account(),same={...scope,project:'https://fixture-project.example',providerKey:'fixture-provider',scopeHash:'fixture-scope',hidden:{...scope.hidden,movies:['changed'],live:['changed']}};
  assert.equal(seriesMetadataScopeKey(scope),seriesMetadataScopeKey(same));assert.notEqual(seriesScopeKey(scope),seriesScopeKey(same));
  for(const change of [{account:'other-account'},{epoch:2},{includeAdult:true},{hidden:{series:['protected']}},{hiddenItems:{series:['42']}}])assert.notEqual(seriesMetadataScopeKey(scope),seriesMetadataScopeKey({...scope,...change}));
  assert.equal(seriesMetadataScopeKey(null),null);
});

test('series detail readers coalesce on one provider request and cancel independently',async()=>{
  const scope=account(),pending=deferred();let calls=0,transportSignal;
  const services=new SeriesServices({getScope:()=>scope,request:async(path,{signal})=>{calls++;transportSignal=signal;assert.equal(path,'/api/details?type=series&id=42');return pending.promise;}});
  const controller=new AbortController(),first=services.details(item,{signal:controller.signal}),second=services.details(item);
  await Promise.resolve();controller.abort();await assert.rejects(first,{name:'AbortError'});
  assert.equal(transportSignal.aborted,false,'A canceled preview cannot retire another reader.');
  pending.resolve(details);assert.equal(await second,details);assert.equal(calls,1);assert.equal(services.peekDetails(item),details);
  services.reset();assert.equal(services.peekDetails(item),null);
});

test('late bootstrap retains the selected series preview while account replacement rejects old details',async()=>{
  let scope=account(),pending=deferred();
  const services=new SeriesServices({getScope:()=>scope,request:()=>pending.promise});
  const selected=services.details(item);await Promise.resolve();scope={...scope,project:'https://fixture.example',providerKey:'provider',scopeHash:'scope'};
  pending.resolve(details);assert.equal(await selected,details);
  pending=deferred();const old=services.details(item,{force:true});await Promise.resolve();scope={...scope,account:'other-account'};
  pending.resolve(details);await assert.rejects(old,{name:'AbortError'});assert.equal(services.peekDetails(item),null);
});

test('last series reader cancellation retires transport and malformed movie metadata never enters the series cache',async()=>{
  const scope=account(),pending=deferred();let transportSignal;
  const services=new SeriesServices({getScope:()=>scope,request:(_path,{signal})=>{transportSignal=signal;return pending.promise;}});
  const controller=new AbortController(),selected=services.details(item,{signal:controller.signal});await Promise.resolve();controller.abort();
  await assert.rejects(selected,{name:'AbortError'});assert.equal(transportSignal.aborted,true);pending.resolve(details);
  services.configure({request:async()=>({...details,kind:'movie'})});
  await assert.rejects(services.details(item),/SERIES_DETAILS_RESPONSE_INVALID/);assert.equal(services.peekDetails(item),null);
});

test('series queries use the injected client and recover without constructing a client when it is not yet available',async()=>{
  const scope=account();let client=null,calls=0;
  const services=new SeriesServices({getScope:()=>scope,request:async()=>{calls++;return details;}});
  const queries=new SeriesQueries({services,getScope:()=>scope,getQueryClient:()=>client});
  assert.equal(await queries.lookup(item),details);assert.equal(calls,1);
  client=borrowedQueries();assert.equal(await queries.lookup(item),details);assert.equal(calls,1,'The service cache remains valid until an actual publication.');assert.equal(client.values.size,1);
  queries.invalidate();assert.equal(await queries.lookup(item),details);assert.equal(calls,2);assert.equal(client.values.size,2,'Publication revisions cannot reuse an old detail key.');
  client.setQueryData(['unrelated-domain'],{preserve:true});queries.reset();assert.equal(client.values.size,1);assert.deepEqual(client.getQueryData(['unrelated-domain']),{preserve:true});
});

test('series metadata bounds only its borrowed query namespace and preserves other domain caches',async()=>{
  const scope=account(),client=borrowedQueries(),services=new SeriesServices({getScope:()=>scope,request:async path=>({...item,id:new URL(path,'http://fixture.example').searchParams.get('id')})});
  const queries=new SeriesQueries({services,getScope:()=>scope,getQueryClient:()=>client,maxEntries:2});client.setQueryData(['movie-cache'],{keep:true});
  for(const id of ['1','2','3'])await queries.lookup({...item,id});
  assert.equal(client.values.size,3);assert.deepEqual(client.getQueryData(['movie-cache']),{keep:true});
  assert.equal([...client.values.keys()].some(key=>JSON.parse(key).at(-1)==='1'),false);
});

test('manual series refresh retires cached metadata while a selected read may finish without repopulating the old revision',async()=>{
  const scope=account(),client=borrowedQueries(),pending=deferred();let calls=0;
  const updated={...details,seasons:[{season:1,episodes:[{id:'91',number:1,season:1},{id:'92',number:2,season:1}]}]};
  const series=new SeriesFeature();series.configure({getScope:()=>scope,getQueryClient:()=>client,request:()=>++calls===1?pending.promise:Promise.resolve(updated)});
  const selected=series.details(item);await Promise.resolve();series.invalidateDetails();
  pending.resolve(details);assert.equal(await selected,details,'An already selected authorized preview can complete.');
  assert.equal(series.peekDetails(item),null,'The old publication must not repopulate either metadata cache.');
  assert.equal(await series.details(item),updated);assert.equal(calls,2);assert.equal(series.peekDetails(item),updated);series.dispose();
});

test('series search delegates exact RPC ordering and pagination to the existing search owner without affecting another tab',async()=>{
  let scope=account();const calls=[],response={items:[{id:'9',kind:'series'},{id:'2',kind:'series'}]};
  const engine={state:{type:'all',phase:'idle',data:null},search:async(query,options)=>{calls.push(['search',query,options]);engine.state={query,type:options.type,phase:'ready',data:response};return response;},
    more:async()=>{calls.push(['more']);return response;},cancel:()=>calls.push(['cancel'])};
  const search=new SeriesSearch({search:engine,getScope:()=>scope});
  assert.equal(await search.search('Fixture',{immediate:true,force:true,type:'movies'}),response);
  assert.deepEqual(calls[0],['search','Fixture',{type:'series',immediate:true,force:true}]);assert.deepEqual(search.state.data.items.map(value=>value.id),['9','2']);
  await search.more();assert.equal(calls.at(-1)[0],'more');engine.state={type:'movies',phase:'ready'};search.reset();assert.equal(calls.some(row=>row[0]==='cancel'),false);
  engine.state={type:'series',phase:'ready',data:response};scope=null;assert.equal(search.state.data,null);assert.equal(await search.search('Fixture'),null);
});

test('series realtime consumes only the current series partition and progress never reloads catalogue metadata',()=>{
  const scope={...account(),providerKey:'provider',scopeHash:'scope'},invalidations=[],revisions=[],favorites=[],progress=[];
  const realtime=new SeriesRealtime({getScope:()=>scope,queries:{invalidate:partition=>invalidations.push(partition)},onCatalogRevision:event=>revisions.push(event.revision),
    onFavoritesUpdate:value=>favorites.push(value),onProgressUpdate:value=>progress.push(value)});
  const publication={table:'catalog_visible_generations',type:'series',providerKey:'provider',scopeHash:'scope',revision:'2026-10-16T20:00:00Z'};
  assert.equal(realtime.sharedUpdated({...publication,type:'movies'}),false);assert.equal(realtime.sharedUpdated({...publication,scopeHash:'other'}),false);
  assert.equal(realtime.sharedUpdated(publication),true);assert.equal(realtime.sharedUpdated(publication),false);
  assert.equal(realtime.sharedUpdated({...publication,revision:'2026-10-15T20:00:00Z'}),false);
  assert.deepEqual(invalidations,['details']);assert.equal(revisions.length,1);
  assert.equal(realtime.libraryUpdated({ready:true},{progress:['series']}),true);assert.deepEqual(invalidations,['details','progress']);assert.equal(progress.length,1);
  assert.equal(realtime.libraryUpdated({ready:true},{favorites:['movie'],progress:['live']}),false);assert.equal(favorites.length,0);
});

test('series playback URLs require an actual episode and preserve its native id and format',()=>{
  const services=new SeriesServices();
  assert.equal(services.playbackURL(item,{episode:{id:'91',container:'mkv'},attempt:'fixture-attempt'}),'/api/play/series/91.mkv?attempt=fixture-attempt');
  assert.equal(services.playbackURL(item,{episode:{id:92,container:'m3u8'}}),'/api/play/series/92.m3u8');
  for(const options of [{},{episode:{id:'../../91'}},{episode:{id:'91',container:'mp4?secret'}},{episode:{id:'91'},attempt:'../attempt'}])assert.throws(()=>services.playbackURL(item,options),TypeError);
  assert.throws(()=>services.playbackURL({kind:'movie',id:'42'},{episode:{id:'91'}}),TypeError);
});

test('series library projection rejects another owner and filters only this account without opening another connection or store',()=>{
  let session={connected:true,account:{libraryId:'fixture-account'},cloud:{url:'https://fixture-project.example',provider:'wplay',userId:'fixture-user',providerKey:'provider',scopeHash:'scope'}};
  const cloudLibrary={scope:{...session.cloud,libraryId:'fixture-account'}},entry={item,episode:{id:'91'},libraryId:'fixture-account'};
  const library=new SeriesSupabase({cloudLibrary,getSession:()=>session,isVisible:value=>value.id!=='43',canRemember:()=>true});
  const row=(item,extra={})=>({user_id:'fixture-user',provider:'wplay',item,entry:{...entry,item},...extra});
  const snapshot={ready:true,userId:'fixture-user',provider:'wplay',favorites:[item,{...item,id:'43'},{...item,kind:'movie'}],
    favoriteRecords:[row(item),row(item,{user_id:'other-user'})],history:[entry,{...entry,item:{...item,isAdult:true}},{...entry,libraryId:'other-account'}],
    episodes:[entry],progressRecords:[row(item),row(item,{provider:'other-provider'})]};
  const projected=library.snapshot(snapshot);assert.equal(projected.ready,true);assert.deepEqual(projected.favorites,[item]);assert.equal(projected.favoriteRecords.length,1);
  assert.deepEqual(projected.history,[entry]);assert.deepEqual(projected.episodes,[entry]);assert.equal(projected.progressRecords.length,1);
  assert.equal(library.snapshot({...snapshot,userId:'other-user'}).ready,false);
  session={...session,account:{libraryId:'other-account'}};assert.equal(library.snapshot(snapshot).ready,false);
  assert.deepEqual(Object.keys(cloudLibrary),['scope'],'A read projection must not construct or mutate an Auth/socket/outbox owner.');
});

test('series orchestration keeps repository loading and metadata/search consumers under one domain lifecycle',async()=>{
  const scope=account(),loads=[],services=new SeriesServices({loadCatalog:(...args)=>loads.push(args),getCatalog:type=>({type}),request:async()=>details,getScope:()=>scope});
  const series=new SeriesFeature({services});series.configure({request:async()=>details,getScope:()=>scope});
  assert.equal(series.services.current().type,'series');await series.load({force:true});assert.deepEqual(loads[0],['series',true,{}]);
  assert.equal(await series.details(item),details);assert.equal(series.peekDetails(item),details);series.reset();assert.equal(series.peekDetails(item),null);
  assert.throws(()=>series.configure(),/SERIES_ALREADY_CONFIGURED/);series.dispose();
});
