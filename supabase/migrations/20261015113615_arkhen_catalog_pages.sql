-- Bounded catalog reads use normalized global metadata. No provider transport
-- credentials or per-account parental state are stored in these shared rows.
begin;
set local lock_timeout='5s';
set local statement_timeout='120s';

alter table public.catalog_media add column if not exists sort_order bigint not null default 0;
alter table public.catalog_media add column if not exists is_adult boolean not null default false;
alter table public.catalog_categories add column if not exists is_adult boolean not null default false;
alter table public.provider_catalog_cache add column if not exists item_count bigint not null default 0;
alter table public.provider_catalog_cache add column if not exists safe_item_count bigint not null default 0;

create or replace function arkhen_private.catalog_adult_marker(p_text text,p_category boolean default false)
returns boolean language sql immutable security invoker set search_path='' as $$
  select normalized ~ '(^|[^a-z0-9])(adult(o|a|os|as|s)?|xxx|porn(o|os|ografia|ographic)?|erotic(o|a|os|as)?|hentai)($|[^a-z0-9])'
    or normalized ~ '(^|[^0-9])(\+[[:space:]]*18|18[[:space:]]*\+)($|[^0-9])'
    or p_category and normalized ~ '(^|[^a-z0-9])18($|[^a-z0-9])'
  from (select regexp_replace(translate(lower(coalesce(p_text,'')),'áàâãäéèêëíìîïóòôõöúùûüçñ','aaaaaeeeeiiiiooooouuuucn'),'\madult[[:space:]]+swim\M','','g') as normalized) source
$$;

create or replace function arkhen_private.catalog_item_adult(p_metadata jsonb)
returns boolean language sql immutable security invoker set search_path='' as $$
  select coalesce(p_metadata->>'adult','false')='true' or coalesce(p_metadata->>'isAdult','false')='true' or coalesce(p_metadata->>'is_adult','false')='true'
    or arkhen_private.catalog_adult_marker(coalesce(p_metadata->>'name',p_metadata->>'title'),false)
    or arkhen_private.catalog_adult_marker(concat_ws(' ',p_metadata->>'group',p_metadata->>'categoryName',p_metadata->>'category_name',case when jsonb_typeof(p_metadata->'groupNames')='array' then (select string_agg(value,' ') from jsonb_array_elements_text(p_metadata->'groupNames')) else '' end),true)
$$;
revoke all on function arkhen_private.catalog_adult_marker(text,boolean),arkhen_private.catalog_item_adult(jsonb) from public,anon,authenticated;
grant execute on function arkhen_private.catalog_adult_marker(text,boolean),arkhen_private.catalog_item_adult(jsonb) to service_role;

-- Recover the original source ordering once; later publications maintain it.
with positions as (
  select cache.provider_key,cache.scope_hash,cache.media_type,item.value->>'id' as media_id,item.ordinality
  from public.provider_catalog_cache cache cross join lateral jsonb_array_elements(cache.payload->'items') with ordinality item
)
update public.catalog_media media set sort_order=positions.ordinality from positions
where (media.provider_key,media.scope_hash,media.media_type,media.media_id)=(positions.provider_key,positions.scope_hash,positions.media_type,positions.media_id);
update public.catalog_categories set is_adult=arkhen_private.catalog_adult_marker(name,true);
update public.catalog_media media set is_adult=arkhen_private.catalog_item_adult(media.metadata) or exists(
  select 1 from public.catalog_categories category where category.provider_key=media.provider_key and category.scope_hash=media.scope_hash and category.media_type=media.media_type and category.category_id=any(media.category_ids) and category.is_adult
);
update public.provider_catalog_cache cache set item_count=counts.total,safe_item_count=counts.safe
from (select provider_key,scope_hash,media_type,count(*) as total,count(*) filter(where not is_adult) as safe from public.catalog_media where is_active group by provider_key,scope_hash,media_type) counts
where (cache.provider_key,cache.scope_hash,cache.media_type)=(counts.provider_key,counts.scope_hash,counts.media_type);

create index if not exists arkhen_catalog_media_order on public.catalog_media(provider_key,scope_hash,media_type,sort_order,media_id) where is_active;
create index if not exists arkhen_catalog_media_safe_order on public.catalog_media(provider_key,scope_hash,media_type,sort_order,media_id) where is_active and not is_adult;

create table if not exists public.catalog_artwork_refs (
  provider_key text not null,scope_hash text not null,ref text not null check(ref~'^[a-f0-9]{64}$'),
  media_type text not null check(media_type in ('live','movies','series')),media_id text not null,
  field text not null check(field in ('poster','backdrop','posterOriginal')),
  primary key(provider_key,scope_hash,ref,media_type,media_id,field)
);
comment on table public.catalog_artwork_refs is 'Shared opaque artwork lookup only: no upstream URLs, tokens or headers; bytes resolve lazily through an authorized provider session';
alter table public.catalog_artwork_refs enable row level security;
revoke all on public.catalog_artwork_refs from public,anon,authenticated;
grant select on public.catalog_artwork_refs to authenticated;
grant all on public.catalog_artwork_refs to service_role;
create policy arkhen_artwork_partition_read on public.catalog_artwork_refs for select to authenticated using(public.arkhen_partition_allows(provider_key,scope_hash));
insert into public.catalog_artwork_refs(provider_key,scope_hash,ref,media_type,media_id,field)
select media.provider_key,media.scope_hash,substring(field.value from '/api/shared-image/([a-f0-9]{64})$'),media.media_type,media.media_id,field.key
from public.catalog_media media cross join lateral jsonb_each_text(media.metadata) field
where media.is_active and field.key in ('poster','backdrop','posterOriginal') and field.value~'^/api/shared-image/[a-f0-9]{64}$'
on conflict do nothing;

-- STABLE keeps header, rows and categories on one statement snapshot while a
-- worker atomically publishes the next global catalog revision.
create or replace function public.arkhen_catalog_page(p_provider_key text,p_scope_hash text,p_media_type text,p_category text default null,p_page integer default 1,p_after bigint default -1,p_limit integer default 120,p_snapshot uuid default null,p_include_adult boolean default false)
returns jsonb language plpgsql stable security invoker set search_path='' set statement_timeout='8s' as $$
declare current_snapshot uuid;expiry timestamptz;revision_at timestamptz;total bigint;page_rows jsonb;categories jsonb;states jsonb;more boolean;last_order bigint;count_rows integer;changed boolean;
begin
  if p_media_type is null or p_media_type not in ('live','movies','series') or p_limit is null or p_limit not between 1 and 240 or p_page is null or p_page not between 1 and 100000 or p_after is null or p_after < -1 or p_after > 1000000000 or p_include_adult is null or p_category is not null and p_category!~'^[A-Za-z0-9_-]{1,160}$' then raise exception 'Invalid catalog page' using errcode='22023';end if;
  if not coalesce(public.arkhen_partition_allows(p_provider_key,p_scope_hash),false) then return null;end if;
  select snapshot_id,expires_at,updated_at,case when p_include_adult then item_count else safe_item_count end into current_snapshot,expiry,revision_at,total from public.provider_catalog_cache where provider_key=p_provider_key and scope_hash=p_scope_hash and media_type=p_media_type and is_complete;
  if current_snapshot is null then return null;end if;
  changed:=p_snapshot is not null and p_snapshot<>current_snapshot;
  if changed then p_category:=null;p_page:=1;p_after:=-1;end if;
  with selected as (
    select metadata,sort_order from public.catalog_media where provider_key=p_provider_key and scope_hash=p_scope_hash and media_type=p_media_type and is_active and (p_include_adult or not is_adult) and sort_order>p_after and (p_category is null or category_ids @> array[p_category]) order by sort_order,media_id limit p_limit+1
  ), limited as (select * from selected order by sort_order limit p_limit)
  select coalesce((select jsonb_agg(metadata order by sort_order) from limited),'[]'::jsonb),(select count(*)>p_limit from selected),(select max(sort_order) from limited),(select count(*) from limited) into page_rows,more,last_order,count_rows;
  select coalesce(jsonb_agg(jsonb_build_object('id',category_id,'name',name) order by sort_order,category_id),'[]'::jsonb),coalesce(jsonb_object_agg(category_id,jsonb_build_object('loaded',false,'nextPage',1,'nextCursor',-1,'hasMore',true)),'{}'::jsonb) into categories,states from public.catalog_categories where provider_key=p_provider_key and scope_hash=p_scope_hash and media_type=p_media_type and is_active and (p_include_adult or not is_adult);
  states:=states||jsonb_build_object(coalesce(p_category,'__all'),jsonb_build_object('loaded',true,'nextPage',p_page+1,'nextCursor',coalesce(last_order,p_after),'hasMore',more));
  if p_category is not null then states:=states||jsonb_build_object('__all',jsonb_build_object('loaded',false,'nextPage',1,'nextCursor',-1,'hasMore',true));end if;
  return jsonb_build_object('categories',categories,'items',page_rows,'catalogComplete',p_category is null and p_page=1 and not more,
    'pagination',jsonb_build_object('mode','category','source','supabase','snapshotId',current_snapshot,'snapshotChanged',changed,'revisionAt',revision_at,'globalCategory','__all','pageSize',p_limit,'total',total,'complete',p_category is null and not more,'expiresAt',expiry,'byCategory',states));
end $$;
revoke all on function public.arkhen_catalog_page(text,text,text,text,integer,bigint,integer,uuid,boolean) from public,anon;
grant execute on function public.arkhen_catalog_page(text,text,text,text,integer,bigint,integer,uuid,boolean) to authenticated;

create or replace function public.arkhen_publish_catalog(p_provider_key text,p_scope_hash text,p_media_type text,p_payload jsonb,p_complete boolean,p_snapshot_id uuid,p_expires_at timestamptz,p_job_id uuid,p_worker text)
returns void language plpgsql security invoker set search_path = '' set statement_timeout = '55s' as $$
begin
  perform arkhen_private.assert_cache_lease(p_job_id,p_worker,p_provider_key,p_scope_hash,'catalog');
  if p_complete is distinct from true or jsonb_typeof(p_payload->'items') is distinct from 'array' or jsonb_typeof(p_payload->'categories') is distinct from 'array' then raise exception 'Only a successful complete snapshot may be published';end if;
  if not arkhen_private.safe_shared_payload(p_payload) then raise exception 'Unsafe catalog payload';end if;
  if exists(select 1 from jsonb_array_elements(p_payload->'categories') c where jsonb_typeof(c)<>'object' or coalesce(c->>'id','')='' or coalesce(c->>'name','')='') then raise exception 'Invalid category';end if;
  if exists(select 1 from jsonb_array_elements(p_payload->'items') m where jsonb_typeof(m)<>'object' or coalesce(m->>'id','')='' or coalesce(m->>'name','')='') then raise exception 'Invalid media';end if;
  select p_payload || jsonb_build_object(
    'categories',coalesce((select jsonb_agg(value order by ordinality) from (select distinct on (value->>'id') value,ordinality from jsonb_array_elements(p_payload->'categories') with ordinality order by value->>'id',ordinality desc) chosen),'[]'::jsonb),
    'items',coalesce((select jsonb_agg(value order by ordinality) from (select distinct on (value->>'id') value,ordinality from jsonb_array_elements(p_payload->'items') with ordinality order by value->>'id',ordinality desc) chosen),'[]'::jsonb)
  ) into p_payload;

  with categories as (
    select distinct on (value->>'id') value,ordinality from jsonb_array_elements(p_payload->'categories') with ordinality order by value->>'id',ordinality desc
  )
  insert into public.catalog_categories as current(provider_key,scope_hash,media_type,category_id,name,last_seen_snapshot,sort_order,is_adult)
    select p_provider_key,p_scope_hash,p_media_type,value->>'id',value->>'name',p_snapshot_id,ordinality,arkhen_private.catalog_adult_marker(value->>'name',true) from categories
  on conflict(provider_key,scope_hash,media_type,category_id) do update
    set name=excluded.name,sort_order=excluded.sort_order,is_adult=excluded.is_adult,is_active=true,last_seen_snapshot=excluded.last_seen_snapshot,updated_at=now()
    where (current.name,current.sort_order,current.is_adult,current.is_active) is distinct from (excluded.name,excluded.sort_order,excluded.is_adult,true);

  with media as (
    select distinct on (value->>'id') value,ordinality from jsonb_array_elements(p_payload->'items') with ordinality order by value->>'id',ordinality desc
  )
  insert into public.catalog_media as current(provider_key,scope_hash,media_type,media_id,name,category_ids,metadata,last_seen_snapshot,sort_order,is_adult)
    select p_provider_key,p_scope_hash,p_media_type,value->>'id',value->>'name',
      case when jsonb_typeof(value->'categoryIds')='array' then coalesce(array(select jsonb_array_elements_text(value->'categoryIds')),'{}'::text[])
        when value->>'categoryId' is null then '{}'::text[] else array[value->>'categoryId'] end,
      value,p_snapshot_id,ordinality,arkhen_private.catalog_item_adult(value) or exists(
        select 1 from public.catalog_categories category where category.provider_key=p_provider_key and category.scope_hash=p_scope_hash and category.media_type=p_media_type and category.is_adult
          and (category.category_id=value->>'categoryId' or jsonb_typeof(value->'categoryIds')='array' and value->'categoryIds' ? category.category_id)
      ) from media
  on conflict(provider_key,scope_hash,media_type,media_id) do update
    set name=excluded.name,category_ids=excluded.category_ids,metadata=excluded.metadata,sort_order=excluded.sort_order,is_adult=excluded.is_adult,is_active=true,last_seen_snapshot=excluded.last_seen_snapshot,updated_at=now()
    where (current.name,current.category_ids,current.metadata,current.sort_order,current.is_adult,current.is_active) is distinct from (excluded.name,excluded.category_ids,excluded.metadata,excluded.sort_order,excluded.is_adult,true);

  -- Unchanged rows keep their last metadata revision; presence in this input,
  -- rather than an UPDATE solely for a snapshot UUID, decides disappearance.
  update public.catalog_categories c set is_active=false,updated_at=now()
    where c.provider_key=p_provider_key and c.scope_hash=p_scope_hash and c.media_type=p_media_type and c.is_active
      and not exists(select 1 from jsonb_array_elements(p_payload->'categories') item where item->>'id'=c.category_id);
  update public.catalog_media m set is_active=false,updated_at=now()
    where m.provider_key=p_provider_key and m.scope_hash=p_scope_hash and m.media_type=p_media_type and m.is_active
      and not exists(select 1 from jsonb_array_elements(p_payload->'items') item where item->>'id'=m.media_id);

  -- This is the publication point: failed validation or index writes roll back
  -- the entire transaction and never replace the visible complete snapshot.
  insert into public.provider_catalog_cache(provider_key,scope_hash,media_type,payload,expires_at,snapshot_id,is_complete)
    values(p_provider_key,p_scope_hash,p_media_type,p_payload,p_expires_at,p_snapshot_id,true)
    on conflict(provider_key,scope_hash,media_type) do update
      set payload=excluded.payload,expires_at=excluded.expires_at,snapshot_id=excluded.snapshot_id,is_complete=true,updated_at=now();

  update public.provider_catalog_cache set item_count=counts.total,safe_item_count=counts.safe
    from (select count(*) as total,count(*) filter(where not is_adult) as safe from public.catalog_media where provider_key=p_provider_key and scope_hash=p_scope_hash and media_type=p_media_type and is_active) counts
    where provider_key=p_provider_key and scope_hash=p_scope_hash and media_type=p_media_type;
  insert into public.catalog_artwork_refs(provider_key,scope_hash,ref,media_type,media_id,field)
    select provider_key,scope_hash,substring(field.value from '/api/shared-image/([a-f0-9]{64})$'),media_type,media_id,field.key
    from public.catalog_media media cross join lateral jsonb_each_text(media.metadata) field
    where provider_key=p_provider_key and scope_hash=p_scope_hash and media_type=p_media_type and is_active and field.key in ('poster','backdrop','posterOriginal') and field.value~'^/api/shared-image/[a-f0-9]{64}$' on conflict do nothing;
  delete from public.catalog_artwork_refs reference where reference.provider_key=p_provider_key and reference.scope_hash=p_scope_hash and reference.media_type=p_media_type and not exists(
    select 1 from public.catalog_media media where media.provider_key=reference.provider_key and media.scope_hash=reference.scope_hash and media.media_type=reference.media_type and media.media_id=reference.media_id and media.is_active and media.metadata->>reference.field='/api/shared-image/'||reference.ref
  );
end $$;


revoke all on function public.arkhen_publish_catalog(text,text,text,jsonb,boolean,uuid,timestamptz,uuid,text) from public,anon,authenticated;
grant execute on function public.arkhen_publish_catalog(text,text,text,jsonb,boolean,uuid,timestamptz,uuid,text) to service_role;
notify pgrst,'reload schema';
commit;
