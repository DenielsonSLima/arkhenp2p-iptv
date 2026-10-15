-- The measured authenticated 97,370-row JSON aggregation took 9,488 ms.
-- Compute it once globally, outside settings requests, without relaxing RLS.
begin;
set local lock_timeout='5s';
set local statement_timeout='55s';
alter table public.marker_sync_registry add column coverage_refreshed_at timestamptz;
create table public.marker_series_sync_metrics (
  imdb_id text primary key check(imdb_id~'^tt[0-9]{6,10}$'),
  episodes bigint not null check(episodes>=0),
  with_markers bigint not null check(with_markers between 0 and episodes),
  intro_episodes bigint not null check(intro_episodes between 0 and episodes),
  recap_episodes bigint not null check(recap_episodes between 0 and episodes),
  credits_episodes bigint not null check(credits_episodes between 0 and episodes),
  editions bigint not null check(editions>=0),
  unverified_episodes bigint not null check(unverified_episodes between 0 and episodes),
  refreshed_at timestamptz not null
);
alter table public.marker_series_sync_metrics enable row level security;
revoke all on public.marker_series_sync_metrics from public,anon,authenticated;
grant select on public.marker_series_sync_metrics to authenticated;
grant all on public.marker_series_sync_metrics to service_role;
create policy arkhen_marker_series_metrics_read on public.marker_series_sync_metrics for select to authenticated
  using(exists(select 1 from public.profiles p where p.id=(select auth.uid()) and public.arkhen_profile_allows(p.provider)));

create function public.arkhen_refresh_marker_sync_metrics()
returns boolean language plpgsql security invoker set search_path='' set statement_timeout='45s' as $$
declare refreshed timestamptz:=clock_timestamp();
begin
  if not pg_try_advisory_xact_lock(hashtext('arkhen-marker-sync-metrics')) then return false;end if;
  with references_by_episode as (
    select imdb_id,season,episode,bool_or(has_intro) as has_intro,bool_or(has_recap) as has_recap,bool_or(has_credits) as has_credits,
      bool_or(unverified) as unverified,sum(editions) as editions
    from (
      select imdb_id,season,episode,markers ? 'openingEnd' as has_intro,markers ? 'recapEnd' as has_recap,markers ? 'creditsStart' as has_credits,
        verification<>'verified' as unverified,1 as editions from public.episode_skip_markers where is_active and imdb_id ~ '^tt[0-9]{6,10}$'
      union all
      select imdb_id,season,episode,
        jsonb_typeof(evidence#>'{skipdb,intro}')='object' or jsonb_typeof(evidence#>'{introdb,intro}')='object',
        jsonb_typeof(evidence#>'{skipdb,recap}')='object' or jsonb_typeof(evidence#>'{introdb,recap}')='object',
        jsonb_typeof(evidence#>'{skipdb,outro}')='object' or jsonb_typeof(evidence#>'{introdb,outro}')='object',
        status='unverified',0 from public.series_marker_coverage
    ) source group by imdb_id,season,episode
  )
  insert into public.marker_series_sync_metrics(imdb_id,episodes,with_markers,intro_episodes,recap_episodes,credits_episodes,editions,unverified_episodes,refreshed_at)
  select imdb_id,count(*),count(*) filter(where has_intro or has_recap or has_credits),count(*) filter(where has_intro),count(*) filter(where has_recap),
    count(*) filter(where has_credits),coalesce(sum(editions),0),count(*) filter(where unverified),refreshed
  from references_by_episode group by imdb_id
  on conflict(imdb_id) do update set episodes=excluded.episodes,with_markers=excluded.with_markers,intro_episodes=excluded.intro_episodes,
    recap_episodes=excluded.recap_episodes,credits_episodes=excluded.credits_episodes,editions=excluded.editions,
    unverified_episodes=excluded.unverified_episodes,refreshed_at=excluded.refreshed_at;
  delete from public.marker_series_sync_metrics where refreshed_at<>refreshed;
  update public.marker_sync_registry set coverage_refreshed_at=refreshed where name='global';
  return true;
end $$;
revoke all on function public.arkhen_refresh_marker_sync_metrics() from public,anon,authenticated;
grant execute on function public.arkhen_refresh_marker_sync_metrics() to service_role;

create or replace function public.arkhen_marker_sync_status(p_provider_key text,p_scope_hash text)
returns jsonb language plpgsql stable security invoker set search_path='' set statement_timeout='10s' as $$
declare state public.marker_sync_registry;global_counts jsonb;catalog_counts jsonb;recent jsonb;issues jsonb;identified jsonb;providers jsonb;
begin
  if not public.arkhen_partition_allows(p_provider_key,p_scope_hash) then raise exception 'Marker synchronization access denied' using errcode='42501';end if;
  select * into state from public.marker_sync_registry where name='global';
  with catalog as materialized (
    select m.media_id,m.name,i.imdb_id,i.status,i.error_code,i.updated_at
    from public.catalog_media m join public.catalog_visible_generations g using(provider_key,scope_hash,media_type,generation_id)
    left join public.series_marker_identities i on i.provider_key=m.provider_key and i.scope_hash=m.scope_hash and i.media_id=m.media_id
    where m.provider_key=p_provider_key and m.scope_hash=p_scope_hash and m.media_type='series' and m.is_active and not m.is_adult
  ), mapped as materialized(select distinct imdb_id from catalog where status='resolved' and imdb_id is not null),
  coverage as materialized(select r.* from public.marker_series_sync_metrics r join mapped using(imdb_id))
  select
    (select jsonb_build_object('episodes',sum(episodes),'series',count(*),'introEpisodes',sum(intro_episodes),'recapEpisodes',sum(recap_episodes),
      'creditsEpisodes',sum(credits_episodes),'editions',sum(editions),'unverifiedEpisodes',sum(unverified_episodes)) from public.marker_series_sync_metrics),
    (select jsonb_build_object('series',count(*),'identifiedSeries',count(*) filter(where status='resolved'),
      'pendingSeries',count(*) filter(where status is null or status='pending'),
      'unresolvedSeries',count(*) filter(where status in('unresolved','ambiguous')),'failedSeries',count(*) filter(where status='failed'),
      'episodes',(select coalesce(sum(episodes),0) from coverage),'withMarkers',(select coalesce(sum(with_markers),0) from coverage),
      'introEpisodes',(select coalesce(sum(intro_episodes),0) from coverage)) from catalog),
    (select coalesce(jsonb_agg(jsonb_build_object('title',left(name,180),'status',status,'reasonCode',case when error_code~'^[A-Z][A-Z0-9_]{0,79}$' then error_code end,'updatedAt',updated_at) order by updated_at desc,name),'[]')
      from (select * from catalog where status in('unresolved','ambiguous','failed') order by updated_at desc,name limit 20) limited),
    (select coalesce(jsonb_agg(jsonb_build_object('title',left(name,180),'imdbId',imdb_id,'updatedAt',updated_at,
      'episodes',case when state.coverage_refreshed_at is not null then coalesce(episodes,0) end,
      'withMarkers',case when state.coverage_refreshed_at is not null then coalesce(with_markers,0) end) order by updated_at desc,name),'[]')
      from(select c.*,cc.episodes,cc.with_markers from catalog c left join coverage cc using(imdb_id)
        where c.status='resolved' order by c.updated_at desc,c.name limit 20) limited)
  into global_counts,catalog_counts,issues,identified;
  if state.coverage_refreshed_at is null then
    select jsonb_object_agg(key,null::integer) into global_counts from jsonb_object_keys(global_counts) as key;
    catalog_counts:=catalog_counts||jsonb_build_object('episodes',null,'withMarkers',null,'introEpisodes',null);
  else
    select jsonb_object_agg(key,coalesce(nullif(value,'null'::jsonb),'0'::jsonb)) into global_counts from jsonb_each(global_counts);
  end if;
  global_counts:=global_counts||jsonb_build_object('updatedAt',state.coverage_refreshed_at);
  catalog_counts:=catalog_counts||jsonb_build_object('updatedAt',state.coverage_refreshed_at);
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'occurredAt',finished_at,'startedAt',started_at,'status',status,'errorCode',error_code)||counters order by finished_at desc),'[]')
    into recent from(select * from public.marker_sync_runs order by finished_at desc limit 20) limited;
  select jsonb_agg(jsonb_build_object('id',source,'label',case when source='skipdb' then 'SkipDB' else 'IntroDB' end,'priority',priority,
    'configured',state.providers#>array[source,'configured'],'lastCheckedAt',state.providers#>array[source,'lastCheckedAt'],
    'lastSuccessAt',state.providers#>array[source,'lastSuccessAt'],'errorCode',state.providers#>array[source,'errorCode'],
    'retryAt',cooldown,'status',case when cooldown>now() then 'cooldown' when state.providers#>>array[source,'errorCode'] is not null then 'failed'
      when state.providers#>>array[source,'lastSuccessAt'] is not null then 'ready' else 'unknown' end) order by priority)
    into providers from(values('skipdb',1,state.skipdb_cooldown_until),('introdb',2,state.introdb_cooldown_until)) sources(source,priority,cooldown);
  return jsonb_build_object('schemaVersion',1,'generatedAt',now(),'status',case when state.running_until>now() then 'running'
    when state.last_started_at is not null and (state.last_finished_at is null or state.last_finished_at<state.last_started_at) then 'partial' else coalesce(state.last_status,'idle') end,
    'lastStartedAt',state.last_started_at,'lastFinishedAt',state.last_finished_at,'lastSourceCompletedAt',state.last_source_completed_at,
    'providers',providers,'global',global_counts,'catalog',catalog_counts,'recent',recent,'recentLimit',20,'issues',issues,'identified',identified);
end $$;
revoke all on function public.arkhen_marker_sync_status(text,text) from public,anon;
grant execute on function public.arkhen_marker_sync_status(text,text) to authenticated;
do $cron$begin if to_regprocedure('cron.schedule(text,text,text)') is not null then
  perform cron.schedule('arkhen-marker-sync-metrics','*/5 * * * *','select public.arkhen_refresh_marker_sync_metrics();');
end if;end $cron$;
notify pgrst,'reload schema';
commit;
