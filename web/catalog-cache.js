import {isAdultCategory,isAdultItem} from './parental-classification.js';
import {sanitizeCatalogReadModel} from './catalog-read-model.js';
import {catalogMatchesPublication,normalizeCatalogPublication,compareCatalogRevisions} from './catalog-revision.js';

export const CATALOG_CACHE_TTL_MS=86400000;
export const CATALOG_CACHE_RECORD_VERSION=2;
const PROJECT='https://wnicimkmzswksaqdtgdv.supabase.co',TYPES=['live','movies','series'],HASH=/^[a-f0-9]{64}$/i;
const id=value=>typeof value==='string'||typeof value==='number'?String(value):'';
const safeID=value=>/^[A-Za-z0-9_-]{1,160}$/.test(id(value))?id(value):'';
const text=(value,max=1000)=>typeof value==='string'||typeof value==='number'?String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').replace(/(?:https?:)?\/\/[^\s<>"']+/gi,'').slice(0,max):'';
const array=value=>Array.isArray(value)?value:value instanceof Set?[...value]:[];
const artwork=value=>typeof value==='string'&&(/^\/api\/(?:shared|sports)-image\/[a-f0-9]{64}$/.test(value)||/^\/assets\/[A-Za-z0-9_./-]+$/.test(value)&&!value.includes('..'))?value:'';
function scopeOf(value){
  if(!value||!TYPES.includes(value.type)||!HASH.test(value.providerKey||'')||!HASH.test(value.scopeHash||'')||typeof value.includeAdult!=='boolean')return null;
  let url;try{url=new URL(value.project||PROJECT);}catch{return null;}
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/')return null;
  return {project:url.origin,providerKey:value.providerKey.toLowerCase(),scopeHash:value.scopeHash.toLowerCase(),type:value.type,includeAdult:value.includeAdult};
}
const cacheKey=scope=>JSON.stringify(['arkhen-catalog',1,scope.project,scope.providerKey,scope.scopeHash,scope.type,scope.includeAdult]);
const verificationKey=scope=>JSON.stringify(['arkhen-catalog-verified',1,scope.project,scope.providerKey,scope.scopeHash,scope.type,scope.includeAdult]);
// Keep the database/store/key unchanged. Old v1 snapshots may lack publication
// identity; ignore them on read and atomically replace them on the next valid
// download, without inheriting their old timestamp/revision as a write fence.
function newer(previous,next){if(previous?.version!==next.version)return !Number.isSafeInteger(previous?.version)||previous.version<next.version;const order=compareCatalogRevisions(next.catalog?.pagination?.revisionAt,previous?.catalog?.pagination?.revisionAt);return !(previous?.savedAt>next.savedAt||Number.isFinite(order)&&order<0);}

/** Explicit global metadata allowlist. No account, favorites, credentials,
 * playback sources or session-bound artwork enters the catalog database. */
export function sanitizeCatalogCache(catalog,{type,includeAdult=false}={}){
  if(!TYPES.includes(type)||catalog?.catalogComplete!==true||catalog.preparing===true||catalog.pagination?.preparing===true||catalog.pagination?.complete===false||!Array.isArray(catalog.items)||catalog.items.length>500000)return null;
  const rawCategories=Array.isArray(catalog.sourceCategories)?catalog.sourceCategories:catalog.categories;if(!Array.isArray(rawCategories)||rawCategories.length>20000)return null;
  const categories=[],items=[],seenCategories=new Set(),seenItems=new Set();
  for(const raw of rawCategories){const categoryID=safeID(raw?.id),name=text(raw?.name);if(!categoryID||!name||seenCategories.has(categoryID))continue;seenCategories.add(categoryID);const category={id:categoryID,name,...(isAdultCategory(raw)?{isAdult:true}:{})};const ids=array(raw.ids).map(safeID).filter(Boolean);if(ids.length)category.ids=[...new Set(ids)].slice(0,1000);categories.push(category);}
  const kind=type==='movies'?'movie':type;
  for(const raw of catalog.items){
    const itemID=safeID(raw?.id),name=text(raw?.name);if(!itemID||!name||seenItems.has(itemID)||raw.kind!==kind)continue;seenItems.add(itemID);
    const categoryIds=[...new Set([raw.categoryId,...array(raw.categoryIds)].map(safeID).filter(Boolean))].slice(0,100);
    const adult=isAdultItem({...raw,name,categoryIds,groupNames:array(raw.groupNames)},categories);if(!includeAdult&&adult)continue;
    const item={id:itemID,name,kind,categoryId:safeID(raw.categoryId)||categoryIds[0]||'',categoryIds,poster:artwork(raw.poster),backdrop:artwork(raw.backdrop),year:text(raw.year,20),rating:Number.isFinite(raw.rating)?Math.max(0,Math.min(10,raw.rating)):0,added:text(raw.added,80),plot:text(raw.plot,5000),genre:text(raw.genre,2000),container:/^[a-z0-9]{2,6}$/i.test(raw.container||'')?raw.container:'mp4'};
    for(const field of ['group','categoryName','cast','director'])if(typeof raw[field]==='string')item[field]=text(raw[field],1000);
    if(Array.isArray(raw.groupNames))item.groupNames=raw.groupNames.map(value=>text(value,300)).filter(Boolean).slice(0,100);
    if(Number.isFinite(raw.durationSeconds)&&raw.durationSeconds>0&&raw.durationSeconds<=86400)item.durationSeconds=raw.durationSeconds;
    if(typeof raw.duration==='string')item.duration=text(raw.duration,80);
    if(typeof raw.imdbId==='string'&&/^tt\d{6,10}$/.test(raw.imdbId))item.imdbId=raw.imdbId;
    if(Number.isSafeInteger(raw.tmdbId)&&raw.tmdbId>0)item.tmdbId=raw.tmdbId;
    if(adult)item.isAdult=true;if(kind==='live')item.posterOriginal=artwork(raw.posterOriginal);
    items.push(item);
  }
  const pagination={mode:'complete',source:'supabase'};
  if(/^[a-f0-9-]{36}$/i.test(catalog.pagination?.snapshotId||''))pagination.snapshotId=catalog.pagination.snapshotId;
  if(Number.isFinite(Date.parse(catalog.pagination?.revisionAt)))pagination.revisionAt=new Date(catalog.pagination.revisionAt).toISOString();
  if(Number.isFinite(Date.parse(catalog.pagination?.expiresAt)))pagination.expiresAt=new Date(catalog.pagination.expiresAt).toISOString();
  const result={catalogComplete:true,categories:includeAdult?categories:categories.filter(category=>!isAdultCategory(category)),items,pagination};
  const readModel=sanitizeCatalogReadModel(catalog.readModel,result,{type,includeAdult});if(readModel)result.readModel=readModel;
  return result;
}

/** One readwrite transaction replaces a complete snapshot atomically. */
export class IndexedDBCatalogStorage{
  constructor({indexedDB=globalThis.indexedDB,databaseName='arkhen-catalog-v1'}={}){Object.assign(this,{indexedDB,databaseName});this.pending=null;}
  async open(){
    if(!this.indexedDB)throw new Error('CATALOG_CACHE_UNAVAILABLE');
    if(!this.pending)this.pending=new Promise((resolve,reject)=>{const request=this.indexedDB.open(this.databaseName,1);let rejected=false;request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains('catalogs'))request.result.createObjectStore('catalogs');};request.onerror=()=>reject(new Error('CATALOG_CACHE_UNAVAILABLE'));request.onblocked=()=>{rejected=true;reject(new Error('CATALOG_CACHE_BLOCKED'));};request.onsuccess=()=>{const db=request.result;if(rejected){db.close();return;}db.onversionchange=()=>{db.close();this.pending=null;};resolve(db);};}).catch(error=>{this.pending=null;throw error;});
    return this.pending;
  }
  async transaction(mode,run){const db=await this.open();return new Promise((resolve,reject)=>{const tx=db.transaction('catalogs',mode);let result;tx.oncomplete=()=>resolve(result);tx.onerror=tx.onabort=()=>reject(new Error('CATALOG_CACHE_TRANSACTION_FAILED'));try{const request=run(tx.objectStore('catalogs'));if(request)request.onsuccess=()=>{result=request.result;};}catch(error){tx.abort();reject(error);}});}
  get(key){return this.transaction('readonly',store=>store.get(key));}
  put(key,value){return this.transaction('readwrite',store=>store.put(value,key));}
  async putIfNewer(key,value){const db=await this.open();return new Promise((resolve,reject)=>{const tx=db.transaction('catalogs','readwrite'),store=tx.objectStore('catalogs'),request=store.get(key);let accepted=false;tx.oncomplete=()=>resolve(accepted);tx.onerror=tx.onabort=()=>reject(new Error('CATALOG_CACHE_TRANSACTION_FAILED'));request.onsuccess=()=>{if(newer(request.result,value)){store.put(value,key);accepted=true;}};});}
  delete(key){return this.transaction('readwrite',store=>store.delete(key));}
  async close(){const db=await this.pending?.catch(()=>null);db?.close();this.pending=null;}
}

export class CatalogCache{
  constructor({storage=new IndexedDBCatalogStorage(),now=Date.now,ttlMs=CATALOG_CACHE_TTL_MS}={}){Object.assign(this,{storage,now,ttlMs});this.writes=new Map();this.epochs=new Map();}
  async read(value){
    const scope=scopeOf(value);if(!scope)return null;const key=cacheKey(scope),epoch=this.epochs.get(key)||0;
    try{
      await this.writes.get(key)?.catch(()=>{});const record=await this.storage.get(key);
      if((this.epochs.get(key)||0)!==epoch||record?.version!==CATALOG_CACHE_RECORD_VERSION||cacheKey(scopeOf(record.scope)||{})!==key||!Number.isFinite(record.savedAt)||record.savedAt>this.now()+60000)return null;
      const catalog=sanitizeCatalogCache(record.catalog,scope);if(!catalog)return null;
      // This small record never rewrites the catalog or changes its byte age.
      // A missing/evicted verification simply requires another header check.
      let check=null;try{check=await this.storage.get(verificationKey(scope));}catch{/* Keep the complete snapshot if only verification metadata was evicted. */}
      if((this.epochs.get(key)||0)!==epoch)return null;
      const verifiedAt=check?.version===1&&cacheKey(scopeOf(check.scope)||{})===key&&Number.isFinite(check.verifiedAt)&&check.verifiedAt>=record.savedAt&&check.verifiedAt<=this.now()+60000&&catalogMatchesPublication(catalog,check.publication,scope)?check.verifiedAt:0;
      return {catalog,savedAt:record.savedAt,verifiedAt,fresh:this.now()-Math.max(record.savedAt,verifiedAt)<this.ttlMs};
    }catch{return null;}
  }
  write(value,data,{fetchedAt=this.now()}={}){
    const scope=scopeOf(value),catalog=scope&&sanitizeCatalogCache(data,scope);if(!scope||!catalog||!Number.isFinite(fetchedAt)||fetchedAt>this.now()+60000)return Promise.resolve(false);
    const key=cacheKey(scope),epoch=this.epochs.get(key)||0,record={version:CATALOG_CACHE_RECORD_VERSION,scope,savedAt:fetchedAt,catalog};
    const pending=(this.writes.get(key)||Promise.resolve()).catch(()=>{}).then(async()=>{if((this.epochs.get(key)||0)!==epoch)return false;try{if(this.storage.putIfNewer)return await this.storage.putIfNewer(key,record);const previous=await this.storage.get(key);if(!newer(previous,record)||(this.epochs.get(key)||0)!==epoch)return false;await this.storage.put(key,record);return true;}catch{return false;}});
    this.writes.set(key,pending);void pending.finally(()=>{if(this.writes.get(key)===pending)this.writes.delete(key);});return pending;
  }
  verify(value,publication,{verifiedAt=this.now()}={}){
    const scope=scopeOf(value),normalized=scope&&normalizeCatalogPublication(publication,scope);
    if(!normalized||!Number.isFinite(verifiedAt)||verifiedAt>this.now()+60000||verifiedAt<=0)return Promise.resolve(false);
    const key=cacheKey(scope),epoch=this.epochs.get(key)||0;
    const pending=(this.writes.get(key)||Promise.resolve()).catch(()=>{}).then(async()=>{
      if((this.epochs.get(key)||0)!==epoch)return false;
      try{await this.storage.put(verificationKey(scope),{version:1,scope,publication:normalized,verifiedAt});return true;}catch{return false;}
    });
    this.writes.set(key,pending);void pending.finally(()=>{if(this.writes.get(key)===pending)this.writes.delete(key);});return pending;
  }
  async clear(value){const scope=scopeOf(value);if(!scope)return false;const key=cacheKey(scope);this.epochs.set(key,(this.epochs.get(key)||0)+1);try{await this.writes.get(key)?.catch(()=>{});await Promise.all([this.storage.delete(key),this.storage.delete(verificationKey(scope))]);return true;}catch{return false;}}
  async clearAdult(scope){const results=await Promise.all(TYPES.map(type=>this.clear({...scope,type,includeAdult:true})));return results.every(Boolean);}
}
