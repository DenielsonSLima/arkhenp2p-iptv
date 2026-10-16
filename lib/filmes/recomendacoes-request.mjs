import {catalogSearchRequest} from '../catalog-search-request.mjs';

export function movieRecommendationsRequest(value={}){
  const invalid=()=>Object.assign(new Error('Parâmetros de recomendações inválidos.'),{code:'MOVIE_RECOMMENDATIONS_INVALID_REQUEST',status:400});
  if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.id!=='string'||!/^[A-Za-z0-9_-]{1,160}$/.test(value.id))throw invalid();
  const limit=value.limit??10;
  if(!Number.isSafeInteger(limit)||limit<1||limit>10)throw invalid();
  let preferences;
  try{preferences=catalogSearchRequest({query:'movie',hidden:value.hidden,hiddenItems:value.hiddenItems});}catch{throw invalid();}
  return {id:value.id,limit,hidden:preferences.hidden,hiddenItems:preferences.hiddenItems};
}
