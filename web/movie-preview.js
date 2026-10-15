import { previewNode, previewText, previewYear, previewRating, previewFact } from './preview-tools.js';
import { renderRelatedMovies } from './related-movies.js';
import { renderDetailProgress } from './detail-progress.js';

export function movieWithPlaybackDuration(item,previousDuration){
  if(previewText(item.duration))return item;
  const seconds=Number(item.durationSeconds)||Number(previousDuration);if(!Number.isFinite(seconds)||seconds<=0)return item;
  const minutes=Math.floor(seconds/60),hours=Math.floor(minutes/60),duration=hours?`${hours} h${minutes%60?' '+minutes%60+' min':''}`:minutes?`${minutes} min`:`${Math.round(seconds)} s`;
  return {...item,duration};
}
export function updateMovieDuration(tools,item,{previousDuration,historyEntry,durationPending=false}={}){
  const movie=movieWithPlaybackDuration(item,previousDuration),fact=tools.root.querySelector('.detail-fact-duration');
  if(fact){fact.querySelector('.detail-fact-value').textContent=previewText(movie.duration)||'Não informada';fact.setAttribute('aria-busy',String(durationPending));}
  const summary=tools.root.querySelector('.detail-summary');if(summary)renderDetailProgress(summary,movie,historyEntry);
}
export function renderMoviePreview(tools,item,{continuing=false,previousDuration,historyEntry,durationPending=false,relatedItems=[],renderCards}={}){
  const movie=movieWithPlaybackDuration(item,previousDuration),{showcase,summary}=tools.begin(movie,'FILME'),facts=previewNode('div','detail-facts'),duration=previewFact('Duração',previewText(movie.duration)||'Não informada','detail-fact-duration');
  duration.setAttribute('aria-busy',String(durationPending));facts.append(previewFact('Ano',previewYear(movie)),duration,previewFact('Avaliação',previewRating(movie)));summary.append(facts);
  tools.genre(summary,movie);tools.actions(summary,{continuing,enabled:!movie.unavailable});renderDetailProgress(summary,movie,historyEntry);tools.information(summary,movie);
  const related=renderCards?renderRelatedMovies(tools.root,movie,relatedItems,{renderCards}):null;tools.finish(showcase,[related]);
}
