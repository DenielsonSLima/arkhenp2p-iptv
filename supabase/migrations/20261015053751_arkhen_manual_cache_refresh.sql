begin;
-- Explicit user refresh requests still produce one shared, leased worker job.
-- They do not reset the automatic cadence or run an upstream fetch per user.
create or replace function public.arkhen_request_cache_refresh(p_provider_key text,p_scope_hash text,p_job_type text,p_payload jsonb default '{}')
returns integer language plpgsql security invoker set search_path = '' as $$
declare inserted integer;
begin
  if p_job_type not in ('catalog','epg','games') or not arkhen_private.safe_shared_payload(p_payload) then raise exception 'Invalid cache refresh request';end if;
  if not exists(select 1 from arkhen_private.cache_sources s where s.provider_key=p_provider_key and s.scope_hash=p_scope_hash and s.enabled) then return 0;end if;
  if exists(select 1 from arkhen_private.cache_jobs j where j.provider_key=p_provider_key and j.scope_hash=p_scope_hash and j.job_type=p_job_type and j.created_at>now()-interval '60 seconds') then return 0;end if;
  insert into arkhen_private.cache_jobs(provider_key,scope_hash,job_type,payload) values(p_provider_key,p_scope_hash,p_job_type,p_payload) on conflict do nothing;
  get diagnostics inserted=row_count;return inserted;
end $$;
revoke all on function public.arkhen_request_cache_refresh(text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.arkhen_request_cache_refresh(text,text,text,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
