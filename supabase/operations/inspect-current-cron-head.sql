-- Metadata only: no job invocation and no Logs Explorer scan.
begin read only;
set local statement_timeout='3s';
set local jit='off';
select clock_timestamp() observed_at, jobid,jobname,schedule,active,
 substring(command from 'statement_timeout=''([0-9]+s)''') outer_budget
from cron.job order by jobid limit 40;
commit;
