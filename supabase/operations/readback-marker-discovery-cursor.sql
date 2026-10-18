-- At most three small cursor rows, no provider/scope, title ID or metadata.
-- Run only after the discovery migration. This is not a worker invocation.
set statement_timeout='5s';
select clock_timestamp() observed_at,media_type,is_complete,last_media_id is not null as started,completed_at,last_visited_at
from arkhen_private.marker_catalog_discovery_cursors
order by last_visited_at desc limit 3;
