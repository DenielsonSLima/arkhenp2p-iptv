// Explicit live verification, never included in npm test. Uses an existing,
// recently WPLAY-validated account and removes only its random test preference.
import {randomUUID} from 'node:crypto';
import {createClient} from '@supabase/supabase-js';
import {QueryClient} from '@tanstack/query-core';
import {SupabaseCloud} from '../lib/supabase-cloud.mjs';
import {CloudLibrary} from '../web/cloud-library.js';

const memory=()=>{const entries=new Map();return {getItem:key=>entries.get(key)??null,setItem:(key,value)=>entries.set(key,value),removeItem:key=>entries.delete(key)};};
const cloud=new SupabaseCloud(),libraries=[],tokens=[];
let profile,key,stage='configuration',preferenceCreated=false,ok=false;
const deadline=async(promise,ms)=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('timeout')),ms);})]);}finally{clearTimeout(timer);}};
try{
  await cloud.ready;if(!cloud.enabled)throw new Error('not-configured');
  stage='validated-account';
  const idIndex=process.argv.indexOf('--user-id'),id=idIndex>=0?process.argv[idIndex+1]:null;
  if(id&&!/^[a-f0-9-]{36}$/i.test(id))throw new Error('invalid-user-id');
  const filters=new URLSearchParams({select:'id,provider,provider_key,scope_hash,library_hash,status,access_expires_at,last_validated_at',status:'eq.active',limit:'2',...(id?{id:'eq.'+id}:{})});
  const profiles=await cloud.request('/rest/v1/profiles?'+filters);
  if(profiles?.length!==1)throw new Error('one-validated-account-required');
  profile=profiles[0];
  if(Date.parse(profile.last_validated_at)<Date.now()-86400000||profile.access_expires_at&&Date.parse(profile.access_expires_at)<=Date.now())throw new Error('provider-validation-expired');
  const sessions=[];
  for(let device=0;device<2;device++){
    stage='issue-isolated-test-session';
    const email=profile.library_hash+'@accounts.arkhen.invalid';
    const link=await cloud.request('/auth/v1/admin/generate_link',{method:'POST',body:{type:'magiclink',email}});
    if((link.user??link).id!==profile.id)throw new Error('identity-mismatch');
    const issued=await cloud.request('/auth/v1/verify',{method:'POST',publicKey:true,body:{type:'email',token_hash:link.hashed_token??link.properties?.hashed_token}});
    if(issued.user?.id!==profile.id)throw new Error('identity-mismatch');
    sessions.push(issued);tokens.push(issued.access_token);
  }
  const sessionId=session=>JSON.parse(Buffer.from(session.access_token.split('.')[1],'base64url').toString()).session_id;
  if(!sessionId(sessions[0])||sessionId(sessions[0])===sessionId(sessions[1]))throw new Error('sessions-not-isolated');
  stage='connect-client-library';
  for(const session of sessions){
    const authStorage=memory();
    const library=new CloudLibrary({storage:memory(),pageTarget:null,loadSDK:async()=>({QueryClient,createClient:(url,key,options)=>createClient(url,key,{...options,auth:{...options.auth,storage:authStorage}})})});
    libraries.push(library);
    const snapshot=await library.connect({...cloud.publicConfig(),session,userId:profile.id,provider:profile.provider,providerKey:profile.provider_key,scopeHash:profile.scope_hash,libraryId:profile.library_hash});
    if(!snapshot?.ready)throw new Error('client-connect-failed');
  }
  stage='realtime-subscription';
  await deadline((async()=>{while(libraries.some(library=>library.channel?.state!=='joined'))await new Promise(resolve=>setTimeout(resolve,50));})(),15000);
  key='review.'+randomUUID();
  const delivery=new Promise(resolve=>{const unsubscribe=libraries[1].subscribe(snapshot=>{if(snapshot.preferences[key]?.verified===true){unsubscribe();resolve();}});});
  stage='write-and-realtime-delivery';preferenceCreated=true;
  await libraries[0].savePreference(key,{verified:true});
  await deadline(delivery,15000);
  stage='logout-isolated-device';
  await libraries[0].logout({flush:false});
  const refresh=await libraries[1].client.auth.refreshSession();
  if(refresh.error||!refresh.data?.session)throw new Error('other-device-revoked');
  console.log(JSON.stringify({live_library_connection:true,independent_sessions:true,preference_write:true,realtime_delivery:true,second_device_survives_logout:true}));ok=true;
}catch(error){
  console.error(JSON.stringify({ok:false,stage,code:/^[a-z0-9-]{1,80}$/.test(error.message||'')?error.message:'verification-failed'}));
  process.exitCode=1;
}finally{
  for(const library of libraries)await library.logout({flush:false}).catch(()=>{});
  for(const token of tokens)await cloud.revoke(token).catch(()=>{});
  if(preferenceCreated&&profile&&key){
    try{
      const filter=new URLSearchParams({user_id:'eq.'+profile.id,provider:'eq.'+profile.provider,key:'eq.'+key});
      await cloud.request('/rest/v1/user_preferences?'+filter,{method:'DELETE'});
      console.log(JSON.stringify({temporary_preference_removed:true}));
    }catch{console.error(JSON.stringify({temporary_preference_removed:false}));process.exitCode=1;}
  }
  if(!ok)process.exitCode=1;
}
