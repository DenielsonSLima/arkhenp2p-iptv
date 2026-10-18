-- Reversible containment of nonessential periodic work during saturation.
-- Keep every job, schedule, command, cursor, source and published snapshot.
begin;
set local statement_timeout='5s';
set local lock_timeout='1s';
set local jit='off';
do $contain$
declare j record;
begin
 for j in select jobid,jobname,schedule,command,active from cron.job
  where jobname in('arkhen-catalog-generation-cleanup','arkhen-marker-sync-metrics','arkhen-tv-guide-clock') loop
  if (j.jobname='arkhen-catalog-generation-cleanup' and
    (j.schedule<>'* * * * *' or j.command<>$cmd$set statement_timeout='3s'; select public.arkhen_cleanup_catalog_generations(500);$cmd$))
   or(j.jobname='arkhen-marker-sync-metrics' and
    (j.schedule<>'2-59/5 * * * *' or j.command<>$cmd$set statement_timeout='8s'; select public.arkhen_refresh_marker_sync_metrics();$cmd$))
   or(j.jobname='arkhen-tv-guide-clock' and
    (j.schedule<>'* * * * *' or j.command not in(
     $cmd$set statement_timeout='20s'; select public.arkhen_tick_tv_guides();$cmd$,
     $cmd$select public.arkhen_tick_tv_guides();$cmd$))) then
   raise exception 'Maintenance command changed for %; inspect before containment',j.jobname using errcode='55000';
  end if;
  if j.active then perform cron.alter_job(j.jobid,active:=false);end if;
 end loop;
end $contain$;
commit;
