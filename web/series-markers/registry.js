// Shared by browser lookup and the server-side public-data importer. Provider
// IDs never stand in for an IMDb/TMDB identity; every alias is an exact title.
const freeze=value=>Object.freeze({...value,aliases:Object.freeze([...value.aliases])});
export const SERIES_MARKER_REGISTRY=Object.freeze([
  freeze({slug:'game-of-thrones',title:'Game of Thrones',aliases:['Game of Thrones','Guerra dos Tronos'],tmdbId:1399,imdbId:'tt0944947'}),
  freeze({slug:'the-rings-of-power',title:'The Lord of the Rings: The Rings of Power',aliases:['The Lord of the Rings: The Rings of Power','The Lord of the Rings The Rings of Power','The Rings of Power','O Senhor dos Anéis: Os Anéis de Poder','O Senhor dos Anéis Os Anéis de Poder','Os Anéis de Poder'],tmdbId:84773,imdbId:'tt7631058'}),
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
