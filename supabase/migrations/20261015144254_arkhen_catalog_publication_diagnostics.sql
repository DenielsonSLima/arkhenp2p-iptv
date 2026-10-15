-- The timeout handler rolls back this call's writes and records only a small,
-- private diagnostic. The collector reports failure instead of an empty cache.
begin;
set local lock_timeout='5s';
do $instrument$
declare original text;body text;definition text;marker text;label text;
begin
 select prosrc into original from pg_proc where oid='public.arkhen_cloud_catalog_publish(uuid,text,text)'::regprocedure;
 body:=replace(original,E'\r\n',E'\n');
 if position('Publication page exceeds bounded batch limit' in body)=0 or position('publicationFailure' in body)>0 then raise exception 'Catalog diagnostic version mismatch';end if;
 body:=replace(body,'declare job arkhen_private.cache_jobs;','declare phase text:=''initial'';started timestamptz:=clock_timestamp();job arkhen_private.cache_jobs;');
 body:=regexp_replace(body,'\mbegin\M',E'begin\n begin');
 body:=replace(body,'select progress into state from arkhen_private.cloud_job_progress where job_id=p_job_id for update;',E'select progress into state from arkhen_private.cloud_job_progress where job_id=p_job_id for update;\n state:=state-''publicationFailure'';');
 foreach label in array array['catalog_build','categories','media','deactivate_categories','deactivate_media','artwork_insert','artwork_cleanup','snapshot','cleanup_private'] loop
  marker:=case label when 'catalog_build' then ' select coalesce(jsonb_agg(metadata order by last_position'
   when 'categories' then ' insert into public.catalog_categories as current'
   when 'media' then ' insert into public.catalog_media as current'
   when 'deactivate_categories' then ' update public.catalog_categories c set'
   when 'deactivate_media' then ' update public.catalog_media m set'
   when 'artwork_insert' then ' insert into public.catalog_artwork_refs('
   when 'artwork_cleanup' then ' delete from public.catalog_artwork_refs a where'
   when 'snapshot' then ' insert into public.provider_catalog_cache('
   else ' delete from arkhen_private.cloud_catalog_staging where' end;
  if position(marker in body)=0 then raise exception 'Publication phase marker missing';end if;
  body:=replace(body,marker,E' phase:='''||label||E''';\n'||marker);
 end loop;
 body:=regexp_replace(body,E'\nend[[:space:]]*$',E'\n exception when query_canceled then\n select * into job from arkhen_private.cache_jobs where id=p_job_id;\n perform arkhen_private.assert_cache_lease(p_job_id,p_worker,job.provider_key,job.scope_hash,''catalog'');\n select progress into state from arkhen_private.cloud_job_progress where job_id=p_job_id for update;\n state:=state||jsonb_build_object(''publicationFailure'',jsonb_build_object(''type'',p_media_type,''code'',''57014'',''stage'',phase,''elapsedMs'',round(extract(epoch from(clock_timestamp()-started))*1000)));\n update arkhen_private.cloud_job_progress set progress=state,updated_at=now() where job_id=p_job_id;\n return state;\n end;\nend\n');
 definition:=pg_get_functiondef('public.arkhen_cloud_catalog_publish(uuid,text,text)'::regprocedure);
 execute replace(definition,original,body);
end $instrument$;
notify pgrst,'reload schema';
commit;
