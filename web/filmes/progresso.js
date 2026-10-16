import {cloudProgress,millis} from '../cloud-library-records.js';
import {isAdultItem} from '../parental-classification.js';
import {movieID,movieScope,movieScopeKey} from './scope.js';
import {movieQueryKeys} from './tanstack-query.js';

/** Measured movie progress only. The existing map/MediaLibrary and bridge
 * remain authoritative for local persistence and the single cloud outbox. */
export class MoviesProgress{
  constructor({supabase,getScope=()=>null,getLocalHistory=()=>null,canRemember=()=>true,
    onLocalChange=()=>{},getQueryClient=()=>null}={}){
    Object.assign(this,{supabase,getScope,getLocalHistory,canRemember,onLocalChange,getQueryClient});
    this.scope=null;this.epoch=0;this.remote=null;
  }
  #synchronize(){const scope=movieScope(this.getScope()),encoded=movieScopeKey(scope);if(encoded!==this.scope){this.reset();this.scope=encoded;}return scope;}
  read(item){
    const scope=this.#synchronize(),id=movieID(item);if(!scope||!id||!this.canRemember(item)||isAdultItem(item))return null;
    const local=this.getLocalHistory()?.get?.('movie:'+id),remote=(this.remote||this.supabase?.snapshot())?.history?.find(entry=>String(entry.item.id)===id);
    const valid=entry=>entry?.item?.kind==='movie'&&String(entry.item.id)===id&&(!entry.libraryId||entry.libraryId===scope.account)&&!isAdultItem(entry)&&this.canRemember(entry.item);
    return [local,remote].filter(valid).sort((a,b)=>millis(b.updated)-millis(a.updated))[0]||null;
  }
  reconcile(value){
    const scope=this.#synchronize();if(!scope)return null;const snapshot=this.supabase?.snapshot(value);this.remote=snapshot?.ready?snapshot:null;
    const history=(snapshot?.history||[]).filter(entry=>this.canRemember(entry.item));
    this.getQueryClient()?.setQueryData?.(movieQueryKeys.progress(scope),{ready:snapshot?.ready===true,account:scope.account,history});return history;
  }
  async salvar(value,{force=false}={}){
    const scope=this.#synchronize(),entry=cloudProgress(value,{canRemember:this.canRemember});
    if(!scope||entry?.item.kind!=='movie'||value.libraryId&&value.libraryId!==scope.account)return {accepted:false,saved:false,queued:false};
    const epoch=this.epoch,key=this.scope,record={...entry,libraryId:scope.account};
    this.getLocalHistory()?.set?.('movie:'+entry.item.id,record);
    try{this.onLocalChange(record);}catch{}
    let saved=false;try{saved=await this.supabase?.saveProgress(record,{force})===true;}catch{/* The bridge preserves its local/outbox recovery. */}
    if(epoch!==this.epoch||key!==movieScopeKey(this.getScope()))return {accepted:false,saved:false,queued:false};
    const queued=this.supabase?.queued('user_progress',entry.item.id)===true;
    this.reconcile(this.supabase?.snapshot());return {accepted:true,saved:saved&&!queued,queued};
  }
  reset(){this.epoch++;this.scope=null;this.remote=null;}
}
