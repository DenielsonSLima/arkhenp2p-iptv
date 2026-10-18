-- Bound privacy cleanup by examined rows, not only matching deletions. Keep
-- the existing write guard and restrictive SELECT policy unchanged. No cleanup
-- function or scheduled job is executed, enabled or rescheduled here.
begin;
set local lock_timeout='3s';
set local statement_timeout='10s';

do $baseline$
begin
 if (select md5(prosrc) from pg_proc where oid='public.arkhen_prune_adult_progress(integer)'::regprocedure)
  is distinct from 'ef4890ec3a744cc7cfbe742f815d2317'
  or (select md5(prosrc) from pg_proc where oid='arkhen_private.arkhen_schedule_marker_sync()'::regprocedure)
  is distinct from 'b692312a2b4eacf70978a08fb85432c5' then
  raise exception 'Privacy cleanup or marker scheduler changed; inspect before applying';
 end if;
end $baseline$;

-- This is an internal maintenance cursor, never a public user/library index.
-- Its ordering uses the existing user_progress primary key, including removed
-- records. A skipped locked row is revisited on the next complete sweep.
create table arkhen_private.progress_privacy_sweep_cursor(
 id boolean primary key default true check(id),
 user_id uuid,
 provider text,
 item_key text,
 episode_id text,
 check((user_id is null and provider is null and item_key is null and episode_id is null)
  or(user_id is not null and provider is not null and item_key is not null and episode_id is not null))
);
alter table arkhen_private.progress_privacy_sweep_cursor enable row level security;
revoke all on arkhen_private.progress_privacy_sweep_cursor from public,anon,authenticated;
grant all on arkhen_private.progress_privacy_sweep_cursor to service_role;
insert into arkhen_private.progress_privacy_sweep_cursor(id) values(true);

create or replace function public.arkhen_prune_adult_progress(p_limit integer default 500)
returns integer language plpgsql security invoker set search_path=''
 set statement_timeout='8s' set lock_timeout='500ms' set jit='off' set enable_nestloop='on' as $$
declare cursor_state arkhen_private.progress_privacy_sweep_cursor;
declare affected integer;next_user_id uuid;next_provider text;next_item_key text;next_episode_id text;
begin
 if p_limit is null or p_limit<1 or p_limit>500 then
  raise exception 'Invalid privacy cleanup limit' using errcode='22023';
 end if;
 if not pg_try_advisory_xact_lock(hashtextextended('arkhen-adult-progress-privacy',0)) then return 0;end if;
 select c.* into strict cursor_state from arkhen_private.progress_privacy_sweep_cursor c where c.id for update;

 with batch as materialized(
  select p.ctid row_tid,p.user_id,p.provider,p.item_key,p.episode_id,p.entry
  from public.user_progress p
  where(p.user_id,p.provider,p.item_key,p.episode_id)>
   (coalesce(cursor_state.user_id,'00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(cursor_state.provider,''),coalesce(cursor_state.item_key,''),coalesce(cursor_state.episode_id,''))
  order by p.user_id,p.provider,p.item_key,p.episode_id
  limit least(p_limit,50) for update of p skip locked
 ), classified as materialized(
  select b.row_tid,
   (public.arkhen_progress_metadata_adult(b.entry->'item')
    or public.arkhen_progress_metadata_adult(b.entry->'episode')
    or public.arkhen_progress_metadata_adult(b.entry)
    or coalesce(m.is_adult or public.arkhen_progress_metadata_adult(m.metadata) or exists(
     select 1 from public.catalog_categories c
     where(c.provider_key,c.scope_hash,c.media_type,c.generation_id)=
      (g.provider_key,g.scope_hash,g.media_type,g.generation_id)
      and c.is_active and c.category_id=any(m.category_ids)
      and(c.is_adult or public.arkhen_progress_metadata_adult(jsonb_build_object('categoryName',c.name)))
    ),false)) is_adult
  from batch b
  left join public.profiles p on p.id=b.user_id and p.provider=b.provider
  left join public.catalog_visible_generations g on(g.provider_key,g.scope_hash,g.media_type)=
   (p.provider_key,p.scope_hash,case split_part(b.item_key,':',1) when 'movie' then 'movies' else split_part(b.item_key,':',1) end)
  left join public.catalog_media m on(m.provider_key,m.scope_hash,m.media_type,m.generation_id,m.media_id)=
   (g.provider_key,g.scope_hash,g.media_type,g.generation_id,substr(b.item_key,strpos(b.item_key,':')+1)) and m.is_active
 ), removed as(
  -- The ctid belongs to an already locked row in this same statement. No
  -- caller chooses a physical row and no unlocked metadata is used to delete.
  delete from public.user_progress p using classified b where p.ctid=b.row_tid and b.is_adult returning 1
 ), tail as materialized(
  select b.user_id,b.provider,b.item_key,b.episode_id from batch b
  order by b.user_id desc,b.provider desc,b.item_key desc,b.episode_id desc limit 1
 )
 select(select count(*)::integer from removed),(select t.user_id from tail t),(select t.provider from tail t),
  (select t.item_key from tail t),(select t.episode_id from tail t)
 into affected,next_user_id,next_provider,next_item_key,next_episode_id;

 -- Advance even when the page has no adult progress. End-of-sweep resets only
 -- the cursor; the next invocation starts a new pass without another scan now.
 update arkhen_private.progress_privacy_sweep_cursor set user_id=next_user_id,provider=next_provider,
  item_key=next_item_key,episode_id=next_episode_id where id;
 return affected;
end $$;
revoke all on function public.arkhen_prune_adult_progress(integer) from public,anon,authenticated;
grant execute on function public.arkhen_prune_adult_progress(integer) to service_role;

-- A worker with a valid global lease would reject another claim. Check that
-- single indexed row before decrypting Vault data or invoking the Edge worker.
-- Expired/missing leases retain the existing dispatch path and due-work logic.
create or replace function arkhen_private.arkhen_schedule_marker_sync()
returns bigint language plpgsql security definer set search_path='' set jit='off' as $$
declare sync_secret text;request_id bigint;
begin
 if exists(select 1 from public.series_marker_sync_state where name='global' and lease_until>now()) then return null;end if;
 select decrypted_secret into sync_secret from vault.decrypted_secrets where name='arkhen_marker_sync_secret' limit 1;
 if sync_secret is null or length(sync_secret)<32 then return null;end if;
 select net.http_post(
  url:='https://wnicimkmzswksaqdtgdv.supabase.co/functions/v1/series-markers-sync',
  headers:=jsonb_build_object('Content-Type','application/json','x-arkhen-marker-secret',sync_secret),
  body:='{}'::jsonb,timeout_milliseconds:=55000) into request_id;
 return request_id;
end $$;
revoke all on function arkhen_private.arkhen_schedule_marker_sync() from public,anon,authenticated;
grant execute on function arkhen_private.arkhen_schedule_marker_sync() to service_role;

notify pgrst,'reload schema';
commit;
