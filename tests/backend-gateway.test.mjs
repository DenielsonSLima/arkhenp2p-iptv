import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,randomBytes} from 'node:crypto';
import {createBackendGateway,PROJECT_URL} from '../supabase/functions/arkhen-backend/handler.mjs';

const secret='fixture_backend_secret_123456789012345678901',serviceKey='sb_secret_fixture_admin_12345678901234567890';
const clock=Date.parse('2026-10-15T15:00:00Z'),hash='a'.repeat(64),partition={p_provider_key:'b'.repeat(64),p_scope_hash:'c'.repeat(64)};
const userId='d243589c-25c5-4db0-b9aa-c087ace3d180',email=hash+'@accounts.arkhen.invalid';
const user={id:userId,email,app_metadata:{arkhen_library_hash:hash,arkhen_provider:'wplay'}};
const rpc=(name,body)=>({path:'/rest/v1/rpc/'+name,method:'POST',body});
function fixture({handler,environment={},maxBytes}={}){
  const calls=[],env={ARKHEN_BACKEND_SECRET:secret,SUPABASE_SECRET_KEYS:JSON.stringify({default:serviceKey}),...environment};
  const gateway=createBackendGateway({environment:name=>env[name],now:()=>clock,...(maxBytes?{maxBytes}:{}),fetch:async(url,options)=>{
    const call={url,...options,body:options.body?JSON.parse(options.body):undefined};calls.push(call);
    const result=await handler?.(call);if(result)return result;
    if(url.endsWith('/auth/v1/admin/users'))return Response.json({...user,identities:[{private:'not-forwarded'}]});
    if(url.endsWith('/auth/v1/admin/generate_link'))return Response.json({user,properties:{hashed_token:'generated-otp-token-hash-123456',action_link:'https://private.example/otp',email_otp:'123456'}});
    return Response.json(null);
  }});
  return {gateway,calls};
}
function signed(envelope,{timestamp=String(clock),nonce=randomBytes(16).toString('hex'),signature,headers={},body,method='POST'}={}){
  const raw=body??JSON.stringify(envelope),hmac=signature??createHmac('sha256',secret).update(`${timestamp}.${nonce}.${raw}`).digest('hex');
  return new Request(PROJECT_URL+'/functions/v1/arkhen-backend',{method,headers:{'Content-Type':'application/json','x-arkhen-timestamp':timestamp,'x-arkhen-nonce':nonce,'x-arkhen-signature':hmac,...headers},...(method==='POST'?{body:raw}:{})});
}
const marker=()=>({series_slug:'game-of-thrones',season:5,episode:1,edition_id:'skipdb-'+ 'd'.repeat(24),tmdb_id:1399,imdb_id:'tt0944947',duration_seconds:3131.6,tolerance_seconds:2,verification:'community-reference',markers:{creditsStart:3000},
  provenance:{source:'skipdb',license:'ODbL 1.0 + Service Provider Reciprocity',licenseUrl:'https://skipdb.tv/license',dumpUrl:'https://skipdb.tv/api/dump',dumpGeneratedAt:new Date(clock).toISOString(),retrievedAt:new Date(clock).toISOString(),sources:[{title:'SkipDB',url:'https://skipdb.tv/api/segments?imdb_id=tt0944947&season=5&episode=1&duration=3131.6&adjust=none',retrievedAt:new Date(clock).toISOString()}],verification:{status:'community-reference',notes:['Community timestamps.']},evidence:[{id:1,imdb_id:'tt0944947',media_type:'series',season:5,episode:1,segment_type:'outro',start_ms:3000000,end_ms:3131600,duration_ms:3131600,score:0}]},data_version:'skipdb.20261015T150000000Z',is_active:true});

test('a signed administrative operation is limited to the fixed project and uses only injected service keys',async()=>{
  const f=fixture(),response=await f.gateway(signed(rpc('arkhen_identity_lookup',{p_library_hash:hash})));
  assert.equal(response.status,200);assert.equal(f.calls.length,1);assert.equal(f.calls[0].url,PROJECT_URL+'/rest/v1/rpc/arkhen_identity_lookup');assert.equal(f.calls[0].redirect,'error');
  assert.deepEqual(f.calls[0].body,{p_library_hash:hash});assert.equal(f.calls[0].headers.apikey,serviceKey);assert.equal(f.calls[0].headers.Authorization,undefined);
  assert.equal(f.calls[0].headers['x-arkhen-signature'],undefined);assert.doesNotMatch(await response.text(),/sb_secret|fixture_backend_secret/);assert.equal(response.headers.get('access-control-allow-origin'),null);
});

test('invalid signatures, stale or future timestamps, Origin and known replay never reach Supabase',async()=>{
  const f=fixture(),envelope=rpc('arkhen_identity_lookup',{p_library_hash:hash});
  for(const options of [{signature:'0'.repeat(64)},{timestamp:String(clock-120001)},{timestamp:String(clock+120001)},{nonce:'wrong'},{headers:{Origin:'https://untrusted.example'}},{method:'GET'}])assert.ok((await f.gateway(signed(envelope,options))).status>=400);
  const original=signed(envelope),replay=original.clone();assert.equal((await f.gateway(original)).status,200);assert.equal((await f.gateway(replay)).status,409);assert.equal(f.calls.length,1);
});

test('body byte bounds apply to declared and streamed data before any upstream call',async()=>{
  const f=fixture({maxBytes:100}),envelope=rpc('arkhen_identity_lookup',{p_library_hash:hash});
  assert.equal((await f.gateway(signed(envelope,{headers:{'Content-Length':'101'}}))).status,413);
  assert.equal((await f.gateway(signed(envelope))).status,413);assert.equal(f.calls.length,0);
});

test('the gateway denies arbitrary RPCs, SQL, table writes, extra args and URL normalization tricks',async()=>{
  const f=fixture();
  for(const envelope of [rpc('execute_sql',{sql:'select 1'}),rpc('arkhen_identity_lookup',{p_library_hash:hash,sql:'select 1'}),
    {path:'/rest/v1/user_preferences',method:'GET'},{path:'/rest/v1/user_preferences?id=eq.any',method:'PATCH',body:{value:'overwrite'}},
    {path:'/auth/v1/admin/users',method:'GET'},{path:'/rest/v1/rpc/../profiles',method:'GET'},{path:'https://untrusted.example/rest/v1/profiles',method:'GET'},
    {...rpc('arkhen_identity_lookup',{p_library_hash:hash}),headers:{Authorization:'Bearer arbitrary'}},
    {path:'/rest/v1/rpc/arkhen_identity_lookup?extra=1',method:'POST',body:{p_library_hash:hash}}])assert.equal((await f.gateway(signed(envelope))).status,400,JSON.stringify(envelope));
  assert.equal(f.calls.length,0);
});

test('synthetic identity creation has exact server metadata and replaces the supplied password with random bytes',async()=>{
  const f=fixture(),body={email,password:'caller-password-that-must-not-be-used-123456',email_confirm:true,app_metadata:{arkhen_provider:'wplay',arkhen_library_hash:hash}};
  const response=await f.gateway(signed({path:'/auth/v1/admin/users',method:'POST',body}));assert.equal(response.status,200);
  assert.notEqual(f.calls[0].body.password,body.password);assert.match(f.calls[0].body.password,/^[a-f0-9]{96}$/);assert.deepEqual(f.calls[0].body.app_metadata,body.app_metadata);
  assert.deepEqual(await response.json(),user);
  for(const invalid of [{...body,email:'someone@example.com'},{...body,email_confirm:false},{...body,app_metadata:{...body.app_metadata,admin:true}},{...body,app_metadata:{arkhen_library_hash:hash,arkhen_provider:'xtream'}},{...body,app_metadata:{...body.app_metadata,arkhen_library_hash:'d'.repeat(64)}}])assert.equal((await f.gateway(signed({path:'/auth/v1/admin/users',method:'POST',body:invalid}))).status,400);
  assert.equal(f.calls.length,1);
});

test('magic links return only the checked synthetic user and hashed token, and reject identity mismatches',async()=>{
  const envelope={path:'/auth/v1/admin/generate_link',method:'POST',body:{type:'magiclink',email}},f=fixture();
  const response=await f.gateway(signed(envelope));assert.deepEqual(await response.json(),{user,hashed_token:'generated-otp-token-hash-123456'});
  assert.equal((await f.gateway(signed({...envelope,body:{type:'signup',email}}))).status,400);
  const mismatch=fixture({handler:()=>Response.json({user:{...user,app_metadata:{arkhen_library_hash:'f'.repeat(64),arkhen_provider:'wplay'}},hashed_token:'generated-otp-token-hash-123456'})});
  const rejected=await mismatch.gateway(signed(envelope));assert.equal(rejected.status,502);assert.doesNotMatch(await rejected.text(),/generated-otp|action_link|email_otp/);
});

test('active profile inventory exposes only explicitly selected non-email fields and bounded filters',async()=>{
  const f=fixture({handler:()=>Response.json([{id:userId,status:'active',email:'never@example.com',password:'never-forwarded'}])});
  const path='/rest/v1/profiles?'+new URLSearchParams({select:'id,status',status:'eq.active',limit:'2'}),response=await f.gateway(signed({path,method:'GET'}));
  assert.equal(response.status,200);assert.deepEqual(await response.json(),[{id:userId,status:'active'}]);
  for(const query of [{select:'*',status:'eq.active'},{select:'id,email',status:'eq.active'},{select:'id',status:'eq.disabled'},{select:'id',status:'eq.active',limit:'100'},{select:'id',status:'eq.active',or:'(id.neq.any)'}])assert.equal((await f.gateway(signed({path:'/rest/v1/profiles?'+new URLSearchParams(query),method:'GET'}))).status,400);
  assert.equal(f.calls.length,1);
});

test('SkipDB imports force idempotent inserts and guard verified or unrelated rows from changes',async()=>{
  const f=fixture(),row=marker(),path='/rest/v1/episode_skip_markers?'+new URLSearchParams({on_conflict:'series_slug,season,episode,edition_id'});
  assert.equal((await f.gateway(signed({path,method:'POST',body:[row]}))).status,200);assert.equal(f.calls[0].headers.Prefer,'resolution=ignore-duplicates,return=minimal');
  const patch='/rest/v1/episode_skip_markers?'+new URLSearchParams({edition_id:`in.(${row.edition_id})`,'provenance->>source':'eq.skipdb',verification:'neq.verified'});
  assert.equal((await f.gateway(signed({path:patch,method:'PATCH',body:{is_active:false}}))).status,200);assert.equal(f.calls[1].headers.Prefer,'return=minimal');
  for(const changed of [{...row,edition_id:'manual-verified'},{...row,verification:'verified'},{...row,provenance:{...row.provenance,source:'manual'}},{...row,user_id:userId}])assert.equal((await f.gateway(signed({path,method:'POST',body:[changed]}))).status,400);
  assert.equal((await f.gateway(signed({path:patch,method:'PATCH',body:{is_active:true,markers:{openingEnd:100}}}))).status,400);
  assert.equal((await f.gateway(signed({path:patch.replace('neq.verified','eq.verified'),method:'PATCH',body:{is_active:false}}))).status,400);
  assert.equal(f.calls.length,2);
});

test('SkipDB lookup matches importer pagination but cannot broaden into unrelated records',async()=>{
  const f=fixture({handler:()=>Response.json([{series_slug:'game-of-thrones',edition_id:marker().edition_id,internal:'not-forwarded'}])});
  const query={select:'series_slug,season,episode,edition_id,verification,is_active',edition_id:'like.skipdb-*','provenance->>source':'eq.skipdb',series_slug:'in.(game-of-thrones)',order:'series_slug,season,episode,edition_id',limit:'1000',offset:'0'};
  const response=await f.gateway(signed({path:'/rest/v1/episode_skip_markers?'+new URLSearchParams(query),method:'GET'}));assert.equal(response.status,200);assert.equal((await response.json())[0].internal,undefined);
  assert.equal((await f.gateway(signed({path:'/rest/v1/episode_skip_markers?'+new URLSearchParams({...query,edition_id:'like.*'}),method:'GET'}))).status,400);
});

test('conflicting source opening ranges retain their bounded candidates through the gateway',async()=>{
  const f=fixture(),row=marker();row.provenance.verification.openingCandidates=[{openingStart:0,openingEnd:113,durationSeconds:3131.6},{openingStart:6,openingEnd:114,durationSeconds:3132}];
  const envelope={path:'/rest/v1/episode_skip_markers?'+new URLSearchParams({on_conflict:'series_slug,season,episode,edition_id'}),method:'POST',body:[row]};
  assert.equal((await f.gateway(signed(envelope))).status,200);assert.deepEqual(f.calls[0].body[0].provenance.verification.openingCandidates,row.provenance.verification.openingCandidates);
  row.provenance.verification.openingCandidates[0].openingEnd=9000;
  assert.equal((await f.gateway(signed(envelope))).status,400);assert.equal(f.calls.length,1);
});

test('the upstream deadline remains active while streaming its response body',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let started;
  const began=new Promise(resolve=>{started=resolve;});
  const f=fixture({handler:({signal})=>{started();return new Response(new ReadableStream({start(controller){signal.addEventListener('abort',()=>controller.error(new Error('private upstream stream timeout')),{once:true});}}));}});
  const pending=f.gateway(signed(rpc('arkhen_identity_lookup',{p_library_hash:hash})));await began;
  t.mock.timers.tick(15000);const response=await pending;
  assert.equal(response.status,502);assert.deepEqual(await response.json(),{code:'GATEWAY_UPSTREAM_TIMEOUT'});
});

test('cache publication and account validation accept the real contract while rejecting unsafe metadata',async()=>{
  const f=fixture(),lease={...partition,p_job_id:userId,p_worker:'arkhen-'+userId},expires=new Date(clock+60000).toISOString();
  for(const envelope of [rpc('arkhen_validate_account',{...partition,p_user_id:userId,p_status:'active',p_expires_at:null,p_validated_at:new Date(clock).toISOString()}),
    rpc('arkhen_identity_bind',{...partition,p_library_hash:hash,p_user_id:userId,p_provider:'wplay'}),rpc('arkhen_enqueue_source_jobs',partition),
    rpc('arkhen_claim_cache_jobs',{p_worker:lease.p_worker,p_limit:1,p_lease_seconds:300}),rpc('arkhen_renew_cache_job',{p_worker:lease.p_worker,p_job_id:userId,p_lease_seconds:300}),
    rpc('arkhen_finish_cache_job',{p_worker:lease.p_worker,p_job_id:userId,p_success:true,p_error_code:null}),
    rpc('arkhen_request_cache_refresh',{...partition,p_job_type:'catalog',p_payload:{media_type:'movies'}}),
    rpc('arkhen_publish_catalog',{...lease,p_media_type:'movies',p_payload:{categories:[],items:[]},p_complete:true,p_snapshot_id:userId,p_expires_at:expires}),
    rpc('arkhen_publish_epg_batch',{...lease,p_channels:[{channel_id:'100',payload:{list:[]}}],p_expires_at:expires}),
    rpc('arkhen_publish_games',{...lease,p_game_date:'2026-10-15',p_time_zone:'America/Maceio',p_payload:{available:true,date:'2026-10-15',timeZone:'America/Maceio',games:[]},p_expires_at:expires})])assert.equal((await f.gateway(signed(envelope))).status,200,envelope.path);
  assert.equal((await f.gateway(signed(rpc('arkhen_publish_catalog',{...lease,p_media_type:'movies',p_payload:{categories:[],items:[{id:'1',kind:'movie',name:'Private',password:'not-allowed'}]},p_complete:true,p_snapshot_id:userId,p_expires_at:expires})))).status,400);
});

test('upstream failures preserve machine codes while stripping secrets, provider details and diagnostic messages',async()=>{
  const f=fixture({handler:()=>Response.json({code:'email_exists',message:'private-password at https://private.example',details:'private diagnosis'},{status:422})});
  const response=await f.gateway(signed(rpc('arkhen_identity_lookup',{p_library_hash:hash})));assert.equal(response.status,422);assert.deepEqual(await response.json(),{code:'email_exists'});
  const leaking=fixture({handler:()=>Response.json({message:serviceKey+' '+secret},{status:500})}),blocked=await leaking.gateway(signed(rpc('arkhen_identity_lookup',{p_library_hash:hash})));
  assert.equal(blocked.status,502);assert.doesNotMatch(await blocked.text(),/sb_secret|fixture_backend_secret|private/);
});

test('legacy service-role authentication stays inside the function and a missing server secret denies all operations',async()=>{
  const legacy='eyJhbGciOiJIUzI1NiJ9.'+Buffer.from(JSON.stringify({role:'service_role'})).toString('base64url')+'.fixtureSignature';
  const f=fixture({environment:{SUPABASE_SECRET_KEYS:'{}',SUPABASE_SERVICE_ROLE_KEY:legacy}});
  assert.equal((await f.gateway(signed(rpc('arkhen_identity_lookup',{p_library_hash:hash})))).status,200);assert.equal(f.calls[0].headers.Authorization,'Bearer '+legacy);
  const missing=fixture({environment:{ARKHEN_BACKEND_SECRET:undefined}});assert.equal((await missing.gateway(signed(rpc('arkhen_identity_lookup',{p_library_hash:hash})))).status,503);assert.equal(missing.calls.length,0);
});
