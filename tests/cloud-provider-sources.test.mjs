import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {sealSource,openSource,publicProviderURL,assertPublicProviderDestination} from '../supabase/functions/_shared/provider-sources.mjs';
import {createWplayGateway} from '../supabase/functions/arkhen-backend/wplay-gateway.mjs';
import {sharedImageReference} from '../supabase/functions/arkhen-catalog-sync/wplay-http.mjs';
import {wplayAuthForm,wplayUserAgent,wplayDevice} from '../lib/wplay/conexao/provedor-nativo.mjs';

const providerKey='a'.repeat(64),scopeHash='b'.repeat(64),sourceId='c'.repeat(64),key=randomBytes(32).toString('base64url');
const server='https://auth1.wareztv.io/api/v2/auth',serviceKey='sb_secret_fixture_only_12345678901234567890';
const device=wplayDevice({}),authBody=()=>({server,form:wplayAuthForm({username:'fixture-account',password:'fixture-password',device}),userAgent:wplayUserAgent(device)});

test('encrypted provider sources bind ciphertext to partition, identity and expiry without retaining passwords',async()=>{
 const source={provider:'wplay',service:{token:'fixture-access-token'},userAgent:'fixture'};
 const cipher=await sealSource({source,providerKey,scopeHash,sourceId,key});
 assert.doesNotMatch(JSON.stringify(cipher),/fixture-access-token|fixture/);
 const row={provider_key:providerKey,scope_hash:scopeHash,source_id:sourceId,cipher,expires_at:new Date(Date.now()+60000).toISOString()};
 assert.deepEqual(await openSource(row,key),source);
 for(const changed of [{provider_key:'d'.repeat(64)},{scope_hash:'e'.repeat(64)},{source_id:'f'.repeat(64)},{expires_at:new Date(Date.now()-1).toISOString()},{cipher:{...cipher,ciphertext:cipher.ciphertext.slice(0,-3)+'abc'}}])await assert.rejects(openSource({...row,...changed},key),{code:'PROVIDER_SOURCE_INVALID'});
 await assert.rejects(openSource(row,randomBytes(32).toString('base64url')),{code:'PROVIDER_SOURCE_INVALID'});
});

test('provider and artwork targets reject private addresses and credential-bearing destinations',()=>{
 for(const value of ['http://127.0.0.1/x','http://0x7f000001/x','http://169.254.169.254/x','http://10.1.1.1/x','http://172.16.0.1/x','http://192.168.1.1/x','http://100.64.0.1/x','http://[::1]/x','http://localhost./x','https://metadata.google.internal./x','https://metadata.google.internal/x','https://local/x','https://service.internal/x','https://user:pass@example.com/x','file:///x'])assert.throws(()=>publicProviderURL(value),{code:'PROVIDER_SOURCE_INVALID'},value);
 assert.equal(publicProviderURL('https://cdn.example.com/poster?t=private-token').hostname,'cdn.example.com');
 assert.equal(publicProviderURL('https://catalog.example.com:8443/videos').port,'8443');
});

test('DNS aliases and mixed public/private DNS responses are refused before provider fetch',async()=>{
 for(const addresses of [['169.254.169.254'],['93.184.215.14','127.0.0.1'],['fd00::1'],['::ffff:127.0.0.1'],[]])await assert.rejects(assertPublicProviderDestination('https://alias.example.com/x',{resolveDns:async()=>addresses}),{code:'PROVIDER_SOURCE_INVALID'});
 assert.equal((await assertPublicProviderDestination('https://cdn.example.com/x',{resolveDns:async(_,type)=>type==='A'?['93.184.215.14']:['2606:4700::1111']})).hostname,'cdn.example.com');
});

test('cloud authentication uses the fixed provider host and saves only an expiring encrypted service capability',async()=>{
 const now=Date.now(),calls=[];let saved;
 const gateway=createWplayGateway({now:()=>now,environment:name=>name==='ARKHEN_SOURCE_ENCRYPTION_KEY'?key:undefined,fetch:async(url,options)=>{
  calls.push({url,options});
  if(url===server){assert.equal(options.headers.apikey,undefined);return Response.json({code:0,user:{end_time:now/1000+86400},service:{token:'fixture-provider-token',ch_url:'https://catalog.example.com/channels',auth_url_sdk:'https://engine.example.com/only-local'}});}
  assert.ok(url.endsWith('/rest/v1/rpc/arkhen_source_put'));saved=JSON.parse(options.body);return Response.json(null);
 }});
 const result=await gateway({path:'/providers/wplay/auth',method:'POST',body:authBody()},serviceKey);
 assert.equal(result.cloudCollector,true);assert.equal(result.payload.code,0);assert.equal(calls.length,2);assert.equal(Date.parse(saved.p_expires_at),now+23400000);
 assert.doesNotMatch(JSON.stringify(saved),/fixture-account|fixture-password|fixture-provider-token|catalog.example|engine.example/);
 const decoded=await openSource({provider_key:saved.p_provider_key,scope_hash:saved.p_scope_hash,source_id:saved.p_source_id,cipher:saved.p_cipher,expires_at:saved.p_expires_at},key);
 assert.deepEqual(Object.keys(decoded).sort(),['expiresAt','provider','service','userAgent','validatedAt']);assert.equal(decoded.service.token,'fixture-provider-token');assert.equal(decoded.service.auth_url_sdk,undefined);
});

test('the import window never exceeds the verified account or provider JWT expiry',async()=>{
 const now=Date.now();
 for(const [accountMs,tokenMs,expected] of [[600000,1800000,600000],[3600000,900000,900000],[86400000,10800000,10800000],[86400000,86400000,23400000]]){
  let saved;const token='e30.'+Buffer.from(JSON.stringify({exp:(now+tokenMs)/1000})).toString('base64url')+'.fixture';
  const gateway=createWplayGateway({environment:()=>key,now:()=>now,fetch:async(url,options)=>{
   if(url===server)return Response.json({code:0,user:{end_time:(now+accountMs)/1000},service:{token,ch_url:'https://catalog.example.com/channels'}});
   saved=JSON.parse(options.body);return Response.json(null);
  }});
  assert.equal((await gateway({path:'/providers/wplay/auth',method:'POST',body:authBody()},serviceKey)).cloudCollector,true);
  assert.equal(Date.parse(saved.p_expires_at),now+expected);
 }
 for(const exp of [0,-1,now/1000-60]){
  let calls=0;const token='e30.'+Buffer.from(JSON.stringify({exp})).toString('base64url')+'.fixture';
  const gateway=createWplayGateway({environment:()=>key,now:()=>now,fetch:async()=>{calls++;return Response.json({code:0,service:{token,ch_url:'https://catalog.example.com/channels'}});}});
  assert.equal((await gateway({path:'/providers/wplay/auth',method:'POST',body:authBody()},serviceKey)).cloudCollector,false);assert.equal(calls,1);
 }
});

test('a fresh guarded artwork source must match its canonical hash before being encrypted and mirrored',async()=>{
 const source={url:'https://cdn.example.com/poster?t=private-token',userAgent:'fixture-agent'},reference=await sharedImageReference(source.url,{providerKey,scopeHash}),ref=reference.split('/').pop();let saved;
 const gateway=createWplayGateway({environment:()=>key,resolveDns:async()=>['93.184.215.14'],fetch:async(url,options)=>{
  if(options.method==='HEAD')return new Response(null,{status:404});
  if(url.endsWith('/rpc/arkhen_artwork_put_batch')){saved=JSON.parse(options.body).p_rows[0];return Response.json(1);}
  if(url===source.url){assert.equal(options.headers.apikey,undefined);return new Response(Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,0]));}
  assert.ok(url.includes('/storage/v1/object/arkhen-catalog-artwork/'));return Response.json({});
 }});
 const body={providerKey,scopeHash,ref,source};
 assert.ok((await gateway({path:'/providers/wplay/artwork',method:'POST',body},serviceKey)).url);
 assert.doesNotMatch(JSON.stringify(saved),/private-token|fixture-agent|cdn.example/);
 assert.deepEqual(await openSource(saved,key),source);
 for(const changed of [{ref:'d'.repeat(64)},{source:{...source,extra:true}},{source:{...source,url:'http://127.0.0.1/private'}}])await assert.rejects(gateway({path:'/providers/wplay/artwork',method:'POST',body:{...body,...changed}},serviceKey));
});

test('provider rejection and unavailable collection do not create a cloud source or change the provider response',async()=>{
 for(const payload of [{code:-10},{code:0,service:{ch_url:'http://127.0.0.1/private'}}]){
  let calls=0;const gateway=createWplayGateway({environment:()=>key,fetch:async()=>{calls++;return Response.json(payload);}});
  const result=await gateway({path:'/providers/wplay/auth',method:'POST',body:authBody()},serviceKey);
  assert.deepEqual(result,{payload,cloudCollector:false});assert.equal(calls,1);
 }
 const gateway=createWplayGateway({environment:()=>key,fetch:async()=>{throw new Error('private network details');}});
 await assert.rejects(gateway({path:'/providers/wplay/auth',method:'POST',body:authBody()},serviceKey),{code:'GATEWAY_PROVIDER_AUTH_UNAVAILABLE'});
});

test('an authorized authentication fallback preserves the original shared catalog partition',async()=>{
 const scopeServer='https://auth1.authwplays.one/api/v2/auth';let saved;
 const gateway=createWplayGateway({environment:()=>key,fetch:async(url,options)=>{
  if(url===server)return Response.json({code:0,service:{ch_url:'https://catalog.example.com/live'}});
  saved=JSON.parse(options.body);return Response.json(null);
 }});
 assert.equal((await gateway({path:'/providers/wplay/auth',method:'POST',body:{...authBody(),scopeServer}},serviceKey)).cloudCollector,true);
 const expected=createHash('sha256').update(JSON.stringify(['arkhen-provider-v1','wplay',new URL(scopeServer).origin])).digest('hex');
 assert.equal(saved.p_provider_key,expected);
});

test('the provider gateway rejects added fields, alternate hosts and malformed device headers before network access',async()=>{
 let calls=0;const gateway=createWplayGateway({environment:()=>key,fetch:async()=>{calls++;throw new Error();}}),body=authBody();
 for(const invalid of [{...body,server:'https://example.com/auth'},{...body,form:body.form+'&url=http://127.0.0.1'},{...body,form:body.form+'&username=override'},{...body,userAgent:body.userAgent+'\r\nX: injected'},{...body,extra:true}])await assert.rejects(gateway({path:'/providers/wplay/auth',method:'POST',body:invalid},serviceKey),{code:'GATEWAY_PROVIDER_OPERATION_REJECTED'});
 assert.equal(calls,0);
});

test('artwork is mirrored in Supabase by partition and hash; upstream never receives an administrative key',async()=>{
 const ref='d'.repeat(64),source={url:'https://cdn.example.com/poster?t=private-token',userAgent:'fixture-agent'},cipher=await sealSource({source,providerKey,scopeHash,sourceId:ref,key}),calls=[];
 const gateway=createWplayGateway({environment:()=>key,resolveDns:async()=>['93.184.215.14'],fetch:async(url,options)=>{
  calls.push(url);
  if(options.method==='HEAD')return new Response(null,{status:404});
  if(url.endsWith('/rpc/arkhen_artwork_get'))return Response.json({provider_key:providerKey,scope_hash:scopeHash,ref,cipher,expires_at:new Date(Date.now()+60000).toISOString()});
  if(url===source.url){assert.equal(options.headers.apikey,undefined);assert.equal(options.headers.Authorization,undefined);return new Response(Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,0]));}
  assert.ok(url.includes('/storage/v1/object/arkhen-catalog-artwork/'+providerKey+'/'+scopeHash+'/'+ref));assert.equal(options.headers['Content-Type'],'image/png');return Response.json({});
 }});
 const result=await gateway({path:'/providers/wplay/artwork',method:'POST',body:{providerKey,scopeHash,ref}},serviceKey);
 assert.equal(calls.length,4);assert.equal(result.url,'https://wnicimkmzswksaqdtgdv.supabase.co/storage/v1/object/public/arkhen-catalog-artwork/'+providerKey+'/'+scopeHash+'/'+ref);assert.doesNotMatch(JSON.stringify(result),/private-token|sb_secret/);
});
