// Local Postgres security integration; never contacts a real project/provider.
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const {PGlite}=await import(pathToFileURL(process.argv[2]).href),db=new PGlite();
let checks=0;const check=(value,message)=>{assert.ok(value,message);checks++;};
try{
 await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;create schema arkhen_private;revoke all on schema arkhen_private from public;grant usage on schema arkhen_private to service_role;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`);
 await db.exec(await readFile(new URL('../supabase/migrations/20261015115927_arkhen_cloud_provider_sources.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../supabase/migrations/20261015125530_arkhen_provider_source_import_window.sql',import.meta.url),'utf8'));
 const provider='a'.repeat(64),scope='b'.repeat(64),id='c'.repeat(64),cipher={version:1,iv:'a'.repeat(16),ciphertext:'b'.repeat(32)};
 await db.exec('set role service_role');
 await db.query("select public.arkhen_source_put($1,$2,$3,$4,now()+interval '120 minutes')",[provider,scope,id,cipher]);
 const row=(await db.query('select public.arkhen_source_get($1,$2) as source',[provider,scope])).rows[0].source;
 check(row.source_id===id&&row.cipher.ciphertext===cipher.ciphertext,'Only the encrypted, bounded source is persisted.');
 check((await db.query('select public.arkhen_source_get($1,$2) as source',['d'.repeat(64),scope])).rows[0].source===null,'Source lookup respects the full partition.');
 for(const interval of ['-1 minute','122 minutes']){let denied=false;try{await db.query(`select public.arkhen_source_put($1,$2,$3,$4,now()+interval '${interval}')`,[provider,scope,id,cipher]);}catch{denied=true;}check(denied,'Expired and overly long source leases are rejected.');}
 await db.query('select public.arkhen_artwork_put_batch($1)',[[{provider_key:provider,scope_hash:scope,ref:id,cipher,expires_at:new Date(Date.now()+60000).toISOString()}]]);
 check((await db.query('select public.arkhen_artwork_get($1,$2,$3) as source',[provider,scope,id])).rows[0].source.ref===id,'Artwork lookup binds the opaque ref and partition.');
 await db.exec('reset role');
 for(const role of ['anon','authenticated']){
  await db.exec('set role '+role);
  for(const sql of ["select public.arkhen_source_get('"+provider+"','"+scope+"')",'select * from arkhen_private.provider_sources','select * from arkhen_private.artwork_sources']){let denied=false;try{await db.exec(sql);}catch(error){denied=error.code==='42501';}check(denied,role+' cannot read or invoke encrypted source capabilities.');}
  await db.exec('reset role');
 }
 check((await db.query("select count(*)::int as count from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='arkhen_private' and c.relname in ('provider_sources','artwork_sources') and c.relrowsecurity")).rows[0].count===2,'Both private tables have RLS enabled.');
 console.log(JSON.stringify({verified:true,checks,passwordsPersisted:false}));
}catch(error){console.error(JSON.stringify({verified:false,code:error.code,message:error.message}));process.exitCode=1;}finally{await db.close();}
