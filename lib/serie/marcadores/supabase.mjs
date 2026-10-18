import {SERIES_MARKER_REGISTRY} from '../../../web/series-markers/registry.js';
import {failure} from './contrato.mjs';
const recordKey=row=>[row.series_slug,row.season,row.episode,row.edition_id].join(':');

/** Immutable edition inserts preserve verified/manual edits; only our source
 * may be deactivated after the full validated source and public export exist. */
export async function applySkipDBRows(cloud,rows,{slugs=SERIES_MARKER_REGISTRY.map(series=>series.slug),signal}={}){
  await cloud.ready;if(!cloud.enabled)throw failure('SKIPDB_CLOUD_DISABLED');
  const check=()=>{if(signal?.aborted)throw failure('SKIPDB_SYNC_ABORTED');};check();
  const existing=[];
  for(let offset=0;;offset+=1000){
    if(offset>=50000)throw failure('SKIPDB_EXISTING_LIMIT');
    const params=new URLSearchParams({select:'series_slug,season,episode,edition_id,verification,is_active',edition_id:'like.skipdb-*','provenance->>source':'eq.skipdb',series_slug:'in.('+slugs.join(',')+')',order:'series_slug,season,episode,edition_id',limit:'1000',offset:String(offset)});
    const page=await cloud.request('/rest/v1/episode_skip_markers?'+params);check();if(!Array.isArray(page))throw failure('SKIPDB_CLOUD_RESPONSE_INVALID');existing.push(...page);if(page.length<1000)break;
  }
  for(let offset=0;offset<rows.length;offset+=200){check();await cloud.request('/rest/v1/episode_skip_markers?on_conflict=series_slug,season,episode,edition_id',{method:'POST',headers:{Prefer:'resolution=ignore-duplicates,return=minimal'},body:rows.slice(offset,offset+200)});}
  const keys=new Map(rows.map(row=>[recordKey(row),row.is_active])),changes=existing.filter(row=>row.verification!=='verified'&&Boolean(row.is_active)!==(keys.get(recordKey(row))===true));
  for(const active of [false,true]){
    const ids=changes.filter(row=>(keys.get(recordKey(row))===true)===active).map(row=>row.edition_id);
    for(let offset=0;offset<ids.length;offset+=100){check();const params=new URLSearchParams({edition_id:'in.('+ids.slice(offset,offset+100).join(',')+')','provenance->>source':'eq.skipdb',verification:'neq.verified'});await cloud.request('/rest/v1/episode_skip_markers?'+params,{method:'PATCH',headers:{Prefer:'return=minimal'},body:{is_active:active}});}
  }
  return {rows:rows.length,activated:changes.filter(row=>keys.get(recordKey(row))===true).length,deactivated:changes.filter(row=>keys.get(recordKey(row))!==true).length};
}

