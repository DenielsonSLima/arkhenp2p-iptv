import {cloudItem,millis} from '../cloud-library-records.js';
import {movieID,movieScope,movieScopeKey} from './scope.js';
import {movieQueryKeys} from './tanstack-query.js';

const key=item=>'movie:'+String(item.id);

/** Updates the account's existing map once and delegates one write to its
 * bridge. Remote reconciliation never triggers another mutation. */
export class MoviesFavorites{
  constructor({supabase,getScope=()=>null,getLocalFavorites=()=>null,onLocalChange=()=>{},isVisible=()=>true,
    getQueryClient=()=>null,now=Date.now}={}){
    Object.assign(this,{supabase,getScope,getLocalFavorites,onLocalChange,isVisible,getQueryClient,now});
    this.scope=null;this.epoch=0;this.remote=null;this.pending=new Map();this.overrides=new Map();
  }
  #synchronize(){const scope=movieScope(this.getScope()),encoded=movieScopeKey(scope);if(encoded!==this.scope){this.reset();this.scope=encoded;}return scope;}
  snapshot(){
    const scope=this.#synchronize();if(!scope)return {ready:false,account:null,items:[],saving:false};
    const remote=this.remote||this.supabase?.snapshot(),records=new Map((remote?.favoriteRecords||[]).map(row=>[row.item_key,row]));
    const items=new Map((remote?.ready?remote.favorites:[]).map(item=>[key(item),item])),local=this.getLocalFavorites();
    for(const value of local instanceof Map?local.values():[]){
      if(!movieID(value)||value.libraryId&&value.libraryId!==scope.account)continue;
      const item=cloudItem(value),record=records.get(key(value));if(item&&(!record||millis(value.savedAt)>millis(record.updated_at)))items.set(key(value),{...item,savedAt:value.savedAt,libraryId:scope.account});
    }
    for(const [id,override] of this.overrides){if(override.active)items.set(id,override.item);else items.delete(id);}
    return {ready:remote?.ready===true,account:scope.account,items:[...items.values()].filter(this.isVisible),saving:this.pending.size>0};
  }
  #publish(){const value=this.snapshot(),scope=this.getScope();if(value.account)this.getQueryClient()?.setQueryData?.(movieQueryKeys.favorites(scope),value);return value;}
  has(item){const id=String(typeof item==='object'?item?.id:item);return this.snapshot().items.some(item=>String(item.id)===id);}
  reconcile(value){
    if(!this.#synchronize())return this.#publish();const snapshot=this.supabase?.snapshot(value);this.remote=snapshot?.ready?snapshot:null;
    for(const row of snapshot?.favoriteRecords||[]){
      const override=this.overrides.get(row.item_key);
      if(override&&millis(row.updated_at)>=override.updated&&!this.pending.has(row.item_key))this.overrides.delete(row.item_key);
    }
    return this.#publish();
  }
  async buscar(options){const scope=this.#synchronize(),epoch=this.epoch,key=this.scope;if(!scope)return this.#publish();const value=await this.supabase?.load(options);return epoch===this.epoch&&key===movieScopeKey(this.getScope())?this.reconcile(value):null;}
  async salvar(value,active=true){
    const scope=this.#synchronize(),item=movieID(value)?cloudItem(value):null;
    if(!scope||!item||value.libraryId&&value.libraryId!==scope.account)return {accepted:false,saved:false,queued:false};
    const entry={...item,libraryId:scope.account,savedAt:this.now()},id=key(item),epoch=this.epoch,encoded=this.scope,operation=Symbol(id);
    this.pending.set(id,operation);this.overrides.set(id,{item:entry,active:active===true,updated:entry.savedAt});
    const local=this.getLocalFavorites();if(local instanceof Map){if(active===true)local.set(id,entry);else local.delete(id);}
    this.#publish();try{this.onLocalChange({item:entry,active:active===true,account:scope.account});}catch{}
    let saved=false;try{saved=await this.supabase?.saveFavorite(entry,active===true)===true;}catch{/* Local map/outbox remain the write owners. */}
    if(epoch!==this.epoch||encoded!==movieScopeKey(this.getScope()))return {accepted:false,saved:false,queued:false};
    if(this.pending.get(id)===operation)this.pending.delete(id);
    const queued=this.supabase?.queued('user_favorites',item.id)===true;this.reconcile(this.supabase?.snapshot());
    return {accepted:true,active:active===true,saved:saved&&!queued,queued};
  }
  toggle(item){return this.salvar(item,!this.has(item));}
  reset(){this.epoch++;this.scope=null;this.remote=null;this.pending.clear();this.overrides.clear();}
}
