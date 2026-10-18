-- Sanitized restoration inventory: no command bodies or source credentials.
begin read only;
set local statement_timeout='5s';
set local jit='off';
select jobid,jobname,schedule,active,md5(command) as command_hash
from cron.job where jobname like 'arkhen-%' order by jobid;
commit;
