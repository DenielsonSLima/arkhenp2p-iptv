import {movieScopeKey} from './scope.js';
import {movieRecommendationQueryKey} from './recomendacoes/modelo.js';
export {MovieRecommendationsModel} from './recomendacoes/modelo.js';

export const movieQueryKeys=Object.freeze({
  recommendations:movieRecommendationQueryKey,
  favorites:scope=>['arkhen-movies','favorites',movieScopeKey(scope)],
  progress:scope=>['arkhen-movies','progress',movieScopeKey(scope)]
});
