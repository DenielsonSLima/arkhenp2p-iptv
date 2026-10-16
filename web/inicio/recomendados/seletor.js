import {cloudFeaturedTitles} from '../bannerprincipal/selecao.js';

export function selectRecommendationShelf(context){
  const recommended=context.privateModel?.recommendations,hasPrivate=Array.isArray(recommended?.items);
  // A valid empty private result remains authoritative. Only an unavailable
  // projection may show the loaded, preordered non-personalized selection.
  const items=hasPrivate?context.unique(recommended.items):context.limit>0?
    context.unique(cloudFeaturedTitles(context.catalogs,{visible:context.visible,perType:Math.min(30,context.limit)})).slice(0,30):[];
  return items.length?{key:'home:recommendations',title:'Recomendados para você',type:'mixed',items,
    subtitle:!hasPrivate?'Seleção do catálogo carregado':recommended.personalized?'Com base no que você assiste':'Filmes e séries bem avaliados'}:null;
}
