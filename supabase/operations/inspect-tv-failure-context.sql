begin read only;
set local statement_timeout='5s';
set local jit='off';
select j.jobname,r.start_time,left(r.return_message,2400) as technical_error
from(select jobid,status,start_time,return_message from cron.job_run_details order by runid desc limit 140)r
join cron.job j on j.jobid=r.jobid
where r.status='failed' and j.jobname='arkhen-tv-guide-clock'
order by r.start_time desc limit 2;
commit;
