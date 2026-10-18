// In-memory PostgreSQL only: independent TV and VOD failure domains.
export async function homeDomainIsolationFixture({q,as,load,check,rejected,media,progress,user,other,foreignUser,provider,scope,foreign,zero,candidate}){
 await load('20261016050044_arkhen_home_library_compact_candidates.sql');
 await load('20261016053123_arkhen_home_library_published_signal_fields.sql');
 await load('20261017161601_arkhen_home_vod_isolated.sql');
 await load('20261017161618_arkhen_home_tv_catalog_authority.sql');
 for(const type of ['movies','series'])await as('service_role',null,()=>q('select public.arkhen_prepare_catalog_read_model($1,$2,$3)',[provider,scope,type]));
 const vod=(id=user,{p=provider,hidden={},hiddenItems={},adult=false}={})=>as('authenticated',id,async()=>(await q(
  'select public.arkhen_home_vod($1,$2,$3,$4,$5) data',[p,scope,adult,hidden,hiddenItems])).rows[0].data);
 const tv=(id=user,{p=provider,hidden=[],hiddenItems=[]}={})=>as('authenticated',id,async()=>(await q(
  'select public.arkhen_home_tv_catalog($1,$2,$3,$4) data',[p,scope,hidden,hiddenItems])).rows[0].data);
 const legacy=await as('authenticated',user,async()=>(await q('select public.arkhen_home_library($1,$2) data',[provider,scope])).rows[0].data);
 const original=await vod();
 check(original!==null&&original.recommendations.items.length>0,'Prepared VOD returns real candidates, not a fabricated empty success.');
 check(JSON.stringify(original.recommendations)===JSON.stringify(legacy.recommendations),'VOD isolation preserves the current bounded ranking and order.');
 check(JSON.stringify(original.history.movie)===JSON.stringify(legacy.history.movie)&&JSON.stringify(original.history.series)===JSON.stringify(legacy.history.series),'Movie and series history are unchanged by domain separation.');
 check(original.counts.movie===legacy.counts.movie&&original.counts.series===legacy.counts.series,'VOD favorite counts remain exact.');
 check(original.counts.live===0&&original.history.live.length===0&&original.favoriteChannels.length===0&&!('live' in original.revisions),'Legacy TV DTO slots are empty and no live revision is claimed.');
 await q("update public.catalog_media set home_identity=null where provider_key=$1 and scope_hash=$2 and media_type='live'",[provider,scope]);
 const brokenLegacy=await as('authenticated',user,async()=>(await q('select public.arkhen_home_library($1,$2) data',[provider,scope])).rows[0].data);
 check(brokenLegacy===null,'Fixture reproduces the old coupling: unfinished live preparation makes the entire legacy Home unavailable.');
 check(JSON.stringify((await vod()).recommendations)===JSON.stringify(original.recommendations),'Unprepared TV cannot erase VOD recommendations.');
 const tvWithUnpreparedIdentity=await tv();
 check(tvWithUnpreparedIdentity.items.length>0,'TV does not depend on VOD home-title identity preparation.');
 await q("update public.catalog_visible_generations set generation_id=$1 where provider_key=$2 and scope_hash=$3 and media_type='live'",[candidate,provider,scope]);
 check(JSON.stringify((await vod()).history.movie)===JSON.stringify(original.history.movie),'An unpublished live generation cannot block movie history.');
 await q("update public.catalog_visible_generations set generation_id=$1 where provider_key=$2 and scope_hash=$3 and media_type='live'",[zero,provider,scope]);
 const beforeRevision=(await vod()).revisionLibrary;
 await progress(user,{id:'9106',kind:'live',name:'Live update',categoryId:'general'});
 check((await vod()).revisionLibrary===beforeRevision,'Live progress cannot advance the private VOD revision.');
 await q("update public.catalog_visible_generations set generation_id=$1 where provider_key=$2 and scope_hash=$3 and media_type='movies'",[candidate,provider,scope]);
 check(await vod()===null,'An unprepared VOD generation remains explicit unavailability.');
 check((await tv()).items.length>0,'An unprepared movie generation cannot block TV cards.');
 await q("update public.catalog_visible_generations set generation_id=$1 where provider_key=$2 and scope_hash=$3 and media_type='movies'",[zero,provider,scope]);
 const fresh=await tv(other);
 check(fresh.featuredId==='9001','Database-derived TV IDs preserve the generic Globo default.');
 check(!(await tv(other,{hiddenItems:['9001','9004','9008']})).items.some(row=>['9001','9004','9007','9008','9009'].includes(row.item.id)),'TV filters and trusted availability/adult categories still apply to database-derived IDs.');
 check((await tv(other,{hidden:['general']})).items.length===0,'Database authority cannot bypass hidden categories.');
 await media({id:'9991',kind:'live',name:'Globo Foreign',categoryIds:['general']},{p:foreign,order:-10});
 await media({id:'9992',kind:'live',name:'Globo Unpublished',categoryIds:['general']},{generation:candidate,order:-11});
 check(!(await tv(other)).items.some(row=>['9991','9992'].includes(row.item.id)),'TV derives IDs only from the authorized current partition.');
 check((await vod(other)).history.movie.length===0,'Other account retains its own empty movie history.');
 for(const read of [vod,tv]){await rejected(()=>read(foreignUser));await rejected(()=>read(user,{p:foreign}));}
 await rejected(()=>as('anon',null,()=>q('select public.arkhen_home_vod($1,$2)',[provider,scope])));
 await rejected(()=>as('anon',null,()=>q('select public.arkhen_home_tv_catalog($1,$2)',[provider,scope])));
 await rejected(()=>tv(user,{hidden:['bad/id']}),'22023');
 await rejected(()=>tv(user,{hiddenItems:null}),'22023');
 await rejected(()=>vod(user,{hiddenItems:{movies:'not-an-array'}}),'22023');
 const guards=(await q("select proname,prosecdef,proconfig,has_function_privilege('anon',oid,'EXECUTE') anon from pg_proc where proname in('arkhen_home_vod','arkhen_home_tv_catalog')")).rows;
 check(guards.length===2&&guards.every(row=>!row.prosecdef&&!row.anon&&row.proconfig.includes('search_path=\"\"')),'New entry points keep SECURITY INVOKER, empty search path and authenticated-only grants.');
 check(guards.find(row=>row.proname==='arkhen_home_vod').proconfig.includes('statement_timeout=8s')&&guards.find(row=>row.proname==='arkhen_home_tv_catalog').proconfig.includes('statement_timeout=3s'),'Neither new function raises the original SQL time budget.');
}
