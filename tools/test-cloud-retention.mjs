// Isolated PostgreSQL integration test; never connects to a remote database.
// Usage: node tools/test-cloud-retention.mjs /path/to/pglite/dist/index.js
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';

if(!process.argv[2])throw new Error('Pass a local PGlite module path.');
const {PGlite}=await import(pathToFileURL(process.argv[2]).href);
const db=new PGlite();let assertions=0;
const check=(value,message)=>{assert.ok(value,message);assertions++;};
const id='10000000-0000-4000-8000-000000000001';
try{
  await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
    create schema auth;create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to anon,authenticated,service_role;grant execute on function auth.uid() to anon,authenticated,service_role;`);
  await db.exec(await readFile(new URL('../supabase/schema-proposal.sql',import.meta.url),'utf8'));
  const migration=await readFile(new URL('../supabase/migrations/20261015090801_arkhen_shared_metadata_retention.sql',import.meta.url),'utf8');
  await db.exec(migration);await db.exec(migration);check(true,'Retention migration applies idempotently');
  await db.exec('begin');
  await db.query('insert into auth.users(id) values($1)',[id]);
  await db.exec('set local role service_role');
  await db.query('select public.arkhen_identity_bind($1,$2,$3,$4,$5)',['a'.repeat(64),id,'wplay','retention-provider','retention-scope']);
  await db.query("select public.arkhen_validate_account($1,'active',now()+interval '1 day',now(),'retention-provider','retention-scope')",[id]);
  await db.query("insert into public.user_favorites(user_id,provider,item_key,item,updated_at) values($1,'wplay','movie:kept','{}',now()-interval '1 year')",[id]);
  await db.query("insert into public.user_progress(user_id,provider,item_key,entry,updated_at) values($1,'wplay','movie:kept','{}',now()-interval '1 year')",[id]);
  await db.exec(`insert into public.provider_catalog_cache(provider_key,scope_hash,media_type,payload,expires_at,snapshot_id,is_complete,updated_at)
    values('retention-provider','retention-scope','movies','{"items":[],"categories":[]}',now()-interval '1 year',gen_random_uuid(),true,now()-interval '1 year');
    insert into public.epg_programs(provider_key,scope_hash,channel_id,start_at,end_at,title) values
    ('retention-provider','retention-scope','old',now()-interval '9 days',now()-interval '8 days','Old'),
    ('retention-provider','retention-scope','recent',now()-interval '2 days',now()-interval '1 day','Recent'),
    ('retention-provider','retention-scope','future',now()+interval '1 day',now()+interval '2 days','Future');
    insert into public.provider_epg_cache(provider_key,scope_hash,channel_id,payload,expires_at,updated_at) values
    ('retention-provider','retention-scope','old-expired','{}',now()-interval '1 day',now()-interval '8 days'),
    ('retention-provider','retention-scope','recent-expired','{}',now()-interval '1 day',now()-interval '2 days'),
    ('retention-provider','retention-scope','old-unexpired','{}',now()+interval '1 day',now()-interval '8 days');
    insert into public.provider_games_cache(provider_key,scope_hash,game_date,time_zone,payload,expires_at) values
    ('retention-provider','retention-scope',(now() at time zone 'UTC')::date-31,'UTC','{}',now()-interval '1 day'),
    ('retention-provider','retention-scope',(now() at time zone 'UTC')::date-30,'UTC','{}',now()-interval '1 day'),
    ('retention-provider','retention-scope',(now() at time zone 'UTC')::date-32,'UTC','{}',now()+interval '1 day');`);
  const result=(await db.query('select arkhen_private.prune_shared_metadata() as removed')).rows[0].removed;
  assert.deepEqual(result,{epg_programs:1,epg_caches:1,games_caches:1});assertions++;
  const kept=(await db.query(`select
    (select array_agg(channel_id order by channel_id) from public.epg_programs) as programs,
    (select array_agg(channel_id order by channel_id) from public.provider_epg_cache) as epg,
    (select count(*)::integer from public.provider_games_cache) as games,
    (select count(*)::integer from public.user_favorites) as favorites,
    (select count(*)::integer from public.user_progress) as progress,
    (select count(*)::integer from public.provider_catalog_cache) as catalogs,
    (select count(*)::integer from arkhen_private.cache_sources) as sources`)).rows[0];
  assert.deepEqual(kept.programs,['future','recent']);assertions++;
  assert.deepEqual(kept.epg,['old-unexpired','recent-expired']);assertions++;
  for(const name of ['games','favorites','progress','catalogs','sources'])check(kept[name]===(name==='games'?2:1),`${name} outside expired retention remain intact`);
  assert.deepEqual((await db.query('select arkhen_private.prune_shared_metadata() as removed')).rows[0].removed,{epg_programs:0,epg_caches:0,games_caches:0});assertions++;
  await db.exec('reset role');
  for(const role of ['anon','authenticated']){
    await db.exec(`set local role ${role};savepoint denied_prune`);
    let error;try{await db.query('select arkhen_private.prune_shared_metadata()');}catch(value){error=value;}
    await db.exec('rollback to savepoint denied_prune;release savepoint denied_prune;reset role');
    check(error?.code==='42501',`${role} cannot invoke retention`);
  }
  await db.exec('rollback');
  console.log(JSON.stringify({ok:true,assertions,engine:'PGlite PostgreSQL',remoteDatabaseAccess:false}));
}finally{await db.close();}
