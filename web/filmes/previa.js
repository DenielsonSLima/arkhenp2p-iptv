import {previewNode,previewFact} from '../preview-tools.js';
import {renderDetailProgress} from '../detail-progress.js';
import {movieMetadata} from './titulo.js';

export function renderMoviePreview(tools,item,{continuing=false,previousDuration,historyEntry,durationPending=false,relatedSection=null}={}){
  const metadata=movieMetadata(item,{previousDuration}),movie=metadata.item,{showcase,summary}=tools.begin({...movie,name:metadata.title},'FILME'),facts=previewNode('div','detail-facts'),duration=previewFact('Duração',metadata.duration,'detail-fact-duration');
  duration.setAttribute('aria-busy',String(durationPending));facts.append(previewFact('Ano',metadata.year),duration,previewFact('Avaliação',metadata.rating));summary.append(facts);
  tools.genre(summary,movie);tools.actions(summary,{continuing,enabled:!movie.unavailable});renderDetailProgress(summary,movie,historyEntry);tools.information(summary,movie);
  tools.finish(showcase,[relatedSection]);
}
