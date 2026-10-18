-- Resume only definitions verified after this incident. Deadlines precede the
-- calls so they bound the outer statement, rather than relying on function SET.
begin;
set local statement_timeout='5s';
set local lock_timeout='500ms';
select jobid,jobname,cron.alter_job(jobid,
 schedule:='*/5 * * * *',
 command:='set statement_timeout=''3s''; select public.arkhen_cleanup_catalog_generations(500);',
 active:=true) as resume_result
from cron.job where jobname='arkhen-catalog-generation-cleanup'
 and schedule='* * * * *'
 and command='select public.arkhen_cleanup_catalog_generations(500);' and not active
 and (select md5(prosrc) from pg_proc where oid='public.arkhen_cleanup_catalog_generations(integer)'::regprocedure)='c472fc383f4ba0e5da2c847c7ade787a';
select jobid,jobname,cron.alter_job(jobid,
 command:='set statement_timeout=''20s''; select public.arkhen_tick_tv_guides();',
 active:=true) as resume_result
from cron.job where jobname='arkhen-tv-guide-clock' and schedule='* * * * *'
 and command='select public.arkhen_tick_tv_guides();' and not active
 and (select md5(prosrc) from pg_proc where oid='arkhen_private.refresh_tv_guide(text,text,boolean,text)'::regprocedure)='6eadce53b3bcb052db3957680c9da241';
commit;
