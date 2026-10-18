import {isAdultItem} from '../../parental-classification.js';
import {movieSuggestionScope,movieSuggestionScopeKey,canRetainMovieSuggestions} from './escopo.js';
import {MOVIE_RECOMMENDATION_LIMIT,recommendationFailure} from './contrato.js';

const empty=()=>({item:null,items:[],loading:false,error:null,failure:null,reason:null,personalized:false});
const identity=item=>String(item?.id??'');
export function movieCanHaveSuggestions(item,allowed=()=>true){return item?.kind==='movie'&&!isAdultItem(item)&&allowed(item);}
export function movieFinishedForSuggestions(item,video,allowed=()=>true){return movieCanHaveSuggestions(item,allowed)&&video?.ended===true;}

// Each visible destination owns its cancellation ticket. The injected model
// deduplicates/cache results across preview and playback; this never ranks a
// local catalog or mistakes a response failure for an empty recommendation set.
export class MovieSuggestionSession{
  constructor({lookup,readCached=()=>null,getScope=()=>'',allowed=()=>true,onChange=()=>{}}){Object.assign(this,{lookup,readCached,getScope,allowed,onChange});this.state=empty();this.epoch=0;this.key=null;this.controller=null;this.recoveryScope=null;}
  reset(){this.epoch++;this.controller?.abort();this.controller=null;this.pending=null;this.key=null;this.recoveryScope=null;this.state=empty();this.onChange(this.state);}
  matchesScope(){return this.key===JSON.stringify([movieSuggestionScopeKey(this.getScope()),identity(this.state.item)]);}
  recover(){
    if(!this.state.error||!this.state.item||!this.recoveryScope||!canRetainMovieSuggestions(this.recoveryScope,movieSuggestionScope(this.getScope())))return false;
    void this.select(this.state.item,{force:true,retain:true});return true;
  }
  fromReply(item,result){
    if(result?.schemaVersion!==1||String(result.sourceId)!==identity(item)||!Array.isArray(result.items))return null;
    const seen=new Set([identity(item)]),items=[];
    for(const candidate of result.items.slice(0,MOVIE_RECOMMENDATION_LIMIT))if(movieCanHaveSuggestions(candidate,this.allowed)&&!seen.has(identity(candidate))){seen.add(identity(candidate));items.push(candidate);}
    return {item,items,loading:false,error:null,failure:null,reason:result.reason||null,personalized:result.personalized===true};
  }
  select(item,{force=false,retain=false}={}){
    if(!movieCanHaveSuggestions(item,this.allowed)){this.reset();return Promise.resolve();}
    const scope=movieSuggestionScopeKey(this.getScope()),key=JSON.stringify([scope,identity(item)]);
    if(!force&&this.key===key)return this.pending||Promise.resolve();
    this.controller?.abort();const controller=new AbortController(),epoch=++this.epoch,same=this.key===key||retain&&identity(this.state.item)===identity(item)&&this.recoveryScope&&canRetainMovieSuggestions(this.recoveryScope,movieSuggestionScope(this.getScope()));
    this.controller=controller;this.key=key;this.recoveryScope=movieSuggestionScope(this.getScope());
    let cached=null;try{cached=this.readCached(item,{limit:MOVIE_RECOMMENDATION_LIMIT});}catch{/* Presentation cannot block the live request. */}
    const initial=same?this.state:this.fromReply(item,cached)||empty();
    this.state={...initial,item,loading:true,error:null,failure:null};this.onChange(this.state);
    const current=()=>epoch===this.epoch&&!controller.signal.aborted&&scope===movieSuggestionScopeKey(this.getScope())&&movieCanHaveSuggestions(item,this.allowed);
    const pending=Promise.resolve().then(()=>this.lookup(item,{signal:controller.signal,limit:MOVIE_RECOMMENDATION_LIMIT,force})).then(result=>{
      if(!current())return;
      const next=this.fromReply(item,result);if(!next)throw Object.assign(new Error('MOVIE_SUGGESTIONS_INVALID'),{code:'MOVIE_SUGGESTIONS_INVALID',phase:'dto'});
      this.state=next;
    }).catch(error=>{if(current())this.state={...this.state,loading:false,error:'Não foi possível carregar as sugestões.',failure:recommendationFailure(error)};})
      .finally(()=>{
        if(epoch!==this.epoch)return;this.controller=null;this.pending=null;
        if(current())this.onChange(this.state);
        else if(!controller.signal.aborted&&movieCanHaveSuggestions(item,this.allowed)&&canRetainMovieSuggestions(this.recoveryScope,movieSuggestionScope(this.getScope()))){
          // Bootstrap can attach the cloud binding while the HTTP request is
          // running. That obsolete reply cannot win, but it must not erase the
          // selected destination or leave an endless loading/false empty state.
          this.state={...this.state,loading:false,error:'Não foi possível carregar as sugestões.',
            failure:recommendationFailure({code:'MOVIE_RECOMMENDATIONS_SCOPE_CHANGED',phase:'precondition'})};
          this.onChange(this.state);
        }else this.reset();
      });
    this.pending=pending;return pending;
  }
}
