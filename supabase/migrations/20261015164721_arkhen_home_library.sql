-- Depends on 20261015164720: shared compact catalog fields stay global;
-- this read joins only the authenticated owner's private viewing signals.
begin;
set local lock_timeout='5s';
set local statement_timeout='55s';

create function public.arkhen_home_title_identity(p_kind text,p_metadata jsonb)
returns text language plpgsql immutable parallel safe security invoker set search_path='' as $$
declare title text:=public.arkhen_query_normalize(p_metadata->>'name');previous text;year text;ending text;
begin
 year:=substring(coalesce(nullif(p_metadata->>'year',''),nullif(p_metadata->>'releaseDate',''),p_metadata->>'release_date','') from '\m((?:19|20)[0-9]{2})\M');
 loop
  previous:=title;
  title:=trim(regexp_replace(title,'(\s+|\s*[-[({])(full\s*hd|sd|hd|fhd|uhd|4k|hevc|h[ .]?26[45]|leg(endad[oa]s?)?|dub(lad[oa]s?)?|dual(\s+audio)?)[\])}]?\s*$','','i'));
  ending:=substring(title from '\s*[([]((?:19|20)[0-9]{2})[)\]]\s*$');
  if ending is not null then year:=coalesce(year,ending);title:=trim(regexp_replace(title,'\s*[([]((?:19|20)[0-9]{2})[)\]]\s*$',''));end if;
  exit when previous=title;
 end loop;
 return p_kind||':'||trim(regexp_replace(title,'[^a-z0-9]+',' ','g'))||':'||coalesce(year,'0');
end $$;
-- Adding a stored generated field rewrites every large metadata value. Keep the
-- derived value explicit and populate existing generations in bounded batches.
alter table public.catalog_media add column home_identity text;
create function arkhen_private.arkhen_home_identity_prepare()
returns trigger language plpgsql security invoker set search_path='' as $$
begin new.home_identity:=public.arkhen_home_title_identity(case new.media_type when 'movies' then 'movie' else new.media_type end,new.metadata);return new;end $$;
revoke all on function arkhen_private.arkhen_home_identity_prepare() from public,anon,authenticated;
grant execute on function arkhen_private.arkhen_home_identity_prepare() to service_role;
create trigger arkhen_home_identity_prepare before insert or update of metadata,media_type on public.catalog_media for each row execute function arkhen_private.arkhen_home_identity_prepare();
create index arkhen_home_identity_pending on public.catalog_media(provider_key,scope_hash,media_type,generation_id,media_id) where home_identity is null and is_active;
create function public.arkhen_prepare_home_identities(p_limit integer default 1000)
returns integer language plpgsql security invoker set search_path='' set statement_timeout='20s' as $$
declare affected integer;
begin
 if p_limit is null or p_limit not between 1 and 1000 then raise exception 'Invalid home preparation batch' using errcode='22023';end if;
 if not pg_try_advisory_xact_lock(hashtext('arkhen-home-identities')) then return 0;end if;
 with pending as materialized(
  select m.provider_key,m.scope_hash,m.media_type,m.generation_id,m.media_id from public.catalog_media m join public.catalog_visible_generations g using(provider_key,scope_hash,media_type,generation_id)
  where m.home_identity is null and m.is_active order by m.provider_key,m.scope_hash,m.media_type,m.media_id limit p_limit for update of m skip locked
 )
 update public.catalog_media m set home_identity=public.arkhen_home_title_identity(case m.media_type when 'movies' then 'movie' else m.media_type end,m.metadata)
 from pending p where(m.provider_key,m.scope_hash,m.media_type,m.generation_id,m.media_id)=(p.provider_key,p.scope_hash,p.media_type,p.generation_id,p.media_id);
 get diagnostics affected=row_count;return affected;
end $$;
revoke all on function public.arkhen_prepare_home_identities(integer) from public,anon,authenticated;
grant execute on function public.arkhen_prepare_home_identities(integer) to service_role;
do $cron$begin if to_regprocedure('cron.schedule(text,text,text)') is not null then perform cron.schedule('arkhen-home-identities','* * * * *','select public.arkhen_prepare_home_identities(1000);');end if;end $cron$;
create index arkhen_user_progress_home on public.user_progress(user_id,provider,updated_at desc) where deleted_at is null;
create index arkhen_user_favorites_home on public.user_favorites(user_id,provider,updated_at desc) where deleted_at is null;

create function public.arkhen_home_library(p_provider_key text,p_scope_hash text,p_include_adult boolean default false,p_hidden_categories jsonb default '{}',p_hidden_items jsonb default '{}')
returns jsonb language plpgsql stable security invoker set search_path='' set statement_timeout='8s' as $$
declare owner uuid:=(select auth.uid());account_provider text;input_kind text;values_json jsonb;result jsonb;
begin
 if not coalesce(public.arkhen_partition_allows(p_provider_key,p_scope_hash),false) then raise exception 'Home access denied' using errcode='42501';end if;
 if p_include_adult is null or jsonb_typeof(p_hidden_categories) is distinct from 'object' or jsonb_typeof(p_hidden_items) is distinct from 'object' or octet_length(p_hidden_categories::text)+octet_length(p_hidden_items::text)>65536 then raise exception 'Invalid home parameters' using errcode='22023';end if;
 foreach input_kind in array array['live','movies','series'] loop
  foreach values_json in array array[coalesce(p_hidden_categories->input_kind,'[]'),coalesce(p_hidden_items->input_kind,'[]')] loop
   if jsonb_typeof(values_json)<>'array' then raise exception 'Invalid home exclusions' using errcode='22023';end if;
   if jsonb_array_length(values_json)>2000 or exists(select 1 from jsonb_array_elements(values_json) item where jsonb_typeof(item)<>'string' or length(item#>>'{}')>160) then raise exception 'Invalid home exclusions' using errcode='22023';end if;
  end loop;
 end loop;
 select provider into account_provider from public.profiles where id=owner;
 if exists(select 1 from public.catalog_media m join public.catalog_visible_generations g using(provider_key,scope_hash,media_type,generation_id)
  where m.provider_key=p_provider_key and m.scope_hash=p_scope_hash and m.is_active and m.home_identity is null) then return null;end if;
 with catalog_rows as materialized(
  select m.media_type,m.media_id,m.generation_id,m.category_ids,m.is_adult,m.sort_order,m.home_identity,m.query_rating,m.query_release_year,m.query_genres
  from public.catalog_media m join public.catalog_visible_generations g using(provider_key,scope_hash,media_type,generation_id)
  where m.provider_key=p_provider_key and m.scope_hash=p_scope_hash and m.is_active
 ), visible as materialized(
  select m.* from catalog_rows m where(p_include_adult or not m.is_adult)
   and not coalesce(p_hidden_items->m.media_type,'[]') ? m.media_id
   and(cardinality(m.category_ids)=0 or exists(select 1 from unnest(m.category_ids) cat where not coalesce(p_hidden_categories->m.media_type,'[]') ? cat))
 ), category_genres as materialized(
  select c.media_type,c.category_id,unnest(public.arkhen_query_genres(to_jsonb(c.name))) genre
  from public.catalog_categories c join public.catalog_visible_generations g using(provider_key,scope_hash,media_type,generation_id)
  where c.provider_key=p_provider_key and c.scope_hash=p_scope_hash and c.media_type in('movies','series') and c.is_active
 ), title_genres as materialized(
  select home_identity,array_agg(distinct genre order by genre) genres from(
   select v.home_identity,unnest(v.query_genres) genre from visible v where v.media_type in('movies','series')
   union all
   select v.home_identity,c.genre from visible v cross join lateral unnest(v.category_ids) cid
    join category_genres c on c.media_type=v.media_type and c.category_id=cid where v.media_type in('movies','series')
  ) expanded group by home_identity
 ), progress as materialized(
  select p.item_key,p.episode_id,p.entry,p.updated_at,split_part(p.item_key,':',1) kind,
   case split_part(p.item_key,':',1) when 'movie' then 'movies' else split_part(p.item_key,':',1) end media_type,
   split_part(p.item_key,':',2) media_id,
   public.arkhen_home_title_identity(split_part(p.item_key,':',1),p.entry->'item') saved_identity,
   case when jsonb_typeof(p.entry->'time')='number' then (p.entry->>'time')::numeric end watched_seconds,
   row_number() over(partition by p.item_key order by p.updated_at desc,p.episode_id) latest
  from public.user_progress p where p.user_id=owner and p.provider=account_provider and p.deleted_at is null
   and p.item_key=concat(p.entry#>>'{item,kind}',':',p.entry#>>'{item,id}') and length(coalesce(p.entry#>>'{item,name}',''))>0
   and (split_part(p.item_key,':',1)<>'series' and p.episode_id='' or split_part(p.item_key,':',1)='series' and p.episode_id=p.entry#>>'{episode,id}')
 ), favorite as materialized(
  select f.item_key,f.item,f.updated_at,split_part(f.item_key,':',1) kind,
   case split_part(f.item_key,':',1) when 'movie' then 'movies' else split_part(f.item_key,':',1) end media_type,split_part(f.item_key,':',2) media_id,
   array(select cid from(select coalesce(f.item->>'categoryId','') cid union select value from jsonb_array_elements_text(case when jsonb_typeof(f.item->'categoryIds')='array' then f.item->'categoryIds' else '[]' end) value) ids where cid<>'') category_ids
  from public.user_favorites f where f.user_id=owner and f.provider=account_provider and f.deleted_at is null
   and f.item_key=concat(f.item->>'kind',':',f.item->>'id') and length(coalesce(f.item->>'name',''))>0
 ), favorite_visible as materialized(
  select f.* from favorite f left join catalog_rows c using(media_type,media_id)
  where(p_include_adult or not coalesce(c.is_adult,f.item->'isAdult'='true'::jsonb,false))
   and not coalesce(p_hidden_items->f.media_type,'[]') ? f.media_id
   and(case when c.media_id is not null then cardinality(c.category_ids)=0 or exists(select 1 from unnest(c.category_ids) cid where not coalesce(p_hidden_categories->f.media_type,'[]') ? cid)
    else cardinality(f.category_ids)=0 or exists(select 1 from unnest(f.category_ids) cid where not coalesce(p_hidden_categories->f.media_type,'[]') ? cid) end)
 ), watched as materialized(
  select p.*,coalesce(v.home_identity,matched.home_identity,p.saved_identity) current_identity,coalesce(v.home_identity,matched.home_identity) is not null has_current
  from progress p left join visible v using(media_type,media_id)
  left join(select distinct home_identity from visible) matched on v.media_id is null and matched.home_identity=p.saved_identity
  where p.latest=1 and p.kind in('movie','series') and p.watched_seconds>5 and p.watched_seconds<=8640000
 ), signals as materialized(
  select w.current_identity,max(w.updated_at) watched_at,t.genres from watched w left join title_genres t on t.home_identity=w.current_identity
  where w.has_current group by w.current_identity,t.genres
 ), weighted as materialized(
  select genres,1.0/(1.0+(row_number() over(order by watched_at desc,current_identity)-1)/4.0)/nullif(cardinality(genres),0) weight from signals
 ), genre_weights as materialized(select genre,sum(weight) weight from weighted cross join lateral unnest(genres) genre group by genre),
 scores as materialized(
  select t.home_identity,coalesce(sum(w.weight),0) score from title_genres t cross join lateral unnest(t.genres) genre left join genre_weights w using(genre) group by t.home_identity
 ), ranked as materialized(
  select v.*,coalesce(s.score,0) score,row_number() over(partition by v.home_identity order by coalesce(s.score,0) desc,v.query_rating desc,v.query_release_year desc,v.sort_order,v.media_id) variant
  from visible v left join scores s using(home_identity)
  where v.media_type in('movies','series') and v.query_rating>=7 and v.query_rating<=10
   and not exists(select 1 from watched w where w.media_type=v.media_type and w.media_id=v.media_id or w.saved_identity=v.home_identity or w.current_identity=v.home_identity)
 ), by_kind as materialized(
  select r.*,row_number() over(partition by media_type order by score desc,query_rating desc,query_release_year desc,sort_order,media_id) position
  from ranked r where variant=1
 ), first_kind as(select media_type from by_kind where position=1 order by score desc,query_rating desc,query_release_year desc,case media_type when 'movies' then 0 else 1 end,sort_order,media_id limit 1),
 recommendations as materialized(
  select media_type,media_id,score,row_number() over(order by position,case when media_type=(select media_type from first_kind) then 0 else 1 end) position
  from by_kind where position<=30 order by position,case when media_type=(select media_type from first_kind) then 0 else 1 end limit 30
 ), histories as materialized(
  select v.media_type,v.media_id,row_number() over(partition by v.media_type order by p.updated_at desc,v.media_id) position
  from progress p join visible v using(media_type,media_id) where p.latest=1 and p.watched_seconds>=0 and p.watched_seconds<=8640000
 ), favorites_live as materialized(
  select f.media_type,f.media_id,row_number() over(order by f.updated_at desc,f.media_id) position from favorite_visible f join visible v using(media_type,media_id) where f.kind='live' order by f.updated_at desc,f.media_id limit 30
 ), selected_keys as materialized(
  select media_type,media_id from recommendations union select media_type,media_id from histories where position<=30 union select media_type,media_id from favorites_live
 ), metadata as materialized(
  select m.media_type,m.media_id,m.metadata||jsonb_build_object('id',m.media_id,'kind',case m.media_type when 'movies' then 'movie' else m.media_type end,'isAdult',m.is_adult) item
  from selected_keys s join public.catalog_media m on(m.provider_key,m.scope_hash,m.media_type,m.media_id)=(p_provider_key,p_scope_hash,s.media_type,s.media_id)
   join public.catalog_visible_generations g on(m.provider_key,m.scope_hash,m.media_type,m.generation_id)=(g.provider_key,g.scope_hash,g.media_type,g.generation_id)
 )
 select jsonb_build_object('schemaVersion',1,'generatedAt',now(),
  'revisionLibrary',greatest((select max(updated_at) from public.user_progress where user_id=owner and provider=account_provider),(select max(updated_at) from public.user_favorites where user_id=owner and provider=account_provider)),
  'revisions',(select coalesce(jsonb_object_agg(media_type,generation_id),'{}') from public.catalog_visible_generations where provider_key=p_provider_key and scope_hash=p_scope_hash),
  'counts',(select jsonb_build_object('live',count(*) filter(where kind='live'),'movie',count(*) filter(where kind='movie'),'series',count(*) filter(where kind='series')) from favorite_visible),
  'history',(select jsonb_object_agg(kind,items) from(select kind,(select coalesce(jsonb_agg(m.item order by h.position),'[]') from histories h join metadata m using(media_type,media_id) where h.media_type=case kind when 'movie' then 'movies' else kind end and h.position<=30) items from unnest(array['live','movie','series']) kind) sections),
  'favoriteChannels',(select coalesce(jsonb_agg(m.item order by f.position),'[]') from favorites_live f join metadata m using(media_type,media_id)),
  'recommendations',jsonb_build_object('personalized',(select coalesce(bool_or(score>0),false) from recommendations),'items',(select coalesce(jsonb_agg(m.item order by r.position),'[]') from recommendations r join metadata m using(media_type,media_id)))
 ) into result;
 return result;
end $$;
revoke all on function public.arkhen_home_library(text,text,boolean,jsonb,jsonb) from public,anon;
grant execute on function public.arkhen_home_library(text,text,boolean,jsonb,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
