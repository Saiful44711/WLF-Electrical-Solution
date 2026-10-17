-- Read-only owner verification. Expect all tables rls=true, no unexpected write grants.
select c.relname as table_name,c.relrowsecurity as rls
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public'and c.relkind='r'and c.relname like'wlf_%'order by c.relname;
select 'components' as source,count(*) from public.wlf_components
union all select 'troubleshooting',count(*) from public.wlf_troubleshooting
union all select 'support forms',count(*) from public.wlf_forms;
select schemaname,tablename,policyname,roles,cmd from pg_policies where tablename like'wlf_%'order by tablename;
select grantee,table_name,privilege_type from information_schema.role_table_grants
where table_schema='public'and table_name like'wlf_%'and grantee in('anon','authenticated')order by table_name;
select p.proname,p.prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'and p.proname='wlf_rpc';
select * from pg_publication_tables where pubname='supabase_realtime'and tablename like'wlf_%';
