-- Definition/catalog readback only: does not execute the optimized routines.
select n.nspname as schema,p.proname as routine,md5(p.prosrc) as body_md5,p.proconfig,
 position('catalog_cleanup_cursors' in p.prosrc)>0 as bounded_cleanup,
 position('j.attempts<8' in p.prosrc)>0 as checks_eligible_work,
 position('least(p_limit,50)' in p.prosrc)>0 as home_batch_capped
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where p.oid in('public.arkhen_cleanup_catalog_generations(integer)'::regprocedure,
 'arkhen_private.kick_cloud_collector()'::regprocedure,
 'public.arkhen_prepare_home_identities(integer)'::regprocedure)
order by p.proname;
