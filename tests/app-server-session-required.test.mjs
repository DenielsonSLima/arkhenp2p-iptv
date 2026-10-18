import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../lib/app-server.mjs';

async function fixture(t){
  const clients=[];
  const app=createApp({connection:{server:'https://fixture.example'},sharedWorker:{stop(){},unregisterSource(){}},providerFactory:({config})=>{
    const client={config,session:null,authenticatedAt:Date.now(),logoutCalls:0,catalogCalls:0,
      async connect(){this.session||={connected:true,account:{status:'Active'}};return this.session;},
      async logout(){this.logoutCalls++;this.session=null;},async stopPlayback(){},
      async catalog(){this.catalogCalls++;return{categories:[{id:'1',name:'TV'}],items:[{id:'1',kind:'live',name:'Synthetic channel',categoryId:'1'}]};}};
    clients.push(client);return client;
  }});
  await new Promise((resolve,reject)=>{app.once('error',reject);app.listen(0,'127.0.0.1',resolve);});
  t.after(async()=>{app.closeAllConnections?.();await app.shutdown();});const base='http://127.0.0.1:'+app.address().port;
  return{app,clients,async login(){
    const response=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({provider:'xtream',server:'https://fixture.example',username:'synthetic-user',password:'synthetic-password'})});
    assert.equal(response.status,200);const data=await response.json();assert.equal(data.connected,true);
    return{cookie:response.headers.get('set-cookie').split(';')[0],data};
  },read:(path,cookie,method='GET')=>fetch(base+path,{method,headers:{...(cookie?{Cookie:cookie}:{})}})};
}

test('a cookie from a replaced server instance receives SESSION_REQUIRED without restoring a provider or exposing credentials',async t=>{
  const first=await fixture(t),account=await first.login();
  assert.equal((await first.read('/api/catalog?type=live',account.cookie)).status,200);
  await first.app.shutdown();assert.equal(first.clients[0].logoutCalls,1);
  const replacement=await fixture(t),denied=await replacement.read('/api/catalog?type=live',account.cookie);
  assert.equal(denied.status,401);assert.deepEqual(await denied.json(),{error:'Conecte a conta para carregar o catálogo.',code:'SESSION_REQUIRED'});
  const nextCookie=denied.headers.get('set-cookie').split(';')[0];assert.notEqual(nextCookie,account.cookie);
  const session=await replacement.read('/api/session',nextCookie),data=await session.json();
  assert.equal(session.status,200);assert.equal(data.connected,false);assert.equal(data.code,'SESSION_REQUIRED');
  assert.equal(replacement.clients.length,0);assert.doesNotMatch(JSON.stringify(data),/synthetic-user|synthetic-password|fixture\.example/);
  for(const route of ['/api/live/sources?id=1','/api/play/live/1/index.m3u8']){
    const response=await replacement.read(route,nextCookie);assert.equal(response.status,401);assert.equal((await response.json()).code,'SESSION_REQUIRED');
  }
});

test('logout marks only that local browser session as required while another cookie keeps its independent provider client',async t=>{
  const f=await fixture(t),first=await f.login(),second=await f.login();
  assert.notEqual(first.cookie,second.cookie);assert.equal(first.data.account.libraryId,second.data.account.libraryId);
  const logout=await f.read('/api/logout',first.cookie,'POST');assert.equal(logout.status,200);assert.equal((await logout.json()).connected,false);
  const disconnected=await f.read('/api/session',first.cookie);assert.equal(disconnected.status,200);
  assert.equal((await disconnected.json()).code,'SESSION_REQUIRED');
  const denied=await f.read('/api/catalog?type=live',first.cookie);assert.equal(denied.status,401);assert.equal((await denied.json()).code,'SESSION_REQUIRED');
  const active=await f.read('/api/session',second.cookie),data=await active.json();
  assert.equal(active.status,200);assert.equal(data.connected,true);assert.equal(data.code,undefined);
  assert.equal((await f.read('/api/catalog?type=live',second.cookie)).status,200);
  assert.equal(f.clients[0].logoutCalls,1);assert.equal(f.clients[1].logoutCalls,0);
});

test('a provider revalidation exception remains distinct from an absent local session and can recover',async t=>{
  const f=await fixture(t),account=await f.login(),client=f.clients[0],connect=client.connect;
  client.connect=async()=>{throw new Error('Temporary synthetic provider failure');};
  const response=await f.read('/api/session',account.cookie),failed=await response.json();
  assert.equal(response.status,200);assert.equal(failed.connected,false);assert.equal(failed.code,undefined);
  assert.match(failed.error,/Temporary synthetic provider failure/);assert.equal(client.logoutCalls,0);
  client.connect=connect;
  const recovered=await (await f.read('/api/session',account.cookie)).json();assert.equal(recovered.connected,true);assert.equal(recovered.code,undefined);
});
