begin read only;
set local statement_timeout='5s';
set local jit='off';
select j.jobname,r.start_time,left(substring(r.return_message from 'CONTEXT:.*'),2500) as context
from(select jobid,status,start_time,return_message from cron.job_run_details order by runid desc limit 100)r
join cron.job j on j.jobid=r.jobid
where r.status='failed' and j.jobname='arkhen-catalog-generation-cleanup'
order by r.start_time desc limit 1;
explain(format json)
select m.provider_key,m.scope_hash,m.media_type,m.generation_id
from public.catalog_artwork_refs m
order by m.provider_key,m.scope_hash,m.media_type,m.generation_id limit 1;
explain(format json)
select m.provider_key,m.scope_hash,m.media_type,m.generation_id
from public.catalog_media m
order by m.provider_key,m.scope_hash,m.media_type,m.generation_id limit 1;
select schemaname,tablename,indexname,indexdef from pg_indexes where
 schemaname in('public','arkhen_private') and tablename in('catalog_artwork_refs','catalog_generation_copies','catalog_prepared_snapshots','cache_jobs');
commit;
