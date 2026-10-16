import {cloudItem} from '../cloud-library-records.js';

const scopeKey=scope=>scope?JSON.stringify([scope.url,scope.provider,scope.userId,scope.libraryId,scope.providerKey,scope.scopeHash]):null;
const empty=()=>({ready:false,libraryId:null,favorites:[],favoriteRecords:[]});

/** TV reuses the application library's validated Auth, RLS, outbox and socket.
 * This adapter never creates a Supabase client or stores provider credentials. */
export class TVSupabase{
  constructor({cloudLibrary,getSession=()=>null}={}){
    Object.assign(this,{cloudLibrary,getSession});this.epoch=0;this.listeners=new Set();this.unsubscribe=null;this.pending=null;
  }
  currentScope({allowOffline=false}={}){
    const session=this.getSession(),cloud=this.cloudLibrary,scope=cloud?.scope||(allowOffline?cloud?.offlineScope:null),account=session?.account?.libraryId;
    if(!session?.connected||!account||!scope||scope.libraryId!==account||!scope.userId||!scope.provider)return null;
    const expected=session.cloud;
    if(expected&&(expected.url&&expected.url.replace(/\/$/,'')!==scope.url||expected.provider&&expected.provider!==scope.provider||expected.userId&&expected.userId!==scope.userId||expected.providerKey&&expected.providerKey!==scope.providerKey||expected.scopeHash&&expected.scopeHash!==scope.scopeHash))return null;
    // Explicit allowlist: scope contains Auth/session material in its owner.
    return {url:scope.url,provider:scope.provider,userId:scope.userId,libraryId:account,providerKey:scope.providerKey,scopeHash:scope.scopeHash};
  }
  accepts(snapshot){
    const scope=this.currentScope();return Boolean(scope&&snapshot?.ready&&snapshot.userId===scope.userId&&snapshot.provider===scope.provider);
  }
  snapshot(value=this.cloudLibrary?.snapshot?.()){
    const scope=this.currentScope();if(!scope||!this.accepts(value))return empty();
    return {ready:true,libraryId:scope.libraryId,userId:scope.userId,provider:scope.provider,
      favorites:(value.favorites||[]).filter(item=>item?.kind==='live'&&(!item.libraryId||item.libraryId===scope.libraryId)),
      favoriteRecords:(value.favoriteRecords||[]).filter(row=>row?.item?.kind==='live'&&row.provider===scope.provider&&row.user_id===scope.userId)};
  }
  #emit(snapshot){for(const listener of [...this.listeners]){try{listener(snapshot);}catch{}}}
  subscribe(listener){
    this.listeners.add(listener);listener(this.snapshot());
    if(!this.unsubscribe&&typeof this.cloudLibrary?.subscribe==='function')this.unsubscribe=this.cloudLibrary.subscribe(value=>this.#emit(this.snapshot(value)));
    return()=>{this.listeners.delete(listener);if(!this.listeners.size){this.unsubscribe?.();this.unsubscribe=null;}};
  }
  async loadFavorites({force=false}={}){
    const scope=this.currentScope();if(!scope)return this.snapshot();
    if(!force&&this.cloudLibrary.ready)return this.snapshot();
    if(this.pending?.key===scopeKey(scope))return this.pending.promise;
    const ticket={key:scopeKey(scope),epoch:this.epoch,promise:null};this.pending=ticket;
    ticket.promise=Promise.resolve().then(()=>{
      if(ticket.epoch!==this.epoch||ticket.key!==scopeKey(this.currentScope()))return null;
      return this.cloudLibrary.load({force});
    }).then(()=>
      ticket.epoch===this.epoch&&ticket.key===scopeKey(this.currentScope())?this.snapshot():empty()
    ).finally(()=>{if(this.pending===ticket)this.pending=null;});return ticket.promise;
  }
  async saveFavorite(value,active=true){
    const scope=this.currentScope({allowOffline:true}),item=cloudItem(value);
    if(!scope||item?.kind!=='live'||value.libraryId&&value.libraryId!==scope.libraryId)return false;
    const epoch=this.epoch,key=scopeKey(scope);
    const saved=await this.cloudLibrary.saveFavorite({...item,libraryId:scope.libraryId},active===true);
    return epoch===this.epoch&&key===scopeKey(this.currentScope({allowOffline:true}))?Boolean(saved):false;
  }
  isFavoriteQueued(value){
    const scope=this.currentScope({allowOffline:true}),item=cloudItem(value);
    if(!scope||item?.kind!=='live'||value.libraryId&&value.libraryId!==scope.libraryId)return false;
    return Boolean(this.cloudLibrary.outbox?.entries?.().some(({table,row})=>table==='user_favorites'&&
      row?.item_key==='live:'+item.id&&row.user_id===scope.userId&&row.provider===scope.provider));
  }
  reset(){this.epoch++;this.pending=null;this.#emit(empty());}
  dispose(){this.reset();this.unsubscribe?.();this.unsubscribe=null;this.listeners.clear();}
}
