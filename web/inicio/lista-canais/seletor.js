export function selectChannelShelf(context){
  const favorites=context.favoriteChannels(),recent=context.recent('live');
  const items=context.unique([...favorites,...recent,...(!favorites.length&&!recent.length?context.readOrder('live','name'):[])],{channels:true});
  return items.length?{key:'home:live',title:favorites.length?'Seus canais favoritos e recentes':recent.length?'Últimos canais assistidos':'TV ao vivo',type:'live',items}:null;
}
