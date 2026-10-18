-- Private, encrypted application runtime. No credentials or media are exposed
-- through a public table; only the trusted service role calls these RPCs.
begin;

create schema if not exists arkhen_private;
revoke all on schema arkhen_private from public, anon, authenticated;
grant usage on schema arkhen_private to service_role;

create table arkhen_private.runtime_sessions (
  session_hash text primary key check (session_hash ~ '^[a-f0-9]{64}$'),
  cipher text check (cipher is null or (octet_length(cipher) <= 4194304
    and cipher ~ '^v1[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+$')),
  media_epoch text check (media_epoch is null or media_epoch ~ '^[a-f0-9]{64}$'),
  revision bigint not null default 0 check (revision >= 0),
  fence bigint not null default 0 check (fence >= 0),
  owner uuid,
  lease_until timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null default (clock_timestamp() + interval '24 hours'),
  updated_at timestamptz not null default clock_timestamp(),
  check ((owner is null) = (lease_until is null))
);
create index runtime_sessions_expiry_idx on arkhen_private.runtime_sessions (expires_at, session_hash);
alter table arkhen_private.runtime_sessions enable row level security;
revoke all on arkhen_private.runtime_sessions from public, anon, authenticated;
grant select, insert, update, delete on arkhen_private.runtime_sessions to service_role;

create function public.arkhen_runtime_session_acquire(p_session_hash text, p_owner uuid, p_create boolean default false)
returns jsonb language plpgsql security invoker
set search_path = '' set lock_timeout = '500ms' set statement_timeout = '3s'
as $$
declare
  v_row arkhen_private.runtime_sessions%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if p_session_hash is null or p_session_hash !~ '^[a-f0-9]{64}$' or p_owner is null or p_create is null then
    raise exception using errcode = '22023', message = 'Invalid runtime session arguments';
  end if;
  -- At most eight obsolete rows per request, using the expiry index and never
  -- waiting for rows currently owned by another transaction. No cron/polling.
  delete from arkhen_private.runtime_sessions
  where session_hash in (
    select session_hash from arkhen_private.runtime_sessions
    where expires_at <= v_now and session_hash <> p_session_hash
    order by expires_at, session_hash limit 8 for update skip locked
  );
  select * into v_row from arkhen_private.runtime_sessions
  where session_hash = p_session_hash for update;
  if not found then
    if not p_create then return jsonb_build_object('missing', true); end if;
    insert into arkhen_private.runtime_sessions (session_hash) values (p_session_hash)
      on conflict (session_hash) do nothing;
    select * into v_row from arkhen_private.runtime_sessions
      where session_hash = p_session_hash for update;
  end if;
  v_now := clock_timestamp();
  if v_row.expires_at <= v_now then
    if not p_create then return jsonb_build_object('missing', true); end if;
    update arkhen_private.runtime_sessions
    set cipher = null, media_epoch = null, revision = 0, owner = null, lease_until = null,
      created_at = v_now, expires_at = v_now + interval '24 hours', updated_at = v_now
    where session_hash = p_session_hash returning * into v_row;
  end if;
  if v_row.owner is not null and v_row.owner <> p_owner and v_row.lease_until > v_now then
    return jsonb_build_object('busy', true, 'retryAfterMs', 250);
  end if;
  update arkhen_private.runtime_sessions
  set owner = p_owner, fence = fence + 1, lease_until = v_now + interval '90 seconds', updated_at = v_now
  where session_hash = p_session_hash returning * into v_row;
  return jsonb_build_object('revision', v_row.revision, 'fence', v_row.fence,
    'leaseUntil', v_row.lease_until, 'expiresAt', v_row.expires_at, 'cipher', v_row.cipher);
exception when lock_not_available then
  return jsonb_build_object('busy', true, 'retryAfterMs', 250);
end;
$$;

create function public.arkhen_runtime_session_renew(p_session_hash text, p_owner uuid, p_fence bigint)
returns jsonb language plpgsql security invoker
set search_path = '' set lock_timeout = '500ms' set statement_timeout = '3s'
as $$
declare
  v_row arkhen_private.runtime_sessions%rowtype;
  v_now timestamptz;
  v_until timestamptz;
begin
  if p_session_hash is null or p_session_hash !~ '^[a-f0-9]{64}$' or p_owner is null or p_fence is null or p_fence < 1 then
    raise exception using errcode = '22023', message = 'Invalid runtime session arguments';
  end if;
  select * into v_row from arkhen_private.runtime_sessions
    where session_hash = p_session_hash for update;
  if not found then return jsonb_build_object('ok', false, 'conflict', true); end if;
  v_now := clock_timestamp();
  if v_row.owner is distinct from p_owner or v_row.fence <> p_fence
    or v_row.lease_until is null or v_row.lease_until <= v_now or v_row.expires_at <= v_now then
    return jsonb_build_object('ok', false, 'conflict', true);
  end if;
  update arkhen_private.runtime_sessions
  set lease_until = v_now + interval '90 seconds', updated_at = v_now
  where session_hash = p_session_hash and owner = p_owner and fence = p_fence
    and lease_until > clock_timestamp() and expires_at > clock_timestamp()
  returning lease_until into v_until;
  if not found then return jsonb_build_object('ok', false, 'conflict', true); end if;
  return jsonb_build_object('ok', true, 'leaseUntil', v_until);
exception when lock_not_available then
  return jsonb_build_object('ok', false, 'conflict', true);
end;
$$;

create function public.arkhen_runtime_session_commit(p_session_hash text, p_owner uuid, p_fence bigint,
  p_revision bigint, p_cipher text default null, p_release boolean default true, p_media_epoch text default null)
returns jsonb language plpgsql security invoker
set search_path = '' set lock_timeout = '500ms' set statement_timeout = '3s'
as $$
declare
  v_row arkhen_private.runtime_sessions%rowtype;
  v_now timestamptz;
  v_revision bigint;
begin
  if p_session_hash is null or p_session_hash !~ '^[a-f0-9]{64}$' or p_owner is null
    or p_fence is null or p_fence < 1 or p_revision is null or p_revision < 0 or p_release is null
    or (p_media_epoch is not null and p_media_epoch !~ '^[a-f0-9]{64}$')
    or (p_cipher is not null and (octet_length(p_cipher) > 4194304
      or p_cipher !~ '^v1[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+$')) then
    raise exception using errcode = '22023', message = 'Invalid runtime session arguments';
  end if;
  select * into v_row from arkhen_private.runtime_sessions
    where session_hash = p_session_hash for update;
  if not found then return jsonb_build_object('ok', false, 'conflict', true); end if;
  v_now := clock_timestamp();
  if v_row.owner is distinct from p_owner or v_row.fence <> p_fence or v_row.revision <> p_revision
    or v_row.lease_until is null or v_row.lease_until <= v_now or v_row.expires_at <= v_now then
    return jsonb_build_object('ok', false, 'conflict', true);
  end if;
  update arkhen_private.runtime_sessions
  set cipher = coalesce(p_cipher, cipher),
    media_epoch = p_media_epoch,
    revision = revision + case when p_cipher is not null and p_cipher is distinct from cipher then 1 else 0 end,
    owner = case when p_release then null else owner end,
    lease_until = case when p_release then null else v_now + interval '90 seconds' end,
    updated_at = v_now
  where session_hash = p_session_hash and owner = p_owner and fence = p_fence and revision = p_revision
    and lease_until > clock_timestamp() and expires_at > clock_timestamp()
  returning revision into v_revision;
  if not found then return jsonb_build_object('ok', false, 'conflict', true); end if;
  return jsonb_build_object('ok', true, 'revision', v_revision, 'fence', p_fence);
exception when lock_not_available then
  return jsonb_build_object('ok', false, 'conflict', true);
end;
$$;

-- Active HTTP bodies can check revocation across server instances without
-- acquiring a session lease or transferring its encrypted runtime payload.
create function public.arkhen_runtime_session_media(p_session_hash text, p_media_epoch text)
returns jsonb language plpgsql security invoker
set search_path = '' set lock_timeout = '500ms' set statement_timeout = '3s'
as $$
begin
  if p_session_hash is null or p_session_hash !~ '^[a-f0-9]{64}$'
    or p_media_epoch is null or p_media_epoch !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'Invalid runtime media arguments';
  end if;
  return jsonb_build_object('ok', exists (
    select 1 from arkhen_private.runtime_sessions
    where session_hash = p_session_hash and media_epoch = p_media_epoch and expires_at > clock_timestamp()
  ));
end;
$$;

revoke all on function public.arkhen_runtime_session_acquire(text, uuid, boolean) from public, anon, authenticated;
revoke all on function public.arkhen_runtime_session_renew(text, uuid, bigint) from public, anon, authenticated;
revoke all on function public.arkhen_runtime_session_commit(text, uuid, bigint, bigint, text, boolean, text) from public, anon, authenticated;
revoke all on function public.arkhen_runtime_session_media(text, text) from public, anon, authenticated;
grant execute on function public.arkhen_runtime_session_acquire(text, uuid, boolean) to service_role;
grant execute on function public.arkhen_runtime_session_renew(text, uuid, bigint) to service_role;
grant execute on function public.arkhen_runtime_session_commit(text, uuid, bigint, bigint, text, boolean, text) to service_role;
grant execute on function public.arkhen_runtime_session_media(text, text) to service_role;

commit;
