-- Bounded metadata only: no source rows, logs API or scheduled job execution.
begin read only;
set local statement_timeout='8s';
set local jit='off';
select jsonb_build_object(
 'observed_at',clock_timestamp(),
 'failures',(select jsonb_agg(t) from (
  select j.jobname,r.start_time,r.end_time,
   case when r.return_message ilike '%statement timeout%' then 'statement_timeout'
    when r.return_message ilike '%lock timeout%' then 'lock_timeout'
    when r.return_message ilike '%deadlock%' then 'deadlock'
    else left(regexp_replace(r.return_message,E'[\\n\\r].*','','s'),160) end as error_class
  from(select jobid,status,start_time,end_time,return_message from cron.job_run_details order by runid desc limit 80)r
  join cron.job j on j.jobid=r.jobid
  where r.status='failed' and j.jobname in('arkhen-catalog-generation-cleanup','arkhen-marker-sync-metrics')
  order by r.start_time desc limit 4
 )t),
 'relations',(select jsonb_agg(t) from(
  select n.nspname as schema,c.relname,c.reltuples::bigint as estimated_rows,c.relpages,
   pg_relation_size(c.oid) as heap_bytes,pg_total_relation_size(c.oid) as total_bytes
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname in('public','arkhen_private') and c.relname in(
   'episode_skip_markers','series_marker_coverage','marker_series_sync_metrics','marker_metric_invalidations',
   'catalog_media','catalog_generations','catalog_categories','catalog_generation_cleanup_cursor')
 )t),
 'indexes',(select jsonb_agg(t) from(
  select schemaname,tablename,indexname,indexdef from pg_indexes
  where schemaname in('public','arkhen_private') and tablename in(
   'episode_skip_markers','series_marker_coverage','marker_series_sync_metrics',
   'catalog_media','catalog_generations','catalog_categories')
 )t)
) as metadata;
commit;
