begin read only;
set local statement_timeout='3s';
select version,name from supabase_migrations.schema_migrations
where name in('arkhen_tv_guide_on_demand_channels','arkhen_marker_metrics_phase_progress','arkhen_marker_discovery_bounded_pages')
order by version;
commit;
