-- Only a changed source/catalog publishes a public revision. Minute progress
-- is a bounded server read; it does not rewrite the entire guide or wake
-- Realtime subscribers when nobody is reading TV.
begin;
set local lock_timeout='3s';
set local statement_timeout='10s';

do $guard$
begin
 if not exists(select 1 from pg_proc where oid=to_regprocedure('public.arkhen_tv_guide(text,text,text[],boolean,text)')
  and not prosecdef and md5(prosrc)='9bc93f608cefcb2238726d7b6c4159ce')
 or not exists(select 1 from pg_proc where oid=to_regprocedure('public.arkhen_tick_tv_guides()')
  and not prosecdef and md5(prosrc)='260bb9e9d2e2ac2e6b30698eb64c7169')
 or not exists(select 1 from pg_proc where oid=to_regprocedure('arkhen_private.refresh_tv_guide(text,text,boolean,text)')
  and not prosecdef and md5(prosrc)='76f885ad6324356c857bff956be75280') then
  raise exception 'TV guide baseline changed; inspect before applying' using errcode='55000';
 end if;
end $guard$;

-- Neutral programme windows can be shared by both PIN visibilities. Every
-- response still joins the current eligible catalogue before exposing a row.
-- A channel row is replaced on revision/boundary/clock reversal only, not on
-- each minute's progress. The PK also bounds reuse across request subsets.
create table arkhen_private.epg_channel_windows(
 provider_key text not null,scope_hash text not null,channel_id text not null,
 time_zone text not null check(time_zone in('America/Maceio','America/Sao_Paulo','UTC')),
 revision uuid not null,as_of timestamptz not null,next_window_change timestamptz,
 previous_program jsonb,current_program jsonb,next_program jsonb,
 current_start timestamptz,current_end timestamptz,next_start timestamptz,
 primary key(provider_key,scope_hash,channel_id,time_zone),
 foreign key(provider_key,scope_hash) references public.epg_cache_versions(provider_key,scope_hash) on delete cascade,
 check(channel_id~'^[0-9]{1,12}$')
);
alter table arkhen_private.epg_channel_windows enable row level security;
revoke all on arkhen_private.epg_channel_windows from public,anon,authenticated;
grant all on arkhen_private.epg_channel_windows to service_role;

create or replace function public.arkhen_tv_guide(
 p_provider_key text,p_scope_hash text,p_channel_ids text[] default null,
 p_include_adult boolean default false,p_time_zone text default 'America/Maceio'
) returns jsonb language plpgsql security invoker set search_path=''
 set statement_timeout='8s' set jit='off' as $$
declare
 registry public.epg_cache_versions;generation uuid;stamp timestamptz;
 channels jsonb;refresh_at timestamptz;
begin
 if p_provider_key is null or p_provider_key!~'^[a-f0-9]{64}$'
  or p_scope_hash is null or p_scope_hash!~'^[a-f0-9]{64}$'
  or p_include_adult is null or p_time_zone is null
  or p_time_zone not in('America/Maceio','America/Sao_Paulo','UTC') then
  raise exception 'Invalid TV guide partition' using errcode='22023';
 end if;
 if p_channel_ids is not null and(cardinality(p_channel_ids)>2000 or array_ndims(p_channel_ids)>1
  or exists(select 1 from unnest(p_channel_ids)id where id is null or id!~'^[0-9]{1,12}$')) then
  raise exception 'Invalid TV guide channel batch' using errcode='22023';
 end if;
 -- The same lock as the publisher keeps header/raw rows on one sealed
 -- revision through both statements below. No provider I/O occurs here.
 perform pg_advisory_xact_lock(hashtextextended('arkhen:epg:'||p_provider_key||':'||p_scope_hash,0));
 stamp:=clock_timestamp();
 select * into registry from public.epg_cache_versions
  where provider_key=p_provider_key and scope_hash=p_scope_hash;
 if not found then return null;end if;
 select generation_id into generation from public.catalog_visible_generations
  where provider_key=p_provider_key and scope_hash=p_scope_hash and media_type='live';

 with eligible as materialized(
  select m.media_id from public.catalog_media m
  where m.provider_key=p_provider_key and m.scope_hash=p_scope_hash and m.media_type='live'
   and m.generation_id=generation and m.is_active and(p_include_adult or not m.is_adult)
   and(p_channel_ids is null or m.media_id=any(p_channel_ids))
 ),due as materialized(
  select e.media_id from eligible e left join arkhen_private.epg_channel_windows w
   on(w.provider_key,w.scope_hash,w.channel_id,w.time_zone)=(p_provider_key,p_scope_hash,e.media_id,p_time_zone)
  where w.channel_id is null or w.revision<>registry.revision or w.as_of>stamp
   or w.next_window_change<=stamp
 ),windows as(
  select e.media_id,w.* from due e cross join lateral(
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
    select min(v.change_at) next_window_change from programs pr
    cross join lateral(values(pr.start_at),(pr.end_at))v(change_at) where v.change_at>stamp
   )b left join previous p on true left join current c on true left join following n on true
  )w
 )insert into arkhen_private.epg_channel_windows(
  provider_key,scope_hash,channel_id,time_zone,revision,as_of,next_window_change,
  previous_program,current_program,next_program,current_start,current_end,next_start)
 select p_provider_key,p_scope_hash,media_id,p_time_zone,registry.revision,stamp,next_window_change,
  previous_program,current_program,next_program,start_at,end_at,next_start from windows
 on conflict(provider_key,scope_hash,channel_id,time_zone)do update set
  revision=excluded.revision,as_of=excluded.as_of,next_window_change=excluded.next_window_change,
  previous_program=excluded.previous_program,current_program=excluded.current_program,next_program=excluded.next_program,
  current_start=excluded.current_start,current_end=excluded.current_end,next_start=excluded.next_start;

 -- Progress is evaluated only for the authorized requested rows. It is never
 -- stored in the public registry or written back to the window cache.
 with projected as(
  select m.media_id,w.next_window_change,
   jsonb_build_object('status',case when w.current_program is not null or w.next_program is not null then 'ready' else 'unavailable' end,
    'list',to_jsonb(array_remove(array[w.previous_program,w.current_program,w.next_program],null)),
    'window',jsonb_build_object('previous',w.previous_program,'current',w.current_program,'next',w.next_program),
    'progressPercent',case when w.current_end is not null then round(greatest(0,least(100,
     100*extract(epoch from(stamp-w.current_start))/extract(epoch from(w.current_end-w.current_start)))),2) end,
    'elapsedSeconds',case when w.current_end is not null then floor(extract(epoch from(stamp-w.current_start))) end,
    'remainingSeconds',case when w.current_end is not null then ceil(extract(epoch from(w.current_end-stamp))) end,
    'nextChangeAt',least(w.current_end,w.next_start))value
  from public.catalog_media m join arkhen_private.epg_channel_windows w
   on(w.provider_key,w.scope_hash,w.channel_id,w.time_zone)=(m.provider_key,m.scope_hash,m.media_id,p_time_zone)
  where m.provider_key=p_provider_key and m.scope_hash=p_scope_hash and m.media_type='live'
   and m.generation_id=generation and m.is_active and(p_include_adult or not m.is_adult)
   and(p_channel_ids is null or m.media_id=any(p_channel_ids)) and w.revision=registry.revision
 )select coalesce(jsonb_object_agg(media_id,value order by media_id),'{}'),
  least(date_trunc('minute',stamp)+interval '1 minute',min(next_window_change)filter(where next_window_change>stamp),
   case when registry.snapshot_expires_at>stamp then registry.snapshot_expires_at end)
 into channels,refresh_at from projected;
 return jsonb_build_object('schemaVersion',1,'revision',registry.revision,
  'projectionVersion',registry.revision::text||':'||extract(epoch from stamp)::text,
  'asOf',stamp,'serverTime',stamp,'timeZone',p_time_zone,'nextRefreshAt',refresh_at,
  'sourceNextRefreshAt',registry.source_next_refresh_at,'snapshotFetchedAt',registry.snapshot_fetched_at,
  'snapshotExpiresAt',registry.snapshot_expires_at,'horizonEnd',registry.horizon_end,
  'stale',registry.snapshot_expires_at<=stamp or coalesce(registry.horizon_end<=stamp,true),
  'legacySnapshot',registry.is_legacy,'channels',channels);
end $$;

-- Old trusted callers retain their full-map contract; neither entry point
-- mutates epg_cache_versions. Source publication remains untouched/atomic.
create or replace function arkhen_private.refresh_tv_guide(
 p_provider_key text,p_scope_hash text,p_include_adult boolean,p_time_zone text
)returns jsonb language sql security invoker set search_path='' set jit='off' as $$
 select public.arkhen_tv_guide(p_provider_key,p_scope_hash,null,p_include_adult,p_time_zone)
$$;
create or replace function public.arkhen_tick_tv_guides()
returns integer language sql security invoker set search_path='' as $$ select 0 $$;
revoke all on function public.arkhen_tv_guide(text,text,text[],boolean,text),
 arkhen_private.refresh_tv_guide(text,text,boolean,text),public.arkhen_tick_tv_guides() from public,anon,authenticated;
grant execute on function public.arkhen_tv_guide(text,text,text[],boolean,text),
 arkhen_private.refresh_tv_guide(text,text,boolean,text),public.arkhen_tick_tv_guides() to service_role;
do $cron$
declare job record;
begin
 if to_regclass('cron.job')is not null then
  for job in select jobid from cron.job where jobname='arkhen-tv-guide-clock'
   and schedule='* * * * *' and command in('select public.arkhen_tick_tv_guides();',
    'set statement_timeout=''20s''; select public.arkhen_tick_tv_guides();') loop
   perform cron.alter_job(job.jobid,active:=false);
  end loop;
 end if;
end $cron$;
commit;
