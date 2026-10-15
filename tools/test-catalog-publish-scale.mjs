// Synthetic local-only scale fixture. No Supabase credentials or remote writes.
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
if(!process.argv[2])throw new Error('Pass an installed local PGlite module path.');
const {PGlite}=await import(pathToFileURL(process.argv[2]).href),db=new PGlite();
const count=Number(process.argv[3]||18612),legacy=process.argv.includes('--legacy'),batches=process.argv.includes('--batches'),firstOnly=process.argv.includes('--first-only');
if(!Number.isSafeInteger(count)||count<1||count>100000)throw new Error('Invalid fixture size.');
const provider='a'.repeat(64),scope='b'.repeat(64),job='10000000-0000-4000-8000-000000000001';
try{
 await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
  create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;
  grant usage on schema auth to anon,authenticated,service_role;grant execute on function auth.uid() to anon,authenticated,service_role;`);
 if(batches)await db.exec('create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);');
 for(const name of ['20261015044236_arkhen_cloud_schema.sql','20261015095103_arkhen_shared_metadata_set_based.sql','20261015113615_arkhen_catalog_pages.sql',...legacy?[]:['20261015133920_arkhen_catalog_publish_scale.sql']])await db.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
 if(batches)for(const name of ['20261015115927_arkhen_cloud_provider_sources.sql','20261015115930_arkhen_cloud_collector.sql','20261015141803_arkhen_catalog_publish_batches.sql'])await db.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
 if(process.argv.includes('--profile')){
  let definition=(await db.query("select pg_get_functiondef('public.arkhen_publish_catalog(text,text,text,jsonb,boolean,uuid,timestamptz,uuid,text)'::regprocedure) as body")).rows[0].body;
  definition=definition.replace(/\bbegin\r?\n/,'declare scale_started timestamptz:=clock_timestamp();\nbegin\n');
  assert.ok(definition.includes('declare scale_started'),'Publisher profiling requires a statement timestamp.');
  for(const [marker,stage]of [['  with categories as (','categories'],['  with media as (','media'],['  update public.catalog_categories c set','deactivate_categories'],['  update public.catalog_media m set','deactivate_media'],['  insert into public.provider_catalog_cache(','snapshot'],['  update public.provider_catalog_cache set item_count','counts'],['  insert into public.catalog_artwork_refs(','artwork_insert'],['  delete from public.catalog_artwork_refs reference','artwork_cleanup']]){
   assert.ok(definition.includes(marker),'Profile marker missing: '+stage);definition=definition.replace(marker,"  raise notice 'PROFILE stage="+stage+" elapsed_ms=%',round(extract(epoch from(clock_timestamp()-scale_started))*1000);\n"+marker);
  }await db.exec(definition);
 }
 await db.query("insert into arkhen_private.cache_sources(provider_key,scope_hash,provider,enabled) values($1,$2,'wplay',true)",[provider,scope]);
 await db.query("insert into arkhen_private.cache_jobs(id,provider_key,scope_hash,job_type,status,locked_by,lease_until) values($1,$2,$3,'catalog','leased','scale-worker',now()+interval '20 minutes')",[job,provider,scope]);
 const payload={categories:[{id:'safe',name:'Drama'}],items:Array.from({length:count},(_,index)=>({id:String(index),kind:'movie',name:'Filme '+index,categoryId:'safe',categoryIds:['safe'],poster:'/api/shared-image/'+index.toString(16).padStart(64,'0'),plot:'A'.repeat(500)}))};
 let normalizationCalls=0,largestRpcMs=0,finalRpcMs=0;
 const publish=async(data,id)=>{
  if(!batches)return db.query("select public.arkhen_publish_catalog($1,$2,'movies',$3,true,$4,now()+interval '1 day',$5,'scale-worker')",[provider,scope,data,id,job],{onNotice:notice=>console.log(notice.message)});
  await db.query("insert into arkhen_private.cloud_job_progress(job_id,progress) values($1,$2) on conflict(job_id) do update set progress=excluded.progress",[job,{typeReady:'movies'}]);
  let step=0;const occurrences=[...data.items,...data.items];
  for(let offset=0;offset<occurrences.length;offset+=45)await db.query("insert into arkhen_private.cloud_catalog_staging(job_id,media_type,step_key,payload) values($1,'movies',$2,$3)",[job,'scale:'+step++,{categories:data.categories,items:occurrences.slice(offset,offset+45)}]);
  for(let call=0;call<10000;call++){
   const started=performance.now();const state=(await db.query("select public.arkhen_cloud_catalog_publish($1,'scale-worker','movies') as state",[job])).rows[0].state;
   const elapsed=Math.round(performance.now()-started);largestRpcMs=Math.max(largestRpcMs,elapsed);
   if(state.publishedTypes?.includes('movies')){finalRpcMs=elapsed;return;}
   normalizationCalls++;assert.ok(state.publicationCursors?.movies>0);assert.equal(state.typeReady,'movies');
  }throw new Error('fixture-publication-did-not-finish');
 };
 const started=performance.now();await publish(payload,'20000000-0000-4000-8000-000000000001');const firstMs=Math.round(performance.now()-started);
 const [first]=(await db.query("select count(*)::int as total,count(*) filter(where is_active)::int as active from public.catalog_media where media_type='movies'")).rows;
 assert.equal(first.total,count);assert.equal(first.active,count);
 assert.equal((await db.query('select count(*)::int as total from public.catalog_artwork_refs')).rows[0].total,count);
 if(firstOnly){console.log(JSON.stringify({ok:true,mode:batches?'batches':legacy?'legacy':'scaled',items:count,payload_bytes:Buffer.byteLength(JSON.stringify(payload)),first_ms:firstMs,normalization_calls:normalizationCalls,largest_rpc_ms:largestRpcMs,final_rpc_ms:finalRpcMs}));await db.close();process.exit(0);}
 const before=(await db.query("select updated_at,last_seen_snapshot from public.catalog_media where media_id='0'")).rows[0];
 const repeatStarted=performance.now();await publish(payload,'20000000-0000-4000-8000-000000000002');const repeatMs=Math.round(performance.now()-repeatStarted);
 const after=(await db.query("select updated_at,last_seen_snapshot from public.catalog_media where media_id='0'")).rows[0];assert.deepEqual(after,before,'Unchanged metadata must not be rewritten for every snapshot.');
 assert.equal((await db.query('select count(*)::int as active from public.catalog_media where is_active')).rows[0].active,count,'A new snapshot keeps unchanged records active.');
 await publish({...payload,items:payload.items.slice(1)},'20000000-0000-4000-8000-000000000003');
 assert.equal((await db.query("select is_active from public.catalog_media where media_id='0'")).rows[0].is_active,false);
 assert.equal((await db.query("select count(*)::int as n from public.catalog_artwork_refs where media_id='0'")).rows[0].n,0);
 console.log(JSON.stringify({ok:true,mode:batches?'batches':legacy?'legacy':'scaled',items:count,payload_bytes:Buffer.byteLength(JSON.stringify(payload)),first_ms:firstMs,unchanged_repeat_ms:repeatMs,...batches?{normalization_calls:normalizationCalls,largest_rpc_ms:largestRpcMs,final_rpc_ms:finalRpcMs}:{}}));
}finally{await db.close();}
