-- Skip the global metrics aggregation when its counted fields have not changed.
-- Keep the complete metrics snapshot/status DTO atomic: no partial series
-- publication, source backfill, cron activation or refresh is executed here.
begin;
set local lock_timeout='3s';
set local statement_timeout='10s';

do $baseline$
begin
 if (select md5(prosrc) from pg_proc where oid='public.arkhen_refresh_marker_sync_metrics()'::regprocedure)
  is distinct from 'b232c7bee289c6592872d392dcdf3ed1' then
  raise exception 'Marker metrics definition changed; inspect before applying';
 end if;
end $baseline$;

-- A committed writer transaction is one invalidation, irrespective of how many
-- source statements it executed. Distinct writers never lock one shared row.
create table arkhen_private.marker_metric_invalidations(
 writer_xid bigint primary key default txid_current()
);
alter table arkhen_private.marker_metric_invalidations enable row level security;
revoke all on arkhen_private.marker_metric_invalidations from public,anon,authenticated;
grant all on arkhen_private.marker_metric_invalidations to service_role;
insert into arkhen_private.marker_metric_invalidations default values;

-- Inspect each relevant statement and retain one invalidation per transaction.
-- Compare
-- only fields used by the counters: publication generation/provenance, audit
-- deadlines, retries and timestamps do not invalidate unchanged metrics.
-- EXCEPT ALL preserves edition multiplicity while ignoring irrelevant changes.
create function arkhen_private.mark_marker_metric_changes()
returns trigger language plpgsql security invoker set search_path='' set jit='off' as $$
declare projection text;predicate text;changes text;changed boolean;
begin
 if tg_table_schema<>'public' then raise exception 'Invalid marker metrics source';end if;
 if tg_table_name='episode_skip_markers' then
  projection:='imdb_id,season,episode,markers ? ''openingEnd'' as has_intro,markers ? ''recapEnd'' as has_recap,markers ? ''creditsStart'' as has_credits,verification<>''verified'' as unverified';
  predicate:='is_active and imdb_id ~ ''^tt[0-9]{6,10}$''';
 elsif tg_table_name='series_marker_coverage' then
  projection:=$projection$imdb_id,season,episode,
   coalesce(jsonb_typeof(evidence#>'{skipdb,intro}')='object' or jsonb_typeof(evidence#>'{introdb,intro}')='object',false) as has_intro,
   coalesce(jsonb_typeof(evidence#>'{skipdb,recap}')='object' or jsonb_typeof(evidence#>'{introdb,recap}')='object',false) as has_recap,
   coalesce(jsonb_typeof(evidence#>'{skipdb,outro}')='object' or jsonb_typeof(evidence#>'{introdb,outro}')='object',false) as has_credits,
   status='unverified' as unverified$projection$;
  predicate:='true';
 else raise exception 'Invalid marker metrics source';end if;
 if tg_op='TRUNCATE' then
  insert into arkhen_private.marker_metric_invalidations default values on conflict do nothing;
  return null;
 elsif tg_op='UPDATE' then
  changes:=format($changes$
   with before_rows as materialized(select %s from old_rows where %s),
    after_rows as materialized(select %s from new_rows where %s)
   select 1 from(
    (select * from before_rows except all select * from after_rows)
    union all(select * from after_rows except all select * from before_rows)
   ) changed
  $changes$,projection,predicate,projection,predicate);
 elsif tg_op='INSERT' then changes:='select 1 from new_rows where '||predicate;
 elsif tg_op='DELETE' then changes:='select 1 from old_rows where '||predicate;
 else raise exception 'Invalid marker metrics operation';end if;
 execute 'select exists('||changes||')' into changed;
 if changed then
  insert into arkhen_private.marker_metric_invalidations default values on conflict do nothing;
 end if;
 return null;
end $$;
revoke all on function arkhen_private.mark_marker_metric_changes() from public,anon,authenticated;
grant execute on function arkhen_private.mark_marker_metric_changes() to service_role;

create trigger arkhen_marker_metrics_insert after insert on public.episode_skip_markers
 referencing new table as new_rows for each statement execute function arkhen_private.mark_marker_metric_changes();
create trigger arkhen_marker_metrics_update after update on public.episode_skip_markers
 referencing old table as old_rows new table as new_rows for each statement execute function arkhen_private.mark_marker_metric_changes();
create trigger arkhen_marker_metrics_delete after delete on public.episode_skip_markers
 referencing old table as old_rows for each statement execute function arkhen_private.mark_marker_metric_changes();
create trigger arkhen_marker_metrics_truncate after truncate on public.episode_skip_markers
 for each statement execute function arkhen_private.mark_marker_metric_changes();
create trigger arkhen_coverage_metrics_insert after insert on public.series_marker_coverage
 referencing new table as new_rows for each statement execute function arkhen_private.mark_marker_metric_changes();
create trigger arkhen_coverage_metrics_update after update on public.series_marker_coverage
 referencing old table as old_rows new table as new_rows for each statement execute function arkhen_private.mark_marker_metric_changes();
create trigger arkhen_coverage_metrics_delete after delete on public.series_marker_coverage
 referencing old table as old_rows for each statement execute function arkhen_private.mark_marker_metric_changes();
create trigger arkhen_coverage_metrics_truncate after truncate on public.series_marker_coverage
 for each statement execute function arkhen_private.mark_marker_metric_changes();

create or replace function public.arkhen_refresh_marker_sync_metrics()
returns boolean language plpgsql security invoker set search_path=''
 set statement_timeout='45s' set jit='off' as $$
declare refreshed timestamptz:=clock_timestamp();observed_writers bigint[];
begin
 if not pg_try_advisory_xact_lock(hashtext('arkhen-marker-sync-metrics')) then return false;end if;
 select array_agg(writer_xid) into observed_writers from arkhen_private.marker_metric_invalidations;
 if observed_writers is null then return false;end if;
 -- Other writers' invalidations become visible only with their commit, so the
 -- aggregation sees all their source writes. Acknowledge exactly those IDs:
 -- a writer committing during aggregation retains its row for the next cycle.
 -- Sequence/max-ID watermarks would lose such out-of-order commits.
 with editions_by_episode as materialized(
  select m.imdb_id,m.season,m.episode,bool_or(m.markers ? 'openingEnd') as has_intro,
   bool_or(m.markers ? 'recapEnd') as has_recap,bool_or(m.markers ? 'creditsStart') as has_credits,
   bool_or(m.verification<>'verified') as unverified,count(*) as editions
  from public.episode_skip_markers m where m.is_active and m.imdb_id~'^tt[0-9]{6,10}$'
  group by m.imdb_id,m.season,m.episode
 ),coverage_by_episode as materialized(
  select c.imdb_id,c.season,c.episode,
   coalesce(jsonb_typeof(c.evidence#>'{skipdb,intro}')='object' or jsonb_typeof(c.evidence#>'{introdb,intro}')='object',false) as has_intro,
   coalesce(jsonb_typeof(c.evidence#>'{skipdb,recap}')='object' or jsonb_typeof(c.evidence#>'{introdb,recap}')='object',false) as has_recap,
   coalesce(jsonb_typeof(c.evidence#>'{skipdb,outro}')='object' or jsonb_typeof(c.evidence#>'{introdb,outro}')='object',false) as has_credits,
   c.status='unverified' as unverified
  from public.series_marker_coverage c
 ),episodes as(
  select coalesce(m.imdb_id,c.imdb_id) as imdb_id,
   coalesce(m.has_intro,false) or coalesce(c.has_intro,false) as has_intro,
   coalesce(m.has_recap,false) or coalesce(c.has_recap,false) as has_recap,
   coalesce(m.has_credits,false) or coalesce(c.has_credits,false) as has_credits,
   coalesce(m.unverified,false) or coalesce(c.unverified,false) as unverified,coalesce(m.editions,0) as editions
  from editions_by_episode m full join coverage_by_episode c using(imdb_id,season,episode)
 )insert into public.marker_series_sync_metrics(
  imdb_id,episodes,with_markers,intro_episodes,recap_episodes,credits_episodes,editions,unverified_episodes,refreshed_at)
 select imdb_id,count(*),count(*) filter(where has_intro or has_recap or has_credits),
  count(*) filter(where has_intro),count(*) filter(where has_recap),count(*) filter(where has_credits),
  coalesce(sum(editions),0),count(*) filter(where unverified),refreshed
 from episodes group by imdb_id
 on conflict(imdb_id) do update set episodes=excluded.episodes,with_markers=excluded.with_markers,
  intro_episodes=excluded.intro_episodes,recap_episodes=excluded.recap_episodes,credits_episodes=excluded.credits_episodes,
  editions=excluded.editions,unverified_episodes=excluded.unverified_episodes,refreshed_at=excluded.refreshed_at;
 delete from public.marker_series_sync_metrics where refreshed_at<>refreshed;
 update public.marker_sync_registry set coverage_refreshed_at=refreshed where name='global';
 delete from arkhen_private.marker_metric_invalidations where writer_xid=any(observed_writers);
 return true;
end $$;
revoke all on function public.arkhen_refresh_marker_sync_metrics() from public,anon,authenticated;
grant execute on function public.arkhen_refresh_marker_sync_metrics() to service_role;
notify pgrst,'reload schema';
commit;
