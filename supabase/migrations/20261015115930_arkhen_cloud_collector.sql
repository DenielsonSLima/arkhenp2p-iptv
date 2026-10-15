-- Resumable metadata collection. Credentials live only in separately encrypted
-- provider sources; staging holds the same sanitized metadata as the catalog.
begin;
set local lock_timeout='5s';
set local statement_timeout='90s';

create table if not exists arkhen_private.cloud_job_progress(
  job_id uuid primary key references arkhen_private.cache_jobs(id) on delete cascade,
  progress jsonb not null default '{}' check(arkhen_private.safe_shared_payload(progress) and octet_length(progress::text)<=131072),
  updated_at timestamptz not null default now()
);
create table if not exists arkhen_private.cloud_catalog_staging(
  job_id uuid not null references arkhen_private.cache_jobs(id) on delete cascade,
  media_type text not null check(media_type in ('live','movies','series')),
  step_key text not null check(step_key~'^[A-Za-z0-9_.:-]{1,200}$'),
  position bigint generated always as identity,
  payload jsonb not null check(arkhen_private.safe_shared_payload(payload) and octet_length(payload::text)<=4194304),
  primary key(job_id,media_type,step_key)
);
alter table arkhen_private.cloud_job_progress enable row level security;
alter table arkhen_private.cloud_catalog_staging enable row level security;
revoke all on arkhen_private.cloud_job_progress,arkhen_private.cloud_catalog_staging from public,anon,authenticated;
grant all on arkhen_private.cloud_job_progress,arkhen_private.cloud_catalog_staging to service_role;
grant usage,select on sequence arkhen_private.cloud_catalog_staging_position_seq to service_role;

-- A cloud invocation must not claim a legacy/local source that it cannot open.
create or replace function public.arkhen_claim_cloud_cache_jobs(p_worker text)
returns table(id uuid,provider_key text,scope_hash text,job_type text,payload jsonb,attempts integer)
language plpgsql security invoker set search_path='' as $$
begin
  if p_worker is null or length(p_worker) not between 1 and 160 then raise exception 'Invalid worker';end if;
  update arkhen_private.cache_jobs j set status='failed',finished_at=now(),error_code='lease_exhausted' where j.status='leased' and j.lease_until<now() and j.attempts>=8;
  return query with picked as (
    select j.id from arkhen_private.cache_jobs j where ((j.status='queued' and j.run_after<=now()) or (j.status='leased' and j.lease_until<now())) and j.attempts<8
      and exists(select 1 from arkhen_private.cache_sources s where s.provider_key=j.provider_key and s.scope_hash=j.scope_hash and s.enabled)
      and exists(select 1 from arkhen_private.provider_sources s where s.provider_key=j.provider_key and s.scope_hash=j.scope_hash and s.expires_at>now())
    order by j.run_after,j.created_at for update skip locked limit 1
  ) update arkhen_private.cache_jobs j set status='leased',locked_by=p_worker,lease_until=now()+interval '180 seconds',attempts=j.attempts+1 from picked where j.id=picked.id
    returning j.id,j.provider_key,j.scope_hash,j.job_type,j.payload,j.attempts;
end $$;
revoke all on function public.arkhen_claim_cloud_cache_jobs(text) from public,anon,authenticated;
grant execute on function public.arkhen_claim_cloud_cache_jobs(text) to service_role;

create or replace function public.arkhen_cloud_catalog_state(p_job_id uuid,p_worker text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare job arkhen_private.cache_jobs; result jsonb;
begin
  select * into job from arkhen_private.cache_jobs where id=p_job_id;
  perform arkhen_private.assert_cache_lease(p_job_id,p_worker,job.provider_key,job.scope_hash,job.job_type);
  select progress into result from arkhen_private.cloud_job_progress where job_id=p_job_id;
  return coalesce(result,'{}'::jsonb);
end $$;

create or replace function public.arkhen_cloud_catalog_checkpoint(p_job_id uuid,p_worker text,p_media_type text,p_step_key text,p_payload jsonb,p_progress jsonb)
returns void language plpgsql security invoker set search_path='' as $$
declare job arkhen_private.cache_jobs;
begin
  select * into job from arkhen_private.cache_jobs where id=p_job_id;
  perform arkhen_private.assert_cache_lease(p_job_id,p_worker,job.provider_key,job.scope_hash,job.job_type);
  if not coalesce(arkhen_private.safe_shared_payload(p_progress),false) or octet_length(p_progress::text)>131072 then raise exception 'Invalid collector checkpoint';end if;
  if p_payload is not null then
    if job.job_type<>'catalog' or p_media_type is null or p_media_type not in ('live','movies','series') or p_step_key is null or p_step_key!~'^[A-Za-z0-9_.:-]{1,200}$' or not coalesce(arkhen_private.safe_shared_payload(p_payload),false) or octet_length(p_payload::text)>4194304 or jsonb_typeof(p_payload->'items') is distinct from 'array' or jsonb_typeof(p_payload->'categories') is distinct from 'array' then raise exception 'Invalid collector page';end if;
    insert into arkhen_private.cloud_catalog_staging(job_id,media_type,step_key,payload) values(p_job_id,p_media_type,p_step_key,p_payload)
    on conflict(job_id,media_type,step_key) do update set payload=excluded.payload;
    -- A retried page can shrink. Its final chunk replaces the previous tail in
    -- the same transaction that advances the durable page cursor.
    if p_progress->>'type'=p_media_type and p_progress ? 'cursor' and coalesce(p_progress->'pageChunk','null'::jsonb)='null'::jsonb and p_step_key~'^(live|movies|series):[0-9]{1,8}:[0-9]{1,8}:[0-9]{1,8}$' then
      delete from arkhen_private.cloud_catalog_staging where job_id=p_job_id and media_type=p_media_type
        and split_part(step_key,':',1)=split_part(p_step_key,':',1) and split_part(step_key,':',2)=split_part(p_step_key,':',2) and split_part(step_key,':',3)=split_part(p_step_key,':',3)
        and split_part(step_key,':',4)~'^[0-9]{1,8}$' and split_part(step_key,':',4)::bigint>split_part(p_step_key,':',4)::bigint;
    end if;
  end if;
  insert into arkhen_private.cloud_job_progress(job_id,progress) values(p_job_id,p_progress)
  on conflict(job_id) do update set progress=cloud_job_progress.progress||excluded.progress,updated_at=now();
end $$;

create or replace function public.arkhen_cloud_catalog_publish(p_job_id uuid,p_worker text,p_media_type text)
returns jsonb language plpgsql security invoker set search_path='' set statement_timeout='55s' as $$
declare job arkhen_private.cache_jobs; state jsonb; catalog jsonb; categories jsonb; items jsonb;
begin
  select * into job from arkhen_private.cache_jobs where id=p_job_id;
  perform arkhen_private.assert_cache_lease(p_job_id,p_worker,job.provider_key,job.scope_hash,'catalog');
  select progress into state from arkhen_private.cloud_job_progress where job_id=p_job_id for update;
  if coalesce(state->'publishedTypes','[]'::jsonb) ? p_media_type then return state;end if;
  if p_media_type is null or p_media_type not in ('live','movies','series') or state->>'typeReady' is distinct from p_media_type then raise exception 'Collector type is not complete';end if;
  with expanded as (
    select category.value,stage.position,category.ordinality from arkhen_private.cloud_catalog_staging stage cross join lateral jsonb_array_elements(stage.payload->'categories') with ordinality category where stage.job_id=p_job_id and stage.media_type=p_media_type
  ), chosen as (select distinct on(value->>'id') value,position,ordinality from expanded order by value->>'id',position desc,ordinality desc)
  select coalesce(jsonb_agg(value order by position,ordinality),'[]'::jsonb) into categories from chosen;
  with expanded as (
    select item.value,item.value->>'id' as media_id,stage.position,item.ordinality from arkhen_private.cloud_catalog_staging stage cross join lateral jsonb_array_elements(stage.payload->'items') with ordinality item where stage.job_id=p_job_id and stage.media_type=p_media_type
  ), chosen as (select distinct on(media_id) media_id,value from expanded order by media_id,position desc,ordinality desc),
  ordering as (select media_id,min(position*1000000+ordinality) as original_order from expanded group by media_id),
  memberships as (
    select media_id,array_agg(distinct category_id order by category_id) as category_ids from expanded cross join lateral (
      select jsonb_array_elements_text(case when jsonb_typeof(value->'categoryIds')='array' then value->'categoryIds' else '[]'::jsonb end) as category_id
      union select value->>'categoryId' where value->>'categoryId' is not null
    ) category where category_id is not null and category_id<>'' group by media_id
  )
  select coalesce(jsonb_agg(chosen.value||jsonb_build_object('categoryIds',coalesce(to_jsonb(memberships.category_ids),'[]'::jsonb)) order by ordering.original_order),'[]'::jsonb) into items from chosen join ordering using(media_id) left join memberships using(media_id);
  catalog:=jsonb_build_object('categories',categories,'items',items);
  perform public.arkhen_publish_catalog(job.provider_key,job.scope_hash,p_media_type,catalog,true,gen_random_uuid(),now()+interval '1 day',p_job_id,p_worker);
  state:=(state-'typeReady')||jsonb_build_object('publishedTypes',coalesce(state->'publishedTypes','[]'::jsonb)||jsonb_build_array(p_media_type));
  update arkhen_private.cloud_job_progress set progress=state,updated_at=now() where job_id=p_job_id;
  delete from arkhen_private.cloud_catalog_staging where job_id=p_job_id and media_type=p_media_type;
  return state;
end $$;

create or replace function public.arkhen_cloud_catalog_yield(p_job_id uuid,p_worker text,p_progress jsonb)
returns void language plpgsql security invoker set search_path='' as $$
declare job arkhen_private.cache_jobs;
begin
  select * into job from arkhen_private.cache_jobs where id=p_job_id;
  perform arkhen_private.assert_cache_lease(p_job_id,p_worker,job.provider_key,job.scope_hash,job.job_type);
  if not coalesce(arkhen_private.safe_shared_payload(p_progress),false) or octet_length(p_progress::text)>131072 then raise exception 'Invalid collector checkpoint';end if;
  insert into arkhen_private.cloud_job_progress(job_id,progress) values(p_job_id,p_progress) on conflict(job_id) do update set progress=cloud_job_progress.progress||excluded.progress,updated_at=now();
  update arkhen_private.cache_jobs set status='queued',locked_by=null,lease_until=null,run_after=now()+interval '5 seconds',attempts=greatest(0,attempts-1) where id=p_job_id;
end $$;

revoke all on function public.arkhen_cloud_catalog_state(uuid,text),public.arkhen_cloud_catalog_checkpoint(uuid,text,text,text,jsonb,jsonb),public.arkhen_cloud_catalog_publish(uuid,text,text),public.arkhen_cloud_catalog_yield(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.arkhen_cloud_catalog_state(uuid,text),public.arkhen_cloud_catalog_checkpoint(uuid,text,text,text,jsonb,jsonb),public.arkhen_cloud_catalog_publish(uuid,text,text),public.arkhen_cloud_catalog_yield(uuid,text,jsonb) to service_role;

-- Native provider restriction flags remain part of shared classification even
-- when a restricted tag uses a generic name such as VIP.
do $classification$
declare definition text; original text:=$needle$arkhen_private.catalog_adult_marker(value->>'name',true) from categories$needle$;
begin
  definition:=pg_get_functiondef('public.arkhen_publish_catalog(text,text,text,jsonb,boolean,uuid,timestamptz,uuid,text)'::regprocedure);
  if position(original in definition)=0 then raise exception 'Catalog publisher version does not match classification patch';end if;
  execute replace(definition,original,$replacement$(arkhen_private.catalog_adult_marker(value->>'name',true) or coalesce(value->>'adult','false')='true' or coalesce(value->>'isAdult','false')='true' or coalesce(value->>'is_adult','false')='true') from categories$replacement$);
end $classification$;

create table if not exists arkhen_private.cloud_collector_clock(id boolean primary key default true check(id),last_kick_at timestamptz);
insert into arkhen_private.cloud_collector_clock(id) values(true) on conflict do nothing;
alter table arkhen_private.cloud_collector_clock enable row level security;
revoke all on arkhen_private.cloud_collector_clock from public,anon,authenticated;
grant all on arkhen_private.cloud_collector_clock to service_role;
do $extension$ begin if exists(select 1 from pg_available_extensions where name='pg_net') then execute 'create extension if not exists pg_net with schema extensions';end if;end $extension$;
create or replace function arkhen_private.kick_cloud_collector()
returns boolean language plpgsql security definer set search_path='' as $$
declare secret text; request_id bigint;
begin
  if to_regclass('vault.decrypted_secrets') is null then return false;end if;
  select decrypted_secret into secret from vault.decrypted_secrets where name='arkhen_collector_secret' limit 1;
  if secret is null or length(secret)<32 then return false;end if;
  update arkhen_private.cloud_collector_clock set last_kick_at=now() where id and (last_kick_at is null or last_kick_at<now()-interval '10 seconds');
  if not found then return false;end if;
  select net.http_post(url:='https://wnicimkmzswksaqdtgdv.supabase.co/functions/v1/arkhen-catalog-sync',headers:=jsonb_build_object('Content-Type','application/json','x-arkhen-collector-secret',secret),body:='{}'::jsonb,timeout_milliseconds:=55000) into request_id;
  return request_id is not null;
end $$;
revoke all on function arkhen_private.kick_cloud_collector() from public,anon,authenticated;
grant execute on function arkhen_private.kick_cloud_collector() to service_role;
create or replace function public.arkhen_kick_cloud_collector()
returns boolean language sql security invoker set search_path='' as $$select arkhen_private.kick_cloud_collector()$$;
revoke all on function public.arkhen_kick_cloud_collector() from public,anon,authenticated;
grant execute on function public.arkhen_kick_cloud_collector() to service_role;
do $cron$ begin if to_regprocedure('cron.schedule(text,text,text)') is not null then perform cron.schedule('arkhen-cloud-catalog-sync','* * * * *','select public.arkhen_kick_cloud_collector();');end if;end $cron$;
notify pgrst,'reload schema';
commit;
