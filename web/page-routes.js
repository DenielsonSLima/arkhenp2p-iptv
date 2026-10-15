const ID=/^\d{1,12}$/;
const CATALOG=/^#(home|live|movies|series|favorites)$/;
export function catalogView(hash){return CATALOG.exec(hash)?.[1]||null;}
export function restoreCatalogPosition(hash,...candidates){
  const route=catalogView(hash),saved=candidates.find(position=>position&&catalogView('#'+position.view)&&(!route||position.view===route));
  return {view:route||saved?.view||'home',category:saved?.category||'__all',genre:saved?.genre||'__all',query:saved?.query||'',visibleLimit:saved?.visibleLimit||48,scrollY:saved?.scrollY||0};
}
export function parseContentRoute(hash) {
  const match=/^#(preview|watch)\/(live|movie|series)\/(\d{1,12})(?:\/(\d{1,12}))?$/.exec(hash);
  if(!match)return null;
  const [,page,kind,id,episodeId]=match;
  if(page==='preview'&&(kind==='live'||episodeId)||episodeId&&(page!=='watch'||kind!=='series'))return null;
  return {page,kind,id,episodeId:episodeId||null};
}
export function contentRoute(page,item,episode) {
  const kind=item?.kind,id=String(item?.id??'');
  if(!['preview','watch'].includes(page)||!['live','movie','series'].includes(kind)||!ID.test(id)||page==='preview'&&kind==='live')throw new Error('Página de conteúdo inválida.');
  const episodeId=kind==='series'&&page==='watch'&&episode?String(episode.id):null;
  if(episodeId&&!ID.test(episodeId))throw new Error('Episódio inválido.');
  return `#${page}/${kind}/${id}${episodeId?'/'+episodeId:''}`;
}
export function fallbackContentRoute(route) {
  if(route?.page==='watch'&&route.kind==='live')return '#live';
  return route?.page==='watch'&&['movie','series'].includes(route.kind)?contentRoute('preview',route):'#home';
}
