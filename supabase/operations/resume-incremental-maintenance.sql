-- Resume only reviewed bounded implementations. Cleanup retains its original
-- one-minute cadence with short rotating units; metrics/privacy retain five
-- minutes and run in different minutes to reduce simultaneous expensive work.
begin;
set local statement_timeout='5s';
set local lock_timeout='1s';
do $$
declare j record;
begin
 if to_regclass('arkhen_private.marker_metric_batch_clock') is null or
  (select prosrc not like '%marker_metric_batch_clock%' from pg_proc where oid='public.arkhen_refresh_marker_sync_metrics()'::regprocedure) or
  (select prosrc not like '%ctid=any%' from pg_proc where oid='public.arkhen_cleanup_catalog_generations(integer)'::regprocedure) then
  raise exception 'Incremental implementations are not installed';
 end if;
 for j in select jobid,jobname,schedule,command,active from cron.job
  where jobname in('arkhen-catalog-generation-cleanup','arkhen-marker-sync-metrics','arkhen-adult-progress-privacy') loop
  if j.schedule<>'*/5 * * * *' then raise exception 'Unexpected maintenance schedule';end if;
  if j.jobname='arkhen-catalog-generation-cleanup' then
   if j.command<>$command$set statement_timeout='3s'; select public.arkhen_cleanup_catalog_generations(500);$command$ or j.active then
    raise exception 'Unexpected cleanup state';end if;
   perform cron.alter_job(j.jobid,schedule:='* * * * *',active:=true);
  elsif j.jobname='arkhen-marker-sync-metrics' then
   if j.command<>$command$set statement_timeout='8s'; select public.arkhen_refresh_marker_sync_metrics();$command$ or j.active then
    raise exception 'Unexpected metrics state';end if;
   perform cron.alter_job(j.jobid,schedule:='2-59/5 * * * *',active:=true);
  else
   if j.command<>$command$set statement_timeout='8s'; select public.arkhen_prune_adult_progress(500);$command$ then
    raise exception 'Unexpected privacy command';end if;
   perform cron.alter_job(j.jobid,schedule:='3-59/5 * * * *');
  end if;
 end loop;
end $$;
select jobname,schedule,active from cron.job
 where jobname in('arkhen-catalog-generation-cleanup','arkhen-marker-sync-metrics','arkhen-adult-progress-privacy');
commit;
