-- Metadata only: verifies additive RPC publication and security, never calls
-- private ranking or reads a profile, favorites, progress or watch history.
begin read only;
set local statement_timeout='5s';
set local lock_timeout='500ms';
select p.proname,pg_get_function_identity_arguments(p.oid) arguments,
 md5(p.prosrc) body_md5,p.prosecdef security_definer,p.proconfig,
 has_function_privilege('anon',p.oid,'EXECUTE') anon_execute,
 has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated_execute,
 case when p.proname='arkhen_home_vod' then
  p.prosrc like '%media_type in(''movies'',''series'')%' and
  p.prosrc not like '%favorites_live as%' and
  p.prosrc like '%''favoriteChannels'',''[]''::jsonb%'
 when p.proname='arkhen_home_tv_catalog' then
  p.prosrc like '%public.arkhen_home_tv(%' and p.prosrc like '%limit 2001%'
 else null end domain_contract_present
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in
 ('arkhen_home_vod','arkhen_home_tv_catalog','arkhen_home_library','arkhen_home_tv','arkhen_movie_recommendations')
order by p.proname;
commit;
