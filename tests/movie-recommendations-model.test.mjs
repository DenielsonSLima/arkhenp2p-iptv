import test from 'node:test';
import assert from 'node:assert/strict';
import {QueryClient} from '@tanstack/query-core';
import {MovieRecommendationsModel} from '../web/filmes/tanstack-query.js';
import {MovieSuggestionSession} from '../web/filmes/recomendacoes/sessao.js';
const movie={id:'10',kind:'movie',name:'Filme'},entry=id=>({id:String(id),kind:'movie',name:'Sugestão '+id});
const response=(sourceId='10')=>({schemaVersion:1,rankingVersion:2,identityVersion:2,source:'rpc',sourceId,revision:'catalog',revisionLibrary:null,personalized:true,items:[entry(9),entry(2),entry(7),entry(5)]});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,options={}){
  let scope={account:'A',project:'fixed',providerKey:'p',scopeHash:'s',hidden:{},hiddenItems:{}},revision=1;const calls=[];
  const model=new MovieRecommendationsModel({request:async(path,options)=>{calls.push({path,...options});return response();},getScope:()=>scope,getRevision:()=>revision,loadQueryCore:async()=>({QueryClient}),...options});
  t.after(()=>model.dispose());return {model,calls,setScope:value=>{scope=value;},setRevision:value=>{revision=value;}};
}
test('preview and end screen share server ranking, preserve order and only vary presentation size',async t=>{
  const f=fixture(t),[preview,end]=await Promise.all([f.model.lookup(movie,{limit:10}),f.model.lookup(movie,{limit:3})]);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].path,'/api/recommendations/movie');assert.equal(JSON.parse(f.calls[0].body).limit,10);
  assert.deepEqual(preview.items.map(item=>item.id),['9','2','7','5']);assert.deepEqual(end.items.map(item=>item.id),['9','2','7']);
  await f.model.lookup(movie);assert.equal(f.calls.length,1);
  await f.model.lookup(movie,{force:true});assert.equal(f.calls.length,2);
});
test('canceling one destination does not abort another destination sharing its RPC',async t=>{
  let release,requestSignal;const f=fixture(t,{request:async(_path,{signal})=>{requestSignal=signal;return new Promise(resolve=>{release=resolve;});}}),controller=new AbortController();
  const first=f.model.lookup(movie,{signal:controller.signal}),second=f.model.lookup(movie);
  await tick();controller.abort();await assert.rejects(first,{name:'AbortError'});assert.equal(requestSignal.aborted,false);
  release(response());assert.equal((await second).items.length,4);
});
test('last canceled destination aborts HTTP and cannot poison a later lookup',async t=>{
  const pending=[];const f=fixture(t,{request:async(_path,{signal})=>new Promise(resolve=>pending.push({signal,resolve}))}),controller=new AbortController();
  const old=f.model.lookup(movie,{signal:controller.signal});await tick();controller.abort();await assert.rejects(old,{name:'AbortError'});assert.equal(pending[0].signal.aborted,true);
  const next=f.model.lookup(movie);await tick();pending[0].resolve(response());pending[1].resolve(response());assert.equal((await next).items[0].id,'9');
});
test('scope changes cancel stale responses and separate account, filters and library revisions',async t=>{
  const pending=[];const f=fixture(t,{request:async(_path,options)=>new Promise(resolve=>pending.push({options,resolve}))});
  const old=f.model.lookup(movie);const oldRejection=assert.rejects(old,error=>error.name==='AbortError'||error.code==='MOVIE_RECOMMENDATIONS_UNAVAILABLE');await tick();
  f.setScope({account:'B',hidden:{movies:['hidden']},hiddenItems:{movies:['8']}});const next=f.model.lookup(movie);await tick();
  assert.equal(pending[0].options.signal.aborted,true);pending[0].resolve(response());pending[1].resolve(response());await oldRejection;await next;
  assert.deepEqual(JSON.parse(pending[1].options.body).hidden,{movies:['hidden']});
  f.setRevision(2);const refresh=f.model.lookup(movie);await tick();assert.equal(pending.length,3);pending[2].resolve(response());await refresh;
});
test('invalid or unsafe server responses are rejected instead of ranked or repaired locally',async t=>{
  for(const value of [{...response(),rankingVersion:1},{...response(),identityVersion:1},{...response(),source:'loaded-catalog'},{...response(),sourceId:'99'},{...response(),items:[entry(10)]},{...response(),items:[entry(2),entry(2)]},{...response(),items:[{...entry(2),isAdult:true}]},{...response(),items:[{...entry(2),kind:'series'}]}]){
    const f=fixture(t,{request:async()=>value});await assert.rejects(f.model.lookup(movie),{code:'MOVIE_RECOMMENDATIONS_UNAVAILABLE'});
  }
});
test('unavailable cloud and adult content never trigger a recommendation request',async t=>{
  const f=fixture(t);f.setScope(null);await assert.rejects(f.model.lookup(movie),{code:'MOVIE_RECOMMENDATIONS_UNAVAILABLE'});
  f.setScope({account:'A'});await assert.rejects(f.model.lookup({...movie,isAdult:true}),{code:'MOVIE_RECOMMENDATIONS_UNAVAILABLE'});
  const controller=new AbortController();controller.abort();await assert.rejects(f.model.lookup(movie,{signal:controller.signal}),{name:'AbortError'});assert.equal(f.calls.length,0);
});

test('peek retains a validated RPC result after 503, scoped by source, owner, filters and provider',async t=>{
  let fail=false;const f=fixture(t,{request:async()=>{if(fail)throw Object.assign(new Error('offline'),{status:503,code:'CLOUD_UNAVAILABLE'});return response();}});
  await f.model.lookup(movie);assert.deepEqual(f.model.peek(movie).items.map(item=>item.id),['9','2','7','5']);
  fail=true;f.setRevision(2);await assert.rejects(f.model.lookup(movie),{status:503});
  assert.deepEqual(f.model.peek(movie,{limit:2}).items.map(item=>item.id),['9','2']);
  assert.equal(f.model.peek({...movie,id:'20'}),null);
  for(const update of [{account:'B'},{epoch:2},{providerKey:'other'},{project:'other'},{scopeHash:'other'}, {hidden:{movies:['drama']}},{hiddenItems:{movies:['9']}}]){
    f.setScope({account:'A',project:'fixed',providerKey:'p',scopeHash:'s',hidden:{},hiddenItems:{},...update});
    assert.equal(f.model.peek(movie),null,JSON.stringify(update));
  }
  f.setScope(null);assert.equal(f.model.peek(movie),null);
});

test('TV and series preferences share the same movie cache without a request or invalidation',async t=>{
  const f=fixture(t);await f.model.lookup(movie);
  f.setScope({account:'A',project:'fixed',providerKey:'p',scopeHash:'s',hidden:{live:['news'],series:['drama']},hiddenItems:{live:['90'],series:['92']}});
  assert.equal(f.model.peek(movie).items.length,4);await f.model.lookup(movie);assert.equal(f.calls.length,1);
});


test('real query cache and destination keep source A cards during 503 after A to B to A, then recover independently',async t=>{
  let failed=false,scope={account:'A',project:'fixed',providerKey:'p',scopeHash:'s',hidden:{},hiddenItems:{}};
  const f=fixture(t,{getScope:()=>scope,request:async(_path,{body})=>{
    const {id}=JSON.parse(body);if(failed)throw Object.assign(new Error('unavailable'),{code:'CLOUD_UNAVAILABLE',status:503});
    return response(id);
  }});
  const session=new MovieSuggestionSession({getScope:()=>({generation:1,scope}),lookup:(item,options)=>f.model.lookup(item,options),readCached:item=>f.model.peek(item)});
  t.after(()=>session.reset());
  await session.select(movie);await session.select({...movie,id:'20'});
  f.setRevision(2);failed=true;const retry=session.select(movie);
  assert.deepEqual(session.state.items.map(item=>item.id),['9','2','7','5']);assert.equal(session.state.loading,true);
  await retry;assert.equal(session.state.loading,false);assert.equal(session.state.failure.status,503);assert.equal(session.state.items.length,4);
  failed=false;await session.select(movie,{force:true});assert.equal(session.state.error,null);assert.equal(session.state.items.length,4);
  scope={...scope,account:'B'};failed=true;await session.select(movie);
  assert.equal(session.state.items.length,0);assert.equal(session.state.failure.status,503);
});
