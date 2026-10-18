-- Plan only: no source rows, identifiers or payloads are returned. Do not add
-- ANALYZE: this explains the same five-branch retention expression whose IF
-- timed out, parameterized by one generation selected through the existing
-- artwork index. The materialized candidate itself is not executed by EXPLAIN.
begin read only;
set local statement_timeout='3s';
set local lock_timeout='500ms';
set local jit='off';
explain(format json,costs true)
with candidate as materialized(
 select m.provider_key,m.scope_hash,m.media_type,m.generation_id
 from public.catalog_artwork_refs m
 order by m.provider_key,m.scope_hash,m.media_type,m.generation_id limit 1
)
select
 exists(select 1 from public.catalog_visible_generations g
  where(g.provider_key,g.scope_hash,g.media_type,g.generation_id)=
   (candidate.provider_key,candidate.scope_hash,candidate.media_type,candidate.generation_id))
 or exists(select 1 from public.provider_catalog_cache c
  where(c.provider_key,c.scope_hash,c.media_type,c.index_generation)=
   (candidate.provider_key,candidate.scope_hash,candidate.media_type,candidate.generation_id))
 or exists(select 1 from arkhen_private.catalog_prepared_snapshots p
  where p.generation_id=candidate.generation_id)
 or exists(select 1 from arkhen_private.catalog_generation_copies p
  join arkhen_private.cache_jobs j on j.id=p.job_id
  where p.generation_id=candidate.generation_id
   and(j.status in('queued','leased') or j.lease_until>now()))
 or exists(select 1 from arkhen_private.cache_jobs j
  where j.provider_key=candidate.provider_key and j.scope_hash=candidate.scope_hash
   and j.job_type='catalog' and j.payload->>'media_type'=candidate.media_type
   and j.status='leased' and j.lease_until>now()) as is_protected
from candidate;
commit;
