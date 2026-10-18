-- Minimal incident read; do not run in a polling loop.
begin read only;
set local statement_timeout='5s';
set local lock_timeout='500ms';
select clock_timestamp() as observed_at,pid,backend_type,state,wait_event_type,wait_event,
 round(extract(epoch from (clock_timestamp()-query_start))::numeric,1) as seconds,
 substring(query from '(arkhen_[a-z_]{1,80})') as arkhen_routine
from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
 and state='active' order by query_start limit 12;
commit;
