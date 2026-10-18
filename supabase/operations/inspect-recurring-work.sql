-- Bounded incident metadata, without source credentials, job commands or query text.
begin read only;
set local statement_timeout='8s';
set local lock_timeout='500ms';
set local jit='off';
select jsonb_build_object(
 'observed_at',clock_timestamp(),
 'cron',(select jsonb_agg(t) from (select jobid,jobname,schedule,active from cron.job where jobname like 'arkhen-%' order by jobid)t),
 'recent_runs',(select jsonb_agg(t) from (
   select j.jobname,r.status,r.start_time,r.end_time,
    round(extract(epoch from(coalesce(r.end_time,clock_timestamp())-r.start_time))::numeric,1) as seconds
   from cron.job_run_details r join cron.job j on j.jobid=r.jobid
   where j.jobname like 'arkhen-%' and r.start_time>now()-interval '15 minutes'
   order by r.start_time desc limit 40
 )t),
 'cleanup_definition',pg_get_functiondef('public.arkhen_cleanup_catalog_generations(integer)'::regprocedure)
) as snapshot;
commit;
