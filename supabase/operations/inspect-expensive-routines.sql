-- Cumulative Postgres counters, not the Logs Query service. No raw SQL text.
begin read only;
set local statement_timeout='5s';
set local jit='off';
select queryid,calls,round(total_exec_time::numeric,1) as total_ms,
 round(mean_exec_time::numeric,1) as mean_ms,round(max_exec_time::numeric,1) as max_ms,
 rows,substring(query from '(arkhen_[a-z_]{1,80})') as routine
from extensions.pg_stat_statements
where query ~ '^\s*(select|SELECT|WITH|with)\s' and query ~ 'arkhen_[a-z_]+'
order by total_exec_time desc limit 12;
commit;
