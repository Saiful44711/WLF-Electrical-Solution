-- WLF Electrical Solution. Run once on the existing Damage Demand database.
-- The entire migration is transactional and can be reapplied safely.
begin;

do $$
begin
  if to_regprocedure('wlf_private.rpc_v220(text,jsonb)') is null
     or to_regclass('wlf_private.damage_demands') is null
     or (select count(*) from public.wlf_forms) <> 6 then
    raise exception 'Apply the existing six-team Technical Support and Damage Demand updates first.';
  end if;
  if to_regprocedure('wlf_private.rpc_before_workspace(text,jsonb)') is null then
    alter function wlf_private.rpc(text,jsonb) rename to rpc_before_workspace;
    alter function wlf_private.catalog() rename to catalog_before_workspace;
    alter function public.wlf_backup_admin(text,uuid,jsonb) rename to wlf_backup_admin_before_workspace;
  end if;
end
$$;

-- Extend only the live form definitions. Existing requests retain their form snapshots.
do $$
declare
  form public.wlf_forms;
  fields jsonb;
  after_project integer;
  address jsonb := '{"id":"project_address","label":"Project Address","type":"textarea","required":false,"options":[],"autoFill":"none"}';
begin
  for form in select * from public.wlf_forms
    where category in ('commissioning','aftersales','installation') order by category for update
  loop
    fields := form.schema->'fields';
    if exists(select 1 from jsonb_array_elements(fields) f
      where lower(btrim(f->>'label'))='project address') then continue; end if;
    if exists(select 1 from jsonb_array_elements(fields) f where f->>'id'='project_address') then
      raise exception 'Field ID project_address is already used in %. Review the form before applying.',form.category;
    end if;
    select ord::integer-1 into after_project
    from jsonb_array_elements(fields) with ordinality f(field,ord)
    where wlf_private.field_role(f.field)='project' order by ord limit 1;
    fields := jsonb_insert(fields,array[coalesce(after_project,-1)::text],address,true);
    perform wlf_private.form_fields(fields);
    update public.wlf_forms set schema=jsonb_set(schema,'{fields}',fields),revision=revision+1
      where category=form.category;
  end loop;
end
$$;

create or replace function wlf_private.catalog()
returns jsonb language sql stable security definer set search_path='' as $$
  select wlf_private.catalog_before_workspace() || '[
    {"key":"qms:components","label":"Component Tracking / View and record","group":"QMS"},
    {"key":"workspace:dashboard","label":"Dashboard / View team performance and export","group":"Workspace Dashboard"}
  ]'::jsonb
$$;

-- Keep the stable profile ID referenced by work records after the Auth login is removed.
-- SET NULL and the profile trigger run in the same transaction as Auth deletion.
alter table wlf_private.deleting_users
  add column if not exists reserved_by uuid,
  add column if not exists reserved_at timestamptz;
do $$
begin
  if not exists(select 1 from pg_attribute where attrelid='public.wlf_profiles'::regclass
      and attname='auth_user_id' and not attisdropped) then
    alter table public.wlf_profiles add column auth_user_id uuid;
    alter table public.wlf_profiles disable trigger wlf_deletion_guard;
    update public.wlf_profiles set auth_user_id=id;
    alter table public.wlf_profiles enable trigger wlf_deletion_guard;
    alter table public.wlf_profiles drop constraint wlf_profiles_id_fkey;
    alter table public.wlf_profiles
      add constraint wlf_profiles_auth_user_id_key unique(auth_user_id),
      add constraint wlf_profiles_auth_user_id_fkey foreign key(auth_user_id) references auth.users(id) on delete set null,
      add constraint wlf_profiles_auth_identity check(
        (auth_user_id is not null and auth_user_id=id)
        or (auth_user_id is null and status='Rejected' and cardinality(permissions)=0)
      );
  end if;
end
$$;

create or replace function wlf_private.new_user()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  insert into public.wlf_profiles(id,auth_user_id,email,name) values(
    new.id,new.id,lower(new.email),
    left(coalesce(nullif(new.raw_user_meta_data->>'name',''),split_part(new.email,'@',1)),120));
  return new;
end
$$;

create or replace function wlf_private.deletion_guard()
returns trigger language plpgsql security definer set search_path='' as $$
declare admin_id uuid;
begin
  if old.auth_user_id is null then raise exception 'This account was deleted.'; end if;
  select reserved_by into admin_id from wlf_private.deleting_users
    where id=old.id and reserved_at > now()-interval '15 minutes';
  if new.auth_user_id is null then
    -- An Auth account can also be removed by its project administrator.
    new.status := 'Rejected';
    new.permissions := '{}';
    new.access_revision := old.access_revision+1;
    new.email := 'deleted/'||old.id;

    -- Retain prior assignee/solver history and return open work to the queue.
    with returned as (
      update public.wlf_requests set assigned_to=null,status='Pending',updated_at=now(),revision=revision+1
      where assigned_to=old.id and deleted_at is null and status<>'Solved' returning id
    )
    insert into public.wlf_history(request_id,actor,action,comment)
    select id,coalesce(admin_id,old.id),'assignee account closed','Returned to Pending after assignee account deletion.'
    from returned;
    delete from wlf_private.deleting_users where id=old.id;
  elsif admin_id is not null then
    raise exception 'Account deletion in progress.';
  end if;
  return new;
end
$$;

drop policy if exists wlf_profile_read on public.wlf_profiles;
create policy wlf_profile_read on public.wlf_profiles for select to authenticated
  using(auth_user_id is not null and (id=(select auth.uid()) or (select wlf_private.super())));

create or replace function public.wlf_backup_admin(action text,actor uuid,payload jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
declare target uuid;
begin
  if action not in ('reserveDeleteUser','releaseDeleteUser') then
    return public.wlf_backup_admin_before_workspace(action,actor,payload);
  end if;
  if not exists(select 1 from public.wlf_profiles p
    where p.id=actor and p.auth_user_id is not null and p.status='Approved' and p.role='Super Admin') then
    raise exception 'Super Admin only';
  end if;
  if action='releaseDeleteUser' then
    delete from wlf_private.deleting_users where id=(payload->>'id')::uuid and reserved_by=actor;
    return 'true';
  end if;
  select p.id into target from public.wlf_profiles p
    where p.email=lower(btrim(payload->>'email')) and p.status='Rejected' and p.auth_user_id is not null
      and p.id<>actor for update;
  if not found then raise exception 'Only rejected users can be deleted'; end if;
  insert into wlf_private.deleting_users(id,reserved_by,reserved_at) values(target,actor,now())
    on conflict(id) do update set reserved_by=excluded.reserved_by,reserved_at=excluded.reserved_at
    where wlf_private.deleting_users.reserved_at is null
      or wlf_private.deleting_users.reserved_at<=now()-interval '15 minutes';
  if not found then raise exception 'Account deletion in progress. Refresh the user list.'; end if;
  return jsonb_build_object('id',target);
end
$$;

-- QMS starts with a shared project component register. The creator and Super Admin
-- can edit records, with revision and operation checks on the server.
create table if not exists wlf_private.qms_components (
  id uuid primary key,
  owner uuid not null references public.wlf_profiles(id),
  project text not null check(length(project) between 1 and 180),
  lift_id text not null check(length(lift_id)<=120),
  component text not null check(length(component) between 1 and 180),
  item_code text not null check(length(item_code)<=120),
  model text not null check(length(model)<=180),
  quantity integer not null check(quantity between 1 and 999999),
  status text not null check(status in ('Planned','In progress','Verified')),
  note text not null check(length(note)<=2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revision integer not null default 1,
  last_operation uuid not null,
  last_payload_hash bytea not null
);
alter table wlf_private.qms_components enable row level security;
revoke all on wlf_private.qms_components from public,anon,authenticated,service_role;
create index if not exists wlf_qms_created_idx on wlf_private.qms_components(created_at desc,id desc);

create or replace function wlf_private.qms_component_row(r wlf_private.qms_components, u public.wlf_profiles)
returns jsonb language sql stable set search_path='' as $$
  select to_jsonb(r)-'last_operation'-'last_payload_hash'-'owner' || jsonb_build_object(
    'ownerName',(select name from public.wlf_profiles where id=r.owner),
    'canEdit',r.owner=u.id or u.role='Super Admin')
$$;

create or replace function wlf_private.qms_components_api(a text,p jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare
  u public.wlf_profiles := wlf_private.me();
  r wlf_private.qms_components;
  rows jsonb;
  row_id uuid;
  op uuid;
  signature bytea;
  project_name text := btrim(coalesce(p->>'project',''));
  component_name text := btrim(coalesce(p->>'component',''));
  qty text := p->>'quantity';
  prior_revision integer;
begin
  if not wlf_private.ri_enabled('qms:components') then raise exception 'QMS Component Tracking access required'; end if;
  if a='getQmsComponents' then
    select coalesce(jsonb_agg(wlf_private.qms_component_row(x,u) order by x.created_at desc,x.id desc),'[]') into rows
    from (
      select c.* from wlf_private.qms_components c
      where position(lower(left(project_name,180)) in lower(c.project))>0
        and (coalesce(p->>'status','')='' or c.status=p->>'status')
        and (nullif(p->>'beforeAt','') is null or (c.created_at,c.id)<((p->>'beforeAt')::timestamptz,(p->>'beforeId')::uuid))
      order by c.created_at desc,c.id desc limit 26
    ) x;
    return jsonb_build_object('rows',case when jsonb_array_length(rows)>25 then rows-25 else rows end,
      'hasMore',jsonb_array_length(rows)>25);
  end if;

  row_id := (p->>'id')::uuid;
  op := (p->>'operation')::uuid;
  prior_revision := (p->>'revision')::integer;
  signature := sha256(convert_to(p::text,'UTF8'));
  if row_id is null or op is null then raise exception 'Missing record or operation ID.'; end if;
  if length(project_name) not between 1 and 180 or length(component_name) not between 1 and 180 then
    raise exception 'Enter a project name and component name.';
  end if;
  if coalesce(qty,'') !~ '^[1-9][0-9]{0,5}$' then raise exception 'Quantity must be a whole number from 1 to 999999.'; end if;
  if coalesce(p->>'status','') not in ('Planned','In progress','Verified') then raise exception 'Select a tracking status.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('wlf-qms-component:'||row_id,0));
  select * into r from wlf_private.qms_components where id=row_id for update;
  if found then
    if r.owner<>u.id and u.role<>'Super Admin' then raise exception 'Only the creator or Super Admin can edit this record.'; end if;
    if r.last_operation=op then
      if r.last_payload_hash<>signature then raise exception 'Operation ID reused with different data.'; end if;
      return wlf_private.qms_component_row(r,u);
    end if;
    if r.revision is distinct from prior_revision then raise exception 'CONFLICT: Component record changed. Refresh and review.'; end if;
    update wlf_private.qms_components set project=project_name,component=component_name,
      lift_id=btrim(coalesce(p->>'lift_id','')),item_code=btrim(coalesce(p->>'item_code','')),
      model=btrim(coalesce(p->>'model','')),quantity=qty::integer,status=p->>'status',note=btrim(coalesce(p->>'note','')),
      updated_at=now(),revision=revision+1,last_operation=op,last_payload_hash=signature
    where id=row_id returning * into r;
  else
    if prior_revision is distinct from 0 then raise exception 'Component record no longer available.'; end if;
    insert into wlf_private.qms_components(id,owner,project,component,lift_id,item_code,model,quantity,status,note,last_operation,last_payload_hash)
    values(row_id,u.id,project_name,component_name,btrim(coalesce(p->>'lift_id','')),btrim(coalesce(p->>'item_code','')),
      btrim(coalesce(p->>'model','')),qty::integer,p->>'status',btrim(coalesce(p->>'note','')),op,signature)
    returning * into r;
  end if;
  return wlf_private.qms_component_row(r,u);
end
$$;

-- Reporting uses the same option gates as the source workspaces.
create or replace function wlf_private.workspace_sections(own boolean)
returns table(section text,label text) language sql stable set search_path='' as $$
  select v.section,v.label from (values
    ('support','Technical Support',exists(select 1 from wlf_private.support_teams() t where wlf_private.team(t.id))),
    ('activity','R&I Team Activity',wlf_private.ri_enabled('ri:activity')),
    ('projects','R&I Project Manager',wlf_private.ri_enabled('ri:projects')),
    ('damage','Damage Demand',wlf_private.ri_enabled('damage:dashboard') or
      (own and (wlf_private.ri_enabled('damage:demand') or (wlf_private.me()).role='R&I'))),
    ('qms','QMS',wlf_private.ri_enabled('qms:components')),
    ('selection','Component Selection',wlf_private.can('selection')),
    ('calculations','Calculations',exists(select 1 from unnest(array['travel','power','speed','motor','energy','solar']) x where wlf_private.can('calc:'||x))),
    ('troubleshooting','Troubleshooting',exists(
      select 1 from public.wlf_troubleshooting t where not t.deleted and wlf_private.can(
        case when t.controller='GENERAL' then 'tb:general:'||t.id
        when t.content->>'kind'='procedure' then 'tb:option:'||t.id else 'tb:'||t.controller||':error' end))),
    ('documents','Documents Links',wlf_private.approved())
  ) v(section,label,allowed) where v.allowed
$$;

create or replace function wlf_private.workspace_activity(own boolean, since_at timestamptz, until_at timestamptz)
returns table(actor uuid,happened_at timestamptz,section text,entry text,outcome text,minutes numeric,completed boolean)
language sql stable set search_path='' as $$
  with viewer as (select * from wlf_private.me()), allowed as materialized (
    select s.section from wlf_private.workspace_sections(own) s
  ), support as not materialized (
    select r.* from public.wlf_requests r cross join viewer u
    where r.deleted_at is null and exists(select 1 from allowed a where a.section='support')
      and wlf_private.team(r.category) and (u.role<>'User' or r.created_by=u.id)
  ), usage_codes(action,option_key,section) as (values
    ('Component Selection','selection','selection'),
    ('Travel Time Calculation','calc:travel','calculations'),
    ('Power Calculation','calc:power','calculations'),
    ('Speed & Slip Calculation','calc:speed','calculations'),
    ('Motor Power Justification','calc:motor','calculations'),
    ('Energy Bill Calculation','calc:energy','calculations'),
    ('Solar Sizing Calculation','calc:solar','calculations')
  ), entries(actor,happened_at,section,entry,outcome,minutes,completed) as not materialized (
    select r.created_by,r.created_at,'support',r.reference||' · '||t.title,'Submitted',null::numeric,false
    from support r join wlf_private.support_teams() t on t.id=r.category
    union all
    select h.actor,h.at,'support',r.reference||' · '||t.title,
      case h.action when 'receive' then 'Received' when 'solve' then 'Solved' when 'notSolved' then 'Not Solved'
      when 'forward' then 'Forwarded' else 'Kept pending' end,
      case when h.action='solve' and h.actor=r.solved_by and h.at=r.solved_at then r.duration_minutes end,
      h.action='solve'
    from public.wlf_history h join support r on r.id=h.request_id
    join wlf_private.support_teams() t on t.id=r.category
    where h.action in ('receive','solve','notSolved','forward','pending')
    union all
    select e.owner,e.created_at,'activity',coalesce(
      (select nullif(e.values->>(f->>'id'),'')||' · '||c.name
        from jsonb_array_elements(e.form_schema->'fields') f
        where lower(btrim(f->>'label')) in ('task name','project name','report title')
          and coalesce(e.values->>(f->>'id'),'')<>'' limit 1),c.name),e.status,
      (select (e.values->>(f->>'id'))::numeric
        from jsonb_array_elements(e.form_schema->'fields') f
        where lower(regexp_replace(f->>'label','[^a-zA-Z]','','g')) in ('durationmin','durationminute','durationminutes')
          and (e.values->>(f->>'id')) ~ '^[0-9]{1,8}([.][0-9]{1,2})?$' limit 1),
      e.status in ('Completed','Solved','Done')
    from public.wlf_ri_entries e join public.wlf_ri_categories c on c.id=e.category
    where e.deleted_at is null and exists(select 1 from allowed a where a.section='activity')
    union all
    select r.owner,r.created_at,'projects',r.data->>'name',r.data->>'status',null::numeric,r.data->>'status'='Done'
    from public.wlf_ri_projects r where r.deleted_at is null and exists(select 1 from allowed a where a.section='projects')
    union all
    select e.actor,e.event_at,'damage','DD-'||d.demand_no||' · '||d.item_name,e.outcome,null::numeric,e.outcome='Received'
    from wlf_private.damage_demands d cross join lateral
      (values(d.confirmed_by,d.created_at,'Demand raised'),(d.received_by,d.received_at,'Received')) e(actor,event_at,outcome)
    where e.event_at is not null and exists(select 1 from allowed a where a.section='damage')
    union all
    select q.owner,q.created_at,'qms',q.project||' · '||q.component,q.status,null::numeric,q.status='Verified'
    from wlf_private.qms_components q where exists(select 1 from allowed a where a.section='qms')
    union all
    select l.actor,l.at,k.section,l.action,'Used',null::numeric,false
    from public.wlf_usage l join usage_codes k on k.action=l.action
    where wlf_private.can(k.option_key)
    union all
    select l.actor,l.at,'troubleshooting',l.action,'Viewed',null::numeric,false
    from public.wlf_usage l where l.action like 'Troubleshooting / %' and exists(
      select 1 from public.wlf_troubleshooting t
      where not t.deleted and t.controller=split_part(l.action,' / ',2)
        and (case when t.controller='GENERAL' or t.content->>'kind'='procedure'
          then t.content->>'category' else 'Error Solution' end)=split_part(l.action,' / ',3)
        and wlf_private.can(case when t.controller='GENERAL' then 'tb:general:'||t.id
          when t.content->>'kind'='procedure' then 'tb:option:'||t.id else 'tb:'||t.controller||':error' end))
    union all
    select l.actor,l.at,'documents',l.details,'Link opened',null::numeric,false
    from public.wlf_usage l where l.action='Documents Links'
      and exists(select 1 from allowed a where a.section='documents')
  )
  select e.* from entries e cross join viewer u
  where (not own or e.actor=u.id)
    and (since_at is null or e.happened_at>=since_at)
    and (until_at is null or e.happened_at<until_at)
$$;

create or replace function wlf_private.workspace_insights(a text,p jsonb)
returns jsonb language plpgsql stable set search_path='' as $$
declare
  u public.wlf_profiles := wlf_private.me();
  own boolean := a='getMyWorkspaceProfile';
  full_report boolean := a='getWorkspaceReport';
  from_date date := nullif(p->>'from','')::date;
  to_date date := nullif(p->>'to','')::date;
  member_id uuid := nullif(p->>'member','')::uuid;
  section_key text := coalesce(p->>'section','');
  row_offset integer := greatest(0,coalesce((p->>'offset')::integer,0));
  month_at timestamptz := date_trunc('month',now() at time zone 'Asia/Dhaka') at time zone 'Asia/Dhaka';
  result jsonb;
begin
  if not own and not wlf_private.ri_enabled('workspace:dashboard') then
    raise exception 'Workspace Dashboard access required';
  end if;
  if own then
    from_date := null;
    to_date := null;
    member_id := u.id;
    section_key := '';
  end if;
  if from_date>to_date then raise exception 'From date must be on or before To date.'; end if;
  if section_key<>'' and not exists(select 1 from wlf_private.workspace_sections(own) s where s.section=section_key) then
    raise exception 'You do not have access to that section.';
  end if;

  with available as materialized (select * from wlf_private.workspace_sections(own)),
  events as materialized (
    select e.* from wlf_private.workspace_activity(own,from_date::timestamp at time zone 'Asia/Dhaka',
      (to_date+1)::timestamp at time zone 'Asia/Dhaka') e
    where section_key='' or e.section=section_key
  ), filtered as materialized (
    select e.* from events e where member_id is null or e.actor=member_id
  ), modules as (
    select s.section,s.label,count(e.section) as activities,count(*) filter(where e.completed) as completed,
      coalesce(sum(e.minutes),0) as minutes
    from available s left join filtered e on e.section=s.section
    where section_key='' or s.section=section_key group by s.section,s.label
  ), totals as (
    select count(*) as activities,count(distinct actor) as members,
      count(*) filter(where completed) as completed,coalesce(sum(minutes),0) as minutes,
      min(happened_at) as first_at,max(happened_at) as last_at,
      count(*) filter(where happened_at>=month_at and happened_at<=now()) as month_activities,
      coalesce(sum(minutes) filter(where happened_at>=month_at and happened_at<=now()),0) as month_minutes
    from filtered
  ), members as (
    select p.id,p.name,p.role,count(*) as activities,count(*) filter(where e.completed) as completed,
      coalesce(sum(e.minutes),0) as minutes,max(e.happened_at) as last_at
    from filtered e join public.wlf_profiles p on p.id=e.actor group by p.id
  ), people as (
    select distinct p.id,p.name,p.role from events e join public.wlf_profiles p on p.id=e.actor
  ), weeks as (
    select date_trunc('week',e.happened_at at time zone 'Asia/Dhaka')::date as week,
      count(*) as activities,coalesce(sum(e.minutes),0) as minutes
    from filtered e group by week order by week desc limit 12
  ), recent as (
    select e.happened_at,e.section,e.entry,e.outcome,e.minutes,p.name
    from filtered e join public.wlf_profiles p on p.id=e.actor
    order by e.happened_at desc,e.section,e.entry,e.outcome,e.actor
    limit case when full_report then 2500 else 25 end offset case when full_report then 0 else row_offset end
  ), previous as (
    select count(*) as activities,count(distinct e.actor) as members,
      count(*) filter(where e.completed) as completed,coalesce(sum(e.minutes),0) as minutes
    from wlf_private.workspace_activity(false,
      (from_date-(to_date-from_date+1))::timestamp at time zone 'Asia/Dhaka',
      from_date::timestamp at time zone 'Asia/Dhaka') e
    where (section_key='' or e.section=section_key) and (member_id is null or e.actor=member_id)
  )
  select jsonb_build_object(
    'totals',to_jsonb(t),
    'previous',case when not own and from_date is not null and to_date is not null then (select to_jsonb(v) from previous v) end,
    'sections',coalesce((select jsonb_agg(to_jsonb(s) order by s.label) from available s),'[]'),
    'modules',coalesce((select jsonb_agg(to_jsonb(m) order by m.activities desc,m.label) from modules m),'[]'),
    'members',coalesce((select jsonb_agg(to_jsonb(m) order by m.activities desc,m.name,m.id) from members m),'[]'),
    'people',coalesce((select jsonb_agg(to_jsonb(m) order by m.name,m.id) from people m),'[]'),
    'weeks',coalesce((select jsonb_agg(to_jsonb(w) order by w.week) from weeks w),'[]'),
    'recent',coalesce((select jsonb_agg(to_jsonb(r) order by r.happened_at desc,r.section,r.entry,r.outcome) from recent r),'[]')
  ) into result from totals t;
  if full_report and (result->'totals'->>'activities')::bigint>2500 then
    raise exception 'More than 2500 activities match. Choose a shorter date range or a section.';
  end if;
  if own then
    result := result||jsonb_build_object(
      'profile',jsonb_build_object('name',u.name,'email',u.email,'role',u.role,'status',u.status,
        'joinedAt',u.created_at,'lastSignIn',(select last_sign_in_at from auth.users where id=u.auth_user_id)),
      'projects',case when wlf_private.ri_enabled('ri:projects') then (
        select jsonb_build_object(
          'led',count(*) filter(where data->>'lead'=u.id::text),
          'collaborating',count(*) filter(where data->'collaborators' ? u.id::text),
          'completed',count(*) filter(where data->>'status'='Done'),
          'active',count(*) filter(where data->>'status' in ('In Progress','On Hold')))
        from public.wlf_ri_projects r where r.deleted_at is null and (r.owner=u.id or data->>'lead'=u.id::text
          or data->'collaborators' ? u.id::text
          or exists(select 1 from jsonb_array_elements(r.data->'tasks') t where t->>'owner'=u.id::text))
      ) end);
  end if;
  return result;
end
$$;

create or replace function wlf_private.rpc(a text,args jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  p jsonb := coalesce(args->0,'{}');
  result jsonb;
  selected jsonb;
  doc_name text;
begin
  if not wlf_private.approved() then raise exception 'SESSION_EXPIRED: Account is pending approval or inactive'; end if;
  if octet_length(args::text)>100000 then raise exception 'Request too large'; end if;
  if a in ('getQmsComponents','saveQmsComponent') then
    return wlf_private.qms_components_api(a,p);
  elsif a in ('getMyWorkspaceProfile','getWorkspaceDashboard','getWorkspaceReport') then
    return wlf_private.workspace_insights(a,p);
  elsif a in ('listAppUsers','adminListUsers') then
    if not wlf_private.super() then raise exception 'Permission denied: Super Admin only'; end if;
    return jsonb_build_object('users',coalesce((select jsonb_agg(wlf_private.safe_user(u) order by u.created_at)
      from public.wlf_profiles u where u.auth_user_id is not null),'[]'),'catalog',wlf_private.catalog());
  elsif a='getDamageDashboard' and p->>'status' in ('Pending','Received') then
    selected := wlf_private.damage_demands_api(a,p);
    result := wlf_private.damage_demands_api(a,p-'status'-'cursor');
    return result||jsonb_build_object('rows',selected->'rows','nextCursor',selected->'nextCursor','pageTotal',selected->'total');
  elsif a='logAction' and args->>0='Documents Links' then
    select name into doc_name from public.wlf_documents where id=(args->>1)::uuid;
    if not found then raise exception 'Document link no longer available.'; end if;
    insert into public.wlf_usage(actor,action,details) values(auth.uid(),'Documents Links',doc_name);
    return 'true';
  end if;
  result := wlf_private.rpc_before_workspace(a,args);
  if a in ('getSession','getAppContext') then return result||jsonb_build_object('workspaceUpdate',true); end if;
  return result;
end
$$;

revoke all on function public.wlf_backup_admin_before_workspace(text,uuid,jsonb),
  public.wlf_backup_admin(text,uuid,jsonb),wlf_private.rpc_before_workspace(text,jsonb),
  wlf_private.catalog_before_workspace(),wlf_private.catalog(),
  wlf_private.qms_component_row(wlf_private.qms_components,public.wlf_profiles),wlf_private.qms_components_api(text,jsonb),
  wlf_private.workspace_sections(boolean),wlf_private.workspace_activity(boolean,timestamptz,timestamptz),
  wlf_private.workspace_insights(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.wlf_backup_admin(text,uuid,jsonb) to service_role;
revoke all on function wlf_private.rpc(text,jsonb) from public,anon;
grant execute on function wlf_private.rpc(text,jsonb) to authenticated;
-- Refresh the existing invoker endpoint so it resolves the new dispatch function.
create or replace function public.wlf_rpc(action text,args jsonb default '[]')
returns jsonb language sql security invoker set search_path='' as $$select wlf_private.rpc(action,args)$$;
notify pgrst,'reload schema';
commit;

select
  (select count(*)=3 from public.wlf_forms f where f.category in ('commissioning','aftersales','installation')
    and exists(select 1 from jsonb_array_elements(f.schema->'fields') x where lower(btrim(x->>'label'))='project address')) as project_address_ready,
  to_regprocedure('wlf_private.workspace_insights(text,jsonb)') is not null as dashboard_and_profile_ready,
  not has_table_privilege('authenticated','wlf_private.qms_components','select') as qms_private,
  has_function_privilege('service_role','public.wlf_backup_admin(text,uuid,jsonb)','execute')
    and not has_function_privilege('authenticated','public.wlf_backup_admin(text,uuid,jsonb)','execute') as deletion_server_only;
