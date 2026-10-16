import {previewTitle,previewText,previewYear,previewRating} from '../preview-tools.js';
import {movieWithPlaybackDuration} from './duracao.js';

/** Real provider fields and a previously measured duration form the preview
 * view model. No release date, rating or runtime is fabricated when absent. */
export function movieMetadata(item,{previousDuration}={}){
  const movie=movieWithPlaybackDuration(item,previousDuration);
  return {item:movie,title:previewTitle(movie.name),year:previewYear(movie),rating:previewRating(movie),duration:previewText(movie.duration)||'Não informada'};
}
