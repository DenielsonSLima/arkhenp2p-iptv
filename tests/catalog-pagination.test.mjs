import test from 'node:test';
import assert from 'node:assert/strict';
import { CatalogPager, mergeCatalogPage, pageChoices, rememberedTitles } from '../web/catalog-pagination.js';

const catalog = () => ({
  sourceCategories:[{id:'1',name:'Ação'},{id:'2',name:'Drama'}],
  categories:[{id:'acao',ids:new Set(['1'])},{id:'drama',ids:new Set(['2'])}],
  items:[{id:'10',name:'Primeiro',categoryId:'1'}],itemMap:new Map([['10',{id:'10'}]]),
  pagination:{mode:'category',byCategory:{1:{loaded:true,nextPage:2,hasMore:true},2:{loaded:false,nextPage:1,hasMore:true}}}
});
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => {resolve=yes;reject=no;}); return {promise,resolve,reject}; };

test('unvisited categories load first, selected categories fetch independently, custom groups do not fetch',()=>{
  const data=catalog();
  assert.deepEqual(pageChoices(data).map(page=>[page.id,page.nextPage]),[['2',1],['1',2]]);
  assert.deepEqual(pageChoices(data,'acao',true),[]);
  assert.deepEqual(pageChoices(data,'drama',true).map(page=>page.id),['2']);
  assert.deepEqual(pageChoices(data,'__favorites'),[]);
  assert.deepEqual(pageChoices(data,'custom:personal'),[]);
});

test('out of order snapshots retain titles, category memberships and completed pages',()=>{
  const first=mergeCatalogPage(catalog(),{categories:[],items:[{id:'10',name:'Primeiro',categoryId:'2'},{id:'20',name:'Segundo',categoryId:'2'}],pagination:{mode:'category',byCategory:{1:{loaded:true,nextPage:3,hasMore:false},2:{loaded:true,nextPage:2,hasMore:true}}}});
  const merged=mergeCatalogPage({...first,sourceCategories:first.categories},{categories:[],items:[{id:'30',name:'Terceiro',categoryId:'1'}],pagination:{mode:'category',byCategory:{1:{loaded:true,nextPage:2,hasMore:true},2:{loaded:false,nextPage:1,hasMore:true}}}});
  assert.deepEqual(merged.items.map(item=>item.id),['10','20','30']);
  assert.deepEqual(merged.items[0].categoryIds,['1','2']);
  assert.equal(merged.pagination.byCategory['1'].hasMore,false);
  assert.equal(merged.pagination.byCategory['2'].nextPage,2);
  assert.equal(merged.categories.length,2);
});

test('an explicitly complete shared snapshot replaces partial titles and ignores stale category pages',()=>{
  const incoming={catalogComplete:true,categories:[{id:'3',name:'Novidades'}],items:[{id:'30',name:'Título atual',categoryId:'3'}]};
  const complete=mergeCatalogPage(catalog(),incoming);
  assert.deepEqual(complete.items,incoming.items);assert.deepEqual(complete.categories,incoming.categories);
  assert.equal(complete.pagination.mode,'complete');assert.deepEqual(pageChoices(complete),[]);
  assert.deepEqual(complete.pagination.byCategory,{'3':{loaded:true,nextPage:1,hasMore:false}});
  const stale=mergeCatalogPage(complete,{categories:[{id:'1',name:'Ação'}],items:[{id:'10',name:'Removido'}],pagination:catalog().pagination});
  assert.equal(stale,complete);assert.deepEqual(stale.items.map(item=>item.id),['30']);
  const prepared={...complete,sourceCategories:complete.categories,categories:[{id:'novidades',ids:new Set(['3']),name:'Novidades'}]};
  const preserved=mergeCatalogPage(prepared,{categories:[],items:[{id:'10',name:'Removido'}]});
  assert.deepEqual(preserved.categories,incoming.categories,'The app receives original source IDs when it normalizes a preserved snapshot again.');
  assert.deepEqual(preserved.items,incoming.items);
  assert.equal(mergeCatalogPage(complete,{...incoming,items:[]}).items.length,0,'An explicitly complete empty replacement also removes old titles.');
});

test('page failures retain a retryable error and overlapping requests are deduplicated',async()=>{
  const request=deferred();let calls=0;const pager=new CatalogPager({getCatalog:catalog,request:()=>{calls++;return request.promise;},onData:()=>assert.fail('Failed page cannot replace catalog'),onChange:()=>{}});
  const first=pager.load('movies','drama'),second=pager.load('movies','drama');await Promise.resolve();assert.equal(calls,1);assert.equal(pager.pendingFor('movies','drama'),true);
  request.reject(new Error('Serviço indisponível'));await Promise.all([first,second]);
  assert.equal(pager.pendingFor('movies','drama'),false);assert.equal(pager.errorFor('movies','drama'),'Serviço indisponível');
});

test('reset prevents pending results from a previous login or refresh from entering the catalog',async()=>{
  const request=deferred();let replacements=0;const pager=new CatalogPager({getCatalog:catalog,request:()=>request.promise,onData:()=>replacements++,onChange:()=>{}});
  const pending=pager.load('movies','drama');await Promise.resolve();pager.reset();
  request.resolve({categories:[],items:[{id:'99',name:'Antigo'}],pagination:catalog().pagination});await pending;
  assert.equal(replacements,0);assert.equal(pager.pending.size,0);
});

test('explore more respects hidden categories and limits each action to four pages',async()=>{
  const data=catalog();
  for(let id=3;id<=12;id++)data.pagination.byCategory[id]={loaded:false,nextPage:1,hasMore:true};
  const calls=[];const pager=new CatalogPager({getCatalog:()=>data,isCategoryAllowed:(_,id)=>id!=='2',request:async url=>{calls.push(url);return{categories:[],items:[],pagination:data.pagination};},onData:()=>{},onChange:()=>{}});
  await pager.load('movies');
  assert.equal(calls.length,4);assert.equal(calls.some(url=>new URL(url,'http://localhost').searchParams.get('category')==='2'),false);
});

test('remembered hydration is bounded, deduplicates history and favorites, and skips already loaded or invalid titles',()=>{
  const favorites=new Map([['a',{id:'20',kind:'movie'}],['b',{id:'30',kind:'movie'}],['invalid',{id:'https://example.org',kind:'movie'}]]);
  const history=new Map([['a',{updated:2,item:{id:'20',kind:'movie'}}],['b',{updated:1,item:{id:'10',kind:'movie'}}]]);
  assert.deepEqual(rememberedTitles(catalog,favorites,history,1),[{id:'20',kind:'movie'}]);
  assert.deepEqual(rememberedTitles(catalog,favorites,history,16).map(item=>item.id),['20','30']);
});

test('remembered hydration uses only fresh artwork and a missing cover cannot revive an old reference',async()=>{
  const favorites=new Map([
    ['missing',{id:'20',kind:'movie',name:'Sem capa',poster:'/api/image?ref=previous-login',backdrop:'/api/image?ref=previous-scene'}],
    ['fresh',{id:'30',kind:'movie',name:'Capa atual',poster:'/api/image?ref=previous-login'}]
  ]);
  const hydrated=[];
  const pager=new CatalogPager({getCatalog:catalog,request:async url=>url.endsWith('id=20')?{name:'Sem capa'}:{name:'Capa atual',poster:'/api/image?ref=current-login'},onData:(_,data)=>hydrated.push(...data.items.filter(item=>item.id!=='10')),onChange:()=>{}});
  await pager.hydrateRemembered(favorites,new Map());
  assert.equal(hydrated.find(item=>item.id==='20').poster,'');
  assert.equal(hydrated.find(item=>item.id==='20').backdrop,'');
  assert.equal(hydrated.find(item=>item.id==='30').poster,'/api/image?ref=current-login');
  assert.equal(favorites.get('missing').poster,'/api/image?ref=previous-login');
});

test('a failed remembered series does not clear the catalog or prevent other history from hydrating',async()=>{
  const favorites=new Map([['series',{id:'309206683028',kind:'series',name:'Indisponível'}],['movie',{id:'30',kind:'movie',name:'Disponível'}]]),changes=[];
  const pager=new CatalogPager({getCatalog:catalog,request:async url=>{if(url.includes('type=series'))throw new Error('HTTP 502');return {name:'Disponível',poster:'/api/image?ref=fresh'};},onData:(type,data)=>changes.push({type,data}),onChange:()=>{}});
  await pager.hydrateRemembered(favorites,new Map());
  assert.equal(changes.length,1);assert.equal(changes[0].type,'movies');
  assert.deepEqual(changes[0].data.items.map(item=>item.id),['10','30']);
});

const sharedPage=(snapshotId,ids,{page=1,cursor=120,complete=false,changed=false}={})=>({
  categories:[{id:'1',name:'Ação'}],items:ids.map(id=>({id,name:'Filme '+id,categoryId:'1'})),
  pagination:{mode:'category',source:'supabase',snapshotId,snapshotChanged:changed,globalCategory:'__all',complete,byCategory:{'1':{loaded:false,nextPage:1,nextCursor:-1,hasMore:true},__all:{loaded:true,nextPage:page+1,nextCursor:cursor,hasMore:!complete}}}
});

test('shared keyset completion uses one global stream and preserves every page on terminal delivery',async()=>{
  let data=sharedPage('revision-a',['10']);const calls=[];
  const pager=new CatalogPager({getCatalog:()=>data,request:async path=>{
    const query=new URL(path,'http://localhost').searchParams;calls.push(query);
    return sharedPage('revision-a',['20'],{page:2,cursor:240,complete:true});
  },onData:(_,incoming)=>{data=incoming;}});
  assert.deepEqual(pageChoices(data).map(choice=>choice.id),['__all']);
  const done=await pager.complete('movies');assert.equal(done.status,'complete');assert.equal(calls.length,1);
  assert.equal(calls[0].get('snapshot'),'revision-a');assert.equal(calls[0].get('cursor'),'120');assert.equal(calls[0].get('paged'),'1');
  assert.deepEqual(data.items.map(item=>item.id),['10','20']);assert.equal(data.catalogComplete,true);assert.deepEqual(pageChoices(data),[]);
});

test('a newly committed shared revision replaces old partial titles and ignores late responses from its predecessor',async()=>{
  const old=sharedPage('revision-a',['removed'],{page:4,cursor:480});
  const next=sharedPage('revision-b',['new'],{changed:true});
  const replaced=mergeCatalogPage(old,next);assert.deepEqual(replaced.items.map(item=>item.id),['new']);
  const stale=mergeCatalogPage(replaced,sharedPage('revision-a',['removed-again'],{page:5,cursor:600}));
  assert.deepEqual(stale.items.map(item=>item.id),['new']);assert.equal(stale.pagination.snapshotId,'revision-b');
});

test('a snapshot rollover restarts completion at its new cursor without reporting a stalled page',async()=>{
  let data=sharedPage('revision-a',['removed'],{page:4,cursor:480}),requests=0;
  const pager=new CatalogPager({getCatalog:()=>data,request:async()=>++requests===1?sharedPage('revision-b',['new-1'],{changed:true}):sharedPage('revision-b',['new-2'],{page:2,cursor:240,complete:true}),onData:(_,incoming)=>{data=incoming;}});
  assert.equal((await pager.complete('movies')).status,'complete');assert.equal(requests,2);assert.deepEqual(data.items.map(item=>item.id),['new-1','new-2']);
});
