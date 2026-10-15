select jsonb_build_object(
  'tables', (select jsonb_agg(to_jsonb(t) order by t.schema,t.table_name) from (
    select n.nspname as schema,c.relname as table_name,c.relrowsecurity as rls_enabled,
      exists(select 1 from pg_publication_tables p where p.pubname='supabase_realtime'
        and p.schemaname=n.nspname and p.tablename=c.relname) as realtime_enabled
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where c.relkind='r' and n.nspname in ('public','arkhen_private')
  ) t),
  'cron', (select jsonb_agg(to_jsonb(j) order by j.jobname) from (
    select jobname,schedule,active from cron.job where jobname like 'arkhen-%'
  ) j),
  'audit_fixtures_remaining', (select count(*) from auth.users
    where id in ('ffffffff-ffff-4fff-8fff-ffffffffffa1','ffffffff-ffff-4fff-8fff-ffffffffffb2'))
) as inventory;
