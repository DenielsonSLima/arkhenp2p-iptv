-- The authenticated plan estimated one visible title instead of 26,988 and
-- selected repeated nested loops between materialized CTEs. The full query,
-- including bounded metadata, measured 1,162 ms with these local plan options.
-- Keep explicit generation joins, owner predicates and SECURITY INVOKER/RLS.
begin;
set local lock_timeout='5s';
set local statement_timeout='20s';
alter function public.arkhen_home_library(text,text,boolean,jsonb,jsonb) set enable_nestloop='off';
alter function public.arkhen_home_library(text,text,boolean,jsonb,jsonb) set jit='off';
notify pgrst,'reload schema';
commit;
