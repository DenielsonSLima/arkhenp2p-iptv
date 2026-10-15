-- The home query discourages nested loops for its broad ranking; the private
-- adult lookup needs an indexed one-title join. Keep that choice local too.
begin;
set local lock_timeout='5s';
set local statement_timeout='15s';
alter function public.arkhen_progress_catalog_adult(uuid,text,text) set enable_nestloop='on';
alter function public.arkhen_progress_catalog_adult(uuid,text,text) set jit='off';

-- A separate materialization barrier ensures the final positive metadata
-- classifier sees only selected results, not a pushed-down full catalog scan.
do $home$
declare definition text;needle text;replacement text;
begin
 select pg_get_functiondef('public.arkhen_home_library(text,text,boolean,jsonb,jsonb)'::regprocedure) into definition;
 needle:=$n$), metadata as materialized(
  select m.media_type,m.media_id,m.metadata||$n$;
 replacement:=$r$), selected_metadata as materialized(
  select m.media_type,m.media_id,m.metadata source_metadata,m.metadata||$r$;
 if strpos(definition,needle)=0 then raise exception 'Home privacy plan: metadata anchor missing';end if;
 definition:=replace(definition,needle,replacement);
 needle:=$n$  where not public.arkhen_progress_metadata_adult(m.metadata)
   or p_include_adult and exists(select 1 from favorites_live f where(f.media_type,f.media_id)=(m.media_type,m.media_id))
 )$n$;
 replacement:=$r$ ), metadata as materialized(
  select m.media_type,m.media_id,m.item from selected_metadata m
  where not public.arkhen_progress_metadata_adult(m.source_metadata)
   or p_include_adult and exists(select 1 from favorites_live f where(f.media_type,f.media_id)=(m.media_type,m.media_id))
 )$r$;
 if strpos(definition,needle)=0 then raise exception 'Home privacy plan: filter anchor missing';end if;
 definition:=replace(definition,needle,replacement);
 execute definition;
end $home$;
notify pgrst,'reload schema';
commit;
