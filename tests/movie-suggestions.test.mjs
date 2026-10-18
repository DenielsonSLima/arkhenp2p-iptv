import test from 'node:test';
import assert from 'node:assert/strict';
import {MovieSuggestionSession,movieCanHaveSuggestions,movieFinishedForSuggestions} from '../web/filmes/recomendacoes/sessao.js';
const movie=(id,extra={})=>({id:String(id),kind:'movie',name:'Filme '+id,...extra});
const result=(source,items=[])=>({schemaVersion:1,rankingVersion:2,identityVersion:2,source:'rpc',sourceId:String(source),items});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
test('end suggestions require the actual ended state, a movie and no positive adult classification',()=>{
  assert.equal(movieFinishedForSuggestions(movie(1),{ended:false,currentTime:100,duration:100}),false);
  assert.equal(movieFinishedForSuggestions(movie(1),{ended:true}),true);
  for(const item of [movie(1,{kind:'live'}),movie(1,{kind:'series'}),movie(1,{isAdult:true}),movie(1,{group:'Adulto'})])assert.equal(movieFinishedForSuggestions(item,{ended:true}),false);
  assert.equal(movieFinishedForSuggestions(movie(1),{ended:true},()=>false),false);
  assert.equal(movieCanHaveSuggestions(movie(1),()=>true),true);
});
test('stale movie responses and account changes cannot replace the active destination',async()=>{
  const one=deferred(),two=deferred(),signals=[];let account='a';
  const session=new MovieSuggestionSession({getScope:()=>account,lookup:(item,{signal})=>{signals.push(signal);return item.id==='1'?one.promise:two.promise;}});
  const first=session.select(movie(1));await Promise.resolve();const second=session.select(movie(2));await Promise.resolve();assert.equal(signals[0].aborted,true);
  two.resolve(result(2,[movie(3)]));await second;one.resolve(result(1,[movie(4)]));await first;assert.equal(session.state.item.id,'2');assert.equal(session.state.items[0].id,'3');
  const third=deferred();session.lookup=()=>third.promise;const work=session.select(movie(5));await Promise.resolve();account='b';third.resolve(result(5,[movie(6)]));await work;assert.equal(session.state.item,null);assert.deepEqual(session.state.items,[]);
});
test('same preview renders reuse one request, preserve supplied ordering and cap the display at ten films',async()=>{
  let calls=0;const d=deferred();const session=new MovieSuggestionSession({lookup:()=>{calls++;return d.promise;}});
  const first=session.select(movie(1));const second=session.select(movie(1));await Promise.resolve();assert.equal(calls,1);
  d.resolve(result(1,[movie(4),movie(5),movie(6),movie(7),movie(8),movie(9),movie(10),movie(11),movie(12),movie(13),movie(14)]));await Promise.all([first,second]);
  assert.deepEqual(session.state.items.map(item=>item.id),['4','5','6','7','8','9','10','11','12','13']);await session.select(movie(1));assert.equal(calls,1);
});
test('request failure is explicit, refresh keeps the last suggestions, and another source response is rejected',async()=>{
  let calls=0;const session=new MovieSuggestionSession({lookup:async()=>{calls++;if(calls===1)return result(1,[movie(2)]);throw new Error('offline');}});
  await session.select(movie(1));const refresh=session.select(movie(1),{force:true});assert.equal(session.state.items[0].id,'2');await refresh;assert.match(session.state.error,/Não foi possível/);assert.equal(session.state.items[0].id,'2');
  session.lookup=async()=>result(99,[movie(4)]);await session.select(movie(3));assert.match(session.state.error,/Não foi possível/);assert.deepEqual(session.state.items,[]);
});
test('late adult classification clears suggestions and reset aborts in-flight work',async()=>{
  let allowed=true;const d=deferred();let signal;
  const session=new MovieSuggestionSession({allowed:()=>allowed,lookup:(_,options)=>{signal=options.signal;return d.promise;}});
  const work=session.select(movie(1));await Promise.resolve();allowed=false;d.resolve(result(1,[movie(2)]));await work;assert.equal(session.state.item,null);
  allowed=true;const next=deferred();session.lookup=(_,options)=>{signal=options.signal;return next.promise;};const pending=session.select(movie(3));await Promise.resolve();session.reset();assert.equal(signal.aborted,true);next.resolve(result(3,[movie(4)]));await pending;assert.equal(session.state.item,null);
});
test('recommendation provenance survives refresh and a standalone abort ends loading honestly',async()=>{
  const session=new MovieSuggestionSession({lookup:async()=>({...result(1,[movie(2)]),reason:'source_franchise',personalized:false})});
  await session.select(movie(1));assert.equal(session.state.reason,'source_franchise');assert.equal(session.state.personalized,false);
  session.lookup=async()=>{throw new DOMException('cancelled','AbortError');};await session.select(movie(1),{force:true});
  assert.equal(session.state.loading,false);assert.equal(session.state.reason,'source_franchise');assert.equal(session.state.items[0].id,'2');assert.match(session.state.error,/Não foi possível/);
});

test('TV and series preferences cannot cancel or hide an active movie recommendation request',async()=>{
  const pending=deferred();let calls=0;
  let scope={generation:7,scope:{account:'A',epoch:7,providerKey:'p',scopeHash:'s',hidden:{movies:[],live:[],series:[]},hiddenItems:{movies:[],live:[],series:[]}}};
  const session=new MovieSuggestionSession({getScope:()=>scope,lookup:()=>{calls++;return pending.promise;}});
  const work=session.select(movie(1));await Promise.resolve();
  scope={...scope,scope:{...scope.scope,hidden:{...scope.scope.hidden,live:['news'],series:['drama']},hiddenItems:{...scope.scope.hiddenItems,live:['22']}}};
  pending.resolve(result(1,[movie(2)]));await work;
  assert.equal(session.state.item?.id,'1');assert.equal(session.state.items[0]?.id,'2');assert.equal(session.matchesScope(),true);
  await session.select(movie(1));assert.equal(calls,1);
});

test('a cached server result survives A to B to A navigation and a failed revalidation, then retry replaces it',async()=>{
  const cache=new Map([['1',result(1,[movie(2)])]]);let fail=true;let scope={account:'A',epoch:1};
  const session=new MovieSuggestionSession({getScope:()=>scope,readCached:item=>cache.get(item.id)||null,
    lookup:async item=>{if(fail)throw Object.assign(new Error('offline'),{status:503,code:'CLOUD_UNAVAILABLE'});return result(item.id,[movie(4)]);}});
  await session.select(movie(1));assert.deepEqual(session.state.items.map(item=>item.id),['2']);assert.equal(session.state.failure.status,503);
  await session.select(movie(3));assert.equal(session.state.items.length,0);assert.ok(session.state.error);
  const returning=session.select(movie(1));assert.deepEqual(session.state.items.map(item=>item.id),['2']);await returning;
  assert.equal(session.state.loading,false);assert.ok(session.state.error);assert.deepEqual(session.state.items.map(item=>item.id),['2']);
  fail=false;await session.select(movie(1),{force:true});assert.equal(session.state.error,null);assert.deepEqual(session.state.items.map(item=>item.id),['4']);
  scope={account:'B',epoch:2};session.readCached=()=>null;
  fail=true;await session.select(movie(1));assert.deepEqual(session.state.items,[]);assert.ok(session.state.error);
});

test('cloud recovery cannot retain recommendations across a provider or generation change',async()=>{
  let scope={generation:1,scope:{account:'A',epoch:1,providerKey:'p',scopeHash:'s'}};
  const session=new MovieSuggestionSession({getScope:()=>scope,lookup:async()=>result(1,[movie(2)])});
  await session.select(movie(1));session.lookup=async()=>{throw Object.assign(new Error('offline'),{status:503});};
  await session.select(movie(1),{force:true});
  scope={...scope,scope:{...scope.scope,providerKey:'other'}};
  assert.equal(session.recover(),false);
  scope={generation:2,scope:{account:'A',epoch:1,providerKey:'p',scopeHash:'s'}};
  assert.equal(session.recover(),false);
});

test('a cloud binding attached during the request becomes a retryable failure, not a disappearing destination',async()=>{
  const pending=deferred();let scope={generation:3,scope:{account:'A',epoch:3}};
  const session=new MovieSuggestionSession({getScope:()=>scope,lookup:()=>pending.promise});
  const work=session.select(movie(1));await Promise.resolve();
  scope={generation:3,scope:{account:'A',epoch:3,project:'fixed',providerKey:'p',scopeHash:'s'}};
  pending.reject(Object.assign(new Error('bootstrap'),{code:'CLOUD_SESSION_MISSING',status:503}));await work;
  assert.equal(session.state.item?.id,'1');assert.equal(session.state.loading,false);assert.ok(session.state.error);
  session.lookup=async()=>result(1,[movie(2)]);assert.equal(session.recover(),true);await session.pending;
  assert.deepEqual(session.state.items.map(item=>item.id),['2']);assert.equal(session.state.error,null);
});
