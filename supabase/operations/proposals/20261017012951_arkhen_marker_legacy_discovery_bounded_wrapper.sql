-- Bound discovery even while an older Edge worker still calls the integer RPC.
-- Keep that RPC's signature, integer changed-row result, lenient argument
-- normalization, security mode, configuration and ACLs. Delegate one page only
-- to the reviewed cursor implementation; never fabricate a full-batch count.
-- Its page changes at most 499 rows, so a legacy worker with a 15-minute
-- discovery cooldown will wait after every page. Bootstrap may take hours or
-- span catalog generations; this containment does not claim a 24-hour bound.
-- No worker release, discovery call, source scan or cron change runs here.
begin;
set local lock_timeout='3s';
set local statement_timeout='10s';

do $rewrite$
declare original text;definition text;updated text;
begin
 select p.prosrc,pg_get_functiondef(p.oid) into strict original,definition
 from pg_proc p where p.oid='public.arkhen_marker_discover(integer)'::regprocedure;
 if md5(original) is distinct from '48eb218ac93d994721e9d416aa6d5a21'
  or(select md5(p.prosrc) from pg_proc p where p.oid='public.arkhen_marker_discover_batch(integer)'::regprocedure)
   is distinct from '8c9fed7831dd93f59ff94217fea8c636' then
  raise exception 'Marker discovery baseline changed; inspect before applying' using errcode='55000';
 end if;
 if length(definition)-length(replace(definition,original,''))<>length(original) then
  raise exception 'Legacy marker discovery function-definition anchor changed' using errcode='55000';
 end if;
 updated:=$body$
declare page jsonb;requested_limit integer;
begin
 requested_limit:=least(1000,greatest(1,coalesce(p_limit,500)));
 page:=public.arkhen_marker_discover_batch(least(requested_limit,500));
 return coalesce((page->>'changed')::integer,0);
end
$body$;
 if md5(updated) is distinct from '8984dddd59916ec8f70f7be13e3217ed' then
  raise exception 'Unexpected legacy marker discovery wrapper body' using errcode='55000';
 end if;
 execute replace(definition,original,updated);
 if(select md5(p.prosrc) from pg_proc p where p.oid='public.arkhen_marker_discover(integer)'::regprocedure)
  is distinct from '8984dddd59916ec8f70f7be13e3217ed' then
  raise exception 'Legacy marker discovery wrapper readback changed' using errcode='55000';
 end if;
end $rewrite$;
commit;
