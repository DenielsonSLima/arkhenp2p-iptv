-- Home TV accepts only presentation filters; channel availability belongs to
-- the current published live generation in PostgreSQL. No full catalogue is
-- transferred to Node merely to return five cards. Existing rank/heartbeat
-- RPCs and the original explicit-ID API remain unchanged for old clients.
begin;
set local lock_timeout='5s';
set local statement_timeout='15s';

create function public.arkhen_home_tv_catalog(
 p_provider_key text,p_scope_hash text,
 p_hidden_categories text[] default '{}',p_hidden_items text[] default '{}'
) returns jsonb language plpgsql stable security invoker set search_path=''
 set statement_timeout='3s' set jit='off' as $$
declare ids text[];generation uuid;
begin
 if (select auth.uid()) is null or not coalesce(public.arkhen_partition_allows(p_provider_key,p_scope_hash),false) then
  raise exception 'TV Home access denied' using errcode='42501';
 end if;
 -- Reject malformed filters before any catalogue work. The existing TV RPC
 -- repeats this check and owns all final parental/hidden/availability checks.
 for ids in select filters.value from(values(p_hidden_categories),(p_hidden_items)) filters(value) loop
  if ids is null or coalesce(array_ndims(ids),1)<>1 or cardinality(ids)>2000
   or exists(select 1 from unnest(ids) id where id is null or id !~ '^[A-Za-z0-9_-]{1,160}$') then
   raise exception 'Invalid TV Home filters' using errcode='22023';
  end if;
 end loop;
 select g.generation_id into generation from public.catalog_visible_generations g
 where(g.provider_key,g.scope_hash,g.media_type)=(p_provider_key,p_scope_hash,'live');
 if generation is null then return null;end if;
 -- Compact IDs only, limited before aggregation. More than 2,000 channels is
 -- explicit unavailability, never a truncated selection or wrong default.
 select coalesce(array_agg(m.media_id order by m.media_id),'{}'::text[]) into ids
 from(select media_id from public.catalog_media
  where(provider_key,scope_hash,media_type,generation_id)=(p_provider_key,p_scope_hash,'live',generation)
   and is_active order by media_id limit 2001) m;
 if cardinality(ids)>2000 then
  raise exception 'TV Home catalog exceeds supported bound' using errcode='54000';
 end if;
 return public.arkhen_home_tv(p_provider_key,p_scope_hash,ids,p_hidden_categories,p_hidden_items);
end $$;
revoke all on function public.arkhen_home_tv_catalog(text,text,text[],text[]) from public,anon;
grant execute on function public.arkhen_home_tv_catalog(text,text,text[],text[]) to authenticated;
notify pgrst,'reload schema';
commit;
