-- ARKHEN / project wnicimkmzswksaqdtgdv. Review inventory before applying.
-- No provider passwords, access tokens, playback URLs or signing secrets belong here.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '90s';

-- Refuse to reinterpret pre-existing tables from another application.
do $guard$
declare name text; relation regclass;
begin
  foreach name in array array['profiles','user_favorites','user_progress','user_preferences','custom_collections','provider_catalog_cache','catalog_media','catalog_categories','provider_epg_cache','epg_programs','provider_games_cache','episode_skip_markers'] loop
    relation := to_regclass('public.' || name);
    if relation is not null and coalesce(obj_description(relation,'pg_class'),'') not like 'ARKHEN %' then
      raise exception 'Existing table public.% is not identified as ARKHEN; inspect before migrating', name;
    end if;
  end loop;
end $guard$;

create schema if not exists arkhen_private;
revoke all on schema arkhen_private from public, anon, authenticated;
grant usage on schema arkhen_private to service_role;
grant usage on schema public to authenticated,service_role;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  provider text not null check (provider in ('wplay','wplay-ott','xtream')),
  provider_key text not null check (provider_key ~ '^[A-Za-z0-9:_-]{1,160}$'),
  scope_hash text not null check (scope_hash ~ '^[A-Za-z0-9:_-]{1,160}$'),
  library_hash text not null unique check (library_hash ~ '^[a-f0-9]{64}$'),
  status text not null default 'pending' check (status in ('active','expired','disabled','pending')),
  access_expires_at timestamptz,
  last_validated_at timestamptz,
  display_name text not null default '' check (length(display_name) <= 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.profiles is 'ARKHEN v1: server-validated account access; clients may update display_name only';
create index if not exists arkhen_profiles_partition on public.profiles(provider_key,scope_hash,id);

create table if not exists arkhen_private.provider_identities (
  library_hash text primary key check (library_hash ~ '^[a-f0-9]{64}$'),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  provider text not null check (provider in ('wplay','wplay-ott','xtream')),
  provider_key text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.user_favorites (
  user_id uuid not null references public.profiles(id) on delete cascade,
  provider text not null check (provider in ('wplay','wplay-ott','xtream')),
  item_key text not null check (item_key ~ '^(live|movie|series):[A-Za-z0-9_-]{1,160}$'),
  item jsonb not null check (jsonb_typeof(item) = 'object' and octet_length(item::text) <= 32768),
  deleted_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id,provider,item_key)
);
comment on table public.user_favorites is 'ARKHEN v1: owner-scoped favorites with synchronization tombstones';

create table if not exists public.user_progress (
  user_id uuid not null references public.profiles(id) on delete cascade,
  provider text not null check (provider in ('wplay','wplay-ott','xtream')),
  item_key text not null check (item_key ~ '^(live|movie|series):[A-Za-z0-9_-]{1,160}$'),
  episode_id text not null default '' check (episode_id ~ '^[A-Za-z0-9_-]{0,160}$'),
  entry jsonb not null check (jsonb_typeof(entry) = 'object' and octet_length(entry::text) <= 65536),
  deleted_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id,provider,item_key,episode_id)
);
comment on table public.user_progress is 'ARKHEN v1: owner-scoped title and exact-episode playback progress';

create table if not exists public.user_preferences (
  user_id uuid not null references public.profiles(id) on delete cascade,
  provider text not null check (provider in ('wplay','wplay-ott','xtream')),
  key text not null check (key ~ '^[A-Za-z0-9_.:-]{1,100}$'),
  value jsonb not null check (octet_length(value::text) <= 262144),
  deleted_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id,provider,key)
);
comment on table public.user_preferences is 'ARKHEN v1: owner-scoped playback and catalog preferences';

create table if not exists public.custom_collections (
  user_id uuid not null references public.profiles(id) on delete cascade,
  provider text not null check (provider in ('wplay','wplay-ott','xtream')),
  id text not null check (id ~ '^[A-Za-z0-9_-]{1,160}$'),
  name text not null check (length(name) between 1 and 80),
  collection_type text not null check (collection_type in ('live','movies','series')),
  item_keys text[] not null default '{}' check (cardinality(item_keys) <= 1000),
  deleted_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id,provider,id)
);
comment on table public.custom_collections is 'ARKHEN v1: owner-scoped personal collections';

-- Defense in depth for worker snapshots. Provider transport data is excluded.
create or replace function arkhen_private.safe_shared_payload(value jsonb)
returns boolean language sql immutable security invoker set search_path = ''
as $$ select value is not null and pg_catalog.jsonb_typeof(value) = 'object'
  and pg_catalog.octet_length(value::text) <= 33554432
  and value::text !~* 'https?://'
  and value::text !~* '"(password|passwd|token|access_token|refresh_token|api_key|apikey|authorization|cookie|secret|client_secret|playback_url|play_url|stream_url|m3u_url|headers)"[[:space:]]*:' $$;

create table if not exists public.provider_catalog_cache (
  provider_key text not null,
  scope_hash text not null,
  media_type text not null check (media_type in ('live','movies','series')),
  payload jsonb not null check (arkhen_private.safe_shared_payload(payload)),
  expires_at timestamptz not null,
  snapshot_id uuid not null,
  is_complete boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (provider_key,scope_hash,media_type)
);
comment on table public.provider_catalog_cache is 'ARKHEN v1: complete sanitized catalog snapshots; service writes only';

create table if not exists public.catalog_categories (
  provider_key text not null,
  scope_hash text not null,
  media_type text not null check (media_type in ('live','movies','series')),
  category_id text not null,
  name text not null,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  last_seen_snapshot uuid not null,
  updated_at timestamptz not null default now(),
  primary key (provider_key,scope_hash,media_type,category_id)
);
comment on table public.catalog_categories is 'ARKHEN v1: provider-partitioned normalized categories';

create table if not exists public.catalog_media (
  provider_key text not null,
  scope_hash text not null,
  media_type text not null check (media_type in ('live','movies','series')),
  media_id text not null,
  name text not null,
  category_ids text[] not null default '{}',
  metadata jsonb not null check (arkhen_private.safe_shared_payload(metadata)),
  is_active boolean not null default true,
  last_seen_snapshot uuid not null,
  updated_at timestamptz not null default now(),
  primary key (provider_key,scope_hash,media_type,media_id)
);
comment on table public.catalog_media is 'ARKHEN v1: provider-partitioned metadata without playback URLs or credentials';
create index if not exists arkhen_catalog_media_active on public.catalog_media(provider_key,scope_hash,media_type,media_id) where is_active;
create index if not exists arkhen_catalog_media_categories on public.catalog_media using gin(category_ids);

create table if not exists public.provider_epg_cache (
  provider_key text not null,
  scope_hash text not null,
  channel_id text not null,
  payload jsonb not null check (arkhen_private.safe_shared_payload(payload)),
  expires_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (provider_key,scope_hash,channel_id)
);
comment on table public.provider_epg_cache is 'ARKHEN v1: shared sanitized channel schedule snapshots';

create table if not exists public.epg_programs (
  provider_key text not null,
  scope_hash text not null,
  channel_id text not null,
  start_at timestamptz not null,
  end_at timestamptz not null check (end_at > start_at),
  title text not null,
  description text not null default '',
  updated_at timestamptz not null default now(),
  primary key (provider_key,scope_hash,channel_id,start_at)
);
comment on table public.epg_programs is 'ARKHEN v1: normalized public-program metadata partitioned by provider';
create index if not exists arkhen_epg_programs_window on public.epg_programs(provider_key,scope_hash,start_at,end_at);

create table if not exists public.provider_games_cache (
  provider_key text not null,
  scope_hash text not null,
  game_date date not null,
  time_zone text not null check (length(time_zone) between 1 and 100),
  payload jsonb not null check (arkhen_private.safe_shared_payload(payload)),
  expires_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (provider_key,scope_hash,game_date,time_zone)
);
comment on table public.provider_games_cache is 'ARKHEN v1: shared normalized daily game snapshots, no provider image or playback URLs';

create or replace function arkhen_private.valid_episode_markers(value jsonb,duration numeric)
returns boolean language plpgsql immutable security invoker set search_path = '' as $$
declare name text; seconds numeric;
begin
  if jsonb_typeof(value) is distinct from 'object' then return false;end if;
  for name in select jsonb_object_keys(value) loop
    if name not in ('openingStart','openingEnd','creditsStart') or jsonb_typeof(value->name) is distinct from 'number' then return false;end if;
    seconds:=(value->>name)::numeric;
    if seconds<0 or seconds>=duration or (name<>'openingStart' and seconds=0) then return false;end if;
  end loop;
  if value ? 'openingEnd' and (not value ? 'openingStart' or (value->>'openingEnd')::numeric<=(value->>'openingStart')::numeric) then return false;end if;
  if value ? 'creditsStart' and (value->>'creditsStart')::numeric<coalesce((value->>'openingEnd')::numeric,(value->>'openingStart')::numeric,0) then return false;end if;
  return true;
end $$;

create table if not exists public.episode_skip_markers (
  series_slug text not null check (series_slug ~ '^[a-z0-9-]{1,100}$'),
  season integer not null check (season between 0 and 1000),
  episode integer not null check (episode between 1 and 10000),
  edition_id text not null check (edition_id ~ '^[A-Za-z0-9_.-]{1,160}$'),
  tmdb_id bigint check (tmdb_id > 0),
  imdb_id text check (imdb_id ~ '^tt[0-9]+$'),
  duration_seconds numeric not null check (duration_seconds > 0 and duration_seconds <= 86400),
  tolerance_seconds numeric not null default 0.5 check (tolerance_seconds between 0 and 3),
  verification text not null check (verification in ('community-reference','verified','unverified')),
  markers jsonb not null check (arkhen_private.valid_episode_markers(markers,duration_seconds)),
  provenance jsonb not null default '{}' check (jsonb_typeof(provenance) = 'object' and octet_length(provenance::text) <= 65536),
  data_version text not null,
  is_active boolean not null default true,
  updated_at timestamptz not null default now(),
  check (verification<>'verified' or tolerance_seconds<=2),
  primary key (series_slug,season,episode,edition_id)
);
comment on table public.episode_skip_markers is 'ARKHEN v1: global non-playback segment references; community evidence is not verified provider-edition proof';

create table if not exists arkhen_private.cache_sources (
  provider_key text not null,
  scope_hash text not null,
  provider text not null check (provider in ('wplay','wplay-ott','xtream')),
  enabled boolean not null default true,
  catalog_interval_seconds integer not null default 86400 check (catalog_interval_seconds between 3600 and 604800),
  epg_interval_seconds integer not null default 300 check (epg_interval_seconds between 60 and 3600),
  games_interval_seconds integer not null default 60 check (games_interval_seconds between 60 and 3600),
  last_catalog_enqueued_at timestamptz,
  last_epg_enqueued_at timestamptz,
  last_games_enqueued_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (provider_key,scope_hash)
);

create table if not exists arkhen_private.cache_jobs (
  id uuid primary key default gen_random_uuid(),
  provider_key text not null,
  scope_hash text not null,
  job_type text not null check (job_type in ('catalog','epg','games')),
  payload jsonb not null default '{}',
  status text not null default 'queued' check (status in ('queued','leased','succeeded','failed')),
  attempts integer not null default 0,
  run_after timestamptz not null default now(),
  lease_until timestamptz,
  locked_by text,
  error_code text,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  foreign key (provider_key,scope_hash) references arkhen_private.cache_sources(provider_key,scope_hash) on delete cascade
);
create unique index if not exists arkhen_one_active_cache_job on arkhen_private.cache_jobs(provider_key,scope_hash,job_type) where status in ('queued','leased');
create index if not exists arkhen_due_cache_jobs on arkhen_private.cache_jobs(status,run_after,lease_until);

-- RLS helpers are invoker functions: authorization comes from the server-owned
-- profile, never user_metadata and never a caller-supplied partition alone.
create or replace function public.arkhen_profile_allows(p_provider text)
returns boolean language sql stable security invoker set search_path = ''
as $$ select exists(select 1 from public.profiles p where p.id=(select auth.uid()) and p.provider=p_provider and p.status='active'
  and (p.access_expires_at is null or p.access_expires_at>now()) and p.last_validated_at>now()-interval '24 hours') $$;
create or replace function public.arkhen_partition_allows(p_provider_key text,p_scope_hash text)
returns boolean language sql stable security invoker set search_path = ''
as $$ select exists(select 1 from public.profiles p where p.id=(select auth.uid()) and p.provider_key=p_provider_key and p.scope_hash=p_scope_hash
  and p.status='active' and (p.access_expires_at is null or p.access_expires_at>now()) and p.last_validated_at>now()-interval '24 hours') $$;

create or replace function public.arkhen_profile_update_guard()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.id is distinct from old.id or new.provider is distinct from old.provider or new.library_hash is distinct from old.library_hash then
    raise exception 'Account identity is immutable' using errcode='42501';
  end if;
  new.updated_at:=clock_timestamp();return new;
end $$;
drop trigger if exists arkhen_profile_update_guard on public.profiles;
create trigger arkhen_profile_update_guard before update on public.profiles for each row execute function public.arkhen_profile_update_guard();

create or replace function public.arkhen_user_lww_guard()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.updated_at > clock_timestamp()+interval '5 minutes' then raise exception 'Invalid synchronization timestamp' using errcode='22007';end if;
  if tg_op='UPDATE' then
    if new.user_id is distinct from old.user_id or new.provider is distinct from old.provider then raise exception 'Record ownership is immutable' using errcode='42501';end if;
    if new.updated_at < old.updated_at then return null;end if;
  end if;
  return new;
end $$;

do $rls$
declare name text;
begin
  foreach name in array array['profiles','user_favorites','user_progress','user_preferences','custom_collections','provider_catalog_cache','catalog_media','catalog_categories','provider_epg_cache','epg_programs','provider_games_cache','episode_skip_markers'] loop
    execute format('alter table public.%I enable row level security',name);
    execute format('revoke all on table public.%I from public,anon,authenticated',name);
    execute format('grant all on table public.%I to service_role',name);
    execute format('grant select on table public.%I to authenticated',name);
  end loop;
  foreach name in array array['provider_identities','cache_sources','cache_jobs'] loop
    execute format('alter table arkhen_private.%I enable row level security',name);
    execute format('revoke all on table arkhen_private.%I from public,anon,authenticated',name);
    execute format('grant all on table arkhen_private.%I to service_role',name);
  end loop;
end $rls$;

drop policy if exists arkhen_profile_read on public.profiles;
create policy arkhen_profile_read on public.profiles for select to authenticated using (id=(select auth.uid()));
drop policy if exists arkhen_profile_edit on public.profiles;
create policy arkhen_profile_edit on public.profiles for update to authenticated using (id=(select auth.uid())) with check(id=(select auth.uid()));
grant update(display_name) on public.profiles to authenticated;

do $user_policies$
declare name text;
begin
  foreach name in array array['user_favorites','user_progress','user_preferences','custom_collections'] loop
    execute format('grant insert,update on table public.%I to authenticated',name);
    execute format('drop policy if exists arkhen_owner_read on public.%I',name);
    execute format('drop policy if exists arkhen_owner_insert on public.%I',name);
    execute format('drop policy if exists arkhen_owner_update on public.%I',name);
    execute format('create policy arkhen_owner_read on public.%I for select to authenticated using (user_id=(select auth.uid()) and public.arkhen_profile_allows(provider))',name);
    execute format('create policy arkhen_owner_insert on public.%I for insert to authenticated with check (user_id=(select auth.uid()) and public.arkhen_profile_allows(provider))',name);
    execute format('create policy arkhen_owner_update on public.%I for update to authenticated using (user_id=(select auth.uid()) and public.arkhen_profile_allows(provider)) with check (user_id=(select auth.uid()) and public.arkhen_profile_allows(provider))',name);
    execute format('drop trigger if exists arkhen_user_lww_guard on public.%I',name);
    execute format('create trigger arkhen_user_lww_guard before insert or update on public.%I for each row execute function public.arkhen_user_lww_guard()',name);
  end loop;
end $user_policies$;

do $shared_policies$
declare name text;
begin
  foreach name in array array['provider_catalog_cache','catalog_media','catalog_categories','provider_epg_cache','epg_programs','provider_games_cache'] loop
    execute format('drop policy if exists arkhen_partition_read on public.%I',name);
    execute format('create policy arkhen_partition_read on public.%I for select to authenticated using (public.arkhen_partition_allows(provider_key,scope_hash))',name);
  end loop;
end $shared_policies$;
drop policy if exists arkhen_markers_read on public.episode_skip_markers;
create policy arkhen_markers_read on public.episode_skip_markers for select to authenticated using
  (is_active and exists(select 1 from public.profiles p where p.id=(select auth.uid()) and public.arkhen_profile_allows(p.provider)));

-- Service-only RPCs expose narrow operations, not the private schema itself.
create or replace function public.arkhen_identity_lookup(p_library_hash text)
returns table(user_id uuid) language sql stable security invoker set search_path = ''
as $$ select i.user_id from arkhen_private.provider_identities i where i.library_hash=p_library_hash $$;

create or replace function public.arkhen_identity_bind(p_library_hash text,p_user_id uuid,p_provider text,p_provider_key text,p_scope_hash text)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  insert into arkhen_private.provider_identities(library_hash,user_id,provider,provider_key) values(p_library_hash,p_user_id,p_provider,p_provider_key)
    on conflict(library_hash) do nothing;
  if not exists(select 1 from arkhen_private.provider_identities where library_hash=p_library_hash and user_id=p_user_id and provider=p_provider and provider_key=p_provider_key) then
    raise exception 'Provider identity conflict' using errcode='23505';
  end if;
  insert into public.profiles(id,provider,provider_key,scope_hash,library_hash) values(p_user_id,p_provider,p_provider_key,p_scope_hash,p_library_hash)
    on conflict(id) do nothing;
  if not exists(select 1 from public.profiles where id=p_user_id and provider=p_provider and library_hash=p_library_hash) then raise exception 'Profile identity conflict' using errcode='23505';end if;
  insert into arkhen_private.cache_sources(provider_key,scope_hash,provider) values(p_provider_key,p_scope_hash,p_provider) on conflict do nothing;
end $$;

create or replace function public.arkhen_validate_account(p_user_id uuid,p_status text,p_expires_at timestamptz,p_validated_at timestamptz,p_provider_key text,p_scope_hash text)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  if p_validated_at is null or p_validated_at>clock_timestamp()+interval '1 minute' then raise exception 'Invalid validation time';end if;
  update public.profiles set status=p_status,access_expires_at=p_expires_at,last_validated_at=p_validated_at,provider_key=p_provider_key,scope_hash=p_scope_hash
    where id=p_user_id and (last_validated_at is null or last_validated_at<=p_validated_at);
  if not found and not exists(select 1 from public.profiles where id=p_user_id) then raise exception 'Unknown profile';end if;
end $$;

create or replace function arkhen_private.enqueue_due_cache_jobs(p_provider_key text default null,p_scope_hash text default null)
returns integer language plpgsql security invoker set search_path = '' as $$
declare source record; kind text; previous timestamptz; seconds integer; inserted integer; total integer:=0;
begin
  for source in select s.* from arkhen_private.cache_sources s where enabled
    and (p_provider_key is null or s.provider_key=p_provider_key) and (p_scope_hash is null or s.scope_hash=p_scope_hash)
    and exists(select 1 from public.profiles p where p.provider_key=s.provider_key and p.scope_hash=s.scope_hash and p.status='active'
      and (p.access_expires_at is null or p.access_expires_at>now()) and p.last_validated_at>now()-interval '24 hours')
    for update skip locked loop
    foreach kind in array array['catalog','epg','games'] loop
      previous:=case kind when 'catalog' then source.last_catalog_enqueued_at when 'epg' then source.last_epg_enqueued_at else source.last_games_enqueued_at end;
      seconds:=case kind when 'catalog' then source.catalog_interval_seconds when 'epg' then source.epg_interval_seconds else source.games_interval_seconds end;
      if previous is null or previous<=now()-make_interval(secs=>seconds) then
        insert into arkhen_private.cache_jobs(provider_key,scope_hash,job_type) values(source.provider_key,source.scope_hash,kind) on conflict do nothing;
        get diagnostics inserted=row_count;total:=total+inserted;
        if inserted>0 then
          update arkhen_private.cache_sources set last_catalog_enqueued_at=case when kind='catalog' then now() else last_catalog_enqueued_at end,
            last_epg_enqueued_at=case when kind='epg' then now() else last_epg_enqueued_at end,
            last_games_enqueued_at=case when kind='games' then now() else last_games_enqueued_at end
            where provider_key=source.provider_key and scope_hash=source.scope_hash;
        end if;
      end if;
    end loop;
  end loop;
  return total;
end $$;

create or replace function public.arkhen_enqueue_source_jobs(p_provider_key text,p_scope_hash text)
returns integer language sql security invoker set search_path = ''
as $$ select arkhen_private.enqueue_due_cache_jobs(p_provider_key,p_scope_hash) $$;

create or replace function public.arkhen_claim_cache_jobs(p_worker text,p_limit integer default 1,p_lease_seconds integer default 300)
returns table(id uuid,provider_key text,scope_hash text,job_type text,payload jsonb,attempts integer)
language plpgsql security invoker set search_path = '' as $$
begin
  if p_worker is null or length(p_worker) not between 1 and 160 then raise exception 'Invalid worker';end if;
  update arkhen_private.cache_jobs j set status='failed',finished_at=now(),error_code='lease_exhausted' where j.status='leased' and j.lease_until<now() and j.attempts>=8;
  return query with picked as (
    select j.id from arkhen_private.cache_jobs j where ((j.status='queued' and j.run_after<=now()) or (j.status='leased' and j.lease_until<now())) and j.attempts<8
      and exists(select 1 from arkhen_private.cache_sources s where s.provider_key=j.provider_key and s.scope_hash=j.scope_hash and s.enabled)
    order by j.run_after,j.created_at for update skip locked limit greatest(1,least(coalesce(p_limit,1),10))
  ) update arkhen_private.cache_jobs j set status='leased',locked_by=p_worker,lease_until=now()+make_interval(secs=>greatest(30,least(coalesce(p_lease_seconds,300),900))),attempts=j.attempts+1
    from picked where j.id=picked.id returning j.id,j.provider_key,j.scope_hash,j.job_type,j.payload,j.attempts;
end $$;

create or replace function public.arkhen_renew_cache_job(p_job_id uuid,p_worker text,p_lease_seconds integer default 300)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  update arkhen_private.cache_jobs set lease_until=now()+make_interval(secs=>greatest(30,least(coalesce(p_lease_seconds,300),900)))
    where id=p_job_id and status='leased' and locked_by=p_worker and lease_until>now();return found;
end $$;

create or replace function public.arkhen_finish_cache_job(p_job_id uuid,p_worker text,p_success boolean,p_error_code text default null)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  if p_error_code is not null and p_error_code!~'^[A-Za-z0-9_.-]{1,80}$' then raise exception 'Use a non-sensitive error code';end if;
  update arkhen_private.cache_jobs set status=case when p_success then 'succeeded' when attempts<8 then 'queued' else 'failed' end,
    run_after=case when p_success then run_after else now()+make_interval(secs=>least(1800,30*attempts*attempts)) end,
    finished_at=case when p_success or attempts>=8 then now() else null end,error_code=case when p_success then null else coalesce(p_error_code,'worker_failed') end,
    lease_until=null,locked_by=null where id=p_job_id and status='leased' and locked_by=p_worker and lease_until>now();
  if not found then raise exception 'Worker lease expired or reassigned' using errcode='55000';end if;
end $$;

create or replace function arkhen_private.assert_cache_lease(p_job_id uuid,p_worker text,p_provider_key text,p_scope_hash text,p_job_type text)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  perform 1 from arkhen_private.cache_jobs where id=p_job_id and locked_by=p_worker and status='leased' and lease_until>now()
    and provider_key=p_provider_key and scope_hash=p_scope_hash and job_type=p_job_type for update;
  if not found then raise exception 'Publication requires the current worker lease' using errcode='55000';end if;
end $$;

create or replace function public.arkhen_publish_catalog(p_provider_key text,p_scope_hash text,p_media_type text,p_payload jsonb,p_complete boolean,p_snapshot_id uuid,p_expires_at timestamptz,p_job_id uuid,p_worker text)
returns void language plpgsql security invoker set search_path = '' as $$
declare row jsonb; category_ids text[];
begin
  perform arkhen_private.assert_cache_lease(p_job_id,p_worker,p_provider_key,p_scope_hash,'catalog');
  if p_complete is distinct from true or jsonb_typeof(p_payload->'items') is distinct from 'array' or jsonb_typeof(p_payload->'categories') is distinct from 'array' then raise exception 'Only a successful complete snapshot may be published';end if;
  if not arkhen_private.safe_shared_payload(p_payload) then raise exception 'Unsafe catalog payload';end if;
  for row in select value from jsonb_array_elements(p_payload->'categories') loop
    if coalesce(row->>'id','')='' or coalesce(row->>'name','')='' then raise exception 'Invalid category';end if;
    insert into public.catalog_categories(provider_key,scope_hash,media_type,category_id,name,last_seen_snapshot) values(p_provider_key,p_scope_hash,p_media_type,row->>'id',row->>'name',p_snapshot_id)
      on conflict(provider_key,scope_hash,media_type,category_id) do update set name=excluded.name,is_active=true,last_seen_snapshot=excluded.last_seen_snapshot,updated_at=now();
  end loop;
  for row in select value from jsonb_array_elements(p_payload->'items') loop
    if coalesce(row->>'id','')='' or coalesce(row->>'name','')='' then raise exception 'Invalid media';end if;
    if jsonb_typeof(row->'categoryIds')='array' then select array_agg(value) into category_ids from jsonb_array_elements_text(row->'categoryIds');else category_ids:=case when row->>'categoryId' is null then '{}'::text[] else array[row->>'categoryId'] end;end if;
    insert into public.catalog_media(provider_key,scope_hash,media_type,media_id,name,category_ids,metadata,last_seen_snapshot)
      values(p_provider_key,p_scope_hash,p_media_type,row->>'id',row->>'name',coalesce(category_ids,'{}'),row,p_snapshot_id)
      on conflict(provider_key,scope_hash,media_type,media_id) do update set name=excluded.name,category_ids=excluded.category_ids,metadata=excluded.metadata,is_active=true,last_seen_snapshot=excluded.last_seen_snapshot,updated_at=now();
  end loop;
  update public.catalog_categories set is_active=false,updated_at=now() where provider_key=p_provider_key and scope_hash=p_scope_hash and media_type=p_media_type and last_seen_snapshot<>p_snapshot_id and is_active;
  update public.catalog_media set is_active=false,updated_at=now() where provider_key=p_provider_key and scope_hash=p_scope_hash and media_type=p_media_type and last_seen_snapshot<>p_snapshot_id and is_active;
  insert into public.provider_catalog_cache(provider_key,scope_hash,media_type,payload,expires_at,snapshot_id,is_complete) values(p_provider_key,p_scope_hash,p_media_type,p_payload,p_expires_at,p_snapshot_id,true)
    on conflict(provider_key,scope_hash,media_type) do update set payload=excluded.payload,expires_at=excluded.expires_at,snapshot_id=excluded.snapshot_id,is_complete=true,updated_at=now();
end $$;

create or replace function public.arkhen_publish_epg(p_provider_key text,p_scope_hash text,p_channel_id text,p_payload jsonb,p_expires_at timestamptz,p_job_id uuid,p_worker text)
returns void language plpgsql security invoker set search_path = '' as $$
declare row jsonb;
begin
  perform arkhen_private.assert_cache_lease(p_job_id,p_worker,p_provider_key,p_scope_hash,'epg');
  if not arkhen_private.safe_shared_payload(p_payload) or jsonb_typeof(p_payload->'list') is distinct from 'array' then raise exception 'Invalid EPG payload';end if;
  for row in select value from jsonb_array_elements(p_payload->'list') loop
    if coalesce(row->>'title','')='' or (row->>'start')::timestamptz >= (row->>'end')::timestamptz then raise exception 'Invalid program';end if;
    insert into public.epg_programs(provider_key,scope_hash,channel_id,start_at,end_at,title,description) values(p_provider_key,p_scope_hash,p_channel_id,(row->>'start')::timestamptz,(row->>'end')::timestamptz,row->>'title',coalesce(row->>'description',''))
      on conflict(provider_key,scope_hash,channel_id,start_at) do update set end_at=excluded.end_at,title=excluded.title,description=excluded.description,updated_at=now();
  end loop;
  insert into public.provider_epg_cache(provider_key,scope_hash,channel_id,payload,expires_at) values(p_provider_key,p_scope_hash,p_channel_id,p_payload,p_expires_at)
    on conflict(provider_key,scope_hash,channel_id) do update set payload=excluded.payload,expires_at=excluded.expires_at,updated_at=now();
end $$;

create or replace function public.arkhen_publish_games(p_provider_key text,p_scope_hash text,p_game_date date,p_time_zone text,p_payload jsonb,p_expires_at timestamptz,p_job_id uuid,p_worker text)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  perform arkhen_private.assert_cache_lease(p_job_id,p_worker,p_provider_key,p_scope_hash,'games');
  if not arkhen_private.safe_shared_payload(p_payload) or jsonb_typeof(p_payload->'games') is distinct from 'array' or (p_payload->>'date') is distinct from p_game_date::text then raise exception 'Invalid daily games payload';end if;
  insert into public.provider_games_cache(provider_key,scope_hash,game_date,time_zone,payload,expires_at) values(p_provider_key,p_scope_hash,p_game_date,p_time_zone,p_payload,p_expires_at)
    on conflict(provider_key,scope_hash,game_date,time_zone) do update set payload=excluded.payload,expires_at=excluded.expires_at,updated_at=now();
end $$;

create or replace function public.arkhen_publish_epg_batch(p_provider_key text,p_scope_hash text,p_channels jsonb,p_expires_at timestamptz,p_job_id uuid,p_worker text)
returns void language plpgsql security invoker set search_path = '' as $$
declare channel jsonb;
begin
  perform arkhen_private.assert_cache_lease(p_job_id,p_worker,p_provider_key,p_scope_hash,'epg');
  if jsonb_typeof(p_channels) is distinct from 'array' or jsonb_array_length(p_channels)>10000 then raise exception 'Invalid EPG channel batch';end if;
  for channel in select value from jsonb_array_elements(p_channels) loop
    if coalesce(channel->>'channel_id','')='' then raise exception 'Missing channel identity';end if;
    perform public.arkhen_publish_epg(p_provider_key,p_scope_hash,channel->>'channel_id',channel->'payload',p_expires_at,p_job_id,p_worker);
  end loop;
end $$;

create or replace function public.arkhen_hot_channels(p_provider_key text,p_scope_hash text,p_limit integer default 24)
returns table(channel_id text) language sql stable security invoker set search_path = '' as $$
  select split_part(f.item_key,':',2) as channel_id from public.user_favorites f join public.profiles p on p.id=f.user_id
  where p.provider_key=p_provider_key and p.scope_hash=p_scope_hash and f.provider=p.provider and f.item_key like 'live:%' and f.deleted_at is null
  group by f.item_key order by count(*) desc,f.item_key limit greatest(1,least(coalesce(p_limit,24),500))
$$;

-- PostgreSQL grants EXECUTE to PUBLIC by default: narrow every app function.
do $function_grants$
declare fn record;
begin
  for fn in select p.oid::regprocedure as signature,n.nspname,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where (n.nspname='public' and p.proname like 'arkhen_%') or n.nspname='arkhen_private' loop
    execute format('revoke all on function %s from public,anon,authenticated',fn.signature);
    execute format('grant execute on function %s to service_role',fn.signature);
  end loop;
end $function_grants$;
grant execute on function public.arkhen_profile_allows(text),public.arkhen_partition_allows(text,text),public.arkhen_profile_update_guard(),public.arkhen_user_lww_guard() to authenticated;

-- Publish owner rows and sanitized metadata only. Hard DELETE is not granted to
-- clients; tombstones carry ownership and avoid DELETE-event authorization gaps.
do $publication$
declare name text;
begin
  if not exists(select 1 from pg_publication where pubname='supabase_realtime') then create publication supabase_realtime;end if;
  foreach name in array array['profiles','user_favorites','user_progress','user_preferences','custom_collections','provider_catalog_cache','catalog_media','catalog_categories','provider_epg_cache','epg_programs','provider_games_cache','episode_skip_markers'] loop
    if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename=name) then execute format('alter publication supabase_realtime add table public.%I',name);end if;
  end loop;
end $publication$;

-- A minute tick enqueues due work; it never calls WPLAY or stores credentials.
-- pg_cron is optional locally; hosted application verifies availability.
do $cron$
begin
  if exists(select 1 from pg_available_extensions where name='pg_cron') then
    execute 'create extension if not exists pg_cron';
    perform cron.schedule('arkhen-cache-enqueue','* * * * *','select arkhen_private.enqueue_due_cache_jobs();');
    perform cron.schedule('arkhen-cache-history-prune','17 3 * * *','delete from arkhen_private.cache_jobs where status in (''succeeded'',''failed'') and finished_at < now() - interval ''14 days'';');
  else raise notice 'pg_cron unavailable: enable it and schedule arkhen_private.enqueue_due_cache_jobs() every minute';
  end if;
end $cron$;
notify pgrst,'reload schema';
commit;
