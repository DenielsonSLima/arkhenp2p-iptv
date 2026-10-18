-- Existing bindings are read-only: reconnecting a device must not contend
-- with catalogue/collector writers on a cache_sources row it already owns.
-- This service-only operation does not validate account status or mint JWTs;
-- arkhen_validate_account and Auth verification still run on every bootstrap.
begin;
set local lock_timeout='5s';
set local statement_timeout='15s';

create or replace function public.arkhen_identity_bind(
 p_library_hash text,p_user_id uuid,p_provider text,p_provider_key text,p_scope_hash text
) returns void language plpgsql security invoker set search_path=''
 set statement_timeout='3s' set lock_timeout='500ms' set jit='off' as $$
begin
 if p_library_hash is null or p_library_hash !~ '^[a-f0-9]{64}$' or p_user_id is null
  or p_provider is null or p_provider not in('wplay','wplay-ott')
  or p_provider_key is null or p_provider_key !~ '^[a-f0-9]{64}$'
  or p_scope_hash is null or p_scope_hash !~ '^[a-f0-9]{64}$' then
  raise exception 'Invalid provider identity' using errcode='22023';
 end if;
 if exists(
  select 1 from arkhen_private.provider_identities i
  join public.profiles p on p.id=i.user_id
  join arkhen_private.cache_sources s on(s.provider_key,s.scope_hash)=(p_provider_key,p_scope_hash)
  where(i.library_hash,i.user_id,i.provider,i.provider_key)=(p_library_hash,p_user_id,p_provider,p_provider_key)
   and(p.library_hash,p.provider,p.provider_key,p.scope_hash)=(p_library_hash,p_provider,p_provider_key,p_scope_hash)
   and s.provider=p_provider
 ) then return;end if;

 -- Partial/new provisioning keeps conflict checks; the fast path cannot bind
 -- another owner, provider, library or partition to this existing identity.
 insert into arkhen_private.provider_identities(library_hash,user_id,provider,provider_key)
 values(p_library_hash,p_user_id,p_provider,p_provider_key) on conflict(library_hash) do nothing;
 if not exists(select 1 from arkhen_private.provider_identities i
  where(i.library_hash,i.user_id,i.provider,i.provider_key)=(p_library_hash,p_user_id,p_provider,p_provider_key)) then
  raise exception 'Provider identity conflict' using errcode='23505';
 end if;
 insert into public.profiles(id,provider,provider_key,scope_hash,library_hash)
 values(p_user_id,p_provider,p_provider_key,p_scope_hash,p_library_hash) on conflict(id) do nothing;
 if not exists(select 1 from public.profiles p where(p.id,p.provider,p.library_hash)=(p_user_id,p_provider,p_library_hash)) then
  raise exception 'Profile identity conflict' using errcode='23505';
 end if;
 if not exists(select 1 from arkhen_private.cache_sources s where(s.provider_key,s.scope_hash,s.provider)=(p_provider_key,p_scope_hash,p_provider)) then
  insert into arkhen_private.cache_sources(provider_key,scope_hash,provider)
  values(p_provider_key,p_scope_hash,p_provider) on conflict do nothing;
  if not exists(select 1 from arkhen_private.cache_sources s where(s.provider_key,s.scope_hash,s.provider)=(p_provider_key,p_scope_hash,p_provider)) then
   raise exception 'Provider source conflict' using errcode='23505';
  end if;
 end if;
end $$;

revoke all on function public.arkhen_identity_bind(text,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.arkhen_identity_bind(text,uuid,text,text,text) to service_role;
notify pgrst,'reload schema';
commit;
