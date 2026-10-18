-- The former TMDB sort joined/ranked every pending source group before
-- LIMIT 20. Materialize the small lexical page first; the existing pending
-- index has (generation,imdb_id,season,episode) WHERE NOT exported. TMDB
-- preference now applies only within that page and does not rank the backlog.
-- No source rows are changed and no index is built by this migration.
begin;
set local lock_timeout='3s';
set local statement_timeout='10s';

do $baseline$
begin
 if(select md5(prosrc) from pg_proc where oid='public.arkhen_marker_source_batch(text,uuid,integer)'::regprocedure)
  is distinct from '98408548adc6f4d942ec0f698c0bbb62' then
  raise exception 'Marker source batch definition changed; inspect before applying' using errcode='55000';
 end if;
end $baseline$;

create or replace function public.arkhen_marker_source_batch(p_generation text,p_owner uuid,p_limit integer default 20)
returns jsonb language plpgsql security invoker set search_path='' set statement_timeout='15s' as $$
declare groups jsonb;segments jsonb;
begin
  perform 1 from public.series_marker_sync_state where name='global' and lease_owner=p_owner and lease_until>now() and raw_generation=p_generation and raw_complete_at is not null for update;
  if not found then raise exception 'Marker lease expired';end if;
  with page as materialized (
    select g.* from public.series_marker_source_groups g
    where g.generation=p_generation and not g.exported
    order by g.imdb_id,g.season,g.episode
    limit least(20,greatest(1,coalesce(p_limit,20)))
  ), ranked as (
    select g.*,(t.tmdb_id is not null) as has_tmdb
    from page g left join public.series_marker_titles t on t.imdb_id=g.imdb_id
  ), bounded as (
    select r.*,sum(segment_count) over(order by has_tmdb desc,imdb_id,season,episode) as total from ranked r
  ) select coalesce(jsonb_agg(jsonb_build_object('imdb_id',imdb_id,'season',season,'episode',episode)
      order by has_tmdb desc,imdb_id,season,episode),'[]') into groups from bounded where total<=2000;
  select coalesce(jsonb_agg(jsonb_build_object('id',s.segment_id,'status','approved','media_type','series','imdb_id',s.imdb_id,'season',s.season,'episode',s.episode,'segment_type',s.segment_type,'start_ms',s.start_ms,'end_ms',s.end_ms,'duration_ms',s.duration_ms,'score',s.score)),'[]') into segments
  from public.series_marker_source_segments s join jsonb_to_recordset(groups) as g(imdb_id text,season integer,episode integer) on s.imdb_id=g.imdb_id and s.season=g.season and s.episode=g.episode where s.generation=p_generation;
  -- Preserve the exact exclusion count/API contract. This aggregate still
  -- examines the generation and is not claimed to be bounded by the page.
  return jsonb_build_object('groups',groups,'segments',segments,'excluded_groups',(select count(*) from public.series_marker_source_groups where generation=p_generation and error_code is not null));
end $$;
revoke all on function public.arkhen_marker_source_batch(text,uuid,integer) from public,anon,authenticated;
grant execute on function public.arkhen_marker_source_batch(text,uuid,integer) to service_role;
commit;
