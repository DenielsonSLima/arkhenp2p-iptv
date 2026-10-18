-- The old LIMIT bounded deleted rows, but finding them could scan every row
-- of the current generation and repeat every retention guard for each row.
-- Walk generation keys through existing btree prefixes instead. No backfill,
-- catalog read, cleanup execution or cron activation occurs in this migration.
begin;
set local lock_timeout='3s';
set local statement_timeout='10s';

do $baseline$
begin
 if (select md5(prosrc) from pg_proc where oid='public.arkhen_cleanup_catalog_generations(integer)'::regprocedure)
  is distinct from 'ed03eba9c6c7ff2c39d2203473b3d7fc' then
  raise exception 'Cleanup definition changed; inspect before applying';
 end if;
end $baseline$;

create table arkhen_private.catalog_cleanup_cursors(
 relation_name text primary key check(relation_name in('catalog_artwork_refs','catalog_media','catalog_categories')),
 last_provider_key text,
 last_scope_hash text,
 last_media_type text,
 last_generation_id uuid,
 check((last_provider_key is null and last_scope_hash is null and last_media_type is null and last_generation_id is null)
  or(last_provider_key is not null and last_scope_hash is not null and last_media_type is not null and last_generation_id is not null))
);
alter table arkhen_private.catalog_cleanup_cursors enable row level security;
revoke all on arkhen_private.catalog_cleanup_cursors from public,anon,authenticated;
grant all on arkhen_private.catalog_cleanup_cursors to service_role;
insert into arkhen_private.catalog_cleanup_cursors(relation_name)
values('catalog_artwork_refs'),('catalog_media'),('catalog_categories');

create or replace function public.arkhen_cleanup_catalog_generations(p_limit integer default 500)
returns integer language plpgsql security invoker set search_path=''
 set statement_timeout='3s' set lock_timeout='500ms' set jit='off' as $$
declare
 v_relation_name text;cursor_row arkhen_private.catalog_cleanup_cursors;candidate record;
 scanned integer;removed integer;total integer:=0;
 remaining integer:=least(1000,greatest(1,coalesce(p_limit,500)));
 step integer;started timestamptz:=clock_timestamp();
begin
 if not pg_try_advisory_xact_lock(hashtext('arkhen-catalog-generation-cleanup')) then return 0;end if;
 foreach v_relation_name in array array['catalog_artwork_refs','catalog_media','catalog_categories'] loop
  exit when remaining<=0 or clock_timestamp()-started>interval '1500 milliseconds';
  select c.* into strict cursor_row from arkhen_private.catalog_cleanup_cursors c
   where c.relation_name=v_relation_name;
  for step in 1..8 loop
   exit when clock_timestamp()-started>interval '1500 milliseconds';
   -- The ordered prefix exists on media/categories primary keys and on
   -- arkhen_artwork_generation. One seek jumps over a whole generation.
   execute format($seek$
    select m.provider_key,m.scope_hash,m.media_type,m.generation_id
    from public.%I m
    where $1::text is null or
     (m.provider_key,m.scope_hash,m.media_type,m.generation_id)>($1::text,$2::text,$3::text,$4::uuid)
    order by m.provider_key,m.scope_hash,m.media_type,m.generation_id limit 1
   $seek$,v_relation_name) into candidate
   using cursor_row.last_provider_key,cursor_row.last_scope_hash,cursor_row.last_media_type,cursor_row.last_generation_id;
   get diagnostics scanned=row_count;
   if scanned=0 then
    -- Wrap on the next invocation, rather than revisit the same keys now.
    cursor_row.last_provider_key:=null;cursor_row.last_scope_hash:=null;
    cursor_row.last_media_type:=null;cursor_row.last_generation_id:=null;
    exit;
   end if;
   -- Reject a protected generation before planning any DELETE at all. Repeat
   -- the guards inside that statement below to retain its own MVCC protection.
   if exists(select 1 from public.catalog_visible_generations g
     where(g.provider_key,g.scope_hash,g.media_type,g.generation_id)=
      (candidate.provider_key,candidate.scope_hash,candidate.media_type,candidate.generation_id))
    or exists(select 1 from public.provider_catalog_cache c
     where(c.provider_key,c.scope_hash,c.media_type,c.index_generation)=
      (candidate.provider_key,candidate.scope_hash,candidate.media_type,candidate.generation_id))
    or exists(select 1 from arkhen_private.catalog_prepared_snapshots p where p.generation_id=candidate.generation_id)
    or exists(select 1 from arkhen_private.catalog_generation_copies p join arkhen_private.cache_jobs j on j.id=p.job_id
     where p.generation_id=candidate.generation_id and(j.status in('queued','leased') or j.lease_until>now()))
    or exists(select 1 from arkhen_private.cache_jobs j
     where j.provider_key=candidate.provider_key and j.scope_hash=candidate.scope_hash and j.job_type='catalog'
      and j.payload->>'media_type'=candidate.media_type and j.status='leased' and j.lease_until>now()) then
    cursor_row.last_provider_key:=candidate.provider_key;
    cursor_row.last_scope_hash:=candidate.scope_hash;
    cursor_row.last_media_type:=candidate.media_type;
    cursor_row.last_generation_id:=candidate.generation_id;
    continue;
   end if;
   execute format($cleanup$
    with retired as materialized(
     select true as eligible
     where not exists(select 1 from public.catalog_visible_generations g
      where(g.provider_key,g.scope_hash,g.media_type,g.generation_id)=($2,$3,$4,$5))
     and not exists(select 1 from public.provider_catalog_cache c
      where(c.provider_key,c.scope_hash,c.media_type,c.index_generation)=($2,$3,$4,$5))
     and not exists(select 1 from arkhen_private.catalog_prepared_snapshots p where p.generation_id=$5)
     and not exists(select 1 from arkhen_private.catalog_generation_copies p
      join arkhen_private.cache_jobs j on j.id=p.job_id
      where p.generation_id=$5 and(j.status in('queued','leased') or j.lease_until>now()))
     and not exists(select 1 from arkhen_private.cache_jobs j
      where j.provider_key=$2 and j.scope_hash=$3 and j.job_type='catalog'
       and j.payload->>'media_type'=$4 and j.status='leased' and j.lease_until>now())
    ),candidates as materialized(
     select m.ctid from public.%I m cross join retired
     where(m.provider_key,m.scope_hash,m.media_type,m.generation_id)=($2,$3,$4,$5)
      and m.generation_created_at<now()-interval '1 day'
     limit $1 for update of m skip locked
    )
    delete from public.%I m using candidates where m.ctid=candidates.ctid
   $cleanup$,v_relation_name,v_relation_name)
   using remaining,candidate.provider_key,candidate.scope_hash,candidate.media_type,candidate.generation_id;
   get diagnostics removed=row_count;
   total:=total+removed;remaining:=remaining-removed;
   -- A full batch may leave more rows in this generation. Retain the prior
   -- cursor so the next invocation resumes here before advancing onward.
   exit when remaining<=0;
   cursor_row.last_provider_key:=candidate.provider_key;
   cursor_row.last_scope_hash:=candidate.scope_hash;
   cursor_row.last_media_type:=candidate.media_type;
   cursor_row.last_generation_id:=candidate.generation_id;
  end loop;
  update arkhen_private.catalog_cleanup_cursors c set
   last_provider_key=cursor_row.last_provider_key,last_scope_hash=cursor_row.last_scope_hash,
   last_media_type=cursor_row.last_media_type,last_generation_id=cursor_row.last_generation_id
  where c.relation_name=v_relation_name;
 end loop;
 return total;
end $$;
revoke all on function public.arkhen_cleanup_catalog_generations(integer) from public,anon,authenticated;
grant execute on function public.arkhen_cleanup_catalog_generations(integer) to service_role;
commit;
