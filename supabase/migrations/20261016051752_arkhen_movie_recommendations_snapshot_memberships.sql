-- Identity memberships are prepared globally once per movie generation.
-- Reader sampling happens before per-row RLS/classifier/metadata work. SQL8s,
-- schema1/ranking2/identity2 and every final authorization/filter remain intact.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

-- Preserve the current published builder. Only movies gain movieIdentityV2;
-- false/true models share one classification pass. Other domains keep DO NOTHING.
-- These seven roots exhaust the immutable keys_v2 registry: each nonempty
-- family has DC/Marvel/Middle-earth, or one of the four standalone franchises.
-- Its existing GIN index preselects positives globally before classification.
-- Keep this exact prefilter versioned with keys_v2; do not extend it silently.
CREATE OR REPLACE FUNCTION public.arkhen_prepare_catalog_read_model(p_provider_key text, p_scope_hash text, p_media_type text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO ''
 SET statement_timeout TO '45s'
AS $function$
declare header record;adult boolean;result jsonb;v_movie_identity jsonb;
begin
 if p_media_type is null or p_media_type not in('live','movies','series') then raise exception 'Invalid catalog domain' using errcode='22023';end if;
 if not pg_try_advisory_xact_lock(hashtext('catalog-navigation:'||p_provider_key||p_scope_hash||p_media_type)) then return false;end if;
 select c.snapshot_id,c.index_generation,c.updated_at,c.expires_at into header from public.provider_catalog_cache c join public.catalog_visible_generations g on(c.provider_key,c.scope_hash,c.media_type,c.index_generation)=(g.provider_key,g.scope_hash,g.media_type,g.generation_id) where c.provider_key=p_provider_key and c.scope_hash=p_scope_hash and c.media_type=p_media_type and c.is_complete;
 if not found then return false;end if;
 foreach adult in array array[false,true] loop
  with movie_key_candidates as materialized(
   select m.media_id,m.name,m.query_release_year
   from public.catalog_media m
   where p_media_type='movies' and not adult
    and m.provider_key=p_provider_key and m.scope_hash=p_scope_hash
    and m.media_type='movies' and m.generation_id=header.index_generation
    and m.is_active and not m.is_adult and not 'documentario'=any(m.query_genres)
    and public.arkhen_movie_recommendation_keys_v2(m.name,m.query_release_year)
     && array['universe:dc','universe:marvel','universe:middle-earth',
      'franchise:fast-furious','franchise:transformers',
      'franchise:avatar-aang','franchise:avatar-cameron']::text[]
  ), identified_movie_keys as materialized(
   select media_id,public.arkhen_movie_recommendation_keys_v2(name,query_release_year) movie_keys
   from movie_key_candidates
  ), categories as materialized(
   select category_id,name,public.arkhen_query_genres(to_jsonb(name)) genres from public.catalog_categories where provider_key=p_provider_key and scope_hash=p_scope_hash and media_type=p_media_type and generation_id=header.index_generation and is_active and(adult or not is_adult)
  ), items as materialized(
   select m.media_id,m.category_ids,m.query_title_key,m.query_added,m.query_rating,m.sort_order,
    m.query_release_year as release_year,m.query_release_time as release_time,m.query_identity as title_identity,m.query_launch as launch_category,m.query_feature_ready as feature_ready,
    coalesce(k.movie_keys,'{}'::text[]) movie_keys,
    case when p_media_type='live' then '{}'::text[] else array(select distinct genre from unnest(m.query_genres||coalesce((select array_agg(genre) from categories c cross join lateral unnest(c.genres) genre where c.category_id=any(m.category_ids)),'{}')) genre order by genre) end genres
   from public.catalog_media m left join identified_movie_keys k on k.media_id=m.media_id
   where m.provider_key=p_provider_key and m.scope_hash=p_scope_hash and m.media_type=p_media_type and m.generation_id=header.index_generation and m.is_active and(adult or not m.is_adult)
  ), category_members as(
   select c.category_id,c.name,array(select i.media_id from items i where c.category_id=any(i.category_ids) order by i.sort_order,i.media_id) ids from categories c
  ), genre_members as(
   select genre,array_agg(media_id order by sort_order,media_id) ids from items cross join lateral unnest(genres) genre group by genre
  ), movie_memberships as(
   select key,jsonb_agg(media_id order by query_rating desc nulls last,sort_order,media_id) ids
   from items cross join lateral unnest(movie_keys) key group by key
  ), distinct_releases as(
   select *,row_number() over(partition by title_identity order by release_year desc,launch_category desc,release_time desc,sort_order,media_id) as edition from items
  ), releases as materialized(
   select *,row_number() over(order by release_year desc,launch_category desc,release_time desc,sort_order,media_id) as release_order from distinct_releases where edition=1
  ), featured as(
   select *,case when release_year>=(select max(release_year)-1 from releases) and feature_ready then 0 else 1 end priority from releases where release_order<=36
  )
  select jsonb_build_object('schemaVersion',1,'mediaType',p_media_type,'snapshotId',header.snapshot_id,'generation',header.index_generation,'revisionAt',header.updated_at,'expiresAt',header.expires_at,'includeAdult',adult,
   'total',(select count(*) from items),'orders',jsonb_build_object(
    'name',(select coalesce(jsonb_agg(media_id order by query_title_key,sort_order,media_id),'[]') from items),
    'date',(select coalesce(jsonb_agg(media_id order by query_added desc nulls last,sort_order,media_id),'[]') from items),
    'rating',(select coalesce(jsonb_agg(media_id order by query_rating desc nulls last,query_title_key,media_id),'[]') from items),
    'releases',(select coalesce(jsonb_agg(media_id order by release_order),'[]') from releases),
    'featured',(select coalesce(jsonb_agg(media_id order by priority,release_order),'[]') from featured)),
   'categories',(select coalesce(jsonb_agg(jsonb_build_object('id',category_id,'name',name,'itemIds',ids,'count',cardinality(ids)) order by public.arkhen_query_title_key(name),category_id),'[]') from category_members),
   'genres',(select coalesce(jsonb_agg(jsonb_build_object('id',genre,'name',public.arkhen_query_genre_label(genre),'itemIds',ids,'count',cardinality(ids)) order by public.arkhen_query_title_key(public.arkhen_query_genre_label(genre))),'[]') from genre_members))
   ||case when p_media_type='movies' then jsonb_build_object('movieIdentityV2',
    case when not adult then jsonb_build_object('version',2,'generation',header.index_generation,'complete',true,'preparedAt',now(),
     'keys',(select coalesce(jsonb_object_agg(key,ids),'{}') from movie_memberships),
     'byId',(select coalesce(jsonb_object_agg(media_id,to_jsonb(movie_keys)),'{}') from identified_movie_keys)) else v_movie_identity end) else '{}'::jsonb end into result;
  if p_media_type='movies' and not adult then v_movie_identity:=result->'movieIdentityV2';end if;
  insert into public.catalog_navigation_cache(provider_key,scope_hash,media_type,generation_id,include_adult,payload) values(p_provider_key,p_scope_hash,p_media_type,header.index_generation,adult,result) on conflict(provider_key,scope_hash,media_type,generation_id,include_adult) do update set payload=excluded.payload where p_media_type='movies';
 end loop;
 if not exists(select 1 from public.catalog_visible_generations where provider_key=p_provider_key and scope_hash=p_scope_hash and media_type=p_media_type and generation_id=header.index_generation) then raise exception 'Catalog generation changed while preparing navigation' using errcode='40001';end if;
 delete from public.catalog_navigation_cache where provider_key=p_provider_key and scope_hash=p_scope_hash and media_type=p_media_type and generation_id<>header.index_generation;
 return true;
end $function$;
revoke all on function public.arkhen_prepare_catalog_read_model(text,text,text) from public,anon,authenticated;
grant execute on function public.arkhen_prepare_catalog_read_model(text,text,text) to service_role;

create or replace function public.arkhen_movie_recommendations(
 p_provider_key text,p_scope_hash text,p_source_id text,p_limit integer default 10,
 p_hidden_categories jsonb default '{}',p_hidden_items jsonb default '{}'
) returns jsonb language plpgsql stable security invoker set search_path=''
 set statement_timeout='8s' set jit='off' as $$
declare
 owner uuid := (select auth.uid()); account_provider text; generation uuid;
 model jsonb; source_row record; result jsonb; exclusions jsonb; domain text;
 source_keys text[]; source_franchises text[]; source_universes text[];
 source_tmdb text; source_imdb text;
 v_category_genres jsonb; v_adult_categories text[]; v_specific_categories text[];
 v_source_genres text[]; v_frequencies jsonb:='{}';
 v_seen jsonb; v_history_weights jsonb:='{}'; v_history_genres text[];
 v_identity_map jsonb;v_genre_groups jsonb;v_category_groups jsonb;
 v_pool text[]:='{}'; v_added text[]; v_phase integer; v_revision_library timestamptz;
begin
 if owner is null or not public.arkhen_partition_allows(p_provider_key,p_scope_hash) then
  raise exception 'Invalid account partition' using errcode='42501';
 end if;
 if p_source_id is null or p_source_id !~ '^[A-Za-z0-9_-]{1,160}$'
  or p_limit is null or p_limit not between 1 and 10 then
  raise exception 'Invalid recommendation request' using errcode='22023';
 end if;
 foreach exclusions in array array[p_hidden_categories,p_hidden_items] loop
  if exclusions is null or jsonb_typeof(exclusions)<>'object' or octet_length(exclusions::text)>65536
   or exists(select 1 from jsonb_object_keys(exclusions) k where k not in('live','movies','series')) then
   raise exception 'Invalid visibility preferences' using errcode='22023';
  end if;
  foreach domain in array array['live','movies','series'] loop
   if exclusions ? domain then
    if jsonb_typeof(exclusions->domain)<>'array' then raise exception 'Invalid visibility preferences' using errcode='22023';end if;
    if jsonb_array_length(exclusions->domain)>2000 or exists(
     select 1 from jsonb_array_elements(exclusions->domain) e where jsonb_typeof(e)<>'string' or (e#>>'{}') !~ '^[A-Za-z0-9_-]{1,160}$'
    ) then raise exception 'Invalid visibility preferences' using errcode='22023';end if;
   end if;
  end loop;
 end loop;
 select provider into account_provider from public.profiles where id=owner;
 select generation_id into generation from public.catalog_visible_generations
  where provider_key=p_provider_key and scope_hash=p_scope_hash and media_type='movies';
 select m.home_identity,m.category_ids,m.query_genres,m.metadata,m.name,m.query_release_year into source_row
  from public.catalog_media m where(m.provider_key,m.scope_hash,m.media_type,m.generation_id,m.media_id)=
   (p_provider_key,p_scope_hash,'movies',generation,p_source_id)
   and m.is_active and not m.is_adult and not coalesce(p_hidden_items->'movies','[]') ? m.media_id
   and(cardinality(m.category_ids)=0 or exists(select 1 from unnest(m.category_ids) cid where not coalesce(p_hidden_categories->'movies','[]') ? cid))
   and not public.arkhen_progress_catalog_adult(owner,account_provider,'movie:'||m.media_id);
 if not found then
  return jsonb_build_object('schemaVersion',1,'rankingVersion',2,'identityVersion',2,'source','rpc','generatedAt',now(),'sourceId',p_source_id,
   'revision',generation,'revisionLibrary',null,'personalized',false,'reason','unavailable','items','[]'::jsonb);
 end if;
 if source_row.home_identity is null then return null;end if;
 source_keys:=case when 'documentario'=any(source_row.query_genres) then '{}'::text[]
  else public.arkhen_movie_recommendation_keys_v2(source_row.name,source_row.query_release_year) end;
 source_franchises:=array(select k from unnest(source_keys) k where k like 'franchise:%');
 source_universes:=array(select k from unnest(source_keys) k where k like 'universe:%');
 source_tmdb:=case when source_row.metadata->>'tmdbId' ~ '^[1-9][0-9]{0,15}$' then source_row.metadata->>'tmdbId' end;
 source_imdb:=case when source_row.metadata->>'imdbId' ~ '^tt[0-9]{6,10}$' then source_row.metadata->>'imdbId' end;

 -- Categories are small, trusted rows of the exact published movie generation.
 with definitions as materialized(
  select c.category_id,c.name,public.arkhen_query_genres(to_jsonb(c.name)) genres,
   c.is_adult or public.arkhen_progress_metadata_adult(jsonb_build_object('categoryName',c.name)) adult
  from public.catalog_categories c
  where(c.provider_key,c.scope_hash,c.media_type,c.generation_id)=(p_provider_key,p_scope_hash,'movies',generation) and c.is_active
 )
 select coalesce((select jsonb_object_agg(category_id,to_jsonb(genres)) from definitions),'{}'),
  coalesce((select array_agg(category_id) from definitions where adult),'{}'),
  coalesce((select array_agg(category_id) from definitions where not adult and category_id=any(source_row.category_ids)
   and not coalesce(p_hidden_categories->'movies','[]') ? category_id
   and public.arkhen_query_normalize(name) !~ '^(geral|todos|todos os filmes|filmes|movies|favoritos)$'
   and public.arkhen_query_normalize(name) !~ '(^|[^a-z0-9])(lancamentos?|recentes|netflix|hbo|max|disney|prime|amazon|apple|4k|hd|fhd|uhd)([^a-z0-9]|$)'),'{}'),
  array(select distinct genre from(
   select unnest(source_row.query_genres) genre union all
   select unnest(d.genres) from definitions d where not d.adult and d.category_id=any(source_row.category_ids)
  ) all_genres)
 into v_category_genres,v_adult_categories,v_specific_categories,v_source_genres;

 -- Read the shared map before private signals. Missing preparation is explicit
 -- unavailability, never a fallback to scanning/classifying the whole catalog.
 select payload into model from public.catalog_navigation_cache
 where provider_key=p_provider_key and scope_hash=p_scope_hash and media_type='movies'
  and generation_id=generation and not include_adult;
 v_identity_map:=model->'movieIdentityV2';
 if model is null or (v_identity_map->>'version') is distinct from '2'
  or (v_identity_map->>'complete') is distinct from 'true'
  or (v_identity_map->>'generation') is distinct from generation::text
  or jsonb_typeof(v_identity_map->'keys') is distinct from 'object'
  or jsonb_typeof(v_identity_map->'byId') is distinct from 'object' then
  raise exception 'ARKHEN_MOVIE_IDENTITY_MODEL_PREPARING' using errcode='55000';
 end if;
 v_genre_groups:=coalesce(model->'genres','[]');
 v_category_groups:=coalesce(model->'categories','[]');

 -- Preserve exclusion of ALL watched movie works. This owner-only read is not
 -- a global genre rank; series/episode history is deferred until phase2.
 select coalesce(jsonb_agg(jsonb_build_object('id',substr(p.item_key,7),'identity',public.arkhen_home_title_identity('movie',p.entry->'item'),
   'tmdb',case when p.entry#>>'{item,tmdbId}' ~ '^[1-9][0-9]{0,15}$' then p.entry#>>'{item,tmdbId}' end,
   'imdb',case when p.entry#>>'{item,imdbId}' ~ '^tt[0-9]{6,10}$' then p.entry#>>'{item,imdbId}' end)),'[]')
 into v_seen from public.user_progress p
 where p.user_id=owner and p.provider=account_provider and p.deleted_at is null and p.episode_id=''
  and p.item_key like 'movie:%' and p.item_key=concat(p.entry#>>'{item,kind}',':',p.entry#>>'{item,id}')
  and length(coalesce(p.entry#>>'{item,name}',''))>0
  and case when jsonb_typeof(p.entry->'time')='number' then (p.entry->>'time')::numeric>5 and (p.entry->>'time')::numeric<=8640000 else false end
  and not public.arkhen_progress_metadata_adult(p.entry) and not public.arkhen_progress_metadata_adult(p.entry->'item')
  and not public.arkhen_progress_metadata_adult(p.entry->'episode');

 for v_phase in 0..2 loop
  if v_phase=0 then
   -- The complete key map is global. Bound extraction BEFORE catalog RLS,
   -- classifier functions, private exclusions or metadata lookup.
   with groups as materialized(
    select key,value ids,case when key=any(source_franchises) then 0 else 1 end bucket
    from jsonb_each(v_identity_map->'keys') g where key=any(source_keys)
   ), members as materialized(
    select g.ids->>p.position id,g.bucket,p.position from groups g
    cross join lateral generate_series(0,least(jsonb_array_length(g.ids),600)-1) p(position)
   ), selected as materialized(
    select id,min(bucket) bucket,min(position) position from members where id<>p_source_id
    group by id order by min(bucket),min(position),id limit 600
   ) select coalesce(array_agg(id order by bucket,position,id),'{}') into v_added from selected;
  elsif v_phase=1 then
   select coalesce(jsonb_object_agg(g->>'id',greatest((g->>'count')::numeric,1)),'{}') into v_frequencies
   from jsonb_array_elements(v_genre_groups) g;
   with source_groups as materialized(
    select g->'itemIds' ids,1000.0/greatest((g->>'count')::numeric,1) weight
    from jsonb_array_elements(v_genre_groups) g where g->>'id'=any(v_source_genres)
    order by greatest((g->>'count')::numeric,1),g->>'id' limit 6
   ), category_groups as materialized(
    select g->'itemIds' ids from jsonb_array_elements(v_category_groups) g
    where g->>'id'=any(v_specific_categories) order by g->>'id' limit 6
   ), groups as materialized(
    select ids,weight,2 bucket from source_groups union all select ids,0,3 from category_groups
   ), members as materialized(
    select g.ids->>p.position id,g.bucket,g.weight,p.position from groups g
    cross join lateral generate_series(0,least(jsonb_array_length(g.ids),300)-1) p(position)
   ), selected as materialized(
    select id,min(bucket) bucket,sum(weight) weight,min(position) position from members where id<>p_source_id
    group by id order by min(bucket),sum(weight) desc,min(position),id limit 600
   ) select coalesce(array_agg(id order by bucket,weight desc,position,id),'{}') into v_added from selected;
  else
   -- History is a last class. Inspect at most100 distinct recent titles and
   -- their exact current metadata, not a genre map of the entire catalog.
   with recent as materialized(
    select * from(select distinct on(p.item_key) p.item_key,p.updated_at,
     case split_part(p.item_key,':',1) when 'movie' then 'movies' else 'series' end media_type,
     substr(p.item_key,strpos(p.item_key,':')+1) media_id
     from public.user_progress p where p.user_id=owner and p.provider=account_provider and p.deleted_at is null
      and split_part(p.item_key,':',1) in('movie','series') and p.item_key=concat(p.entry#>>'{item,kind}',':',p.entry#>>'{item,id}')
      and length(coalesce(p.entry#>>'{item,name}',''))>0
      and(split_part(p.item_key,':',1)='movie' and p.episode_id='' or split_part(p.item_key,':',1)='series' and p.episode_id=p.entry#>>'{episode,id}')
      and case when jsonb_typeof(p.entry->'time')='number' then (p.entry->>'time')::numeric>5 and (p.entry->>'time')::numeric<=8640000 else false end
      and not public.arkhen_progress_metadata_adult(p.entry) and not public.arkhen_progress_metadata_adult(p.entry->'item')
      and not public.arkhen_progress_metadata_adult(p.entry->'episode')
     order by p.item_key,p.updated_at desc) distinct_titles order by updated_at desc,item_key limit 100
   ), categories as materialized(
    select c.media_type,c.category_id,public.arkhen_query_genres(to_jsonb(c.name)) genres,
     c.is_adult or public.arkhen_progress_metadata_adult(jsonb_build_object('categoryName',c.name)) adult
    from public.catalog_categories c join public.catalog_visible_generations g using(provider_key,scope_hash,media_type,generation_id)
    where c.provider_key=p_provider_key and c.scope_hash=p_scope_hash and c.media_type in('movies','series') and c.is_active
   ), signals as materialized(
    select r.item_key,r.updated_at,array(select distinct genre from(
     select unnest(m.query_genres) genre union all
     select unnest(c.genres) from categories c where c.media_type=m.media_type and c.category_id=any(m.category_ids)
    ) all_genres) genres
    from recent r join public.catalog_visible_generations g on(g.provider_key,g.scope_hash,g.media_type)=(p_provider_key,p_scope_hash,r.media_type)
    join public.catalog_media m on(m.provider_key,m.scope_hash,m.media_type,m.generation_id,m.media_id)=(p_provider_key,p_scope_hash,r.media_type,g.generation_id,r.media_id)
    where m.is_active and not m.is_adult and not public.arkhen_progress_metadata_adult(m.metadata)
     and not coalesce(p_hidden_items->m.media_type,'[]') ? m.media_id
     and(cardinality(m.category_ids)=0 or exists(select 1 from unnest(m.category_ids) cid where not coalesce(p_hidden_categories->m.media_type,'[]') ? cid))
     and not exists(select 1 from categories c where c.media_type=m.media_type and c.category_id=any(m.category_ids) and c.adult)
   ), weighted as materialized(
    select genres,1.0/(1.0+(row_number() over(order by updated_at desc,item_key)-1)/4.0)/nullif(cardinality(genres),0) weight from signals
   ), weights as(
    select genre,sum(weight) weight from weighted cross join lateral unnest(genres) genre group by genre
    order by sum(weight) desc,genre limit 6
   ) select coalesce(jsonb_object_agg(genre,weight),'{}') into v_history_weights from weights;
   v_history_genres:=array(select jsonb_object_keys(v_history_weights));
   with groups as materialized(
    select g->'itemIds' ids,(v_history_weights->>(g->>'id'))::numeric weight
    from jsonb_array_elements(v_genre_groups) g where g->>'id'=any(v_history_genres)
   ), members as materialized(
    select g.ids->>p.position id,g.weight,p.position from groups g
    cross join lateral generate_series(0,least(jsonb_array_length(g.ids),300)-1) p(position)
   ), selected as materialized(
    select id,sum(weight) weight,min(position) position from members where id<>p_source_id
    group by id order by sum(weight) desc,min(position),id limit 600
   ) select coalesce(array_agg(id order by weight desc,position,id),'{}') into v_added from selected;
  end if;
  v_pool:=array(select distinct id from unnest(v_pool||v_added) id);

  -- Re-authorize the bounded IDs against current published rows before reading
  -- at most120 full metadata values. Complete byId supplies the same immutable
  -- keys without calling the classifier again for every candidate/phase.
  with compact as materialized(
   select m.media_id id,m.home_identity,m.query_rating,m.sort_order,
    case when 'documentario'=any(m.query_genres) then '{}'::text[]
     else array(select jsonb_array_elements_text(coalesce(v_identity_map->'byId'->m.media_id,'[]'::jsonb))) end keys,
    array(select distinct genre from(
     select unnest(m.query_genres) genre union all
     select jsonb_array_elements_text(v_category_genres->cid) from unnest(m.category_ids) cid
    ) all_genres) genres,m.category_ids && v_specific_categories source_category
   from unnest(v_pool) p(id) join public.catalog_media m on(m.provider_key,m.scope_hash,m.media_type,m.generation_id,m.media_id)=(p_provider_key,p_scope_hash,'movies',generation,p.id)
   where m.is_active and not m.is_adult and m.home_identity is not null and m.media_id<>p_source_id
    and not exists(select 1 from jsonb_array_elements(v_seen) seen where seen->>'id'=m.media_id)
    and not coalesce(p_hidden_items->'movies','[]') ? m.media_id and not m.category_ids && v_adult_categories
    and(cardinality(m.category_ids)=0 or exists(select 1 from unnest(m.category_ids) cid where not coalesce(p_hidden_categories->'movies','[]') ? cid))
  ), scored as materialized(
   select c.*,case when keys && source_franchises then 0 when keys && source_universes then 1
    when genres && v_source_genres then 2 when source_category then 3
    when genres && v_history_genres then 4 else 5 end bucket,
    coalesce((select sum(1000.0/greatest(coalesce((v_frequencies->>genre)::numeric,1),1)) from unnest(genres) genre where genre=any(v_source_genres)),0) genre_specificity,
    coalesce((select sum(coalesce((v_history_weights->>genre)::numeric,0)) from unnest(genres) genre),0) history_weight
   from compact c where not('franchise:avatar-cameron'=any(source_keys) and 'franchise:avatar-aang'=any(c.keys)
    or 'franchise:avatar-aang'=any(source_keys) and 'franchise:avatar-cameron'=any(c.keys))
  ), shortlist as materialized(
   select s.*,row_number() over(order by bucket,
    case when bucket=2 then genre_specificity else 0 end desc,
    case when bucket=4 then history_weight else 0 end desc,query_rating desc nulls last,sort_order,id) rank
   from scored s where bucket<5
   order by bucket,case when bucket=2 then genre_specificity else 0 end desc,
    case when bucket=4 then history_weight else 0 end desc,query_rating desc nulls last,sort_order,id limit 120
  ), metadata as materialized(
   select s.*,m.metadata raw_metadata,m.metadata||jsonb_build_object('id',m.media_id,'kind','movie','isAdult',false) item,
    case when m.metadata->>'tmdbId' ~ '^[1-9][0-9]{0,15}$' then m.metadata->>'tmdbId' end tmdb,
    case when m.metadata->>'imdbId' ~ '^tt[0-9]{6,10}$' then m.metadata->>'imdbId' end imdb
   from shortlist s join public.catalog_media m on(m.provider_key,m.scope_hash,m.media_type,m.generation_id,m.media_id)=(p_provider_key,p_scope_hash,'movies',generation,s.id)
  ), safe as materialized(
   select m.* from metadata m where not public.arkhen_progress_metadata_adult(raw_metadata)
    and not(coalesce(m.tmdb=source_tmdb,false) or coalesce(m.imdb=source_imdb,false)
     or m.home_identity=source_row.home_identity and not(coalesce(m.tmdb<>source_tmdb,false) or coalesce(m.imdb<>source_imdb,false)))
    and not exists(select 1 from jsonb_array_elements(v_seen) seen where
     seen->>'id'=m.id or coalesce(seen->>'tmdb'=m.tmdb,false) or coalesce(seen->>'imdb'=m.imdb,false)
     or seen->>'identity'=m.home_identity and not(coalesce(seen->>'tmdb'<>m.tmdb,false) or coalesce(seen->>'imdb'<>m.imdb,false)))
  ), deduplicated as materialized(
   select s.* from safe s where not exists(select 1 from safe prior where prior.rank<s.rank and(
    coalesce(prior.tmdb=s.tmdb,false) or coalesce(prior.imdb=s.imdb,false)
    or prior.home_identity=s.home_identity and not(coalesce(prior.tmdb<>s.tmdb,false) or coalesce(prior.imdb<>s.imdb,false))))
  ), final as materialized(
   select d.*,case bucket when 0 then 'source_franchise' when 1 then 'source_universe' when 2 then 'source_genre'
    when 3 then 'source_category' else 'history_genre' end recommendation_reason
   from deduplicated d order by rank limit p_limit
  ) select jsonb_build_object('schemaVersion',1,'rankingVersion',2,'identityVersion',2,'source','rpc','generatedAt',now(),
   'sourceId',p_source_id,'revision',generation,'revisionLibrary',null,
   'personalized',(select coalesce(bool_or(bucket=4),false) from final),
   'reason',coalesce((select recommendation_reason from final order by rank limit 1),'unavailable'),
   'items',(select coalesce(jsonb_agg(item||jsonb_build_object('recommendationReason',recommendation_reason) order by rank),'[]') from final)
  ) into result;
  if jsonb_array_length(result->'items')>=p_limit or v_phase=2 then
   select max(updated_at) into v_revision_library from public.user_progress where user_id=owner and provider=account_provider;
   return result||jsonb_build_object('revisionLibrary',v_revision_library);
  end if;
 end loop;
 return null;
end $$;
revoke all on function public.arkhen_movie_recommendations(text,text,text,integer,jsonb,jsonb) from public,anon;
grant execute on function public.arkhen_movie_recommendations(text,text,text,integer,jsonb,jsonb) to authenticated;

-- Both current movie models receive the map atomically. No account/private
-- table is read or updated by this backfill; future generations use the same
-- existing prepare function/cron, without another collector or cron job.
-- Preserve their existing base orders/categories/genres and created_at. Only
-- indexed positive candidates need keys_v2; do not rebuild either navigation.
do $backfill$
declare v_partition record;v_movie_identity jsonb;v_changed integer;
begin
 for v_partition in select provider_key,scope_hash,generation_id
  from public.catalog_visible_generations where media_type='movies'
  order by provider_key,scope_hash loop
  if not pg_try_advisory_xact_lock(hashtext('catalog-navigation:'||v_partition.provider_key||v_partition.scope_hash||'movies')) then
   raise exception 'ARKHEN_MOVIE_IDENTITY_BACKFILL_BUSY' using errcode='55000';
  end if;
  with movie_key_candidates as materialized(
   select m.media_id,m.name,m.query_release_year,m.query_rating,m.sort_order
   from public.catalog_media m
   where m.provider_key=v_partition.provider_key and m.scope_hash=v_partition.scope_hash
    and m.media_type='movies' and m.generation_id=v_partition.generation_id
    and m.is_active and not m.is_adult and not 'documentario'=any(m.query_genres)
    and public.arkhen_movie_recommendation_keys_v2(m.name,m.query_release_year)
     && array['universe:dc','universe:marvel','universe:middle-earth',
      'franchise:fast-furious','franchise:transformers',
      'franchise:avatar-aang','franchise:avatar-cameron']::text[]
  ), identified_movie_keys as materialized(
   select c.*,public.arkhen_movie_recommendation_keys_v2(c.name,c.query_release_year) movie_keys
   from movie_key_candidates c
  ), movie_memberships as(
   select key,jsonb_agg(media_id order by query_rating desc nulls last,sort_order,media_id) ids
   from identified_movie_keys cross join lateral unnest(movie_keys) key group by key
  )
  select jsonb_build_object('version',2,'generation',v_partition.generation_id,
   'complete',true,'preparedAt',now(),'keys',coalesce(jsonb_object_agg(key,ids),'{}'::jsonb),
   'byId',(select coalesce(jsonb_object_agg(media_id,to_jsonb(movie_keys)),'{}'::jsonb) from identified_movie_keys))
  into v_movie_identity from movie_memberships;
  update public.catalog_navigation_cache n
   set payload=n.payload||jsonb_build_object('movieIdentityV2',v_movie_identity)
   where n.provider_key=v_partition.provider_key and n.scope_hash=v_partition.scope_hash
    and n.media_type='movies' and n.generation_id=v_partition.generation_id
    and n.payload->>'generation'=v_partition.generation_id::text;
  get diagnostics v_changed=row_count;
  if v_changed<>2 then
   raise exception 'ARKHEN_MOVIE_IDENTITY_BACKFILL_MODELS_NOT_READY' using errcode='55000';
  end if;
  if not exists(select 1 from public.catalog_visible_generations g
   where g.provider_key=v_partition.provider_key and g.scope_hash=v_partition.scope_hash
    and g.media_type='movies' and g.generation_id=v_partition.generation_id) then
   raise exception 'Catalog generation changed while preparing movie identity' using errcode='40001';
  end if;
 end loop;
end $backfill$;
notify pgrst,'reload schema';
commit;
