// Optional SQL integration audit, isolated from the application's npm tests.
// Usage: node tools/test-cloud-schema.mjs /absolute/path/to/pglite/dist/index.js
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';

const modulePath=process.argv[2];
if(!modulePath)throw new Error('Pass the local PGlite module path; this script never connects to a remote database.');
const {PGlite}=await import(pathToFileURL(modulePath).href);
const db=new PGlite();let assertions=0;
const query=(text,args=[])=>db.query(text,args);
const check=(value,message)=>{assert.ok(value,message);assertions++;};
const asRole=async(role,user,run)=>{
  await db.exec(`set local role ${role}`);
  await query("select set_config('request.jwt.claim.sub',$1,true)",[user||'']);
  try{return await run();}finally{await db.exec('reset role');}
};
const denied=async(run)=>{
  await db.exec('savepoint expected_denial');
  let failure;
  try{await run();}catch(error){failure=error;}
  await db.exec('rollback to savepoint expected_denial; release savepoint expected_denial');
  check(failure?.code==='42501',`Expected permission denial, received ${failure?.code||'success'}`);
};
const a='10000000-0000-4000-8000-000000000001',b='10000000-0000-4000-8000-000000000002';
try{
  await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
    create schema auth;create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to anon,authenticated,service_role;grant execute on function auth.uid() to anon,authenticated,service_role;`);
  const schema=await readFile(new URL('../supabase/schema-proposal.sql',import.meta.url),'utf8');
  await db.exec(schema);await db.exec(schema);check(true,'Schema applies idempotently');
  await db.exec('begin');
  await query('insert into auth.users(id) values($1),($2)',[a,b]);
  await asRole('service_role',null,async()=>{
    await query('select public.arkhen_identity_bind($1,$2,$3,$4,$5)',['a'.repeat(64),a,'wplay','provider-a','scope-a']);
    await query('select public.arkhen_identity_bind($1,$2,$3,$4,$5)',['b'.repeat(64),b,'wplay','provider-b','scope-b']);
    await query('select public.arkhen_validate_account($1,$2,now()+interval \'1 day\',now(),$3,$4)',[a,'active','provider-a','scope-a']);
    await query('select public.arkhen_validate_account($1,$2,now()+interval \'1 day\',now(),$3,$4)',[b,'active','provider-b','scope-b']);
    const found=await query('select * from public.arkhen_identity_lookup($1)',['a'.repeat(64)]);check(found.rows[0]?.user_id===a,'Service-only identity lookup');
    await denied(()=>query("update public.profiles set provider='xtream' where id=$1",[a]));
  });
  await asRole('authenticated',a,async()=>{
    check((await query('select id from public.profiles')).rows.length===1,'Profile RLS limits rows to self');
    await query('update public.profiles set display_name=$1 where id=$2',['Account A',a]);
    check((await query('select display_name from public.profiles')).rows[0].display_name==='Account A','Display name is editable');
    await denied(()=>query("update public.profiles set status='active'"));
    await denied(()=>query("update public.profiles set access_expires_at=now()+interval '10 years'"));
    await denied(()=>query('select * from arkhen_private.provider_identities'));
    await denied(()=>query('select * from public.arkhen_identity_lookup($1)',['a'.repeat(64)]));
    await query('insert into public.user_favorites(user_id,provider,item_key,item) values($1,$2,$3,$4)',[a,'wplay','movie:1',{id:'1',name:'Film A',kind:'movie'}]);
    await denied(()=>query('insert into public.user_favorites(user_id,provider,item_key,item) values($1,$2,$3,$4)',[b,'wplay','movie:2',{}]));
    await denied(()=>query('insert into public.user_favorites(user_id,provider,item_key,item) values($1,$2,$3,$4)',[a,'xtream','movie:3',{}]));
    await denied(()=>query('delete from public.user_favorites'));
    await query('insert into public.user_progress(user_id,provider,item_key,episode_id,entry) values($1,$2,$3,$4,$5)',[a,'wplay','series:5','episode-1',{time:20}]);
    await query('insert into public.user_progress(user_id,provider,item_key,episode_id,entry) values($1,$2,$3,$4,$5)',[a,'wplay','series:5','episode-2',{time:50}]);
    check((await query('select * from public.user_progress')).rows.length===2,'Episodes retain separate progress');
    await query('insert into public.user_preferences(user_id,provider,key,value) values($1,$2,$3,$4)',[a,'wplay','audio',{mode:'original'}]);
    await query('insert into public.custom_collections(user_id,provider,id,name,collection_type,item_keys) values($1,$2,$3,$4,$5,$6)',[a,'wplay','mine','Mine','movies',['movie:1']]);
    check((await query('select * from public.user_preferences')).rows.length===1,'Owner reads preferences');
    check((await query('select * from public.custom_collections')).rows.length===1,'Owner reads collections');
    await denied(()=>query('update public.user_progress set user_id=$1',[b]));
    await denied(()=>query('insert into public.custom_collections(user_id,provider,id,name,collection_type) values($1,$2,$3,$4,$5)',[b,'wplay','foreign','Foreign','movies']));
    await query('update public.user_favorites set deleted_at=now(),updated_at=now()+interval \'1 second\' where item_key=$1',['movie:1']);
    await query('update public.user_favorites set deleted_at=null,updated_at=now()-interval \'1 day\' where item_key=$1',['movie:1']);
    check((await query('select deleted_at from public.user_favorites')).rows[0].deleted_at!==null,'Stale updates cannot resurrect tombstones');
  });
  await asRole('authenticated',b,async()=>{
    check((await query('select * from public.user_favorites')).rows.length===0,'Other user cannot read favorites');
    check((await query('select * from public.user_progress')).rows.length===0,'Other user cannot read progress');
    check((await query('select * from public.user_preferences')).rows.length===0,'Other user cannot read preferences');
    check((await query('select * from public.custom_collections')).rows.length===0,'Other user cannot read collections');
    check((await query('update public.user_favorites set deleted_at=now() returning *')).rows.length===0,'Other user cannot update favorites');
  });
  await asRole('anon',null,async()=>{
    await denied(()=>query('select * from public.profiles'));
    await denied(()=>query('select * from public.user_favorites'));
    await denied(()=>query('select * from public.provider_catalog_cache'));
    await denied(()=>query('select * from public.episode_skip_markers'));
  });
  let jobs;
  await asRole('service_role',null,async()=>{
    check((await query('select public.arkhen_enqueue_source_jobs($1,$2) as count',['provider-a','scope-a'])).rows[0].count===3,'First source schedules three jobs');
    check((await query('select public.arkhen_enqueue_source_jobs($1,$2) as count',['provider-a','scope-a'])).rows[0].count===0,'Repeated login cannot duplicate jobs');
    jobs=(await query('select * from public.arkhen_claim_cache_jobs($1,10,300)',['worker-1'])).rows;
    check(jobs.length===3,'Worker claims source jobs');
    const catalog=jobs.find(job=>job.job_type==='catalog'),epg=jobs.find(job=>job.job_type==='epg'),games=jobs.find(job=>job.job_type==='games');
    check((await query('select arkhen_private.safe_shared_payload($1) as safe',[{items:[{token:'not-a-real-secret'}]}])).rows[0].safe===false,'Shared token keys are rejected');
    check((await query('select arkhen_private.safe_shared_payload($1) as safe',[{poster:'https://example.com/image.png'}])).rows[0].safe===false,'Shared external URLs are rejected');
    await query('insert into public.episode_skip_markers(series_slug,season,episode,edition_id,imdb_id,duration_seconds,verification,markers,data_version) values($1,1,1,$2,$3,600,$4,$5,$6)',['test-series','edition-1','tt123','community-reference',{openingStart:10,openingEnd:50,creditsStart:560},'test.1']);
    check((await query('select arkhen_private.valid_episode_markers($1,600) as safe',[{openingEnd:50}])).rows[0].safe===false,'Missing opening start cannot be promoted into usable markers');
    check((await query('select arkhen_private.valid_episode_markers($1,600) as safe',[{openingStart:10,openingEnd:50,creditsStart:20}])).rows[0].safe===false,'Contradictory marker windows are rejected');
    const payload={categories:[{id:'cat',name:'Films'}],items:[{id:'old',name:'Film old',categoryId:'cat'},{id:'keep',name:'Film keep',categoryId:'cat'}]};
    await query('select public.arkhen_publish_catalog($1,$2,$3,$4,true,gen_random_uuid(),now()+interval \'1 day\',$5,$6)',['provider-a','scope-a','movies',payload,catalog.id,'worker-1']);
    check((await query('select * from public.catalog_media where is_active')).rows.length===2,'Complete snapshot creates normalized metadata');
    await db.exec('savepoint bad_snapshot');
    let incomplete=false;try{await query('select public.arkhen_publish_catalog($1,$2,$3,$4,false,gen_random_uuid(),now()+interval \'1 day\',$5,$6)',['provider-a','scope-a','movies',{categories:[],items:[]},catalog.id,'worker-1']);}catch{incomplete=true;}
    await db.exec('rollback to savepoint bad_snapshot;release savepoint bad_snapshot');check(incomplete,'Partial snapshot is rejected');
    check((await query('select * from public.catalog_media where is_active')).rows.length===2,'Rejected snapshot preserves existing metadata');
    await query('select public.arkhen_publish_catalog($1,$2,$3,$4,true,gen_random_uuid(),now()+interval \'1 day\',$5,$6)',['provider-a','scope-a','movies',{categories:[{id:'cat',name:'Films'}],items:[{id:'keep',name:'Film keep'}]},catalog.id,'worker-1']);
    check((await query('select * from public.catalog_media where is_active')).rows.length===1,'Only successful complete replacement marks vanished rows inactive');
    await query('select public.arkhen_publish_epg_batch($1,$2,$3,now()+interval \'5 minutes\',$4,$5)',['provider-a','scope-a',[{channel_id:'10',payload:{list:[{title:'Program',description:'',start:'2026-10-15T00:00:00Z',end:'2026-10-15T01:00:00Z'}]}}],epg.id,'worker-1']);
    await query('select public.arkhen_publish_games($1,$2,$3,$4,$5,now()+interval \'1 minute\',$6,$7)',['provider-a','scope-a','2026-10-15','UTC',{date:'2026-10-15',available:true,games:[]},games.id,'worker-1']);
    check((await query('select public.arkhen_renew_cache_job($1,$2,300) as active',[catalog.id,'worker-1'])).rows[0].active===true,'Lease renewal works for current worker');
    check((await query('select public.arkhen_renew_cache_job($1,$2,300) as active',[catalog.id,'worker-other'])).rows[0].active===false,'Another worker cannot renew lease');
    await query('select public.arkhen_finish_cache_job($1,$2,true,null)',[catalog.id,'worker-1']);
    await db.exec('savepoint ended_lease');let blocked=false;
    try{await query('select public.arkhen_publish_catalog($1,$2,$3,$4,true,gen_random_uuid(),now()+interval \'1 day\',$5,$6)',['provider-a','scope-a','movies',payload,catalog.id,'worker-1']);}catch{blocked=true;}
    await db.exec('rollback to savepoint ended_lease;release savepoint ended_lease');check(blocked,'Finished lease cannot publish');
  });
  await asRole('authenticated',a,async()=>{
    check((await query('select * from public.provider_catalog_cache')).rows.length===1,'Entitled provider partition is readable');
    check((await query('select * from public.provider_epg_cache')).rows.length===1,'Entitled EPG is readable');
    check((await query('select * from public.provider_games_cache')).rows.length===1,'Entitled games are readable');
    check((await query('select * from public.episode_skip_markers')).rows.length===1,'Active users can read public non-playback markers');
    await denied(()=>query("update public.provider_catalog_cache set is_complete=false"));
    await denied(()=>query("select * from public.arkhen_claim_cache_jobs('bad',1,30)"));
  });
  await asRole('authenticated',b,async()=>{
    check((await query('select * from public.provider_catalog_cache')).rows.length===0,'Another provider partition is hidden');
    check((await query('select * from public.provider_epg_cache')).rows.length===0,'Another partition EPG is hidden');
    check((await query('select * from public.provider_games_cache')).rows.length===0,'Another partition games are hidden');
  });
  await asRole('service_role',null,()=>query("update public.profiles set status='expired' where id=$1",[a]));
  await asRole('authenticated',a,async()=>{
    check((await query('select * from public.provider_catalog_cache')).rows.length===0,'Expired access cannot read catalog');
    check((await query('select * from public.user_progress')).rows.length===0,'Expired access cannot modify personal playback state');
    await denied(()=>query('insert into public.user_preferences(user_id,provider,key,value) values($1,$2,$3,$4)',[a,'wplay','audio',{}]));
  });
  await asRole('service_role',null,()=>query("update public.profiles set status='active',last_validated_at=now()-interval '25 hours' where id=$1",[a]));
  await asRole('authenticated',a,async()=>{
    check((await query('select * from public.provider_catalog_cache')).rows.length===0,'Stale validation cannot authorize shared catalog reads');
    check((await query('select * from public.episode_skip_markers')).rows.length===0,'Stale validation cannot authorize marker reads');
  });
  await db.exec('rollback');console.log(JSON.stringify({ok:true,assertions,engine:'PGlite PostgreSQL',remoteDatabaseAccess:false}));
}finally{await db.close();}
