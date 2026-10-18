-- Bounded EPG publication/job metadata only: no profiles, library, logs,
-- raw schedules, source URLs, credentials or execution of collector functions.
begin read only;
set local statement_timeout='5s';
set local lock_timeout='500ms';
set local jit='off';
with versions as materialized (
 select * from public.epg_cache_versions order by updated_at desc limit 6
), publication as (
 select v.snapshot_fetched_at,v.snapshot_expires_at,v.source_next_refresh_at,
  v.horizon_end,v.updated_at,v.is_legacy,v.channel_count,v.program_count,
  v.snapshot_expires_at<=now() ttl_expired,
  coalesce(v.horizon_end<=now(),true) horizon_expired,
  s.enabled source_enabled,s.epg_interval_seconds,s.last_epg_enqueued_at,
  s.last_epg_enqueued_at+make_interval(secs=>s.epg_interval_seconds) next_enqueue_due
 from versions v left join arkhen_private.cache_sources s
 using(provider_key,scope_hash)
), recent_jobs as materialized (
 select j.status,j.attempts,j.run_after,j.lease_until,j.created_at,j.finished_at,
  case when j.error_code ~ '^[A-Z0-9_]{1,100}$' then j.error_code
   when j.error_code is null then null else 'OTHER' end error_code,
  c.state candidate_state,c.fetched_at,c.published_at
 from arkhen_private.cache_jobs j
 join versions v using(provider_key,scope_hash)
 left join arkhen_private.epg_snapshot_candidates c on c.job_id=j.id
 where j.job_type='epg' and(j.created_at>=now()-interval '24 hours'
  or j.status in('queued','leased'))
), job_groups as (
 select status,error_code,candidate_state,count(*) jobs,max(attempts) max_attempts,
  min(created_at) oldest_created_at,max(created_at) latest_created_at,
  min(run_after) earliest_run_after,max(lease_until) latest_lease_until,
  max(finished_at) latest_finished_at,max(fetched_at) latest_fetched_at,
  max(published_at) latest_published_at,
  count(*)filter(where status='queued' and run_after<=now()) due_queued,
  count(*)filter(where status='leased' and lease_until<=now()) expired_leases
 from recent_jobs group by status,error_code,candidate_state
 order by latest_created_at desc limit 10
)
select now() observed_at,
 coalesce((select jsonb_agg(to_jsonb(p)) from publication p),'[]') publications,
 coalesce((select jsonb_agg(to_jsonb(j)) from job_groups j),'[]') job_groups;
commit;
