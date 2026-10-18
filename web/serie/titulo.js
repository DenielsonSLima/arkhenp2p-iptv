import {previewTitle,previewYear,previewRating} from '../preview-tools.js';
import {computeSeriesStats} from './temporadas.js';

/** Preview fields describe the supplied series, never an episode runtime.
 * Counts retain the existing received-season contract; they do not rank a catalog. */
export function seriesMetadata(item){
  const stats=computeSeriesStats(item),unavailable=item.loading?'Carregando…':item.error?'Indisponível':'';
  return {item,title:previewTitle(item.name),year:previewYear(item),rating:previewRating(item),
    seasonCount:stats.seasonCount,episodeCount:stats.episodeCount,
    seasons:unavailable||stats.seasonCount.toLocaleString('pt-BR'),
    episodes:unavailable||stats.episodeCount.toLocaleString('pt-BR')};
}
