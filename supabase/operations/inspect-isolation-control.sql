-- Minimal control read: no job history, source table or task execution.
select jsonb_build_object('observed_at',clock_timestamp(),'server_started',pg_postmaster_start_time(),
 'active_application_crons',(select count(*) from cron.job where jobname like 'arkhen-%' and active),
 'legacy_discovery',(select md5(prosrc) from pg_proc where oid=to_regprocedure('public.arkhen_marker_discover(integer)')),
 'source_batch',(select md5(prosrc) from pg_proc where oid=to_regprocedure('public.arkhen_marker_source_batch(text,uuid,integer)'))
) as state;
