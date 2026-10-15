-- Only encrypted, expiring provider access tokens and artwork references.
-- Account passwords are neither accepted by these RPCs nor persisted.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

create table if not exists arkhen_private.provider_sources (
  provider_key text not null check(provider_key~'^[a-f0-9]{64}$'),
  scope_hash text not null check(scope_hash~'^[a-f0-9]{64}$'),
  source_id text not null check(source_id~'^[a-f0-9]{64}$'),
  cipher jsonb not null check(octet_length(cipher::text)<=131072),
  expires_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key(provider_key,scope_hash,source_id)
);
create index if not exists arkhen_provider_sources_expiry on arkhen_private.provider_sources(expires_at);
create table if not exists arkhen_private.artwork_sources (
  provider_key text not null check(provider_key~'^[a-f0-9]{64}$'),
  scope_hash text not null check(scope_hash~'^[a-f0-9]{64}$'),
  ref text not null check(ref~'^[a-f0-9]{64}$'),
  cipher jsonb not null check(octet_length(cipher::text)<=32768),
  expires_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key(provider_key,scope_hash,ref)
);
create index if not exists arkhen_artwork_sources_expiry on arkhen_private.artwork_sources(expires_at);
alter table arkhen_private.provider_sources enable row level security;
alter table arkhen_private.artwork_sources enable row level security;
revoke all on arkhen_private.provider_sources,arkhen_private.artwork_sources from public,anon,authenticated;
grant all on arkhen_private.provider_sources,arkhen_private.artwork_sources to service_role;

create or replace function arkhen_private.source_cipher_valid(p_cipher jsonb)
returns boolean language sql immutable security invoker set search_path='' as $$
  select jsonb_typeof(p_cipher)='object' and p_cipher->>'version'='1'
    and coalesce(p_cipher->>'iv','')~'^[A-Za-z0-9_-]{16}$'
    and length(coalesce(p_cipher->>'ciphertext','')) between 22 and 131000
    and coalesce(p_cipher->>'ciphertext','')~'^[A-Za-z0-9_-]+$'
    and not exists(select 1 from jsonb_object_keys(p_cipher) k where k not in ('version','iv','ciphertext'))
$$;
revoke all on function arkhen_private.source_cipher_valid(jsonb) from public,anon,authenticated;
grant execute on function arkhen_private.source_cipher_valid(jsonb) to service_role;

create or replace function public.arkhen_source_put(p_provider_key text,p_scope_hash text,p_source_id text,p_cipher jsonb,p_expires_at timestamptz)
returns void language plpgsql security invoker set search_path='' as $$
begin
  if p_expires_at is null or p_expires_at<=now() or p_expires_at>now()+interval '31 minutes' or arkhen_private.source_cipher_valid(p_cipher) is distinct from true then raise exception 'Invalid encrypted source';end if;
  insert into arkhen_private.provider_sources(provider_key,scope_hash,source_id,cipher,expires_at)
  values(p_provider_key,p_scope_hash,p_source_id,p_cipher,p_expires_at)
  on conflict(provider_key,scope_hash,source_id) do update set cipher=excluded.cipher,expires_at=excluded.expires_at,updated_at=now();
  delete from arkhen_private.provider_sources where expires_at<now();
end $$;
create or replace function public.arkhen_source_get(p_provider_key text,p_scope_hash text)
returns jsonb language sql stable security invoker set search_path='' as $$
  select to_jsonb(source) from arkhen_private.provider_sources source
  where source.provider_key=p_provider_key and source.scope_hash=p_scope_hash and source.expires_at>now()
  order by source.updated_at desc limit 1
$$;
create or replace function public.arkhen_artwork_put_batch(p_rows jsonb)
returns integer language plpgsql security invoker set search_path='' as $$
declare changed integer;
begin
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows)>1000 or octet_length(p_rows::text)>4194304 then raise exception 'Invalid artwork source batch';end if;
  if exists(select 1 from jsonb_array_elements(p_rows) r where arkhen_private.source_cipher_valid(r->'cipher') is distinct from true or (r->>'expires_at')::timestamptz<=now() or (r->>'expires_at')::timestamptz>now()+interval '25 hours') then raise exception 'Invalid encrypted artwork';end if;
  insert into arkhen_private.artwork_sources(provider_key,scope_hash,ref,cipher,expires_at)
  select provider_key,scope_hash,ref,cipher,expires_at from jsonb_to_recordset(p_rows) as r(provider_key text,scope_hash text,ref text,cipher jsonb,expires_at timestamptz)
  on conflict(provider_key,scope_hash,ref) do update set cipher=excluded.cipher,expires_at=excluded.expires_at,updated_at=now();
  get diagnostics changed=row_count;
  delete from arkhen_private.artwork_sources where expires_at<now();
  return changed;
end $$;
create or replace function public.arkhen_artwork_get(p_provider_key text,p_scope_hash text,p_ref text)
returns jsonb language sql stable security invoker set search_path='' as $$
  select to_jsonb(source) from arkhen_private.artwork_sources source
  where source.provider_key=p_provider_key and source.scope_hash=p_scope_hash and source.ref=p_ref and source.expires_at>now()
$$;
revoke all on function public.arkhen_source_put(text,text,text,jsonb,timestamptz),public.arkhen_source_get(text,text),public.arkhen_artwork_put_batch(jsonb),public.arkhen_artwork_get(text,text,text) from public,anon,authenticated;
grant execute on function public.arkhen_source_put(text,text,text,jsonb,timestamptz),public.arkhen_source_get(text,text),public.arkhen_artwork_put_batch(jsonb),public.arkhen_artwork_get(text,text,text) to service_role;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('arkhen-catalog-artwork','arkhen-catalog-artwork',true,8388608,array['image/jpeg','image/png','image/webp','image/avif','image/gif'])
on conflict(id) do update set public=true,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
notify pgrst,'reload schema';
commit;
