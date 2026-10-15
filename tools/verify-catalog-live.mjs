// Explicit, read-only catalog verification after deployment. A fresh Auth
// session is issued for one already validated account and revoked locally.
// Provider credentials, browser cookies and existing sessions are never read.
import assert from 'node:assert/strict';
import {SupabaseCloud} from '../lib/supabase-cloud.mjs';
import {CloudRuntime} from '../lib/cloud-runtime.mjs';
import {ParentalControl} from '../lib/parental-control.mjs';
const cloud=new SupabaseCloud(),runtime=new CloudRuntime({cloud,worker:{stop(){}}});
let accessToken,stage='configuration';
try{
 await runtime.ready;assert.equal(cloud.enabled,true);
 stage='validated-account';
 const profiles=await cloud.request('/rest/v1/profiles?'+new URLSearchParams({select:'id,provider,provider_key,scope_hash,library_hash,status,access_expires_at,last_validated_at',status:'eq.active',limit:'2'}));
 assert.equal(profiles?.length,1,'one-validated-account-required');const profile=profiles[0];
 assert.ok(Date.parse(profile.last_validated_at)>Date.now()-86400000&&(!profile.access_expires_at||Date.parse(profile.access_expires_at)>Date.now()));
 stage='isolated-auth';
 const link=await cloud.request('/auth/v1/admin/generate_link',{method:'POST',body:{type:'magiclink',email:profile.library_hash+'@accounts.arkhen.invalid'}});
 assert.equal((link.user??link).id,profile.id);
 const session=await cloud.request('/auth/v1/verify',{method:'POST',publicKey:true,body:{type:'email',token_hash:link.hashed_token??link.properties?.hashed_token}});
 assert.equal(session.user?.id,profile.id);accessToken=session.access_token;assert.equal(typeof accessToken,'string');
 const state={cloud:{session:{access_token:accessToken},providerKey:profile.provider_key,scopeHash:profile.scope_hash}};
 const completeStart=performance.now(),completeReads=new Map();
 if(process.argv.includes('--concurrent'))await Promise.all(['live','movies','series'].map(async type=>{
  const started=performance.now(),full=await runtime.catalog(state,type,{fresh:true});
  assert.equal(full?.catalogComplete,true,'concurrent-complete-'+type);
  completeReads.set(type,{full,read_ms:Math.round(performance.now()-started)});
 }));
 const results=[];
 for(const type of ['live','movies','series']){
  stage='catalog-page-'+type;
  const page=await runtime.catalogPage(state,type,{includeAdult:true,fresh:true});
  if(!page||page.preparing||page.catalogComplete===false&&page.pagination?.complete===false&&page.pagination?.preparing){results.push({type,complete:false,preparing:Boolean(page?.preparing),preview_items:page?.items?.length||0});continue;}
  stage='complete-catalog-'+type;const started=performance.now();
  const full=completeReads.get(type)?.full||await runtime.catalog(state,type,{fresh:true});
  assert.ok(Array.isArray(full?.items)&&Array.isArray(full?.categories),'complete-payload-required');
  assert.equal(full.items.length,page.pagination.total,'unpaged-runtime-returns-all-records');
  assert.equal(new Set(full.items.map(item=>item.id)).size,full.items.length,'unique-media-identities');
  const lockedPage=await runtime.catalogPage(state,type,{includeAdult:false,fresh:true});
  const filtered=new ParentalControl().filterCatalog(full,type);assert.equal(filtered.items.length,lockedPage.pagination.total,'server-filter-matches-sql-adult-count');
  const raw=JSON.stringify(full);assert.doesNotMatch(raw,/https?:\/\/|"(?:password|passwd|token|access_token|refresh_token|api_key|apikey|authorization|cookie|secret|client_secret|playback_url|play_url|stream_url|m3u_url|headers)"\s*:/i,'transport-secrets-never-published');
  results.push({type,complete:true,items:full.items.length,safe_items:filtered.items.length,categories:full.categories.length,payload_bytes:Buffer.byteLength(raw),read_ms:completeReads.get(type)?.read_ms||Math.round(performance.now()-started)});
 }
 stage='partition-isolation';
 const denied=await cloud.request('/rest/v1/rpc/arkhen_catalog_page',{method:'POST',publicKey:true,accessToken,body:{p_provider_key:'e'.repeat(64),p_scope_hash:profile.scope_hash,p_media_type:'movies'}});assert.equal(denied,null);
 console.log(JSON.stringify({ok:true,isolated_auth:true,partition_isolation:true,concurrent:process.argv.includes('--concurrent'),elapsed_ms:Math.round(performance.now()-completeStart),catalogs:results}));
}catch(error){console.error(JSON.stringify({ok:false,stage,code:/^[A-Z0-9_]{1,80}$/.test(error?.code||'')?error.code:'CATALOG_VERIFICATION_FAILED'}));process.exitCode=1;}
finally{runtime.close();if(accessToken)await cloud.revoke(accessToken).catch(()=>{console.error(JSON.stringify({isolated_session_revoked:false}));process.exitCode=1;});}
