import {SERIES_MARKER_REGISTRY} from '../../../web/series-markers/registry.js';

export const DAY=86400000,LICENSE='ODbL 1.0 + Service Provider Reciprocity';
export const imdbID=value=>typeof value==='string'&&/^tt\d{6,10}$/.test(value)?value:null;
export const positive=value=>Number.isSafeInteger(Number(value))&&Number(value)>0?Number(value):null;
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const normalize=value=>String(value??'').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
export function catalogTitle(value){
  const name=String(value??'').trim().replace(/(?:\s+(?:\((?:sd|hd|fhd|uhd|4k|hevc|leg|dub|dual)\)|\[(?:sd|hd|fhd|uhd|4k|hevc|leg|dub|dual)\]|(?:sd|hd|fhd|uhd|4k|hevc|leg|dub|dual)))+\s*$/i,'');
  const year=/(?:\((19\d{2}|20\d{2})\)|-\s*(19\d{2}|20\d{2}))\s*$/.exec(name);
  return {name:year?name.slice(0,year.index).trim():name,year:year?Number(year[1]||year[2]):null};
}
export function canonicalSeries(imdb,title=null,tmdb=null){
  const known=SERIES_MARKER_REGISTRY.find(value=>value.imdbId===imdb);
  return {imdb_id:imdb,series_slug:known?.slug||'imdb-'+imdb,title:title||known?.title||null,tmdb_id:positive(tmdb)||known?.tmdbId||null};
}
export function explicitIdentity(row){
  const metadata=row.catalog_metadata||row.metadata||{},imdb=imdbID(metadata.imdbId??metadata.imdb_id??metadata.externalIds?.imdb);
  const parsed=catalogTitle(row.catalog_name||row.name),year=positive(metadata.year)||parsed.year;
  if(positive(metadata.year)&&parsed.year&&Number(metadata.year)!==parsed.year)throw Object.assign(new Error('CATALOG_YEAR_CONFLICT'),{code:'CATALOG_YEAR_CONFLICT'});
  const byIMDb=imdb?SERIES_MARKER_REGISTRY.find(series=>series.imdbId===imdb):null,tmdb=positive(metadata.tmdbId??metadata.tmdb_id);
  if(byIMDb?.year&&year&&byIMDb.year!==year)throw Object.assign(new Error('CATALOG_YEAR_CONFLICT'),{code:'CATALOG_YEAR_CONFLICT'});
  if(byIMDb&&tmdb&&byIMDb.tmdbId!==tmdb)throw Object.assign(new Error('CATALOG_IDENTITY_CONFLICT'),{code:'CATALOG_IDENTITY_CONFLICT'});
  const matches=SERIES_MARKER_REGISTRY.filter(series=>(!year||!series.year||series.year===year)&&series.aliases.some(alias=>normalize(alias)===normalize(parsed.name)));
  const candidates=imdb?matches.filter(series=>series.imdbId===imdb):matches,known=candidates.length===1?candidates[0]:null;
  if(known&&tmdb&&tmdb!==known.tmdbId||imdb&&matches.length===1&&!known)throw Object.assign(new Error('CATALOG_IDENTITY_CONFLICT'),{code:'CATALOG_IDENTITY_CONFLICT'});
  if(imdb)return {...canonicalSeries(imdb,row.catalog_name||row.name,tmdb),year:byIMDb?.year||year,method:'catalog-external-id'};
  return known?{...canonicalSeries(known.imdbId,known.title,known.tmdbId),year:known.year||year,method:'curated-exact-alias'}:null;
}
export function selectSeriesIdentity(row,response){
  const parsed=catalogTitle(row.catalog_name||row.name),year=positive(row.catalog_metadata?.year)||parsed.year;
  const candidates=new Map();
  for(const candidate of [...(Array.isArray(response?.local)?response.local:[]),...(Array.isArray(response?.results)?response.results:[])]){
    const imdb=imdbID(candidate.imdb_id??candidate.imdbId),type=candidate.media_type??candidate.mediaType;
    if(!imdb||type!=='series'||normalize(candidate.name)!==normalize(parsed.name)||year!==null&&Number(candidate.year)!==year)continue;
    const known=SERIES_MARKER_REGISTRY.find(series=>series.imdbId===imdb),tmdb=positive(candidate.tmdb_id??candidate.tmdbId);
    if(known&&(known.year&&Number(candidate.year)!==known.year||tmdb&&tmdb!==known.tmdbId))continue;
    candidates.set(imdb,{...canonicalSeries(imdb,candidate.name,candidate.tmdb_id??candidate.tmdbId),year:positive(candidate.year),method:'skipdb-exact-title-year'});
  }
  return candidates.size===1?{status:'resolved',identity:[...candidates.values()][0]}:{status:candidates.size?'ambiguous':'unresolved',identity:null};
}
export function episodeInventory(value,imdb){
  if(value?.imdb_id!==imdb||value.media_type!=='series'||!Array.isArray(value.episodes)||value.episodes.length>20000)throw Object.assign(new Error('INVALID_INVENTORY'),{code:'INVALID_INVENTORY'});
  const seen=new Set(),episodes=[];
  for(const raw of value.episodes){
    const season=raw?.season,episode=raw?.episode;if(!Number.isSafeInteger(season)||season<0||season>1000||!Number.isSafeInteger(episode)||episode<1||episode>10000)continue;
    const key=season+':'+episode;if(seen.has(key))continue;seen.add(key);
    episodes.push({season,episode,runtime_hint_seconds:finite(raw.runtimeMs)&&raw.runtimeMs>0&&raw.runtimeMs<=86400000?raw.runtimeMs/1000:null});
  }
  return episodes;
}
export async function digest(value){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))))].map(byte=>byte.toString(16).padStart(2,'0')).join('').slice(0,24);}

/** Deno/Node neutral normalization. Only original, approved source editions
 * create playable records. The full derivative has no contributor identities. */
export async function normalizeGlobalDump(dump,{now=Date.now(),consume=false}={}){
  if(dump?.license!==LICENSE||dump.license_url!=='https://skipdb.tv/license'||!Number.isFinite(Date.parse(dump.generated_at))||!Array.isArray(dump.segments)||dump.count!==dump.segments.length||dump.count>250000)throw Object.assign(new Error('INVALID_DUMP'),{code:'INVALID_DUMP'});
  const groups=new Map(),referenceGroups=new Map(),selected=[];let missingDuration=0,unsupportedEpisodes=0;
  for(let index=0;index<dump.segments.length;index++){
    const raw=dump.segments[index];if(consume)dump.segments[index]=null;
    if(raw?.status!=='approved'||raw.media_type!=='series'||!imdbID(raw.imdb_id))continue;
    // SkipDB permits episode zero; the application's season/episode contract
    // starts at one. Report these explicitly instead of renumbering them.
    if(raw.episode===0){unsupportedEpisodes++;continue;}
    if(!Number.isSafeInteger(raw.id)||raw.id<1||!Number.isSafeInteger(raw.season)||raw.season<0||raw.season>1000||!Number.isSafeInteger(raw.episode)||raw.episode<1||raw.episode>10000||!['intro','outro','preview','recap'].includes(raw.segment_type)||!finite(raw.start_ms)||!finite(raw.end_ms)||raw.start_ms<0||raw.end_ms<raw.start_ms||raw.end_ms>86400000)throw Object.assign(new Error('INVALID_DUMP_SEGMENT'),{code:'INVALID_DUMP_SEGMENT'});
    const segment={id:raw.id,imdb_id:raw.imdb_id,season:raw.season,episode:raw.episode,segment_type:raw.segment_type,start_ms:raw.start_ms,end_ms:raw.end_ms,duration_ms:raw.duration_ms??null,score:finite(raw.score)?raw.score:0};
    selected.push(segment);
    if(raw.duration_ms===null||raw.duration_ms===undefined){missingDuration++;const key=[raw.imdb_id,raw.season,raw.episode].join(':');if(!referenceGroups.has(key))referenceGroups.set(key,[]);referenceGroups.get(key).push(segment);continue;}
    if(!finite(raw.duration_ms)||raw.duration_ms<=0||raw.duration_ms>86400000)throw Object.assign(new Error('INVALID_DUMP_SEGMENT'),{code:'INVALID_DUMP_SEGMENT'});
    if(raw.end_ms>raw.duration_ms)throw Object.assign(new Error('INVALID_DUMP_SEGMENT'),{code:'INVALID_DUMP_SEGMENT'});
    const key=[raw.imdb_id,raw.season,raw.episode,raw.duration_ms].join(':');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(segment);
  }
  const records=[],retrievedAt=new Date(now).toISOString(),dataVersion='skipdb-cloud.'+dump.generated_at.replace(/[^0-9TZ]/g,'');
  for(const segments of groups.values()){
    const first=segments[0],duration=first.duration_ms/1000,markers={},notes=[];
    const best=type=>{const rows=segments.filter(row=>row.segment_type===type&&row.end_ms>row.start_ms);return rows.length&&Math.max(...rows.map(row=>row.start_ms))-Math.min(...rows.map(row=>row.start_ms))<=2000&&Math.max(...rows.map(row=>row.end_ms))-Math.min(...rows.map(row=>row.end_ms))<=2000?[...rows].sort((a,b)=>b.score-a.score||a.id-b.id)[0]:null;};
    const intro=best('intro'),outro=best('outro');
    if(intro&&intro.end_ms<first.duration_ms){markers.openingStart=intro.start_ms/1000;markers.openingEnd=intro.end_ms/1000;}
    const hasOutros=segments.some(row=>row.segment_type==='outro'&&row.end_ms>row.start_ms);
    const later=outro&&segments.some(row=>['preview','recap','intro'].includes(row.segment_type)&&row.end_ms>row.start_ms&&row.start_ms>=outro.start_ms);
    if(outro&&first.duration_ms-outro.end_ms<=2000&&!later&&outro.start_ms>=(intro?.end_ms??0)&&outro.start_ms>0&&outro.start_ms<first.duration_ms)markers.creditsStart=outro.start_ms/1000;
    const blockEarlyNext=hasOutros&&markers.creditsStart===undefined;
    if(blockEarlyNext)notes.push('Preserve final content: outro bounds or later segments are ambiguous.');
    const series=canonicalSeries(first.imdb_id),sourceURL=`https://skipdb.tv/api/segments?imdb_id=${first.imdb_id}&season=${first.season}&episode=${first.episode}&duration=${duration}&adjust=none`;
    records.push({...series,season:first.season,episode:first.episode,duration_seconds:duration,tolerance_seconds:2,verification:'community-reference',markers,
      provenance:{source:'skipdb-cloud',license:LICENSE,licenseUrl:'https://skipdb.tv/license',dumpGeneratedAt:dump.generated_at,retrievedAt,sources:[{url:sourceURL,title:'SkipDB',retrievedAt}],verification:{status:'community-reference',...(blockEarlyNext?{blockEarlyNext:true}:{}),notes},evidence:segments},data_version:dataVersion});
  }
  const byEpisode=new Map();for(const row of records){const key=[row.imdb_id,row.season,row.episode].join(':');if(!byEpisode.has(key))byEpisode.set(key,[]);byEpisode.get(key).push({row,markers:{...row.markers}});}
  for(const values of byEpisode.values())for(const {row,markers:own}of values){
    const peers=values.filter(value=>value.row!==row&&Math.abs(value.row.duration_seconds-row.duration_seconds)<=4);
    if(own.openingEnd!==undefined&&peers.some(({markers})=>markers.openingEnd!==undefined&&(Math.abs(markers.openingStart-own.openingStart)>2||Math.abs(markers.openingEnd-own.openingEnd)>2))){
      if(peers.length<=32)row.provenance.verification.openingCandidates=[{...own,durationSeconds:row.duration_seconds},...peers.filter(({markers})=>markers.openingEnd!==undefined).map(({row,markers})=>({...markers,durationSeconds:row.duration_seconds}))].map(({openingStart,openingEnd,durationSeconds})=>({openingStart,openingEnd,durationSeconds}));
      else row.provenance.verification.notes.push('Too many conflicting editions for a bounded opening reference.');
      delete row.markers.openingStart;delete row.markers.openingEnd;
    }
    if(own.creditsStart!==undefined&&peers.some(({markers})=>markers.creditsStart!==undefined&&Math.abs(markers.creditsStart-own.creditsStart)>2)){
      delete row.markers.creditsStart;row.provenance.verification.blockEarlyNext=true;
    }
    row.edition_id='skipdb-cloud-'+await digest([row.imdb_id,row.season,row.episode,row.duration_seconds,row.markers,row.provenance.verification]);
    row.is_active=Object.keys(row.markers).length>0||row.provenance.verification.blockEarlyNext===true;
  }
  records.sort((a,b)=>a.imdb_id.localeCompare(b.imdb_id)||a.season-b.season||a.episode-b.episode||a.duration_seconds-b.duration_seconds);
  const references=[];for(const values of referenceGroups.values()){
    const first=values[0],evidence={};for(const type of ['intro','recap','outro','preview']){
      const candidates=values.filter(row=>row.segment_type===type&&row.end_ms>row.start_ms);
      if(candidates.length&&Math.max(...candidates.map(row=>row.start_ms))-Math.min(...candidates.map(row=>row.start_ms))<=2000&&Math.max(...candidates.map(row=>row.end_ms))-Math.min(...candidates.map(row=>row.end_ms))<=2000){const candidate=[...candidates].sort((a,b)=>b.score-a.score||a.id-b.id)[0];evidence[type]={start_ms:candidate.start_ms,end_ms:candidate.end_ms};}
    }
    references.push({type:'reference',...canonicalSeries(first.imdb_id),season:first.season,episode:first.episode,evidence:{skipdb:evidence},license:LICENSE,sourceUrl:'https://skipdb.tv/api/dump'});
  }
  return {schemaVersion:1,source:'skipdb',license:LICENSE,licenseUrl:'https://skipdb.tv/license',sourceUrl:'https://skipdb.tv/api/dump',generatedAt:dump.generated_at,retrievedAt,segments:selected,records,references,missingDuration,unsupportedEpisodes};
}

/** APIs lacking explicit edition runtime remain evidence, never invented rows.
 * IntroDB outro.end is not file duration: it may precede a post-credit scene. */
export function inspectSegments(source,payload,episode){
  if(payload?.imdb_id!==episode.imdb_id||payload.season!==episode.season||payload.episode!==episode.episode)throw Object.assign(new Error('SOURCE_IDENTITY_MISMATCH'),{code:'SOURCE_IDENTITY_MISMATCH'});
  const raw=source==='skipdb'?payload.segments:payload;
  if(!raw||typeof raw!=='object'||!['intro','recap','outro','preview','post_credits'].some(key=>Object.hasOwn(raw,key)))throw Object.assign(new Error('SOURCE_SCHEMA_INVALID'),{code:'SOURCE_SCHEMA_INVALID'});
  const evidence={};
  for(const type of ['intro','recap','outro','preview','post_credits']){
    const segment=raw[type];if(segment==null)continue;
    if(!finite(segment.start_ms)||!finite(segment.end_ms)||segment.start_ms<0||segment.end_ms<=segment.start_ms||segment.end_ms>86400000)throw Object.assign(new Error('SOURCE_SEGMENT_INVALID'),{code:'SOURCE_SEGMENT_INVALID'});
    evidence[type]={start_ms:segment.start_ms,end_ms:segment.end_ms,...(finite(segment.confidence)?{confidence:segment.confidence}:{}),...(typeof segment.match==='string'?{match:segment.match}:{}),...(typeof segment.adjusted==='boolean'?{adjusted:segment.adjusted}:{})};
  }
  return {status:Object.keys(evidence).length?'unverified':'empty',evidence,reason:Object.keys(evidence).length?'SOURCE_EDITION_DURATION_UNAVAILABLE':null};
}
