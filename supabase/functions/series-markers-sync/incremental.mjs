import {LICENSE,DAY,imdbID,canonicalSeries,digest,normalizeGlobalDump} from './metadata.mjs';
import {openPublicDump} from './providers.mjs';

const error=code=>Object.assign(new Error(code),{code}),iso=value=>new Date(value).toISOString();
export function parseRawRange(bytes,{offset=0,metadata=null}={}){
  let position=0,count=0,excluded=0;const decoder=new TextDecoder(),rows=[];
  if(offset===0){
    const text=decoder.decode(bytes),match=/"segments"\s*:\s*\[/.exec(text);if(!match)throw error('DUMP_HEADER_INVALID');
    try{metadata=JSON.parse(text.slice(0,match.index)+'"segments":[]}');}catch{throw error('DUMP_HEADER_INVALID');}
    if(metadata.license!==LICENSE||metadata.license_url!=='https://skipdb.tv/license'||!Number.isSafeInteger(metadata.count)||!Number.isFinite(Date.parse(metadata.generated_at)))throw error('DUMP_HEADER_INVALID');
    position=new TextEncoder().encode(text.slice(0,match.index+match[0].length)).length;
  }
  if(!metadata)throw error('DUMP_HEADER_REQUIRED');
  while(position<bytes.length){
    while(position<bytes.length&&[9,10,13,32,44].includes(bytes[position]))position++;
    if(position>=bytes.length)break;
    if(bytes[position]===93)return {rows,count,excluded,next:offset+position+1,complete:true,metadata};
    const start=position;if(bytes[start]!==123)throw error('DUMP_OBJECT_INVALID');
    let depth=0,quoted=false,escaped=false,complete=false;
    for(;position<bytes.length;position++){
      const byte=bytes[position];if(quoted){if(escaped)escaped=false;else if(byte===92)escaped=true;else if(byte===34)quoted=false;continue;}
      if(byte===34)quoted=true;else if(byte===123)depth++;else if(byte===125&&--depth===0){complete=true;position++;break;}
    }
    if(!complete)return {rows,count,excluded,next:offset+start,complete:false,metadata};
    const raw=JSON.parse(decoder.decode(bytes.subarray(start,position)));count++;
    if(raw.status!=='approved'||raw.media_type!=='series'||!imdbID(raw.imdb_id)||raw.episode===0){excluded++;continue;}
    if(!Number.isSafeInteger(raw.id)||raw.id<1||!Number.isSafeInteger(raw.season)||raw.season<0||raw.season>1000||!Number.isSafeInteger(raw.episode)||raw.episode<1||raw.episode>10000||!['intro','outro','preview','recap'].includes(raw.segment_type)||!Number.isFinite(raw.start_ms)||!Number.isFinite(raw.end_ms)||raw.start_ms<0||raw.end_ms<raw.start_ms||raw.end_ms>86400000||raw.duration_ms!=null&&(!Number.isFinite(raw.duration_ms)||raw.duration_ms<=0||raw.duration_ms>86400000||raw.end_ms>raw.duration_ms))throw error('DUMP_SEGMENT_INVALID');
    rows.push({segment_id:raw.id,imdb_id:raw.imdb_id,season:raw.season,episode:raw.episode,segment_type:raw.segment_type,start_ms:raw.start_ms,end_ms:raw.end_ms,duration_ms:raw.duration_ms??null,score:Number.isFinite(raw.score)?raw.score:0});
  }
  return {rows,count,excluded,next:offset+position,complete:false,metadata};
}

export async function advanceIncrementalSource({store,state,owner,request,now=Date.now,room,artifactStream,result}){
  if(Date.parse(state.dump_retry_at)>now())return;
  const stale=now()-(Date.parse(state.dump_refreshed_at)||0)>=DAY;
  const refreshDue=!state.raw_object&&(!state.dump_object||stale)||state.dump_completed_at&&stale;
  if(refreshDue&&!(Date.parse(state.dump_retry_at)>now())&&room(10000)){
    const generation=iso(now()).replace(/[^0-9TZ]/g,''),key='skipdb-raw-'+generation+'.json',response=await openPublicDump(request);
    await store.uploadRaw(key,response.body);
    Object.assign(state,{source_mode:'incremental',raw_object:key,raw_generation:generation,raw_cursor:0,raw_seen_count:0,raw_complete_at:null,raw_metadata:null,dump_completed_at:null,dump_refreshed_at:iso(now())});
    await store.checkpoint(owner,{source_mode:state.source_mode,raw_object:key,raw_generation:generation,raw_cursor:0,raw_seen_count:0,raw_complete_at:null,raw_metadata:null,dump_completed_at:null,dump_refreshed_at:state.dump_refreshed_at,dump_retry_at:null});
    result.rawCopied=true;return;
  }
  if(!state.raw_object||state.dump_completed_at)return;
  for(let page=0;page<2&&!state.raw_complete_at&&room(6000);page++){
    const parsed=parseRawRange(await store.rawPage(state.raw_object,Number(state.raw_cursor)||0),{offset:Number(state.raw_cursor)||0,metadata:state.raw_metadata});
    if(parsed.next<=Number(state.raw_cursor||0))throw error('DUMP_RANGE_CANNOT_ADVANCE');
    await store.rpc('arkhen_marker_stage_page',{p_generation:state.raw_generation,p_owner:owner,p_rows:parsed.rows,p_count:parsed.count,p_next:parsed.next,p_complete:parsed.complete,p_metadata:parsed.metadata});
    Object.assign(state,{raw_cursor:parsed.next,raw_seen_count:Number(state.raw_seen_count||0)+parsed.count,raw_metadata:parsed.metadata,raw_complete_at:parsed.complete?iso(now()):null,dump_generation:state.raw_generation});
    result.rawStaged=Number(result.rawStaged||0)+parsed.rows.length;
  }
  let changed=false,normalizedSegments=0;
  for(let chunk=0;chunk<8&&state.raw_complete_at&&room(8000);chunk++){
    const batch=await store.rpc('arkhen_marker_source_batch',{p_generation:state.raw_generation,p_owner:owner,p_limit:20});
    if(batch.excluded_groups){result.sourceExcluded=batch.excluded_groups;result.state='partial';result.sourceError='SOURCE_EPISODE_GROUP_LIMIT';}
    if(!batch.groups.length){await store.rpc('arkhen_marker_finalize',{p_generation:state.raw_generation,p_owner:owner});await store.checkpoint(owner,{dump_completed_at:iso(now())});state.dump_completed_at=iso(now());result.dumpComplete=true;result.cacheChanged=true;changed=true;break;}
    if(normalizedSegments+batch.segments.length>4000)break;normalizedSegments+=batch.segments.length;
    const normalized=await normalizeGlobalDump({license:LICENSE,license_url:'https://skipdb.tv/license',generated_at:state.raw_metadata.generated_at,count:batch.segments.length,segments:batch.segments},{now:now(),consume:true});
    const records=normalized.records,references=normalized.references,key='skipdb-'+state.raw_generation+'-part-'+await digest(batch.groups)+'.jsonl';
    const exportURL=store.url+'/storage/v1/object/public/arkhen-marker-open-data/'+key;
    for(const row of records)row.provenance.openDataUrl=exportURL;
    // The licensed public artifact exists before any corresponding database row.
    await store.uploadDump(key,artifactStream({type:'metadata',license:LICENSE,licenseUrl:'https://skipdb.tv/license',sourceUrl:'https://skipdb.tv/api/dump',generatedAt:state.raw_metadata.generated_at},records.concat(references)));
    const titles=[...new Map([...records,...references].map(row=>[row.imdb_id,{...canonicalSeries(row.imdb_id,null,row.tmdb_id),inventory_check_at:'9999-01-01T00:00:00.000Z'}])).values()];
    await store.save('series_marker_titles',titles,'imdb_id',{ignore:true});
    if(records.length)await store.rpc('arkhen_marker_publish',{p_rows:records.map(({title,...row})=>row),p_generation:state.raw_generation,p_owner:owner});result.published+=records.length;
    const coverage=new Map();for(const row of records){const key=[row.imdb_id,row.season,row.episode].join(':'),complete=row.markers.openingEnd!==undefined;
      coverage.set(key,{imdb_id:row.imdb_id,series_slug:row.series_slug,tmdb_id:row.tmdb_id,season:row.season,episode:row.episode,status:complete||coverage.get(key)?.status==='ready'?'ready':'unverified',source:'skipdb',skipdb_status:complete?'ready':'partial',next_check_at:iso(now()+(complete?DAY:0))});}
    await store.save('series_marker_coverage',[...coverage.values()],'imdb_id,season,episode');
    if(references.length)await store.save('series_marker_coverage',references.map(row=>({imdb_id:row.imdb_id,series_slug:row.series_slug,tmdb_id:row.tmdb_id,season:row.season,episode:row.episode,status:'unverified',source:'skipdb',skipdb_status:'unverified',evidence:row.evidence,error_code:'SOURCE_EDITION_DURATION_UNAVAILABLE',next_check_at:iso(now()+7*DAY)})),'imdb_id,season,episode',{ignore:true});
    await store.rpc('arkhen_marker_source_done',{p_generation:state.raw_generation,p_owner:owner,p_groups:batch.groups,p_export_key:key});changed=true;
  }
  if(changed&&room(3000)){
    const parts=await store.rpc('arkhen_marker_source_index',{p_generation:state.raw_generation});
    await store.uploadDump('skipdb-current.json',JSON.stringify({schemaVersion:1,license:LICENSE,licenseUrl:'https://skipdb.tv/license',sourceUrl:'https://skipdb.tv/api/dump',generation:state.raw_generation,complete:Boolean(state.dump_completed_at),excludedEpisodes:result.sourceExcluded||0,parts:parts.map(key=>store.url+'/storage/v1/object/public/arkhen-marker-open-data/'+key)}));
  }
}
