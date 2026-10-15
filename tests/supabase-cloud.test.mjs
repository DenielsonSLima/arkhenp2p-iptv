import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,unlink,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHmac} from 'node:crypto';
import {SupabaseCloud,normalizeCloudConfig,cloudSourceScope,ARKHEN_SUPABASE_PROJECT} from '../lib/supabase-cloud.mjs';

const config={url:`https://${ARKHEN_SUPABASE_PROJECT}.supabase.co`,publishableKey:'sb_publishable_fixture_1234567890',secretKey:'sb_secret_fixture_123456789012345'};
const libraryHash='a'.repeat(64),userId='d243589c-25c5-4db0-b9aa-c087ace3d180',now=Date.parse('2026-10-15T12:00:00Z');
const account={status:'Active',libraryId:libraryHash,expiresAt:'2026-11-15T00:00:00Z'};
test('an obsolete public RPC can be aborted without retaining a fetch or sending a pre-aborted request',async()=>{
  let calls=0,entered;const started=new Promise(resolve=>{entered=resolve;});
  const cloud=new SupabaseCloud({config,fetch:async(_url,{signal})=>{calls++;entered();return new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError')),{once:true});});}});
  const controller=new AbortController(),pending=cloud.request('/rest/v1/rpc/arkhen_global_search',{publicKey:true,signal:controller.signal});await started;controller.abort();
  await assert.rejects(pending,{name:'AbortError'});await assert.rejects(cloud.request('/rest/v1/rpc/arkhen_global_search',{publicKey:true,signal:controller.signal}),{name:'AbortError'});assert.equal(calls,1);
});
const input=()=>({session:{connected:true,account:{...account}},client:{session:{connected:true},config:{server:'https://auth.example/login?token=never-read',password:'never-store-provider-password'},authenticatedAt:now},provider:'wplay'});
function fixture({existing=false,handler}={}){
  const calls=[],user={id:userId,email:libraryHash+'@accounts.arkhen.invalid',app_metadata:{arkhen_library_hash:libraryHash}};
  let bound=existing;
  const cloud=new SupabaseCloud({config,now:()=>now,fetch:async(url,options)=>{
    const path=new URL(url).pathname,body=options.body===undefined?null:JSON.parse(options.body);calls.push({url,path,body,headers:options.headers,method:options.method});
    const overridden=await handler?.({path,body,options,calls,user});if(overridden)return overridden;
    if(path.endsWith('/arkhen_identity_lookup'))return Response.json(bound?[{user_id:userId}]:[]);
    if(path.endsWith('/arkhen_identity_bind'))bound=true;
    if(path.endsWith('/admin/users'))return Response.json(user);
    if(path.endsWith('/admin/generate_link'))return Response.json({...user,hashed_token:'fixture-generated-token-hash-1234',action_link:'https://do-not-expose.example/secret',email_otp:'123456'});
    if(path.endsWith('/verify'))return Response.json({access_token:'fixture-access-token',refresh_token:'fixture-refresh-token',expires_in:3600,user});
    return new Response(null,{status:204});
  }});
  return {cloud,calls,user};
}

test('cloud configuration is restricted to the explicitly authorized project and separates public/admin keys',()=>{
  assert.equal(normalizeCloudConfig(config).url,config.url);
  for(const url of ['https://other-project.supabase.co',config.url+'/other',config.url+'?key=value','http://'+ARKHEN_SUPABASE_PROJECT+'.supabase.co',`https://user:pass@${ARKHEN_SUPABASE_PROJECT}.supabase.co`])
    assert.throws(()=>normalizeCloudConfig({...config,url}),{code:'CLOUD_PROJECT_MISMATCH'});
  assert.throws(()=>normalizeCloudConfig({...config,publishableKey:config.secretKey}),{code:'CLOUD_CONFIG_INVALID'});
  assert.throws(()=>normalizeCloudConfig({...config,secretKey:config.publishableKey}),{code:'CLOUD_CONFIG_INVALID'});
});

test('Edge gateway configuration is limited to the ARKHEN function and excludes local admin credentials',()=>{
  const gateway={secret:'fixture_gateway_secret_12345678901234567890'},edge={url:config.url,publishableKey:config.publishableKey,gateway};
  assert.deepEqual(normalizeCloudConfig(edge),{...edge,gateway:{...gateway,url:config.url+'/functions/v1/arkhen-backend'}});
  for(const update of [{...edge,secretKey:config.secretKey},{...edge,serviceRoleKey:config.secretKey},{...edge,gateway:{secret:'short'}},
    {...edge,gateway:{...gateway,url:'https://other.example/functions/v1/arkhen-backend'}},{...edge,gateway:{...gateway,url:config.url+'/functions/v1/other'}}])
    assert.throws(()=>normalizeCloudConfig(update),{code:'CLOUD_CONFIG_INVALID'});
});

test('privileged requests use signed Edge envelopes while public and user requests retain scoped API authentication',async()=>{
  const calls=[],gateway={secret:'fixture_gateway_secret_12345678901234567890'};
  const cloud=new SupabaseCloud({config:{url:config.url,publishableKey:config.publishableKey,gateway},now:()=>now,
    fetch:async(url,options)=>{calls.push({url,...options});return Response.json({ok:true});}});
  await cloud.rpc('arkhen_identity_lookup',{p_library_hash:libraryHash});
  const signed=calls[0],headers=signed.headers,envelope=JSON.parse(signed.body);
  assert.equal(signed.url,config.url+'/functions/v1/arkhen-backend');assert.equal(signed.method,'POST');
  assert.deepEqual(envelope,{path:'/rest/v1/rpc/arkhen_identity_lookup',method:'POST',body:{p_library_hash:libraryHash}});
  assert.equal(headers['x-arkhen-timestamp'],String(now));assert.match(headers['x-arkhen-nonce'],/^[a-f0-9]{32}$/);
  assert.equal(headers['x-arkhen-signature'],createHmac('sha256',gateway.secret).update(`${now}.${headers['x-arkhen-nonce']}.${signed.body}`).digest('hex'));
  assert.equal(headers.apikey,undefined);assert.equal(headers.Authorization,undefined);
  assert.doesNotMatch(JSON.stringify(cloud.publicConfig()),/gateway|secret/);assert.equal(JSON.stringify(signed).includes(gateway.secret),false);
  await cloud.request('/auth/v1/verify',{method:'POST',publicKey:true,body:{token_hash:'test-token',type:'email'}});
  assert.equal(calls[1].url,config.url+'/auth/v1/verify');assert.equal(calls[1].headers.apikey,config.publishableKey);assert.equal(calls[1].headers['x-arkhen-signature'],undefined);
  await cloud.revoke('device-access');
  assert.equal(calls[2].url,config.url+'/auth/v1/logout?scope=local');assert.equal(calls[2].headers.Authorization,'Bearer device-access');assert.equal(calls[2].headers.apikey,config.publishableKey);
});

test('provider authentication, collection wakeup and artwork use restricted signed gateway operations',async()=>{
  const calls=[],gateway={secret:'fixture_gateway_secret_12345678901234567890'},providerKey='a'.repeat(64),scopeHash='b'.repeat(64),ref='c'.repeat(64);
  let artworkURL=config.url+`/storage/v1/object/public/arkhen-catalog-artwork/${providerKey}/${scopeHash}/${ref}`;
  const cloud=new SupabaseCloud({config:{url:config.url,publishableKey:config.publishableKey,gateway},fetch:async(url,options)=>{
    const envelope=JSON.parse(options.body);calls.push(envelope);
    return Response.json(envelope.path==='/providers/wplay/auth'?{payload:{code:0},cloudCollector:false}:envelope.path==='/providers/wplay/artwork'?{url:artworkURL}:true);
  }});await cloud.ready;
  assert.equal(cloud.providerAuthenticationEnabled,true);
  assert.deepEqual(await cloud.authenticateWplay({server:'https://auth1.wareztv.io/api/v2/auth',form:'username=fixture&password=private',userAgent:'FixtureUA'}),{payload:{code:0},cloudCollector:false});
  assert.deepEqual(calls[0],{path:'/providers/wplay/auth',method:'POST',body:{server:'https://auth1.wareztv.io/api/v2/auth',form:'username=fixture&password=private',userAgent:'FixtureUA'}});
  assert.equal(await cloud.artwork({providerKey,scopeHash,ref}),artworkURL);
  const source={url:'https://covers.arkhen.media/poster.jpg?t=private',userAgent:'FixtureUA'};
  assert.equal(await cloud.artwork({providerKey,scopeHash,ref,source}),artworkURL);assert.deepEqual(calls.at(-1).body.source,source);
  await assert.rejects(cloud.artwork({providerKey,scopeHash,ref,source:{...source,headers:{Authorization:'forbidden'}}}),{code:'CLOUD_ARTWORK_SOURCE_INVALID'});
  for(const invalid of ['https://foreign.arkhen.media/poster',config.url+'/storage/v1/object/public/other/'+ref,artworkURL+'?token=secret']){artworkURL=invalid;assert.equal(await cloud.artwork({providerKey,scopeHash,ref}),null);}
  await cloud.kickCollector();assert.deepEqual(calls.at(-1),{path:'/rest/v1/rpc/arkhen_kick_cloud_collector',method:'POST',body:{}});
  const direct=new SupabaseCloud({config,fetch:()=>assert.fail('Provider forwarding requires the restricted gateway.')});await assert.rejects(direct.authenticateWplay({}),{code:'CLOUD_PROVIDER_AUTH_UNAVAILABLE'});
});

test('absent configuration disables cloud without contacting a project',async()=>{
  const cloud=new SupabaseCloud({config:null,fetch:()=>assert.fail('No network expected')});assert.equal(await cloud.ready,false);assert.equal(cloud.enabled,false);assert.equal(cloud.publicConfig(),null);
  await assert.rejects(cloud.bootstrap(input()),{code:'CLOUD_NOT_CONFIGURED'});
});

test('provisioning or repairing the server-only config activates cloud without restarting the process',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'arkhen-cloud-configuration-')),configPath=join(directory,'supabase.json');
  t.after(async()=>{await unlink(configPath);await rmdir(directory);});
  let clock=now;
  const cloud=new SupabaseCloud({configPath,now:()=>clock,fetch:()=>assert.fail('Configuration never makes a network request')});
  assert.equal(await cloud.ready,false);assert.equal(cloud.publicConfig(),null);
  await writeFile(configPath,JSON.stringify(config));
  assert.equal(await cloud.refreshConfiguration(),false,'Missing configuration checks are throttled.');
  clock+=5000;assert.equal(await cloud.refreshConfiguration(),true);assert.equal(cloud.enabled,true);
  assert.deepEqual(cloud.publicConfig(),{url:config.url,publishableKey:config.publishableKey});
  await writeFile(configPath,'invalid');clock+=5000;
  assert.equal(await cloud.refreshConfiguration(),true,'Active sessions retain their validated project and configuration.');
  const repaired=new SupabaseCloud({configPath,now:()=>clock});
  await assert.rejects(repaired.ready,{code:'CLOUD_CONFIG_INVALID'});
  await writeFile(configPath,JSON.stringify(config));clock+=5000;
  assert.equal(await repaired.refreshConfiguration(),true);assert.equal(repaired.enabled,true);
});

test('a validated provider login creates a separate random-password Auth identity and a real OTP session',async()=>{
  const {cloud,calls}=fixture();const result=await cloud.bootstrap(input());
  assert.equal(result.userId,userId);assert.equal(result.session.access_token,'fixture-access-token');assert.equal(result.session.refresh_token,'fixture-refresh-token');
  assert.deepEqual(result.session.user,{id:userId});assert.deepEqual(cloud.publicConfig(),{url:config.url,publishableKey:config.publishableKey});
  const create=calls.find(call=>call.path.endsWith('/admin/users'));assert.equal(create.body.email,libraryHash+'@accounts.arkhen.invalid');assert.equal(create.body.email_confirm,true);assert.ok(create.body.password.length>=48);assert.notEqual(create.body.password,input().client.config.password);
  assert.deepEqual(create.body.app_metadata,{arkhen_provider:'wplay',arkhen_library_hash:libraryHash});
  assert.equal(calls.some(call=>call.path.endsWith('/otp')||call.path.endsWith('/invite')),false);
  const verify=calls.find(call=>call.path.endsWith('/verify'));assert.deepEqual(verify.body,{token_hash:'fixture-generated-token-hash-1234',type:'email'});
  assert.equal(verify.headers.apikey,config.publishableKey);assert.equal(verify.headers.Authorization,undefined);
  assert.equal(create.headers.apikey,config.secretKey);assert.equal(create.headers.Authorization,undefined,'New secret keys are API keys, not bearer JWTs.');
  assert.doesNotMatch(JSON.stringify(result),/sb_secret|action_link|email_otp|password|never-read/);
  assert.doesNotMatch(JSON.stringify(calls.map(call=>({path:call.path,body:call.body}))),/never-store-provider-password|never-read/);
  const validate=calls.find(call=>call.path.endsWith('/arkhen_validate_account'));assert.equal(validate.body.p_validated_at,new Date(now).toISOString());assert.equal(validate.body.p_expires_at,account.expiresAt);assert.equal(validate.body.p_status,'active');
});

test('concurrent devices serialize one-use links and create independent refresh sessions for one identity',async()=>{
  let releaseFirst,firstStarted,links=0;const verified=new Set();
  const firstVerify=new Promise(resolve=>{firstStarted=resolve;}),release=new Promise(resolve=>{releaseFirst=resolve;});
  const f=fixture({handler:async({path,body,options,user})=>{
    if(path.endsWith('/admin/generate_link')){links++;return Response.json({...user,hashed_token:`fixture-generated-token-hash-${links}`});}
    if(path.endsWith('/verify')){
      const number=body.token_hash.split('-').at(-1);if(number==='1'){firstStarted();await release;}
      verified.add(number);return Response.json({access_token:`access-device-${number}`,refresh_token:`refresh-device-${number}`,expires_in:3600,user});
    }
    if(path.endsWith('/logout'))verified.delete(options.headers.Authorization.split('-').at(-1));
  }});
  const first=f.cloud.bootstrap(input()),second=f.cloud.bootstrap(input());await firstVerify;
  assert.equal(links,1,'A second magic link cannot invalidate the first OTP before verification.');
  releaseFirst();const [a,b]=await Promise.all([first,second]);
  assert.equal(a.userId,b.userId);assert.notEqual(a.session.refresh_token,b.session.refresh_token);assert.notEqual(a.session.access_token,b.session.access_token);
  assert.equal(f.calls.filter(call=>call.path.endsWith('/admin/users')).length,1);
  assert.equal(f.calls.filter(call=>call.path.endsWith('/admin/generate_link')).length,2);assert.deepEqual([...verified],['1','2']);
  await f.cloud.revoke(a.session.access_token);
  assert.equal(f.calls.at(-1).headers.Authorization,'Bearer access-device-1');assert.deepEqual([...verified],['2'],'Local logout never targets the second device token.');
  await f.cloud.bootstrap(input());assert.equal(links,3,'A later login also obtains its own refresh session.');assert.equal(f.cloud.bootstraps.size,0);
});

test('a failed queued bootstrap does not prevent the next device from connecting',async()=>{
  let links=0;const f=fixture({existing:true,handler:({path})=>path.endsWith('/admin/generate_link')&&++links===1?Response.json({message:'Temporary failure'},{status:503}):null});
  const results=await Promise.allSettled([f.cloud.bootstrap(input()),f.cloud.bootstrap(input())]);
  assert.equal(results[0].status,'rejected');assert.equal(results[1].status,'fulfilled');assert.equal(results[1].value.userId,userId);assert.equal(f.cloud.bootstraps.size,0);
});

test('an orphan created by an earlier interruption is adopted only with matching server-controlled identity metadata',async()=>{
  const f=fixture({handler:({path})=>path.endsWith('/admin/users')?Response.json({code:'email_exists',message:'private service detail'},{status:422}):null});
  assert.equal((await f.cloud.bootstrap(input())).userId,userId);
  const mismatch=fixture({handler:({path,user})=>path.endsWith('/admin/generate_link')?Response.json({...user,app_metadata:{},hashed_token:'fixture-generated-token-hash-1234'}):null});
  await assert.rejects(mismatch.cloud.bootstrap(input()),{code:'CLOUD_IDENTITY_INVALID'});assert.equal(mismatch.calls.some(call=>call.path.endsWith('/verify')),false);
});

test('no Auth account or cloud session is created without current accepted provider access',async()=>{
  for(const change of [v=>v.session.connected=false,v=>v.client.session.connected=false,v=>v.session.account.status='Expired',v=>v.session.account.expiresAt='2026-10-01T00:00:00Z',v=>v.client.authenticatedAt=now-86400001,v=>v.provider='xtream',v=>v.session.account.libraryId='not-an-account-hash']){
    const f=fixture(),value=input();change(value);await assert.rejects(f.cloud.bootstrap(value),{code:'CLOUD_PROVIDER_VALIDATION_REQUIRED'});assert.equal(f.calls.length,0);
  }
});

test('global metadata shares a provider origin scope without publishing usernames or authentication query values',()=>{
  const first=cloudSourceScope('wplay','https://auth.example/login?token=one'),second=cloudSourceScope('wplay','https://name:pass@auth.example/another?token=two');assert.deepEqual(first,second);
  assert.match(first.providerKey,/^[a-f0-9]{64}$/);assert.match(first.scopeHash,/^[a-f0-9]{64}$/);
  assert.notDeepEqual(first,cloudSourceScope('wplay','https://other.example'));
});

test('remote failures and invalid paths never expose credentials or raw upstream response messages',async()=>{
  const f=fixture({handler:()=>Response.json({message:config.secretKey+' password=private https://private.example'},{status:500})});
  await assert.rejects(f.cloud.bootstrap(input()),error=>error.code==='CLOUD_REQUEST_FAILED'&&!/sb_secret|private|https:/.test(error.message));
  await assert.rejects(f.cloud.request('https://evil.example'),{code:'CLOUD_PATH_INVALID'});await assert.rejects(f.cloud.rpc('arbitrary_function'),{code:'CLOUD_RPC_INVALID'});
});

test('local logout sends the user access token and never revokes another device globally',async()=>{
  const f=fixture();await f.cloud.ready;await f.cloud.revoke('fixture-user-access');assert.match(f.calls[0].url,/\/logout\?scope=local$/);assert.equal(f.calls[0].headers.Authorization,'Bearer fixture-user-access');
});

test('large metadata publications have a longer bounded deadline without extending login requests',async()=>{
  const cloud=new SupabaseCloud({config,timeoutMs:20,publicationTimeoutMs:200,fetch:async(url,{signal})=>{
    await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,60);signal.addEventListener('abort',()=>{clearTimeout(timer);reject(new Error('aborted private details'));},{once:true});});
    return new Response(null,{status:204});
  }});
  await assert.rejects(cloud.request('/auth/v1/admin/users'),{code:'CLOUD_TIMEOUT'});
  assert.equal(await cloud.rpc('arkhen_publish_catalog',{}),null);
});

test('database statement timeout is identifiable without exposing its SQL or raw error text',async()=>{
  const cloud=new SupabaseCloud({config,fetch:async()=>Response.json({code:'57014',message:'statement details secret SQL'},{status:500})});
  await assert.rejects(cloud.rpc('arkhen_publish_epg_batch',{}),error=>error.code==='CLOUD_DATABASE_TIMEOUT'&&!/secret|SQL|details/.test(error.message));
});
