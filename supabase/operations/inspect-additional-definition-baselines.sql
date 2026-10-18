-- Only routine metadata; does not invoke TV, marker or privacy operations.
select n.nspname as schema,p.proname as routine,md5(p.prosrc) as body_md5,p.prosecdef,p.proconfig
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where p.oid in('arkhen_private.refresh_tv_guide(text,text,boolean,text)'::regprocedure,
 'public.arkhen_refresh_marker_sync_metrics()'::regprocedure,
 'public.arkhen_prune_adult_progress(integer)'::regprocedure,
 'arkhen_private.arkhen_schedule_marker_sync()'::regprocedure)
order by p.proname;
