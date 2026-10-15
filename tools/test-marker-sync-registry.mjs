// Isolated PostgreSQL/RLS fixture. No network, real accounts or credentials.
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
if(!process.argv[2])throw new Error('Pass the installed local PGlite module path.');
const {PGlite}=await import(pathToFileURL(process.argv[2]).href),db=new PGlite();
const user='10000000-0000-4000-8000-000000000001',other='10000000-0000-4000-8000-000000000002';
const provider='a'.repeat(64),scope='b'.repeat(64),foreign='e'.repeat(64),zero='00000000-0000-0000-0000-000000000000',candidate='90000000-0000-4000-8000-000000000001';
const q=(sql,args=[])=>db.query(sql,args);let assertions=0;
const check=(value,message)=>{assert.ok(value,message);assertions++;};
async function denied(run){await assert.rejects(run,error=>error.code==='42501');assertions++;}
async function as(role,id,run){await db.exec('set role '+role);await q("select set_config('request.jwt.claim.sub',$1,false)",[id||'']);try{return await run();}finally{await db.exec('reset role');await q("select set_config('request.jwt.claim.sub','',false)");}}
const status=(id=user,p=provider)=>as('authenticated',id,async()=>(await q('select public.arkhen_marker_sync_status($1,$2) data',[p,scope])).rows[0].data);
const load=async name=>{let sql=await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8');if(name.includes('marker_cloud_pipeline'))sql=sql.replace(/^create extension if not exists pg_net.*$/m,'').replace(/^select cron\.schedule\(.*$/m,'');await db.exec(sql);};
try{
  await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
    create schema auth;create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to anon,authenticated,service_role;grant execute on function auth.uid() to anon,authenticated,service_role;
    create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`);
  for(const name of ['20261015044236_arkhen_cloud_schema.sql','20261015053751_arkhen_manual_cache_refresh.sql','20261015095103_arkhen_shared_metadata_set_based.sql','20261015113615_arkhen_catalog_pages.sql','20261015113617_arkhen_marker_cloud_pipeline.sql','20261015115927_arkhen_cloud_provider_sources.sql','20261015115930_arkhen_cloud_collector.sql','20261015120527_arkhen_marker_incremental_source.sql','20261015131845_arkhen_catalog_previews.sql','20261015133920_arkhen_catalog_publish_scale.sql','20261015141803_arkhen_catalog_publish_batches.sql','20261015143432_arkhen_catalog_publish_memory.sql','20261015144254_arkhen_catalog_publication_diagnostics.sql','20261015150309_arkhen_catalog_domains.sql','20261015151331_arkhen_catalog_snapshot_preparation.sql','20261015152804_arkhen_catalog_generations.sql'])await load(name);
  await q('insert into auth.users values($1),($2)',[user,other]);
  for(const [id,hash,p] of [[user,'c'.repeat(64),provider],[other,'d'.repeat(64),foreign]]){
    await q("select public.arkhen_identity_bind($1,$2,'wplay',$3,$4)",[hash,id,p,scope]);
    await q("select public.arkhen_validate_account($1,'active',now()+interval '1 day',now(),$2,$3)",[id,p,scope]);
  }
  await q("update public.series_marker_sync_state set last_started_at=now()-interval '1 minute',last_finished_at=now(),last_result=$1",[{state:'ready',published:12,token:'NEVER-EXPOSE-THIS',dump:{publicObject:'NEVER-EXPOSE-THIS'}}]);
  await load('20261015155746_arkhen_marker_sync_registry.sql');
  await load('20261015162134_arkhen_marker_sync_metrics.sql');
  let value=await status();check(value.recent.length===1&&value.recent[0].published===12,'The real last cycle is retained once at installation.');
  check(value.providers.every(row=>row.configured===null),'Legacy workers without telemetry report unknown configuration.');
  check(!JSON.stringify(value).includes('NEVER-EXPOSE-THIS'),'Raw worker fields are absent from every public response.');
  check(value.global.episodes===null&&value.global.updatedAt===null&&value.catalog.withMarkers===null,'An unbuilt summary reports unknown coverage rather than a successful empty cache.');
  await q("insert into public.catalog_visible_generations(provider_key,scope_hash,media_type,generation_id) values($1,$3,'series',$4),($2,$3,'series',$4)",[provider,foreign,scope,zero]);
  for(const [id,name,p,adult,generation] of [['one','Known',provider,false,zero],['two','Unmatched',provider,false,zero],['three','Unprocessed',provider,false,zero],['adult','Restricted title',provider,true,zero],['other','OTHER SCOPE PRIVATE TITLE',foreign,false,zero],['future','UNPUBLISHED TITLE',provider,false,candidate]])
    await q("insert into public.catalog_media(provider_key,scope_hash,media_type,media_id,name,metadata,last_seen_snapshot,generation_id,is_adult) values($1,$2,'series',$3,$4,'{}',$5,$6,$7)",[p,scope,id,name,zero,generation,adult]);
  for(const [id,p,state,imdb,title] of [['one',provider,'resolved','tt1234567','Known'],['two',provider,'unresolved',null,'Unmatched'],['adult',provider,'failed',null,'Restricted title'],['other',foreign,'failed','tt7654321','OTHER SCOPE PRIVATE TITLE'],['future',provider,'failed',null,'UNPUBLISHED TITLE']])
    await q("insert into public.series_marker_identities(provider_key,scope_hash,media_id,catalog_name,status,imdb_id,series_slug,error_code) values($1,$2,$3,$4,$5,$6,$7,'IDENTITY_NOT_FOUND')",[p,scope,id,title,state,imdb,imdb?'imdb-'+imdb:null]);
  await q("insert into public.series_marker_titles(imdb_id,series_slug) values('tt1234567','imdb-tt1234567'),('tt7654321','imdb-tt7654321')");
  await q("insert into public.series_marker_coverage(imdb_id,series_slug,season,episode,status,evidence) values('tt1234567','imdb-tt1234567',1,1,'ready','{}'),('tt1234567','imdb-tt1234567',1,2,'unverified',$1),('tt7654321','imdb-tt7654321',1,1,'empty','{}')",[{introdb:{intro:{start_ms:1000,end_ms:60000}}}]);
  for(const edition of ['first','second'])await q("insert into public.episode_skip_markers(series_slug,imdb_id,season,episode,edition_id,duration_seconds,markers,verification,data_version) values('imdb-tt1234567','tt1234567',1,1,$1,600,'{\"openingStart\":1,\"openingEnd\":60}','community-reference','fixture')",[edition]);
  await as('service_role',null,()=>q('select public.arkhen_refresh_marker_sync_metrics()'));
  value=await status();check(value.global.episodes===3&&value.global.editions===2&&value.global.introEpisodes===2,'Coverage deduplicates editions and never counts overlapping sources twice.');
  check(value.catalog.series===3&&value.catalog.identifiedSeries===1&&value.catalog.pendingSeries===1&&value.catalog.unresolvedSeries===1,'Catalog identity counters use only safe visible series in the current partition.');
  check(value.catalog.episodes===2&&value.catalog.withMarkers===2,'Catalog coverage joins only uniquely resolved IMDb identities.');
  check(Boolean(value.global.updatedAt)&&value.global.updatedAt===value.catalog.updatedAt,'All coverage counters carry one shared publication timestamp.');
  check(value.issues.length===1&&value.issues[0].title==='Unmatched','Issues omit adult, unpublished and foreign titles.');
  check(value.identified.length===1&&value.identified[0].title==='Known'&&value.identified[0].imdbId==='tt1234567'&&value.identified[0].episodes===2&&value.identified[0].withMarkers===2,'Recent identified titles join real episode coverage in the safe authorized catalog.');
  check(!JSON.stringify(value).includes('OTHER SCOPE')&&!JSON.stringify(value).includes('UNPUBLISHED')&&!JSON.stringify(value).includes('Restricted title'),'No title from an unauthorized or unpublished partition leaks.');
  await denied(()=>status(other));await denied(()=>as('anon',null,()=>q('select public.arkhen_marker_sync_status($1,$2)',[provider,scope])));
  for(const table of ['marker_sync_registry','marker_sync_runs']){
    await denied(()=>as('anon',null,()=>q('select * from public.'+table)));
    await denied(()=>as('authenticated',user,()=>q('delete from public.'+table)));
  }
  await denied(()=>as('authenticated',user,()=>q('select * from public.series_marker_sync_state')));
  await denied(()=>as('authenticated',user,()=>q('select public.arkhen_refresh_marker_sync_metrics()')));
  await denied(()=>as('authenticated',user,()=>q('delete from public.marker_series_sync_metrics')));
  await denied(()=>as('anon',null,()=>q('select * from public.marker_series_sync_metrics')));
  const original=(await q("select pg_get_functiondef('public.arkhen_refresh_marker_sync_metrics()'::regprocedure) body")).rows[0].body;
  const beforeSummary=JSON.stringify((await status()).global);
  await q("insert into public.series_marker_coverage(imdb_id,series_slug,season,episode,status) values('tt1234567','imdb-tt1234567',1,3,'pending')");
  check(JSON.stringify((await status()).global)===beforeSummary,'Reading settings reuses the last completed summary rather than rescanning global JSON.');
  await db.exec(original.replace('  update public.marker_sync_registry',"  raise exception 'SIMULATED_SUMMARY_FAILURE';\n  update public.marker_sync_registry"));
  await assert.rejects(()=>as('service_role',null,()=>q('select public.arkhen_refresh_marker_sync_metrics()')),/SIMULATED_SUMMARY_FAILURE/);assertions++;
  check(JSON.stringify((await status()).global)===beforeSummary,'A failed summary refresh rolls back rows and preserves its true publication time.');
  await db.exec(original);await as('service_role',null,()=>q('select public.arkhen_refresh_marker_sync_metrics()'));
  check((await status()).global.episodes===4,'A later successful refresh atomically publishes changed coverage.');
  const healthy={skipdb:{configured:true,lastCheckedAt:'2026-10-15T16:00:00.000Z',lastSuccessAt:'2026-10-15T16:00:00.000Z',errorCode:null,secret:'NEVER-EXPOSE-THIS'},introdb:{configured:false,lastCheckedAt:'2026-10-15T16:01:00.000Z',errorCode:'PROVIDER_RATE_LIMITED'}};
  await as('service_role',null,()=>q("update public.series_marker_sync_state set lease_owner=$1,lease_until=now()+interval '1 minute',last_started_at=now()+interval '1 second' where name='global'",[candidate]));
  check((await status()).status==='running','The active lease is projected as running without exposing the owner.');
  await as('service_role',null,()=>q("update public.series_marker_sync_state set last_finished_at=last_started_at+interval '1 second',lease_owner=null,lease_until=null,introdb_cooldown_until=now()+interval '10 minutes',last_result=$1",[{state:'partial',identities:3,episodesChecked:4,skipdb:1,introdb:3,failures:1,published:-3,unverified:'NOT-A-COUNT',elapsedMs:1500,code:'raw-secret-with-url',providerStatus:healthy,headers:{Authorization:'NEVER-EXPOSE-THIS'}}]));
  value=await status();check(value.status==='partial'&&value.recent.length===2,'A completed cycle produces one persistent global record.');
  check(value.recent[0].published===0&&value.recent[0].unverified===0&&value.recent[0].errorCode===null,'Malformed counters and non-enum raw errors cannot enter history.');
  check(value.providers[0].configured===true&&value.providers[1].configured===false&&value.providers[1].status==='cooldown','API-key presence is a boolean; provider cooldown is represented accurately.');
  check(!JSON.stringify(value).includes('NEVER-EXPOSE-THIS')&&!JSON.stringify(value).includes(candidate),'Raw secrets and lease identifiers remain private.');
  await q("update public.series_marker_sync_state set last_finished_at=last_finished_at");
  check((await status()).recent.length===2,'Repeated projection of the same completed cycle is idempotent.');
  await q("insert into public.marker_sync_runs(started_at,finished_at,status,counters) select now()-interval '10 days'+i*interval '1 minute',now()-interval '10 days'+i*interval '1 minute','ready','{}' from generate_series(1,25) i");
  check((await status()).recent.length===20,'The settings response has a fixed maximum of twenty recent cycles.');
  await q("insert into public.marker_sync_runs(started_at,finished_at,status,counters) select now()-interval '40 days'+i*interval '1 minute',now()-interval '40 days'+i*interval '1 minute','ready','{}' from generate_series(1,120) i");
  await q("update public.series_marker_sync_state set last_finished_at=last_finished_at");
  check(Number((await q("select count(*) n from public.marker_sync_runs where finished_at<now()-interval '30 days'")).rows[0].n)===20,'History retention deletes no more than one hundred old records per cycle.');
  await q("update public.series_marker_sync_state set last_started_at=now()-interval '4 minutes',last_finished_at=now()-interval '5 minutes',lease_until=now()-interval '3 minutes' where name='global'");
  check((await status()).status==='partial','An expired unfinished lease cannot pretend the previous successful cycle is current.');
  await q("update public.series_marker_sync_state set last_started_at=now(),lease_until=now()+interval '1 minute' where name='global'");
  check((await status()).recent.some(row=>row.errorCode==='MARKER_RUN_INTERRUPTED'),'A crashed cycle is recorded once when the worker resumes.');
  await q("update public.profiles set last_validated_at=now()-interval '2 days' where id=$1",[user]);
  await denied(()=>status());check((await as('authenticated',user,()=>q('select * from public.marker_sync_runs'))).rows.length===0,'Expired authorization cannot read global operational records.');
  await load('20261015182553_arkhen_marker_target_audit.sql');
  await as('service_role',null,()=>q("update public.series_marker_coverage set audit_priority=100,audit_requested_at=now(),next_check_at=now() where imdb_id='tt1234567' and episode=1"));
  const prioritized=(await as('service_role',null,()=>q("select imdb_id,episode,status from public.series_marker_coverage where next_check_at<=now() and (status in ('pending','empty','unverified','failed') or audit_priority>0) order by audit_priority desc,next_check_at,imdb_id,season,episode limit 10"))).rows;
  check(prioritized[0].episode===1&&prioritized[0].status==='ready','An explicit reference audit prioritizes a ready edition without downgrading it.');
  await denied(()=>as('authenticated',user,()=>q("update public.series_marker_coverage set audit_priority=100")));
  check((await q("select count(*)::int n from pg_indexes where indexname='arkhen_marker_coverage_priority_due'")).rows[0].n===1,'The bounded priority lookup has a matching partial index.');
  for(const firstRequest of [null,'2026-10-15T12:00:00Z']){
    await q("update public.series_marker_coverage set audit_requested_at=$1,updated_at='2026-10-15T12:00:00Z',audit_priority=0 where imdb_id='tt1234567' and episode=1",[firstRequest]);
    await q("update public.series_marker_coverage set audit_requested_at='2026-10-15T13:00:00Z',updated_at='2026-10-15T13:00:00Z',audit_priority=100,next_check_at='2026-10-15T13:00:00Z' where imdb_id='tt1234567' and episode=1");
    const stale=await q("update public.series_marker_coverage set audit_priority=0,next_check_at=now()+interval '7 days' where imdb_id='tt1234567' and episode=1 and audit_requested_at is not distinct from $1::timestamptz and updated_at='2026-10-15T12:00:00Z' returning episode",[firstRequest]);
    check(stale.rows.length===0,'An in-flight normal or audit response cannot overwrite a newer requested audit.');
    check((await q("select audit_priority=100 and next_check_at='2026-10-15T13:00:00Z' as preserved from public.series_marker_coverage where imdb_id='tt1234567' and episode=1")).rows[0].preserved,'The new priority and due time survive a stale completion.');
  }
  if(process.argv[3]){
    const prepared=await readFile(process.argv[3],'utf8'),literal=prepared.match(/jsonb_populate_recordset\(null::public\.series_marker_identities,('(?:''|[^'])*')::jsonb\)/)?.[1];
    if(!literal)throw new Error('Prepared audit identities missing.');
    const bindings=JSON.parse(literal.slice(1,-1).replace(/''/g,"'"));
    for(const binding of bindings){
      await q("insert into public.catalog_visible_generations(provider_key,scope_hash,media_type,generation_id) values($1,$2,'series',$3) on conflict do nothing",[binding.provider_key,binding.scope_hash,zero]);
      await q("insert into public.catalog_media(provider_key,scope_hash,media_type,media_id,name,metadata,last_seen_snapshot,generation_id,is_adult) values($1,$2,'series',$3,$4,$5,$6,$7,false)",[binding.provider_key,binding.scope_hash,binding.media_id,binding.catalog_name,binding.catalog_metadata,binding.source_snapshot,zero]);
    }
    await db.exec(prepared);
    check((await q("select count(*)::int n from public.series_marker_coverage where audit_priority>=50")).rows[0].n===1388,'The atomic prepared audit queues all 1,387 requested references and preserves the existing queued fixture.');
    check((await q("select count(*)::int n from public.series_marker_identities where evidence->>'method'='curated-exact-title-year-public-identity'")).rows[0].n===9,'All nine current native identities are reconciled atomically.');
  }
  console.log(JSON.stringify({ok:true,assertions}));
}finally{await db.close();}
