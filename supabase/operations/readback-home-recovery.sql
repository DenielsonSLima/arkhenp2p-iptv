-- Schema/privileges only: do not execute private RPCs or read watch rows.
with functions as (
 select n.nspname,p.proname,md5(p.prosrc) as body_md5,p.prosecdef,p.proconfig,
 has_function_privilege('anon',p.oid,'EXECUTE') as anon_execute,
 has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_execute,
 has_function_privilege('service_role',p.oid,'EXECUTE') as service_execute
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where (n.nspname='public' and p.proname in
  ('arkhen_identity_bind','arkhen_home_tv','arkhen_tv_watch_heartbeat','arkhen_movie_recommendations'))
 or (n.nspname='arkhen_private' and p.proname='tv_watch_span_milliseconds')
), tables as (
 select c.relname,c.relrowsecurity,
 has_table_privilege('anon',c.oid,'SELECT') as anon_select,
 has_table_privilege('authenticated',c.oid,'SELECT') as authenticated_select,
 has_table_privilege('authenticated',c.oid,'INSERT') as authenticated_insert,
 (select bool_and(i.indisvalid and i.indisready) from pg_index i where i.indrelid=c.oid) as indexes_ready
 from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='arkhen_private' and c.relname='user_tv_watch_buckets'
)
select jsonb_build_object('functions',(select jsonb_agg(f) from functions f),
 'tables',(select jsonb_agg(t) from tables t));
