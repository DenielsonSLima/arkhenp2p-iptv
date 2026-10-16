-- One provider EPG capture per collection; readers never schedule provider I/O.
-- The canonical per-channel JSON snapshot publishes atomically. The historical
-- epg_programs table is intentionally outside this path (no 50k-row rewrite).
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';
lock table arkhen_private.cache_jobs in exclusive mode;

do $cutover$begin
 if exists(select 1 from arkhen_private.cache_jobs where job_type='epg' and status='leased' and lease_until>now()) then raise exception 'Wait for the active EPG lease before snapshot cutover' using errcode='55000';end if;
end $cutover$;

alter table arkhen_private.cache_sources drop constraint cache_sources_epg_interval_seconds_check;
alter table arkhen_private.cache_sources alter column epg_interval_seconds set default 21600;
update arkhen_private.cache_sources set epg_interval_seconds=21600;
alter table arkhen_private.cache_sources add constraint cache_sources_epg_interval_seconds_check check(epg_interval_seconds between 21600 and 604800);

create table arkhen_private.epg_snapshot_candidates(
 job_id uuid primary key references arkhen_private.cache_jobs(id) on delete cascade,
 snapshot_id uuid not null unique default gen_random_uuid(),
 content_hash text not null check(content_hash~'^[a-f0-9]{64}$'),
 state text not null check(state in('sealed','published','superseded')),
 payload jsonb check(payload is null or arkhen_private.safe_shared_payload(payload)),
 fetched_at timestamptz not null,
 channel_count integer not null check(channel_count between 1 and 10000),
 program_count integer not null check(program_count between 0 and 250000),
 horizon_end timestamptz,
 sealed_at timestamptz not null default now(),
 published_at timestamptz,
 check(state<>'sealed' or payload is not null)
);
create table public.epg_cache_versions(
 provider_key text not null,scope_hash text not null,revision uuid not null,
 snapshot_fetched_at timestamptz not null,snapshot_expires_at timestamptz not null,
 source_next_refresh_at timestamptz not null,horizon_end timestamptz,
 is_legacy boolean not null default false,
 channel_count integer not null,program_count integer not null,
 projection_version text not null,as_of timestamptz not null,next_refresh_at timestamptz not null,
 updated_at timestamptz not null default now(),primary key(provider_key,scope_hash)
);
create table arkhen_private.epg_projection_cache(
 provider_key text not null,scope_hash text not null,include_adult boolean not null,time_zone text not null,
 revision uuid not null,catalog_generation uuid,projection_version text not null,
 as_of timestamptz not null,next_refresh_at timestamptz not null,payload jsonb not null,
 primary key(provider_key,scope_hash,include_adult,time_zone),
 check(time_zone in('America/Maceio','America/Sao_Paulo','UTC')),
 check(arkhen_private.safe_shared_payload(payload))
);
alter table arkhen_private.epg_snapshot_candidates enable row level security;
alter table arkhen_private.epg_projection_cache enable row level security;
alter table public.epg_cache_versions enable row level security;
revoke all on arkhen_private.epg_snapshot_candidates,arkhen_private.epg_projection_cache,public.epg_cache_versions from public,anon,authenticated;
grant all on arkhen_private.epg_snapshot_candidates,arkhen_private.epg_projection_cache,public.epg_cache_versions to service_role;
grant select on public.epg_cache_versions to authenticated;
create policy arkhen_epg_version_partition_read on public.epg_cache_versions for select to authenticated using(public.arkhen_partition_allows(provider_key,scope_hash));

-- Keep the old, independently collected guides readable during cutover. This
-- is explicitly stale legacy data, never evidence of a complete new capture.
insert into public.epg_cache_versions(provider_key,scope_hash,revision,snapshot_fetched_at,snapshot_expires_at,source_next_refresh_at,horizon_end,is_legacy,channel_count,program_count,projection_version,as_of,next_refresh_at)
select provider_key,scope_hash,gen_random_uuid(),min(updated_at),least(min(expires_at),now()),now(),null,true,count(*)::integer,0,'legacy:'||extract(epoch from now())::text,now(),now()
from public.provider_epg_cache group by provider_key,scope_hash;

create function public.arkhen_epg_snapshot_state(p_job_id uuid,p_worker text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare job arkhen_private.cache_jobs;candidate arkhen_private.epg_snapshot_candidates;
begin
 select * into job from arkhen_private.cache_jobs where id=p_job_id;
 perform arkhen_private.assert_cache_lease(p_job_id,p_worker,job.provider_key,job.scope_hash,'epg');
 select * into candidate from arkhen_private.epg_snapshot_candidates where job_id=p_job_id;
 if not found then return jsonb_build_object('state','missing');end if;
 return jsonb_build_object('state',candidate.state,'snapshotId',candidate.snapshot_id,'contentHash',candidate.content_hash,'fetchedAt',candidate.fetched_at,'channelCount',candidate.channel_count,'programCount',candidate.program_count);
end $$;

create function public.arkhen_epg_snapshot_stage(p_job_id uuid,p_worker text,p_channels jsonb,p_content_hash text,p_fetched_at timestamptz)
returns jsonb language plpgsql security invoker set search_path='' set statement_timeout='15s' as $$
declare job arkhen_private.cache_jobs;candidate arkhen_private.epg_snapshot_candidates;total integer;horizon timestamptz;
begin
 select * into job from arkhen_private.cache_jobs where id=p_job_id;
 perform arkhen_private.assert_cache_lease(p_job_id,p_worker,job.provider_key,job.scope_hash,'epg');
 select * into candidate from arkhen_private.epg_snapshot_candidates where job_id=p_job_id for update;
 if found then
  if candidate.content_hash is distinct from p_content_hash then raise exception 'EPG candidate is immutable' using errcode='22023';end if;
  return public.arkhen_epg_snapshot_state(p_job_id,p_worker);
 end if;
 if p_content_hash is null or p_content_hash!~'^[a-f0-9]{64}$' or p_fetched_at is null or p_fetched_at>clock_timestamp()+interval '1 minute' or p_fetched_at<clock_timestamp()-interval '15 minutes'
 or jsonb_typeof(p_channels) is distinct from 'array' or jsonb_array_length(p_channels) not between 1 and 10000
 or arkhen_private.safe_shared_payload(jsonb_build_object('channels',p_channels)) is distinct from true then raise exception 'Invalid complete EPG snapshot' using errcode='22023';end if;
 if exists(select 1 from jsonb_array_elements(p_channels) c where jsonb_typeof(c)<>'object' or coalesce(c->>'channel_id','')!~'^[0-9]{1,12}$' or jsonb_typeof(c->'payload'->'list') is distinct from 'array')
 or (select count(distinct c->>'channel_id') from jsonb_array_elements(p_channels)c)<>jsonb_array_length(p_channels) then raise exception 'Invalid EPG channel identity' using errcode='22023';end if;
 if exists(select 1 from jsonb_array_elements(p_channels)c cross join lateral jsonb_array_elements(c->'payload'->'list')p
  where jsonb_typeof(p)<>'object' or length(coalesce(p->>'title','')) not between 1 and 1000 or length(coalesce(p->>'description',''))>5000
   or p->>'start' is null or p->>'end' is null or (p->>'start')::timestamptz>=(p->>'end')::timestamptz) then raise exception 'Invalid EPG programme' using errcode='22023';end if;
 select count(*),max((p->>'end')::timestamptz) into total,horizon from jsonb_array_elements(p_channels)c cross join lateral jsonb_array_elements(c->'payload'->'list')p;
 if total not between 1 and 250000 or horizon<=p_fetched_at then raise exception 'EPG snapshot has no current or future horizon' using errcode='22023';end if;
 insert into arkhen_private.epg_snapshot_candidates(job_id,content_hash,state,payload,fetched_at,channel_count,program_count,horizon_end)
 values(p_job_id,p_content_hash,'sealed',jsonb_build_object('channels',p_channels),p_fetched_at,jsonb_array_length(p_channels),total,horizon);
 return public.arkhen_epg_snapshot_state(p_job_id,p_worker);
end $$;

create function public.arkhen_epg_snapshot_publish(p_job_id uuid,p_worker text)
returns jsonb language plpgsql security invoker set search_path='' set statement_timeout='15s' as $$
declare job arkhen_private.cache_jobs;candidate arkhen_private.epg_snapshot_candidates;stamp timestamptz:=clock_timestamp();
begin
 select * into job from arkhen_private.cache_jobs where id=p_job_id;
 perform arkhen_private.assert_cache_lease(p_job_id,p_worker,job.provider_key,job.scope_hash,'epg');
 perform pg_advisory_xact_lock(hashtextextended('arkhen:epg:'||job.provider_key||':'||job.scope_hash,0));
 select * into candidate from arkhen_private.epg_snapshot_candidates where job_id=p_job_id for update;
 if not found then raise exception 'Sealed EPG candidate required' using errcode='55000';end if;
 if candidate.state in('published','superseded') then return public.arkhen_epg_snapshot_state(p_job_id,p_worker);end if;
 if exists(select 1 from public.epg_cache_versions where provider_key=job.provider_key and scope_hash=job.scope_hash and snapshot_fetched_at>candidate.fetched_at) then
  update arkhen_private.epg_snapshot_candidates set state='superseded',payload=null,published_at=stamp where job_id=p_job_id;
  return public.arkhen_epg_snapshot_state(p_job_id,p_worker);
 end if;
 insert into public.provider_epg_cache as current(provider_key,scope_hash,channel_id,payload,expires_at,updated_at)
 select job.provider_key,job.scope_hash,c->>'channel_id',c->'payload',candidate.fetched_at+interval '6 hours',stamp from jsonb_array_elements(candidate.payload->'channels')c
 on conflict(provider_key,scope_hash,channel_id) do update set payload=excluded.payload,expires_at=excluded.expires_at,updated_at=excluded.updated_at
 where(current.payload,current.expires_at) is distinct from(excluded.payload,excluded.expires_at);
 with wanted as materialized(select s->>'channel_id' channel_id from jsonb_array_elements(candidate.payload->'channels')s)
 delete from public.provider_epg_cache c where c.provider_key=job.provider_key and c.scope_hash=job.scope_hash
 and not exists(select 1 from wanted s where s.channel_id=c.channel_id);
 insert into public.epg_cache_versions(provider_key,scope_hash,revision,snapshot_fetched_at,snapshot_expires_at,source_next_refresh_at,horizon_end,channel_count,program_count,projection_version,as_of,next_refresh_at,updated_at)
 values(job.provider_key,job.scope_hash,candidate.snapshot_id,candidate.fetched_at,candidate.fetched_at+interval '6 hours',candidate.fetched_at+interval '6 hours',candidate.horizon_end,candidate.channel_count,candidate.program_count,candidate.snapshot_id::text||':'||extract(epoch from stamp)::text,stamp,stamp,stamp)
 on conflict(provider_key,scope_hash) do update set revision=excluded.revision,snapshot_fetched_at=excluded.snapshot_fetched_at,snapshot_expires_at=excluded.snapshot_expires_at,source_next_refresh_at=excluded.source_next_refresh_at,horizon_end=excluded.horizon_end,is_legacy=false,channel_count=excluded.channel_count,program_count=excluded.program_count,projection_version=excluded.projection_version,as_of=excluded.as_of,next_refresh_at=excluded.next_refresh_at,updated_at=excluded.updated_at;
 delete from arkhen_private.epg_projection_cache where provider_key=job.provider_key and scope_hash=job.scope_hash;
 update arkhen_private.epg_snapshot_candidates set state='published',payload=null,published_at=stamp where job_id=p_job_id;
 return public.arkhen_epg_snapshot_state(p_job_id,p_worker);
end $$;

create function arkhen_private.epg_program_json(p_title text,p_description text,p_start timestamptz,p_end timestamptz,p_time_zone text)
returns jsonb language sql stable parallel safe security invoker set search_path='' as $$
 select jsonb_build_object('title',p_title,'description',coalesce(p_description,''),'start',p_start,'end',p_end,'startLabel',to_char(p_start at time zone p_time_zone,'HH24:MI'),'endLabel',to_char(p_end at time zone p_time_zone,'HH24:MI'))
$$;

-- Called by the trusted API and cron. This caches ALL eligible channels once;
-- requested IDs are filtered only after the shared calculation has completed.
create function arkhen_private.refresh_tv_guide(p_provider_key text,p_scope_hash text,p_include_adult boolean,p_time_zone text)
returns jsonb language plpgsql security invoker set search_path='' set statement_timeout='8s' as $$
declare registry public.epg_cache_versions;cached arkhen_private.epg_projection_cache;generation uuid;stamp timestamptz;refresh_at timestamptz;channels jsonb;result jsonb;
begin
 if p_provider_key is null or p_provider_key!~'^[a-f0-9]{64}$' or p_scope_hash is null or p_scope_hash!~'^[a-f0-9]{64}$' or p_include_adult is null or p_time_zone is null or p_time_zone not in('America/Maceio','America/Sao_Paulo','UTC') then raise exception 'Invalid TV guide partition' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended('arkhen:epg:'||p_provider_key||':'||p_scope_hash,0));
 stamp:=clock_timestamp();
 select * into registry from public.epg_cache_versions where provider_key=p_provider_key and scope_hash=p_scope_hash;
 if not found then return null;end if;
 select generation_id into generation from public.catalog_visible_generations where provider_key=p_provider_key and scope_hash=p_scope_hash and media_type='live';
 if registry.next_refresh_at<=stamp then
  update public.epg_cache_versions set projection_version=revision::text||':'||extract(epoch from stamp)::text,as_of=stamp,next_refresh_at=date_trunc('minute',stamp)+interval '1 minute',updated_at=stamp
  where provider_key=p_provider_key and scope_hash=p_scope_hash returning * into registry;
 end if;
 select * into cached from arkhen_private.epg_projection_cache where provider_key=p_provider_key and scope_hash=p_scope_hash and include_adult=p_include_adult and time_zone=p_time_zone;
 if found and cached.revision=registry.revision and cached.catalog_generation is not distinct from generation and cached.projection_version=registry.projection_version and cached.next_refresh_at>stamp then return jsonb_set(cached.payload,'{serverTime}',to_jsonb(clock_timestamp()));end if;
 with eligible as materialized(
  select m.media_id from public.catalog_media m where m.provider_key=p_provider_key and m.scope_hash=p_scope_hash and m.media_type='live' and m.generation_id=generation and m.is_active and(p_include_adult or not m.is_adult)
 ),programs as materialized(
  select c.channel_id,p.title,p.description,t.start_at,t.end_at from eligible e join public.provider_epg_cache c on(c.provider_key,c.scope_hash,c.channel_id)=(p_provider_key,p_scope_hash,e.media_id)
  cross join lateral jsonb_to_recordset(c.payload->'list') as p(title text,description text,"start" timestamptz,"end" timestamptz)
  cross join lateral(select p."start" start_at,p."end" end_at)t
  where p.title<>'' and t.end_at>t.start_at
 ),previous as(
  select distinct on(channel_id) channel_id,title,description,start_at,end_at from programs where end_at<=stamp order by channel_id,end_at desc,start_at desc,title
 ),current as(
  select distinct on(channel_id) channel_id,title,description,start_at,end_at from programs where start_at<=stamp and end_at>stamp order by channel_id,start_at desc,end_at,title
 ),following as(
  select distinct on(channel_id) channel_id,title,description,start_at,end_at from programs where start_at>stamp order by channel_id,start_at,end_at,title
 ),windows as(
  select e.media_id,c.start_at,c.end_at,n.start_at next_start,
   case when p.channel_id is not null then arkhen_private.epg_program_json(p.title,p.description,p.start_at,p.end_at,p_time_zone) end previous_program,
   case when c.channel_id is not null then arkhen_private.epg_program_json(c.title,c.description,c.start_at,c.end_at,p_time_zone) end current_program,
   case when n.channel_id is not null then arkhen_private.epg_program_json(n.title,n.description,n.start_at,n.end_at,p_time_zone) end next_program
  from eligible e left join previous p on p.channel_id=e.media_id left join current c on c.channel_id=e.media_id left join following n on n.channel_id=e.media_id
 ),projected as(
  select media_id,least(end_at,next_start) next_change,
  jsonb_build_object('status',case when current_program is not null or next_program is not null then 'ready' else 'unavailable' end,
   'list',to_jsonb(array_remove(array[previous_program,current_program,next_program],null)),
   'window',jsonb_build_object('previous',previous_program,'current',current_program,'next',next_program),
   'progressPercent',case when end_at is not null then round(greatest(0,least(100,100*extract(epoch from(stamp-start_at))/extract(epoch from(end_at-start_at)))),2) end,
   'elapsedSeconds',case when end_at is not null then floor(extract(epoch from(stamp-start_at))) end,
   'remainingSeconds',case when end_at is not null then ceil(extract(epoch from(end_at-stamp))) end,
   'nextChangeAt',least(end_at,next_start)) value from windows
 )select coalesce(jsonb_object_agg(media_id,value order by media_id),'{}'),least(date_trunc('minute',stamp)+interval '1 minute',min(next_change) filter(where next_change>stamp),case when registry.snapshot_expires_at>stamp then registry.snapshot_expires_at end) into channels,refresh_at from projected;
 result:=jsonb_build_object('schemaVersion',1,'revision',registry.revision,'projectionVersion',registry.projection_version,'asOf',stamp,'serverTime',stamp,'timeZone',p_time_zone,'nextRefreshAt',refresh_at,
 'sourceNextRefreshAt',registry.source_next_refresh_at,'snapshotFetchedAt',registry.snapshot_fetched_at,'snapshotExpiresAt',registry.snapshot_expires_at,'horizonEnd',registry.horizon_end,
 'stale',registry.snapshot_expires_at<=stamp or coalesce(registry.horizon_end<=stamp,true),'legacySnapshot',registry.is_legacy,'channels',channels);
 insert into arkhen_private.epg_projection_cache(provider_key,scope_hash,include_adult,time_zone,revision,catalog_generation,projection_version,as_of,next_refresh_at,payload)
 values(p_provider_key,p_scope_hash,p_include_adult,p_time_zone,registry.revision,generation,registry.projection_version,stamp,refresh_at,result)
 on conflict(provider_key,scope_hash,include_adult,time_zone) do update set revision=excluded.revision,catalog_generation=excluded.catalog_generation,projection_version=excluded.projection_version,as_of=excluded.as_of,next_refresh_at=excluded.next_refresh_at,payload=excluded.payload;
 update public.epg_cache_versions set next_refresh_at=least(next_refresh_at,refresh_at) where provider_key=p_provider_key and scope_hash=p_scope_hash and next_refresh_at>refresh_at;
 return result;
end $$;

create function public.arkhen_tv_guide(p_provider_key text,p_scope_hash text,p_channel_ids text[] default null,p_include_adult boolean default false,p_time_zone text default 'America/Maceio')
returns jsonb language plpgsql security invoker set search_path='' set statement_timeout='8s' as $$
declare result jsonb;channels jsonb;
begin
 if p_channel_ids is not null and(cardinality(p_channel_ids)>2000 or array_ndims(p_channel_ids)>1 or exists(select 1 from unnest(p_channel_ids)id where id is null or id!~'^[0-9]{1,12}$')) then raise exception 'Invalid TV guide channel batch' using errcode='22023';end if;
 result:=arkhen_private.refresh_tv_guide(p_provider_key,p_scope_hash,p_include_adult,p_time_zone);
 if result is not null then result:=jsonb_set(result,'{serverTime}',to_jsonb(clock_timestamp()));end if;
 if result is null or p_channel_ids is null then return result;end if;
 select coalesce(jsonb_object_agg(key,value),'{}') into channels from jsonb_each(result->'channels') where key=any(p_channel_ids);
 return jsonb_set(result,'{channels}',channels);
end $$;

create function public.arkhen_tick_tv_guides()
returns integer language plpgsql security invoker set search_path='' set statement_timeout='20s' as $$
declare registry record;total integer:=0;
begin
 for registry in select provider_key,scope_hash from public.epg_cache_versions where next_refresh_at<=clock_timestamp() order by next_refresh_at limit 8 loop
  perform arkhen_private.refresh_tv_guide(registry.provider_key,registry.scope_hash,false,'America/Maceio');
  perform arkhen_private.refresh_tv_guide(registry.provider_key,registry.scope_hash,true,'America/Maceio');
  total:=total+1;
 end loop;
 return total;
end $$;

-- A sealed candidate contains only sanitized metadata: its publication can
-- finish after the encrypted provider capability expires. FETCH still cannot.
create or replace function public.arkhen_claim_cloud_cache_jobs(p_worker text)
returns table(id uuid,provider_key text,scope_hash text,job_type text,payload jsonb,attempts integer)
language plpgsql security invoker set search_path='' as $$
begin
 if p_worker is null or length(p_worker) not between 1 and 160 then raise exception 'Invalid worker';end if;
 update arkhen_private.cache_jobs j set status='failed',finished_at=now(),error_code='lease_exhausted' where j.status='leased' and j.lease_until<now() and j.attempts>=8;
 return query with picked as(
  select j.id from arkhen_private.cache_jobs j where((j.status='queued' and j.run_after<=now()) or(j.status='leased' and j.lease_until<now())) and j.attempts<8
  and exists(select 1 from arkhen_private.cache_sources s where s.provider_key=j.provider_key and s.scope_hash=j.scope_hash and s.enabled)
  and(exists(select 1 from arkhen_private.provider_sources s where s.provider_key=j.provider_key and s.scope_hash=j.scope_hash and s.expires_at>now())
   or(j.job_type='epg' and exists(select 1 from arkhen_private.epg_snapshot_candidates c where c.job_id=j.id and c.state in('sealed','published','superseded'))))
  order by j.run_after,j.created_at for update skip locked limit 1
 )update arkhen_private.cache_jobs j set status='leased',locked_by=p_worker,lease_until=now()+interval '180 seconds',attempts=j.attempts+1 from picked where j.id=picked.id
 returning j.id,j.provider_key,j.scope_hash,j.job_type,j.payload,j.attempts;
end $$;

-- Reader-driven refresh cannot bypass the source's six-hour cadence. Other
-- domains retain their existing manual-refresh behavior.
do $guard$declare definition text;body text;begin
 select pg_get_functiondef(oid),prosrc into definition,body from pg_proc where oid='public.arkhen_request_cache_refresh(text,text,text,jsonb)'::regprocedure;
 if position('p_job_type=''epg''' in body)>0 then raise exception 'EPG refresh cadence version mismatch';end if;
 execute replace(definition,body,regexp_replace(body,'\mbegin\M',E'begin\n if p_job_type=''epg'' then return 0;end if;'));
end $guard$;

create or replace function public.arkhen_source_put(p_provider_key text,p_scope_hash text,p_source_id text,p_cipher jsonb,p_expires_at timestamptz)
returns void language plpgsql security invoker set search_path='' as $$
begin
 if p_expires_at is null or p_expires_at<=now() or p_expires_at>now()+interval '391 minutes' or arkhen_private.source_cipher_valid(p_cipher) is distinct from true then raise exception 'Invalid encrypted source';end if;
 insert into arkhen_private.provider_sources(provider_key,scope_hash,source_id,cipher,expires_at) values(p_provider_key,p_scope_hash,p_source_id,p_cipher,p_expires_at)
 on conflict(provider_key,scope_hash,source_id) do update set cipher=excluded.cipher,expires_at=excluded.expires_at,updated_at=now();
 delete from arkhen_private.provider_sources where expires_at<now();
end $$;

revoke all on function public.arkhen_epg_snapshot_state(uuid,text),public.arkhen_epg_snapshot_stage(uuid,text,jsonb,text,timestamptz),public.arkhen_epg_snapshot_publish(uuid,text),public.arkhen_tv_guide(text,text,text[],boolean,text),public.arkhen_tick_tv_guides(),arkhen_private.epg_program_json(text,text,timestamptz,timestamptz,text),arkhen_private.refresh_tv_guide(text,text,boolean,text) from public,anon,authenticated;
grant execute on function public.arkhen_epg_snapshot_state(uuid,text),public.arkhen_epg_snapshot_stage(uuid,text,jsonb,text,timestamptz),public.arkhen_epg_snapshot_publish(uuid,text),public.arkhen_tv_guide(text,text,text[],boolean,text),public.arkhen_tick_tv_guides(),arkhen_private.epg_program_json(text,text,timestamptz,timestamptz,text),arkhen_private.refresh_tv_guide(text,text,boolean,text) to service_role;
-- An outdated worker must fail safely rather than mutate the new snapshot
-- behind its registry or resume the historical 50k-program publication path.
revoke execute on function public.arkhen_publish_epg(text,text,text,jsonb,timestamptz,uuid,text),public.arkhen_publish_epg_batch(text,text,jsonb,timestamptz,uuid,text) from service_role;

do $realtime$begin
 if exists(select 1 from pg_publication where pubname='supabase_realtime') then
  if exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='provider_epg_cache') then alter publication supabase_realtime drop table public.provider_epg_cache;end if;
  if exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='epg_programs') then alter publication supabase_realtime drop table public.epg_programs;end if;
  alter publication supabase_realtime add table public.epg_cache_versions;
 end if;
end $realtime$;
do $cron$begin
 if to_regprocedure('cron.schedule(text,text,text)') is not null then perform cron.schedule('arkhen-tv-guide-clock','* * * * *','select public.arkhen_tick_tv_guides();');end if;
end $cron$;
-- Initialize the new registry through one real, complete collection; do not
-- mislabel the old independently published rows as a new complete snapshot.
with inserted as(
 insert into arkhen_private.cache_jobs(provider_key,scope_hash,job_type)
 select provider_key,scope_hash,'epg' from arkhen_private.cache_sources where enabled
 on conflict do nothing returning provider_key,scope_hash
)update arkhen_private.cache_sources s set last_epg_enqueued_at=now() from inserted i where(s.provider_key,s.scope_hash)=(i.provider_key,i.scope_hash);
notify pgrst,'reload schema';
commit;
