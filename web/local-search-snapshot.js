import {canSearchGlobally,normalizeSearchText,searchCatalogs} from './global-search.js';
import {isAdultItem} from './parental-classification.js';

const TYPES=['live','movies','series'],KINDS={live:'live',movies:'movie',series:'series'};
const identities=new WeakMap();let serial=0;
const complete=catalog=>catalog?.catalogComplete===true&&catalog.preparing!==true&&catalog.pagination?.preparing!==true&&catalog.pagination?.complete!==false;
function snapshotId(catalog){
  if(catalog.pagination?.snapshotId)return catalog.pagination.snapshotId;
  if(!identities.has(catalog))identities.set(catalog,`snapshot-${++serial}`);
  return identities.get(catalog);
}

/** Search only snapshots already held by the caller, on an explicit fallback.
 * Counts are exact for loaded visible metadata; incomplete domains stay marked
 * as partial. This function never fetches a catalog or claims an unseen total. */
export function localSearchSnapshot(input,{catalogs,isItemVisible,isCategoryAllowed=()=>true,signal}={}) {
  if(signal?.aborted)throw new DOMException('Busca cancelada.','AbortError');
  const query=normalizeSearchText(input?.query),type=input?.type??'all',offset=input?.offset??0,limit=input?.limit??120;
  if(!canSearchGlobally(query)||!['all',...TYPES].includes(type)||!Number.isSafeInteger(offset)||offset<0||offset>1000000||!Number.isSafeInteger(limit)||limit<1||limit>120)return null;
  const snapshots=new Map();
  for(const type of TYPES){const catalog=catalogs instanceof Map?catalogs.get(type):catalogs?.[type];if(Array.isArray(catalog?.items))snapshots.set(type,catalog);}
  const usable=type=>{const catalog=snapshots.get(type);return catalog&&(catalog.items.length>0||complete(catalog));};
  if(type==='all'?!TYPES.some(usable):!usable(type))return null;
  const visible=(item,type)=>{
    const catalog=snapshots.get(type),categories=[...(catalog?.categories||[]),...(catalog?.sourceCategories||[])];
    const ids=item.categoryIds?.length?item.categoryIds:[item.categoryId].filter(Boolean);
    return item.kind===KINDS[type]&&(!ids.length||ids.some(id=>isCategoryAllowed(type,String(id))))&&
      (isItemVisible?isItemVisible(item,type):!isAdultItem(item,categories));
  };
  const result=searchCatalogs(snapshots,query,{isItemVisible:visible,isCategoryAllowed});
  if(signal?.aborted)throw new DOMException('Busca cancelada.','AbortError');
  const partialTypes=TYPES.filter(type=>!complete(snapshots.get(type))||result.partialTypes.includes(type)),revision={};
  for(const [type,catalog] of snapshots)revision[type]={source:'client-snapshot',snapshotId:snapshotId(catalog),
    revisionAt:catalog.pagination?.revisionAt||'',itemCount:catalog.items.length,complete:!partialTypes.includes(type)};
  const selected=result.items.filter(item=>type==='all'||item.kind===KINDS[type]),total=selected.length;
  const items=selected.slice(offset,offset+limit),hasMore=offset+items.length<total,partial=partialTypes.length>0;
  return {schemaVersion:1,query,items,counts:result.counts,total,hasMore,nextOffset:hasMore?offset+items.length:null,
    revision,complete:!partial,preparing:partial,partial,partialTypes,missingTypes:result.missingTypes,
    countsArePartial:partial,source:'client-snapshot',minimumLength:3};
}
