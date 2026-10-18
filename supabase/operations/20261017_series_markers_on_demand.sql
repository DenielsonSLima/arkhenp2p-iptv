-- Authorized policy: external timestamps are fetched only for the playing
-- episode. Preserve all existing identities/markers and their read contracts.
-- Project: wnicimkmzswksaqdtgdv. Idempotent operational change, no schema change.
begin;
set local statement_timeout='5s';
select cron.alter_job(jobid, active:=false)
from cron.job
where jobname in ('arkhen-series-markers-sync','arkhen-marker-sync-metrics') and active;
commit;
select jobid,jobname,schedule,active from cron.job
where jobname in ('arkhen-series-markers-sync','arkhen-marker-sync-metrics') order by jobname;
