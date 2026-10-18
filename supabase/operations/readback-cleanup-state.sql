-- Minimal readback after response/connection timeouts. No log scans or tasks.
select jsonb_build_object(
 'observed_at',clock_timestamp(),
 'cleanup_hash',(select md5(prosrc) from pg_proc where oid='public.arkhen_cleanup_catalog_generations(integer)'::regprocedure),
 'cron',(select jsonb_agg(t) from (
  select jobid,jobname,active from cron.job
  where jobname in('arkhen-home-identities','arkhen-catalog-generation-cleanup')
 )t)
) as state;
