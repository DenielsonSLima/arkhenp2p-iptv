-- Home optimization after the compact v1 read still reached SQLSTATE57014.
-- Keep the same private API, RLS, exact favorite counts, destination caps,
-- generation revisions and 8s SQL budget. No new cache/cron/index/policy.
-- Globally score only the top6 private genre weights, <=300 IDs per genre
-- and VOD domain, then <=300 affinity +300 rating IDs per domain. Category,
-- adult, hidden and watched eligibility is checked only on that bounded pool.
-- JSON arrays are read by bounded index; no full itemIds/rating expansion.
-- This is a documented candidate sample and can return fewer valid titles.
--
-- Rollout / recovery:
-- - Apply after 20261016050044; its current-identity index remains in use.
-- - Read back this function's bounded genre/rating stages and invoker/grants.
--   A committed definition is not proof of a completed user RPC or latency.
-- - Keep SQL8s and the already aligned HTTP/client budgets unchanged. Compare
--   only new request logs/statistics deltas; pre-rollout averages mix old work.
-- - HomeCloudModel can be blocked after three backoffs. Recover with the
--   existing manual retry, client reload/new connection or a real validated
--   offline/connecting -> synced transition. Progress revisions do not unlock it.
-- - No favorite/progress cleanup or bootstrap/login is part of this rollout.
--   The existing snapshot and exact counts are independent of candidate caps.
-- - Failure of this transaction preserves the previous committed definition.
--   Further tuning requires new phase evidence, not another timeout increase.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

create or replace function public.arkhen_home_library(
 p_provider_key text,p_scope_hash text,p_include_adult boolean default false,
 p_hidden_categories jsonb default '{}',p_hidden_items jsonb default '{}'
) returns jsonb language plpgsql stable security invoker set search_path=''
 set statement_timeout='8s' set jit='off' as $$
declare owner uuid:=(select auth.uid());account_provider text;input_kind text;values_json jsonb;result jsonb;
begin
 if owner is null or not coalesce(public.arkhen_partition_allows(p_provider_key,p_scope_hash),false) then
  raise exception 'Home access denied' using errcode='42501';
 end if;
 if p_include_adult is null or jsonb_typeof(p_hidden_categories) is distinct from 'object'
  or jsonb_typeof(p_hidden_items) is distinct from 'object'
  or octet_length(p_hidden_categories::text)+octet_length(p_hidden_items::text)>65536 then
  raise exception 'Invalid home parameters' using errcode='22023';
 end if;
 foreach input_kind in array array['live','movies','series'] loop
  foreach values_json in array array[coalesce(p_hidden_categories->input_kind,'[]'),coalesce(p_hidden_items->input_kind,'[]')] loop
   if jsonb_typeof(values_json)<>'array' then raise exception 'Invalid home exclusions' using errcode='22023';end if;
   if jsonb_array_length(values_json)>2000 or exists(
    select 1 from jsonb_array_elements(values_json) item where jsonb_typeof(item)<>'string' or length(item#>>'{}')>160
   ) then raise exception 'Invalid home exclusions' using errcode='22023';end if;
  end loop;
 end loop;
 select provider into account_provider from public.profiles where id=owner;
 -- Missing global preparation is still explicit unavailability, not empty
 -- success and not an on-demand collection/backfill inside a user's read.
 if exists(select 1 from public.catalog_media m join public.catalog_visible_generations g using(provider_key,scope_hash,media_type,generation_id)
  where m.provider_key=p_provider_key and m.scope_hash=p_scope_hash and m.is_active and m.home_identity is null) then return null;end if;
 if exists(select 1 from public.catalog_visible_generations g
  where g.provider_key=p_provider_key and g.scope_hash=p_scope_hash and g.media_type in('movies','series')
   and not exists(select 1 from public.catalog_navigation_cache n
    where(n.provider_key,n.scope_hash,n.media_type,n.generation_id,n.include_adult)=
     (g.provider_key,g.scope_hash,g.media_type,g.generation_id,false))) then return null;end if;

 with generations as materialized(
  select media_type,generation_id from public.catalog_visible_generations
  where provider_key=p_provider_key and scope_hash=p_scope_hash
 ), models as materialized(
  select n.media_type,n.payload from public.catalog_navigation_cache n join generations g using(media_type,generation_id)
  where n.provider_key=p_provider_key and n.scope_hash=p_scope_hash and n.media_type in('movies','series') and not n.include_adult
 ), adult_categories as materialized(
  select c.media_type,array_agg(c.category_id) ids from public.catalog_categories c join generations g using(media_type,generation_id)
  where c.provider_key=p_provider_key and c.scope_hash=p_scope_hash and c.is_active
   and(c.is_adult or public.arkhen_progress_metadata_adult(jsonb_build_object('categoryName',c.name))) group by c.media_type
 ), progress as materialized(
  -- All private title/episode rows stay owner-filtered. Only the latest row of
  -- each title can affect a shelf; signals are bounded to 100 titles below.
  select distinct on(p.item_key) p.item_key,p.episode_id,p.entry,p.updated_at,split_part(p.item_key,':',1) kind,
   case split_part(p.item_key,':',1) when 'movie' then 'movies' else split_part(p.item_key,':',1) end media_type,
   substr(p.item_key,strpos(p.item_key,':')+1) media_id,
   public.arkhen_home_title_identity(split_part(p.item_key,':',1),p.entry->'item') saved_identity,
   case when jsonb_typeof(p.entry->'time')='number' then(p.entry->>'time')::numeric end watched_seconds
  from public.user_progress p where p.user_id=owner and p.provider=account_provider and p.deleted_at is null
   and split_part(p.item_key,':',1) in('live','movie','series')
   and p.item_key=concat(p.entry#>>'{item,kind}',':',p.entry#>>'{item,id}') and length(coalesce(p.entry#>>'{item,name}',''))>0
   and(split_part(p.item_key,':',1)<>'series' and p.episode_id='' or split_part(p.item_key,':',1)='series' and p.episode_id=p.entry#>>'{episode,id}')
   and not public.arkhen_progress_metadata_adult(p.entry) and not public.arkhen_progress_metadata_adult(p.entry->'item')
   and not public.arkhen_progress_metadata_adult(p.entry->'episode')
  order by p.item_key,p.updated_at desc,p.episode_id
 ), favorite as materialized(
  -- Counts remain exact: favorites are not sampled to the recommendation cap.
  select f.item_key,f.item,f.updated_at,split_part(f.item_key,':',1) kind,
   case split_part(f.item_key,':',1) when 'movie' then 'movies' else split_part(f.item_key,':',1) end media_type,
   substr(f.item_key,strpos(f.item_key,':')+1) media_id,
   array(select cid from(select coalesce(f.item->>'categoryId','') cid union
    select value from jsonb_array_elements_text(case when jsonb_typeof(f.item->'categoryIds')='array' then f.item->'categoryIds' else '[]' end) value
   ) ids where cid<>'') category_ids
  from public.user_favorites f where f.user_id=owner and f.provider=account_provider and f.deleted_at is null
   and split_part(f.item_key,':',1) in('live','movie','series')
   and f.item_key=concat(f.item->>'kind',':',f.item->>'id') and length(coalesce(f.item->>'name',''))>0
 ), private_ids as materialized(
  select media_type,media_id from progress union select media_type,media_id from favorite
 ), private_catalog as materialized(
  select m.media_type,m.media_id,m.category_ids,m.home_identity,m.sort_order,
   (m.is_adult or m.category_ids&&coalesce(a.ids,'{}'::text[]) or public.arkhen_progress_metadata_adult(m.metadata)) is_adult
  from private_ids p join generations g using(media_type)
  join public.catalog_media m on(m.provider_key,m.scope_hash,m.media_type,m.generation_id,m.media_id)=
   (p_provider_key,p_scope_hash,p.media_type,g.generation_id,p.media_id)
  left join adult_categories a on a.media_type=m.media_type where m.is_active
 ), private_visible as materialized(
  select m.* from private_catalog m where not m.is_adult and not coalesce(p_hidden_items->m.media_type,'[]') ? m.media_id
   and(cardinality(m.category_ids)=0 or exists(select 1 from unnest(m.category_ids) cid where not coalesce(p_hidden_categories->m.media_type,'[]') ? cid))
 ), favorite_visible as materialized(
  select f.* from favorite f left join private_catalog c using(media_type,media_id)
  where(p_include_adult or not coalesce(c.is_adult,public.arkhen_progress_metadata_adult(f.item),false))
   and not coalesce(p_hidden_items->f.media_type,'[]') ? f.media_id
   and(case when c.media_id is not null then cardinality(c.category_ids)=0 or exists(select 1 from unnest(c.category_ids) cid where not coalesce(p_hidden_categories->f.media_type,'[]') ? cid)
    else cardinality(f.category_ids)=0 or exists(select 1 from unnest(f.category_ids) cid where not coalesce(p_hidden_categories->f.media_type,'[]') ? cid) end)
 ), watched as materialized(
  select p.*,coalesce(c.home_identity,matched.home_identity,p.saved_identity) current_identity,
   coalesce(c.media_id,matched.media_id) current_id
  from progress p left join private_visible c using(media_type,media_id)
  left join lateral(
   select m.media_id,m.home_identity from generations g join public.catalog_media m
    on(m.provider_key,m.scope_hash,m.media_type,m.generation_id)=(p_provider_key,p_scope_hash,g.media_type,g.generation_id)
   left join adult_categories a on a.media_type=m.media_type
   where c.media_id is null and g.media_type=p.media_type and m.home_identity=p.saved_identity
    and m.is_active and not m.is_adult and m.home_identity is not null
    and not m.category_ids&&coalesce(a.ids,'{}'::text[]) and not public.arkhen_progress_metadata_adult(m.metadata)
    and not coalesce(p_hidden_items->m.media_type,'[]') ? m.media_id
    and(cardinality(m.category_ids)=0 or exists(select 1 from unnest(m.category_ids) cid where not coalesce(p_hidden_categories->m.media_type,'[]') ? cid))
   order by m.sort_order,m.media_id limit 1
  ) matched on true
  where p.kind in('movie','series') and p.watched_seconds>5 and p.watched_seconds<=8640000
 ), genre_members as materialized(
  select m.media_type,g->>'id' genre,g->'itemIds' ids from models m
  cross join lateral jsonb_array_elements(coalesce(m.payload->'genres','[]')) g
 ), recent as materialized(
  select * from(select distinct on(current_identity) * from watched where current_id is not null
   order by current_identity,updated_at desc,item_key) titles order by updated_at desc,item_key limit 100
 ), signals as materialized(
  select r.current_identity,r.updated_at watched_at,
   coalesce(array_agg(distinct g.genre) filter(where g.genre is not null),'{}'::text[]) genres
  from recent r left join genre_members g on g.media_type=r.media_type and g.ids ? r.current_id
  group by r.current_identity,r.updated_at
 ), weighted as materialized(
  select genres,1.0/(1.0+(row_number() over(order by watched_at desc,current_identity)-1)/4.0)/nullif(cardinality(genres),0) weight from signals
 ), genre_weights as materialized(
  select genre,sum(weight) weight from weighted cross join lateral unnest(genres) genre group by genre
  order by sum(weight) desc,genre limit 6
 ), affinity as materialized(
  -- Index extraction is bounded before expansion. LIMIT on a FunctionScan of
  -- jsonb_array_elements_text would still materialize the entire source array.
  select g.media_type,g.ids->>p.position id,sum(w.weight) score
  from genre_members g join genre_weights w using(genre)
  cross join lateral generate_series(0,least(jsonb_array_length(coalesce(g.ids,'[]'::jsonb)),300)-1) p(position)
  group by g.media_type,g.ids->>p.position
 ), rating_groups as materialized(
  -- Extract the large navigation object's array once per domain, not once
  -- again for every selected position.
  select media_type,coalesce(payload#>'{orders,rating}','[]'::jsonb) ids from models
 ), rating_order as materialized(
  select m.media_type,m.ids->>r.position id,r.position
  from rating_groups m cross join lateral generate_series(
   0,least(jsonb_array_length(m.ids),300)-1
  ) r(position)
 ), pool as materialized(
  -- No category expansion or owner/history anti-join over global memberships.
  -- Those checks run only after these <=600 IDs per domain are materialized.
  select domain.media_type,p.id from models domain cross join lateral(
   (select a.id from affinity a where a.media_type=domain.media_type order by a.score desc,a.id limit 300)
   union
   (select r.id from rating_order r where r.media_type=domain.media_type order by r.position,r.id limit 300)
  ) p
 ), candidates as materialized(
  select m.media_type,m.media_id,m.home_identity,m.query_rating,m.query_release_year,m.sort_order,coalesce(a.score,0) score
  from pool p join generations g using(media_type)
  join public.catalog_media m on(m.provider_key,m.scope_hash,m.media_type,m.generation_id,m.media_id)=
   (p_provider_key,p_scope_hash,p.media_type,g.generation_id,p.id)
  left join affinity a on a.media_type=p.media_type and a.id=p.id left join adult_categories adult on adult.media_type=m.media_type
  where m.is_active and not m.is_adult and m.home_identity is not null and m.query_rating between 7 and 10
   and not m.category_ids&&coalesce(adult.ids,'{}'::text[])
   and not coalesce(p_hidden_items->m.media_type,'[]') ? m.media_id
   and(cardinality(m.category_ids)=0 or exists(select 1 from unnest(m.category_ids) cid where not coalesce(p_hidden_categories->m.media_type,'[]') ? cid))
   and not exists(select 1 from watched w where w.media_type=m.media_type and w.media_id=m.media_id
    or w.saved_identity=m.home_identity or w.current_identity=m.home_identity)
 ), ranked as materialized(
  select c.*,row_number() over(partition by home_identity order by score desc,query_rating desc,query_release_year desc,sort_order,media_id) variant from candidates c
 ), by_kind as materialized(
  select r.*,row_number() over(partition by media_type order by score desc,query_rating desc,query_release_year desc,sort_order,media_id) position from ranked r where variant=1
 ), first_kind as(
  select media_type from by_kind where position=1 order by score desc,query_rating desc,query_release_year desc,
   case media_type when 'movies' then 0 else 1 end,sort_order,media_id limit 1
 ), recommendation_keys as materialized(
  select media_type,media_id,score,row_number() over(order by position,case when media_type=(select media_type from first_kind) then 0 else 1 end) position
  from by_kind where position<=30 order by position,case when media_type=(select media_type from first_kind) then 0 else 1 end limit 60
 ), histories as materialized(
  select c.media_type,c.media_id,row_number() over(partition by c.media_type order by p.updated_at desc,c.media_id) position
  from progress p join private_visible c using(media_type,media_id) where p.watched_seconds>=0 and p.watched_seconds<=8640000
 ), favorites_live as materialized(
  select f.media_type,f.media_id,row_number() over(order by f.updated_at desc,f.media_id) position
  from favorite_visible f join private_catalog c using(media_type,media_id)
  where f.kind='live' and(p_include_adult or not c.is_adult) order by f.updated_at desc,f.media_id limit 30
 ), selected_keys as materialized(
  select media_type,media_id from recommendation_keys union select media_type,media_id from histories where position<=30
  union select media_type,media_id from favorites_live
 ), metadata as materialized(
  -- <=180 destination IDs: 60 recommendation alternatives, 90 history, 30 TV.
  select m.media_type,m.media_id,m.metadata raw_metadata,
   m.metadata||jsonb_build_object('id',m.media_id,'kind',case m.media_type when 'movies' then 'movie' else m.media_type end,'isAdult',m.is_adult) item
  from selected_keys s join generations g using(media_type)
  join public.catalog_media m on(m.provider_key,m.scope_hash,m.media_type,m.generation_id,m.media_id)=
   (p_provider_key,p_scope_hash,s.media_type,g.generation_id,s.media_id) where m.is_active
 ), recommendations as materialized(
  select r.* from recommendation_keys r join metadata m using(media_type,media_id)
  where not public.arkhen_progress_metadata_adult(m.raw_metadata) order by r.position limit 30
 )
 select jsonb_build_object('schemaVersion',1,'generatedAt',now(),
  'revisionLibrary',greatest((select max(updated_at) from public.user_progress where user_id=owner and provider=account_provider),
   (select max(updated_at) from public.user_favorites where user_id=owner and provider=account_provider)),
  'revisions',(select coalesce(jsonb_object_agg(media_type,generation_id),'{}') from generations),
  'counts',(select jsonb_build_object('live',count(*) filter(where kind='live'),'movie',count(*) filter(where kind='movie'),'series',count(*) filter(where kind='series')) from favorite_visible),
  'history',(select jsonb_object_agg(kind,items) from(select kind,(select coalesce(jsonb_agg(m.item order by h.position),'[]')
   from histories h join metadata m using(media_type,media_id) where h.media_type=case kind when 'movie' then 'movies' else kind end and h.position<=30) items
   from unnest(array['live','movie','series']) kind) sections),
  'favoriteChannels',(select coalesce(jsonb_agg(m.item order by f.position),'[]') from favorites_live f join metadata m using(media_type,media_id)),
  'recommendations',jsonb_build_object('personalized',(select coalesce(bool_or(score>0),false) from recommendations),
   'items',(select coalesce(jsonb_agg(m.item order by r.position),'[]') from recommendations r join metadata m using(media_type,media_id)))
 ) into result;
 return result;
end $$;
revoke all on function public.arkhen_home_library(text,text,boolean,jsonb,jsonb) from public,anon;
grant execute on function public.arkhen_home_library(text,text,boolean,jsonb,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
