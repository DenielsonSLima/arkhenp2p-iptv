export function selectRecentMovieShelf(context){
  const items=context.recent('movie');
  return items.length?{key:'home:movie-history',title:'Últimos filmes assistidos',type:'movies',items}:null;
}
