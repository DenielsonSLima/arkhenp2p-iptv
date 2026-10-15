import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../lib/app-server.mjs';
import {ProviderError} from '../lib/provider.mjs';

const providerKey='a'.repeat(64),scopeHash='b'.repeat(64),userId='d243589c-25c5-4db0-b9aa-c087ace3d180';
async function fixture(t,{cloudFailure=false,pendingBootstrap,sportsLogoReader}={}){
  const calls=[],clients=[],config={url:'https://wnicimkmzswksaqdtgdv.supabase.co',publishableKey:'sb_publishable_fixture_1234567890'};
  const cloud={ready:Promise.resolve(true),enabled:true,publicConfig:()=>config,
    async bootstrap(value){calls.push({kind:'bootstrap',value});if(pendingBootstrap)await pendingBootstrap;if(cloudFailure)throw Object.assign(new Error('private password token'),{code:'CLOUD_REQUEST_FAILED'});return {...config,userId,providerKey,scopeHash,session:{access_token:'fixture-access',refresh_token:'fixture-refresh',expires_in:3600}};},
    async revoke(value){calls.push({kind:'revoke',value});},async rpc(name,args){calls.push({kind:'rpc',name,args});},
    async request(url){calls.push({kind:'cloud-read',url});const expires_at='2070-01-01T00:00:00Z';if(url.includes('/provider_catalog_cache?'))return [{expires_at,is_complete:true,payload:{categories:[{id:'1',name:'GLOBAL'}],items:[{id:'1',kind:'live',name:'GLOBAL CHANNEL',poster:''}]}}];if(url.includes('/provider_epg_cache?'))return [{expires_at,payload:{list:[{title:'GLOBAL EPG'}]}}];if(url.includes('/provider_games_cache?'))return [{expires_at,payload:{available:true,date:'2026-10-15',timeZone:'America/Maceio',games:[{id:'global-game'}]}}];return [];}};
  const worker={registerSource:value=>calls.push({kind:'register',value}),unregisterSource:value=>calls.push({kind:'unregister',value}),start:()=>calls.push({kind:'worker-start'}),stop:()=>calls.push({kind:'worker-stop'}),tick:async()=>calls.push({kind:'worker-tick'})};
  const providerFactory=({config})=>{const client={config,images:new Map(),async connect(){this.authenticatedAt=Date.now();this.session={connected:true,account:{status:'Active',expiresAt:'2070-01-01T00:00:00Z'}};return this.session;},async logout(){calls.push({kind:'provider-logout'});this.session=null;},async stopPlayback(){calls.push({kind:'provider-stop'});},async catalog(){calls.push({kind:'provider-catalog'});return {categories:[],items:[]};},async epg(){calls.push({kind:'provider-epg'});return {list:[]};},async games(){calls.push({kind:'provider-games'});return {available:true,games:[]};},async details(){calls.push({kind:'provider-details'});return {id:'1',plot:'individual'};},async playbackURL(){calls.push({kind:'provider-playback'});throw new ProviderError('Esta conta não tem acesso a essa mídia.','ACCOUNT_MEDIA_UNAVAILABLE',403);},playbackGeneration:0,invalidateCatalog(){}};clients.push(client);return client;};
  const app=createApp({connection:{server:'https://fixture.example'},nativeBridge:null,cloud,sharedWorker:worker,providerFactory,sportsLogoReader});await new Promise((resolve,reject)=>{app.once('error',reject);app.listen(0,'127.0.0.1',resolve);});
  t.after(async()=>{app.closeAllConnections?.();await app.shutdown();});const base=`http://127.0.0.1:${app.address().port}`;
  const login=async headers=>fetch(base+'/api/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json',...headers},body:JSON.stringify({provider:'wplay',username:'fixture-user',password:'private-provider-password'})});
  return {base,app,cloud,calls,clients,login};
}

test('authenticated login and session expose cloud bootstrap; cache endpoints are primary while playback remains individual',async t=>{
  const f=await fixture(t),response=await f.login(),headers={Cookie:response.headers.get('set-cookie').split(';')[0]},body=await response.json();
  assert.equal(response.status,200);assert.equal(body.connected,true);assert.equal(body.capabilities.cloud,true);assert.equal(body.cloud.userId,userId);assert.equal(body.cloud.provider,'wplay');assert.equal(body.cloud.libraryId,body.account.libraryId);assert.equal(body.cloud.session.access_token,'fixture-access');assert.doesNotMatch(JSON.stringify(body),/private-provider-password/);
  const csp=response.headers.get('content-security-policy');assert.match(csp,/https:\/\/wnicimkmzswksaqdtgdv\.supabase\.co/);assert.match(csp,/wss:\/\/wnicimkmzswksaqdtgdv\.supabase\.co/);
  const imageWarmCatalogs=f.calls.filter(call=>call.kind==='provider-catalog').length;assert.equal(imageWarmCatalogs,3,'One background metadata warmup restores private image bindings after a process restart.');
  assert.equal((await (await fetch(f.base+'/api/session',{headers})).json()).cloud.userId,userId);assert.equal(f.calls.filter(call=>call.kind==='bootstrap').length,1);
  assert.equal((await (await fetch(f.base+'/api/catalog?type=live',{headers})).json()).items[0].name,'GLOBAL CHANNEL');
  assert.equal((await (await fetch(f.base+'/api/epg?id=1',{headers})).json()).list[0].title,'GLOBAL EPG');
  assert.equal((await (await fetch(f.base+'/api/games?date=2026-10-15&timezone=America%2FMaceio',{headers})).json()).games[0].id,'global-game');
  assert.equal(f.calls.filter(call=>call.kind==='provider-catalog').length,imageWarmCatalogs);assert.equal(f.calls.some(call=>['provider-epg','provider-games'].includes(call.kind)),false);
  assert.equal((await fetch(f.base+'/api/play/live/1/index.m3u8',{headers})).status,403);assert.equal(f.calls.filter(call=>call.kind==='provider-playback').length,1);
  await fetch(f.base+'/api/stop',{method:'POST',headers:{...headers,Origin:f.base},body:'{}'});assert.equal(f.calls.filter(call=>call.kind==='revoke').length,0);
  await fetch(f.base+'/api/logout',{method:'POST',headers:{...headers,Origin:f.base},body:'{}'});assert.equal(f.calls.filter(call=>call.kind==='revoke').length,1);assert.equal((await fetch(f.base+'/api/catalog?type=live',{headers})).status,401);
});

test('an unavailable cloud never converts a valid WPLAY login into failure or leaks its raw error',async t=>{
  const f=await fixture(t,{cloudFailure:true}),response=await f.login(),headers={Cookie:response.headers.get('set-cookie').split(';')[0]},body=await response.json();
  assert.equal(body.connected,true);assert.equal(body.cloud,null);assert.equal(body.cloudStatus.state,'unavailable');assert.doesNotMatch(JSON.stringify(body),/private password/);
  assert.deepEqual(await (await fetch(f.base+'/api/catalog?type=live',{headers})).json(),{categories:[],items:[]});assert.equal(f.calls.filter(call=>call.kind==='provider-catalog').length,1);
});

test('logout during cloud bootstrap cannot return a late authenticated session or register its client',async t=>{
  let release;const pendingBootstrap=new Promise(resolve=>{release=resolve;}),f=await fixture(t,{pendingBootstrap});
  const initial=await fetch(f.base+'/api/session'),headers={Cookie:initial.headers.get('set-cookie').split(';')[0]};await initial.json();const login=f.login(headers);
  for(let attempt=0;attempt<100&&!f.calls.some(call=>call.kind==='bootstrap');attempt++)await new Promise(resolve=>setImmediate(resolve));
  const logout=await fetch(f.base+'/api/logout',{method:'POST',headers:{...headers,Origin:f.base},body:'{}'});assert.equal(logout.status,200);release();const late=await login;assert.equal(late.status,409);assert.equal((await late.json()).connected,false);assert.equal(f.calls.some(call=>call.kind==='register'),false);
});

test('an inactive provider cannot keep reading global metadata with a previously issued cloud token',async t=>{
  const f=await fixture(t),login=await f.login(),headers={Cookie:login.headers.get('set-cookie').split(';')[0]};await login.json();
  const client=f.clients[0];client.session.account.status='Disabled';client.connect=async()=>client.session;
  const response=await fetch(f.base+'/api/catalog?type=live',{headers});assert.equal(response.status,401);
  assert.equal(f.calls.some(call=>call.kind==='cloud-read'),false);assert.equal(f.calls.some(call=>call.kind==='revoke'),true);
  const denial=f.calls.find(call=>call.kind==='rpc'&&call.name==='arkhen_validate_account');assert.equal(denial.args.p_status,'disabled');
});

test('catalog cache reload returns the committed shared snapshot without forcing another WPLAY update',async t=>{
  const f=await fixture(t);let title='old';
  f.cloud.request=async()=>[{expires_at:'2070-01-01T00:00:00Z',is_complete:true,payload:{categories:[],items:[{id:title,kind:'movie',name:title}]}}];
  const login=await f.login(),headers={Cookie:login.headers.get('set-cookie').split(';')[0]};await login.json();
  const catalog=async query=>{const body=await (await fetch(f.base+'/api/catalog?type=movies'+query,{headers})).json();assert.equal(body.catalogComplete,true);return body.items[0].name;};
  assert.equal(await catalog(''),'old');title='new';assert.equal(await catalog(''),'old');
  assert.equal(await catalog('&cache=reload'),'new');assert.equal(await catalog(''),'new');
  assert.equal(f.calls.some(call=>call.kind==='rpc'&&call.name==='arkhen_request_cache_refresh'),false);
});

test('downloaded sports crests are served only to an authenticated account and support private browser caching',async t=>{
  const ref='a'.repeat(64),bytes=Buffer.from('cached-image'),reads=[];
  const f=await fixture(t,{sportsLogoReader:async key=>{reads.push(key);return key===ref?{bytes,contentType:'image/png'}:null;}}),url=f.base+'/api/sports-image/'+ref;
  assert.equal((await fetch(url)).status,401);assert.equal(reads.length,0);
  const login=await f.login(),headers={Cookie:login.headers.get('set-cookie').split(';')[0]};await login.json();
  const image=await fetch(url,{headers});assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/png');assert.match(image.headers.get('cache-control'),/^private/);assert.equal(await image.text(),'cached-image');
  assert.equal((await fetch(url,{method:'HEAD',headers})).headers.get('content-length'),String(bytes.length));
  assert.equal((await fetch(url,{headers:{...headers,'If-None-Match':image.headers.get('etag')}})).status,304);
  assert.equal((await fetch(f.base+'/api/sports-image/'+'b'.repeat(64),{headers})).status,404);
});
