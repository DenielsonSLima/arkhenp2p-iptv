// Read-only verification with an isolated, temporary JWT; never reads browser credentials.
import assert from 'node:assert/strict';
import {SupabaseCloud} from '../lib/supabase-cloud.mjs';
import {CloudRuntime} from '../lib/cloud-runtime.mjs';
const cloud=new SupabaseCloud(),runtime=new CloudRuntime({cloud,worker:{stop(){}}});
let accessToken,stage='configuration';
try{
 await runtime.ready;assert.equal(cloud.enabled,true);
 const profiles=await cloud.request('/rest/v1/profiles?'+new URLSearchParams({select:'id,provider_key,scope_hash,library_hash,status,access_expires_at,last_validated_at',status:'eq.active',limit:'2'}));
 assert.equal(profiles?.length,1);const profile=profiles[0];assert.ok(Date.parse(profile.last_validated_at)>Date.now()-86400000&&(!profile.access_expires_at||Date.parse(profile.access_expires_at)>Date.now()));
 stage='isolated-auth';
 const link=await cloud.request('/auth/v1/admin/generate_link',{method:'POST',body:{type:'magiclink',email:profile.library_hash+'@accounts.arkhen.invalid'}});assert.equal((link.user??link).id,profile.id);
 const session=await cloud.request('/auth/v1/verify',{method:'POST',publicKey:true,body:{type:'email',token_hash:link.hashed_token??link.properties?.hashed_token}});assert.equal(session.user?.id,profile.id);accessToken=session.access_token;
 const state={cloud:{session:{access_token:accessToken},providerKey:profile.provider_key,scopeHash:profile.scope_hash},parental:{unlocked:false}};
 const searches=[],navigation=[];
 for(const [query,type] of [['senhor','all'],['game thrones','series'],['glo','live'],['acao','movies']]){
  stage='search-'+type;const start=performance.now(),result=await runtime.searchCatalog(state,{query,type,limit:120});assert.equal(result?.schemaVersion,1);assert.equal(result.query,query);assert.ok(result.items.length<=120);assert.ok(result.total>=result.items.length);assert.ok(result.items.every(item=>item.isAdult===false));
  if(type!=='all')assert.ok(result.items.every(item=>item.kind===(type==='movies'?'movie':type)));assert.equal(result.hasMore,result.total>result.items.length);
  assert.doesNotMatch(JSON.stringify(result),/https?:\/\/|"(?:password|token|access_token|refresh_token|secret|playback_url|stream_url)"\s*:/i);
  searches.push({type,total:result.total,returned:result.items.length,counts:result.counts,elapsed_ms:Math.round(performance.now()-start)});
 }
 for(const type of ['live','movies','series']){
  stage='navigation-'+type;const start=performance.now(),result=await runtime.catalogReadModel(state,type);assert.equal(result?.mediaType,type);assert.equal(result.schemaVersion,1);assert.equal(result.includeAdult,false);
  const expected=await runtime.catalogPage(state,type,{includeAdult:false,fresh:true});assert.equal(result.total,expected.pagination.total);assert.equal(result.snapshotId,expected.pagination.snapshotId);
  for(const order of ['name','date','rating'])assert.equal(new Set(result.orders[order]).size,result.total);
  const ids=new Set(result.orders.name);assert.ok(result.categories.every(category=>category.count===category.itemIds.length&&category.itemIds.every(id=>ids.has(id))));assert.ok(result.genres.every(genre=>genre.count===genre.itemIds.length&&genre.itemIds.every(id=>ids.has(id))));
  navigation.push({type,total:result.total,categories:result.categories.length,genres:result.genres.length,featured:result.orders.featured.length,bytes:Buffer.byteLength(JSON.stringify(result)),elapsed_ms:Math.round(performance.now()-start)});
 }
 stage='foreign-partition';let denied=false;try{await cloud.request('/rest/v1/rpc/arkhen_global_search',{method:'POST',publicKey:true,accessToken,body:{p_provider_key:'e'.repeat(64),p_scope_hash:profile.scope_hash,p_query:'senhor'}});}catch{denied=true;}assert.ok(denied);
 console.log(JSON.stringify({ok:true,isolated_auth:true,partition_isolation:true,searches,navigation}));
}catch(error){console.error(JSON.stringify({ok:false,stage,code:/^[A-Z0-9_]{1,80}$/.test(error?.code||'')?error.code:'CATALOG_QUERY_VERIFICATION_FAILED'}));process.exitCode=1;}
finally{runtime.close();if(accessToken)await cloud.revoke(accessToken).catch(()=>{console.error(JSON.stringify({isolated_session_revoked:false}));process.exitCode=1;});}
