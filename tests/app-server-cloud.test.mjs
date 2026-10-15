import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../lib/app-server.mjs';
import {ProviderError} from '../lib/provider.mjs';
import {createHash} from 'node:crypto';
import {catalogReadFixture} from './helpers/catalog-read-fixture.mjs';

const providerKey='a'.repeat(64),scopeHash='b'.repeat(64),userId='d243589c-25c5-4db0-b9aa-c087ace3d180';
async function fixture(t,{cloudFailure=false,pendingBootstrap,sportsLogoReader,sportsLogoMirror}={}){
  const calls=[],clients=[],config={url:'https://wnicimkmzswksaqdtgdv.supabase.co',publishableKey:'sb_publishable_fixture_1234567890'};
  const cloud={ready:Promise.resolve(true),enabled:true,publicConfig:()=>config,
    async bootstrap(value){calls.push({kind:'bootstrap',value});if(pendingBootstrap)await pendingBootstrap;if(cloudFailure)throw Object.assign(new Error('private password token'),{code:'CLOUD_REQUEST_FAILED'});return {...config,userId,providerKey,scopeHash,session:{access_token:'fixture-access',refresh_token:'fixture-refresh',expires_in:3600}};},
    async revoke(value){calls.push({kind:'revoke',value});},async rpc(name,args){calls.push({kind:'rpc',name,args});},
    async request(url){calls.push({kind:'cloud-read',url});const expires_at='2070-01-01T00:00:00Z';if(/\/(provider_catalog_cache|catalog_categories|catalog_media)\?/.test(url))return catalogReadFixture({categories:[{id:'1',name:'GLOBAL'}],items:[{id:'1',kind:'live',name:'GLOBAL CHANNEL',poster:''}]})(url);if(url.includes('/provider_epg_cache?'))return [{expires_at,payload:{list:[{title:'GLOBAL EPG'}]}}];if(url.includes('/provider_games_cache?'))return [{expires_at,payload:{available:true,date:'2026-10-15',timeZone:'America/Maceio',games:[{id:'global-game'}]}}];return [];}};
  const worker={registerSource:value=>calls.push({kind:'register',value}),unregisterSource:value=>calls.push({kind:'unregister',value}),start:()=>calls.push({kind:'worker-start'}),stop:()=>calls.push({kind:'worker-stop'}),tick:async()=>calls.push({kind:'worker-tick'})};
  const providerFactory=({config})=>{const client={config,images:new Map(),async connect(){this.authenticatedAt=Date.now();this.session={connected:true,account:{status:'Active',expiresAt:'2070-01-01T00:00:00Z'}};return this.session;},async logout(){calls.push({kind:'provider-logout'});this.session=null;},async stopPlayback(){calls.push({kind:'provider-stop'});},async catalog(){calls.push({kind:'provider-catalog'});return {categories:[],items:[]};},async epg(){calls.push({kind:'provider-epg'});return {list:[]};},async games(){calls.push({kind:'provider-games'});return {available:true,games:[]};},async details(){calls.push({kind:'provider-details'});return {id:'1',plot:'individual'};},async playbackURL(){calls.push({kind:'provider-playback'});throw new ProviderError('Esta conta não tem acesso a essa mídia.','ACCOUNT_MEDIA_UNAVAILABLE',403);},playbackGeneration:0,invalidateCatalog(){}};clients.push(client);return client;};
  const app=createApp({connection:{server:'https://fixture.example'},nativeBridge:null,cloud,sharedWorker:worker,providerFactory,sportsLogoReader,sportsLogoMirror});await new Promise((resolve,reject)=>{app.once('error',reject);app.listen(0,'127.0.0.1',resolve);});
  t.after(async()=>{app.closeAllConnections?.();await app.shutdown();});const base=`http://127.0.0.1:${app.address().port}`;
  const login=async headers=>fetch(base+'/api/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json',...headers},body:JSON.stringify({provider:'wplay',username:'fixture-user',password:'private-provider-password'})});
  return {base,app,cloud,calls,clients,login};
}

test('authenticated login and session expose cloud bootstrap; cache endpoints are primary while playback remains individual',async t=>{
  const f=await fixture(t),response=await f.login(),headers={Cookie:response.headers.get('set-cookie').split(';')[0]},body=await response.json();
  assert.equal(response.status,200);assert.equal(body.connected,true);assert.equal(body.capabilities.cloud,true);assert.equal(body.cloud.userId,userId);assert.equal(body.cloud.provider,'wplay');assert.equal(body.cloud.libraryId,body.account.libraryId);assert.equal(body.cloud.session.access_token,'fixture-access');assert.doesNotMatch(JSON.stringify(body),/private-provider-password/);
  const csp=response.headers.get('content-security-policy');assert.match(csp,/https:\/\/wnicimkmzswksaqdtgdv\.supabase\.co/);assert.match(csp,/wss:\/\/wnicimkmzswksaqdtgdv\.supabase\.co/);
  const imageWarmCatalogs=f.calls.filter(call=>call.kind==='provider-catalog').length;assert.equal(imageWarmCatalogs,0,'Attaching a cloud account must not download provider catalogs to restore artwork.');
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

test('session bootstrap recovery requires the existing provider cookie and repeated requests reuse one recovery',async t=>{
  const f=await fixture(t);
  assert.equal((await (await fetch(f.base+'/api/session?cloud=refresh')).json()).connected,false);assert.equal(f.calls.some(row=>row.kind==='bootstrap'),false);
  const login=await f.login(),headers={Cookie:login.headers.get('set-cookie').split(';')[0]};await login.json();
  const before=f.calls.filter(row=>row.kind==='bootstrap').length;
  const recovered=await Promise.all([fetch(f.base+'/api/session?cloud=refresh',{headers}),fetch(f.base+'/api/session?cloud=refresh',{headers})]);
  for(const response of recovered){const data=await response.json();assert.equal(data.connected,true);assert.equal(data.cloud.userId,userId);assert.equal(data.cloudStatus.state,'ready');}
  assert.equal(f.calls.filter(row=>row.kind==='bootstrap').length,before+1);assert.equal(f.calls.some(row=>row.kind==='revoke'),false);
  await (await fetch(f.base+'/api/session?cloud=refresh',{headers})).json();assert.equal(f.calls.filter(row=>row.kind==='bootstrap').length,before+1);
});

test('cloud activation recovers the same browser account without requiring another provider login',async t=>{
  const f=await fixture(t);f.cloud.enabled=false;
  const document=await fetch(f.base+'/');assert.match(document.headers.get('content-security-policy'),/wss:\/\/wnicimkmzswksaqdtgdv\.supabase\.co/);await document.text();
  const response=await f.login(),headers={Cookie:response.headers.get('set-cookie').split(';')[0]},initial=await response.json();
  assert.equal(initial.connected,true);assert.equal(initial.cloud,null);assert.equal(initial.cloudStatus.code,'CLOUD_NOT_CONFIGURED');
  assert.equal(f.calls.some(call=>call.kind==='bootstrap'),false);
  f.cloud.enabled=true;
  const recovered=await (await fetch(f.base+'/api/session',{headers})).json();
  assert.equal(recovered.connected,true);assert.equal(recovered.cloudStatus.state,'ready');assert.equal(recovered.cloud.userId,userId);
  assert.equal(recovered.account.libraryId,initial.account.libraryId);assert.equal(f.clients.length,1);
});

test('two browser cookies share the provider account library and logout leaves the second browser connected',async t=>{
  const f=await fixture(t),first=await f.login(),firstCookie=first.headers.get('set-cookie').split(';')[0],a=await first.json();
  const second=await f.login(),secondCookie=second.headers.get('set-cookie').split(';')[0],b=await second.json();
  assert.notEqual(firstCookie,secondCookie);assert.equal(a.account.libraryId,b.account.libraryId);assert.equal(a.cloud.userId,b.cloud.userId);assert.equal(f.clients.length,2);
  await (await fetch(f.base+'/api/logout',{method:'POST',headers:{Cookie:firstCookie,Origin:f.base},body:'{}'})).json();
  const retained=await (await fetch(f.base+'/api/session',{headers:{Cookie:secondCookie}})).json();
  assert.equal(retained.connected,true);assert.equal(retained.cloud.userId,b.cloud.userId);assert.equal(retained.account.libraryId,b.account.libraryId);
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
  f.cloud.request=async path=>catalogReadFixture({items:[{id:title,kind:'movie',name:title}]})(path);
  const login=await f.login(),headers={Cookie:login.headers.get('set-cookie').split(';')[0]};await login.json();
  const catalog=async query=>{const body=await (await fetch(f.base+'/api/catalog?type=movies'+query,{headers})).json();assert.equal(body.catalogComplete,true);return body.items[0].name;};
  assert.equal(await catalog(''),'old');title='new';assert.equal(await catalog(''),'old');
  assert.equal(await catalog('&cache=reload'),'new');assert.equal(await catalog(''),'new');
  assert.equal(f.calls.some(call=>call.kind==='rpc'&&call.name==='arkhen_request_cache_refresh'),false);
});

test('the complete catalog API exposes its real publication revision and keeps every item unpaged',async t=>{
  const f=await fixture(t),items=Array.from({length:181},(_,i)=>({id:String(i+1),kind:'movie',name:'Published film '+i,categoryId:'1'}));
  f.cloud.request=async path=>catalogReadFixture({categories:[{id:'1',name:'Cinema'}],items})(path);
  const login=await f.login(),headers={Cookie:login.headers.get('set-cookie').split(';')[0]};await login.json();
  const response=await fetch(f.base+'/api/catalog?type=movies',{headers}),body=await response.json();
  assert.equal(response.status,200);assert.equal(body.items.length,181);assert.equal(body.catalogComplete,true);assert.equal(body.pagination.mode,'complete');assert.equal(body.pagination.source,'supabase');
  assert.equal(body.pagination.snapshotId,userId);assert.equal(body.pagination.revisionAt,'2026-10-15T15:00:00.000Z');assert.equal(body.pagination.total,181);
  assert.equal(f.calls.some(call=>call.kind==='provider-catalog'),false,'Published metadata does not enumerate the private provider.');
});
test('daily navigation model is attached only to its matching snapshot and adult scope',async t=>{
  const f=await fixture(t),items=[{id:'1',kind:'movie',name:'Film',categoryId:'1'}],read=catalogReadFixture({categories:[{id:'1',name:'Cinema'}],items});
  let model={schemaVersion:1,mediaType:'movies',snapshotId:userId,revisionAt:'2026-10-15T15:00:00+00:00',includeAdult:false,total:1,orders:{name:['1'],date:['1'],rating:['1']},categories:[],genres:[]};
  f.cloud.request=async path=>path.endsWith('/arkhen_catalog_read_model')?model:read(path);
  const login=await f.login(),headers={Cookie:login.headers.get('set-cookie').split(';')[0]};await login.json();
  const get=async()=>await(await fetch(f.base+'/api/catalog?type=movies',{headers})).json();
  assert.deepEqual((await get()).readModel,model,'Equivalent ISO offsets must match the publication time.');
  for(const update of [{includeAdult:true},{snapshotId:'00000000-0000-4000-8000-000000000001'},{total:2},{revisionAt:'2026-10-14T15:00:00Z'}]){
    const before=model;model={...model,...update};const data=await get();assert.equal(data.readModel,undefined);assert.equal(data.items.length,1);model=before;
  }
});

test('the paged catalog endpoint reads a bounded Supabase page and keeps provider catalogs idle',async t=>{
  const f=await fixture(t),requests=[];
  f.cloud.request=async(path,options)=>{requests.push({path,options});assert.equal(path,'/rest/v1/rpc/arkhen_catalog_page');return {categories:[{id:'safe',name:'Cinema'}],items:[{id:'120',name:'Cached film',kind:'movie',categoryId:'safe'}],catalogComplete:false,pagination:{mode:'category',source:'supabase',snapshotId:userId,expiresAt:'2070-01-01T00:00:00Z',globalCategory:'__all',byCategory:{__all:{loaded:true,nextPage:2,nextCursor:120,hasMore:true}}}};};
  const login=await f.login(),headers={Cookie:login.headers.get('set-cookie').split(';')[0]};await login.json();
  const result=await (await fetch(f.base+'/api/catalog?type=movies&paged=1',{headers})).json();
  assert.equal(result.pagination.source,'supabase');assert.equal(result.items.length,1);assert.equal(result.pagination.byCategory.__all.nextCursor,120);
  assert.equal(requests[0].options.body.p_limit,120);assert.equal(requests[0].options.body.p_include_adult,false);assert.equal(requests[0].options.accessToken,'fixture-access');assert.equal(f.calls.some(call=>call.kind==='provider-catalog'),false);
});

test('old browser catalog scans cannot start a second local collection while the cloud snapshot is preparing',async t=>{
  const f=await fixture(t);f.cloud.request=async()=>[];const login=await f.login(),headers={Cookie:login.headers.get('set-cookie').split(';')[0]};await login.json();f.clients[0].cloudCollection=true;
  f.clients[0].catalogPage=()=>assert.fail('Cloud-managed metadata cannot be enumerated again by an old browser.');
  for(let page=1;page<=30;page++){const data=await(await fetch(f.base+'/api/catalog?type=movies&category=1&page='+page,{headers})).json();assert.equal(data.preparing,true);assert.equal(data.catalogComplete,false);assert.deepEqual(data.items,[]);assert.equal(data.pagination.source,'preparing');}
  assert.equal(f.calls.some(row=>row.kind==='provider-catalog'),false);
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

test('a cloud games logo is mirrored locally only after a scoped JWT lookup proves its exact logo field',async t=>{
  const logo='c'.repeat(64),adultPoster='d'.repeat(64),local=new Map(),mirrors=[],artworks=[],reads=[];
  const f=await fixture(t,{sportsLogoReader:async ref=>local.get(ref)||null,sportsLogoMirror:async(ref,url)=>{mirrors.push({ref,url});const image={bytes:Buffer.from('local-crest'),contentType:'image/png'};local.set(ref,image);return image;}});
  f.cloud.request=async(path,options)=>{reads.push({path,options});assert.match(path,/^\/rest\/v1\/provider_games_cache\?/);return [{payload:{games:[{league:{logo:'/api/sports-image/'+logo},plot:'/api/sports-image/'+adultPoster}]}}];};
  f.cloud.artwork=async args=>{artworks.push(args);return `https://wnicimkmzswksaqdtgdv.supabase.co/storage/v1/object/public/arkhen-catalog-artwork/${providerKey}/${scopeHash}/${args.ref}`;};
  const login=await f.login(),headers={Cookie:login.headers.get('set-cookie').split(';')[0]};await login.json();
  const allowed=await fetch(f.base+'/api/sports-image/'+logo,{headers});assert.equal(allowed.status,200);assert.equal(await allowed.text(),'local-crest');
  const params=new URLSearchParams(reads[0].path.split('?')[1]);assert.equal(params.get('provider_key'),'eq.'+providerKey);assert.equal(params.get('scope_hash'),'eq.'+scopeHash);assert.equal(params.get('limit'),'8');assert.equal(reads[0].options.accessToken,'fixture-access');
  assert.equal((await fetch(f.base+'/api/sports-image/'+adultPoster,{headers})).status,404);assert.equal(artworks.length,1);assert.equal(mirrors.length,1);
  assert.equal((await fetch(f.base+'/api/sports-image/'+logo,{headers})).status,200);assert.equal(mirrors.length,1);assert.equal(reads.length,1,'Partition logo references are reused briefly; bytes stay in the local logo cache.');
});

test('a permitted cold poster warms global Storage from one lazy item while an adult poster cannot supply a source',async t=>{
  const canonical='https://covers.arkhen.media/poster.jpg',origin=canonical+'?t=private-token',ref=createHash('sha256').update(JSON.stringify([providerKey,scopeHash,canonical])).digest('hex'),adultRef='f'.repeat(64),artworks=[],details=[];
  const f=await fixture(t),location=`https://wnicimkmzswksaqdtgdv.supabase.co/storage/v1/object/public/arkhen-catalog-artwork/${providerKey}/${scopeHash}/${ref}`;
  f.cloud.request=async path=>{
    const query=new URLSearchParams(path.split('?')[1]);
    if(path.includes('/catalog_artwork_refs?'))return [{media_type:'movies',media_id:query.get('ref')==='eq.'+adultRef?'999':'120',field:'poster'}];
    if(path.includes('/catalog_media?')){const adult=query.get('media_id')==='eq.999';return [{metadata:{id:adult?'999':'120',name:adult?'Conteudo 18+':'Safe film',kind:'movie',poster:'/api/shared-image/'+(adult?adultRef:ref)},is_adult:adult}];}
    return [];
  };
  f.cloud.artwork=async args=>{artworks.push(args);return args.source?location:null;};
  const login=await f.login(),headers={Cookie:login.headers.get('set-cookie').split(';')[0]};await login.json();
  f.clients[0].upstreamHeaders=()=>({'User-Agent':'FixtureAndroid'});f.clients[0].artworkMetadata=async(kind,id)=>{details.push({kind,id});f.clients[0].images.set('lazy',origin);return {poster:'/api/image?ref=lazy'};};
  const response=await fetch(f.base+'/api/shared-image/'+ref,{headers,redirect:'manual'});assert.equal(response.status,302);assert.equal(response.headers.get('location'),location);
  assert.deepEqual(details,[{kind:'movie',id:'120'}]);assert.equal(artworks.length,2);assert.deepEqual(artworks[1].source,{url:origin,userAgent:'FixtureAndroid'});assert.equal(f.calls.some(call=>call.kind==='provider-catalog'),false);
  assert.equal((await fetch(f.base+'/api/shared-image/'+adultRef,{headers,redirect:'manual'})).status,403);assert.equal(artworks.length,2);assert.equal(details.length,1);
});
