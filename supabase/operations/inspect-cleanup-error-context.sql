begin read only;
set local statement_timeout='5s';
select j.jobname,r.start_time,left(substring(r.return_message from 'CONTEXT:.*'),2500) as context
from(select jobid,status,start_time,return_message from cron.job_run_details order by runid desc limit 120)r
join cron.job j on j.jobid=r.jobid
where r.status='failed' and j.jobname='arkhen-catalog-generation-cleanup'
order by r.start_time desc limit 1;
commit;
