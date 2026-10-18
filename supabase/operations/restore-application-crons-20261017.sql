-- Incident containment window; exact captured metadata, no task invocation.
begin;
set local statement_timeout='8s';
set local lock_timeout='1s';
set local jit='off';
do $window$
declare s record;j record;
begin
 if (select count(*) from cron.job where jobname like 'arkhen-%')<>11 then
  raise exception 'Application cron inventory changed';
 end if;
 for s in select * from(values
  (1,'arkhen-cache-enqueue','* * * * *','b94d7470818e81eafcd20c25d9881439',true),
  (2,'arkhen-cache-history-prune','17 3 * * *','a30650e2e40f9b5f03119f0b89471e4e',true),
  (3,'arkhen-shared-metadata-prune','37 3 * * *','3775261eb725119aac1c42d093226ea8',true),
  (4,'arkhen-series-markers-sync','*/2 * * * *','9a439934913fe7edbe7d7302dff0f6d9',true),
  (5,'arkhen-cloud-catalog-sync','* * * * *','53a72f027325cee1f545a827ede6576e',true),
  (6,'arkhen-catalog-generation-cleanup','* * * * *','98d5d8481cb03f0e3cc569be67bc2d94',false),
  (7,'arkhen-marker-sync-metrics','2-59/5 * * * *','1659eeb842828fb80ab490495db367b8',false),
  (8,'arkhen-catalog-navigation','* * * * *','70e9a757a2c827e53e05532ef2f73d6c',true),
  (9,'arkhen-home-identities','* * * * *','3a542afa3eaaf8a63ae599860151dc75',false),
  (10,'arkhen-adult-progress-privacy','3-59/5 * * * *','8736fdf0215af14c6596a5e32abadf24',true),
  (11,'arkhen-tv-guide-clock','* * * * *','301c88c3ab36ddff977fc9d28bbe994b',false)
 ) baseline(job_id,job_name,job_schedule,command_hash,was_active) loop
  select jobid,jobname,schedule,command,active into strict j from cron.job where jobid=s.job_id;
  if j.jobname<>s.job_name or j.schedule<>s.job_schedule or md5(j.command)<>s.command_hash then
   raise exception 'Application cron definition changed for %',s.job_name;
  end if;
  if j.active is distinct from s.was_active then perform cron.alter_job(j.jobid,active:=s.was_active);end if;
 end loop;
end $window$;
commit;
