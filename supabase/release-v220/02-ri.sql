create table if not exists public.wlf_ri_categories (
  id text primary key check(id ~ '^[-a-z0-9]{2,100}$'),
  section text not null check(section in ('team','scm','sales','reports')),
  name text not null check(length(name) between 1 and 120),
  position integer not null default 0,
  schema jsonb not null,
  active boolean not null default true,
  revision integer not null default 1
);
create unique index if not exists wlf_ri_active_category_name on public.wlf_ri_categories(section,lower(name)) where active;
create table if not exists public.wlf_ri_entries (
  id uuid primary key,
  category text not null references public.wlf_ri_categories(id),
  owner uuid not null references public.wlf_profiles(id),
  author_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  status text not null,
  form_schema jsonb not null,
  values jsonb not null,
  deleted_at timestamptz,
  revision integer not null default 1,
  last_operation uuid not null,
  last_payload_hash text not null
);
create index if not exists wlf_ri_entries_category_idx on public.wlf_ri_entries(category,created_at desc,id) where deleted_at is null;
create table if not exists public.wlf_ri_projects (
  id uuid primary key,
  owner uuid not null references public.wlf_profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  data jsonb not null,
  revision integer not null default 1,
  last_operation uuid not null,
  last_payload_hash text not null,
  deleted_at timestamptz
);
create index if not exists wlf_ri_projects_active_idx on public.wlf_ri_projects(created_at desc,id) where deleted_at is null;
create table if not exists wlf_private.ri_entry_archive (id uuid primary key);
alter table public.wlf_ri_categories enable row level security;
alter table public.wlf_ri_entries enable row level security;
alter table public.wlf_ri_projects enable row level security;
alter table wlf_private.ri_entry_archive enable row level security;
revoke all on public.wlf_ri_categories,public.wlf_ri_entries,public.wlf_ri_projects,wlf_private.ri_entry_archive
  from public,anon,authenticated;

create or replace function wlf_private.ri_enabled(module text)
returns boolean language sql stable security definer set search_path='' as $$
  select coalesce((select status='Approved' and (role='Super Admin' or module=any(permissions))
    from public.wlf_profiles where id=auth.uid()),false)
$$;

create or replace function wlf_private.ri_person_allowed(person uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.wlf_profiles where id=person and status='Approved'
    and (role='Super Admin' or 'ri:projects'=any(permissions)))
$$;

create or replace function wlf_private.ri_categories()
returns jsonb language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(to_jsonb(c) order by c.position,c.name),'[]')
  from public.wlf_ri_categories c where c.active or wlf_private.super()
$$;

create or replace function wlf_private.ri_activity(action text,p jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  u public.wlf_profiles=wlf_private.me(); c public.wlf_ri_categories; rec public.wlf_ri_entries;
  entry_id uuid; op uuid; payload_hash text; vals jsonb; current_status text; title text; category_id text=p->>'category';
  section_name text; after_at timestamptz; after_id uuid; start_date date; end_date date; rows jsonb;
begin
  if not wlf_private.ri_enabled('ri:activity') then raise exception 'R&I Team Activity access required'; end if;
  if action='getRiCategories' then return wlf_private.ri_categories(); end if;

  if action='saveRiCategory' or action='setRiCategoryActive' then
    if u.role<>'Super Admin' then raise exception 'Super Admin only'; end if;
    if action='setRiCategoryActive' then
      update public.wlf_ri_categories set active=(p->>'active')::boolean,revision=revision+1
        where id=category_id and revision=(p->>'revision')::integer returning * into c;
    else
      title=btrim(coalesce(p->>'name',''));
      section_name=p->>'section';
      if length(title) not between 1 and 120 or coalesce(section_name,'') not in ('team','scm','sales','reports') then
        raise exception 'Enter a category name and select its tab.';
      end if;
      vals=jsonb_build_object('fields',wlf_private.form_fields(p->'fields'));
      if (p->>'revision')::integer=0 then
        if coalesce(category_id,'') !~ '^custom-[-a-f0-9]{36}$' then raise exception 'Invalid category ID'; end if;
        perform pg_advisory_xact_lock(hashtextextended('wlf-category:'||section_name,0));
        insert into public.wlf_ri_categories(id,section,name,position,schema)
          values(category_id,section_name,title,coalesce((select max(position)+1 from public.wlf_ri_categories),1),vals)
          on conflict(id) do nothing returning * into c;
      else
        update public.wlf_ri_categories set section=section_name,name=title,schema=vals,revision=revision+1
          where id=category_id and revision=(p->>'revision')::integer returning * into c;
      end if;
    end if;
    if not found then raise exception 'CONFLICT: Category changed. Refresh and review.'; end if;
    return to_jsonb(c);
  end if;

  select * into c from public.wlf_ri_categories where id=category_id and (active or u.role='Super Admin');
  if not found then raise exception 'Activity category not found'; end if;

  if action='getRiEntries' then
    start_date=nullif(p->>'from','')::date; end_date=nullif(p->>'to','')::date;
    if start_date>end_date then raise exception 'Invalid date range'; end if;
    after_at=nullif(p->>'beforeAt','')::timestamptz; after_id=nullif(p->>'beforeId','')::uuid;
    select coalesce(jsonb_agg(to_jsonb(e)-'last_operation'-'last_payload_hash' order by created_at desc,id desc),'[]')
    into rows
    from (
      select * from public.wlf_ri_entries e
      where e.category=c.id and deleted_at is null
        and (start_date is null or (created_at at time zone 'Asia/Dhaka')::date>=start_date)
        and (end_date is null or (created_at at time zone 'Asia/Dhaka')::date<=end_date)
        and (coalesce(p->>'status','')='' or status=p->>'status')
        and (coalesce(p->>'query','')='' or position(lower(left(p->>'query',200)) in lower(author_name||' '||values::text))>0)
        and (after_at is null or (created_at,id)<(after_at,after_id))
      order by created_at desc,id desc limit 26
    ) e;
    return jsonb_build_object('entries',case when jsonb_array_length(rows)>25 then rows-25 else rows end,
      'hasMore',jsonb_array_length(rows)>25,
      'statuses',(select coalesce(jsonb_agg(status order by status),'[]') from (
        select distinct status from public.wlf_ri_entries where category=c.id and deleted_at is null) s));
  end if;

  if action not in ('saveRiEntry','deleteRiEntry') then raise exception 'Unsupported activity action'; end if;
  if action='deleteRiEntry' and u.role<>'Super Admin' then raise exception 'Super Admin only'; end if;
  entry_id=(p->>'id')::uuid; op=(p->>'operation')::uuid; payload_hash=md5(action||p::text);
  if entry_id is null or op is null then raise exception 'Missing activity or operation ID'; end if;
  perform pg_advisory_xact_lock(hashtextextended('wlf-ri-entry:'||entry_id,0));
  select * into rec from public.wlf_ri_entries where id=entry_id and category=c.id for update;
  if found then
    if rec.owner<>u.id and u.role<>'Super Admin' then raise exception 'Only the creator or Super Admin can edit this entry'; end if;
    if rec.last_operation=op then
      if rec.last_payload_hash<>payload_hash then raise exception 'Operation ID reused with different data'; end if;
      return to_jsonb(rec)-'last_operation'-'last_payload_hash';
    end if;
    if rec.deleted_at is not null or rec.revision is distinct from (p->>'revision')::integer then
      raise exception 'CONFLICT: Activity changed. Refresh and review.';
    end if;
    if action='deleteRiEntry' then
      update public.wlf_ri_entries set deleted_at=now(),updated_at=now(),revision=revision+1,
        last_operation=op,last_payload_hash=payload_hash where id=entry_id returning * into rec;
    else
      vals=wlf_private.form_values(rec.form_schema,p->'values',rec.author_name,
        (rec.created_at at time zone 'Asia/Dhaka')::date,rec.values);
      current_status=coalesce(nullif(wlf_private.field_display(rec.form_schema,vals,'status'),''),'Submitted');
      update public.wlf_ri_entries set values=vals,status=current_status,updated_at=now(),revision=revision+1,
        last_operation=op,last_payload_hash=payload_hash where id=entry_id returning * into rec;
    end if;
  else
    if action<>'saveRiEntry' or (p->>'revision')::integer is distinct from 0
        or exists(select 1 from wlf_private.ri_entry_archive where id=entry_id) then
      raise exception 'Activity no longer available';
    end if;
    select * into c from public.wlf_ri_categories where id=category_id for share;
    if not c.active or c.revision is distinct from (p->>'formRevision')::integer then
      raise exception 'CONFLICT: Form changed. Reopen the form.';
    end if;
    vals=wlf_private.form_values(c.schema,p->'values',u.name,(now() at time zone 'Asia/Dhaka')::date);
    current_status=coalesce(nullif(wlf_private.field_display(c.schema,vals,'status'),''),'Submitted');
    insert into public.wlf_ri_entries(id,category,owner,author_name,status,form_schema,values,last_operation,last_payload_hash)
      values(entry_id,c.id,u.id,u.name,current_status,c.schema,vals,op,payload_hash) returning * into rec;
    insert into public.wlf_usage(actor,action,details) values(u.id,'R&I Team Activity',c.name);
  end if;
  return to_jsonb(rec)-'last_operation'-'last_payload_hash';
end
$$;

create or replace function wlf_private.ri_project_data(data jsonb, previous jsonb)
returns jsonb language plpgsql stable set search_path='' as $$
declare
  proj_name text=btrim(coalesce(data->>'name','')); lead uuid; collaborator uuid; member_ids jsonb;
  old_members jsonb; task jsonb; old_task jsonb; tasks jsonb='[]'; task_id uuid; task_owner uuid;
  task_name text; task_progress integer; task_status text; start_date date; end_date date;
  task_start date; task_end date;
begin
  if jsonb_typeof(data) is distinct from 'object' or octet_length(data::text)>65000 or length(proj_name) not between 1 and 180
      or coalesce(data->>'impact','') not in ('Product Development','Process Improvement','Business Development')
      or coalesce(data->>'status','') not in ('In Progress','On Hold','Done','Cancelled') then
    raise exception 'Check the project name, impact type and status.';
  end if;
  start_date=nullif(data->>'start','')::date; end_date=nullif(data->>'end','')::date;
  if start_date is null or end_date is null or start_date>end_date then raise exception 'Select valid project dates'; end if;
  lead=nullif(data->>'lead','')::uuid;
  if lead is null or (not wlf_private.ri_person_allowed(lead) and lead::text is distinct from previous->>'lead') then
    raise exception 'Choose a project lead with access.';
  end if;
  member_ids=coalesce(data->'collaborators','[]'); old_members=coalesce(previous->'collaborators','[]');
  if jsonb_typeof(member_ids)<>'array' or jsonb_array_length(member_ids)>50
     or (select count(distinct value) from jsonb_array_elements_text(member_ids))<>jsonb_array_length(member_ids) then
    raise exception 'Choose up to 50 distinct collaborators.';
  end if;
  for collaborator in select value::uuid from jsonb_array_elements_text(member_ids) loop
    if collaborator is null or collaborator=lead or
      (not wlf_private.ri_person_allowed(collaborator) and not (old_members ? collaborator::text)) then
      raise exception 'Choose collaborators with project access who are different from the lead.';
    end if;
  end loop;
  if jsonb_typeof(data->'tasks') is distinct from 'array' or jsonb_array_length(data->'tasks')>150 then
    raise exception 'A project can contain up to 150 tasks.';
  end if;
  for task in select value from jsonb_array_elements(data->'tasks') loop
    task_id=(task->>'id')::uuid; task_name=btrim(coalesce(task->>'name',''));
    task_owner=nullif(task->>'owner','')::uuid;
    task_progress=(task->>'progress')::integer; task_status=task->>'status';
    task_start=nullif(task->>'start','')::date; task_end=nullif(task->>'end','')::date;
    select t into old_task from jsonb_array_elements(coalesce(previous->'tasks','[]')) t where t->>'id'=task_id::text;
    if task_id is null or tasks @> jsonb_build_array(jsonb_build_object('id',task_id))
      or length(task_name) not between 1 and 180 or task_start is null or task_end is null or task_start>task_end
      or task_progress is null or task_progress not between 0 and 100
      or coalesce(task_status,'') not in ('Pending','In Progress','On Hold','Done','Cancelled')
      or (task_owner is not null and not wlf_private.ri_person_allowed(task_owner)
          and task_owner::text is distinct from old_task->>'owner') then
      raise exception 'Check the task name, dates, progress, status and assignee.';
    end if;
    tasks=tasks||jsonb_build_array(jsonb_build_object('id',task_id,'name',task_name,'owner',coalesce(task_owner::text,''),
      'start',task_start,'end',task_end,'status',task_status,'progress',task_progress));
  end loop;
  return jsonb_build_object('name',proj_name,'lead',lead,'collaborators',member_ids,'start',start_date,'end',end_date,
    'impact',data->>'impact','status',data->>'status','brief',left(coalesce(data->>'brief',''),4000),
    'financial',coalesce((data->>'financial')::boolean,false),'documentation',coalesce((data->>'documentation')::boolean,false),
    'tasks',tasks);
end
$$;

create or replace function wlf_private.ri_projects(action text,p jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  u public.wlf_profiles=wlf_private.me(); rec public.wlf_ri_projects;
  project_id uuid; op uuid; payload_hash text; vals jsonb; people jsonb; rows jsonb;
  after_at timestamptz; after_id uuid;
begin
  if not wlf_private.ri_enabled('ri:projects') then raise exception 'R&I Project Manager access required'; end if;
  if action='getRiProjects' then
    after_at=nullif(p->>'beforeAt','')::timestamptz; after_id=nullif(p->>'beforeId','')::uuid;
    select coalesce(jsonb_agg(to_jsonb(r)-'last_operation'-'last_payload_hash' order by created_at desc,id desc),'[]') into rows
    from (select r.*,profile.name owner_name from public.wlf_ri_projects r
      join public.wlf_profiles profile on profile.id=r.owner where r.deleted_at is null
      and (coalesce(p->>'query','')='' or position(lower(left(p->>'query',200)) in lower(r.data->>'name'))>0)
      and (coalesce(p->>'lead','')='' or r.data->>'lead'=p->>'lead')
      and (coalesce(p->>'collaborator','')='' or r.data->'collaborators' ? (p->>'collaborator'))
      and (coalesce(p->>'impact','')='' or r.data->>'impact'=p->>'impact')
      and (coalesce(p->>'status','')='' or r.data->>'status'=p->>'status')
      and (after_at is null or (r.created_at,r.id)<(after_at,after_id))
      order by r.created_at desc,r.id desc limit 21) r;
    -- Include historic display names for returned projects even if access was subsequently removed.
    select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'eligible',wlf_private.ri_person_allowed(p.id)) order by p.name,p.id),'[]') into people
    from public.wlf_profiles p
    where (p.status='Approved' and (p.role='Super Admin' or 'ri:projects'=any(p.permissions))) or p.id::text in (
      select r->'data'->>'lead' from jsonb_array_elements(rows) r
      union select c from jsonb_array_elements(rows) r cross join lateral jsonb_array_elements_text(r->'data'->'collaborators') c
      union select t->>'owner' from jsonb_array_elements(rows) r cross join lateral jsonb_array_elements(r->'data'->'tasks') t
    );
    return jsonb_build_object('projects',case when jsonb_array_length(rows)>20 then rows-20 else rows end,
      'hasMore',jsonb_array_length(rows)>20,'people',people);
  end if;

  if action not in ('saveRiProject','deleteRiProject') then raise exception 'Unsupported project action'; end if;
  project_id=(p->>'id')::uuid; op=(p->>'operation')::uuid; payload_hash=md5(action||p::text);
  if project_id is null or op is null then raise exception 'Missing project or operation ID'; end if;
  perform pg_advisory_xact_lock(hashtextextended('wlf-ri-project:'||project_id,0));
  select * into rec from public.wlf_ri_projects where id=project_id for update;
  if found then
    if rec.owner<>u.id and u.role<>'Super Admin' then raise exception 'Only the project creator or Super Admin can change the project or its tasks'; end if;
    if rec.last_operation=op then
      if rec.last_payload_hash<>payload_hash then raise exception 'Operation ID reused with different data'; end if;
      return to_jsonb(rec)-'last_operation'-'last_payload_hash';
    end if;
    if rec.deleted_at is not null or rec.revision is distinct from (p->>'revision')::integer then
      raise exception 'CONFLICT: Project changed. Refresh and review.';
    end if;
    if action='deleteRiProject' then
      update public.wlf_ri_projects set deleted_at=now(),updated_at=now(),revision=revision+1,
        last_operation=op,last_payload_hash=payload_hash where id=project_id returning * into rec;
    else
      vals=wlf_private.ri_project_data(p->'data',rec.data);
      update public.wlf_ri_projects set data=vals,updated_at=now(),revision=revision+1,
        last_operation=op,last_payload_hash=payload_hash where id=project_id returning * into rec;
    end if;
  else
    if action<>'saveRiProject' or (p->>'revision')::integer is distinct from 0 then raise exception 'Project no longer available'; end if;
    vals=wlf_private.ri_project_data(p->'data','{}');
    insert into public.wlf_ri_projects(id,owner,data,last_operation,last_payload_hash) values(project_id,u.id,vals,op,payload_hash) returning * into rec;
    insert into public.wlf_usage(actor,action,details) values(u.id,'R&I Project Manager',vals->>'name');
  end if;
  return to_jsonb(rec)-'last_operation'-'last_payload_hash';
end
$$;

create or replace function wlf_private.ri_dashboard()
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'activity',case when wlf_private.ri_enabled('ri:activity') then
      (select coalesce(jsonb_object_agg(status,n),'{}') from (
        select status,count(*) n from public.wlf_ri_entries e join public.wlf_ri_categories c on c.id=e.category
        where e.deleted_at is null and c.active group by status) x) end,
    'projects',case when wlf_private.ri_enabled('ri:projects') then
      (select coalesce(jsonb_object_agg(status,n),'{}') from (
        select data->>'status' status,count(*) n from public.wlf_ri_projects where deleted_at is null group by status) x) end)
$$;

-- Maintain the existing v2.1 actions and permissions underneath the release-specific actions.
do $$
begin
  if to_regprocedure('wlf_private.rpc_v210(text,jsonb)') is null then
    alter function wlf_private.rpc(text,jsonb) rename to rpc_v210;
  end if;
end
$$;
create or replace function wlf_private.rpc(a text,args jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare p jsonb=coalesce(args->0,'{}'); result jsonb;
begin
  if not wlf_private.approved() then raise exception 'SESSION_EXPIRED: Account is pending approval or inactive'; end if;
  if octet_length(args::text)>100000 then raise exception 'Request too large'; end if;
  if a in ('createSupportRequest','editSupportRequest','saveSupportSchema') then
    return wlf_private.save_support_v220(a,p);
  elsif a in ('getRiCategories','getRiEntries','saveRiCategory','setRiCategoryActive','saveRiEntry','deleteRiEntry') then
    return wlf_private.ri_activity(a,p);
  elsif a in ('getRiProjects','saveRiProject','deleteRiProject') then
    return wlf_private.ri_projects(a,p);
  elsif a='getRiDashboard' then
    return wlf_private.ri_dashboard();
  end if;
  result=wlf_private.rpc_v210(a,args);
  if a in ('getSession','getAppContext') then
    return result||jsonb_build_object('build','2.2.0');
  elsif a='getSupportWorkspace' and coalesce(p->>'category','')<>'' then
    return result||jsonb_build_object('facets',wlf_private.support_facets(p->>'category'));
  end if;
  return result;
end
$$;
