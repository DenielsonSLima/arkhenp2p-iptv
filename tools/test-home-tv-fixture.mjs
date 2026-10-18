// Runs only inside the isolated in-memory PostgreSQL/RLS home harness.
export async function homeTvFixture({q,as,load,check,rejected,media,progress,user,other,foreignUser,provider,scope,foreign,zero}){
 await load('20261016054432_arkhen_private_tv_watch_home.sql');
 await load('20261017014445_arkhen_tv_home_rolling_week.sql');
 await load('20261017020723_arkhen_home_tv_featured_and_four_recent.sql');
 for(const [id,name,adult]of [['general','Geral',false],['tv-restricted','Reservado',true]])await q(
  "insert into public.catalog_categories(provider_key,scope_hash,media_type,category_id,name,is_adult,last_seen_snapshot) values($1,$2,'live',$3,$4,$5,$6) on conflict do nothing",
  [provider,scope,id,name,adult,zero]);
 const channels=[
  ['9001','TV Globo [HD]',30],['9002','GloboNews',0],['9003','Globo News',1],['9004','Globo SP',10],['9005','Globo RJ',20],
  ['9006','Globoplay Novelas',2],['9007','Globo Indisponível',3],['9008','Globo Oculta',4],['9009','Globo Restrita',5],
  ['9101','Canal A HD',100],['9102','Canal B HD',101],['9103','Canal B FHD',102],['9104','Canal C',103],
  ['9105','Canal D',104],['9106','Canal E',105],['9107','Canal A FHD',106],['9108','Canal na borda',107],['9109','Canal vencido',108],
 ];
 for(const [id,name,order]of channels)await media({id,name,kind:'live',isAdult:false,categoryIds:[id==='9009'?'tv-restricted':'general'],
  ...(id==='9007'?{available:false}:{})},{order});
 const ids=channels.map(([id])=>id);
 const read=(id=user,{p=provider,hidden=[],hiddenItems=['9008']}={})=>as('authenticated',id,async()=>(await q(
  'select public.arkhen_home_tv($1,$2,$3,$4,$5) data',[p,scope,ids,hidden,hiddenItems])).rows[0].data);
 const counts=async()=>JSON.stringify((await q(`select
  (select count(*) from public.user_progress) progress,
  (select count(*) from arkhen_private.user_tv_watch_time) watched,
  (select count(*) from arkhen_private.user_tv_watch_sessions) leases,
  (select count(*) from arkhen_private.user_tv_watch_buckets) buckets`)).rows[0]);
 const before=await counts();
 let result=await read(other);
 check(result.featuredId==='9001'&&result.mostWatchedId===null&&result.items.length===1,'A generic Globo outranks regional editorial candidates without any history.');
 check(result.items[0].reason==='default-globo'&&result.items[0].lastWatchedAt===null&&result.items[0].watchedSeconds===0,'Default metadata never claims watch time or recency.');
 check(await counts()===before,'Reading or previewing a default does not write history, leases or watch buckets.');
 result=await read(other,{hiddenItems:['9001','9008']});
 check(result.featuredId==='9004'&&result.items[0].item.name==='Globo SP','Without a generic channel, native order selects Globo SP and preserves its regional name.');
 check(!(result.items.some(row=>['9002','9003','9006','9007','9008','9009'].includes(row.item.id))),'News, Globoplay, unavailable, hidden and category-adult defaults are excluded before selection.');
 result=await read(other,{hiddenItems:['9001','9004','9008']});
 check(result.featuredId==='9005','Hiding the first eligible editorial candidate selects the next actual catalogue channel.');
 result=await read(other,{hidden:['general']});
 check(result.items.length===0&&result.featuredId===null&&result.mostWatchedId===null,'A default cannot bypass hidden categories or invent a channel when none is eligible.');
 await q("update public.catalog_media set is_active=false where provider_key=$1 and media_type='live' and media_id='9001'",[provider]);
 check((await read(other)).featuredId==='9004','An inactive generic channel cannot suppress a live editorial default.');
 await q("update public.catalog_media set is_active=true where provider_key=$1 and media_type='live' and media_id='9001'",[provider]);

 const history=[['9101',10,100],['9102',1,999999999],['9103',2,50],['9104',3,50],['9105',4,50],['9106',5,50],['9107',0.5,50]];
 for(const [id,minutes,lifetime]of history)await q(`insert into arkhen_private.user_tv_watch_time
  (user_id,provider_key,scope_hash,channel_id,watched_milliseconds,last_watched_at)
  values($1,$2,$3,$4,$5,now()-$6*interval '1 minute')`,[user,provider,scope,id,lifetime,minutes]);
 const addSpan=async(id,agoStart,agoEnd)=>q(`with measured as(
  select now()-$5*interval '1 second' starts,now()-$6*interval '1 second' ends
 ), pieces as(
  select h bucket,tstzmultirange(tstzrange(greatest(m.starts,h),least(m.ends,h+interval '1 hour'),'[)')) spans
  from measured m cross join lateral generate_series(
   date_trunc('hour',m.starts at time zone 'UTC') at time zone 'UTC',
   date_trunc('hour',(m.ends-interval '1 microsecond') at time zone 'UTC') at time zone 'UTC',interval '1 hour') h
 ) insert into arkhen_private.user_tv_watch_buckets(user_id,provider_key,scope_hash,bucket_start,channel_id,credited_spans,watched_milliseconds)
 select $1,$2,$3,bucket,$4,spans,arkhen_private.tv_watch_span_milliseconds(spans) from pieces`,[user,provider,scope,id,agoStart,agoEnd]);
 await addSpan('9101',601,1);
 result=await read();
 check(result.featuredId==='9101'&&result.mostWatchedId==='9101'&&result.items[0].reason==='most-watched','Measured seven-day time outranks default and a larger lifetime-only total.');
 check(JSON.stringify(result.items.map(row=>row.item.id))===JSON.stringify(['9101','9102','9104','9105','9106']),'Four recents are ordered, distinct by full channel identity, and exclude another quality of the feature.');
 check(result.items.length===5&&result.items.filter(row=>row.reason==='recent').length===4,'The RPC fills exactly one feature plus four real recent slots when enough history exists.');
 check((await read(other)).mostWatchedId===null,'Another owner never inherits weekly ranking or recent history.');
 check(Math.round((Date.parse(result.windowEnd)-Date.parse(result.windowStart))/1000)===604800,'The measured window remains exactly 168 hours.');
 check(!JSON.stringify(result).includes(user)&&!JSON.stringify(result).includes('user_id'),'The display DTO does not expose owner or raw private records.');
 for(const id of ['9004','9005'])await progress(user,{id,name:channels.find(row=>row[0]===id)[1],kind:'live',categoryIds:['general']},{time:0});
 const regional=(await read()).items.filter(row=>['9004','9005'].includes(row.item.id));
 check(regional.length===2&&regional.every(row=>row.reason==='recent'),'Distinct Globo SP/RJ histories retain separate regional identities; delivery dedupe cannot merge them.');
 result=await read(user,{hiddenItems:['9008','9101']});
 check(result.featuredId==='9001'&&result.items[0].reason==='default-globo','Hiding the measured feature does not bypass filters or invent a new measured champion.');
 const legacy=channels.find(([id])=>id==='9005');
 await progress(other,{id:legacy[0],name:legacy[1],kind:'live',categoryIds:['general']},{time:0});
 check((await read(other)).items.find(row=>row.item.id==='9005')?.reason==='recent','A genuine legacy playing event can supply recency at zero measured time.');

 await q(`insert into arkhen_private.user_tv_watch_time(user_id,provider_key,scope_hash,channel_id,watched_milliseconds,last_watched_at)
  values($1,$2,$3,'9108',999999999,now()),($1,$2,$3,'9109',999999999,now())`,[user,provider,scope]);
 await addSpan('9108',604800+300,604800-300);
 await addSpan('9109',604800+900,604800+600);
 const boundary=(await read()).items.find(row=>row.item.id==='9108');
 check(boundary?.watchedSeconds>=299&&boundary.watchedSeconds<=300,'A span crossing the weekly boundary contributes only its in-window half.');
 check(!(await read()).items.find(row=>row.item.id==='9109')?.watchedSeconds,'Expired buckets cannot contribute even when lifetime time and recency remain.');
 await rejected(()=>read(foreignUser));
 await rejected(()=>read(user,{p:foreign}));
 await rejected(()=>as('anon',null,()=>q('select public.arkhen_home_tv($1,$2,$3,$4,$5)',[provider,scope,ids,[],[]])));
 await rejected(()=>as('authenticated',user,()=>q('select * from arkhen_private.user_tv_watch_buckets')));
 const guards=(await q(`select prosecdef,proconfig,has_function_privilege('anon',oid,'EXECUTE') anon,
  has_function_privilege('authenticated',oid,'EXECUTE') authenticated from pg_proc
  where oid='public.arkhen_home_tv(text,text,text[],text[],text[])'::regprocedure`)).rows[0];
 check(guards.prosecdef===true&&!guards.anon&&guards.authenticated&&guards.proconfig.includes('statement_timeout=3s'),'Projection keeps its existing definer owner checks, authenticated ACL and SQL budget.');
}
