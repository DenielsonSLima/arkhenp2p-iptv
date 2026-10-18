-- Inspect private batch metadata and natural cron history; invoke no jobs.
begin read only;
set local statement_timeout='5s';
set local jit='off';
select jsonb_build_object(
 'observed_at',clock_timestamp(),
 'metrics_clock',(select to_jsonb(c)-'captured_global_events'-'markers_cursor'-'coverage_cursor'
  from arkhen_private.marker_metric_batch_clock c where c.id),
 'metrics_queue',jsonb_build_object(
  'dirty_titles',(select count(*) from arkhen_private.marker_metric_dirty_titles),
  'pending_titles',(select count(*) from arkhen_private.marker_metric_pending_titles),
  'staged_titles',(select count(*) from arkhen_private.marker_metric_staged_titles)),
 'cleanup_cursors',(select jsonb_agg(t) from(
  select relation_name,pending_cleanup,last_visited_at from arkhen_private.catalog_cleanup_cursors order by relation_name
 )t),
 'definitions',(select jsonb_agg(t) from(
  select p.proname,md5(p.prosrc) body_md5,p.proconfig from pg_proc p where p.oid in(
   'public.arkhen_cleanup_catalog_generations(integer)'::regprocedure,
   'public.arkhen_refresh_marker_sync_metrics()'::regprocedure,
   'arkhen_private.refresh_tv_guide(text,text,boolean,text)'::regprocedure,
   'arkhen_private.mark_marker_metric_changes()'::regprocedure)
 )t),
 'cron',(select jsonb_agg(t) from(
  select jobname,schedule,active,substring(command from 'statement_timeout=''([0-9]+s)''') as outer_budget
  from cron.job where jobname in('arkhen-catalog-generation-cleanup','arkhen-marker-sync-metrics',
   'arkhen-adult-progress-privacy','arkhen-tv-guide-clock','arkhen-home-identities') order by jobname
 )t),
 'migrations',(select jsonb_agg(t) from(
  select version,name from supabase_migrations.schema_migrations
  where name in('arkhen_catalog_cleanup_separate_seek_and_tid_batches','arkhen_marker_metrics_atomic_batches',
   'arkhen_tv_guide_channel_local_windows') order by version
 )t),
 'recent',(select jsonb_agg(t) from(
  select j.jobname,r.status,r.start_time,r.end_time,
   round(extract(epoch from(r.end_time-r.start_time))::numeric,3) as duration_seconds
  from(select jobid,status,start_time,end_time from cron.job_run_details order by runid desc limit 100)r
  join cron.job j on j.jobid=r.jobid
  where j.jobname in('arkhen-catalog-generation-cleanup','arkhen-marker-sync-metrics',
   'arkhen-tv-guide-clock','arkhen-adult-progress-privacy')
  order by r.start_time desc limit 12
 )t),
 'active',(select jsonb_agg(t) from(
  select wait_event_type,wait_event,count(*) as sessions from pg_stat_activity
  where datname=current_database() and state='active' and pid<>pg_backend_pid()
  group by wait_event_type,wait_event
 )t)
) as state;
commit;
