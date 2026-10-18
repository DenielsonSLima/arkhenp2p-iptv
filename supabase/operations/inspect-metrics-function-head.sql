begin read only;
set local statement_timeout='3s';
set local jit='off';
select p.oid::regprocedure::text routine,md5(p.prosrc) body_md5,p.proconfig,
 has_function_privilege('anon',p.oid,'EXECUTE') anon_execute,
 has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated_execute,
 has_function_privilege('service_role',p.oid,'EXECUTE') service_execute
from pg_proc p where p.oid='public.arkhen_refresh_marker_sync_metrics()'::regprocedure;
commit;
