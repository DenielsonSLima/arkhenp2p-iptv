-- One private singleton, no source/dirty/staged counts or source identifiers.
set statement_timeout='5s';
select clock_timestamp() observed_at,metrics_seeded,markers_complete,coverage_complete,discovery_turn,completed_units,last_published_at,
 captured_global_events<>'{}'::jsonb as has_global_event,
 markers_cursor<>'' as markers_started,coverage_cursor<>'' as coverage_started
from arkhen_private.marker_metric_batch_clock where id;
