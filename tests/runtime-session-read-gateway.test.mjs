import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,webcrypto} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {SupabaseCloud} from '../lib/supabase-cloud.mjs';
import {createSessionGateway,PROJECT_URL} from '../supabase/functions/arkhen-session/handler.mjs';

const secret='fixture_session_read_secret_12345678901234567890',serviceKey='sb_secret_fixture_session_read_123456789012345';
const hash='a'.repeat(64),epoch='b'.repeat(64),now=1780000000000;
const snapshot={cipher:'v1.aXZmaXh0dXJl.dGFnZml4dHVyZQ.cGF5bG9hZA',mediaEpoch:epoch,expiresAt:new Date(now+86400000).toISOString(),revision:12};
const environment=name=>({ARKHEN_BACKEND_SECRET:secret,SUPABASE_SECRET_KEYS:JSON.stringify({default:serviceKey})})[name];
function signed(value,{nonce='1'.repeat(32),headers={}}={}){
  const body=JSON.stringify(value),timestamp=String(now),signature=createHmac('sha256',secret).update(`${timestamp}.${nonce}.${body}`).digest('hex');
  return new Request(PROJECT_URL+'/functions/v1/arkhen-session',{method:'POST',headers:{'Content-Type':'application/json','x-arkhen-timestamp':timestamp,'x-arkhen-nonce':nonce,'x-arkhen-signature':signature,...headers},body});
}
const envelope=args=>({rpc:'arkhen_runtime_session_read',args});

test('SDK and Edge read the committed checkpoint through a fixed signed operation without writer arguments',async()=>{
  const calls=[];
  const gateway=createSessionGateway({environment,now:()=>now,crypto:webcrypto,fetch:async(url,options)=>{
    calls.push({url,options});assert.equal(url,PROJECT_URL+'/rest/v1/rpc/arkhen_runtime_session_read');
    assert.deepEqual(JSON.parse(options.body),{p_session_hash:hash});assert.equal(options.headers.apikey,serviceKey);
    assert.equal(options.headers.Authorization,undefined);return Response.json(snapshot);
  }});
  const cloud=new SupabaseCloud({config:{url:PROJECT_URL,publishableKey:'sb_publishable_fixture_123456789012345',gateway:{secret}},now:()=>now,
    fetch:async(url,options)=>{
      assert.equal(url,PROJECT_URL+'/functions/v1/arkhen-session');assert.deepEqual(JSON.parse(options.body),envelope({p_session_hash:hash}));
      assert.equal(options.headers.apikey,undefined);assert.equal(options.headers.Authorization,undefined);
      return gateway(new Request(url,options));
    }});
  assert.deepEqual(await cloud.runtimeSessionRPC('read',{p_session_hash:hash}),snapshot);assert.equal(calls.length,1);
  await assert.rejects(cloud.runtimeSessionRPC('arbitrary',{}),{code:'CLOUD_RPC_INVALID'});
});

test('Edge read accepts a missing checkpoint or a valid nullable epoch and rejects malformed response fields',async t=>{
  const valid=[{missing:true},{...snapshot,mediaEpoch:null}];
  for(const result of valid){
    const gateway=createSessionGateway({environment,now:()=>now,crypto:webcrypto,fetch:async()=>Response.json(result)});
    const response=await gateway(signed(envelope({p_session_hash:hash})));assert.equal(response.status,200);assert.deepEqual(await response.json(),result);
  }
  const invalid=[{...snapshot,cipher:null},{...snapshot,mediaEpoch:'invalid'},{...snapshot,revision:-1},{...snapshot,expiresAt:'invalid'},
    {...snapshot,owner:'unexpected'}, {cipher:snapshot.cipher,expiresAt:snapshot.expiresAt,revision:12}];
  for(const [index,result]of invalid.entries())await t.test('malformed checkpoint '+index,async()=>{
    const gateway=createSessionGateway({environment,now:()=>now,crypto:webcrypto,fetch:async()=>Response.json(result)});
    const response=await gateway(signed(envelope({p_session_hash:hash})));assert.equal(response.status,502);assert.deepEqual(await response.json(),{code:'GATEWAY_RESPONSE_INVALID'});
  });
});

test('read rejects extra writer arguments, invalid hashes, browsers, unsigned requests and replayed envelopes',async()=>{
  let calls=0;const gateway=createSessionGateway({environment,now:()=>now,crypto:webcrypto,fetch:async()=>{calls++;return Response.json({missing:true});}});
  let serial=0;
  for(const args of [{p_session_hash:hash,p_owner:'owner'},{p_session_hash:hash,p_create:true},{p_session_hash:hash,p_media_epoch:epoch},{p_session_hash:'invalid'},{}]){
    const response=await gateway(signed(envelope(args),{nonce:String(++serial).padStart(32,'0')}));assert.equal(response.status,400);
  }
  assert.equal((await gateway(signed(envelope({p_session_hash:hash}),{headers:{Origin:'https://browser.invalid'}}))).status,403);
  const unsigned=new Request(PROJECT_URL+'/functions/v1/arkhen-session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(envelope({p_session_hash:hash}))});
  assert.equal((await gateway(unsigned)).status,401);assert.equal(calls,0);
  const value=envelope({p_session_hash:hash});assert.equal((await gateway(signed(value))).status,200);
  assert.equal((await gateway(signed(value))).status,409);assert.equal(calls,1);
});

test('read migration grants only service_role and performs no write or row-lock operation',async()=>{
  const sql=await readFile(new URL('../supabase/migrations/20261018152631_arkhen_private_runtime_session_read.sql',import.meta.url),'utf8');
  assert.match(sql,/security invoker/i);assert.match(sql,/set search_path = ''/i);
  assert.match(sql,/revoke all on function public\.arkhen_runtime_session_read\(text\) from public, anon, authenticated/i);
  assert.match(sql,/grant execute on function public\.arkhen_runtime_session_read\(text\) to service_role/i);
  assert.match(sql,/expires_at > clock_timestamp\(\) and cipher is not null/i);
  assert.doesNotMatch(sql,/\b(?:update|insert|delete)\s+(?:into\s+|from\s+)?arkhen_private\.runtime_sessions|for\s+(?:update|share)|\blease_until\s*=/i);
});
