-- Read a committed checkpoint through MVCC without claiming/changing the
-- writer lease. A writer may be preparing its next fenced checkpoint while
-- metadata readers use the previous committed one and validate its epoch.
begin;

create function public.arkhen_runtime_session_read(p_session_hash text)
returns jsonb language plpgsql stable security invoker
set search_path = '' set lock_timeout = '500ms' set statement_timeout = '3s'
as $$
declare
  v_result jsonb;
begin
  if p_session_hash is null or p_session_hash !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'Invalid runtime session arguments';
  end if;
  select jsonb_build_object('cipher', cipher, 'mediaEpoch', media_epoch,
    'expiresAt', expires_at, 'revision', revision)
  into v_result
  from arkhen_private.runtime_sessions
  where session_hash = p_session_hash and expires_at > clock_timestamp() and cipher is not null;
  return coalesce(v_result, jsonb_build_object('missing', true));
end;
$$;

revoke all on function public.arkhen_runtime_session_read(text) from public, anon, authenticated;
grant execute on function public.arkhen_runtime_session_read(text) to service_role;

commit;
