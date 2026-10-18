-- One bounded administrative snapshot; no account IDs, private rows,
-- statement text, log API or function invocation is returned.
begin read only;
set local statement_timeout='5s';
set local lock_timeout='500ms';
set local jit='off';
with routines as (
 select p.proname,md5(p.prosrc) body_md5,p.prosecdef security_definer,p.proconfig,
  has_function_privilege('anon',p.oid,'EXECUTE') anon_execute,
  has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated_execute
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname in
 ('arkhen_home_library','arkhen_movie_recommendations','arkhen_home_tv','arkhen_prepare_catalog_read_model')
), timings as (
 select case when query ilike '%arkhen_movie_recommendations%' then 'movies'
  when query ilike '%arkhen_home_library%' then 'home-library'
  when query ilike '%arkhen_home_tv%' then 'home-tv' end domain,
  sum(calls) calls,round(sum(total_exec_time)::numeric/nullif(sum(calls),0),1) mean_ms,
  round(max(max_exec_time)::numeric,1) max_ms,
  sum(shared_blks_read) blocks_read,sum(shared_blks_hit) blocks_hit,
  sum(temp_blks_written) temp_blocks_written
 from extensions.pg_stat_statements
 where query not ilike '%pg_stat_statements%' and
  (query ilike '%arkhen_home_library%' or query ilike '%arkhen_movie_recommendations%' or query ilike '%arkhen_home_tv%')
 group by 1
), sessions as (
 select backend_type,state,wait_event_type,wait_event,count(*) count,
  round(max(extract(epoch from clock_timestamp()-query_start))::numeric,1) oldest_seconds
 from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
 group by backend_type,state,wait_event_type,wait_event
)
select jsonb_build_object('observedAt',clock_timestamp(),'postgresStartedAt',pg_postmaster_start_time(),
 'routines',(select coalesce(jsonb_agg(r),'[]') from routines r),
 'timings',(select coalesce(jsonb_agg(t),'[]') from timings t),
 'sessions',(select coalesce(jsonb_agg(s),'[]') from sessions s));
commit;
