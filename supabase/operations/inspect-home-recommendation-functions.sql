-- Metadata and aggregate durations only; no parameters or private library rows.
with functions as (
select p.proname, pg_get_function_identity_arguments(p.oid) as arguments,
       md5(p.prosrc) as body_md5, p.prosecdef as security_definer, p.proconfig
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in
 ('arkhen_identity_bind','arkhen_home_tv','arkhen_tv_watch_heartbeat','arkhen_movie_recommendations')
order by p.proname
), timings as (

select case
 when query ilike '%arkhen_identity_bind%' then 'identity'
 when query ilike '%arkhen_movie_recommendations%' then 'movie'
 when query ilike '%arkhen_home_tv%' then 'home-tv'
 end as phase, sum(calls) as calls,
 round(sum(total_exec_time)::numeric/nullif(sum(calls),0),1) as mean_ms,
 round(max(max_exec_time)::numeric,1) as max_ms
from extensions.pg_stat_statements
where query not ilike '%pg_stat_statements%' and
 (query ilike '%arkhen_identity_bind%' or query ilike '%arkhen_movie_recommendations%' or query ilike '%arkhen_home_tv%')
group by 1 order by 1
)
select jsonb_build_object('functions',(select coalesce(jsonb_agg(f),'[]') from functions f),
 'timings',(select coalesce(jsonb_agg(t),'[]') from timings t));
