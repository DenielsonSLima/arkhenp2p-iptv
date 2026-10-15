// Offline normalization of researched public responses. Does not call a provider.
import {readFile,writeFile} from 'node:fs/promises';
import {validateSkipMarkers} from '../web/episode-skip.js';
const input=process.argv[2];
if(!input)throw new Error('Pass the researched Rings of Power response file.');
const raw=JSON.parse(await readFile(input,'utf8'));
const finite=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
const seconds=value=>finite(value)===null?null:value/1000;
const span=value=>value&&typeof value==='object'?{start:seconds(value.start_ms),end:seconds(value.end_ms)}:null;
const notesCount={};
const records=raw.records.map(record=>{
  const a=record.sources.find(source=>source.provider==='introdb'&&source.httpStatus===200)?.data;
  const b=record.sources.find(source=>source.provider==='theintrodb'&&source.httpStatus===200)?.data;
  const ai=span(a?.intro),bi=span(b?.intro?.[0]),ac=span(a?.outro),bc=span(b?.credits?.[0]);
  const runtime=bc?.end??ac?.end??null,notes=[],markers={};
  const compare=(one,two,label)=>{if(one!==null&&one!==undefined&&two!==null&&two!==undefined&&Math.abs(one-two)>3)notes.push(`${label} differs by more than three seconds between databases`);};
  compare(ai?.start,bi?.start,'Opening start');compare(ai?.end,bi?.end,'Opening end');compare(ac?.start,bc?.start,'Credits start');compare(ac?.end,bc?.end,'Reference duration');
  const starts=[ai?.start,bi?.start].filter(value=>value!==null&&value!==undefined),ends=[ai?.end,bi?.end].filter(value=>value!==null&&value!==undefined);
  if(starts.length&&ends.length){markers.openingStart=Math.max(...starts);markers.openingEnd=Math.max(...ends);}
  const credits=bc?.start??ac?.start;if(credits!==null&&credits!==undefined)markers.creditsStart=credits;
  if(runtime===null)notes.push('No public reference duration is available; these times stay inactive');
  if(!Object.keys(markers).length)notes.push('No opening or credits segment was supplied');
  if(runtime!==null&&!validateSkipMarkers(markers,runtime))notes.push('Segment bounds are not compatible with the public reference duration');
  const status=notes.length?'unverified':'community-reference';notesCount[status]=(notesCount[status]||0)+1;
  return {season:record.season,episode:record.episode,edition:{id:`introdb-community-s${String(record.season).padStart(2,'0')}e${String(record.episode).padStart(2,'0')}`,durationSeconds:runtime,toleranceSeconds:3},
    verification:{status,...(notes.length?{notes}:{})},markers,
    sources:record.sources.map(source=>({url:source.url,title:source.provider==='introdb'?'IntroDB.app':'TheIntroDB',retrievedAt:raw.retrievedAt,httpStatus:source.httpStatus,
      ...(source.provider==='introdb'&&a?{confidence:a.intro?.confidence??a.outro?.confidence??null,submissionCount:a.intro?.submission_count??a.outro?.submission_count??null}:{}),
      segmentEvidence:source.httpStatus===200?{intro:source.data?.intro??null,credits:source.data?.outro??source.data?.credits??null}:null}))};
});
const manifest={schemaVersion:1,dataVersion:'2026-10-15.community.1',series:{slug:'the-rings-of-power',title:'The Lord of the Rings: The Rings of Power',tmdbId:84773,imdbId:'tt7631058'},status:'community-reference',
  research:{retrievedAt:raw.retrievedAt,totalEpisodes:records.length,statusCounts:notesCount,notes:'References are community-contributed; matching runtime does not prove identical provider cuts. Missing runtime and conflicting windows remain inactive.'},records};
await writeFile(new URL('../web/series-markers/the-rings-of-power/manifest.json',import.meta.url),JSON.stringify(manifest,null,2)+'\n');

const quote=value=>`'${String(value).replaceAll("'","''")}'`;
const sql=['-- Public researched references only. No provider credentials or playback URLs.','begin;'];let rows=0,skipped=0;
for(const slug of ['game-of-thrones','the-rings-of-power']){
  const data=JSON.parse(await readFile(new URL(`../web/series-markers/${slug}/manifest.json`,import.meta.url),'utf8'));
  for(const record of data.records){
    const duration=record.edition?.durationSeconds,marks=validateSkipMarkers(record.markers,duration);
    if(!Number.isFinite(duration)||duration<=0||!marks||!Object.keys(marks).length){skipped++;continue;}
    const provenance={sources:record.sources,verification:record.verification,research:data.research??null};
    const values=[quote(slug),record.season,record.episode,quote(record.edition.id),data.series.tmdbId,quote(data.series.imdbId),duration,record.edition.toleranceSeconds,
      quote(record.verification.status),quote(JSON.stringify(marks))+'::jsonb',quote(JSON.stringify(provenance))+'::jsonb',quote(data.dataVersion),'true'];
    sql.push(`insert into public.episode_skip_markers(series_slug,season,episode,edition_id,tmdb_id,imdb_id,duration_seconds,tolerance_seconds,verification,markers,provenance,data_version,is_active) values(${values.join(',')}) on conflict(series_slug,season,episode,edition_id) do update set tmdb_id=excluded.tmdb_id,imdb_id=excluded.imdb_id,duration_seconds=excluded.duration_seconds,tolerance_seconds=excluded.tolerance_seconds,verification=excluded.verification,markers=excluded.markers,provenance=excluded.provenance,data_version=excluded.data_version,is_active=true,updated_at=now();`);rows++;
  }
}
sql.push('commit;','');await writeFile(new URL('../supabase/seed-series-markers.sql',import.meta.url),sql.join('\n'));
console.log(JSON.stringify({rings:notesCount,totalSQLRows:rows,skippedWithoutValidRuntimeOrBounds:skipped}));
