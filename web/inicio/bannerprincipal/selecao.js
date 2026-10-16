import {latestReleases,releaseYear} from '../ordens.js';
import {readHomeOrder} from '../projecao.js';
const list=value=>Array.isArray(value)?value:[];
const key=item=>`${item.kind}:${item.id}`;

function featuredByKind(items, kind, limit) {
  const recent = latestReleases(list(items).filter(item => item?.kind === kind), Math.max(limit, 36));
  const newestYear = releaseYear(recent[0]);
  const ready = recent.filter(item => releaseYear(item) >= newestYear - 1 && item.backdrop && item.poster && Number(item.rating) > 0);
  // Within the current release window, prefer titles with real artwork and
  // metadata over entries that only have a name. Keep distinct real titles.
  const selected = new Set();
  return [...ready, ...recent].filter(item => {const id = key(item);if (selected.has(id)) return false;selected.add(id);return true;}).slice(0, limit);
}
export function featuredMovies(items, limit = 3) {return featuredByKind(items,'movie',limit);}

export function featuredTitles(movies = [], series = [], {perType = 3} = {}) {
  const limit=Number.isFinite(Number(perType))?Math.max(0,Math.floor(Number(perType))):3;
  const films=featuredByKind(movies,'movie',limit), shows=featuredByKind(series,'series',limit), selected=[];
  for (let index=0;index<Math.max(films.length,shows.length);index++) {
    if (films[index]) selected.push(films[index]);
    if (shows[index]) selected.push(shows[index]);
  }
  return selected;
}


export function cloudFeaturedTitles(catalogs,{visible=()=>true,perType=3}={}){
  const movies=readHomeOrder(catalogs.get('movies'),'featured',{visible,limit:perType})||[],series=readHomeOrder(catalogs.get('series'),'featured',{visible,limit:perType})||[],items=[];
  for(let index=0;index<Math.max(movies.length,series.length);index++){if(movies[index])items.push(movies[index]);if(series[index])items.push(series[index]);}return items;
}
