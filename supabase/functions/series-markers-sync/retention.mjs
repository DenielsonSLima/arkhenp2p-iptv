const THREE_DAYS=3*86400000,PAGE=100,MAX_OBJECTS=20;
const rawPattern=/^skipdb-raw-([0-9TZ]{14,32})\.json$/;
const publicPattern=/^skipdb-([0-9TZ]{14,32})(?:-part-[a-f0-9]{24})?\.jsonl$/;
const error=code=>Object.assign(new Error(code),{code});
export function expiredCacheObjects(rows,{kind,context,now=Date.now(),limit=MAX_OBJECTS}={}){
  if(!Array.isArray(rows)||rows.length>PAGE||!['raw','public'].includes(kind))throw error('MARKER_RETENTION_LIST_INVALID');
  const keep=new Set(context.public_keys||[]),pattern=kind==='raw'?rawPattern:publicPattern,keys=[];
  for(const row of rows){
    const match=typeof row?.name==='string'&&pattern.exec(row.name);if(!match||row.id==null)continue;
    const created=Date.parse(row.created_at),updated=Date.parse(row.updated_at);
    if(!Number.isFinite(created)||!Number.isFinite(updated)||Math.max(created,updated)>now-THREE_DAYS)continue;
    if(row.name===context.raw_object||row.name===context.dump_object||match[1]===context.generation||kind==='public'&&keep.has(row.name))continue;
    keys.push(row.name);if(keys.length>=Math.min(MAX_OBJECTS,limit))break;
  }
  return [...new Set(keys)];
}

/** Cache-only cleanup. SQL owns the lease/reference checks; Storage owns object
 * deletion. No direct mutations of storage.objects or private library data. */
export async function retainMarkerCaches({store,owner,now=Date.now,room=()=>true}={}){
  const context=await store.rpc('arkhen_marker_retention_context',{p_owner:owner,p_limit:5000});
  if(!/^[0-9TZ]{14,32}$/.test(context?.generation||''))throw error('MARKER_RETENTION_CONTEXT_INVALID');
  const result={segmentsRemoved:context.removed_segments||0,groupsRemoved:context.removed_groups||0,objectsRemoved:0};
  const offsets={};let attempted=0;
  for(const kind of ['raw','public']){
    if(!room(6000)||attempted>=MAX_OBJECTS)break;
    const bucket=kind==='raw'?'arkhen-marker-staging':'arkhen-marker-open-data';
    const offset=Number.isSafeInteger(context[kind+'_offset'])&&context[kind+'_offset']>=0?context[kind+'_offset']:0;
    const rows=await store.storageList(bucket,offset,PAGE);
    const candidates=expiredCacheObjects(rows,{kind,context,now:now(),limit:MAX_OBJECTS-attempted});
    let removed=0;
    if(candidates.length&&room(5000)){
      const checked=await store.rpc('arkhen_marker_retention_candidates',{p_owner:owner,p_raw:kind==='raw'?candidates:[],p_public:kind==='public'?candidates:[]});
      // A response cannot add unrelated paths, and stale/slow network responses
      // cannot turn an expired worker into a Storage deletion authority.
      const allowed=new Set(Array.isArray(checked?.[kind])?checked[kind]:[]),keys=candidates.filter(key=>allowed.has(key));
      if(keys.length&&Date.parse(checked.lease_until)>now()+12000){
        attempted+=keys.length;
        removed=await store.storageRemove(bucket,keys);result.objectsRemoved+=removed;
      }
    }
    offsets['retention_'+kind+'_offset']=rows.length<PAGE?0:offset+rows.length-removed;
  }
  if(Object.keys(offsets).length)await store.checkpoint(owner,{...offsets,retention_checked_at:new Date(now()).toISOString()});
  return result;
}
