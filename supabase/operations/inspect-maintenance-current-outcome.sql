-- Read-only, one job and at most three natural runs. No raw return_message,
-- query text, worker body, credentials, account keys or logs scan is returned.
set statement_timeout='5s';
select r.runid,r.status,r.start_time,r.end_time,
 round(extract(epoch from(r.end_time-r.start_time))::numeric,3) as elapsed_seconds,
 case when r.status='succeeded' then 'SUCCEEDED'
  when r.return_message ilike '%job startup timeout%' then 'JOB_STARTUP_TIMEOUT'
  when r.return_message ilike '%statement timeout%' then 'STATEMENT_TIMEOUT'
  when r.return_message ilike '%lock timeout%' then 'LOCK_TIMEOUT'
  when r.return_message ilike '%connection%' then 'CONNECTION_FAILURE'
  when r.return_message ilike '%canceling statement%' then 'STATEMENT_CANCELLED'
  else 'UNCLASSIFIED_FAILURE' end as outcome_code
from cron.job_run_details r
where r.jobid=(select j.jobid from cron.job j where j.jobname='arkhen-marker-sync-metrics')
order by r.runid desc limit 3;
