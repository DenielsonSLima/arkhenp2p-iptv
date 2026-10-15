import test from 'node:test';
import assert from 'node:assert/strict';
import {CatalogPager,mergeCatalogPage} from '../web/catalog-pagination.js';
import {isPreparingCatalog,completeCatalogForSession} from '../web/catalog-loading-policy.js';

function fixture(source){
  let data={categories:[{id:'1',name:'Drama',ids:new Set(['1'])}],items:[],pagination:{mode:'category',...(source?{source,snapshotId:'revision',globalCategory:'__all'}:{}),byCategory:{[source?'__all':'1']:{loaded:true,nextPage:2,hasMore:true,nextCursor:0}}}},calls=[];
  const pager=new CatalogPager({getCatalog:()=>data,onData:(_type,value)=>{data=mergeCatalogPage(data,value);},request:async url=>{calls.push(url);return {...data,items:[{id:'2',name:'Next title',kind:'movie'}],pagination:{...data.pagination,complete:true,byCategory:{[source?'__all':'1']:{loaded:true,nextPage:3,hasMore:false,nextCursor:1}}}};}});
  return {pager,calls,get data(){return data;}};
}
test('a cloud session never starts an upstream fallback import, including repeated startup/search/manual completion requests',async()=>{
  const f=fixture();assert.equal(isPreparingCatalog(f.data,{cloudReady:true}),true);
  await Promise.all(Array.from({length:20},()=>completeCatalogForSession(f.pager,'movies',f.data,{cloudReady:true})));
  assert.equal(f.calls.length,0);assert.equal(f.pager.progressFor('movies'),null);
  await f.pager.load('movies');assert.equal(f.calls.length,1);assert.equal(f.data.items[0].id,'2');
});
test('published Supabase pages may complete in the browser and local-only fallback preserves its earlier completion behavior',async()=>{
  for(const [source,cloudReady]of [['supabase',true],[undefined,false]]){const f=fixture(source),result=await completeCatalogForSession(f.pager,'movies',f.data,{cloudReady});assert.equal(result.status,'complete');assert.equal(f.calls.length,1);assert.equal(isPreparingCatalog(f.data,{cloudReady}),false);}
});
