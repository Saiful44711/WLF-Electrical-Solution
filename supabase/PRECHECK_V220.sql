-- Read-only. Run in the intended existing project before UPDATE_V220.sql.
select current_database() as database_name,
  current_setting('server_version') as postgres_version,
  to_regclass('public.wlf_profiles') is not null as has_wlf_profiles,
  to_regclass('public.wlf_forms') is not null as has_wlf_forms,
  to_regclass('public.wlf_documents') is not null as has_v210_documents,
  to_regprocedure('public.wlf_backup_admin(text,uuid,jsonb)') is not null as has_v210_backup,
  to_regprocedure('wlf_private.rpc_v200(text,jsonb)') is not null as has_v210_rpc,
  to_regprocedure('public.wlf_excel_admin(text,uuid,jsonb)') is not null as has_v220_excel;
