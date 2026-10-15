import {isAdultItem} from './parental-classification.js';

const empty=()=>({item:null,items:[],loading:false,error:null,reason:null,personalized:false});
const identity=item=>String(item?.id??'');
export function movieCanHaveSuggestions(item,allowed=()=>true){return item?.kind==='movie'&&!isAdultItem(item)&&allowed(item);}
export function movieFinishedForSuggestions(item,video,allowed=()=>true){return movieCanHaveSuggestions(item,allowed)&&video?.ended===true;}

// Each visible destination owns its cancellation ticket. The injected model
// deduplicates/cache results across preview and playback; this never ranks a
// local catalog or mistakes a response failure for an empty recommendation set.
export class MovieSuggestionSession{
  constructor({lookup,getScope=()=>'',allowed=()=>true,onChange=()=>{}}){Object.assign(this,{lookup,getScope,allowed,onChange});this.state=empty();this.epoch=0;this.key=null;this.controller=null;}
  reset(){this.epoch++;this.controller?.abort();this.controller=null;this.pending=null;this.key=null;this.state=empty();this.onChange(this.state);}
  matchesScope(){return this.key===JSON.stringify([JSON.stringify(this.getScope()),identity(this.state.item)]);}
  select(item,{force=false}={}){
    if(!movieCanHaveSuggestions(item,this.allowed)){this.reset();return Promise.resolve();}
    const scope=JSON.stringify(this.getScope()),key=JSON.stringify([scope,identity(item)]);
    if(!force&&this.key===key)return this.pending||Promise.resolve();
    this.controller?.abort();const controller=new AbortController(),epoch=++this.epoch,same=this.key===key;
    this.controller=controller;this.key=key;this.state={...(same?this.state:empty()),item,loading:true,error:null};this.onChange(this.state);
    const current=()=>epoch===this.epoch&&!controller.signal.aborted&&scope===JSON.stringify(this.getScope())&&movieCanHaveSuggestions(item,this.allowed);
    const pending=Promise.resolve().then(()=>this.lookup(item,{signal:controller.signal,limit:3,force})).then(result=>{
      if(!current())return;
      if(result?.schemaVersion!==1||String(result.sourceId)!==identity(item)||!Array.isArray(result.items))throw new Error('MOVIE_SUGGESTIONS_INVALID');
      const seen=new Set([identity(item)]),items=[];
      for(const candidate of result.items.slice(0,12))if(movieCanHaveSuggestions(candidate,this.allowed)&&!seen.has(identity(candidate))){seen.add(identity(candidate));items.push(candidate);if(items.length===3)break;}
      this.state={item,items,loading:false,error:null,reason:result.reason||null,personalized:result.personalized===true};
    }).catch(()=>{if(current())this.state={...this.state,loading:false,error:'Não foi possível carregar as sugestões.'};})
      .finally(()=>{if(epoch!==this.epoch)return;this.controller=null;this.pending=null;if(current())this.onChange(this.state);else this.reset();});
    this.pending=pending;return pending;
  }
}

const node=(tag,className='',text)=>{const value=document.createElement(tag);value.className=className;if(text!==undefined)value.textContent=text;return value;};
const action=(label,className,run)=>{const button=node('button',className,label);button.type='button';button.addEventListener('click',run);return button;};

export class MovieSuggestionsView{
  constructor({stage,video,lookup,getScope,allowed,image,setArt,onWatch,onDetails,onReplay,onBack}){
    Object.assign(this,{stage,video,allowed,image,setArt,onWatch,onDetails,onReplay,onBack});this.endItem=null;this.endCurrent=null;this.inertNodes=[];
    this.preview=node('section','detail-related movie-suggestions-preview');const heading=node('div','detail-related-heading');this.previewHeading=node('h2','','Sugestões para você');heading.append(this.previewHeading);this.previewBody=node('div');this.preview.append(heading,this.previewBody);
    this.end=node('section','movie-end-screen');this.end.hidden=true;this.end.tabIndex=-1;this.end.setAttribute('role','dialog');this.end.setAttribute('aria-modal','true');this.end.setAttribute('aria-labelledby','movie-end-title');
    this.endArt=node('div','movie-end-art');this.endArt.setAttribute('aria-hidden','true');const shade=node('div','movie-end-shade');shade.setAttribute('aria-hidden','true');
    const content=node('div','movie-end-content'),top=node('div','movie-end-top');
    this.back=action('Voltar ao catálogo','button quiet movie-end-back',()=>{if(this.validEnd()){this.closeEnd();this.onBack?.();}});top.append(node('span','eyebrow','SUA PRÓXIMA HISTÓRIA'),this.back);
    const lead=node('header','movie-end-heading');lead.append(node('p','movie-end-caption','Porque você assistiu'));this.endTitle=node('h1');this.endTitle.id='movie-end-title';lead.append(this.endTitle);
    this.replay=action('Rever filme','button secondary',()=>{if(this.validEnd()){const item=this.endItem;this.closeEnd();this.onReplay?.(item);}});
    this.endBody=node('div','movie-end-body');const footer=node('div','movie-end-footer');footer.append(this.replay);content.append(top,lead,this.endBody,footer);this.end.append(this.endArt,shade,content);stage.append(this.end);
    this.previewSession=new MovieSuggestionSession({lookup,getScope,allowed,onChange:state=>this.render(this.previewBody,state,'preview')});
    this.endSession=new MovieSuggestionSession({lookup,getScope,allowed,onChange:state=>{if(!state.item){if(this.endItem)this.closeEnd(false);return;}if(this.validEnd())this.render(this.endBody,state,'end');}});
    this.end.addEventListener('keydown',event=>this.keydown(event));
  }
  showPreview(parent,item){
    const section=this.previewFor(item);if(section&&section.parentElement!==parent)parent.append(section);
  }
  previewFor(item){
    if(!movieCanHaveSuggestions(item,this.allowed)){this.previewSession.reset();this.preview.remove();return null;}
    void this.previewSession.select(item);return this.preview;
  }
  showEnd(item,{isCurrent=()=>true}={}){
    if(!movieFinishedForSuggestions(item,this.video,this.allowed)||!isCurrent())return false;
    if(this.endItem&&identity(this.endItem)===identity(item)&&this.endCurrent?.())return true;
    this.closeEnd();this.endItem=item;this.endCurrent=isCurrent;this.endTitle.textContent=String(item.name||'Seu filme');
    const backdrop=Array.isArray(item.backdrop)?item.backdrop[0]:item.backdrop;this.setArt?.(this.endArt,backdrop||item.poster,!backdrop,item.poster);
    this.inertNodes=[...this.stage.children].filter(child=>child!==this.end).map(child=>({child,inert:child.inert}));for(const {child}of this.inertNodes)child.inert=true;
    this.stage.classList.add('movie-end-visible');this.end.hidden=false;this.end.scrollTop=0;this.back.focus({preventScroll:true});void this.endSession.select(item);return true;
  }
  validEnd(){return Boolean(this.endItem&&this.endCurrent?.()&&movieCanHaveSuggestions(this.endItem,this.allowed));}
  closeEnd(resetSession=true){
    this.endItem=null;this.endCurrent=null;this.end.hidden=true;this.stage.classList.remove('movie-end-visible');for(const {child,inert}of this.inertNodes)child.inert=inert;this.inertNodes=[];
    if(resetSession)this.endSession.reset();
  }
  reset(){this.closeEnd();this.previewSession.reset();this.preview.remove();}
  render(parent,state,mode){
    parent.setAttribute('aria-busy',String(state.loading));
    if(!state.item){parent.replaceChildren();return;}
    const content=node('div','movie-suggestions-content'),grid=node('div','movie-suggestions-grid');
    const label=state.reason==='rating'?'Filmes bem avaliados':state.reason==='history_genre'?'Recomendados para você':['source_genre','source_category'].includes(state.reason)?'Filmes semelhantes':'Sugestões para você';
    if(mode==='preview')this.previewHeading.textContent=label;
    if(mode==='end'&&state.items.length&&state.reason==='rating')content.append(node('p','movie-suggestion-status','Bem avaliados no catálogo'));
    for(const item of state.items){
      const card=node('article','movie-suggestion');card.dataset.movieId=identity(item);
      const canAct=()=> (mode==='end'?this.validEnd():this.previewSession.matchesScope())&&movieCanHaveSuggestions(item,this.allowed);
      const details=()=>{if(!canAct())return;if(mode==='end')this.closeEnd();this.onDetails?.(item);};
      const watch=()=>{if(!canAct())return;if(mode==='end')this.closeEnd();this.onWatch?.(item);};
      const artwork=action('','movie-suggestion-art',details);artwork.setAttribute('aria-label',`Ver detalhes de ${item.name}`);
      if(this.image){const backdrop=Array.isArray(item.backdrop)?item.backdrop[0]:item.backdrop;artwork.append(this.image(mode==='end'?backdrop||item.poster:item.poster,'',true,item.poster));}
      const copy=node('div','movie-suggestion-copy');copy.append(node('h2','movie-suggestion-title',String(item.name||'Filme')));
      const facts=[String(item.year||'').match(/(?:19|20)\d{2}/)?.[0],typeof item.genre==='string'?item.genre:''].filter(Boolean);if(facts.length)copy.append(node('p','movie-suggestion-meta',facts.join(' · ')));
      const actions=node('div','movie-suggestion-actions');actions.append(action('Assistir','button primary',watch),action('Detalhes','button secondary',details));copy.append(actions);card.append(artwork,copy);grid.append(card);
    }
    if(state.items.length)content.append(grid);
    if(state.loading&&!state.items.length){const status=node('p','movie-suggestion-status','Encontrando sua próxima história…');status.setAttribute('role','status');content.append(status);}
    else if(state.error){const status=node('p','movie-suggestion-status',state.error);status.setAttribute('role','status');content.append(status,action('Tentar novamente','button secondary',()=>{const session=mode==='end'?this.endSession:this.previewSession;if(mode!=='end'||this.validEnd())void session.select(state.item,{force:true});}));}
    else if(!state.items.length){const status=node('p','movie-suggestion-status','Explore o catálogo para encontrar sua próxima história.');status.setAttribute('role','status');content.append(status);}
    parent.replaceChildren(content);
  }
  keydown(event){
    if(this.end.hidden)return;event.stopPropagation();
    if(event.key==='Escape'){event.preventDefault();this.back.click();return;}
    const buttons=[...this.end.querySelectorAll('button')].filter(button=>!button.disabled&&!button.hidden),index=buttons.indexOf(document.activeElement);
    if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();const delta=['ArrowLeft','ArrowUp'].includes(event.key)?-1:1;buttons[(index+delta+buttons.length)%buttons.length]?.focus();}
    else if(event.key==='Tab'&&(!event.shiftKey&&index===buttons.length-1||event.shiftKey&&index<=0)){event.preventDefault();buttons[event.shiftKey?buttons.length-1:0]?.focus();}
  }
}
