import {createDOMHooks} from './hooks.js';

/** Search DOM forwards intent; debounce, abort and results stay with search. */
export class SystemSearch{
  constructor({root=document,onSearch=()=>{},onClearSearch=()=>{},beforeOpen=()=>{},isReady=()=>true}={}){
    Object.assign(this,{root,onSearch,onClearSearch,beforeOpen,isReady});this.hooks=createDOMHooks();
    this.input=root.querySelector('#search-input');this.panel=root.querySelector('#search-panel');this.clear=root.querySelector('#close-search');
    this.query='';this.searchPhase='idle';
    this.hooks.listen(this.input,'input',event=>{if(this.isReady())this.onSearch(event.target.value.trim(),event);});
    this.hooks.listen(this.clear,'click',event=>this.clearSearch(event));
  }
  sync({query=this.query,searchPhase=this.searchPhase}={}){
    this.query=query;this.searchPhase=searchPhase;if(this.panel)this.panel.hidden=false;
    if(this.clear)this.clear.disabled=!this.input?.value;
    this.input?.setAttribute('aria-busy',String(Boolean(query)&&['queued','loading','more'].includes(searchPhase)));
  }
  setValue(value=''){if(this.input)this.input.value=String(value);this.sync();}
  open(){if(!this.isReady())return;this.beforeOpen();this.input?.focus();}
  clearSearch(event){if(!this.isReady())return;this.onClearSearch(event);this.input?.focus();}
  dispose(){this.hooks.dispose();}
}
