-- Read-only plan of the current discovery SELECT. LIMIT caps changed rows,
-- rather than examined catalog rows, so empty backlog can still read a catalog.
-- No ANALYZE, source payload, provider/scope value or title is returned.
set statement_timeout='5s';
explain(costs true,verbose false,format text)
select m.provider_key,m.scope_hash,m.media_id
from public.catalog_media m join public.catalog_visible_generations g
 on(g.provider_key,g.scope_hash,g.media_type,g.generation_id)=
  (m.provider_key,m.scope_hash,m.media_type,m.generation_id)
left join public.series_marker_identities i
 on(i.provider_key,i.scope_hash,i.media_id)=(m.provider_key,m.scope_hash,m.media_id)
where m.media_type='series' and m.is_active
 and(i.media_id is null or i.source_snapshot is distinct from m.last_seen_snapshot)
order by m.provider_key,m.scope_hash,m.media_id limit 500;
