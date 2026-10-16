-- ARKHEN: private TV watch time and a separate, bounded four-card Home read.
-- No migration of user_progress/open events into invented watched seconds.
-- Existing owner-scoped live playing history can supply recent IDs at zero
-- measured time; it is read only and can never become the most-watched row.
-- Both RPCs derive the owner from the validated JWT and check its live account
-- partition. Only the backend's current real player attempt sends heartbeats;
-- previews never call this API. No position, duration or client clock is input.
-- SQL measures intervals between pulses: initial/resume pulse adds zero;
-- previous playing time is capped at 20s and a gap >35s is never filled in.
-- Backend pulses every15s and sends playing=false on pause/waiting/stop/error.
-- One owner/partition lease serializes updates, deduplicates sequences and
-- retires previous session IDs. The backend also rejects old attempts before
-- dispatch. No per-channel/provider request, collection, cron or Home v1 change.
-- Stats/lease have RLS and no authenticated table grants. The only published
-- row is an owner-scoped revision, throttled to 30s plus session/stop boundaries.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

create table arkhen_private.user_tv_watch_time(
 user_id uuid not null references public.profiles(id) on delete cascade,
 provider_key text not null,scope_hash text not null,
 channel_id text not null check(channel_id ~ '^[0-9]{1,12}$'),
 watched_milliseconds bigint not null default 0 check(watched_milliseconds between 0 and 9007199254740000),
 last_watched_at timestamptz not null,
 primary key(user_id,provider_key,scope_hash,channel_id)
);
comment on table arkhen_private.user_tv_watch_time is 'ARKHEN v1: owner-scoped real TV heartbeat time; never global or directly client-writable';

create table arkhen_private.user_tv_watch_sessions(
 user_id uuid not null references public.profiles(id) on delete cascade,
 provider_key text not null,scope_hash text not null,
 session_id uuid not null,channel_id text not null check(channel_id ~ '^[0-9]{1,12}$'),
 last_sequence bigint not null default -1 check(last_sequence between -1 and 9007199254740991),
 playing boolean not null default false,last_heartbeat_at timestamptz not null,
 retired_session_ids uuid[] not null default '{}' check(cardinality(retired_session_ids)<=64),
 primary key(user_id,provider_key,scope_hash)
);
comment on table arkhen_private.user_tv_watch_sessions is 'ARKHEN v1: private bounded active TV measurement lease; no playback URLs or credentials';

create table public.user_tv_watch_versions(
 user_id uuid not null references public.profiles(id) on delete cascade,
 provider_key text not null,scope_hash text not null,
 revision bigint not null default 1 check(revision between 1 and 9007199254740991),
 updated_at timestamptz not null default now(),
 primary key(user_id,provider_key,scope_hash)
);
comment on table public.user_tv_watch_versions is 'ARKHEN v1: compact owner-scoped TV watch revision; no channel IDs, times or payloads';

alter table arkhen_private.user_tv_watch_time enable row level security;
alter table arkhen_private.user_tv_watch_sessions enable row level security;
alter table public.user_tv_watch_versions enable row level security;
revoke all on table arkhen_private.user_tv_watch_time,arkhen_private.user_tv_watch_sessions,public.user_tv_watch_versions from public,anon,authenticated;
grant all on table arkhen_private.user_tv_watch_time,arkhen_private.user_tv_watch_sessions,public.user_tv_watch_versions to service_role;
grant select on public.user_tv_watch_versions to authenticated;
create policy arkhen_tv_watch_version_owner_read on public.user_tv_watch_versions for select to authenticated using(
 user_id=(select auth.uid()) and public.arkhen_partition_allows(provider_key,scope_hash)
);

create function public.arkhen_tv_watch_heartbeat(
 p_provider_key text,p_scope_hash text,p_channel_id text,p_session_id uuid,p_sequence bigint,p_playing boolean
) returns jsonb language plpgsql volatile security definer set search_path=''
 set statement_timeout='3s' set lock_timeout='500ms' as $$
declare
 owner uuid:=(select auth.uid());lease arkhen_private.user_tv_watch_sessions%rowtype;
 stamp timestamptz;elapsed numeric;credit bigint:=0;changed_session boolean:=false;version bigint;
begin
 if owner is null or not coalesce(public.arkhen_partition_allows(p_provider_key,p_scope_hash),false) then
  raise exception 'TV watch access denied' using errcode='42501';
 end if;
 if p_channel_id is null or p_channel_id !~ '^[0-9]{1,12}$' or p_session_id is null
  or p_sequence is null or p_sequence<0 or p_sequence>9007199254740991 or p_playing is null then
  raise exception 'Invalid TV watch parameters' using errcode='22023';
 end if;
 -- Explicit trusted current-generation checks also apply inside this definer.
 -- A PIN unlock never relaxes adult/history exclusion. Availability/hidden
 -- filters of the account's current player are additionally enforced upstream.
 if not exists(
  select 1 from public.catalog_visible_generations g
  join public.catalog_media m on(m.provider_key,m.scope_hash,m.media_type,m.generation_id,m.media_id)=
   (g.provider_key,g.scope_hash,g.media_type,g.generation_id,p_channel_id)
  where(g.provider_key,g.scope_hash,g.media_type)=(p_provider_key,p_scope_hash,'live')
   and m.is_active and not m.is_adult and coalesce(m.metadata->>'available','true')<>'false'
   and not public.arkhen_progress_metadata_adult(m.metadata)
   and not exists(select 1 from public.catalog_categories c
    where(c.provider_key,c.scope_hash,c.media_type,c.generation_id)=(g.provider_key,g.scope_hash,g.media_type,g.generation_id)
     and c.is_active and c.category_id=any(m.category_ids)
     and(c.is_adult or public.arkhen_progress_metadata_adult(jsonb_build_object('categoryName',c.name))))
 ) then
  -- A later adult/unavailable reclassification closes only this exact lease.
  -- It neither credits the interval nor leaves it open for a future recovery.
  update arkhen_private.user_tv_watch_sessions s set playing=false,last_heartbeat_at=clock_timestamp(),last_sequence=p_sequence
  where(s.user_id,s.provider_key,s.scope_hash,s.session_id,s.channel_id)=(owner,p_provider_key,p_scope_hash,p_session_id,p_channel_id)
   and s.last_sequence<p_sequence;
  return jsonb_build_object('schemaVersion',1,'accepted',false,'reason','channel-ineligible','creditedSeconds',0);
 end if;

 if p_sequence=0 then
  insert into arkhen_private.user_tv_watch_sessions(user_id,provider_key,scope_hash,session_id,channel_id,last_heartbeat_at)
  values(owner,p_provider_key,p_scope_hash,p_session_id,p_channel_id,clock_timestamp()) on conflict do nothing;
 end if;
 select * into lease from arkhen_private.user_tv_watch_sessions s
 where(s.user_id,s.provider_key,s.scope_hash)=(owner,p_provider_key,p_scope_hash) for update;
 if not found then return jsonb_build_object('schemaVersion',1,'accepted',false,'reason','session-not-started','creditedSeconds',0);end if;
 stamp:=clock_timestamp();
 if lease.session_id<>p_session_id then
  if p_sequence<>0 or p_session_id=any(lease.retired_session_ids) then
   return jsonb_build_object('schemaVersion',1,'accepted',false,'reason','stale-session','creditedSeconds',0);
  end if;
  lease.retired_session_ids:=array_append(lease.retired_session_ids,lease.session_id);
  if cardinality(lease.retired_session_ids)>64 then lease.retired_session_ids:=lease.retired_session_ids[2:65];end if;
  lease.session_id:=p_session_id;lease.channel_id:=p_channel_id;lease.last_sequence:=-1;
  lease.playing:=false;lease.last_heartbeat_at:=stamp;changed_session:=true;
 elsif lease.channel_id<>p_channel_id then
  raise exception 'TV watch session channel mismatch' using errcode='22023';
 end if;
 if p_sequence<=lease.last_sequence then
  return jsonb_build_object('schemaVersion',1,'accepted',true,'duplicate',true,'creditedSeconds',0);
 end if;
 changed_session:=changed_session or lease.last_sequence=-1;
 elapsed:=extract(epoch from(stamp-lease.last_heartbeat_at));
 if lease.playing and elapsed>0 and elapsed<=35 then credit:=least(20000,floor(elapsed*1000)::bigint);end if;
 update arkhen_private.user_tv_watch_sessions s set session_id=p_session_id,channel_id=p_channel_id,last_sequence=p_sequence,
  playing=p_playing,last_heartbeat_at=stamp,retired_session_ids=lease.retired_session_ids
 where(s.user_id,s.provider_key,s.scope_hash)=(owner,p_provider_key,p_scope_hash);

 if p_playing or credit>0 then
  insert into arkhen_private.user_tv_watch_time as stored_watch(user_id,provider_key,scope_hash,channel_id,watched_milliseconds,last_watched_at)
  values(owner,p_provider_key,p_scope_hash,p_channel_id,credit,stamp)
  on conflict(user_id,provider_key,scope_hash,channel_id) do update
  set watched_milliseconds=least(9007199254740000::bigint,stored_watch.watched_milliseconds+excluded.watched_milliseconds),
   last_watched_at=excluded.last_watched_at;
  insert into public.user_tv_watch_versions as current_version(user_id,provider_key,scope_hash,revision,updated_at)
  values(owner,p_provider_key,p_scope_hash,1,stamp)
  on conflict(user_id,provider_key,scope_hash) do update
  set revision=least(9007199254740991::bigint,current_version.revision+1),updated_at=excluded.updated_at
  where changed_session or not p_playing or current_version.updated_at<=stamp-interval '30 seconds'
  returning revision into version;
 end if;
 if version is null then select v.revision into version from public.user_tv_watch_versions v
  where(v.user_id,v.provider_key,v.scope_hash)=(owner,p_provider_key,p_scope_hash);end if;
 return jsonb_build_object('schemaVersion',1,'accepted',true,'creditedSeconds',credit::numeric/1000,'revision',coalesce(version,0),'serverTime',stamp);
end $$;

create function public.arkhen_home_tv(
 p_provider_key text,p_scope_hash text,p_channel_ids text[],p_hidden_categories text[],p_hidden_items text[]
) returns jsonb language plpgsql stable security definer set search_path=''
 set statement_timeout='3s' set jit='off' as $$
declare owner uuid:=(select auth.uid());ids text[];snapshot uuid;account_provider text;result jsonb;
begin
 if owner is null or not coalesce(public.arkhen_partition_allows(p_provider_key,p_scope_hash),false) then
  raise exception 'TV Home access denied' using errcode='42501';
 end if;
 for ids in select filters.value from(values(p_channel_ids),(p_hidden_categories),(p_hidden_items)) filters(value) loop
  if ids is null or coalesce(array_ndims(ids),1)<>1 or cardinality(ids)>2000
   or exists(select 1 from unnest(ids) id where id is null or id !~ '^[A-Za-z0-9_-]{1,160}$') then
   raise exception 'Invalid TV Home filters' using errcode='22023';
  end if;
 end loop;
 -- Validate each differently sized filter independently, without combining
 -- them into a rectangular array or inferring account scope from client IDs.
 select g.generation_id into snapshot from public.catalog_visible_generations g
 where(g.provider_key,g.scope_hash,g.media_type)=(p_provider_key,p_scope_hash,'live');
 if snapshot is null then return null;end if;
 select p.provider into account_provider from public.profiles p where p.id=owner;
 with allowed_ids as materialized(
  select distinct id channel_id from unnest(p_channel_ids) id
 ), adult_categories as materialized(
  select c.category_id from public.catalog_categories c
  where(c.provider_key,c.scope_hash,c.media_type,c.generation_id)=(p_provider_key,p_scope_hash,'live',snapshot)
   and c.is_active and(c.is_adult or public.arkhen_progress_metadata_adult(jsonb_build_object('categoryName',c.name)))
 ), legacy_recent as materialized(
  -- saveLiveWatch records the real player's playing event with time=0. Its
  -- old position/duration fields are ignored, not converted into watch time.
  -- Definer access repeats owner/provider/shape/tombstone/privacy constraints;
  -- the current trusted catalog is checked once for this bounded union below.
  select a.channel_id,0::bigint watched_milliseconds,p.updated_at last_watched_at
  from allowed_ids a join public.user_progress p
  on(p.user_id,p.provider,p.item_key,p.episode_id)=(owner,account_provider,'live:'||a.channel_id,'')
  where p.deleted_at is null and p.entry#>>'{item,kind}'='live' and p.entry#>>'{item,id}'=a.channel_id
   and length(coalesce(p.entry#>>'{item,name}',''))>0
   and not public.arkhen_progress_metadata_adult(p.entry) and not public.arkhen_progress_metadata_adult(p.entry->'item')
   and not public.arkhen_progress_metadata_adult(p.entry->'episode')
 ), history as materialized(
  select channel_id,max(watched_milliseconds) watched_milliseconds,max(last_watched_at) last_watched_at from(
   select s.channel_id,s.watched_milliseconds,s.last_watched_at from arkhen_private.user_tv_watch_time s
   join allowed_ids a using(channel_id) where(s.user_id,s.provider_key,s.scope_hash)=(owner,p_provider_key,p_scope_hash)
   union all select * from legacy_recent
  ) private_history group by channel_id
 ), eligible as materialized(
  select s.*,m.metadata from history s join public.catalog_media m
  on(m.provider_key,m.scope_hash,m.media_type,m.generation_id,m.media_id)=(p_provider_key,p_scope_hash,'live',snapshot,s.channel_id)
  where m.is_active and not m.is_adult and coalesce(m.metadata->>'available','true')<>'false'
   and not public.arkhen_progress_metadata_adult(m.metadata) and not m.media_id=any(p_hidden_items)
   and not exists(select 1 from adult_categories c where c.category_id=any(m.category_ids))
   and(cardinality(m.category_ids)=0 or exists(select 1 from unnest(m.category_ids) id where not id=any(p_hidden_categories)))
 ), most_watched as materialized(
  select * from eligible where watched_milliseconds>0 order by watched_milliseconds desc,last_watched_at desc,channel_id limit 1
 ), recent as materialized(
  select e.* from eligible e where not exists(select 1 from most_watched m where m.channel_id=e.channel_id)
  order by e.last_watched_at desc,e.channel_id limit 3
 ), selected as(
  select m.*,0 position,'most-watched'::text reason from most_watched m union all
  select r.*,row_number() over(order by r.last_watched_at desc,r.channel_id)::integer position,'recent'::text reason from recent r
 )
 select jsonb_build_object('schemaVersion',1,'source','rpc','generatedAt',now(),'snapshotVersion',snapshot,
  'revision',coalesce((select v.revision from public.user_tv_watch_versions v where(v.user_id,v.provider_key,v.scope_hash)=(owner,p_provider_key,p_scope_hash)),0),
  'mostWatchedId',(select channel_id from most_watched),
  'items',coalesce(jsonb_agg(jsonb_build_object('item',metadata||jsonb_build_object('id',channel_id,'kind','live','isAdult',false),
   'reason',reason,'watchedSeconds',floor(watched_milliseconds::numeric/1000),'lastWatchedAt',last_watched_at) order by position),'[]'::jsonb)
 ) into result from selected;
 return result;
end $$;

revoke all on function public.arkhen_tv_watch_heartbeat(text,text,text,uuid,bigint,boolean),public.arkhen_home_tv(text,text,text[],text[],text[]) from public,anon,authenticated;
grant execute on function public.arkhen_tv_watch_heartbeat(text,text,text,uuid,bigint,boolean),public.arkhen_home_tv(text,text,text[],text[],text[]) to authenticated;
do $publication$ begin
 if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='user_tv_watch_versions') then
  alter publication supabase_realtime add table public.user_tv_watch_versions;
 end if;
end $publication$;
notify pgrst,'reload schema';
commit;
