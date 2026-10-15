-- Retain bounded shared metadata history without touching user libraries or
-- catalog snapshots. Current/future schedules and unexpired caches are kept.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '90s';

create index if not exists arkhen_epg_programs_retention on public.epg_programs(end_at);
create index if not exists arkhen_epg_cache_retention on public.provider_epg_cache(updated_at,expires_at);
create index if not exists arkhen_games_cache_retention on public.provider_games_cache(game_date,expires_at);

create or replace function arkhen_private.prune_shared_metadata()
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare programs_removed integer; epg_caches_removed integer; games_caches_removed integer;
begin
  delete from public.epg_programs where end_at < now() - interval '7 days';
  get diagnostics programs_removed=row_count;
  delete from public.provider_epg_cache
    where updated_at < now() - interval '7 days' and expires_at < now();
  get diagnostics epg_caches_removed=row_count;
  delete from public.provider_games_cache
    where game_date < (now() at time zone 'UTC')::date - 30 and expires_at < now();
  get diagnostics games_caches_removed=row_count;
  return jsonb_build_object('epg_programs',programs_removed,'epg_caches',epg_caches_removed,'games_caches',games_caches_removed);
end $$;
revoke all on function arkhen_private.prune_shared_metadata() from public,anon,authenticated;
grant execute on function arkhen_private.prune_shared_metadata() to service_role;
comment on function arkhen_private.prune_shared_metadata() is 'ARKHEN v1: daily shared metadata retention; EPG 7 days, expired games before UTC date minus 30 days; no personal/catalog deletion';

do $cron$
begin
  if exists(select 1 from pg_extension where extname='pg_cron') then
    perform cron.schedule('arkhen-shared-metadata-prune','37 3 * * *','select arkhen_private.prune_shared_metadata();');
  else raise notice 'pg_cron unavailable: schedule arkhen_private.prune_shared_metadata() daily at 03:37 UTC';
  end if;
end $cron$;
commit;
