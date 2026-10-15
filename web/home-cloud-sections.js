const key=item=>`${item.kind}:${item.id}`;
const typeFor=kind=>kind==='movie'?'movies':kind;
const channelKey=item=>String(item.name||'').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^a-z0-9+]+/g,' ').trim().replace(/(?:\s+(?:sd|hd|fhd|uhd|4k|hevc|h ?265))+$/,'');

/** Read a small window from the server's precomputed ID order. */
export function readHomeOrder(catalog,order,{visible=()=>true,limit=30}={}){
  if(!catalog?.readModel?.orders?.[order])return null;const items=[];
  const categories=[...(catalog.categories||[]),...(catalog.sourceCategories||[])];
  for(const id of catalog.readModel.orders[order]){const item=catalog.itemMap.get(id);if(item&&!isAdultItem(item,categories)&&visible(item))items.push(item);if(items.length>=limit)break;}return items;
}

/** Shared release/featured orders remain separate from the signed-in user's
 * small history/favorite projection. Local library entries retain optimistic
 * actions while the acknowledged server projection is refreshed. */
export function cloudHomeSections({catalogs,privateModel,history=new Map(),favorites=new Map(),excludedHistory=new Set(),visible=()=>true,resolve=item=>catalogs.get(typeFor(item.kind))?.itemMap.get(String(item.id))||item,limit=30}={}){
  const sections=[],add=(key,title,type,items)=>{if(items.length)sections.push({key,title,type,items});};
  const rememberable=item=>{const catalog=catalogs.get(typeFor(item?.kind));return item&&!isAdultItem(item,[...(catalog?.categories||[]),...(catalog?.sourceCategories||[])]);};
  const unique=(items,{channels=false}={})=>{const seen=new Set(),result=[];for(const raw of items){const item=raw&&resolve(raw);if(!item||!rememberable(raw)||!rememberable(item)||!visible(item))continue;const id=channels?channelKey(item):key(item);if(seen.has(id))continue;seen.add(id);result.push(item);if(result.length>=limit)break;}return result;};
  const recent=kind=>{
    const local=[...history.values()].filter(entry=>entry.item?.kind===kind&&!isAdultItem(entry)&&!isAdultItem(entry.episode)&&rememberable(entry.item)).sort((a,b)=>Number(b.updated||0)-Number(a.updated||0)).slice(0,limit).map(entry=>entry.item);
    return unique([...local,...privateModel?.history?.[kind]||[]].filter(item=>!excludedHistory.has(key(item))));
  };
  const localFavorites=[...favorites.values()].filter(item=>item.kind==='live').sort((a,b)=>Number(b.savedAt||0)-Number(a.savedAt||0));
  const favoriteChannels=unique([...localFavorites,...(privateModel?.favoriteChannels||[]).filter(item=>favorites.has(key(item)))]);
  const recentChannels=recent('live');
  const channels=unique([...favoriteChannels,...recentChannels,...(!favoriteChannels.length&&!recentChannels.length?readHomeOrder(catalogs.get('live'),'name',{visible,limit})||[]:[])],{channels:true});
  add('home:live',favoriteChannels.length?'Seus canais favoritos e recentes':recentChannels.length?'Últimos canais assistidos':'TV ao vivo','live',channels);
  for(const [kind,title,type]of [['movie','filmes','movies'],['series','séries','series']]){
    add(`home:${kind}-history`,kind==='movie'?'Últimos filmes assistidos':'Últimas séries assistidas',type,recent(kind));
    add(`home:${kind}-releases`,`Lançamentos de ${title}`,type,readHomeOrder(catalogs.get(type),'releases',{visible,limit})||[]);
  }
  const recommended=privateModel?.recommendations;
  add('home:recommendations','Recomendados para você','mixed',unique(recommended?.items||[]));
  const recommendations=sections.find(section=>section.key==='home:recommendations');
  if(recommendations)recommendations.subtitle=recommended?.personalized?'Com base no que você assiste':'Filmes e séries bem avaliados';
  return sections;
}

export function cloudFeaturedTitles(catalogs,{visible=()=>true,perType=3}={}){
  const movies=readHomeOrder(catalogs.get('movies'),'featured',{visible,limit:perType})||[],series=readHomeOrder(catalogs.get('series'),'featured',{visible,limit:perType})||[],items=[];
  for(let index=0;index<Math.max(movies.length,series.length);index++){if(movies[index])items.push(movies[index]);if(series[index])items.push(series[index]);}return items;
}
import {isAdultItem} from './parental-classification.js';
