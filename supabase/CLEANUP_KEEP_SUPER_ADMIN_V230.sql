-- =====================================================================
-- WLF v2.3.0 : TEST DATA CLEANUP (keeps only the Super Admin)
-- Run ONLY after UPDATE_SECTIONS_V230.sql and after a fresh backup.
-- THIS CANNOT BE UNDONE (except from your backup).
--
-- Deletes: every user except liftrndelectrical@gmail.com (login + profile),
--   and all test records: support requests and history, R&I activity and
--   projects, Damage Demands, QMS records, usage logs, saved calculations,
--   in-app backup run logs.
-- Keeps: Super Admin login, password and access; Components data,
--   Troubleshooting, support forms, Documents links, R&I categories, settings.
-- =====================================================================
begin;

do $guard$ begin
  if not exists (select 1 from public.wlf_profiles where email='liftrndelectrical@gmail.com'
                 and role='Super Admin' and status='Approved' and auth_user_id is not null) then
    raise exception 'STOP: Super Admin liftrndelectrical@gmail.com not found or not approved. Nothing was deleted.';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public'
                 and table_name='wlf_profiles' and column_name='employee_id') then
    raise exception 'STOP: run UPDATE_SECTIONS_V230.sql first. Nothing was deleted.';
  end if;
end $guard$;

-- test records
delete from wlf_private.backup_chunks;
delete from wlf_private.backup_items;
delete from wlf_private.backup_runs;
delete from wlf_private.excel_runs;
delete from wlf_private.archived_operations;
delete from wlf_private.ri_entry_archive;
delete from wlf_private.deleting_users;
delete from wlf_private.damage_demands;
delete from wlf_private.qms_components;
delete from public.wlf_operations;
delete from public.wlf_history;
delete from public.wlf_requests;
delete from public.wlf_ri_entries;
delete from public.wlf_ri_projects;
delete from public.wlf_records;
delete from public.wlf_usage;

-- other users' login accounts
create temp table if not exists wlf_cleanup_note(note text);
delete from wlf_cleanup_note;
do $auth$ declare sa uuid; n int; begin
  select id into sa from public.wlf_profiles where email='liftrndelectrical@gmail.com' and role='Super Admin';
  begin
    delete from auth.users where id is distinct from sa
      and id not in (select auth_user_id from public.wlf_profiles where id=sa and auth_user_id is not null);
    get diagnostics n = row_count;
    insert into wlf_cleanup_note values ('Deleted login accounts: '||n);
  exception when insufficient_privilege then
    insert into wlf_cleanup_note values ('Login accounts could not be deleted here. Delete them in Authentication > Users (keep the Super Admin). Their app access is already removed.');
  end;
  -- profiles of everyone else (also blocks login if the Auth rows remain)
  delete from public.wlf_profiles where id<>sa;
end $auth$;

commit;

-- Result: check profiles_left = 1 and support_requests_left = 0
select note,
  (select count(*) from public.wlf_profiles) as profiles_left,
  (select count(*) from public.wlf_requests) as support_requests_left,
  (select count(*) from public.wlf_components) as components_kept,
  (select count(*) from public.wlf_troubleshooting where not deleted) as troubleshooting_kept,
  (select count(*) from public.wlf_forms) as support_forms_kept
from wlf_cleanup_note;
