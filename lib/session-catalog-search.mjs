import {searchLocalCatalog} from './local-catalog-search.mjs';

/** Session-only snapshots: a failed RPC must not discard metadata already sent. */
export class SessionCatalogSearch{
  constructor(){this.snapshots=new WeakMap();}
  remember(client,type,data){
    if(!client||!Array.isArray(data?.items)||!Array.isArray(data.categories))return;
    let records=this.snapshots.get(client);if(!records){records=new Map();this.snapshots.set(client,records);}
    const previous=records.get(type),complete=data.catalogComplete===true||!data.pagination&&data.catalogComplete!==false&&data.preparing!==true;
    if(complete){records.set(type,{...data,catalogComplete:true});return;}
    if(previous?.catalogComplete===true)return;
    const items=new Map((previous?.items||[]).map(item=>[String(item.id),item])),categories=new Map((previous?.categories||[]).map(item=>[String(item.id),item]));
    for(const item of data.items)items.set(String(item.id),item);
    for(const item of data.categories)categories.set(String(item.id),item);
    records.set(type,{...data,items:[...items.values()],categories:[...categories.values()],catalogComplete:false});
  }
  metadataSnapshot(client,type){
    if(!client||!['live','movies','series'].includes(type))return null;
    const saved=this.snapshots.get(client)?.get(type);if(saved)return saved;
    // Native snapshots are synchronous projections of pages already in RAM.
    // Do not await cache promises: they may still be downloading VOD metadata.
    if(type!=='live'&&client.nativeVOD?.items?.[type]?.size&&typeof client.nativeVOD.snapshot==='function'){
      const data=client.nativeVOD.snapshot(type);
      if(Array.isArray(data?.items)&&Array.isArray(data.categories))return data;
    }
    return null;
  }
  search(state,request,{signal}={}){
    const client=state.client;
    return searchLocalCatalog(request,{includeAdult:state.parental?.unlocked===true,signal,getCatalog:async(type,{allowLoad})=>{
      const saved=this.snapshots.get(client)?.get(type);if(saved)return saved;
      if(type!=='live'&&client.nativeVOD?.items?.[type]?.size)return client.nativeVOD.snapshot(type);
      const cached=client.cache?.get('catalog:'+type);
      if(cached?.promise)return cached.promise;
      if(!allowLoad)return null;
      const data=await client.catalog('live');this.remember(client,'live',data);return this.snapshots.get(client)?.get('live')||data;
    }});
  }
}
