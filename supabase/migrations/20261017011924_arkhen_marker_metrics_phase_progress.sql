-- Natural runs succeeded in ~5-6s yet the clock retained only one completed
-- unit and neither discovery cursor. The former function-wide cooperative
-- timers could expire during initialization/first plan preparation, before any
-- seek or aggregation was attempted. Allocate the same slices at their phases,
-- guarantee the first indexed unit, and alternate discovery sources. No source
-- scan, refresh, worker invocation or cron change is executed by this migration.
begin;
set local lock_timeout='3s';
set local statement_timeout='10s';
do $baseline$
begin
 if(select md5(prosrc) from pg_proc where oid='public.arkhen_refresh_marker_sync_metrics()'::regprocedure)
  is distinct from '898b72f914d28fba28b2f2c3c0155650' then
  raise exception 'Marker metrics definition changed; inspect before applying' using errcode='55000';
 end if;
end $baseline$;
alter table arkhen_private.marker_metric_batch_clock
 add column discovery_turn text not null default 'markers' check(discovery_turn in('markers','coverage'));

create or replace function public.arkhen_refresh_marker_sync_metrics()
returns boolean language plpgsql security invoker set search_path=''
 set statement_timeout='8s' set lock_timeout='500ms' set jit='off' as $$
declare
 phase_started timestamptz;batch arkhen_private.marker_metric_batch_clock;
 globals jsonb;writers bigint[];source_name text;cursor_value text;next_imdb text;
 source_complete boolean;step integer;units integer:=0;metrics record;published_now boolean:=false;
begin
 if not pg_try_advisory_xact_lock(hashtext('arkhen-marker-sync-metrics')) then return false;end if;
 select c.* into strict batch from arkhen_private.marker_metric_batch_clock c where c.id for update;
 if exists(select 1 from arkhen_private.marker_metric_invalidations i
  where (batch.captured_global_events->>i.writer_xid::text)::bigint is distinct from i.revision) then
  select coalesce(jsonb_object_agg(i.writer_xid::text,i.revision),'{}'::jsonb) into globals
   from arkhen_private.marker_metric_invalidations i;
  -- A new global event invalidates even private results. Keep per-title writer
  -- invalidations: inserts/changes behind a discovery cursor must survive reset.
  delete from arkhen_private.marker_metric_pending_titles;
  delete from arkhen_private.marker_metric_staged_titles;
  batch.captured_global_events:=globals;batch.metrics_seeded:=false;
  batch.markers_cursor:='';batch.markers_complete:=false;
  batch.coverage_cursor:='';batch.coverage_complete:=false;
 end if;
 if batch.metrics_seeded and batch.markers_complete and batch.coverage_complete and batch.captured_global_events='{}'
  and not exists(select 1 from arkhen_private.marker_metric_dirty_titles)
  and not exists(select 1 from arkhen_private.marker_metric_pending_titles)
  and not exists(select 1 from arkhen_private.marker_metric_staged_titles) then return false;end if;
 if not batch.metrics_seeded then
  -- This reads only the compact existing metrics PK (about 1,716 rows at the
  -- incident), not either large JSON source. Extinct titles are included.
  insert into arkhen_private.marker_metric_pending_titles(imdb_id)
   select m.imdb_id from public.marker_series_sync_metrics m where true on conflict do nothing;
  batch.metrics_seeded:=true;
 end if;
 phase_started:=clock_timestamp();
 source_name:=case when batch.markers_complete then 'coverage' when batch.coverage_complete then 'markers' else batch.discovery_turn end;
  source_complete:=case source_name when 'markers' then batch.markers_complete else batch.coverage_complete end;
 if not source_complete then
  cursor_value:=case source_name when 'markers' then batch.markers_cursor else batch.coverage_cursor end;
  for step in 1..128 loop
   exit when step>1 and clock_timestamp()-phase_started>interval '500 milliseconds';
   if source_name='markers' then
    select m.imdb_id into next_imdb from public.episode_skip_markers m
     where m.is_active and m.imdb_id>cursor_value and m.imdb_id~'^tt[0-9]{6,10}$'
     order by m.imdb_id limit 1;
   else
    select c.imdb_id into next_imdb from public.series_marker_coverage c
     where c.imdb_id>cursor_value order by c.imdb_id limit 1;
   end if;
   if next_imdb is null then source_complete:=true;exit;end if;
   insert into arkhen_private.marker_metric_pending_titles(imdb_id)
    select next_imdb where not exists(select 1 from arkhen_private.marker_metric_staged_titles s where s.imdb_id=next_imdb)
    on conflict do nothing;
   cursor_value:=next_imdb;
  end loop;
  if source_name='markers' then batch.markers_cursor:=cursor_value;batch.markers_complete:=source_complete;
  else batch.coverage_cursor:=cursor_value;batch.coverage_complete:=source_complete;end if;
 end if;
 batch.discovery_turn:=case source_name when 'markers' then 'coverage' else 'markers' end;
 phase_started:=clock_timestamp();
 for step in 1..128 loop
  exit when step>1 and clock_timestamp()-phase_started>interval '2 seconds';
  -- Each branch is a primary-key seek; do not sort/expand the complete union
  -- of dirty writers and pending titles again for every computed title.
  select least(
   (select d.imdb_id from arkhen_private.marker_metric_dirty_titles d order by d.imdb_id limit 1),
   (select p.imdb_id from arkhen_private.marker_metric_pending_titles p order by p.imdb_id limit 1)
  ) into next_imdb;
  if next_imdb is null then exit;end if;
  select array_agg(d.writer_xid) into writers from arkhen_private.marker_metric_dirty_titles d where d.imdb_id=next_imdb;
  -- Both source indexes begin with IMDb. Edition multiplicity is collapsed
  -- before joining the coverage primary key, preserving the former counters.
  with editions_by_episode as materialized(
   select m.season,m.episode,bool_or(m.markers ? 'openingEnd') as has_intro,
    bool_or(m.markers ? 'recapEnd') as has_recap,bool_or(m.markers ? 'creditsStart') as has_credits,
    bool_or(m.verification<>'verified') as unverified,count(*) as editions
   from public.episode_skip_markers m where m.is_active and m.imdb_id=next_imdb group by m.season,m.episode
  ),coverage_by_episode as materialized(
   select c.season,c.episode,
    coalesce(jsonb_typeof(c.evidence#>'{skipdb,intro}')='object' or jsonb_typeof(c.evidence#>'{introdb,intro}')='object',false) as has_intro,
    coalesce(jsonb_typeof(c.evidence#>'{skipdb,recap}')='object' or jsonb_typeof(c.evidence#>'{introdb,recap}')='object',false) as has_recap,
    coalesce(jsonb_typeof(c.evidence#>'{skipdb,outro}')='object' or jsonb_typeof(c.evidence#>'{introdb,outro}')='object',false) as has_credits,
    c.status='unverified' as unverified
   from public.series_marker_coverage c where c.imdb_id=next_imdb
  ),episodes as(
   select coalesce(m.has_intro,false) or coalesce(c.has_intro,false) as has_intro,
    coalesce(m.has_recap,false) or coalesce(c.has_recap,false) as has_recap,
    coalesce(m.has_credits,false) or coalesce(c.has_credits,false) as has_credits,
    coalesce(m.unverified,false) or coalesce(c.unverified,false) as unverified,coalesce(m.editions,0) as editions
   from editions_by_episode m full join coverage_by_episode c using(season,episode)
  )select count(*) as episodes,count(*) filter(where has_intro or has_recap or has_credits) as with_markers,
   count(*) filter(where has_intro) as intro_episodes,count(*) filter(where has_recap) as recap_episodes,
   count(*) filter(where has_credits) as credits_episodes,coalesce(sum(editions),0) as editions,
   count(*) filter(where unverified) as unverified_episodes into metrics from episodes;
  insert into arkhen_private.marker_metric_staged_titles(
   imdb_id,episodes,with_markers,intro_episodes,recap_episodes,credits_episodes,editions,unverified_episodes)
  values(next_imdb,metrics.episodes,metrics.with_markers,metrics.intro_episodes,metrics.recap_episodes,
   metrics.credits_episodes,metrics.editions,metrics.unverified_episodes)
  on conflict(imdb_id) do update set episodes=excluded.episodes,with_markers=excluded.with_markers,
   intro_episodes=excluded.intro_episodes,recap_episodes=excluded.recap_episodes,credits_episodes=excluded.credits_episodes,
   editions=excluded.editions,unverified_episodes=excluded.unverified_episodes;
  -- A writer committing during this read has a different, uncaptured txid.
  -- Never acknowledge by max(txid): commit order and ID order can differ.
  delete from arkhen_private.marker_metric_dirty_titles where imdb_id=next_imdb and writer_xid=any(writers);
  delete from arkhen_private.marker_metric_pending_titles where imdb_id=next_imdb;
  units:=units+1;
 end loop;
 update arkhen_private.marker_metric_batch_clock c set captured_global_events=batch.captured_global_events,
  metrics_seeded=batch.metrics_seeded,markers_cursor=batch.markers_cursor,markers_complete=batch.markers_complete,
  coverage_cursor=batch.coverage_cursor,coverage_complete=batch.coverage_complete,discovery_turn=batch.discovery_turn,completed_units=c.completed_units+units
  where c.id;
 -- Discovery cannot publish yet. Avoid preparing/executing the full atomic
 -- publication statement on these bootstrap rounds; the clock above commits.
 if not batch.markers_complete or not batch.coverage_complete then return false;end if;
 -- Gate and publication share ONE statement snapshot. A commit after this
 -- snapshot remains dirty for the next cycle; all earlier relevant changes
 -- must already have a staged result or prevent this publication entirely.
 with gate as materialized(
  select clock_timestamp() as stamp where batch.markers_complete and batch.coverage_complete
   and not exists(select 1 from arkhen_private.marker_metric_pending_titles)
   and not exists(select 1 from arkhen_private.marker_metric_dirty_titles)
   and not exists(select 1 from arkhen_private.marker_metric_invalidations i
    where (batch.captured_global_events->>i.writer_xid::text)::bigint is distinct from i.revision)
   and(exists(select 1 from arkhen_private.marker_metric_staged_titles) or batch.captured_global_events<>'{}')
 ),next_rows as materialized(
  select coalesce(s.imdb_id,m.imdb_id) as imdb_id,
   coalesce(s.episodes,m.episodes) as episodes,coalesce(s.with_markers,m.with_markers) as with_markers,
   coalesce(s.intro_episodes,m.intro_episodes) as intro_episodes,coalesce(s.recap_episodes,m.recap_episodes) as recap_episodes,
   coalesce(s.credits_episodes,m.credits_episodes) as credits_episodes,coalesce(s.editions,m.editions) as editions,
   coalesce(s.unverified_episodes,m.unverified_episodes) as unverified_episodes,g.stamp
  from public.marker_series_sync_metrics m full join arkhen_private.marker_metric_staged_titles s using(imdb_id)
  cross join gate g where coalesce(s.episodes,m.episodes)>0
 ),published_rows as(
  insert into public.marker_series_sync_metrics(imdb_id,episodes,with_markers,intro_episodes,recap_episodes,
   credits_episodes,editions,unverified_episodes,refreshed_at)
  select imdb_id,episodes,with_markers,intro_episodes,recap_episodes,credits_episodes,editions,unverified_episodes,stamp from next_rows where true
  on conflict(imdb_id) do update set episodes=excluded.episodes,with_markers=excluded.with_markers,
   intro_episodes=excluded.intro_episodes,recap_episodes=excluded.recap_episodes,credits_episodes=excluded.credits_episodes,
   editions=excluded.editions,unverified_episodes=excluded.unverified_episodes,refreshed_at=excluded.refreshed_at returning 1
 ),removed_rows as(
  -- Zero-count deltas are disjoint from next_rows, so no public tuple is
  -- modified twice by the data-modifying CTEs in this statement.
  delete from public.marker_series_sync_metrics m using arkhen_private.marker_metric_staged_titles s,gate g
   where m.imdb_id=s.imdb_id and s.episodes=0 returning 1
 ),checkpoint as(
  update public.marker_sync_registry r set coverage_refreshed_at=g.stamp from gate g
   where r.name='global' and(select count(*) from published_rows)>=0 and(select count(*) from removed_rows)>=0
   returning r.coverage_refreshed_at
 ),clear_staging as(
  delete from arkhen_private.marker_metric_staged_titles where exists(select 1 from checkpoint) returning 1
 ),clear_globals as(
  delete from arkhen_private.marker_metric_invalidations i where i.revision=(batch.captured_global_events->>i.writer_xid::text)::bigint
   and exists(select 1 from checkpoint) returning 1
 ),advance_clock as(
  update arkhen_private.marker_metric_batch_clock c set captured_global_events='{}',last_published_at=p.coverage_refreshed_at
   from checkpoint p where c.id returning 1
 )select exists(select 1 from checkpoint) into published_now;
 return published_now;
end $$;
revoke all on function public.arkhen_refresh_marker_sync_metrics() from public,anon,authenticated;
grant execute on function public.arkhen_refresh_marker_sync_metrics() to service_role;
commit;
