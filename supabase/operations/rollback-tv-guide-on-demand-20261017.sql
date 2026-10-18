-- Manual rollback only; never sent by the implementation agent.
-- Restores the exact bodies confirmed remotely before this migration.
begin;
set local lock_timeout='3s';
set local statement_timeout='10s';
do $guard$begin
 if not exists(select 1 from pg_proc where oid=to_regprocedure('public.arkhen_tv_guide(text,text,text[],boolean,text)') and not prosecdef and md5(prosrc)='d4bb56ed00c68ed5f0ab6ccd718987c7') then raise exception 'TV on-demand definition changed; inspect rollback first' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid=to_regprocedure('arkhen_private.refresh_tv_guide(text,text,boolean,text)') and not prosecdef and md5(prosrc)='bd0b16947f17fa530b795cbc9ca1862f') then raise exception 'TV on-demand definition changed; inspect rollback first' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid=to_regprocedure('public.arkhen_tick_tv_guides()') and not prosecdef and md5(prosrc)='14939ecb98c466af2fb01426295f6482') then raise exception 'TV on-demand definition changed; inspect rollback first' using errcode='55000';end if;
end $guard$;
create or replace function public.arkhen_tv_guide(p_provider_key text,p_scope_hash text,p_channel_ids text[] default null,p_include_adult boolean default false,p_time_zone text default 'America/Maceio')
returns jsonb language plpgsql security invoker set search_path='' set statement_timeout='8s' as $$
declare result jsonb;channels jsonb;
begin
 if p_channel_ids is not null and(cardinality(p_channel_ids)>2000 or array_ndims(p_channel_ids)>1 or exists(select 1 from unnest(p_channel_ids)id where id is null or id!~'^[0-9]{1,12}$')) then raise exception 'Invalid TV guide channel batch' using errcode='22023';end if;
 result:=arkhen_private.refresh_tv_guide(p_provider_key,p_scope_hash,p_include_adult,p_time_zone);
 if result is not null then result:=jsonb_set(result,'{serverTime}',to_jsonb(clock_timestamp()));end if;
 if result is null or p_channel_ids is null then return result;end if;
 select coalesce(jsonb_object_agg(key,value),'{}') into channels from jsonb_each(result->'channels') where key=any(p_channel_ids);
 return jsonb_set(result,'{channels}',channels);
end $$;
create or replace function arkhen_private.refresh_tv_guide(
 p_provider_key text,p_scope_hash text,p_include_adult boolean,p_time_zone text
) returns jsonb language plpgsql security invoker set search_path=''
 set statement_timeout='8s' set jit='off' as $$
declare
 registry public.epg_cache_versions;cached arkhen_private.epg_projection_cache;
 generation uuid;stamp timestamptz;refresh_at timestamptz;channels jsonb;boundaries jsonb;result jsonb;
 reuse_windows boolean:=false;
begin
 if p_provider_key is null or p_provider_key!~'^[a-f0-9]{64}$'
  or p_scope_hash is null or p_scope_hash!~'^[a-f0-9]{64}$'
  or p_include_adult is null or p_time_zone is null
  or p_time_zone not in('America/Maceio','America/Sao_Paulo','UTC') then
  raise exception 'Invalid TV guide partition' using errcode='22023';
 end if;
 perform pg_advisory_xact_lock(hashtextextended('arkhen:epg:'||p_provider_key||':'||p_scope_hash,0));
 stamp:=clock_timestamp();
 select * into registry from public.epg_cache_versions
  where provider_key=p_provider_key and scope_hash=p_scope_hash;
 if not found then return null;end if;
 select generation_id into generation from public.catalog_visible_generations
  where provider_key=p_provider_key and scope_hash=p_scope_hash and media_type='live';
 if registry.next_refresh_at<=stamp then
  update public.epg_cache_versions set
   projection_version=revision::text||':'||extract(epoch from stamp)::text,
   as_of=stamp,next_refresh_at=date_trunc('minute',stamp)+interval '1 minute',updated_at=stamp
  where provider_key=p_provider_key and scope_hash=p_scope_hash returning * into registry;
 end if;
 select * into cached from arkhen_private.epg_projection_cache
  where provider_key=p_provider_key and scope_hash=p_scope_hash
   and include_adult=p_include_adult and time_zone=p_time_zone;
 if found and cached.revision=registry.revision
  and cached.catalog_generation is not distinct from generation
  and cached.projection_version=registry.projection_version and cached.as_of<=stamp and cached.next_refresh_at>stamp then
  return jsonb_set(cached.payload,'{serverTime}',to_jsonb(clock_timestamp()));
 end if;
 reuse_windows:=found and cached.revision=registry.revision
  and cached.catalog_generation is not distinct from generation and cached.as_of<=stamp
  and cached.payload->>'schemaVersion'='1' and jsonb_typeof(cached.payload->'channels')='object'
  and jsonb_typeof(cached.window_boundaries)='object';
 with eligible as materialized(
  select m.media_id from public.catalog_media m
  where m.provider_key=p_provider_key and m.scope_hash=p_scope_hash and m.media_type='live'
   and m.generation_id=generation and m.is_active and(p_include_adult or not m.is_adult)
 ),cached_channels as materialized(
  -- Expand each cached map once. Per-channel lookups into the entire toasted
  -- payload would otherwise repeatedly decompress that large JSON value.
  select e.media_id,c.value,b.change_at::timestamptz next_window_change,
   b.channel_id is not null boundary_known
  from jsonb_each(case when reuse_windows then cached.payload->'channels' else '{}'::jsonb end) c
  join eligible e on e.media_id=c.key
  left join jsonb_each_text(case when reuse_windows then cached.window_boundaries else '{}'::jsonb end)
   b(channel_id,change_at) on b.channel_id=e.media_id
 ),kept as materialized(
  select media_id,value,next_window_change from cached_channels
  where jsonb_typeof(value)='object' and jsonb_typeof(value->'window')='object'
   and boundary_known
   and(next_window_change>stamp or next_window_change is null)
 ),due as materialized(
  select e.media_id from eligible e where not exists(select 1 from kept k where k.media_id=e.media_id)
 ),windows as(
  select e.media_id,w.start_at,w.end_at,w.next_start,w.next_window_change,
   w.previous_program,w.current_program,w.next_program
  from due e cross join lateral(
   -- Materialization is local to this one primary-key channel lookup. Three
   -- small top-one sorts replace three sorts of the complete due programme set.
   with programs as materialized(
    select c.channel_id,p.title,p.description,p."start" start_at,p."end" end_at
    from public.provider_epg_cache c
    cross join lateral jsonb_to_recordset(c.payload->'list')
     as p(title text,description text,"start" timestamptz,"end" timestamptz)
    where(c.provider_key,c.scope_hash,c.channel_id)=(p_provider_key,p_scope_hash,e.media_id)
     and p.title<>'' and p."end">p."start"
   ),previous as materialized(
    select * from programs where end_at<=stamp order by end_at desc,start_at desc,title limit 1
   ),current as materialized(
    select * from programs where start_at<=stamp and end_at>stamp order by start_at desc,end_at,title limit 1
   ),following as materialized(
    select * from programs where start_at>stamp order by start_at,end_at,title limit 1
   )select c.start_at,c.end_at,n.start_at next_start,b.next_window_change,
    case when p.channel_id is not null then arkhen_private.epg_program_json(p.title,p.description,p.start_at,p.end_at,p_time_zone) end previous_program,
    case when c.channel_id is not null then arkhen_private.epg_program_json(c.title,c.description,c.start_at,c.end_at,p_time_zone) end current_program,
    case when n.channel_id is not null then arkhen_private.epg_program_json(n.title,n.description,n.start_at,n.end_at,p_time_zone) end next_program
   from(
    -- Aggregate always supplies one row, even for missing/empty channel lists.
    -- Every valid future start/end boundary retains gap/overlap behavior.
    select min(v.change_at) next_window_change from programs pr
    cross join lateral(values(pr.start_at),(pr.end_at)) v(change_at)
    where v.change_at>stamp
   ) b left join previous p on true left join current c on true left join following n on true
  ) w
  union all
  select k.media_id,(k.value#>>'{window,current,start}')::timestamptz,
   (k.value#>>'{window,current,end}')::timestamptz,(k.value#>>'{window,next,start}')::timestamptz,
   k.next_window_change,
   nullif(k.value#>'{window,previous}','null'::jsonb),nullif(k.value#>'{window,current}','null'::jsonb),
   nullif(k.value#>'{window,next}','null'::jsonb) from kept k
 ),projected as(
  select media_id,least(end_at,next_start) next_change,next_window_change,
   jsonb_build_object('status',case when current_program is not null or next_program is not null then 'ready' else 'unavailable' end,
    'list',to_jsonb(array_remove(array[previous_program,current_program,next_program],null)),
    'window',jsonb_build_object('previous',previous_program,'current',current_program,'next',next_program),
    'progressPercent',case when end_at is not null then round(greatest(0,least(100,100*extract(epoch from(stamp-start_at))/extract(epoch from(end_at-start_at)))),2) end,
    'elapsedSeconds',case when end_at is not null then floor(extract(epoch from(stamp-start_at))) end,
    'remainingSeconds',case when end_at is not null then ceil(extract(epoch from(end_at-stamp))) end,
    'nextChangeAt',least(end_at,next_start)) value from windows
 )select coalesce(jsonb_object_agg(media_id,value order by media_id),'{}'),
  least(date_trunc('minute',stamp)+interval '1 minute',min(next_change) filter(where next_change>stamp),
   case when registry.snapshot_expires_at>stamp then registry.snapshot_expires_at end),
  coalesce(jsonb_object_agg(media_id,to_jsonb(next_window_change)),'{}')
 into channels,refresh_at,boundaries from projected;
 result:=jsonb_build_object('schemaVersion',1,'revision',registry.revision,
  'projectionVersion',registry.projection_version,'asOf',stamp,'serverTime',stamp,'timeZone',p_time_zone,
  'nextRefreshAt',refresh_at,'sourceNextRefreshAt',registry.source_next_refresh_at,
  'snapshotFetchedAt',registry.snapshot_fetched_at,'snapshotExpiresAt',registry.snapshot_expires_at,
  'horizonEnd',registry.horizon_end,'stale',registry.snapshot_expires_at<=stamp or coalesce(registry.horizon_end<=stamp,true),
  'legacySnapshot',registry.is_legacy,'channels',channels);
 insert into arkhen_private.epg_projection_cache(
  provider_key,scope_hash,include_adult,time_zone,revision,catalog_generation,projection_version,as_of,next_refresh_at,payload,window_boundaries)
 values(p_provider_key,p_scope_hash,p_include_adult,p_time_zone,registry.revision,generation,registry.projection_version,stamp,refresh_at,result,boundaries)
 on conflict(provider_key,scope_hash,include_adult,time_zone) do update set
  revision=excluded.revision,catalog_generation=excluded.catalog_generation,
  projection_version=excluded.projection_version,as_of=excluded.as_of,next_refresh_at=excluded.next_refresh_at,
  payload=excluded.payload,window_boundaries=excluded.window_boundaries;
 update public.epg_cache_versions set next_refresh_at=least(next_refresh_at,refresh_at)
  where provider_key=p_provider_key and scope_hash=p_scope_hash and next_refresh_at>refresh_at;
 return result;
end $$;
create or replace function public.arkhen_tick_tv_guides()
returns integer language plpgsql security invoker set search_path='' set statement_timeout='20s' as $$
declare registry record;total integer:=0;
begin
 for registry in select provider_key,scope_hash from public.epg_cache_versions where next_refresh_at<=clock_timestamp() order by next_refresh_at limit 8 loop
  perform arkhen_private.refresh_tv_guide(registry.provider_key,registry.scope_hash,false,'America/Maceio');
  perform arkhen_private.refresh_tv_guide(registry.provider_key,registry.scope_hash,true,'America/Maceio');
  total:=total+1;
 end loop;
 return total;
end $$;
drop table arkhen_private.epg_channel_windows;
do $cron$
declare job record;
begin
 if to_regclass('cron.job')is not null then
  for job in select jobid from cron.job where jobname='arkhen-tv-guide-clock'
   and schedule='* * * * *' and command in('select public.arkhen_tick_tv_guides();',
    'set statement_timeout=''20s''; select public.arkhen_tick_tv_guides();') loop
   perform cron.alter_job(job.jobid,active:=true);
  end loop;
 end if;
end $cron$;
commit;
