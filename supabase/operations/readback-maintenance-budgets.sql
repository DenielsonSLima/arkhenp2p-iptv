-- Read metadata after deployment; do not invoke maintenance functions.
begin read only;
set local statement_timeout='5s';
set local jit='off';
select jsonb_build_object(
 'observed_at',clock_timestamp(),
 'cron',(select jsonb_agg(t) from (
  select jobname,schedule,active,
   substring(command from 'statement_timeout=''([0-9]+s)''') as outer_statement_budget
  from cron.job where jobname in('arkhen-catalog-generation-cleanup','arkhen-home-identities',
   'arkhen-tv-guide-clock','arkhen-marker-sync-metrics','arkhen-adult-progress-privacy')
  order by jobname
 )t),
 'scheduler_config',(select jsonb_agg(t) from (
  select p.proname,md5(p.prosrc) as body_md5,p.proconfig from pg_proc p
  where p.oid in('arkhen_private.enqueue_due_cache_jobs(text,text)'::regprocedure,
   'arkhen_private.kick_cloud_collector()'::regprocedure)
 )t),
 'migrations',(select jsonb_agg(t) from (
  select version,name from supabase_migrations.schema_migrations
  where name in('arkhen_idle_collector_and_bounded_home','arkhen_catalog_cleanup_generation_cursor',
   'arkhen_tv_guide_incremental_windows','arkhen_bounded_privacy_sweep_and_marker_lease',
   'arkhen_marker_metrics_relevant_revision','arkhen_scheduler_jit_and_cron_budgets')
  order by version
 )t)
) as state;
commit;
