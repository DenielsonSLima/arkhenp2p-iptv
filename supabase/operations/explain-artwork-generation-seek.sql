begin read only;
set local statement_timeout='5s';
set local jit='off';
explain(format json) select m.provider_key,m.scope_hash,m.media_type,m.generation_id
from public.catalog_artwork_refs m
order by m.provider_key,m.scope_hash,m.media_type,m.generation_id limit 1;
commit;
