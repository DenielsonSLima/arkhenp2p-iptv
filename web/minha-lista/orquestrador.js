export class MyListOrchestrator{
  constructor({services,getLimit=()=>48,ui}={}){Object.assign(this,{services,getLimit,ui});}
  items(){return this.services.items();}
  render(container,items=this.items()){
    const {node,formatNumber,renderCards,renderLive,reconcileChildren,renderCatalogStatus}=this.ui,limit=this.getLimit();
    let shown=0;const sections=[];
    for(const [kind,title] of [['live','TV ao vivo'],['movie','Filmes'],['series','Séries']]){
      const values=items.filter(item=>item.kind===kind);if(!values.length)continue;
      let section=[...container.children].find(element=>element.dataset.favoriteKind===kind);
      if(!section){section=node('section','favorite-section');section.dataset.favoriteKind=kind;if(kind!=='live'||!renderLive){const heading=node('div','live-grid-title');heading.append(node('h2','',title),node('span'));section.append(heading);}section.append(node('div',kind==='live'&&renderLive?'favorite-tv-guide-host':kind==='live'?'live-grid':'poster-grid'));}
      const count=section.querySelector('.live-grid-title>span');if(count)count.textContent=`${formatNumber(values.length)} favoritos`;
      const visible=values.slice(0,limit);shown+=visible.length;if(kind==='live'&&renderLive)renderLive(section.lastElementChild,visible);else renderCards(section.lastElementChild,visible);sections.push(section);
    }
    reconcileChildren(container,sections);
    renderCatalogStatus(items,{shown,more:['live','movie','series'].some(kind=>items.filter(item=>item.kind===kind).length>limit)});
  }
}
