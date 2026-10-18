-- Read-only, catalog/statistics only: no accounts, queries or payloads returned.
begin read only;
set local statement_timeout='3s';
set local lock_timeout='500ms';
set local jit='off';
select s.schemaname as schema,s.relname as name,
 pg_total_relation_size(s.relid) as total_bytes,
 pg_table_size(s.relid) as table_and_toast_bytes,
 pg_indexes_size(s.relid) as index_bytes,
 s.n_live_tup as estimated_live_rows,s.n_dead_tup as estimated_dead_rows,
 s.last_autovacuum,s.last_autoanalyze
from pg_stat_user_tables s
order by pg_total_relation_size(s.relid) desc limit 12;
select backend_type,state,wait_event_type,count(*) as connections,
 round(max(extract(epoch from (clock_timestamp()-query_start)))::numeric,1) as longest_query_seconds
from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
group by backend_type,state,wait_event_type order by connections desc limit 15;
commit;
