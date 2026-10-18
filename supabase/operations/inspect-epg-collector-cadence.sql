-- Publication/cadence metadata only. No Logs API, messages, commands, payloads,
-- private identities, claims or invocation of collector/cron functions.
begin read only;
set local statement_timeout='5s';
set local lock_timeout='500ms';
set local jit='off';
with selected_crons as materialized (
 select jobid,jobname,schedule,active from cron.job
 where jobname in('arkhen-cache-enqueue','arkhen-cloud-catalog-sync','arkhen-tv-guide-clock')
 limit 3
), cron_summary as (
 select j.jobname,j.schedule,j.active,
  max(d.start_time) latest_start_at,
  max(d.end_time)filter(where d.status='succeeded') latest_success_at,
  count(d.runid)filter(where d.status='succeeded') successful_runs_last_15m,
  count(d.runid)filter(where d.status='failed') failed_runs_last_15m
 from selected_crons j left join cron.job_run_details d
 on d.jobid=j.jobid and d.start_time>=now()-interval '15 minutes'
 group by j.jobid,j.jobname,j.schedule,j.active
), epg_history as (
 select max(created_at) latest_created_at,
  max(finished_at)filter(where status='succeeded') latest_success_at,
  max(finished_at)filter(where status='failed') latest_failure_at,
  count(*)filter(where status='succeeded') successes_last_14d,
  count(*)filter(where status='failed') failures_last_14d
 from arkhen_private.cache_jobs
 where job_type='epg' and created_at>=now()-interval '14 days'
), candidates as (
 select state,count(*) candidates,max(fetched_at) latest_fetched_at,
  max(published_at) latest_published_at
 from arkhen_private.epg_snapshot_candidates
 where fetched_at>=now()-interval '14 days' group by state limit 3
)
select now() observed_at,
 coalesce((select jsonb_agg(to_jsonb(c)) from cron_summary c),'[]') crons,
 (select to_jsonb(h) from epg_history h) epg_jobs,
 coalesce((select jsonb_agg(to_jsonb(c)) from candidates c),'[]') candidates;
commit;
