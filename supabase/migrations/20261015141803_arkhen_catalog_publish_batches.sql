-- Finish large imports without sorting/reclassifying every provider occurrence
-- in one RPC. Batches remain private; the visible complete snapshot swaps once.
begin;
set local lock_timeout='5s';
set local statement_timeout='90s';
create table arkhen_private.catalog_publish_categories(
 job_id uuid not null references arkhen_private.cache_jobs(id) on delete cascade,media_type text not null,
 category_id text not null,metadata jsonb not null check(arkhen_private.safe_shared_payload(metadata)),
 last_position bigint not null,last_ordinality bigint not null,primary key(job_id,media_type,category_id)
);
create table arkhen_private.catalog_publish_items(
 job_id uuid not null references arkhen_private.cache_jobs(id) on delete cascade,media_type text not null,
 media_id text not null,metadata jsonb not null check(arkhen_private.safe_shared_payload(metadata)),
 category_ids text[] not null,first_order bigint not null,is_adult boolean not null,primary key(job_id,media_type,media_id)
);
create table arkhen_private.catalog_publish_artwork(
 job_id uuid not null references arkhen_private.cache_jobs(id) on delete cascade,media_type text not null,
 media_id text not null,field text not null check(field in('poster','backdrop','posterOriginal')),ref text not null check(ref~'^[a-f0-9]{64}$'),
 primary key(job_id,media_type,media_id,field,ref)
);
alter table arkhen_private.catalog_publish_categories enable row level security;
alter table arkhen_private.catalog_publish_items enable row level security;
alter table arkhen_private.catalog_publish_artwork enable row level security;
revoke all on arkhen_private.catalog_publish_categories,arkhen_private.catalog_publish_items,arkhen_private.catalog_publish_artwork from public,anon,authenticated;
grant all on arkhen_private.catalog_publish_categories,arkhen_private.catalog_publish_items,arkhen_private.catalog_publish_artwork to service_role;

create function arkhen_private.catalog_category_union(p_left text[],p_right text[])
returns text[] language sql immutable security invoker set search_path='' as $$select coalesce(array_agg(distinct id order by id),'{}'::text[]) from unnest(p_left||p_right)id where id is not null and id<>''$$;
revoke all on function arkhen_private.catalog_category_union(text[],text[]) from public,anon,authenticated;
grant execute on function arkhen_private.catalog_category_union(text[],text[]) to service_role;

create or replace function public.arkhen_cloud_catalog_publish(p_job_id uuid,p_worker text,p_media_type text)
returns jsonb language plpgsql security invoker set search_path='' set statement_timeout='55s' as $$
declare job arkhen_private.cache_jobs;state jsonb;pages jsonb;after_position bigint;batch_last bigint;categories jsonb;catalog jsonb;snapshot uuid:=gen_random_uuid();total bigint;safe_total bigint;
begin
 select * into job from arkhen_private.cache_jobs where id=p_job_id;
 perform arkhen_private.assert_cache_lease(p_job_id,p_worker,job.provider_key,job.scope_hash,'catalog');
 select progress into state from arkhen_private.cloud_job_progress where job_id=p_job_id for update;
 if coalesce(state->'publishedTypes','[]'::jsonb)?p_media_type then return state;end if;
 if p_media_type is null or p_media_type not in('live','movies','series') or state->>'typeReady' is distinct from p_media_type then raise exception 'Collector type is not complete';end if;
 after_position:=coalesce((state->'publicationCursors'->>p_media_type)::bigint,0);
 with candidates as materialized(select position,payload from arkhen_private.cloud_catalog_staging where job_id=p_job_id and media_type=p_media_type and position>after_position order by position limit 12),
 sized as(select *,sum(octet_length(payload::text)) over(order by position) as bytes from candidates)
 select jsonb_agg(jsonb_build_object('position',position,'payload',payload) order by position),max(position) into pages,batch_last from sized where bytes<=4194304;
 if pages is not null then
  if exists(select 1 from jsonb_array_elements(pages)p cross join lateral jsonb_array_elements(p->'payload'->'items')i where jsonb_typeof(i)<>'object' or coalesce(i->>'id','')='' or coalesce(i->>'name','')='') then raise exception 'Invalid normalized media';end if;
  if exists(select 1 from jsonb_array_elements(pages)p cross join lateral jsonb_array_elements(p->'payload'->'categories')c where jsonb_typeof(c)<>'object' or coalesce(c->>'id','')='' or coalesce(c->>'name','')='') then raise exception 'Invalid normalized category';end if;
  with expanded as(select c.value,(p->>'position')::bigint as position,c.ordinality from jsonb_array_elements(pages)p cross join lateral jsonb_array_elements(p->'payload'->'categories') with ordinality c),
  classified as(select *,bool_or(arkhen_private.catalog_adult_marker(value->>'name',true) or coalesce(value->>'isAdult','false')='true' or coalesce(value->>'adult','false')='true' or coalesce(value->>'is_adult','false')='true') over(partition by value->>'id') as is_adult from expanded),
  chosen as(select distinct on(value->>'id') value,position,ordinality,is_adult from classified order by value->>'id',position desc,ordinality desc)
  insert into arkhen_private.catalog_publish_categories as current(job_id,media_type,category_id,metadata,last_position,last_ordinality)
   select p_job_id,p_media_type,value->>'id',jsonb_build_object('id',value->>'id','name',value->>'name','isAdult',is_adult),position,ordinality from chosen
  on conflict(job_id,media_type,category_id) do update set metadata=excluded.metadata||jsonb_build_object('isAdult',current.metadata->>'isAdult'='true' or excluded.metadata->>'isAdult'='true'),last_position=excluded.last_position,last_ordinality=excluded.last_ordinality;
  with expanded as(select i.value,i.value->>'id' as id,(p->>'position')::bigint*1000000+i.ordinality as n from jsonb_array_elements(pages)p cross join lateral jsonb_array_elements(p->'payload'->'items') with ordinality i),
  chosen as(select distinct on(id) id,value from expanded order by id,n desc),
  ordering as(select id,min(n) as first_order,bool_or(arkhen_private.catalog_item_adult(value)) as explicit_adult from expanded group by id),
  memberships as(select id,array_agg(distinct category_id order by category_id) as ids from expanded cross join lateral(
   select jsonb_array_elements_text(case when jsonb_typeof(value->'categoryIds')='array' then value->'categoryIds' else '[]' end) as category_id union select value->>'categoryId' where value->>'categoryId' is not null
  )c where category_id is not null and category_id<>'' group by id),
  classified as(select chosen.id,chosen.value,ordering.first_order,coalesce(memberships.ids,'{}'::text[]) as ids,
   ordering.explicit_adult or exists(select 1 from arkhen_private.catalog_publish_categories c where c.job_id=p_job_id and c.media_type=p_media_type and c.metadata->>'isAdult'='true' and(c.category_id=chosen.value->>'categoryId' or c.category_id=any(memberships.ids))) as is_adult
   from chosen join ordering using(id) left join memberships using(id))
  insert into arkhen_private.catalog_publish_items as current(job_id,media_type,media_id,metadata,category_ids,first_order,is_adult)
   select p_job_id,p_media_type,id,value||jsonb_build_object('categoryIds',to_jsonb(ids),'isAdult',is_adult),ids,first_order,is_adult from classified
  on conflict(job_id,media_type,media_id) do update set category_ids=arkhen_private.catalog_category_union(current.category_ids,excluded.category_ids),
   metadata=excluded.metadata||jsonb_build_object('categoryIds',to_jsonb(arkhen_private.catalog_category_union(current.category_ids,excluded.category_ids)),'isAdult',current.is_adult or excluded.is_adult),
   first_order=least(current.first_order,excluded.first_order),is_adult=current.is_adult or excluded.is_adult;
  delete from arkhen_private.catalog_publish_artwork a where a.job_id=p_job_id and a.media_type=p_media_type and a.media_id in(select i->>'id' from jsonb_array_elements(pages)p cross join lateral jsonb_array_elements(p->'payload'->'items')i);
  insert into arkhen_private.catalog_publish_artwork(job_id,media_type,media_id,field,ref)
   select p_job_id,p_media_type,m.media_id,f.key,substring(f.value from '/api/shared-image/([a-f0-9]{64})$')
   from arkhen_private.catalog_publish_items m cross join lateral(values('poster',m.metadata->>'poster'),('backdrop',m.metadata->>'backdrop'),('posterOriginal',m.metadata->>'posterOriginal'))f(key,value)
   where m.job_id=p_job_id and m.media_type=p_media_type and m.media_id in(select i->>'id' from jsonb_array_elements(pages)p cross join lateral jsonb_array_elements(p->'payload'->'items')i) and f.value~'^/api/shared-image/[a-f0-9]{64}$' on conflict do nothing;
  state:=jsonb_set(state,'{publicationCursors}',coalesce(state->'publicationCursors','{}'::jsonb)||jsonb_build_object(p_media_type,batch_last));
  update arkhen_private.cloud_job_progress set progress=state,updated_at=now() where job_id=p_job_id;
  return state;
 end if;
 if exists(select 1 from arkhen_private.cloud_catalog_staging where job_id=p_job_id and media_type=p_media_type and position>after_position) then raise exception 'Publication page exceeds bounded batch limit';end if;
 -- No partial index or raw snapshot is visible before this final transaction.
 update arkhen_private.catalog_publish_items m set is_adult=true,metadata=metadata||jsonb_build_object('isAdult',true)
 where m.job_id=p_job_id and m.media_type=p_media_type and not m.is_adult and m.category_ids&&(select array_agg(category_id) from arkhen_private.catalog_publish_categories c where c.job_id=p_job_id and c.media_type=p_media_type and c.metadata->>'isAdult'='true');
 select coalesce(jsonb_agg(metadata order by last_position,last_ordinality,category_id),'[]') into categories from arkhen_private.catalog_publish_categories where job_id=p_job_id and media_type=p_media_type;
 select jsonb_build_object('categories',categories,'items',coalesce(jsonb_agg(metadata order by first_order,media_id),'[]')),count(*),count(*) filter(where not is_adult)
 into catalog,total,safe_total from arkhen_private.catalog_publish_items where job_id=p_job_id and media_type=p_media_type;
 if octet_length(catalog::text)>33554432 then raise exception 'Complete catalog exceeds metadata limit';end if;
 insert into public.catalog_categories as current(provider_key,scope_hash,media_type,category_id,name,last_seen_snapshot,sort_order,is_adult)
 select job.provider_key,job.scope_hash,p_media_type,category_id,metadata->>'name',snapshot,row_number() over(order by last_position,last_ordinality,category_id),metadata->>'isAdult'='true' from arkhen_private.catalog_publish_categories where job_id=p_job_id and media_type=p_media_type
 on conflict(provider_key,scope_hash,media_type,category_id) do update set name=excluded.name,sort_order=excluded.sort_order,is_adult=excluded.is_adult,is_active=true,last_seen_snapshot=excluded.last_seen_snapshot,updated_at=now()
 where(current.name,current.sort_order,current.is_adult,current.is_active) is distinct from(excluded.name,excluded.sort_order,excluded.is_adult,true);
 insert into public.catalog_media as current(provider_key,scope_hash,media_type,media_id,name,category_ids,metadata,last_seen_snapshot,sort_order,is_adult)
 select job.provider_key,job.scope_hash,p_media_type,media_id,metadata->>'name',category_ids,metadata,snapshot,row_number() over(order by first_order,media_id),is_adult from arkhen_private.catalog_publish_items where job_id=p_job_id and media_type=p_media_type
 on conflict(provider_key,scope_hash,media_type,media_id) do update set name=excluded.name,category_ids=excluded.category_ids,metadata=excluded.metadata,sort_order=excluded.sort_order,is_adult=excluded.is_adult,is_active=true,last_seen_snapshot=excluded.last_seen_snapshot,updated_at=now()
 where(current.name,current.category_ids,current.metadata,current.sort_order,current.is_adult,current.is_active) is distinct from(excluded.name,excluded.category_ids,excluded.metadata,excluded.sort_order,excluded.is_adult,true);
 update public.catalog_categories c set is_active=false,updated_at=now() where c.provider_key=job.provider_key and c.scope_hash=job.scope_hash and c.media_type=p_media_type and c.is_active and not exists(select 1 from arkhen_private.catalog_publish_categories n where n.job_id=p_job_id and n.media_type=p_media_type and n.category_id=c.category_id);
 update public.catalog_media m set is_active=false,updated_at=now() where m.provider_key=job.provider_key and m.scope_hash=job.scope_hash and m.media_type=p_media_type and m.is_active and not exists(select 1 from arkhen_private.catalog_publish_items n where n.job_id=p_job_id and n.media_type=p_media_type and n.media_id=m.media_id);
 insert into public.catalog_artwork_refs(provider_key,scope_hash,ref,media_type,media_id,field) select job.provider_key,job.scope_hash,ref,p_media_type,media_id,field from arkhen_private.catalog_publish_artwork where job_id=p_job_id and media_type=p_media_type on conflict do nothing;
 delete from public.catalog_artwork_refs a where a.provider_key=job.provider_key and a.scope_hash=job.scope_hash and a.media_type=p_media_type and not exists(select 1 from arkhen_private.catalog_publish_artwork n where n.job_id=p_job_id and n.media_type=p_media_type and n.media_id=a.media_id and n.field=a.field and n.ref=a.ref);
 insert into public.provider_catalog_cache(provider_key,scope_hash,media_type,payload,expires_at,snapshot_id,is_complete,item_count,safe_item_count)
 values(job.provider_key,job.scope_hash,p_media_type,catalog,now()+interval '1 day',snapshot,true,total,safe_total)
 on conflict(provider_key,scope_hash,media_type) do update set payload=excluded.payload,expires_at=excluded.expires_at,snapshot_id=excluded.snapshot_id,is_complete=true,item_count=excluded.item_count,safe_item_count=excluded.safe_item_count,updated_at=now();
 state:=(state-'typeReady')||jsonb_build_object('publishedTypes',coalesce(state->'publishedTypes','[]'::jsonb)||jsonb_build_array(p_media_type));
 update arkhen_private.cloud_job_progress set progress=state,updated_at=now() where job_id=p_job_id;
 delete from arkhen_private.cloud_catalog_staging where job_id=p_job_id and media_type=p_media_type;
 delete from arkhen_private.catalog_publish_artwork where job_id=p_job_id and media_type=p_media_type;
 delete from arkhen_private.catalog_publish_items where job_id=p_job_id and media_type=p_media_type;
 delete from arkhen_private.catalog_publish_categories where job_id=p_job_id and media_type=p_media_type;
 return state;
end $$;
revoke all on function public.arkhen_cloud_catalog_publish(uuid,text,text) from public,anon,authenticated;
grant execute on function public.arkhen_cloud_catalog_publish(uuid,text,text) to service_role;
notify pgrst,'reload schema';
commit;
