-- Read-only operational check; it never invokes the pruning function.
select jsonb_build_object(
  'function_exists',to_regprocedure('arkhen_private.prune_shared_metadata()') is not null,
  'security_invoker',not (select p.prosecdef from pg_proc p where p.oid='arkhen_private.prune_shared_metadata()'::regprocedure),
  'anon_can_execute',has_function_privilege('anon','arkhen_private.prune_shared_metadata()','EXECUTE'),
  'authenticated_can_execute',has_function_privilege('authenticated','arkhen_private.prune_shared_metadata()','EXECUTE'),
  'service_role_can_execute',has_function_privilege('service_role','arkhen_private.prune_shared_metadata()','EXECUTE'),
  'cron',(select jsonb_agg(to_jsonb(j)) from (select jobname,schedule,active from cron.job where jobname='arkhen-shared-metadata-prune') j)
) as retention;
