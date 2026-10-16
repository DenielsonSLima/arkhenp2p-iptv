import {createDOMHooks} from './hooks.js';

export const SYSTEM_VIEWS=Object.freeze({home:'Início',live:'Ao vivo',movies:'Filmes',series:'Séries',favorites:'Minha lista'});

/** Navigation chooses a domain; catalogue state stays in that domain. */
export class SystemNavigation{
  constructor({root=document,onNavigate=()=>{},isReady=()=>true}={}){
    Object.assign(this,{root,onNavigate,isReady});this.hooks=createDOMHooks();
    this.navigation=root.querySelector('#navigation');
    this.hooks.listen(this.navigation,'click',event=>{
      const target=event.target.closest?.('[data-view]');
      if(!this.isReady()||!target||!this.navigation.contains(target)||!Object.hasOwn(SYSTEM_VIEWS,target.dataset.view))return;
      this.onNavigate(target.dataset.view,event);
    });
    this.hooks.listen(root.querySelector('.topbar .brand'),'click',event=>{
      if(!this.isReady())return;event.preventDefault();this.onNavigate('home',event);
    });
  }
  update({view='home',query=''}={}){
    for(const element of this.root.querySelectorAll('[data-view]')){
      const active=element.dataset.view===view&&!query;element.classList.toggle('active',active);
      active?element.setAttribute('aria-current','page'):element.removeAttribute('aria-current');
    }
  }
  dispose(){this.hooks.dispose();}
}
