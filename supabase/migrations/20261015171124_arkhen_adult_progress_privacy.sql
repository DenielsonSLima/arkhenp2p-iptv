-- Adult playback is intentionally ephemeral, even after parental unlock.
-- Favorites and catalog publication are not changed by this migration.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

-- Same positive markers as catalog ingestion. A false client flag cannot
-- override a trusted catalog match. The classifier does not infer adulthood
-- from an ordinary age-rating field, and Adult Swim remains a brand exception.
create function public.arkhen_progress_metadata_adult(p_item jsonb)
returns boolean language sql immutable security invoker set search_path='' as $$
 select coalesce(p_item->>'adult','false')='true' or coalesce(p_item->>'isAdult','false')='true' or coalesce(p_item->>'is_adult','false')='true'
  or exists(select 1 from(
   select regexp_replace(translate(lower(coalesce(value,'')),
    U&'\00e1\00e0\00e2\00e3\00e4\00e9\00e8\00ea\00eb\00ed\00ec\00ee\00ef\00f3\00f2\00f4\00f5\00f6\00fa\00f9\00fb\00fc\00e7\00f1',
    'aaaaaeeeeiiiiooooouuuucn'),'\madult[[:space:]]+swim\M','','g') normalized,is_category
   from(values(coalesce(p_item->>'name',p_item->>'title'),false),
    (concat_ws(' ',p_item->>'group',p_item->>'categoryName',p_item->>'category_name',
     case when jsonb_typeof(p_item->'groupNames')='array' then(select string_agg(value,' ') from jsonb_array_elements_text(p_item->'groupNames')) else '' end),true)) fields(value,is_category)
  ) labels where normalized~'(^|[^a-z0-9])(adult(o|a|os|as|s)?|xxx|porn(o|os|ografia|ographic)?|erotic(o|a|os|as)?|hentai)($|[^a-z0-9])'
   or normalized~'(^|[^0-9])(\+[[:space:]]*18|18[[:space:]]*\+)($|[^0-9])'
   or is_category and normalized~'(^|[^a-z0-9])18($|[^a-z0-9])')
$$;

-- The trusted lookup is scoped by the server-owned profile and published
-- generation, with the complete media primary key. No caller-provided scope,
-- category IDs or negative isAdult flag participates in this decision.
create function public.arkhen_progress_catalog_adult(p_user_id uuid,p_provider text,p_item_key text)
returns boolean language sql stable security invoker set search_path='' as $$
 select exists(
  select 1 from public.profiles p
  join public.catalog_visible_generations g on(g.provider_key,g.scope_hash,g.media_type)=
   (p.provider_key,p.scope_hash,case split_part(p_item_key,':',1) when 'movie' then 'movies' else split_part(p_item_key,':',1) end)
  join public.catalog_media m on(m.provider_key,m.scope_hash,m.media_type,m.generation_id,m.media_id)=
   (g.provider_key,g.scope_hash,g.media_type,g.generation_id,substr(p_item_key,strpos(p_item_key,':')+1))
  where p.id=p_user_id and p.provider=p_provider and m.is_active
   and(m.is_adult or public.arkhen_progress_metadata_adult(m.metadata) or exists(
    select 1 from public.catalog_categories c
    where(c.provider_key,c.scope_hash,c.media_type,c.generation_id)=(g.provider_key,g.scope_hash,g.media_type,g.generation_id)
     and c.is_active and c.category_id=any(m.category_ids)
     and(c.is_adult or public.arkhen_progress_metadata_adult(jsonb_build_object('categoryName',c.name)))
   ))
 )
$$;

create function public.arkhen_progress_privacy_guard()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if public.arkhen_progress_metadata_adult(new.entry->'item')
  or public.arkhen_progress_metadata_adult(new.entry->'episode')
  or public.arkhen_progress_metadata_adult(new.entry)
  or public.arkhen_progress_catalog_adult(new.user_id,new.provider,new.item_key) then
  raise exception using errcode='P0001',message='ARKHEN_ADULT_PROGRESS_DISABLED';
 end if;
 return new;
end $$;
revoke all on function public.arkhen_progress_metadata_adult(jsonb),public.arkhen_progress_catalog_adult(uuid,text,text),public.arkhen_progress_privacy_guard() from public,anon;
grant execute on function public.arkhen_progress_metadata_adult(jsonb),public.arkhen_progress_catalog_adult(uuid,text,text),public.arkhen_progress_privacy_guard() to authenticated,service_role;
create trigger arkhen_progress_privacy_guard before insert or update on public.user_progress
 for each row execute function public.arkhen_progress_privacy_guard();

-- Existing owner/provider policies still authorize every read. This additional
-- restrictive policy suppresses a later reclassification until bounded cleanup.
create policy arkhen_progress_private_read on public.user_progress as restrictive for select to authenticated using(
 not public.arkhen_progress_metadata_adult(entry->'item') and not public.arkhen_progress_metadata_adult(entry->'episode') and not public.arkhen_progress_metadata_adult(entry)
 and not public.arkhen_progress_catalog_adult(user_id,provider,item_key)
);

-- Delete only progress positively identified in the CURRENT trusted catalog
-- or explicitly marked adult in the saved record. Unknown/obsolete unmarked
-- IDs and all favorites are retained. No per-title log exists.
create function public.arkhen_prune_adult_progress(p_limit integer default 500)
returns integer language plpgsql security invoker set search_path='' set statement_timeout='8s' as $$
declare affected integer;
begin
 if p_limit is null or p_limit<1 or p_limit>500 then raise exception 'Invalid privacy cleanup limit' using errcode='22023';end if;
 if not pg_try_advisory_xact_lock(hashtextextended('arkhen-adult-progress-privacy',0)) then return 0;end if;
 with selected as materialized(
  select p.user_id,p.provider,p.item_key,p.episode_id from public.user_progress p
  where public.arkhen_progress_catalog_adult(p.user_id,p.provider,p.item_key)
   or public.arkhen_progress_metadata_adult(p.entry->'item') or public.arkhen_progress_metadata_adult(p.entry->'episode') or public.arkhen_progress_metadata_adult(p.entry)
  order by p.updated_at,p.user_id,p.provider,p.item_key,p.episode_id limit p_limit for update of p skip locked
 ), removed as(
  delete from public.user_progress p using selected s
  where(p.user_id,p.provider,p.item_key,p.episode_id)=(s.user_id,s.provider,s.item_key,s.episode_id) returning 1
 ) select count(*) into affected from removed;
 return affected;
end $$;
revoke all on function public.arkhen_prune_adult_progress(integer) from public,anon,authenticated;
grant execute on function public.arkhen_prune_adult_progress(integer) to service_role;

-- Preserve the tested home query and its function-local planner settings.
-- A separate safe projection drives history, genre signals and recommendations;
-- the unlocked projection continues to serve explicit favorite selections.
do $home$
declare definition text;needle text;replacement text;
begin
 select pg_get_functiondef('public.arkhen_home_library(text,text,boolean,jsonb,jsonb)'::regprocedure) into definition;
 needle:=$n$with catalog_rows as materialized($n$;
 replacement:=$r$with adult_categories as materialized(
  select c.media_type,array_agg(c.category_id) ids from public.catalog_categories c
  join public.catalog_visible_generations g using(provider_key,scope_hash,media_type,generation_id)
  where c.provider_key=p_provider_key and c.scope_hash=p_scope_hash and c.is_active
   and(c.is_adult or public.arkhen_progress_metadata_adult(jsonb_build_object('categoryName',c.name))) group by c.media_type
 ), catalog_rows as materialized($r$;
 if strpos(definition,needle)=0 then raise exception 'Home privacy patch: catalog anchor missing';end if;
 definition:=replace(definition,needle,replacement);
 needle:='m.category_ids,m.is_adult,m.sort_order';
 if strpos(definition,needle)=0 then raise exception 'Home privacy patch: classification anchor missing';end if;
 definition:=replace(definition,needle,'m.category_ids,(m.is_adult or m.category_ids&&coalesce(a.ids,array[]::text[])) is_adult,m.sort_order');
 needle:=$n$from public.catalog_media m join public.catalog_visible_generations g using(provider_key,scope_hash,media_type,generation_id)
  where m.provider_key=p_provider_key$n$;
 replacement:=$r$from public.catalog_media m join public.catalog_visible_generations g using(provider_key,scope_hash,media_type,generation_id)
  left join adult_categories a on a.media_type=m.media_type
  where m.provider_key=p_provider_key$r$;
 -- This text also appears in the preparation guard; only replace within the CTE.
 definition:=substr(definition,1,strpos(definition,'with adult_categories')-1)||replace(substr(definition,strpos(definition,'with adult_categories')),needle,replacement);
 needle:= '), category_genres as materialized(';
 if strpos(definition,needle)=0 then raise exception 'Home privacy patch: safe projection anchor missing';end if;
 definition:=replace(definition,needle,'), history_visible as materialized(select * from visible where not is_adult), category_genres as materialized(');
 definition:=replace(definition,'from visible v','from history_visible v');
 definition:=replace(definition,'left join visible v','left join history_visible v');
 definition:=replace(definition,'select distinct home_identity from visible','select distinct home_identity from history_visible');
 definition:=replace(definition,'from progress p join visible v','from progress p join history_visible v');
 -- Explicitly exclude untrusted adult metadata even if executed by a privileged
 -- test/service context; authenticated reads also have the restrictive policy.
 needle:='and p.item_key=concat(p.entry';
 if strpos(definition,needle)=0 then raise exception 'Home privacy patch: progress anchor missing';end if;
 definition:=replace(definition,needle,$r$and not public.arkhen_progress_metadata_adult(p.entry->'item') and not public.arkhen_progress_metadata_adult(p.entry->'episode') and not public.arkhen_progress_metadata_adult(p.entry)
   and not public.arkhen_progress_catalog_adult(p.user_id,p.provider,p.item_key)
   and p.item_key=concat(p.entry$r$);
 -- A positive metadata flag inconsistent with the compact column is checked
 -- only for selected results, not by detoasting the full catalog on each read.
 -- Explicit unlocked live favorites may still be displayed.
 needle:=$n$join public.catalog_visible_generations g on(m.provider_key,m.scope_hash,m.media_type,m.generation_id)=(g.provider_key,g.scope_hash,g.media_type,g.generation_id)
 )$n$;
 if strpos(definition,needle)=0 then raise exception 'Home privacy patch: metadata anchor missing';end if;
 replacement:=$r$join public.catalog_visible_generations g on(m.provider_key,m.scope_hash,m.media_type,m.generation_id)=(g.provider_key,g.scope_hash,g.media_type,g.generation_id)
  where not public.arkhen_progress_metadata_adult(m.metadata)
   or p_include_adult and exists(select 1 from favorites_live f where(f.media_type,f.media_id)=(m.media_type,m.media_id))
 )$r$;
 definition:=replace(definition,needle,replacement);
 execute definition;
end $home$;

select public.arkhen_prune_adult_progress(500);
do $cron$begin if to_regprocedure('cron.schedule(text,text,text)') is not null then
 perform cron.schedule('arkhen-adult-progress-privacy','*/5 * * * *','select public.arkhen_prune_adult_progress(500);');
end if;end $cron$;
notify pgrst,'reload schema';
commit;
