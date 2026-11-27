-- WLF v2.7.0 · Monthly reports (Technical Support, R&I Team Activity, Damage Demand) saved to Google Drive every month.
-- Requires UPDATE_V268.sql (v2.6.8). v2.6.9 has no SQL. Safe to run again. Nothing existing is changed or deleted.
-- The schedule uses the Supabase extensions pg_cron and pg_net. This file tries to switch them on; if your project
-- does not allow it, switch them on in Database > Extensions and run this file again.
begin;

do $c$ begin
  if to_regprocedure('wlf_private.rpc_before_v268(text,jsonb)') is null then
    raise exception 'Run UPDATE_V268.sql first (v2.6.8 is not installed).';
  end if;
end $c$;

-- ---------------------------------------------------------------- 1. scheduler extensions (optional here, checked again when the schedule is turned on)
do $x$ begin
  begin create extension if not exists pg_cron; exception when others then raise notice 'pg_cron could not be enabled here: %', sqlerrm; end;
  begin create extension if not exists pg_net; exception when others then raise notice 'pg_net could not be enabled here: %', sqlerrm; end;
end $x$;

-- ---------------------------------------------------------------- 2. report list and schedule settings
create table if not exists wlf_private.monthly_reports(
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('support','activity','damage')),
  month date not null check (extract(day from month)=1),
  file_id text not null check (file_id ~ '^[-a-zA-Z0-9_]{5,200}$'),
  file_name text not null,
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  records integer not null default 0,
  source text not null check (source in ('schedule','manual')),
  actor uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (kind, month)
);
alter table wlf_private.monthly_reports enable row level security;
revoke all on wlf_private.monthly_reports from public, anon, authenticated;

create table if not exists wlf_private.report_settings(
  id integer primary key default 1 check (id=1),
  enabled boolean not null default false,
  token text,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  last_check timestamptz,
  last_error text
);
insert into wlf_private.report_settings(id) values (1) on conflict (id) do nothing;
alter table wlf_private.report_settings enable row level security;
revoke all on wlf_private.report_settings from public, anon, authenticated;

-- first day of a month from 'YYYY-MM'
create or replace function wlf_private.report_month(m text) returns date
language plpgsql immutable set search_path='' as $$
declare d date;
begin
  if coalesce(m,'') !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then raise exception 'Choose a month (YYYY-MM).'; end if;
  d := (m||'-01')::date;
  if d < date '2024-01-01' then raise exception 'Choose a month from 2024 on.'; end if;
  return d;
end
$$;

-- the last complete month in Bangladesh time
create or replace function wlf_private.report_last_month() returns date
language sql stable set search_path='' as $$
  select (date_trunc('month', now() at time zone 'Asia/Dhaka') - interval '1 month')::date
$$;

-- ---------------------------------------------------------------- 3. data of one month for one report
create or replace function wlf_private.report_data(kind text, mon date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare t_from timestamptz := (mon::timestamp) at time zone 'Asia/Dhaka';
        t_to timestamptz := ((mon + interval '1 month')::timestamp) at time zone 'Asia/Dhaka';
        rows_json jsonb; extra jsonb := '{}';
begin
  if kind='support' then
    select coalesce(jsonb_agg(jsonb_build_object(
        'reference',r.reference,'at',r.created_at,'team',r.category,'status',r.status,
        'requester',wlf_private.person_label(r.created_by),'requesterSection',coalesce(p.section,''),
        'assignee',wlf_private.person_label(r.assigned_to),'solver',wlf_private.person_label(r.solved_by),'solvedAt',r.solved_at,
        'solution',r.solution,'values',r.values,'schema',r.form_schema,
        'forwards',(select count(*) from public.wlf_history hh where hh.request_id=r.id and hh.action='forward'))
        order by r.created_at, r.id),'[]') into rows_json
    from public.wlf_requests r left join public.wlf_profiles p on p.id=r.created_by
    where r.deleted_at is null and r.created_at>=t_from and r.created_at<t_to;
    select jsonb_build_object(
      'teams',(select jsonb_agg(jsonb_build_object('id',t.id,'name',replace(t.title,' Support Request','')) order by t.sort_order) from wlf_private.support_teams() t),
      'given',coalesce((select jsonb_agg(x order by x->>'name') from (
          select jsonb_build_object('name',wlf_private.person_label(h.actor),
            'received',count(*) filter (where h.action='receive'),'solved',count(*) filter (where h.action='solve'),
            'notSolved',count(*) filter (where h.action='notSolved'),'forwarded',count(*) filter (where h.action='forward')) x
          from public.wlf_history h join public.wlf_requests r on r.id=h.request_id and r.deleted_at is null
          where h.at>=t_from and h.at<t_to and h.action in ('receive','solve','notSolved','forward')
          group by h.actor) g),'[]')) into extra;
  elsif kind='activity' then
    select coalesce(jsonb_agg(jsonb_build_object(
        'at',e.created_at,'sector',c.section,'form',c.name,'status',e.status,
        'member',coalesce(nullif(wlf_private.person_label(e.owner),''),e.author_name),
        'minutes',wlf_private.entry_minutes(e.values),'values',e.values,'schema',e.form_schema)
        order by e.created_at, e.id),'[]') into rows_json
    from public.wlf_ri_entries e join public.wlf_ri_categories c on c.id=e.category
    where e.deleted_at is null and e.created_at>=t_from and e.created_at<t_to;
  elsif kind='damage' then
    select coalesce(jsonb_agg(jsonb_build_object(
        'reference','DD-'||d.demand_no,'at',d.created_at,'team',d.category,'requester',d.requester_name,
        'project',d.project,'liftId',d.lift_id,'controllers',to_jsonb(d.controllers),'problems',to_jsonb(d.problem_categories),
        'item',d.item_name,'spec',d.item_spec,'model',coalesce(d.component_model,''),'brand',coalesce(d.brand,''),
        'supplier',coalesce(d.supplier,''),'quantity',d.quantity,'confirmedBy',d.confirmed_name,
        'received',d.received_at is not null,'claimed',d.claim_at is not null)
        order by d.created_at, d.demand_no),'[]') into rows_json
    from wlf_private.damage_demands d
    where d.created_at>=t_from and d.created_at<t_to;
    select jsonb_build_object('teams',(select jsonb_agg(jsonb_build_object('id',t.id,'name',replace(t.title,' Support Request','')) order by t.sort_order)
      from wlf_private.support_teams() t where t.id in ('commissioning','aftersales','installation','maintenance'))) into extra;
  else
    raise exception 'Unknown report';
  end if;
  if jsonb_array_length(rows_json)>20000 then raise exception 'Too many records in one month for one report.'; end if;
  return jsonb_build_object('kind',kind,'month',to_char(mon,'YYYY-MM'),'from',t_from,'to',t_to,'records',rows_json) || extra;
end
$$;
revoke all on function wlf_private.report_data(text,date) from public, anon, authenticated;

-- ---------------------------------------------------------------- 4. service function used only by the wlf-maintenance Edge Function
create or replace function public.wlf_report_admin(action text, actor uuid, payload jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
declare s wlf_private.report_settings; mon date; k text; out jsonb; job_url text; cmd text; removed integer;
begin
  select * into s from wlf_private.report_settings where id=1;
  if actor is null then
    -- the monthly schedule: the token stored here must come back with the call
    if not coalesce(s.enabled,false) or s.token is null or payload->>'token' is distinct from s.token then
      raise exception 'Monthly report schedule is not allowed';
    end if;
    if action not in ('pending','data','saved','checked') then raise exception 'Not allowed for the schedule'; end if;
  elsif not exists(select 1 from public.wlf_profiles where id=actor and status='Approved' and role='Super Admin') then
    raise exception 'Super Admin only';
  end if;

  if action='status' then
    return jsonb_build_object('enabled',s.enabled,'lastCheck',s.last_check,'lastError',s.last_error,
      'cronReady',to_regnamespace('cron') is not null,'netReady',to_regnamespace('net') is not null,
      'lastMonth',to_char(wlf_private.report_last_month(),'YYYY-MM'));
  elsif action='history' then
    return coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'kind',r.kind,'month',to_char(r.month,'YYYY-MM'),'fileId',r.file_id,
        'fileName',r.file_name,'records',r.records,'source',r.source,'createdAt',r.created_at,'updatedAt',r.updated_at)
        order by r.month desc, array_position(array['support','activity','damage'],r.kind))
      from (select * from wlf_private.monthly_reports order by month desc limit 120) r),'[]');
  elsif action='pending' then
    mon := wlf_private.report_last_month();
    return jsonb_build_object('month',to_char(mon,'YYYY-MM'),'kinds',coalesce((select jsonb_agg(x.k order by x.o) from (values ('support',1),('activity',2),('damage',3)) x(k,o)
      where not exists(select 1 from wlf_private.monthly_reports r where r.kind=x.k and r.month=mon)),'[]'));
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
    if coalesce((payload->>'enable')::boolean,false) then
      if to_regnamespace('cron') is null or to_regnamespace('net') is null then
        raise exception 'Turn on the extensions pg_cron and pg_net first (Supabase: Database > Extensions), then try again.';
      end if;
      job_url := payload->>'url';
      if coalesce(job_url,'') !~ '^https://[a-z0-9-]+\.supabase\.co/functions/v1/wlf-maintenance$' then raise exception 'Schedule address rejected'; end if;
      update wlf_private.report_settings set enabled=true,token=encode(extensions.gen_random_bytes(24),'hex'),updated_at=now(),updated_by=actor,last_error=null
        where id=1 returning * into s;
      cmd := format('select net.http_post(url:=%L, headers:=jsonb_build_object(%L,%L,%L,%L), body:=jsonb_build_object(%L,%L,%L,jsonb_build_object(%L,%L)), timeout_milliseconds:=120000)',
        job_url,'Content-Type','application/json','x-wlf-cron',s.token,'action','monthlyReports','payload','token',s.token);
      -- every night at 02:00 Bangladesh time (20:00 UTC); only the month that is still missing is made, so a failed night is retried the next night
      execute 'select cron.schedule($1,$2,$3)' using 'wlf-monthly-reports','0 20 * * *',cmd;
    else
      update wlf_private.report_settings set enabled=false,token=null,updated_at=now(),updated_by=actor where id=1;
      if to_regnamespace('cron') is not null then
        execute 'select cron.unschedule(jobid) from cron.job where jobname=$1' using 'wlf-monthly-reports';
      end if;
    end if;
    select * into s from wlf_private.report_settings where id=1;
    return jsonb_build_object('enabled',s.enabled);
  end if;
  raise exception 'Unsupported report action';
end
$$;
revoke all on function public.wlf_report_admin(text,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.wlf_report_admin(text,uuid,jsonb) to service_role;

-- ---------------------------------------------------------------- 5. build number
do $r$ begin
  if to_regprocedure('wlf_private.rpc_before_v270(text,jsonb)') is null then
    alter function wlf_private.rpc(text,jsonb) rename to rpc_before_v270;
  end if;
end $r$;

create or replace function wlf_private.rpc(a text, args jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  result := wlf_private.rpc_before_v270(a,args);
  if a in ('getSession','getAppContext') and jsonb_typeof(result)='object' then
    result := result || jsonb_build_object('build','2.7.0');
  end if;
  return result;
end
$$;
revoke all on function wlf_private.rpc_before_v270(text,jsonb) from public, anon, authenticated;
revoke all on function wlf_private.rpc(text,jsonb) from public, anon;
grant execute on function wlf_private.rpc(text,jsonb) to authenticated;

notify pgrst, 'reload schema';
commit;

select to_regprocedure('wlf_private.rpc_before_v270(text,jsonb)') is not null
   and to_regprocedure('public.wlf_report_admin(text,uuid,jsonb)') is not null as v270_ready;
