import {cloudItem,millis} from '../../cloud-library-records.js';
import {tvQueryKeys} from '../tanstack-query.js';
import {tvScopeKey} from '../scope.js';

const key=item=>'live:'+String(item.id);
const scopeKey=tvScopeKey;
const liveItem=value=>value?.kind==='live'&&/^\d{1,12}$/.test(String(value.id??''))?cloudItem(value):null;

/** Private live favourites are a projection of CloudLibrary, including its
 * existing outbox. The local map remains the application's account-owned map,
 * so TV never migrates or overwrites movie/series favourites. */
export class TVFavorites{
  constructor({supabase,getScope=()=>null,getLocalFavorites=()=>null,onLocalChange=()=>{},onChange=()=>{},
    getQueryClient=()=>null,isVisible=()=>true,now=Date.now}={}){
    Object.assign(this,{supabase,getScope,getLocalFavorites,onLocalChange,onChange,getQueryClient,isVisible,now});
    this.scope=null;this.epoch=0;this.remote=null;this.overrides=new Map();this.listeners=new Set();this.unsubscribe=null;this.pending=new Map();
    this.state={account:null,ready:false,items:[],saving:false};
  }
  #synchronize(){
    const scope=this.getScope(),encoded=scopeKey(scope);
    if(encoded!==this.scope){this.epoch++;this.scope=encoded;this.remote=null;this.overrides.clear();this.pending.clear();this.state={account:scope?.account||null,ready:false,items:[],saving:false};}
    return scope?.account?scope:null;
  }
  #localValues(){const local=this.getLocalFavorites();return local instanceof Map?[...local.values()]:Array.isArray(local)?local:[];}
  #project(){
    const scope=this.#synchronize();if(!scope)return {...this.state,items:[],ready:false};
    const remote=this.remote||this.supabase?.snapshot(),records=new Map((remote?.favoriteRecords||[]).map(row=>[row.item_key,row]));
    const items=new Map((remote?.ready?remote.favorites:[]).filter(item=>item?.kind==='live').map(item=>[key(item),item]));
    for(const value of this.#localValues()){
      if(value?.kind!=='live'||value.libraryId&&value.libraryId!==scope.account)continue;
      const item=liveItem(value);if(!item)continue;const id=key(item),record=records.get(id);
      if(!record||millis(value.savedAt)>millis(record.updated_at))items.set(id,{...item,savedAt:value.savedAt,libraryId:scope.account});
    }
    for(const [id,override] of this.overrides){if(override.active)items.set(id,override.item);else items.delete(id);}
    return {account:scope.account,ready:remote?.ready===true,items:[...items.values()].filter(this.isVisible),saving:this.pending.size>0};
  }
  #publish(){
    this.state=this.#project();const scope=this.getScope();
    if(scope?.account)this.getQueryClient()?.setQueryData?.(tvQueryKeys.favorites(scope),this.state);
    try{this.onChange(this.state);}catch{}
    for(const listener of [...this.listeners]){try{listener(this.state);}catch{}}
    return this.state;
  }
  snapshot(){return this.#project();}
  has(value){const id=String(typeof value==='object'?value?.id:value);return this.snapshot().items.some(item=>String(item.id)===id);}
  subscribe(listener){
    this.listeners.add(listener);listener(this.#project());
    if(!this.unsubscribe&&this.supabase?.subscribe)this.unsubscribe=this.supabase.subscribe(snapshot=>this.reconcile(snapshot));
    return()=>{this.listeners.delete(listener);if(!this.listeners.size){this.unsubscribe?.();this.unsubscribe=null;}};
  }
  reconcile(value){
    const scope=this.#synchronize();if(!scope)return this.#publish();
    const snapshot=this.supabase?.snapshot(value);
    if(!snapshot?.ready||snapshot.libraryId!==scope.account){this.remote=null;return this.#publish();}
    this.remote=snapshot;const records=new Map(snapshot.favoriteRecords.map(row=>[row.item_key,row]));
    for(const [id,override] of this.overrides){
      const record=records.get(id),updated=millis(record?.updated_at);
      if(record&&updated>=override.updated&&(!this.pending.has(id)||Boolean(!record.deleted_at)===override.active))this.overrides.delete(id);
    }
    return this.#publish();
  }
  async buscar({force=false}={}){
    const scope=this.#synchronize();if(!scope)return this.#publish();
    const epoch=this.epoch,encoded=this.scope,snapshot=await this.supabase?.loadFavorites({force});
    return epoch===this.epoch&&scopeKey(this.getScope())===encoded?this.reconcile(snapshot):null;
  }
  async salvar(value,active=true){
    active=active===true;
    const scope=this.#synchronize(),item=liveItem(value);
    if(!scope||!item||value.libraryId&&value.libraryId!==scope.account)return {accepted:false,saved:false,queued:false};
    const id=key(item),updated=this.now(),entry={...item,libraryId:scope.account,savedAt:updated},epoch=this.epoch,encoded=this.scope;
    const operation=Symbol(id);this.pending.set(id,operation);this.overrides.set(id,{active:active===true,item:entry,updated});
    const local=this.getLocalFavorites();if(local instanceof Map){if(active)local.set(id,entry);else local.delete(id);}
    this.#publish();
    try{this.onLocalChange({item:entry,active:active===true,account:scope.account});}catch{}
    let saved=false;
    try{saved=await this.supabase?.saveFavorite(entry,active===true)===true;}catch{/* The existing outbox/local map owns offline recovery. */}
    if(epoch!==this.epoch||scopeKey(this.getScope())!==encoded)return {accepted:false,saved:false,queued:false};
    if(this.pending.get(id)===operation)this.pending.delete(id);
    const queued=this.supabase?.isFavoriteQueued?.(entry)===true;
    this.reconcile(this.supabase?.snapshot());return {accepted:true,active,saved:saved&&!queued,queued};
  }
  toggle(item){return this.salvar(item,!this.has(item));}
  invalidate(){
    const scope=this.#synchronize();if(scope)void this.getQueryClient()?.invalidateQueries?.({queryKey:tvQueryKeys.favorites(scope),refetchType:'none'})?.catch?.(()=>{});
    return this.#publish();
  }
  reset(){this.epoch++;this.scope=null;this.remote=null;this.overrides.clear();this.pending.clear();this.state={account:null,ready:false,items:[],saving:false};}
  dispose(){this.reset();this.unsubscribe?.();this.unsubscribe=null;this.listeners.clear();}
}
