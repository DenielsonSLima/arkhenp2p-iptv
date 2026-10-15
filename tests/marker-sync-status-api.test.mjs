import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../lib/app-server.mjs';
import {CloudRuntime} from '../lib/cloud-runtime.mjs';

const providerKey='a'.repeat(64),scopeHash='b'.repeat(64);
const report={schemaVersion:1,providers:[{id:'skipdb',priority:1},{id:'introdb',priority:2}],recent:[],global:{episodes:200},catalog:{series:20,withMarkers:5}};
async function fixture(t){
  const calls=[],clients=[];
  const cloud={enabled:true,ready:Promise.resolve(),publicConfig:()=>({url:'https://wnicimkmzswksaqdtgdv.supabase.co',publishableKey:'sb_publishable_fixture'}),
    bootstrap:async()=>({providerKey,scopeHash,session:{access_token:'scoped-user-token',expires_in:3600}}),revoke:async()=>{},rpc:async()=>{},
    request:async(path,options)=>{calls.push({path,options});return report;}};
  const worker={registerSource(){},unregisterSource(){},start(){},stop(){},async tick(){}};
  const app=createApp({connection:{},nativeBridge:null,cloud,sharedWorker:worker,providerFactory:({config})=>{
    const client={config,images:new Map(),async connect(){this.authenticatedAt=Date.now();this.session={connected:true,account:{status:'Active',expiresAt:'2070-01-01T00:00:00Z'}};return this.session;},async logout(){this.session=null;},async stopPlayback(){}};clients.push(client);return client;
  }});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{app.closeAllConnections?.();await app.shutdown();});
  const base=`http://127.0.0.1:${app.address().port}`;
  const login=await fetch(base+'/api/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({username:'fixture',password:'private-password',provider:'wplay'})});
  assert.equal(login.status,200);await login.json();
  return {base,cloud,calls,clients,headers:{Cookie:login.headers.get('set-cookie').split(';')[0]}};
}

test('sync status requires a provider session and uses only its authorized partition and user JWT',async t=>{
  const f=await fixture(t);
  assert.equal((await fetch(f.base+'/api/markers/sync-status')).status,401);
  const response=await fetch(f.base+'/api/markers/sync-status?providerKey=other&scopeHash=other',{headers:f.headers});
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.deepEqual(await response.json(),report);
  assert.deepEqual(f.calls,[{path:'/rest/v1/rpc/arkhen_marker_sync_status',options:{method:'POST',body:{p_provider_key:providerKey,p_scope_hash:scopeHash},timeoutMs:15000,publicKey:true,accessToken:'scoped-user-token'}}]);
  assert.equal((await fetch(f.base+'/api/markers/sync-status',{method:'POST',headers:{...f.headers,Origin:f.base}})).status,405);
  assert.equal(f.calls.length,1,'Reading the panel must not start collection or reload catalogs.');
});

test('sync status failures return an unavailable state without leaking backend errors or claiming an empty registry',async t=>{
  const f=await fixture(t);f.cloud.request=async()=>{throw new Error('private-password secret api-key');};
  const response=await fetch(f.base+'/api/markers/sync-status',{headers:f.headers}),body=await response.json();
  assert.equal(response.status,503);assert.equal(body.code,'MARKER_SYNC_STATUS_UNAVAILABLE');assert.equal(body.global,undefined);assert.doesNotMatch(JSON.stringify(body),/private-password|api-key|secret/);
});

test('logout during sync status read rejects a late response from the previous account',async t=>{
  const f=await fixture(t);let release,started;
  const gate=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{started=resolve;});
  f.cloud.request=async()=>{started();await gate;return report;};
  const pending=fetch(f.base+'/api/markers/sync-status',{headers:f.headers});await entered;
  assert.equal((await fetch(f.base+'/api/logout',{method:'POST',headers:{...f.headers,Origin:f.base}})).status,200);
  release();const response=await pending;assert.equal(response.status,401);assert.equal((await response.json()).global,undefined);
});

test('sync status never falls back to privileged access when the user session is absent',async()=>{
  let requests=0;const runtime=new CloudRuntime({cloud:{enabled:true,request:async()=>{requests++;return report;}},worker:{stop(){}}});
  try{assert.equal(await runtime.markerSyncStatus({}),null);assert.equal(await runtime.markerSyncStatus({cloud:{providerKey:'invalid',scopeHash}}),null);assert.equal(await runtime.markerSyncStatus({cloud:{providerKey,scopeHash}}),null);assert.equal(await runtime.markerSyncStatus({cloud:{providerKey,scopeHash,session:{access_token:''}}}),null);assert.equal(requests,0);}finally{runtime.close();}
});
