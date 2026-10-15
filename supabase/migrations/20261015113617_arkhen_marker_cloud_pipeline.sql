-- Shared references only: no provider credentials, playback URLs or user data.
create table if not exists public.series_marker_identities (
  provider_key text not null, scope_hash text not null, media_id text not null,
  catalog_name text not null, catalog_metadata jsonb not null default '{}',
  series_slug text, imdb_id text check(imdb_id ~ '^tt[0-9]{6,10}$'), tmdb_id bigint check(tmdb_id>0),
  status text not null default 'pending' check(status in ('pending','resolved','unresolved','ambiguous','failed')),
  error_code text, evidence jsonb not null default '{}' check(octet_length(evidence::text)<=32768),
  next_check_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  source_snapshot uuid,
  primary key(provider_key,scope_hash,media_id),
  check(status<>'resolved' or (imdb_id is not null and series_slug ~ '^[a-z0-9-]{1,100}$')),
  check(arkhen_private.safe_shared_payload(catalog_metadata))
);
create index if not exists arkhen_marker_identities_due on public.series_marker_identities(next_check_at);
create index if not exists arkhen_marker_identities_imdb on public.series_marker_identities(imdb_id) where status='resolved';

create table if not exists public.series_marker_titles (
  imdb_id text primary key check(imdb_id ~ '^tt[0-9]{6,10}$'),
  series_slug text not null unique check(series_slug ~ '^[a-z0-9-]{1,100}$'),
  title text, year integer check(year between 1800 and 2200), tmdb_id bigint check(tmdb_id>0),
  inventory_status text not null default 'pending' check(inventory_status in ('pending','ready','empty','failed')),
  inventory_error text, inventory_check_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists arkhen_marker_titles_due on public.series_marker_titles(inventory_check_at);

create table if not exists public.series_marker_coverage (
  imdb_id text not null references public.series_marker_titles(imdb_id),
  season integer not null check(season between 0 and 1000), episode integer not null check(episode between 1 and 10000),
  series_slug text not null check(series_slug ~ '^[a-z0-9-]{1,100}$'), tmdb_id bigint,
  runtime_hint_seconds numeric check(runtime_hint_seconds>0 and runtime_hint_seconds<=86400),
  status text not null default 'pending' check(status in ('pending','ready','empty','unverified','failed')),
  source text check(source in ('skipdb','introdb')), skipdb_status text, introdb_status text,
  error_code text, attempts integer not null default 0 check(attempts>=0),
  evidence jsonb not null default '{}' check(octet_length(evidence::text)<=65536),
  next_check_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  primary key(imdb_id,season,episode)
);
create index if not exists arkhen_marker_coverage_due on public.series_marker_coverage(next_check_at);

create table if not exists public.series_marker_sync_state (
  name text primary key, lease_owner uuid, lease_until timestamptz,
  skipdb_cooldown_until timestamptz, introdb_cooldown_until timestamptz,
  last_started_at timestamptz, last_finished_at timestamptz, last_result jsonb not null default '{}'
);
alter table public.series_marker_sync_state add column if not exists dump_object text;
alter table public.series_marker_sync_state add column if not exists dump_generation text;
alter table public.series_marker_sync_state add column if not exists dump_completed_at timestamptz;
alter table public.series_marker_sync_state add column if not exists dump_cursor bigint not null default 0;
alter table public.series_marker_sync_state add column if not exists dump_refreshed_at timestamptz;
alter table public.series_marker_sync_state add column if not exists dump_retry_at timestamptz;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('arkhen-marker-open-data','arkhen-marker-open-data',true,67108864,array['application/x-ndjson','application/json'])
on conflict(id) do update set public=true,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
insert into public.series_marker_sync_state(name) values('global') on conflict do nothing;

alter table public.series_marker_identities enable row level security;
alter table public.series_marker_titles enable row level security;
alter table public.series_marker_coverage enable row level security;
alter table public.series_marker_sync_state enable row level security;
revoke all on public.series_marker_identities,public.series_marker_titles,public.series_marker_coverage,public.series_marker_sync_state from public,anon,authenticated;
grant all on public.series_marker_identities,public.series_marker_titles,public.series_marker_coverage,public.series_marker_sync_state to service_role;
grant select on public.series_marker_identities,public.series_marker_titles,public.series_marker_coverage to authenticated;
create policy arkhen_marker_identity_read on public.series_marker_identities for select to authenticated
  using(public.arkhen_partition_allows(provider_key,scope_hash));
create policy arkhen_marker_title_read on public.series_marker_titles for select to authenticated
  using(exists(select 1 from public.profiles p where p.id=(select auth.uid()) and public.arkhen_profile_allows(p.provider)));
create policy arkhen_marker_coverage_read on public.series_marker_coverage for select to authenticated
  using(exists(select 1 from public.profiles p where p.id=(select auth.uid()) and public.arkhen_profile_allows(p.provider)));

-- Relational discovery resumes from absent/changed rows, independently of any
-- browser, process memory, login or title playback. The cap bounds each run.
create or replace function public.arkhen_marker_discover(p_limit integer default 500)
returns integer language plpgsql security invoker set search_path='' as $$
declare changed integer;
begin
  insert into public.series_marker_identities(provider_key,scope_hash,media_id,catalog_name,catalog_metadata,source_snapshot)
  select m.provider_key,m.scope_hash,m.media_id,m.name,m.metadata,m.last_seen_snapshot
  from public.catalog_media m left join public.series_marker_identities i
    on i.provider_key=m.provider_key and i.scope_hash=m.scope_hash and i.media_id=m.media_id
  where m.media_type='series' and m.is_active and (i.media_id is null or i.source_snapshot is distinct from m.last_seen_snapshot)
  order by m.provider_key,m.scope_hash,m.media_id limit least(1000,greatest(1,coalesce(p_limit,500)))
  on conflict(provider_key,scope_hash,media_id) do update set
    catalog_name=excluded.catalog_name,catalog_metadata=excluded.catalog_metadata,source_snapshot=excluded.source_snapshot,
    status=case when series_marker_identities.catalog_name is distinct from excluded.catalog_name then 'pending' else series_marker_identities.status end,
    next_check_at=case when series_marker_identities.catalog_name is distinct from excluded.catalog_name then now() else series_marker_identities.next_check_at end,
    updated_at=now();
  get diagnostics changed=row_count;return changed;
end $$;

create or replace function public.arkhen_marker_claim(p_owner uuid,p_lease_seconds integer default 70)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare state public.series_marker_sync_state;
begin
  if p_owner is null then raise exception 'Invalid marker lease owner';end if;
  select * into state from public.series_marker_sync_state where name='global' for update;
  if state.lease_until>now() then return jsonb_build_object('claimed',false);end if;
  update public.series_marker_sync_state set lease_owner=p_owner,lease_until=now()+make_interval(secs=>least(90,greatest(10,p_lease_seconds))),last_started_at=now()
    where name='global';
  return to_jsonb(state)||jsonb_build_object('claimed',true);
end $$;

create or replace function public.arkhen_marker_release(p_owner uuid,p_result jsonb,p_skipdb_cooldown timestamptz default null,p_introdb_cooldown timestamptz default null)
returns boolean language plpgsql security invoker set search_path='' as $$
declare changed integer;
begin
  update public.series_marker_sync_state set lease_owner=null,lease_until=null,last_finished_at=now(),last_result=p_result,
    skipdb_cooldown_until=greatest(skipdb_cooldown_until,p_skipdb_cooldown),introdb_cooldown_until=greatest(introdb_cooldown_until,p_introdb_cooldown)
  where name='global' and lease_owner=p_owner;
  get diagnostics changed=row_count;return changed>0;
end $$;
revoke all on function public.arkhen_marker_discover(integer),public.arkhen_marker_claim(uuid,integer),public.arkhen_marker_release(uuid,jsonb,timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.arkhen_marker_discover(integer),public.arkhen_marker_claim(uuid,integer),public.arkhen_marker_release(uuid,jsonb,timestamptz,timestamptz) to service_role;

alter table public.episode_skip_markers add column if not exists sync_generation text;
create or replace function public.arkhen_marker_publish(p_rows jsonb,p_generation text,p_owner uuid)
returns integer language plpgsql security invoker set search_path='' as $$
declare affected integer;
begin
  if p_generation is null or p_generation !~ '^[0-9TZ]{14,32}$' then raise exception 'Invalid marker generation';end if;
  perform 1 from public.series_marker_sync_state where name='global' and lease_owner=p_owner and lease_until>now() and dump_generation=p_generation for update;
  if not found then raise exception 'Marker lease expired';end if;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows)>1000 or octet_length(p_rows::text)>4194304 then raise exception 'Invalid marker batch';end if;
  if exists(select 1 from jsonb_array_elements(p_rows) r where r->>'edition_id' !~ '^skipdb-cloud-[a-f0-9]{24}$' or r#>>'{provenance,source}' is distinct from 'skipdb-cloud') then raise exception 'Invalid marker source';end if;
  insert into public.episode_skip_markers as current(series_slug,season,episode,edition_id,tmdb_id,imdb_id,duration_seconds,tolerance_seconds,verification,markers,provenance,data_version,is_active,sync_generation)
  select r.series_slug,r.season,r.episode,r.edition_id,r.tmdb_id,r.imdb_id,r.duration_seconds,r.tolerance_seconds,r.verification,r.markers,r.provenance,r.data_version,r.is_active,p_generation
  from jsonb_to_recordset(p_rows) as r(series_slug text,season integer,episode integer,edition_id text,tmdb_id bigint,imdb_id text,duration_seconds numeric,tolerance_seconds numeric,verification text,markers jsonb,provenance jsonb,data_version text,is_active boolean)
  on conflict(series_slug,season,episode,edition_id) do update set sync_generation=excluded.sync_generation,
    data_version=case when current.verification='verified' then current.data_version else excluded.data_version end,
    is_active=case when current.verification='verified' then current.is_active else excluded.is_active end
  where current.provenance->>'source'='skipdb-cloud';
  get diagnostics affected=row_count;return affected;
end $$;
create or replace function public.arkhen_marker_finalize(p_generation text,p_owner uuid)
returns integer language plpgsql security invoker set search_path='' as $$
declare affected integer;
begin
  if p_generation is null or p_generation !~ '^[0-9TZ]{14,32}$' then raise exception 'Invalid marker generation';end if;
  perform 1 from public.series_marker_sync_state where name='global' and lease_owner=p_owner and lease_until>now() and dump_generation=p_generation for update;
  if not found then raise exception 'Marker lease expired';end if;
  update public.episode_skip_markers set is_active=false,updated_at=now()
  where provenance->>'source'='skipdb-cloud' and verification<>'verified' and is_active and sync_generation is distinct from p_generation;
  get diagnostics affected=row_count;return affected;
end $$;
revoke all on function public.arkhen_marker_publish(jsonb,text,uuid),public.arkhen_marker_finalize(text,uuid) from public,anon,authenticated;
grant execute on function public.arkhen_marker_publish(jsonb,text,uuid),public.arkhen_marker_finalize(text,uuid) to service_role;

-- This function is callable only by the service/cron owner. Vault is read at
-- invocation; missing credentials do not create an unauthenticated request.
create extension if not exists pg_net with schema extensions;
create or replace function arkhen_private.arkhen_schedule_marker_sync()
returns bigint language plpgsql security definer set search_path='' as $$
declare sync_secret text; request_id bigint;
begin
  select decrypted_secret into sync_secret from vault.decrypted_secrets where name='arkhen_marker_sync_secret' limit 1;
  if sync_secret is null or length(sync_secret)<32 then return null;end if;
  select net.http_post(
    url:='https://wnicimkmzswksaqdtgdv.supabase.co/functions/v1/series-markers-sync',
    headers:=jsonb_build_object('Content-Type','application/json','x-arkhen-marker-secret',sync_secret),
    body:='{}'::jsonb,timeout_milliseconds:=55000) into request_id;
  return request_id;
end $$;
revoke all on function arkhen_private.arkhen_schedule_marker_sync() from public,anon,authenticated;
grant execute on function arkhen_private.arkhen_schedule_marker_sync() to service_role;
select cron.schedule('arkhen-series-markers-sync','*/2 * * * *','select arkhen_private.arkhen_schedule_marker_sync();');
notify pgrst,'reload schema';
