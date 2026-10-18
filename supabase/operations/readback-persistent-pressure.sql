-- Small metadata only, after incident containment. No job or source invoked.
begin read only;
set local statement_timeout='5s';
set local jit='off';
select jsonb_build_object('observed_at',clock_timestamp(),
 'cron',(select jsonb_agg(t) from(select jobname,schedule,active from cron.job
  where jobname in('arkhen-tv-guide-clock','arkhen-catalog-generation-cleanup','arkhen-marker-sync-metrics',
   'arkhen-home-identities','arkhen-cache-enqueue','arkhen-cloud-catalog-sync','arkhen-series-markers-sync') order by jobname)t),
 'migrations',(select jsonb_agg(t) from(select version,name from supabase_migrations.schema_migrations
  where version>='20261017010000' order by version)t),
 'functions',(select jsonb_object_agg(p.oid::regprocedure::text,md5(p.prosrc)) from pg_proc p
  where p.oid in(to_regprocedure('public.arkhen_refresh_marker_sync_metrics()'),
   to_regprocedure('public.arkhen_cleanup_catalog_generations(integer)'),
   to_regprocedure('public.arkhen_tv_guide(text,text,text[],boolean,text)'),
   to_regprocedure('public.arkhen_tick_tv_guides()'),to_regprocedure('public.arkhen_marker_discover_batch(integer)'))),
 'activity',(select coalesce(jsonb_agg(t),'[]') from(select backend_type,wait_event_type,wait_event,
  round(extract(epoch from(clock_timestamp()-query_start))::numeric,1) as seconds
  from pg_stat_activity where state='active' and pid<>pg_backend_pid() order by query_start limit 6)t)
) as state;
commit;
