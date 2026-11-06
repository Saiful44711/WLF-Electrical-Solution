-- Read-only verification after UPDATE_V220.sql.
select
  (select array_agg(f.category order by t.sort_order)
    from public.wlf_forms f join wlf_private.support_teams() t on f.category=t.id) as support_teams,
  (select count(*) from public.wlf_ri_categories where active) as active_ri_forms,
  (select count(*) from public.wlf_ri_categories where active and section='reports') as active_report_forms,
  (select count(*) from public.wlf_components) as live_component_rows,
  (select jsonb_array_length(value) from public.wlf_settings where key='component_headers') as component_columns,
  has_function_privilege('authenticated','public.wlf_excel_admin(text,uuid,jsonb)','EXECUTE') as browser_has_direct_excel_access,
  has_function_privilege('service_role','public.wlf_excel_admin(text,uuid,jsonb)','EXECUTE') as edge_has_excel_access,
  (select jsonb_object_agg(decision,total) from (
    select decision,count(*) total from wlf_private.v220_import_audit group by decision) grouped) as workbook_import_decisions,
  (select coalesce(jsonb_agg(jsonb_build_object('item',item,'decision',decision) order by item),'[]')
    from wlf_private.v220_import_audit where decision like 'preserved:%') as items_kept_for_review;
