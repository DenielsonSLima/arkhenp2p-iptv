const ROOT='https://wnicimkmzswksaqdtgdv.supabase.co';
const failure=code=>Object.assign(new Error(code),{code});
export class CollectorStore{
  constructor({key,fetch:request=globalThis.fetch}={}){this.key=key;this.request=request;}
  async rpc(name,body,{timeoutMs=15000}={}){
    if(!/^arkhen_[a-z_]+$/.test(name))throw failure('COLLECTOR_RPC_INVALID');
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
    try{
      const response=await this.request(ROOT+'/rest/v1/rpc/'+name,{method:'POST',redirect:'error',signal:controller.signal,headers:{apikey:this.key,...(this.key?.split('.').length===3?{Authorization:'Bearer '+this.key}:{}),'Content-Type':'application/json'},body:JSON.stringify(body)});
      const reader=response.body?.getReader();let raw='',bytes=0;const decoder=new TextDecoder();
      if(reader)try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>1048576)throw failure('COLLECTOR_RESPONSE_TOO_LARGE');raw+=decoder.decode(part.value,{stream:true});}raw+=decoder.decode();}finally{await reader.cancel().catch(()=>{});}
      if(!response.ok){let code;try{code=JSON.parse(raw).code;}catch{/* Raw database errors never enter logs. */}throw failure(typeof code==='string'&&/^[0-9A-Z]{5}$/.test(code)?'COLLECTOR_DATABASE_SQL_'+code:'COLLECTOR_DATABASE_HTTP_'+response.status);}
      return raw?JSON.parse(raw):null;
    }catch(error){throw typeof error?.code==='string'&&/^COLLECTOR_[A-Z0-9_]{1,65}$/.test(error.code)?error:failure(controller.signal.aborted?'COLLECTOR_DATABASE_TIMEOUT':'COLLECTOR_DATABASE_UNAVAILABLE');}
    finally{clearTimeout(timer);}
  }
  claim(worker){return this.rpc('arkhen_claim_cloud_cache_jobs',{p_worker:worker});}
  source(job){return this.rpc('arkhen_source_get',{p_provider_key:job.provider_key,p_scope_hash:job.scope_hash});}
  state(job,worker){return this.rpc('arkhen_cloud_catalog_state',{p_job_id:job.id,p_worker:worker});}
  seed(job,worker,type,payload){return this.rpc('arkhen_catalog_preview_seed',{p_job_id:job.id,p_worker:worker,p_media_type:type,p_payload:payload});}
  renew(job,worker){return this.rpc('arkhen_renew_cache_job',{p_job_id:job.id,p_worker:worker,p_lease_seconds:180});}
  checkpoint(job,worker,{type=null,step=null,payload=null,progress={}}={}){return this.rpc('arkhen_cloud_catalog_checkpoint',{p_job_id:job.id,p_worker:worker,p_media_type:type,p_step_key:step,p_payload:payload,p_progress:progress});}
  publish(job,worker,type){return this.rpc('arkhen_cloud_catalog_publish',{p_job_id:job.id,p_worker:worker,p_media_type:type},{timeoutMs:60000});}
  yield(job,worker,progress){return this.rpc('arkhen_cloud_catalog_yield',{p_job_id:job.id,p_worker:worker,p_progress:progress});}
  finish(job,worker,success,error=null){return this.rpc('arkhen_finish_cache_job',{p_job_id:job.id,p_worker:worker,p_success:success,p_error_code:error});}
  artworks(rows){return rows.length?this.rpc('arkhen_artwork_put_batch',{p_rows:rows}):Promise.resolve();}
}
