import { previewNode, previewText, previewYear, previewRating, previewFact, previewButton } from './preview-tools.js';

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

function seasonPanel(tools,item,{activeSeason=0,onSeason,onEpisode}={}){
  const seasons=providedSeriesSeasons(item).filter(season=>season.episodes.length),section=previewNode('section','detail-episodes'),heading=previewNode('div','episode-heading');heading.append(previewNode('h3','','Episódios'));section.append(heading);
  if(!seasons.length){section.append(previewNode('p','detail-error',item.loading?'Carregando episódios…':item.unavailable?'Este título não está disponível no catálogo atual.':item.error?'Não foi possível carregar os episódios. Tente novamente acima.':'Os episódios ainda não foram disponibilizados pelo serviço.'));return {section,activeSeason:0};}
  if(activeSeason>=seasons.length||activeSeason<0)activeSeason=0;
  const tabs=previewNode('div','season-tabs');tabs.setAttribute('aria-label','Temporadas');
  seasons.forEach((season,index)=>{const tab=previewButton(season.name||`Temporada ${season.number}`,'season-tab',()=>onSeason(index));tab.dataset.seasonIndex=String(index);tab.classList.toggle('active',index===activeSeason);tab.setAttribute('aria-pressed',String(index===activeSeason));tabs.append(tab);});section.append(tabs);
  const list=previewNode('div','episode-list');
  for(const episode of seasons[activeSeason].episodes){
    const number=seasonNumber(episode.number),play=previewButton('','episode-button',()=>onEpisode(episode));play.dataset.episodeId=episode.id;
    const playSymbol=previewNode('span','episode-play');playSymbol.append(tools.icon('play'));const copy=previewNode('span','episode-copy');
    copy.append(previewNode('strong','',previewText(episode.title)||(number===null?'Episódio':`Episódio ${number}`)),previewNode('small','',`Temporada ${episode.season}${number===null?'':` · Episódio ${number}`}`));
    play.append(previewNode('span','episode-number',number===null?'—':String(number).padStart(2,'0')),playSymbol,copy);if(previewText(episode.duration))play.append(previewNode('span','episode-duration',previewText(episode.duration)));list.append(play);
  }
  section.append(list);return {section,activeSeason};
}
export function renderSeriesPreview(tools,item,{continuing=false,activeSeason=0,onSeason,onEpisode}={}){
  const {showcase,summary}=tools.begin(item,'SÉRIE'),stats=computeSeriesStats(item),facts=previewNode('div','detail-facts detail-facts-series');
  const unavailable=item.loading?'Carregando…':item.error?'Indisponível':'';
  facts.append(previewFact('Ano',previewYear(item)),previewFact('Temporadas',unavailable||stats.seasonCount.toLocaleString('pt-BR')),previewFact('Episódios',unavailable||stats.episodeCount.toLocaleString('pt-BR')),previewFact('Avaliação',previewRating(item)));summary.append(facts);
  tools.genre(summary,item);tools.actions(summary,{continuing,enabled:stats.episodeCount>0});tools.information(summary,item);
  const panel=seasonPanel(tools,item,{activeSeason,onSeason,onEpisode});tools.finish(showcase,[panel.section]);return panel.activeSeason;
}
