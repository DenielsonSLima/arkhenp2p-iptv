import test from 'node:test';
import assert from 'node:assert/strict';
import {ConectorRecomendacoesFilmesSupabase} from '../lib/filmes/recomendacoes/conector-supabase.mjs';
import {ConectorBibliotecaInicioSupabase} from '../lib/inicio/biblioteca/conector-supabase.mjs';
import {ConectorHomeTvSupabase} from '../lib/tv/home-conector-supabase.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const movieReply=(sourceId='film')=>({schemaVersion:1,rankingVersion:2,identityVersion:2,source:'rpc',sourceId,items:[]});
const homeReply=()=>({schemaVersion:1,counts:{live:0,movie:0,series:0},history:{live:[],movie:[],series:[]},favoriteChannels:[],recommendations:{items:[]}});
const tvReply=()=>({schemaVersion:1,source:'rpc',revision:1,generatedAt:'2026-10-17T00:00:00Z',snapshotVersion:'11111111-1111-4111-8111-111111111111',featuredId:null,mostWatchedId:null,items:[]});
function state(){return {authGeneration:1,client:{session:{connected:true}},parental:{unlocked:false,rememberCatalog(){}},cloud:{providerKey:'a'.repeat(64),scopeHash:'b'.repeat(64),session:{access_token:'synthetic-only'}}};}
function fixture(){
  const calls=[],runtime={now:()=>Date.now(),enabled:true,closed:false,catalog:async()=>({items:[],categories:[]}),cloud:{request:(path,options)=>new Promise((resolve,reject)=>{
    const cancel=()=>reject(new DOMException('Cancelled','AbortError'));
    options.signal?.addEventListener('abort',cancel,{once:true});
    calls.push({path,options,resolve:value=>{options.signal?.removeEventListener('abort',cancel);resolve(value);},reject:error=>{options.signal?.removeEventListener('abort',cancel);reject(error);}});
  })}};
  return {runtime,calls,state:state(),movies:new ConectorRecomendacoesFilmesSupabase({runtime}),home:new ConectorBibliotecaInicioSupabase({runtime}),tv:new ConectorHomeTvSupabase({runtime})};
}

test('Home TV, Home library and movie suggestions run separate RPCs and failures stay in their domain',async()=>{
  const f=fixture(),home=f.home.read(f.state,{}),movie=f.movies.recommendations(f.state,{id:'film'}),tv=f.tv.read(f.state,{hidden:[],hiddenItems:[]});
  const rejectedHome=assert.rejects(home,{code:'CLOUD_DATABASE_TIMEOUT'});await tick();
  assert.equal(f.calls.length,3);
  const find=suffix=>f.calls.find(row=>row.path.endsWith(suffix));
  assert.equal(find('arkhen_home_vod').options.timeoutMs,10000);
  assert.equal(find('arkhen_movie_recommendations').options.timeoutMs,10000);
  assert.equal(find('arkhen_home_tv_catalog').options.timeoutMs,5000);
  find('arkhen_home_vod').reject(Object.assign(new Error('Synthetic timeout'),{code:'CLOUD_DATABASE_TIMEOUT'}));
  find('arkhen_movie_recommendations').resolve(movieReply());find('arkhen_home_tv_catalog').resolve(tvReply());
  await rejectedHome;assert.deepEqual(await movie,movieReply());assert.deepEqual(await tv,tvReply());
  const retry=f.home.read(f.state,{});await tick();f.calls.at(-1).resolve(homeReply());assert.deepEqual(await retry,homeReply());
});

test('cancelling Home leaves TV and movie queries running',async()=>{
  const f=fixture(),abort=new AbortController(),home=f.home.read(f.state,{}, {signal:abort.signal});
  const movie=f.movies.recommendations(f.state,{id:'film'}),tv=f.tv.read(f.state,{hidden:[],hiddenItems:[]});
  const rejection=assert.rejects(home,{name:'AbortError'});await tick();abort.abort();await rejection;
  for(const call of f.calls.filter(row=>!row.path.endsWith('arkhen_home_vod'))){assert.equal(call.options.signal?.aborted??false,false);call.resolve(call.path.endsWith('arkhen_home_tv_catalog')?tvReply():movieReply());}
  assert.deepEqual(await movie,movieReply());assert.deepEqual(await tv,tvReply());
});

test('Home VOD ignores TV filters and shares concurrent reads without sharing their cancellation',async()=>{
  const f=fixture(),abort=new AbortController();
  const first=f.home.read(f.state,{hidden:{live:['1'],movies:['10']},hiddenItems:{live:['2']}},{signal:abort.signal});
  const second=f.home.read(f.state,{hidden:{live:['3'],movies:['10']},hiddenItems:{live:['4']}});
  const rejected=assert.rejects(first,{name:'AbortError'});await tick();assert.equal(f.calls.length,1);
  assert.deepEqual(f.calls[0].options.body.p_hidden_categories,{movies:['10']});assert.deepEqual(f.calls[0].options.body.p_hidden_items,{});
  abort.abort();await rejected;assert.equal(f.calls[0].options.signal.aborted,false);
  f.calls[0].resolve(homeReply());assert.deepEqual(await second,homeReply());
  const next=f.home.read(f.state,{});await tick();assert.equal(f.calls.length,2);f.calls[1].resolve(homeReply());await next;
});

test('Home VOD refuses a mixed TV DTO instead of allowing channel data into VOD shelves',async()=>{
  const f=fixture(),pending=f.home.read(f.state,{});await tick();f.calls[0].resolve({...homeReply(),favoriteChannels:[{kind:'live',id:'1'}]});assert.equal(await pending,null);
});

test('movie suggestions share only an unfinished identical request, with independent reader cancellation',async()=>{
  const f=fixture(),abort=new AbortController();
  const first=f.movies.recommendations(f.state,{id:'film'},{signal:abort.signal}),second=f.movies.recommendations(f.state,{id:'film'});
  const rejected=assert.rejects(first,{name:'AbortError'});await tick();assert.equal(f.calls.length,1);
  abort.abort();await rejected;assert.equal(f.calls[0].options.signal.aborted,false);
  f.calls[0].resolve(movieReply());assert.deepEqual(await second,movieReply());
  const next=f.movies.recommendations(f.state,{id:'film'});await tick();assert.equal(f.calls.length,2,'Settled private results are not cached on the server.');f.calls[1].resolve(movieReply());await next;
});

test('last movie reader cancellation stops only its upstream RPC and can retry',async()=>{
  const f=fixture(),abort=new AbortController(),first=f.movies.recommendations(f.state,{id:'film'},{signal:abort.signal});
  const rejected=assert.rejects(first,{name:'AbortError'});await tick();abort.abort();await rejected;
  assert.equal(f.calls[0].options.signal.aborted,true);
  const second=f.movies.recommendations(f.state,{id:'film'});await tick();assert.equal(f.calls.length,2);f.calls[1].resolve(movieReply());assert.deepEqual(await second,movieReply());
});

test('movie request identity includes account, client, authentication generation, PIN and preferences',async()=>{
  for(const mutate of [
    value=>{value.cloud={...value.cloud};},value=>{value.client={session:{connected:true}};},
    value=>{value.authGeneration++;},value=>{value.parental.unlocked=true;},
  ]){
    const f=fixture(),first=f.movies.recommendations(f.state,{id:'film'});await tick();mutate(f.state);
    const second=f.movies.recommendations(f.state,{id:'film'});await tick();assert.equal(f.calls.length,2);
    f.calls[0].resolve(movieReply());f.calls[1].resolve(movieReply());assert.equal(await first,null);assert.deepEqual(await second,movieReply());
  }
  const f=fixture(),first=f.movies.recommendations(f.state,{id:'film'}),second=f.movies.recommendations(f.state,{id:'film',hiddenItems:{movies:['other']}});await tick();assert.equal(f.calls.length,2);
  f.calls.forEach(row=>row.resolve(movieReply()));await Promise.all([first,second]);
});

test('Home completion is discarded after account, client, authentication generation or PIN changes',async()=>{
  for(const mutate of [
    value=>{value.cloud={...value.cloud};},value=>{value.client={session:{connected:true}};},
    value=>{value.authGeneration++;},value=>{value.parental.unlocked=true;},
  ]){
    const f=fixture(),first=f.home.read(f.state,{});await tick();mutate(f.state);f.calls[0].resolve(homeReply());assert.equal(await first,null);
  }
});

test('closing a projection module stops its pending reads without disabling the other module',async()=>{
  const f=fixture(),home=f.home.read(f.state,{}),movie=f.movies.recommendations(f.state,{id:'film'}),rejected=assert.rejects(home,{name:'AbortError'});await tick();
  f.home.close();await rejected;
  const film=f.calls.find(row=>row.path.endsWith('arkhen_movie_recommendations'));assert.equal(film.options.signal.aborted,false);film.resolve(movieReply());assert.deepEqual(await movie,movieReply());
  const next=f.movies.recommendations(f.state,{id:'film'});await tick();f.movies.close();assert.equal(await next,null);
});

test('RPC failure and invalid DTO never become a successful empty movie shelf',async()=>{
  const f=fixture(),first=f.movies.recommendations(f.state,{id:'film'});await tick();f.calls[0].reject(Object.assign(new Error('Synthetic timeout'),{code:'CLOUD_DATABASE_TIMEOUT'}));assert.equal(await first,null);
  const malformed=f.movies.recommendations(f.state,{id:'film'});await tick();f.calls[1].resolve({items:[]});assert.equal(await malformed,null);
  const empty=f.movies.recommendations(f.state,{id:'film'});await tick();f.calls[2].resolve(movieReply());assert.deepEqual(await empty,movieReply());
});
