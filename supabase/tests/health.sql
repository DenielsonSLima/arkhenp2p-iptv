-- Counts only: no usernames, credentials or personal library contents.
select jsonb_build_object(
  'profiles', (select count(*) from public.profiles),
  'catalog_items', (select count(*) from public.catalog_media where is_active),
  'catalog_snapshots', (select count(*) from public.provider_catalog_cache where is_complete),
  'epg_channels', (select count(*) from public.provider_epg_cache),
  'epg_programs', (select count(*) from public.epg_programs),
  'daily_games_snapshots', (select count(*) from public.provider_games_cache),
  'marker_references', (select count(*) from public.episode_skip_markers),
  'markers_by_verification', (select jsonb_object_agg(t.verification,t.total) from (
    select verification,count(*) as total from public.episode_skip_markers group by verification
  ) t),
  'jobs', (select jsonb_object_agg(t.status,t.total) from (
    select status,count(*) as total from arkhen_private.cache_jobs group by status
  ) t),
  'admin_rls_function_callable_by_clients',
    has_function_privilege('anon','public.rls_auto_enable()','EXECUTE')
    or has_function_privilege('authenticated','public.rls_auto_enable()','EXECUTE')
) as health;
