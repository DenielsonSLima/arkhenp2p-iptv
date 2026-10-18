-- The runid index bounds this read independently of history size.
begin read only;
set local statement_timeout='3s';
set local jit='off';
select r.runid,j.jobname,r.status,r.start_time,r.end_time,
 round(extract(epoch from(r.end_time-r.start_time))::numeric,3) duration_seconds
from (select runid,jobid,status,start_time,end_time from cron.job_run_details order by runid desc limit 35) r
join cron.job j on j.jobid=r.jobid order by r.runid desc;
commit;
