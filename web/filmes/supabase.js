import {cloudItem,cloudProgress} from '../cloud-library-records.js';

const scopeKey=scope=>scope?JSON.stringify([scope.url,scope.provider,scope.userId,scope.libraryId,scope.providerKey,scope.scopeHash]):null;
const empty=()=>({ready:false,libraryId:null,favorites:[],favoriteRecords:[],history:[],progressRecords:[]});

/** Movie-only view of the single authenticated library. Writes go through
 * the injected application bridge, which owns applying/outbox safeguards. */
export class MoviesSupabase{
  constructor({cloudLibrary,getSession=()=>null,saveFavorite,saveProgress}={}){
    Object.assign(this,{cloudLibrary,getSession,writeFavorite:saveFavorite,writeProgress:saveProgress});
    this.epoch=0;this.pending=null;this.listeners=new Set();this.unsubscribe=null;
  }
  currentScope({allowOffline=false}={}){
    const session=this.getSession(),cloud=this.cloudLibrary,scope=cloud?.scope||(allowOffline?cloud?.offlineScope:null),account=session?.account?.libraryId;
    if(!session?.connected||!account||!scope||scope.libraryId!==account||!scope.userId||!scope.provider)return null;
    const expected=session.cloud;
    if(expected&&(expected.url&&expected.url.replace(/\/$/,'')!==scope.url||expected.provider&&expected.provider!==scope.provider||expected.userId&&expected.userId!==scope.userId||expected.providerKey&&expected.providerKey!==scope.providerKey||expected.scopeHash&&expected.scopeHash!==scope.scopeHash))return null;
    return {url:scope.url,provider:scope.provider,userId:scope.userId,libraryId:account,providerKey:scope.providerKey,scopeHash:scope.scopeHash};
  }
  snapshot(value=this.cloudLibrary?.snapshot?.()){
    const scope=this.currentScope();if(!scope||!value?.ready||value.userId!==scope.userId||value.provider!==scope.provider)return empty();
    const owns=item=>item?.kind==='movie'&&(!item.libraryId||item.libraryId===scope.libraryId);
    const ownsRow=row=>row?.user_id===scope.userId&&row.provider===scope.provider;
    return {ready:true,...scope,
      favorites:(value.favorites||[]).filter(owns),history:(value.history||[]).filter(entry=>owns(entry.item)&&(!entry.libraryId||entry.libraryId===scope.libraryId)),
      favoriteRecords:(value.favoriteRecords||[]).filter(row=>ownsRow(row)&&row.item?.kind==='movie'),
      progressRecords:(value.progressRecords||[]).filter(row=>ownsRow(row)&&row.entry?.item?.kind==='movie')};
  }
  subscribe(listener){
    this.listeners.add(listener);listener(this.snapshot());
    if(!this.unsubscribe&&this.cloudLibrary?.subscribe)this.unsubscribe=this.cloudLibrary.subscribe(value=>{
      const snapshot=this.snapshot(value);for(const listener of [...this.listeners]){try{listener(snapshot);}catch{}}
    });
    return()=>{this.listeners.delete(listener);if(!this.listeners.size){this.unsubscribe?.();this.unsubscribe=null;}};
  }
  async load({force=false}={}){
    const scope=this.currentScope();if(!scope||!force&&this.cloudLibrary?.ready)return this.snapshot();
    const key=scopeKey(scope);if(this.pending?.key===key)return this.pending.promise;
    const ticket={key,epoch:this.epoch,promise:null};this.pending=ticket;
    ticket.promise=Promise.resolve().then(()=>ticket.epoch===this.epoch&&key===scopeKey(this.currentScope())?this.cloudLibrary.load({force}):null)
      .then(()=>ticket.epoch===this.epoch&&key===scopeKey(this.currentScope())?this.snapshot():empty())
      .finally(()=>{if(this.pending===ticket)this.pending=null;});return ticket.promise;
  }
  async saveFavorite(value,active=true){
    const session=this.getSession(),account=session?.connected?session.account?.libraryId:null,item=cloudItem(value);
    if(!account||item?.kind!=='movie'||value.libraryId&&value.libraryId!==account||typeof this.writeFavorite!=='function')return false;
    const epoch=this.epoch,saved=await this.writeFavorite({...item,libraryId:account},active===true);
    return epoch===this.epoch&&this.getSession()?.connected&&this.getSession()?.account?.libraryId===account?saved===true:false;
  }
  async saveProgress(value,options={}){
    const session=this.getSession(),account=session?.connected?session.account?.libraryId:null,entry=cloudProgress(value);
    if(!account||entry?.item.kind!=='movie'||value.libraryId&&value.libraryId!==account||typeof this.writeProgress!=='function')return false;
    const epoch=this.epoch,saved=await this.writeProgress({...entry,libraryId:account},options);
    return epoch===this.epoch&&this.getSession()?.connected&&this.getSession()?.account?.libraryId===account?saved===true:false;
  }
  queued(table,id){
    const scope=this.currentScope({allowOffline:true});if(!scope)return false;
    return Boolean(this.cloudLibrary?.outbox?.entries?.().some(entry=>entry.table===table&&entry.row?.item_key==='movie:'+id&&entry.row.user_id===scope.userId&&entry.row.provider===scope.provider));
  }
  reset(){this.epoch++;this.pending=null;}
  dispose(){this.reset();this.unsubscribe?.();this.unsubscribe=null;this.listeners.clear();}
}
