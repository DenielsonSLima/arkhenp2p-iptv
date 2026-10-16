import {isAdultItem} from '../parental-classification.js';

export const homeItemKey=item=>`${item.kind}:${item.id}`;
const typeFor=kind=>kind==='movie'?'movies':kind;
const channelKey=item=>String(item.name||'').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^a-z0-9+]+/g,' ').trim().replace(/(?:\s+(?:sd|hd|fhd|uhd|4k|hevc|h ?265))+$/,'');

/** Read a small window from the server's precomputed ID order. */
export function readHomeOrder(catalog,order,{visible=()=>true,limit=30}={}){
  if(!catalog?.readModel?.orders?.[order])return null;
  const items=[],categories=[...(catalog.categories||[]),...(catalog.sourceCategories||[])];
  if(limit<=0)return items;
  for(const id of catalog.readModel.orders[order]){
    const item=catalog.itemMap.get(id);if(item&&!isAdultItem(item,categories)&&visible(item))items.push(item);
    if(items.length>=limit)break;
  }
  return items;
}

/** Account-filtered history and optimistic favourites augment the small
 * signed-in projection. This does not calculate recommendation affinity. */
export function homeProjectionContext({catalogs=new Map(),privateModel,history=new Map(),favorites=new Map(),excludedHistory=new Set(),
  visible=()=>true,resolve=item=>catalogs.get(typeFor(item.kind))?.itemMap.get(String(item.id))||item,limit=30}={}){
  const rememberable=item=>{
    const catalog=catalogs.get(typeFor(item?.kind));
    return item&&!isAdultItem(item,[...(catalog?.categories||[]),...(catalog?.sourceCategories||[])]);
  };
  const unique=(items,{channels=false}={})=>{
    const seen=new Set(),result=[];if(limit<=0)return result;
    for(const raw of items){
      const item=raw&&resolve(raw);if(!item||!rememberable(raw)||!rememberable(item)||!visible(item))continue;
      const id=channels?channelKey(item):homeItemKey(item);if(seen.has(id))continue;
      seen.add(id);result.push(item);if(result.length>=limit)break;
    }
    return result;
  };
  const recent=kind=>{
    const local=[...history.values()].filter(entry=>entry.item?.kind===kind&&!isAdultItem(entry)&&!isAdultItem(entry.episode)&&rememberable(entry.item))
      .sort((a,b)=>Number(b.updated||0)-Number(a.updated||0)).slice(0,limit).map(entry=>entry.item);
    return unique([...local,...privateModel?.history?.[kind]||[]].filter(item=>!excludedHistory.has(homeItemKey(item))));
  };
  const favoriteChannels=()=>{
    const local=[...favorites.values()].filter(item=>item.kind==='live').sort((a,b)=>Number(b.savedAt||0)-Number(a.savedAt||0));
    return unique([...local,...(privateModel?.favoriteChannels||[]).filter(item=>favorites.has(homeItemKey(item)))]);
  };
  const readOrder=(type,order)=>readHomeOrder(catalogs.get(type),order,{visible,limit})||[];
  return {catalogs,privateModel,history,favorites,excludedHistory,visible,resolve,limit,unique,recent,favoriteChannels,readOrder};
}
