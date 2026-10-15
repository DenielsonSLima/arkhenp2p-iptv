// PostgreSQL/RLS fixture only. No credentials, remote writes or real accounts.
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
if(!process.argv[2])throw new Error('Pass the local PGlite module path.');
const {PGlite}=await import(pathToFileURL(process.argv[2]).href),db=new PGlite();
const provider='a'.repeat(64),scope='b'.repeat(64),foreign='e'.repeat(64),user='10000000-0000-4000-8000-000000000001',other='10000000-0000-4000-8000-000000000002',generation='00000000-0000-0000-0000-000000000000',future='90000000-0000-4000-8000-000000000001';
let assertions=0;const check=(value,message)=>{assert.ok(value,message);assertions++;};
const q=(sql,args=[])=>db.query(sql,args),migration=async name=>db.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
async function as(role,id,run){await db.exec('set role '+role);await q("select set_config('request.jwt.claim.sub',$1,false)",[id||'']);try{return await run();}finally{await db.exec('reset role');await q("select set_config('request.jwt.claim.sub','',false)");}}
async function denied(run,code='42501'){await assert.rejects(run,error=>error.code===code);assertions++;}
const search=(query,options={})=>as('authenticated',options.user||user,async()=>(await q('select public.arkhen_global_search($1,$2,$3,$4,$5,$6,$7,$8,$9) result',[options.provider||provider,scope,query,options.type||'all',options.offset||0,options.limit||120,options.hidden||{},options.hiddenItems||{},options.adult||false])).rows[0].result);
const readModel=(type='movies',adult=false,id=user,p=provider)=>as('authenticated',id,async()=>(await q('select public.arkhen_catalog_read_model($1,$2,$3,$4) result',[p,scope,type,adult])).rows[0].result);
try{
 await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to anon,authenticated,service_role;grant execute on function auth.uid() to anon,authenticated,service_role;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`);
 for(const name of ['20261015044236_arkhen_cloud_schema.sql','20261015053751_arkhen_manual_cache_refresh.sql','20261015095103_arkhen_shared_metadata_set_based.sql','20261015113615_arkhen_catalog_pages.sql','20261015115927_arkhen_cloud_provider_sources.sql','20261015115930_arkhen_cloud_collector.sql','20261015131845_arkhen_catalog_previews.sql','20261015133920_arkhen_catalog_publish_scale.sql','20261015141803_arkhen_catalog_publish_batches.sql','20261015143432_arkhen_catalog_publish_memory.sql','20261015144254_arkhen_catalog_publication_diagnostics.sql','20261015150309_arkhen_catalog_domains.sql','20261015151331_arkhen_catalog_snapshot_preparation.sql','20261015152804_arkhen_catalog_generations.sql','20261015164720_arkhen_catalog_query_models.sql'])await migration(name);
 await q('insert into auth.users values($1),($2)',[user,other]);
 for(const [id,hash,p] of [[user,'c'.repeat(64),provider],[other,'d'.repeat(64),foreign]]){await q("select public.arkhen_identity_bind($1,$2,'wplay',$3,$4)",[hash,id,p,scope]);await q("select public.arkhen_validate_account($1,'active',now()+interval '1 day',now(),$2,$3)",[id,p,scope]);}
 for(const type of ['live','movies','series']){
  await q('insert into public.catalog_visible_generations(provider_key,scope_hash,media_type,generation_id) values($1,$2,$3,$4)',[provider,scope,type,generation]);
  await q("insert into public.provider_catalog_cache(provider_key,scope_hash,media_type,payload,expires_at,snapshot_id,index_generation,is_complete) values($1,$2,$3,'{}',now()+interval '1 day',$4,$4,true)",[provider,scope,type,generation]);
  for(const [id,name,adult] of [['safe','Séries/Drama',false],['another','Ação',false],['adult','Adultos',true]])await q('insert into public.catalog_categories(provider_key,scope_hash,media_type,category_id,name,is_adult,last_seen_snapshot,generation_id) values($1,$2,$3,$4,$5,$6,$7,$7)',[provider,scope,type,id,name,adult,generation]);
 }
 const add=async(type,id,name,extra={})=>{const metadata={id,name,kind:type==='movies'?'movie':type,categoryId:'safe',categoryIds:extra.categories||['safe'],...extra.metadata};await q('insert into public.catalog_media(provider_key,scope_hash,media_type,media_id,name,metadata,category_ids,last_seen_snapshot,generation_id,is_adult,sort_order) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[extra.provider||provider,scope,type,id,name,metadata,extra.categories||['safe'],generation,extra.generation||generation,extra.adult||false,extra.order||0]);};
 await add('movies','exact','Ação',{metadata:{year:2026,poster:'/cover',backdrop:'/scene',rating:'9,1',added:'100'}});
 await add('movies','prefix','Ação hero',{metadata:{genre:'Action & Adventure',rating:'8',added:'200'},categories:['safe','another']});
 await add('movies','substring','Uma ação',{metadata:{genres:[{name:'Sci-Fi & Fantasy'}]}});
 await add('movies','words','Hero de Ação',{metadata:{group:'Estreias',rating:'bad'}});
 await add('movies','metadata','Outro título',{metadata:{genre:'Ação'}});
 await add('movies','same','Ação parte 10',{order:2});await add('movies','part2','Ação parte 2',{order:1});
 for(let index=0;index<125;index++)await add('movies','bulk'+index,'Ação catálogo '+index,{order:index+10});
 await add('series','same','Ação série');await add('live','same','Ação TV');
 await add('movies','adult','Ação restrita',{adult:true,categories:['adult']});
 await add('movies','future','Ação invisível',{generation:future});await add('movies','foreign','Ação outra conta',{provider:foreign});
 await add('movies','new-film','Novo Filme (2026)',{metadata:{year:2026,added:'2026-10-15T12:00:00Z',rating:8,poster:'/poster',backdrop:'/backdrop'},order:999});
 await add('movies','new-film-hd','Novo Filme (2026) HD',{metadata:{year:2026,added:'100'},order:1000});
 check((await readModel())===null,'A new read model is unknown until its completed global build.');
 let result=await search('  ÁçÃO   ');check(result.query==='acao'&&result.items[0].id==='exact','Search normalizes accents/case/spacing and ranks exact titles first.');
 check(result.items.length===120&&result.total===134&&result.counts.movie===132&&result.counts.live===1&&result.counts.series===1,'Counts include the complete catalog, not only the first 120 results.');
 check(result.hasMore&&result.nextOffset===120&&Object.keys(result.revision).length===3&&result.complete,'The response carries exact continuation and all published revisions.');
 check(result.items.every(item=>typeof item.isAdult==='boolean'&&!item.isAdult),'Adult classification comes from the trusted relational column.');
 result=await search('ação',{offset:120});check(result.items.length===14&&!result.hasMore&&result.nextOffset===null,'Final search continuation has no fabricated next page.');
 result=await search('acao',{type:'series'});check(result.items.length===1&&result.items[0].kind==='series'&&result.total===1&&result.counts.movie===132,'Selecting Series searches Series, while tab counts retain all types.');
 result=await search('hero acao');check(result.items.length===2&&result.items.every(item=>['prefix','words'].includes(item.id)),'All query words must match, independently of their order.');
 check((await search('aç')).tooShort&&(await search('aç')).items.length===0,'The minimum three normalized characters is enforced by SQL.');
 check((await search('①Áa')).query==='①aa','Query normalization uses NFD, matching the browser/API contract.');
 result=await search('acao',{hidden:{movies:['safe']}});check(result.counts.movie===1&&result.items.find(item=>item.kind==='movie')?.id==='prefix','Hiding one category preserves a title with another visible membership.');
 result=await search('acao',{hiddenItems:{movies:['prefix']}});check(result.counts.movie===131&&!result.items.some(item=>item.id==='prefix'),'Item exclusions affect ranking and complete tab counts.');
 result=await search('acao',{adult:true});check(result.counts.movie===133&&result.total===135,'The server-controlled adult mode changes counts and results together.');
 check((await search('%_x')).total===0,'Search treats wildcard characters as literal input.');
 await denied(()=>search('acao',{provider:foreign}));await denied(()=>search('acao',{user:other}));
 await denied(()=>as('anon',null,()=>q("select public.arkhen_global_search($1,$2,'acao')",[provider,scope])));
 await denied(()=>search('acao',{limit:121}),'22023');await denied(()=>search('a'.repeat(161)),'22023');await denied(()=>search('acao',{hidden:{movies:Array(2001).fill('x')}}),'22023');await denied(()=>search('acao',{hiddenItems:{series:[123]}}),'22023');
 await denied(()=>as('authenticated',user,()=>q('select public.arkhen_prepare_catalog_read_model($1,$2,$3)',[provider,scope,'movies'])));
 for(const type of ['movies','series','live'])await as('service_role',null,()=>q('select public.arkhen_prepare_catalog_read_model($1,$2,$3)',[provider,scope,type]));
 const model=await readModel();check(model.mediaType==='movies'&&model.schemaVersion===1&&model.total===134&&model.snapshotId===generation,'Daily navigation has the complete typed immutable snapshot.');
 check(model.orders.name.length===134&&new Set(model.orders.name).size===134&&!model.orders.name.includes('adult')&&!model.orders.name.includes('future'),'Every visible title appears exactly once in each full order.');
 check(model.orders.name.indexOf('part2')<model.orders.name.indexOf('same'),'Numeric name sorting puts part 2 before part 10.');
 check(model.orders.date[0]==='prefix'&&model.orders.rating[0]==='exact','Date and rating orders retain numeric source semantics.');
 check(model.genres.find(genre=>genre.id==='drama').count===134&&model.genres.find(genre=>genre.id==='acao-aventura').itemIds.includes('prefix'),'Genres combine canonical metadata and real category taxonomy without losing memberships.');
 check(model.categories.find(category=>category.id==='another').count===1&&model.categories.every(category=>category.id!=='adult'),'Category counts and memberships are computed separately per parental visibility.');
 check(model.orders.releases.includes('new-film')&&!model.orders.releases.includes('new-film-hd'),'Releases deduplicate title/year editions using the shared source ranking.');
 check(model.orders.featured.length===36&&model.orders.featured.indexOf('new-film')>=0,'Featured provides a bounded candidate sequence before private visibility filters.');
 check((await readModel('movies',true)).total===135&&(await readModel('series')).total===1,'Full and safe models and media types are independent.');
 check((await readModel('live')).genres.length===0,'TV never inherits film or series genre facets.');
 await denied(()=>readModel('movies',false,other));await denied(()=>as('authenticated',user,()=>q('delete from public.catalog_navigation_cache')));
 await q('update public.catalog_visible_generations set generation_id=$1 where media_type=$2 and provider_key=$3',[future,'movies',provider]);
 check((await readModel())===null,'A publication swap cannot return the previous generation as the new navigation model.');
 check((await as('authenticated',user,()=>q("select * from public.catalog_navigation_cache where media_type='movies'"))).rows.length===0,'RLS hides retired navigation snapshots directly as well as via RPC.');
 await q('update public.catalog_visible_generations set generation_id=$1 where media_type=$2 and provider_key=$3',[generation,'movies',provider]);
 await db.exec("create or replace function public.arkhen_query_genre_label(p_id text) returns text language sql immutable parallel safe security invoker set search_path='' as $$ select chr(65533) $$");
 await q("update public.catalog_navigation_cache set payload=jsonb_set(payload,'{genres}',(select coalesce(jsonb_agg(genre||jsonb_build_object('name',chr(65533))),'[]') from jsonb_array_elements(payload->'genres') genre))");
 await migration('20261015164722_arkhen_catalog_genre_labels_utf8.sql');
 check((await q("select ascii(substring(public.arkhen_query_genre_label('acao'),2,1)) code")).rows[0].code===231,'UTF-8 label repair restores the actual cedilla codepoint.');
 check((await readModel()).genres.find(genre=>genre.id==='acao-aventura').name==='Ação e aventura','Stored navigation labels are repaired without republishing the catalog.');
 await q("update public.profiles set last_validated_at=now()-interval '2 days' where id=$1",[user]);
 await denied(()=>search('acao'));await denied(()=>readModel());
 console.log(JSON.stringify({ok:true,assertions,search:true,navigation:true,rls:true}));
}finally{await db.close();}
