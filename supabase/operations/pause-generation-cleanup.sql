-- Incident containment: only the known minute-by-minute cleanup definition.
-- Does not delete data or cancel an in-flight statement. Read back separately.
set statement_timeout='5s';
select jobid,jobname,cron.alter_job(jobid,active:=false) as pause_result
from cron.job
where jobname='arkhen-catalog-generation-cleanup'
 and schedule='* * * * *'
 and command='select public.arkhen_cleanup_catalog_generations(500);'
 and active;
