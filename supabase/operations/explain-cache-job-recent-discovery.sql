-- Plan only: never ANALYZE. The source is a runtime CTE, so provider/scope
-- values are not exposed as constants in the plan. Mirrors the movies branch
-- of enqueue_due_cache_jobs, including completed/failed historical jobs.
set statement_timeout='5s';
explain(costs true,verbose false,format text)
with source as materialized(
 select s.provider_key,s.scope_hash,s.catalog_interval_seconds
 from arkhen_private.cache_sources s where s.enabled
 order by s.provider_key,s.scope_hash limit 1
)
select exists(
 select 1 from arkhen_private.cache_jobs j,source s
 where j.provider_key=s.provider_key and j.scope_hash=s.scope_hash
  and j.job_type='catalog' and j.payload->>'media_type'='movies'
  and j.created_at>now()-make_interval(secs=>s.catalog_interval_seconds)
);
