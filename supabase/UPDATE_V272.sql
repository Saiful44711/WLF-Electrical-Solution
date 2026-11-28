-- =====================================================================
-- WLF Electrical Solution v2.7.2
--   1. Request access: Name, Employee ID and Section are required for every sign-up that comes from the app;
--      an account without Employee ID and Section cannot be approved
--   2. date indexes for period queries; faster clean-up of unused QMS snapshots
--   3. monthly automatic Excel backup (previous month, never clears) on the monthly schedule
--   4. error log: errors in the app are kept 7 days for the Super Admin
--   5. build number 2.7.2 (System status card compares app, database and Edge Function)
-- Needs UPDATE_V271.sql (v2.7.1). Safe to run more than once.
-- =====================================================================
begin;

do $pre$ begin
  if to_regprocedure('wlf_private.rpc_before_v271(text,jsonb)') is null then
    raise exception 'STOP: apply UPDATE_V271.sql (v2.7.1) first. Nothing was changed.';
  end if;
end $pre$;

-- ---------------------------------------------------------------- 1. Request access: all fields required
create or replace function wlf_private.new_user() returns trigger
language plpgsql security definer set search_path='' as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data,'{}'::jsonb);
  sec text := nullif(btrim(coalesce(meta->>'section','')),'');
  emp text := nullif(btrim(coalesce(meta->>'employeeId','')),'');
  nm text := nullif(btrim(coalesce(meta->>'name','')),'');
begin
  -- v2.7.2: any sign-up that carries a name (every version of the app's Request access form does) must carry
  -- Name, Employee ID and Section. Only accounts added by an administrator in the Supabase dashboard have no form data.
  if meta ? 'name' or meta ? 'employeeId' or meta ? 'section' or meta ? 'full_name' then
    if nm is null or emp is null or sec is null then
      raise exception 'Fill in Name, Employee ID and Section.';
    end if;
    if emp !~ '^[A-Za-z0-9][A-Za-z0-9 ./_-]{0,29}$' then raise exception 'Enter a valid Employee ID (letters or digits, up to 30).'; end if;
    if not (sec = any(wlf_private.sections())) then raise exception 'Choose a section from the list.'; end if;
  end if;
  if sec is not null and not (sec = any(wlf_private.sections())) then sec := null; end if;
  if emp is not null and emp !~ '^[A-Za-z0-9][A-Za-z0-9 ./_-]{0,29}$' then emp := null; end if;
  insert into public.wlf_profiles(id,auth_user_id,email,name,employee_id,section,role) values(
    new.id,new.id,lower(new.email),
    left(coalesce(nm,split_part(new.email,'@',1)),120),
    emp, sec, wlf_private.role_for(sec));
  return new;
end
$$;

-- ---------------------------------------------------------------- 2. indexes and snapshot clean-up
create index if not exists wlf_requests_created_idx on public.wlf_requests(created_at) where deleted_at is null;
create index if not exists wlf_history_at_idx on public.wlf_history(at);
create index if not exists wlf_ri_entries_created_idx on public.wlf_ri_entries(created_at) where deleted_at is null;
create index if not exists qms_lifts_created_idx on wlf_private.qms_lifts(created_at) where deleted_at is null;
create index if not exists damage_demands_claim_idx on wlf_private.damage_demands(claim_at) where claim_at is not null;

-- a snapshot is kept while any lift (also one in the Recycle bin) points at it; set-based, no huge text in memory
create or replace function wlf_private.hw_snap_gc() returns integer
language plpgsql security definer set search_path='' as $$
declare n integer;
begin
  with used as (
    select e->>'h' h from wlf_private.qms_lifts l
      cross join lateral jsonb_array_elements(case when jsonb_typeof(l.parts)='array' then l.parts else '[]'::jsonb end) e
     where e ? 'h'
    union
    select l.selection->>'h' from wlf_private.qms_lifts l where jsonb_typeof(l.selection)='object' and l.selection ? 'h')
  delete from wlf_private.hw_snap s where not exists (select 1 from used u where u.h=s.h);
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function wlf_private.hw_snap_gc() from public, anon, authenticated;

-- ---------------------------------------------------------------- 3. monthly automatic Excel backup
alter table wlf_private.report_settings add column if not exists backup_enabled boolean not null default false;
alter table wlf_private.excel_runs add column if not exists monthly_month date;
create index if not exists excel_runs_monthly_idx on wlf_private.excel_runs(monthly_month, kind) where monthly_month is not null;

create or replace function public.wlf_report_admin(action text, actor uuid, payload jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
declare s wlf_private.report_settings; mon date; k text; out jsonb; job_url text; cmd text; removed integer; on_now boolean;
begin
  select * into s from wlf_private.report_settings where id=1;
  if actor is null then
    -- the monthly schedule: the token stored here must come back with the call
    if not (coalesce(s.enabled,false) or coalesce(s.backup_enabled,false)) or s.token is null or payload->>'token' is distinct from s.token then
      raise exception 'Monthly report schedule is not allowed';
    end if;
    if action not in ('pending','data','saved','checked','backupActor','backupSaved') then raise exception 'Not allowed for the schedule'; end if;
  elsif not exists(select 1 from public.wlf_profiles where id=actor and status='Approved' and role='Super Admin') then
    raise exception 'Super Admin only';
  end if;

  if action='status' then
    return jsonb_build_object('enabled',s.enabled,'backupEnabled',s.backup_enabled,'lastCheck',s.last_check,'lastError',s.last_error,
      'cronReady',to_regnamespace('cron') is not null,'netReady',to_regnamespace('net') is not null,
      'lastMonth',to_char(wlf_private.report_last_month(),'YYYY-MM'),'build','2.7.2');
  elsif action='history' then
    return coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'kind',r.kind,'month',to_char(r.month,'YYYY-MM'),'fileId',r.file_id,
        'fileName',r.file_name,'records',r.records,'source',r.source,'createdAt',r.created_at,'updatedAt',r.updated_at)
        order by r.month desc, array_position(array['support','activity','damage'],r.kind))
      from (select * from wlf_private.monthly_reports order by month desc limit 120) r),'[]');
  elsif action='backupHistory' then
    return coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'kind',r.kind,'month',to_char(r.monthly_month,'YYYY-MM'),'fileId',r.workbook_id,
        'records',coalesce(jsonb_array_length(r.items),0),'createdAt',r.created_at)
        order by r.monthly_month desc, array_position(array['support','activity','project','qms','damage','claim'],r.kind))
      from (select * from wlf_private.excel_runs where monthly_month is not null and workbook_id is not null order by monthly_month desc limit 120) r),'[]');
  elsif action='pending' then
    mon := wlf_private.report_last_month();
    return jsonb_build_object('month',to_char(mon,'YYYY-MM'),
      'kinds',case when coalesce(s.enabled,false) then coalesce((select jsonb_agg(x.k order by x.o) from (values ('support',1),('activity',2),('damage',3)) x(k,o)
        where not exists(select 1 from wlf_private.monthly_reports r where r.kind=x.k and r.month=mon)),'[]') else '[]'::jsonb end,
      'backups',case when coalesce(s.backup_enabled,false) then coalesce((select jsonb_agg(x.k order by x.o)
        from (values ('support',1),('activity',2),('project',3),('qms',4),('damage',5),('claim',6)) x(k,o)
        where not exists(select 1 from wlf_private.excel_runs r where r.kind=x.k and r.monthly_month=mon and r.workbook_id is not null)),'[]') else '[]'::jsonb end,
      'from',mon,'to',(mon + interval '1 month' - interval '1 day')::date);
  elsif action='backupActor' then
    -- the schedule makes the backups in the name of the Super Admin who turned it on
    if s.updated_by is null or not exists(select 1 from public.wlf_profiles where id=s.updated_by and status='Approved' and role='Super Admin') then
      raise exception 'The Super Admin who turned on the monthly backup is no longer active. Turn it on again.';
    end if;
    return jsonb_build_object('actor',s.updated_by);
  elsif action='backupSaved' then
    mon := wlf_private.report_month(payload->>'month');
    -- a month made again replaces the older receipt; its Drive file goes to the Drive bin
    select coalesce(jsonb_agg(r.workbook_id),'[]') into out from wlf_private.excel_runs r
     where r.monthly_month=mon and r.kind=(select x.kind from wlf_private.excel_runs x where x.id=nullif(payload->>'id','')::uuid)
       and r.id<>nullif(payload->>'id','')::uuid;
    update wlf_private.excel_runs r set monthly_month=null
     where r.monthly_month=mon and r.kind=(select x.kind from wlf_private.excel_runs x where x.id=nullif(payload->>'id','')::uuid)
       and r.id<>nullif(payload->>'id','')::uuid;
    update wlf_private.excel_runs set monthly_month=mon
     where id=nullif(payload->>'id','')::uuid and workbook_id is not null and not with_clear
       and date_from=mon and date_to=(mon + interval '1 month' - interval '1 day')::date;
    get diagnostics removed = row_count;
    if removed<>1 then raise exception 'Monthly backup receipt rejected'; end if;
    return jsonb_build_object('saved',true,'replaced',out);
  elsif action='backupDeleteHistory' then
    update wlf_private.excel_runs set monthly_month=null where id=nullif(payload->>'id','')::uuid and monthly_month is not null;
    get diagnostics removed = row_count;
    return jsonb_build_object('deleted',removed);
  elsif action='data' then
    k := payload->>'kind'; mon := wlf_private.report_month(payload->>'month');
    if mon > wlf_private.report_last_month() + interval '1 month' then raise exception 'That month has not started yet.'; end if;
    out := wlf_private.report_data(k, mon);
    return out || jsonb_build_object('existing',(select jsonb_build_object('fileId',r.file_id,'fileName',r.file_name)
      from wlf_private.monthly_reports r where r.kind=k and r.month=mon));
  elsif action='saved' then
    k := payload->>'kind'; mon := wlf_private.report_month(payload->>'month');
    if k not in ('support','activity','damage') or coalesce(payload->>'fileId','') !~ '^[-a-zA-Z0-9_]{5,200}$'
       or coalesce(payload->>'sha256','') !~ '^[a-f0-9]{64}$' then raise exception 'Report receipt rejected'; end if;
    insert into wlf_private.monthly_reports(kind,month,file_id,file_name,sha256,records,source,actor)
      values(k,mon,payload->>'fileId',left(coalesce(payload->>'fileName',''),200),payload->>'sha256',coalesce((payload->>'records')::int,0),
        case when actor is null then 'schedule' else 'manual' end,actor)
      on conflict (kind,month) do update set file_id=excluded.file_id,file_name=excluded.file_name,sha256=excluded.sha256,
        records=excluded.records,source=excluded.source,actor=excluded.actor,updated_at=now();
    return jsonb_build_object('saved',true);
  elsif action='checked' then
    update wlf_private.report_settings set last_check=now(),last_error=nullif(left(coalesce(payload->>'error',''),500),'') where id=1;
    return 'true';
  elsif action='deleteHistory' then
    delete from wlf_private.monthly_reports where id=nullif(payload->>'id','')::uuid;
    get diagnostics removed = row_count;
    return jsonb_build_object('deleted',removed);
  elsif action='schedule' then
    -- payload.enable = monthly reports, payload.backup = monthly Excel backup (left out: unchanged)
    on_now := coalesce((payload->>'enable')::boolean, s.enabled);
    if (on_now or coalesce((payload->>'backup')::boolean, s.backup_enabled)) then
      if to_regnamespace('cron') is null or to_regnamespace('net') is null then
        raise exception 'Turn on the extensions pg_cron and pg_net first (Supabase: Database > Extensions), then try again.';
      end if;
      job_url := payload->>'url';
      if coalesce(job_url,'') !~ '^https://[a-z0-9-]+\.supabase\.co/functions/v1/wlf-maintenance$' then raise exception 'Schedule address rejected'; end if;
      update wlf_private.report_settings set enabled=on_now, backup_enabled=coalesce((payload->>'backup')::boolean, backup_enabled),
             token=coalesce(token,encode(extensions.gen_random_bytes(24),'hex')),updated_at=now(),updated_by=actor,last_error=null
        where id=1 returning * into s;
      cmd := format('select net.http_post(url:=%L, headers:=jsonb_build_object(%L,%L,%L,%L), body:=jsonb_build_object(%L,%L,%L,jsonb_build_object(%L,%L)), timeout_milliseconds:=120000)',
        job_url,'Content-Type','application/json','x-wlf-cron',s.token,'action','monthlyReports','payload','token',s.token);
      -- every night between 02:00 and 05:00 Bangladesh time (20:00-23:00 UTC), once an hour; each call makes only what is
      -- still missing for the last month, a few files at a time, so a failed hour is retried in the next one
      execute 'select cron.schedule($1,$2,$3)' using 'wlf-monthly-reports','0 20-23 * * *',cmd;
    else
      update wlf_private.report_settings set enabled=false,backup_enabled=false,token=null,updated_at=now(),updated_by=actor where id=1;
      if to_regnamespace('cron') is not null then
        execute 'select cron.unschedule(jobid) from cron.job where jobname=$1' using 'wlf-monthly-reports';
      end if;
    end if;
    select * into s from wlf_private.report_settings where id=1;
    return jsonb_build_object('enabled',s.enabled,'backupEnabled',s.backup_enabled);
  end if;
  raise exception 'Unsupported report action';
end
$$;
revoke all on function public.wlf_report_admin(text,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.wlf_report_admin(text,uuid,jsonb) to service_role;

-- a schedule that is already on moves to the new hours
do $s$ declare s wlf_private.report_settings; begin
  select * into s from wlf_private.report_settings where id=1;
  if s.enabled and s.token is not null and to_regnamespace('cron') is not null then
    begin
      -- cron.job cannot be written directly in Supabase; cron.alter_job is the supported way
      execute 'select cron.alter_job(job_id:=(select jobid from cron.job where jobname=$2), schedule:=$1)' using '0 20-23 * * *','wlf-monthly-reports';
    exception when others then
      raise notice 'Schedule not moved (%). Press Turn off, then Turn on in Storage & Backup to apply the new hours.', sqlerrm;
    end;
  end if;
end $s$;

-- ---------------------------------------------------------------- 4. error log (7 days)
create table if not exists wlf_private.client_errors(
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  user_id uuid,
  who text not null default '',
  page text not null default '',
  message text not null default '',
  detail text not null default '',
  version text not null default '',
  agent text not null default ''
);
create index if not exists client_errors_at_idx on wlf_private.client_errors(at);
create index if not exists client_errors_user_idx on wlf_private.client_errors(user_id, at);
alter table wlf_private.client_errors enable row level security;
revoke all on wlf_private.client_errors from public, anon, authenticated;

create or replace function wlf_private.log_client_error(p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare uid uuid := auth.uid(); who text;
begin
  if uid is null then return jsonb_build_object('saved',false); end if;
  delete from wlf_private.client_errors where at < now() - interval '7 days';
  -- at most 30 errors per account per hour, 5000 in total: the log can never fill the database
  if (select count(*) from wlf_private.client_errors where user_id=uid and at > now() - interval '1 hour') >= 30
     or (select count(*) from wlf_private.client_errors) >= 5000 then
    return jsonb_build_object('saved',false);
  end if;
  select coalesce(nullif(wlf_private.person_label(uid),''),email,'') into who from public.wlf_profiles where id=uid;
  insert into wlf_private.client_errors(user_id,who,page,message,detail,version,agent)
  values(uid,left(coalesce(who,''),160),left(coalesce(p->>'page',''),120),left(coalesce(nullif(p->>'message',''),'Unknown error'),500),
         left(coalesce(p->>'detail',''),2000),left(coalesce(p->>'version',''),20),left(coalesce(p->>'agent',''),200));
  return jsonb_build_object('saved',true);
end
$$;
revoke all on function wlf_private.log_client_error(jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------- 5. API wrapper + build number
do $r$ begin
  if to_regprocedure('wlf_private.rpc_before_v272(text,jsonb)') is null then
    alter function wlf_private.rpc(text,jsonb) rename to rpc_before_v272;
  end if;
end $r$;

create or replace function wlf_private.rpc(a text, args jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb; p jsonb := coalesce(args->0,'{}'); me public.wlf_profiles; target public.wlf_profiles; n integer;
begin
  if a='logClientError' then
    return wlf_private.log_client_error(p);
  end if;
  if a in ('getClientErrors','clearClientErrors') then
    select * into me from public.wlf_profiles where id=auth.uid();
    if me.id is null or me.status<>'Approved' or me.role<>'Super Admin' then raise exception 'Super Admin only'; end if;
    delete from wlf_private.client_errors where at < now() - interval '7 days';
    if a='clearClientErrors' then
      delete from wlf_private.client_errors;
      get diagnostics n = row_count;
      return jsonb_build_object('deleted',n);
    end if;
    return jsonb_build_object('total',(select count(*) from wlf_private.client_errors),
      'errors',coalesce((select jsonb_agg(jsonb_build_object('at',e.at,'who',e.who,'page',e.page,'message',e.message,'detail',e.detail,'version',e.version,'agent',e.agent) order by e.at desc)
        from (select * from wlf_private.client_errors order by at desc limit 200) e),'[]'));
  end if;
  if a='saveAppUserAccess' then
    -- v2.7.2: an account can be approved only with an Employee ID and a Section
    select * into target from public.wlf_profiles where email=lower(btrim(coalesce(p->>'email','')));
    if target.id is not null and coalesce(p->>'status','')='Approved' and target.status is distinct from 'Approved'
       and (coalesce(nullif(btrim(coalesce(p->>'empId','')),''),nullif(btrim(coalesce(target.employee_id,'')),'')) is null
            or coalesce(nullif(btrim(coalesce(p->>'section','')),''),nullif(btrim(coalesce(target.section,'')),'')) is null) then
      raise exception 'Fill in the Employee ID and the Section before approving this account.';
    end if;
  end if;
  result := wlf_private.rpc_before_v272(a,args);
  if a in ('getSession','getAppContext') and jsonb_typeof(result)='object' then
    result := result || jsonb_build_object('build','2.7.2');
  end if;
  return result;
end
$$;
revoke all on function wlf_private.rpc_before_v272(text,jsonb) from public, anon, authenticated;
revoke all on function wlf_private.rpc(text,jsonb) from public, anon;
grant execute on function wlf_private.rpc(text,jsonb) to authenticated;

notify pgrst, 'reload schema';
commit;

select to_regprocedure('wlf_private.rpc_before_v272(text,jsonb)') is not null
   and to_regclass('wlf_private.client_errors') is not null as v272_ready,
   (select count(*) from public.wlf_profiles where status='Pending' and (coalesce(employee_id,'')='' or coalesce(section,'')='')) as pending_without_id_or_section;
