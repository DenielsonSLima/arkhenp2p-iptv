-- Cancel only the exact cleanup backend observed at 23:55:52 UTC on 16/10.
-- A cancelled cleanup rolls its transaction back. Never terminate the backend.
-- PID reuse, another statement or a finished invocation produces zero changes.
select pid,pg_cancel_backend(pid) as cancelled
from pg_stat_activity
where datname=current_database() and pid=79904 and state='active'
 and query_start between timestamptz '2026-10-16 23:54:03+00' and timestamptz '2026-10-16 23:54:06+00'
 and query ~ '^\s*select\s+public\.arkhen_cleanup_catalog_generations\(500\);?\s*$';
