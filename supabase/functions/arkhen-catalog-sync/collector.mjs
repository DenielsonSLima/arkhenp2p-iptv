import {openSource,sealSource,publicProviderURL} from '../_shared/provider-sources.mjs';
import {createWplayHttpSource,sharedImageReference} from './wplay-http.mjs';
import {collectEPGSnapshot} from './epg-collector.mjs';

const failure=code=>Object.assign(new Error(code),{code});
const safeError=(error,phase)=>/^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code||'')?error.code:'COLLECTOR_'+phase+'_FAILED';
const validTypes=['live','movies','series'];
const publicationStages=['initial','catalog_build','categories','media','deactivate_categories','deactivate_media','artwork_insert','artwork_cleanup','snapshot','cleanup_private'];
function publicationResult(state,type){const error=state?.publicationFailure;if(error?.type===type)throw failure(publicationStages.includes(error.stage)&&/^[0-9A-Z]{5}$/.test(error.code||'')?'COLLECTOR_PUBLICATION_'+error.stage.toUpperCase()+'_'+error.code:'COLLECTOR_PUBLICATION_FAILED');return state;}
const authQuery=/^(?:t|token|access_token|refresh_token|auth|authorization|password|passwd|username|user|key|api_key|apikey|secret|signature|sig|expires|expiry|session|jwt)$/i;
const encoder=new TextEncoder();
// The database accepts bounded pages rather than a single huge Edge payload.
function chunks(data){
  if(!Array.isArray(data?.items)||!Array.isArray(data?.categories))throw failure('COLLECTOR_PAGE_INVALID');
  const categories=data.categories,base=encoder.encode(JSON.stringify({categories,items:[]})).length;
  if(base>2000000)throw failure('COLLECTOR_CATEGORIES_TOO_LARGE');
  const result=[];let items=[],size=base;
  for(const item of data.items){const length=encoder.encode(JSON.stringify(item)).length+1;if(length+base>3000000)throw failure('COLLECTOR_ITEM_TOO_LARGE');if(items.length&&size+length>3000000){result.push({categories,items});items=[];size=base;}items.push(item);size+=length;}
  result.push({categories,items});return result;
}
export async function runCloudCollector({store,fetch:request=globalThis.fetch,encryptionKey,now=Date.now,maxSteps=12,budgetMs=35000,worker='edge-'+crypto.randomUUID(),createSource=createWplayHttpSource,decrypt=openSource,encrypt=sealSource}={}){
  const jobs=await store.claim(worker),job=Array.isArray(jobs)?jobs[0]:null;if(!job)return {state:'idle'};
  const started=now(),common={p_provider_key:job.provider_key,p_scope_hash:job.scope_hash,p_job_id:job.id,p_worker:worker};let completed=false,yielded=false,steps=0,renewedAt=started,phase='SOURCE';
  const renew=async()=>{if(now()-renewedAt>=45000){if(await store.renew(job,worker)!==true)throw failure('COLLECTOR_LEASE_LOST');renewedAt=now();}};
  const pendingArtwork=new Map();
  try{
    if(job.job_type==='epg'){
      phase='EPG';
      const result=await collectEPGSnapshot({store,job,worker,now,started,budgetMs,renew,openClient:async()=>{
        const row=await store.source(job);if(!row)throw failure('COLLECTOR_SOURCE_UNAVAILABLE');
        const source=await decrypt(row,encryptionKey);
        if(source?.provider!=='wplay'||!Number.isFinite(Date.parse(source.expiresAt))||Date.parse(source.expiresAt)<=now())throw failure('COLLECTOR_SOURCE_EXPIRED');
        return createSource({source,fetch:request,now,timeoutMs:Math.max(1000,Math.min(10000,budgetMs))});
      }});
      ({completed,yielded,steps}=result);
      if(completed){phase='FINISH';await store.finish(job,worker,true);}
      return {state:yielded?'checkpointed':'ready',jobType:job.job_type,steps};
    }
    const row=await store.source(job);if(!row)throw failure('COLLECTOR_SOURCE_UNAVAILABLE');
    const source=await decrypt(row,encryptionKey);
    if(source?.provider!=='wplay'||!Number.isFinite(Date.parse(source.expiresAt))||Date.parse(source.expiresAt)<=now())throw failure('COLLECTOR_SOURCE_EXPIRED');
    const flush=async()=>{while(pendingArtwork.size){const batch=[...pendingArtwork.values()].slice(0,500);await renew();await store.artworks(batch);for(const item of batch)pendingArtwork.delete(item.ref);}};
    const mapImage=async(value,context={})=>{
      if(typeof value!=='string'||!value)return '';
      if(/^\/assets\/[A-Za-z0-9_./-]+$/.test(value)&&!value.includes('..'))return value;
      const url=publicProviderURL(value),token=source.service?.token,authenticated=[...url.searchParams.keys()].some(key=>authQuery.test(key))||typeof token==='string'&&token.length>=6&&(value.includes(token)||value.includes(encodeURIComponent(token)));
      const artExpiry=new Date(authenticated?Math.min(now()+7200000,Date.parse(source.expiresAt),Date.parse(row.expires_at)):now()+86400000).toISOString();
      const reference=await sharedImageReference(value,{providerKey:job.provider_key,scopeHash:job.scope_hash}),ref=reference.slice(reference.lastIndexOf('/')+1);
      if(!pendingArtwork.has(ref))pendingArtwork.set(ref,{provider_key:job.provider_key,scope_hash:job.scope_hash,ref,cipher:await encrypt({source:{url:value,userAgent:context.userAgent||source.userAgent},providerKey:job.provider_key,scopeHash:job.scope_hash,sourceId:ref,key:encryptionKey}),expires_at:artExpiry});
      if(pendingArtwork.size>=500)await flush();return context.kind==='sports-logo'?'/api/sports-image/'+ref:reference;
    };
    const client=createSource({source,fetch:request,mapImage,now,timeoutMs:Math.max(1000,Math.min(10000,budgetMs))});
    if(job.job_type==='catalog'){
      const types=job.payload?.media_type?[job.payload.media_type]:validTypes;if(types.some(type=>!validTypes.includes(type)))throw failure('COLLECTOR_JOB_INVALID');
      phase='STATE';let state=await store.state(job,worker)||{};
      if(!state.cursors&&validTypes.includes(state.type)&&state.cursor)state={...state,cursors:{[state.type]:{cursor:state.cursor,pageChunk:state.pageChunk||null}}};
      const disabled=types.filter(type=>type==='live'?source.service?.enabledLive===false:source.service?.enabledVoD===false);
      const skippedTypes=disabled.filter(type=>!state.publishedTypes?.includes(type));
      if(JSON.stringify(state.skippedTypes||[])!==JSON.stringify(skippedTypes)){await store.checkpoint(job,worker,{progress:{skippedTypes}});state={...state,skippedTypes};}
      // Probe each requested media type once, before walking a large movie
      // category. A seed is a bounded preview, never a completed catalog page.
      if(typeof store.seed==='function')for(const type of types){
        if(now()-started>=budgetMs)break;
        if(disabled.includes(type)||state.publishedTypes?.includes(type)||state.typeReady===type||state.previewSeeded?.includes(type))continue;
        phase='PREVIEW';const first=await client.catalogStep(type,{categoryIndex:0,page:1});
        if(!Array.isArray(first?.categories)||!Array.isArray(first?.items))throw failure('COLLECTOR_PAGE_INVALID');
        await flush();await renew();await store.seed(job,worker,type,{categories:first.categories,items:first.items.slice(0,120)});
        const previewSeeded=[...new Set([...(state.previewSeeded||[]),type])];
        await store.checkpoint(job,worker,{progress:{previewSeeded}});state={...state,previewSeeded};
      }
      while(steps<maxSteps&&now()-started<budgetMs){
        const eligible=types.filter(value=>!disabled.includes(value)&&!state.publishedTypes?.includes(value));
        const type=eligible.includes(state.typeReady)?state.typeReady:eligible.includes(state.nextType)?state.nextType:eligible[0];
        if(!type){completed=true;break;}
        if(state.typeReady===type){phase='PUBLISH';await renew();const prepared=state.publicationPreparedTypes?.includes(type);state=publicationResult(await store.publish(job,worker,type),type);steps++;if(!prepared&&state.publicationPreparedTypes?.includes(type))break;continue;}
        const saved=state.cursors?.[type],cursor=saved?.cursor||(state.type===type&&state.cursor&&typeof state.cursor==='object'?state.cursor:{categoryIndex:0,page:1});
        if(!Number.isSafeInteger(cursor.categoryIndex)||cursor.categoryIndex<0||!Number.isSafeInteger(cursor.page)||cursor.page<1)throw failure('COLLECTOR_CURSOR_INVALID');
        phase='PROVIDER';const data=await client.catalogStep(type,cursor);steps++;
        if(typeof data?.complete!=='boolean'||!data.complete&&(!data.next||data.next.categoryIndex===cursor.categoryIndex&&data.next.page<=cursor.page))throw failure('COLLECTOR_PAGINATION_STALLED');
        await flush();
        const nextType=eligible[(eligible.indexOf(type)+1)%eligible.length];
        const progress={type,cursor:data.next||cursor,pageChunk:null,nextType,cursors:{...state.cursors,[type]:{cursor:data.next||cursor,pageChunk:null}},...(data.complete?{typeReady:type}:{})};
        const pages=chunks(data),pageHash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(JSON.stringify(data)))),value=>value.toString(16).padStart(2,'0')).join('');
        const chunk=saved?.pageChunk||(state.type===type?state.pageChunk:null),start=chunk?.type===type&&chunk.categoryIndex===cursor.categoryIndex&&chunk.page===cursor.page&&chunk.pageHash===pageHash&&Number.isSafeInteger(chunk.next)?Math.min(chunk.next,pages.length-1):0;
        let stagedAll=false;
        for(let index=start;index<pages.length;index++){
          const final=index===pages.length-1,partialChunk={type,...cursor,pageHash,next:index+1},next=final?progress:{type,cursor,pageChunk:partialChunk,nextType:type,cursors:{...state.cursors,[type]:{cursor,pageChunk:partialChunk}}};
          phase='CHECKPOINT';await renew();await store.checkpoint(job,worker,{type,step:`${type}:${cursor.categoryIndex}:${cursor.page}:${index}`,payload:pages[index],progress:next});state={...state,...next};
          if(final){stagedAll=true;break;}if(now()-started>=budgetMs)break;
        }
        if(!stagedAll)break;
        if(data.complete){phase='PUBLISH';await renew();state=publicationResult(await store.publish(job,worker,type),type);}
      }
      if(skippedTypes.length&&types.filter(type=>!disabled.includes(type)).every(type=>state.publishedTypes?.includes(type))){
        await store.finish(job,worker,false,'COLLECTOR_CAPABILITY_UNAVAILABLE');return {state:'deferred',jobType:job.job_type,code:'COLLECTOR_CAPABILITY_UNAVAILABLE',skippedTypes,steps};
      }
      if(!completed)completed=types.every(type=>state.publishedTypes?.includes(type));
      if(!completed){phase='YIELD';await store.yield(job,worker,state);yielded=true;}
    }else if(job.job_type==='games'){
      phase='PROVIDER';const data=await client.games({date:job.payload?.date,timeZone:job.payload?.timeZone||job.payload?.time_zone||'America/Maceio',lang:job.payload?.lang||'pt'});
      await flush();await store.rpc('arkhen_publish_games',{...common,p_game_date:data.date,p_time_zone:data.timeZone,p_payload:data,p_expires_at:new Date(now()+60000).toISOString()});completed=true;
    }else throw failure('COLLECTOR_JOB_INVALID');
    if(completed){phase='FINISH';await store.finish(job,worker,true);}
    return {state:yielded?'checkpointed':'ready',jobType:job.job_type,steps};
  }catch(error){const code=safeError(error,phase);try{if(!yielded&&!completed)await store.finish(job,worker,false,code);}catch{/* A reassigned lease cannot be released by this invocation. */}return {state:'failed',jobType:job.job_type,code,steps};}
}
