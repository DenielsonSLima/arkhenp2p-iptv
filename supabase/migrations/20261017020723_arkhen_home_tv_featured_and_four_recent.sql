-- Home TV: one weekly/default feature plus up to four real recent channels.
-- Only the owner-scoped projection changes. No history write, heartbeat,
-- 168-hour bucket accounting, EPG collection or playback transport changes.
begin;
set local lock_timeout='5s';
set local statement_timeout='15s';

create or replace function public.arkhen_home_tv(
 p_provider_key text,p_scope_hash text,p_channel_ids text[],p_hidden_categories text[],p_hidden_items text[]
) returns jsonb language plpgsql stable security definer set search_path=''
 set statement_timeout='3s' set jit='off' as $$
declare owner uuid:=(select auth.uid());ids text[];snapshot uuid;account_provider text;result jsonb;
 window_end timestamptz:=now();window_start timestamptz:=now()-interval '168 hours';
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
 ), window_time as materialized(
  -- At most 169 hourly buckets per watched channel; only boundary hours need
  -- span intersections. Legacy lifetime totals never become dated evidence.
  select b.channel_id,sum(case
   when b.bucket_start>=window_start and b.bucket_start+interval '1 hour'<=window_end then b.watched_milliseconds
   else arkhen_private.tv_watch_span_milliseconds(b.credited_spans*tstzmultirange(tstzrange(window_start,window_end,'[)')))
  end)::bigint watched_milliseconds
  from arkhen_private.user_tv_watch_buckets b join allowed_ids a using(channel_id)
  where(b.user_id,b.provider_key,b.scope_hash)=(owner,p_provider_key,p_scope_hash)
   and b.bucket_start>=date_trunc('hour',window_start at time zone 'UTC') at time zone 'UTC'
   and b.bucket_start<=window_end
  group by b.channel_id
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
   select s.channel_id,coalesce(w.watched_milliseconds,0) watched_milliseconds,s.last_watched_at from arkhen_private.user_tv_watch_time s
   join allowed_ids a using(channel_id) left join window_time w using(channel_id) where(s.user_id,s.provider_key,s.scope_hash)=(owner,p_provider_key,p_scope_hash)
   union all select * from legacy_recent
  ) private_history group by channel_id
 ), catalog_candidates as materialized(
  -- Read metadata only for actual private history or possible Globo defaults;
  -- unrelated live channels do not enter the JSON/privacy/ranking stages.
  select m.media_id,m.name,m.metadata,m.sort_order,m.is_active,m.is_adult,m.category_ids,
   trim(regexp_replace(public.arkhen_query_normalize(m.name),'[^a-z0-9]+',' ','g')) normalized_name
  from allowed_ids a join public.catalog_media m
  on(m.provider_key,m.scope_hash,m.media_type,m.generation_id,m.media_id)=(p_provider_key,p_scope_hash,'live',snapshot,a.channel_id)
  where exists(select 1 from history h where h.channel_id=m.media_id)
   or trim(regexp_replace(public.arkhen_query_normalize(m.name),'[^a-z0-9]+',' ','g')) ~ '^(?:(?:tv|rede) +)?globo(?: |$)'
 ), safe_catalog as materialized(
  -- Shared eligibility applies equally to measured, recent and default rows.
  -- The default never bypasses availability, adult or account-hidden filters.
  select m.media_id channel_id,m.name,m.metadata,m.sort_order,m.normalized_name,
   trim(regexp_replace(public.arkhen_query_normalize(m.name),
    '(?: +(?:\[|\()?(?:full *hd|sd|hd|fhd|uhd|4k|(?:480|576|720|1080|1440|2160)p|hevc|avc|[hx][. -]?26[45])(?:\]|\))?)+$','','g')) live_identity
  from catalog_candidates m
  where m.is_active and not m.is_adult and coalesce(m.metadata->>'available','true')<>'false'
   and not public.arkhen_progress_metadata_adult(m.metadata) and not m.media_id=any(p_hidden_items)
   and not exists(select 1 from adult_categories c where c.category_id=any(m.category_ids))
   and(cardinality(m.category_ids)=0 or exists(select 1 from unnest(m.category_ids) id where not id=any(p_hidden_categories)))
 ), eligible as materialized(
  select h.*,c.metadata,c.live_identity from history h join safe_catalog c using(channel_id)
 ), most_watched as materialized(
  select * from eligible where watched_milliseconds>0 order by watched_milliseconds desc,last_watched_at desc,channel_id limit 1
 ), default_globo as materialized(
  -- Prefer generic Globo. Otherwise choose the first Globo affiliate in
  -- native catalogue order as an editorial default, preserving its full name.
  -- No claim is made about the account's region; News/Globoplay do not qualify.
  select c.channel_id,0::bigint watched_milliseconds,null::timestamptz last_watched_at,c.metadata,c.live_identity
  from safe_catalog c where not exists(select 1 from most_watched)
   and(c.normalized_name ~ '^(?:(?:tv|rede) +)?globo(?: +(?:sd|hd|fhd|uhd|4k|full *hd|(?:480|576|720|1080|1440|2160)p|hevc|avc|[hx] *26[45]))*$'
    or c.normalized_name ~ '^globo (?!news(?: |$)|play(?: |$))')
  order by case when c.normalized_name ~ '^(?:(?:tv|rede) +)?globo(?: +(?:sd|hd|fhd|uhd|4k|full *hd|(?:480|576|720|1080|1440|2160)p|hevc|avc|[hx] *26[45]))*$' then 0 else 1 end,
   c.sort_order,c.channel_id limit 1
 ), featured as materialized(
  select m.*,'most-watched'::text reason from most_watched m union all
  select d.*,'default-globo'::text reason from default_globo d
 ), recent_candidates as materialized(
  -- Versions with the same complete channel label occupy one recent slot.
  -- Only terminal delivery tags leave this identity; region/numbers remain.
  select distinct on(e.live_identity) e.* from eligible e
  where not exists(select 1 from featured f where f.live_identity=e.live_identity)
  order by e.live_identity,e.last_watched_at desc,e.channel_id
 ), recent as materialized(
  select * from recent_candidates order by last_watched_at desc,channel_id limit 4
 ), selected as(
  select f.channel_id,f.watched_milliseconds,f.last_watched_at,f.metadata,0 position,f.reason from featured f union all
  select r.channel_id,r.watched_milliseconds,r.last_watched_at,r.metadata,
   row_number() over(order by r.last_watched_at desc,r.channel_id)::integer position,'recent'::text reason from recent r
 )
 select jsonb_build_object('schemaVersion',1,'source','rpc','generatedAt',window_end,'snapshotVersion',snapshot,
  'windowStart',window_start,'windowEnd',window_end,
  'revision',coalesce((select v.revision from public.user_tv_watch_versions v where(v.user_id,v.provider_key,v.scope_hash)=(owner,p_provider_key,p_scope_hash)),0),
  'mostWatchedId',(select channel_id from most_watched),
  'featuredId',(select channel_id from featured),
  'items',coalesce(jsonb_agg(jsonb_build_object('item',metadata||jsonb_build_object('id',channel_id,'kind','live','isAdult',false),
   'reason',reason,'watchedSeconds',floor(watched_milliseconds::numeric/1000),'lastWatchedAt',last_watched_at) order by position),'[]'::jsonb)
 ) into result from selected;
 return result;
end $$;

revoke all on function public.arkhen_home_tv(text,text,text[],text[],text[]) from public,anon,authenticated;
grant execute on function public.arkhen_home_tv(text,text,text[],text[],text[]) to authenticated;
notify pgrst,'reload schema';
commit;
