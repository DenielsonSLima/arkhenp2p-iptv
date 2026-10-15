-- Publish metadata as sets: avoid per-row RPC loops and unchanged Realtime
-- updates. Complete snapshots remain atomic and require the worker's lease.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '90s';

create or replace function public.arkhen_publish_catalog(p_provider_key text,p_scope_hash text,p_media_type text,p_payload jsonb,p_complete boolean,p_snapshot_id uuid,p_expires_at timestamptz,p_job_id uuid,p_worker text)
returns void language plpgsql security invoker set search_path = '' set statement_timeout = '55s' as $$
begin
  perform arkhen_private.assert_cache_lease(p_job_id,p_worker,p_provider_key,p_scope_hash,'catalog');
  if p_complete is distinct from true or jsonb_typeof(p_payload->'items') is distinct from 'array' or jsonb_typeof(p_payload->'categories') is distinct from 'array' then raise exception 'Only a successful complete snapshot may be published';end if;
  if not arkhen_private.safe_shared_payload(p_payload) then raise exception 'Unsafe catalog payload';end if;
  if exists(select 1 from jsonb_array_elements(p_payload->'categories') c where jsonb_typeof(c)<>'object' or coalesce(c->>'id','')='' or coalesce(c->>'name','')='') then raise exception 'Invalid category';end if;
  if exists(select 1 from jsonb_array_elements(p_payload->'items') m where jsonb_typeof(m)<>'object' or coalesce(m->>'id','')='' or coalesce(m->>'name','')='') then raise exception 'Invalid media';end if;
  select p_payload || jsonb_build_object(
    'categories',coalesce((select jsonb_agg(value order by ordinality) from (select distinct on (value->>'id') value,ordinality from jsonb_array_elements(p_payload->'categories') with ordinality order by value->>'id',ordinality desc) chosen),'[]'::jsonb),
    'items',coalesce((select jsonb_agg(value order by ordinality) from (select distinct on (value->>'id') value,ordinality from jsonb_array_elements(p_payload->'items') with ordinality order by value->>'id',ordinality desc) chosen),'[]'::jsonb)
  ) into p_payload;

  with categories as (
    select distinct on (value->>'id') value from jsonb_array_elements(p_payload->'categories') with ordinality order by value->>'id',ordinality desc
  )
  insert into public.catalog_categories as current(provider_key,scope_hash,media_type,category_id,name,last_seen_snapshot)
    select p_provider_key,p_scope_hash,p_media_type,value->>'id',value->>'name',p_snapshot_id from categories
  on conflict(provider_key,scope_hash,media_type,category_id) do update
    set name=excluded.name,is_active=true,last_seen_snapshot=excluded.last_seen_snapshot,updated_at=now()
    where current.name is distinct from excluded.name or not current.is_active;

  with media as (
    select distinct on (value->>'id') value from jsonb_array_elements(p_payload->'items') with ordinality order by value->>'id',ordinality desc
  )
  insert into public.catalog_media as current(provider_key,scope_hash,media_type,media_id,name,category_ids,metadata,last_seen_snapshot)
    select p_provider_key,p_scope_hash,p_media_type,value->>'id',value->>'name',
      case when jsonb_typeof(value->'categoryIds')='array' then coalesce(array(select jsonb_array_elements_text(value->'categoryIds')),'{}'::text[])
        when value->>'categoryId' is null then '{}'::text[] else array[value->>'categoryId'] end,
      value,p_snapshot_id from media
  on conflict(provider_key,scope_hash,media_type,media_id) do update
    set name=excluded.name,category_ids=excluded.category_ids,metadata=excluded.metadata,is_active=true,last_seen_snapshot=excluded.last_seen_snapshot,updated_at=now()
    where (current.name,current.category_ids,current.metadata,current.is_active) is distinct from (excluded.name,excluded.category_ids,excluded.metadata,true);

  -- Unchanged rows keep their last metadata revision; presence in this input,
  -- rather than an UPDATE solely for a snapshot UUID, decides disappearance.
  update public.catalog_categories c set is_active=false,updated_at=now()
    where c.provider_key=p_provider_key and c.scope_hash=p_scope_hash and c.media_type=p_media_type and c.is_active
      and not exists(select 1 from jsonb_array_elements(p_payload->'categories') item where item->>'id'=c.category_id);
  update public.catalog_media m set is_active=false,updated_at=now()
    where m.provider_key=p_provider_key and m.scope_hash=p_scope_hash and m.media_type=p_media_type and m.is_active
      and not exists(select 1 from jsonb_array_elements(p_payload->'items') item where item->>'id'=m.media_id);

  -- This is the publication point: failed validation or index writes roll back
  -- the entire transaction and never replace the visible complete snapshot.
  insert into public.provider_catalog_cache(provider_key,scope_hash,media_type,payload,expires_at,snapshot_id,is_complete)
    values(p_provider_key,p_scope_hash,p_media_type,p_payload,p_expires_at,p_snapshot_id,true)
    on conflict(provider_key,scope_hash,media_type) do update
      set payload=excluded.payload,expires_at=excluded.expires_at,snapshot_id=excluded.snapshot_id,is_complete=true,updated_at=now();
end $$;

create or replace function public.arkhen_publish_epg_batch(p_provider_key text,p_scope_hash text,p_channels jsonb,p_expires_at timestamptz,p_job_id uuid,p_worker text)
returns void language plpgsql security invoker set search_path = '' set statement_timeout = '55s' as $$
begin
  perform arkhen_private.assert_cache_lease(p_job_id,p_worker,p_provider_key,p_scope_hash,'epg');
  if jsonb_typeof(p_channels) is distinct from 'array' or jsonb_array_length(p_channels)>10000 then raise exception 'Invalid EPG channel batch';end if;
  if exists(select 1 from jsonb_array_elements(p_channels) channel where jsonb_typeof(channel)<>'object' or coalesce(channel->>'channel_id','')='' or not arkhen_private.safe_shared_payload(channel->'payload') or jsonb_typeof(channel->'payload'->'list') is distinct from 'array') then raise exception 'Invalid EPG channel payload';end if;
  if exists(select 1 from jsonb_array_elements(p_channels) channel cross join lateral jsonb_array_elements(channel->'payload'->'list') program where jsonb_typeof(program)<>'object' or coalesce(program->>'title','')='' or program->>'start' is null or program->>'end' is null or (program->>'start')::timestamptz >= (program->>'end')::timestamptz) then raise exception 'Invalid program';end if;
  select coalesce(jsonb_agg(jsonb_set(channel.value,'{payload,list}',
    coalesce((select jsonb_agg(value order by ordinality) from (
      select distinct on ((value->>'start')::timestamptz) value,ordinality
      from jsonb_array_elements(channel.value->'payload'->'list') with ordinality
      order by (value->>'start')::timestamptz,ordinality desc
    ) chosen),'[]'::jsonb)) order by channel.ordinality),'[]'::jsonb) into p_channels
    from (select distinct on (value->>'channel_id') value,ordinality from jsonb_array_elements(p_channels) with ordinality order by value->>'channel_id',ordinality desc) channel;

  with channels as (
    select distinct on (value->>'channel_id') value from jsonb_array_elements(p_channels) with ordinality order by value->>'channel_id',ordinality desc
  ), programs as (
    select c.value->>'channel_id' as channel_id,p.value as program,p.ordinality
      from channels c cross join lateral jsonb_array_elements(c.value->'payload'->'list') with ordinality p
  ), chosen as (
    select distinct on (channel_id,(program->>'start')::timestamptz) channel_id,program from programs order by channel_id,(program->>'start')::timestamptz,ordinality desc
  )
  insert into public.epg_programs as current(provider_key,scope_hash,channel_id,start_at,end_at,title,description)
    select p_provider_key,p_scope_hash,channel_id,(program->>'start')::timestamptz,(program->>'end')::timestamptz,program->>'title',coalesce(program->>'description','') from chosen
    on conflict(provider_key,scope_hash,channel_id,start_at) do update
      set end_at=excluded.end_at,title=excluded.title,description=excluded.description,updated_at=now()
      where (current.end_at,current.title,current.description) is distinct from (excluded.end_at,excluded.title,excluded.description);

  with channels as (
    select distinct on (value->>'channel_id') value from jsonb_array_elements(p_channels) with ordinality order by value->>'channel_id',ordinality desc
  )
  insert into public.provider_epg_cache as current(provider_key,scope_hash,channel_id,payload,expires_at)
    select p_provider_key,p_scope_hash,value->>'channel_id',value->'payload',p_expires_at from channels
    on conflict(provider_key,scope_hash,channel_id) do update
      set payload=excluded.payload,expires_at=excluded.expires_at,updated_at=now()
      where (current.payload,current.expires_at) is distinct from (excluded.payload,excluded.expires_at);
end $$;

create or replace function public.arkhen_publish_epg(p_provider_key text,p_scope_hash text,p_channel_id text,p_payload jsonb,p_expires_at timestamptz,p_job_id uuid,p_worker text)
returns void language plpgsql security invoker set search_path = '' set statement_timeout = '55s' as $$
begin
  perform public.arkhen_publish_epg_batch(p_provider_key,p_scope_hash,jsonb_build_array(jsonb_build_object('channel_id',p_channel_id,'payload',p_payload)),p_expires_at,p_job_id,p_worker);
end $$;

revoke all on function public.arkhen_publish_catalog(text,text,text,jsonb,boolean,uuid,timestamptz,uuid,text) from public,anon,authenticated;
revoke all on function public.arkhen_publish_epg(text,text,text,jsonb,timestamptz,uuid,text) from public,anon,authenticated;
revoke all on function public.arkhen_publish_epg_batch(text,text,jsonb,timestamptz,uuid,text) from public,anon,authenticated;
grant execute on function public.arkhen_publish_catalog(text,text,text,jsonb,boolean,uuid,timestamptz,uuid,text) to service_role;
grant execute on function public.arkhen_publish_epg(text,text,text,jsonb,timestamptz,uuid,text) to service_role;
grant execute on function public.arkhen_publish_epg_batch(text,text,jsonb,timestamptz,uuid,text) to service_role;
commit;
