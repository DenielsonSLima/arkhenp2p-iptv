begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
-- Raw source bytes are private; only sanitized, licensed derived parts are public.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('arkhen-marker-staging','arkhen-marker-staging',false,67108864,array['application/json'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
alter table public.series_marker_sync_state add column if not exists source_mode text;
alter table public.series_marker_sync_state add column if not exists raw_object text;
alter table public.series_marker_sync_state add column if not exists raw_generation text;
alter table public.series_marker_sync_state add column if not exists raw_cursor bigint not null default 0;
alter table public.series_marker_sync_state add column if not exists raw_seen_count integer not null default 0;
alter table public.series_marker_sync_state add column if not exists raw_complete_at timestamptz;
alter table public.series_marker_sync_state add column if not exists raw_metadata jsonb;
create table if not exists public.series_marker_source_segments (
  generation text not null,segment_id bigint not null check(segment_id>0),
  imdb_id text not null check(imdb_id~'^tt[0-9]{6,10}$'),season integer not null check(season between 0 and 1000),episode integer not null check(episode between 1 and 10000),
  segment_type text not null check(segment_type in('intro','recap','outro','preview')),
  start_ms numeric not null check(start_ms>=0),end_ms numeric not null check(end_ms>=start_ms and end_ms<=86400000),
  duration_ms numeric check(duration_ms>0 and duration_ms<=86400000 and end_ms<=duration_ms),score numeric not null default 0,
  primary key(generation,segment_id)
);
create index if not exists arkhen_marker_source_episode on public.series_marker_source_segments(generation,imdb_id,season,episode);
create table if not exists public.series_marker_source_groups (
  generation text not null,imdb_id text not null,season integer not null,episode integer not null,
  exported boolean not null default false,export_key text,error_code text,segment_count integer not null check(segment_count>0),
  primary key(generation,imdb_id,season,episode)
);
create index if not exists arkhen_marker_groups_pending on public.series_marker_source_groups(generation,imdb_id,season,episode) where not exported;
alter table public.series_marker_source_segments enable row level security;
alter table public.series_marker_source_groups enable row level security;
revoke all on public.series_marker_source_segments,public.series_marker_source_groups from public,anon,authenticated;
grant all on public.series_marker_source_segments,public.series_marker_source_groups to service_role;

create or replace function public.arkhen_marker_stage_page(p_generation text,p_owner uuid,p_rows jsonb,p_count integer,p_next bigint,p_complete boolean,p_metadata jsonb)
returns integer language plpgsql security invoker set search_path='' set statement_timeout='15s' as $$
declare state public.series_marker_sync_state;inserted integer;
begin
  select * into state from public.series_marker_sync_state where name='global' and lease_owner=p_owner and lease_until>now() and raw_generation=p_generation for update;
  if not found then raise exception 'Marker lease expired';end if;
  if p_generation is null or p_generation!~'^[0-9TZ]{14,32}$' or jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows)>10000 or octet_length(p_rows::text)>2097152 or p_count is null or p_count<jsonb_array_length(p_rows) or p_count>10000 or p_next is null or p_next<=state.raw_cursor or p_next>67108864 or p_complete is null or state.raw_complete_at is not null then raise exception 'Invalid source page';end if;
  if p_metadata is null or p_metadata->>'license' is distinct from 'ODbL 1.0 + Service Provider Reciprocity' or p_metadata->>'count' is null or p_metadata->>'count'!~'^[0-9]{1,7}$' then raise exception 'Invalid source license';end if;
  insert into public.series_marker_source_segments(generation,segment_id,imdb_id,season,episode,segment_type,start_ms,end_ms,duration_ms,score)
  select p_generation,r.segment_id,r.imdb_id,r.season,r.episode,r.segment_type,r.start_ms,r.end_ms,r.duration_ms,r.score
  from jsonb_to_recordset(p_rows) as r(segment_id bigint,imdb_id text,season integer,episode integer,segment_type text,start_ms numeric,end_ms numeric,duration_ms numeric,score numeric)
  on conflict(generation,segment_id) do nothing;
  get diagnostics inserted=row_count;
  if p_complete and state.raw_seen_count+p_count<>(p_metadata->>'count')::integer then raise exception 'Incomplete source count';end if;
  update public.series_marker_sync_state set raw_cursor=p_next,raw_seen_count=raw_seen_count+p_count,raw_metadata=p_metadata,
    raw_complete_at=case when p_complete then now() else null end,dump_generation=p_generation where name='global';
  if p_complete then
    insert into public.series_marker_source_groups(generation,imdb_id,season,episode,segment_count)
    select generation,imdb_id,season,episode,count(*) from public.series_marker_source_segments where generation=p_generation group by generation,imdb_id,season,episode on conflict do nothing;
    -- An anomalously large episode is isolated explicitly. Keep its last good
    -- edition active rather than partially normalize it or block all series.
    update public.series_marker_source_groups set exported=true,error_code='SOURCE_EPISODE_GROUP_LIMIT'
      where generation=p_generation and segment_count>2000;
    update public.episode_skip_markers m set sync_generation=p_generation
      from public.series_marker_source_groups g where g.generation=p_generation and g.error_code='SOURCE_EPISODE_GROUP_LIMIT'
      and m.imdb_id=g.imdb_id and m.season=g.season and m.episode=g.episode and m.provenance->>'source'='skipdb-cloud';
    insert into public.series_marker_titles(imdb_id,series_slug,inventory_check_at)
      select distinct imdb_id,'imdb-'||imdb_id,'9999-01-01'::timestamptz from public.series_marker_source_groups
      where generation=p_generation and error_code='SOURCE_EPISODE_GROUP_LIMIT' on conflict(imdb_id) do nothing;
    insert into public.series_marker_coverage(imdb_id,series_slug,season,episode,status,source,skipdb_status,error_code,next_check_at)
      select g.imdb_id,t.series_slug,g.season,g.episode,'failed','skipdb','failed','SOURCE_EPISODE_GROUP_LIMIT',now()+interval '1 day'
      from public.series_marker_source_groups g join public.series_marker_titles t on t.imdb_id=g.imdb_id
      where g.generation=p_generation and g.error_code='SOURCE_EPISODE_GROUP_LIMIT'
      on conflict(imdb_id,season,episode) do update set error_code=excluded.error_code,next_check_at=excluded.next_check_at;
  end if;
  return inserted;
end $$;

create or replace function public.arkhen_marker_source_batch(p_generation text,p_owner uuid,p_limit integer default 20)
returns jsonb language plpgsql security invoker set search_path='' set statement_timeout='15s' as $$
declare groups jsonb;segments jsonb;
begin
  perform 1 from public.series_marker_sync_state where name='global' and lease_owner=p_owner and lease_until>now() and raw_generation=p_generation and raw_complete_at is not null for update;
  if not found then raise exception 'Marker lease expired';end if;
  with ranked as (
    select g.* from public.series_marker_source_groups g left join public.series_marker_titles t on t.imdb_id=g.imdb_id
    where g.generation=p_generation and not g.exported order by (t.tmdb_id is not null) desc,g.imdb_id,g.season,g.episode limit least(20,greatest(1,coalesce(p_limit,20)))
  ), bounded as (
    select r.*,sum(segment_count) over(order by imdb_id,season,episode) as total from ranked r
  ) select coalesce(jsonb_agg(jsonb_build_object('imdb_id',imdb_id,'season',season,'episode',episode)),'[]') into groups from bounded where total<=2000;
  select coalesce(jsonb_agg(jsonb_build_object('id',s.segment_id,'status','approved','media_type','series','imdb_id',s.imdb_id,'season',s.season,'episode',s.episode,'segment_type',s.segment_type,'start_ms',s.start_ms,'end_ms',s.end_ms,'duration_ms',s.duration_ms,'score',s.score)),'[]') into segments
  from public.series_marker_source_segments s join jsonb_to_recordset(groups) as g(imdb_id text,season integer,episode integer) on s.imdb_id=g.imdb_id and s.season=g.season and s.episode=g.episode where s.generation=p_generation;
  return jsonb_build_object('groups',groups,'segments',segments,'excluded_groups',(select count(*) from public.series_marker_source_groups where generation=p_generation and error_code is not null));
end $$;

create or replace function public.arkhen_marker_source_done(p_generation text,p_owner uuid,p_groups jsonb,p_export_key text)
returns integer language plpgsql security invoker set search_path='' as $$
declare changed integer;
begin
  perform 1 from public.series_marker_sync_state where name='global' and lease_owner=p_owner and lease_until>now() and raw_generation=p_generation for update;
  if not found then raise exception 'Marker lease expired';end if;
  if p_export_key is null or p_export_key!~'^skipdb-[0-9TZ]+-part-[a-f0-9]{24}\.jsonl$' or left(p_export_key,length(p_generation)+13)<>'skipdb-'||p_generation||'-part-' or jsonb_typeof(p_groups) is distinct from 'array' or jsonb_array_length(p_groups)>20 then raise exception 'Invalid public artifact';end if;
  update public.series_marker_source_groups s set exported=true,export_key=p_export_key from jsonb_to_recordset(p_groups) as g(imdb_id text,season integer,episode integer)
  where s.generation=p_generation and s.imdb_id=g.imdb_id and s.season=g.season and s.episode=g.episode;
  get diagnostics changed=row_count;return changed;
end $$;
create or replace function public.arkhen_marker_source_index(p_generation text)
returns jsonb language sql stable security invoker set search_path='' as $$
  select coalesce(jsonb_agg(export_key order by export_key),'[]') from (select distinct export_key from public.series_marker_source_groups where generation=p_generation and exported and export_key is not null) parts
$$;
revoke all on function public.arkhen_marker_stage_page(text,uuid,jsonb,integer,bigint,boolean,jsonb),public.arkhen_marker_source_batch(text,uuid,integer),public.arkhen_marker_source_done(text,uuid,jsonb,text),public.arkhen_marker_source_index(text) from public,anon,authenticated;
grant execute on function public.arkhen_marker_stage_page(text,uuid,jsonb,integer,bigint,boolean,jsonb),public.arkhen_marker_source_batch(text,uuid,integer),public.arkhen_marker_source_done(text,uuid,jsonb,text),public.arkhen_marker_source_index(text) to service_role;

-- One small signal per worker invocation replaces tens of thousands of row
-- events. Identities, coverage and markers share this cache revision.
create table public.marker_cache_versions(name text primary key check(name='global'),generation text not null,updated_at timestamptz not null default now());
insert into public.marker_cache_versions(name,generation) values('global','initial');
alter table public.marker_cache_versions enable row level security;
revoke all on public.marker_cache_versions from public,anon,authenticated;
grant all on public.marker_cache_versions to service_role;
grant select on public.marker_cache_versions to authenticated;
create policy arkhen_marker_version_read on public.marker_cache_versions for select to authenticated
  using(exists(select 1 from public.profiles p where p.id=(select auth.uid()) and public.arkhen_profile_allows(p.provider)));
do $$begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime') then
    if exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='episode_skip_markers') then
      alter publication supabase_realtime drop table public.episode_skip_markers;
    end if;
    alter publication supabase_realtime add table public.marker_cache_versions;
  end if;
end $$;
notify pgrst,'reload schema';
commit;
