-- Brief, guarded DDL window. Restore the original active state after readback.
set statement_timeout='5s';
select jobid,jobname,cron.alter_job(jobid,active:=false) as pause_result
from cron.job where jobname='arkhen-tv-guide-clock' and schedule='* * * * *'
 and command='select public.arkhen_tick_tv_guides();' and active;
