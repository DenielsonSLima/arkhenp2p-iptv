import {USER_TABLES,cloudItem,cloudProgress,itemKey,millis,recordIdentity,replaceRecord} from './cloud-library-records.js';

const browserStorage=()=>{try{return globalThis.localStorage;}catch{return null;}};
const safeJSON=value=>{try{const encoded=JSON.stringify(value);return encoded&&encoded.length<=262144&&!/"(?:password|access_token|refresh_token|service_role|authorization)"\s*:/i.test(encoded)?JSON.parse(encoded):null;}catch{return null;}};
export function cloudPreference(key,value){return typeof key==='string'&&/^[\w.:-]{1,100}$/.test(key)&&!/password|secret|token|credential|username|authorization/i.test(key)?safeJSON(value):null;}
function validRow(table,value,scope){
  if(!USER_TABLES.includes(table)||value?.user_id!==scope?.userId||value?.provider!==scope?.provider||!millis(value.updated_at))return null;
  const base={user_id:value.user_id,provider:value.provider,updated_at:value.updated_at,deleted_at:millis(value.deleted_at)?value.deleted_at:null};
  if(table==='user_favorites'){const item=cloudItem(value.item);return item&&itemKey(item)===value.item_key?{...base,item_key:value.item_key,item}:null;}
  if(table==='user_progress'){const entry=cloudProgress(value.entry);return entry&&itemKey(entry.item)===value.item_key&&(entry.episode?.id||'')===(value.episode_id||'')?{...base,item_key:value.item_key,episode_id:value.episode_id||'',entry}:null;}
  if(table==='user_preferences'){const data=cloudPreference(value.key,value.value);return data!==null?{...base,key:value.key,value:data}:null;}
  return typeof value.id==='string'&&/^[\w-]{1,160}$/.test(value.id)&&typeof value.name==='string'&&value.name.trim()&&['live','movies','series'].includes(value.collection_type)?{...base,id:value.id,name:value.name.slice(0,80),collection_type:value.collection_type,item_keys:[...new Set((Array.isArray(value.item_keys)?value.item_keys:[]).filter(key=>typeof key==='string'&&/^(live|movie|series):[\w-]{1,160}$/.test(key)))].slice(0,1000)}:null;
}

/** Account-bound data-only queue. No auth session or provider address is stored. */
export class CloudOutbox {
  constructor({storage=browserStorage(),limit=2000}={}){this.storage=storage;this.limit=limit;this.scope=null;this.rows=new Map();}
  key(){return this.scope?`arkhen.cloud-outbox.v1.${new URL(this.scope.url).hostname}.${this.scope.provider}.${this.scope.userId}`:'';}
  setScope(scope){
    this.scope=scope;this.rows.clear();if(!scope)return;
    try{
      const encoded=this.storage?.getItem(this.key());if(!encoded||encoded.length>2*1024*1024)return;
      const saved=JSON.parse(encoded);if(saved?.url!==scope.url||saved?.provider!==scope.provider||saved?.userId!==scope.userId||!Array.isArray(saved.entries))return;
      for(const value of saved.entries.slice(-this.limit)){const row=validRow(value.table,value.row,scope);if(row)this.rows.set(`${value.table}:${recordIdentity(value.table,row)}`,{table:value.table,row});}
    }catch{/* The local media library still records progress when storage is unavailable. */}
  }
  persist(){if(!this.scope)return;try{this.storage?.setItem(this.key(),JSON.stringify({version:1,url:this.scope.url,provider:this.scope.provider,userId:this.scope.userId,entries:[...this.rows.values()]}));}catch{/* Storage is optional. */}}
  put(table,value){const row=validRow(table,value,this.scope);if(!row)return false;const key=`${table}:${recordIdentity(table,row)}`,old=this.rows.get(key);if(old&&millis(old.row.updated_at)>millis(row.updated_at))return true;this.rows.delete(key);this.rows.set(key,{table,row});while(this.rows.size>this.limit)this.rows.delete(this.rows.keys().next().value);this.persist();return true;}
  acknowledge(table,row){const key=`${table}:${recordIdentity(table,row)}`;if(this.rows.get(key)?.row.updated_at===row.updated_at){this.rows.delete(key);this.persist();}}
  apply(rows){const result={...rows};for(const {table,row}of this.rows.values())result[table]=replaceRecord(result[table]||[],row,table);return result;}
  entries(){return [...this.rows.values()];}
}
