import {isAdultItem} from '../../parental-classification.js';
import {movieScope} from '../scope.js';
import {MOVIE_RECOMMENDATION_LIMIT,recommendationFailure} from './contrato.js';

const empty=()=>({item:null,items:[],loading:false,error:null,failure:null,reason:null,personalized:false});
const identity=item=>String(item?.id??'');
const recoveryScopeKey=value=>{
  const scope=movieScope(value?.scope||value);return scope?JSON.stringify({account:scope.account,epoch:scope.epoch,
    includeAdult:scope.includeAdult,hidden:scope.hidden,hiddenItems:scope.hiddenItems}):null;
};
export function movieCanHaveSuggestions(item,allowed=()=>true){return item?.kind==='movie'&&!isAdultItem(item)&&allowed(item);}
export function movieFinishedForSuggestions(item,video,allowed=()=>true){return movieCanHaveSuggestions(item,allowed)&&video?.ended===true;}

// Each visible destination owns its cancellation ticket. The injected model
// deduplicates/cache results across preview and playback; this never ranks a
// local catalog or mistakes a response failure for an empty recommendation set.
export class MovieSuggestionSession{
  constructor({lookup,getScope=()=>'',allowed=()=>true,onChange=()=>{}}){Object.assign(this,{lookup,getScope,allowed,onChange});this.state=empty();this.epoch=0;this.key=null;this.controller=null;this.recoveryScope=null;}
  reset(){this.epoch++;this.controller?.abort();this.controller=null;this.pending=null;this.key=null;this.recoveryScope=null;this.state=empty();this.onChange(this.state);}
  matchesScope(){return this.key===JSON.stringify([JSON.stringify(this.getScope()),identity(this.state.item)]);}
  recover(){
    if(!this.state.error||!this.state.item||!this.recoveryScope||this.recoveryScope!==recoveryScopeKey(this.getScope()))return false;
    void this.select(this.state.item,{force:true,retain:true});return true;
  }
  select(item,{force=false,retain=false}={}){
    if(!movieCanHaveSuggestions(item,this.allowed)){this.reset();return Promise.resolve();}
    const scope=JSON.stringify(this.getScope()),key=JSON.stringify([scope,identity(item)]);
    if(!force&&this.key===key)return this.pending||Promise.resolve();
    this.controller?.abort();const controller=new AbortController(),epoch=++this.epoch,same=this.key===key||retain&&identity(this.state.item)===identity(item)&&this.recoveryScope&&this.recoveryScope===recoveryScopeKey(this.getScope());
    this.controller=controller;this.key=key;this.recoveryScope=recoveryScopeKey(this.getScope());
    this.state={...(same?this.state:empty()),item,loading:true,error:null,failure:null};this.onChange(this.state);
    const current=()=>epoch===this.epoch&&!controller.signal.aborted&&scope===JSON.stringify(this.getScope())&&movieCanHaveSuggestions(item,this.allowed);
    const pending=Promise.resolve().then(()=>this.lookup(item,{signal:controller.signal,limit:MOVIE_RECOMMENDATION_LIMIT,force})).then(result=>{
      if(!current())return;
      if(result?.schemaVersion!==1||String(result.sourceId)!==identity(item)||!Array.isArray(result.items))throw Object.assign(new Error('MOVIE_SUGGESTIONS_INVALID'),{code:'MOVIE_SUGGESTIONS_INVALID',phase:'dto'});
      const seen=new Set([identity(item)]),items=[];
      for(const candidate of result.items.slice(0,MOVIE_RECOMMENDATION_LIMIT))if(movieCanHaveSuggestions(candidate,this.allowed)&&!seen.has(identity(candidate))){seen.add(identity(candidate));items.push(candidate);}
      this.state={item,items,loading:false,error:null,failure:null,reason:result.reason||null,personalized:result.personalized===true};
    }).catch(error=>{if(current())this.state={...this.state,loading:false,error:'Não foi possível carregar as sugestões.',failure:recommendationFailure(error)};})
      .finally(()=>{if(epoch!==this.epoch)return;this.controller=null;this.pending=null;if(current())this.onChange(this.state);else this.reset();});
    this.pending=pending;return pending;
  }
}
