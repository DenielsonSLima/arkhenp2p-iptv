-- Metadata only; natural runs since this postmaster start. No task invocation.
begin read only;
set local statement_timeout='3s';
set local jit='off';
select jsonb_build_object(
 'observed_at',clock_timestamp(),
 'server_started',pg_postmaster_start_time(),
 'jobs',(select jsonb_agg(jsonb_build_object('id',jobid,'name',jobname,'schedule',schedule,'active',active) order by jobid)
   from cron.job where jobname like 'arkhen-%'),
 'runs',(select coalesce(jsonb_agg(jsonb_build_object(
   'job',j.jobname,'status',r.status,'started',r.start_time,
   'seconds',round(extract(epoch from(r.end_time-r.start_time))::numeric,3),
   'failure',case when r.status<>'failed' then null
     when r.return_message ilike '%startup%timeout%' then 'startup_timeout'
     when r.return_message ilike '%statement timeout%' then 'statement_timeout'
     else 'other' end) order by r.runid desc),'[]'::jsonb)
   from (select runid,jobid,status,start_time,end_time,return_message
     from cron.job_run_details order by runid desc limit 35) r
   join cron.job j on j.jobid=r.jobid
   where r.start_time>=pg_postmaster_start_time() and j.jobname like 'arkhen-%')
) as recovery;
commit;
