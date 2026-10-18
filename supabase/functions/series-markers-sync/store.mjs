const jsonHeaders={Accept:'application/json','Content-Type':'application/json'};
const failure=code=>Object.assign(new Error(code),{code});
const query=parameters=>new URLSearchParams(parameters).toString();
export class MarkerStore{
  constructor({url,key,fetch:request=globalThis.fetch,uploadTimeoutMs=15000}){this.url=url.replace(/\/$/,'');this.key=key;this.request=request;this.uploadTimeoutMs=uploadTimeoutMs;}
  authHeaders(){return {apikey:this.key,...(this.key.startsWith('eyJ')?{Authorization:'Bearer '+this.key}:{})};}
  async call(path,{method='GET',body,headers={}}={}){
    let response;try{response=await this.request(this.url+path,{method,headers:{...jsonHeaders,...this.authHeaders(),...headers},...(body!==undefined?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000)});}catch{throw failure('MARKER_DATABASE_UNAVAILABLE');}
    if(!response.ok)throw failure('MARKER_DATABASE_HTTP_'+response.status);if(response.status===204)return null;const text=await response.text();return text?JSON.parse(text):null;
  }
  rpc(name,body){return this.call('/rest/v1/rpc/'+name,{method:'POST',body});}
  claim(owner){return this.rpc('arkhen_marker_claim',{p_owner:owner,p_lease_seconds:70});}
  release(owner,result,cooldowns){return this.rpc('arkhen_marker_release',{p_owner:owner,p_result:result,p_skipdb_cooldown:cooldowns.skipdb?new Date(cooldowns.skipdb).toISOString():null,p_introdb_cooldown:cooldowns.introdb?new Date(cooldowns.introdb).toISOString():null});}
  discover(){return this.rpc('arkhen_marker_discover',{p_limit:500});}
  discoverBatch(){return this.rpc('arkhen_marker_discover_batch',{p_limit:500});}
  auditDue(now,limit){return this.call('/rest/v1/series_marker_coverage?'+query({select:'*',audit_priority:'gt.0',audit_next_check_at:'lte.'+new Date(now).toISOString(),order:'audit_priority.desc,audit_next_check_at.asc,imdb_id.asc,season.asc,episode.asc',limit:String(Math.min(10,Math.max(1,limit)))}));}
  due(table,field,now,limit,extra={}){return this.call('/rest/v1/'+table+'?'+query({select:'*',[field]:'lte.'+new Date(now).toISOString(),order:field+'.asc',limit:String(limit),...extra}));}
  save(table,rows,conflict,{ignore=false}={}){if(!rows.length)return Promise.resolve();return this.call('/rest/v1/'+table+'?'+query({on_conflict:conflict}),{method:'POST',headers:{Prefer:'resolution='+(ignore?'ignore':'merge')+'-duplicates,return=minimal'},body:rows});}
  update(table,filters,patch){return this.call('/rest/v1/'+table+'?'+query(filters),{method:'PATCH',headers:{Prefer:'return=minimal'},body:patch});}
  identity(row,patch){return this.update('series_marker_identities',{provider_key:'eq.'+row.provider_key,scope_hash:'eq.'+row.scope_hash,media_id:'eq.'+row.media_id},patch);}
  title(row,patch){return this.update('series_marker_titles',{imdb_id:'eq.'+row.imdb_id},patch);}
  async coverage(row,patch){
    // A newly queued audit or concurrent source publication must survive an old
    // in-flight HTTP response. Compare the exact revision read by this worker.
    const filters={imdb_id:'eq.'+row.imdb_id,season:'eq.'+row.season,episode:'eq.'+row.episode,
      audit_requested_at:row.audit_requested_at?'eq.'+row.audit_requested_at:'is.null',
      ...(row.updated_at?{updated_at:'eq.'+row.updated_at}:{}),select:'imdb_id,season,episode'};
    const changed=await this.call('/rest/v1/series_marker_coverage?'+query(filters),{method:'PATCH',headers:{Prefer:'return=representation'},body:patch});
    return Array.isArray(changed)&&changed.length===1;
  }
  bumpVersion(){return this.update('marker_cache_versions',{name:'eq.global'},{generation:crypto.randomUUID(),updated_at:new Date().toISOString()});}
  checkpoint(owner,patch){return this.update('series_marker_sync_state',{name:'eq.global',lease_owner:'eq.'+owner,lease_until:'gt.'+new Date().toISOString()},patch);}
  async storageList(bucket,offset=0,limit=100){
    if(!['arkhen-marker-staging','arkhen-marker-open-data'].includes(bucket)||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100)throw failure('MARKER_RETENTION_LIST_INVALID');
    const rows=await this.call('/storage/v1/object/list/'+bucket,{method:'POST',body:{prefix:'',limit,offset,sortBy:{column:'name',order:'asc'},search:'skipdb-'}});
    if(!Array.isArray(rows)||rows.length>limit)throw failure('MARKER_RETENTION_LIST_INVALID');return rows;
  }
  async storageRemove(bucket,keys){
    const pattern=bucket==='arkhen-marker-staging'?/^skipdb-raw-[0-9TZ]{14,32}\.json$/:bucket==='arkhen-marker-open-data'?/^skipdb-[0-9TZ]{14,32}(?:-part-[a-f0-9]{24})?\.jsonl$/:null;
    if(!pattern||!Array.isArray(keys)||!keys.length||keys.length>20||keys.some(key=>typeof key!=='string'||!pattern.test(key)))throw failure('MARKER_RETENTION_DELETE_INVALID');
    const rows=await this.call('/storage/v1/object/'+bucket,{method:'DELETE',body:{prefixes:keys}});
    if(!Array.isArray(rows)||rows.some(row=>!keys.includes(row.name??row.Key)))throw failure('MARKER_RETENTION_DELETE_RESULT_INVALID');return new Set(rows.map(row=>row.name??row.Key)).size;
  }
  async uploadDump(key,body){
    const response=await this.request(this.url+'/storage/v1/object/arkhen-marker-open-data/'+key,{method:'POST',headers:{...this.authHeaders(),'Content-Type':'application/x-ndjson','x-upsert':'true'},body,...(body instanceof ReadableStream?{duplex:'half'}:{}),signal:AbortSignal.timeout(this.uploadTimeoutMs)});
    if(!response.ok)throw failure('MARKER_EXPORT_FAILED');return this.url+'/storage/v1/object/public/arkhen-marker-open-data/'+key;
  }
  async uploadRaw(key,body){
    let bytes=0;const checked=body.pipeThrough(new TransformStream({transform(chunk,controller){bytes+=chunk.byteLength;if(bytes>67108864)throw failure('DUMP_TOO_LARGE');controller.enqueue(chunk);}}));
    const response=await this.request(this.url+'/storage/v1/object/arkhen-marker-staging/'+key,{method:'POST',headers:{...this.authHeaders(),'Content-Type':'application/json','x-upsert':'true'},body:checked,duplex:'half',signal:AbortSignal.timeout(45000)});
    if(!response.ok)throw failure('MARKER_RAW_UPLOAD_FAILED');
  }
  async rawPage(key,offset){
    if(!/^skipdb-raw-[0-9TZ]+\.json$/.test(key))throw failure('MARKER_RAW_KEY_INVALID');
    const response=await this.request(this.url+'/storage/v1/object/authenticated/arkhen-marker-staging/'+key,{headers:{...this.authHeaders(),Range:`bytes=${offset}-${offset+524287}`},signal:AbortSignal.timeout(10000)});
    if(!response.ok||response.status!==206)throw failure('MARKER_RAW_RANGE_FAILED');const bytes=new Uint8Array(await response.arrayBuffer());
    if(bytes.length>524288)throw failure('MARKER_RAW_RANGE_TOO_LARGE');return bytes;
  }
  async dumpPage(key,offset){
    if(!/^[a-zA-Z0-9_.-]{1,120}\.jsonl$/.test(key)||!Number.isSafeInteger(offset)||offset<0)throw failure('MARKER_CURSOR_INVALID');
    const response=await this.request(this.url+'/storage/v1/object/public/arkhen-marker-open-data/'+key,{headers:{Range:`bytes=${offset}-${offset+524287}`},signal:AbortSignal.timeout(10000)});
    if(response.status===416)return {records:[],next:offset,done:true};
    if(!response.ok||offset>0&&response.status!==206)throw failure('MARKER_EXPORT_RANGE_FAILED');
    const bytes=new Uint8Array(await response.arrayBuffer());if(bytes.length>2097152)throw failure('MARKER_EXPORT_RANGE_TOO_LARGE');
    const end=bytes.lastIndexOf(10);if(end<0)throw failure('MARKER_EXPORT_LINE_INVALID');
    const records=[],offsets=[],decoder=new TextDecoder();let start=0;
    for(let index=0;index<=end;index++)if(bytes[index]===10){const text=decoder.decode(bytes.subarray(start,index)),row=text.trim()?JSON.parse(text):null;start=index+1;if(row&&row.type!=='metadata'){records.push(row);offsets.push(offset+index+1);}}
    const total=Number(/\/(\d+)$/.exec(response.headers.get('content-range')||'')?.[1]||bytes.length),next=offset+end+1;
    return {records,offsets,next,done:next>=total};
  }
}
