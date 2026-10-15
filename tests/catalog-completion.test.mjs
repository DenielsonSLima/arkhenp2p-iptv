import test from 'node:test';
import assert from 'node:assert/strict';
import { CatalogPager } from '../web/catalog-pagination.js';
import { searchCatalogs } from '../web/global-search.js';

const deferred = () => {let resolve; const promise=new Promise(yes => {resolve=yes;}); return {promise,resolve};};
const tick = () => new Promise(resolve => setImmediate(resolve));
const source = ids => ({
  sourceCategories:ids.map(id => ({id,name:`Categoria ${id}`})),
  categories:ids.map(id => ({id,ids:new Set([id])})), items:[],
  pagination:{mode:'category',byCategory:Object.fromEntries(ids.map(id => [id,{loaded:false,nextPage:1,hasMore:true}]))}
});
const pageFrom = url => {
  const params=new URL(url,'http://localhost').searchParams;
  return {type:params.get('type'),id:params.get('category'),page:Number(params.get('page'))};
};
const response = (id,page,hasMore=true) => ({
  categories:[],items:hasMore?[{id:`${id}-${page}`,name:`Título ${id} ${page}`}]:[],
  pagination:{mode:'category',byCategory:{[id]:{loaded:true,nextPage:page+1,hasMore}}}
});
const fixture = ({catalogs=new Map([['movies',source(['1','2'])]]),request,...options}={}) => {
  const calls=[],updates=[];
  const pager=new CatalogPager({
    getCatalog:type => catalogs.get(type),
    request:(url,options) => {calls.push(pageFrom(url)); return request(url,options);},
    onData:(type,data) => {
      data.sourceCategories=data.categories;
      data.categories=data.categories.map(group => ({...group,ids:new Set([group.id])}));
      catalogs.set(type,data);
    },
    onProgress:(type,progress) => updates.push({type,...progress}),
    ...options
  });
  return {pager,catalogs,calls,updates};
};

test('completion loads every category and page automatically, including hidden categories, then uses the cache', async () => {
  const ids=Array.from({length:7},(_,index) => String(index+1));
  const f=fixture({catalogs:new Map([['movies',source(ids)]]),isCategoryAllowed:() => false,request:async url => {
    const {id,page}=pageFrom(url); return response(id,page,page<=9);
  }});
  const done=await f.pager.complete('movies');
  assert.equal(done.status,'complete');
  assert.equal(done.categoriesTotal,7); assert.equal(done.categoriesComplete,7);
  assert.equal(done.pagesLoaded,70); assert.equal(done.itemsLoaded,63);
  assert.equal(f.calls.length,70);
  assert.equal('pagesTotal' in done,false);
  assert.deepEqual(done.failedCategories,[]);
  assert.equal(f.updates.at(-1).status,'complete');
  assert.equal(f.updates.filter(update => update.status==='loading').every(update => update.categoriesComplete<=update.categoriesTotal),true);
  await f.pager.complete('movies');
  assert.equal(f.calls.length,70);
  assert.equal(f.pager.progressFor('movies').status,'complete');
});

test('movies, series and interactive loads share a global request ceiling and overlapping pages are deduplicated', async () => {
  let active=0,peak=0;
  const f=fixture({catalogs:new Map([['movies',source(['1','2','3','4','5'])],['series',source(['6','7','8','9','10'])]]),request:async url => {
    const {id,page}=pageFrom(url); active++; peak=Math.max(peak,active);
    await tick(); active--; return response(id,page,page===1);
  }});
  const tasks=[f.pager.load('movies'),f.pager.complete('movies',{concurrency:4}),f.pager.complete('movies'),f.pager.complete('series',{concurrency:4})];
  const results=await Promise.all(tasks);
  assert.equal(results.slice(1).every(result => result.status==='complete'),true);
  assert.equal(peak,4);
  const keys=f.calls.map(call => `${call.type}:${call.id}:${call.page}`);
  assert.equal(new Set(keys).size,keys.length);
  assert.equal(f.calls.length,20);
});

test('automatic movie and series completion makes late titles in unvisited categories searchable without navigation', async () => {
  const movies=source(['1','99']);
  movies.items=[{id:'initial',name:'Título inicial',kind:'movie'}];
  movies.pagination.byCategory['1']={loaded:true,nextPage:2,hasMore:false};
  const f=fixture({catalogs:new Map([['live',{items:[]}],['movies',movies],['series',source(['77'])]]),request:async url => {
    const {id,page,type}=pageFrom(url),hasMore=page<=3,answer=response(id,page,hasMore);
    if (hasMore) answer.items[0].name=page===3?'Órbita Distante'+(type==='series'?' · A série':''):`Outro título ${page}`;
    return answer;
  }});
  const before=searchCatalogs(f.catalogs,'orbita distante');
  assert.equal(before.partial,true); assert.equal(before.items.length,0);
  await Promise.all([f.pager.complete('movies'),f.pager.complete('series')]);
  const after=searchCatalogs(f.catalogs,'  ÓRBITA  distante ');
  assert.equal(after.partial,false);
  assert.deepEqual(after.items.map(item => item.id),['99-3','77-3']);
  assert.deepEqual(after.counts,{live:0,movie:1,series:1});
  assert.equal(f.calls.some(call => call.type==='movies' && call.id==='99' && call.page===3),true);
  assert.equal(f.calls.some(call => call.type==='series' && call.id==='77' && call.page===3),true);
});

test('remembered metadata hydration shares the completion concurrency budget', async () => {
  let active=0,peak=0;
  const f=fixture({catalogs:new Map([['movies',source(['1','2','3'])],['series',source(['4','5','6'])]]),request:async url => {
    active++; peak=Math.max(peak,active); await tick(); active--;
    if (url.startsWith('/api/details')) return {name:'Título lembrado'};
    const {id,page}=pageFrom(url); return response(id,page,false);
  }});
  const favorites=new Map(Array.from({length:6},(_,index) => [String(index),{id:String(100+index),kind:'movie',name:'Lembrado'}]));
  await Promise.all([f.pager.complete('movies'),f.pager.complete('series'),f.pager.hydrateRemembered(favorites,new Map())]);
  assert.equal(peak,4);
  assert.equal(f.pager.progressFor('movies').status,'complete');
  assert.equal(f.pager.progressFor('series').status,'complete');
  assert.equal(f.catalogs.get('movies').items.filter(item => item.name==='Título lembrado').length,6);
});

test('reset also aborts remembered metadata requests and releases their shared request slots', async () => {
  const started=deferred(); let aborted=0;
  const f=fixture({catalogs:new Map([['movies',source(['1'])]]),request:async (url,{signal}) => {
    started.resolve();
    return new Promise((resolve,reject) => signal.addEventListener('abort',() => {aborted++; reject(new DOMException('cancelled','AbortError'));},{once:true}));
  }});
  const hydrated=f.pager.hydrateRemembered(new Map([['100',{id:'100',kind:'movie'}]]),new Map());
  await started.promise; f.pager.reset('movies'); await hydrated;
  assert.equal(aborted,1); assert.equal(f.pager.activeRequests,0); assert.equal(f.pager.metadataPending.size,0);
  assert.equal(f.catalogs.get('movies').items.length,0);
});

test('transient errors retry automatically but a persistent error remains partial until a later retry succeeds', async () => {
  const failures=new Map(); let recover=false;
  const f=fixture({request:async url => {
    const {id,page}=pageFrom(url),key=`${id}:${page}`;
    failures.set(key,(failures.get(key)||0)+1);
    if (id==='1' && failures.get(key)===1 || id==='2' && !recover) throw new Error('Serviço indisponível');
    return response(id,page,false);
  }});
  const partial=await f.pager.complete('movies');
  assert.equal(partial.status,'partial');
  assert.equal(partial.categoriesComplete,1);
  assert.deepEqual(partial.failedCategories,[{id:'2',error:'Serviço indisponível'}]);
  assert.equal(failures.get('1:1'),2); assert.equal(failures.get('2:1'),2);
  assert.equal(f.pager.errorFor('movies','2'),'Serviço indisponível');
  recover=true;
  const done=await f.pager.complete('movies');
  assert.equal(done.status,'complete'); assert.equal(done.categoriesComplete,2);
  assert.equal(failures.get('1:1'),2); assert.equal(failures.get('2:1'),3);
});

test('a provider page that never advances cannot create an infinite completion loop or a false success', async () => {
  const data=source(['1']);
  const f=fixture({catalogs:new Map([['movies',data]]),request:async () => ({categories:[],items:[],pagination:data.pagination})});
  const done=await f.pager.complete('movies');
  assert.equal(done.status,'partial');
  assert.equal(done.categoriesComplete,0); assert.equal(done.pagesLoaded,0);
  assert.equal(f.calls.length,2);
  assert.match(done.error,/não avançou/);
});

test('a malformed page missing pagination cannot erase partial state or report the catalog complete', async () => {
  const f=fixture({catalogs:new Map([['movies',source(['1'])]]),request:async () => ({categories:[],items:[{id:'10',name:'Preservado'}]})});
  const done=await f.pager.complete('movies');
  assert.equal(done.status,'partial'); assert.equal(done.itemsLoaded,1);
  assert.equal(f.calls.length,2); assert.equal(f.catalogs.get('movies').pagination.mode,'category');
  assert.equal(f.catalogs.get('movies').pagination.byCategory['1'].hasMore,true);
});

test('a shared snapshot arriving during first-load pagination completes all categories and cannot revive removed titles',async()=>{
  const first=deferred(),late=deferred(),catalogs=new Map([['movies',source(['1','2','3','4','5'])]]);
  catalogs.get('movies').items=[{id:'old',name:'Removido'}];
  const f=fixture({catalogs,request:url=>{
    const {id}=pageFrom(url);return id==='1'?first.promise:late.promise;
  }});
  const completion=f.pager.complete('movies',{concurrency:3});await tick();assert.equal(f.calls.length,3);
  first.resolve({catalogComplete:true,categories:[{id:'1',name:'Novidades'},{id:'2',name:'Drama'}],items:[{id:'current',name:'Atual',kind:'movie',categoryId:'1'}]});
  await tick();assert.deepEqual(f.catalogs.get('movies').items.map(item=>item.id),['current']);
  late.resolve({categories:[{id:'5',name:'Antiga'}],items:[{id:'old',name:'Removido'}],pagination:{mode:'category',byCategory:{2:{loaded:true,nextPage:2,hasMore:true},3:{loaded:true,nextPage:2,hasMore:true}}}});
  const done=await completion;
  assert.equal(done.status,'complete');assert.equal(done.categoriesTotal,2);assert.equal(done.categoriesComplete,2);
  assert.deepEqual(done.failedCategories,[]);assert.equal(f.calls.length,3,'No remaining category or retry downloads the whole snapshot again.');
  assert.deepEqual(f.catalogs.get('movies').items.map(item=>item.id),['current']);
  assert.deepEqual(Object.keys(f.catalogs.get('movies').pagination.byCategory),['1','2']);
});

test('a category request failing after an authoritative shared snapshot does not mark the catalog partial',async()=>{
  const first=deferred();let rejectLate;const late=new Promise((_,reject)=>{rejectLate=reject;});
  const f=fixture({catalogs:new Map([['movies',source(['1','2'])]]),request:url=>pageFrom(url).id==='1'?first.promise:late});
  const completion=f.pager.complete('movies',{concurrency:2});await tick();
  first.resolve({catalogComplete:true,categories:[{id:'1',name:'Atual'}],items:[]});await tick();rejectLate(new Error('old page failed'));
  const done=await completion;assert.equal(done.status,'complete');assert.deepEqual(done.failedCategories,[]);assert.equal(f.calls.length,2);assert.deepEqual(f.catalogs.get('movies').items,[]);
});

test('cancelling the only completion aborts its requests and preserves already loaded titles', async () => {
  const started=deferred(); let aborted=0;
  const f=fixture({catalogs:new Map([['movies',source(['1'])]]),request:async (url,{signal}) => {
    const {id,page}=pageFrom(url);
    if (page===1) return response(id,page);
    started.resolve();
    return new Promise((resolve,reject) => signal.addEventListener('abort',() => {aborted++; reject(new DOMException('cancelled','AbortError'));},{once:true}));
  }});
  const controller=new AbortController(),pending=f.pager.complete('movies',{signal:controller.signal});
  await started.promise; controller.abort();
  assert.equal((await pending).status,'cancelled');
  await tick();
  assert.equal(aborted,1); assert.equal(f.calls.length,2);
  assert.equal(f.catalogs.get('movies').items.length,1);
  assert.equal(f.pager.progressFor('movies').status,'cancelled');
});

test('cancelling one completion consumer does not interrupt the other consumer or its shared requests', async () => {
  const started=deferred(),answer=deferred(); let aborted=false;
  const f=fixture({catalogs:new Map([['movies',source(['1'])]]),request:async (url,{signal}) => {
    signal.addEventListener('abort',() => {aborted=true;},{once:true}); started.resolve(); return answer.promise;
  }});
  const controller=new AbortController();
  const first=f.pager.complete('movies',{signal:controller.signal}),second=f.pager.complete('movies');
  await started.promise; controller.abort();
  assert.equal((await first).status,'cancelled'); assert.equal(aborted,false);
  answer.resolve(response('1',1,false));
  assert.equal((await second).status,'complete'); assert.equal(f.calls.length,1);
});

test('an interactive subscriber retains a shared page when background completion is cancelled', async () => {
  const started=deferred(),answer=deferred(); let aborted=false;
  const f=fixture({catalogs:new Map([['movies',source(['1'])]]),request:async (url,{signal}) => {
    signal.addEventListener('abort',() => {aborted=true;},{once:true}); started.resolve(); return answer.promise;
  }});
  const controller=new AbortController(),completion=f.pager.complete('movies',{signal:controller.signal});
  await started.promise;
  const interactive=f.pager.load('movies','1'); controller.abort();
  assert.equal((await completion).status,'cancelled'); assert.equal(aborted,false);
  answer.resolve(response('1',1,false)); await interactive;
  assert.equal(f.calls.length,1); assert.equal(f.catalogs.get('movies').pagination.byCategory['1'].hasMore,false);
});

test('reset cancels old work, discards delayed responses and progress, and permits a new catalog generation', async () => {
  const started=deferred(),answer=deferred(); let useOld=true;
  const f=fixture({catalogs:new Map([['movies',source(['1'])]]),request:async url => {
    const {id,page}=pageFrom(url);
    if (useOld) {started.resolve(); return answer.promise;}
    return response(id,page,false);
  }});
  const old=f.pager.complete('movies'); await started.promise;
  f.pager.reset('movies'); useOld=false; f.catalogs.set('movies',source(['2']));
  const done=await f.pager.complete('movies');
  assert.equal(done.status,'complete'); assert.equal(done.categoriesTotal,1);
  const updates=f.updates.length;
  answer.resolve(response('1',1));
  assert.equal((await old).status,'cancelled'); await tick();
  assert.deepEqual(Object.keys(f.catalogs.get('movies').pagination.byCategory),['2']);
  assert.equal(f.catalogs.get('movies').items.some(item => item.id==='1-1'),false);
  assert.equal(f.updates.length,updates);
  assert.equal(f.pager.progressFor('movies').status,'complete');
});

test('missing snapshots remain partial while complete nonpaged catalogs require no extra requests', async () => {
  const f=fixture({catalogs:new Map([['live',{items:[{id:'1',name:'Canal'}]}]]),request:() => assert.fail('No pagination request is needed')});
  const missing=await f.pager.complete('movies');
  assert.equal(missing.status,'partial'); assert.match(missing.error,/não foi carregado/);
  const live=await f.pager.complete('live');
  assert.equal(live.status,'complete'); assert.equal(live.itemsLoaded,1);
});
