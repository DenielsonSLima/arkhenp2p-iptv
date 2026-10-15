import { previewNode, previewText, previewYear, previewRating, previewFact, previewButton } from './preview-tools.js';
import { renderDetailProgress } from './detail-progress.js';
import { episodePlaybackProgress } from './episode-progress.js';
import { artworkURL } from './channel-artwork.js';

export function episodeArtworkSources(episode,series){
  const seen=new Set(),sources=[];
  for(const [kind,values] of [['episode',[episode?.thumbnail,episode?.still,episode?.image,episode?.poster]],['series',[series?.backdrop,series?.poster]]]){
    for(const raw of values.flatMap(value=>Array.isArray(value)?value:[value])){
      const url=artworkURL(raw);if(!url||seen.has(url))continue;seen.add(url);sources.push({url,kind});
    }
  }
  return sources;
}
function episodeThumbnail(tools,episode,series){
  const thumbnail=previewNode('span','episode-thumbnail'),play=previewNode('span','episode-play');play.append(tools.icon('play'));thumbnail.setAttribute('aria-hidden','true');
  const sources=episodeArtworkSources(episode,series);thumbnail.dataset.artworkKind=sources[0]?.kind||'placeholder';
  if(sources.length){
    const image=previewNode('img','episode-thumbnail-image'),caption=previewNode('span','episode-thumbnail-caption');let index=0;
    image.alt='';image.loading='lazy';image.decoding='async';
    const apply=()=>{const source=sources[index];thumbnail.dataset.artworkKind=source?.kind||'placeholder';caption.textContent=source?.kind==='series'?'Imagem da série':'';caption.hidden=!caption.textContent;if(source){image.src=source.url;image.hidden=false;}else image.hidden=true;};
    image.addEventListener('error',()=>{index++;apply();});apply();thumbnail.append(image,caption);
  }
  thumbnail.append(play);return thumbnail;
}

function seasonNumber(value){
  if(typeof value!=='number'&&!(typeof value==='string'&&/^\d+$/.test(value)))return null;
  const number=Number(value);return Number.isSafeInteger(number)&&number>=0?number:null;
}
export function providedSeriesSeasons(data){
  const seasons=new Map(),seenEpisodes=new Set();
  for(const source of Array.isArray(data?.seasons)?data.seasons:[]){
    const number=seasonNumber(source?.number);if(number===null||!Array.isArray(source?.episodes))continue;
    if(!seasons.has(number))seasons.set(number,{...source,number,episodes:[]});
    for(const raw of source.episodes){
      const id=String(raw?.id??'');if(!raw||typeof raw!=='object'||!/^\d{1,12}$/.test(id)||seenEpisodes.has(id))continue;
      seenEpisodes.add(id);seasons.get(number).episodes.push({...raw,id,season:seasonNumber(raw.season)??number});
    }
  }
  return [...seasons.values()].sort((first,second)=>first.number-second.number);
}
export function computeSeriesStats(data){const seasons=providedSeriesSeasons(data);return {seasonCount:seasons.length,episodeCount:seasons.reduce((total,season)=>total+season.episodes.length,0)};}
export function allSeriesEpisodes(data){return providedSeriesSeasons(data).flatMap(season=>season.episodes);}

function seasonPanel(tools,item,{activeSeason=0,onSeason,onEpisode,readEpisodeProgress,historyEntry}={}){
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
export function renderSeriesPreview(tools,item,{continuing=false,historyEntry,activeSeason=0,onSeason,onEpisode,readEpisodeProgress}={}){
  const {showcase,summary}=tools.begin(item,'SÉRIE'),stats=computeSeriesStats(item),facts=previewNode('div','detail-facts detail-facts-series');
  const unavailable=item.loading?'Carregando…':item.error?'Indisponível':'';
  facts.append(previewFact('Ano',previewYear(item)),previewFact('Temporadas',unavailable||stats.seasonCount.toLocaleString('pt-BR')),previewFact('Episódios',unavailable||stats.episodeCount.toLocaleString('pt-BR')),previewFact('Avaliação',previewRating(item)));summary.append(facts);
  tools.genre(summary,item);tools.actions(summary,{continuing,enabled:stats.episodeCount>0});renderDetailProgress(summary,item,historyEntry);tools.information(summary,item);
  const panel=seasonPanel(tools,item,{activeSeason,onSeason,onEpisode,readEpisodeProgress,historyEntry});tools.finish(showcase,[panel.section]);return panel.activeSeason;
}
