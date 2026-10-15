// Local SQL integration test only. Pass an installed PGlite module path; this
// never connects to Supabase or handles a real account/provider credential.
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';

if(!process.argv[2])throw new Error('Pass the local PGlite module path.');
const {PGlite}=await import(pathToFileURL(process.argv[2]).href),db=new PGlite();
const user='10000000-0000-4000-8000-000000000001',other='10000000-0000-4000-8000-000000000002',provider='a'.repeat(64),scope='b'.repeat(64),snapshot='20000000-0000-4000-8000-000000000001';
let assertions=0;
const check=(condition,message)=>{assert.ok(condition,message);assertions++;};
const query=(sql,args=[])=>db.query(sql,args);
async function asRole(role,id,run){
  await db.exec('set role '+role);await query("select set_config('request.jwt.claim.sub',$1,false)",[id||'']);
  try{return await run();}finally{await db.exec('reset role');await query("select set_config('request.jwt.claim.sub','',false)");}
}
const page=(options={})=>asRole('authenticated',options.user||user,async()=>{
  const args=[options.provider||provider,scope,options.type||'live',options.category??null,options.page??1,options.after??-1,120,options.snapshot??null,options.adult??false];
  return (await query('select public.arkhen_catalog_page($1,$2,$3,$4,$5,$6,$7,$8,$9) as page',args)).rows[0].page;
});
try{
  await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
    create schema auth;create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to anon,authenticated,service_role;grant execute on function auth.uid() to anon,authenticated,service_role;`);
  await db.exec('create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);');
  for(const filename of ['20261015044236_arkhen_cloud_schema.sql','20261015095103_arkhen_shared_metadata_set_based.sql','20261015113615_arkhen_catalog_pages.sql','20261015115927_arkhen_cloud_provider_sources.sql','20261015115930_arkhen_cloud_collector.sql','20261015131845_arkhen_catalog_previews.sql','20261015133920_arkhen_catalog_publish_scale.sql','20261015141803_arkhen_catalog_publish_batches.sql','20261015143432_arkhen_catalog_publish_memory.sql','20261015144254_arkhen_catalog_publication_diagnostics.sql'])await db.exec(await readFile(new URL('../supabase/migrations/'+filename,import.meta.url),'utf8'));
  await query('insert into auth.users(id) values($1),($2)',[user,other]);
  await asRole('service_role',null,async()=>{
    for(const [id,hash,p]of [[user,'c'.repeat(64),provider],[other,'d'.repeat(64),'e'.repeat(64)]]){
      await query("select public.arkhen_identity_bind($1,$2,'wplay',$3,$4)",[hash,id,p,scope]);
      await query("select public.arkhen_validate_account($1,'active',now()+interval '1 day',now(),$2,$3)",[id,p,scope]);
    }
  });
  const job=(await query("insert into arkhen_private.cache_jobs(provider_key,scope_hash,job_type,status,locked_by,lease_until) values($1,$2,'catalog','leased','fixture-worker',now()+interval '10 minutes') returning id",[provider,scope])).rows[0].id;
  const payload={categories:[{id:'safe',name:'Drama'},{id:'adult',name:'Adultos 18+'},{id:'swim',name:'Adult Swim'}],items:Array.from({length:760},(_,index)=>({id:String(index),name:'Canal '+index,kind:'live',categoryId:index<25?'adult':index===25?'swim':'safe',categoryIds:[index<25?'adult':index===25?'swim':'safe'],poster:'/api/shared-image/'+(index===0?'f':'a').repeat(64),backdrop:'',plot:'A'.repeat(320)}))};
  const publish=async(data,id=snapshot)=>asRole('service_role',null,()=>query("select public.arkhen_publish_catalog($1,$2,'live',$3,true,$4,now()+interval '1 day',$5,'fixture-worker')",[provider,scope,data,id,job]));
  await publish(payload);
  const first=await page();check(first.items.length===120,'Adult filtering occurs before the bounded page limit.');check(first.items[0].id==='25','Adult Swim remains visible; adult category items are excluded.');check(first.pagination.total===735,'Locked totals exclude adult records.');check(first.categories.length===2,'Locked categories exclude adult labels.');
  const unlocked=await page({adult:true});check(unlocked.items.length===120&&unlocked.items[0].id==='0'&&unlocked.pagination.total===760,'The unlocked request changes visibility only for that request.');
  const ids=new Set(first.items.map(item=>item.id));let current=first,pages=1;
  while(current.pagination.byCategory.__all.hasMore){const state=current.pagination.byCategory.__all;current=await page({page:state.nextPage,after:state.nextCursor,snapshot});for(const item of current.items){check(!ids.has(item.id),'Keyset pages do not duplicate titles.');ids.add(item.id);}pages++;}
  check(ids.size===735&&current.pagination.complete===true,'All safe titles complete without category duplication.');
  check((await page({category:'adult'})).items.length===0,'A direct adult-category request remains filtered.');
  check(await page({user:other})===null,'A different account partition cannot read this catalog.');check(await page({provider:'e'.repeat(64)})===null,'Partition lookup cannot cross the authenticated viewer scope.');
  const refs=await asRole('authenticated',user,()=>query('select * from public.catalog_artwork_refs'));
  check(refs.rows.length===760,'Every normalized artwork reference is indexed.');check(Object.keys(refs.rows[0]).every(key=>['provider_key','scope_hash','ref','media_type','media_id','field'].includes(key)),'Artwork lookup contains no upstream URL or credentials.');
  check((await asRole('authenticated',other,()=>query('select * from public.catalog_artwork_refs'))).rows.length===0,'Artwork lookup follows provider partition RLS.');
  let denied=false;try{await asRole('anon',null,()=>query('select public.arkhen_catalog_page($1,$2,$3)',[provider,scope,'live']));}catch(error){denied=error.code==='42501';}check(denied,'Anonymous callers cannot execute the catalog RPC.');
  let unbounded=false;try{await asRole('authenticated',user,()=>query('select public.arkhen_catalog_page($1,$2,$3,p_limit=>null)',[provider,scope,'live']));}catch(error){unbounded=error.code==='22023';}check(unbounded,'An explicit null limit cannot disable the SQL page bound.');
  const replacement={...payload,items:payload.items.slice(1)};await publish(replacement,'20000000-0000-4000-8000-000000000002');
  const rollover=await page({page:4,after:480,snapshot});check(rollover.pagination.snapshotChanged===true&&rollover.pagination.byCategory.__all.nextPage===2,'A changed snapshot restarts at the new first page.');
  check((await query("select count(*)::int as count from public.catalog_artwork_refs where ref=$1",['f'.repeat(64)])).rows[0].count===0,'Removed artwork references cannot survive a new publication.');
  const previewCategories=[{id:'vip',name:'VIP',isAdult:true},{id:'safe',name:'Drama'},{id:'swim',name:'Adult Swim'}];
  const previewItem=index=>({id:'preview-'+index,name:'Titulo '+index,kind:'movie',categoryId:index<40?'vip':index===40?'swim':'safe',categoryIds:[index<40?'vip':index===40?'swim':'safe'],poster:'/api/shared-image/'+'7'.repeat(64)});
  const seed=async(type,data)=>asRole('service_role',null,()=>query('select public.arkhen_catalog_preview_seed($1,$2,$3,$4)',[job,'fixture-worker',type,data]));
  await seed('movies',{categories:previewCategories,items:Array.from({length:120},(_,index)=>previewItem(index))});
  const preview=await page({type:'movies'});check(preview.items.length===80&&preview.items[0].id==='preview-40','A cold preview filters generic restricted categories before returning safe items.');
  check(preview.preparing===true&&preview.catalogComplete===false&&preview.pagination.complete===false&&preview.pagination.source==='supabase','The existing catalog RPC identifies a draft without claiming completeness.');
  check(preview.pagination.byCategory.__all.hasMore===false,'Drafts never start an unbounded pagination or provider scan.');
  check(preview.categories.some(category=>category.name==='Adult Swim')&&!preview.categories.some(category=>category.id==='vip'),'Preview category classification preserves Adult Swim and hides restricted VIP.');
  check((await page({type:'movies',adult:true})).items.length===120,'Unlocked visibility does not alter the shared preview.');
  check((await page({type:'movies',category:'vip'})).items.length===0,'A direct restricted preview category is filtered.');
  check((await query("select count(*)::int as n from public.provider_catalog_cache where provider_key=$1 and media_type='movies'",[provider])).rows[0].n===0,'A preview never creates a successful complete snapshot.');
  check((await asRole('authenticated',other,()=>query('select * from public.catalog_preview_cache'))).rows.length===0&&await page({type:'movies',user:other})===null,'Draft tables and the RPC enforce the same partition RLS.');
  check((await query("select count(*)::int as n from public.catalog_artwork_refs where provider_key=$1 and media_type='movies'",[provider])).rows[0].n===120,'Bounded draft artwork metadata supports current image guards without a provider-wide scan.');
  for(const role of ['anon','authenticated']){
    let seedDenied=false;try{await asRole(role,user,()=>query('select public.arkhen_catalog_preview_seed($1,$2,$3,$4)',[job,'fixture-worker','movies',{categories:[],items:[]}]));}catch(error){seedDenied=error.code==='42501';}check(seedDenied,'Browser roles cannot write shared previews.');
  }
  let previewWriteDenied=false;try{await asRole('authenticated',user,()=>query('delete from public.catalog_preview_cache'));}catch(error){previewWriteDenied=error.code==='42501';}check(previewWriteDenied,'RLS readers cannot modify a preview directly.');
  const previewCheckpoint=(index)=>asRole('service_role',null,()=>query('select public.arkhen_cloud_catalog_checkpoint($1,$2,$3,$4,$5,$6)',[job,'fixture-worker','movies','movies:0:'+index+':0',{categories:previewCategories,items:Array.from({length:20},(_,offset)=>previewItem((index-1)*20+offset))},{type:'movies',cursor:{categoryIndex:0,page:index+1}}]));
  for(let index=1;index<=12;index++)await previewCheckpoint(index);
  const sampled=(await query('select payload,sampled_pages from public.catalog_preview_cache where provider_key=$1 and media_type=$2',[provider,'movies'])).rows[0];
  check(sampled.sampled_pages===12&&sampled.payload.items.length===120&&sampled.payload.safeItems.length===120,'The first twelve pages materialize at most 120 unrestricted and 120 safe records.');
  const safeDraft=await page({type:'movies'});check(safeDraft.items.length===120&&safeDraft.items[0].id==='preview-40','Filtering precedes the draft row limit even when initial items are restricted.');
  for(let index=13;index<=20;index++)await previewCheckpoint(index);
  const frozen=(await query('select payload,sampled_pages from public.catalog_preview_cache where provider_key=$1 and media_type=$2',[provider,'movies'])).rows[0];
  check(JSON.stringify(frozen)===JSON.stringify(sampled),'Later staging pages cannot grow or repeatedly rebuild the bounded preview.');
  await seed('movies',{categories:previewCategories,items:[previewItem(999)]});check((await page({type:'movies'})).items[0].id==='preview-40','A repeated first-page probe cannot replace an assembled preview.');
  check((await query("select count(*)::int as n from public.catalog_media where provider_key=$1 and media_type='movies' and is_active",[provider])).rows[0].n<=240,'Cold normalized rows remain bounded for metadata and parental lookup.');
  await seed('live',{categories:[],items:[{id:'wrong-preview',name:'Must not replace',kind:'live'}]});
  check((await page()).items[0].id===rollover.items[0].id&&(await query("select count(*)::int as n from public.catalog_media where provider_key=$1 and media_type='live' and is_active",[provider])).rows[0].n===759,'A draft never replaces or deactivates an existing complete catalog.');
  await asRole('service_role',null,()=>query("select public.arkhen_publish_catalog($1,$2,'movies',$3,true,$4,now()+interval '1 day',$5,'fixture-worker')",[provider,scope,{categories:previewCategories,items:Array.from({length:10},(_,index)=>previewItem(index+40))},'20000000-0000-4000-8000-000000000003',job]));
  const finishedDraft=await page({type:'movies',snapshot:job});check(finishedDraft.items.length===10&&finishedDraft.pagination.complete===true&&finishedDraft.pagination.snapshotChanged===true&&!finishedDraft.preparing,'An atomic complete publication takes precedence over the old draft and restarts its cursor.');
  await query("update public.profiles set status='disabled' where id=$1",[user]);check(await page()===null,'Disabled viewers lose access through RLS.');
  check(await page({type:'movies'})===null,'Disabled viewers also lose access to drafts and completed VOD.');
  const stagedJob=(await query("insert into arkhen_private.cache_jobs(provider_key,scope_hash,job_type,status,locked_by,lease_until) values($1,$2,'catalog','leased','staged-worker',now()+interval '10 minutes') returning id",['e'.repeat(64),scope])).rows[0].id;
  await asRole('service_role',null,()=>query("select public.arkhen_publish_catalog($1,$2,'movies',$3,true,$4,now()+interval '1 day',$5,'staged-worker')",['e'.repeat(64),scope,{categories:[{id:'safe',name:'Comedia'}],items:[{id:'old',kind:'movie',name:'Old complete',categoryId:'safe'}]},'20000000-0000-4000-8000-000000000004',stagedJob]));
  const checkpoint=(step,data,progress)=>asRole('service_role',null,()=>query('select public.arkhen_cloud_catalog_checkpoint($1,$2,$3,$4,$5,$6)',[stagedJob,'staged-worker','movies',step,data,progress]));
  await checkpoint('movies:0:1:0',{categories:[{id:'vip',name:'VIP',isAdult:true},{id:'safe',name:'Comedia'}],items:[{id:'9',name:'Titulo',kind:'movie',categoryId:'safe',categoryIds:['safe']}]},{type:'movies',cursor:{categoryIndex:0,page:2}});
  await checkpoint('movies:0:1:1',{categories:[],items:[{id:'obsolete',name:'Obsolete',kind:'movie',categoryId:'safe'}]},{});
  await checkpoint('movies:0:1:0',{categories:[{id:'vip',name:'VIP',isAdult:true},{id:'safe',name:'Comedia'}],items:[{id:'9',name:'Titulo',kind:'movie',categoryId:'safe',categoryIds:['safe']}]},{type:'movies',cursor:{categoryIndex:0,page:2},pageChunk:null});
  check((await query('select count(*)::int as n from arkhen_private.cloud_catalog_staging where job_id=$1',[stagedJob])).rows[0].n===1,'A retried shorter page removes leftover chunks atomically.');
  await checkpoint('movies:1:1:0',{categories:[{id:'vip',name:'VIP',isAdult:true}],items:[{id:'9',name:'Titulo atualizado',kind:'movie',categoryId:'vip',categoryIds:['vip']}]},{type:'movies',typeReady:'movies'});
  const publishStaged=()=>asRole('service_role',null,()=>query("select public.arkhen_cloud_catalog_publish($1,'staged-worker','movies') as state",[stagedJob]));
  const pending=(await publishStaged()).rows[0].state;check(!pending.publishedTypes?.includes('movies')&&pending.typeReady==='movies'&&pending.publicationCursors.movies>0,'A bounded normalization batch records a durable private cursor before publication.');
  check((await query("select payload->'items'->0->>'id' as id from public.provider_catalog_cache where provider_key=$1 and media_type='movies'",['e'.repeat(64)])).rows[0].id==='old','Normalization preserves the previous complete raw snapshot.');
  check((await query("select is_active from public.catalog_media where provider_key=$1 and media_type='movies' and media_id='old'",['e'.repeat(64)])).rows[0].is_active===true,'Normalization preserves the previous complete index until the atomic publication.');
  for(const table of ['catalog_publish_categories','catalog_publish_items','catalog_publish_artwork']){let denied=false;try{await asRole('authenticated',other,()=>query('select * from arkhen_private.'+table));}catch(error){denied=error.code==='42501';}check(denied,'Authenticated viewers cannot access private normalized staging.');}
  const originalPublisher=(await query("select pg_get_functiondef('public.arkhen_cloud_catalog_publish(uuid,text,text)'::regprocedure) as body")).rows[0].body;
  await db.exec(originalPublisher.replace(' insert into public.provider_catalog_cache('," raise query_canceled;\n insert into public.provider_catalog_cache("));
  const interrupted=(await publishStaged()).rows[0].state;
  check(interrupted.publicationFailure.code==='57014'&&interrupted.publicationFailure.stage==='snapshot'&&!interrupted.publishedTypes?.includes('movies'),'A canceled final publication persists only its private sanitized phase and remains incomplete.');
  check((await query("select payload->'items'->0->>'id' as id from public.provider_catalog_cache where provider_key=$1 and media_type='movies'",['e'.repeat(64)])).rows[0].id==='old'&&(await query("select is_active from public.catalog_media where provider_key=$1 and media_type='movies' and media_id='old'",['e'.repeat(64)])).rows[0].is_active===true,'A final timeout rolls back normalized public rows and preserves the old complete snapshot together.');
  await db.exec(originalPublisher);
  const state=(await publishStaged()).rows[0].state;check(state.publishedTypes.includes('movies')&&!state.typeReady,'Publication records a durable completed type in the same transaction.');
  check(!state.publicationFailure,'A successful retry clears the previous private timeout diagnostic.');
  check(JSON.stringify((await publishStaged()).rows[0].state)===JSON.stringify(state),'A retry after publication does not publish an empty catalog.');
  const merged=(await query("select metadata,category_ids,is_adult from public.catalog_media where provider_key=$1 and media_type='movies' and media_id='9'",['e'.repeat(64)])).rows[0];
  check(merged.metadata.name==='Titulo atualizado'&&merged.category_ids.join(',')==='safe,vip','Staged pages preserve the latest item and union category memberships.');
  check(merged.is_adult===true,'Restricted generic categories stay protected in merged publications.');
  check((await query('select count(*)::int as n from arkhen_private.cloud_catalog_staging where job_id=$1',[stagedJob])).rows[0].n===0,'Published staging rows are removed.');
  check((await query('select count(*)::int as n from arkhen_private.catalog_publish_items where job_id=$1',[stagedJob])).rows[0].n===0,'Normalized staging is removed only after the complete publication.');
  let oversizedRejected=false;await db.exec('begin');
  try{
    await db.exec('alter table arkhen_private.cloud_catalog_staging drop constraint cloud_catalog_staging_payload_check');
    await query("update arkhen_private.cloud_job_progress set progress=progress||jsonb_build_object('typeReady','series') where job_id=$1",[stagedJob]);
    await query("insert into arkhen_private.cloud_catalog_staging(job_id,media_type,step_key,payload) values($1,'series','oversized',jsonb_build_object('categories','[]'::jsonb,'items',jsonb_build_array(jsonb_build_object('id','oversized','name','Oversized','kind','series','plot',repeat('x',4194304)))))",[stagedJob]);
    await query("select public.arkhen_cloud_catalog_publish($1,'staged-worker','series')",[stagedJob]);
  }catch(error){oversizedRejected=error.code==='P0001'&&error.message==='Publication page exceeds bounded batch limit';}
  finally{await db.exec('rollback');}
  check(oversizedRejected,'An unexpectedly oversized staging page cannot be mistaken for EOF or publish an incomplete empty snapshot.');
  await asRole('service_role',null,()=>query("select public.arkhen_cloud_catalog_yield($1,'staged-worker',$2)",[stagedJob,{cursor:{categoryIndex:2,page:3}}]));
  const released=(await query('select status,locked_by,attempts from arkhen_private.cache_jobs where id=$1',[stagedJob])).rows[0];check(released.status==='queued'&&released.locked_by===null,'A successful checkpoint releases the job for another invocation.');
  let lost=false;try{await checkpoint('movies:3:1:0',{categories:[],items:[]},{});}catch(error){lost=error.code==='55000';}check(lost,'An invocation cannot append pages after releasing its lease.');
  let privateDenied=false;try{await asRole('authenticated',other,()=>query("select public.arkhen_cloud_catalog_state($1,'staged-worker')",[stagedJob]));}catch(error){privateDenied=error.code==='42501';}check(privateDenied,'Authenticated browsers cannot access collector progress.');
  await query("update arkhen_private.cache_jobs set run_after=now()-interval '1 minute' where id=$1",[stagedJob]);
  const claimCloud=()=>asRole('service_role',null,()=>query("select * from public.arkhen_claim_cloud_cache_jobs('cloud-worker')"));
  check((await claimCloud()).rows.length===0,'The cloud collector leaves local-only sources and their retries untouched.');
  await asRole('service_role',null,()=>query("select public.arkhen_source_put($1,$2,$3,$4,now()+interval '20 minutes')",['e'.repeat(64),scope,'f'.repeat(64),{version:1,iv:'a'.repeat(16),ciphertext:'b'.repeat(24)}]));
  check((await claimCloud()).rows[0]?.id===stagedJob,'The cloud collector claims a due job once an encrypted valid source exists.');
  console.log(JSON.stringify({ok:true,assertions,fixture_items:760,locked_items:ids.size,pages,full_bytes:Buffer.byteLength(JSON.stringify(payload)),first_page_bytes:Buffer.byteLength(JSON.stringify(first))}));
}finally{await db.close();}
