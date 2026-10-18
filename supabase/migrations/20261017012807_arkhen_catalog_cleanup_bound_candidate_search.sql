-- Bound candidate discovery before applying retention age. The former LIMIT
-- followed generation_created_at and could walk a whole recent generation
-- to return zero. Process one page of at most 50 candidate rows per invocation;
-- TIDs never survive this transaction. No index build, scan, cleanup execution
-- or cron activation is performed while applying this definition.
begin;
set local lock_timeout='3s';
set local statement_timeout='10s';

do $baseline$
begin
 if(select md5(prosrc) from pg_proc where oid='public.arkhen_cleanup_catalog_generations(integer)'::regprocedure)
  is distinct from 'b63086711ebf8c9edde85128574bf5bc' then
  raise exception 'Cleanup definition changed; inspect before applying' using errcode='55000';
 end if;
end $baseline$;

create or replace function public.arkhen_cleanup_catalog_generations(p_limit integer default 500)
returns integer language plpgsql security invoker set search_path=''
 set statement_timeout='3s' set lock_timeout='500ms' set jit='off' as $$
declare
 cursor_row arkhen_private.catalog_cleanup_cursors;candidate record;
 v_relation_name text;v_protected boolean;v_pending boolean;v_tids tid[];v_candidate_tids tid[];
 scanned integer;removed integer:=0;v_bucket integer;
 batch_limit integer:=least(50,greatest(1,coalesce(p_limit,500)));
 started timestamptz:=clock_timestamp();
begin
 if not pg_try_advisory_xact_lock(hashtext('arkhen-catalog-generation-cleanup')) then return 0;end if;
 -- Keep table rotation independent of prior cursor writes/timeouts.
 v_bucket:=mod(extract(minute from started at time zone 'UTC')::integer,3);
 select c.* into strict cursor_row from arkhen_private.catalog_cleanup_cursors c
 where c.relation_name=case v_bucket
  when 0 then 'catalog_artwork_refs' when 1 then 'catalog_media' else 'catalog_categories' end;
 v_relation_name:=cursor_row.relation_name;v_pending:=cursor_row.pending_cleanup;
 if v_pending then
  select cursor_row.last_provider_key as provider_key,cursor_row.last_scope_hash as scope_hash,
   cursor_row.last_media_type as media_type,cursor_row.last_generation_id as generation_id into candidate;
 else
  if cursor_row.last_provider_key is null then
   execute format($seek$
    select m.provider_key,m.scope_hash,m.media_type,m.generation_id
    from public.%I m order by m.provider_key,m.scope_hash,m.media_type,m.generation_id limit 1
   $seek$,v_relation_name) into candidate;
  else
   execute format($seek$
    select m.provider_key,m.scope_hash,m.media_type,m.generation_id from public.%I m
    where(m.provider_key,m.scope_hash,m.media_type,m.generation_id)>($1,$2,$3,$4)
    order by m.provider_key,m.scope_hash,m.media_type,m.generation_id limit 1
   $seek$,v_relation_name) into candidate
   using cursor_row.last_provider_key,cursor_row.last_scope_hash,cursor_row.last_media_type,cursor_row.last_generation_id;
  end if;
  get diagnostics scanned=row_count;
  if scanned=0 then
   update arkhen_private.catalog_cleanup_cursors set last_provider_key=null,last_scope_hash=null,
    last_media_type=null,last_generation_id=null,pending_cleanup=false,last_visited_at=clock_timestamp()
   where relation_name=v_relation_name;
   return 0;
  end if;
  -- Commit generation discovery before retention guards or candidate access.
  update arkhen_private.catalog_cleanup_cursors set last_provider_key=candidate.provider_key,
   last_scope_hash=candidate.scope_hash,last_media_type=candidate.media_type,last_generation_id=candidate.generation_id,
   pending_cleanup=true,last_visited_at=clock_timestamp() where relation_name=v_relation_name;
  return 0;
 end if;
 select exists(select 1 from public.catalog_visible_generations g
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
    and j.payload->>'media_type'=candidate.media_type and j.status='leased' and j.lease_until>now()) into v_protected;
 v_pending:=false;
 if not v_protected then
  -- Age and row-lock availability deliberately do not filter this indexed
  -- generation seek: otherwise LIMIT would bound matches instead of the page.
  execute format($page$
   select array_agg(b.row_tid) from(
    select m.ctid row_tid from public.%I m
    where(m.provider_key,m.scope_hash,m.media_type,m.generation_id)=($1,$2,$3,$4)
    limit $5
   ) b
  $page$,v_relation_name) into v_candidate_tids
  using candidate.provider_key,candidate.scope_hash,candidate.media_type,candidate.generation_id,batch_limit;
  if v_candidate_tids is not null then
   -- Lock only that bounded array. Recheck its logical key because another
   -- transaction may have replaced a tuple between the two SQL statements.
   execute format($lock$
    select array_agg(b.row_tid) from(
     select m.ctid row_tid from public.%I m where m.ctid=any($1::tid[])
      and(m.provider_key,m.scope_hash,m.media_type,m.generation_id)=($2,$3,$4,$5)
     for update of m skip locked
    ) b
   $lock$,v_relation_name) into v_tids
   using v_candidate_tids,candidate.provider_key,candidate.scope_hash,candidate.media_type,candidate.generation_id;
   if v_tids is not null then
    execute format($delete$
     delete from public.%I m where m.ctid=any($1::tid[])
      and(m.provider_key,m.scope_hash,m.media_type,m.generation_id)=($2,$3,$4,$5)
      and m.generation_created_at<now()-interval '1 day'
      and not exists(select 1 from public.catalog_visible_generations g
       where(g.provider_key,g.scope_hash,g.media_type,g.generation_id)=($2,$3,$4,$5))
      and not exists(select 1 from public.provider_catalog_cache c
       where(c.provider_key,c.scope_hash,c.media_type,c.index_generation)=($2,$3,$4,$5))
      and not exists(select 1 from arkhen_private.catalog_prepared_snapshots p where p.generation_id=$5)
      and not exists(select 1 from arkhen_private.catalog_generation_copies p join arkhen_private.cache_jobs j on j.id=p.job_id
       where p.generation_id=$5 and(j.status in('queued','leased') or j.lease_until>now()))
      and not exists(select 1 from arkhen_private.cache_jobs j
       where j.provider_key=$2 and j.scope_hash=$3 and j.job_type='catalog'
        and j.payload->>'media_type'=$4 and j.status='leased' and j.lease_until>now())
    $delete$,v_relation_name)
    using v_tids,candidate.provider_key,candidate.scope_hash,candidate.media_type,candidate.generation_id;
    get diagnostics removed=row_count;
   end if;
   -- Keep draining only when this full page made progress. A recent/locked
   -- head advances to the next generation and is revisited on a future wrap;
   -- old rows behind recent rows may consequently wait for that head to age.
   v_pending:=removed>0 and cardinality(v_candidate_tids)=batch_limit;
  end if;
 end if;
 update arkhen_private.catalog_cleanup_cursors set pending_cleanup=v_pending,last_visited_at=clock_timestamp()
  where relation_name=v_relation_name;
 return removed;
end $$;
revoke all on function public.arkhen_cleanup_catalog_generations(integer) from public,anon,authenticated;
grant execute on function public.arkhen_cleanup_catalog_generations(integer) to service_role;
commit;
