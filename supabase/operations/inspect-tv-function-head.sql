begin read only;
set local statement_timeout='3s';
set local jit='off';
select p.oid::regprocedure::text routine,md5(p.prosrc) body_md5,p.proconfig
from pg_proc p where p.oid in(
 'public.arkhen_tv_guide(text,text,text[],boolean,text)'::regprocedure,
 'public.arkhen_tick_tv_guides()'::regprocedure,
 'arkhen_private.refresh_tv_guide(text,text,boolean,text)'::regprocedure);
commit;
