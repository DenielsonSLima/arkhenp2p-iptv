begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
alter table public.series_marker_sync_state add column if not exists retention_public_offset integer not null default 0 check(retention_public_offset>=0);
alter table public.series_marker_sync_state add column if not exists retention_raw_offset integer not null default 0 check(retention_raw_offset>=0);
alter table public.series_marker_sync_state add column if not exists retention_checked_at timestamptz;
create index if not exists arkhen_marker_retained_artifact on public.episode_skip_markers((provenance->>'openDataUrl')) where is_active or verification='verified';

-- All marker content and verified provenance stay intact. An unchanged public
-- source edition may point to its newly published licensed derivative.
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
    is_active=case when current.verification='verified' then current.is_active else excluded.is_active end,
    provenance=case when current.verification<>'verified' and current.markers=excluded.markers and current.duration_seconds=excluded.duration_seconds
      and current.tolerance_seconds=excluded.tolerance_seconds and current.imdb_id is not distinct from excluded.imdb_id
      and current.tmdb_id is not distinct from excluded.tmdb_id and current.verification=excluded.verification
      and excluded.provenance->>'openDataUrl' ~ '^https://wnicimkmzswksaqdtgdv\.supabase\.co/storage/v1/object/public/arkhen-marker-open-data/skipdb-[0-9TZ]{14,32}(-part-[a-f0-9]{24})?\.jsonl$'
      then jsonb_set(current.provenance,'{openDataUrl}',excluded.provenance->'openDataUrl',true) else current.provenance end
  where current.provenance->>'source'='skipdb-cloud';
  get diagnostics affected=row_count;return affected;
end $$;

-- Retention is allowed only after the current source has been finalized and
-- while its worker still has enough lease time for a bounded Storage request.
create or replace function public.arkhen_marker_retention_context(p_owner uuid,p_limit integer default 5000)
returns jsonb language plpgsql security invoker set search_path='' set statement_timeout='15s' as $$
declare state public.series_marker_sync_state;removed_segments integer;removed_groups integer;public_keys jsonb;
declare prefix constant text='https://wnicimkmzswksaqdtgdv.supabase.co/storage/v1/object/public/arkhen-marker-open-data/';
begin
  if p_limit is null or p_limit<1 or p_limit>5000 then raise exception 'Invalid retention limit';end if;
  select * into state from public.series_marker_sync_state where name='global' and lease_owner=p_owner and lease_until>now()+interval '15 seconds' and dump_completed_at is not null and dump_generation~'^[0-9TZ]{14,32}$' for update;
  if not found then raise exception 'Marker retention lease unavailable';end if;
  delete from public.series_marker_source_segments where ctid in(select ctid from public.series_marker_source_segments
    where generation is distinct from state.raw_generation and generation is distinct from state.dump_generation order by generation,segment_id limit p_limit);
  get diagnostics removed_segments=row_count;
  delete from public.series_marker_source_groups where ctid in(select ctid from public.series_marker_source_groups
    where generation is distinct from state.raw_generation and generation is distinct from state.dump_generation order by generation,imdb_id,season,episode limit p_limit);
  get diagnostics removed_groups=row_count;
  select coalesce(jsonb_agg(key order by key),'[]') into public_keys from (
    select distinct substr(provenance->>'openDataUrl',length(prefix)+1) as key from public.episode_skip_markers
    where (is_active or verification='verified') and left(provenance->>'openDataUrl',length(prefix))=prefix
    union select state.dump_object where state.dump_object is not null
    union select export_key from public.series_marker_source_groups where generation=state.dump_generation and export_key is not null
  ) kept;
  return jsonb_build_object('generation',state.dump_generation,'raw_object',state.raw_object,'dump_object',state.dump_object,'public_keys',public_keys,
    'public_offset',state.retention_public_offset,'raw_offset',state.retention_raw_offset,'removed_segments',removed_segments,'removed_groups',removed_groups);
end $$;

-- Recheck immediately before each API delete. Neither callers nor storage
-- listing responses may select arbitrary buckets, paths or referenced files.
create or replace function public.arkhen_marker_retention_candidates(p_owner uuid,p_raw jsonb default '[]',p_public jsonb default '[]')
returns jsonb language plpgsql security invoker set search_path='' set statement_timeout='10s' as $$
declare state public.series_marker_sync_state;raw_keys jsonb;public_keys jsonb;
declare prefix constant text='https://wnicimkmzswksaqdtgdv.supabase.co/storage/v1/object/public/arkhen-marker-open-data/';
begin
  if jsonb_typeof(p_raw) is distinct from 'array' or jsonb_typeof(p_public) is distinct from 'array' or jsonb_array_length(p_raw)+jsonb_array_length(p_public)>20 then raise exception 'Invalid retention batch';end if;
  select * into state from public.series_marker_sync_state where name='global' and lease_owner=p_owner and lease_until>now()+interval '15 seconds' and dump_completed_at is not null and dump_generation~'^[0-9TZ]{14,32}$' for update;
  if not found then raise exception 'Marker retention lease unavailable';end if;
  select coalesce(jsonb_agg(key),'[]') into raw_keys from (select distinct value as key from jsonb_array_elements_text(p_raw)
    where value ~ '^skipdb-raw-[0-9TZ]{14,32}\.json$' and value is distinct from state.raw_object
      and value<>'skipdb-raw-'||coalesce(state.raw_generation,'')||'.json') candidates;
  select coalesce(jsonb_agg(key),'[]') into public_keys from (select distinct value as key from jsonb_array_elements_text(p_public)
    where value ~ '^skipdb-[0-9TZ]{14,32}(-part-[a-f0-9]{24})?\.jsonl$' and value is distinct from state.dump_object
      and value not like 'skipdb-'||state.dump_generation||'-%' and value<>'skipdb-'||state.dump_generation||'.jsonl'
      and not exists(select 1 from public.episode_skip_markers m where (m.is_active or m.verification='verified') and m.provenance->>'openDataUrl'=prefix||value)
      and not exists(select 1 from public.series_marker_source_groups g where g.generation=state.dump_generation and g.export_key=value)) candidates;
  return jsonb_build_object('raw',raw_keys,'public',public_keys,'lease_until',state.lease_until);
end $$;
revoke all on function public.arkhen_marker_publish(jsonb,text,uuid),public.arkhen_marker_retention_context(uuid,integer),public.arkhen_marker_retention_candidates(uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.arkhen_marker_publish(jsonb,text,uuid),public.arkhen_marker_retention_context(uuid,integer),public.arkhen_marker_retention_candidates(uuid,jsonb,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
