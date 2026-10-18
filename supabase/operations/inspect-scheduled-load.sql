-- Metadata and activity only, without cron history or log scans.
select jsonb_build_object(
 'observed_at',clock_timestamp(),
 'cron',(select jsonb_agg(t) from (select jobid,jobname,schedule,active from cron.job where jobname like 'arkhen-%' order by jobid)t),
 'active',(select coalesce(jsonb_agg(t),'[]'::jsonb) from (
  select backend_type,wait_event_type,wait_event,
   round(extract(epoch from(clock_timestamp()-query_start))::numeric,1) as seconds,
   coalesce(substring(query from '(arkhen_private\.[a-z_]{1,80})'),substring(query from '(arkhen_[a-z_]{1,80})')) as routine
  from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and state='active'
  order by query_start limit 12
 )t),
 'private_costs',(select jsonb_agg(t) from (
  select calls,round(mean_exec_time::numeric,1) as mean_ms,
   substring(query from '(arkhen_private\.[a-z_]{1,80})') as routine
  from extensions.pg_stat_statements where queryid in(2073228433068969532,8212580662467090949)
 )t)
) as snapshot;
