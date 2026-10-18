-- Incident containment, 2026-10-16. Not a migration and not an automatic startup task.
-- Scope: only the observed ARKHEN Home backfill. Preserves definition and history.
-- Review the readback: HTTP acceptance alone does not prove a committed pause.
begin;
set local statement_timeout='5s';
set local lock_timeout='500ms';
set local jit='off';
select cron.alter_job(jobid,active:=false)
from cron.job
where jobid=9 and jobname='arkhen-home-identities'
 and schedule='* * * * *'
 and command='select public.arkhen_prepare_home_identities(1000);';
select jobid,jobname,schedule,active from cron.job
where jobid=9 and jobname='arkhen-home-identities';
commit;
