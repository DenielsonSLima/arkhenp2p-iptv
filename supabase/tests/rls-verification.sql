-- Run only against the intended ARKHEN project after the migration.
-- This transaction rolls back every fixture, including temporary Auth rows.
begin;
do $$begin
  if exists(select 1 from auth.users where id in ('ffffffff-ffff-4fff-8fff-ffffffffffa1','ffffffff-ffff-4fff-8fff-ffffffffffb2')) then
    raise exception 'Reserved audit fixture ID already exists; choose different IDs before testing';
  end if;
end $$;
insert into auth.users(id) values('ffffffff-ffff-4fff-8fff-ffffffffffa1'),('ffffffff-ffff-4fff-8fff-ffffffffffb2');

set local role service_role;
select public.arkhen_identity_bind(repeat('a',64),'ffffffff-ffff-4fff-8fff-ffffffffffa1','wplay','audit-provider-a','audit-scope-a');
select public.arkhen_identity_bind(repeat('b',64),'ffffffff-ffff-4fff-8fff-ffffffffffb2','wplay','audit-provider-b','audit-scope-b');
select public.arkhen_validate_account('ffffffff-ffff-4fff-8fff-ffffffffffa1','active',now()+interval '1 day',now(),'audit-provider-a','audit-scope-a');
select public.arkhen_validate_account('ffffffff-ffff-4fff-8fff-ffffffffffb2','active',now()+interval '1 day',now(),'audit-provider-b','audit-scope-b');
insert into public.provider_catalog_cache(provider_key,scope_hash,media_type,payload,expires_at,snapshot_id,is_complete)
  values('audit-provider-a','audit-scope-a','movies','{"items":[],"categories":[]}',now()+interval '1 day',gen_random_uuid(),true);
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub','ffffffff-ffff-4fff-8fff-ffffffffffa1',true);
do $$begin
  if (select count(*) from public.profiles)<>1 then raise exception 'FAIL: profile must be owner-scoped';end if;
  if (select count(*) from public.provider_catalog_cache where provider_key='audit-provider-a')<>1 then raise exception 'FAIL: own partition is unreadable';end if;
  begin update public.profiles set status='active';raise exception 'FAIL: user may change account status';exception when insufficient_privilege then null;end;
  begin update public.profiles set access_expires_at=now()+interval '10 years';raise exception 'FAIL: user may extend access expiry';exception when insufficient_privilege then null;end;
  begin perform * from arkhen_private.provider_identities;raise exception 'FAIL: user may read private identities';exception when insufficient_privilege then null;end;
  begin perform * from public.arkhen_identity_lookup(repeat('a',64));raise exception 'FAIL: user may call identity lookup';exception when insufficient_privilege then null;end;
  begin perform * from public.arkhen_claim_cache_jobs('forbidden',1,30);raise exception 'FAIL: user may claim service jobs';exception when insufficient_privilege then null;end;
  begin update public.provider_catalog_cache set is_complete=false;raise exception 'FAIL: user may change shared catalog';exception when insufficient_privilege then null;end;
end $$;
update public.profiles set display_name='Temporary audit' where id='ffffffff-ffff-4fff-8fff-ffffffffffa1';
insert into public.user_favorites(user_id,provider,item_key,item) values('ffffffff-ffff-4fff-8fff-ffffffffffa1','wplay','movie:audit','{"kind":"movie","id":"audit","name":"Audit"}');
insert into public.user_progress(user_id,provider,item_key,episode_id,entry) values('ffffffff-ffff-4fff-8fff-ffffffffffa1','wplay','series:audit','e1','{"time":20}'),('ffffffff-ffff-4fff-8fff-ffffffffffa1','wplay','series:audit','e2','{"time":40}');
insert into public.user_preferences(user_id,provider,key,value) values('ffffffff-ffff-4fff-8fff-ffffffffffa1','wplay','audit','{}');
insert into public.custom_collections(user_id,provider,id,name,collection_type) values('ffffffff-ffff-4fff-8fff-ffffffffffa1','wplay','audit','Audit','movies');
do $$begin
  if (select count(*) from public.user_progress where item_key='series:audit')<>2 then raise exception 'FAIL: episode progress was merged';end if;
  begin insert into public.user_favorites(user_id,provider,item_key,item) values('ffffffff-ffff-4fff-8fff-ffffffffffb2','wplay','movie:foreign','{}');raise exception 'FAIL: can write another owner';exception when insufficient_privilege then null;end;
  begin insert into public.user_favorites(user_id,provider,item_key,item) values('ffffffff-ffff-4fff-8fff-ffffffffffa1','xtream','movie:foreign','{}');raise exception 'FAIL: can write another provider';exception when insufficient_privilege then null;end;
  begin update public.user_progress set user_id='ffffffff-ffff-4fff-8fff-ffffffffffb2';raise exception 'FAIL: ownership transfer is allowed';exception when insufficient_privilege then null;end;
  begin delete from public.user_favorites;raise exception 'FAIL: hard delete allowed';exception when insufficient_privilege then null;end;
end $$;
update public.user_favorites set deleted_at=now(),updated_at=now()+interval '1 second' where item_key='movie:audit';
update public.user_favorites set deleted_at=null,updated_at=now()-interval '1 day' where item_key='movie:audit';
do $$begin
  if not exists(select 1 from public.user_favorites where item_key='movie:audit' and deleted_at is not null) then raise exception 'FAIL: stale update resurrected deleted favorite';end if;
end $$;
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub','ffffffff-ffff-4fff-8fff-ffffffffffb2',true);
do $$begin
  if exists(select 1 from public.user_favorites where user_id='ffffffff-ffff-4fff-8fff-ffffffffffa1') then raise exception 'FAIL: favorite cross-account read';end if;
  if exists(select 1 from public.user_progress where user_id='ffffffff-ffff-4fff-8fff-ffffffffffa1') then raise exception 'FAIL: progress cross-account read';end if;
  if exists(select 1 from public.user_preferences where user_id='ffffffff-ffff-4fff-8fff-ffffffffffa1') then raise exception 'FAIL: preferences cross-account read';end if;
  if exists(select 1 from public.custom_collections where user_id='ffffffff-ffff-4fff-8fff-ffffffffffa1') then raise exception 'FAIL: collection cross-account read';end if;
  if exists(select 1 from public.provider_catalog_cache where provider_key='audit-provider-a') then raise exception 'FAIL: shared partition leakage';end if;
end $$;
reset role;

set local role anon;
select set_config('request.jwt.claim.sub','',true);
do $$begin
  begin perform * from public.profiles;raise exception 'FAIL: anonymous profile access';exception when insufficient_privilege then null;end;
  begin perform * from public.user_favorites;raise exception 'FAIL: anonymous favorite access';exception when insufficient_privilege then null;end;
  begin perform * from public.provider_catalog_cache;raise exception 'FAIL: anonymous catalog access';exception when insufficient_privilege then null;end;
  begin perform * from public.episode_skip_markers;raise exception 'FAIL: anonymous marker access';exception when insufficient_privilege then null;end;
end $$;
reset role;

update public.profiles set status='expired' where id='ffffffff-ffff-4fff-8fff-ffffffffffa1';
set local role authenticated;
select set_config('request.jwt.claim.sub','ffffffff-ffff-4fff-8fff-ffffffffffa1',true);
do $$begin
  if exists(select 1 from public.provider_catalog_cache where provider_key='audit-provider-a') then raise exception 'FAIL: expired access reads provider catalog';end if;
  begin insert into public.user_preferences(user_id,provider,key,value) values('ffffffff-ffff-4fff-8fff-ffffffffffa1','wplay','after-expiry','{}');raise exception 'FAIL: expired access changes preferences';exception when insufficient_privilege then null;end;
end $$;
reset role;
select 'ARKHEN RLS verification passed; every fixture will be rolled back' as result;
rollback;
