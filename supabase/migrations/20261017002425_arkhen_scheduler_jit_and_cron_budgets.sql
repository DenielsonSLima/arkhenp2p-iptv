-- Keep scheduler bodies, task eligibility and cron cadence/active state intact.
-- Small scheduling queries do not need JIT compilation; timed maintenance
-- statements must establish their existing budget before the SELECT starts.
begin;
set local lock_timeout='3s';
set local statement_timeout='10s';

do $baseline$
begin
 if (select md5(prosrc) from pg_proc where oid='arkhen_private.enqueue_due_cache_jobs(text,text)'::regprocedure)
  is distinct from 'e32bb4a60272519f10d387799019fd56'
  or (select md5(prosrc) from pg_proc where oid='arkhen_private.kick_cloud_collector()'::regprocedure)
  is distinct from '10296ee977e3a55e6743ab48ac75fe95' then
  raise exception 'Scheduler definition changed; inspect before applying' using errcode='55000';
 end if;
end $baseline$;

alter function arkhen_private.enqueue_due_cache_jobs(text,text) set jit='off';
alter function arkhen_private.kick_cloud_collector() set jit='off';

do $budgets$
declare spec record;current_job record;
begin
 for spec in select * from(values
  ('arkhen-marker-sync-metrics',
   'select public.arkhen_refresh_marker_sync_metrics();',
   'set statement_timeout=''45s''; select public.arkhen_refresh_marker_sync_metrics();'),
  ('arkhen-adult-progress-privacy',
   'select public.arkhen_prune_adult_progress(500);',
   'set statement_timeout=''8s''; select public.arkhen_prune_adult_progress(500);')
 ) entries(job_name,original_command,budgeted_command) loop
  select j.jobid,j.command into strict current_job from cron.job j where j.jobname=spec.job_name;
  if current_job.command=spec.original_command then
   -- Passing only command preserves the current schedule and active state,
   -- including a pause made independently for incident containment.
   perform cron.alter_job(current_job.jobid,command:=spec.budgeted_command);
  elsif current_job.command is distinct from spec.budgeted_command then
   raise exception 'Unexpected maintenance command for %; inspect before applying',spec.job_name using errcode='55000';
  end if;
 end loop;
end $budgets$;
commit;
