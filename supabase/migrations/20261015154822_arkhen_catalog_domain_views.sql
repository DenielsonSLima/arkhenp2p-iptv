-- Inspectable logical domains over the same indexed rows. Invoker views keep
-- caller RLS and never expose an unpublished/retired generation to service
-- readers either. No private library or provider transport data is joined.
begin;
do $views$
declare kind text;name text;
begin
 foreach kind in array array['movies','series','live'] loop
  name:='catalog_'||kind;
  if to_regclass('public.'||name) is not null or to_regclass('public.'||name||'_categories') is not null or to_regclass('public.'||name||'_cache') is not null then raise exception 'Catalog domain view already exists';end if;
  execute format($sql$create view public.%I with(security_invoker=true) as
   select m.provider_key,m.scope_hash,m.media_type,m.media_id,m.name,m.category_ids,m.metadata,m.last_seen_snapshot,m.sort_order,m.is_adult,m.is_active,m.updated_at,m.generation_id
   from public.catalog_media m join public.catalog_visible_generations g using(provider_key,scope_hash,media_type,generation_id)
   where m.media_type=%L and m.is_active$sql$,name,kind);
  execute format($sql$create view public.%I with(security_invoker=true) as
   select m.provider_key,m.scope_hash,m.media_type,m.category_id,m.name,m.sort_order,m.is_adult,m.is_active,m.last_seen_snapshot,m.updated_at,m.generation_id
   from public.catalog_categories m join public.catalog_visible_generations g using(provider_key,scope_hash,media_type,generation_id)
   where m.media_type=%L and m.is_active$sql$,name||'_categories',kind);
  execute format($sql$create view public.%I with(security_invoker=true) as
   select c.provider_key,c.scope_hash,c.media_type,c.payload,c.expires_at,c.snapshot_id,c.is_complete,c.item_count,c.safe_item_count,c.updated_at,c.index_generation
   from public.provider_catalog_cache c join public.catalog_visible_generations g on g.provider_key=c.provider_key and g.scope_hash=c.scope_hash and g.media_type=c.media_type and g.generation_id=c.index_generation
   where c.media_type=%L and c.is_complete$sql$,name||'_cache',kind);
  execute format('revoke all on public.%I,public.%I,public.%I from public,anon,authenticated',name,name||'_categories',name||'_cache');
  execute format('grant select on public.%I,public.%I,public.%I to authenticated,service_role',name,name||'_categories',name||'_cache');
 end loop;
end $views$;
notify pgrst,'reload schema';
commit;
