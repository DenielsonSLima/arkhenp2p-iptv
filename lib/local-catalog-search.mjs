import {createHash} from 'node:crypto';
import {catalogSearchRequest,normalizeCatalogSearch,shortCatalogSearch} from './catalog-search-request.mjs';
import {isAdultItem} from '../web/parental-classification.js';

const TYPES=['live','movies','series'],KINDS={live:'live',movies:'movie',series:'series'};
const ID=/^[A-Za-z0-9_-]{1,160}$/;
const order=new Intl.Collator('pt-BR',{sensitivity:'base',numeric:true});
const list=value=>Array.isArray(value)?value:[];
const text=(value,limit=1000)=>typeof value==='string'||typeof value==='number'
  ?String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').replace(/https?:\/\/[^\s<>"']+/gi,'').slice(0,limit):'';
const id=value=>ID.test(String(value??''))?String(value):'';
const abort=()=>new DOMException('Busca cancelada.','AbortError');
const check=signal=>{if(signal?.aborted)throw abort();};
function wait(promise,signal){
  check(signal);if(!signal)return promise;
  return new Promise((resolve,reject)=>{
    const cancel=()=>{signal.removeEventListener('abort',cancel);reject(abort());};
    signal.addEventListener('abort',cancel,{once:true});
    Promise.resolve(promise).then(value=>{signal.removeEventListener('abort',cancel);resolve(value);},error=>{signal.removeEventListener('abort',cancel);reject(error);});
  });
}
const image=value=>typeof value==='string'&&(
  /^\/api\/image\?ref=[A-Za-z0-9_-]{1,200}$/.test(value)
  ||/^\/api\/(?:shared-image|sports-image)\/[a-f0-9]{64}$/.test(value)
  ||/^\/assets\/[A-Za-z0-9_./-]+$/.test(value)&&!value.includes('..'))?value:'';

/** This projection can contain session artwork references, never media sources. */
function metadata(raw,type,categories){
  const mediaId=id(raw?.id),name=text(raw?.name);
  if(!mediaId||!name||raw.kind!==KINDS[type])return null;
  const categoryIds=[...new Set([raw.categoryId,...list(raw.categoryIds)].map(id).filter(Boolean))];
  const item={id:mediaId,name,kind:KINDS[type],categoryId:categoryIds[0]||'',categoryIds,
    poster:image(raw.poster),backdrop:image(raw.backdrop),year:text(raw.year,20),
    rating:Number.isFinite(Number(raw.rating))?Math.max(0,Math.min(10,Number(raw.rating))):0,
    added:text(raw.added,80),plot:text(raw.plot,20000),genre:text(raw.genre,10000),group:text(raw.group),
    groupNames:list(raw.groupNames).map(value=>text(value,300)).filter(Boolean).slice(0,200),
    container:/^[a-z0-9]{1,12}$/i.test(raw.container||'')?raw.container:'mp4',
    isAdult:isAdultItem(raw,categories)};
  if(typeof raw.imdbId==='string'&&/^tt\d{6,10}$/.test(raw.imdbId))item.imdbId=raw.imdbId;
  if(Number.isSafeInteger(Number(raw.tmdbId))&&Number(raw.tmdbId)>0)item.tmdbId=Number(raw.tmdbId);
  if(Number.isFinite(raw.durationSeconds)&&raw.durationSeconds>0&&raw.durationSeconds<=86400)item.durationSeconds=raw.durationSeconds;
  if(typeof raw.duration==='string')item.duration=text(raw.duration,80);
  return item;
}
function completeCatalog(data){
  if(data.preparing===true||data.pagination?.preparing===true||data.catalogComplete===false||data.pagination?.complete===false)return false;
  if(data.catalogComplete===true||data.pagination?.complete===true)return true;
  // Native flat catalogs have no pagination. A paged preview must explicitly
  // prove completion; merely exhausting its currently loaded items is not proof.
  return !data.pagination;
}
function matchRank(item,query,words,raw){
  const name=normalizeCatalogSearch(item.name),searchable=normalizeCatalogSearch([
    item.name,item.group,item.genre,...item.groupNames,...list(raw.genres).map(value=>typeof value==='string'?value:value?.name),
  ].join(' '));
  if(!words.every(word=>searchable.includes(word)))return -1;
  return name===query?0:name.startsWith(query)?1:name.includes(query)?2:words.every(word=>name.includes(word))?3:4;
}

/**
 * Search already authorized snapshots when the indexed service is unavailable.
 * getCatalog(type,{signal,allowLoad}) must return a session-scoped cached
 * complete/preview snapshot for VOD. Only live/all requests grant allowLoad for
 * live; the adapter may then obtain client.catalog('live'). No page traversal,
 * catalog invalidation or VOD download is performed by this helper.
 *
 * Counts/total describe matching loaded metadata. Partial flags make these
 * lower bounds explicit. With no usable data for the selected domain return
 * null, preserving a retryable unavailable response instead of a false zero.
 */
export async function searchLocalCatalog(request,{getCatalog,includeAdult=false,signal}={}){
  const input=catalogSearchRequest(request);check(signal);
  if(Array.from(input.query).length<3)return shortCatalogSearch(input.query);
  if(typeof getCatalog!=='function')return null;
  const snapshots=await Promise.all(TYPES.map(async type=>{
    try{
      const data=await wait(Promise.resolve().then(()=>getCatalog(type,{signal,allowLoad:type==='live'&&['all','live'].includes(input.type)})),signal);
      return Array.isArray(data?.items)&&Array.isArray(data.categories)?data:null;
    }catch(error){if(signal?.aborted)throw abort();if([401,403].includes(error?.status))throw error;return null;}
  }));
  check(signal);
  const partialTypes=[],missingTypes=[],revision={},found=new Map(),counts={live:0,movie:0,series:0};
  const words=input.query.split(' ').filter(Boolean),usable=new Set();
  for(let index=0;index<TYPES.length;index++){
    const type=TYPES[index],data=snapshots[index];
    if(!data){missingTypes.push(type);partialTypes.push(type);continue;}
    const complete=completeCatalog(data);if(!complete)partialTypes.push(type);
    let validItems=0,invalidItems=0;
    const hidden=new Set(input.hidden[type]||[]),hiddenItems=new Set(input.hiddenItems[type]||[]),hash=createHash('sha256');
    hash.update(JSON.stringify([type,complete]));
    for(const raw of data.items){
      const item=metadata(raw,type,data.categories);if(!item){invalidItems++;continue;}validItems++;
      if(!includeAdult&&item.isAdult||hiddenItems.has(item.id)||item.categoryIds.length&&item.categoryIds.every(value=>hidden.has(value)))continue;
      hash.update(JSON.stringify(item));
      const rank=matchRank(item,input.query,words,raw);if(rank<0)continue;
      const key=`${item.kind}:${item.id}`,previous=found.get(key);
      if(!previous||rank<previous.rank)found.set(key,{item,rank});
    }
    if(validItems||complete&&!data.items.length)usable.add(type);
    if(invalidItems&&!partialTypes.includes(type))partialTypes.push(type);
    revision[type]={source:'session',snapshotId:hash.digest('hex'),complete:complete&&!invalidItems};
  }
  if(input.type==='all'?!usable.size:!usable.has(input.type))return null;
  const matches=[...found.values()].sort((a,b)=>a.rank-b.rank||order.compare(a.item.name,b.item.name)
    ||TYPES.indexOf(a.item.kind==='movie'?'movies':a.item.kind)-TYPES.indexOf(b.item.kind==='movie'?'movies':b.item.kind)
    ||order.compare(a.item.id,b.item.id));
  for(const {item} of matches)counts[item.kind]++;
  const selected=matches.filter(({item})=>input.type==='all'||item.kind===KINDS[input.type]);
  const total=selected.length,items=selected.slice(input.offset,input.offset+input.limit).map(({item})=>item),hasMore=input.offset+items.length<total;
  const partial=partialTypes.length>0;
  return {schemaVersion:1,query:input.query,items,counts,total,hasMore,nextOffset:hasMore?input.offset+items.length:null,
    revision,complete:!partial,preparing:partial,partial,partialTypes,missingTypes,countsArePartial:partial,source:'local-cache',minimumLength:3};
}
