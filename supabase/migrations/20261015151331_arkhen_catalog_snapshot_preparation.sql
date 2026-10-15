-- Measured remote phase catalog_build cost15.8s before the atomic publication.
-- Persist that validated JSON privately in an earlier call. Public metadata,
-- complete snapshot and its revision still commit in one final transaction.
begin;
set local lock_timeout='5s';
create table arkhen_private.catalog_prepared_snapshots(
 job_id uuid not null references arkhen_private.cache_jobs(id) on delete cascade,
 media_type text not null check(media_type in('live','movies','series')),
 normalization_position bigint not null,staging_position bigint not null,
 payload jsonb not null check(arkhen_private.safe_shared_payload(payload)),
 item_count bigint not null check(item_count>=0),safe_item_count bigint not null check(safe_item_count between 0 and item_count),
 category_count bigint not null,artwork_count bigint not null,
 prepared_at timestamptz not null default now(),primary key(job_id,media_type)
);
alter table arkhen_private.catalog_prepared_snapshots enable row level security;
revoke all on arkhen_private.catalog_prepared_snapshots from public,anon,authenticated;
grant all on arkhen_private.catalog_prepared_snapshots to service_role;
do $prepare$
declare original text;body text;definition text;start_marker text;end_marker text;start_at integer;end_at integer;build text;
begin
 select prosrc into original from pg_proc where oid='public.arkhen_cloud_catalog_publish(uuid,text,text)'::regprocedure;
 body:=replace(original,E'\r\n',E'\n');
 if position('phase_timings' in body)=0 or position('catalog_prepared_snapshots' in body)>0 then raise exception 'Catalog preparation version mismatch';end if;
 body:=replace(body,'declare phase text:', 'declare prepared arkhen_private.catalog_prepared_snapshots;phase text:');
 start_marker:=' -- No partial index or raw snapshot is visible before this final transaction.';
 end_marker:=E' phase_timings:=phase_timings||jsonb_build_object(phase,round(extract(epoch from(clock_timestamp()-phase_started))*1000));phase:=''categories'';phase_started:=clock_timestamp();';
 start_at:=position(start_marker in body);end_at:=position(end_marker in body);
 if start_at=0 or end_at<=start_at then raise exception 'Catalog preparation boundary missing';end if;
 build:=substring(body from start_at for end_at-start_at);
 body:=substring(body from 1 for start_at-1)||$replacement$
 if not exists(select 1 from arkhen_private.provider_sources where provider_key=job.provider_key and scope_hash=job.scope_hash and expires_at>now()) then raise exception 'Valid cloud source required for publication';end if;
 select * into prepared from arkhen_private.catalog_prepared_snapshots where job_id=p_job_id and media_type=p_media_type;
 if not found then
 $replacement$||build||$replacement$
  insert into arkhen_private.catalog_prepared_snapshots(job_id,media_type,normalization_position,staging_position,payload,item_count,safe_item_count,category_count,artwork_count)
  values(p_job_id,p_media_type,after_position,coalesce((select max(position) from arkhen_private.cloud_catalog_staging where job_id=p_job_id and media_type=p_media_type),0),catalog,total,safe_total,
   (select count(*) from arkhen_private.catalog_publish_categories where job_id=p_job_id and media_type=p_media_type),(select count(*) from arkhen_private.catalog_publish_artwork where job_id=p_job_id and media_type=p_media_type));
  state:=state||jsonb_build_object('publicationPreparedTypes',coalesce(state->'publicationPreparedTypes','[]'::jsonb)||jsonb_build_array(p_media_type));
  update arkhen_private.cloud_job_progress set progress=state,updated_at=now() where job_id=p_job_id;
  return state;
 end if;
 if prepared.normalization_position<>after_position or prepared.staging_position is distinct from(select coalesce(max(position),0) from arkhen_private.cloud_catalog_staging where job_id=p_job_id and media_type=p_media_type)
 or prepared.item_count<>(select count(*) from arkhen_private.catalog_publish_items where job_id=p_job_id and media_type=p_media_type)
 or prepared.category_count<>(select count(*) from arkhen_private.catalog_publish_categories where job_id=p_job_id and media_type=p_media_type)
 or prepared.artwork_count<>(select count(*) from arkhen_private.catalog_publish_artwork where job_id=p_job_id and media_type=p_media_type) then raise exception 'Prepared catalog normalization revision mismatch';end if;
 catalog:=prepared.payload;total:=prepared.item_count;safe_total:=prepared.safe_item_count;
 $replacement$||substring(body from end_at);
 body:=replace(body,E' delete from arkhen_private.cloud_catalog_staging where',E' delete from arkhen_private.catalog_prepared_snapshots where job_id=p_job_id and media_type=p_media_type;\n delete from arkhen_private.cloud_catalog_staging where');
 definition:=pg_get_functiondef('public.arkhen_cloud_catalog_publish(uuid,text,text)'::regprocedure);
 execute replace(definition,original,body);
end $prepare$;
-- Once a validated complete candidate has been prepared, a provider page cannot
-- mutate that generation behind its normalization/publication cursor.
do $fence$
declare original text;definition text;body text;
begin
 select prosrc into original from pg_proc where oid='public.arkhen_cloud_catalog_checkpoint(uuid,text,text,text,jsonb,jsonb)'::regprocedure;
 if position('catalog_prepared_snapshots' in original)>0 then raise exception 'Catalog checkpoint preparation version mismatch';end if;
 if position(' perform arkhen_private.catalog_checkpoint_base(' in original)=0 then raise exception 'Catalog checkpoint lease boundary missing';end if;
 body:=regexp_replace(original,'\mbegin\M',E'declare checked_job arkhen_private.cache_jobs;\nbegin');
 body:=replace(body,' perform arkhen_private.catalog_checkpoint_base(',$guard$
 if p_payload is not null then
  select * into checked_job from arkhen_private.cache_jobs where id=p_job_id;
  perform arkhen_private.assert_cache_lease(p_job_id,p_worker,checked_job.provider_key,checked_job.scope_hash,'catalog');
  if exists(select 1 from arkhen_private.catalog_prepared_snapshots where job_id=p_job_id and media_type=p_media_type) then raise exception 'Catalog publication already prepared';end if;
 end if;
 perform arkhen_private.catalog_checkpoint_base($guard$);
 definition:=pg_get_functiondef('public.arkhen_cloud_catalog_checkpoint(uuid,text,text,text,jsonb,jsonb)'::regprocedure);
 execute replace(definition,original,body);
end $fence$;
notify pgrst,'reload schema';
commit;
