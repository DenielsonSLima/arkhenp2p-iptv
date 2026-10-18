-- The legacy discovery caps matching mutations after joining the whole visible
-- catalog. This worker-only alternative pages the catalog PK before comparing
-- identities. The legacy integer RPC remains unchanged for compatibility.
begin;
set local lock_timeout='3s';
set local statement_timeout='10s';
do $baseline$
begin
 if(select md5(prosrc) from pg_proc where oid='public.arkhen_marker_discover(integer)'::regprocedure)
  is distinct from '48eb218ac93d994721e9d416aa6d5a21' then
  raise exception 'Marker discovery definition changed; inspect before applying' using errcode='55000';
 end if;
end $baseline$;

create table arkhen_private.marker_catalog_discovery_cursors(
 provider_key text not null,scope_hash text not null,
 media_type text not null default 'series' check(media_type='series'),
 generation_id uuid not null,last_media_id text,
 is_complete boolean not null default false,completed_at timestamptz,
 last_visited_at timestamptz not null default 'epoch',
 primary key(provider_key,scope_hash,media_type),
 check(not is_complete or completed_at is not null)
);
alter table arkhen_private.marker_catalog_discovery_cursors enable row level security;
revoke all on arkhen_private.marker_catalog_discovery_cursors from public,anon,authenticated;
grant all on arkhen_private.marker_catalog_discovery_cursors to service_role;

create function public.arkhen_marker_discover_batch(p_limit integer default 500)
returns jsonb language plpgsql security invoker set search_path=''
 set statement_timeout='8s' set lock_timeout='500ms' set jit='off' as $$
declare
 selected record;cursor_state arkhen_private.marker_catalog_discovery_cursors;
 work_limit integer;changed integer;scanned integer;processed integer;tail text;more boolean;
begin
 if p_limit is null or p_limit not between 1 and 500 then
  raise exception 'Invalid marker discovery page limit' using errcode='22023';
 end if;
 -- One lookahead row gives a real hasMore without OFFSET or an unbounded
 -- anti-join. At most 500 source rows are examined, including that lookahead.
 work_limit:=least(p_limit,499);
 if not pg_try_advisory_xact_lock(hashtext('arkhen-marker-catalog-discovery')) then
  return jsonb_build_object('changed',0,'scanned',0,'hasMore',true,'busy',true);
 end if;
 select g.provider_key,g.scope_hash,g.media_type,g.generation_id into selected
 from public.catalog_visible_generations g
 left join arkhen_private.marker_catalog_discovery_cursors c
  on(c.provider_key,c.scope_hash,c.media_type)=(g.provider_key,g.scope_hash,g.media_type)
 where g.media_type='series' and(c.generation_id is distinct from g.generation_id
  or not c.is_complete or c.completed_at<=now()-interval '15 minutes')
 order by coalesce(c.last_visited_at,'epoch'::timestamptz),g.provider_key,g.scope_hash limit 1;
 if not found then return jsonb_build_object('changed',0,'scanned',0,'hasMore',false);end if;

 insert into arkhen_private.marker_catalog_discovery_cursors(provider_key,scope_hash,media_type,generation_id)
 values(selected.provider_key,selected.scope_hash,selected.media_type,selected.generation_id)
 on conflict do nothing;
 select c.* into strict cursor_state from arkhen_private.marker_catalog_discovery_cursors c
 where(c.provider_key,c.scope_hash,c.media_type)=(selected.provider_key,selected.scope_hash,selected.media_type)
 for update;
 if cursor_state.generation_id<>selected.generation_id or cursor_state.is_complete then
  cursor_state.generation_id:=selected.generation_id;cursor_state.last_media_id:=null;
  cursor_state.is_complete:=false;cursor_state.completed_at:=null;
 end if;

 with raw_page as materialized(
  select m.media_id,m.name,m.metadata,m.last_seen_snapshot,m.is_active
  from public.catalog_media m
  where(m.provider_key,m.scope_hash,m.media_type,m.generation_id)=
   (selected.provider_key,selected.scope_hash,selected.media_type,selected.generation_id)
   and m.media_id>=coalesce(cursor_state.last_media_id,'')
   and m.media_id is distinct from cursor_state.last_media_id
   and exists(select 1 from public.catalog_visible_generations g
    where(g.provider_key,g.scope_hash,g.media_type,g.generation_id)=
     (selected.provider_key,selected.scope_hash,selected.media_type,selected.generation_id))
  order by m.media_id limit work_limit+1
 ),page as materialized(
  select * from raw_page order by media_id limit work_limit
 ),written as(
  insert into public.series_marker_identities as current(
   provider_key,scope_hash,media_id,catalog_name,catalog_metadata,source_snapshot)
  select selected.provider_key,selected.scope_hash,m.media_id,m.name,m.metadata,m.last_seen_snapshot
  from page m left join public.series_marker_identities i
   on(i.provider_key,i.scope_hash,i.media_id)=(selected.provider_key,selected.scope_hash,m.media_id)
  where m.is_active and(i.media_id is null or i.source_snapshot is distinct from m.last_seen_snapshot)
  on conflict(provider_key,scope_hash,media_id)do update set
   catalog_name=excluded.catalog_name,catalog_metadata=excluded.catalog_metadata,source_snapshot=excluded.source_snapshot,
   status=case when current.catalog_name is distinct from excluded.catalog_name then 'pending' else current.status end,
   next_check_at=case when current.catalog_name is distinct from excluded.catalog_name then now() else current.next_check_at end,
   updated_at=now()
  returning 1
 )select(select count(*)::integer from written),(select count(*)::integer from raw_page),
  (select count(*)::integer from page),(select max(media_id) from page)
 into changed,scanned,processed,tail;

 update arkhen_private.marker_catalog_discovery_cursors c
 set generation_id=selected.generation_id,last_media_id=coalesce(tail,cursor_state.last_media_id),
  is_complete=scanned<=work_limit,
  completed_at=case when scanned<=work_limit then now() end,last_visited_at=clock_timestamp()
 where(c.provider_key,c.scope_hash,c.media_type)=(selected.provider_key,selected.scope_hash,selected.media_type);
 -- Only the compact visible registry/cursors are consulted here. A generation
 -- changing during the page is due on the next call, even after an empty page.
 select exists(
  select 1 from public.catalog_visible_generations g
  left join arkhen_private.marker_catalog_discovery_cursors c
   on(c.provider_key,c.scope_hash,c.media_type)=(g.provider_key,g.scope_hash,g.media_type)
  where g.media_type='series' and(c.generation_id is distinct from g.generation_id
   or not c.is_complete or c.completed_at<=now()-interval '15 minutes')
 )into more;
 return jsonb_build_object('changed',changed,'scanned',scanned,'processed',processed,'hasMore',more);
end $$;
revoke all on function public.arkhen_marker_discover_batch(integer) from public,anon,authenticated;
grant execute on function public.arkhen_marker_discover_batch(integer) to service_role;
notify pgrst,'reload schema';
commit;
