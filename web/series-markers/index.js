import {SERIES_MARKER_REGISTRY} from './registry.js';
export {SERIES_MARKER_REGISTRY} from './registry.js';
const normalized = value => String(value??'').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const titleWithoutQuality = value => String(value??'').trim().replace(/(?:\s+(?:\((?:sd|hd|fhd|uhd|4k|hevc|leg|dub|dual)\)|\[(?:sd|hd|fhd|uhd|4k|hevc|leg|dub|dual)\]|sd|hd|fhd|uhd|4k|hevc|leg|dub|dual))+\s*$/i,'');
const titleIdentity = value => normalized(titleWithoutQuality(value).replace(/\s*(?:\((?:19|20)\d{2}\)|-\s*(?:19|20)\d{2})\s*$/,''));
const titleYear = value => Number(/(?:\(((?:19|20)\d{2})\)|-\s*((?:19|20)\d{2}))\s*$/.exec(titleWithoutQuality(value))?.slice(1).find(Boolean))||null;
const releaseYear = value => /^(?:19|20)\d{2}(?:-\d{2}-\d{2})?$/.test(String(value??''))?Number(String(value).slice(0,4)):null;
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
  if(explicit!=null&&tmdbId===null||imdb!=null&&!/^tt\d{6,10}$/.test(imdb))return null;
  const fromTitle=titleYear(item.name),fromField=releaseYear(item.year??item.releaseYear??item.release_year??item.first_air_date);
  if(fromTitle&&fromField&&fromTitle!==fromField)return null;
  const year=fromField||fromTitle,named=registry.filter(series=>series.aliases.some(alias=>titleIdentity(alias)===titleIdentity(item.name)));
  const unique=values=>[...new Map(values.map(value=>[`${value.slug}:${value.imdbId}:${value.tmdbId??''}`,value])).values()];
  let candidates=imdb!=null||tmdbId!==null?registry.filter(series=>(imdb==null||series.imdbId===imdb)&&(tmdbId===null||Number(series.tmdbId)===tmdbId)):named;
  if(named.length&&(imdb!=null||tmdbId!==null))candidates=candidates.filter(series=>named.some(value=>value.slug===series.slug&&value.imdbId===series.imdbId));
  if(year)candidates=candidates.filter(series=>{const known=releaseYear(series.year)||titleYear(series.title);return !known||known===year;});
  candidates=unique(candidates);
  // Homonyms such as the two One Piece adaptations need a year or explicit
  // identity. Array order and equal episode numbers are never identity proof.
  return candidates.length===1?candidates[0]:null;
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
/** Runtime and community agreement cannot identify an edit of a video. Keep
 * this guard at the catalog and at the player boundary so a future adapter
 * cannot accidentally turn a reference-only response into a seek. */
export function isVerifiedEpisodeMarkerResult(value,context={}){
  const proof=value?.provenance,numbers=markerEpisodeNumbers(context.episode);
  if(value?.status!=='matched'||value.confidence!=='edition-verified'||!proof||!numbers||context.item?.kind!=='series'||
    context.item.id==null||value.mediaId!==String(context.item.id)||
    value.season!==numbers.season||value.episode!==numbers.episode||!safeID(proof.editionId)||
    !durationValid(context.duration)||!durationValid(proof.durationSeconds))return false;
  const tolerance=proof.toleranceSeconds??.5;
  if(!Number.isFinite(tolerance)||tolerance<0||tolerance>2||Math.abs(context.duration-proof.durationSeconds)>tolerance)return false;
  const hasEdition=context.editionId!=null,hasSource=fingerprint(context.sourceFingerprint);
  const editionMatches=safeID(context.editionId)&&context.editionId===proof.editionId;
  const sourceMatches=hasSource&&fingerprint(proof.sourceFingerprint)&&context.sourceFingerprint===proof.sourceFingerprint;
  if(hasEdition&&!editionMatches||hasSource&&proof.sourceFingerprint&&!sourceMatches)return false;
  return (editionMatches||sourceMatches)&&Array.isArray(proof.sources)&&proof.sources.some(source=>sourceURL(source?.url)&&typeof source?.title==='string')&&
    Boolean(markersFor(value.markers,context.duration,value.blockEarlyNext===true));
}
function inspectRecord(record,context){
  const runtime=record?.edition?.durationSeconds;
  if(!durationValid(runtime)&&record?.verification?.status==='unverified')return result('unverified',{reason:'reference-duration-unavailable'});
  const blockEarlyNext=record?.verification?.blockEarlyNext===true;
  const markers=markersFor(record?.markers,runtime,blockEarlyNext);
  if(!markers||!safeID(record?.edition?.id))return result('invalid-data');
  const tolerance=record.edition.toleranceSeconds??.5;
  if(!Number.isFinite(tolerance)||tolerance<0||tolerance>(record.verification?.status==='verified'?2:3))return result('invalid-data');
  if(Math.abs(context.duration-runtime)>tolerance)return result('edition-mismatch');
  const sources=(Array.isArray(record.sources)?record.sources:[]).filter(source=>object(source)&&sourceURL(source.url)&&typeof source.title==='string');
  const provenance={editionId:record.edition.id,durationSeconds:runtime,toleranceSeconds:tolerance,
    ...(fingerprint(record.edition.sourceFingerprint)?{sourceFingerprint:record.edition.sourceFingerprint}:{}),sources:sources.map(source=>({...source}))};
  const hasEdition=context.editionId!=null,hasSource=fingerprint(context.sourceFingerprint);
  const editionMatches=safeID(context.editionId)&&context.editionId===record.edition.id;
  const sourceMatches=hasSource&&fingerprint(record.edition.sourceFingerprint)&&context.sourceFingerprint===record.edition.sourceFingerprint;
  if(hasEdition&&!editionMatches||hasSource&&record.edition.sourceFingerprint&&!sourceMatches)return result('edition-mismatch',{provenance});
  if(record.verification?.status!=='verified'||!sources.length)return result('unverified',{reason:'edition-verification-required',provenance});
  if(!editionMatches&&!sourceMatches)return result('edition-unverified',{provenance});
  // Validate against the decoded duration too, especially near the file's end.
  const safe=markersFor(markers,context.duration,blockEarlyNext);
  return safe?result('matched',{markers:safe,confidence:'edition-verified',provenance,...(blockEarlyNext?{blockEarlyNext:true}:{})}):result('edition-mismatch',{provenance});
}

/** Local JSON is one swappable data adapter; lookup never guesses timestamps. */
export class EpisodeMarkerCatalog {
  constructor({request=(url,options)=>globalThis.fetch(url,options),registry=SERIES_MARKER_REGISTRY,timeoutMs=4000,perEpisode=false,
    schedule=(callback,delay)=>globalThis.setTimeout(callback,delay),cancel=timer=>globalThis.clearTimeout(timer)}={}){
    Object.assign(this,{request,registry,schedule,cancel,perEpisode});this.timeoutMs=Number.isFinite(timeoutMs)?Math.max(100,Math.min(15000,timeoutMs)):4000;
    this.cache=new Map();this.pending=new Map();this.epoch=0;
  }
  reset(){this.epoch++;this.cache.clear();for(const job of this.pending.values())job.controller.abort();this.pending.clear();}
  async lookup({item,episode,duration,editionId,sourceFingerprint,allowReferenceMarkers=false,signal,seriesIdentity}={}){
    const dynamic=seriesIdentity?.resolved===true&&/^tt\d{6,10}$/.test(seriesIdentity.imdbId||'')&&/^[a-z0-9-]{1,100}$/.test(seriesIdentity.slug||'')&&Array.isArray(seriesIdentity.aliases)?seriesIdentity:null;
    const series=resolveMarkerSeries(item,dynamic?[dynamic,...this.registry]:this.registry),numbers=markerEpisodeNumbers(episode);
    if(signal?.aborted)return result('cancelled');
    if(!series||!numbers)return result('unavailable',{reason:!series?'unknown-series':'unknown-episode'});
    if(!durationValid(duration))return result('unavailable',{reason:'duration-required'});
    const context={duration,editionId,sourceFingerprint},epoch=this.epoch;
    const loaded=await this.#load(series,signal,numbers);
    if(signal?.aborted||epoch!==this.epoch||loaded.status==='cancelled')return result('cancelled');
    if(!loaded.manifest)return result('unavailable',{reason:loaded.reason||'load-failed'});
    const manifest=loaded.manifest,records=manifest.records.filter(record=>record?.season===numbers.season&&record?.episode===numbers.episode);
    const evidence=manifest.episodeEvidence,references=[];
    if(allowReferenceMarkers===true&&evidence?.imdb_id===series.imdbId&&evidence.season===numbers.season&&evidence.episode===numbers.episode){
      for(const source of ['skipdb','introdb']){const intro=evidence.evidence?.[source]?.intro;
        if(!Number.isFinite(intro?.start_ms)||!Number.isFinite(intro?.end_ms)||intro.adjusted===true||intro.end_ms-intro.start_ms>300000)continue;
        const marks=markersFor({openingStart:intro?.start_ms/1000,openingEnd:intro?.end_ms/1000},duration);
        if(marks)references.push({...marks,source:source==='introdb'?'IntroDB':'SkipDB',reason:'edition-verification-required'});
      }
    }
    const metadata={series:series.slug,mediaId:item.id==null?null:String(item.id),season:numbers.season,episode:numbers.episode,dataVersion:manifest.dataVersion,...(references.length?{references}:{})};
    if(!records.length)return result('unavailable',{reason:'episode-not-indexed',...metadata});
    const inspected=records.map(record=>inspectRecord(record,context)),verified=inspected.filter(value=>value.status==='matched');
    const signature=value=>JSON.stringify([value.markers.openingStart??null,value.markers.openingEnd??null,value.markers.creditsStart??null,value.blockEarlyNext===true]);
    if(new Set(verified.map(signature)).size>1)return result('edition-conflict',{reason:'conflicting-verified-markers',...metadata});
    const chosen=verified[0]||inspected.find(value=>value.status==='unverified')||inspected.find(value=>value.status==='edition-unverified')||inspected[0];
    return {...chosen,...metadata};
  }
  #load(series,signal,numbers){
    const key=this.perEpisode?`${series.slug}:${numbers.season}:${numbers.episode}`:series.slug;
    if(this.cache.has(key))return Promise.resolve({manifest:this.cache.get(key)});
    let job=this.pending.get(key);
    if(!job||job.controller.signal.aborted){
      job={controller:new AbortController(),consumers:new Set(),settled:false};const epoch=this.epoch;
      const timer=this.schedule(()=>{job.timedOut=true;job.controller.abort();},this.timeoutMs);
      const work=Promise.resolve().then(async()=>{
        if(job.controller.signal.aborted)return {status:'cancelled'};
        try{
          const response=await this.request(`/series-markers/${series.slug}/manifest.json`,{signal:job.controller.signal,...(this.perEpisode?numbers:{})});
          if(response?.ok===false)return {reason:'load-failed'};
          const manifest=typeof response?.json==='function'?await response.json():response;
          if(job.controller.signal.aborted||epoch!==this.epoch)return {status:'cancelled'};
          if(!validManifest(manifest,series))return {reason:'invalid-manifest'};
          this.cache.set(key,manifest);return {manifest};
        }catch{return {reason:job.timedOut?'timeout':'load-failed'};}
      });
      let onAbort;
      const stopped=new Promise(resolve=>{onAbort=()=>resolve(job.timedOut?{reason:'timeout'}:{status:'cancelled'});job.controller.signal.addEventListener('abort',onAbort,{once:true});if(job.controller.signal.aborted)onAbort();});
      job.promise=Promise.race([work,stopped]).finally(()=>{job.settled=true;this.cancel(timer);job.controller.signal.removeEventListener('abort',onAbort);if(this.pending.get(key)===job)this.pending.delete(key);});
      this.pending.set(key,job);
    }
    return new Promise(resolve=>{
      const consumer={};job.consumers.add(consumer);let settled=false;
      const finish=value=>{if(settled)return;settled=true;signal?.removeEventListener('abort',abort);job.consumers.delete(consumer);if(!job.settled&&!job.consumers.size)job.controller.abort();resolve(value);};
      const abort=()=>finish({status:'cancelled'});signal?.addEventListener('abort',abort,{once:true});
      job.promise.then(finish);if(signal?.aborted)abort();
    });
  }
}
