-- Independent task ownership for TV, movies and series. Existing complete
-- snapshots and personal libraries are untouched. Legacy in-flight work keeps
-- its original job id, positions, normalized rows and publication cursor.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
lock table arkhen_private.cache_jobs in share row exclusive mode;
do $cutover$
declare j record;kind text;
begin
 if exists(select 1 from arkhen_private.cache_jobs where job_type='catalog' and payload->>'media_type' is null and status='leased' and lease_until>now()) then raise exception 'Wait for legacy catalog lease before domain cutover' using errcode='55000';end if;
 for j in select q.id,q.payload,p.progress from arkhen_private.cache_jobs q left join arkhen_private.cloud_job_progress p on p.job_id=q.id
 where q.job_type='catalog' and q.payload->>'media_type' is null and(q.status in('queued','leased') or exists(select 1 from arkhen_private.cloud_catalog_staging s where s.job_id=q.id)) for update of q loop
  kind:=coalesce(case when j.progress->>'typeReady' in('live','movies','series') then j.progress->>'typeReady' end,case when j.progress->>'type' in('live','movies','series') then j.progress->>'type' end,(select media_type from arkhen_private.cloud_catalog_staging where job_id=j.id order by position limit 1),'movies');
  if exists(select 1 from arkhen_private.cloud_catalog_staging where job_id=j.id and media_type<>kind) then raise exception 'Legacy staged types require explicit routing';end if;
  update arkhen_private.cache_jobs set payload=payload||jsonb_build_object('media_type',kind) where id=j.id;
 end loop;
end $cutover$;
drop index arkhen_private.arkhen_one_active_cache_job;
create unique index arkhen_one_active_cache_job on arkhen_private.cache_jobs(provider_key,scope_hash,job_type,(case when job_type='catalog' then payload->>'media_type' else '' end)) where status in('queued','leased');
alter table arkhen_private.cache_jobs add constraint arkhen_active_catalog_type check(job_type<>'catalog' or status not in('queued','leased') or coalesce(payload->>'media_type' in('live','movies','series'),false));

create function arkhen_private.assert_catalog_type(p_job_id uuid,p_media_type text)
returns void language plpgsql security invoker set search_path='' as $$
begin
 if p_media_type is null or p_media_type not in('live','movies','series') or not exists(select 1 from arkhen_private.cache_jobs where id=p_job_id and job_type='catalog' and payload->>'media_type'=p_media_type) then raise exception 'Catalog task type mismatch' using errcode='22023';end if;
end $$;
revoke all on function arkhen_private.assert_catalog_type(uuid,text) from public,anon,authenticated;
grant execute on function arkhen_private.assert_catalog_type(uuid,text) to service_role;

-- Apply the task/type guard to every service-only route that writes catalog
-- metadata. Existing security modes, grants and bounded settings are retained.
do $guards$
declare signature text;definition text;body text;guard text;
begin
 foreach signature in array array['public.arkhen_cloud_catalog_checkpoint(uuid,text,text,text,jsonb,jsonb)','public.arkhen_cloud_catalog_publish(uuid,text,text)','public.arkhen_catalog_preview_seed(uuid,text,text,jsonb)','public.arkhen_publish_catalog(text,text,text,jsonb,boolean,uuid,timestamptz,uuid,text)'] loop
  select prosrc into body from pg_proc where oid=signature::regprocedure;
  guard:=case when signature like '%checkpoint%' then E'\n if p_payload is not null then perform arkhen_private.assert_catalog_type(p_job_id,p_media_type);end if;\n' else E'\n perform arkhen_private.assert_catalog_type(p_job_id,p_media_type);\n' end;
  if position('assert_catalog_type' in body)>0 then raise exception 'Catalog type guard version mismatch';end if;
  definition:=pg_get_functiondef(signature::regprocedure);
  execute replace(definition,body,regexp_replace(body,'\mbegin\M','begin'||guard));
 end loop;
end $guards$;

create or replace function arkhen_private.enqueue_due_cache_jobs(p_provider_key text default null,p_scope_hash text default null)
returns integer language plpgsql security invoker set search_path='' as $$
declare source record;kind text;media text;previous timestamptz;seconds integer;inserted integer;total integer:=0;
begin
 for source in select s.* from arkhen_private.cache_sources s where enabled and(p_provider_key is null or s.provider_key=p_provider_key) and(p_scope_hash is null or s.scope_hash=p_scope_hash)
 and exists(select 1 from public.profiles p where p.provider_key=s.provider_key and p.scope_hash=s.scope_hash and p.status='active' and(p.access_expires_at is null or p.access_expires_at>now()) and p.last_validated_at>now()-interval '24 hours') for update skip locked loop
  foreach media in array array['live','movies','series'] loop
   if not exists(select 1 from public.provider_catalog_cache c where c.provider_key=source.provider_key and c.scope_hash=source.scope_hash and c.media_type=media and c.is_complete and c.expires_at>now())
   and not exists(select 1 from arkhen_private.cache_jobs j where j.provider_key=source.provider_key and j.scope_hash=source.scope_hash and j.job_type='catalog' and j.payload->>'media_type'=media and j.created_at>now()-make_interval(secs=>source.catalog_interval_seconds)) then
    insert into arkhen_private.cache_jobs(provider_key,scope_hash,job_type,payload) values(source.provider_key,source.scope_hash,'catalog',jsonb_build_object('media_type',media)) on conflict do nothing;
    get diagnostics inserted=row_count;total:=total+inserted;
    if inserted>0 then update arkhen_private.cache_sources set last_catalog_enqueued_at=now() where provider_key=source.provider_key and scope_hash=source.scope_hash;end if;
   end if;
  end loop;
  foreach kind in array array['epg','games'] loop
   previous:=case kind when 'epg' then source.last_epg_enqueued_at else source.last_games_enqueued_at end;
   seconds:=case kind when 'epg' then source.epg_interval_seconds else source.games_interval_seconds end;
   if previous is null or previous<=now()-make_interval(secs=>seconds) then
    insert into arkhen_private.cache_jobs(provider_key,scope_hash,job_type) values(source.provider_key,source.scope_hash,kind) on conflict do nothing;
    get diagnostics inserted=row_count;total:=total+inserted;
    if inserted>0 then update arkhen_private.cache_sources set last_epg_enqueued_at=case when kind='epg' then now() else last_epg_enqueued_at end,last_games_enqueued_at=case when kind='games' then now() else last_games_enqueued_at end where provider_key=source.provider_key and scope_hash=source.scope_hash;end if;
   end if;
  end loop;
 end loop;
 return total;
end $$;

create or replace function public.arkhen_request_cache_refresh(p_provider_key text,p_scope_hash text,p_job_type text,p_payload jsonb default '{}')
returns integer language plpgsql security invoker set search_path='' as $$
declare media text;wanted text;inserted integer;total integer:=0;
begin
 if p_job_type is null or p_job_type not in('catalog','epg','games') or arkhen_private.safe_shared_payload(p_payload) is distinct from true then raise exception 'Invalid cache refresh request';end if;
 if not exists(select 1 from arkhen_private.cache_sources where provider_key=p_provider_key and scope_hash=p_scope_hash and enabled) then return 0;end if;
 if p_job_type='catalog' then
  wanted:=p_payload->>'media_type';
  if p_payload?'media_type' and(wanted is null or wanted not in('live','movies','series')) then raise exception 'Invalid catalog refresh type' using errcode='22023';end if;
  foreach media in array array['live','movies','series'] loop
   if(wanted is null or wanted=media) and not exists(select 1 from arkhen_private.cache_jobs where provider_key=p_provider_key and scope_hash=p_scope_hash and job_type='catalog' and payload->>'media_type'=media and created_at>now()-interval '60 seconds') then
    insert into arkhen_private.cache_jobs(provider_key,scope_hash,job_type,payload) values(p_provider_key,p_scope_hash,'catalog',jsonb_build_object('media_type',media)) on conflict do nothing;
    get diagnostics inserted=row_count;total:=total+inserted;
   end if;
  end loop;
  return total;
 end if;
 if exists(select 1 from arkhen_private.cache_jobs where provider_key=p_provider_key and scope_hash=p_scope_hash and job_type=p_job_type and created_at>now()-interval '60 seconds') then return 0;end if;
 insert into arkhen_private.cache_jobs(provider_key,scope_hash,job_type,payload) values(p_provider_key,p_scope_hash,p_job_type,p_payload) on conflict do nothing;
 get diagnostics inserted=row_count;return inserted;
end $$;
revoke all on function public.arkhen_request_cache_refresh(text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.arkhen_request_cache_refresh(text,text,text,jsonb) to service_role;

-- Record durations of completed phases separately from elapsed time in the
-- interrupted phase. No statement/global timeout is increased.
do $timings$
declare original text;body text;definition text;label text;
begin
 select prosrc into original from pg_proc where oid='public.arkhen_cloud_catalog_publish(uuid,text,text)'::regprocedure;
 if position('publicationFailure' in original)=0 or position('phase_started' in original)>0 then raise exception 'Catalog timing version mismatch';end if;
 body:=replace(original,'started timestamptz:=clock_timestamp();','started timestamptz:=clock_timestamp();phase_started timestamptz:=clock_timestamp();phase_timings jsonb:=''{}'';');
 foreach label in array array['catalog_build','categories','media','deactivate_categories','deactivate_media','artwork_insert','artwork_cleanup','snapshot','cleanup_private'] loop
  body:=replace(body,'phase:='''||label||''';','phase_timings:=phase_timings||jsonb_build_object(phase,round(extract(epoch from(clock_timestamp()-phase_started))*1000));phase:='''||label||''';phase_started:=clock_timestamp();');
 end loop;
 body:=replace(body,'''elapsedMs'',round(extract(epoch from(clock_timestamp()-started))*1000))','''elapsedMs'',round(extract(epoch from(clock_timestamp()-started))*1000),''phaseTimings'',phase_timings||jsonb_build_object(phase,round(extract(epoch from(clock_timestamp()-phase_started))*1000)))');
 if body=original or position('''phaseTimings''' in body)=0 then raise exception 'Catalog timing marker missing';end if;
 definition:=pg_get_functiondef('public.arkhen_cloud_catalog_publish(uuid,text,text)'::regprocedure);
 execute replace(definition,original,body);
end $timings$;
-- Enqueue missing types immediately. No existing job, attempt counter, source,
-- staging row or complete snapshot is reset by this operation.
select arkhen_private.enqueue_due_cache_jobs();
notify pgrst,'reload schema';
commit;
