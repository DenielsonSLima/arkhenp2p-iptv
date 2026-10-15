-- Only the one leased catalog publisher needs to sort the bounded complete
-- metadata set. Keep role/global memory and the 55-second timeout unchanged.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
alter function public.arkhen_cloud_catalog_publish(uuid,text,text) set work_mem='32MB';
analyze arkhen_private.catalog_publish_categories;
analyze arkhen_private.catalog_publish_items;
analyze arkhen_private.catalog_publish_artwork;
analyze public.catalog_media;
analyze public.catalog_artwork_refs;
notify pgrst,'reload schema';
commit;
