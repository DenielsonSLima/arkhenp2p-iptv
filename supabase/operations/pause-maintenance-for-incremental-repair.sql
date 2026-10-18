begin;
set local statement_timeout='5s';
set local lock_timeout='1s';
do $$
declare j record;
begin
 for j in select jobid,jobname,schedule,command from cron.job
  where jobname in('arkhen-catalog-generation-cleanup','arkhen-marker-sync-metrics') loop
  if j.schedule<>'*/5 * * * *' or
   (j.jobname='arkhen-catalog-generation-cleanup' and j.command<>$command$set statement_timeout='3s'; select public.arkhen_cleanup_catalog_generations(500);$command$) or
   (j.jobname='arkhen-marker-sync-metrics' and j.command<>$command$set statement_timeout='45s'; select public.arkhen_refresh_marker_sync_metrics();$command$) then
   raise exception 'Unexpected maintenance schedule/command; inspect before pausing';
  end if;
  perform cron.alter_job(j.jobid,active:=false);
 end loop;
end $$;
select jobname,active from cron.job where jobname in('arkhen-catalog-generation-cleanup','arkhen-marker-sync-metrics');
commit;
