// Isolated real PostgreSQL/RLS fixture. No network or real account data.
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {homeRecommendations} from '../web/home-recommendations.js';
import {movieRecommendationsFixture} from './test-movie-recommendations-fixture.mjs';
if(!process.argv[2])throw new Error('Pass the installed local PGlite module path.');
const {PGlite}=await import(pathToFileURL(process.argv[2]).href),db=new PGlite();
const user='10000000-0000-4000-8000-000000000001',other='10000000-0000-4000-8000-000000000002',foreignUser='10000000-0000-4000-8000-000000000003';
const provider='a'.repeat(64),scope='b'.repeat(64),foreign='e'.repeat(64),zero='00000000-0000-0000-0000-000000000000',candidate='90000000-0000-4000-8000-000000000001';
const q=(sql,args=[])=>db.query(sql,args);let assertions=0;
const check=(value,message)=>{assert.ok(value,message);assertions++;};
async function rejected(run,code='42501'){await assert.rejects(run,error=>error.code===code);assertions++;}
async function as(role,id,run){await db.exec('set role '+role);await q("select set_config('request.jwt.claim.sub',$1,false)",[id||'']);try{return await run();}finally{await db.exec('reset role');await q("select set_config('request.jwt.claim.sub','',false)");}}
const home=(id=user,adult=false,hidden={},hiddenItems={},p=provider)=>as('authenticated',id,async()=>(await q('select public.arkhen_home_library($1,$2,$3,$4,$5) data',[p,scope,adult,hidden,hiddenItems])).rows[0].data);
const load=async name=>{let sql=await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8');if(name.includes('marker_cloud_pipeline'))sql=sql.replace(/^create extension if not exists pg_net.*$/m,'').replace(/^select cron\.schedule\(.*$/m,'');await db.exec(sql);};
const catalog={movies:[],series:[],live:[]};
const types={movie:'movies',series:'series',live:'live'};
async function media(item,{p=provider,generation=zero,adult=false,order}={}){
 const type=types[item.kind];
 await q('insert into public.catalog_media(provider_key,scope_hash,media_type,media_id,name,metadata,category_ids,last_seen_snapshot,generation_id,is_adult,sort_order) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[p,scope,type,item.id,item.name,item,item.categoryIds||[item.categoryId||'general'],zero,generation,adult,order??catalog[type].length]);
 if(p===provider&&generation===zero&&!adult)catalog[type].push(item);
}
const favorites=async(id,item,{deleted=false}={})=>q("insert into public.user_favorites(user_id,provider,item_key,item,deleted_at) values($1,'wplay',$2,$3,case when $4 then now() end)",[id,`${item.kind}:${item.id}`,item,deleted]);
const progress=async(id,item,{episode,time=600,ago=0,deleted=false}={})=>{
 const entry={item,time,duration:1800,updated:Date.now()-ago,episode:episode?{id:episode,title:'Episode',season:1,number:1}:null};
 await q("insert into public.user_progress(user_id,provider,item_key,episode_id,entry,updated_at,deleted_at) values($1,'wplay',$2,$3,$4,now()-$5*interval '1 millisecond',case when $6 then now() end)",[id,`${item.kind}:${item.id}`,episode||'',entry,ago,deleted]);return entry;
};
try{
 await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
  create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
  grant usage on schema auth to anon,authenticated,service_role;grant execute on function auth.uid() to anon,authenticated,service_role;
  create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`);
 for(const name of ['20261015044236_arkhen_cloud_schema.sql','20261015053751_arkhen_manual_cache_refresh.sql','20261015095103_arkhen_shared_metadata_set_based.sql','20261015113615_arkhen_catalog_pages.sql','20261015113617_arkhen_marker_cloud_pipeline.sql','20261015115927_arkhen_cloud_provider_sources.sql','20261015115930_arkhen_cloud_collector.sql','20261015120527_arkhen_marker_incremental_source.sql','20261015131845_arkhen_catalog_previews.sql','20261015133920_arkhen_catalog_publish_scale.sql','20261015141803_arkhen_catalog_publish_batches.sql','20261015143432_arkhen_catalog_publish_memory.sql','20261015144254_arkhen_catalog_publication_diagnostics.sql','20261015150309_arkhen_catalog_domains.sql','20261015151331_arkhen_catalog_snapshot_preparation.sql','20261015152804_arkhen_catalog_generations.sql','20261015164720_arkhen_catalog_query_models.sql','20261015164721_arkhen_home_library.sql'])await load(name);
 await load('20261015170123_arkhen_home_query_plan.sql');
 check((await q("select proconfig from pg_proc where oid='public.arkhen_home_library(text,text,boolean,jsonb,jsonb)'::regprocedure")).rows[0].proconfig.includes('enable_nestloop=off'),'Plan correction is scoped to the home function.');
 await q('insert into auth.users values($1),($2),($3)',[user,other,foreignUser]);
 for(const [id,hash,p]of [[user,'c'.repeat(64),provider],[other,'d'.repeat(64),provider],[foreignUser,'f'.repeat(64),foreign]]){
  await q("select public.arkhen_identity_bind($1,$2,'wplay',$3,$4)",[hash,id,p,scope]);await q("select public.arkhen_validate_account($1,'active',now()+interval '1 day',now(),$2,$3)",[id,p,scope]);
 }
 await q("insert into public.catalog_visible_generations(provider_key,scope_hash,media_type,generation_id) select p,$3,t,$4::uuid from unnest(array[$1,$2]) p cross join unnest(array['live','movies','series']) t",[provider,foreign,scope,zero]);
 const empty=await home();check(empty.recommendations.items.length===0&&empty.recommendations.personalized===false&&empty.counts.movie===0&&empty.history.series.length===0,'An empty valid account and catalog remain valid with the scoped plan options.');
 for(const type of ['movies','series'])for(const [id,name]of [['action','Ação'],['drama','Séries/Drama'],['general','Geral']])await q('insert into public.catalog_categories(provider_key,scope_hash,media_type,category_id,name,last_seen_snapshot) values($1,$2,$3,$4,$5,$6)',[provider,scope,type,id,name,zero]);
 const watchedMovie={kind:'movie',id:'watched',name:'Ação conhecida (2020)',year:'2020',rating:8,categoryId:'action',categoryIds:['action']};
 const watchedSeries={kind:'series',id:'watched',name:'Drama conhecido (2020)',year:'2020',rating:8,categoryId:'drama',categoryIds:['drama']};
 const movie={kind:'movie',id:'film',name:'Aventura nova (2026) FHD',year:'2026',rating:8.2,categoryId:'action',categoryIds:['action']};
 const variant={...movie,id:'film-variant',name:'Aventura nova Full HD (2026)',rating:7.8};
 const show={kind:'series',id:'show',name:'Drama novo',year:'2025',rating:9,categoryId:'drama',categoryIds:['drama']};
 const channel={kind:'live',id:'channel',name:'Canal HD',categoryId:'general',categoryIds:['general']};
 for(const item of [watchedMovie,watchedSeries,movie,variant,show,channel,{kind:'movie',id:'rated',name:'Bem avaliado',year:'2026',rating:9.5,categoryId:'general'}])await media(item);
 await media({...movie,id:'adult',name:'Adulto restrito'},{adult:true});await media({...movie,id:'unpublished',name:'UNPUBLISHED'},{generation:candidate});await media({...movie,id:'foreign',name:'FOREIGN'},{p:foreign});
 const entries=[];entries.push(await progress(user,watchedMovie,{ago:1000}));entries.push(await progress(user,watchedSeries,{episode:'ep2',ago:2000}));await progress(user,watchedSeries,{episode:'ep1',ago:3000});await progress(user,channel,{time:0});
 await favorites(user,movie);await favorites(user,channel);await favorites(user,{...show,id:'missing',name:'Favorite without current catalog'});await favorites(user,{...movie,id:'deleted'},{deleted:true});await favorites(other,show);
 // Legacy progress deliberately omits isAdult; classification must come from
 // the trusted catalog, including category-only and exact-series matches.
 const adultMovie={...movie,id:'adult',name:'Unmarked legacy title',isAdult:false};
 const categoryAdult={...show,id:'category-adult',name:'Another unmarked title',categoryId:'restricted',categoryIds:['restricted']};
 await q("insert into public.catalog_categories(provider_key,scope_hash,media_type,category_id,name,is_adult,last_seen_snapshot) values($1,$2,'series','restricted','Reserved',true,$3)",[provider,scope,zero]);
 await media(categoryAdult);await progress(user,adultMovie);await progress(user,categoryAdult,{episode:'private-episode'});
 const inconsistentAdult={...movie,id:'metadata-adult',name:'Metadata classification',isAdult:true};
 await media(inconsistentAdult);await progress(user,{...inconsistentAdult,isAdult:false});
 await progress(user,{kind:'movie',id:'old-explicit',name:'Obsolete explicit title',is_adult:true});
 await progress(user,{kind:'movie',id:'old-unknown',name:'Obsolete ordinary title'});
 await progress(user,{kind:'series',id:'old-episode',name:'Obsolete ordinary series'},{episode:'positive-episode'});
 await q("update public.user_progress set entry=jsonb_set(entry,'{episode,adult}','true') where item_key='series:old-episode'");
 await favorites(user,adultMovie);
 const beforeFavorites=(await q('select count(*)::integer n from public.user_favorites')).rows[0].n;
 await load('20261015171124_arkhen_adult_progress_privacy.sql');
 await load('20261015172532_arkhen_progress_privacy_query_plan.sql');
 check((await q("select proconfig from pg_proc where oid='public.arkhen_progress_catalog_adult(uuid,text,text)'::regprocedure")).rows[0].proconfig.includes('enable_nestloop=on'),'Single-title privacy checks have their own indexed lookup plan.');
 check((await q("select pg_get_functiondef('public.arkhen_home_library(text,text,boolean,jsonb,jsonb)'::regprocedure) body")).rows[0].body.includes('selected_metadata as materialized'),'Metadata privacy filtering occurs after a materialization barrier for selected IDs.');
 check((await q("select count(*)::integer n from public.user_progress where item_key in('movie:adult','series:category-adult','movie:metadata-adult')")).rows[0].n===0,'Migration physically removes trusted adult legacy progress, including category-only episodes and catalog metadata.');
 check((await q('select count(*)::integer n from public.user_favorites')).rows[0].n===beforeFavorites,'Adult privacy cleanup leaves every favorite unchanged.');
 check((await q("select count(*)::integer n from public.user_progress where item_key='movie:old-explicit'")).rows[0].n===0,'Explicit adult legacy progress is deleted even when the provider ID is no longer in the catalog.');
 check((await q("select count(*)::integer n from public.user_progress where item_key='series:old-episode'")).rows[0].n===0,'An explicit legacy episode marker is sufficient even when the series itself has no adult flag.');
 check((await q("select count(*)::integer n from public.user_progress where item_key='movie:old-unknown'")).rows[0].n===1,'Unmarked obsolete progress survives the conservative cleanup.');
 catalog.series=catalog.series.filter(item=>item.id!==categoryAdult.id);
 catalog.movies=catalog.movies.filter(item=>item.id!==inconsistentAdult.id);
 const deniedAdult=async run=>{await assert.rejects(run,error=>error.code==='P0001'&&error.message==='ARKHEN_ADULT_PROGRESS_DISABLED');assertions++;};
 await deniedAdult(()=>as('authenticated',user,()=>progress(user,adultMovie)));
 await deniedAdult(()=>as('authenticated',user,()=>progress(user,categoryAdult,{episode:'private-episode'})));
 await deniedAdult(()=>as('service_role',null,()=>progress(user,adultMovie)));
 await deniedAdult(()=>as('authenticated',user,()=>progress(user,{...inconsistentAdult,isAdult:false})));
 await deniedAdult(()=>as('authenticated',user,()=>progress(user,{kind:'movie',id:'unknown-adult',name:'Unknown',isAdult:true})));
 await deniedAdult(()=>as('authenticated',user,()=>progress(user,{kind:'live',id:'unknown-marker',name:'Canal',group:'Erótico'})));
 await deniedAdult(()=>as('authenticated',user,()=>q("insert into public.user_progress(user_id,provider,item_key,entry) values($1,'wplay','movie:root-flag',$2)",[user,{adult:true,item:{kind:'movie',id:'root-flag',name:'Ordinary title'},time:10}])));
 await deniedAdult(()=>as('authenticated',user,()=>q("insert into public.user_progress(user_id,provider,item_key,episode_id,entry) values($1,'wplay','series:episode-flag','episode',$2)",[user,{item:{kind:'series',id:'episode-flag',name:'Ordinary title'},episode:{id:'episode',isAdult:true},time:10}])));
 await deniedAdult(()=>as('authenticated',user,()=>q("update public.user_progress set item_key='movie:adult',entry=jsonb_set(entry,'{item}',$2::jsonb) where user_id=$1 and item_key='movie:watched'",[user,adultMovie])));
 check((await q('select count(*)::integer n from public.user_progress where item_key=$1',['movie:adult'])).rows[0].n===0,'Rejected writes never leave adult rows or tombstones.');
 for(const item of [{kind:'live',id:'brand',name:'Adult Swim',rating:'18'},{kind:'movie',id:'unknown',name:'Unknown ordinary title'},{kind:'movie',id:'age-rating',name:'Ordinary mature drama',ageRating:18}]){
  await as('authenticated',user,()=>progress(user,item));
 }
 check((await as('authenticated',user,()=>q("select count(*)::integer n from public.user_progress where item_key in('live:brand','movie:unknown','movie:age-rating')"))).rows[0].n===3,'Adult Swim, ordinary age ratings and unclassified obsolete IDs remain valid.');
 const onlyOtherAdult={kind:'movie',id:'foreign-only-adult',name:'Ordinary title'};
 await media(onlyOtherAdult,{p:foreign,adult:true});await as('authenticated',user,()=>progress(user,onlyOtherAdult));
 check((await q('select public.arkhen_progress_catalog_adult($1,\'wplay\',$2) adult',[user,'movie:foreign-only-adult'])).rows[0].adult===false,'A foreign partition with the same ID cannot classify another account progress.');
 await rejected(()=>as('authenticated',other,()=>progress(user,{kind:'movie',id:'cross-owner',name:'Ordinary title'})));
 await rejected(()=>as('authenticated',user,()=>q('select public.arkhen_prune_adult_progress(500)')));
 await rejected(()=>as('anon',null,()=>q('select public.arkhen_prune_adult_progress(500)')));
 await rejected(()=>q('select public.arkhen_prune_adult_progress(501)'),'22023');
 // A later publication can classify an existing neutral title as adult. The
 // restrictive read policy hides it immediately, before bounded deletion.
 const later={kind:'movie',id:'later',name:'Previously unclassified',rating:9,categoryId:'general'};
 await media(later);await progress(other,later);
 await q("update public.catalog_media set is_adult=true where provider_key=$1 and media_type='movies' and media_id='later'",[provider]);
 check((await as('authenticated',other,()=>q("select count(*)::integer n from public.user_progress where item_key='movie:later'"))).rows[0].n===0,'A later classification immediately suppresses private reads before maintenance.');
 check((await home(other,true)).history.movie.length===0&&(await home(other,true)).recommendations.personalized===false,'Unlocking cannot restore adult history or derive personalized genre signals from it.');
 check((await as('service_role',null,()=>q('select public.arkhen_prune_adult_progress(1) n'))).rows[0].n===1,'Bounded service maintenance physically removes a later-confirmed adult record.');
 check((await q("select count(*)::integer n from public.user_progress where item_key='movie:later'")).rows[0].n===0,'Cleanup retains no adult tombstone or historical row.');
 catalog.movies=catalog.movies.filter(item=>item.id!=='later');
 let value=await home();check(value.schemaVersion===1&&value.generatedAt&&value.revisionLibrary,'Home response includes schema and actual private revision.');
 check(value.counts.live===1&&value.counts.movie===1&&value.counts.series===1,'Favorite counts preserve a private item absent from the current catalog.');
 check(value.history.movie.length===1&&value.history.series.length===1&&value.history.live.length===1,'Latest exact-episode progress produces one recent title per kind.');
 check(value.favoriteChannels.length===1&&value.favoriteChannels[0].id==='channel','Favorite channels are selected from this owner only.');
 const expected=homeRecommendations({...catalog,history:entries,movieCatalog:{categories:[{id:'action',name:'Ação'},{id:'general',name:'Geral'}]},seriesCatalog:{categories:[{id:'drama',name:'Séries/Drama'}]}});
 check(JSON.stringify(value.recommendations.items.map(row=>`${row.kind}:${row.id}`))===JSON.stringify(expected.items.map(row=>`${row.kind}:${row.id}`)),'SQL ranking matches local weights, interleaving, rating, year and quality deduplication.');
 check(value.recommendations.personalized===true,'Matching real genre signals label recommendations personalized.');
 check(!JSON.stringify(value).includes('Adulto')&&!JSON.stringify(value).includes('UNPUBLISHED')&&!JSON.stringify(value).includes('FOREIGN'),'Adult, unpublished and foreign metadata cannot leak.');
 check((await home(other)).counts.series===1&&(await home(other)).counts.movie===0&&(await home(other)).history.movie.length===0,'Another user in the same partition has independent favorites and history.');
 check((await home(other)).recommendations.personalized===false,'A new account gets shared rating fallback, never another account preferences.');
 await q("update public.catalog_media set home_identity=null where provider_key=$1 and media_type='movies' and media_id='film'",[provider]);
 check(await home()===null,'An incomplete derived generation returns preparing/null, never misleading empty recommendations.');
 await rejected(()=>as('authenticated',user,()=>q('select public.arkhen_prepare_home_identities(1000)')));
 await rejected(()=>as('anon',null,()=>q('select public.arkhen_prepare_home_identities(1000)')));
 check((await as('service_role',null,()=>q('select public.arkhen_prepare_home_identities(1) affected'))).rows[0].affected===1,'Service preparation honors the row limit and fills only pending current generation data.');
 check((await home()).recommendations.items.length>0,'A completed identity backfill restores the read response.');
 await q("update public.catalog_media set metadata=metadata||'{\"name\":\"Aventura nova (2026) FHD\"}' where provider_key=$1 and media_type='movies' and media_id='film'",[provider]);
 check((await q("select home_identity from public.catalog_media where provider_key=$1 and media_type='movies' and media_id='film'",[provider])).rows[0].home_identity==='movie:aventura nova:2026','The publication trigger derives the same identity for future metadata updates.');
 value=await home(user,false,{movies:['action']},{live:['channel']});check(value.history.movie.length===0&&value.favoriteChannels.length===0&&value.counts.movie===0&&value.counts.live===0,'Private hidden categories and items apply to counts, history and channels.');
 check(!value.recommendations.items.some(row=>['film','film-variant'].includes(row.id)),'Hidden categories cannot reappear in recommendations.');
 check(!(await home(user,true)).recommendations.items.some(row=>['adult','category-adult','later','metadata-adult'].includes(row.id)),'Adult titles remain absent from automatic recommendations even while unlocked, including inconsistent positive metadata flags.');
 check((await home(user,true)).counts.movie===(await home(user,false)).counts.movie+1,'Unlocking still allows the explicitly saved adult favorite.');
 await favorites(user,{kind:'movie',id:'outside',name:'Private outside catalog',categoryId:'',categoryIds:['action','drama']});
 check((await home(user,false,{movies:['action','drama']})).counts.movie===0,'All stored categories are checked for favorites absent from the catalog, even without a primary category.');
 check((await home(user,false,{movies:['action']})).counts.movie===1,'A multi-category missing favorite remains visible when at least one category is allowed.');
 await progress(user,{...movie,id:'obsolete',name:watchedMovie.name},{ago:5000});
 check(!(await home()).recommendations.items.some(item=>item.id==='watched'),'An obsolete provider ID still excludes the same watched identity.');
 await rejected(()=>home(foreignUser));await rejected(()=>home(user,false,{}, {},foreign));await rejected(()=>as('anon',null,()=>q('select public.arkhen_home_library($1,$2)',[provider,scope])));
 await rejected(()=>home(user,false,{movies:'not-an-array'}),'22023');await rejected(()=>home(user,false,{}, {movies:Array(2001).fill('x')}),'22023');await rejected(()=>home(user,null),'22023');
 await q("update public.user_progress set deleted_at=now() where user_id=$1 and item_key='movie:watched'",[user]);
 check((await home()).history.movie.length===0,'Progress tombstones remove watched rows immediately without mutating catalog data.');
 const unsafe=JSON.stringify(await home());check(!unsafe.includes(user)&&!unsafe.includes(other)&&!unsafe.includes('user_id')&&!unsafe.includes('episode_id'),'No owner identifiers or raw private records are included in the display response.');
 for(let index=0;index<35;index++){
  const item={kind:'movie',id:'extra-'+index,name:'Independent '+index,year:'2025',rating:8,categoryId:'general'};await media(item);await progress(user,item,{ago:4000+index});
 }
 value=await home();check(value.history.movie.length===30&&value.recommendations.items.length<=30,'Server bounds every returned history and recommendation list.');
 check(JSON.stringify(value.revisions)===JSON.stringify({live:zero,movies:zero,series:zero}),'Revisions are the current published generations of this partition.');
 check((await q("select prosecdef from pg_proc where oid='public.arkhen_home_library(text,text,boolean,jsonb,jsonb)'::regprocedure")).rows[0].prosecdef===false,'The private RPC remains SECURITY INVOKER.');
 await movieRecommendationsFixture({q,as,load,check,rejected,media,progress,user,other,foreignUser,provider,scope,foreign,zero,candidate});
 await q("update public.profiles set last_validated_at=now()-interval '2 days' where id=$1",[user]);await rejected(()=>home());
 console.log(JSON.stringify({ok:true,assertions}));
}catch(error){console.error(JSON.stringify({ok:false,code:error.code,message:error.message,detail:error.detail,where:error.where,position:error.position,internalPosition:error.internalPosition}));process.exitCode=1;}finally{await db.close();}
