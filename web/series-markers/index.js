import {SERIES_MARKER_REGISTRY} from './registry.js';
export {SERIES_MARKER_REGISTRY} from './registry.js';
const normalized = value => String(value??'').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const titleIdentity = value => normalized(String(value??'').trim().replace(/(?:\s+(?:sd|hd|fhd|uhd|4k|hevc|leg|dub|dual))+\s*$/i,'').replace(/\s*(?:\((?:19|20)\d{2}\)|-\s*(?:19|20)\d{2})\s*$/,''));
const numeric = (value,min=1) => (typeof value==='number'||typeof value==='string'&&/^\d{1,6}$/.test(value))&&Number.isSafeInteger(Number(value))&&Number(value)>=min?Number(value):null;
const object = value => value&&typeof value==='object'&&!Array.isArray(value);
const durationValid = value => Number.isFinite(value)&&value>0&&value<=86400;
const safeID = value => typeof value==='string'&&/^[A-Za-z0-9_.-]{1,160}$/.test(value);
const fingerprint = value => typeof value==='string'&&/^[a-f0-9]{16}$/.test(value);
const sourceURL = value => {try{return typeof value==='string'&&new URL(value).protocol==='https:';}catch{return false;}};
const result = (status,extra={}) => ({status,markers:null,...extra});

export function resolveMarkerSeries(item,registry=SERIES_MARKER_REGISTRY){
  if(item?.kind!=='series')return null;
  const explicit=item.tmdbId??item.tmdb_id??item.externalIds?.tmdb??item.external_ids?.tmdb_id;
  const tmdbId=explicit==null?null:numeric(explicit);
  const imdb=item.imdbId??item.imdb_id??item.externalIds?.imdb??item.external_ids?.imdb_id;
  const byName=registry.find(series=>series.aliases.some(alias=>titleIdentity(alias)===titleIdentity(item.name)));
  const byIMDb=imdb==null?null:registry.find(series=>series.imdbId===imdb);
  if(imdb!=null&&(!byIMDb||byName&&byName.slug!==byIMDb.slug))return null;
  if(explicit!=null){
    if(tmdbId===null)return null;
    const byID=registry.find(series=>series.tmdbId!=null&&Number(series.tmdbId)===tmdbId);
    if(!byID||byName&&byName.slug!==byID.slug||byIMDb&&byIMDb.slug!==byID.slug)return null;
    return byID;
  }
  return byIMDb||byName||null;
}

export function markerEpisodeNumbers(episode){
  const season=numeric(episode?.season??episode?.seasonNumber??episode?.season_number,0);
  const number=numeric(episode?.number??episode?.episodeNumber??episode?.episode_number);
  return season!==null&&number!==null?{season,episode:number}:null;
}

function markersFor(value,duration,allowEmpty=false){
  if(!object(value)||!durationValid(duration))return null;
  const marks={};
  for(const name of ['openingStart','openingEnd','creditsStart'])if(Object.hasOwn(value,name)){
    const seconds=value[name];if(!Number.isFinite(seconds)||seconds<0||seconds>=duration||name!=='openingStart'&&seconds===0)return null;
    marks[name]=seconds;
  }
  if(marks.openingEnd!==undefined&&(marks.openingStart===undefined||marks.openingEnd<=marks.openingStart))return null;
  if(marks.creditsStart!==undefined&&marks.creditsStart<(marks.openingEnd??marks.openingStart??0))return null;
  return Object.keys(marks).length||allowEmpty&&Object.keys(value).length===0?marks:null;
}
function validManifest(value,series){
  return object(value)&&value.schemaVersion===1&&value.series?.slug===series.slug&&
    typeof value.dataVersion==='string'&&value.dataVersion.length>0&&value.dataVersion.length<=80&&
    (value.series.tmdbId==null||series.tmdbId!=null&&Number(value.series.tmdbId)===Number(series.tmdbId))&&
    (value.series.imdbId==null||value.series.imdbId===series.imdbId)&&
    Array.isArray(value.records)&&value.records.length<=2000;
}
function inspectRecord(record,context,series){
  const runtime=record?.edition?.durationSeconds;
  if(!durationValid(runtime)&&record?.verification?.status==='unverified')return result('unverified',{reason:'reference-duration-unavailable'});
  const blockEarlyNext=record?.verification?.blockEarlyNext===true;
  const markers=markersFor(record?.markers,runtime,blockEarlyNext);
  if(!markers||!safeID(record?.edition?.id))return result('invalid-data');
  const tolerance=record.edition.toleranceSeconds??.5;
  const reference=record.verification?.status==='community-reference';
  if(!Number.isFinite(tolerance)||tolerance<0||tolerance>(record.verification?.status==='verified'?2:3))return result('invalid-data');
  if(Math.abs(context.duration-runtime)>tolerance)return result('edition-mismatch');
  const sources=(Array.isArray(record.sources)?record.sources:[]).filter(source=>object(source)&&sourceURL(source.url)&&typeof source.title==='string');
  const provenance={editionId:record.edition.id,durationSeconds:runtime,sources:sources.map(source=>({...source}))};
  const hasEdition=safeID(context.editionId),hasSource=fingerprint(context.sourceFingerprint);
  const editionMatches=hasEdition&&context.editionId===record.edition.id;
  const sourceMatches=hasSource&&fingerprint(record.edition.sourceFingerprint)&&context.sourceFingerprint===record.edition.sourceFingerprint;
  if(hasEdition&&!editionMatches||hasSource&&record.edition.sourceFingerprint&&!sourceMatches)return result('edition-mismatch',{provenance});
  if(reference){
    if(!context.allowReferenceMarkers||!series.imdbId||!sources.length)return result('unverified',{provenance});
    const safe=markersFor(markers,context.duration,blockEarlyNext);
    return safe?result('matched',{markers:safe,confidence:'community-reference',provenance,...(blockEarlyNext?{blockEarlyNext:true}:{})}):result('edition-mismatch',{provenance});
  }
  if(record.verification?.status!=='verified'||!sources.length)return result('unverified',{provenance});
  if(!editionMatches&&!sourceMatches)return result('edition-unverified',{provenance});
  // Validate against the decoded duration too, especially near the file's end.
  const safe=markersFor(markers,context.duration,blockEarlyNext);
  return safe?result('matched',{markers:safe,confidence:'edition-verified',provenance,...(blockEarlyNext?{blockEarlyNext:true}:{})}):result('edition-mismatch',{provenance});
}

/** Local JSON is one swappable data adapter; lookup never guesses timestamps. */
export class EpisodeMarkerCatalog {
  constructor({request=(url,options)=>globalThis.fetch(url,options),registry=SERIES_MARKER_REGISTRY,timeoutMs=4000,
    schedule=(callback,delay)=>globalThis.setTimeout(callback,delay),cancel=timer=>globalThis.clearTimeout(timer)}={}){
    Object.assign(this,{request,registry,schedule,cancel});this.timeoutMs=Number.isFinite(timeoutMs)?Math.max(100,Math.min(15000,timeoutMs)):4000;
    this.cache=new Map();this.pending=new Map();this.epoch=0;
  }
  reset(){this.epoch++;this.cache.clear();for(const job of this.pending.values())job.controller.abort();this.pending.clear();}
  async lookup({item,episode,duration,editionId,sourceFingerprint,allowReferenceMarkers=false,signal}={}){
    const series=resolveMarkerSeries(item,this.registry),numbers=markerEpisodeNumbers(episode);
    if(signal?.aborted)return result('cancelled');
    if(!series||!numbers)return result('unavailable',{reason:!series?'unknown-series':'unknown-episode'});
    if(!durationValid(duration))return result('unavailable',{reason:'duration-required'});
    const context={duration,editionId,sourceFingerprint,allowReferenceMarkers:allowReferenceMarkers===true},epoch=this.epoch;
    const loaded=await this.#load(series,signal);
    if(signal?.aborted||epoch!==this.epoch||loaded.status==='cancelled')return result('cancelled');
    if(!loaded.manifest)return result('unavailable',{reason:loaded.reason||'load-failed'});
    const manifest=loaded.manifest,records=manifest.records.filter(record=>record?.season===numbers.season&&record?.episode===numbers.episode);
    if(!records.length)return result('unavailable',{reason:'episode-not-indexed',series:series.slug,dataVersion:manifest.dataVersion});
    const inspected=records.map(record=>inspectRecord(record,context,series));
    const chosen=inspected.find(value=>value.status==='matched'&&value.confidence==='edition-verified')||inspected.find(value=>value.status==='matched'&&value.blockEarlyNext)||inspected.find(value=>value.status==='matched')||inspected.find(value=>value.status==='unverified')||inspected.find(value=>value.status==='edition-unverified')||inspected[0];
    return {...chosen,series:series.slug,season:numbers.season,episode:numbers.episode,dataVersion:manifest.dataVersion};
  }
  #load(series,signal){
    if(this.cache.has(series.slug))return Promise.resolve({manifest:this.cache.get(series.slug)});
    let job=this.pending.get(series.slug);
    if(!job||job.controller.signal.aborted){
      job={controller:new AbortController(),consumers:new Set(),settled:false};const epoch=this.epoch;
      const timer=this.schedule(()=>{job.timedOut=true;job.controller.abort();},this.timeoutMs);
      const work=Promise.resolve().then(async()=>{
        if(job.controller.signal.aborted)return {status:'cancelled'};
        try{
          const response=await this.request(`/series-markers/${series.slug}/manifest.json`,{signal:job.controller.signal});
          if(response?.ok===false)return {reason:'load-failed'};
          const manifest=typeof response?.json==='function'?await response.json():response;
          if(job.controller.signal.aborted||epoch!==this.epoch)return {status:'cancelled'};
          if(!validManifest(manifest,series))return {reason:'invalid-manifest'};
          this.cache.set(series.slug,manifest);return {manifest};
        }catch{return {reason:job.timedOut?'timeout':'load-failed'};}
      });
      let onAbort;
      const stopped=new Promise(resolve=>{onAbort=()=>resolve(job.timedOut?{reason:'timeout'}:{status:'cancelled'});job.controller.signal.addEventListener('abort',onAbort,{once:true});if(job.controller.signal.aborted)onAbort();});
      job.promise=Promise.race([work,stopped]).finally(()=>{job.settled=true;this.cancel(timer);job.controller.signal.removeEventListener('abort',onAbort);if(this.pending.get(series.slug)===job)this.pending.delete(series.slug);});
      this.pending.set(series.slug,job);
    }
    return new Promise(resolve=>{
      const consumer={};job.consumers.add(consumer);let settled=false;
      const finish=value=>{if(settled)return;settled=true;signal?.removeEventListener('abort',abort);job.consumers.delete(consumer);if(!job.settled&&!job.consumers.size)job.controller.abort();resolve(value);};
      const abort=()=>finish({status:'cancelled'});signal?.addEventListener('abort',abort,{once:true});
      job.promise.then(finish);if(signal?.aborted)abort();
    });
  }
}
