import { SETTINGS_SECTIONS, STARTUP_VIEWS, settingsIcon, renderGeneral, renderProfile, renderStartup } from './settings-views.js';
import {renderAudioPreferences} from './audio-preferences.js';
import {renderSeriesPlaybackPreferences} from './series-playback-preferences-view.js';
const STORAGE='arkehn.catalog-settings.v1';
const TYPES={live:'TV ao vivo',movies:'Filmes',series:'Séries'};
const normalize=value=>String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const itemKey=item=>`${item.kind}:${item.id}`;
function node(tag,className='',text){const element=document.createElement(tag);element.className=className;if(text!==undefined)element.textContent=text;return element;}
function button(text,action,className='button secondary'){const element=node('button',className,text);element.type='button';element.addEventListener('click',action);return element;}
function read(key=STORAGE){try{const value=JSON.parse(localStorage.getItem(key));return value&&typeof value==='object'?value:{};}catch{return {};}}
export class SettingsTools {
  constructor(options){
    this.options=options;this.storageKey=STORAGE;const stored=read();this.hidden={};this.hiddenItems={};
    for(const type of Object.keys(TYPES)){
      this.hidden[type]=new Set(Array.isArray(stored.hidden?.[type])?stored.hidden[type].filter(id=>typeof id==='string'):[]);
      this.hiddenItems[type]=new Set(Array.isArray(stored.hiddenItems?.[type])?stored.hiddenItems[type].filter(id=>typeof id==='string'):[]);
    }
    this.channelNumbers=new Map();const usedNumbers=new Set();for(const [id,number]of Object.entries(stored.channelNumbers||{})){if(/^\d{1,12}$/.test(id)&&Number.isInteger(number)&&number>0&&number<=9999&&!usedNumbers.has(number)){this.channelNumbers.set(id,number);usedNumbers.add(number);}}
    this.groups=(Array.isArray(stored.groups)?stored.groups:[]).filter(group=>group&&typeof group.id==='string'&&typeof group.name==='string'&&TYPES[group.type]&&Array.isArray(group.itemKeys)).map(group=>({...group,name:group.name.slice(0,60),itemKeys:group.itemKeys.filter(key=>/^(live|movie|series):\d{1,12}$/.test(key)).slice(0,500)}));
    this.startupView=STARTUP_VIEWS.some(([id])=>id===stored.startupView)?stored.startupView:'home';
    this.trash=[];this.tab='general';this.type='live';this.editing=null;this.query='';this.categoryQuery='';this.onlyFavorites=false;this.isOpen=false;this.diagnosticRequest=0;
    this.catalogPane='provider';this.providerCategory=null;this.providerQuery='';this.providerLimit=80;this.catalogLoadFailures=new Set();this.catalogLoads=new Map();
    this.dialog=node('section','settings-page');this.dialog.id='settings-page';this.dialog.hidden=true;this.dialog.setAttribute('aria-labelledby','settings-title');
    const sidebar=node('aside','settings-sidebar'),identity=node('div','settings-sidebar-identity'),mark=node('img');mark.src='/assets/brand/symbol.svg';mark.alt='';const identityCopy=node('div');identityCopy.append(node('small','','SUA EXPERIÊNCIA'),node('strong','','Preferências'));identity.append(mark,identityCopy);sidebar.append(identity);
    this.tabs=node('nav','settings-sidebar-nav');this.tabs.setAttribute('aria-label','Seções de configurações');
    for(const {id,label,icon}of SETTINGS_SECTIONS){const tab=button('',()=>this.open(id),'settings-sidebar-link');tab.dataset.tab=id;tab.append(settingsIcon(icon),node('span','',label));this.tabs.append(tab);}sidebar.append(this.tabs);
    this.sidebarAccount=node('div','settings-sidebar-account');sidebar.append(this.sidebarAccount);this.dialog.append(sidebar);
    const workspace=node('div','settings-workspace'),heading=node('div','settings-heading');heading.append(node('div','','SEU UNIVERSO, DO SEU JEITO'),button('Voltar ao catálogo',()=>this.close(),'button secondary compact'));
    this.title=node('h2','','Configurações');this.title.id='settings-title';this.title.tabIndex=-1;this.description=node('p','settings-section-description');this.body=node('div','settings-body');workspace.append(heading,this.title,this.description,this.body);this.dialog.append(workspace);document.querySelector('#application').insertBefore(this.dialog,document.querySelector('.app-footer'));
    window.addEventListener('popstate',()=>{if(location.hash.startsWith('#settings/'))this.restoreRoute();else this.close(false);});
  }
  catalog(type){const catalogs=this.options.getCatalogs();return catalogs instanceof Map?catalogs.get(type):catalogs?.[type];}
  getPreferences(){return {hidden:Object.fromEntries(Object.entries(this.hidden).map(([type,ids])=>[type,[...ids]])),hiddenItems:Object.fromEntries(Object.entries(this.hiddenItems||{}).map(([type,ids])=>[type,[...ids]])),groups:this.getCustomGroups(),channelNumbers:Object.fromEntries(this.channelNumbers),startupView:this.getStartupView()};}
  store({notify=true}={}){try{localStorage.setItem(this.storageKey,JSON.stringify(this.getPreferences()));}catch{this.options.toast('Não foi possível salvar estas preferências no navegador.');}if(notify)this.options.onStore?.();}
  activateAccount(id){
    this.markerSyncCleanup?.();this.markerSyncCleanup=null;this.markerSyncController?.reset();
    this.storageKey=/^[a-f0-9]{64}$/i.test(id||'')?`${STORAGE}.account.${id}`:STORAGE;
    this.applyPreferences(read(this.storageKey),{includeGroups:true});
  }
  applyPreferences(value={}, {includeGroups=false}={}){
    for(const type of Object.keys(TYPES)){
      this.hidden[type]=new Set((Array.isArray(value.hidden?.[type])?value.hidden[type]:[]).filter(id=>typeof id==='string'));
      this.hiddenItems[type]=new Set((Array.isArray(value.hiddenItems?.[type])?value.hiddenItems[type]:[]).filter(id=>typeof id==='string'));
    }
    this.channelNumbers=new Map();const used=new Set();for(const [id,number]of Object.entries(value.channelNumbers||{}))if(/^\d{1,12}$/.test(id)&&Number.isInteger(number)&&number>0&&number<=9999&&!used.has(number)){used.add(number);this.channelNumbers.set(id,number);}
    this.startupView=STARTUP_VIEWS.some(([id])=>id===value.startupView)?value.startupView:'home';
    if(includeGroups)this.setCustomGroups(value.groups||[],{store:false});this.store({notify:false});
  }
  setCustomGroups(groups,{store=true}={}){
    this.groups=(Array.isArray(groups)?groups:[]).filter(group=>group&&typeof group.id==='string'&&/^[\w-]{1,160}$/.test(group.id)&&typeof group.name==='string'&&TYPES[group.type]&&Array.isArray(group.itemKeys)).map(group=>({id:group.id,name:group.name.slice(0,60),type:group.type,itemKeys:group.itemKeys.filter(key=>/^(live|movie|series):\d{1,12}$/.test(key)).slice(0,500)}));
    if(store)this.store({notify:false});
  }
  getStartupView(){return STARTUP_VIEWS.some(([id])=>id===this.startupView)?this.startupView:'home';}
  setStartupView(value){if(!STARTUP_VIEWS.some(([id])=>id===value))return;this.startupView=value;this.store();this.options.toast('Tela de inicialização salva.');}
  persist(){this.store();this.options.onChange();if(this.isOpen)document.title='ARKHEN P2 IPTV · Configurações';}
  isCategoryVisible(type,id){return !this.hidden[type]?.has(String(id));}
  isItemVisible(type,itemId){return !this.hiddenItems?.[type]?.has(String(itemId));}
  isCatalogItemVisible(type,item){return (item.categoryIds||[item.categoryId]).some(id=>this.isCategoryVisible(type,id))&&this.isItemVisible(type,item.id);}
  setItemVisible(type,itemId,visible){
    const id=String(itemId);if(!TYPES[type]||!this.catalog(type)?.items?.some(item=>String(item.id)===id))return false;
    this.hiddenItems ||= {};this.hiddenItems[type] ||= new Set();const hidden=this.hiddenItems[type],wasHidden=hidden.has(id);
    visible?hidden.delete(id):hidden.add(id);if(wasHidden!==hidden.has(id))this.persist();return true;
  }
  getProviderCategoryItems(type,categoryId){
    const catalog=this.catalog(type),category=catalog?.categories?.find(group=>String(group.id)===String(categoryId));if(!category)return[];
    const ids=new Set([...(category.ids||[category.id])].map(String));return(catalog.items||[]).filter(item=>(item.categoryIds||[item.categoryId]).some(id=>ids.has(String(id))));
  }
  restoreCategoryItems(type,categoryId){
    let restored=0;for(const item of this.getProviderCategoryItems(type,categoryId))if(this.hiddenItems?.[type]?.delete(String(item.id)))restored++;
    if(restored)this.persist();return restored;
  }
  countVisibleItems(type){return(this.catalog(type)?.items||[]).filter(item=>this.isCatalogItemVisible(type,item)).length;}
  getCustomGroups(){return this.groups.map(group=>({...group,itemKeys:[...group.itemKeys]}));}
  getNumberedChannels({favoritesOnly=true,fallbackToAll=true}={}){
    const catalog=this.catalog('live');if(!catalog&&!this.options.resolveFavoriteItem)return[];
    const stored=this.options.getFavorites(),favorites=stored instanceof Map?[...stored.values()]:Array.isArray(stored)?stored:[];
    const visible=(catalog?.items||[]).filter(item=>this.isCatalogItemVisible('live',item));const visibleMap=new Map(visible.map(item=>[String(item.id),item]));
    const favoriteItems=favorites.filter(item=>item.kind==='live').map(item=>this.options.resolveFavoriteItem?this.options.resolveFavoriteItem(item):visibleMap.get(String(item.id))).filter(item=>item&&this.isCatalogItemVisible('live',item));
    for(const item of favoriteItems)if(!visibleMap.has(String(item.id))){visibleMap.set(String(item.id),item);visible.push(item);}
    const used=new Set(this.channelNumbers.values());let candidate=1,changed=false;
    for(const item of favoriteItems){if(this.channelNumbers.has(String(item.id)))continue;while(used.has(candidate))candidate++;if(candidate>9999)break;this.channelNumbers.set(String(item.id),candidate);used.add(candidate);changed=true;}
    if(changed)this.store();
    const selected=favoritesOnly?(favoriteItems.length||!fallbackToAll?favoriteItems:visible):visible;
    const result=selected.map(item=>{let number=this.channelNumbers.get(String(item.id));if(!number){while(used.has(candidate))candidate++;number=candidate++;used.add(number);}return{item,number};});return result.sort((a,b)=>a.number-b.number);
  }
  getChannelNumber(itemId,fallback=null){return this.channelNumbers.get(String(itemId))??this.getNumberedChannels({favoritesOnly:false}).find(entry=>String(entry.item.id)===String(itemId))?.number??fallback;}
  setChannelNumber(itemId,value){const number=Number(value),id=String(itemId);if(!Number.isInteger(number)||number<1||number>9999){this.options.toast('Use um número de canal entre 1 e 9999.');return false;}if([...this.channelNumbers].some(([other,assigned])=>other!==id&&assigned===number)){this.options.toast(`O número ${number} já está em uso. Escolha outro.`);return false;}this.channelNumbers.set(id,number);this.persist();return true;}
  renderNumbering(){
    const section=node('section','settings-section settings-numbering');section.append(node('h3','','Números dos canais favoritos'),node('p','settings-note','Em tela cheia, use as setas para cima/baixo para trocar de canal ou digite o número. Os números ficam salvos neste navegador.'));
    const channels=this.getNumberedChannels({favoritesOnly:true,fallbackToAll:false});if(!channels.length){section.append(node('p','settings-note','Marque a estrela de um canal para adicioná-lo aos Favoritos e definir seu número.'));return section;}
    const list=node('div','settings-channel-number-list');for(const {item,number}of channels){const row=node('label','settings-channel-number'),input=node('input','settings-search');input.type='number';input.min='1';input.max='9999';input.value=String(number);input.setAttribute('aria-label',`Número do canal ${item.name}`);input.addEventListener('change',()=>{if(!this.setChannelNumber(item.id,input.value))input.value=String(this.getChannelNumber(item.id,number));});row.append(input,node('span','',item.name));list.append(row);}section.append(list);return section;
  }
  updateRoute(){const hash=`#settings/${this.tab}`;if(location.hash!==hash)history.pushState({settings:true},'',hash);}
  restoreRoute(){const match=/^#settings\/(general|profile|parental|live|movies|series|series-playback|marker-sync|playback|audio|startup|connection|catalog)(?:\/(live|movies|series))?$/.exec(location.hash);if(match)this.open(match[1],match[2],false);}
  open(tab='general',type,route=true){
    if(!this.isOpen){this.previousTitle=document.title;this.previousHash=location.hash.startsWith('#settings/')?'#home':location.hash;this.options.onOpen?.();}
    const next=tab==='catalog'?(TYPES[type]?type:this.type):tab;
    this.diagnosticRequest++;this.tab=SETTINGS_SECTIONS.some(section=>section.id===next)||next==='connection'?next:'general';
    if(TYPES[this.tab]&&this.type!==this.tab){this.type=this.tab;this.editing=null;this.query='';this.categoryQuery='';this.providerCategory=null;this.providerQuery='';this.providerLimit=80;}
    this.isOpen=true;this.dialog.hidden=false;document.querySelector('#main-content').hidden=true;document.title='ARKHEN P2 IPTV · Configurações';
    this.render();if(route)this.updateRoute();window.scrollTo({top:0,behavior:'instant'});this.title.focus({preventScroll:true});
    if(TYPES[this.tab]&&!this.catalog(this.tab))this.ensureCatalog(this.tab);
  }
  ensureCatalog(type){
    if(!this.options.loadCatalog||this.catalogLoads.has(type))return;
    this.catalogLoadFailures.delete(type);
    const pending=Promise.resolve(this.options.loadCatalog(type)).then(data=>{if(!data)this.catalogLoadFailures.add(type);}).catch(()=>this.catalogLoadFailures.add(type)).finally(()=>{this.catalogLoads.delete(type);if(this.isOpen&&this.tab===type)this.render();});
    this.catalogLoads.set(type,pending);
  }
  close(route=true){if(!this.isOpen)return;this.audioCleanup?.();this.audioCleanup=null;this.seriesPlaybackCleanup?.();this.seriesPlaybackCleanup=null;this.markerSyncCleanup?.();this.markerSyncCleanup=null;this.diagnosticRequest++;this.isOpen=false;this.dialog.hidden=true;document.querySelector('#main-content').hidden=false;document.title=this.previousTitle||'ARKHEN P2 IPTV';if(route)history.replaceState(null,'',this.previousHash||'#home');this.options.onClose?.();}
  render(){
    this.audioCleanup?.();this.audioCleanup=null;
    this.seriesPlaybackCleanup?.();this.seriesPlaybackCleanup=null;
    this.markerSyncCleanup?.();this.markerSyncCleanup=null;
    for(const tab of this.tabs.children){const active=tab.dataset.tab===this.tab||(this.tab==='connection'&&tab.dataset.tab==='general');tab.classList.toggle('active',active);active?tab.setAttribute('aria-current','page'):tab.removeAttribute('aria-current');}
    const section=SETTINGS_SECTIONS.find(item=>item.id===this.tab);this.title.textContent=section?.label||'Teste de conexão';this.description.textContent=section?.description||'Confira como está o seu serviço e a reprodução.';
    const account=this.options.getSession?.()?.account||{};this.sidebarAccount.replaceChildren(node('span','status-dot'),node('span','',account.usernameMasked||'Conta conectada'));
    this.body.replaceChildren();
    const viewOptions={getSession:this.options.getSession,getCloudStatus:this.options.getCloudStatus,mediaLibrary:this.options.mediaLibrary,onLibraryChange:()=>{this.options.onLibraryChange?.();this.options.onChange?.();},open:(tab,type)=>this.open(tab,type),logout:()=>this.options.onLogout?.(),refresh:()=>this.options.onRefresh?.()};
    if(this.tab==='general')renderGeneral(this.body,viewOptions);
    else if(this.tab==='profile')renderProfile(this.body,viewOptions);
    else if(this.tab==='parental')this.options.parentalControl?.renderSettings(this.body);
    else if(this.tab==='startup')renderStartup(this.body,{value:this.getStartupView(),onChange:value=>this.setStartupView(value)});
    else if(this.tab==='audio')this.audioCleanup=renderAudioPreferences(this.body,{controller:this.options.audioController,toast:this.options.toast});
    else if(this.tab==='series-playback')this.seriesPlaybackCleanup=renderSeriesPlaybackPreferences(this.body,{controller:this.options.seriesPlaybackPreferences,toast:this.options.toast});
    else if(this.tab==='marker-sync')void this.renderMarkerSync();
    else if(this.tab==='playback'){
      if(this.options.playerTools?.renderPreferences)this.options.playerTools.renderPreferences(this.body);
      else this.body.append(node('p','settings-note','Ajuste o buffer no menu do player durante a reprodução.'));
      this.body.append(node('p','settings-note','Mais buffer dá margem contra oscilações e pode aumentar o atraso ao vivo. Para filmes e séries, priorize estabilidade.'));
    }else if(this.tab==='connection'){
      this.body.append(node('h3','','Como está a sua sessão?'),node('p','settings-note','Verifique a resposta do serviço e a entrega dos segmentos do vídeo que já está em reprodução.'));
      const result=node('div','settings-diagnostic-result');
      const run=button('Iniciar teste de conexão',()=>this.diagnose(result,run),'button primary');this.body.append(run,result);
      this.body.append(node('p','settings-note','O teste não abre outro canal. Sem reprodução HLS, a avaliação informa que faltam amostras de vídeo.'));
    }else this.renderCatalog();
  }
  async renderMarkerSync(){
    const request=++this.diagnosticRequest,loading=node('p','settings-note','Carregando o registro de sincronização…');this.body.append(loading);
    try{
      const module=await(this.markerSyncModule||=import('./marker-sync-settings.js'));
      if(request!==this.diagnosticRequest||!this.isOpen||this.tab!=='marker-sync')return;
      this.markerSyncController||=new module.MarkerSyncRegistry({api:this.options.api,getScope:()=>{const cloud=this.options.getSession?.()?.cloud;return{project:cloud?.url,providerKey:cloud?.providerKey,scopeHash:cloud?.scopeHash};}});
      this.body.replaceChildren();this.markerSyncCleanup=module.renderMarkerSyncSettings(this.body,{controller:this.markerSyncController});
    }catch{
      if(request!==this.diagnosticRequest||!this.isOpen||this.tab!=='marker-sync')return;
      this.body.replaceChildren(node('p','diagnostics-error','Não foi possível abrir o registro de sincronização.'),button('Tentar novamente',()=>this.render()));
    }
  }
  async diagnose(container,run){
    const request=++this.diagnosticRequest;run.disabled=true;container.replaceChildren(node('p','settings-note','Verificando três respostas do serviço e os dados da reprodução…'));
    try{
      const data=await this.options.api('/api/diagnostics');if(request!==this.diagnosticRequest||!this.isOpen||this.tab!=='connection')return;
      container.replaceChildren();const assessment=node('section','diagnostics-assessment');assessment.dataset.status=data.assessment.status;assessment.append(node('h3','',data.assessment.title),node('p','',data.assessment.detail));container.append(assessment);
      if(this.options.playerTools?.current?.failed)container.append(node('p','diagnostics-error','O player reportou uma interrupção. A margem de entrega dos segmentos não garante que o navegador consiga decodificar esta fonte. Confira a mensagem do player e tente novamente.'));
      const grid=node('div','diagnostics-grid'),value=(number,unit)=>number===null||number===undefined?'Sem amostra':`${Number(number).toLocaleString('pt-BR',{maximumFractionDigits:2})} ${unit}`;
      for(const [label,measurement]of [['Serviço',data.server.host],['Resposta da API',value(data.server.latencyMs,'ms')],['Variação da API',value(data.server.jitterMs,'ms')],['Entrega do vídeo',value(data.playback.throughputMbps,'Mb/s')],['Necessidade da fonte',value(data.playback.requiredMbps,'Mb/s')],['Segmentos medidos',String(data.playback.segmentSamples)]]){const metric=node('div','diagnostics-metric');metric.append(node('span','',label),node('strong','',measurement));grid.append(metric);}container.append(grid);
      container.append(node('p','settings-note',`Medido às ${new Date(data.checkedAt).toLocaleTimeString('pt-BR')}. ${data.playback.active?'Amostras da reprodução selecionada.':'Nenhuma reprodução ativa nesta medição.'}`));
      for(const recommendation of data.recommendations||[])container.append(node('p','settings-note',recommendation));
      const limits=node('details','diagnostics-limits');limits.append(node('summary','','Como interpretar este teste'));for(const limit of data.limits||[])limits.append(node('p','settings-note',limit));container.append(limits);
    }catch(error){if(request===this.diagnosticRequest)container.replaceChildren(node('p','diagnostics-error',error.message));}
    finally{if(request===this.diagnosticRequest)run.disabled=false;}
  }
  renderCatalog(){
    this.body.append(node('p','settings-note','Organize o que aparece neste navegador. Uma lista menor torna a navegação mais leve; a qualidade da transmissão depende da fonte e da conexão.'));
    const catalog=this.catalog(this.type);if(!catalog){const failed=this.catalogLoadFailures.has(this.type);this.body.append(node('p','settings-note',failed?'Não foi possível carregar as categorias. Confira sua conexão e tente novamente.':'Carregando suas categorias…'));if(failed)this.body.append(button('Tentar novamente',()=>{this.ensureCatalog(this.type);this.render();},'button secondary'));return;}
    let numbering=this.type==='live'?this.renderNumbering():null;if(numbering)this.body.append(numbering);
    const columns=node('div','settings-columns'),categories=node('section','settings-section'),groups=node('section','settings-section settings-catalog-content');columns.append(categories,groups);this.body.append(columns);
    categories.append(node('h3','','Categorias visíveis'));
    const total=catalog.items?.length||0,counter=node('p','settings-counter');categories.append(counter);
    const updateSummary=()=>{counter.textContent=`${this.countVisibleItems(this.type).toLocaleString('pt-BR')} de ${total.toLocaleString('pt-BR')} títulos visíveis`;if(numbering){const replacement=this.renderNumbering();numbering.replaceWith(replacement);numbering=replacement;}};
    const actions=node('div','settings-actions');actions.append(button('Mostrar todas',()=>{this.hidden[this.type].clear();this.persist();this.render();},'button secondary compact'),button('Ocultar todas',()=>{for(const category of catalog.categories||[])for(const id of category.ids||[category.id])this.hidden[this.type].add(String(id));this.persist();this.render();},'button secondary compact'));categories.append(actions);
    const search=node('input','settings-search');search.type='search';search.placeholder='Buscar categoria';search.setAttribute('aria-label','Buscar categoria');search.value=this.categoryQuery;
    const list=node('div','settings-category-list');categories.append(search,list);
    const drawRight=()=>{
      groups.replaceChildren();const modes=node('div','settings-type-choices settings-catalog-modes');
      for(const [mode,label]of [['provider',this.type==='live'?'Canais da categoria':'Títulos da categoria'],['personal','Categorias pessoais']])modes.append(button(label,()=>{this.catalogPane=mode;drawRight();drawCategories();},`settings-tab${this.catalogPane===mode?' active':''}`));
      groups.append(modes);if(this.catalogPane==='provider')this.renderProviderCategory(groups,catalog,updateSummary);else this.renderPersonalGroups(groups,catalog);
    };
    const drawCategories=()=>{
      list.replaceChildren();for(const category of catalog.categories||[]){
        if(!normalize(category.name).includes(normalize(this.categoryQuery)))continue;
        const ids=[...(category.ids||[category.id])].map(String),row=node('div','settings-check settings-provider-category'),checkbox=node('input');
        checkbox.type='checkbox';checkbox.setAttribute('aria-label',`Mostrar categoria ${category.name}`);checkbox.checked=ids.every(id=>this.isCategoryVisible(this.type,id));checkbox.indeterminate=!checkbox.checked&&ids.some(id=>this.isCategoryVisible(this.type,id));
        checkbox.addEventListener('click',event=>event.stopPropagation());checkbox.addEventListener('change',()=>{for(const id of ids)checkbox.checked?this.hidden[this.type].delete(id):this.hidden[this.type].add(id);this.persist();updateSummary();drawRight();});
        const select=button(category.name,event=>{event.stopPropagation();this.providerCategory=String(category.id);this.catalogPane='provider';this.providerQuery='';this.providerLimit=80;drawCategories();drawRight();},'settings-group-open settings-category-select');
        const selected=this.catalogPane==='provider'&&String(category.id)===this.providerCategory;select.setAttribute('aria-pressed',String(selected));row.classList.toggle('selected',selected);row.dataset.categoryId=String(category.id);
        row.append(checkbox,select,node('small','',String(category.count??this.getProviderCategoryItems(this.type,category.id).length)));list.append(row);
      }
    };
    search.addEventListener('input',()=>{this.categoryQuery=search.value;drawCategories();});updateSummary();drawRight();drawCategories();
  }
  renderProviderCategory(section,catalog,updateSummary){
    let category=(catalog.categories||[]).find(group=>String(group.id)===this.providerCategory);
    if(!category){category=catalog.categories?.[0];this.providerCategory=category?String(category.id):null;}
    if(!category){section.append(node('p','settings-note','Nenhuma categoria disponível neste catálogo.'));return;}
    const all=this.getProviderCategoryItems(this.type,category.id),label=this.type==='live'?'canais':'títulos';
    section.append(node('h3','',category.name),node('p','settings-note',`Remova ${label} desta lista para organizar seu catálogo. Você pode restaurá-los a qualquer momento.`));
    if(![...(category.ids||[category.id])].every(id=>this.isCategoryVisible(this.type,id)))section.append(node('p','settings-note','Esta categoria está oculta ou parcialmente oculta. Marque sua caixa à esquerda para exibir seus títulos.'));
    const summary=node('p','settings-counter'),actions=node('div','settings-actions'),restore=button('Restaurar removidos desta categoria',()=>{this.restoreCategoryItems(this.type,category.id);updateSummary();drawItems();},'button secondary compact');actions.append(restore);section.append(summary,actions);
    const search=node('input','settings-search');search.type='search';search.placeholder=this.type==='live'?'Buscar canal nesta categoria':'Buscar título nesta categoria';search.setAttribute('aria-label',search.placeholder);search.value=this.providerQuery;
    const items=node('div','settings-item-list settings-provider-items'),progress=node('p','settings-counter'),more=button('Mostrar mais',()=>{this.providerLimit+=80;drawItems();},'button secondary compact');section.append(search,items,progress,more);
    const drawItems=()=>{
      items.replaceChildren();const removed=all.filter(item=>!this.isItemVisible(this.type,item.id)).length,matches=all.filter(item=>normalize(item.name).includes(normalize(this.providerQuery))),visible=all.filter(item=>this.isCatalogItemVisible(this.type,item)).length;
      summary.textContent=`${visible.toLocaleString('pt-BR')} de ${all.length.toLocaleString('pt-BR')} ${label} visíveis · ${removed.toLocaleString('pt-BR')} removidos`;restore.disabled=removed===0;
      for(const item of matches.slice(0,this.providerLimit)){
        const available=this.isItemVisible(this.type,item.id),row=node('div','settings-group-row settings-provider-item');row.classList.toggle('is-hidden',!available);row.dataset.itemId=String(item.id);
        const title=node('span','settings-group-open',item.name),toggle=button(available?'Remover':'Restaurar',()=>{this.setItemVisible(this.type,item.id,!available);updateSummary();drawItems();},'settings-remove');toggle.setAttribute('aria-label',`${available?'Remover':'Restaurar'} ${item.name}`);
        row.append(title,toggle);items.append(row);
      }
      if(!matches.length)items.append(node('p','settings-note','Nenhum título encontrado nesta categoria.'));
      progress.textContent=matches.length?`${Math.min(this.providerLimit,matches.length).toLocaleString('pt-BR')} de ${matches.length.toLocaleString('pt-BR')} ${label}`:'';more.hidden=matches.length<=this.providerLimit;
    };
    search.addEventListener('input',()=>{this.providerQuery=search.value;this.providerLimit=80;drawItems();});drawItems();
  }
  renderPersonalGroups(groups,catalog){
    groups.append(node('h3','','Categorias pessoais'));const currentGroups=this.groups.filter(group=>group.type===this.type);
    for(const group of currentGroups){const row=node('div','settings-group-row');row.dataset.groupId=group.id;row.append(button(`${group.name} · ${group.itemKeys.length}`,()=>{this.editing=group.id;this.query='';this.render();},'settings-group-open'),button('Remover',()=>{this.trash.push(group);this.groups=this.groups.filter(entry=>entry.id!==group.id);if(this.editing===group.id)this.editing=null;this.persist();this.render();},'settings-remove'));groups.append(row);}
    if(this.trash.length)groups.append(button('Desfazer remoção',()=>{this.groups.push(this.trash.pop());this.persist();this.render();},'button secondary compact'));
    const selected=this.groups.find(group=>group.id===this.editing&&group.type===this.type);if(!selected){groups.append(node('p','settings-note',currentGroups.length?'Selecione uma categoria salva para organizar seus títulos.':'Nenhuma categoria pessoal salva.'));return;}
    const editor=node('div','settings-group-editor');groups.append(editor);
    const rename=node('form','settings-create-group'),renameInput=node('input','settings-search');renameInput.value=selected.name;renameInput.maxLength=60;renameInput.setAttribute('aria-label','Renomear grupo');const renameSubmit=node('button','button secondary compact','Renomear');renameSubmit.type='submit';rename.append(renameInput,renameSubmit);rename.addEventListener('submit',event=>{event.preventDefault();const value=renameInput.value.trim();if(value){selected.name=value;this.persist();this.render();}});editor.append(rename);
    const itemSearch=node('input','settings-search');itemSearch.type='search';itemSearch.placeholder='Buscar título para adicionar';itemSearch.setAttribute('aria-label','Buscar título para adicionar ao grupo');itemSearch.value=this.query;editor.append(itemSearch);
    const favoriteLabel=node('label','settings-check'),favoriteCheck=node('input');favoriteCheck.type='checkbox';favoriteCheck.checked=this.onlyFavorites;favoriteLabel.append(favoriteCheck,node('span','','Somente minha lista'));editor.append(favoriteLabel);
    const selectionCount=node('p','settings-counter',`${selected.itemKeys.length} selecionados · limite de 500 por grupo`),items=node('div','settings-item-list');editor.append(selectionCount,items);
    const drawItems=()=>{items.replaceChildren();const favorites=this.options.getFavorites(),favoriteKeys=new Set((favorites instanceof Map?[...favorites.values()]:Array.isArray(favorites)?favorites:[]).map(itemKey));const matches=(catalog.items||[]).filter(item=>(!this.onlyFavorites||favoriteKeys.has(itemKey(item)))&&normalize(item.name).includes(normalize(this.query)));for(const item of matches.slice(0,80)){const key=itemKey(item),row=node('label','settings-check'),check=node('input');check.type='checkbox';check.checked=selected.itemKeys.includes(key);check.addEventListener('change',()=>{if(check.checked){if(selected.itemKeys.length>=500){check.checked=false;this.options.toast('O grupo chegou ao limite de 500 títulos.');return;}if(!selected.itemKeys.includes(key))selected.itemKeys.push(key);}else selected.itemKeys=selected.itemKeys.filter(value=>value!==key);this.persist();const selectedRow=[...groups.querySelectorAll(".settings-group-row")].find(row=>row.dataset.groupId===selected.id);if(selectedRow)selectedRow.firstElementChild.textContent=`${selected.name} · ${selected.itemKeys.length}`;selectionCount.textContent=`${selected.itemKeys.length} selecionados · limite de 500 por grupo`;});row.append(check,node('span','',item.name));items.append(row);}if(matches.length>80)items.append(node('p','settings-note','Mostrando os primeiros 80 resultados. Use a busca para encontrar outros títulos.'));if(!matches.length)items.append(node('p','settings-note','Nenhum título encontrado.'));};
    itemSearch.addEventListener('input',()=>{this.query=itemSearch.value;drawItems();});favoriteCheck.addEventListener('change',()=>{this.onlyFavorites=favoriteCheck.checked;drawItems();});drawItems();
  }
}
