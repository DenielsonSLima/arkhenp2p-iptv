-- Read-only movie recommendations. Shared navigation memberships are prepared
-- once per published generation; personal viewing signals remain private.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

create function public.arkhen_movie_recommendations(
 p_provider_key text,p_scope_hash text,p_source_id text,p_limit integer default 3,
 p_hidden_categories jsonb default '{}',p_hidden_items jsonb default '{}'
) returns jsonb language plpgsql stable security invoker set search_path=''
 set statement_timeout='8s' set jit='off' as $$
declare
 owner uuid := (select auth.uid()); account_provider text; generation uuid;
 model jsonb; source_row record; result jsonb; exclusions jsonb; domain text;
begin
 if owner is null or not public.arkhen_partition_allows(p_provider_key,p_scope_hash) then
  raise exception 'Invalid account partition' using errcode='42501';
 end if;
 if p_source_id is null or p_source_id !~ '^[A-Za-z0-9_-]{1,160}$'
  or p_limit is null or p_limit not between 1 and 12 then
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
 select payload into model from public.catalog_navigation_cache
  where provider_key=p_provider_key and scope_hash=p_scope_hash and media_type='movies'
   and generation_id=generation and not include_adult;
 if model is null then return null;end if;
 select m.home_identity,m.category_ids,m.query_genres,m.metadata into source_row
  from public.catalog_media m where(m.provider_key,m.scope_hash,m.media_type,m.generation_id,m.media_id)=
   (p_provider_key,p_scope_hash,'movies',generation,p_source_id)
   and m.is_active and not m.is_adult and not coalesce(p_hidden_items->'movies','[]') ? m.media_id
   and(cardinality(m.category_ids)=0 or exists(select 1 from unnest(m.category_ids) cid where not coalesce(p_hidden_categories->'movies','[]') ? cid))
   and not public.arkhen_progress_catalog_adult(owner,account_provider,'movie:'||m.media_id);
 if not found then
  return jsonb_build_object('schemaVersion',1,'generatedAt',now(),'sourceId',p_source_id,'revision',generation,'revisionLibrary',null,'personalized',false,'reason','unavailable','items','[]'::jsonb);
 end if;
 if source_row.home_identity is null then return null;end if;

 with categories as materialized(
  select c.media_type,c.category_id,c.name,
   c.is_adult or public.arkhen_progress_metadata_adult(jsonb_build_object('categoryName',c.name)) is_adult,
   public.arkhen_query_genres(to_jsonb(c.name)) genres
  from public.catalog_categories c join public.catalog_visible_generations g using(provider_key,scope_hash,media_type,generation_id)
  where c.provider_key=p_provider_key and c.scope_hash=p_scope_hash and c.media_type in('movies','series') and c.is_active
 ), watched as materialized(
  select p.item_key,p.updated_at,public.arkhen_home_title_identity(split_part(p.item_key,':',1),p.entry->'item') identity,
   case split_part(p.item_key,':',1) when 'movie' then 'movies' else 'series' end media_type,
   substr(p.item_key,strpos(p.item_key,':')+1) media_id
  from public.user_progress p where p.user_id=owner and p.provider=account_provider and p.deleted_at is null
   and split_part(p.item_key,':',1) in('movie','series') and p.item_key=concat(p.entry#>>'{item,kind}',':',p.entry#>>'{item,id}')
   and length(coalesce(p.entry#>>'{item,name}',''))>0
   and(split_part(p.item_key,':',1)='movie' and p.episode_id='' or split_part(p.item_key,':',1)='series' and p.episode_id=p.entry#>>'{episode,id}')
   and case when jsonb_typeof(p.entry->'time')='number' then (p.entry->>'time')::numeric>5 and (p.entry->>'time')::numeric<=8640000 else false end
   and not public.arkhen_progress_metadata_adult(p.entry) and not public.arkhen_progress_metadata_adult(p.entry->'item')
   and not public.arkhen_progress_metadata_adult(p.entry->'episode')
 ), recent as materialized(
  select * from(select distinct on(item_key) * from watched order by item_key,updated_at desc) latest
  order by updated_at desc,item_key limit 100
 ), signals as materialized(
  select r.item_key,r.updated_at,array(select distinct genre from unnest(m.query_genres || coalesce((select array_agg(distinct genre)
   from categories c cross join lateral unnest(c.genres) genre where c.media_type=m.media_type and c.category_id=any(m.category_ids)),'{}')) genre) genres
  from recent r join public.catalog_visible_generations g on(g.provider_key,g.scope_hash,g.media_type)=(p_provider_key,p_scope_hash,r.media_type)
  join public.catalog_media m on(m.provider_key,m.scope_hash,m.media_type,m.generation_id,m.media_id)=
   (p_provider_key,p_scope_hash,r.media_type,g.generation_id,r.media_id)
  where m.is_active and not m.is_adult and not coalesce(p_hidden_items->m.media_type,'[]') ? m.media_id
   and(cardinality(m.category_ids)=0 or exists(select 1 from unnest(m.category_ids) cid where not coalesce(p_hidden_categories->m.media_type,'[]') ? cid))
   and not exists(select 1 from categories c where c.media_type=m.media_type and c.category_id=any(m.category_ids) and c.is_adult)
   and not public.arkhen_progress_metadata_adult(m.metadata)
 ), weighted as materialized(
  select genres,1.0/(1.0+(row_number() over(order by updated_at desc,item_key)-1)/4.0)/nullif(cardinality(genres),0) weight from signals
 ), genre_weights as materialized(
  select genre,sum(weight) weight from weighted cross join lateral unnest(genres) genre group by genre
 ), source_genres as materialized(
  select distinct genre from(
   select unnest(source_row.query_genres) genre union all
   select unnest(c.genres) from categories c where c.media_type='movies' and c.category_id=any(source_row.category_ids)
  ) genres
 ), groups as materialized(
  select g->'itemIds' ids,case when exists(select 1 from source_genres s where s.genre=g->>'id') then 1 else 0 end source_genre,
   0 source_category,coalesce((select weight from genre_weights w where w.genre=g->>'id'),0) history_weight
  from jsonb_array_elements(coalesce(model->'genres','[]')) g
  union all
  select g->'itemIds',0,1,0 from jsonb_array_elements(coalesce(model->'categories','[]')) g
  where (g->>'id')=any(source_row.category_ids)
   and public.arkhen_query_normalize(g->>'name') !~ '^(geral|todos|todos os filmes|filmes|movies|lancamentos|filmes/lancamentos|recentes|favoritos|4k|hd|fhd|uhd)$'
 ), affinity as materialized(
  select id,sum(source_genre) source_genres,max(source_category) source_category,sum(history_weight) history_weight
  from groups cross join lateral jsonb_array_elements_text(coalesce(ids,'[]')) id
  where source_genre>0 or source_category>0 or history_weight>0 group by id
 ), category_visibility as materialized(
  select id,bool_or(not coalesce(p_hidden_categories->'movies','[]') ? (c->>'id')) allowed
  from jsonb_array_elements(coalesce(model->'categories','[]')) c
  cross join lateral jsonb_array_elements_text(coalesce(c->'itemIds','[]')) id group by id
 ), pool as materialized(
  select r.id,coalesce(a.source_genres,0) source_genres,coalesce(a.source_category,0) source_category,
   coalesce(a.history_weight,0) history_weight,r.position
  from jsonb_array_elements_text(coalesce(model#>'{orders,rating}','[]')) with ordinality r(id,position)
  left join affinity a on a.id=r.id
  left join category_visibility v on v.id=r.id
  where r.id<>p_source_id and not coalesce(p_hidden_items->'movies','[]') ? r.id
   and coalesce(v.allowed,true)
   and not exists(select 1 from watched w where w.media_type='movies' and w.media_id=r.id)
  order by coalesce(a.source_genres,0) desc,coalesce(a.source_category,0) desc,coalesce(a.history_weight,0) desc,r.position
  limit 600
 ), candidates as materialized(
  select p.*,m.home_identity,m.query_rating,m.query_release_year,m.category_ids,
   row_number() over(partition by m.home_identity order by p.source_genres desc,p.source_category desc,p.history_weight desc,m.query_rating desc nulls last,p.position,p.id) variant
  from pool p join public.catalog_media m on(m.provider_key,m.scope_hash,m.media_type,m.generation_id,m.media_id)=
   (p_provider_key,p_scope_hash,'movies',generation,p.id)
  where m.is_active and not m.is_adult and m.home_identity is not null and m.home_identity<>source_row.home_identity
   and(cardinality(m.category_ids)=0 or exists(select 1 from unnest(m.category_ids) cid where not coalesce(p_hidden_categories->'movies','[]') ? cid))
   and not exists(select 1 from categories c where c.media_type='movies' and c.category_id=any(m.category_ids) and c.is_adult)
   and not exists(select 1 from watched w where w.identity=m.home_identity)
 ), selected as materialized(
  select * from candidates where variant=1
  order by source_genres desc,source_category desc,history_weight desc,query_rating desc nulls last,query_release_year desc nulls last,position,id limit 60
 ), selected_metadata as materialized(
  select s.*,m.metadata raw_metadata,m.metadata||jsonb_build_object('id',m.media_id,'kind','movie','isAdult',false) item
  from selected s join public.catalog_media m on(m.provider_key,m.scope_hash,m.media_type,m.generation_id,m.media_id)=
   (p_provider_key,p_scope_hash,'movies',generation,s.id)
 ), final as materialized(
  select * from selected_metadata where not public.arkhen_progress_metadata_adult(raw_metadata)
  order by source_genres desc,source_category desc,history_weight desc,query_rating desc nulls last,query_release_year desc nulls last,position,id limit p_limit
 )
 select jsonb_build_object('schemaVersion',1,'generatedAt',now(),'sourceId',p_source_id,'revision',generation,
  'revisionLibrary',(select max(updated_at) from public.user_progress where user_id=owner and provider=account_provider),
  'personalized',(select coalesce(bool_or(history_weight>0),false) from final),
  'reason',(select case when coalesce(bool_or(source_genres>0),false) then 'source_genre' when coalesce(bool_or(source_category>0),false) then 'source_category'
   when coalesce(bool_or(history_weight>0),false) then 'history_genre' else 'rating' end from final),
  'items',(select coalesce(jsonb_agg(item order by source_genres desc,source_category desc,history_weight desc,query_rating desc nulls last,query_release_year desc nulls last,position,id),'[]') from final)
 ) into result;
 return result;
end $$;
revoke all on function public.arkhen_movie_recommendations(text,text,text,integer,jsonb,jsonb) from public,anon;
grant execute on function public.arkhen_movie_recommendations(text,text,text,integer,jsonb,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
