import {MovieSuggestionSession,movieCanHaveSuggestions,movieFinishedForSuggestions} from './sessao.js';
const identity=item=>String(item?.id??'');

const node=(tag,className='',text)=>{const value=document.createElement(tag);value.className=className;if(text!==undefined)value.textContent=text;return value;};
const action=(label,className,run)=>{const button=node('button',className,label);button.type='button';button.addEventListener('click',run);return button;};

export class MovieSuggestionsView{
  constructor({stage,video,lookup,readCached,getScope,allowed,createCard,setArt,onWatch,onDetails,onReplay,onBack}){
    Object.assign(this,{stage,video,allowed,createCard,setArt,onWatch,onDetails,onReplay,onBack});this.endItem=null;this.endCurrent=null;this.inertNodes=[];
    this.preview=node('section','detail-related movie-suggestions-preview');const heading=node('div','detail-related-heading');this.previewHeading=node('h2','','Sugestões para você');heading.append(this.previewHeading);this.previewBody=node('div');this.preview.append(heading,this.previewBody);
    this.end=node('section','movie-end-screen');this.end.hidden=true;this.end.tabIndex=-1;this.end.setAttribute('role','dialog');this.end.setAttribute('aria-modal','true');this.end.setAttribute('aria-labelledby','movie-end-title');
    this.endArt=node('div','movie-end-art');this.endArt.setAttribute('aria-hidden','true');const shade=node('div','movie-end-shade');shade.setAttribute('aria-hidden','true');
    const content=node('div','movie-end-content'),top=node('div','movie-end-top');
    this.back=action('Voltar ao catálogo','button quiet movie-end-back',()=>{if(this.validEnd()){this.closeEnd();this.onBack?.();}});top.append(node('span','eyebrow','SUA PRÓXIMA HISTÓRIA'),this.back);
    const lead=node('header','movie-end-heading');lead.append(node('p','movie-end-caption','Porque você assistiu'));this.endTitle=node('h1');this.endTitle.id='movie-end-title';lead.append(this.endTitle);
    this.replay=action('Rever filme','button secondary',()=>{if(this.validEnd()){const item=this.endItem;this.closeEnd();this.onReplay?.(item);}});
    this.endBody=node('div','movie-end-body');const footer=node('div','movie-end-footer');footer.append(this.replay);content.append(top,lead,this.endBody,footer);this.end.append(this.endArt,shade,content);stage.append(this.end);
    this.previewSession=new MovieSuggestionSession({lookup,readCached,getScope,allowed,onChange:state=>this.render(this.previewBody,state,'preview')});
    this.endSession=new MovieSuggestionSession({lookup,readCached,getScope,allowed,onChange:state=>{if(!state.item){if(this.endItem)this.closeEnd(false);return;}if(this.validEnd())this.render(this.endBody,state,'end');}});
    this.onKeydown=event=>this.keydown(event);this.end.addEventListener('keydown',this.onKeydown);
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
  pausePreview(){this.previewSession.reset();}
  recover(){
    const preview=this.preview.isConnected&&!this.preview.ownerDocument?.hidden&&!this.preview.closest?.('[hidden]')&&this.previewSession.recover();
    const end=this.validEnd()&&!this.end.hidden&&!this.end.ownerDocument?.hidden&&this.endSession.recover();return Boolean(preview||end);
  }
  dispose(){this.reset();this.end.removeEventListener('keydown',this.onKeydown);this.end.remove();}
  render(parent,state,mode){
    parent.setAttribute('aria-busy',String(state.loading));
    for(const [field,key]of [['failureCode','code'],['failurePhase','phase'],['failureStatus','status']]){
      if(state.failure?.[key]!=null)parent.dataset[field]=String(state.failure[key]);else delete parent.dataset[field];
    }
    if(!state.item){parent.replaceChildren();return;}
    const content=node('div','movie-suggestions-content'),grid=node('div','movie-suggestions-grid');
    if(mode==='preview')this.previewHeading.textContent='Sugestões para você';
    for(const item of state.items){
      const canAct=()=> (mode==='end'?this.validEnd():this.previewSession.matchesScope())&&movieCanHaveSuggestions(item,this.allowed);
      const details=()=>{if(!canAct())return;if(mode==='end')this.closeEnd();this.onDetails?.(item);};
      const card=this.createCard(item,{onDetails:details,canAct});card.dataset.movieId=identity(item);grid.append(card);
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
