import {createHash} from 'node:crypto';
import {SERIES_MARKER_REGISTRY} from '../../../web/series-markers/registry.js';
import {SKIPDB_DUMP_URL,SKIPDB_LICENSE,SKIPDB_MAX_SEGMENTS,validDate,failure} from './contrato.mjs';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,24);
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const finite=value=>typeof value==='number'&&Number.isFinite(value);

export function validateSkipDBDump(value){
  if(!object(value)||value.license!==SKIPDB_LICENSE||value.license_url!=='https://skipdb.tv/license'||!validDate(value.generated_at)||
    !Array.isArray(value.segments)||!Number.isSafeInteger(value.count)||value.count!==value.segments.length||value.count>SKIPDB_MAX_SEGMENTS)throw failure('SKIPDB_DUMP_INVALID');
  return value;
}

function cleanSegment(raw){
  if(!object(raw)||raw.status!=='approved'||raw.media_type!=='series'||!/^tt\d+$/.test(raw.imdb_id||'')||
    !Number.isSafeInteger(raw.id)||raw.id<1||!Number.isSafeInteger(raw.season)||raw.season<0||raw.season>1000||
    !Number.isSafeInteger(raw.episode)||raw.episode<1||raw.episode>10000||!['intro','outro','recap','preview'].includes(raw.segment_type))return null;
  const {start_ms:start,end_ms:end,duration_ms:duration}=raw;
  if(!finite(start)||!finite(end)||start<0||end<start||end>86400000||start===end&&start!==0||
    duration!==null&&duration!==undefined&&(!finite(duration)||duration<=0||duration>86400000||end>duration))return null;
  return {id:raw.id,imdb_id:raw.imdb_id,media_type:'series',season:raw.season,episode:raw.episode,segment_type:raw.segment_type,
    start_ms:start,end_ms:end,duration_ms:duration??null,
    score:finite(raw.score)?raw.score:0,...(validDate(raw.updated_at)?{updated_at:raw.updated_at}:{})};
}

function consistent(rows){
  if(!rows.length)return null;
  if(Math.max(...rows.map(row=>row.start_ms))-Math.min(...rows.map(row=>row.start_ms))>2000||
    Math.max(...rows.map(row=>row.end_ms))-Math.min(...rows.map(row=>row.end_ms))>2000)return null;
  return [...rows].sort((a,b)=>b.score-a.score||a.id-b.id)[0];
}

/** Keep source editions separate; never shift timestamps or consult another DB. */
export function normalizeSkipDBDump(value,{registry=SERIES_MARKER_REGISTRY,retrievedAt=new Date().toISOString()}={}){
  const dump=validateSkipDBDump(value);if(!validDate(retrievedAt))throw failure('SKIPDB_RETRIEVAL_INVALID');
  const selected=new Map(registry.map(series=>[series.imdbId,series])),segments=[],seen=new Set();
  for(const raw of dump.segments){
    if(!selected.has(raw?.imdb_id)||raw?.media_type!=='series'||raw?.status!=='approved')continue;
    const segment=cleanSegment(raw);if(!segment)throw failure('SKIPDB_SELECTED_SEGMENT_INVALID');
    const identity=[segment.imdb_id,segment.season,segment.episode,segment.segment_type,segment.duration_ms,segment.start_ms,segment.end_ms].join(':');
    if(seen.has(identity))continue;seen.add(identity);segments.push(segment);
  }
  segments.sort((a,b)=>a.imdb_id.localeCompare(b.imdb_id)||a.season-b.season||a.episode-b.episode||(a.duration_ms??0)-(b.duration_ms??0)||a.segment_type.localeCompare(b.segment_type)||a.start_ms-b.start_ms||a.id-b.id);
  const groups=new Map();
  for(const segment of segments){if(!segment.duration_ms)continue;const key=[segment.imdb_id,segment.season,segment.episode,segment.duration_ms].join(':');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(segment);}
  const dataVersion='skipdb.'+dump.generated_at.replace(/[^\dTZ]/g,''),manifests=Object.fromEntries(registry.map(series=>[series.slug,{schemaVersion:1,dataVersion,series:{slug:series.slug,title:series.title,tmdbId:series.tmdbId,imdbId:series.imdbId},status:'community-reference',records:[]}])),rows=[];
  let ambiguous=0,unsafeCredits=0;
  for(const evidence of groups.values()){
    const first=evidence[0],series=selected.get(first.imdb_id),duration=first.duration_ms,notes=[],markers={};
    const intros=evidence.filter(row=>row.segment_type==='intro'&&row.end_ms>row.start_ms&&row.end_ms<duration),intro=consistent(intros);
    if(intro){markers.openingStart=intro.start_ms/1000;markers.openingEnd=intro.end_ms/1000;}
    else if(intros.length){ambiguous++;notes.push('Conflicting intro ranges for the same duration; opening disabled.');}
    const outros=evidence.filter(row=>row.segment_type==='outro'&&row.end_ms>row.start_ms),outro=consistent(outros);
    const hasLaterContent=outro&&evidence.some(row=>['preview','intro','recap'].includes(row.segment_type)&&row.end_ms>row.start_ms&&row.start_ms>=outro.start_ms);
    if(outro&&outro.start_ms>0&&duration-outro.end_ms<=2000&&!hasLaterContent&&outro.start_ms>=(intro?.end_ms??0))markers.creditsStart=outro.start_ms/1000;
    else if(outros.length){unsafeCredits++;notes.push('Credits are not proven to run through the end without a later segment; auto-next disabled.');}
    const editionId='skipdb-'+hash([first.imdb_id,first.season,first.episode,duration,markers]);
    const sources=[{title:'SkipDB',url:`https://skipdb.tv/api/segments?imdb_id=${first.imdb_id}&season=${first.season}&episode=${first.episode}&duration=${duration/1000}&adjust=none`,retrievedAt}];
    const verification={status:'community-reference',...(outros.length&&markers.creditsStart===undefined?{blockEarlyNext:true}:{}),notes:['Community timestamps; matching duration does not prove the WPLAY edition.',...notes]};
    const active=Object.keys(markers).length>0||verification.blockEarlyNext===true;
    const provenance={source:'skipdb',license:SKIPDB_LICENSE,licenseUrl:'https://skipdb.tv/license',dumpUrl:SKIPDB_DUMP_URL,dumpGeneratedAt:dump.generated_at,retrievedAt,sources,verification,evidence};
    const row={series_slug:series.slug,season:first.season,episode:first.episode,edition_id:editionId,tmdb_id:series.tmdbId,imdb_id:series.imdbId,duration_seconds:duration/1000,tolerance_seconds:2,
      verification:'community-reference',markers,provenance,data_version:dataVersion,is_active:active};
    rows.push(row);
  }
  // Two duration windows may overlap while representing different cuts. The
  // player cannot distinguish them by duration alone, so suppress disputed
  // fields rather than choosing whichever edition sorts first.
  const originals=rows.map(row=>({...row.markers}));
  for(let index=0;index<rows.length;index++){
    const row=rows[index],own=originals[index];
    const peers=rows.map((other,position)=>({other,marks:originals[position]})).filter(({other})=>other!==row&&other.series_slug===row.series_slug&&other.season===row.season&&other.episode===row.episode&&Math.abs(other.duration_seconds-row.duration_seconds)<=4);
    if(own.openingEnd!==undefined&&peers.some(({marks})=>marks.openingEnd!==undefined&&(Math.abs(marks.openingStart-own.openingStart)>2||Math.abs(marks.openingEnd-own.openingEnd)>2))){
      row.provenance.verification.openingCandidates=[{...own,durationSeconds:row.duration_seconds},...peers.filter(({marks})=>marks.openingEnd!==undefined).map(({other,marks})=>({...marks,durationSeconds:other.duration_seconds}))].map(({openingStart,openingEnd,durationSeconds})=>({openingStart,openingEnd,durationSeconds}));
      delete row.markers.openingStart;delete row.markers.openingEnd;ambiguous++;row.provenance.verification.notes.push('Nearby duration editions have contradictory opening ranges; duration alone cannot select one.');
    }
    if(own.creditsStart!==undefined&&peers.some(({marks})=>marks.creditsStart!==undefined&&Math.abs(marks.creditsStart-own.creditsStart)>2)){
      delete row.markers.creditsStart;unsafeCredits++;row.provenance.verification.blockEarlyNext=true;row.provenance.verification.notes.push('Nearby duration editions have contradictory credit starts; duration alone cannot select one.');
    }
    row.is_active=Object.keys(row.markers).length>0||row.provenance.verification.blockEarlyNext===true;
    row.edition_id='skipdb-'+hash([row.imdb_id,row.season,row.episode,row.duration_seconds*1000,row.markers,row.provenance.verification.blockEarlyNext===true]);
    manifests[row.series_slug].records.push({season:row.season,episode:row.episode,edition:{id:row.edition_id,durationSeconds:row.duration_seconds,toleranceSeconds:2},verification:row.provenance.verification,markers:row.markers,sources:row.provenance.sources});
  }
  for(const manifest of Object.values(manifests)){
    manifest.records.sort((a,b)=>a.season-b.season||a.episode-b.episode||a.edition.durationSeconds-b.edition.durationSeconds);
    if(manifest.records.length>2000)throw failure('SKIPDB_SERIES_EDITIONS_LIMIT');
  }
  const coverage=registry.map(series=>{const records=rows.filter(row=>row.series_slug===series.slug),count=values=>new Set(values.map(row=>`${row.season}:${row.episode}`)).size;return {slug:series.slug,imdbId:series.imdbId,episodes:count(records),regularEpisodes:count(records.filter(row=>row.season>0)),specialEpisodes:count(records.filter(row=>row.season===0)),editions:records.length,openingEditions:records.filter(row=>row.markers.openingEnd!==undefined).length,creditsEditions:records.filter(row=>row.markers.creditsStart!==undefined).length};});
  const snapshot={schemaVersion:1,source:'skipdb',license:SKIPDB_LICENSE,licenseUrl:'https://skipdb.tv/license',sourceUrl:SKIPDB_DUMP_URL,generatedAt:dump.generated_at,retrievedAt,
    notice:'Derived from SkipDB. ODbL 1.0 and Service Provider Reciprocity apply unchanged; see DATA-LICENSE and ODbL-1.0.txt. No user data is included.',
    series:registry.map(({slug,title,imdbId,tmdbId})=>({slug,title,imdbId,tmdbId})),segments,records:rows,coverage};
  return {snapshot,manifests,rows,stats:{sourceSegments:dump.count,selectedSegments:segments.length,editions:rows.length,activeEditions:rows.filter(row=>row.is_active).length,ambiguousOpenings:ambiguous,unsafeCredits,coverage}};
}

