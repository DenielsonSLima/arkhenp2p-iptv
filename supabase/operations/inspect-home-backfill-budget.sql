-- Index-backed bounded metadata check. No backfill or private library reads.
select count(*) as pending_up_to_51 from (
 select 1 from public.catalog_media m
 where m.home_identity is null and m.is_active
  and exists(select 1 from public.catalog_visible_generations g
   where(g.provider_key,g.scope_hash,g.media_type,g.generation_id)=
    (m.provider_key,m.scope_hash,m.media_type,m.generation_id))
 limit 51
) pending;
