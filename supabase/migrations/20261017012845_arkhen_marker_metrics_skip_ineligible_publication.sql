-- Keep completed private units when discovery is finished but titles still
-- remain. Do not prepare the atomic publication statement when this call
-- already knows its gate cannot open. The gate retains its own pending/dirty
-- checks to cover writers committing after this preliminary check.
-- Preserve the complete function definition, configuration and existing ACLs.
-- No metrics refresh, source scan, worker or cron change is executed here.
begin;
set local lock_timeout='3s';
set local statement_timeout='10s';

do $rewrite$
declare original text;definition text;updated text;old_block text;new_block text;
begin
 select p.prosrc,pg_get_functiondef(p.oid) into strict original,definition
 from pg_proc p where p.oid='public.arkhen_refresh_marker_sync_metrics()'::regprocedure;
 if md5(original) is distinct from '969090bac09ea855cb8282e22a98a994' then
  raise exception 'Marker metrics phase-progress baseline changed; inspect before applying' using errcode='55000';
 end if;
 old_block:=' if not batch.markers_complete or not batch.coverage_complete then return false;end if;';
 new_block:=$new$ if not batch.markers_complete or not batch.coverage_complete
  or exists(select 1 from arkhen_private.marker_metric_pending_titles)
  or exists(select 1 from arkhen_private.marker_metric_dirty_titles) then return false;end if;$new$;
 if length(original)-length(replace(original,old_block,''))<>length(old_block) then
  raise exception 'Marker metrics publication-return anchor changed; inspect before applying' using errcode='55000';
 end if;
 if length(definition)-length(replace(definition,original,''))<>length(original) then
  raise exception 'Marker metrics function-definition anchor changed; inspect before applying' using errcode='55000';
 end if;
 updated:=replace(original,old_block,new_block);
 if md5(updated) is distinct from 'bfab02863f54ff05241406f1a08a1728' then
  raise exception 'Unexpected marker metrics publication-return rewrite' using errcode='55000';
 end if;
 execute replace(definition,original,updated);
 if(select md5(p.prosrc) from pg_proc p where p.oid='public.arkhen_refresh_marker_sync_metrics()'::regprocedure)
  is distinct from 'bfab02863f54ff05241406f1a08a1728' then
  raise exception 'Marker metrics publication-return readback changed' using errcode='55000';
 end if;
end $rewrite$;
commit;
