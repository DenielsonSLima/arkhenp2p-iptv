import {previewNode,previewFact} from '../preview-tools.js';
import {renderDetailProgress} from '../detail-progress.js';
import {seriesMetadata} from './titulo.js';
import {renderSeasonPanel} from './episodios.js';

export function renderSeriesPreview(tools,item,{continuing=false,historyEntry,activeSeason=0,onSeason,onEpisode,readEpisodeProgress}={}){
  const metadata=seriesMetadata(item),{showcase,summary}=tools.begin(metadata.item,'SÉRIE'),facts=previewNode('div','detail-facts detail-facts-series');
  facts.append(previewFact('Ano',metadata.year),previewFact('Temporadas',metadata.seasons),previewFact('Episódios',metadata.episodes),previewFact('Avaliação',metadata.rating));summary.append(facts);
  tools.genre(summary,item);tools.actions(summary,{continuing,enabled:metadata.episodeCount>0});renderDetailProgress(summary,item,historyEntry);tools.information(summary,item);
  const panel=renderSeasonPanel(tools,item,{activeSeason,onSeason,onEpisode,readEpisodeProgress,historyEntry});tools.finish(showcase,[panel.section]);return panel.activeSeason;
}
