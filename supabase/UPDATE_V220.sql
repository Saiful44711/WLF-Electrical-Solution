-- WLF v2.2.0 upgrade. Run in the existing v2.1 Supabase project.
begin;
-- Existing v2.1 must be installed. Keep all existing records and request references.
do $$
begin
  if to_regprocedure('wlf_private.rpc_v200(text,jsonb)') is null
     or to_regprocedure('public.wlf_backup_admin(text,uuid,jsonb)') is null then
    raise exception 'WLF v2.1 database required. Verify the existing project before proceeding.';
  end if;
end
$$;

create or replace function wlf_private.support_teams()
returns table (id text, title text, sort_order integer)
language sql immutable set search_path='' as $$
  values ('commissioning','Commissioning Team Support Request',1),
         ('aftersales','After Sales Team Support Request',2),
         ('production','Production Team Support Request',3),
         ('maintenance','Factory Maintenance Team Support Request',4),
         ('qc','QC Team Support Request',5),
         ('installation','Installation Team Support Request',6)
$$;

alter table public.wlf_forms drop constraint if exists wlf_forms_category_check;
alter table public.wlf_forms add constraint wlf_forms_category_check
  check (category in ('commissioning','aftersales','production','maintenance','qc','installation'));

create sequence if not exists wlf_private.support_reference_sequence;
create unique index if not exists wlf_numbered_support_reference
  on public.wlf_requests(reference) where reference ~ '^TCS[0-9]+-';

create or replace function wlf_private.field_role(field jsonb)
returns text language sql immutable set search_path='' as $$
  select case
    when field->>'id' in ('identity','field_1674702979')
      or lower(field->>'label') in ('name & id','name & (id)','name (id)','full name-id','responder name & id') then 'identity'
    when field->>'id' in ('controller','field_620050161','field_637986521')
      or lower(field->>'label') in ('controller','control system','control system brand') then 'controller'
    when field->>'id' in ('sub','field_295723266')
      or lower(regexp_replace(coalesce(field->>'label',''),'[^a-zA-Z]+','','g')) in ('subcategory','problemsubcategory') then 'sub'
    when field->>'id' in ('lift','field_1369800003') or lower(field->>'label') in ('lift id','project lift id') then 'lift'
    when field->>'id' in ('project','field_1866778380','field_702543330')
      or lower(field->>'label') in ('project name','project / task name') then 'project'
    when field->>'id' = 'status' or lower(field->>'label') in ('task status','project/task status','solution status') then 'status'
    else '' end
$$;

create or replace function wlf_private.field_choices(form jsonb, vals jsonb, field_kind text)
returns setof text language sql immutable set search_path='' as $$
  select btrim(choice)
  from jsonb_array_elements(coalesce(form->'fields','[]')) f
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(vals->(f->>'id'))
      when 'array' then vals->(f->>'id')
      when 'null' then '[]'::jsonb
      else jsonb_build_array(vals->(f->>'id')) end
  ) a(choice)
  where wlf_private.field_role(f)=field_kind and btrim(choice)<>''
$$;

create or replace function wlf_private.field_display(form jsonb, vals jsonb, field_kind text)
returns text language sql immutable set search_path='' as $$
  select coalesce(string_agg(x, ', '),'') from wlf_private.field_choices(form,vals,field_kind) x
$$;

create or replace function wlf_private.form_fields(fields jsonb)
returns jsonb language plpgsql immutable set search_path='' as $$
declare field jsonb; field_id text; label text; kind text; auto_fill text; choices jsonb; result jsonb='[]';
begin
  if jsonb_typeof(fields) is distinct from 'array' or jsonb_array_length(fields)>60
      or octet_length(fields::text)>45000 then
    raise exception 'A form can contain up to 60 fields and 45 KB of settings.';
  end if;
  for field in select value from jsonb_array_elements(fields) loop
    field_id=field->>'id'; label=btrim(field->>'label'); kind=field->>'type';
    auto_fill=coalesce(field->>'autoFill','');
    choices=coalesce(field->'options','[]');
    if coalesce(field_id,'') !~ '^[-a-zA-Z0-9_]{2,100}$'
        or result @> jsonb_build_array(jsonb_build_object('id',field_id))
        or coalesce(length(label),0) not between 1 and 180
        or coalesce(kind,'') not in ('text','textarea','date','number','select','multi','radio','checkbox')
        or auto_fill not in ('','today','identity','none')
        or jsonb_typeof(choices)<>'array' or jsonb_array_length(choices)>100 then
      raise exception 'Check field names, types and unique IDs.';
    end if;
    if exists(select 1 from jsonb_array_elements(choices) c
        where jsonb_typeof(c)<>'string' or length(btrim(c#>>'{}')) not between 1 and 300)
        or (select count(distinct btrim(value)) from jsonb_array_elements_text(choices))<>jsonb_array_length(choices)
        or (kind in ('select','multi','radio') and jsonb_array_length(choices)=0) then
      raise exception 'Check the options for %.', label;
    end if;
    if kind not in ('select','multi','radio','checkbox') then choices='[]'; end if;
    if (auto_fill='identity' and kind not in ('text','textarea')) or (auto_fill='today' and kind<>'date') then
      auto_fill='none';
    end if;
    result=result||jsonb_build_array(jsonb_build_object('id',field_id,'label',label,'type',kind,
      'help',left(coalesce(field->>'help',''),2000),'required',coalesce((field->>'required')::boolean,false),
      'autoFill',auto_fill,'options',choices));
  end loop;
  return result;
end
$$;

create or replace function wlf_private.form_values(form jsonb, vals jsonb, identity_name text, submitted_on date,
                                                  previous jsonb default '{}')
returns jsonb language plpgsql immutable set search_path='' as $$
declare f jsonb; x jsonb; txt text; field_id text; kind text; auto_fill text; choices jsonb; result jsonb='{}';
begin
  if jsonb_typeof(vals) is distinct from 'object' or octet_length(vals::text)>64000 then
    raise exception 'Invalid or oversized submission.';
  end if;
  for f in select value from jsonb_array_elements(form->'fields') loop
    field_id=f->>'id'; kind=f->>'type'; choices=coalesce(f->'options','[]');
    auto_fill=coalesce(f->>'autoFill','');
    if (auto_fill='identity' or (auto_fill='' and wlf_private.field_role(f)='identity'))
        and kind in ('text','textarea') then
      x=coalesce(previous->field_id,to_jsonb(identity_name));
    elsif (auto_fill='today' or (auto_fill='' and field_id='submitted_date')) and kind='date' then
      x=coalesce(previous->field_id,to_jsonb(to_char(submitted_on,'YYYY-MM-DD')));
    elsif kind='multi' or (kind='checkbox' and jsonb_array_length(choices)>0) then
      x=coalesce(vals->field_id,'[]');
      if jsonb_typeof(x)<>'array' or jsonb_array_length(x)>100 then
        raise exception 'Invalid multiple choice: %.', f->>'label';
      end if;
    elsif kind='checkbox' then
      x=coalesce(vals->field_id,'false');
      if jsonb_typeof(x)<>'boolean' then raise exception 'Invalid checkbox: %.', f->>'label'; end if;
    else
      x=coalesce(vals->field_id,'""');
      if jsonb_typeof(x) not in ('string','number') then raise exception 'Invalid field: %.',f->>'label'; end if;
      txt=btrim(x#>>'{}');
      if length(txt)>4000 then raise exception 'Field text too long: %.', f->>'label'; end if;
      if txt<>'' and kind='number' and txt !~ '^[-+]?[0-9]+([.][0-9]+)?$' then
        raise exception 'Enter a number for %.', f->>'label';
      end if;
      if txt<>'' and kind='date' and (txt !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or to_char(txt::date,'YYYY-MM-DD')<>txt) then
        raise exception 'Invalid date: %.', f->>'label';
      end if;
      x=to_jsonb(txt);
    end if;
    if coalesce((f->>'required')::boolean,false) and (x is null or x in ('""','[]','false','null')) then
      raise exception 'Required: %.',f->>'label';
    end if;
    if jsonb_array_length(choices)>0 and exists(
        select 1 from jsonb_array_elements(case when jsonb_typeof(x)='array' then x else jsonb_build_array(x) end) a
        where a<>'""' and not(choices @> jsonb_build_array(a))) then
      raise exception 'Invalid choice: %.',f->>'label';
    end if;
    result=result||jsonb_build_object(field_id,x);
  end loop;
  return result;
end
$$;

create or replace function wlf_private.summary()
returns jsonb language sql stable security definer set search_path='' as $$
  with grouped as (
    select category,status,count(*) n from public.wlf_requests r
    where deleted_at is null and wlf_private.visible(r.category,r.created_by)
    group by category,status
  ), counts as (
    select c.id,
      coalesce(sum(g.n) filter(where g.status='Pending'),0) pending,
      coalesce(sum(g.n) filter(where g.status<>'Solved'),0) open,
      coalesce(jsonb_object_agg(g.status,g.n) filter(where g.status is not null),'{}') statuses
    from wlf_private.support_teams() c left join grouped g on c.id=g.category group by c.id
  )
  select jsonb_build_object('pending',jsonb_object_agg(id,pending),'open',jsonb_object_agg(id,open),
    'statuses',jsonb_object_agg(id,statuses),'version',clock_timestamp(),'user',wlf_private.safe_user(wlf_private.me()))
  from counts
$$;

create or replace function wlf_private.support_facets(team text)
returns jsonb language sql stable security definer set search_path='' as $$
  with saved as (
    select kind,choice from public.wlf_requests r
    cross join unnest(array['controller','sub']) kind
    cross join lateral wlf_private.field_choices(r.form_schema,r.values,kind) choice
    where r.category=team and r.deleted_at is null and wlf_private.visible(r.category,r.created_by)
  ), configured as (
    select wlf_private.field_role(field) kind, choice
    from public.wlf_forms f cross join lateral jsonb_array_elements(f.schema->'fields') field
    cross join lateral jsonb_array_elements_text(coalesce(field->'options','[]')) choice
    where f.category=team and wlf_private.team(team) and wlf_private.field_role(field) in ('controller','sub')
  ), all_choices as (select * from saved union select * from configured)
  select jsonb_build_object(
    'controller',coalesce(jsonb_agg(choice order by choice) filter(where kind='controller'),'[]'),
    'sub',coalesce(jsonb_agg(choice order by choice) filter(where kind='sub'),'[]'))
  from all_choices
$$;

create or replace function wlf_private.save_support_v220(action text, payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  u public.wlf_profiles=wlf_private.me(); r public.wlf_requests; form public.wlf_forms;
  receipt public.wlf_operations; op text=payload->>'mutationId'; team text=payload->>'category';
  vals jsonb; lift text; ref text; event_name text; comment text;
  today date=(now() at time zone 'Asia/Dhaka')::date;
begin
  if u.status is distinct from 'Approved' then raise exception 'SESSION_EXPIRED'; end if;
  if action='saveSupportSchema' then
    if u.role<>'Super Admin' then raise exception 'Super Admin only'; end if;
    vals=wlf_private.form_fields(payload->'schema'->'fields');
    update public.wlf_forms set schema=jsonb_set(schema,'{fields}',vals),revision=revision+1
      where category=team and revision=(payload->>'revision')::integer returning * into form;
    if not found then raise exception 'CONFLICT: Form changed. Refresh before editing.'; end if;
    return form.schema||jsonb_build_object('revision',form.revision);
  end if;
  if action not in ('createSupportRequest','editSupportRequest') then raise exception 'Unsupported support action'; end if;
  if action='editSupportRequest' and u.role<>'Super Admin' then raise exception 'Super Admin only'; end if;
  if coalesce(op,'') !~ '^[-a-zA-Z0-9]{12,100}$' then raise exception 'Invalid operation ID'; end if;
  perform pg_advisory_xact_lock(hashtextextended(u.id::text||op,0));
  if exists(select 1 from wlf_private.archived_operations where actor=u.id and mutation_id=op) then
    raise exception 'This operation belongs to an archived request.';
  end if;
  select * into receipt from public.wlf_operations where actor=u.id and mutation_id=op;
  if found then
    if receipt.action<>action or receipt.payload<>payload then raise exception 'Operation ID reused with different data'; end if;
    select * into r from public.wlf_requests where id=receipt.request_id and deleted_at is null
      and wlf_private.visible(category,created_by);
    if not found then raise exception 'Request no longer available'; end if;
    return jsonb_build_object('id',r.id,'revision',r.revision,'status',r.status,'duplicate',true,
      'ticket',wlf_private.ticket(r),'summary',wlf_private.summary());
  end if;
  if action='createSupportRequest' then
    if not coalesce(wlf_private.team(team),false) or u.role not in ('User','Super Admin') then raise exception 'Permission denied'; end if;
    select * into form from public.wlf_forms where category=team for share;
    if not found then raise exception 'Unknown support team'; end if;
    if payload ? 'formRevision' and form.revision is distinct from (payload->>'formRevision')::integer then
      raise exception 'CONFLICT: Form changed. Reopen the request form.';
    end if;
    vals=wlf_private.form_values(form.schema,payload->'values',u.name,today);
    lift=left(regexp_replace(wlf_private.field_display(form.schema,vals,'lift'),'[^[:alnum:]_.-]+','-','g'),64);
    ref='TCS'||nextval('wlf_private.support_reference_sequence')||'-'||coalesce(nullif(lift,''),'NO-LIFT')||'-'||to_char(today,'YYYYMMDD');
    insert into public.wlf_requests(category,created_by,values,form_schema,reference,search_text)
      values(team,u.id,vals,form.schema,ref,vals::text) returning * into r;
    event_name='submit'; comment='Request submitted';
  else
    select * into r from public.wlf_requests where id=(payload->>'id')::uuid and deleted_at is null for update;
    if not found or r.revision is distinct from (payload->>'revision')::integer then
      raise exception 'CONFLICT: Request changed. Refresh and review.';
    end if;
    vals=wlf_private.form_values(r.form_schema,payload->'values',
      (select name from public.wlf_profiles where id=r.created_by),(r.created_at at time zone 'Asia/Dhaka')::date,r.values);
    update public.wlf_requests set values=vals, search_text=vals::text, revision=revision+1,updated_at=now()
      where id=r.id returning * into r;
    event_name='edit form'; comment='Form corrected by Super Admin';
  end if;
  insert into public.wlf_history(request_id,actor,action,comment,to_user) values(r.id,u.id,event_name,comment,r.assigned_to);
  insert into public.wlf_operations(actor,mutation_id,action,request_id,payload) values(u.id,op,action,r.id,payload);
  return jsonb_build_object('id',r.id,'revision',r.revision,'status',r.status,'ticket',wlf_private.ticket(r),
    'summary',wlf_private.summary());
end
$$;

create or replace function wlf_private.catalog() returns jsonb language sql stable security definer set search_path='' as $$
 select '[{"key":"selection","label":"Component Selection","group":"Workspace"},{"key":"calc:travel","label":"Travel Time","group":"Calculations"},{"key":"calc:power","label":"Total Power","group":"Calculations"},{"key":"calc:speed","label":"Nominal Speed & Slip frequency","group":"Calculations"},{"key":"calc:motor","label":"Motor Power Justification","group":"Calculations"},{"key":"calc:energy","label":"Energy Bill","group":"Calculations"},{"key":"calc:solar","label":"Solar Sizing","group":"Calculations"},{"key":"support:commissioning:request","label":"Commissioning / Submit & own status","group":"Technical Support"},{"key":"support:aftersales:request","label":"After Sales / Submit & own status","group":"Technical Support"},{"key":"dashboard","label":"Dashboard","group":"Workspace"}]'::jsonb || coalesce((select jsonb_agg(jsonb_build_object('key',case when e->>'controller'='GENERAL' then 'tb:general:'||(e->>'id') when e->>'kind'='procedure' then 'tb:option:'||(e->>'id') else 'tb:'||(e->>'controller')||':error' end,'label',(e->>'controller')||' / '||coalesce(nullif(e->>'category',''),'Error Solution'),'group','Troubleshooting')) from jsonb_array_elements(wlf_private.options()) e),'[]') ||
    (select jsonb_agg(jsonb_build_object('key','support:'||id||':request','label',title,'group','Technical Support') order by sort_order)
      from wlf_private.support_teams() where sort_order>2) ||
    '[{"key":"ri:activity","label":"R&I Team Activity","group":"R&I"},{"key":"ri:projects","label":"R&I Project Manager","group":"R&I"}]'::jsonb$$;

create or replace function wlf_private.ticket(r public.wlf_requests,full_data boolean default true) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',r.id,'reference',r.reference,'category',r.category,'status',r.status,'createdBy',(select email from public.wlf_profiles where id=r.created_by),'assignedTo',coalesce((select email from public.wlf_profiles where id=r.assigned_to),''),'createdAt',r.created_at,'updatedAt',r.updated_at,'revision',r.revision,'values',r.values,
  'project',wlf_private.field_display(r.form_schema,r.values,'project'),
  'lift',wlf_private.field_display(r.form_schema,r.values,'lift'),
  'controller',to_jsonb(array(select wlf_private.field_choices(r.form_schema,r.values,'controller'))),
  'sub',to_jsonb(array(select wlf_private.field_choices(r.form_schema,r.values,'sub'))),
  'authorName',(select name from public.wlf_profiles where id=r.created_by),'formSchema',case when full_data then r.form_schema else '{}'::jsonb end,'solution',case when full_data then r.solution else '' end,'solvedBy',coalesce((select email from public.wlf_profiles where id=r.solved_by),''),'solvedAt',r.solved_at,'notSolvedBy',coalesce((select email from public.wlf_profiles where id=r.not_solved_by),''),'notSolvedAt',r.not_solved_at,'history',case when full_data then coalesce((select jsonb_agg(ev order by hid) from(select h.id hid,jsonb_build_object('at',h.at,'actor',p.email,'action',h.action,'comment',h.comment,'to',coalesce(q.email,'')) ev from public.wlf_history h join public.wlf_profiles p on p.id=h.actor left join public.wlf_profiles q on q.id=h.to_user where h.request_id=r.id order by h.id desc limit 150)x),'[]') else '[]'::jsonb end)$$;

create or replace function wlf_private.filtered(f jsonb) returns setof public.wlf_requests language sql stable security definer set search_path='' as $$
 select r.* from public.wlf_requests r where r.deleted_at is null and wlf_private.visible(r.category,r.created_by)
 and(coalesce(f->>'category','')='' or r.category=f->>'category')
 and(coalesce(f->>'status','')='' or r.status=f->>'status')
 and(coalesce(f->>'assignee','')='' or r.assigned_to=(select id from public.wlf_profiles where email=f->>'assignee'))
 and(coalesce(f->>'engineer','')='' or case when f->>'dateBasis'='solved' or f->>'status'='Solved' then r.solved_by=(select id from public.wlf_profiles where email=f->>'engineer') else exists(select 1 from public.wlf_history h join public.wlf_profiles p on p.id=h.actor where h.request_id=r.id and p.email=f->>'engineer' and h.action in ('receive','solve','forward','notSolved','pending')) end)
 and(coalesce(f->>'from','')='' or (case when f->>'dateBasis'='solved' then r.solved_at else r.created_at end at time zone 'Asia/Dhaka')::date >= (f->>'from')::date)
 and(coalesce(f->>'to','')='' or (case when f->>'dateBasis'='solved' then r.solved_at else r.created_at end at time zone 'Asia/Dhaka')::date <= (f->>'to')::date)
 and(coalesce(f->>'query','')='' or position(lower(left(f->>'query',200)) in lower(r.search_text||' '||r.reference||' '||r.id||' '||r.solution))>0)
 and(coalesce(f->>'controller','')='' or exists(select 1 from wlf_private.field_choices(r.form_schema,r.values,'controller') x where lower(x)=lower(btrim(f->>'controller'))))
 and(coalesce(f->>'sub','')='' or exists(select 1 from wlf_private.field_choices(r.form_schema,r.values,'sub') x where lower(x)=lower(btrim(f->>'sub'))))
 order by r.updated_at desc,r.id$$;

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

-- Generated once from the two approved workbooks. Import is conditional and repeatable.
create table if not exists wlf_private.v220_import_audit (item text primary key, decision text not null, before_state jsonb, at timestamptz not null default now());
alter table wlf_private.v220_import_audit enable row level security;
revoke all on wlf_private.v220_import_audit from public,anon,authenticated;
do $$
declare old_headers jsonb; old_row public.wlf_components; old_form public.wlf_forms; incoming jsonb; component jsonb; key text; live_count int;
begin
  lock table public.wlf_components, public.wlf_settings, public.wlf_forms in share row exclusive mode;
  if not exists(select 1 from wlf_private.v220_import_audit where item='component_headers') then
    select value into old_headers from public.wlf_settings where wlf_settings.key='component_headers';
    if old_headers is distinct from '["Capacity (KG)","Speed (m/s)","Usage Type","Roping","Motor brand","Motor Model","Motor Type","Motor Power (KW)","Motor Rated (A)","Traction Sheave Dia (mm)","Rope Dia (mm)","Rope Num","Recommended ARKEL Controller KW","Recommended ARKEL Controller Amp","Recommended NICE3000+ Controller KW","Recommended NICE3000+ Controller Amp","Recommended AVR","UPS for ARKEL","ARD For NICE3000+","Brake Resistor for ARKEL","Brake Resistor for NICE3000+","Main Power Cable (RM)","SDB main breaker"]'::jsonb then
      insert into wlf_private.v220_import_audit(item,decision,before_state) values('component_headers','preserved: custom headers; review component import manually',old_headers);
    else
      insert into wlf_private.v220_import_audit(item,decision,before_state) values('component_headers','imported',old_headers);
      update public.wlf_settings set value='["Capacity (KG)","Speed (m/s)","Usage Type","Roping","Motor brand","Motor Model","Motor Type","Motor Power (KW)","Motor Rated (A)","Traction Sheave Dia (mm)","Rope Dia (mm)","Rope Num","Recommended ARKEL Controller KW","Recommended ARKEL Controller Amp","Recommended NICE3000+ Controller KW","Recommended NICE3000+ Controller Amp","Recommended AVR","UPS for ARKEL","ARD For NICE3000+","Brake Resistor for ARKEL","Brake Resistor for NICE3000+","Main Power Cable (RM)","SDB main breaker","SL.N"]'::jsonb where wlf_settings.key='component_headers';
      for component in select value from jsonb_array_elements('[{"id":3,"old":[450,1,"MR","2:1","Monadrive","MCK 100 E","Gearless",3.9,10,320,8,5,5.5,"14 A",7.5,"18 A","15 KVA","1500 VA","32 A","50 ohm 2 KW","80 ohm 2.5 kw","6 RM","32 A"],"incoming":[450,1,"MR","2:1","Monadrive","MCK 100 E","Gearless",3.9,10,320,8,5,5.5,"14 A",7.5,"18 A",15,"1500 VA","32 A","50 ohm 2 KW","80 ohm 2.5 kw","6 RM","32 A",1]},{"id":4,"old":[450,1,"MR","2:1","Ziehl Abegg","SM 190-11B-20","Gearless",3.3,11,240,6.5,5,5.5,"14 A",7.5,"18 A","15 KVA","1500 VA","32 A","50 ohm 2 KW","80 ohm 2.5 kw","6 RM","32 A"],"incoming":[450,1,"MR","2:1","Ziehl Abegg","SM 190-11B-20","Gearless",3.3,11,240,6.5,5,5.5,"14 A",7.5,"18 A",15,"1500 VA","32 A","50 ohm 2 KW","80 ohm 2.5 kw","6 RM","32 A",2]},{"id":5,"old":[450,1,"MR","2:1","Montanari","MGX-75","Gearless",4.1,10,320,8,4,5.5,"14 A",7.5,"18 A","15 KVA","1500 VA","32 A","50 ohm 2 KW","80 ohm 2.5 kw","6 RM","32 A"],"incoming":[450,1,"MR","2:1","Montanari","MGX-75","Gearless",4.1,10,320,8,4,5.5,"14 A",7.5,"18 A",15,"1500 VA","32 A","50 ohm 2 KW","80 ohm 2.5 kw","6 RM","32 A",3]},{"id":6,"old":[450,1,"MR","2:1","Ziehl Abegg","SM 200.15D","Gearless",4.4,13,240,6.5,5,5.5,"14 A",7.5,"18 A","15 KVA","1500 VA","32 A","50 ohm 2 KW","80 ohm 2.5 kw","6 RM","32 A"],"incoming":[450,1,"MR","2:1","Ziehl Abegg","SM 200.15D","Gearless",4.4,13,240,6.5,5,5.5,"14 A",7.5,"18 A",15,"1500 VA","32 A","50 ohm 2 KW","80 ohm 2.5 kw","6 RM","32 A",4]},{"id":7,"old":[450,1.5,"MR","2:1","Monadrive","MCK 100-E","Gearless",5.8,16,320,8,5,7.5,"17 A",7.5,"18 A","20 KVA","1500 VA","32 A","50 ohm 2 KW","80 ohm 2.5 kw","6 RM","32 A"],"incoming":[450,1.5,"MR","2:1","Monadrive","MCK 100-E","Gearless",5.8,16,320,8,5,7.5,"17 A",7.5,"18 A",20,"1500 VA","32 A","50 ohm 2 KW","80 ohm 2.5 kw","6 RM","32 A",5]},{"id":8,"old":[450,1.5,"MR","2:1","Montanari","MGX - 75","Gearless",6.1,15,320,8,4,7.5,"17 A",7.5,"18 A","20 KVA","1500 VA","32 A","50 ohm 2 KW","80 ohm 2.5 kw","6 RM","32 A"],"incoming":[450,1.5,"MR","2:1","Montanari","MGX - 75","Gearless",6.1,15,320,8,4,7.5,"17 A",7.5,"18 A",20,"1500 VA","32 A","50 ohm 2 KW","80 ohm 2.5 kw","6 RM","32 A",6]},{"id":9,"old":[450,1,"MRL","2:1","Monadrive","Mona 200","Gearless",4,10,240,6.5,6,5.5,"14 A",7.5,"18 A","15 KVA","1500 VA","32 A","50 ohm 2 KW","80 ohm 2.5 kw","6 RM","32 A"],"incoming":[450,1,"MRL","2:1","Monadrive","Mona 200","Gearless",4,10,240,6.5,6,5.5,"14 A",7.5,"18 A",15,"1500 VA","32 A","50 ohm 2 KW","80 ohm 2.5 kw","6 RM","32 A",7]},{"id":10,"old":[450,1,"MRL","2:1","Ziehl Abegg","SM 200.15D","Gearless",4.4,13,240,6.5,5,5.5,"14 A",7.5,"18 A","15 KVA","1500 VA","32 A","50 ohm 2 KW","80 ohm 2.5 kw","6 RM","32 A"],"incoming":[450,1,"MRL","2:1","Ziehl Abegg","SM 200.15D","Gearless",4.4,13,240,6.5,5,5.5,"14 A",7.5,"18 A",15,"1500 VA","32 A","50 ohm 2 KW","80 ohm 2.5 kw","6 RM","32 A",8]},{"id":11,"old":[450,1,"MRL","2:1","Ziehl Abegg","SM 200.15D","Gearless",4.4,13,240,6.5,5,5.5,"14 A",7.5,"18 A","15 KVA","1500 VA","32 A","50 ohm 2 KW","80 ohm 2.5 kw","6 RM","32 A"],"incoming":[450,1,"MRL","2:1","Ziehl Abegg","SM 200.15D","Gearless",4.4,13,240,6.5,5,5.5,"14 A",7.5,"18 A",15,"1500 VA","32 A","50 ohm 2 KW","80 ohm 2.5 kw","6 RM","32 A",9]},{"id":12,"old":[450,1.5,"MR","2:1","Ziehl Abegg","SM 200.15D","Gearless",6.8,19.5,240,6.5,5,7.5,"17 A",11,"27 A","20 KVA","1500 VA","32 A","50 ohm 2 KW","50 ohm 3.5kw","6 RM","32 A"],"incoming":[450,1.5,"MR","2:1","Ziehl Abegg","SM 200.15D","Gearless",6.8,19.5,240,6.5,5,7.5,"17 A",11,"27 A",20,"1500 VA","32 A","50 ohm 2 KW","50 ohm 3.5kw","6 RM","32 A",10]},{"id":13,"old":[450,1.5,"MRL","2:1","Ziehl Abegg","SM 200.15D","Gearless",6.8,19.5,240,6.5,6,7.5,"17 A",11,"27 A","20 KVA","1500 VA","32 A","50 ohm 2 KW","50 ohm 3.5kw","6 RM","32 A"],"incoming":[450,1.5,"MRL","2:1","Ziehl Abegg","SM 200.15D","Gearless",6.8,19.5,240,6.5,6,7.5,"17 A",11,"27 A",20,"1500 VA","32 A","50 ohm 2 KW","50 ohm 3.5kw","6 RM","32 A",11]},{"id":14,"old":[630,1,"MR","2:1","Ziehl Abegg","SM200.15D","Gearless",4.4,13,240,6.5,6,5.5,"14 A",7.5,"18 A","15 KVA","1500 VA","32 A","50 ohm 2 KW","80 ohm 2.5 kw","6 RM","32 A"],"incoming":[630,1,"MR","2:1","Ziehl Abegg","SM200.15D","Gearless",4.4,13,240,6.5,6,5.5,"14 A",7.5,"18 A",15,"1500 VA","32 A","50 ohm 2 KW","80 ohm 2.5 kw","6 RM","32 A",12]},{"id":15,"old":[630,1.5,"MR","2:1","Ziehl Abegg","SM200.15D","Gearless",6.8,19.5,240,6.5,6,7.5,"17 A",11,"27 A","20 KVA","1500 VA","32 A","50 ohm 2 KW","50 ohm 3.5kw","6 RM","32 A"],"incoming":[630,1.5,"MR","2:1","Ziehl Abegg","SM200.15D","Gearless",6.8,19.5,240,6.5,6,7.5,"17 A",11,"27 A",20,"1500 VA","32 A","50 ohm 2 KW","50 ohm 3.5kw","6 RM","32 A",13]},{"id":16,"old":[630,1,"MR","2:1","Montanari","MGX75","Gearless",4.1,10,320,8,5,5.5,"14 A",7.5,"18 A","15 KVA","1500 VA","32 A","50 ohm 2 KW","80 ohm 2.5 kw","6 RM","32 A"],"incoming":[630,1,"MR","2:1","Montanari","MGX75","Gearless",4.1,10,320,8,5,5.5,"14 A",7.5,"18 A",15,"1500 VA","32 A","50 ohm 2 KW","80 ohm 2.5 kw","6 RM","32 A",14]},{"id":17,"old":[630,1.5,"MR","2:1","Montanari","MGX75","Gearless",6.1,14.5,320,8,5,7.5,"17 A",7.5,"18 A","20 KVA","1500 VA","32 A","50 ohm 2 KW","80 ohm 2.5 kw","6 RM","32 A"],"incoming":[630,1.5,"MR","2:1","Montanari","MGX75","Gearless",6.1,14.5,320,8,5,7.5,"17 A",7.5,"18 A",20,"1500 VA","32 A","50 ohm 2 KW","80 ohm 2.5 kw","6 RM","32 A",15]},{"id":18,"old":[630,1,"MR","2:1","Monadrive","MCK100-E","Gearless",3.9,10,320,8,5,5.5,"14 A",7.5,"18 A","15 KVA","1500 VA","32 A","50 ohm 2 KW","80 ohm 2.5 kw","6 RM","32 A"],"incoming":[630,1,"MR","2:1","Monadrive","MCK100-E","Gearless",3.9,10,320,8,5,5.5,"14 A",7.5,"18 A",15,"1500 VA","32 A","50 ohm 2 KW","80 ohm 2.5 kw","6 RM","32 A",16]},{"id":19,"old":[630,1.5,"MR","2:1","Monadrive","MCK100-E","Gearless",5.8,16,320,8,5,7.5,"17 A",7.5,"18 A","20 KVA","1500 VA","32 A","50 ohm 2 KW","80 ohm 2.5 kw","6 RM","32 A"],"incoming":[630,1.5,"MR","2:1","Monadrive","MCK100-E","Gearless",5.8,16,320,8,5,7.5,"17 A",7.5,"18 A",20,"1500 VA","32 A","50 ohm 2 KW","80 ohm 2.5 kw","6 RM","32 A",17]},{"id":20,"old":[630,1,"MRL","2:1","Monadrive","Mona 200","Gearless",4,10,240,6.5,7,5.5,"14 A",7.5,"18 A","15 KVA","1500 VA","32 A","50 ohm 2 KW","80 ohm 2.5 kw","6 RM","32 A"],"incoming":[630,1,"MRL","2:1","Monadrive","Mona 200","Gearless",4,10,240,6.5,7,5.5,"14 A",7.5,"18 A",15,"1500 VA","32 A","50 ohm 2 KW","80 ohm 2.5 kw","6 RM","32 A",18]},{"id":21,"old":[630,1,"MRL","2:1","Ziehl Abegg","SM 200.15D","Gearless",4.4,13,240,6.5,6,5.5,"14 A",7.5,"18 A","15 KVA","1500 VA","32 A","50 ohm 2 KW","80 ohm 2.5 kw","6 RM","32 A"],"incoming":[630,1,"MRL","2:1","Ziehl Abegg","SM 200.15D","Gearless",4.4,13,240,6.5,6,5.5,"14 A",7.5,"18 A",15,"1500 VA","32 A","50 ohm 2 KW","80 ohm 2.5 kw","6 RM","32 A",19]},{"id":22,"old":[630,1,"MRL","2:1","Ziehl Abegg","SM 200.15D","Gearless",4.4,13,240,6.5,6,5.5,"14 A",7.5,"18 A","15 KVA","1500 VA","32 A","50 ohm 2 KW","80 ohm 2.5 kw","6 RM","32 A"],"incoming":[630,1,"MRL","2:1","Ziehl Abegg","SM 200.15D","Gearless",4.4,13,240,6.5,6,5.5,"14 A",7.5,"18 A",15,"1500 VA","32 A","50 ohm 2 KW","80 ohm 2.5 kw","6 RM","32 A",20]},{"id":23,"old":[630,1.5,"MRL","2:1","Ziehl Abegg","SM 200.15D","Gearless",6.8,19.6,240,6.5,6,7.5,"17 A",11,"27 A","20 KVA","1500 VA","32 A","50 ohm 2 KW","50 ohm 3.5kw","6 RM","32 A"],"incoming":[630,1.5,"MRL","2:1","Ziehl Abegg","SM 200.15D","Gearless",6.8,19.6,240,6.5,6,7.5,"17 A",11,"27 A",20,"1500 VA","32 A","50 ohm 2 KW","50 ohm 3.5kw","6 RM","32 A",21]},{"id":24,"old":[800,1,"MR","2:1","Ziehl Abegg","SM500.12AL","Gearless",5.1,12,400,10,5,5.5,"14 A",7.5,"18 A","20 KVA","1500 VA","32 A","50 ohm 2 KW","80 ohm 2.5 kw","6 RM","32 A"],"incoming":[800,1,"MR","2:1","Ziehl Abegg","SM500.12AL","Gearless",5.1,12,400,10,5,5.5,"14 A",7.5,"18 A",20,"1500 VA","32 A","50 ohm 2 KW","80 ohm 2.5 kw","6 RM","32 A",22]},{"id":25,"old":[800,1.5,"MR","2:1","Ziehl Abegg","SM200.30C","Gearless",9.6,24.5,320,8,6,11,"26 A",11,"27 A","30 KVA","1500 VA","32 A","40 ohm 3 kw","50 ohm 3.5kw","10 RM","50 A"],"incoming":[800,1.5,"MR","2:1","Ziehl Abegg","SM200.30C","Gearless",9.6,24.5,320,8,6,11,"26 A",15,"33 A",30,"1500 VA","50 A","40 ohm 3 kw","40 ohm 4.5 kw","10 RM","50 A",23]},{"id":26,"old":[800,1,"MR","2:1","Montanari","MGX80","Gearless",6.7,15,400,10,5,7.5,"17 A",11,"27 A","20 KVA","1500 VA","32 A","50 ohm 2 KW","50 ohm 3.5kw","6 RM","32 A"],"incoming":[800,1,"MR","2:1","Montanari","MGX80","Gearless",6.7,15,400,10,5,7.5,"17 A",11,"27 A",20,"1500 VA","32 A","50 ohm 2 KW","50 ohm 3.5kw","6 RM","32 A",24]},{"id":27,"old":[800,1.5,"MR","2:1","Montanari","MGX80","Gearless",10.7,23,400,10,5,11,"26 A",11,"27 A","30 KVA","1500 VA","32 A","40 ohm 3 kw","50 ohm 3.5kw","10 RM","50 A"],"incoming":[800,1.5,"MR","2:1","Montanari","MGX80","Gearless",10.7,23,400,10,5,11,"26 A",15,"33 A",30,"1500 VA","50 A","40 ohm 3 kw","40 ohm 4.5 kw","10 RM","50 A",25]},{"id":28,"old":[800,1,"MR","2:1","Monadrive","MCK200-E","Gearless",5.2,12,400,10,5,5.5,"14 A",7.5,"18 A","20 KVA","1500 VA","32 A","50 ohm 2 KW","80 ohm 2.5 kw","6 RM","32 A"],"incoming":[800,1,"MR","2:1","Monadrive","MCK200-E","Gearless",5.2,12,400,10,5,5.5,"14 A",7.5,"18 A",20,"1500 VA","32 A","50 ohm 2 KW","80 ohm 2.5 kw","6 RM","32 A",26]},{"id":29,"old":[800,1.5,"MR","2:1","Monadrive","MCK200-E","Gearless",7.8,18,400,10,5,11,"26 A",11,"27 A","20 KVA","1500 VA","32 A","40 ohm 3 kw","50 ohm 3.5kw","6 RM","32 A"],"incoming":[800,1.5,"MR","2:1","Monadrive","MCK200-E","Gearless",7.8,18,400,10,5,11,"26 A",11,"27 A",20,"1500 VA","32 A","40 ohm 3 kw","50 ohm 3.5kw","6 RM","32 A",27]},{"id":30,"old":[800,1,"MRL","2:1","Montanari","MGV 25M","Gearless",7.7,20,240,6.5,8,11,"26 A",11,"27 A","20 KVA","1500 VA","32 A","40 ohm 3 kw","50 ohm 3.5kw","6 RM","32 A"],"incoming":[800,1,"MRL","2:1","Montanari","MGV 25M","Gearless",7.7,20,240,6.5,8,11,"26 A",11,"27 A",20,"1500 VA","32 A","40 ohm 3 kw","50 ohm 3.5kw","6 RM","32 A",28]},{"id":31,"old":[800,1,"MRL","2:1","Ziehl Abegg","SM 200.23D","Gearless",6.7,18.5,240,6.5,8,11,"26 A",11,"27 A","20 KVA","1500 VA","32 A","40 ohm 3 kw","50 ohm 3.5kw","6 RM","32 A"],"incoming":[800,1,"MRL","2:1","Ziehl Abegg","SM 200.23D","Gearless",6.7,18.5,240,6.5,8,11,"26 A",11,"27 A",20,"1500 VA","32 A","40 ohm 3 kw","50 ohm 3.5kw","6 RM","32 A",29]},{"id":32,"old":[800,1.5,"MRL","2:1","Ziehl Abegg","SM 200.23D","Gearless",12.8,34,240,6.5,8,15,"35 A",15,"33 A","40 KVA","1500 VA","50 A","25 ohm 8 kw","40 ohm 4.5 kw","10 RM","63 A"],"incoming":[800,1.5,"MRL","2:1","Ziehl Abegg","SM 200.23D","Gearless",12.8,34,240,6.5,8,15,"35 A",22,"48 A",40,"1500 VA","50 A","25 ohm 8 kw","24 ohm 6.5 kw","10 RM","50 A",30]},{"id":33,"old":[1000,1,"MR","2:1","Ziehl Abegg","SM500.16AL","Gearless",6.4,15,400,10,5,7.5,"17 A",11,"27 A","20 KVA","1500 VA","32 A","50 ohm 2 KW","50 ohm 3.5kw","6 RM","32 A"],"incoming":[1000,1,"MR","2:1","Ziehl Abegg","SM500.16AL","Gearless",6.4,15,400,10,5,7.5,"17 A",11,"27 A",20,"1500 VA","32 A","50 ohm 2 KW","50 ohm 3.5kw","6 RM","32 A",31]},{"id":34,"old":[1000,1.5,"MR","2:1","Ziehl Abegg","SM500.16AL","Gearless",11,26,400,10,5,11,"26 A",15,"33 A","30 KVA","1500 VA","50 A","40 ohm 3 kw","40 ohm 4.5 kw","10 RM","50 A"],"incoming":[1000,1.5,"MR","2:1","Ziehl Abegg","SM500.16AL","Gearless",11,26,400,10,5,11,"26 A",15,"33 A",40,"1500 VA","50 A","40 ohm 3 kw","40 ohm 4.5 kw","10 RM","50 A",32]},{"id":35,"old":[1000,1,"MRL","2:1","Ziehl Abegg","SM200.30D-20","Gearless",8.4,23,240,6.5,11,11,"26 A",15,"33 A","30 KVA","1500 VA","50 A","40 ohm 3 kw","40 ohm 4.5 kw","10 RM","50 A"],"incoming":[1000,1,"MRL","2:1","Ziehl Abegg","SM200.30D-20","Gearless",8.4,23,240,6.5,11,11,"26 A",15,"33 A",30,"1500 VA","50 A","40 ohm 3 kw","40 ohm 4.5 kw","10 RM","50 A",33]},{"id":36,"old":[1000,1.5,"MRL","2:1","Ziehl Abegg","SM200.30D-20","Gearless",12.8,34,240,6.5,11,15,"35 A",22,"48 A","40 KVA","1500 VA","50 A","25 ohm 8 kw","24 ohm 6.5 kw","10 RM","63 A"],"incoming":[1000,1.5,"MRL","2:1","Ziehl Abegg","SM200.30D-20","Gearless",12.8,34,240,6.5,11,15,"35 A",22,"48 A",40,"1500 VA","50 A","25 ohm 8 kw","24 ohm 6.5 kw","10 RM","50 A",34]},{"id":37,"old":[1000,1,"MR","2:1","Montanari","MGX80","Gearless",6.7,15,400,10,5,7.5,"17 A",11,"27 A","20 KVA","1500 VA","32 A","50 ohm 2 KW","50 ohm 3.5kw","6 RM","32 A"],"incoming":[1000,1,"MR","2:1","Montanari","MGX80","Gearless",6.7,15,400,10,5,7.5,"17 A",11,"27 A",20,"1500 VA","32 A","50 ohm 2 KW","50 ohm 3.5kw","6 RM","32 A",35]},{"id":38,"old":[1000,1.5,"MR","2:1","Montanari","MGX80","Gearless",10.7,23,400,10,5,11,"26 A",11,"27 A","30 KVA","1500 VA","32 A","40 ohm 3 kw","50 ohm 3.5kw","10 RM","50 A"],"incoming":[1000,1.5,"MR","2:1","Montanari","MGX80","Gearless",10.7,23,400,10,5,11,"26 A",15,"33 A",40,"1500 VA","50 A","40 ohm 3 kw","40 ohm 4.5 kw","10 RM","50 A",36]},{"id":39,"old":[1000,1,"MR","2:1","Monadrive","MCK200","Gearless",6.5,15,400,10,5,7.5,"17 A",11,"27 A","20 KVA","1500 VA","32 A","50 ohm 2 KW","50 ohm 3.5kw","6 RM","32 A"],"incoming":[1000,1,"MR","2:1","Monadrive","MCK200","Gearless",6.5,15,400,10,5,7.5,"17 A",11,"27 A",20,"1500 VA","32 A","50 ohm 2 KW","50 ohm 3.5kw","6 RM","32 A",37]},{"id":40,"old":[1000,1,"MRL","2:1","Monadrive","MONA320","Gearless",6.3,16,240,6.5,11,7.5,"17 A",11,"27 A","20 KVA","1500 VA","32 A","50 ohm 2 KW","50 ohm 3.5kw","6 RM","32 A"],"incoming":[1000,1,"MRL","2:1","Monadrive","MONA320","Gearless",6.3,16,240,6.5,11,7.5,"17 A",11,"27 A",20,"1500 VA","32 A","50 ohm 2 KW","50 ohm 3.5kw","6 RM","32 A",38]},{"id":41,"old":[1000,1.5,"MR","2:1","Monadrive","MCK200","Gearless",9.7,23,400,10,5,11,"26 A",11,"27 A","30 KVA","1500 VA","32 A","40 ohm 3 kw","50 ohm 3.5kw","10 RM","50 A"],"incoming":[1000,1.5,"MR","2:1","Monadrive","MCK200","Gearless",9.7,23,400,10,5,11,"26 A",11,"27 A",30,"1500 VA","32 A","40 ohm 3 kw","50 ohm 3.5kw","10 RM","50 A",39]},{"id":42,"old":[1000,1.5,"MRL","2:1","Monadrive","MONA320","Gearless",9.5,25,240,6.5,11,11,"26 A",15,"33 A","30 KVA","1500 VA","50 A","40 ohm 3 kw","40 ohm 4.5 kw","10 RM","50 A"],"incoming":[1000,1.5,"MRL","2:1","Monadrive","MONA320","Gearless",9.5,25,240,6.5,11,11,"26 A",15,"33 A",30,"1500 VA","50 A","40 ohm 3 kw","40 ohm 4.5 kw","10 RM","50 A",40]},{"id":43,"old":[1150,1,"MR","2:1","Ziehl Abegg","SM 500.16AL","Gearless",6.4,15,400,10,5,7.5,"17 A",11,"27 A","20 KVA","1500 VA","32 A","50 ohm 2 KW","50 ohm 3.5kw","6 RM","32 A"],"incoming":[1150,1,"MR","2:1","Ziehl Abegg","SM 500.16AL","Gearless",6.4,15,400,10,5,7.5,"17 A",11,"27 A",20,"1500 VA","32 A","50 ohm 2 KW","50 ohm 3.5kw","6 RM","32 A",41]},{"id":44,"old":[1150,1.5,"MR","2:1","Ziehl Abegg","SM 500.16AL","Gearless",11,26,400,10,5,11,"26 A",15,"33 A","30 KVA","1500 VA","50 A","40 ohm 3 kw","40 ohm 4.5 kw","10 RM","50 A"],"incoming":[1150,1.5,"MR","2:1","Ziehl Abegg","SM 500.16AL","Gearless",11,26,400,10,5,11,"26 A",15,"33 A",40,"1500 VA","50 A","40 ohm 3 kw","40 ohm 4.5 kw","10 RM","50 A",42]},{"id":45,"old":[1150,1,"MR","2:1","Montanari","MGX90","Gearless",10.4,23.5,400,10,5,11,"26 A",15,"33 A","30 KVA","1500 VA","50 A","40 ohm 3 kw","40 ohm 4.5 kw","10 RM","50 A"],"incoming":[1150,1,"MR","2:1","Montanari","MGX90","Gearless",10.4,23.5,400,10,5,11,"26 A",15,"33 A",30,"1500 VA","50 A","40 ohm 3 kw","40 ohm 4.5 kw","10 RM","50 A",43]},{"id":46,"old":[1150,1.5,"MR","2:1","Montanari","MGX90","Gearless",14.7,33,400,10,5,15,"35 A",22,"48 A","40 KVA","1500 VA","50 A","25 ohm 8 kw","24 ohm 6.5 kw","10 RM","63 A"],"incoming":[1150,1.5,"MR","2:1","Montanari","MGX90","Gearless",14.7,33,400,10,5,15,"35 A",22,"48 A",40,"1500 VA","50 A","25 ohm 8 kw","24 ohm 6.5 kw","10 RM","50 A",44]},{"id":47,"old":[1150,1,"MR","2:1","Monadrive","MCK200","Gearless",7.5,17,400,10,5,11,"26 A",11,"27 A","20 KVA","1500 VA","32 A","40 ohm 3 kw","50 ohm 3.5kw","6 RM","32 A"],"incoming":[1150,1,"MR","2:1","Monadrive","MCK200","Gearless",7.5,17,400,10,5,11,"26 A",11,"27 A",20,"1500 VA","32 A","40 ohm 3 kw","50 ohm 3.5kw","6 RM","32 A",45]},{"id":48,"old":[1150,1.5,"MR","2:1","Monadrive","MCK200","Gearless",11,25,400,10,5,11,"26 A",15,"33 A","30 KVA","1500 VA","50 A","40 ohm 3 kw","40 ohm 4.5 kw","10 RM","50 A"],"incoming":[1150,1.5,"MR","2:1","Monadrive","MCK200","Gearless",11,25,400,10,5,11,"26 A",15,"33 A",40,"1500 VA","50 A","40 ohm 3 kw","40 ohm 4.5 kw","10 RM","50 A",46]},{"id":49,"old":[1250,1,"MR","2:1","Ziehl Abegg","SM200.45E-20","Gearless",8.9,24,320,8,8,11,"26 A",15,"33 A","30 KVA","1500 VA","50 A","40 ohm 3 kw","40 ohm 4.5 kw","10 RM","50 A"],"incoming":[1250,1,"MR","2:1","Ziehl Abegg","SM200.45E-20","Gearless",8.9,24,320,8,8,11,"26 A",15,"33 A",30,"1500 VA","50 A","40 ohm 3 kw","40 ohm 4.5 kw","10 RM","50 A",47]},{"id":50,"old":[1250,1,"MRL","2:1","Ziehl Abegg","SM200.45E-20","Gearless",8.9,24,320,8,8,11,"26 A",15,"33 A","30 KVA","1500 VA","50 A","40 ohm 3 kw","40 ohm 4.5 kw","10 RM","50 A"],"incoming":[1250,1,"MRL","2:1","Ziehl Abegg","SM200.45E-20","Gearless",8.9,24,320,8,8,11,"26 A",15,"33 A",30,"1500 VA","50 A","40 ohm 3 kw","40 ohm 4.5 kw","10 RM","50 A",48]},{"id":51,"old":[1250,1.5,"MR","2:1","Ziehl Abegg","SM200.45E-20","Gearless",14.3,36,320,8,7,15,"35 A",22,"48 A","40 KVA","1500 VA","50 A","25 ohm 8 kw","24 ohm 6.5 kw","10 RM","63 A"],"incoming":[1250,1.5,"MR","2:1","Ziehl Abegg","SM200.45E-20","Gearless",14.3,36,320,8,7,15,"35 A",22,"48 A",40,"1500 VA","50 A","25 ohm 8 kw","24 ohm 6.5 kw","10 RM","50 A",49]},{"id":52,"old":[1250,1.5,"MRL","2:1","Ziehl Abegg","SM200.45E-20","Gearless",14.3,36,320,8,7,15,"35 A",22,"48 A","40 KVA","1500 VA","50 A","25 ohm 8 kw","24 ohm 6.5 kw","10 RM","63 A"],"incoming":[1250,1.5,"MRL","2:1","Ziehl Abegg","SM200.45E-20","Gearless",14.3,36,320,8,7,15,"35 A",22,"48 A",40,"1500 VA","50 A","25 ohm 8 kw","24 ohm 6.5 kw","10 RM","50 A",50]},{"id":53,"old":[1350,1,"MR","2:1","Ziehl Abegg","SM200.45E-20","Gearless",8.9,24,320,8,8,11,"26 A",15,"33 A","30 KVA","1500 VA","50 A","40 ohm 3 kw","40 ohm 4.5 kw","10 RM","50 A"],"incoming":[1350,1,"MR","2:1","Ziehl Abegg","SM200.45E-20","Gearless",8.9,24,320,8,8,11,"26 A",15,"33 A",30,"1500 VA","50 A","40 ohm 3 kw","40 ohm 4.5 kw","10 RM","50 A",51]},{"id":54,"old":[1350,1,"MRL","2:1","Ziehl Abegg","SM200.45E-20","Gearless",8.9,24,320,8,8,11,"26 A",15,"33 A","30 KVA","1500 VA","50 A","40 ohm 3 kw","40 ohm 4.5 kw","10 RM","50 A"],"incoming":[1350,1,"MRL","2:1","Ziehl Abegg","SM200.45E-20","Gearless",8.9,24,320,8,8,11,"26 A",15,"33 A",30,"1500 VA","50 A","40 ohm 3 kw","40 ohm 4.5 kw","10 RM","50 A",52]},{"id":55,"old":[1350,1.5,"MR","2:1","Ziehl Abegg","SM200.45E-20","Gearless",14.3,36,320,8,7,22,"50 A",22,"48 A","40 KVA","1500 VA","50 A","18 ohm 8 kw","24 ohm 6.5 kw","10 RM","63 A"],"incoming":[1350,1.5,"MR","2:1","Ziehl Abegg","SM200.45E-20","Gearless",14.3,36,320,8,7,22,"50 A",22,"48 A",40,"1500 VA","50 A","18 ohm 8 kw","24 ohm 6.5 kw","10 RM","50 A",53]},{"id":56,"old":[1350,1.5,"MRL","2:1","Ziehl Abegg","SM200.45E-20","Gearless",14.3,36,320,8,7,22,"50 A",22,"48 A","40 KVA","1500 VA","50 A","18 ohm 8 kw","24 ohm 6.5 kw","10 RM","63 A"],"incoming":[1350,1.5,"MRL","2:1","Ziehl Abegg","SM200.45E-20","Gearless",14.3,36,320,8,7,22,"50 A",22,"48 A",40,"1500 VA","50 A","18 ohm 8 kw","24 ohm 6.5 kw","10 RM","50 A",54]},{"id":57,"old":[1350,1,"MR","2:1","Monadrive","MCK300E","Gearless",8.6,22,480,10,7,11,"26 A",11,"27 A","30 KVA","1500 VA","32 A","40 ohm 3 kw","50 ohm 3.5kw","10 RM","50 A"],"incoming":[1350,1,"MR","2:1","Monadrive","MCK300E","Gearless",8.6,22,480,10,7,11,"26 A",11,"27 A",30,"1500 VA","32 A","40 ohm 3 kw","50 ohm 3.5kw","10 RM","50 A",56]},{"id":58,"old":[1350,1.5,"MR","2:1","Monadrive","MCK300E","Gearless",12.9,30,480,10,7,15,"35 A",15,"33 A","40 KVA","1500 VA","50 A","25 ohm 8 kw","40 ohm 4.5 kw","10 RM","63 A"],"incoming":[1350,1.5,"MR","2:1","Monadrive","MCK300E","Gearless",12.9,30,480,10,7,15,"35 A",22,"48 A",40,"1500 VA","50 A","25 ohm 8 kw","24 ohm 6.5 kw","10 RM","50 A",57]},{"id":59,"old":[1600,1,"MR","2:1","Ziehl Abegg","SM210.60B-20","Gearless",10.7,29,320,8,10,15,"35 A",15,"33 A","30 KVA","1500 VA","50 A","25 ohm 8 kw","40 ohm 4.5 kw","10 RM","50 A"],"incoming":[1600,1,"MR","2:1","Ziehl Abegg","SM210.60B-20","Gearless",10.7,29,320,8,10,15,"35 A",22,"48 A",30,"1500 VA","50 A","25 ohm 8 kw","24 ohm 6.5 kw","10 RM","50 A",58]},{"id":60,"old":[1600,1,"MRL","2:1","Ziehl Abegg","SM210.60B-20","Gearless",10.7,29,320,8,10,15,"35 A",15,"33 A","30 KVA","1500 VA","50 A","25 ohm 8 kw","40 ohm 4.5 kw","10 RM","50 A"],"incoming":[1600,1,"MRL","2:1","Ziehl Abegg","SM210.60B-20","Gearless",10.7,29,320,8,10,15,"35 A",22,"48 A",30,"1500 VA","50 A","25 ohm 8 kw","24 ohm 6.5 kw","10 RM","50 A",59]},{"id":61,"old":[1600,1.5,"MR","2:1","Ziehl Abegg","SM210.60B-20","Gearless",17.1,44,320,8,10,22,"50 A",22,"48 A","40 KVA","1500 VA","50 A","18 ohm 8 kw","24 ohm 6.5 kw","10 RM","63 A"],"incoming":[1600,1.5,"MR","2:1","Ziehl Abegg","SM210.60B-20","Gearless",17.1,44,320,8,10,22,"50 A",30,"60 A",40,"1500 VA","80 A","18 ohm 8 kw","20 ohm 9 kw","10 RM","50 A",60]},{"id":62,"old":[1600,1.5,"MRL","2:1","Ziehl Abegg","SM210.60B-20","Gearless",17.1,44,320,8,10,22,"50 A",22,"48 A","40 KVA","1500 VA","50 A","18 ohm 8 kw","24 ohm 6.5 kw","10 RM","63 A"],"incoming":[1600,1.5,"MRL","2:1","Ziehl Abegg","SM210.60B-20","Gearless",17.1,44,320,8,10,22,"50 A",30,"60 A",40,"1500 VA","80 A","18 ohm 8 kw","20 ohm 9 kw","10 RM","50 A",61]},{"id":63,"old":[1600,1,"MR","2:1","Montanari","MGV34S","Gearless",10.6,28,320,8,10,15,"35 A",15,"33 A","30 KVA","1500 VA","50 A","25 ohm 8 kw","40 ohm 4.5 kw","10 RM","50 A"],"incoming":[1600,1,"MR","2:1","Montanari","MGV34S","Gearless",10.6,28,320,8,10,15,"35 A",22,"48 A",30,"1500 VA","50 A","25 ohm 8 kw","24 ohm 6.5 kw","10 RM","50 A",62]},{"id":64,"old":[1600,1,"MRL","2:1","Montanari","MGV34S","Gearless",10.6,28,320,8,10,15,"35 A",15,"33 A","30 KVA","1500 VA","50 A","25 ohm 8 kw","40 ohm 4.5 kw","10 RM","50 A"],"incoming":[1600,1,"MRL","2:1","Montanari","MGV34S","Gearless",10.6,28,320,8,10,15,"35 A",22,"48 A",30,"1500 VA","50 A","25 ohm 8 kw","24 ohm 6.5 kw","10 RM","50 A",63]},{"id":65,"old":[1600,1.5,"MR","2:1","Montanari","MGV34S","Gearless",18.6,43,320,8,10,22,"50 A",22,"48 A","40 KVA","1500 VA","50 A","18 ohm 8 kw","24 ohm 6.5 kw","10 RM","63 A"],"incoming":[1600,1.5,"MR","2:1","Montanari","MGV34S","Gearless",18.6,43,320,8,10,22,"50 A",30,"60 A",40,"1500 VA","80 A","18 ohm 8 kw","20 ohm 9 kw","10 RM","50 A",64]},{"id":66,"old":[1600,1.5,"MRL","2:1","Montanari","MGV34S","Gearless",18.6,43,320,8,10,22,"50 A",22,"48 A","40 KVA","1500 VA","50 A","18 ohm 8 kw","24 ohm 6.5 kw","10 RM","63 A"],"incoming":[1600,1.5,"MRL","2:1","Montanari","MGV34S","Gearless",18.6,43,320,8,10,22,"50 A",30,"60 A",40,"1500 VA","80 A","18 ohm 8 kw","20 ohm 9 kw","10 RM","50 A",65]},{"id":67,"old":[1600,1,"MR","2:1","Monadrive","MCK300E","Gearless",10.4,24,480,10,8,11,"26 A",15,"33 A","30 KVA","1500 VA","50 A","40 ohm 3 kw","40 ohm 4.5 kw","10 RM","50 A"],"incoming":[1600,1,"MR","2:1","Monadrive","MCK300E","Gearless",10.4,24,480,10,8,11,"26 A",15,"33 A",30,"1500 VA","50 A","40 ohm 3 kw","40 ohm 4.5 kw","10 RM","50 A",66]},{"id":68,"old":[1600,1.5,"MR","2:1","Monadrive","MCK300E","Gearless",15.6,35,480,10,8,15,"35 A",22,"48 A","60 KVA","1500 VA","50 A","25 ohm 8 kw","24 ohm 6.5 kw","16 RM","100 A"],"incoming":[1600,1.5,"MR","2:1","Monadrive","MCK300E","Gearless",15.6,35,480,10,8,15,"35 A",22,"48 A",60,"1500 VA","50 A","25 ohm 8 kw","24 ohm 6.5 kw","10 RM","50 A",67]},{"id":69,"old":[2000,1,"MR","2:1","Torin","GTW10X","Gearless",12.4,28.4,410,10,9,15,"35 A",15,"33 A","40 KVA","1500 VA","50 A","25 ohm 8 kw","40 ohm 4.5 kw","10 RM","63 A"],"incoming":[2000,1,"MR","2:1","Torin","GTW10X","Gearless",12.4,28.4,410,10,9,15,"35 A",22,"48 A",40,"1500 VA","50 A","25 ohm 8 kw","24 ohm 6.5 kw","10 RM","50 A",68]},{"id":70,"old":[2000,1.5,"MR","2:1","Montanari","MGV34M","Gearless",19.8,43,320,8,10,22,"50 A",22,"48 A","60 KVA","1500 VA","50 A","18 ohm 8 kw","24 ohm 6.5 kw","16 RM","100 A"],"incoming":[2000,1.5,"MR","2:1","Montanari","MGV34M","Gearless",19.8,43,320,8,10,22,"50 A",30,"60 A",60,"3000 VA","80 A","18 ohm 8 kw","20 ohm 9 kw","10 RM","50 A",69]},{"id":71,"old":[2500,1,"MR","2:1","Monadrive","MCK500E","Gearless",16.3,38,480,10,9,22,"50 A",22,"48 A","60 KVA","3000 VA","50 A","18 ohm 8 kw","24 ohm 6.5 kw","16 RM","100 A"],"incoming":[2500,1,"MR","2:1","Monadrive","MCK500E","Gearless",16.3,38,480,10,9,22,"50 A",22,"48 A",60,"3000 VA","50 A","18 ohm 8 kw","24 ohm 6.5 kw","10 RM","50 A",70]},{"id":72,"old":[3000,1,"MR","4:1","Ziehl Abegg","SM210.60B","Gearless",21.6,54,320,8,10,37,"75 A",30,"60 A","60 KVA","3000 VA","80 A","10 ohm 16 kw","20 ohm 9 kw","16 RM","100 A"],"incoming":[3000,1,"MR","4:1","Ziehl Abegg","SM210.60B","Gearless",21.6,54,320,8,10,37,"75 A",37,"75 A",60,"3000 VA","80 A","10 ohm 16 kw","15 ohm 11 kw","16 RM","63 A",71]},{"id":73,"old":[3000,1,"MR","4:1","SJEC","JTYB-3F","Gearless",19.58,42,450,10,7,22,"50 A",22,"48 A","60 KVA","3000 VA","50 A","18 ohm 8 kw","24 ohm 6.5 kw","16 RM","100 A"],"incoming":[3000,1,"MR","4:1","SJEC","JTYB-3F","Gearless",19.58,42,450,10,7,22,"50 A",30,"60 A",60,"3000 VA","80 A","18 ohm 8 kw","20 ohm 9 kw","16 RM","63 A",72]},{"id":74,"old":[3000,0.5,"MR","4:1","Torin","GTW10X","Gearless",9.2,20.5,485,10,8,15,"35 A",15,"33 A","40 KVA","3000 VA","50 A","25 ohm 8 kw","40 ohm 4.5 kw","10 RM","63 A"],"incoming":[3000,0.5,"MR","4:1","Torin","GTW10X","Gearless",9.2,20.5,485,10,8,15,"35 A",15,"33 A",40,"1500 VA","50 A","25 ohm 8 kw","40 ohm 4.5 kw","10 RM","50 A",73]},{"id":75,"old":[4000,0.5,"MR","2:1","Torin","YJ320A","Geared",26,48.5,700,16,8,22,"50 A",30,"60 A","80 KVA","3000 VA","80 A","18 ohm 8 kw","20 ohm 9 kw","16 RM","100 A"],"incoming":[4000,0.5,"MR","2:1","Torin","YJ320A","Geared",26,48.5,700,16,8,22,"50 A",37,"75 A",80,"3000 VA","80 A","18 ohm 8 kw","15 ohm 11 kw","16 RM","63 A",74]},{"id":76,"old":[5000,1,"MR","4:1","Monadrive","MCK500E","Gearless",30.6,71,520,10,9,37,"75 A",45,"91 A","80 KVA","3000 VA","80 A","10 ohm 16 kw","11 ohm 13.5 kw","16 RM","100 A"],"incoming":[5000,1,"MR","4:1","Monadrive","MCK500E","Gearless",30.6,71,520,10,9,37,"75 A",45,"91 A",80,"3000 VA","80 A","10 ohm 16 kw","11 ohm 13.5 kw","16 RM","63 A",75]},{"id":77,"old":[5000,1,"MR","4:1","Ziehl Abegg","SM250.60B","Gearless",38,88,320,8,12,"Null","Null",45,"91 A","100 KVA","Null","80 A","Null","11 ohm 13.5 kw","16 RM","125 A"],"incoming":[5000,1,"MR","4:1","Ziehl Abegg","SM250.60B","Gearless",38,88,320,8,12,"Null","Null",45,"91 A",100,null,"80 A",null,"11 ohm 13.5 kw","16 RM","63 A",76]},{"id":78,"old":[5000,0.5,"MR","2:1","Torin","YJ320A","Geared",30,56,700,16,8,37,"75 A",37,"75 A","80 KVA","3000 VA","80 A","10 ohm 16 kw","15 ohm 11 kw","16 RM","100 A"],"incoming":[5000,0.5,"MR","2:1","Torin","YJ320A","Geared",30,56,700,16,8,37,"75 A",37,"75 A",80,"3000 VA","80 A","10 ohm 16 kw","15 ohm 11 kw","16 RM","63 A",77]},{"id":79,"old":[6000,1,"MR","4:1","Monadrive","MCK500","Gearless",36.6,82,520,10,10,"Null","Null",45,"91 A","100 KVA","Null","80 A","Null","11 ohm 13.5 kw","16 RM","125 A"],"incoming":[6000,1,"MR","4:1","Monadrive","MCK500","Gearless",36.6,82,520,10,10,"Null","Null",45,"91 A",100,null,"80 A",null,"11 ohm 13.5 kw","16 RM","63 A",78]}]'::jsonb) loop
        select * into old_row from public.wlf_components where id=(component->>'id')::bigint;
        if not found then
          insert into wlf_private.v220_import_audit(item,decision) values('component:'||(component->>'id'),'preserved: previously deleted');
        elsif old_row.revision=1 and old_row.values=component->'old' then
          update public.wlf_components set values=component->'incoming',revision=revision+1 where id=old_row.id;
          insert into wlf_private.v220_import_audit(item,decision,before_state) values('component:'||old_row.id,'imported',to_jsonb(old_row));
        else
          insert into wlf_private.v220_import_audit(item,decision,before_state) values('component:'||old_row.id,'preserved: customized',to_jsonb(old_row));
        end if;
      end loop;
      incoming='[1350,1,"MR","2:1","Montanari","MGV34S","Gearless",10.7,28,320,8,8,15,"35 A",22,"48 A",30,"1500 VA","50 A","25 ohm 8 kw","24 ohm 6.5 kw","10 RM","50 A",55]'::jsonb;
      if exists(select 1 from public.wlf_components r where r.values->0=incoming->0 and r.values->1=incoming->1 and
          (select bool_and(lower(regexp_replace(btrim(r.values->>i),'[[:space:].-]+','','g'))=lower(regexp_replace(btrim(incoming->>i),'[[:space:].-]+','','g'))) from generate_series(2,5) i)) then
        insert into wlf_private.v220_import_audit(item,decision) values('component:master-055','preserved: matching configuration exists');
      else
        insert into public.wlf_components(values) values(incoming);
        insert into wlf_private.v220_import_audit(item,decision) values('component:master-055','inserted');
      end if;
      update public.wlf_components set values=values||jsonb_build_array(null::text) where jsonb_array_length(values)=23;
    end if;
  end if;
  for key,incoming in select * from jsonb_each('{"commissioning":{"title":"Commissioning Team Support Request","fields":[{"id":"date","label":"Date","type":"date","required":true,"options":[],"autoFill":"today"},{"id":"identity","label":"Name & ID","type":"text","required":true,"options":[],"autoFill":"identity"},{"id":"pm","label":"PM","type":"select","required":true,"options":["Md. Rejaul Karim(47869)","Masum(51111)"]},{"id":"project","label":"Project Name","type":"text","required":true,"options":[]},{"id":"lift","label":"Lift ID","type":"number","required":true,"options":[]},{"id":"controller","label":"Control System Brand","type":"select","required":true,"options":["NICE3000+","MOT","MOTCUBE","Hydraulic-ARL700","Hydraulic-PLC","Home Lift"]},{"id":"problem_category","label":"Problem Category","type":"select","required":true,"options":["Drive system related problem","Cartop board related problem","CPC/Call card related problem","COP display Issue","LOP display problem","Traction Machine related problem","Encoder problem","UPS/ARD related Issue","Braking Resistor problem","Intercom set issue","Light issue","Transformer","Door inverter","Switch","Sensor","Battery","Fan","AVR","Vibration/Rollback","Bumping","MOTCUBE Activation","Parameters Issue","Other:"]},{"id":"sub","label":"Sub Category","type":"multi","required":false,"options":["1. Assembly / Fixing : Structure (Mechanical)","2. Assembly / Fixing : Cabin (Mechanical)","3. Assembly / Fixing : Machine Room (Mechanical)","4. Assembly / Fixing : Door (Mechanical)","5. Aesthetics (Mechanical)","6.Steel Rope (Mechanical)","7. Motor Related Issue (Mechanical)","8. Drive system related problem","9. Cartop board related problem","10. CPC/Call card related problem","11. COP display Issue","12. LOP display problem","13. Traction Machine related problem","14. Encoder problem","15. UPS/ARD related Issue","16. Braking Resistor problem","17. Intercom set issue","18. Light issue","19. Transformer","20. Door inverter","21. Switch","22. Sensor","23. Battery","24. Fan","25. AVR","26. Vibration/Rollback","27. Bumping","28. Others"]},{"id":"problem","label":"Problem Details","type":"text","required":true,"options":[]},{"id":"remarks","label":"Remarks","type":"text","required":false,"options":[]}]},"aftersales":{"title":"After Sales Team Support Request","fields":[{"id":"date","label":"Date","type":"date","required":true,"options":[],"autoFill":"today"},{"id":"identity","label":"Name & ID","type":"text","required":true,"options":[],"autoFill":"identity"},{"id":"area_csm","label":"Area CSM","type":"select","required":true,"options":["Alamgir Hosen(54655)","Ashraful Alam(54950)","Mehedi Hasan(55514)","Ahmed Ashiq(54760)","Palash Chandra Roy(55009)"]},{"id":"project","label":"Project Name","type":"text","required":true,"options":[]},{"id":"lift","label":"Lift ID","type":"number","required":true,"options":[]},{"id":"controller","label":"Control System Brand","type":"select","required":true,"options":["NICE3000+","MOT","MOTCUBE","Hydraulic-ARL700","Hydraulic-PLC","Home Lift"]},{"id":"problem_category","label":"Problem Category","type":"select","required":true,"options":["Drive system related problem","Cartop board related problem","CPC/Call card related problem","COP display Issue","LOP display problem","Traction Machine related problem","Encoder problem","UPS/ARD related Issue","Braking Resistor problem","Intercom set issue","Light issue","Transformer","Door inverter","Switch","Sensor","Battery","Fan","AVR","Vibration/Rollback","Bumping","MOTCUBE Activation","Parameters Issue","Other:"]},{"id":"sub","label":"Sub Category","type":"multi","required":false,"options":["1. Aesthetics (Mechanical)","2. Steel Rope (Mechanical)","3. Motor Related Issue (Mechanical)","4. Drive system related problem","5. Cartop board related problem","6. CPC/Call card related problem","7. COP display Issue","8. LOP display problem","9. Traction Machine related problem","10. Encoder problem","11. UPS/ARD related Issue","12. Braking Resistor problem","13. Intercom set issue","14. Light issue","15. Transformer","16. Door inverter","17. Door Motor","18. Switch","19. Sensor","20. Battery","21. Fan","22. AVR","23. Vibration/Rollback","24. Bumping","25. Others"]},{"id":"problem","label":"Problem Details","type":"text","required":true,"options":[]},{"id":"remarks","label":"Remarks","type":"text","required":false,"options":[]}]},"production":{"title":"Production Team Support Request","fields":[{"id":"date","label":"Date","type":"date","required":true,"options":[],"autoFill":"today"},{"id":"identity","label":"Name & ID","type":"text","required":true,"options":[],"autoFill":"identity"},{"id":"pm","label":"PM","type":"select","required":true,"options":["Md. Rejaul Karim(47869)","Masum(51111)"]},{"id":"project","label":"Project Name","type":"text","required":true,"options":[]},{"id":"lift","label":"Lift ID","type":"number","required":true,"options":[]},{"id":"controller","label":"Control System Brand","type":"select","required":true,"options":["NICE3000+","MOT","MOTCUBE","Hydraulic-ARL700","Hydraulic-PLC","Home Lift"]},{"id":"problem_category","label":"Problem Category","type":"select","required":true,"options":["Drive system related problem","Cartop board related problem","CPC/Call card related problem","COP display Issue","LOP display problem","Traction Machine related problem","Encoder problem","UPS/ARD related Issue","Braking Resistor problem","Intercom set issue","Light issue","Transformer","Door inverter","Switch","Sensor","Battery","Fan","AVR","Vibration/Rollback","Bumping","MOTCUBE Activation","Parameters Issue","Other:"]},{"id":"sub","label":"Sub Category","type":"text","required":false,"options":[]},{"id":"problem","label":"Problem Details","type":"text","required":true,"options":[]},{"id":"remarks","label":"Remarks","type":"text","required":false,"options":[]}]},"maintenance":{"title":"Factory Maintenance Team Support Request","fields":[{"id":"date","label":"Date","type":"date","required":true,"options":[],"autoFill":"today"},{"id":"identity","label":"Name & ID","type":"text","required":true,"options":[],"autoFill":"identity"},{"id":"pm","label":"PM","type":"select","required":true,"options":["Md. Rejaul Karim(47869)","Masum(51111)"]},{"id":"project","label":"Project Name","type":"text","required":true,"options":[]},{"id":"lift","label":"Lift ID","type":"number","required":true,"options":[]},{"id":"controller","label":"Control System Brand","type":"select","required":true,"options":["NICE3000+","MOT","MOTCUBE","Hydraulic-ARL700","Hydraulic-PLC","Home Lift"]},{"id":"problem_category","label":"Problem Category","type":"select","required":true,"options":["Drive system related problem","Cartop board related problem","CPC/Call card related problem","COP display Issue","LOP display problem","Traction Machine related problem","Encoder problem","UPS/ARD related Issue","Braking Resistor problem","Intercom set issue","Light issue","Transformer","Door inverter","Switch","Sensor","Battery","Fan","AVR","Vibration/Rollback","Bumping","MOTCUBE Activation","Parameters Issue","Other:"]},{"id":"sub","label":"Sub Category","type":"text","required":false,"options":[]},{"id":"problem","label":"Problem Details","type":"text","required":true,"options":[]},{"id":"remarks","label":"Remarks","type":"text","required":false,"options":[]}]},"qc":{"title":"QC Team Support Request","fields":[{"id":"date","label":"Date","type":"date","required":true,"options":[],"autoFill":"today"},{"id":"identity","label":"Name & ID","type":"text","required":true,"options":[],"autoFill":"identity"},{"id":"pm","label":"PM","type":"select","required":true,"options":["Md. Rejaul Karim(47869)","Masum(51111)"]},{"id":"project","label":"Project Name","type":"text","required":true,"options":[]},{"id":"lift","label":"Lift ID","type":"number","required":true,"options":[]},{"id":"controller","label":"Control System Brand","type":"select","required":true,"options":["NICE3000+","MOT","MOTCUBE","Hydraulic-ARL700","Hydraulic-PLC","Home Lift"]},{"id":"problem_category","label":"Problem Category","type":"select","required":true,"options":["Drive system related problem","Cartop board related problem","CPC/Call card related problem","COP display Issue","LOP display problem","Traction Machine related problem","Encoder problem","UPS/ARD related Issue","Braking Resistor problem","Intercom set issue","Light issue","Transformer","Door inverter","Switch","Sensor","Battery","Fan","AVR","Vibration/Rollback","Bumping","MOTCUBE Activation","Parameters Issue","Other:"]},{"id":"sub","label":"Sub Category","type":"text","required":false,"options":[]},{"id":"problem","label":"Problem Details","type":"text","required":true,"options":[]},{"id":"remarks","label":"Remarks","type":"text","required":false,"options":[]}]},"installation":{"title":"Installation Team Support Request","fields":[{"id":"date","label":"Date","type":"date","required":true,"options":[],"autoFill":"today"},{"id":"identity","label":"Name & ID","type":"text","required":true,"options":[],"autoFill":"identity"},{"id":"pm","label":"PM","type":"select","required":true,"options":["Sabbir Ahmmed(55395)","Elias Hossain(52449)","Ashikur Rahman Akash(42976)","Taiful Islam(69313)"]},{"id":"project","label":"Project Name","type":"text","required":true,"options":[]},{"id":"lift","label":"Lift ID","type":"number","required":true,"options":[]},{"id":"capacity","label":"Capacity","type":"number","required":true,"options":[]},{"id":"controller","label":"Control System Brand","type":"select","required":false,"options":["NICE3000+","MOT","MOTCUBE","Hydraulic-ARL700","Hydraulic-PLC","Home Lift"]},{"id":"problem_category","label":"Problem Category","type":"select","required":true,"options":["Mechanical","Electrical"]},{"id":"sub","label":"Sub Category","type":"select","required":true,"options":["1. Asthetics","2. Steel Rope","3. Motor Related Issue","4. Door Related Issue","5. Vibration","6. Bumping","7. Electrical Layout","8. Slow Speed Issue","9. SDB Requirement","10. Others"]},{"id":"problem","label":"Problem Details","type":"text","required":true,"options":[]},{"id":"remarks","label":"Remarks","type":"text","required":false,"options":[]}]}}'::jsonb) loop
    if exists(select 1 from wlf_private.v220_import_audit where item='support:'||key) then continue; end if;
    select * into old_form from public.wlf_forms where category=key;
    if not found then
      insert into public.wlf_forms(category,schema) values(key,incoming);
      insert into wlf_private.v220_import_audit(item,decision) values('support:'||key,'inserted');
    elsif old_form.revision=1 and old_form.schema=('{"commissioning":{"title":"Site Feedback Form - Commissioning","url":"https://forms.gle/LAAPuJiEyG9RohMKA","description":"কমিশনিং সংক্রান্ত জটিলতা নিয়ে আপনার ফিডব্যাক শেয়ার করতে অনুগ্রহ করে এই ফর্মটি পূরণ করুন। আপনার মূল্যবান মতামত ওয়ালটন লিফট R&I টিমকে সমস্যাগুলো খতিয়ে দেখতে, যথাযথ ব্যবস্থা গ্রহণ করতে এবং পণ্যের গুণগত মান আরও বাড়াতে সহায়তা করবে।  ","fields":[{"id":"field_2064608726","label":"Date","help":"","type":"date","required":true,"options":[]},{"id":"field_1674702979","label":"Name (ID)","help":"আপনার নাম ও ID। উদাহরণস্বরূপ - Abdullah (12345)","type":"text","required":true,"options":[]},{"id":"field_1915927061","label":"In-charge","help":"","type":"select","required":true,"options":["Faisal (51123)"]},{"id":"field_1866778380","label":"Project Name","help":"","type":"text","required":true,"options":[]},{"id":"field_1369800003","label":"Project Lift ID","help":"","type":"text","required":true,"options":[]},{"id":"field_1007488857","label":"Capacity (KG)","help":"","type":"select","required":true,"options":["300","350","400","450","630","800","1000","1150","1250","1350","1600","2000","2500","3000","3500","4000","5000","6000"]},{"id":"field_620050161","label":"Control System","help":"সাইটে কি ধরণের Control সিস্টেম ব্যবহৃত হচ্ছে সেটা এখনে সিলেক্ট করুন।","type":"select","required":true,"options":["MOT","MOTCUBE","NICE3000+","Hydraulic ARL-700","Home Lift","Hydraulic -PLC"]},{"id":"field_1661471421","label":"Problem Category","help":"সাইটে কি ধরণের সমস্যা দেখা যাচ্ছে সেটা কোন ধরণের মধ্যে পড়ে সেটা ফিল আপ করুন।","type":"select","required":true,"options":["Mechanical Problem","Electrical Problem"]},{"id":"field_295723266","label":"Sub-Category","help":"সমস্যাটা স্পেসিফিক কোন ক্যাটাগরিতে পড়ে সেটা ফিলাপ করুন। এখানে একাধিক সিলেকশন করা যাবে।  একই প্রোজেক্টে একাধিক ধরণের সমস্যা থাকলে অনুগ্রহ করে একাধিকবার পূরণ করুন।","type":"multi","required":true,"options":["1. Assembly / Fixing : Structure (Mechanical)","2. Assembly / Fixing : Cabin (Mechanical)","3. Assembly / Fixing : Machine Room (Mechanical)","4. Assembly / Fixing : Door (Mechanical)","5. Aesthetics (Mechanical)","6.Steel Rope (Mechanical)","7. Motor Related Issue (Mechanical)","8. Drive system related problem","9. Cartop board related problem","10. CPC/Call card related problem","11. COP display Issue","12. LOP display problem","13. Traction Machine related problem","14. Encoder problem","15. UPS/ARD related Issue","16. Braking Resistor problem","17. Intercom set issue","18. Light issue","19. Transformer","20. Door inverter","21. Switch","22. Sensor","23. Battery","24. Fan","25. AVR","26. Vibration/Rollback","27. Bumping","28. Others"]},{"id":"field_501774740","label":"Problem","help":"সমস্যা কি ধরণের সেটা খুব সংক্ষিপ্ত আকারে এখানে লিখুন।  উপরে  Others হলে এখানে অন্য কি সমস্যা সেটা অবশ্যই লিখুন।","type":"text","required":true,"options":[]},{"id":"field_1153901770","label":"Repeated Problem?","help":"আগে কোনো প্রজেক্টে এমন সমস্যা পেয়েছেন কি-না?","type":"select","required":true,"options":["Yes","No"]},{"id":"field_374734969","label":"Repeated project Name and ID","help":"আগে যে প্রজেক্টে এই একই  সমস্যা হয়েছিল সেই প্রোজেক্টের আইডিটা শেয়ার করুন। \nউদাহরণস্বরূপ - Project Abdullah (12345)","type":"text","required":false,"options":[]},{"id":"field_1279516091","label":"Shared to the group?","help":"প্রোজেক্টের এই সমস্যা গ্রুপে শেয়ার করা হয়েছে কি-না।","type":"select","required":true,"options":["Yes","No"]},{"id":"field_2142260792","label":"Group Name","help":"যদি  WhatsApp / Viber এর গ্রুপে শেয়ার করা হয়ে থাকে তাহলে সেই গ্রুপের নাম উল্লেখ করুন। গ্রুপে শেয়ার করার সময় প্রোজেক্টের নাম, লিফট  ID এবং প্রবলেম নাম্বার  অবশ্যই মেনশন করুন। WhatsApp গ্রুপে না শেয়ার করলেও অবশ্যই Viber / Telegram গ্রুপে শেয়ার করতে হবে। অন্যথায়, R&I এবং QC এর পক্ষে ট্রেস রাখা কষ্টকর!","type":"multi","required":true,"options":["R&I & Commissioning Team Technical Discussion ( Telegram)","Commissioning Feedbak (Viber)","Elevator QC Circle (Whatsapp)"]},{"id":"field_1463858999","label":"Remarks","help":"কোনো ধরণের মতামত থাকলে  বা  প্রাপ্ত সমস্যা নিয়ে কোন বক্তব্য থাকলে সংক্ষিপ্ত আকারে এখানে জানান।","type":"text","required":false,"options":[]},{"id":"submitted_date","label":"Submitted date","type":"date","help":"Request ID uses this date. Defaults to today (Bangladesh). Original incident/site date fields remain separate.","required":true,"options":[]}]},"aftersales":{"title":"Site Feedback Form - After Sales","url":"https://forms.gle/v4nQozvy5ja6R8Da6","description":"আফটার সেলস সংক্রান্ত জটিলতা নিয়ে আপনার ফিডব্যাক শেয়ার করতে অনুগ্রহ করে এই ফর্মটি পূরণ করুন। আপনার মূল্যবান মতামত ওয়ালটন লিফট R&I টিমকে সমস্যাগুলো খতিয়ে দেখতে, যথাযথ ব্যবস্থা গ্রহণ করতে এবং পণ্যের গুণগত মান আরও বাড়াতে সহায়তা করবে।  ","fields":[{"id":"field_2064608726","label":"Date of Incident","help":"","type":"date","required":true,"options":[]},{"id":"field_1674702979","label":"Name (ID)","help":"আপনার নাম ও ID। উদাহরণস্বরূপ - Abdullah (12345)","type":"text","required":true,"options":[]},{"id":"field_1915927061","label":"In-charge","help":"","type":"select","required":true,"options":["Shakirul Yasir (40986)"]},{"id":"field_702543330","label":"Project Name","help":"","type":"text","required":true,"options":[]},{"id":"field_1369800003","label":"Project Lift ID","help":"","type":"text","required":true,"options":[]},{"id":"field_1007488857","label":"Capacity (KG)","help":"","type":"select","required":true,"options":["300","350","400","450","630","800","1000","1150","1250","1350","1600","2000","2500","3000","3500","4000","5000","6000"]},{"id":"field_637986521","label":"Control System","help":"সাইটে কি ধরণের Control সিস্টেম ব্যবহৃত হচ্ছে সেটা এখনে সিলেক্ট করুন।","type":"select","required":true,"options":["MOT","MOTCUBE","NICE3000+","Hydraulic ARL-700","Home Lift","Hydraulic-PLC"]},{"id":"field_1661471421","label":"Problem Category","help":"সাইটে কি ধরণের সমস্যা দেখা যাচ্ছে সেটা কোন ধরণের মধ্যে পড়ে সেটা ফিল আপ করুন।","type":"select","required":true,"options":["Mechanical Problem","Electrical Problem"]},{"id":"field_295723266","label":"Sub-Category","help":"সমস্যাটা স্পেসিফিক কোন ক্যাটাগরিতে পড়ে সেটা ফিলাপ করুন। এখানে একাধিক সিলেকশন করা যাবে।  একই প্রোজেক্টে একাধিক ধরণের সমস্যা থাকলে অনুগ্রহ করে একাধিকবার পূরণ করুন।","type":"multi","required":true,"options":["1. Aesthetics (Mechanical)","2. Steel Rope (Mechanical)","3. Motor Related Issue (Mechanical)","4. Drive system related problem","5. Cartop board related problem","6. CPC/Call card related problem","7. COP display Issue","8. LOP display problem","9. Traction Machine related problem","10. Encoder problem","11. UPS/ARD related Issue","12. Braking Resistor problem","13. Intercom set issue","14. Light issue","15. Transformer","16. Door inverter","17. Door Motor","18. Switch","19. Sensor","20. Battery","21. Fan","22. AVR","23. Vibration/Rollback","24. Bumping","25. Others"]},{"id":"field_501774740","label":"Problem","help":"সমস্যা কি ধরণের সেটা খুব সংক্ষিপ্ত আকারে এখানে লিখুন।  উপরে  Others হলে এখানে অন্য কি সমস্যা সেটা অবশ্যই লিখুন।","type":"text","required":true,"options":[]},{"id":"field_1153901770","label":"Repeated Problem?","help":"আগে কোনো প্রজেক্টে এমন সমস্যা পেয়েছেন কি-না?","type":"select","required":true,"options":["Yes","No"]},{"id":"field_374734969","label":"Repeated project Name and ID","help":"আগে যে প্রজেক্টে এই একই  সমস্যা হয়েছিল সেই প্রোজেক্টের আইডিটা শেয়ার করুন।","type":"text","required":false,"options":[]},{"id":"field_1279516091","label":"Shared to the group?","help":"প্রোজেক্টের এই সমস্যা গ্রুপে শেয়ার করা হয়েছে কি-না।","type":"select","required":true,"options":["Yes","No"]},{"id":"field_2142260792","label":"Group Name","help":"যদি  গ্রুপে শেয়ার করা হয়ে থাকে তাহলে সেই গ্রুপের নাম উল্লেখ করুন। গ্রুপে শেয়ার করার সময় প্রোজেক্টের নাম, লিফট  ID এবং প্রবলেম নাম্বার  অবশ্যই মেনশন করুন। WhatsApp গ্রুপে না শেয়ার করলেও অবশ্যই Viber / Telegram গ্রুপে শেয়ার করতে হবে। অন্যথায়, R&I এবং QC এর পক্ষে ট্রেস রাখা কষ্টকর!","type":"multi","required":true,"options":["R&I and After Sales Team Technical Discussion (Telegram)","After Sales Feedback (Viber)"]},{"id":"field_1463858999","label":"Remarks","help":"কোনো ধরণের মতামত থাকলে  বা  প্রাপ্ত সমস্যা নিয়ে কোন বক্তব্য থাকলে সংক্ষিপ্ত আকারে এখানে জানান।","type":"text","required":false,"options":[]},{"id":"submitted_date","label":"Submitted date","type":"date","help":"Request ID uses this date. Defaults to today (Bangladesh). Original incident/site date fields remain separate.","required":true,"options":[]}]}}'::jsonb)->key then
      update public.wlf_forms set schema=incoming,revision=revision+1 where category=key;
      insert into wlf_private.v220_import_audit(item,decision,before_state) values('support:'||key,'imported',to_jsonb(old_form));
    else
      insert into wlf_private.v220_import_audit(item,decision,before_state) values('support:'||key,'preserved: customized',to_jsonb(old_form));
    end if;
  end loop;
end
$$;
insert into public.wlf_ri_categories(id,section,name,position,schema)
  select id,section,name,position,schema from jsonb_to_recordset('[{"id":"wb-team","section":"team","name":"Team Activity","position":1,"schema":{"fields":[{"id":"date","label":"Perform Date","type":"date","required":true,"options":[],"autoFill":"today"},{"id":"subject","label":"Task Name","type":"text","required":true,"options":[]},{"id":"identity","label":"Responder Name & ID","type":"text","required":true,"options":[],"autoFill":"identity"},{"id":"project","label":"Project / Task Name","type":"text","required":true,"options":[]},{"id":"task_category","label":"Task Category","type":"multi","required":true,"options":["Process Development","Special Engineering Task","SOP","Standard","Testing","Design","Meeting","Case Study","Training","Report","Firmware Update","Firmware Test","New Problem Solve","Manual","BOM","Others"]},{"id":"start_date","label":"Task Start date","type":"date","required":false,"options":[]},{"id":"end_date","label":"Task Complete Date","type":"date","required":false,"options":[]},{"id":"duration_minute","label":"Duration (Minute)","type":"number","required":true,"options":[]},{"id":"status","label":"Project/Task Status","type":"radio","required":false,"options":["Completed","Ongoing","Hold","Canceled"]},{"id":"note_challenges_achievements","label":"Note / Challenges / Achievements","type":"text","required":false,"options":[]}]}},{"id":"wb-scm","section":"scm","name":"Supplier & SCM Cooperation","position":2,"schema":{"fields":[{"id":"date","label":"Date","type":"date","required":true,"options":[],"autoFill":"today"},{"id":"identity","label":"Name & (ID)","type":"text","required":true,"options":[],"autoFill":"identity"},{"id":"task_type","label":"Task Type","type":"select","required":false,"options":["Supplier Communication","Co-Operation With SCM"]},{"id":"supplier_category","label":"Supplier category","type":"select","required":true,"options":["Arkel","Inovance","Sightfly","AVR (Sako)","AVR (Heya)","SJEC","Mona drive","Torin","Ziehl-Abegg","Montanari","Ascend Fuji (Door)","UPS (SNG)","Tebo (Hydraulic System)","Other:"]},{"id":"product_category","label":"Product category","type":"select","required":true,"options":["Controller","Cartop Board","CPC/Call Card","COP Display","LOP Display","Encoder","Motor","UPS/ARD","Brake Resistor","AVR","Load Cell","Cross flow fan","Light","Sensor","Intercom","Other:"]},{"id":"problem","label":"Task Details","type":"text","required":true,"options":[]},{"id":"start_date","label":"Task Start Date","type":"date","required":false,"options":[]},{"id":"end_date","label":"Task Complete Date","type":"date","required":false,"options":[]},{"id":"duration_minute","label":"Duration (Minute)","type":"number","required":true,"options":[]},{"id":"task_impact","label":"Task Impact","type":"select","required":true,"options":["Solution of Problem","Component Selection","Cost Optimization","Product Development","Documentation","Sourcing","Other:"]},{"id":"status","label":"Task Status","type":"radio","required":false,"options":["Completed","Ongoing","Hold","Canceled"]},{"id":"claim_item_name","label":"Claim Item Name","type":"text","required":false,"options":[]},{"id":"claim_item_qty","label":"Claim Item Qty","type":"text","required":false,"options":[]},{"id":"claim_item_value","label":"Claim item Value","type":"text","required":false,"options":[]},{"id":"note","label":"Note","type":"text","required":false,"options":[]}]}},{"id":"wb-sales","section":"sales","name":"Sales Support","position":3,"schema":{"fields":[{"id":"date","label":"Date","type":"date","required":true,"options":[],"autoFill":"today"},{"id":"identity","label":"Name & ID","type":"text","required":true,"options":[],"autoFill":"identity"},{"id":"project","label":"Project Name","type":"text","required":false,"options":[]},{"id":"lift","label":"Lift ID","type":"text","required":false,"options":[]},{"id":"sales_wing","label":"Sales Wing","type":"select","required":false,"options":["General Sales","Tender Sales","CSD"]},{"id":"support_category","label":"Support Category","type":"select","required":true,"options":["Technical Support","Physical Meeting","Client Briefing","Testing Tower Visit","Layout","Other:"]},{"id":"problem","label":"Task Details","type":"text","required":true,"options":[]},{"id":"duration_minute","label":"Duration (Minute)","type":"number","required":true,"options":[]},{"id":"status","label":"Task Status","type":"radio","required":false,"options":["Completed","Ongoing","Hold","Canceled"]}]}},{"id":"report-aftersales","section":"reports","name":"After Sales Onsite Damage Materials Report","position":4,"schema":{"fields":[{"id":"date","label":"Date","type":"date","required":true,"options":[],"autoFill":"today"},{"id":"identity","label":"Name & ID","type":"text","required":true,"options":[],"autoFill":"identity"},{"id":"csm","label":"CSM","type":"select","required":true,"options":["Alamgir Hosen(54655)","Ashraful Alam(54950)","Mehedi Hasan(55514)","Ahmed Ashiq(54760)","Palash Chandra Roy(55009)"]},{"id":"project","label":"Project Name","type":"text","required":true,"options":[]},{"id":"lift","label":"Lift ID","type":"text","required":true,"options":[]},{"id":"controller","label":"Control System Brand","type":"select","required":false,"options":["NICE3000+","MOT","MOTCUBE","Hydraulic-ARL700","Hydraulic-PLC","Home Lift"]},{"id":"damage_components","label":"Damage Components","type":"select","required":true,"options":["Drive","Cartop Board","CPC card","COP display","LOP display","Traction Machine","Encoder","UPS","ARD","Braking Resistor","Intercom set","Light","Transformer","Door inverter","Sensor","Battery","Fan","AVR","Filter card","Power board","Varistor","CPU Card","Other:"]},{"id":"damage_components_model","label":"Damage Components Model","type":"text","required":false,"options":[]},{"id":"possible_damage_reason","label":"Possible Damage Reason","type":"text","required":true,"options":[]},{"id":"supplier","label":"Supplier","type":"select","required":true,"options":["ARKEL","INOVANCE","SAKO","HEYA","SIGHT","FLY","ZIEHL","ABE","GGM","MONAN","BSL","Ascent","Fuji","Montanari"]},{"id":"duration_min","label":"Duration (min)","type":"number","required":true,"options":[]},{"id":"remarks","label":"Remarks","type":"text","required":false,"options":[]}]}},{"id":"report-commissioning","section":"reports","name":"Commissioning Onsite Damage Materials Report","position":5,"schema":{"fields":[{"id":"date","label":"Date","type":"date","required":true,"options":[],"autoFill":"today"},{"id":"identity","label":"Name & ID","type":"text","required":true,"options":[],"autoFill":"identity"},{"id":"pm","label":"PM","type":"select","required":false,"options":["Rezaul Karim (47869)","Masum (51111)"]},{"id":"project","label":"Project Name","type":"text","required":true,"options":[]},{"id":"lift","label":"Lift ID","type":"text","required":true,"options":[]},{"id":"controller","label":"Control System Brand","type":"select","required":false,"options":["NICE3000+","MOT","MOTCUBE","Hydraulic-ARL700","Hydraulic-PLC","Home Lift"]},{"id":"damage_components","label":"Damage Components","type":"select","required":true,"options":["Battery","Drive","Cartop Board","CPC Card","Call Card","COP Display","LOP Display","Encoder","UPS","ARD","Brake Resistor","Intercom Set","Light","Transformer","Door Inverter","Sensor","Fan","AVR","Filter Card","Power Board","Varistor","CPU Card","Door Motor","Other"]},{"id":"damage_components_model","label":"Damage Components Model","type":"text","required":false,"options":[]},{"id":"possible_damage_reason","label":"Possible Damage Reason","type":"text","required":true,"options":[]},{"id":"supplier","label":"Supplier","type":"select","required":true,"options":["ARKEL","INOVANCE","SAKO","HEYA","SIGHT","FLY","ZIEHL","ABE","GGM","MONAN","BSL","Ascent","Fuji","Montanari"]},{"id":"duration","label":"Duration","type":"number","required":true,"options":[]},{"id":"remarks","label":"Remarks","type":"text","required":false,"options":[]}]}},{"id":"report-service","section":"reports","name":"Electrical & Electronic Components Service Report","position":6,"schema":{"fields":[{"id":"date","label":"Date","type":"date","required":true,"options":[],"autoFill":"today"},{"id":"identity","label":"Name & ID","type":"text","required":true,"options":[],"autoFill":"identity"},{"id":"project","label":"Project Name","type":"text","required":true,"options":[]},{"id":"lift","label":"Lift ID","type":"text","required":true,"options":[]},{"id":"controller","label":"Control System Brand","type":"select","required":true,"options":["NICE3000+","MOT","MOTCUBE","Hydraulic-ARL700","Hydraulic-PLC","Home Lift"]},{"id":"damage_item_name","label":"Damage Item Name","type":"select","required":true,"options":["Integrated Elevator Controller Mot 14 A-Lift","Integrated Elevator Controller Mot 17 A","Integrated Elevator Controller 4,Mot 26 A- Arkel","Integrated Elevator Controller Mot 35 A -Lift","Integrated Elevator Controller 4,Mot 50 A- Arkel","Integrated Elevator Controller 4,Mot 75 A-- Arkel","NICE3000+ 18A-7.5KW","NICE3000+ 27A-11KW","NICE3000+ 33A-15KW","NICE3000+ 39A-18.5KW","NICE3000+ 48A-22KW","NICE3000+ 60A-30KW","NICE3000+ 75A-37KW","NICE3000+ 91A-45KW","Motcube 14A - Synchronous Brake Voltage - 110V DC - Arkel","Motcube 17A - Synchronous Brake Voltage - 110V DC - Arkel","MOTCUBE 26A, Brake Voltage 110 V DC","Walton Ups- CN - 1000/60Vdc","Walton Ups- CN - 2000/60Vdc","UPS 1500 VA/900W RD1500 ARKEL","Adalift ALU-1500/60Vdc UPS","Servosan UPS-3000VA (Model: KU-S/60VDCX-1500Va) Arkel","Servosan UPS-1500VA (Model: KU-S/60VDCX-1500Va) Arkel","Ard (MCTC-ARD-C-0P8-18A-N)","Ard (MCTC-ARD-C-0P8-32A-N)","Ard (MCTC-ARD-C-1P6-50A-N)","Ard (MCTC-ARD-C-1P6-80A-N)","Ard (MCTC-ARD-C-1P6-65A-N)","Cop Controller Mot Cpc-Arkel","Call Card (MCTC-CCB-A)","Mot FX Cube - S-Card - Arkel","Ibc-S Board Mot-Arkel","Encoder Board Mot Enca-Arkel","MOT ENCI Encoder Board","PG Card (MCTC-PG-E)","PG Card (MCTC-PG-F1)","PG Card (MCTC-PG-A2)","MOT Size B EMC Board","MOT CPU Board","COP TFT 07 Inch - Picture Display","COP TFT 10 Inch - Video Display","COP TFT 08 Inch - Video Display","GMedia7 (MOT)","MOT BC-D3XW Landing Call and Indicator (White)","MOT BC-LCDA LANDING CALL&INDICATOR","Landing Call&Indicator (Red)Mot Bc-D3Xr-Arkel","LOP Display 208","Transum Display - 07 Inch - Black","Transum Display - 07 Inch - Blue","MOT Rgb Lcd Indicator Bc-Lcd10555 105X55mm-Lift","Power Supply ABL2REM24065K","KBK 2 Connection Board-Arkel (PCS)","Elevator door inverter-Capacity-400 W-Nice-900, Monarch","Door Controller Km 30S","AVR PCB Card","Lift Overload sensor CNT 800","Intercom Receiver","AERM","LED Spot Light with White frame 5 W (White light)","LED Spot Light with Golden frame 5 W (Warm Light","Limit Switch NO","Limit Switch NC","Cross Flow Fan","Intercom Power Supply","LCB Board","Other:"]},{"id":"problem","label":"Problem Details","type":"text","required":true,"options":[]},{"id":"material_source","label":"Material Source","type":"select","required":true,"options":["Commissioning","After Sales","Production","Factory Maintenance"]},{"id":"solution_statement","label":"Solution Statement","type":"text","required":true,"options":[]},{"id":"service_complete_date","label":"Service Complete Date","type":"date","required":true,"options":[]},{"id":"status","label":"Solution Status","type":"select","required":true,"options":["Solved","Not Solved","Ongoing"]},{"id":"root_cause_of_problem","label":"Root cause of problem","type":"text","required":false,"options":[]},{"id":"component_need_for_repairing","label":"Component Need for repairing","type":"text","required":false,"options":[]},{"id":"quantity","label":"Quantity","type":"text","required":false,"options":[]},{"id":"duration_minute","label":"Duration (Minute)","type":"number","required":true,"options":[]},{"id":"remark","label":"Remark","type":"text","required":false,"options":[]}]}}]'::jsonb)
    as c(id text,section text,name text,position int,schema jsonb) on conflict(id) do nothing;
insert into public.wlf_settings(key,value) values('component_master_notes','["Special Notes:\n\n1. Currently, the MOT 14A controller is unavailable. For 14A requirements, please use the 17A controller until the 14A model becomes available.\n\n2. Currently, the NICE3000+ 11 kW controller is unavailable. For 11 kW requirements, please use the 15 kW controller until the 11 kW model becomes available.\n\n3. Currently, the NICE3000+ 22 kW controller is unavailable. For 22 kW requirements, please use the 30 kW controller until the 22 kW model becomes available.\n\n4. Currently, the 18Ω and 25Ω, 8 kW resistors are unavailable. For ARKEL control systems, please use the following alternatives until the required models become available:\n   - 25Ω, 2 kW\n   - 18Ω, 3 kW\n5. Our electrical component selection is based on the motor information provided by the designer. Therefore, any incorrect or inaccurate motor data may result in improper electrical component selection."]'::jsonb) on conflict do nothing;

-- Keep the v2.1 JSON format and allow all installed support teams to be restored.
create or replace function public.wlf_backup_admin(action text,actor uuid,payload jsonb default '{}')returns jsonb language plpgsql security definer set search_path=''as $$
declare runrow wlf_private.backup_runs;runid uuid;part int;cnt int;gone int=0;x jsonb;out jsonb;raw jsonb;rec public.wlf_requests;target public.wlf_profiles;ids uuid[];begin
 if not exists(select 1 from public.wlf_profiles where id=actor and status='Approved'and role='Super Admin')then raise exception 'Super Admin only';end if;
 if action='status'then
 return jsonb_build_object('usedBytes',(select sum(pg_database_size(datname))from pg_database),'limitBytes',500000000,'tables',(select coalesce(jsonb_agg(jsonb_build_object('name',schemaname||'.'||relname,'bytes',pg_total_relation_size(relid))order by pg_total_relation_size(relid)desc),'[]')from pg_stat_user_tables),'backups',coalesce((select jsonb_agg(to_jsonb(b)order by created_at desc)from(select * from wlf_private.backup_runs order by created_at desc limit 30)b),'[]'));
 elsif action='reserveDeleteUser'then
 select * into target from public.wlf_profiles where email=lower(payload->>'email')for update;
 if not found or target.status<>'Rejected'or target.id=actor then raise exception 'Only rejected users can be deleted';end if;
 if exists(select 1 from public.wlf_requests where created_by=target.id or assigned_to=target.id or solved_by=target.id or not_solved_by=target.id)or exists(select 1 from public.wlf_history h where h.actor=target.id or h.to_user=target.id)or exists(select 1 from public.wlf_operations o where o.actor=target.id)or exists(select 1 from public.wlf_records where owner=target.id)or exists(select 1 from public.wlf_usage z where z.actor=target.id)or exists(select 1 from wlf_private.backup_runs b where b.actor=target.id)or exists(select 1 from wlf_private.archived_operations ao where ao.actor=target.id)
 or exists(select 1 from public.wlf_ri_entries where owner=target.id) or exists(select 1 from public.wlf_ri_projects where owner=target.id or data->>'lead'=target.id::text or data->'collaborators' ? target.id::text or exists(select 1 from jsonb_array_elements(data->'tasks') t where t->>'owner'=target.id::text))then raise exception 'Cannot delete: linked records exist. Keep account Rejected.';end if;
 insert into wlf_private.deleting_users values(target.id)on conflict do nothing;return jsonb_build_object('id',target.id);
 elsif action='releaseDeleteUser'then delete from wlf_private.deleting_users where id=(payload->>'id')::uuid;return 'true';
 elsif action='start'then
 if nullif(payload->>'from','')::date>nullif(payload->>'to','')::date then raise exception 'Invalid date range';end if;
 runid=(payload->>'id')::uuid;
 insert into wlf_private.backup_runs(id,actor,date_from,date_to)values(runid,actor,nullif(payload->>'from','')::date,nullif(payload->>'to','')::date)on conflict do nothing;
 select * into runrow from wlf_private.backup_runs where id=runid for update;
 if runrow.actor<>actor or runrow.date_from is distinct from nullif(payload->>'from','')::date or runrow.date_to is distinct from nullif(payload->>'to','')::date then raise exception 'Backup ID reused';end if;
 if runrow.total=0 then
 insert into wlf_private.backup_items(run,seq,request_id)select runid,row_number()over(order by r.id)::int,r.id from public.wlf_requests r where(runrow.date_from is null or coalesce(nullif(r.values->>'submitted_date','')::date,(r.created_at at time zone'Asia/Dhaka')::date)>=runrow.date_from)and(runrow.date_to is null or coalesce(nullif(r.values->>'submitted_date','')::date,(r.created_at at time zone'Asia/Dhaka')::date)<=runrow.date_to)on conflict do nothing;
 update wlf_private.backup_runs set total=(select count(*)from wlf_private.backup_items where run=runid)where id=runid returning * into runrow;end if;
 return to_jsonb(runrow)||jsonb_build_object('batches',ceil(runrow.total/25.0));
 elsif action in('prepare','verify','clear','files','download','restore','abandon')then
 if action='restore'then
 raw=payload->'archive';if raw->>'format'<>'WLF-SUPPORT-2.1'or raw->>'project'<>payload->>'project'or jsonb_typeof(raw->'records')<>'array'or jsonb_array_length(raw->'records')>25 then raise exception 'Wrong project, format or oversized archive';end if;
 for x in select * from jsonb_array_elements(raw->'records')loop
 rec=jsonb_populate_record(null::public.wlf_requests,x->'request');
 if rec.id is null or not exists(select 1 from public.wlf_forms where category=rec.category)then raise exception 'Invalid request';end if;
 if exists(select 1 from public.wlf_requests where id=rec.id)then continue;end if;
 delete from wlf_private.archived_operations where request_id=rec.id;
 insert into public.wlf_requests select rec.*;gone=gone+1;
 insert into public.wlf_history(request_id,actor,action,comment,to_user,at)select rec.id,(h->>'actor')::uuid,h->>'action',coalesce(h->>'comment',''),nullif(h->>'to_user','')::uuid,(h->>'at')::timestamptz from jsonb_array_elements(x->'history')h;
 insert into public.wlf_operations(actor,mutation_id,action,request_id,payload)select(o->>'actor')::uuid,o->>'mutation_id',o->>'action',rec.id,o->'payload'from jsonb_array_elements(x->'operations')o on conflict do nothing;
 end loop;return jsonb_build_object('restored',gone);
 end if;
 runid=(payload->>'id')::uuid;part=coalesce((payload->>'batch')::int,0);
 select * into runrow from wlf_private.backup_runs where id=runid for update;
 if not found or runrow.actor<>actor then raise exception 'Backup not found for this Super Admin';end if;
 if action='files'then return coalesce((select jsonb_agg(to_jsonb(c)order by batch)from wlf_private.backup_chunks c where run=runid),'[]');end if;
 if action='abandon'then if exists(select 1 from wlf_private.backup_chunks where run=runid and verified)then raise exception 'Verified backups cannot be abandoned';end if;delete from wlf_private.backup_runs where id=runid;return 'true';end if;
 if part<0 or part>=ceil(runrow.total/25.0)then raise exception 'Invalid batch';end if;
 if action='download'then return(select to_jsonb(c)from wlf_private.backup_chunks c where run=runid and batch=part and verified);end if;
 if action='prepare'then
 if exists(select 1 from wlf_private.backup_chunks where run=runid and batch=part and verified)then return jsonb_build_object('alreadyVerified',true);end if;
 with snapshot as materialized(select i.seq,wlf_private.backup_record(r)content from wlf_private.backup_items i join public.wlf_requests r on r.id=i.request_id where i.run=runid and i.seq>part*25 and i.seq<=(part+1)*25),updated as(update wlf_private.backup_items i set fingerprint=md5(s.content::text)from snapshot s where i.run=runid and i.seq=s.seq returning s.content,i.seq)
 select coalesce(jsonb_agg(content order by seq),'[]')into out from updated;
 insert into wlf_private.backup_chunks(run,batch,nonce)values(runid,part,(payload->>'nonce')::uuid)on conflict(run,batch)do update set verified=false,sha256=null,file_id=null,nonce=excluded.nonce;
 return jsonb_build_object('format','WLF-SUPPORT-2.1','project',payload->>'project','run',runid,'batch',part,'dateFrom',runrow.date_from,'dateTo',runrow.date_to,'createdAt',runrow.created_at,'records',out);
 elsif action='verify'then
 if coalesce(payload->>'sha256','')!~'^[a-f0-9]{64}$'or coalesce(payload->>'fileId','')!~'^[a-zA-Z0-9_-]{5,200}$'then raise exception 'Invalid verified archive';end if;
 update wlf_private.backup_chunks set file_id=payload->>'fileId',sha256=payload->>'sha256',verified=true where run=runid and batch=part and nonce=(payload->>'nonce')::uuid and not verified;if not found then raise exception 'Backup changed: retry this part';end if;
 if(select count(*)from wlf_private.backup_chunks where run=runid and verified)=ceil(runrow.total/25.0)then update wlf_private.backup_runs set state='Verified on Drive'where id=runid;end if;return 'true';
 else
 if runrow.state not in('Verified on Drive','Partly cleared','Cleared')or not exists(select 1 from wlf_private.backup_chunks where run=runid and batch=part and verified)then raise exception 'Complete and verify all backup parts before clearing';end if;
 -- Row locks serialize with live request transitions; dependent events are in the fingerprint.
 perform r.id from public.wlf_requests r join wlf_private.backup_items i on i.request_id=r.id where i.run=runid and i.seq>part*25 and i.seq<=(part+1)*25 order by r.id for update of r;
 select array_agg(r.id)into ids from public.wlf_requests r join wlf_private.backup_items i on i.request_id=r.id where i.run=runid and not i.cleared and i.seq>part*25 and i.seq<=(part+1)*25 and r.status='Solved'and md5(wlf_private.backup_record(r)::text)=i.fingerprint;
 if ids is not null then
 insert into wlf_private.archived_operations select o.actor,o.mutation_id,o.request_id from public.wlf_operations o where o.request_id=any(ids)on conflict do nothing;
 delete from public.wlf_operations where request_id=any(ids);delete from public.wlf_history where request_id=any(ids);delete from public.wlf_requests where id=any(ids);get diagnostics gone=row_count;
 update wlf_private.backup_items set cleared=true where run=runid and request_id=any(ids);
 update wlf_private.backup_runs set cleared=cleared+gone,state=case when cleared+gone>=total then 'Cleared'else 'Partly cleared'end where id=runid;
 end if;select count(*)into cnt from wlf_private.backup_items where run=runid and seq>part*25 and seq<=(part+1)*25;return jsonb_build_object('cleared',gone,'skipped',cnt-gone);
 end if;
 end if;raise exception 'Unsupported maintenance action';
end$$;

create table if not exists wlf_private.excel_runs (
  id uuid primary key,
  actor uuid not null references public.wlf_profiles(id),
  kind text not null check(kind in ('support','activity')),
  date_from date,
  date_to date,
  with_clear boolean not null,
  created_at timestamptz not null default now(),
  nonce uuid,
  lease_until timestamptz,
  workbook_id text,
  workbook_hash text,
  recovery_id text,
  recovery_hash text,
  items jsonb not null default '[]',
  cleared_ids uuid[] not null default '{}',
  clear_finished boolean not null default false,
  restored_at timestamptz
);
alter table wlf_private.excel_runs enable row level security;
revoke all on wlf_private.excel_runs from public,anon,authenticated;
create index if not exists wlf_excel_runs_history_idx on wlf_private.excel_runs(created_at desc);

create or replace function wlf_private.excel_receipt(r wlf_private.excel_runs)
returns jsonb language sql stable security definer set search_path='' as $$
  select (to_jsonb(r)-'items'-'nonce'-'lease_until'-'cleared_ids')
    ||jsonb_build_object('total',jsonb_array_length(r.items),'cleared',cardinality(r.cleared_ids))
$$;

create or replace function public.wlf_excel_admin(action text, actor uuid, payload jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  run_id uuid; run_row wlf_private.excel_runs; workbook_kind text=payload->>'kind';
  period_from date; period_to date; clear_mode boolean;
  x jsonb; obj jsonb; source_row record; records jsonb[]='{}'; row_count int=0; total_bytes int=0;
  categories jsonb; ids uuid[]; archive jsonb; restored int=0; restore_offset integer; entries jsonb[];
begin
  if not exists(select 1 from public.wlf_profiles where id=actor and status='Approved' and role='Super Admin') then
    raise exception 'Super Admin only';
  end if;
  if action='history' then
    return (select coalesce(jsonb_agg(wlf_private.excel_receipt(r) order by created_at desc,id),'[]')
      from (select * from wlf_private.excel_runs where workbook_id is not null order by created_at desc,id limit 100) r);
  end if;
  run_id=(payload->>'id')::uuid;
  if run_id is null then raise exception 'Missing Excel backup ID'; end if;

  if action='prepare' then
    period_from=nullif(payload->>'from','')::date; period_to=nullif(payload->>'to','')::date;
    clear_mode=coalesce((payload->>'withClear')::boolean,false);
    if coalesce(workbook_kind,'') not in ('support','activity') or (period_from is null)<>(period_to is null)
      or period_from>period_to then raise exception 'Choose a valid module and date range'; end if;
    insert into wlf_private.excel_runs(id,actor,kind,date_from,date_to,with_clear)
      values(run_id,actor,workbook_kind,period_from,period_to,clear_mode) on conflict(id) do nothing;
  end if;
  select * into run_row from wlf_private.excel_runs where id=run_id for update;
  if not found then raise exception 'Excel backup not found'; end if;

  if action='read' then
    if run_row.workbook_id is null then raise exception 'Verified Excel backup not found'; end if;
    return wlf_private.excel_receipt(run_row);
  end if;
  if action in ('prepare','verify','release','clear') and run_row.actor<>actor then
    raise exception 'Only the Super Admin who started this backup can complete it';
  end if;

  if action='prepare' then
    if run_row.kind<>workbook_kind or run_row.with_clear<>clear_mode or run_row.date_from is distinct from period_from
      or run_row.date_to is distinct from period_to then raise exception 'Backup ID reused with different settings'; end if;
    if run_row.workbook_id is not null then return jsonb_build_object('verified',true); end if;
    if run_row.lease_until>now() then raise exception 'This Excel backup is already in progress. Retry shortly.'; end if;

    if run_row.kind='support' then
      select jsonb_agg(jsonb_build_object('id',t.id,'name',t.title,'schema',f.schema) order by t.sort_order) into categories
      from wlf_private.support_teams() t join public.wlf_forms f on f.category=t.id;
      for source_row in
        select r, p.name author_name, a.name assignee_name, s.name solver_name
        from public.wlf_requests r join public.wlf_profiles p on p.id=r.created_by
        left join public.wlf_profiles a on a.id=r.assigned_to left join public.wlf_profiles s on s.id=r.solved_by
        where r.deleted_at is null
          and (period_from is null or (r.created_at at time zone 'Asia/Dhaka')::date between period_from and period_to)
        order by r.created_at,r.id limit 1001
      loop
        obj=wlf_private.backup_record(source_row.r);
        x=obj||jsonb_build_object('authorName',source_row.author_name,'assigneeName',source_row.assignee_name,
          'solverName',source_row.solver_name,'id',obj->'request'->>'id','fingerprint',encode(sha256(convert_to(obj::text,'UTF8')),'hex'),
          'eligible',obj->'request'->>'status'='Solved');
        row_count=row_count+1; total_bytes=total_bytes+octet_length(x::text);
        if row_count>1000 or total_bytes>4000000 then raise exception 'Excel backup is too large. Choose a shorter date range.'; end if;
        records=array_append(records,x);
      end loop;
    else
      select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'schema',c.schema) order by c.position,c.name),'[]') into categories
      from public.wlf_ri_categories c where c.active or exists(
        select 1 from public.wlf_ri_entries e where e.category=c.id and e.deleted_at is null);
      for source_row in
        select e.* from public.wlf_ri_entries e where e.deleted_at is null
          and (period_from is null or (e.created_at at time zone 'Asia/Dhaka')::date between period_from and period_to)
        order by e.created_at,e.id limit 1001
      loop
        obj=to_jsonb(source_row);
        x=jsonb_build_object('entry',obj,'id',source_row.id,'fingerprint',encode(sha256(convert_to(obj::text,'UTF8')),'hex'),
          'eligible',source_row.status in ('Completed','Solved'));
        row_count=row_count+1; total_bytes=total_bytes+octet_length(x::text);
        if row_count>1000 or total_bytes>4000000 then raise exception 'Excel backup is too large. Choose a shorter date range.'; end if;
        records=array_append(records,x);
      end loop;
    end if;
    update wlf_private.excel_runs set nonce=(payload->>'nonce')::uuid,lease_until=now()+interval '2 minutes',
      items=coalesce((select jsonb_agg(jsonb_build_object('id',item->'id','fingerprint',item->'fingerprint',
        'eligible',item->'eligible')) from unnest(records) item),'[]') where id=run_id;
    return jsonb_build_object('verified',false,'kind',run_row.kind,'total',row_count,'categories',categories,
      'records',to_jsonb(records));
  end if;

  if action='release' then
    update wlf_private.excel_runs set lease_until=null,nonce=null
      where id=run_id and workbook_id is null and nonce=(payload->>'nonce')::uuid;
    return 'true';
  elsif action='verify' then
    if run_row.workbook_id is not null or run_row.nonce is distinct from (payload->>'nonce')::uuid
       or coalesce(payload->>'workbookId','') !~ '^[-a-zA-Z0-9_]{5,200}$'
       or coalesce(payload->>'workbookHash','') !~ '^[a-f0-9]{64}$'
       or (run_row.with_clear and (coalesce(payload->>'recoveryId','') !~ '^[-a-zA-Z0-9_]{5,200}$'
          or coalesce(payload->>'recoveryHash','') !~ '^[a-f0-9]{64}$')) then
      raise exception 'Excel backup verification rejected';
    end if;
    update wlf_private.excel_runs set workbook_id=payload->>'workbookId',workbook_hash=payload->>'workbookHash',
      recovery_id=payload->>'recoveryId',recovery_hash=payload->>'recoveryHash',nonce=null,lease_until=null
      where id=run_id returning * into run_row;
    return wlf_private.excel_receipt(run_row);
  elsif action='clear' then
    if not run_row.with_clear or run_row.workbook_id is null or run_row.recovery_id is null then
      raise exception 'Verified workbook and recovery file required for Clear';
    end if;
    if run_row.clear_finished then return wlf_private.excel_receipt(run_row); end if;
    if run_row.kind='support' then
      perform r.id from public.wlf_requests r
        join jsonb_array_elements(run_row.items) i on r.id=(i->>'id')::uuid
        where (i->>'eligible')::boolean order by r.id for update of r;
      select array_agg(r.id) into ids from public.wlf_requests r
        join jsonb_array_elements(run_row.items) i on r.id=(i->>'id')::uuid
        where (i->>'eligible')::boolean and r.deleted_at is null and r.status='Solved'
          and encode(sha256(convert_to(wlf_private.backup_record(r)::text,'UTF8')),'hex')=i->>'fingerprint';
      if ids is not null then
        insert into wlf_private.archived_operations(actor,mutation_id,request_id)
          select o.actor,o.mutation_id,o.request_id from public.wlf_operations o where o.request_id=any(ids) on conflict do nothing;
        delete from public.wlf_operations where request_id=any(ids);
        delete from public.wlf_history where request_id=any(ids);
        delete from public.wlf_requests where id=any(ids);
      end if;
    else
      perform e.id from public.wlf_ri_entries e
        join jsonb_array_elements(run_row.items) i on e.id=(i->>'id')::uuid
        where (i->>'eligible')::boolean order by e.id for update of e;
      select array_agg(e.id) into ids from public.wlf_ri_entries e
        join jsonb_array_elements(run_row.items) i on e.id=(i->>'id')::uuid
        where (i->>'eligible')::boolean and e.deleted_at is null and e.status in ('Completed','Solved')
          and encode(sha256(convert_to(to_jsonb(e)::text,'UTF8')),'hex')=i->>'fingerprint';
      if ids is not null then
        insert into wlf_private.ri_entry_archive(id) select unnest(ids) on conflict do nothing;
        delete from public.wlf_ri_entries where id=any(ids);
      end if;
    end if;
    update wlf_private.excel_runs set clear_finished=true,cleared_ids=coalesce(ids,'{}')
      where id=run_id returning * into run_row;
    return wlf_private.excel_receipt(run_row);
  elsif action='restore' then
    archive=payload->'archive';
    if run_row.recovery_id is null or not run_row.clear_finished or run_row.restored_at is not null
      or archive->>'format' is distinct from 'WLF-EXCEL-RECOVERY-2.2'
      or archive->>'project' is distinct from payload->>'project' or archive->>'id' is distinct from run_id::text
      or archive->>'kind' is distinct from run_row.kind or jsonb_typeof(archive->'records') is distinct from 'array'
      or jsonb_array_length(archive->'records')>1000 then
      raise exception 'This recovery file cannot be applied';
    end if;
    if run_row.kind='support' then
      entries=array(select r-'id'-'fingerprint'-'eligible'-'authorName'-'assigneeName'-'solverName'
        from jsonb_array_elements(archive->'records') r where (r->'request'->>'id')::uuid=any(run_row.cleared_ids));
      for restore_offset in 1..coalesce(cardinality(entries),0) by 25 loop
        x=public.wlf_backup_admin('restore',actor,jsonb_build_object('project',payload->>'project','archive',
          jsonb_build_object('format','WLF-SUPPORT-2.1','project',payload->>'project','records',to_jsonb(entries[restore_offset:restore_offset+24]))));
        restored=restored+(x->>'restored')::int;
      end loop;
    else
      insert into public.wlf_ri_entries
        select (jsonb_populate_record(null::public.wlf_ri_entries,r->'entry')).*
        from jsonb_array_elements(archive->'records') r
        where (r->'entry'->>'id')::uuid=any(run_row.cleared_ids)
        on conflict(id) do nothing;
      get diagnostics restored=row_count;
    end if;
    update wlf_private.excel_runs set restored_at=now() where id=run_id;
    return jsonb_build_object('restored',restored);
  end if;
  raise exception 'Unsupported Excel backup action';
end
$$;

revoke all on function public.wlf_excel_admin(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.wlf_excel_admin(text,uuid,jsonb) to service_role;
revoke all on all functions in schema wlf_private from public,anon;
revoke all on function wlf_private.rpc_v210(text,jsonb) from authenticated;
grant execute on function wlf_private.rpc(text,jsonb) to authenticated;
notify pgrst,'reload schema';

commit;
