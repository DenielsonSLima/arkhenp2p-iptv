import {SettingsTools} from './configuracoes/orquestrador.js';
import {AccountMenu} from './conta/menu.js';
import {SystemHeader} from './cabecalho.js';
import {SystemNavigation} from './navegacao.js';
import {SystemSearch} from './busca.js';
import {createDOMHooks} from './hooks.js';

/** Post-login chrome. Domain catalogues, media and Auth remain injected owners. */
export class SystemShell{
  constructor({root=document,getSession=()=>null,onNavigate=()=>{},onSearch=()=>{},onClearSearch=()=>{},
    settings=null,settingsOptions=null,accountMenu=null,accountMenuOptions={}}={}){
    Object.assign(this,{root,getSession});this.initialized=false;this.disposed=false;this.hooks=createDOMHooks();
    this.ownsSettings=!settings&&Boolean(settingsOptions);this.settings=settings||(settingsOptions?new SettingsTools(settingsOptions):null);
    const isReady=()=>this.initialized&&!this.disposed;
    this.header=new SystemHeader({root,getSession});this.navigation=new SystemNavigation({root,onNavigate,isReady});
    this.search=new SystemSearch({root,onSearch,onClearSearch,isReady,beforeOpen:()=>this.settings?.close()});
    const trigger=accountMenuOptions.trigger||root.querySelector('#account-button');
    this.ownsAccountMenu=!accountMenu&&Boolean(trigger);
    this.accountMenu=accountMenu||(trigger?new AccountMenu({trigger,getSession,
      onProfile:()=>this.settings?.open('profile'),onSettings:()=>this.settings?.open(),...accountMenuOptions}):null);
    for(const selector of ['#open-settings','#open-settings-account'])this.hooks.listen(root.querySelector(selector),'click',()=>{if(isReady())this.settings?.open();});
    this.initialized=true;
  }
  update({view='home',query='',searchPhase='idle'}={}){
    if(!this.initialized||this.disposed)return;
    this.navigation.update({view,query});this.search.sync({query,searchPhase});return this.header.update();
  }
  setSearchValue(value){this.search.setValue(value);}
  openSearch(){this.search.open();}
  clearSearch(event){this.search.clearSearch(event);}
  closeTransient(){this.accountMenu?.close(false);this.settings?.close(false);}
  dispose(){
    if(this.disposed)return;this.initialized=false;this.disposed=true;
    this.hooks.dispose();this.navigation.dispose();this.search.dispose();
    if(this.ownsAccountMenu)this.accountMenu?.dispose();if(this.ownsSettings)this.settings?.dispose();
  }
}
