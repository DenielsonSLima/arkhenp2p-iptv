-- Read after containment; no log scan or task invocation.
set statement_timeout='5s';
select jobid,jobname,schedule,active
from cron.job
where jobname in('arkhen-home-identities','arkhen-catalog-generation-cleanup')
order by jobid;
