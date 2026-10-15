// Isolated PostgreSQL integration checks; no network or project credentials.
// node tools/test-shared-publication.mjs /absolute/path/to/pglite/dist/index.js
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';

if(!process.argv[2])throw new Error('Pass a local PGlite module path.');
const {PGlite}=await import(pathToFileURL(process.argv[2]).href),db=new PGlite();let assertions=0;
const check=(value,message)=>{assert.ok(value,message);assertions++;};
const query=(text,args=[])=>db.query(text,args);
const count=async table=>Number((await query(`select count(*) n from public.${table}`)).rows[0].n);
const changed=async table=>Number((await query('select coalesce(sum(n),0) n from arkhen_private._test_updates where name=$1',[table])).rows[0].n);
const rejects=async run=>{await db.exec('savepoint rejected_input');let error;try{await run();}catch(value){error=value;}await db.exec('rollback to savepoint rejected_input;release savepoint rejected_input');check(Boolean(error),'Invalid publication must fail');};
try{
  await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
    create schema auth;create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to anon,authenticated,service_role;grant execute on function auth.uid() to anon,authenticated,service_role;`);
  await db.exec(await readFile(new URL('../supabase/schema-proposal.sql',import.meta.url),'utf8'));
  const migration=await readFile(new URL('../supabase/migrations/20261015095103_arkhen_shared_metadata_set_based.sql',import.meta.url),'utf8');
  await db.exec(migration);await db.exec(migration);
  const functions=(await query("select oid::regprocedure::text signature,prosecdef,proconfig from pg_proc where pronamespace='public'::regnamespace and proname in ('arkhen_publish_catalog','arkhen_publish_epg','arkhen_publish_epg_batch')")).rows;
  check(functions.length===3&&functions.every(row=>!row.prosecdef&&row.proconfig.includes('statement_timeout=55s')&&row.proconfig.some(value=>value.startsWith('search_path='))),'Only publication functions get a bounded timeout and retain invoker/search_path');
  for(const row of functions){const access=(await query('select has_function_privilege($1,$2,$3) allowed,has_function_privilege($4,$2,$3) denied_a,has_function_privilege($5,$2,$3) denied_b',['service_role',row.signature,'execute','anon','authenticated'])).rows[0];check(access.allowed&&!access.denied_a&&!access.denied_b,'Publication remains service-only');}
  await db.exec(`create table arkhen_private._test_updates(name text primary key,n integer not null);
    grant all on arkhen_private._test_updates to service_role;
    create function arkhen_private._test_count_update() returns trigger language plpgsql security invoker set search_path='' as $$begin
      insert into arkhen_private._test_updates values(TG_TABLE_NAME,1) on conflict(name) do update set n=arkhen_private._test_updates.n+1;return new;end$$;
    create trigger test_updates after update on public.catalog_media for each row execute function arkhen_private._test_count_update();
    create trigger test_updates after update on public.catalog_categories for each row execute function arkhen_private._test_count_update();
    create trigger test_updates after update on public.epg_programs for each row execute function arkhen_private._test_count_update();
    begin;set local role service_role;
    insert into arkhen_private.cache_sources(provider_key,scope_hash,provider) values('provider-a','scope-a','wplay'),('provider-b','scope-b','wplay');`);
  const jobs={};for(const type of ['catalog','epg'])jobs[type]=(await query("insert into arkhen_private.cache_jobs(provider_key,scope_hash,job_type,status,locked_by,lease_until,attempts) values('provider-a','scope-a',$1,'leased','test-worker',now()+interval '5 minutes',1) returning id",[type])).rows[0].id;
  const catalog={categories:[{id:'one',name:'Films'},{id:'one',name:'Films current'}],items:Array.from({length:1100},(_,index)=>({id:String(index),name:'Film '+index,categoryIds:['one'],kind:'movie'}))};
  catalog.items.push({...catalog.items[0],name:'Film final duplicate'});
  const publishCatalog=(payload=catalog,{complete=true,worker='test-worker'}={})=>query("select public.arkhen_publish_catalog('provider-a','scope-a','movies',$1,$2,$3,now()+interval '1 day',$4,$5)",[payload,complete,randomUUID(),jobs.catalog,worker]);
  await publishCatalog();check(await count('catalog_media')===1100,'All 1100 unique media are published');
  check((await query("select name from public.catalog_media where media_id='0'")).rows[0].name==='Film final duplicate','Duplicate media identity uses the last supplied row');
  check((await query('select name from public.catalog_categories')).rows[0].name==='Films current','Duplicate category identity uses the last supplied row');
  const cachedCatalog=(await query('select payload from public.provider_catalog_cache')).rows[0].payload;
  check(cachedCatalog.items.length===1100&&cachedCatalog.categories.length===1&&cachedCatalog.items.find(item=>item.id==='0').name==='Film final duplicate','Visible catalog and normalized index use the same deduplicated values');
  await publishCatalog();check(await changed('catalog_media')===0&&await changed('catalog_categories')===0,'New snapshot UUID does not update unchanged normalized metadata');
  const replacement={...catalog,items:catalog.items.filter(item=>item.id!=='1').map(item=>item.id==='2'?{...item,name:'Changed'}:item)};
  await publishCatalog(replacement);check(await changed('catalog_media')===2,'Only a changed item and vanished item generate updates');
  check((await query("select is_active from public.catalog_media where media_id='1'")).rows[0].is_active===false,'Only absence from a complete input deactivates media');
  const previous=(await query('select snapshot_id from public.provider_catalog_cache')).rows[0].snapshot_id;
  await rejects(()=>publishCatalog({categories:[],items:[]},{complete:false}));
  await rejects(()=>publishCatalog({categories:[],items:[{id:'bad',name:''}]}));
  await rejects(()=>publishCatalog({categories:[],items:[{id:'bad',name:'Unsafe',stream_url:'https://example.test/video'}]}));
  await rejects(()=>publishCatalog(catalog,{worker:'another-worker'}));
  check((await query('select snapshot_id from public.provider_catalog_cache')).rows[0].snapshot_id===previous,'Rejected inputs preserve the prior public snapshot');
  check(!(await query("select 1 from public.catalog_media where media_id='bad'")).rows.length,'Invalid rows never escape a failed snapshot');

  const start=Date.parse('2026-10-15T00:00:00Z'),expiry='2026-10-20T00:00:00Z';
  const channels=Array.from({length:20},(_,channel)=>({channel_id:String(channel),payload:{list:Array.from({length:60},(_,index)=>({title:`Program ${channel} ${index}`,start:new Date(start+index*3600000).toISOString(),end:new Date(start+(index+1)*3600000).toISOString(),description:''}))}}));
  channels[0].payload.list.push({...channels[0].payload.list[0],title:'Final program duplicate'});channels.push(structuredClone(channels[0]));
  const publishEPG=(payload=channels)=>query("select public.arkhen_publish_epg_batch('provider-a','scope-a',$1,$2,$3,'test-worker')",[payload,expiry,jobs.epg]);
  await publishEPG();check(await count('epg_programs')===1200&&await count('provider_epg_cache')===20,'Batch inserts 1200 unique programs and 20 unique channel caches');
  check((await query("select title from public.epg_programs where channel_id='0' order by start_at limit 1")).rows[0].title==='Final program duplicate','Duplicate channel/program keys use the last supplied value');
  const cachedPrograms=(await query("select payload from public.provider_epg_cache where channel_id='0'")).rows[0].payload.list;
  check(cachedPrograms.length===60&&cachedPrograms.find(program=>program.start==='2026-10-15T00:00:00.000Z').title==='Final program duplicate','Visible EPG cache and normalized program index agree on duplicate program keys');
  await publishEPG();check(await changed('epg_programs')===0,'An unchanged EPG creates zero program UPDATE events');
  const next=structuredClone(channels);next.at(-1).payload.list.at(-1).title='Updated program';await publishEPG(next);check(await changed('epg_programs')===1,'One changed program creates exactly one UPDATE');
  const before=JSON.stringify((await query('select channel_id,payload from public.provider_epg_cache order by channel_id')).rows);
  await rejects(()=>publishEPG([{channel_id:'bad',payload:{list:[{title:'Invalid',start:'2026-10-16T00:00:00Z',end:'2026-10-15T00:00:00Z'}]}}]));
  check(JSON.stringify((await query('select channel_id,payload from public.provider_epg_cache order by channel_id')).rows)===before,'Failed EPG leaves all visible cache rows unchanged');
  await query("select public.arkhen_publish_epg('provider-a','scope-a','single',$1,$2,$3,'test-worker')",[{list:[{title:'Single',start:'2026-10-15T00:00:00Z',end:'2026-10-15T01:00:00Z'}]},expiry,jobs.epg]);
  check(await count('provider_epg_cache')===21,'Single-channel entry point delegates to the same guarded publication');
  await db.exec('rollback');console.log(JSON.stringify({assertions,catalogItems:1100,epgPrograms:1200,status:'passed'}));
}finally{await db.close();}
