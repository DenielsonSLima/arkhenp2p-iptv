import test from 'node:test';
import assert from 'node:assert/strict';
import {QueryClient} from '@tanstack/query-core';
import {CatalogRepository,catalogQueryKey} from '../web/catalog-repository.js';
import {CatalogCache} from '../web/catalog-cache.js';
import {MoviesFeature} from '../web/filmes/orquestrador.js';
import {SeriesFeature} from '../web/serie/orquestrador.js';
import {LiveFeature} from '../web/tv/aba.js';
import {selectLibraryFavorites,libraryChangeSet,includePreparingSearch} from '../web/library-selectors.js';
import {mergeCatalogPage} from '../web/catalog-pagination.js';

const owner='a'.repeat(64),scope={project:'https://test.supabase.co',providerKey:'b'.repeat(64),scopeHash:'c'.repeat(64),includeAdult:false};
const data=(type,count,{complete=false,revision='2026-10-15T12:00:00Z',snapshot='snapshot-1',...extra}={})=>({categories:[{id:'1',name:'Cinema'}],items:Array.from({length:count},(_,index)=>({kind:type==='movies'?'movie':type,id:String(index+1),name:`Title ${index+1}`,categoryId:'1'})),catalogComplete:complete,preparing:!complete,pagination:{mode:complete?'complete':'category',source:'supabase',snapshotId:snapshot,revisionAt:revision,complete,preparing:!complete,byCategory:{__all:{loaded:true,hasMore:false}}},...extra});
// Production prepareCatalog applies this complete-page normalization before
// building UI maps. Keep the real join in this fixture, rather than bypassing it.
const prepare=value=>{if(value.catalogComplete===true)value=mergeCatalogPage(null,value);return {...value,sourceCategories:value.categories,itemMap:new Map(value.items.map(item=>[item.id,item]))};};
function setup(t){let account=1,currentScope={...scope};const commits=[],repository=new CatalogRepository({getScope:type=>({...currentScope,type}),getAccountEpoch:()=>account,prepare,onCommit:(type,catalog)=>commits.push({type,catalog}),loadQueryCore:async()=>({QueryClient})});t.after(()=>{repository.reset();repository.queryClient?.unmount();});return {repository,commits,setAccount:()=>{account++;},setScope:patch=>{currentScope={...currentScope,...patch};}};}
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};

test('0/4/17 previews do not determine the account favorites for any domain',t=>{
  const f=setup(t),features=[new MoviesFeature(),new SeriesFeature(),new LiveFeature()],catalogs=new Map();
  for(const [type,count]of [['movies',4],['series',17],['live',0]])catalogs.set(type,f.repository.commit(type,data(type,count)));
  const favorites=new Map();for(const [kind,count]of [['movie',4],['series',2],['live',31]])for(let index=0;index<count;index++){const item={kind,id:String(900+index),name:`Saved ${kind} ${index}`,libraryId:owner,categoryId:'1'};favorites.set(`${kind}:${item.id}`,item);}
  const context={favorites,catalogs,libraryId:owner,activeLibraryId:owner};
  assert.deepEqual(features.map(feature=>feature.favorites(context).length),[4,2,31]);assert.equal(selectLibraryFavorites(context).length,37);
  assert.equal(selectLibraryFavorites({...context,activeLibraryId:'d'.repeat(64)}).length,0);
  assert.match(features[1].count(17,catalogs.get('series')),/^17 títulos disponíveis$/);
  assert.equal(features[1].count(17,data('series',17,{complete:true})),'17 títulos');
});

test('manual or Realtime previews, empty replies and older revisions preserve the complete snapshot',t=>{
  const {repository:r,commits}=setup(t),complete=r.commit('movies',data('movies',24,{complete:true,revision:'2026-10-15T13:00:00Z',snapshot:'new'}));
  for(const raw of [data('movies',0,{snapshot:'preview'}),data('movies',4,{snapshot:'preview'}),data('movies',10,{complete:true,snapshot:'old'})])assert.equal(r.commit('movies',raw),complete);
  assert.equal(commits.length,1);assert.equal(r.state('movies').preview.items.length,4);
  const next=r.commit('movies',data('movies',20,{complete:true,revision:'2026-10-15T14:00:00Z',snapshot:'next'}));assert.equal(next.items.length,20);assert.equal(commits.length,2);
  assert.equal(mergeCatalogPage(next,data('movies',0,{snapshot:'future-preview',revision:'2026-10-15T15:00:00Z',pagination:{source:'supabase',snapshotId:'future-preview',snapshotChanged:true}})).items.length,20);
});

test('request epochs isolate types, late refreshes, account changes and adult mode',t=>{
  const f=setup(t),r=f.repository,movie=r.begin('movies'),series=r.begin('series'),newMovie=r.begin('movies');
  assert.equal(r.commit('movies',data('movies',4),{ticket:movie}),null);assert.ok(r.commit('series',data('series',17),{ticket:series}));
  f.setScope({includeAdult:true});assert.equal(r.commit('movies',data('movies',9),{ticket:newMovie}),null);
  const adult=r.begin('movies');f.setAccount();assert.equal(r.commit('movies',data('movies',9),{ticket:adult}),null);
  const current=r.begin('movies');r.reset();assert.equal(r.commit('movies',data('movies',9),{ticket:current}),null);
});

test('a partial refresh may enrich a preview but cannot delete its titles or insert another domain',t=>{
  const {repository:r}=setup(t);r.commit('series',data('series',17));
  r.commit('series',data('series',0,{snapshot:'next-preview',revision:'2026-10-15T14:00:00Z'}));assert.equal(r.state('series').current.items.length,17);
  r.commit('series',data('movies',24,{complete:true}));assert.equal(r.state('series').current.items.length,17);
});

test('a failed update keeps data and its fetched age, with errors scoped to one type',t=>{
  const {repository:r}=setup(t),complete=r.commit('movies',data('movies',24,{complete:true}),{savedAt:1000});r.commit('series',data('series',17));
  const ticket=r.begin('movies');r.finish(ticket,'offline');assert.equal(r.state('movies').current,complete);assert.equal(r.state('movies').savedAt,1000);assert.equal(r.state('movies').error,'offline');assert.equal(r.state('series').error,null);
});

test('older and unversioned complete responses cannot renew the accepted snapshot age',t=>{
  const {repository:r}=setup(t),known=data('movies',24,{complete:true,snapshot:'known',revision:'2026-10-15T14:00:00Z'}),current=r.commit('movies',known,{savedAt:1000});assert.equal(r.acceptedResponse('movies',known),true);
  for(const response of [data('movies',4,{complete:true,revision:'2026-10-15T13:00:00Z'}),data('movies',0,{complete:true,pagination:{mode:'complete',source:'supabase'}})]){
    assert.equal(r.commit('movies',response),current);assert.equal(r.acceptedResponse('movies',response),false);assert.equal(r.state('movies').savedAt,1000);
  }
  const same=data('movies',24,{complete:true,snapshot:'known',revision:'2026-10-15T14:00:00Z'});assert.equal(r.commit('movies',same),current);assert.equal(r.acceptedResponse('movies',same),true);
});

test('an existing complete publication accepts its later read model without renewing daily freshness',t=>{
  const {repository:r,commits}=setup(t),original=data('movies',3,{complete:true}),initial=r.commit('movies',original,{savedAt:1000}),readModel={schemaVersion:1,orders:{name:['1','2','3']}};
  const enriched=r.commit('movies',{...original,readModel});assert.notEqual(enriched,initial);assert.equal(enriched.readModel,readModel);assert.equal(r.state('movies').savedAt,1000);assert.equal(commits.length,2);
  assert.equal(r.commit('movies',original),enriched);assert.equal(r.state('movies').savedAt,1000);
});

test('the production complete-page join preserves publication identity through repository and persistent cache',async t=>{
  const {repository:r}=setup(t),now=Date.parse('2026-10-15T15:00:00Z'),rows=new Map(),storage={async get(key){return structuredClone(rows.get(key));},async put(key,value){rows.set(key,structuredClone(value));}},cache=new CatalogCache({storage,now:()=>now+60000});
  const snapshot='11111111-1111-4111-8111-111111111111',revision='2026-10-15T14:00:00Z',incoming=data('movies',24,{complete:true,snapshot,revision});
  incoming.pagination.total=24;incoming.pagination.expiresAt='2026-10-16T14:00:00Z';
  const current=r.commit('movies',incoming,{savedAt:now});
  assert.equal(current.pagination.source,'supabase');assert.equal(current.pagination.snapshotId,snapshot);assert.equal(current.pagination.revisionAt,revision);assert.equal(current.pagination.total,24);assert.equal(current.pagination.expiresAt,incoming.pagination.expiresAt);
  const cacheScope={...scope,type:'movies'};assert.equal(await cache.write(cacheScope,current,{fetchedAt:now}),true);
  const persisted=await cache.read(cacheScope);assert.equal(persisted.catalog.pagination.source,'supabase');assert.equal(persisted.catalog.pagination.snapshotId,snapshot);assert.equal(persisted.catalog.pagination.revisionAt,new Date(revision).toISOString());
  const older=data('movies',4,{complete:true,snapshot:'22222222-2222-4222-8222-222222222222',revision:'2026-10-15T13:00:00Z'});
  assert.equal(r.commit('movies',older),current);assert.equal(r.acceptedResponse('movies',older),false);assert.equal(r.state('movies').savedAt,now);
  assert.equal(await cache.write(cacheScope,prepare(older),{fetchedAt:now+60000}),false);assert.equal((await cache.read(cacheScope)).savedAt,now);
});

test('Query Core deduplicates concurrent metadata reads and all global dimensions partition its keys',async t=>{
  const {repository:r}=setup(t),ticket=r.begin('movies'),gate=deferred();let calls=0;
  const request=async()=>{calls++;return gate.promise;};const first=r.fetch(ticket,request),second=r.fetch(ticket,request);await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);gate.resolve(data('movies',4));await Promise.all([first,second]);
  const key=catalogQueryKey({...scope,type:'movies'});for(const change of [{project:'https://other.supabase.co'},{providerKey:'d'.repeat(64)},{scopeHash:'d'.repeat(64)},{type:'series'},{includeAdult:true}])assert.notDeepEqual(catalogQueryKey({...scope,type:'movies',...change}),key);
  assert.ok(!key.includes(owner));
});

test('a network reply released after account/scope switch cannot publish into the next account',async t=>{
  const f=setup(t),r=f.repository,gate=deferred(),ticket=r.begin('series');let oldRequests=0;
  const pending=r.fetch(ticket,async()=>{oldRequests++;return gate.promise;}).then(value=>r.commit('series',value,{ticket}));
  const rejected=assert.rejects(pending);await new Promise(resolve=>setImmediate(resolve));assert.equal(oldRequests,1);
  f.setAccount();f.setScope({scopeHash:'d'.repeat(64)});const next=r.begin('series');r.commit('series',data('series',3),{ticket:next});
  gate.resolve(data('series',17));await rejected;assert.equal(r.state('series').current.items.length,3);assert.equal(f.commits.length,1);
});

test('each domain retains its category, genre, sort and display limit without sharing state',()=>{
  const movies=new MoviesFeature(),series=new SeriesFeature(),live=new LiveFeature();movies.capture({category:'__favorites',genre:'Drama',sort:'name',limit:144,defaultPending:false,scrollY:600});series.capture({category:'14',genre:'Comedy',sort:'rating',limit:96,defaultPending:false});
  assert.equal(movies.restore().category,'__favorites');assert.equal(movies.restore().limit,144);assert.equal(series.restore().category,'14');assert.equal(live.restore().category,'__all');series.reset();assert.equal(movies.restore().genre,'Drama');
});

test('progress affects its private projection without invalidating or rebuilding browse domains',()=>{
  const previous={favoriteRecords:[{item_key:'movie:900',updated_at:'1'}],progressRecords:[]},next={...previous,progressRecords:[{item_key:'series:901',episode_id:'1',updated_at:'2',entry:{item:{kind:'series'}}}]},changes=libraryChangeSet(previous,next);
  assert.deepEqual(changes.favorites,[]);assert.deepEqual(changes.progress,['series']);for(const feature of [new MoviesFeature(),new SeriesFeature(),new LiveFeature()])assert.equal(feature.libraryAffectsBrowse(changes),false);
  assert.deepEqual(libraryChangeSet(next,next).progress,[]);
});

test('a terminal bounded preview still makes an empty global search incomplete',()=>{
  const result={items:[],partial:false,partialTypes:[]},catalogs=new Map([['series',data('series',17)]]);
  assert.deepEqual(includePreparingSearch(result,catalogs).partialTypes,['series']);assert.equal(includePreparingSearch(result,catalogs).partial,true);
  catalogs.set('series',data('series',17,{complete:true}));assert.equal(includePreparingSearch(result,catalogs).partial,false);
});
