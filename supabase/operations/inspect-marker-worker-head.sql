-- Singleton and compact publication registry only; no title, payload or logs.
begin read only;
set local statement_timeout='3s';
set local jit='off';
select clock_timestamp() observed_at,s.last_started_at,s.last_finished_at,
 coalesce(s.lease_until>now(),false) leased,
 case when s.last_result->>'state' in('ready','partial','failed','busy') then s.last_result->>'state' end last_state,
 case when s.last_result->>'error'~'^[A-Z0-9_]{1,80}$' then s.last_result->>'error' end error_code,
 s.last_result?'discoveryCheckedAt' paged_worker_watermark,
 (select jsonb_agg(t) from(select media_type,generation_id is not null published
  from public.catalog_visible_generations order by media_type limit 6)t) published_domains
from public.series_marker_sync_state s where s.name='global';
commit;
