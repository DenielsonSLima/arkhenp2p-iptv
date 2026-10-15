// Shared by browser lookup and the server-side public-data importer. Provider
// IDs never stand in for an IMDb/TMDB identity; every alias is an exact title.
const freeze=value=>Object.freeze({...value,aliases:Object.freeze([...value.aliases])});
export const SERIES_MARKER_REGISTRY=Object.freeze([
  freeze({slug:'game-of-thrones',title:'Game of Thrones',year:2011,aliases:['Game of Thrones','Guerra dos Tronos'],tmdbId:1399,imdbId:'tt0944947'}),
  freeze({slug:'the-rings-of-power',title:'The Lord of the Rings: The Rings of Power',year:2022,aliases:['The Lord of the Rings: The Rings of Power','The Lord of the Rings The Rings of Power','The Rings of Power','O Senhor dos Anéis: Os Anéis de Poder','O Senhor dos Anéis Os Anéis de Poder','Os Anéis de Poder'],tmdbId:84773,imdbId:'tt7631058'}),
  freeze({slug:'imdb-tt2306299',title:'Vikings',year:2013,aliases:['Vikings'],tmdbId:44217,imdbId:'tt2306299'}),
  freeze({slug:'imdb-tt11311302',title:'Vikings: Valhalla',year:2022,aliases:['Vikings: Valhalla','Vikings Valhalla'],tmdbId:116135,imdbId:'tt11311302'}),
  freeze({slug:'imdb-tt0388629',title:'One Piece',year:1999,aliases:['One Piece'],tmdbId:37854,imdbId:'tt0388629'}),
  freeze({slug:'imdb-tt11737520',title:'One Piece',year:2023,aliases:['One Piece','ONE PIECE A Serie','ONE PIECE: A Série'],tmdbId:111110,imdbId:'tt11737520'}),
  freeze({slug:'house-of-the-dragon',title:'House of the Dragon',aliases:['House of the Dragon','A Casa do Dragão'],tmdbId:94997,imdbId:'tt11198330'}),
  freeze({slug:'breaking-bad',title:'Breaking Bad',aliases:['Breaking Bad','Breaking Bad: A Química do Mal','Breaking Bad: A Química do Mal L'],tmdbId:1396,imdbId:'tt0903747'}),
  freeze({slug:'stranger-things',title:'Stranger Things',aliases:['Stranger Things'],tmdbId:66732,imdbId:'tt4574334'}),
  freeze({slug:'the-last-of-us',title:'The Last of Us',aliases:['The Last of Us'],tmdbId:100088,imdbId:'tt3581920'}),
  freeze({slug:'the-boys',title:'The Boys',aliases:['The Boys'],tmdbId:76479,imdbId:'tt1190634'}),
  freeze({slug:'suits',title:'Suits',aliases:['Suits','Suits: Homens de Terno','Suits - Homens de Terno','Homens de Terno - Suits'],tmdbId:37680,imdbId:'tt1632701'}),
  freeze({slug:'dark',title:'Dark',aliases:['Dark'],tmdbId:70523,imdbId:'tt5753856'}),
  freeze({slug:'the-walking-dead',title:'The Walking Dead',aliases:['The Walking Dead'],tmdbId:1402,imdbId:'tt1520211'}),
  freeze({slug:'wednesday',title:'Wednesday',aliases:['Wednesday','Wandinha'],tmdbId:119051,imdbId:'tt13443470'}),
  freeze({slug:'reacher',title:'Reacher',aliases:['Reacher'],tmdbId:108978,imdbId:'tt9288030'}),
  freeze({slug:'better-call-saul',title:'Better Call Saul',aliases:['Better Call Saul'],tmdbId:60059,imdbId:'tt3032476'}),
  freeze({slug:'lost',title:'Lost',aliases:['Lost','Perdidos'],tmdbId:4607,imdbId:'tt0411008'})
]);

export const markerSeriesBySlug=slug=>typeof slug==='string'?SERIES_MARKER_REGISTRY.find(series=>series.slug===slug)||null:null;

/** A mapping read through the catalog partition's RLS is explicit identity
 * evidence. Provider IDs and approximate title matches never become IMDb. */
export function markerSeriesFromIdentity(row,item){
  if(item?.kind!=='series'||row?.status!=='resolved'||String(row.media_id)!==String(item.id)||!/^tt\d{6,10}$/.test(row.imdb_id||''))return null;
  const known=SERIES_MARKER_REGISTRY.find(series=>series.imdbId===row.imdb_id),slug=known?.slug||'imdb-'+row.imdb_id;
  if(row.series_slug!==slug)return null;
  const titleYear=String(item.name||row.catalog_name||'').match(/(?:-\s*|\()(19\d{2}|20\d{2})\)?(?:\s+(?:\((?:LEG|DUB|HD|FHD|4K)\)|\[(?:LEG|DUB|HD|FHD|4K)\]|LEG|DUB|HD|FHD|4K))*\s*$/i)?.[1];
  const years=[known?.year,item.year,row.catalog_metadata?.year,titleYear].map(Number).filter(value=>Number.isInteger(value)&&value>=1800&&value<=2200);
  if(new Set(years).size>1)return null;
  const tmdb=Number(row.tmdb_id),explicitIMDb=item.imdbId??item.imdb_id,explicitTMDB=item.tmdbId??item.tmdb_id;
  if(explicitIMDb!=null&&explicitIMDb!==row.imdb_id||explicitTMDB!=null&&Number(explicitTMDB)!==tmdb||known?.tmdbId&&row.tmdb_id!=null&&known.tmdbId!==tmdb)return null;
  const year=years[0]||null;
  return {slug,title:row.catalog_name||item.name,year,imdbId:row.imdb_id,tmdbId:Number.isSafeInteger(tmdb)&&tmdb>0?tmdb:null,aliases:[item.name,row.catalog_name].filter(value=>typeof value==='string'&&value.trim()),resolved:true};
}
