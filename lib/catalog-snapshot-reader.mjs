const HASH=/^[a-f0-9]{64}$/i,UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const LIMIT=1000,MAX_ITEMS=1000000,MAX_CATEGORIES=10000;
const fail=()=>{throw Object.assign(new Error('Incomplete catalog snapshot'),{code:'CLOUD_CATALOG_SNAPSHOT_INVALID'});};

/** FIFO across domains. Each domain enqueues only its next bounded read, so
 * Movies cannot place every batch ahead of a new TV/Series request. */
export function catalogReadLimiter(concurrency=2){
  let active=0;const queue=[];
  const run=()=>{while(active<concurrency&&queue.length){const job=queue.shift();active++;Promise.resolve().then(job.task).then(job.resolve,job.reject).finally(()=>{active--;run();});}};
  return task=>new Promise((resolve,reject)=>{queue.push({task,resolve,reject});run();});
}

/** Transport batches remain server-side. Only the verified, complete immutable
 * generation is returned to the application's single catalog request/cache. */
export async function readCatalogSnapshot({read,limitRead,providerKey,scopeHash,type,current=()=>true}){
  if(!HASH.test(providerKey||'')||!HASH.test(scopeHash||'')||!['live','movies','series'].includes(type))fail();
  const filters={provider_key:'eq.'+providerKey,scope_hash:'eq.'+scopeHash,media_type:'eq.'+type};
  const fetchRows=async(table,parameters,{limited=false}={})=>{
    const task=async()=>{if(!current())fail();const rows=await read('/rest/v1/'+table+'?'+new URLSearchParams({...filters,...parameters}));if(!current()||!Array.isArray(rows))fail();return rows;};
    return limited?limitRead(task):task();
  };
  const readHeader=async()=>{
    const rows=await fetchRows('provider_catalog_cache',{select:'is_complete,snapshot_id,index_generation,updated_at,expires_at,item_count,safe_item_count',limit:'1'});
    if(rows.length!==1)return null;const row=rows[0];
    if(row.is_complete!==true||!UUID.test(row.snapshot_id||'')||!UUID.test(row.index_generation||'')||!Number.isSafeInteger(row.item_count)||row.item_count<0||row.item_count>MAX_ITEMS||!Number.isSafeInteger(row.safe_item_count)||row.safe_item_count<0||row.safe_item_count>row.item_count||!Number.isFinite(Date.parse(row.updated_at))||!Number.isFinite(Date.parse(row.expires_at)))return null;
    return row;
  };
  const header=await readHeader();if(!header)return null;
  const generation={generation_id:'eq.'+header.index_generation,is_active:'eq.true'};
  const categories=[],categoryIds=new Set();
  for(let offset=0;offset<=MAX_CATEGORIES;offset+=LIMIT){
    const rows=await fetchRows('catalog_categories',{...generation,select:'category_id,name,is_adult,generation_id',order:'sort_order.asc,category_id.asc',offset:String(offset),limit:String(LIMIT)},{limited:true});
    if(rows.length>LIMIT||categories.length+rows.length>MAX_CATEGORIES)fail();
    for(const row of rows){if(row.generation_id!==header.index_generation||typeof row.category_id!=='string'||!row.category_id||typeof row.name!=='string'||categoryIds.has(row.category_id)||typeof row.is_adult!=='boolean')fail();categoryIds.add(row.category_id);categories.push({id:row.category_id,name:row.name,isAdult:row.is_adult});}
    if(rows.length<LIMIT)break;
  }
  const items=[],ids=new Set(),kind=type==='movies'?'movie':type;let safe=0;
  for(let offset=0;offset<header.item_count;offset+=LIMIT){
    const count=Math.min(LIMIT,header.item_count-offset);
    const rows=await fetchRows('catalog_media',{...generation,select:'media_id,media_type,metadata,is_adult,generation_id',order:'sort_order.asc,media_id.asc',offset:String(offset),limit:String(count)},{limited:true});
    if(rows.length!==count)fail();
    for(const row of rows){
      const item=row.metadata;
      if(row.media_type!==type||row.generation_id!==header.index_generation||typeof row.media_id!=='string'||!row.media_id||!item||typeof item!=='object'||Array.isArray(item)||String(item.id)!==row.media_id||item.kind!==kind||ids.has(row.media_id)||typeof row.is_adult!=='boolean')fail();
      ids.add(row.media_id);items.push({...item,isAdult:row.is_adult});if(!row.is_adult)safe++;
    }
  }
  const after=await readHeader();
  if(!after||['snapshot_id','index_generation','updated_at','expires_at','item_count','safe_item_count'].some(field=>after[field]!==header[field])||items.length!==header.item_count||safe!==header.safe_item_count||!current())fail();
  return {categories,items,catalogComplete:true,preparing:false,pagination:{mode:'complete',source:'supabase',complete:true,snapshotId:header.snapshot_id,revisionAt:new Date(header.updated_at).toISOString(),expiresAt:header.expires_at,total:header.item_count,safeTotal:header.safe_item_count}};
}
