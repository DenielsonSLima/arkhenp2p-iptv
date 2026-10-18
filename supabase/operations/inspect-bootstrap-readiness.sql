-- Read-only bootstrap metadata/counters. No private RPC, parameter, account
-- row, SQL text file or Auth operation is executed/read by this inspection.
begin read only;
set local statement_timeout='5s';
set local lock_timeout='500ms';
set local jit='off';
select jsonb_build_object(
 'observed_at',clock_timestamp(),
 'server_started',pg_postmaster_start_time(),
 'statistics_reset',(select stats_reset from pg_stat_database where datname=current_database()),
 'track_functions',current_setting('track_functions'),
 'application_crons_active',(select count(*) from cron.job where jobname like 'arkhen-%' and active),
 'functions',(select jsonb_agg(jsonb_build_object(
  'name',p.proname,'body_md5',md5(p.prosrc),'security_definer',p.prosecdef,'settings',p.proconfig,
  'anon_execute',has_function_privilege('anon',p.oid,'EXECUTE'),
  'authenticated_execute',has_function_privilege('authenticated',p.oid,'EXECUTE'),
  'service_execute',has_function_privilege('service_role',p.oid,'EXECUTE'),
  'calls',s.calls,'total_ms',s.total_time,'self_ms',s.self_time,
  'definition',case when p.proname in('arkhen_identity_lookup','arkhen_validate_account') then p.prosrc end
 ) order by p.proname) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  left join pg_stat_user_functions s on s.funcid=p.oid
  where n.nspname='public' and p.proname in('arkhen_identity_lookup','arkhen_identity_bind','arkhen_validate_account')),
 'active_waits',(select coalesce(jsonb_agg(t),'[]'::jsonb) from(
  select backend_type,wait_event_type,wait_event,count(*) as count
  from pg_stat_activity where pid<>pg_backend_pid() and state='active'
  group by backend_type,wait_event_type,wait_event limit 8
 ) t)
);
commit;
