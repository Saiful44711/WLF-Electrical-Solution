-- Read only; owner SQL Editor.
select to_regprocedure('wlf_private.rpc_v200(text,jsonb)')is not null as original_rpc_preserved,
 to_regprocedure('public.wlf_backup_admin(text,uuid,jsonb)')is not null as maintenance_installed,
 has_function_privilege('authenticated','public.wlf_backup_admin(text,uuid,jsonb)','execute')as browser_maintenance_must_be_false,
 has_function_privilege('service_role','public.wlf_backup_admin(text,uuid,jsonb)','execute')as service_maintenance_must_be_true,
 has_table_privilege('service_role','public.wlf_profiles','select')as edge_profile_read_must_be_true;
select c.relname,c.relrowsecurity as rls_enabled from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'and c.relkind='r'and c.relname like 'wlf_%'order by c.relname;
select name,jsonb_array_length(fields)as extra_fields from public.wlf_document_categories order by name;
select(select count(*)from public.wlf_components)as components,(select count(*)from public.wlf_troubleshooting where not deleted)as troubleshooting,(select count(*)from public.wlf_profiles)as profiles,(select count(*)from public.wlf_requests)as requests;
