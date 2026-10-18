-- Readback of definitions and scheduler state only; no task execution.
select jsonb_build_object(
 'observed_at',clock_timestamp(),
 'cron',(select jsonb_agg(t) from (
  select jobid,jobname,schedule,active from cron.job
  where jobname in('arkhen-home-identities','arkhen-catalog-generation-cleanup','arkhen-tv-guide-clock')
 )t),
 'functions',(select jsonb_agg(t) from (
  select n.nspname as schema,p.proname,md5(p.prosrc) as body_md5,p.proconfig
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where p.oid in('arkhen_private.refresh_tv_guide(text,text,boolean,text)'::regprocedure,
   'public.arkhen_refresh_marker_sync_metrics()'::regprocedure,
   'public.arkhen_prune_adult_progress(integer)'::regprocedure,
   'arkhen_private.arkhen_schedule_marker_sync()'::regprocedure)
 )t)
) as state;
