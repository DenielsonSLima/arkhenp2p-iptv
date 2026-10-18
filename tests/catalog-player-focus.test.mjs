import test from 'node:test';
import assert from 'node:assert/strict';
import {QueryClient} from '@tanstack/query-core';
import {CatalogRepository,catalogQueryKey} from '../web/catalog-repository.js';
import {CatalogPager} from '../web/catalog-pagination.js';
import {HomeTVModel} from '../web/inicio/lista-canais/tanstack-query.js';
import {HomeCloudModel} from '../web/inicio/tanstack-query.js';
import {SharedCatalogUpdates} from '../web/sistema/catalogo/realtime.js';
import {MovieSuggestionsView} from '../web/filmes/recomendacoes/visualizacao.js';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const complete={catalogComplete:true,categories:[],items:[],pagination:{mode:'complete'}};
const scope={project:'synthetic',providerKey:'provider',scopeHash:'scope',type:'movies',includeAdult:false};

test('pausing catalog reads aborts pending work while retaining the complete snapshot and query cache',async t=>{
  const repository=new CatalogRepository({getScope:()=>scope,loadQueryCore:async()=>({QueryClient})});
  const gate=deferred();let pending;
  t.after(async()=>{gate.resolve(complete);await pending;repository.reset();repository.queryClient?.unmount();});
  const first=repository.begin('movies'),saved=await repository.fetch(first,async()=>complete);
  repository.commit('movies',saved,{ticket:first});repository.finish(first);
  const ticket=repository.begin('movies');let signal;
  pending=repository.fetch(ticket,options=>{signal=options.signal;return gate.promise;},{force:true}).catch(error=>error);await tick();assert.ok(signal);
  repository.pause();assert.equal(signal.aborted,true);assert.equal(repository.current(ticket),false);
  assert.equal(repository.state('movies').complete,saved);assert.equal(repository.state('movies').loading,false);
  assert.equal(repository.queryClient.getQueryData(catalogQueryKey(scope)),saved);
  gate.resolve({...complete,items:[{kind:'movie',id:'9'}]});assert.equal((await pending).name,'AbortError');
  const resumed=repository.begin('movies');let reads=0;
  assert.equal(await repository.fetch(resumed,async()=>{reads++;return complete;}),saved);assert.equal(reads,0);
});

test('inactive catalog paging and remembered hydration cannot start requests; resuming reads the same snapshot',async()=>{
  let active=false,calls=0;
  const catalog={categories:[{id:'1'}],items:[],itemMap:new Map(),pagination:{mode:'category',byCategory:{1:{loaded:false,nextPage:1,hasMore:true}}}};
  const pager=new CatalogPager({getCatalog:()=>catalog,isActive:()=>active,request:async()=>{calls++;return{categories:[],items:[],pagination:{mode:'category',byCategory:{1:{loaded:true,nextPage:2,hasMore:false}}}};},
    onData:(_type,value)=>Object.assign(catalog,value)});
  await pager.load('movies');await pager.complete('movies');await pager.hydrateRemembered(new Map([['movie:2',{kind:'movie',id:'2'}]]),new Map());
  assert.equal(calls,0);
  active=true;await pager.load('movies');assert.equal(calls,1);assert.equal(catalog.pagination.byCategory[1].hasMore,false);
});

test('a catalog page retired for playback cannot commit or fan out; the visible view can request it again',async()=>{
  let active=true,calls=0,commits=0;const gate=deferred();
  const catalog={categories:[{id:'1'}],items:[],pagination:{mode:'category',byCategory:{1:{loaded:false,nextPage:1,hasMore:true}}}};
  const page={categories:[{id:'1'}],items:[{id:'2',kind:'movie'}],pagination:{mode:'category',byCategory:{1:{loaded:true,nextPage:2,hasMore:false}}}};
  const pager=new CatalogPager({getCatalog:()=>catalog,isActive:()=>active,request:()=>{calls++;return calls===1?gate.promise:Promise.resolve(page);},
    onData:(_type,value)=>{commits++;Object.assign(catalog,value);}});
  const first=pager.load('movies');await tick();active=false;pager.reset();gate.resolve(page);await first;
  assert.equal(commits,0);assert.equal(calls,1);assert.equal(catalog.items.length,0);
  await pager.complete('movies');assert.equal(calls,1);
  active=true;await pager.load('movies');assert.equal(calls,2);assert.equal(commits,1);assert.equal(catalog.items[0].id,'2');
});

test('Home pause aborts invisible RPC work without losing its snapshot or creating an error/retry loop',async t=>{
  let active=true,revision=1,handler,signal,calls=0;
  const reply=name=>({schemaVersion:1,counts:{},favoriteChannels:[],history:{live:[],movie:[],series:[]},recommendations:{items:[{id:'2',kind:'movie',name}]}});
  const gate=deferred(),model=new HomeCloudModel({getScope:()=>({account:'synthetic',epoch:1}),getRevision:()=>revision,isActive:()=>active,
    now:()=>100000,loadQueryCore:async()=>({QueryClient}),request:(_path,options)=>{calls++;signal=options.signal;return handler();}});
  t.after(()=>{gate.resolve(reply('late'));model.dispose();});
  handler=async()=>reply('saved');model.ensure();await tick();const saved=model.state.data;assert.ok(saved);
  handler=()=>gate.promise;revision=2;model.ensure({force:true});await tick();active=false;model.pause();
  assert.equal(signal.aborted,true);assert.equal(model.state.data,saved);assert.equal(model.state.loading,false);
  gate.resolve(reply('late'));await tick();assert.equal(model.state.data,saved);assert.equal(model.state.error,null);assert.equal(model.timer,null);
  for(let i=0;i<10;i++)model.ensure({force:true});assert.equal(calls,2);
  active=true;handler=async()=>reply('returned');model.ensure({force:true});await tick();assert.equal(model.state.data.recommendations.items[0].name,'returned');
});

test('Home TV pause preserves cards and cooldown, discards late replies and can resume without resetting account state',async t=>{
  let active=true,handler=async()=>({marker:'saved',items:[]}),signal;
  const model=new HomeTVModel({services:{home:(_scope,options)=>{signal=options.signal;return handler();}},getScope:()=>({account:'synthetic',epoch:1}),
    isActive:()=>active,loadQueryCore:async()=>({QueryClient}),now:()=>100000});
  const gate=deferred();t.after(()=>{gate.resolve({items:[]});model.dispose();});
  await model.ensure();const saved=model.state.data;model.cooldownUntil=110000;
  handler=()=>gate.promise;model.cooldownUntil=0;const pending=model.ensure({force:true});await tick();
  model.cooldownUntil=110000;active=false;model.pause();
  assert.equal(signal.aborted,true);assert.equal(model.state.data,saved);assert.equal(model.state.loading,false);assert.equal(model.cooldownUntil,110000);
  gate.resolve({marker:'late',items:[]});await pending;assert.equal(model.state.data,saved);
  active=true;handler=async()=>({marker:'returned',items:[]});await model.ensure({force:true});assert.equal(model.state.data.marker,'returned');
});

test('publication interrupted by inactive screen stays pending without spending the outage retry budget',async()=>{
  let active=true;const timers=new Map(),gate=deferred();let serial=0,calls=0;
  const updates=new SharedCatalogUpdates({reload:()=>{calls++;return calls===1?gate.promise:true;},isConnected:()=>true,isActive:()=>active,
    schedule:callback=>{const id=++serial;timers.set(id,callback);return id;},cancel:id=>timers.delete(id)});
  const drain=async()=>{const jobs=[...timers.values()];timers.clear();jobs.forEach(job=>job());await tick();};
  updates.notify('movies',{revision:'revision-2'});await drain();active=false;gate.resolve(null);await tick();
  assert.equal(timers.size,0);assert.equal(updates.retryCounts.get('movies')||0,0);assert.equal(updates.pending.has('movies'),true);
  active=true;updates.resume();await drain();assert.equal(calls,2);updates.reset();
});

test('hidden movie preview never recovers while the visible movie end panel remains eligible',()=>{
  let preview=0,end=0;
  const view={preview:{isConnected:true,ownerDocument:{hidden:false},closest:()=>({hidden:true})},previewSession:{recover:()=>{preview++;return true;}},
    validEnd:()=>true,end:{hidden:false},endSession:{recover:()=>{end++;return true;}}};
  assert.equal(MovieSuggestionsView.prototype.recover.call(view),true);assert.equal(preview,0);assert.equal(end,1);
});
