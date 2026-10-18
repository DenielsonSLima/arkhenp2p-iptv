import test from 'node:test';
import assert from 'node:assert/strict';
import {QueryClient} from '@tanstack/query-core';
import {RemoteSearch} from '../web/remote-search.js';
import {canSearchGlobally,searchCatalogs} from '../web/global-search.js';

const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const response=(query,extra={})=>({schemaVersion:1,query,items:[{id:'10',kind:'movie',name:query}],counts:{live:0,movie:1,series:0},total:1,hasMore:false,nextOffset:null,complete:true,preparing:false,revision:{live:'l1',movies:'m1',series:'s1'},...extra});
function harness(options={}){const calls=[],scope={account:'a',includeAdult:false,hidden:{movies:['7']},hiddenItems:{series:['9']}},controller=new RemoteSearch({loadQueryCore:async()=>({QueryClient}),debounceMs:15,getScope:()=>scope,request:async(path,init)=>{const body=JSON.parse(init.body);calls.push({path,...body,signal:init.signal});return response(body.query);},...options});return {controller,calls,scope};}

test('three normalized characters are required before any catalog access or SDK/request',async()=>{
  let loaded=0;const {controller,calls}=harness({loadQueryCore:async()=>{loaded++;return {QueryClient};}});
  const catalogs=new Proxy({}, {get(){throw new Error('catalog was accessed');}});
  for(const value of ['', 'a','ãb','a\u0301']){assert.equal(canSearchGlobally(value),false);assert.equal(searchCatalogs(catalogs,value).tooShort,true);await controller.search(value);await wait(25);}
  assert.equal(calls.length,0);assert.equal(loaded,0);assert.equal(new RemoteSearch().debounceMs,300);controller.reset();
});

test('debounce replaces earlier input and sends canonical accented query plus private filters',async()=>{
  const {controller,calls}=harness();await controller.search('sao');await controller.search('  SÃO   PAULO ');
  assert.equal(calls.length,0);await wait(40);assert.equal(calls.length,1);assert.equal(calls[0].path,'/api/search');assert.equal(calls[0].query,'sao paulo');assert.deepEqual(calls[0].hidden,{movies:['7']});assert.deepEqual(calls[0].hiddenItems,{series:['9']});assert.equal(calls[0].limit,120);assert.equal(controller.state.data.total,1);controller.reset();
});

test('shortening input cancels a request and ignores late results',async()=>{
  const pending=deferred();let signal;const {controller}=harness({request:async(_,init)=>{signal=init.signal;return pending.promise;}});
  const loading=controller.search('filme',{immediate:true});await wait(0);await controller.search('fi');assert.equal(signal.aborted,true);pending.resolve(response('filme'));await loading;assert.equal(controller.state.phase,'short');assert.equal(controller.state.data,null);controller.reset();
});

test('new input, account change, parental change and logout fence stale responses',async()=>{
  for(const change of ['query','account','adult','logout']){
    const pending=deferred();const {controller,scope}=harness({request:async()=>pending.promise});const loading=controller.search('filme',{immediate:true});await wait(0);
    if(change==='query')await controller.search('serie');else if(change==='account')scope.account='b';else if(change==='adult')scope.includeAdult=true;else controller.reset();
    pending.resolve(response('filme'));await loading;assert.equal(controller.state.data,null,change);controller.reset();
  }
});

test('typing and type filters use isolated short-lived TanStack cache without a catalog dependency',async()=>{
  const {controller,calls}=harness();await controller.search('filme',{immediate:true});await controller.search('filme',{immediate:true});assert.equal(calls.length,1);
  await controller.search('filme',{type:'movies',immediate:true});assert.equal(calls.length,2);assert.equal(calls[1].type,'movies');await controller.refresh();assert.equal(calls.length,3);controller.reset();
});

test('refresh errors preserve results and never become a false empty result',async()=>{
  let fail=false;const {controller}=harness({request:async()=>{if(fail)throw Object.assign(new Error('private provider credentials'),{status:503});return response('filme');}});
  await controller.search('filme',{immediate:true});const previous=controller.state.data;fail=true;await controller.refresh();assert.equal(controller.state.phase,'error');assert.equal(controller.state.data,previous);assert.equal(controller.state.error.includes('credentials'),false);
  await controller.search('serie',{immediate:true});assert.equal(controller.state.data,null);assert.equal(controller.state.phase,'error');controller.reset();
});

test('malformed replies cannot publish counts or partial snapshots',async()=>{
  for(const invalid of [{counts:{live:0,movie:-1,series:0}},{schemaVersion:2},{hasMore:true,nextOffset:0},{items:[{id:'10',kind:'movie'},{id:'10',kind:'movie'}]},{query:'wrong'}]){
    const {controller}=harness({request:async()=>response('filme',invalid)});await controller.search('filme',{immediate:true});assert.equal(controller.state.phase,'error');assert.equal(controller.state.data,null);controller.reset();
  }
});

test('more uses server offset and structural revision equality, preserves previous data on a changed revision',async()=>{
  let calls=0;const offsets=[];const {controller}=harness({request:async(_,init)=>{const body=JSON.parse(init.body);offsets.push(body.offset);calls++;return response('filme',{items:[{id:String(calls),kind:'movie'}],total:4,hasMore:true,nextOffset:body.offset+2,...(calls===3?{revision:{movies:'changed'}}:{})});}});
  await controller.search('filme',{immediate:true});await controller.more();assert.deepEqual(controller.state.data.items.map(item=>item.id),['1','2']);assert.deepEqual(offsets,[0,2]);const previous=controller.state.data;await controller.more();assert.equal(controller.state.data,previous);assert.equal(controller.state.phase,'error');controller.reset();
});

test('cache is bounded and cleared when visibility preferences change',async()=>{
  const {controller,calls,scope}=harness();for(let i=0;i<24;i++)await controller.search(`filme${i}`,{immediate:true});assert.equal(controller.client.getQueryCache().getAll().length,20);
  scope.hidden.movies.push('8');await controller.search('filme23',{immediate:true});assert.equal(calls.length,25);assert.equal(controller.client.getQueryCache().getAll().length,1);controller.reset();assert.equal(controller.client.getQueryCache().getAll().length,0);
});

test('search cancellation and reset preserve a borrowed series cache and its active metadata request',async()=>{
  const {controller}=harness(),client=await controller.queries(),pending=deferred();let seriesSignal;
  const cachedKey=['arkhen-series','details','fixture-account',1,'42'],activeKey=['arkhen-series','details','fixture-account',1,'43'];
  client.setQueryData(cachedKey,{id:'42',kind:'series'});
  const active=client.fetchQuery({queryKey:activeKey,queryFn:({signal})=>{seriesSignal=signal;return pending.promise;}});
  await controller.search('filme',{immediate:true});controller.cancel();assert.equal(seriesSignal.aborted,false);
  controller.reset();assert.equal(seriesSignal.aborted,false);assert.deepEqual(client.getQueryData(cachedKey),{id:'42',kind:'series'});
  assert.equal(client.getQueryCache().getAll().some(query=>query.queryKey[0]==='arkhen-global-search'),false);
  pending.resolve({id:'43',kind:'series'});assert.deepEqual(await active,{id:'43',kind:'series'});client.clear();
});

test('search cache pruning counts only search queries and never evicts a series or another domain',async()=>{
  const {controller}=harness(),client=await controller.queries();
  for(let index=0;index<25;index++)client.setQueryData(['arkhen-series','details','fixture-account',1,String(index)],{id:String(index),kind:'series'});
  client.setQueryData(['other-domain'],{keep:true});
  for(let index=0;index<24;index++)await controller.search('filme'+index,{immediate:true});
  const queries=client.getQueryCache().getAll();assert.equal(queries.filter(query=>query.queryKey[0]==='arkhen-global-search').length,20);
  assert.equal(queries.filter(query=>query.queryKey[0]==='arkhen-series').length,25);assert.deepEqual(client.getQueryData(['other-domain']),{keep:true});
  controller.reset();assert.equal(client.getQueryCache().getAll().length,26);client.clear();
});
