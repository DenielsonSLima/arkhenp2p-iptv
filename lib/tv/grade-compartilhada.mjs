import {epgTimestamp} from '../wplay/ao-vivo/grade.mjs';

const HASH=/^[a-f0-9]{64}$/i,ID=/^\d{1,12}$/;
const currentList=(data,now)=>Array.isArray(data?.list)&&data.list.some(row=>{
  const start=epgTimestamp(row?.start),end=epgTimestamp(row?.end);
  return typeof row?.title==='string'&&row.title.trim()&&start!==null&&end!==null&&start<=now&&end>now;
});
const usableList=(data,now)=>Array.isArray(data?.list)&&data.list.some(row=>{
  const start=epgTimestamp(row?.start),end=epgTimestamp(row?.end);
  return typeof row?.title==='string'&&row.title.trim()&&start!==null&&end!==null&&end>start&&end>now;
});

// A cache expiry asks for a new snapshot; it does not end a programme. Only a
// row's own end time can retain an expired guide. Empty snapshots remain misses
// so the authenticated provider fallback can recover a missing channel.
export function usableSharedEPG(row,now=Date.now()){
  if(!usableList(row?.payload,now))return null;
  const expiresAt=Date.parse(row.expires_at);
  return Number.isFinite(expiresAt)&&(expiresAt>now||currentList(row.payload,now))?row.payload:null;
}

/** Shared metadata reads, batched by provider/scope rather than viewer. */
export class SharedLiveEPG {
  constructor({now=Date.now,maxEntries=256,readMs=5000,batchMs=8,batchSize=80}={}){
    Object.assign(this,{now,maxEntries,readMs,batchMs,batchSize});
    this.entries=new Map();this.batches=new Map();this.closed=false;
  }
  #prune(){
    for(const [key,entry] of this.entries)if(!entry.pending&&entry.expiresAt<=this.now()&&!currentList(entry.data,this.now()))this.entries.delete(key);
    while(this.entries.size>this.maxEntries)this.entries.delete(this.entries.keys().next().value);
  }
  async get({providerKey,scopeHash,id,read,current=()=>true,onStale=()=>{}}){
    if(this.closed||!HASH.test(providerKey||'')||!HASH.test(scopeHash||'')||!ID.test(String(id))||!current())return null;
    this.#prune();id=String(id);
    const scope=JSON.stringify([providerKey,scopeHash]),key=JSON.stringify([providerKey,scopeHash,id]),previous=this.entries.get(key);
    if(previous?.pending){
      if(currentList(previous.data,this.now()))return current()?previous.data:null;
      const value=await previous.promise;return current()?value:null;
    }
    if(previous?.expiresAt>this.now())return current()&&usableList(previous.data,this.now())?previous.data:null;
    const entry={scope,key,id,previous,data:previous?.data||null,pending:true,expiresAt:Infinity,read,current,onStale,promise:null,resolve:null};
    entry.promise=new Promise(resolve=>{entry.resolve=resolve;});this.entries.set(key,entry);this.#prune();
    let batch=this.batches.get(scope);
    if(!batch){
      batch={entries:[],timer:setTimeout(()=>{this.batches.delete(scope);void this.#read(batch);},this.batchMs)};
      batch.timer.unref?.();this.batches.set(scope,batch);
    }
    batch.entries.push(entry);
    // A warm, still-current guide can render immediately during revalidation.
    if(currentList(entry.data,this.now()))return current()?entry.data:null;
    const value=await entry.promise;return current()?value:null;
  }
  async #read(batch){
    for(let offset=0;offset<batch.entries.length;offset+=this.batchSize){
      const entries=batch.entries.slice(offset,offset+this.batchSize),owner=entries.find(entry=>entry.current());let rows=null;
      try{if(!this.closed&&owner)rows=await owner.read(entries.map(entry=>entry.id));}catch{/* Provider fallback handles a missing shared snapshot. */}
      const byID=new Map((Array.isArray(rows)?rows:[]).map(row=>[String(row?.channel_id),row]));
      for(const entry of entries){
        const row=byID.get(entry.id),now=this.now(),incoming=usableSharedEPG(row,now);
        entry.data=!this.closed?(incoming||(currentList(entry.previous?.data,now)?entry.previous.data:null)):null;
        entry.pending=false;entry.previous=null;entry.expiresAt=now+this.readMs;
        entry.resolve(entry.data);
        if(!this.closed&&entry.current()&&(!incoming||Date.parse(row.expires_at)<=now)){
          try{entry.onStale();}catch{/* Refresh scheduling cannot erase a guide. */}
        }
        entry.read=null;entry.current=null;entry.onStale=null;entry.resolve=null;
      }
    }
    this.#prune();
  }
  invalidate(providerKey,scopeHash){
    const scope=JSON.stringify([providerKey,scopeHash]);
    for(const entry of this.entries.values())if(entry.scope===scope&&!entry.pending)entry.expiresAt=0;
  }
  close(){
    this.closed=true;
    for(const batch of this.batches.values()){clearTimeout(batch.timer);for(const entry of batch.entries)entry.resolve(null);}
    for(const entry of this.entries.values())if(entry.pending)entry.resolve(null);
    this.batches.clear();this.entries.clear();
  }
}
