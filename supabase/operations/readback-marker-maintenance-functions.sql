-- Definition/configuration readback only. No metrics/discovery invocation or
-- private source/queue scan. Compare MD5 to the reviewed migration bodies.
set statement_timeout='5s';
select p.oid::regprocedure::text as signature,md5(p.prosrc) as body_md5,
 p.prosecdef as security_definer,p.proconfig,
 has_function_privilege('anon',p.oid,'EXECUTE') as anon_execute,
 has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_execute,
 has_function_privilege('service_role',p.oid,'EXECUTE') as service_execute
from pg_proc p where p.oid in(
 to_regprocedure('public.arkhen_refresh_marker_sync_metrics()'),
 to_regprocedure('public.arkhen_marker_discover(integer)'),
 to_regprocedure('public.arkhen_marker_discover_batch(integer)')
)order by signature;
