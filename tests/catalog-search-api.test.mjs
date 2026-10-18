import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../lib/app-server.mjs';
import {CloudRuntime} from '../lib/cloud-runtime.mjs';
import {catalogSearchRequest} from '../lib/catalog-search-request.mjs';

const providerKey='a'.repeat(64),scopeHash='b'.repeat(64);
const report={schemaVersion:1,query:'acao',items:[{id:'12',kind:'movie',name:'Ação',isAdult:false}],counts:{live:0,movie:1,series:0},total:1,hasMore:false,revision:{movies:'revision'}};
async function fixture(t){
  const calls=[];
  const cloud={enabled:true,ready:Promise.resolve(),publicConfig:()=>({url:'https://wnicimkmzswksaqdtgdv.supabase.co',publishableKey:'sb_publishable_fixture'}),
    bootstrap:async()=>({providerKey,scopeHash,session:{access_token:'scoped-user-token',expires_in:3600}}),revoke:async()=>{},rpc:async()=>{},
    request:async(path,options)=>{calls.push({path,options});return report;}};
  const worker={registerSource(){},unregisterSource(){},start(){},stop(){},async tick(){}};
  const app=createApp({connection:{},cloud,sharedWorker:worker,providerFactory:({config})=>({config,images:new Map(),
    async connect(){this.authenticatedAt=Date.now();this.session={connected:true,account:{status:'Active',expiresAt:'2070-01-01T00:00:00Z'}};return this.session;},async logout(){this.session=null;},async stopPlayback(){}})});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));t.after(async()=>{app.closeAllConnections?.();await app.shutdown();});
  const base=`http://127.0.0.1:${app.address().port}`,common={Origin:base,'Content-Type':'application/json'};
  const login=await fetch(base+'/api/login',{method:'POST',headers:common,body:JSON.stringify({username:'fixture',password:'private-password',provider:'wplay'})});
  assert.equal(login.status,200);await login.json();const headers={...common,Cookie:login.headers.get('set-cookie').split(';')[0]};
  return {base,cloud,calls,headers,search:body=>fetch(base+'/api/search',{method:'POST',headers,body:JSON.stringify(body)})};
}
test('search below three normalized characters does no cloud query, and query options cannot change ownership or adult authorization',async t=>{
  const f=await fixture(t);
  const short=await f.search({query:' áé '});assert.equal(short.status,200);assert.equal((await short.json()).minimumLength,3);assert.equal(f.calls.length,0);
  const response=await f.search({query:' AÇÃO ',providerKey:'other',scopeHash:'other',includeAdult:true,hidden:{movies:['10']},hiddenItems:{movies:['20']}});
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.deepEqual(await response.json(),report);
  assert.equal(f.calls[0].path,'/rest/v1/rpc/arkhen_global_search');assert.deepEqual(f.calls[0].options.body,{p_provider_key:providerKey,p_scope_hash:scopeHash,p_query:'acao',p_media_type:'all',p_offset:0,p_limit:120,p_hidden_categories:{movies:['10']},p_hidden_items:{movies:['20']},p_include_adult:false});
  assert.equal(f.calls[0].options.accessToken,'scoped-user-token');assert.equal(f.calls[0].options.publicKey,true);
  assert.equal((await fetch(f.base+'/api/search',{method:'POST',headers:{Origin:f.base},body:'{}'})).status,401);
  assert.equal((await fetch(f.base+'/api/search',{headers:f.headers})).status,405);
});
test('search validates limits and structured exclusions before accessing the database',async t=>{
  const f=await fixture(t);
  for(const body of [{query:[]},{query:'a'.repeat(161)},{query:'abc',type:'users'},{query:'abc',offset:-1},{query:'abc',limit:121},{query:'abc',hiddenItems:{movies:['a/b']}},{query:'abc',hidden:{movies:Array(2001).fill('1')}}])assert.equal((await f.search(body)).status,400);
  assert.equal(f.calls.length,0);
  assert.equal(catalogSearchRequest({query:' AÇÃO   ÉPICA '}).query,'acao epica');
});
test('unavailable search returns a retryable error without exposing internals or false empty success',async t=>{
  const f=await fixture(t);f.cloud.request=async()=>{throw new Error('private-password secret api-key');};
  const response=await f.search({query:'acao'}),body=await response.json();assert.equal(response.status,503);assert.equal(body.code,'SEARCH_UNAVAILABLE');assert.equal(body.items,undefined);assert.doesNotMatch(JSON.stringify(body),/private-password|api-key|secret/);
});
test('logout or parental change fences a pending RPC result',async t=>{
  for(const action of ['logout','parental/lock']){
    const f=await fixture(t);
    if(action==='parental/lock')assert.equal((await fetch(f.base+'/api/parental/unlock',{method:'POST',headers:f.headers,body:'{"pin":"0000"}'})).status,200);
    let release,entered;const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
    f.cloud.request=async()=>{entered();await gate;return report;};const pending=f.search({query:'acao'});await started;
    assert.equal((await fetch(f.base+'/api/'+action,{method:'POST',headers:f.headers})).status,200);release();
    const response=await pending;assert.equal(response.status,action==='logout'?401:409);assert.equal((await response.json()).items,undefined);
  }
});
test('search cannot use privileged credentials without a cloud user session',async()=>{
  let calls=0;const runtime=new CloudRuntime({cloud:{enabled:true,request:async()=>{calls++;return report;}},worker:{stop(){}}});
  try{assert.equal(await runtime.searchCatalog({},{query:'acao'}),null);assert.equal(await runtime.searchCatalog({cloud:{providerKey,scopeHash}},{query:'acao'}),null);assert.equal(calls,0);}finally{runtime.close();}
});
test('home projection uses the account JWT, private visibility filters and server adult grant',async t=>{
  const f=await fixture(t),home={schemaVersion:1,counts:{live:0,movie:4,series:1},history:{live:[],movie:[],series:[]},favoriteChannels:[],recommendations:{items:[],personalized:false}};
  f.cloud.request=async(path,options)=>{f.calls.push({path,options});return home;};
  const response=await fetch(f.base+'/api/home/library',{method:'POST',headers:f.headers,body:JSON.stringify({userId:'other',includeAdult:true,hidden:{live:['10']}})});
  assert.equal(response.status,200);assert.deepEqual(await response.json(),home);const call=f.calls[0];assert.equal(call.path,'/rest/v1/rpc/arkhen_home_vod');
  assert.deepEqual(call.options.body,{p_provider_key:providerKey,p_scope_hash:scopeHash,p_include_adult:false,p_hidden_categories:{},p_hidden_items:{}});assert.equal(call.options.accessToken,'scoped-user-token');
  assert.equal((await fetch(f.base+'/api/home/library',{headers:f.headers})).status,405);
  f.cloud.request=async()=>{throw new Error('secret');};const failed=await fetch(f.base+'/api/home/library',{method:'POST',headers:f.headers,body:'{}'});assert.equal(failed.status,503);assert.equal((await failed.json()).code,'HOME_UNAVAILABLE');
});

test('movie recommendations use the account JWT and cannot accept caller ownership or adult overrides',async t=>{
  const f=await fixture(t),value={schemaVersion:1,rankingVersion:2,identityVersion:2,source:'rpc',sourceId:'film',revision:'published',items:[{id:'related',kind:'movie',name:'Related',isAdult:false}],personalized:true,reason:'source_genre'};
  f.cloud.request=async(path,options)=>{f.calls.push({path,options});return value;};
  const response=await fetch(f.base+'/api/recommendations/movie',{method:'POST',headers:f.headers,body:JSON.stringify({id:'film',limit:3,userId:'other',providerKey:'foreign',includeAdult:true,hidden:{movies:['10']}})});
  assert.equal(response.status,200);assert.deepEqual(await response.json(),value);assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal(f.calls[0].path,'/rest/v1/rpc/arkhen_movie_recommendations');assert.deepEqual(f.calls[0].options.body,{p_provider_key:providerKey,p_scope_hash:scopeHash,p_source_id:'film',p_limit:3,p_hidden_categories:{movies:['10']},p_hidden_items:{}});
  assert.equal(f.calls[0].options.accessToken,'scoped-user-token');assert.equal(f.calls[0].options.publicKey,true);
  assert.equal((await fetch(f.base+'/api/recommendations/movie',{headers:f.headers})).status,405);
  const prior=f.calls.length;
  for(const body of [{id:'a/b'},{id:4},{id:'film',limit:13},{id:'film',hidden:{movies:'bad'}}])assert.equal((await fetch(f.base+'/api/recommendations/movie',{method:'POST',headers:f.headers,body:JSON.stringify(body)})).status,400);
  assert.equal(f.calls.length,prior);
  f.cloud.request=async()=>{throw new Error('private-password key');};
  const failed=await fetch(f.base+'/api/recommendations/movie',{method:'POST',headers:f.headers,body:'{"id":"film"}'});assert.equal(failed.status,503);assert.deepEqual(await failed.json(),{error:'Não foi possível atualizar suas recomendações.',code:'MOVIE_RECOMMENDATIONS_UNAVAILABLE'});
});

test('movie recommendations require a scoped session and reject malformed or adult RPC results',async()=>{
  let calls=0,result=null;const runtime=new CloudRuntime({cloud:{enabled:true,request:async()=>{calls++;return result;}},worker:{stop(){}}});
  const state={cloud:{providerKey,scopeHash,session:{access_token:'user-token'}}};
  try{
    assert.equal(await runtime.movieRecommendations({cloud:{providerKey,scopeHash}},{id:'film'}),null);assert.equal(calls,0);
    for(const value of [{schemaVersion:1,sourceId:'other',items:[]},{schemaVersion:1,sourceId:'film',items:[{id:'other',kind:'movie',isAdult:true}]},{schemaVersion:1,sourceId:'film',items:[{id:'film',kind:'movie',isAdult:false}]},{schemaVersion:1,sourceId:'film',items:[{id:'other',kind:'series',isAdult:false}]}]){
      result={rankingVersion:2,identityVersion:2,source:'rpc',...value};assert.equal(await runtime.movieRecommendations(state,{id:'film'}),null);
    }
    result={schemaVersion:1,sourceId:'film',items:[{id:'other',kind:'movie',isAdult:false}]};assert.equal(await runtime.movieRecommendations(state,{id:'film'}),null,'Legacy DTO without ranking/identity versions is not accepted as a current RPC result.');
    result={...result,rankingVersion:2,identityVersion:2,source:'rpc'};assert.deepEqual(await runtime.movieRecommendations(state,{id:'film'}),result);
  }finally{runtime.close();}
});

test('a pending movie recommendation cannot cross logout',async t=>{
  const f=await fixture(t);let release,entered;const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  f.cloud.request=async()=>{entered();await gate;return {schemaVersion:1,sourceId:'film',items:[]};};
  const pending=fetch(f.base+'/api/recommendations/movie',{method:'POST',headers:f.headers,body:'{"id":"film"}'});await started;
  assert.equal((await fetch(f.base+'/api/logout',{method:'POST',headers:f.headers})).status,200);release();assert.equal((await pending).status,401);
});
