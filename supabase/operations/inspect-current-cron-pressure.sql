-- Small cron metadata and last 100 scheduled executions only.
begin read only;
set local statement_timeout='5s';
set local lock_timeout='500ms';
set local jit='off';
select j.jobid,j.jobname,j.schedule,j.active,
 substring(j.command from 'statement_timeout=''([0-9]+s)''') as outer_budget
from cron.job j where j.jobname like 'arkhen-%' order by j.jobid;
select clock_timestamp() as observed_at,j.jobname,r.status,r.start_time,r.end_time,
 round(extract(epoch from(coalesce(r.end_time,clock_timestamp())-r.start_time))::numeric,3) as seconds,
 case when r.return_message ilike '%statement timeout%' then 'statement_timeout'
  when r.return_message ilike '%startup timeout%' then 'startup_timeout'
  when r.return_message ilike '%lock timeout%' then 'lock_timeout'
  when r.status='failed' then 'other_failure' else null end as failure_class
from (select jobid,status,start_time,end_time,return_message
 from cron.job_run_details order by runid desc limit 100) r
join cron.job j on j.jobid=r.jobid
where j.jobname like 'arkhen-%' order by r.start_time desc limit 35;
commit;
