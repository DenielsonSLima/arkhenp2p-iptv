import {movieRecommendationsRequest} from './recomendacoes-request.mjs';
import {normalizeCatalogSearch} from '../catalog-search-request.mjs';
import {catalogGenres} from '../../web/catalog-genres.js';
import {isAdultItem} from '../../web/parental-classification.js';

const ID=/^[A-Za-z0-9_-]{1,160}$/;
const list=value=>Array.isArray(value)?value:[];
const order=new Intl.Collator('pt-BR',{sensitivity:'base',numeric:true});
const abort=()=>new DOMException('A consulta foi cancelada.','AbortError');
const check=signal=>{if(signal?.aborted)throw abort();};
const clean=(value,max=1000)=>typeof value==='string'||typeof value==='number'
  ?String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').replace(/https?:\/\/[^\s<>"']+/gi,'').slice(0,max):'';
const id=value=>ID.test(String(value??''))?String(value):'';
const categoryIds=item=>[...new Set([item.categoryId,...list(item.categoryIds)].map(id).filter(Boolean))];
const artwork=value=>typeof value==='string'&&(
  /^\/api\/image\?ref=[A-Za-z0-9_-]{1,200}$/.test(value)
  ||/^\/api\/shared-image\/[a-f0-9]{64}$/.test(value)
  ||/^\/api\/shared-image\?ref=[a-f0-9]{64}$/.test(value)
  ||/^\/assets\/[A-Za-z0-9_./-]+$/.test(value)&&!value.includes('..'))?value:'';
const year=item=>clean(item.year,20).match(/(?:19|20)\d{2}/)?.[0]||'';
const title=item=>normalizeCatalogSearch(item.name).replace(/\b(?:2160p|1080p|720p|4k|uhd|fhd|hd|sd|hevc|h[ .-]?26[45]|dublado|legendado|dual audio)\b/g,' ').replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');
const imdb=item=>typeof item.imdbId==='string'&&/^tt\d{6,10}$/.test(item.imdbId)?item.imdbId:'';
const tmdb=item=>Number.isSafeInteger(Number(item.tmdbId))&&Number(item.tmdbId)>0?Number(item.tmdbId):null;
const rating=item=>item.rating!==null&&item.rating!==undefined&&item.rating!==''&&Number.isFinite(Number(item.rating))&&Number(item.rating)>=0&&Number(item.rating)<=10?Number(item.rating):-1;
const genericCategory=name=>/^(?:(?:filmes?|movies)\s+)?(?:geral|todos|todos os filmes|filmes?|movies|lancamentos|recentes|favoritos|sd|hd|fhd|uhd|4k|8k|hevc|dublados?|legendados?|dual(?: audio)?)$/.test(normalizeCatalogSearch(name).replace(/[^a-z0-9]+/g,' ').trim());

function publicMovie(raw,categories){
  const mediaId=id(raw?.id),name=clean(raw?.name);
  if(raw?.kind!=='movie'||!mediaId||!name.trim()||isAdultItem(raw,categories))return null;
  const ids=categoryIds(raw),item={id:mediaId,kind:'movie',name,categoryId:ids[0]||'',categoryIds:ids,
    poster:artwork(raw.poster),backdrop:artwork(Array.isArray(raw.backdrop)?raw.backdrop[0]:raw.backdrop),
    year:clean(raw.year,20),genre:clean(raw.genre,10000),group:clean(raw.group),
    groupNames:list(raw.groupNames).map(value=>clean(value,300)).filter(Boolean).slice(0,200),
    plot:clean(raw.plot,20000),added:clean(raw.added,80),isAdult:false};
  if(rating(raw)>=0)item.rating=rating(raw);
  if(imdb(raw))item.imdbId=imdb(raw);
  if(tmdb(raw))item.tmdbId=tmdb(raw);
  if(/^[a-z0-9]{1,12}$/i.test(raw.container||''))item.container=raw.container;
  if(Number.isFinite(raw.durationSeconds)&&raw.durationSeconds>0&&raw.durationSeconds<=86400)item.durationSeconds=raw.durationSeconds;
  if(typeof raw.duration==='string')item.duration=clean(raw.duration,80);
  return item;
}

function sameMovie(source,candidate){
  if(String(source.id)===String(candidate.id)||imdb(source)&&imdb(source)===imdb(candidate)||tmdb(source)&&tmdb(source)===tmdb(candidate))return true;
  return title(source)===title(candidate)&&(!year(source)||!year(candidate)||year(source)===year(candidate));
}

/** A provider/session-scoped alternative, never a personal-history model.
 * Only already loaded metadata is read; missing coverage remains unavailable. */
export class SessionMovieRecommendations{
  constructor({catalogSearch}={}){this.catalogSearch=catalogSearch;}
  recommend(state,request={}, {signal}={}){
    const input=movieRecommendationsRequest(request);check(signal);
    const data=this.catalogSearch?.metadataSnapshot(state?.client,'movies');
    if(!Array.isArray(data?.items)||!Array.isArray(data.categories))return null;
    const hidden=new Set(input.hidden.movies||[]),hiddenItems=new Set(input.hiddenItems.movies||[]);
    const visible=item=>!hiddenItems.has(String(item.id))&&!(categoryIds(item).length&&categoryIds(item).every(value=>hidden.has(value)));
    const source=data.items.find(item=>item?.kind==='movie'&&String(item.id)===input.id);
    if(!source||!visible(source)||!publicMovie(source,data.categories))return null;
    const complete=data.catalogComplete===true&&data.preparing!==true&&data.pagination?.complete!==false&&data.pagination?.preparing!==true
      ||!data.pagination&&data.catalogComplete!==false&&data.preparing!==true;
    const genres=catalogGenres(data),sourceGenres=new Set(genres.genreIdsFor(source)),trustedCategories=new Set();
    for(const category of [...list(data.sourceCategories),...data.categories]){
      if(!clean(category?.name).trim()||genericCategory(category.name))continue;
      for(const value of [category.id,...(category.ids instanceof Set?[...category.ids]:list(category.ids))])if(id(value))trustedCategories.add(id(value));
    }
    const sourceCategories=new Set(categoryIds(source).filter(value=>trustedCategories.has(value))),ranked=[];
    let invalid=false;
    for(const raw of data.items){
      check(signal);
      if(raw?.kind!=='movie'||!id(raw.id)||!clean(raw.name).trim()){invalid=true;continue;}
      if(!visible(raw)||isAdultItem(raw,data.categories)||sameMovie(source,raw))continue;
      const sharedGenres=genres.genreIdsFor(raw).filter(value=>sourceGenres.has(value)).length;
      const sharedCategory=categoryIds(raw).some(value=>sourceCategories.has(value));
      ranked.push({raw,sharedGenres,sharedCategory,rating:rating(raw)});
    }
    check(signal);
    // A similarity label only covers actual matching metadata. Do not fill a
    // genre shelf with unrelated titles when its matching subset is short.
    const hasGenre=ranked.some(row=>row.sharedGenres>0),hasCategory=ranked.some(row=>row.sharedCategory);
    const candidates=ranked.filter(row=>hasGenre?row.sharedGenres>0:hasCategory?row.sharedCategory:true)
      .sort((a,b)=>b.sharedGenres-a.sharedGenres||Number(b.sharedCategory)-Number(a.sharedCategory)||b.rating-a.rating||Number(year(b.raw)||0)-Number(year(a.raw)||0)||order.compare(a.raw.name,b.raw.name)||order.compare(String(a.raw.id),String(b.raw.id)));
    const items=[],seen=[];
    for(const candidate of candidates){
      if(seen.some(previous=>sameMovie(previous,candidate.raw)))continue;
      const item=publicMovie(candidate.raw,data.categories);if(!item)continue;
      seen.push(candidate.raw);items.push(item);if(items.length===input.limit)break;
    }
    const full=complete&&!invalid;
    if(!items.length&&!full)return null;
    return {schemaVersion:1,sourceId:input.id,items,source:'loaded-catalog',personalized:false,
      reason:hasGenre?'source_genre':hasCategory?'source_category':'loaded_catalog',
      complete:full,partial:!full,loadedItems:data.items.length,
      revision:data.pagination?.snapshotId||data.snapshotId||null};
  }
}
