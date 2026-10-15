// Local PostgreSQL contract fixture only; no real credentials or remote writes.
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
if(!process.argv[2])throw new Error('Pass the installed local PGlite module path.');
const {PGlite}=await import(pathToFileURL(process.argv[2]).href),db=new PGlite();
const provider='a'.repeat(64),scope='b'.repeat(64),user='10000000-0000-4000-8000-000000000001',other='10000000-0000-4000-8000-000000000002';
let assertions=0;const check=(value,message)=>{assert.ok(value,message);assertions++;};
const q=(sql,args=[])=>db.query(sql,args),migration=async name=>db.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
async function as(role,id,run){await db.exec('set role '+role);await q("select set_config('request.jwt.claim.sub',$1,false)",[id||'']);try{return await run();}finally{await db.exec('reset role');await q("select set_config('request.jwt.claim.sub','',false)");}}
try{
 await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to anon,authenticated,service_role;grant execute on function auth.uid() to anon,authenticated,service_role;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`);
 for(const name of ['20261015044236_arkhen_cloud_schema.sql','20261015053751_arkhen_manual_cache_refresh.sql','20261015095103_arkhen_shared_metadata_set_based.sql','20261015113615_arkhen_catalog_pages.sql','20261015115927_arkhen_cloud_provider_sources.sql','20261015115930_arkhen_cloud_collector.sql','20261015131845_arkhen_catalog_previews.sql','20261015133920_arkhen_catalog_publish_scale.sql','20261015141803_arkhen_catalog_publish_batches.sql','20261015143432_arkhen_catalog_publish_memory.sql','20261015144254_arkhen_catalog_publication_diagnostics.sql'])await migration(name);
 await q('insert into auth.users values($1),($2)',[user,other]);
 for(const [id,hash,p] of [[user,'c'.repeat(64),provider],[other,'d'.repeat(64),'e'.repeat(64)]]){
  await q("select public.arkhen_identity_bind($1,$2,'wplay',$3,$4)",[hash,id,p,scope]);await q("select public.arkhen_validate_account($1,'active',now()+interval '1 day',now(),$2,$3)",[id,p,scope]);
 }
 const job=(await q("insert into arkhen_private.cache_jobs(provider_key,scope_hash,job_type,status,locked_by,lease_until) values($1,$2,'catalog','leased','movie-worker',now()+interval '10 minutes') returning id",[provider,scope])).rows[0].id;
 const data={categories:[{id:'safe',name:'Drama'}],items:[{id:'one',name:'Preserved movie',kind:'movie',categoryId:'safe',poster:'/api/shared-image/'+'f'.repeat(64)}]};
 await q("select public.arkhen_cloud_catalog_checkpoint($1,'movie-worker','movies','movies:0:1:0',$2,$3)",[job,data,{type:'movies',typeReady:'movies'}]);
 await q("select public.arkhen_cloud_catalog_publish($1,'movie-worker','movies')",[job]);
 const before=(await q('select progress from arkhen_private.cloud_job_progress where job_id=$1',[job])).rows[0].progress;
 let leaseGuard=false;try{await migration('20261015150309_arkhen_catalog_domains.sql');}catch(error){leaseGuard=error.code==='55000';await db.exec('rollback');}check(leaseGuard,'Cutover refuses an active legacy lease instead of stealing a worker.');
 await q("update arkhen_private.cache_jobs set status='queued',locked_by=null,lease_until=null,run_after=now()+interval '1 day' where id=$1",[job]);
 await migration('20261015150309_arkhen_catalog_domains.sql');
 const retained=(await q('select payload,status,attempts from arkhen_private.cache_jobs where id=$1',[job])).rows[0];
 check(retained.payload.media_type==='movies'&&retained.status==='queued'&&retained.attempts===0,'Legacy movie job identity and retry state are retained.');
 check((await q('select count(*)::int n from arkhen_private.cloud_catalog_staging where job_id=$1',[job])).rows[0].n===1,'Cutover preserves raw staging rows.');
 check((await q('select count(*)::int n from arkhen_private.catalog_publish_items where job_id=$1',[job])).rows[0].n===1,'Cutover preserves normalized private items.');
 check(JSON.stringify((await q('select progress from arkhen_private.cloud_job_progress where job_id=$1',[job])).rows[0].progress)===JSON.stringify(before),'Cutover preserves the publication cursor and full checkpoint.');
 const jobs=(await q("select id,payload->>'media_type' media_type from arkhen_private.cache_jobs where provider_key=$1 and job_type='catalog' and status='queued'",[provider])).rows;
 check(jobs.length===3&&new Set(jobs.map(row=>row.media_type)).size===3,'All three catalogs have independent active tasks.');
 let duplicate=false;try{await q("insert into arkhen_private.cache_jobs(provider_key,scope_hash,job_type,payload) values($1,$2,'catalog','{\"media_type\":\"movies\"}')",[provider,scope]);}catch(error){duplicate=error.code==='23505';}check(duplicate,'The active unique index deduplicates the same type without merging different types.');
 let untyped=false;try{await q("insert into arkhen_private.cache_jobs(provider_key,scope_hash,job_type) values($1,$2,'catalog')",[provider,scope]);}catch(error){untyped=error.code==='23514';}check(untyped,'New active catalog jobs require an explicit valid type.');
 for(const sql of ["select public.arkhen_cloud_catalog_checkpoint($1,'movie-worker','series','series:0:1:0',$2,'{}')","select public.arkhen_catalog_preview_seed($1,'movie-worker','series',$2)"]){let denied=false;try{await q(sql,[job,{categories:[],items:[]}]);}catch(error){denied=error.code==='22023';}check(denied,'Catalog task cannot write another media type.');}
 await q("select public.arkhen_source_put($1,$2,$3,$4,now()+interval '20 minutes')",[provider,scope,'f'.repeat(64),{version:1,iv:'a'.repeat(16),ciphertext:'b'.repeat(24)}]);
 const series=jobs.find(row=>row.media_type==='series').id;
 // Make SERIES the next ready task; MOVIES remains intentionally delayed.
 await q("update arkhen_private.cache_jobs set run_after=now()+interval '1 day' where job_type='catalog' and payload->>'media_type'='live'");
 const claimed=(await as('service_role',null,()=>q("select * from public.arkhen_claim_cloud_cache_jobs('series-worker')"))).rows[0];
 check(claimed.id===series&&claimed.payload.media_type==='series','A delayed movie publication does not block claiming a series task.');
 const seriesData={categories:[{id:'safe',name:'Drama'},{id:'vip',name:'VIP',isAdult:true}],items:[{id:'s1',name:'Safe series',kind:'series',categoryId:'safe'},{id:'s2',name:'Restricted series',kind:'series',categoryId:'vip'}]};
 await q("select public.arkhen_cloud_catalog_checkpoint($1,'series-worker','series','series:0:1:0',$2,$3)",[series,seriesData,{type:'series',typeReady:'series'}]);
 await q("select public.arkhen_cloud_catalog_publish($1,'series-worker','series')",[series]);
 await q("select public.arkhen_cloud_catalog_publish($1,'series-worker','series')",[series]);
 const result=(await as('authenticated',user,()=>q("select public.arkhen_catalog_page($1,$2,'series') data",[provider,scope]))).rows[0].data;
 check(result.catalogComplete&&result.items.length===1&&result.items[0].id==='s1'&&result.pagination.total===1,'Series publication is complete independently and filters restricted metadata before counting.');
 check((await as('authenticated',other,()=>q("select public.arkhen_catalog_page($1,$2,'series') data",[provider,scope]))).rows[0].data===null,'The independent series reader still enforces account partition RLS.');
 check((await q('select count(*)::int n from arkhen_private.catalog_publish_items where job_id=$1',[job])).rows[0].n===1,'Series publication does not remove movie normalization.');
 await q("update arkhen_private.cache_jobs set status='leased',locked_by='movie-worker',lease_until=now()+interval '10 minutes' where id=$1",[job]);
 const publisher=(await q("select pg_get_functiondef('public.arkhen_cloud_catalog_publish(uuid,text,text)'::regprocedure) body")).rows[0].body;
 await db.exec(publisher.replace(' insert into public.provider_catalog_cache('," perform pg_sleep(0.02);raise query_canceled;\n insert into public.provider_catalog_cache("));
 const canceled=(await q("select public.arkhen_cloud_catalog_publish($1,'movie-worker','movies') state",[job])).rows[0].state;
 const timing=canceled.publicationFailure.phaseTimings;
 check(canceled.publicationFailure.stage==='snapshot'&&timing.snapshot>=20&&timing.media>=0&&timing.artwork_insert>=0,'Cancellation retains per-phase duration instead of attributing cumulative elapsed time to the final operation.');
 check(Object.values(timing).every(value=>Number.isFinite(value)&&value>=0),'Recorded phase timings contain only bounded numeric measurements.');
 check((await q("select item_count from public.provider_catalog_cache where media_type='series'")).rows[0].item_count===2,'A canceled movie publication preserves the completed series snapshot.');
 await db.exec(publisher);await q("select public.arkhen_cloud_catalog_publish($1,'movie-worker','movies')",[job]);
 check((await q("select item_count from public.provider_catalog_cache where media_type='movies'")).rows[0].item_count===1,'Movies can publish later without depending on series state.');
 for(const role of ['anon','authenticated']){let denied=false;try{await as(role,user,()=>q("select arkhen_private.assert_catalog_type($1,'movies')",[job]));}catch(error){denied=error.code==='42501';}check(denied,'Browser roles cannot inspect or change catalog task ownership.');}
 await migration('20261015151331_arkhen_catalog_snapshot_preparation.sql');
 await q("update arkhen_private.cache_jobs set status='succeeded',locked_by=null,lease_until=null where id=$1",[job]);
 const preparedJob=(await q("insert into arkhen_private.cache_jobs(provider_key,scope_hash,job_type,payload,status,locked_by,lease_until) values($1,$2,'catalog','{\"media_type\":\"movies\"}','leased','prepare-worker',now()+interval '10 minutes') returning id",[provider,scope])).rows[0].id;
 const replacement={categories:[{id:'safe',name:'Drama'}],items:[{id:'new-1',name:'New movie1',kind:'movie',categoryId:'safe'},{id:'new-2',name:'New movie2',kind:'movie',categoryId:'safe'}]};
 await q("select public.arkhen_cloud_catalog_checkpoint($1,'prepare-worker','movies','movies:0:1:0',$2,$3)",[preparedJob,replacement,{type:'movies',typeReady:'movies'}]);
 const prepareCall=async()=>((await q("select public.arkhen_cloud_catalog_publish($1,'prepare-worker','movies') state",[preparedJob])).rows[0].state);
 await prepareCall();
 const preparePublisher=(await q("select pg_get_functiondef('public.arkhen_cloud_catalog_publish(uuid,text,text)'::regprocedure) body")).rows[0].body;
 await db.exec(preparePublisher.replace("  state:=state||jsonb_build_object('publicationPreparedTypes'","  raise query_canceled;\n  state:=state||jsonb_build_object('publicationPreparedTypes'"));
 const interruptedPreparation=await prepareCall();
 check(interruptedPreparation.publicationFailure.stage==='catalog_build'&&(await q('select count(*)::int n from arkhen_private.catalog_prepared_snapshots where job_id=$1',[preparedJob])).rows[0].n===0,'Canceled preparation rolls back its JSON candidate while retaining normalized staging.');
 await db.exec(preparePublisher);
 const preparedState=await prepareCall();
 check(preparedState.publicationPreparedTypes.includes('movies')&&!preparedState.publishedTypes?.includes('movies'),'Preparing private JSON does not declare a complete public catalog.');
 const checkpointBody=(await q("select pg_get_functiondef('public.arkhen_cloud_catalog_checkpoint(uuid,text,text,text,jsonb,jsonb)'::regprocedure) body")).rows[0].body;
 check(checkpointBody.indexOf('assert_cache_lease(')<checkpointBody.indexOf('exists(select 1 from arkhen_private.catalog_prepared_snapshots'),'Checkpoint rechecks frozen preparation only after acquiring the same owned job lease lock.');
 let ownerDenied=false;try{await q("select public.arkhen_cloud_catalog_checkpoint($1,'another-worker','movies','movies:0:2:0',$2,'{}')",[preparedJob,data]);}catch(error){ownerDenied=error.code==='55000';}check(ownerDenied,'A different worker cannot inspect preparation state or append a late page.');
 await db.exec('begin');let leaseExpired=false;
 try{await q("update arkhen_private.cache_jobs set lease_until=now()-interval '1 minute' where id=$1",[preparedJob]);await prepareCall();}catch(error){leaseExpired=error.code==='55000';}finally{await db.exec('rollback');}
 check(leaseExpired,'An expired lease cannot publish an already prepared snapshot.');
 check((await q("select item_count from public.provider_catalog_cache where media_type='movies'")).rows[0].item_count===1,'The previous complete snapshot remains visible throughout preparation.');
 for(const role of ['anon','authenticated']){let denied=false;try{await as(role,user,()=>q('select payload from arkhen_private.catalog_prepared_snapshots'));}catch(error){denied=error.code==='42501';}check(denied,'Prepared metadata remains inaccessible to browser roles.');}
 let frozen=false;try{await q("select public.arkhen_cloud_catalog_checkpoint($1,'prepare-worker','movies','movies:0:2:0',$2,'{}')",[preparedJob,data]);}catch(error){frozen=error.message==='Catalog publication already prepared';}check(frozen,'A late provider page cannot mutate the generation after JSON preparation.');
 await db.exec('begin');let revision=false;
 try{await q("update arkhen_private.cloud_job_progress set progress=jsonb_set(progress,'{publicationCursors,movies}','999999') where job_id=$1",[preparedJob]);await prepareCall();}catch(error){revision=error.message==='Prepared catalog normalization revision mismatch';}finally{await db.exec('rollback');}
 check(revision,'A prepared payload cannot be used with another normalization cursor.');
 await db.exec('begin');let expired=false;
 try{await q("update arkhen_private.provider_sources set expires_at=now()-interval '1 minute'");await prepareCall();}catch(error){expired=error.message==='Valid cloud source required for publication';}finally{await db.exec('rollback');}
 check(expired,'Final publication still requires a valid encrypted provider source and its owned lease.');
 await db.exec(preparePublisher.replace(' insert into public.provider_catalog_cache('," raise query_canceled;\n insert into public.provider_catalog_cache("));
 const canceledFinal=await prepareCall();
 check(canceledFinal.publicationFailure.stage==='snapshot'&&(await q('select count(*)::int n from arkhen_private.catalog_prepared_snapshots where job_id=$1',[preparedJob])).rows[0].n===1,'Canceled final publication retains the already committed private JSON for retry.');
 check((await q("select item_count from public.provider_catalog_cache where media_type='movies'")).rows[0].item_count===1,'A final cancellation rolls back public index changes and preserves the earlier complete snapshot.');
 await db.exec(preparePublisher);const completedPrepared=await prepareCall();
 check(completedPrepared.publishedTypes.includes('movies')&&(await q("select item_count from public.provider_catalog_cache where media_type='movies'")).rows[0].item_count===2,'The final transaction publishes the prepared complete catalog and normalized index together.');
 check((await q('select count(*)::int n from arkhen_private.catalog_prepared_snapshots where job_id=$1',[preparedJob])).rows[0].n===0&&(await q('select count(*)::int n from arkhen_private.cloud_catalog_staging where job_id=$1',[preparedJob])).rows[0].n===0,'Prepared JSON and staging are cleaned only by a committed successful final publication.');
 check(JSON.stringify(await prepareCall())===JSON.stringify(completedPrepared),'A repeated successful final call cannot replace the published catalog with an empty one.');
 const markerSQL=await readFile(new URL('../supabase/migrations/20261015113617_arkhen_marker_cloud_pipeline.sql',import.meta.url),'utf8');
 await db.exec(markerSQL.slice(markerSQL.indexOf('create table if not exists public.series_marker_identities'),markerSQL.indexOf('create index if not exists arkhen_marker_identities_due')));
 await db.exec(markerSQL.slice(markerSQL.indexOf('create or replace function public.arkhen_marker_discover('),markerSQL.indexOf('create or replace function public.arkhen_marker_claim(')));
 await db.exec('grant all on public.series_marker_identities to service_role');
 await q("update arkhen_private.cache_jobs set status='succeeded',locked_by=null,lease_until=null where status in('queued','leased')");
 const priorPreparedJob=(await q("insert into arkhen_private.cache_jobs(provider_key,scope_hash,job_type,payload,status,locked_by,lease_until) values($1,$2,'catalog','{\"media_type\":\"movies\"}','leased','prior-prepare',now()+interval '10 minutes') returning id",[provider,scope])).rows[0].id;
 await q("select public.arkhen_cloud_catalog_checkpoint($1,'prior-prepare','movies','movies:0:1:0',$2,$3)",[priorPreparedJob,data,{type:'movies',typeReady:'movies'}]);
 await q("select public.arkhen_cloud_catalog_publish($1,'prior-prepare','movies')",[priorPreparedJob]);await q("select public.arkhen_cloud_catalog_publish($1,'prior-prepare','movies')",[priorPreparedJob]);
 await q("update arkhen_private.cache_jobs set status='queued',locked_by=null,lease_until=null where id=$1",[priorPreparedJob]);
 await migration('20261015152804_arkhen_catalog_generations.sql');
 const zero='00000000-0000-0000-0000-000000000000',future='90000000-0000-4000-8000-000000000001';
 const preservedPrepared=(await q('select payload,generation_id from arkhen_private.catalog_prepared_snapshots where job_id=$1',[priorPreparedJob])).rows[0];
 check(preservedPrepared.payload.items[0].id==='one'&&preservedPrepared.generation_id!==zero,'Generation cutover retains an existing prepared JSON payload and assigns its immutable generation.');
 await db.exec('begin');
 await q("update arkhen_private.cache_jobs set status='leased',locked_by='prior-prepare',lease_until=now()+interval '10 minutes' where id=$1",[priorPreparedJob]);
 await q("select public.arkhen_cloud_catalog_publish($1,'prior-prepare','movies')",[priorPreparedJob]);
 check((await q('select indexed_items from arkhen_private.catalog_generation_copies where job_id=$1',[priorPreparedJob])).rows[0].indexed_items===1,'An already prepared import resumes directly at its bounded index copy after cutover.');
 await db.exec('rollback');await q("update arkhen_private.cache_jobs set status='failed',finished_at=now() where id=$1",[priorPreparedJob]);
 const rowsFor=async(table,role='authenticated',id=user)=>((await as(role,id,()=>q('select * from public.'+table+" where media_type='movies'"+(table==='catalog_artwork_refs'?'':' and is_active')))).rows);
 check((await rowsFor('catalog_media')).length===2,'Migration preserves the complete legacy generation for current viewers.');
 const coldJob=(await q("insert into arkhen_private.cache_jobs(provider_key,scope_hash,job_type,payload,status,locked_by,lease_until) values($1,$2,'catalog','{\"media_type\":\"live\"}','leased','cold-worker',now()+interval '10 minutes') returning id",[provider,scope])).rows[0].id;
 const cold={categories:[{id:'tv',name:'TV'}],items:[{id:'ch1',name:'Cold TV',kind:'live',categoryId:'tv',poster:'/api/shared-image/'+'6'.repeat(64)}]};
 await q("select public.arkhen_catalog_preview_seed($1,'cold-worker','live',$2)",[coldJob,cold]);
 check((await as('authenticated',user,()=>q("select * from public.catalog_media where media_type='live' and is_active"))).rows.length===1,'A cold preview explicitly registers generation0 without a complete header.');
 check((await as('authenticated',user,()=>q("select * from public.catalog_artwork_refs where media_type='live'"))).rows.length===1,'Cold preview artwork remains resolvable through the same generation registry RLS.');
 check((await q("select count(*)::int n from public.provider_catalog_cache where media_type='live'")).rows[0].n===0,'Cold registry initialization never advertises a complete snapshot.');
 await q("update arkhen_private.cache_jobs set status='succeeded',locked_by=null,lease_until=null where id=$1",[coldJob]);
 const generationJob=(await q("insert into arkhen_private.cache_jobs(provider_key,scope_hash,job_type,payload,status,locked_by,lease_until) values($1,$2,'catalog','{\"media_type\":\"movies\"}','leased','generation-worker',now()+interval '10 minutes') returning id",[provider,scope])).rows[0].id;
 const generated={categories:[{id:'safe',name:'Drama'},{id:'vip',name:'VIP',isAdult:true}],items:Array.from({length:600},(_,index)=>({id:'v'+String(index+1).padStart(3,'0'),name:'Generation title '+index,kind:'movie',categoryId:index<60?'vip':'safe',poster:'/api/shared-image/'+'9'.repeat(64)}))};
 await q("select public.arkhen_cloud_catalog_checkpoint($1,'generation-worker','movies','movies:0:1:0',$2,$3)",[generationJob,generated,{type:'movies',typeReady:'movies'}]);
 const copy=async(worker='generation-worker')=>((await q("select public.arkhen_cloud_catalog_publish($1,$2,'movies') state",[generationJob,worker])).rows[0].state);
 await copy();await copy(); // Private normalization then private JSON preparation.
 const generation=(await q('select generation_id from arkhen_private.catalog_prepared_snapshots where job_id=$1',[generationJob])).rows[0].generation_id;
 const beforeHeader=(await q("select snapshot_id,index_generation,expires_at from public.provider_catalog_cache where media_type='movies'")).rows[0];
 await copy();
 await q("select public.arkhen_catalog_preview_seed($1,'generation-worker','movies',$2)",[generationJob,{categories:[],items:[]}]);
 check((await q("select generation_id from public.catalog_visible_generations where media_type='movies'")).rows[0].generation_id===zero,'A preview probe during index copy cannot switch the already published generation.');
 check((await q('select indexed_items from arkhen_private.catalog_generation_copies where job_id=$1',[generationJob])).rows[0].indexed_items===256,'One public index call copies at most256 titles.');
 check((await rowsFor('catalog_media')).length===2&&(await rowsFor('catalog_artwork_refs')).length===0,'Uncommitted generations stay invisible to direct authenticated metadata and artwork queries.');
 check((await as('authenticated',other,()=>q('select * from public.catalog_visible_generations where provider_key=$1',[provider]))).rows.length===0,'Generation registry RLS excludes another account partition.');
 check((await as('authenticated',user,()=>q("select public.arkhen_catalog_page($1,$2,'movies') data",[provider,scope]))).rows[0].data.pagination.total===2,'Paged catalog continues to expose only the older complete snapshot during copy.');
 await q("update public.profiles set status='disabled' where id=$1",[user]);check((await rowsFor('catalog_media')).length===0,'A disabled profile cannot read any generation through the registry.');await q("update public.profiles set status='active' where id=$1",[user]);
 await q("update arkhen_private.cache_jobs set lease_until=now()-interval '1 minute' where id=$1",[generationJob]);
 const takeover=(await as('service_role',null,()=>q("select * from public.arkhen_claim_cloud_cache_jobs('generation-recovery')"))).rows[0];check(takeover.id===generationJob,'A new owner resumes the original job and its generation after a process crash.');
 let staleOwner=false;try{await copy();}catch(error){staleOwner=error.code==='55000';}check(staleOwner,'The previous worker cannot copy after its lease was reassigned.');
 await copy('generation-recovery');check((await q('select indexed_items from arkhen_private.catalog_generation_copies where job_id=$1',[generationJob])).rows[0].indexed_items===512,'A new invocation resumes the durable copy cursor without duplicates.');
 await copy('generation-recovery');check((await q('select complete from arkhen_private.catalog_generation_copies where job_id=$1',[generationJob])).rows[0].complete,'A short last batch records the complete index privately.');
 const generationPublisher=(await q("select pg_get_functiondef('public.arkhen_cloud_catalog_publish(uuid,text,text)'::regprocedure) body")).rows[0].body;
 await db.exec(generationPublisher.replace(" state:=(state-'typeReady')", " raise query_canceled;\n state:=(state-'typeReady')"));
 const canceledSwap=await copy('generation-recovery');check(canceledSwap.publicationFailure.stage==='snapshot','A canceled registry/header swap reports its fixed phase.');
 const rolledBack=(await q("select snapshot_id,index_generation from public.provider_catalog_cache where media_type='movies'")).rows[0];
 check(rolledBack.snapshot_id===beforeHeader.snapshot_id&&rolledBack.index_generation===zero&&(await rowsFor('catalog_media')).length===2,'Cancellation after the header trigger rolls back both header and visible-generation registry.');
 check((await q('select count(*)::int n from public.catalog_media where generation_id=$1',[generation])).rows[0].n===600,'Canceling final swap preserves previously committed hidden index batches.');
 await db.exec(generationPublisher);await copy('generation-recovery');
 const switched=(await q("select snapshot_id,index_generation,item_count,safe_item_count from public.provider_catalog_cache where media_type='movies'")).rows[0];
 check(switched.index_generation===generation&&switched.snapshot_id===generation&&switched.item_count===600&&switched.safe_item_count===540,'Final publication uses the same prepared revision for header, generation and counts.');
 check((await rowsFor('catalog_media')).length===600&&(await rowsFor('catalog_artwork_refs')).length===600,'The final atomic swap makes exactly the complete candidate visible.');
 const locked=(await as('authenticated',user,()=>q("select public.arkhen_catalog_page($1,$2,'movies') data",[provider,scope]))).rows[0].data;
 check(locked.pagination.total===540&&locked.items.length===120&&locked.pagination.snapshotId===generation,'Typed paging keeps adult filtering and revision aligned with the complete raw header.');
 const registry=(await q("select g.snapshot_id,g.updated_at=c.updated_at aligned from public.catalog_visible_generations g join public.provider_catalog_cache c using(provider_key,scope_hash,media_type) where g.media_type='movies'")).rows[0];check(registry.snapshot_id===generation&&registry.aligned,'Small Realtime registry revision and timestamp exactly match the committed header.');
 check((await q('select count(*)::int n from arkhen_private.catalog_generation_copies where job_id=$1',[generationJob])).rows[0].n===0,'A committed publication removes private copy progress through the prepared-snapshot foreign key.');
 // A service-role reader must reject a future series generation explicitly.
 await q("insert into public.catalog_media(provider_key,scope_hash,media_type,media_id,name,metadata,last_seen_snapshot,generation_id) values($1,$2,'series','pending-series','Pending series','{\"id\":\"pending-series\",\"name\":\"Pending series\"}',$3,$3)",[provider,scope,future]);
 await as('service_role',null,()=>q('select public.arkhen_marker_discover(500)'));
 check((await q("select count(*)::int n from public.series_marker_identities where media_id='pending-series'")).rows[0].n===0&&(await q('select count(*)::int n from public.series_marker_identities')).rows[0].n===2,'Service-role marker discovery reads only the current series generation.');
 // Legacy writes must switch header back to generation0 and ignore conflicting
 // adult category metadata in a future/retired generation.
 await q("update arkhen_private.cache_jobs set status='succeeded',locked_by=null,lease_until=null where id=$1",[generationJob]);
 const legacyJob=(await q("insert into arkhen_private.cache_jobs(provider_key,scope_hash,job_type,payload,status,locked_by,lease_until) values($1,$2,'catalog','{\"media_type\":\"movies\"}','leased','legacy-worker',now()+interval '10 minutes') returning id",[provider,scope])).rows[0].id;
 await q("insert into public.catalog_categories(provider_key,scope_hash,media_type,category_id,name,is_adult,last_seen_snapshot,generation_id) values($1,$2,'movies','safe','Future adult',true,$3,$3)",[provider,scope,future]);
 const legacyPayload={categories:[{id:'safe',name:'Family'}],items:[{id:'legacy',name:'Legacy family title',kind:'movie',categoryId:'safe'}]};
 await q("select public.arkhen_publish_catalog($1,$2,'movies',$3,true,$4,now()+interval '1 day',$5,'legacy-worker')",[provider,scope,legacyPayload,'80000000-0000-4000-8000-000000000001',legacyJob]);
 const legacyVisible=await rowsFor('catalog_media');check(legacyVisible.length===1&&legacyVisible[0].media_id==='legacy'&&!legacyVisible[0].is_adult,'Legacy publication resets the registry/header and classifies only its generation0 categories.');
 check((await q("select index_generation,item_count from public.provider_catalog_cache where media_type='movies'")).rows[0].index_generation===zero&&(await q("select item_count from public.provider_catalog_cache where media_type='movies'")).rows[0].item_count===1,'Legacy raw snapshot and count cannot point at a former UUID generation.');
 check((await q('select count(*)::int n from public.catalog_media where generation_id=$1 and is_active',[generation])).rows[0].n===600,'Legacy deactivation never mutates another generation.');
 // Retention protects current, prepared and actively leased generations.
 await q("update public.catalog_media set generation_created_at=now()-interval '2 days'");await q("update public.catalog_categories set generation_created_at=now()-interval '2 days'");await q("update public.catalog_artwork_refs set generation_created_at=now()-interval '2 days'");
 const protectedMovieCount=(await q("select count(*)::int n from public.catalog_media where media_type='movies'")).rows[0].n;
 check((await q('select public.arkhen_cleanup_catalog_generations(3) n')).rows[0].n<=3&&(await q("select count(*)::int n from public.catalog_media where media_type='movies'")).rows[0].n===protectedMovieCount,'A real active movie lease protects all movie generations while retention can retire other types independently.');
 await q("update arkhen_private.cache_jobs set status='succeeded',locked_by=null,lease_until=null where id=$1",[legacyJob]);
 const retainedJob=(await q("insert into arkhen_private.cache_jobs(provider_key,scope_hash,job_type,payload) values($1,$2,'catalog','{\"media_type\":\"movies\"}') returning id",[provider,scope])).rows[0].id;
 await q("insert into arkhen_private.catalog_prepared_snapshots(job_id,media_type,normalization_position,staging_position,payload,item_count,safe_item_count,category_count,artwork_count,generation_id) values($1,'movies',0,0,'{\"categories\":[],\"items\":[]}',0,0,0,0,$2)",[retainedJob,future]);
 const expiryBefore=new Date((await q("select expires_at from public.provider_catalog_cache where media_type='movies'")).rows[0].expires_at).getTime();
 check((await q('select public.arkhen_cleanup_catalog_generations(3) n')).rows[0].n<=3,'Retention deletes at most the requested total across all index tables.');
 for(let index=0;index<4;index++)check((await q('select public.arkhen_cleanup_catalog_generations(500) n')).rows[0].n<=500,'Every retention call remains bounded.');
 check((await rowsFor('catalog_media')).length===1&&(await q('select count(*)::int n from public.catalog_categories where generation_id=$1',[future])).rows[0].n===1,'Retention preserves the visible generation and private prepared candidates.');
 check(new Date((await q("select expires_at from public.provider_catalog_cache where media_type='movies'")).rows[0].expires_at).getTime()===expiryBefore,'Retention never refreshes catalog expiration.');
 for(const role of ['anon','authenticated']){let denied=false;try{await as(role,user,()=>q('select public.arkhen_cleanup_catalog_generations(1)'));}catch(error){denied=error.code==='42501';}check(denied,'Browser roles cannot retire generations.');}
 const publications=(await q("select tablename from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename in('catalog_visible_generations','provider_catalog_cache','catalog_media','catalog_categories','catalog_artwork_refs')")).rows;
 check(publications.length===1&&publications[0].tablename==='catalog_visible_generations','Realtime publishes only the small typed registry, never full JSON or index-copy rows.');
 await migration('20261015154822_arkhen_catalog_domain_views.sql');
 await q("insert into public.catalog_media(provider_key,scope_hash,media_type,media_id,name,metadata,last_seen_snapshot,generation_id) values($1,$2,'movies','view-hidden','Hidden candidate','{\"id\":\"view-hidden\",\"name\":\"Hidden candidate\"}',$3,$3)",[provider,scope,future]);
 for(const kind of ['movies','series','live']){
  for(const suffix of ['', '_categories', '_cache']){
   const name='catalog_'+kind+suffix;
   const ownRows=(await as('authenticated',user,()=>q('select * from public.'+name))).rows;
   check(ownRows.every(row=>row.media_type===kind&&row.provider_key===provider),'Each domain view exposes only its typed partition.');
   check((await as('authenticated',other,()=>q('select * from public.'+name))).rows.length===0,'Invoker domain views preserve cross-account RLS.');
   let anonymousDenied=false;try{await as('anon',null,()=>q('select * from public.'+name));}catch(error){anonymousDenied=error.code==='42501';}check(anonymousDenied,'Domain views grant no anonymous access.');
   const grants=(await q("select has_table_privilege('authenticated',$1,'INSERT,UPDATE,DELETE') writes",['public.'+name])).rows[0];check(!grants.writes,'Domain views grant authenticated callers SELECT only.');
   check((await q('select reloptions from pg_class where oid=$1::regclass',['public.'+name])).rows[0].reloptions.includes('security_invoker=true'),'All typed views run with the caller RLS context.');
  }
 }
 check((await as('service_role',null,()=>q('select media_id from public.catalog_movies'))).rows.length===1,'Even service readers of a typed view cannot see a hidden generation.');
 check((await as('authenticated',user,()=>q('select * from public.catalog_live_cache'))).rows.length===0,'A cold live preview never becomes a complete cache through its typed view.');
 console.log(JSON.stringify({ok:true,assertions,independent_types:3,private_rows_preserved:true,rls:true,phase_timing:true,prepared_snapshot:true,generation_copy:true,domain_views:true}));
}finally{await db.close();}
