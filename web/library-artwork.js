import {artworkURL} from './channel-artwork.js';
import {isAdultItem} from './parental-classification.js';

const key=item=>`${item.kind}:${item.id}`;
const valid=(item,account)=>item&&['movie','series'].includes(item.kind)&&/^\d{1,12}$/.test(String(item.id))&&
  (!item.libraryId||item.libraryId===account)&&!isAdultItem(item);
const transient=error=>error?.name==='AbortError'||!error?.status||[408,425,429,500,502,503,504].includes(error.status);

/** Recover artwork for a bounded, caller-selected library window. This reads
 * one title's details without probing duration or enumerating a VOD catalog.
 * Scope must include account, connection epoch and visibility/parental filters.
 * Results remain in memory: session image handles never become saved artwork. */
export class LibraryArtworkHydrator {
  constructor({request,getScope,getItems=()=>[],prepare=value=>value,onResult=()=>{},now=Date.now,
    concurrency=2,maxEntries=64,maxItems=30,timeoutMs=8000,retryMs=30000,maxRetries=3}={}) {
    Object.assign(this,{request,getScope,getItems,prepare,onResult,now,timeoutMs,retryMs,maxRetries});
    this.concurrency=Math.max(1,Math.min(3,concurrency));this.maxEntries=Math.max(8,Math.min(128,maxEntries));this.maxItems=Math.max(1,Math.min(96,maxItems));
    this.entries=new Map();this.failedSources=new Map();this.queue=[];this.active=0;this.epoch=0;this.scope=null;this.timer=null;this.disposed=false;this.cloudRecoveryEvents=new WeakSet();
  }
  reset() {
    this.epoch++;clearTimeout(this.timer);this.timer=null;
    for(const entry of this.entries.values())entry.controller?.abort();
    this.entries.clear();this.failedSources.clear();this.queue=[];this.scope=null;this.cloudRecoveryEvents=new WeakSet();
  }
  context() {
    if(this.disposed)return null;
    const scope=this.getScope();
    if(!scope?.account){if(this.scope!==null)this.reset();return null;}
    const encoded=JSON.stringify(scope);
    if(this.scope!==encoded){this.reset();this.scope=encoded;}
    return {scope,encoded};
  }
  items(account) {
    const items=this.getItems(),seen=new Set(),result=[];
    for(const item of Array.isArray(items)?items:[]){
      if(!valid(item,account)||seen.has(key(item)))continue;
      const poster=artworkURL(item.poster);
      if(poster&&!this.failedSources.get(key(item))?.has(poster))continue;
      seen.add(key(item));result.push(item);if(result.length>=this.maxItems)break;
    }
    return result;
  }
  get(item) {
    const context=this.context();
    return context&&valid(item,context.scope.account)?this.entries.get(key(item))?.data||null:null;
  }
  failSource(item,source) {
    const context=this.context(),url=artworkURL(source);
    if(!context||!valid(item,context.scope.account)||!url)return false;
    const id=key(item),entry=this.entries.get(id),items=this.getItems();
    const visible=Array.isArray(items)&&items.find(value=>valid(value,context.scope.account)&&key(value)===id);
    if(!visible||!['poster','posterOriginal','backdrop'].some(field=>artworkURL(visible[field])===url||entry?.data?.[field]===url))return false;
    let failed=this.failedSources.get(id);
    // Image error events can repeat after every render. They must neither
    // restart a budget nor keep collecting an unbounded list of bad origins.
    if(failed?.has(url)||failed?.size>=3)return false;
    if(!failed){failed=new Set();this.failedSources.set(id,failed);}failed.add(url);
    if(entry){
      entry.lastFailureTransient=true;
      if(entry.data&&['poster','posterOriginal','backdrop'].some(field=>entry.data[field]===url)){
        entry.data=null;entry.attempts++;
        entry.retryAt=this.now()+Math.min(300000,this.retryMs*2**Math.min(entry.attempts-1,4));
      }
      if(failed.size>=3||entry.attempts>this.maxRetries)entry.blocked=true;
    }
    this.prune();this.ensure();return true;
  }
  ensure() {
    const context=this.context();if(!context)return;
    const selected=this.items(context.scope.account),wanted=new Set(selected.map(key));
    for(const entry of this.entries.values())if(!wanted.has(entry.key)&&!entry.data){entry.queued=false;entry.controller?.abort();}
    this.queue=this.queue.filter(entry=>entry.queued&&wanted.has(entry.key));
    for(const item of selected){
      const id=key(item);let entry=this.entries.get(id);
      if(!entry){entry={key:id,item,data:null,queued:false,loading:false,attempts:0,retryAt:0,blocked:false,lastFailureTransient:false,controller:null};this.entries.set(id,entry);}
      if(entry.data||entry.loading||entry.queued||entry.blocked||this.failedSources.get(id)?.size>=3||entry.retryAt>this.now())continue;
      entry.item=item;entry.queued=true;this.queue.push(entry);
    }
    this.prune();this.drain();this.scheduleRetry();
  }
  retry(item) {
    const context=this.context();if(!context||!valid(item,context.scope.account))return;
    const entry=this.entries.get(key(item));
    if(entry&&!entry.loading){entry.attempts=0;entry.retryAt=0;entry.blocked=false;}
    this.ensure();
  }
  /** Call only for a transition to synced, with that status event as token.
   * A repeated event cannot renew image/detail budgets from a render loop. */
  recoverCloud(event){
    const context=this.context();
    if(!context||!event||typeof event!=='object'||event.state!=='synced'||this.cloudRecoveryEvents.has(event))return false;
    this.cloudRecoveryEvents.add(event);
    for(const [id,entry]of this.entries){
      if(!entry.lastFailureTransient||entry.loading)continue;
      this.failedSources.delete(id);entry.attempts=0;entry.retryAt=0;entry.blocked=false;entry.lastFailureTransient=false;
    }
    this.ensure();return true;
  }
  prune() {
    for(const [id,entry] of this.entries){
      if(this.entries.size<=this.maxEntries)break;
      if(!entry.loading&&!entry.queued)this.entries.delete(id);
    }
    while(this.failedSources.size>this.maxEntries)this.failedSources.delete(this.failedSources.keys().next().value);
  }
  drain() {
    while(this.active<this.concurrency&&this.queue.length){
      const entry=this.queue.shift();if(!entry.queued||this.entries.get(entry.key)!==entry)continue;
      entry.queued=false;entry.loading=true;this.active++;
      void this.load(entry).catch(()=>{}).finally(()=>{entry.loading=false;this.active--;this.prune();this.ensure();});
    }
  }
  async load(entry) {
    const epoch=this.epoch,scope=this.scope,controller=new AbortController();entry.controller=controller;
    const current=()=>!this.disposed&&this.epoch===epoch&&this.scope===scope&&JSON.stringify(this.getScope())===scope&&this.entries.get(entry.key)===entry&&!controller.signal.aborted;
    const timer=setTimeout(()=>controller.abort(),this.timeoutMs);
    try{
      const raw=await this.request(`/api/details?type=${entry.item.kind}&id=${encodeURIComponent(entry.item.id)}&artwork=1`,{signal:controller.signal});
      if(!current())return;
      const value=await this.prepare(raw,entry.item);if(!current())return;
      const context=JSON.parse(scope);
      if(value?.kind!==entry.item.kind||String(value?.id)!==String(entry.item.id)||value.libraryId&&value.libraryId!==context.account||isAdultItem(value)||!artworkURL(value.poster))throw Object.assign(new Error('ARTWORK_RESPONSE_UNAVAILABLE'),{status:404});
      if(this.failedSources.get(entry.key)?.has(artworkURL(value.poster)))throw Object.assign(new Error('ARTWORK_SOURCE_RETRY_REQUIRED'),{status:503});
      if(!this.items(context.account).some(item=>key(item)===entry.key))return;
      entry.data={id:String(value.id),kind:value.kind,poster:artworkURL(value.poster)};
      for(const field of ['posterOriginal','backdrop'])if(artworkURL(value[field]))entry.data[field]=artworkURL(value[field]);
      if(!this.failedSources.has(entry.key))entry.attempts=0;entry.retryAt=0;
      entry.lastFailureTransient=false;
      try{this.onResult(entry.item,entry.data,context);}catch{/* A rendering callback cannot invalidate recovered metadata. */}
    }catch(error){
      // A timeout may retry; cancellation caused by account/window changes may
      // not schedule work for the retired scope or title.
      const sameScope=!this.disposed&&this.epoch===epoch&&this.scope===scope&&JSON.stringify(this.getScope())===scope&&this.entries.get(entry.key)===entry;
      if(sameScope&&(!controller.signal.aborted||this.items(JSON.parse(scope).account).some(item=>key(item)===entry.key))){
        entry.attempts++;
        entry.lastFailureTransient=transient(error);
        entry.blocked=!entry.lastFailureTransient||entry.attempts>this.maxRetries;
        entry.retryAt=this.now()+Math.min(300000,this.retryMs*2**Math.min(entry.attempts-1,4));
      }
    }finally{clearTimeout(timer);if(entry.controller===controller)entry.controller=null;}
  }
  scheduleRetry() {
    clearTimeout(this.timer);this.timer=null;if(this.disposed||!this.scope)return;
    const context=this.getScope();if(JSON.stringify(context)!==this.scope)return;
    const wanted=new Set(this.items(context.account).map(key));let next=Infinity;
    for(const entry of this.entries.values())if(wanted.has(entry.key)&&!entry.data&&!entry.loading&&!entry.queued&&!entry.blocked&&entry.retryAt>this.now())next=Math.min(next,entry.retryAt);
    if(Number.isFinite(next))this.timer=setTimeout(()=>{this.timer=null;this.ensure();},Math.max(0,next-this.now()));
  }
  dispose(){this.disposed=true;this.reset();}
}
