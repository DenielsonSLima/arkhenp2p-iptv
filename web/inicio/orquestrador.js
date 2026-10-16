import {HomeServices} from './services.js';
import {HomeCloudModel} from './tanstack-query.js';
import {HomeRealtime} from './realtime.js';
import {cloudHomeSections} from './secoes.js';
import {latestReleases,HOME_SHELF_LIMIT} from './ordens.js';
import {featuredTitles} from './bannerprincipal/selecao.js';
import {HeroRotation} from './bannerprincipal/rotacao.js';
import {ShelfCarousels} from './carrosseis.js';
import {homeRecommendationState,renderHomeRecommendationsState} from './recomendados/estado.js';
import {sortCatalogItems} from '../catalog-sort.js';

/** Home owns its projection, six shelves and animation clocks. The banner's
 * optional detail lookup and shared media/Auth remain application callbacks. */
export class HomeOrchestrator{
  constructor({request,services,model,getScope=()=>null,getRevision=()=>'',onChange=()=>{},getState=()=>({}),ui={},
    renderHero=()=>{},ensureArtwork=()=>{},isAvailable=()=>false,recover=()=>{}}={}){
    Object.assign(this,{getScope,getState,ui,renderHero,ensureArtwork,isAvailable,recover});
    this.services=services||new HomeServices({request:request||model?.request,getScope});
    this.model=model||new HomeCloudModel({services:this.services,getScope,getRevision,onChange});
    if(model)model.request=this.services.api;
    this.projection=null;this.offlineCatalogs=new WeakMap();this.heroRotation=null;this.carousels=null;
    this.realtime=new HomeRealtime({model:this.model,getScope,invalidate:()=>this.invalidate()});
  }
  orderedCatalogs(){
    const prepared=new Map(),catalogs=this.getState().catalogs||new Map();
    for(const [type,catalog] of catalogs){
      if(catalog.readModel){prepared.set(type,catalog);continue;}
      let fallback=this.offlineCatalogs.get(catalog);
      if(!fallback){
        const items=catalog.items||[],releases=type==='live'?[]:latestReleases(items,items.length),featured=type==='live'?[]:
          featuredTitles(type==='movies'?items:[],type==='series'?items:[],{perType:36});
        fallback={...catalog,readModel:{orders:{name:sortCatalogItems(items,'name').map(item=>item.id),releases:releases.map(item=>item.id),featured:featured.map(item=>item.id)}}};
        this.offlineCatalogs.set(catalog,fallback);
      }
      prepared.set(type,fallback);
    }
    return prepared;
  }
  sections(){
    const state=this.getState(),scope=JSON.stringify(this.getScope()),catalogs=state.catalogs||new Map(),data=this.model.state.data;
    const sources=['live','movies','series'].map(type=>catalogs.get(type));
    if(this.projection?.scope===scope&&this.projection.revision===state.libraryRevision&&this.projection.data===data&&sources.every((source,index)=>source===this.projection.sources[index]))return this.projection.sections;
    const history=new Map([...(state.history||[])].filter(([,entry])=>!entry.libraryId||entry.libraryId===state.account));
    const sections=cloudHomeSections({catalogs:this.orderedCatalogs(),privateModel:data,favorites:state.favorites,history,
      excludedHistory:state.excludedHistory,visible:this.ui.isVisible,resolve:this.ui.resolveItem});
    this.projection={scope,sources,data,revision:state.libraryRevision,sections};return sections;
  }
  ensure(options){if(this.isAvailable())this.model.ensure(options);}
  invalidate(){this.projection=null;}
  render(container){
    const state=this.getState(),ui=this.ui,catalogs=state.catalogs||new Map();
    this.ensureArtwork();if(!state.settingsOpen&&!state.contentOpen)this.ensure();
    ui.hideCategoryBar?.();ui.clearResultCount?.();
    const sections=[],existing=new Map([...container.children].map(element=>[element.dataset.shelfKey,element]));
    const addShelf=(title,subtitle,items,type,key=`home:${type}:${title}`)=>{
      const section=ui.shelf(title,subtitle,items,type,existing.get(key));section.dataset.shelfKey=key;sections.push(section);
    };
    const channels=ui.renderChannels?.(existing.get('home:live'));if(channels)sections.push(channels);
    for(const section of this.sections())addShelf(section.title,section.subtitle||'',section.items,section.type,section.key);
    if(!sections.some(section=>section.dataset.shelfKey==='home:recommendations')&&(catalogs.has('movies')||catalogs.has('series'))){
      const key='home:recommendations-status',status=homeRecommendationState({...this.model.state,available:this.isAvailable()});
      sections.push(renderHomeRecommendationsState(existing.get(key),{state:status,onRetry:()=>{
        if(!this.isAvailable())this.recover();this.model.ensure({force:true});ui.renderPage?.();
      }}));
    }
    if(!sections.length&&state.loading?.size){const skeleton=existing.get('__loading')||ui.skeletons();skeleton.dataset.shelfKey='__loading';sections.push(skeleton);}
    for(const group of state.customGroups||[]){
      const data=catalogs.get(group.type);if(!data)continue;
      const items=(group.itemKeys||[]).map(key=>data.itemMap.get(String(key).slice(String(key).indexOf(':')+1)))
        .filter(item=>item&&(!ui.isVisible||ui.isVisible(item))).slice(0,HOME_SHELF_LIMIT);
      if(items.length)addShelf(group.name,'SELECIONADO POR VOCÊ',items,group.type,`custom:${group.id}`);
    }
    if(!sections.length){
      const hiddenType=['movies','series','live'].find(type=>ui.catalogHiddenBySettings?.(type)),error=[...(state.failures?.values?.()||[])][0];
      sections.push(hiddenType?ui.emptyState('Seu catálogo está oculto','Suas preferências ocultam os títulos carregados. Escolha o que mostrar em Configurações.',
        {label:'Organizar catálogo',run:()=>ui.openCatalogSettings?.(hiddenType)}):
        ui.emptyState(error?'Seu catálogo está a um passo':'Seu universo está começando',error||'O serviço ainda não retornou conteúdo para explorar.',
          {label:'Tentar novamente',run:ui.refreshCatalog}));
    }
    ui.reconcileChildren(container,sections);ui.syncChannels?.();this.carousels?.sync(container);this.renderHero();
  }
  createHeroRotation(options){this.heroRotation?.stop();return this.heroRotation=new HeroRotation(options);}
  createCarousels(options){this.carousels?.destroy();return this.carousels=new ShelfCarousels(options);}
  onLibraryChange(snapshot,changes){return this.realtime.libraryUpdated(snapshot,changes);}
  onSharedUpdate(event){return this.realtime.sharedUpdated(event);}
  onCloudStatus(status,previous){return this.realtime.statusChanged(status,previous);}
  reset({stopAnimations=true}={}){this.invalidate();this.offlineCatalogs=new WeakMap();this.realtime.reset();this.services.reset();this.model.reset();if(stopAnimations)this.heroRotation?.stop();this.carousels?.sync(null);}
  dispose(){this.reset();this.realtime.dispose();this.services.dispose();this.model.dispose();this.carousels?.destroy();}
}
