-- Numeric statistics without loading the pg_stat_statements query-text file.
begin read only;
set local statement_timeout='5s';
set local jit='off';
select clock_timestamp() as observed_at,s.queryid,s.calls,
 s.total_exec_time as total_ms,s.shared_blks_read,s.shared_blks_hit,
 s.temp_blks_read,s.temp_blks_written
from extensions.pg_stat_statements(false) s
where s.queryid in(-7381786608392519706,6475106387195042014,2741319960202986103,
 5524309180557249339,2073228433068969532,8212580662467090949,
 -8212237553579936383,3573439873717491452)
order by s.queryid;
commit;
