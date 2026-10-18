-- Minimal read after a connection timeout; no functions, history or source scans.
select jobid,active from cron.job where jobname like 'arkhen-%' order by jobid;
