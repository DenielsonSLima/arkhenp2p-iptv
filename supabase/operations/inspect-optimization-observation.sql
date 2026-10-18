-- Observe ordinary scheduled executions; no RPC/job is invoked here.
begin read only;
set local statement_timeout='5s';
set local jit='off';
select jsonb_build_object(
 'observed_at',clock_timestamp(),
 'statements',(select jsonb_agg(t) from (
  select queryid,calls,total_exec_time as total_ms,mean_exec_time as mean_ms,
   coalesce(substring(query from '(arkhen_private\.[a-z_]{1,80})'),substring(query from '(arkhen_[a-z_]{1,80})')) as routine
  from extensions.pg_stat_statements
  where queryid in(6475106387195042014,-7381786608392519706,5524309180557249339,
   2741319960202986103,-8212237553579936383,2073228433068969532,8212580662467090949)
  order by queryid
 )t),
 'recent_scheduled',(select jsonb_agg(t) from (
  select j.jobname,r.status,r.start_time,r.end_time,
   round(extract(epoch from(r.end_time-r.start_time))::numeric,3) as duration_seconds
  from(select jobid,status,start_time,end_time from cron.job_run_details order by runid desc limit 40)r
  join cron.job j on j.jobid=r.jobid
  where j.jobname in('arkhen-tv-guide-clock','arkhen-catalog-generation-cleanup','arkhen-marker-sync-metrics','arkhen-adult-progress-privacy')
  order by r.start_time desc limit 12
 )t)
) as observation;
commit;
