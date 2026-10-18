-- The measured minute tick expanded every programme for both visibilities.
-- Preserve shared precomputation and server-calculated progress, but expand a
-- channel's full source list only when its selected programme window changes.
-- Snapshot/catalog changes still rebuild every eligible channel atomically.
begin;
set local lock_timeout='3s';
set local statement_timeout='10s';

do $guard$
begin
 if not exists(select 1 from pg_proc p
  where p.oid=to_regprocedure('arkhen_private.refresh_tv_guide(text,text,boolean,text)')
   and not p.prosecdef and md5(p.prosrc)='d1824a389b4a1c20ba1a430a8cbff21d') then
  raise exception 'TV guide baseline changed; review the current definition first' using errcode='55000';
 end if;
end $guard$;

-- Nullable metadata avoids rewriting existing payloads. A missing map makes
-- the next ordinary projection rebuild its windows once; no rebuild runs here.
alter table arkhen_private.epg_projection_cache add column window_boundaries jsonb
 check(window_boundaries is null or jsonb_typeof(window_boundaries)='object');

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
 ),programs as materialized(
  select c.channel_id,p.title,p.description,p."start" start_at,p."end" end_at
  from due e join public.provider_epg_cache c
   on(c.provider_key,c.scope_hash,c.channel_id)=(p_provider_key,p_scope_hash,e.media_id)
  cross join lateral jsonb_to_recordset(c.payload->'list')
   as p(title text,description text,"start" timestamptz,"end" timestamptz)
  where p.title<>'' and p."end">p."start"
 ),next_boundaries as materialized(
  -- All valid start/end boundaries preserve exact previous/current/next
  -- selection even when programmes overlap or a channel has a schedule gap.
  select p.channel_id,min(b.change_at) next_window_change from programs p
  cross join lateral(values(p.start_at),(p.end_at)) b(change_at)
  where b.change_at>stamp group by p.channel_id
 ),previous as(
  select distinct on(channel_id) channel_id,title,description,start_at,end_at
  from programs where end_at<=stamp order by channel_id,end_at desc,start_at desc,title
 ),current as(
  select distinct on(channel_id) channel_id,title,description,start_at,end_at
  from programs where start_at<=stamp and end_at>stamp order by channel_id,start_at desc,end_at,title
 ),following as(
  select distinct on(channel_id) channel_id,title,description,start_at,end_at
  from programs where start_at>stamp order by channel_id,start_at,end_at,title
 ),windows as(
  select e.media_id,c.start_at,c.end_at,n.start_at next_start,b.next_window_change,
   case when p.channel_id is not null then arkhen_private.epg_program_json(p.title,p.description,p.start_at,p.end_at,p_time_zone) end previous_program,
   case when c.channel_id is not null then arkhen_private.epg_program_json(c.title,c.description,c.start_at,c.end_at,p_time_zone) end current_program,
   case when n.channel_id is not null then arkhen_private.epg_program_json(n.title,n.description,n.start_at,n.end_at,p_time_zone) end next_program
  from due e left join previous p on p.channel_id=e.media_id
   left join current c on c.channel_id=e.media_id left join following n on n.channel_id=e.media_id
   left join next_boundaries b on b.channel_id=e.media_id
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
revoke all on function arkhen_private.refresh_tv_guide(text,text,boolean,text) from public,anon,authenticated;
grant execute on function arkhen_private.refresh_tv_guide(text,text,boolean,text) to service_role;
commit;
