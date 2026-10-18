-- Read-only incident snapshot. No account data, job commands or query text.
begin read only;
set local statement_timeout='3s';
set local lock_timeout='500ms';
set local jit='off';
select jsonb_build_object(
 'observed_at',clock_timestamp(),
 'activity',(select coalesce(jsonb_agg(t),'[]'::jsonb) from (
   select backend_type,state,wait_event_type,wait_event,count(*) as connections,
    round(max(extract(epoch from (clock_timestamp()-query_start)))::numeric,1) as longest_seconds
   from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
   group by backend_type,state,wait_event_type,wait_event order by count(*) desc limit 16
 )t),
 'cron',(select coalesce(jsonb_agg(t),'[]'::jsonb) from (
   select jobid,jobname,schedule,active from cron.job
   where jobname like 'arkhen-%' order by jobid
 )t),
 'statistics_reset',(select stats_reset from pg_stat_database where datname=current_database()),
 'statement_extension',(select n.nspname from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='pg_stat_statements')
) as snapshot;
commit;
