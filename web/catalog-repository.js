import {CATALOG_CACHE_TTL_MS} from './catalog-cache.js';
import {withRequestSignals} from './request-signals.js';

export const CATALOG_TYPES=Object.freeze(['movies','series','live']);
export const catalogIsComplete=data=>data?.catalogComplete===true&&data.preparing!==true&&data.pagination?.preparing!==true&&data.pagination?.complete!==false;
export function catalogQueryKey(scope){return ['arkhen-catalog',scope.project,scope.providerKey,scope.scopeHash,scope.type,scope.includeAdult];}
const keyOf=scope=>JSON.stringify(catalogQueryKey(scope));
const stamp=data=>Date.parse(data?.pagination?.revisionAt)||0;
const revision=data=>data?.pagination?.snapshotId||'';
const cancelled=()=>new DOMException('Carregamento cancelado.','AbortError');

/** Global metadata only. Account epochs govern in-flight work; account IDs,
 * favorites and progress never enter these shared query/cache keys. */
export class CatalogRepository{
  constructor({getScope,getAccountEpoch=()=>0,prepare=value=>value,onCommit=()=>{},onScopeChange=()=>{},loadQueryCore=()=>import('/assets/vendor/cloud-client.js')}={}){
    Object.assign(this,{getScope,getAccountEpoch,prepare,onCommit,onScopeChange,loadQueryCore});this.entries=new Map();this.acceptedResponses=new WeakMap();this.epoch=0;this.queryClient=null;this.queryPending=null;
  }
  #entry(type){
    if(!CATALOG_TYPES.includes(type))throw new Error('INVALID_CATALOG_TYPE');
    const scope=this.getScope(type),key=keyOf(scope),old=this.entries.get(type);
    if(old?.key===key)return old;
    old?.request?.controller.abort();
    if(old)this.onScopeChange(type);
    const entry={type,key,scope,epoch:0,complete:null,preview:null,current:null,savedAt:0,error:null,loading:false,request:null};this.entries.set(type,entry);return entry;
  }
  state(type){return this.#entry(type);}
  begin(type){
    const entry=this.#entry(type);entry.request?.controller.abort();
    const ticket={type,key:entry.key,epoch:++entry.epoch,repositoryEpoch:this.epoch,accountEpoch:this.getAccountEpoch(),controller:new AbortController()};
    entry.request=ticket;entry.loading=true;entry.error=null;return ticket;
  }
  current(ticket){const entry=this.#entry(ticket.type);return this.epoch===ticket.repositoryEpoch&&this.getAccountEpoch()===ticket.accountEpoch&&entry.key===ticket.key&&entry.epoch===ticket.epoch&&!ticket.controller.signal.aborted;}
  finish(ticket,error=null){if(!this.current(ticket))return false;const entry=this.#entry(ticket.type);entry.loading=false;entry.error=error;entry.request=null;return true;}
  commit(type,incoming,{ticket,savedAt=0}={}){
    if(incoming&&typeof incoming==='object')this.acceptedResponses.delete(incoming);
    if(ticket&&!this.current(ticket))return null;
    const entry=this.#entry(type),complete=catalogIsComplete(incoming),previous=entry.current;
    if(!Array.isArray(incoming?.items)||!Array.isArray(incoming.categories)||incoming.media_type&&incoming.media_type!==type||incoming.items.some(item=>item.kind&&item.kind!==(type==='movies'?'movie':type)))return entry.current;
    const target=complete?entry.complete:entry.preview;
    // Empty/transient previews cannot remove titles already visible in the same
    // revision. A published complete snapshot may authoritatively remove them.
    if(target&&(stamp(target)>0&&(!stamp(incoming)||stamp(target)>stamp(incoming))||complete&&revision(target)&&!revision(incoming)&&!stamp(incoming)||!complete&&revision(target)===revision(incoming)&&incoming.items?.length<target.items?.length))return entry.current;
    if(complete&&entry.complete&&revision(incoming)&&revision(incoming)===revision(entry.complete)&&stamp(incoming)===stamp(entry.complete)){
      // A daily snapshot already on disk may predate its server-prepared browse
      // projection. Enrich that same publication without renewing its age.
      if(incoming.readModel&&!entry.complete.readModel){const data=this.prepare(incoming,type);if(data.readModel){entry.complete=data;entry.current=data;this.onCommit(type,data);}}
      if(savedAt)entry.savedAt=savedAt;this.acceptedResponses.set(incoming,entry.current);return entry.current;
    }
    if(!complete&&target){
      const items=new Map(target.items.map(item=>[String(item.id),item]));for(const item of incoming.items)items.set(String(item.id),item);
      const categories=new Map((target.sourceCategories||target.categories).map(item=>[String(item.id),item]));for(const item of incoming.categories)categories.set(String(item.id),item);
      incoming={...incoming,categories:[...categories.values()],items:[...items.values()]};
    }
    const data=this.prepare(incoming,type);
    if(complete){entry.complete=data;entry.current=data;if(savedAt)entry.savedAt=savedAt;}
    else{entry.preview=data;entry.current=entry.complete||data;}
    if(complete)this.acceptedResponses.set(incoming,entry.current);
    if(entry.current!==previous)this.onCommit(type,entry.current);
    return entry.current;
  }
  acceptedResponse(type,response){return !!response&&this.acceptedResponses.get(response)===this.#entry(type).current;}
  async #queries(){
    if(this.queryClient)return this.queryClient;
    if(!this.queryPending)this.queryPending=Promise.resolve().then(()=>this.loadQueryCore()).then(({QueryClient})=>{
      const client=new QueryClient({defaultOptions:{queries:{retry:0,staleTime:CATALOG_CACHE_TTL_MS,gcTime:CATALOG_CACHE_TTL_MS,refetchOnWindowFocus:false,structuralSharing:false}}});client.mount();this.queryClient=client;return client;
    }).catch(()=>null);
    return this.queryPending;
  }
  async fetch(ticket,queryFn,{force=false}={}){
    const client=await this.#queries();if(!this.current(ticket))throw cancelled();
    const scope=this.#entry(ticket.type).scope,queryKey=catalogQueryKey(scope);
    if(force&&client)await client.cancelQueries({queryKey,exact:true});
    if(!this.current(ticket))throw cancelled();
    const run=({signal}={})=>withRequestSignals([signal,ticket.controller.signal],signal=>queryFn({signal}));
    // Query Core deduplicates metadata reads. Incomplete previews deliberately
    // remain stale, so a later publication can be read without waiting a day.
    const value=client?await client.fetchQuery({queryKey,queryFn:run,staleTime:force||!catalogIsComplete(client.getQueryData(queryKey))?0:CATALOG_CACHE_TTL_MS}):await run();
    if(!this.current(ticket))throw cancelled();return value;
  }
  reset(){this.epoch++;for(const entry of this.entries.values())entry.request?.controller.abort();this.entries.clear();this.acceptedResponses=new WeakMap();void this.queryClient?.cancelQueries();this.queryClient?.clear();}
}
