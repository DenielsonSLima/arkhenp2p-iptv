import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SKIPDB_LICENSE,SKIPDB_CACHE_MS} from '../lib/serie/marcadores/contrato.mjs';
import {normalizeSkipDBDump} from '../lib/serie/marcadores/normalizacao.mjs';
import {loadSkipDBDump} from '../lib/serie/marcadores/skipdb.mjs';
import {applySkipDBRows} from '../lib/serie/marcadores/supabase.mjs';
import {syncSeriesMarkers} from '../lib/serie/marcadores/orquestrador.mjs';

const registry=[{slug:'test-series',title:'Test Series',imdbId:'tt1234567',tmdbId:123,aliases:['Test Series']}];
const retrievedAt='2026-10-15T10:00:00Z';
const segment=(overrides={})=>({id:1,imdb_id:registry[0].imdbId,media_type:'series',season:1,episode:1,segment_type:'intro',status:'approved',start_ms:10000,end_ms:60000,duration_ms:600000,score:1,submitted_by:'opaque-private-id',...overrides});
const dump=segments=>({license:SKIPDB_LICENSE,license_url:'https://skipdb.tv/license',generated_at:'2026-10-14T10:00:00Z',count:segments.length,segments});
const normalize=segments=>normalizeSkipDBDump(dump(segments),{registry,retrievedAt});

test('SkipDB keeps editions with their own runtimes, removes submitters, and never invents missing duration',()=>{
  const result=normalize([segment(),segment({id:2,duration_ms:620000,start_ms:30000,end_ms:80000}),segment({id:3,duration_ms:null}),segment({id:4,episode:2,segment_type:'outro',start_ms:560000,end_ms:600000})]);
  assert.equal(result.rows.length,3);assert.deepEqual(result.rows.slice(0,2).map(row=>row.duration_seconds),[600,620]);
  assert.equal(result.snapshot.segments.length,4);assert.doesNotMatch(JSON.stringify(result),/submitted_by|opaque-private-id/);
  for(const row of result.rows){assert.match(row.edition_id,/^skipdb-[a-f0-9]{24}$/);assert.equal(row.verification,'community-reference');assert.equal(row.tolerance_seconds,2);assert.match(row.provenance.sources[0].url,/^https:/);}
  assert.equal(result.rows[2].markers.creditsStart,560);
});

test('deduplication and ordering yield stable edition IDs without averaging different windows',()=>{
  const a=segment(),b=segment({id:2,start_ms:12000,end_ms:62000,score:2}),conflict=segment({id:3,episode:2,start_ms:30000,end_ms:90000});
  const one=normalize([a,b,{...a,id:9},conflict,segment({id:4,episode:2,start_ms:10000,end_ms:60000})]);
  const two=normalize([conflict,b,a,segment({id:4,episode:2,start_ms:10000,end_ms:60000}),{...a,id:9}]);
  assert.equal(one.snapshot.segments.length,4);assert.deepEqual(one.rows.map(row=>row.edition_id),two.rows.map(row=>row.edition_id));
  assert.equal(one.rows[0].markers.openingStart,12);assert.equal(one.rows[1].markers.openingStart,undefined);assert.equal(one.rows[1].is_active,false);
});

test('pending/rejected entries never become automation and inconsistent complete dumps are rejected',()=>{
  assert.equal(normalize([segment({status:'pending'}),segment({status:'rejected',id:2})]).rows.length,0);
  assert.throws(()=>normalizeSkipDBDump({...dump([segment()]),count:2},{registry,retrievedAt}),{code:'SKIPDB_DUMP_INVALID'});
  for(const changes of [{start_ms:-1},{end_ms:700000},{end_ms:1},{duration_ms:0},{episode:0},{season:-1}])assert.throws(()=>normalize([segment(changes)]),{code:'SKIPDB_SELECTED_SEGMENT_INVALID'});
});

test('overlapping duration editions cannot select contradictory openings just by sort order',()=>{
  const result=normalize([segment({duration_ms:600000}),segment({id:2,duration_ms:601100,start_ms:10000,end_ms:74000}),
    segment({id:3,segment_type:'outro',duration_ms:600000,start_ms:560000,end_ms:600000}),segment({id:4,segment_type:'outro',duration_ms:601100,start_ms:560400,end_ms:601100})]);
  assert.equal(result.rows.length,2);
  for(const row of result.rows){assert.equal(row.markers.openingEnd,undefined);assert.ok(row.markers.creditsStart>=560&&row.markers.creditsStart<=561);assert.equal(row.is_active,true);}
  assert.equal(result.stats.ambiguousOpenings,2);
});

test('suppressed openings preserve source ranges for a conservative cross-source intersection',()=>{
  const result=normalize([segment({start_ms:0,end_ms:118700,duration_ms:3131600}),segment({id:2,start_ms:0,end_ms:115800,duration_ms:3132400}),
    segment({id:3,segment_type:'outro',start_ms:3047700,end_ms:3131600,duration_ms:3131600})]);
  const record=result.manifests['test-series'].records.find(value=>value.edition.durationSeconds===3131.6);
  assert.equal(record.markers.openingEnd,undefined,'The importer still does not choose an edition by sort order.');
  assert.deepEqual(record.verification.openingCandidates,[{openingStart:0,openingEnd:118.7,durationSeconds:3131.6},{openingStart:0,openingEnd:115.8,durationSeconds:3132.4}]);
  assert.equal(record.markers.creditsStart,3047.7);
});

test('mid-episode endings, previews, contradictory ordering and no-segment sentinels cannot skip narrative',()=>{
  const outro=segment({id:2,segment_type:'outro',start_ms:500000,end_ms:550000});
  assert.equal(normalize([outro]).rows[0].markers.creditsStart,undefined);
  assert.equal(normalize([outro]).rows[0].provenance.verification.blockEarlyNext,true);
  assert.equal(normalize([outro]).rows[0].is_active,true);
  const complete={...outro,end_ms:600000};
  const preview=segment({id:3,segment_type:'preview',start_ms:580000,end_ms:600000});
  assert.equal(normalize([complete,preview]).rows[0].markers.creditsStart,undefined);
  assert.equal(normalize([complete,segment({start_ms:520000,end_ms:570000})]).rows[0].markers.creditsStart,undefined);
  const absent=normalize([segment({start_ms:0,end_ms:0}),complete]);assert.equal(absent.rows[0].markers.openingEnd,undefined);assert.equal(absent.rows[0].markers.creditsStart,500);
});

test('an opening that reaches the runtime never creates a marker rejected by the database',()=>{
  const result=normalize([segment({start_ms:0,end_ms:600000})]);
  assert.deepEqual(result.rows[0].markers,{});assert.equal(result.rows[0].is_active,false);
  assert.equal(result.snapshot.segments[0].end_ms,600000);
});

test('dump fetching follows only official HTTPS redirects, enforces 64 MiB, and reuses its 24-hour private cache',async()=>{
  const cacheDir=await mkdtemp(join(tmpdir(),'arkhen-skipdb-cache-'));let requests=0;
  const fetch=async()=>{requests++;return new Response(JSON.stringify(dump([segment()])));};
  try{
    const first=await loadSkipDBDump({cacheDir,fetch,now:()=>Date.parse(retrievedAt)});assert.equal(first.cacheHit,false);assert.equal(requests,1);
    assert.equal((await loadSkipDBDump({cacheDir,fetch,now:()=>Date.parse(retrievedAt)+SKIPDB_CACHE_MS-1})).cacheHit,true);assert.equal(requests,1);
    await loadSkipDBDump({cacheDir,fetch,now:()=>Date.parse(retrievedAt)+SKIPDB_CACHE_MS});assert.equal(requests,2);
    await assert.rejects(loadSkipDBDump({cacheDir,force:true,fetch:async()=>new Response('',{status:302,headers:{location:'https://unrelated.example/dump'}})}),{code:'SKIPDB_REDIRECT_REJECTED'});
    await assert.rejects(loadSkipDBDump({cacheDir,force:true,fetch:async()=>new Response('{}',{headers:{'content-length':String(65*1024*1024)}})}),{code:'SKIPDB_DUMP_TOO_LARGE'});
  }finally{await rm(cacheDir,{recursive:true,force:true});}
});

test('publication inserts immutable own editions and only changes own non-verified activation state',async()=>{
  const rows=normalize([segment()]).rows,removed={...rows[0],episode:2,edition_id:'skipdb-removed',is_active:true},verified={...rows[0],episode:3,edition_id:'skipdb-verified',verification:'verified',is_active:true};
  const calls=[],cloud={ready:Promise.resolve(),enabled:true,request:async(path,options)=>{calls.push({path,options});return options?null:[removed,verified,{...rows[0],is_active:false}];}};
  const result=await applySkipDBRows(cloud,rows,{slugs:['test-series']});assert.deepEqual(result,{rows:1,activated:1,deactivated:1});
  const insertion=calls.find(call=>call.options?.method==='POST');assert.match(insertion.options.headers.Prefer,/ignore-duplicates/);
  const patches=calls.filter(call=>call.options?.method==='PATCH');assert.equal(patches.length,2);
  for(const call of patches){const params=new URL('https://cloud.example'+call.path).searchParams;assert.equal(params.get('provenance->>source'),'eq.skipdb');assert.equal(params.get('verification'),'neq.verified');assert.doesNotMatch(params.get('edition_id'),/verified/);}
});

test('a failed publication never deactivates existing rows and abort forbids all later writes',async()=>{
  const rows=normalize([segment()]).rows,calls=[];
  const cloud={ready:Promise.resolve(),enabled:true,request:async(path,options)=>{calls.push({path,options});if(options?.method==='POST')throw new Error('simulated failure');return [{...rows[0],edition_id:'skipdb-removed',is_active:true}];}};
  await assert.rejects(applySkipDBRows(cloud,rows,{slugs:['test-series']}));assert.equal(calls.some(call=>call.options?.method==='PATCH'),false);
  const controller=new AbortController();controller.abort();await assert.rejects(applySkipDBRows(cloud,rows,{signal:controller.signal}),{code:'SKIPDB_SYNC_ABORTED'});
});

test('a sync exports the exact open derivative before publishing and never touches legacy manifests',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'arkhen-skipdb-export-')),cacheDir=join(directory,'cache'),outputDir=join(directory,'public');
  await mkdir(directory,{recursive:true});await writeFile(join(directory,'legacy.json'),'unchanged');
  const cloud={ready:Promise.resolve(),enabled:true,request:async(path,options)=>{assert.ok(JSON.parse(await readFile(join(outputDir,'skipdb.json'),'utf8')).records.length);return options?null:[];}};
  try{const result=await syncSeriesMarkers({cloud,apply:true,registry,cacheDir,outputDir,fetch:async()=>new Response(JSON.stringify(dump([segment()])))});assert.equal(result.editions,1);assert.equal(result.publication.rows,1);assert.equal(await readFile(join(directory,'legacy.json'),'utf8'),'unchanged');assert.equal(JSON.parse(await readFile(join(outputDir,'test-series','manifest.json'),'utf8')).records[0].edition.toleranceSeconds,2);}
  finally{await rm(directory,{recursive:true,force:true});}
});
