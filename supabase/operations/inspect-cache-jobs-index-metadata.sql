-- Catalog metadata only; reltuples is an estimate, never COUNT(*) on the queue.
set statement_timeout='5s';
select c.reltuples::bigint as estimated_rows,i.indexrelid::regclass::text as index_name,
 pg_get_indexdef(i.indexrelid) as definition
from pg_class c join pg_index i on i.indrelid=c.oid
where c.oid='arkhen_private.cache_jobs'::regclass order by index_name;
