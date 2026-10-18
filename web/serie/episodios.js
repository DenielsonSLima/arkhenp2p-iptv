import {previewNode,previewText,previewButton} from '../preview-tools.js';
import {providedSeriesSeasons,seasonNumber} from './temporadas.js';
import {episodeThumbnail} from './capa.js';
import {episodePlaybackProgress} from './progresso.js';

export function allSeriesEpisodes(data){return providedSeriesSeasons(data).flatMap(season=>season.episodes);}

export function renderSeasonPanel(tools,item,{activeSeason=0,onSeason,onEpisode,readEpisodeProgress,historyEntry}={}){
  const seasons=providedSeriesSeasons(item).filter(season=>season.episodes.length),section=previewNode('section','detail-episodes'),heading=previewNode('div','episode-heading');heading.append(previewNode('h3','','Episódios'));section.append(heading);
  if(!seasons.length){section.append(previewNode('p','detail-error',item.loading?'Carregando episódios…':item.unavailable?'Este título não está disponível no catálogo atual.':item.error?'Não foi possível carregar os episódios. Tente novamente acima.':'Os episódios ainda não foram disponibilizados pelo serviço.'));return {section,activeSeason:0};}
  if(activeSeason>=seasons.length||activeSeason<0)activeSeason=0;
  const tabs=previewNode('div','season-tabs');tabs.setAttribute('aria-label','Temporadas');
  seasons.forEach((season,index)=>{const tab=previewButton(season.name||`Temporada ${season.number}`,'season-tab',()=>onSeason(index));tab.dataset.seasonIndex=String(index);tab.classList.toggle('active',index===activeSeason);tab.setAttribute('aria-pressed',String(index===activeSeason));tabs.append(tab);});section.append(tabs);
  const list=previewNode('div','episode-list');
  for(const episode of seasons[activeSeason].episodes){
    const number=seasonNumber(episode.number),play=previewButton('','episode-button',()=>onEpisode(episode));play.dataset.episodeId=episode.id;
    const thumbnail=episodeThumbnail(tools,episode,item),copy=previewNode('span','episode-copy');
    const title=previewText(episode.title)||(number===null?'Episódio':`Episódio ${number}`),identity=`Temporada ${episode.season}${number===null?'':` · Episódio ${number}`}`;
    copy.append(previewNode('strong','',title),previewNode('small','',identity));
    let saved;try{saved=readEpisodeProgress?.(item,episode);}catch{/* Local history is optional. */}
    const progress=episodePlaybackProgress(item,episode,saved??historyEntry);
    if(progress){
      const row=previewNode('span','episode-progress'),caption=previewNode('span','episode-progress-caption');
      const time=progress.total?`${progress.elapsed} / ${progress.total}`:progress.time>0?`${progress.elapsed} assistidos`:'Duração não informada';
      caption.append(previewNode('span','episode-progress-state',progress.label),previewNode('span','episode-progress-time',time));row.append(caption);
      if(progress.duration!==null){const bar=previewNode('progress','episode-progress-bar');bar.max=progress.duration;bar.value=progress.time;bar.setAttribute('aria-label',`Progresso de ${identity}`);bar.setAttribute('aria-valuetext',`${progress.elapsed} assistidos de ${progress.total}`);row.append(bar);}
      copy.append(row);play.dataset.progressState=progress.state;
      play.setAttribute('aria-label',`${title}. ${identity}. ${progress.label}. ${time}`);
    }
    play.append(previewNode('span','episode-number',number===null?'—':String(number).padStart(2,'0')),thumbnail,copy);list.append(play);
  }
  section.append(list);return {section,activeSeason};
}
