-- Avoid re-expanding the complete JSON for each normalized row. An uncorrelated
-- NOT IN uses a hashed ID subplan; validated non-null IDs preserve anti-join
-- semantics without rewriting unchanged metadata or emitting Realtime updates.
begin;
set local lock_timeout='5s';
set local statement_timeout='90s';
do $publisher$
declare definition text;
 category_old constant text:=$old$and not exists(select 1 from jsonb_array_elements(p_payload->'categories') item where item->>'id'=c.category_id)$old$;
 category_new constant text:=$new$and c.category_id not in(select item->>'id' from jsonb_array_elements(p_payload->'categories') item)$new$;
 media_old constant text:=$old$and not exists(select 1 from jsonb_array_elements(p_payload->'items') item where item->>'id'=m.media_id)$old$;
 media_new constant text:=$new$and m.media_id not in(select item->>'id' from jsonb_array_elements(p_payload->'items') item)$new$;
 artwork_old constant text:=$old$from public.catalog_media media cross join lateral jsonb_each_text(media.metadata) field$old$;
 artwork_new constant text:=$new$from public.catalog_media media cross join lateral(values('poster',media.metadata->>'poster'),('backdrop',media.metadata->>'backdrop'),('posterOriginal',media.metadata->>'posterOriginal')) field(key,value)$new$;
 cleanup_old constant text:=$old$and not exists(
    select 1 from public.catalog_media media where media.provider_key=reference.provider_key and media.scope_hash=reference.scope_hash and media.media_type=reference.media_type and media.media_id=reference.media_id and media.is_active and media.metadata->>reference.field='/api/shared-image/'||reference.ref
  )$old$;
 cleanup_new constant text:=$new$and (reference.media_id,reference.field,reference.ref) not in(
    select item->>'id',field.key,substring(field.value from '/api/shared-image/([a-f0-9]{64})$')
    from jsonb_array_elements(p_payload->'items') item
    cross join lateral(values('poster',item->>'poster'),('backdrop',item->>'backdrop'),('posterOriginal',item->>'posterOriginal')) field(key,value)
    where field.value~'^/api/shared-image/[a-f0-9]{64}$'
  )$new$;
begin
 definition:=pg_get_functiondef('public.arkhen_publish_catalog(text,text,text,jsonb,boolean,uuid,timestamptz,uuid,text)'::regprocedure);
 if position(category_old in definition)=0 or position(media_old in definition)=0 or position(artwork_old in definition)=0 then raise exception 'Catalog publisher scale version mismatch';end if;
 -- pg_get_functiondef retains the original CRLF inside older SQL bodies.
 definition:=replace(definition,E'\r\n',E'\n');
 if position(cleanup_old in definition)=0 then raise exception 'Catalog artwork cleanup version mismatch';end if;
 execute replace(replace(replace(replace(definition,category_old,category_new),media_old,media_new),artwork_old,artwork_new),cleanup_old,cleanup_new);
end $publisher$;
notify pgrst,'reload schema';
commit;
