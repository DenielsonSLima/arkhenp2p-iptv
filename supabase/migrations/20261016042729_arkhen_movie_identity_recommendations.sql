-- Contextual movie ranking v2. No catalog collection ID exists in the shipped
-- DTO: editorial families below are not TMDB collections or shared continuity.
-- Name/year classification is indexed once, not a per-user metadata scan.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

create function public.arkhen_movie_recommendation_keys(p_name text,p_year integer)
returns text[] language plpgsql immutable parallel safe security invoker set search_path='' as $$
declare identity text; title text; year integer; ending text; working_name text:=left(coalesce(p_name,''),500);
 families text[]:='{}'; universes text[]:='{}';
begin
 year:=case when p_year between 1900 and 2099 then p_year else 0 end;
 loop
  -- The shared identity strips technical suffixes and parenthesized years.
  -- Its normalized output also lets us handle "Title -2026", then strip any
  -- technical suffix that was before that year. Only a full release year is
  -- removed; sequel numbers such as "2", "7" and "X" are never stripped.
  identity:=public.arkhen_home_title_identity('movie',jsonb_build_object('name',working_name,'year',year));
  title:=split_part(identity,':',2);
  if year=0 and split_part(identity,':',3) ~ '^(19|20)[0-9]{2}$' then year:=split_part(identity,':',3)::integer;end if;
  ending:=substring(title from ' ((?:19|20)[0-9]{2})$');
  exit when ending is null or year<>0 and year<>ending::integer;
  year:=ending::integer;
  working_name:=trim(regexp_replace(title,' ((?:19|20)[0-9]{2})$',''));
 end loop;
 if title='' or title ~ '(^| )(documentario|documentary|making of|bastidores|parodia|parody)( |$)' then return '{}';end if;

 -- Distinctive phrases use token boundaries. Ambiguous/common titles need an
 -- exact title and year; plot, category, actor and user input cannot add keys.
 if title ~ '(^| )(batman|the batman)( |$)' or title in('the dark knight','the dark knight rises','o cavaleiro das trevas','batman o cavaleiro das trevas','o cavaleiro das trevas ressurge') then families:=array_append(families,'batman');end if;
 if title ~ '^(the |o |lego )?superman( |$)' or title in('man of steel','o homem de aco') then families:=array_append(families,'superman');end if;
 if title ~ '^(wonder woman|mulher maravilha)( |$)' then families:=array_append(families,'wonder-woman');end if;
 if title ~ '^aquaman( |$)' then families:=array_append(families,'aquaman');end if;
 if title ~ '^(justice league|liga da justica|zack snyder s justice league)( |$)' then families:=array_append(families,'justice-league');end if;
 if title ~ '^shazam( |$)' then families:=array_append(families,'shazam');end if;
 if title in('black adam','adao negro') then families:=array_append(families,'black-adam');end if;
 if title in('blue beetle','besouro azul') then families:=array_append(families,'blue-beetle');end if;
 if title ~ '^(green lantern|lanterna verde)( |$)' then families:=array_append(families,'green-lantern');end if;
 if title ~ '^supergirl( |$)' then families:=array_append(families,'supergirl');end if;
 if title in('the flash','flash') and year=2023 then families:=array_append(families,'flash');end if;
 if title in('joker','coringa') and year=2019 or title in('joker folie a deux','coringa delirio a dois') and year=2024 then families:=array_append(families,'joker');end if;
 if families && array['batman','superman','wonder-woman','aquaman','justice-league','shazam','black-adam','blue-beetle','green-lantern','supergirl','flash','joker'] then universes:=array_append(universes,'dc');end if;

 if title ~ '(^| )(homem aranha|spider man)( |$)' then families:=array_append(families,'spider-man');end if;
 if title ~ '^(iron man|homem de ferro)( |$)' then families:=array_append(families,'iron-man');end if;
 if title ~ '^(captain america|capitao america)( |$)' then families:=array_append(families,'captain-america');end if;
 if title ~ '^(the )?(avengers|vingadores)( |$)' or title ~ '^os vingadores( |$)' then families:=array_append(families,'avengers');end if;
 if title ~ '^(guardians of the galaxy|guardioes da galaxia)( |$)' then families:=array_append(families,'guardians-of-the-galaxy');end if;
 if title ~ '^(doctor strange|doutor estranho)( |$)' then families:=array_append(families,'doctor-strange');end if;
 if title ~ '^(black panther|pantera negra)( |$)' then families:=array_append(families,'black-panther');end if;
 if title ~ '^(ant man|homem formiga)( |$)' then families:=array_append(families,'ant-man');end if;
 if title in('thor','thor the dark world','thor o mundo sombrio','thor ragnarok','thor love and thunder','thor amor e trovao') then families:=array_append(families,'thor');end if;
 if title ~ '^x men( |$)' then families:=array_append(families,'x-men');end if;
 if title ~ '^deadpool( |$)' then families:=array_append(families,'deadpool');end if;
 if title in('venom','venom let there be carnage','venom tempo de carnificina','venom the last dance','venom a ultima rodada') and year in(2018,2021,2024) then families:=array_append(families,'venom');end if;
 if families && array['spider-man','iron-man','captain-america','avengers','guardians-of-the-galaxy','doctor-strange','black-panther','ant-man','thor','x-men','deadpool','venom'] then universes:=array_append(universes,'marvel');end if;

 if title ~ '(^| )(velozes e furiosos|velozes furiosos|fast and furious|fast furious|the fast and the furious)( |$)'
  or title in('2 fast 2 furious','mais velozes mais furiosos','fast five','furious 7','the fate of the furious','hobbs shaw','hobbs and shaw')
  or title='f9' and year=2021 or title='fast x' and year=2023 then families:=array_append(families,'fast-furious');end if;
 if title ~ '^transformers( |$)' or title='bumblebee' and year=2018 then families:=array_append(families,'transformers');end if;

 -- Never let the two Avatar families fall through into one another, even in
 -- the later genre fill. An unqualified Avatar without year remains unknown.
 if title in('the last airbender','o ultimo mestre do ar','avatar the last airbender','avatar o ultimo mestre do ar','avatar aang the last airbender',
  'a lenda de aang o ultimo mestre do ar','avatar a lenda de aang o ultimo mestre do ar') then
  families:=array_append(families,'avatar-aang');
 elsif title='avatar' and year=2009
  or title in('avatar the way of water','avatar o caminho da agua','avatar fire and ash','avatar fogo e cinzas','avatar fogo e cinza') then
  families:=array_append(families,'avatar-cameron');
 end if;
 return array(select distinct 'franchise:'||f from unnest(families) f
  union select distinct 'universe:'||u from unnest(universes) u order by 1);
end $$;
revoke all on function public.arkhen_movie_recommendation_keys(text,integer) from public,anon;
grant execute on function public.arkhen_movie_recommendation_keys(text,integer) to authenticated,service_role;

-- This partial expression index avoids a catalog metadata rewrite. Account
-- partition and visible generation are still checked in every indexed read.
-- A changed classifier must use a new version/rebuild this expression index.
create index arkhen_movie_recommendation_keys_v1 on public.catalog_media using gin
 (public.arkhen_movie_recommendation_keys(name,query_release_year))
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
 select payload into model from public.catalog_navigation_cache
  where provider_key=p_provider_key and scope_hash=p_scope_hash and media_type='movies'
   and generation_id=generation and not include_adult;
 if model is null then return null;end if;
 select m.home_identity,m.category_ids,m.query_genres,m.metadata,m.name,m.query_release_year into source_row
  from public.catalog_media m where(m.provider_key,m.scope_hash,m.media_type,m.generation_id,m.media_id)=
   (p_provider_key,p_scope_hash,'movies',generation,p_source_id)
   and m.is_active and not m.is_adult and not coalesce(p_hidden_items->'movies','[]') ? m.media_id
   and(cardinality(m.category_ids)=0 or exists(select 1 from unnest(m.category_ids) cid where not coalesce(p_hidden_categories->'movies','[]') ? cid))
   and not public.arkhen_progress_catalog_adult(owner,account_provider,'movie:'||m.media_id);
 if not found then
  return jsonb_build_object('schemaVersion',1,'rankingVersion',2,'identityVersion',1,'source','rpc','generatedAt',now(),'sourceId',p_source_id,
   'revision',generation,'revisionLibrary',null,'personalized',false,'reason','unavailable','items','[]'::jsonb);
 end if;
 if source_row.home_identity is null then return null;end if;
 source_keys:=case when 'documentario'=any(source_row.query_genres) then '{}'::text[]
  else public.arkhen_movie_recommendation_keys(source_row.name,source_row.query_release_year) end;
 source_franchises:=array(select k from unnest(source_keys) k where k like 'franchise:%');
 source_universes:=array(select k from unnest(source_keys) k where k like 'universe:%');
 source_tmdb:=case when source_row.metadata->>'tmdbId' ~ '^[1-9][0-9]{0,15}$' then source_row.metadata->>'tmdbId' end;
 source_imdb:=case when source_row.metadata->>'imdbId' ~ '^tt[0-9]{6,10}$' then source_row.metadata->>'imdbId' end;

 with categories as materialized(
  select c.media_type,c.category_id,c.name,
   c.is_adult or public.arkhen_progress_metadata_adult(jsonb_build_object('categoryName',c.name)) is_adult,
   public.arkhen_query_genres(to_jsonb(c.name)) genres
  from public.catalog_categories c join public.catalog_visible_generations g using(provider_key,scope_hash,media_type,generation_id)
  where c.provider_key=p_provider_key and c.scope_hash=p_scope_hash and c.media_type in('movies','series') and c.is_active
 ), watched as materialized(
  select p.item_key,p.updated_at,public.arkhen_home_title_identity(split_part(p.item_key,':',1),p.entry->'item') identity,
   case split_part(p.item_key,':',1) when 'movie' then 'movies' else 'series' end media_type,
   substr(p.item_key,strpos(p.item_key,':')+1) media_id,
   case when p.entry#>>'{item,tmdbId}' ~ '^[1-9][0-9]{0,15}$' then p.entry#>>'{item,tmdbId}' end tmdb,
   case when p.entry#>>'{item,imdbId}' ~ '^tt[0-9]{6,10}$' then p.entry#>>'{item,imdbId}' end imdb
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
   case when exists(select 1 from source_genres s where s.genre=g->>'id') then 1000.0/greatest(jsonb_array_length(coalesce(g->'itemIds','[]')),1) else 0 end genre_specificity,
   0 source_category,coalesce((select weight from genre_weights w where w.genre=g->>'id'),0) history_weight
  from jsonb_array_elements(coalesce(model->'genres','[]')) g
  union all
  select g->'itemIds',0,0,1,0 from jsonb_array_elements(coalesce(model->'categories','[]')) g
  where (g->>'id')=any(source_row.category_ids)
   and public.arkhen_query_normalize(g->>'name') !~ '^(geral|todos|todos os filmes|filmes|movies|favoritos)$'
   and public.arkhen_query_normalize(g->>'name') !~ '(^|[^a-z0-9])(lancamentos?|recentes|netflix|hbo|max|disney|prime|amazon|apple|4k|hd|fhd|uhd)([^a-z0-9]|$)'
 ), affinity as materialized(
  select id,sum(source_genre) source_genres,sum(genre_specificity) genre_specificity,max(source_category) source_category,sum(history_weight) history_weight
  from groups cross join lateral jsonb_array_elements_text(coalesce(ids,'[]')) id
  where source_genre>0 or source_category>0 or history_weight>0 group by id
 ), rating_order as materialized(
  select r.id,r.position from jsonb_array_elements_text(coalesce(model#>'{orders,rating}','[]')) with ordinality r(id,position)
 ), category_visibility as materialized(
  select id,bool_or(not coalesce(p_hidden_categories->'movies','[]') ? (c->>'id')) allowed
  from jsonb_array_elements(coalesce(model->'categories','[]')) c
  cross join lateral jsonb_array_elements_text(coalesce(c->'itemIds','[]')) id group by id
 ), strong_pool as materialized(
  select m.media_id id
  from public.catalog_media m
  where m.provider_key=p_provider_key and m.scope_hash=p_scope_hash and m.media_type='movies' and m.generation_id=generation
   and m.is_active and not m.is_adult and not 'documentario'=any(m.query_genres)
   and public.arkhen_movie_recommendation_keys(m.name,m.query_release_year) && source_keys
   and m.media_id<>p_source_id and not coalesce(p_hidden_items->'movies','[]') ? m.media_id
   and(cardinality(m.category_ids)=0 or exists(select 1 from unnest(m.category_ids) cid where not coalesce(p_hidden_categories->'movies','[]') ? cid))
   and not exists(select 1 from categories c where c.media_type='movies' and c.category_id=any(m.category_ids) and c.is_adult)
   and not exists(select 1 from watched w where w.media_type='movies' and w.media_id=m.media_id)
  order by (public.arkhen_movie_recommendation_keys(m.name,m.query_release_year) && source_franchises) desc,
   m.query_rating desc nulls last,m.sort_order,m.media_id limit 600
 ), generic_pool as materialized(
  select r.id from rating_order r join affinity a on a.id=r.id left join category_visibility v on v.id=r.id
  where r.id<>p_source_id and not coalesce(p_hidden_items->'movies','[]') ? r.id and coalesce(v.allowed,true)
   and not exists(select 1 from watched w where w.media_type='movies' and w.media_id=r.id)
  order by case when a.source_genres>0 then 2 when a.source_category>0 then 3 else 4 end,
   a.genre_specificity desc,a.source_genres desc,a.source_category desc,a.history_weight desc,r.position limit 600
 ), pool as materialized(
  select id from strong_pool union select id from generic_pool
 ), candidates as materialized(
  select p.id,m.home_identity,m.query_rating,m.query_release_year,
   case when 'documentario'=any(m.query_genres) then '{}'::text[] else public.arkhen_movie_recommendation_keys(m.name,m.query_release_year) end keys,
   coalesce(a.source_genres,0) source_genres,coalesce(a.genre_specificity,0) genre_specificity,
   coalesce(a.source_category,0) source_category,coalesce(a.history_weight,0) history_weight,coalesce(r.position,2147483647) position
  from pool p join public.catalog_media m on(m.provider_key,m.scope_hash,m.media_type,m.generation_id,m.media_id)=
   (p_provider_key,p_scope_hash,'movies',generation,p.id)
  left join affinity a on a.id=p.id left join rating_order r on r.id=p.id
  where m.is_active and not m.is_adult and m.home_identity is not null
   and(cardinality(m.category_ids)=0 or exists(select 1 from unnest(m.category_ids) cid where not coalesce(p_hidden_categories->'movies','[]') ? cid))
   and not exists(select 1 from categories c where c.media_type='movies' and c.category_id=any(m.category_ids) and c.is_adult)
 ), scored as materialized(
  select c.*,case when keys && source_franchises then 0 when keys && source_universes then 1
   when source_genres>0 then 2 when source_category>0 then 3 when history_weight>0 then 4 else 5 end bucket
  from candidates c
  where not ('franchise:avatar-cameron'=any(source_keys) and 'franchise:avatar-aang'=any(c.keys)
   or 'franchise:avatar-aang'=any(source_keys) and 'franchise:avatar-cameron'=any(c.keys))
 ), shortlist as materialized(
  select * from scored where bucket<5
  order by bucket,genre_specificity desc,source_genres desc,source_category desc,history_weight desc,query_rating desc nulls last,position,id limit 120
 ), metadata as materialized(
  select s.*,m.metadata raw_metadata,m.metadata||jsonb_build_object('id',m.media_id,'kind','movie','isAdult',false) item,
   case when m.metadata->>'tmdbId' ~ '^[1-9][0-9]{0,15}$' then m.metadata->>'tmdbId' end tmdb,
   case when m.metadata->>'imdbId' ~ '^tt[0-9]{6,10}$' then m.metadata->>'imdbId' end imdb
  from shortlist s join public.catalog_media m on(m.provider_key,m.scope_hash,m.media_type,m.generation_id,m.media_id)=
   (p_provider_key,p_scope_hash,'movies',generation,s.id)
 ), safe as materialized(
  select m.*,row_number() over(order by bucket,genre_specificity desc,source_genres desc,source_category desc,history_weight desc,query_rating desc nulls last,position,id) rank
  from metadata m
  where not public.arkhen_progress_metadata_adult(raw_metadata)
   and not(coalesce(m.tmdb=source_tmdb,false) or coalesce(m.imdb=source_imdb,false)
    or m.home_identity=source_row.home_identity and not(coalesce(m.tmdb<>source_tmdb,false) or coalesce(m.imdb<>source_imdb,false)))
   and not exists(select 1 from watched w where w.media_type='movies' and(
    w.media_id=m.id or coalesce(w.tmdb=m.tmdb,false) or coalesce(w.imdb=m.imdb,false)
    or w.identity=m.home_identity and not(coalesce(w.tmdb<>m.tmdb,false) or coalesce(w.imdb<>m.imdb,false))))
 ), deduplicated as materialized(
  select s.* from safe s where not exists(select 1 from safe prior where prior.rank<s.rank and(
   coalesce(prior.tmdb=s.tmdb,false) or coalesce(prior.imdb=s.imdb,false)
   or prior.home_identity=s.home_identity and not(coalesce(prior.tmdb<>s.tmdb,false) or coalesce(prior.imdb<>s.imdb,false))))
 ), final as materialized(
  select d.*,case bucket when 0 then 'source_franchise' when 1 then 'source_universe' when 2 then 'source_genre'
   when 3 then 'source_category' else 'history_genre' end recommendation_reason
  from deduplicated d order by rank limit p_limit
 )
 select jsonb_build_object('schemaVersion',1,'rankingVersion',2,'identityVersion',1,'source','rpc','generatedAt',now(),'sourceId',p_source_id,'revision',generation,
  'revisionLibrary',(select max(updated_at) from public.user_progress where user_id=owner and provider=account_provider),
  'personalized',(select coalesce(bool_or(history_weight>0),false) from final),
  'reason',coalesce((select recommendation_reason from final order by rank limit 1),'unavailable'),
  'items',(select coalesce(jsonb_agg(item||jsonb_build_object('recommendationReason',recommendation_reason) order by rank),'[]') from final)
 ) into result;
 return result;
end $$;
revoke all on function public.arkhen_movie_recommendations(text,text,text,integer,jsonb,jsonb) from public,anon;
grant execute on function public.arkhen_movie_recommendations(text,text,text,integer,jsonb,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
