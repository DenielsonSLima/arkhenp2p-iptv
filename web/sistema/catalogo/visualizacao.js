import {DAILY_GAMES_CATEGORY,ADULT_CATEGORY} from '../../catalog-navigation.js';

/** One catalogue layout, rendered with the selected tab's state. No loading,
 * Auth or per-tab catalogue copy is started while drawing a category. */
export class CatalogContentView{
  constructor({ui,features,pager,getGames,isUnlocked,isForeground,isHidden,onCategory,onSettings,onLoad,onRender}={}){
    Object.assign(this,{ui,features,pager,getGames,isUnlocked,isForeground,isHidden,onCategory,onSettings,onLoad,onRender});
  }
  render(container,{view,category,groups,items,catalog,limit,categorized,error:catalogError}={}){
    const {node,formatNumber,sidebar,renderCards,skeletons,emptyState,reconcileChildren,genreStrip,clearResultCount}=this.ui;
    const live=view==='live';
    if(!categorized){let grid=container.querySelector(':scope>.poster-grid');if(!grid){grid=node('div','poster-grid');container.replaceChildren(grid);}renderCards(grid,items.slice(0,limit));return;}
    let layout=container.querySelector('.catalog-layout');
    if(!layout){layout=node('div','live-layout catalog-layout');const body=node('div','category-results'),heading=node('div','live-grid-title');heading.append(node('h2'),node('span'));body.append(heading);layout.append(sidebar.create(groups),body);container.replaceChildren(layout);}
    sidebar.update(layout.querySelector('.catalog-sidebar'),groups);
    const body=layout.querySelector('.category-results'),heading=body.querySelector(':scope>.live-grid-title');
    heading.firstElementChild.textContent=groups.find(group=>group.id===category)?.name||(live?'Todos os canais':'Todos os títulos');
    heading.lastElementChild.textContent=category==='__favorites'?`${formatNumber(items.length)} ${items.length===1?'favorito':'favoritos'}`:this.features.get(view).count(items.length,catalog);
    const games=this.getGames?.(),gamesSelected=live&&category===DAILY_GAMES_CATEGORY&&games;heading.hidden=Boolean(gamesSelected);
    if(gamesSelected){clearResultCount();reconcileChildren(body,[heading,games.getSection()]);if(this.isForeground())games.mount(body);return false;}
    if(category===ADULT_CATEGORY&&!this.isUnlocked()){
      clearResultCount();heading.lastElementChild.textContent='Bloqueado';
      reconcileChildren(body,[heading,emptyState('Conteúdo protegido','Digite seu PIN para acessar a categoria Adulto nesta sessão.',{label:'Desbloquear',run:()=>void this.onCategory(ADULT_CATEGORY)})]);return false;
    }
    const pageError=this.pager.errorFor(view,category),pageLoading=this.pager.pendingFor(view,category),error=pageError||catalogError;
    let grid=body.querySelector('.live-grid,.poster-grid');
    if(items.length){if(!grid)grid=node('div',live?'live-grid':'poster-grid');renderCards(grid,items.slice(0,limit));}
    else grid=pageLoading?skeletons(8):error?emptyState('Não foi possível carregar o catálogo',error,{label:'Tentar novamente',run:()=>{pageError?this.pager.load(view,category):this.onLoad(view,true);this.onRender();}})
      :this.isHidden(view)?emptyState('Este catálogo está oculto','Suas preferências ocultam os títulos carregados. Escolha o que mostrar em Configurações.',{label:'Organizar catálogo',run:()=>this.onSettings(view)})
      :category==='__favorites'?emptyState('Seus favoritos ficam aqui','Toque na estrela de um canal, filme ou série para guardar sua próxima sessão.')
      :emptyState('Esta categoria está vazia','Escolha outra categoria ou organize o que aparece no seu catálogo.',{label:'Organizar catálogo',run:()=>this.onSettings(view)});
    const genres=live||category===ADULT_CATEGORY?null:genreStrip(body);reconcileChildren(body,[genres,heading,grid].filter(Boolean));
  }
}
