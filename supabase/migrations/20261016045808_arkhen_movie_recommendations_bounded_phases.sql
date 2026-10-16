-- Bounded movie ranking phases. DTO rankingVersion2; identityVersion2 matches the new registry/index.
-- A strong result does not expand navigation or calculate history affinity.
-- No policies, account identities, media IDs or stored private data change.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
-- Additive, versioned registry: never change an immutable expression behind
-- an already-built index. Version1 stays available for compatibility.
-- Primary source: https://www.middleearth.com/films
create function public.arkhen_movie_recommendation_keys_v2(p_name text,p_year integer)
returns text[] language plpgsql immutable parallel safe security invoker set search_path='' as $$
declare keys text[]:=public.arkhen_movie_recommendation_keys(p_name,p_year);
 title text:=trim(regexp_replace(public.arkhen_query_normalize(left(coalesce(p_name,''),500)),'[^a-z0-9]+',' ','g'));
begin
 if title ~ '(^| )(documentario|documentary|making of|bastidores|parodia|parody)( |$)' then return keys;end if;
 if title ~ '^(o |the )?(senhor dos aneis|lord of the rings)( |$)'
  or title ~ '^(a |the )?(guerra dos rohirrim|war of the rohirrim)( |$)' then
  keys:=keys||array['franchise:lord-of-the-rings','universe:middle-earth'];
 end if;
 if title ~ '^(o |the )?hobbit( |$)' then keys:=keys||array['franchise:the-hobbit','universe:middle-earth'];end if;
 return array(select distinct key from unnest(keys) key order by key);
end $$;
revoke all on function public.arkhen_movie_recommendation_keys_v2(text,integer) from public,anon;
grant execute on function public.arkhen_movie_recommendation_keys_v2(text,integer) to authenticated,service_role;
create index arkhen_movie_recommendation_keys_v2 on public.catalog_media using gin
 (public.arkhen_movie_recommendation_keys_v2(name,query_release_year))
 where media_type='movies' and is_active and not is_adult;

create index arkhen_movie_query_genres_v3 on public.catalog_media using gin(query_genres)
 where media_type='movies' and is_active and not is_adult;

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
 v_source_genres text[]; v_source_genre_categories text[]; v_frequencies jsonb:='{}';
 v_seen jsonb; v_history_weights jsonb:='{}'; v_history_genres text[]; v_history_categories text[];
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
 v_source_genre_categories:=array(select key from jsonb_each(v_category_genres) c
  where array(select jsonb_array_elements_text(c.value)) && v_source_genres);

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
   -- Existing identity GIN supplies franchise/universe candidates first. The
   -- full navigation payload and all history affinities stay untouched here.
   select coalesce(array_agg(id),'{}') into v_added from(
    select m.media_id id from public.catalog_media m
    where(m.provider_key,m.scope_hash,m.media_type,m.generation_id)=(p_provider_key,p_scope_hash,'movies',generation)
     and m.is_active and not m.is_adult and m.home_identity is not null
     and not 'documentario'=any(m.query_genres)
     and public.arkhen_movie_recommendation_keys_v2(m.name,m.query_release_year) && source_keys
     and m.media_id<>p_source_id and not coalesce(p_hidden_items->'movies','[]') ? m.media_id
     and not m.category_ids && v_adult_categories
     and(cardinality(m.category_ids)=0 or exists(select 1 from unnest(m.category_ids) cid where not coalesce(p_hidden_categories->'movies','[]') ? cid))
     and not exists(select 1 from jsonb_array_elements(v_seen) seen where seen->>'id'=m.media_id)
    order by (public.arkhen_movie_recommendation_keys_v2(m.name,m.query_release_year) && source_franchises) desc,
     m.query_rating desc nulls last,m.sort_order,m.media_id limit 600
   ) strong;
  elsif v_phase=1 then
   select payload into model from public.catalog_navigation_cache
  where provider_key=p_provider_key and scope_hash=p_scope_hash and media_type='movies'
   and generation_id=generation and not include_adult;
   if model is null then return null;end if;

   -- Only compact group counts are inspected, never the per-item memberships.
   select coalesce(jsonb_object_agg(g->>'id',greatest((g->>'count')::numeric,1)),'{}') into v_frequencies
   from jsonb_array_elements(coalesce(model->'genres','[]')) g;
   select coalesce(array_agg(id),'{}') into v_added from(
    select m.media_id id from public.catalog_media m
    cross join lateral(select array(select distinct genre from(
     select unnest(m.query_genres) genre union all
     select jsonb_array_elements_text(v_category_genres->cid) from unnest(m.category_ids) cid
    ) all_genres) genres) membership
    where(m.provider_key,m.scope_hash,m.media_type,m.generation_id)=(p_provider_key,p_scope_hash,'movies',generation)
     and m.is_active and not m.is_adult and m.home_identity is not null
     and(m.query_genres && v_source_genres or m.category_ids && v_source_genre_categories or m.category_ids && v_specific_categories)
     and m.media_id<>p_source_id and not coalesce(p_hidden_items->'movies','[]') ? m.media_id
     and not m.category_ids && v_adult_categories
     and(cardinality(m.category_ids)=0 or exists(select 1 from unnest(m.category_ids) cid where not coalesce(p_hidden_categories->'movies','[]') ? cid))
     and not exists(select 1 from jsonb_array_elements(v_seen) seen where seen->>'id'=m.media_id)
    order by case when membership.genres && v_source_genres then 2 else 3 end,
     (select sum(1000.0/greatest(coalesce((v_frequencies->>genre)::numeric,1),1)) from unnest(membership.genres) genre where genre=any(v_source_genres)) desc nulls last,
     m.query_rating desc nulls last,m.sort_order,m.media_id limit 600
   ) contextual;
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
   ) select coalesce(jsonb_object_agg(genre,weight),'{}') into v_history_weights from weights;
   v_history_genres:=array(select jsonb_object_keys(v_history_weights));
   v_history_categories:=array(select key from jsonb_each(v_category_genres) c
    where array(select jsonb_array_elements_text(c.value)) && v_history_genres);
   select coalesce(array_agg(id),'{}') into v_added from(
    select m.media_id id from public.catalog_media m
    cross join lateral(select array(select distinct genre from(
     select unnest(m.query_genres) genre union all
     select jsonb_array_elements_text(v_category_genres->cid) from unnest(m.category_ids) cid
    ) all_genres) genres) membership
    where(m.provider_key,m.scope_hash,m.media_type,m.generation_id)=(p_provider_key,p_scope_hash,'movies',generation)
     and m.is_active and not m.is_adult and m.home_identity is not null
     and(m.query_genres && v_history_genres or m.category_ids && v_history_categories)
     and m.media_id<>p_source_id and not coalesce(p_hidden_items->'movies','[]') ? m.media_id
     and not m.category_ids && v_adult_categories
     and(cardinality(m.category_ids)=0 or exists(select 1 from unnest(m.category_ids) cid where not coalesce(p_hidden_categories->'movies','[]') ? cid))
     and not exists(select 1 from jsonb_array_elements(v_seen) seen where seen->>'id'=m.media_id)
    order by (select sum(coalesce((v_history_weights->>genre)::numeric,0)) from unnest(membership.genres) genre) desc nulls last,
     m.query_rating desc nulls last,m.sort_order,m.media_id limit 600
   ) historical;
  end if;
  v_pool:=array(select distinct id from unnest(v_pool||v_added) id);

  -- Re-authorize the bounded IDs against current published rows before reading
  -- at most120 full metadata values. Every phase uses the same final filters.
  with compact as materialized(
   select m.media_id id,m.home_identity,m.query_rating,m.sort_order,
    case when 'documentario'=any(m.query_genres) then '{}'::text[] else public.arkhen_movie_recommendation_keys_v2(m.name,m.query_release_year) end keys,
    array(select distinct genre from(
     select unnest(m.query_genres) genre union all
     select jsonb_array_elements_text(v_category_genres->cid) from unnest(m.category_ids) cid
    ) all_genres) genres,m.category_ids && v_specific_categories source_category
   from unnest(v_pool) p(id) join public.catalog_media m on(m.provider_key,m.scope_hash,m.media_type,m.generation_id,m.media_id)=(p_provider_key,p_scope_hash,'movies',generation,p.id)
   where m.is_active and not m.is_adult and m.home_identity is not null and m.media_id<>p_source_id
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
notify pgrst,'reload schema';
commit;
