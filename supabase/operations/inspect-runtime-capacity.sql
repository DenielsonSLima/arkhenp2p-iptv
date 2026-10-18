-- Server settings, aggregate activity and database counters only.
begin read only;
set local statement_timeout='5s';
set local jit='off';
select jsonb_build_object(
 'observed_at',clock_timestamp(),
 'settings',(select jsonb_object_agg(name,setting) from pg_settings where name in(
  'server_version','max_worker_processes','max_parallel_workers','max_parallel_workers_per_gather',
  'max_connections','work_mem','shared_buffers','track_io_timing','jit','autovacuum_max_workers')),
 'cron_background_workers',current_setting('cron.use_background_workers',true),
 'cron_max_running_jobs',current_setting('cron.max_running_jobs',true),
 'activity',(select jsonb_agg(t) from (
  select backend_type,state,wait_event_type,wait_event,count(*) as backends
  from pg_stat_activity where pid<>pg_backend_pid()
  group by backend_type,state,wait_event_type,wait_event
 )t),
 'database',(select jsonb_build_object('backends',numbackends,'commits',xact_commit,
  'rollbacks',xact_rollback,'blocks_read',blks_read,'blocks_hit',blks_hit,
  'temp_files',temp_files,'temp_bytes',temp_bytes,'block_read_ms',blk_read_time,
  'block_write_ms',blk_write_time,'stats_reset',stats_reset)
  from pg_stat_database where datname=current_database())
) as capacity;
commit;
