export function selectMovieReleaseShelf(context){
  const items=context.readOrder('movies','releases');
  return items.length?{key:'home:movie-releases',title:'Lançamentos de filmes',type:'movies',items}:null;
}
