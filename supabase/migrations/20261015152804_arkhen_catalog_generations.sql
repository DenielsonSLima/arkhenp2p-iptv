-- Measured bulk media INSERT ranged17–50s. Copy at most256 indexed titles per
-- call into an unreadable generation; a tiny registry/header swap publishes it.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
lock table arkhen_private.cache_jobs in share row exclusive mode;
do $$begin
 if exists(select 1 from arkhen_private.cache_jobs where job_type='catalog' and status='leased' and lease_until>now()) then raise exception 'Wait for catalog leases before generation cutover' using errcode='55000';end if;
end$$;
alter table public.provider_catalog_cache add column index_generation uuid not null default '00000000-0000-0000-0000-000000000000';
alter table public.catalog_media add column generation_id uuid not null default '00000000-0000-0000-0000-000000000000';
alter table public.catalog_categories add column generation_id uuid not null default '00000000-0000-0000-0000-000000000000';
alter table public.catalog_artwork_refs add column generation_id uuid not null default '00000000-0000-0000-0000-000000000000';
alter table public.catalog_media add column generation_created_at timestamptz not null default now();
alter table public.catalog_categories add column generation_created_at timestamptz not null default now();
alter table public.catalog_artwork_refs add column generation_created_at timestamptz not null default now();
alter table public.catalog_media drop constraint catalog_media_pkey,add primary key(provider_key,scope_hash,media_type,generation_id,media_id);
alter table public.catalog_categories drop constraint catalog_categories_pkey,add primary key(provider_key,scope_hash,media_type,generation_id,category_id);
alter table public.catalog_artwork_refs drop constraint catalog_artwork_refs_pkey,add primary key(provider_key,scope_hash,ref,media_type,media_id,field,generation_id);
create index arkhen_catalog_generation_order on public.catalog_media(provider_key,scope_hash,media_type,generation_id,sort_order,media_id) where is_active;
create index arkhen_artwork_generation on public.catalog_artwork_refs(provider_key,scope_hash,media_type,generation_id);
create index arkhen_media_generation_age on public.catalog_media(generation_created_at);
create index arkhen_category_generation_age on public.catalog_categories(generation_created_at);
create index arkhen_artwork_generation_age on public.catalog_artwork_refs(generation_created_at);
create table public.catalog_visible_generations(
 provider_key text not null,scope_hash text not null,media_type text not null check(media_type in('live','movies','series')),
 generation_id uuid not null,snapshot_id uuid,updated_at timestamptz not null default now(),primary key(provider_key,scope_hash,media_type)
);
alter table public.catalog_visible_generations enable row level security;
revoke all on public.catalog_visible_generations from public,anon,authenticated;
grant select on public.catalog_visible_generations to authenticated;
grant all on public.catalog_visible_generations to service_role;
create policy arkhen_generation_partition_read on public.catalog_visible_generations for select to authenticated using(public.arkhen_partition_allows(provider_key,scope_hash));
insert into public.catalog_visible_generations(provider_key,scope_hash,media_type,generation_id,snapshot_id)
select provider_key,scope_hash,media_type,'00000000-0000-0000-0000-000000000000'::uuid,null::uuid from public.catalog_media group by provider_key,scope_hash,media_type;
insert into public.catalog_visible_generations(provider_key,scope_hash,media_type,generation_id,snapshot_id)
select provider_key,scope_hash,media_type,index_generation,snapshot_id from public.provider_catalog_cache
on conflict(provider_key,scope_hash,media_type) do update set generation_id=excluded.generation_id,snapshot_id=excluded.snapshot_id;
-- One hashed set of at most the authorized partition's three rows per query.
drop policy arkhen_partition_read on public.catalog_media;
create policy arkhen_partition_read on public.catalog_media for select to authenticated using((provider_key,scope_hash,media_type,generation_id) in(select provider_key,scope_hash,media_type,generation_id from public.catalog_visible_generations));
drop policy arkhen_partition_read on public.catalog_categories;
create policy arkhen_partition_read on public.catalog_categories for select to authenticated using((provider_key,scope_hash,media_type,generation_id) in(select provider_key,scope_hash,media_type,generation_id from public.catalog_visible_generations));
drop policy arkhen_artwork_partition_read on public.catalog_artwork_refs;
create policy arkhen_artwork_partition_read on public.catalog_artwork_refs for select to authenticated using((provider_key,scope_hash,media_type,generation_id) in(select provider_key,scope_hash,media_type,generation_id from public.catalog_visible_generations));
create function arkhen_private.publish_catalog_generation()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if new.is_complete then
  insert into public.catalog_visible_generations(provider_key,scope_hash,media_type,generation_id,snapshot_id,updated_at)
  values(new.provider_key,new.scope_hash,new.media_type,new.index_generation,new.snapshot_id,new.updated_at)
  on conflict(provider_key,scope_hash,media_type) do update set generation_id=excluded.generation_id,snapshot_id=excluded.snapshot_id,updated_at=excluded.updated_at;
 end if;
 return new;
end$$;
revoke all on function arkhen_private.publish_catalog_generation() from public,anon,authenticated;
grant execute on function arkhen_private.publish_catalog_generation() to service_role;
create trigger arkhen_catalog_generation_commit after insert or update of snapshot_id,index_generation,is_complete on public.provider_catalog_cache for each row execute function arkhen_private.publish_catalog_generation();
alter table arkhen_private.catalog_prepared_snapshots add column generation_id uuid not null default gen_random_uuid();
create table arkhen_private.catalog_generation_copies(
 job_id uuid not null,media_type text not null,generation_id uuid not null,
 cursor_id text not null default '',indexed_items bigint not null default 0 check(indexed_items>=0),complete boolean not null default false,
 created_at timestamptz not null default now(),primary key(job_id,media_type),
 foreign key(job_id,media_type) references arkhen_private.catalog_prepared_snapshots(job_id,media_type) on delete cascade
);
alter table arkhen_private.catalog_generation_copies enable row level security;
revoke all on arkhen_private.catalog_generation_copies from public,anon,authenticated;
grant all on arkhen_private.catalog_generation_copies to service_role;

-- Preserve every legacy writer: default generation0 remains readable until a
-- complete new header commits. Do not overwrite or delete a hidden candidate.
do $legacy$
declare signature text;original text;body text;definition text;
begin
 foreach signature in array array['public.arkhen_publish_catalog(text,text,text,jsonb,boolean,uuid,timestamptz,uuid,text)','arkhen_private.store_catalog_preview(uuid,text,text,jsonb,integer)'] loop
  select prosrc into original from pg_proc where oid=signature::regprocedure;
  body:=replace(original,'on conflict(provider_key,scope_hash,media_type,media_id)','on conflict(provider_key,scope_hash,media_type,media_id,generation_id)');
  body:=replace(body,'on conflict(provider_key,scope_hash,media_type,category_id)','on conflict(provider_key,scope_hash,media_type,category_id,generation_id)');
  if signature like 'public.%' then
   body:=replace(body,'where c.provider_key=p_provider_key','where c.generation_id=''00000000-0000-0000-0000-000000000000'' and c.provider_key=p_provider_key');
   body:=replace(body,'where m.provider_key=p_provider_key','where m.generation_id=''00000000-0000-0000-0000-000000000000'' and m.provider_key=p_provider_key');
   body:=replace(body,'where media.provider_key=p_provider_key','where media.generation_id=''00000000-0000-0000-0000-000000000000'' and media.provider_key=p_provider_key');
   body:=replace(body,'where category.provider_key=p_provider_key','where category.generation_id=''00000000-0000-0000-0000-000000000000'' and category.provider_key=p_provider_key');
   body:=replace(body,'where reference.provider_key=p_provider_key','where reference.generation_id=''00000000-0000-0000-0000-000000000000'' and reference.provider_key=p_provider_key');
   body:=replace(body,'where provider_key=p_provider_key and scope_hash=p_scope_hash and media_type=p_media_type and is_active','where generation_id=''00000000-0000-0000-0000-000000000000'' and provider_key=p_provider_key and scope_hash=p_scope_hash and media_type=p_media_type and is_active');
   body:=regexp_replace(body,'\mset[[:space:]]+payload=excluded.payload','set index_generation=''00000000-0000-0000-0000-000000000000'',payload=excluded.payload');
   if position('index_generation=' in body)=0 then raise exception 'Legacy header generation marker missing';end if;
  else
   body:=replace(body,'where m.provider_key=job.provider_key','where m.generation_id=''00000000-0000-0000-0000-000000000000'' and m.provider_key=job.provider_key');
   body:=replace(body,'where r.provider_key=job.provider_key','where r.generation_id=''00000000-0000-0000-0000-000000000000'' and r.provider_key=job.provider_key');
   body:=replace(body,' if not exists(select 1 from public.provider_catalog_cache',$init$ insert into public.catalog_visible_generations(provider_key,scope_hash,media_type,generation_id) values(job.provider_key,job.scope_hash,p_media_type,'00000000-0000-0000-0000-000000000000') on conflict do nothing;
 if not exists(select 1 from public.provider_catalog_cache$init$);
  end if;
  if body=original then raise exception 'Legacy generation writer version mismatch';end if;
  definition:=pg_get_functiondef(signature::regprocedure);execute replace(definition,original,body);
 end loop;
end $legacy$;

-- Reuse bounded normalization/preparation and its tested lease/revision fences.
-- Replace only the former unbounded public INSERT/finalization tail.
do $copies$
declare original text;body text;definition text;start_at integer;end_at integer;
begin
 select prosrc into original from pg_proc where oid='public.arkhen_cloud_catalog_publish(uuid,text,text)'::regprocedure;
 body:=replace(original,E'\r\n',E'\n');
 start_at:=position(' catalog:=prepared.payload;total:=prepared.item_count;safe_total:=prepared.safe_item_count;' in body);
 end_at:=position(E'\n exception when query_canceled then' in body);
 if start_at=0 or end_at<=start_at then raise exception 'Generation publication boundary missing';end if;
 body:=replace(body,'declare prepared arkhen_private.catalog_prepared_snapshots;','declare copy_state arkhen_private.catalog_generation_copies;picked_ids text[];picked_count integer;prepared arkhen_private.catalog_prepared_snapshots;');
 -- Declaration replacement shifts offsets; locate them again.
 start_at:=position(' catalog:=prepared.payload;total:=prepared.item_count;safe_total:=prepared.safe_item_count;' in body);
 end_at:=position(E'\n exception when query_canceled then' in body);
 body:=substring(body from 1 for start_at-1)||$tail$
 insert into arkhen_private.catalog_generation_copies(job_id,media_type,generation_id) values(p_job_id,p_media_type,prepared.generation_id) on conflict do nothing;
 select * into copy_state from arkhen_private.catalog_generation_copies where job_id=p_job_id and media_type=p_media_type for update;
 if copy_state.generation_id<>prepared.generation_id then raise exception 'Catalog generation copy revision mismatch';end if;
 if not copy_state.complete then
  phase:='categories';phase_started:=clock_timestamp();
  insert into public.catalog_categories(provider_key,scope_hash,media_type,category_id,name,last_seen_snapshot,sort_order,is_adult,generation_id)
  select job.provider_key,job.scope_hash,p_media_type,category_id,metadata->>'name',prepared.generation_id,row_number() over(order by last_position,last_ordinality,category_id),metadata->>'isAdult'='true',prepared.generation_id
  from arkhen_private.catalog_publish_categories where job_id=p_job_id and media_type=p_media_type on conflict(provider_key,scope_hash,media_type,category_id,generation_id) do nothing;
  select coalesce(array_agg(media_id order by media_id),'{}') into picked_ids from(select media_id from arkhen_private.catalog_publish_items where job_id=p_job_id and media_type=p_media_type and media_id>copy_state.cursor_id order by media_id limit 256)n;
  picked_count:=cardinality(picked_ids);
  if picked_count=0 and copy_state.indexed_items<>prepared.item_count then raise exception 'Catalog generation copy cursor mismatch';end if;
  phase_timings:=phase_timings||jsonb_build_object(phase,round(extract(epoch from(clock_timestamp()-phase_started))*1000));phase:='media';phase_started:=clock_timestamp();
  with ordering as materialized(select media_id,row_number() over(order by first_order,media_id) as sort_order from arkhen_private.catalog_publish_items where job_id=p_job_id and media_type=p_media_type)
  insert into public.catalog_media(provider_key,scope_hash,media_type,media_id,name,category_ids,metadata,last_seen_snapshot,sort_order,is_adult,generation_id)
  select job.provider_key,job.scope_hash,p_media_type,m.media_id,m.metadata->>'name',m.category_ids,m.metadata,prepared.generation_id,o.sort_order,m.is_adult,prepared.generation_id
  from arkhen_private.catalog_publish_items m join ordering o on o.media_id=m.media_id where m.job_id=p_job_id and m.media_type=p_media_type and m.media_id=any(picked_ids)
  on conflict(provider_key,scope_hash,media_type,media_id,generation_id) do nothing;
  phase_timings:=phase_timings||jsonb_build_object(phase,round(extract(epoch from(clock_timestamp()-phase_started))*1000));phase:='artwork_insert';phase_started:=clock_timestamp();
  insert into public.catalog_artwork_refs(provider_key,scope_hash,ref,media_type,media_id,field,generation_id)
  select job.provider_key,job.scope_hash,ref,p_media_type,media_id,field,prepared.generation_id from arkhen_private.catalog_publish_artwork where job_id=p_job_id and media_type=p_media_type and media_id=any(picked_ids) on conflict do nothing;
  update arkhen_private.catalog_generation_copies set cursor_id=coalesce(picked_ids[picked_count],copy_state.cursor_id),indexed_items=indexed_items+picked_count,complete=indexed_items+picked_count=prepared.item_count where job_id=p_job_id and media_type=p_media_type;
  state:=jsonb_set(state,'{publicationIndexedItems}',coalesce(state->'publicationIndexedItems','{}')||jsonb_build_object(p_media_type,copy_state.indexed_items+picked_count));
  update arkhen_private.cloud_job_progress set progress=state,updated_at=now() where job_id=p_job_id;
  return state;
 end if;
 if copy_state.indexed_items<>prepared.item_count
 or prepared.item_count<>(select count(*) from public.catalog_media where provider_key=job.provider_key and scope_hash=job.scope_hash and media_type=p_media_type and generation_id=prepared.generation_id)
 or prepared.category_count<>(select count(*) from public.catalog_categories where provider_key=job.provider_key and scope_hash=job.scope_hash and media_type=p_media_type and generation_id=prepared.generation_id)
 or prepared.artwork_count<>(select count(*) from public.catalog_artwork_refs where provider_key=job.provider_key and scope_hash=job.scope_hash and media_type=p_media_type and generation_id=prepared.generation_id) then raise exception 'Catalog generation index count mismatch';end if;
 phase:='snapshot';phase_started:=clock_timestamp();
 insert into public.provider_catalog_cache(provider_key,scope_hash,media_type,payload,expires_at,snapshot_id,is_complete,item_count,safe_item_count,index_generation)
 values(job.provider_key,job.scope_hash,p_media_type,prepared.payload,now()+interval '1 day',prepared.generation_id,true,prepared.item_count,prepared.safe_item_count,prepared.generation_id)
 on conflict(provider_key,scope_hash,media_type) do update set payload=excluded.payload,expires_at=excluded.expires_at,snapshot_id=excluded.snapshot_id,is_complete=true,item_count=excluded.item_count,safe_item_count=excluded.safe_item_count,index_generation=excluded.index_generation,updated_at=now();
 state:=(state-'typeReady')||jsonb_build_object('publishedTypes',coalesce(state->'publishedTypes','[]'::jsonb)||jsonb_build_array(p_media_type));
 update arkhen_private.cloud_job_progress set progress=state,updated_at=now() where job_id=p_job_id;
 phase_timings:=phase_timings||jsonb_build_object(phase,round(extract(epoch from(clock_timestamp()-phase_started))*1000));phase:='cleanup_private';phase_started:=clock_timestamp();
 delete from arkhen_private.cloud_catalog_staging where job_id=p_job_id and media_type=p_media_type;
 delete from arkhen_private.catalog_publish_artwork where job_id=p_job_id and media_type=p_media_type;
 delete from arkhen_private.catalog_publish_items where job_id=p_job_id and media_type=p_media_type;
 delete from arkhen_private.catalog_publish_categories where job_id=p_job_id and media_type=p_media_type;
 delete from arkhen_private.catalog_prepared_snapshots where job_id=p_job_id and media_type=p_media_type;
 return state;
$tail$||substring(body from end_at);
 definition:=pg_get_functiondef('public.arkhen_cloud_catalog_publish(uuid,text,text)'::regprocedure);execute replace(definition,original,body);
end $copies$;
-- Service-role discovery bypasses RLS, so explicitly join the visible registry.
do $marker$
declare original text;body text;definition text;
begin
 if to_regprocedure('public.arkhen_marker_discover(integer)') is not null then
  select prosrc into original from pg_proc where oid='public.arkhen_marker_discover(integer)'::regprocedure;
  if position('from public.catalog_media m left join' in original)=0 then raise exception 'Marker catalog reader version mismatch';end if;
  body:=replace(original,'from public.catalog_media m left join','from public.catalog_media m join public.catalog_visible_generations g on g.provider_key=m.provider_key and g.scope_hash=m.scope_hash and g.media_type=m.media_type and g.generation_id=m.generation_id left join');
  definition:=pg_get_functiondef('public.arkhen_marker_discover(integer)'::regprocedure);execute replace(definition,original,body);
 end if;
end $marker$;
-- Explicit generation in the typed reader also protects service-role callers,
-- which bypass table RLS. Preserve STABLE, SECURITY INVOKER and8s read bound.
do $reader$
declare original text;body text;definition text;
begin
 select prosrc into original from pg_proc where oid='public.arkhen_catalog_page(text,text,text,text,integer,bigint,integer,uuid,boolean)'::regprocedure;
 body:=replace(original,'declare current_snapshot uuid;','declare current_generation uuid;current_snapshot uuid;');
 body:=replace(body,'select snapshot_id,expires_at,updated_at,case','select index_generation,snapshot_id,expires_at,updated_at,case');
 body:=replace(body,'into current_snapshot,expiry,revision_at,total','into current_generation,current_snapshot,expiry,revision_at,total');
 body:=replace(body,'media_type=p_media_type and is_active','media_type=p_media_type and generation_id=current_generation and is_active');
 if position('generation_id=current_generation' in body)=0 then raise exception 'Catalog reader generation version mismatch';end if;
 definition:=pg_get_functiondef('public.arkhen_catalog_page(text,text,text,text,integer,bigint,integer,uuid,boolean)'::regprocedure);execute replace(definition,original,body);
end $reader$;
-- Retire only a bounded number of rows, never a current, prepared or leased
-- generation. No source/cache expiry is renewed by cleanup.
create function public.arkhen_cleanup_catalog_generations(p_limit integer default 500)
returns integer language plpgsql security invoker set search_path='' as $$
declare table_name text;removed integer;total integer:=0;remaining integer:=least(1000,greatest(1,coalesce(p_limit,500)));
begin
 foreach table_name in array array['catalog_artwork_refs','catalog_media','catalog_categories'] loop
  execute format($sql$
   with candidates as(select m.ctid from public.%I m where
    not exists(select 1 from public.catalog_visible_generations g where g.provider_key=m.provider_key and g.scope_hash=m.scope_hash and g.media_type=m.media_type and g.generation_id=m.generation_id)
    and not exists(select 1 from public.provider_catalog_cache c where c.provider_key=m.provider_key and c.scope_hash=m.scope_hash and c.media_type=m.media_type and c.index_generation=m.generation_id)
    and not exists(select 1 from arkhen_private.catalog_prepared_snapshots p where p.generation_id=m.generation_id)
    and not exists(select 1 from arkhen_private.catalog_generation_copies p join arkhen_private.cache_jobs j on j.id=p.job_id where p.generation_id=m.generation_id and(j.status in('queued','leased') or j.lease_until>now()))
    and not exists(select 1 from arkhen_private.cache_jobs j where j.provider_key=m.provider_key and j.scope_hash=m.scope_hash and j.job_type='catalog' and j.payload->>'media_type'=m.media_type and j.status='leased' and j.lease_until>now())
    and m.generation_created_at<now()-interval '1 day' limit $1 for update skip locked)
   delete from public.%I m using candidates where m.ctid=candidates.ctid
  $sql$,table_name,table_name) using remaining;
  get diagnostics removed=row_count;total:=total+removed;remaining:=remaining-removed;
  exit when remaining<=0;
 end loop;
 return total;
end$$;
revoke all on function public.arkhen_cleanup_catalog_generations(integer) from public,anon,authenticated;
grant execute on function public.arkhen_cleanup_catalog_generations(integer) to service_role;
do $cron$begin if to_regprocedure('cron.schedule(text,text,text)') is not null then perform cron.schedule('arkhen-catalog-generation-cleanup','* * * * *','select public.arkhen_cleanup_catalog_generations(500);');end if;end $cron$;
-- Realtime carries only the small, typed registry revision. The browser maps
-- that notification to its existing logical catalog-cache callback.
do $realtime$declare name text;begin
 if exists(select 1 from pg_publication where pubname='supabase_realtime') then
  foreach name in array array['provider_catalog_cache','catalog_media','catalog_categories','catalog_artwork_refs'] loop
   if exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename=name) then execute format('alter publication supabase_realtime drop table public.%I',name);end if;
  end loop;
  alter publication supabase_realtime add table public.catalog_visible_generations;
 end if;
end $realtime$;
notify pgrst,'reload schema';
commit;
