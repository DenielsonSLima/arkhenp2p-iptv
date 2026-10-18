-- Do not invoke the network collector when its claim would return no work.
-- Keep the existing source capability, sealed EPG and lease rules unchanged.
-- This migration does not activate, reschedule or execute any cron job.
begin;
set local lock_timeout='3s';
set local statement_timeout='10s';

do $baseline$
begin
 if (select md5(prosrc) from pg_proc where oid='arkhen_private.kick_cloud_collector()'::regprocedure)
  is distinct from 'a5c2ded0ce848d39f38222adcda246e9'
  or (select md5(prosrc) from pg_proc where oid='public.arkhen_prepare_home_identities(integer)'::regprocedure)
  is distinct from 'ee1081f2d330e05c03039280965af02d' then
  raise exception 'Collector or Home definition changed; inspect before applying';
 end if;
end $baseline$;

create or replace function arkhen_private.kick_cloud_collector()
returns boolean language plpgsql security definer set search_path='' as $$
declare secret text;request_id bigint;
begin
 if not exists(
  select 1 from arkhen_private.cache_jobs j
  where ((j.status='queued' and j.run_after<=now()) or (j.status='leased' and j.lease_until<now()))
   and j.attempts<8
   and exists(select 1 from arkhen_private.cache_sources s
    where s.provider_key=j.provider_key and s.scope_hash=j.scope_hash and s.enabled)
   and (exists(select 1 from arkhen_private.provider_sources s
     where s.provider_key=j.provider_key and s.scope_hash=j.scope_hash and s.expires_at>now())
    or (j.job_type='epg' and exists(select 1 from arkhen_private.epg_snapshot_candidates c
     where c.job_id=j.id and c.state in('sealed','published','superseded'))))
 ) and not exists(
  -- The claim also finalizes exhausted leases. Let that maintenance
  -- path run so these rows cannot retain the one-active-job slot indefinitely.
  select 1 from arkhen_private.cache_jobs j
  where j.status='leased' and j.lease_until<now() and j.attempts>=8
 ) then return false;end if;
 if to_regclass('vault.decrypted_secrets') is null then return false;end if;
 select decrypted_secret into secret from vault.decrypted_secrets where name='arkhen_collector_secret' limit 1;
 if secret is null or length(secret)<32 then return false;end if;
 update arkhen_private.cloud_collector_clock set last_kick_at=now()
 where id and(last_kick_at is null or last_kick_at<now()-interval '10 seconds');
 if not found then return false;end if;
 select net.http_post(
  url:='https://wnicimkmzswksaqdtgdv.supabase.co/functions/v1/arkhen-catalog-sync',
  headers:=jsonb_build_object('Content-Type','application/json','x-arkhen-collector-secret',secret),
  body:='{}'::jsonb,timeout_milliseconds:=55000) into request_id;
 return request_id is not null;
end $$;
revoke all on function arkhen_private.kick_cloud_collector() from public,anon,authenticated;
grant execute on function arkhen_private.kick_cloud_collector() to service_role;

-- The BEFORE INSERT / metadata UPDATE trigger already handles new rows.
-- Backfill only old, published rows, at most 50 in one transaction. Preserve
-- the former 1..1000 argument contract for existing callers, including cron.
create or replace function public.arkhen_prepare_home_identities(p_limit integer default 50)
returns integer language plpgsql security invoker set search_path=''
 set statement_timeout='20s' set jit='off' as $$
declare affected integer;
begin
 if p_limit is null or p_limit not between 1 and 1000 then
  raise exception 'Invalid home preparation batch' using errcode='22023';
 end if;
 if not pg_try_advisory_xact_lock(hashtext('arkhen-home-identities')) then return 0;end if;
 with pending as materialized(
  select m.ctid from public.catalog_media m
  where m.home_identity is null and m.is_active
   and exists(select 1 from public.catalog_visible_generations g
    where(g.provider_key,g.scope_hash,g.media_type,g.generation_id)=
     (m.provider_key,m.scope_hash,m.media_type,m.generation_id))
  order by m.provider_key,m.scope_hash,m.media_type,m.generation_id,m.media_id
  limit least(p_limit,50) for update of m skip locked
 )
 update public.catalog_media m
 set home_identity=public.arkhen_home_title_identity(
  case m.media_type when 'movies' then 'movie' else m.media_type end,m.metadata)
 from pending p where m.ctid=p.ctid;
 get diagnostics affected=row_count;
 return affected;
end $$;
revoke all on function public.arkhen_prepare_home_identities(integer) from public,anon,authenticated;
grant execute on function public.arkhen_prepare_home_identities(integer) to service_role;

notify pgrst,'reload schema';
commit;
