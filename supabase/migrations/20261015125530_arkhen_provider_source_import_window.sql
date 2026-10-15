-- A first catalog import can outlive the previous 30 minute source window.
-- The gateway also caps this lease by the provider account/JWT expiration.
begin;
set local lock_timeout='5s';
create or replace function public.arkhen_source_put(p_provider_key text,p_scope_hash text,p_source_id text,p_cipher jsonb,p_expires_at timestamptz)
returns void language plpgsql security invoker set search_path='' as $$
begin
  if p_expires_at is null or p_expires_at<=now() or p_expires_at>now()+interval '121 minutes' or arkhen_private.source_cipher_valid(p_cipher) is distinct from true then raise exception 'Invalid encrypted source';end if;
  insert into arkhen_private.provider_sources(provider_key,scope_hash,source_id,cipher,expires_at)
  values(p_provider_key,p_scope_hash,p_source_id,p_cipher,p_expires_at)
  on conflict(provider_key,scope_hash,source_id) do update set cipher=excluded.cipher,expires_at=excluded.expires_at,updated_at=now();
  delete from arkhen_private.provider_sources where expires_at<now();
end $$;
revoke all on function public.arkhen_source_put(text,text,text,jsonb,timestamptz) from public,anon,authenticated;
grant execute on function public.arkhen_source_put(text,text,text,jsonb,timestamptz) to service_role;
notify pgrst,'reload schema';
commit;
