-- Compact computed fields keep searches away from large metadata JSON values.
-- Navigation models are shared per published domain/generation, never per user.
begin;
set local lock_timeout='5s';
set local statement_timeout='55s';

create function public.arkhen_query_normalize(p_text text)
returns text language sql immutable parallel safe security invoker set search_path='' as $$
 select trim(regexp_replace(lower(regexp_replace(normalize(coalesce(p_text,''),NFD),U&'[\0300-\036f]','','g')),'[[:space:]]+',' ','g'))
$$;
create function public.arkhen_query_title_key(p_text text)
returns text language sql immutable parallel safe security invoker set search_path='' as $$
 select coalesce(string_agg(case when part[1]~'^[0-9]+$' and length(part[1])<=20 then lpad(part[1],20,'0') else part[1] end,'' order by position),'')
 from regexp_matches(public.arkhen_query_normalize(p_text),'[0-9]+|[^0-9]+','g') with ordinality as parts(part,position)
$$;
create function public.arkhen_query_number(p_text text,p_rating boolean default false)
returns numeric language sql immutable parallel safe security invoker set search_path='' as $$
 select case when value>0 and (not p_rating or value<=10) then case when not p_rating and value<100000000000 then value*1000 else value end end
 from (select case when length(trim(p_text))<=25 and trim(p_text)~'^[0-9]+([.,][0-9]+)?$' then replace(trim(p_text),',','.')::numeric end value) parsed
$$;
create function public.arkhen_query_genre(p_text text)
returns text language plpgsql immutable parallel safe security invoker set search_path='' as $$
declare value text:=public.arkhen_query_normalize(p_text);result text;
begin
 if position('/' in value)>0 then
  if value!~'^(filmes?|series?)\s*/[^/]+$' then return null;end if;
  value:=regexp_replace(value,'^(filmes?|series?)\s*/\s*','');
 else value:=regexp_replace(value,'^(filmes?|series?)\s*[-:>]+\s*','');end if;
 value:=trim(regexp_replace(value,'[^a-z0-9&+]+',' ','g'));
 select id into result from(values
 ('acao',array['acao','action']),('aventura',array['aventura','adventure']),('animacao',array['animacao','animacoes','animation']),
 ('biografia',array['biografia','biografias','biography']),('comedia',array['comedia','comedias','comedy']),('crime',array['crime','crimes']),
 ('documentario',array['documentario','documentarios','documentary']),('drama',array['drama','dramas']),('esporte',array['esporte','esportes','sport','sports']),
 ('familia',array['familia','family']),('fantasia',array['fantasia','fantasy']),('faroeste',array['faroeste','western']),
 ('ficcao-cientifica',array['ficcao','ficcao cientifica','science fiction','sci fi']),('guerra',array['guerra','war']),('historia',array['historia','history','historico']),
 ('infantil',array['infantil','infantis','kids']),('misterio',array['misterio','misterios','mystery']),('musica',array['musica','music']),
 ('musical',array['musical','musicais']),('novela',array['novela','novelas','soap']),('policial',array['policial','policiais']),('reality',array['reality','reality show']),
 ('romance',array['romance','romances']),('suspense',array['suspense','suspenses','thriller']),('terror',array['terror','horror']),
 ('acao-aventura',array['acao aventura','acao e aventura','acao & aventura','action & adventure']),
 ('ficcao-fantasia',array['ficcao fantasia','ficcao e fantasia','ficcao & fantasia','sci fi & fantasy'])
 ) genres(id,aliases) where value=any(aliases);return result;
end $$;
create function public.arkhen_query_genres(p_value jsonb)
returns text[] language plpgsql immutable parallel safe security invoker set search_path='' as $$
declare value jsonb;part text;genre text;result text[]:='{}';
begin
 if jsonb_typeof(p_value)='array' then
  for value in select * from jsonb_array_elements(p_value) loop result:=result||public.arkhen_query_genres(value);end loop;
 elsif jsonb_typeof(p_value)='object' then result:=public.arkhen_query_genres(p_value->'name');
 elsif jsonb_typeof(p_value)='string' then
  foreach part in array regexp_split_to_array(p_value#>>'{}','[,;|]') loop genre:=public.arkhen_query_genre(part);if genre is not null then result:=array_append(result,genre);end if;end loop;
 end if;
 return array(select distinct item from unnest(result) item order by item);
end $$;
create function public.arkhen_query_genre_label(p_id text)
returns text language sql immutable parallel safe security invoker set search_path='' as $$
 select label from(values('acao','Ação'),('aventura','Aventura'),('animacao','Animação'),('biografia','Biografia'),('comedia','Comédia'),('crime','Crime'),
 ('documentario','Documentário'),('drama','Drama'),('esporte','Esporte'),('familia','Família'),('fantasia','Fantasia'),('faroeste','Faroeste'),
 ('ficcao-cientifica','Ficção científica'),('guerra','Guerra'),('historia','História'),('infantil','Infantil'),('misterio','Mistério'),('musica','Música'),
 ('musical','Musical'),('novela','Novela'),('policial','Policial'),('reality','Reality'),('romance','Romance'),('suspense','Suspense'),('terror','Terror'),
 ('acao-aventura','Ação e aventura'),('ficcao-fantasia','Ficção e fantasia')) genres(id,label) where id=p_id
$$;
create function public.arkhen_query_metadata_genres(p_metadata jsonb)
returns text[] language sql immutable parallel safe security invoker set search_path='' as $$
 select public.arkhen_query_genres(jsonb_build_array(p_metadata->'genre',p_metadata->'genres',p_metadata->'group',p_metadata->'groupNames'))
$$;
create function public.arkhen_query_release_year(p_metadata jsonb)
returns integer language sql immutable parallel safe security invoker set search_path='' as $$
 select coalesce(substring(coalesce(nullif(p_metadata->>'year',''),nullif(p_metadata->>'releaseDate',''),p_metadata->>'release_date','') from '\m((?:19|20)[0-9]{2})\M'),
  substring(regexp_replace(coalesce(p_metadata->>'name',''),'(\s+(sd|hd|fhd|uhd|4k|leg|dub|dual))+\s*$','','i') from '\(((?:19|20)[0-9]{2})\)\s*$'),'0')::integer
$$;
create function public.arkhen_query_release_time(p_metadata jsonb)
returns numeric language plpgsql immutable parallel safe security invoker set search_path='' as $$
declare value text:=coalesce(nullif(p_metadata->>'added',''),nullif(p_metadata->>'releaseDate',''),p_metadata->>'release_date');number numeric;
begin
 if length(value)<=25 and value~'^[0-9]+(\.[0-9]+)?$' then number:=value::numeric;return case when number<1000000000000 then number*1000 else number end;end if;
 if length(value)<=40 and value~'^[0-9]{4}-[0-9]{2}-[0-9]{2}' then return extract(epoch from (value::timestamp at time zone 'UTC'))*1000;end if;
 return 0;
 exception when invalid_datetime_format or datetime_field_overflow then return 0;
end $$;
create function public.arkhen_query_title_identity(p_metadata jsonb)
returns text language sql immutable parallel safe security invoker set search_path='' as $$
 select trim(regexp_replace(regexp_replace(regexp_replace(public.arkhen_query_normalize(p_metadata->>'name'),'(\s+(sd|hd|fhd|uhd|4k|leg|dub|dual))+\s*$','','i'),'\s*\((19|20)[0-9]{2}\)\s*$',''),'[^a-z0-9]+',' ','g'))||':'||public.arkhen_query_release_year(p_metadata)
$$;
alter table public.catalog_media
 add column query_name text generated always as(public.arkhen_query_normalize(name)) stored,
 add column query_title_key text generated always as(public.arkhen_query_title_key(name)) stored,
 add column query_text text generated always as(public.arkhen_query_normalize(name||' '||coalesce(metadata->>'group','')||' '||coalesce(metadata->>'genre','')||' '||coalesce(metadata->>'genres','')||' '||coalesce(metadata->>'groupNames',''))) stored,
 add column query_rating numeric generated always as(public.arkhen_query_number(metadata->>'rating',true)) stored,
 add column query_added numeric generated always as(public.arkhen_query_number(metadata->>'added',false)) stored,
 add column query_genres text[] generated always as(public.arkhen_query_metadata_genres(metadata)) stored,
 add column query_release_year integer generated always as(public.arkhen_query_release_year(metadata)) stored,
 add column query_identity text generated always as(public.arkhen_query_title_identity(metadata)) stored,
 add column query_release_time numeric generated always as(public.arkhen_query_release_time(metadata)) stored,
 add column query_launch boolean generated always as(public.arkhen_query_normalize(coalesce(metadata->>'group',''))~'\m(lancamentos?|estreias?|recentes?)\M') stored,
 add column query_feature_ready boolean generated always as(coalesce(metadata->>'backdrop','')<>'' and coalesce(metadata->>'poster','')<>'' and public.arkhen_query_number(metadata->>'rating',true)>0) stored;

create function public.arkhen_global_search(p_provider_key text,p_scope_hash text,p_query text,p_media_type text default 'all',p_offset integer default 0,p_limit integer default 120,p_hidden_categories jsonb default '{}',p_hidden_items jsonb default '{}',p_include_adult boolean default false)
returns jsonb language plpgsql stable security invoker set search_path='' set statement_timeout='8s' as $$
declare query text:=public.arkhen_query_normalize(p_query);words text[];kind text;values_json jsonb;items jsonb;counts jsonb;total bigint;revisions jsonb;ready integer;
begin
 if not coalesce(public.arkhen_partition_allows(p_provider_key,p_scope_hash),false) then raise exception 'Search access denied' using errcode='42501';end if;
 if p_media_type is null or p_media_type not in('all','live','movies','series') or p_offset is null or p_offset not between 0 and 1000000 or p_limit is null or p_limit not between 1 and 120 or p_include_adult is null or length(query)>160 or jsonb_typeof(p_hidden_categories) is distinct from 'object' or jsonb_typeof(p_hidden_items) is distinct from 'object' or octet_length(p_hidden_categories::text)+octet_length(p_hidden_items::text)>65536 then raise exception 'Invalid search parameters' using errcode='22023';end if;
 foreach kind in array array['live','movies','series'] loop
  foreach values_json in array array[coalesce(p_hidden_categories->kind,'[]'),coalesce(p_hidden_items->kind,'[]')] loop
   if jsonb_typeof(values_json)<>'array' then raise exception 'Invalid search exclusions' using errcode='22023';end if;
   if jsonb_array_length(values_json)>2000 or exists(select 1 from jsonb_array_elements(values_json) item where jsonb_typeof(item)<>'string' or length(item#>>'{}')>160) then raise exception 'Invalid search exclusions' using errcode='22023';end if;
  end loop;
 end loop;
 if length(query)<3 then return jsonb_build_object('schemaVersion',1,'query',query,'items','[]'::jsonb,'counts',jsonb_build_object('live',0,'movie',0,'series',0),'total',0,'hasMore',false,'nextOffset',null,'revision','{}'::jsonb,'complete',true,'preparing',false,'tooShort',true);end if;
 words:=regexp_split_to_array(query,' ');
 select coalesce(jsonb_object_agg(c.media_type,jsonb_build_object('snapshotId',c.snapshot_id,'generation',c.index_generation,'revisionAt',c.updated_at)),'{}'),count(*)
 into revisions,ready from public.provider_catalog_cache c join public.catalog_visible_generations g on(c.provider_key,c.scope_hash,c.media_type,c.index_generation)=(g.provider_key,g.scope_hash,g.media_type,g.generation_id)
 where c.provider_key=p_provider_key and c.scope_hash=p_scope_hash and c.is_complete;
 with matched as materialized(
  select m.media_id,m.media_type,m.generation_id,m.query_title_key,
   case when m.query_name=query then 0 when starts_with(m.query_name,query) then 1 when position(query in m.query_name)>0 then 2
    when not exists(select 1 from unnest(words) word where position(word in m.query_name)=0) then 3 else 4 end as rank
  from public.catalog_media m join public.catalog_visible_generations g using(provider_key,scope_hash,media_type,generation_id)
  where m.provider_key=p_provider_key and m.scope_hash=p_scope_hash and m.is_active and (p_include_adult or not m.is_adult)
   and not coalesce(p_hidden_items->m.media_type,'[]') ? m.media_id
   and (cardinality(m.category_ids)=0 or exists(select 1 from unnest(m.category_ids) cat where not coalesce(p_hidden_categories->m.media_type,'[]') ? cat))
   and not exists(select 1 from unnest(words) word where position(word in m.query_text)=0)
 ), selected as materialized(
  select * from matched where p_media_type='all' or media_type=p_media_type
  order by rank,query_title_key,case media_type when 'live' then 0 when 'movies' then 1 else 2 end,media_id offset p_offset limit p_limit
 )
 select
  (select coalesce(jsonb_agg(m.metadata||jsonb_build_object('isAdult',m.is_adult) order by s.rank,s.query_title_key,case s.media_type when 'live' then 0 when 'movies' then 1 else 2 end,s.media_id),'[]')
   from selected s join public.catalog_media m on(m.provider_key,m.scope_hash,m.media_type,m.generation_id,m.media_id)=(p_provider_key,p_scope_hash,s.media_type,s.generation_id,s.media_id)),
  (select jsonb_build_object('live',count(*) filter(where media_type='live'),'movie',count(*) filter(where media_type='movies'),'series',count(*) filter(where media_type='series')) from matched),
  (select count(*) from matched where p_media_type='all' or media_type=p_media_type)
 into items,counts,total;
 return jsonb_build_object('schemaVersion',1,'query',query,'items',items,'counts',counts,'total',total,'hasMore',p_offset+jsonb_array_length(items)<total,'nextOffset',case when p_offset+jsonb_array_length(items)<total then p_offset+jsonb_array_length(items) end,'revision',revisions,'complete',ready=3,'preparing',ready<>3);
end $$;
revoke all on function public.arkhen_global_search(text,text,text,text,integer,integer,jsonb,jsonb,boolean) from public,anon;
grant execute on function public.arkhen_global_search(text,text,text,text,integer,integer,jsonb,jsonb,boolean) to authenticated;

create table public.catalog_navigation_cache(
 provider_key text not null,scope_hash text not null,media_type text not null check(media_type in('live','movies','series')),generation_id uuid not null,
 include_adult boolean not null,payload jsonb not null,created_at timestamptz not null default now(),primary key(provider_key,scope_hash,media_type,generation_id,include_adult)
);
alter table public.catalog_navigation_cache enable row level security;
revoke all on public.catalog_navigation_cache from public,anon,authenticated;
grant select on public.catalog_navigation_cache to authenticated;
grant all on public.catalog_navigation_cache to service_role;
create policy arkhen_navigation_read on public.catalog_navigation_cache for select to authenticated using((provider_key,scope_hash,media_type,generation_id) in(select provider_key,scope_hash,media_type,generation_id from public.catalog_visible_generations));

create function public.arkhen_prepare_catalog_read_model(p_provider_key text,p_scope_hash text,p_media_type text)
returns boolean language plpgsql security invoker set search_path='' set statement_timeout='45s' as $$
declare header record;adult boolean;result jsonb;
begin
 if p_media_type is null or p_media_type not in('live','movies','series') then raise exception 'Invalid catalog domain' using errcode='22023';end if;
 if not pg_try_advisory_xact_lock(hashtext('catalog-navigation:'||p_provider_key||p_scope_hash||p_media_type)) then return false;end if;
 select c.snapshot_id,c.index_generation,c.updated_at,c.expires_at into header from public.provider_catalog_cache c join public.catalog_visible_generations g on(c.provider_key,c.scope_hash,c.media_type,c.index_generation)=(g.provider_key,g.scope_hash,g.media_type,g.generation_id) where c.provider_key=p_provider_key and c.scope_hash=p_scope_hash and c.media_type=p_media_type and c.is_complete;
 if not found then return false;end if;
 foreach adult in array array[false,true] loop
  with categories as materialized(
   select category_id,name,public.arkhen_query_genres(to_jsonb(name)) genres from public.catalog_categories where provider_key=p_provider_key and scope_hash=p_scope_hash and media_type=p_media_type and generation_id=header.index_generation and is_active and(adult or not is_adult)
  ), items as materialized(
   select m.media_id,m.category_ids,m.query_title_key,m.query_added,m.query_rating,m.sort_order,
    m.query_release_year as release_year,m.query_release_time as release_time,m.query_identity as title_identity,m.query_launch as launch_category,m.query_feature_ready as feature_ready,
    case when p_media_type='live' then '{}'::text[] else array(select distinct genre from unnest(m.query_genres||coalesce((select array_agg(genre) from categories c cross join lateral unnest(c.genres) genre where c.category_id=any(m.category_ids)),'{}')) genre order by genre) end genres
   from public.catalog_media m where provider_key=p_provider_key and scope_hash=p_scope_hash and media_type=p_media_type and generation_id=header.index_generation and is_active and(adult or not is_adult)
  ), category_members as(
   select c.category_id,c.name,array(select i.media_id from items i where c.category_id=any(i.category_ids) order by i.sort_order,i.media_id) ids from categories c
  ), genre_members as(
   select genre,array_agg(media_id order by sort_order,media_id) ids from items cross join lateral unnest(genres) genre group by genre
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
   'genres',(select coalesce(jsonb_agg(jsonb_build_object('id',genre,'name',public.arkhen_query_genre_label(genre),'itemIds',ids,'count',cardinality(ids)) order by public.arkhen_query_title_key(public.arkhen_query_genre_label(genre))),'[]') from genre_members)) into result;
  insert into public.catalog_navigation_cache(provider_key,scope_hash,media_type,generation_id,include_adult,payload) values(p_provider_key,p_scope_hash,p_media_type,header.index_generation,adult,result) on conflict(provider_key,scope_hash,media_type,generation_id,include_adult) do nothing;
 end loop;
 if not exists(select 1 from public.catalog_visible_generations where provider_key=p_provider_key and scope_hash=p_scope_hash and media_type=p_media_type and generation_id=header.index_generation) then raise exception 'Catalog generation changed while preparing navigation' using errcode='40001';end if;
 delete from public.catalog_navigation_cache where provider_key=p_provider_key and scope_hash=p_scope_hash and media_type=p_media_type and generation_id<>header.index_generation;
 return true;
end $$;
revoke all on function public.arkhen_prepare_catalog_read_model(text,text,text) from public,anon,authenticated;
grant execute on function public.arkhen_prepare_catalog_read_model(text,text,text) to service_role;

create function public.arkhen_catalog_read_model(p_provider_key text,p_scope_hash text,p_media_type text,p_include_adult boolean default false)
returns jsonb language plpgsql stable security invoker set search_path='' set statement_timeout='8s' as $$
declare result jsonb;
begin
 if p_media_type is null or p_media_type not in('live','movies','series') or p_include_adult is null then raise exception 'Invalid catalog read model' using errcode='22023';end if;
 if not coalesce(public.arkhen_partition_allows(p_provider_key,p_scope_hash),false) then raise exception 'Catalog read model access denied' using errcode='42501';end if;
 select c.payload into result from public.catalog_navigation_cache c join public.catalog_visible_generations g using(provider_key,scope_hash,media_type,generation_id) where c.provider_key=p_provider_key and c.scope_hash=p_scope_hash and c.media_type=p_media_type and c.include_adult=p_include_adult;
 return result;
end $$;
revoke all on function public.arkhen_catalog_read_model(text,text,text,boolean) from public,anon;
grant execute on function public.arkhen_catalog_read_model(text,text,text,boolean) to authenticated;

create function public.arkhen_prepare_pending_catalog_read_model()
returns boolean language plpgsql security invoker set search_path='' set statement_timeout='45s' as $$
declare pending record;
begin
 select g.provider_key,g.scope_hash,g.media_type into pending from public.catalog_visible_generations g
 join public.provider_catalog_cache h on(h.provider_key,h.scope_hash,h.media_type,h.index_generation)=(g.provider_key,g.scope_hash,g.media_type,g.generation_id)
 where h.is_complete and (select count(*) from public.catalog_navigation_cache c where(c.provider_key,c.scope_hash,c.media_type,c.generation_id)=(g.provider_key,g.scope_hash,g.media_type,g.generation_id))<2
 order by h.updated_at,g.media_type limit 1;
 if not found then return false;end if;
 return public.arkhen_prepare_catalog_read_model(pending.provider_key,pending.scope_hash,pending.media_type);
end $$;
revoke all on function public.arkhen_prepare_pending_catalog_read_model() from public,anon,authenticated;
grant execute on function public.arkhen_prepare_pending_catalog_read_model() to service_role;
do $cron$begin if to_regprocedure('cron.schedule(text,text,text)') is not null then perform cron.schedule('arkhen-catalog-navigation','* * * * *','select public.arkhen_prepare_pending_catalog_read_model();');end if;end $cron$;
notify pgrst,'reload schema';
commit;
