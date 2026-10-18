-- Two samples only, at the beginning/end of an incident containment window.
begin read only;
set local statement_timeout='5s';
set local jit='off';
select jsonb_build_object('observed_at',clock_timestamp(),'server_started',pg_postmaster_start_time(),
 'application_crons_active',(select count(*) from cron.job where jobname like 'arkhen-%' and active),
 'database',(select jsonb_build_object('backends',numbackends,'commits',xact_commit,'rollbacks',xact_rollback,
  'blocks_read',blks_read,'blocks_hit',blks_hit,'temp_files',temp_files,'temp_bytes',temp_bytes,
  'inserted',tup_inserted,'updated',tup_updated,'deleted',tup_deleted,'reset',stats_reset)
  from pg_stat_database where datname=current_database()),
 'io',(select jsonb_agg(to_jsonb(s)-'read_time'-'write_time'-'writeback_time'-'extend_time'-'fsync_time')
  from pg_stat_io s),
 'wal',(select jsonb_build_object('bytes',wal_bytes,'records',wal_records,'full',wal_buffers_full,
  'writes',wal_write,'syncs',wal_sync,'reset',stats_reset) from pg_stat_wal),
 'activity',(select coalesce(jsonb_agg(t),'[]') from(select backend_type,wait_event_type,wait_event,
   round(extract(epoch from(clock_timestamp()-query_start))::numeric,1) as seconds
   from pg_stat_activity where pid<>pg_backend_pid() and state='active' order by query_start limit 8)t)
) as observation;
commit;
