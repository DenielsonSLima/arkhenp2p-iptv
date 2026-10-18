-- pg_stat_statements counters: no log scan, query literals or task invocation.
begin read only;
set local statement_timeout='5s';
set local lock_timeout='500ms';
set local jit='off';
select clock_timestamp() as observed_at,s.queryid,r.rolname,s.calls,
 round(s.total_exec_time::numeric,1) as total_ms,
 round(s.mean_exec_time::numeric,1) as mean_ms,
 s.shared_blks_read,s.shared_blks_hit,s.temp_blks_read,s.temp_blks_written,
 coalesce(substring(s.query from '(arkhen_private\.[a-z_]{1,80})'),
  substring(s.query from '(arkhen_[a-z_]{1,80})')) as arkhen_routine,
 s.query ilike '%pg_stat_statements%' as reads_statement_statistics,
 s.query ilike '%pg_stat_activity%' as reads_activity,
 s.query ilike '%pg_database_size%' as reads_database_size,
 s.query ilike '%pg_total_relation_size%' as reads_relation_size,
 s.query ilike '%realtime.%' as realtime_work
from extensions.pg_stat_statements s
left join pg_roles r on r.oid=s.userid
order by s.total_exec_time desc limit 15;
commit;
