import {isAdultItem} from '../parental-classification.js';

const empty=()=>({ready:false,libraryId:null,favorites:[],favoriteRecords:[],history:[],episodes:[],progressRecords:[]});

/** Typed read projection of the sole authenticated CloudLibrary. It owns no
 * Auth client, socket, outbox, persistence or episode-progress store. */
export class SeriesSupabase{
  constructor({cloudLibrary,getSession=()=>null,isVisible=()=>true,canRemember=()=>true}={}){Object.assign(this,{cloudLibrary,getSession,isVisible,canRemember});}
  currentScope(){
    const session=this.getSession(),scope=this.cloudLibrary?.scope,account=session?.account?.libraryId;
    if(!session?.connected||!account||!scope||scope.libraryId!==account||!scope.userId||!scope.provider)return null;
    const expected=session.cloud;
    if(expected&&(expected.url&&expected.url.replace(/\/$/,'')!==scope.url||expected.provider&&expected.provider!==scope.provider||expected.userId&&expected.userId!==scope.userId||expected.providerKey&&expected.providerKey!==scope.providerKey||expected.scopeHash&&expected.scopeHash!==scope.scopeHash))return null;
    return {url:scope.url,provider:scope.provider,userId:scope.userId,libraryId:account,providerKey:scope.providerKey,scopeHash:scope.scopeHash};
  }
  snapshot(value=this.cloudLibrary?.snapshot?.()){
    const scope=this.currentScope();if(!scope||!value?.ready||value.userId!==scope.userId||value.provider!==scope.provider)return empty();
    const owns=item=>item?.kind==='series'&&(!item.libraryId||item.libraryId===scope.libraryId);
    const visible=item=>owns(item)&&this.isVisible(item);
    const ownsRow=row=>row?.user_id===scope.userId&&row.provider===scope.provider;
    const remembered=entry=>visible(entry?.item)&&(!entry.libraryId||entry.libraryId===scope.libraryId)&&!isAdultItem(entry)&&!isAdultItem(entry.episode)&&!isAdultItem(entry.item)&&this.canRemember(entry.item);
    return {ready:true,...scope,favorites:(value.favorites||[]).filter(visible),
      favoriteRecords:(value.favoriteRecords||[]).filter(row=>ownsRow(row)&&visible(row.item)),
      history:(value.history||[]).filter(remembered),episodes:(value.episodes||[]).filter(remembered),
      progressRecords:(value.progressRecords||[]).filter(row=>ownsRow(row)&&remembered(row.entry))};
  }
}
