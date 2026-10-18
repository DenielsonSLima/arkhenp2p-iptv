export function selectRecommendationShelf(context){
  const recommended=context.privateModel?.recommendations,hasPrivate=Array.isArray(recommended?.items);
  // This shelf belongs to its RPC. Outages use the explicit retry state,
  // never a catalogue/banner selection presented as recommendations.
  const items=hasPrivate?context.unique(recommended.items):[];
  return items.length?{key:'home:recommendations',title:'Recomendados para você',type:'mixed',items,
    subtitle:recommended.personalized?'Com base no que você assiste':'Filmes e séries bem avaliados'}:null;
}
