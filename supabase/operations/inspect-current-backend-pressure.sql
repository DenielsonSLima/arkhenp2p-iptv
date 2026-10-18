-- Catalog metadata only. Classify SQL without returning statements or literals.
begin read only;
set local statement_timeout='5s';
set local lock_timeout='500ms';
set local jit='off';
select clock_timestamp() as observed_at,pid,usename,application_name,
 backend_type,state,wait_event_type,wait_event,
 round(extract(epoch from(clock_timestamp()-query_start))::numeric,1) as seconds,
 md5(query) as statement_hash,length(query) as statement_length,
 coalesce(substring(query from '(arkhen_private\.[a-z_]{1,80})'),
  substring(query from '(arkhen_[a-z_]{1,80})')) as arkhen_routine,
 query ilike '%pg_stat_statements%' as reads_statement_statistics,
 query ilike '%pg_stat_activity%' as reads_activity,
 query ilike '%order by%' as has_sort,
 query ilike '%pg_database_size%' as reads_database_size,
 query ilike '%pg_total_relation_size%' as reads_relation_size,
 query ilike '%realtime.%' as realtime_work,
 pg_blocking_pids(pid) as blocking_pids
from pg_stat_activity
where datname=current_database() and pid<>pg_backend_pid()
 and state='active'
order by query_start limit 12;
commit;
