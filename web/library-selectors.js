import {resolveLibraryItem} from './library-catalog.js';

const typeFor=kind=>kind==='movie'?'movies':kind;
/** Start with private records from this exact owner, then enrich with metadata.
 * A global preview is never the authority for which favorites an account owns. */
export function selectLibraryFavorites({favorites,catalogs,libraryId,activeLibraryId,type,visible=()=>true}={}){
  const result=[];
  for(const item of favorites?.values?.()||[]){
    if(type&&typeFor(item.kind)!==type)continue;
    const resolved=resolveLibraryItem(item,{catalog:catalogs?.get(typeFor(item.kind)),libraryId,activeLibraryId});
    if(resolved&&visible(resolved))result.push(resolved);
  }
  return result;
}
export function catalogCountLabel(count,{catalog,kind='títulos',loading=false}={}){
  const incomplete=catalog?.catalogComplete!==true||catalog.preparing===true||catalog.pagination?.preparing===true;
  return `${Number(count).toLocaleString('pt-BR')} ${count===1?kind==='canais'?'canal':'título':kind}${incomplete?count===1?' disponível':' disponíveis':''}${loading?' · Atualizando…':''}`;
}
export function includePreparingSearch(result,catalogs){
  const pending=['live','movies','series'].filter(type=>{const catalog=catalogs.get(type);return catalog?.preparing===true||catalog?.pagination?.preparing===true||catalog?.pagination?.mode==='category'&&catalog.catalogComplete!==true;});
  const partialTypes=[...new Set([...(result.partialTypes||[]),...pending])];return {...result,partialTypes,partial:partialTypes.length>0};
}

// Compare compact private record revisions, not the complete catalog or its
// metadata. Progress ticks cannot trigger catalog reads or browse card rebuilds.
export function libraryChangeSet(previous,next){
  const changes={initial:!previous,favorites:[],progress:[],preferences:[],collections:[]};
  const tables=[['favorites','favoriteRecords',row=>row.item_key],['progress','progressRecords',row=>`${row.item_key}:${row.episode_id||''}`],['preferences','preferenceRecords',row=>row.key],['collections','collectionRecords',row=>row.id]];
  for(const [section,field,key]of tables){
    const before=new Map((previous?.[field]||[]).map(row=>[key(row),JSON.stringify(row)]));
    for(const row of next?.[field]||[]){const id=key(row);if(before.get(id)!==JSON.stringify(row))changes[section].push(section==='preferences'?row.key:section==='collections'?row.collection_type:row.item?.kind||row.entry?.item?.kind||row.item_key?.split(':')[0]);before.delete(id);}
    for(const id of before.keys())changes[section].push(section==='preferences'?id:section==='collections'?'all':id.split(':')[0]);
    changes[section]=[...new Set(changes[section].filter(Boolean))];
  }
  return changes;
}
