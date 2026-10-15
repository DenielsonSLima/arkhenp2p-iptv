begin;
set local lock_timeout='5s';
set local statement_timeout='55s';

-- Public operational projections contain only timestamps, bounded counters and
-- provider codes. The worker's leases, raw result and secrets remain private.
create table public.marker_sync_registry (
  name text primary key check(name='global'),
  running_until timestamptz,
  last_started_at timestamptz,
  last_finished_at timestamptz,
  last_source_completed_at timestamptz,
  last_status text not null default 'idle' check(last_status in('idle','ready','partial','failed')),
  skipdb_cooldown_until timestamptz,
  introdb_cooldown_until timestamptz,
  providers jsonb not null default '{}' check(octet_length(providers::text)<4096)
);
create table public.marker_sync_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null unique,
  finished_at timestamptz not null,
  status text not null check(status in('ready','partial','failed')),
  counters jsonb not null check(octet_length(counters::text)<2048),
  error_code text check(error_code is null or error_code ~ '^[A-Z][A-Z0-9_]{0,79}$')
);
create index arkhen_marker_sync_runs_recent on public.marker_sync_runs(finished_at desc,id);
alter table public.marker_sync_registry enable row level security;
alter table public.marker_sync_runs enable row level security;
revoke all on public.marker_sync_registry,public.marker_sync_runs from public,anon,authenticated;
grant all on public.marker_sync_registry,public.marker_sync_runs to service_role;
grant select on public.marker_sync_registry,public.marker_sync_runs to authenticated;
create policy arkhen_marker_sync_registry_read on public.marker_sync_registry for select to authenticated
  using(exists(select 1 from public.profiles p where p.id=(select auth.uid()) and public.arkhen_profile_allows(p.provider)));
create policy arkhen_marker_sync_runs_read on public.marker_sync_runs for select to authenticated
  using(exists(select 1 from public.profiles p where p.id=(select auth.uid()) and public.arkhen_profile_allows(p.provider)));

create or replace function arkhen_private.marker_sync_project()
returns trigger language plpgsql security invoker set search_path='' as $$
declare result jsonb:=coalesce(new.last_result,'{}');health jsonb:='{}';counters jsonb:='{}';
declare source text;field text;value jsonb;provider jsonb;last_status text;error_code text;
begin
  if new.name<>'global' then return new;end if;
  if tg_op='UPDATE' and new.last_started_at is distinct from old.last_started_at and old.last_started_at is not null
    and (old.last_finished_at is null or old.last_finished_at<old.last_started_at) and old.lease_until<=now() then
    insert into public.marker_sync_runs(started_at,finished_at,status,counters,error_code)
      values(old.last_started_at,coalesce(old.lease_until,now()),'failed','{}','MARKER_RUN_INTERRUPTED') on conflict(started_at) do nothing;
  end if;
  last_status:=case when result->>'state' in('ready','partial','failed') then result->>'state' else 'idle' end;
  foreach source in array array['skipdb','introdb'] loop
    provider:='{}';
    value:=result#>array['providerStatus',source,'configured'];
    if jsonb_typeof(value)='boolean' then provider:=provider||jsonb_build_object('configured',value);end if;
    foreach field in array array['lastCheckedAt','lastSuccessAt'] loop
      value:=result#>array['providerStatus',source,field];
      if jsonb_typeof(value)='string' and (value#>>'{}') ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$' then
        provider:=provider||jsonb_build_object(field,value);
      end if;
    end loop;
    value:=result#>array['providerStatus',source,'errorCode'];
    if jsonb_typeof(value)='null' or (value#>>'{}') ~ '^PROVIDER_[A-Z0-9_]{1,60}$' then provider:=provider||jsonb_build_object('errorCode',value);end if;
    health:=health||jsonb_build_object(source,provider);
  end loop;
  insert into public.marker_sync_registry as current(name,running_until,last_started_at,last_finished_at,last_source_completed_at,last_status,skipdb_cooldown_until,introdb_cooldown_until,providers)
  values('global',new.lease_until,new.last_started_at,new.last_finished_at,new.dump_completed_at,last_status,new.skipdb_cooldown_until,new.introdb_cooldown_until,health)
  on conflict(name) do update set running_until=excluded.running_until,last_started_at=excluded.last_started_at,last_finished_at=excluded.last_finished_at,
    last_source_completed_at=coalesce(excluded.last_source_completed_at,current.last_source_completed_at),last_status=excluded.last_status,
    skipdb_cooldown_until=excluded.skipdb_cooldown_until,introdb_cooldown_until=excluded.introdb_cooldown_until,
    providers=jsonb_build_object('skipdb',coalesce(current.providers->'skipdb','{}')||coalesce(excluded.providers->'skipdb','{}'),
      'introdb',coalesce(current.providers->'introdb','{}')||coalesce(excluded.providers->'introdb','{}'));
  if new.last_finished_at is null or new.last_started_at is null or new.last_finished_at<new.last_started_at or last_status='idle' then return new;end if;
  foreach field in array array['published','identities','unresolved','episodesChecked','skipdb','introdb','empty','unverified','failures','elapsedMs'] loop
    value:=result->field;
    counters:=counters||jsonb_build_object(field,case when jsonb_typeof(value)='number' and (value#>>'{}') ~ '^[0-9]{1,10}$'
      then least(2147483647,(value#>>'{}')::bigint) else 0 end);
  end loop;
  error_code:=coalesce(result->>'code',result->>'dumpError',result->>'retentionError',result->>'versionError');
  if error_code !~ '^(MARKER_|PROVIDER_|DUMP_|SOURCE_)[A-Z0-9_]{1,65}$' then error_code:=null;end if;
  insert into public.marker_sync_runs(started_at,finished_at,status,counters,error_code)
    values(new.last_started_at,new.last_finished_at,last_status,counters,error_code) on conflict(started_at) do nothing;
  -- Retain a useful global history without an unbounded operations log.
  delete from public.marker_sync_runs where id in(select id from public.marker_sync_runs
    where finished_at<now()-interval '30 days' order by finished_at limit 100);
  return new;
end $$;
revoke all on function arkhen_private.marker_sync_project() from public,anon,authenticated;
grant execute on function arkhen_private.marker_sync_project() to service_role;
create trigger arkhen_marker_sync_project after insert or update of last_started_at,last_finished_at,dump_completed_at on public.series_marker_sync_state
  for each row execute function arkhen_private.marker_sync_project();
-- Preserve the last real cycle as the first historical entry; no invented past.
update public.series_marker_sync_state set last_finished_at=last_finished_at where name='global';

create index if not exists arkhen_marker_active_episode on public.episode_skip_markers(imdb_id,season,episode) where is_active;
create or replace function public.arkhen_marker_sync_status(p_provider_key text,p_scope_hash text)
returns jsonb language plpgsql stable security invoker set search_path='' set statement_timeout='10s' as $$
declare state public.marker_sync_registry;global_counts jsonb;catalog_counts jsonb;recent jsonb;issues jsonb;identified jsonb;providers jsonb;
begin
  if not public.arkhen_partition_allows(p_provider_key,p_scope_hash) then raise exception 'Marker synchronization access denied' using errcode='42501';end if;
  select * into state from public.marker_sync_registry where name='global';
  with references_by_episode as materialized (
    select imdb_id,season,episode,bool_or(has_intro) as has_intro,bool_or(has_recap) as has_recap,bool_or(has_credits) as has_credits,
      bool_or(unverified) as unverified,sum(editions) as editions
    from (
      select imdb_id,season,episode,markers ? 'openingEnd' as has_intro,markers ? 'recapEnd' as has_recap,markers ? 'creditsStart' as has_credits,
        verification<>'verified' as unverified,1 as editions from public.episode_skip_markers where is_active and imdb_id is not null
      union all
      select imdb_id,season,episode,
        jsonb_typeof(evidence#>'{skipdb,intro}')='object' or jsonb_typeof(evidence#>'{introdb,intro}')='object',
        jsonb_typeof(evidence#>'{skipdb,recap}')='object' or jsonb_typeof(evidence#>'{introdb,recap}')='object',
        jsonb_typeof(evidence#>'{skipdb,outro}')='object' or jsonb_typeof(evidence#>'{introdb,outro}')='object',
        status='unverified',0 from public.series_marker_coverage
    ) source group by imdb_id,season,episode
  ), catalog as materialized (
    select m.media_id,m.name,i.imdb_id,i.status,i.error_code,i.updated_at
    from public.catalog_media m join public.catalog_visible_generations g using(provider_key,scope_hash,media_type,generation_id)
    left join public.series_marker_identities i on i.provider_key=m.provider_key and i.scope_hash=m.scope_hash and i.media_id=m.media_id
    where m.provider_key=p_provider_key and m.scope_hash=p_scope_hash and m.media_type='series' and m.is_active and not m.is_adult
  ), mapped as materialized(select distinct imdb_id from catalog where status='resolved' and imdb_id is not null),
  coverage as materialized(select r.* from references_by_episode r join mapped using(imdb_id)),
  coverage_counts as(select imdb_id,count(*) as episodes,count(*) filter(where has_intro or has_recap or has_credits) as with_markers from coverage group by imdb_id)
  select
    (select jsonb_build_object('episodes',count(*),'series',count(distinct imdb_id),'introEpisodes',count(*) filter(where has_intro),
      'recapEpisodes',count(*) filter(where has_recap),'creditsEpisodes',count(*) filter(where has_credits),
      'editions',coalesce(sum(editions),0),'unverifiedEpisodes',count(*) filter(where unverified)) from references_by_episode),
    (select jsonb_build_object('series',count(*),'identifiedSeries',count(*) filter(where status='resolved'),
      'pendingSeries',count(*) filter(where status is null or status='pending'),
      'unresolvedSeries',count(*) filter(where status in('unresolved','ambiguous')),'failedSeries',count(*) filter(where status='failed'),
      'episodes',(select count(*) from coverage),'withMarkers',(select count(*) from coverage where has_intro or has_recap or has_credits),
      'introEpisodes',(select count(*) from coverage where has_intro)) from catalog),
    (select coalesce(jsonb_agg(jsonb_build_object('title',left(name,180),'status',status,'reasonCode',case when error_code~'^[A-Z][A-Z0-9_]{0,79}$' then error_code end,'updatedAt',updated_at) order by updated_at desc,name),'[]')
      from (select * from catalog where status in('unresolved','ambiguous','failed') order by updated_at desc,name limit 20) limited),
    (select coalesce(jsonb_agg(jsonb_build_object('title',left(name,180),'imdbId',imdb_id,'updatedAt',updated_at,
      'episodes',coalesce(episodes,0),'withMarkers',coalesce(with_markers,0)) order by updated_at desc,name),'[]')
      from(select c.*,cc.episodes,cc.with_markers from catalog c left join coverage_counts cc using(imdb_id)
        where c.status='resolved' order by c.updated_at desc,c.name limit 20) limited)
  into global_counts,catalog_counts,issues,identified;
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
notify pgrst,'reload schema';
commit;
