-- Cold/new-revision projections formerly materialized every due programme,
-- including descriptions, before three global sorts and joins. Preserve the
-- complete projection, but parse/sort a single channel list at a time through
-- its existing provider/scope/channel primary key. Warm kept windows, both
-- visibilities, DTO, publication transaction and cron cadence remain unchanged.
begin;
set local lock_timeout='3s';
set local statement_timeout='10s';
do $rewrite$
declare original text;definition text;updated text;old_block text;new_block text;
begin
 select p.prosrc,pg_get_functiondef(p.oid) into original,definition
  from pg_proc p where p.oid=to_regprocedure('arkhen_private.refresh_tv_guide(text,text,boolean,text)')
   and not p.prosecdef and md5(p.prosrc)='6eadce53b3bcb052db3957680c9da241';
 if not found then raise exception 'TV guide baseline changed; inspect before applying' using errcode='55000';end if;
 old_block:=$old$ ),programs as materialized(
  select c.channel_id,p.title,p.description,p."start" start_at,p."end" end_at
  from due e join public.provider_epg_cache c
   on(c.provider_key,c.scope_hash,c.channel_id)=(p_provider_key,p_scope_hash,e.media_id)
  cross join lateral jsonb_to_recordset(c.payload->'list')
   as p(title text,description text,"start" timestamptz,"end" timestamptz)
  where p.title<>'' and p."end">p."start"
 ),next_boundaries as materialized(
  -- All valid start/end boundaries preserve exact previous/current/next
  -- selection even when programmes overlap or a channel has a schedule gap.
  select p.channel_id,min(b.change_at) next_window_change from programs p
  cross join lateral(values(p.start_at),(p.end_at)) b(change_at)
  where b.change_at>stamp group by p.channel_id
 ),previous as(
  select distinct on(channel_id) channel_id,title,description,start_at,end_at
  from programs where end_at<=stamp order by channel_id,end_at desc,start_at desc,title
 ),current as(
  select distinct on(channel_id) channel_id,title,description,start_at,end_at
  from programs where start_at<=stamp and end_at>stamp order by channel_id,start_at desc,end_at,title
 ),following as(
  select distinct on(channel_id) channel_id,title,description,start_at,end_at
  from programs where start_at>stamp order by channel_id,start_at,end_at,title
 ),windows as(
  select e.media_id,c.start_at,c.end_at,n.start_at next_start,b.next_window_change,
   case when p.channel_id is not null then arkhen_private.epg_program_json(p.title,p.description,p.start_at,p.end_at,p_time_zone) end previous_program,
   case when c.channel_id is not null then arkhen_private.epg_program_json(c.title,c.description,c.start_at,c.end_at,p_time_zone) end current_program,
   case when n.channel_id is not null then arkhen_private.epg_program_json(n.title,n.description,n.start_at,n.end_at,p_time_zone) end next_program
  from due e left join previous p on p.channel_id=e.media_id
   left join current c on c.channel_id=e.media_id left join following n on n.channel_id=e.media_id
   left join next_boundaries b on b.channel_id=e.media_id
$old$;
 new_block:=$new$ ),windows as(
  select e.media_id,w.start_at,w.end_at,w.next_start,w.next_window_change,
   w.previous_program,w.current_program,w.next_program
  from due e cross join lateral(
   -- Materialization is local to this one primary-key channel lookup. Three
   -- small top-one sorts replace three sorts of the complete due programme set.
   with programs as materialized(
    select c.channel_id,p.title,p.description,p."start" start_at,p."end" end_at
    from public.provider_epg_cache c
    cross join lateral jsonb_to_recordset(c.payload->'list')
     as p(title text,description text,"start" timestamptz,"end" timestamptz)
    where(c.provider_key,c.scope_hash,c.channel_id)=(p_provider_key,p_scope_hash,e.media_id)
     and p.title<>'' and p."end">p."start"
   ),previous as materialized(
    select * from programs where end_at<=stamp order by end_at desc,start_at desc,title limit 1
   ),current as materialized(
    select * from programs where start_at<=stamp and end_at>stamp order by start_at desc,end_at,title limit 1
   ),following as materialized(
    select * from programs where start_at>stamp order by start_at,end_at,title limit 1
   )select c.start_at,c.end_at,n.start_at next_start,b.next_window_change,
    case when p.channel_id is not null then arkhen_private.epg_program_json(p.title,p.description,p.start_at,p.end_at,p_time_zone) end previous_program,
    case when c.channel_id is not null then arkhen_private.epg_program_json(c.title,c.description,c.start_at,c.end_at,p_time_zone) end current_program,
    case when n.channel_id is not null then arkhen_private.epg_program_json(n.title,n.description,n.start_at,n.end_at,p_time_zone) end next_program
   from(
    -- Aggregate always supplies one row, even for missing/empty channel lists.
    -- Every valid future start/end boundary retains gap/overlap behavior.
    select min(v.change_at) next_window_change from programs pr
    cross join lateral(values(pr.start_at),(pr.end_at)) v(change_at)
    where v.change_at>stamp
   ) b left join previous p on true left join current c on true left join following n on true
  ) w
$new$;
 if length(original)-length(replace(original,old_block,''))<>length(old_block) then
  raise exception 'TV channel projection anchor changed; inspect before applying' using errcode='55000';
 end if;
 updated:=replace(original,old_block,new_block);
 execute replace(definition,original,updated);
end $rewrite$;
commit;
