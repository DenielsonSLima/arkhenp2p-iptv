-- Audit scheduling is global reference work, never proof of an IPTV edition.
-- Existing table grants/RLS continue to allow writes only to service_role.
alter table public.series_marker_coverage
  add column if not exists audit_priority smallint not null default 0 check(audit_priority between 0 and 100),
  add column if not exists audit_requested_at timestamptz,
  add column if not exists audit_next_check_at timestamptz,
  add column if not exists audit_checked_at timestamptz;
create index if not exists arkhen_marker_coverage_priority_due
  on public.series_marker_coverage(audit_priority desc,audit_next_check_at,imdb_id,season,episode)
  where status in ('pending','empty','unverified','failed') or audit_priority>0;
comment on column public.series_marker_coverage.audit_checked_at is
  'Last completed source-reference audit; not audiovisual or IPTV verification.';
