import {withoutSessionArtwork} from './stored-artwork.js';
import {isAdultItem} from './parental-classification.js';

export const USER_TABLES=Object.freeze(['user_favorites','user_progress','user_preferences','custom_collections']);
export const SHARED_TABLES=Object.freeze(['provider_catalog_cache','epg_cache_versions','provider_games_cache','marker_cache_versions']);
export const itemKey=item=>`${item.kind}:${item.id}`;
export const millis=value=>typeof value==='number'&&Number.isFinite(value)?value:typeof value==='string'&&Number.isFinite(Date.parse(value))?Date.parse(value):0;
const text=(value,max=300)=>typeof value==='string'?value.slice(0,max):'';
const id=value=>typeof value==='string'||typeof value==='number'?String(value):'';

// Only catalog identity/display data belongs in a library. Playback addresses,
// provider credentials and session-bound image references never leave the app.
export function cloudItem(value){
  if(!value||!['live','movie','series'].includes(value.kind)||!/^[A-Za-z0-9_-]{1,160}$/.test(id(value.id))||!text(value.name))return null;
  const item={id:id(value.id),kind:value.kind,name:text(value.name),poster:text(value.poster,300),categoryId:id(value.categoryId),container:/^[a-z0-9]{2,6}$/i.test(value.container||'')?value.container:'mp4'};
  if(Array.isArray(value.categoryIds))item.categoryIds=[...new Set(value.categoryIds.map(id).filter(value=>/^[A-Za-z0-9_-]{1,160}$/.test(value)))].slice(0,100);
  if(isAdultItem(value))item.isAdult=true;
  for(const field of ['group','categoryName'])if(typeof value[field]==='string')item[field]=text(value[field]);
  if(Array.isArray(value.groupNames))item.groupNames=value.groupNames.filter(value=>typeof value==='string').map(value=>text(value)).slice(0,100);
  if(value.year!=null)item.year=text(String(value.year),20);
  if(Number.isFinite(value.rating))item.rating=value.rating;
  for(const field of ['added','savedAt'])if(Number.isFinite(value[field])||typeof value[field]==='string'&&value[field].length<=80)item[field]=value[field];
  return withoutSessionArtwork(item);
}
export function cloudProgress(value,{canRemember=()=>true}={}){
  if(isAdultItem(value)||isAdultItem(value?.episode))return null;
  const item=cloudItem(value?.item),time=value?.time,duration=value?.duration;
  if(!item||isAdultItem(item)||!canRemember(value.item)||typeof time!=='number'||!Number.isFinite(time)||time<0||time>86400*100)return null;
  const entry={item,time,duration:typeof duration==='number'&&Number.isFinite(duration)&&duration>0?Math.min(duration,86400*100):0,completed:value.completed===true,updated:millis(value.updated)||Date.now(),episode:null};
  if(item.kind==='series'){
    const episode=value.episode;
    if(!episode||!/^[A-Za-z0-9_-]{1,160}$/.test(id(episode.id)))return null;
    entry.episode={id:id(episode.id),title:text(episode.title),season:Number.isSafeInteger(Number(episode.season))?Number(episode.season):0,number:Number.isSafeInteger(Number(episode.number))?Number(episode.number):0,container:/^[a-z0-9]{2,6}$/i.test(episode.container||'')?episode.container:'mp4'};
  }
  if(entry.duration)entry.time=Math.min(entry.time,entry.duration);
  return entry;
}
export const recordIdentity=(table,row)=>table==='user_favorites'?row.item_key:table==='user_progress'?JSON.stringify([row.item_key,row.episode_id||'']):table==='user_preferences'?row.key:row.id;
export function replaceRecord(rows,row,table){
  const key=recordIdentity(table,row),previous=(rows||[]).find(entry=>recordIdentity(table,entry)===key);
  if(previous&&millis(previous.updated_at)>millis(row.updated_at))return rows;
  return [...(rows||[]).filter(entry=>recordIdentity(table,entry)!==key),row];
}
export function librarySnapshot(rows,{provider,userId,libraryId,canRemember=()=>true}={}){
  const favorites=(rows.user_favorites||[]).filter(row=>!row.deleted_at).map(row=>{const item=cloudItem(row.item);return item&&itemKey(item)===row.item_key?{...item,savedAt:millis(row.updated_at),...(libraryId?{libraryId}:{})}:null;}).filter(Boolean);
  const episodes=[],latest=new Map(),progressRecords=(rows.user_progress||[]).filter(row=>!isAdultItem(row.entry)&&!isAdultItem(row.entry?.episode)&&(!row.entry?.item||!isAdultItem(row.entry.item)&&canRemember(row.entry.item)));
  for(const row of progressRecords){
    if(row.deleted_at)continue;
    const entry=cloudProgress(row.entry,{canRemember});if(!entry||itemKey(entry.item)!==row.item_key||(entry.episode?.id||'')!==(row.episode_id||''))continue;
    entry.updated=millis(row.updated_at);if(libraryId)entry.libraryId=libraryId;
    if(entry.episode)episodes.push(entry);
    const old=latest.get(itemKey(entry.item));if(!old||old.updated<=entry.updated)latest.set(itemKey(entry.item),entry);
  }
  const preferences=Object.fromEntries((rows.user_preferences||[]).filter(row=>!row.deleted_at).map(row=>[row.key,row.value]));
  return {ready:true,provider,userId,favorites,history:[...latest.values()].sort((a,b)=>b.updated-a.updated),episodes,preferences,
    collections:(rows.custom_collections||[]).filter(row=>!row.deleted_at),favoriteRecords:rows.user_favorites||[],progressRecords,preferenceRecords:rows.user_preferences||[],collectionRecords:rows.custom_collections||[]};
}
export function cloudBootstrap(value){
  if(!value||value.enabled===false)return null;
  let url;try{url=new URL(value.url);}catch{return null;}
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/')return null;
  if(typeof value.publishableKey!=='string'||!/^sb_publishable_[\w-]{10,}$/.test(value.publishableKey))return null;
  if(!/^[a-f0-9-]{36}$/i.test(value.userId||'')||!['wplay','wplay-ott','xtream'].includes(value.provider||'wplay'))return null;
  if(typeof value.session?.access_token!=='string'||!value.session.access_token||typeof value.session?.refresh_token!=='string'||!value.session.refresh_token)return null;
  return {...value,url:url.origin,provider:value.provider||'wplay',providerKey:String(value.providerKey||''),scopeHash:String(value.scopeHash||''),libraryId:String(value.libraryId||'')};
}
