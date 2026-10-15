-- Small global previews are separate from successful, complete catalog snapshots.
begin;
set local lock_timeout='5s';
set local statement_timeout='90s';
create table public.catalog_preview_cache(
 provider_key text not null,scope_hash text not null,media_type text not null check(media_type in('live','movies','series')),
 job_id uuid not null,sampled_pages integer not null check(sampled_pages between 0 and 12),
 payload jsonb not null check(arkhen_private.safe_shared_payload(payload) and octet_length(payload::text)<=8388608
   and jsonb_typeof(payload->'items')='array' and jsonb_array_length(payload->'items')<=120
   and jsonb_typeof(payload->'safeItems')='array' and jsonb_array_length(payload->'safeItems')<=120
   and jsonb_typeof(payload->'categories')='array' and jsonb_array_length(payload->'categories')<=2000),
 updated_at timestamptz not null default now(),expires_at timestamptz not null default now()+interval '1 day',
 primary key(provider_key,scope_hash,media_type)
);
alter table public.catalog_preview_cache enable row level security;
revoke all on public.catalog_preview_cache from public,anon,authenticated;
grant select on public.catalog_preview_cache to authenticated;
grant all on public.catalog_preview_cache to service_role;
create policy arkhen_catalog_preview_read on public.catalog_preview_cache for select to authenticated using(public.arkhen_partition_allows(provider_key,scope_hash));
create index arkhen_staging_first_pages on arkhen_private.cloud_catalog_staging(job_id,media_type,position);

create function arkhen_private.store_catalog_preview(p_job_id uuid,p_worker text,p_media_type text,p_payload jsonb,p_sampled_pages integer)
returns void language plpgsql security invoker set search_path='' as $$
declare job arkhen_private.cache_jobs; result jsonb; categories jsonb; all_items jsonb; safe_items jsonb; merged_items jsonb;
begin
 select * into job from arkhen_private.cache_jobs where id=p_job_id;
 perform arkhen_private.assert_cache_lease(p_job_id,p_worker,job.provider_key,job.scope_hash,'catalog');
 if p_media_type is null or p_media_type not in('live','movies','series') or p_sampled_pages is null or p_sampled_pages not between 0 and 12
   or jsonb_typeof(p_payload->'items') is distinct from 'array' or jsonb_typeof(p_payload->'categories') is distinct from 'array'
   or arkhen_private.safe_shared_payload(p_payload) is distinct from true then raise exception 'Invalid catalog preview';end if;
 if exists(select 1 from jsonb_array_elements(p_payload->'items') m where coalesce(m->>'id','')!~'^[A-Za-z0-9_-]{1,160}$' or coalesce(m->>'name','')='' or m->>'kind' is distinct from case when p_media_type='movies' then 'movie' else p_media_type end) then raise exception 'Invalid preview media';end if;
 if exists(select 1 from jsonb_array_elements(p_payload->'categories') c where coalesce(c->>'id','')!~'^[A-Za-z0-9_-]{1,160}$' or coalesce(c->>'name','')='') then raise exception 'Invalid preview category';end if;
 if exists(select 1 from public.catalog_preview_cache where provider_key=job.provider_key and scope_hash=job.scope_hash and media_type=p_media_type and job_id=p_job_id and sampled_pages>=12) then return;end if;
 with expanded as(select value,ordinality,bool_or(arkhen_private.catalog_adult_marker(value->>'name',true) or coalesce(value->>'isAdult','false')='true' or coalesce(value->>'adult','false')='true' or coalesce(value->>'is_adult','false')='true') over(partition by value->>'id') as is_adult from jsonb_array_elements(p_payload->'categories') with ordinality),
 chosen as(select distinct on(value->>'id') value,ordinality,is_adult from expanded order by value->>'id',ordinality desc)
 select coalesce(jsonb_agg(jsonb_build_object('id',value->>'id','name',value->>'name','isAdult',is_adult) order by ordinality),'[]') into categories from chosen;
 with expanded as(select value,ordinality,value->>'id' as id from jsonb_array_elements(p_payload->'items') with ordinality),
 chosen as(select distinct on(id) id,value from expanded order by id,ordinality desc),
 ordering as(select id,min(ordinality) as n,bool_or(arkhen_private.catalog_item_adult(value)) as explicit_adult from expanded group by id),
 memberships as(select id,array_agg(distinct category_id order by category_id) as ids from expanded cross join lateral (
  select jsonb_array_elements_text(case when jsonb_typeof(value->'categoryIds')='array' then value->'categoryIds' else '[]' end) as category_id union select value->>'categoryId' where value->>'categoryId' is not null
 ) c where category_id is not null group by id),
 classified as(select chosen.value||jsonb_build_object('categoryIds',coalesce(to_jsonb(memberships.ids),'[]'::jsonb),'isAdult',ordering.explicit_adult or exists(select 1 from jsonb_array_elements(categories) c where c->>'isAdult'='true' and(c->>'id'=chosen.value->>'categoryId' or c->>'id'=any(memberships.ids)))) as value,ordering.n
  from chosen join ordering using(id) left join memberships using(id)),
 selected as(select value,n from classified order by n limit 120),safe as(select value,n from classified where value->>'isAdult'<>'true' order by n limit 120)
 select coalesce((select jsonb_agg(value order by n) from selected),'[]'),coalesce((select jsonb_agg(value order by n) from safe),'[]') into all_items,safe_items;
 result:=jsonb_build_object('categories',categories,'items',all_items,'safeItems',safe_items);
 insert into public.catalog_preview_cache(provider_key,scope_hash,media_type,job_id,sampled_pages,payload)
 values(job.provider_key,job.scope_hash,p_media_type,p_job_id,p_sampled_pages,result)
 on conflict(provider_key,scope_hash,media_type) do update set job_id=excluded.job_id,sampled_pages=excluded.sampled_pages,payload=excluded.payload,updated_at=now(),expires_at=now()+interval '1 day';
 -- Existing Node image/playback guards use these indexed metadata tables. Only
 -- cold types get the bounded preview rows; a complete snapshot is untouched.
 if not exists(select 1 from public.provider_catalog_cache where provider_key=job.provider_key and scope_hash=job.scope_hash and media_type=p_media_type and is_complete) then
  select coalesce(jsonb_agg(value),'[]') into merged_items from(select distinct on(value->>'id') value from jsonb_array_elements(all_items||safe_items)) chosen;
  insert into public.catalog_media as current(provider_key,scope_hash,media_type,media_id,name,category_ids,metadata,last_seen_snapshot,sort_order,is_adult)
  select job.provider_key,job.scope_hash,p_media_type,value->>'id',value->>'name',array(select jsonb_array_elements_text(value->'categoryIds')),value,p_job_id,ordinality,(value->>'isAdult')::boolean from jsonb_array_elements(merged_items) with ordinality
  on conflict(provider_key,scope_hash,media_type,media_id) do update set name=excluded.name,category_ids=excluded.category_ids,metadata=excluded.metadata,last_seen_snapshot=excluded.last_seen_snapshot,sort_order=excluded.sort_order,is_adult=excluded.is_adult,is_active=true,updated_at=now();
  update public.catalog_media m set is_active=false where m.provider_key=job.provider_key and m.scope_hash=job.scope_hash and m.media_type=p_media_type and m.is_active and not exists(select 1 from jsonb_array_elements(merged_items) i where i->>'id'=m.media_id);
  delete from public.catalog_artwork_refs r where r.provider_key=job.provider_key and r.scope_hash=job.scope_hash and r.media_type=p_media_type;
  insert into public.catalog_artwork_refs(provider_key,scope_hash,ref,media_type,media_id,field)
   select job.provider_key,job.scope_hash,substring(f.value from '/api/shared-image/([a-f0-9]{64})$'),p_media_type,i.value->>'id',f.key from jsonb_array_elements(merged_items) i cross join lateral jsonb_each_text(i.value) f where f.key in('poster','backdrop','posterOriginal') and f.value~'^/api/shared-image/[a-f0-9]{64}$' on conflict do nothing;
 end if;
end $$;
revoke all on function arkhen_private.store_catalog_preview(uuid,text,text,jsonb,integer) from public,anon,authenticated;
grant execute on function arkhen_private.store_catalog_preview(uuid,text,text,jsonb,integer) to service_role;

create function public.arkhen_catalog_preview_seed(p_job_id uuid,p_worker text,p_media_type text,p_payload jsonb)
returns void language plpgsql security invoker set search_path='' as $$
declare job arkhen_private.cache_jobs;
begin
 select * into job from arkhen_private.cache_jobs where id=p_job_id;
 perform arkhen_private.assert_cache_lease(p_job_id,p_worker,job.provider_key,job.scope_hash,'catalog');
 if jsonb_typeof(p_payload->'items') is distinct from 'array' or jsonb_array_length(p_payload->'items')>120 or octet_length(p_payload::text)>4194304 then raise exception 'Invalid preview seed';end if;
 -- A retried first-page probe cannot replace the preview assembled from staging.
 if exists(select 1 from public.catalog_preview_cache where job_id=p_job_id and media_type=p_media_type and sampled_pages>0) then return;end if;
 perform arkhen_private.store_catalog_preview(p_job_id,p_worker,p_media_type,p_payload,0);
end $$;
revoke all on function public.arkhen_catalog_preview_seed(uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.arkhen_catalog_preview_seed(uuid,text,text,jsonb) to service_role;

create function arkhen_private.preview_from_staging(p_job_id uuid,p_worker text,p_media_type text)
returns void language plpgsql security invoker set search_path='' as $$
declare data jsonb; sampled integer;
begin
 if exists(select 1 from public.catalog_preview_cache where job_id=p_job_id and media_type=p_media_type and sampled_pages>=12) then return;end if;
 with pages as materialized(select payload,position from arkhen_private.cloud_catalog_staging where job_id=p_job_id and media_type=p_media_type order by position limit 12)
 select jsonb_build_object('categories',coalesce((select jsonb_agg(c.value order by position,c.ordinality) from pages cross join lateral jsonb_array_elements(payload->'categories') with ordinality c),'[]'),
  'items',coalesce((select jsonb_agg(i.value order by position,i.ordinality) from pages cross join lateral jsonb_array_elements(payload->'items') with ordinality i),'[]')),
  (select count(*) from pages) into data,sampled;
 if sampled>0 then perform arkhen_private.store_catalog_preview(p_job_id,p_worker,p_media_type,data,sampled);end if;
end $$;
revoke all on function arkhen_private.preview_from_staging(uuid,text,text) from public,anon,authenticated;
grant execute on function arkhen_private.preview_from_staging(uuid,text,text) to service_role;
alter function public.arkhen_cloud_catalog_checkpoint(uuid,text,text,text,jsonb,jsonb) set schema arkhen_private;
alter function arkhen_private.arkhen_cloud_catalog_checkpoint(uuid,text,text,text,jsonb,jsonb) rename to catalog_checkpoint_base;
create function public.arkhen_cloud_catalog_checkpoint(p_job_id uuid,p_worker text,p_media_type text,p_step_key text,p_payload jsonb,p_progress jsonb)
returns void language plpgsql security invoker set search_path='' as $$
begin
 perform arkhen_private.catalog_checkpoint_base(p_job_id,p_worker,p_media_type,p_step_key,p_payload,p_progress);
 if p_payload is not null then perform arkhen_private.preview_from_staging(p_job_id,p_worker,p_media_type);end if;
end $$;
revoke all on function public.arkhen_cloud_catalog_checkpoint(uuid,text,text,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.arkhen_cloud_catalog_checkpoint(uuid,text,text,text,jsonb,jsonb) to service_role;

create function public.arkhen_catalog_preview_page(p_provider_key text,p_scope_hash text,p_media_type text,p_category text,p_limit integer,p_snapshot uuid,p_include_adult boolean)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare preview public.catalog_preview_cache; items jsonb;categories jsonb;states jsonb;total integer;
begin
 if p_media_type is null or p_media_type not in('live','movies','series') or p_limit is null or p_limit not between 1 and 240 or p_include_adult is null or p_category is not null and p_category!~'^[A-Za-z0-9_-]{1,160}$' then raise exception 'Invalid preview page' using errcode='22023';end if;
 select * into preview from public.catalog_preview_cache where provider_key=p_provider_key and scope_hash=p_scope_hash and media_type=p_media_type and expires_at>now();
 if not found then return null;end if;
 select coalesce(jsonb_agg(value),'[]') into items from(select value from jsonb_array_elements(case when p_include_adult then preview.payload->'items' else preview.payload->'safeItems' end) where p_category is null or value->'categoryIds' ? p_category limit least(p_limit,120)) s;
 select coalesce(jsonb_agg(value),'[]') into categories from jsonb_array_elements(preview.payload->'categories') where p_include_adult or value->>'isAdult'<>'true';
 total:=jsonb_array_length(items);
 select coalesce(jsonb_object_agg(value->>'id',jsonb_build_object('loaded',true,'nextPage',1,'nextCursor',-1,'hasMore',false)),'{}') into states from jsonb_array_elements(categories);
 states:=states||jsonb_build_object('__all',jsonb_build_object('loaded',true,'nextPage',1,'nextCursor',-1,'hasMore',false));
 return jsonb_build_object('categories',categories,'items',items,'preparing',true,'catalogComplete',false,
  'pagination',jsonb_build_object('mode','category','source','supabase','snapshotId',preview.job_id,'snapshotChanged',p_snapshot is not null and p_snapshot<>preview.job_id,'revisionAt',preview.updated_at,'globalCategory','__all','pageSize',least(p_limit,120),'total',total,'complete',false,'preparing',true,'expiresAt',preview.expires_at,'byCategory',states));
end $$;
revoke all on function public.arkhen_catalog_preview_page(text,text,text,text,integer,uuid,boolean) from public,anon;
grant execute on function public.arkhen_catalog_preview_page(text,text,text,text,integer,uuid,boolean) to authenticated;
-- Keep the current complete reader (and its indexed pagination) byte-for-byte;
-- only its cold-cache return delegates to the small RLS preview table.
do $reader$
declare definition text;needle constant text='if current_snapshot is null then return null;end if;';
begin
 definition:=pg_get_functiondef('public.arkhen_catalog_page(text,text,text,text,integer,bigint,integer,uuid,boolean)'::regprocedure);
 if position(needle in definition)=0 then raise exception 'Catalog reader version mismatch';end if;
 execute replace(definition,needle,'if current_snapshot is null then return public.arkhen_catalog_preview_page(p_provider_key,p_scope_hash,p_media_type,p_category,p_limit,p_snapshot,p_include_adult);end if;');
end $reader$;
-- Existing ongoing jobs get one bounded preview immediately, not a full rescan.
do $backfill$ declare job record;kind record;begin
 for job in select id,locked_by from arkhen_private.cache_jobs where job_type='catalog' and status='leased' and lease_until>now()+interval '15 seconds' for update skip locked loop
  for kind in select distinct media_type from arkhen_private.cloud_catalog_staging where job_id=job.id loop
   perform arkhen_private.preview_from_staging(job.id,job.locked_by,kind.media_type);
  end loop;
 end loop;
end $backfill$;
notify pgrst,'reload schema';
commit;
