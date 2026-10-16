import {settingsIcon} from '../configuracoes/views.js';
import {createDOMHooks} from '../hooks.js';

export class AccountMenu {
  constructor({trigger,getSession,onProfile,onSettings,onRefresh,onLogout}){
    this.hooks=createDOMHooks();this.originalAttributes=new Map(['aria-haspopup','aria-expanded','aria-controls','aria-label'].map(name=>[name,trigger.getAttribute(name)]));
    this.trigger=trigger;this.getSession=getSession;this.actions={onProfile,onSettings,onRefresh,onLogout};this.isOpen=false;
    this.anchor=document.createElement('div');this.anchor.className='account-menu-anchor';trigger.before(this.anchor);this.anchor.append(trigger);
    this.menu=document.createElement('div');this.menu.id='account-menu';this.menu.className='account-menu';this.menu.hidden=true;this.menu.setAttribute('role','menu');this.menu.setAttribute('aria-label','Opções da conta');
    this.summary=document.createElement('div');this.summary.className='account-menu-summary';const label=document.createElement('small');label.textContent='SUA CONTA';this.username=document.createElement('strong');this.summary.append(label,this.username);this.menu.append(this.summary);
    for(const [label,icon,key]of [['Meu perfil','user','onProfile'],['Configurações','settings','onSettings'],['Atualizar catálogo','refresh','onRefresh'],['Sair da conta','logout','onLogout']]){const item=document.createElement('button');item.type='button';item.className=`account-menu-item${key==='onLogout'?' account-menu-logout':''}`;item.setAttribute('role','menuitem');item.tabIndex=-1;const text=document.createElement('span');text.textContent=label;item.append(settingsIcon(icon),text);item.addEventListener('click',()=>{this.close();this.actions[key]?.();});this.menu.append(item);}
    this.anchor.append(this.menu);trigger.setAttribute('aria-haspopup','menu');trigger.setAttribute('aria-expanded','false');trigger.setAttribute('aria-controls',this.menu.id);trigger.setAttribute('aria-label','Abrir opções da conta');
    this.hooks.listen(trigger,'click',()=>this.isOpen?this.close():this.open());this.hooks.listen(trigger,'keydown',event=>{if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();this.open(event.key==='ArrowUp');}});
    this.hooks.listen(this.menu,'keydown',event=>{const items=this.items(),index=items.indexOf(document.activeElement);let next;if(event.key==='ArrowDown')next=(index+1)%items.length;if(event.key==='ArrowUp')next=(index-1+items.length)%items.length;if(event.key==='Home')next=0;if(event.key==='End')next=items.length-1;if(next!==undefined){event.preventDefault();items[next].focus();}if(event.key==='Escape'){event.preventDefault();event.stopPropagation();this.close();}if(event.key==='Tab')this.close();});
    this.hooks.listen(document,'pointerdown',event=>{if(this.isOpen&&!this.anchor.contains(event.target))this.close(false);});this.hooks.listen(this.anchor,'focusout',event=>{if(!this.anchor.contains(event.relatedTarget))this.close(false);});
  }
  items(){return [...this.menu.querySelectorAll('button')];}
  open(last=false){this.username.textContent=this.getSession?.()?.account?.usernameMasked||'Meu perfil';this.isOpen=true;this.menu.hidden=false;this.trigger.setAttribute('aria-expanded','true');const items=this.items();items[last?items.length-1:0]?.focus();}
  close(returnFocus=true){if(!this.isOpen)return;this.isOpen=false;this.menu.hidden=true;this.trigger.setAttribute('aria-expanded','false');if(returnFocus)this.trigger.focus();}
  dispose(){this.hooks.dispose();this.close(false);this.anchor.before(this.trigger);this.anchor.remove();for(const [name,value] of this.originalAttributes)value===null?this.trigger.removeAttribute(name):this.trigger.setAttribute(name,value);}
}
