import {homeProjectionContext} from './projecao.js';
import {selectRecentMovieShelf} from './ultimosfilmes/seletor.js';
import {selectMovieReleaseShelf} from './lancamentosfilmes/seletor.js';
import {selectRecentSeriesShelf} from './ultimasseries/seletor.js';
import {selectSeriesReleaseShelf} from './lancamentosseries/seletor.js';
import {selectRecommendationShelf} from './recomendados/seletor.js';
export {readHomeOrder} from './projecao.js';

const selectors=[selectRecentMovieShelf,selectMovieReleaseShelf,selectRecentSeriesShelf,selectSeriesReleaseShelf,selectRecommendationShelf];
export function cloudHomeSections(options={}){
  const context=homeProjectionContext(options);return selectors.map(select=>select(context)).filter(Boolean);
}
