-- Metadata only: no programme/channel/account contents, no cache warming.
select jsonb_build_object(
 'functions',(select jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_object('md5',md5(p.prosrc),'securityDefiner',p.prosecdef,'config',p.proconfig,
  'serviceExecute',has_function_privilege('service_role',p.oid,'EXECUTE'),'anonExecute',has_function_privilege('anon',p.oid,'EXECUTE'),'authenticatedExecute',has_function_privilege('authenticated',p.oid,'EXECUTE'))) from pg_proc p where p.oid in(
  to_regprocedure('public.arkhen_tv_guide(text,text,text[],boolean,text)'),to_regprocedure('arkhen_private.refresh_tv_guide(text,text,boolean,text)'),to_regprocedure('public.arkhen_tick_tv_guides()'))),
 'windowCache',(select jsonb_build_object('exists',true,'rls',c.relrowsecurity,'anonSelect',has_table_privilege('anon',c.oid,'SELECT'),'authenticatedSelect',has_table_privilege('authenticated',c.oid,'SELECT'),'serviceSelect',has_table_privilege('service_role',c.oid,'SELECT')) from pg_class c where c.oid=to_regclass('arkhen_private.epg_channel_windows')),
 'clockActive',(select bool_or(active) from cron.job where jobname='arkhen-tv-guide-clock'),
 'snapshotPublisherUnchanged',(select md5(prosrc) from pg_proc where oid=to_regprocedure('public.arkhen_epg_snapshot_publish(uuid,text)'))
);
