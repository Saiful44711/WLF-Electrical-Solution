-- =====================================================================
-- WLF Electrical Solution v2.3.0 : Sections, Name & ID, permission update
-- Run in Supabase > SQL Editor on the EXISTING v2.2 project (after the
-- 7 Nov 2026 Damage Demand and Workspace updates). Safe to run twice.
-- Take a backup first (Backup kit: 01_STRUCTURE_BACKUP + 02_DATA_BACKUP).
--
-- What changes
--  * Profiles get Employee ID and Section. Sign-up stores Name, ID, Section.
--  * User types: Super Admin, R&I user (Section R&I Electrical/Mechanical),
--    section user. The old Admin role is removed.
--  * Nobody except Super Admin gets any option automatically.
--  * Support / R&I forms: "Name & ID" becomes two locked fields, Name and ID,
--    filled from the login profile on the server.
--  * Support tickets return Name (ID) labels instead of e-mail addresses.
--  * SUPPORT USER filter: requesters of the team's section.
--  * Super Admin profile: Md. Saiful Islam / 44711 / R&I Electrical.
-- Nothing here deletes users or records. That is the separate
-- CLEANUP_KEEP_SUPER_ADMIN_V230.sql file.
-- =====================================================================
begin;

do $pre$ begin
  if to_regprocedure('wlf_private.rpc(text,jsonb)') is null
     or to_regprocedure('wlf_private.workspace_insights(text,jsonb)') is null
     or to_regprocedure('wlf_private.damage_demands_api(text,jsonb)') is null
     or to_regprocedure('wlf_private.save_support_v220(text,jsonb)') is null then
    raise exception 'STOP: apply the v2.2 and 7 November 2026 updates first. Nothing was changed.';
  end if;
end $pre$;

-- ---------------------------------------------------------------- sections
create or replace function wlf_private.sections() returns text[]
language sql immutable set search_path='' as $$
  select array['Sales','R&I Electrical','R&I Mechanical','Production','QM','Installation',
    'Commissioning','After Sales','SCM','Dispatch','Process','Business Planning & Development',
    'Factory Maintenance']
$$;

-- Support team -> requester section (SUPPORT USER filter)
create or replace function wlf_private.team_section(team text) returns text
language sql immutable set search_path='' as $$
  select case team when 'commissioning' then 'Commissioning' when 'aftersales' then 'After Sales'
    when 'installation' then 'Installation' when 'production' then 'Production'
    when 'qc' then 'QM' when 'maintenance' then 'Factory Maintenance' end
$$;

-- R&I Electrical / R&I Mechanical users process support (internal role 'R&I')
create or replace function wlf_private.role_for(section text) returns text
language sql immutable set search_path='' as $$
  select case when section in ('R&I Electrical','R&I Mechanical') then 'R&I' else 'User' end
$$;

-- ---------------------------------------------------------------- profiles
alter table public.wlf_profiles add column if not exists employee_id text;
alter table public.wlf_profiles add column if not exists section text;
do $cols$ begin
  if not exists (select 1 from pg_constraint where conrelid='public.wlf_profiles'::regclass and conname='wlf_profiles_employee_id_check') then
    alter table public.wlf_profiles add constraint wlf_profiles_employee_id_check
      check (employee_id is null or employee_id ~ '^[A-Za-z0-9][A-Za-z0-9 ./_-]{0,29}$');
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.wlf_profiles'::regclass and conname='wlf_profiles_section_check') then
    alter table public.wlf_profiles add constraint wlf_profiles_section_check
      check (section is null or section in ('Sales','R&I Electrical','R&I Mechanical','Production','QM','Installation',
        'Commissioning','After Sales','SCM','Dispatch','Process','Business Planning & Development','Factory Maintenance'));
  end if;
end $cols$;
create index if not exists wlf_profiles_section_idx on public.wlf_profiles(section) where status='Approved';

-- Role list without Admin. Former Admin accounts become section users with no options.
alter table public.wlf_profiles disable trigger wlf_deletion_guard;
do $roles$ declare c text; begin
  for c in select conname from pg_constraint where conrelid='public.wlf_profiles'::regclass and contype='c'
           and pg_get_constraintdef(oid) like '%role%' and conname<>'wlf_profiles_role_v230' loop
    execute format('alter table public.wlf_profiles drop constraint %I', c);
  end loop;
end $roles$;
update public.wlf_profiles set role='User', permissions='{}', access_revision=access_revision+1 where role='Admin';
do $roles2$ begin
  if not exists (select 1 from pg_constraint where conrelid='public.wlf_profiles'::regclass and conname='wlf_profiles_role_v230') then
    alter table public.wlf_profiles add constraint wlf_profiles_role_v230 check (role in ('Super Admin','R&I','User'));
  end if;
end $roles2$;

-- Super Admin profile details (e-mail, password and access stay unchanged)
update public.wlf_profiles set name='Md. Saiful Islam', employee_id='44711', section='R&I Electrical'
 where email='liftrndelectrical@gmail.com' and role='Super Admin'
   and (name, coalesce(employee_id,''), coalesce(section,'')) is distinct from ('Md. Saiful Islam','44711','R&I Electrical');
alter table public.wlf_profiles enable trigger wlf_deletion_guard;

-- ---------------------------------------------------------------- people labels
create or replace function wlf_private.person_label(person uuid) returns text
language sql stable security definer set search_path='' as $$
  select case when p.id is null then ''
    else coalesce(nullif(p.name,''), p.email) || case when coalesce(p.employee_id,'')<>'' then ' ('||p.employee_id||')' else '' end end
  from (select null::int) d left join public.wlf_profiles p on p.id=person
$$;
-- Name and ID for server-side form auto-fill, separated by the unit separator
create or replace function wlf_private.person_tag(person uuid) returns text
language sql stable security definer set search_path='' as $$
  select coalesce((select coalesce(p.name,'')||chr(31)||coalesce(p.employee_id,'') from public.wlf_profiles p where p.id=person),'')
$$;

-- ---------------------------------------------------------------- access
create or replace function wlf_private.can(k text) returns boolean
language sql stable security definer set search_path='' as $$
  select coalesce((select p.status='Approved' and (p.role='Super Admin' or k=any(p.permissions))
    from public.wlf_profiles p where p.id=auth.uid()),false)
$$;

create or replace function wlf_private.safe_user(p public.wlf_profiles) returns jsonb
language sql immutable set search_path='' as $$
  select jsonb_build_object('email',p.email,'name',p.name,'role',p.role,'status',p.status,
    'permissions',p.permissions,'accessRevision',p.access_revision,
    'empId',coalesce(p.employee_id,''),'section',coalesce(p.section,''),
    'label',coalesce(nullif(p.name,''),p.email)||case when coalesce(p.employee_id,'')<>'' then ' ('||p.employee_id||')' else '' end)
$$;

-- R&I users for forwarding, labels and filters (teams = support access)
create or replace function wlf_private.directory() returns jsonb
language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('email',p.email,'name',p.name,'role',p.role,'status',p.status,
      'empId',coalesce(p.employee_id,''),'section',coalesce(p.section,''),
      'label',coalesce(nullif(p.name,''),p.email)||case when coalesce(p.employee_id,'')<>'' then ' ('||p.employee_id||')' else '' end,
      'teams',to_jsonb(array(select t.id from wlf_private.support_teams() t where ('support:'||t.id||':request')=any(p.permissions) order by t.sort_order)))
    order by p.name),'[]')
  from public.wlf_profiles p where p.status='Approved' and p.role='R&I' and p.auth_user_id is not null and wlf_private.approved()
$$;

-- Approved requesters of one support team, by Section
create or replace function wlf_private.team_users(team text) returns jsonb
language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('email',p.email,'name',p.name,'empId',coalesce(p.employee_id,''),
      'section',p.section,
      'label',coalesce(nullif(p.name,''),p.email)||case when coalesce(p.employee_id,'')<>'' then ' ('||p.employee_id||')' else '' end)
    order by p.name,p.email),'[]')
  from public.wlf_profiles p
  where p.status='Approved' and p.auth_user_id is not null and p.section=wlf_private.team_section(team)
$$;

-- Sign-up: Name, Employee ID and Section from Auth metadata. Status stays Pending.
create or replace function wlf_private.new_user() returns trigger
language plpgsql security definer set search_path='' as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data,'{}'::jsonb);
  sec text := nullif(btrim(coalesce(meta->>'section','')),'');
  emp text := nullif(btrim(coalesce(meta->>'employeeId','')),'');
begin
  if sec is not null and not (sec = any(wlf_private.sections())) then sec := null; end if;
  if emp is not null and emp !~ '^[A-Za-z0-9][A-Za-z0-9 ./_-]{0,29}$' then emp := null; end if;
  insert into public.wlf_profiles(id,auth_user_id,email,name,employee_id,section,role) values(
    new.id,new.id,lower(new.email),
    left(coalesce(nullif(btrim(coalesce(meta->>'name','')),''),split_part(new.email,'@',1)),120),
    emp, sec, wlf_private.role_for(sec));
  return new;
end
$$;

-- Catalog: team access labels (normal users submit, R&I users handle)
do $cat$ begin
  if to_regprocedure('wlf_private.catalog_before_sections()') is null then
    alter function wlf_private.catalog() rename to catalog_before_sections;
  end if;
end $cat$;
create or replace function wlf_private.catalog() returns jsonb
language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(case when e->>'key' like 'support:%:request' then
      jsonb_set(e,'{label}',to_jsonb(coalesce((select replace(t.title,' Support Request','') from wlf_private.support_teams() t
        where 'support:'||t.id||':request'=e->>'key'), e->>'label'))) else e end order by o),'[]')
  from jsonb_array_elements(wlf_private.catalog_before_sections()) with ordinality x(e,o)
$$;

-- ---------------------------------------------------------------- forms
-- "Name & ID" -> Name + ID (locked, filled from the login profile)
create or replace function wlf_private.split_identity_fields(fields jsonb) returns jsonb
language sql immutable set search_path='' as $$
  select case when jsonb_typeof(fields)<>'array' or fields @> '[{"id":"login_name"}]'::jsonb then fields else
   coalesce((select jsonb_agg(s.f order by e.o, s.sub)
    from jsonb_array_elements(fields) with ordinality e(f,o)
    cross join lateral (
      select 1 as sub, case when (e.f->>'autoFill'='identity' or (coalesce(e.f->>'autoFill','')='' and wlf_private.field_role(e.f)='identity')) and e.o=(select min(z.o) from jsonb_array_elements(fields) with ordinality z(f,o) where z.f->>'autoFill'='identity' or (coalesce(z.f->>'autoFill','')='' and wlf_private.field_role(z.f)='identity'))
        then jsonb_build_object('id','login_name','label','Name','type','text','help','Filled from your login profile.','required',true,'autoFill','name','options','[]'::jsonb)
        else e.f end as f
      union all
      select 2, jsonb_build_object('id','login_id','label','ID','type','text','help','Filled from your login profile.','required',true,'autoFill','empid','options','[]'::jsonb)
      where (e.f->>'autoFill'='identity' or (coalesce(e.f->>'autoFill','')='' and wlf_private.field_role(e.f)='identity')) and e.o=(select min(z.o) from jsonb_array_elements(fields) with ordinality z(f,o) where z.f->>'autoFill'='identity' or (coalesce(z.f->>'autoFill','')='' and wlf_private.field_role(z.f)='identity'))
    ) s), fields) end
$$;
-- Field editor: new auto-fill options name (Login Name) and empid (Login ID)
CREATE OR REPLACE FUNCTION wlf_private.form_fields(fields jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
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
        or auto_fill not in ('','today','identity','name','empid','none')
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
    if (auto_fill in ('identity','name','empid') and kind not in ('text','textarea')) or (auto_fill='today' and kind<>'date') then
      auto_fill='none';
    end if;
    result=result||jsonb_build_array(jsonb_build_object('id',field_id,'label',label,'type',kind,
      'help',left(coalesce(field->>'help',''),2000),'required',coalesce((field->>'required')::boolean,false),
      'autoFill',auto_fill,'options',choices));
  end loop;
  return result;
end
$function$;

-- Server fills Name and ID from the login profile (identity_name carries name<US>id)
CREATE OR REPLACE FUNCTION wlf_private.form_values(form jsonb, vals jsonb, identity_name text, submitted_on date, previous jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
declare f jsonb; x jsonb; txt text; field_id text; kind text; auto_fill text; choices jsonb; result jsonb='{}';
begin
  if jsonb_typeof(vals) is distinct from 'object' or octet_length(vals::text)>64000 then
    raise exception 'Invalid or oversized submission.';
  end if;
  for f in select value from jsonb_array_elements(form->'fields') loop
    field_id=f->>'id'; kind=f->>'type'; choices=coalesce(f->'options','[]');
    auto_fill=coalesce(f->>'autoFill','');
    if auto_fill='name' and kind in ('text','textarea') then
      x=coalesce(previous->field_id,to_jsonb(split_part(coalesce(identity_name,''),chr(31),1)));
    elsif auto_fill='empid' and kind in ('text','textarea') then
      x=coalesce(previous->field_id,to_jsonb(split_part(coalesce(identity_name,''),chr(31),2)));
    elsif (auto_fill='identity' or (auto_fill='' and wlf_private.field_role(f)='identity'))
        and kind in ('text','textarea') then
      x=coalesce(previous->field_id,to_jsonb(case when position(chr(31) in coalesce(identity_name,''))>0
        then split_part(identity_name,chr(31),1)||case when split_part(identity_name,chr(31),2)<>'' then ' - '||split_part(identity_name,chr(31),2) else '' end
        else identity_name end));
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
$function$;

-- Support submit/edit: pass Name and ID of the requester to auto-fill
CREATE OR REPLACE FUNCTION wlf_private.save_support_v220(action text, payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    vals=wlf_private.form_values(form.schema,payload->'values',wlf_private.person_tag(u.id),today);
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
      wlf_private.person_tag(r.created_by),(r.created_at at time zone 'Asia/Dhaka')::date,r.values);
    update public.wlf_requests set values=vals, search_text=vals::text, revision=revision+1,updated_at=now()
      where id=r.id returning * into r;
    event_name='edit form'; comment='Form corrected by Super Admin';
  end if;
  insert into public.wlf_history(request_id,actor,action,comment,to_user) values(r.id,u.id,event_name,comment,r.assigned_to);
  insert into public.wlf_operations(actor,mutation_id,action,request_id,payload) values(u.id,op,action,r.id,payload);
  return jsonb_build_object('id',r.id,'revision',r.revision,'status',r.status,'ticket',wlf_private.ticket(r),
    'summary',wlf_private.summary());
end
$function$;

-- R&I activity: Name and ID auto-fill; "Submitted by" stores Name (ID)
CREATE OR REPLACE FUNCTION wlf_private.ri_activity(action text, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
      vals=wlf_private.form_values(rec.form_schema,p->'values',wlf_private.person_tag(rec.owner),
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
    vals=wlf_private.form_values(c.schema,p->'values',wlf_private.person_tag(u.id),(now() at time zone 'Asia/Dhaka')::date);
    current_status=coalesce(nullif(wlf_private.field_display(c.schema,vals,'status'),''),'Submitted');
    insert into public.wlf_ri_entries(id,category,owner,author_name,status,form_schema,values,last_operation,last_payload_hash)
      values(entry_id,c.id,u.id,wlf_private.person_label(u.id),current_status,c.schema,vals,op,payload_hash) returning * into rec;
    insert into public.wlf_usage(actor,action,details) values(u.id,'R&I Team Activity',c.name);
  end if;
  return to_jsonb(rec)-'last_operation'-'last_payload_hash';
end
$function$;

-- Tickets: Name (ID) labels for requester, assignee, solver and history
CREATE OR REPLACE FUNCTION wlf_private.ticket(r wlf_requests, full_data boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
 select jsonb_build_object('id',r.id,'reference',r.reference,'category',r.category,'status',r.status,'createdBy',(select email from public.wlf_profiles where id=r.created_by),'createdByLabel',wlf_private.person_label(r.created_by),'assignedToLabel',case when r.assigned_to is null then '' else wlf_private.person_label(r.assigned_to) end,'solvedByLabel',case when r.solved_by is null then '' else wlf_private.person_label(r.solved_by) end,'notSolvedByLabel',case when r.not_solved_by is null then '' else wlf_private.person_label(r.not_solved_by) end,'assignedTo',coalesce((select email from public.wlf_profiles where id=r.assigned_to),''),'createdAt',r.created_at,'updatedAt',r.updated_at,'revision',r.revision,'values',r.values,
  'project',wlf_private.field_display(r.form_schema,r.values,'project'),
  'lift',wlf_private.field_display(r.form_schema,r.values,'lift'),
  'controller',to_jsonb(array(select wlf_private.field_choices(r.form_schema,r.values,'controller'))),
  'sub',to_jsonb(array(select wlf_private.field_choices(r.form_schema,r.values,'sub'))),
  'authorName',(select name from public.wlf_profiles where id=r.created_by),'formSchema',case when full_data then r.form_schema else '{}'::jsonb end,'solution',case when full_data then r.solution else '' end,'solvedBy',coalesce((select email from public.wlf_profiles where id=r.solved_by),''),'solvedAt',r.solved_at,'notSolvedBy',coalesce((select email from public.wlf_profiles where id=r.not_solved_by),''),'notSolvedAt',r.not_solved_at,'history',case when full_data then coalesce((select jsonb_agg(ev order by hid) from(select h.id hid,jsonb_build_object('at',h.at,'actor',p.email,'actorLabel',wlf_private.person_label(h.actor),'action',h.action,'comment',h.comment,'to',coalesce(q.email,''),'toLabel',case when h.to_user is null then '' else wlf_private.person_label(h.to_user) end) ev from public.wlf_history h join public.wlf_profiles p on p.id=h.actor left join public.wlf_profiles q on q.id=h.to_user where h.request_id=r.id order by h.id desc limit 150)x),'[]') else '[]'::jsonb end)$function$;

-- Support filter: SUPPORT USER (requester)
CREATE OR REPLACE FUNCTION wlf_private.filtered(f jsonb)
 RETURNS SETOF wlf_requests
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
 select r.* from public.wlf_requests r where r.deleted_at is null and wlf_private.visible(r.category,r.created_by)
 and(coalesce(f->>'category','')='' or r.category=f->>'category')
 and(coalesce(f->>'status','')='' or r.status=f->>'status')
 and(coalesce(f->>'requester','')='' or r.created_by=(select id from public.wlf_profiles where email=f->>'requester'))
 and(coalesce(f->>'assignee','')='' or r.assigned_to=(select id from public.wlf_profiles where email=f->>'assignee'))
 and(coalesce(f->>'engineer','')='' or case when f->>'dateBasis'='solved' or f->>'status'='Solved' then r.solved_by=(select id from public.wlf_profiles where email=f->>'engineer') else exists(select 1 from public.wlf_history h join public.wlf_profiles p on p.id=h.actor where h.request_id=r.id and p.email=f->>'engineer' and h.action in ('receive','solve','forward','notSolved','pending')) end)
 and(coalesce(f->>'from','')='' or (case when f->>'dateBasis'='solved' then r.solved_at else r.created_at end at time zone 'Asia/Dhaka')::date >= (f->>'from')::date)
 and(coalesce(f->>'to','')='' or (case when f->>'dateBasis'='solved' then r.solved_at else r.created_at end at time zone 'Asia/Dhaka')::date <= (f->>'to')::date)
 and(coalesce(f->>'query','')='' or position(lower(left(f->>'query',200)) in lower(r.search_text||' '||r.reference||' '||r.id||' '||r.solution))>0)
 and(coalesce(f->>'controller','')='' or exists(select 1 from wlf_private.field_choices(r.form_schema,r.values,'controller') x where lower(x)=lower(btrim(f->>'controller'))))
 and(coalesce(f->>'sub','')='' or exists(select 1 from wlf_private.field_choices(r.form_schema,r.values,'sub') x where lower(x)=lower(btrim(f->>'sub'))))
 order by r.updated_at desc,r.id$function$;

-- Convert the live form definitions (submitted requests keep their own snapshot)
update public.wlf_forms set schema=jsonb_set(schema,'{fields}',wlf_private.split_identity_fields(schema->'fields')),revision=revision+1
 where schema->'fields' is distinct from wlf_private.split_identity_fields(schema->'fields');
update public.wlf_ri_categories set schema=jsonb_set(schema,'{fields}',wlf_private.split_identity_fields(schema->'fields')),revision=revision+1
 where jsonb_typeof(schema->'fields')='array' and schema->'fields' is distinct from wlf_private.split_identity_fields(schema->'fields');

-- ---------------------------------------------------------------- RPC layer
do $layer$ begin
  if to_regprocedure('wlf_private.rpc_before_sections(text,jsonb)') is null then
    alter function wlf_private.rpc(text,jsonb) rename to rpc_before_sections;
  end if;
end $layer$;

create or replace function wlf_private.rpc(a text, args jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  p jsonb := coalesce(args->0,'{}');
  u public.wlf_profiles;
  target public.wlf_profiles;
  result jsonb;
  cat text;
  v_name text; v_emp text; v_section text; v_status text; v_role text;
begin
  u := wlf_private.me();
  if u.id is null or u.status is distinct from 'Approved' then
    raise exception 'SESSION_EXPIRED: Account is pending approval or inactive';
  end if;
  if octet_length(args::text)>100000 then raise exception 'Request too large'; end if;

  if a='saveAppUserAccess' then
    if u.role<>'Super Admin' then raise exception 'Permission denied: Super Admin only'; end if;
    select * into target from public.wlf_profiles where email=lower(btrim(p->>'email')) and auth_user_id is not null for update;
    if not found then raise exception 'User not found'; end if;
    if target.access_revision is distinct from (p->>'accessRevision')::integer then raise exception 'CONFLICT: Access changed'; end if;
    v_name := btrim(coalesce(p->>'name', target.name));
    v_emp := nullif(btrim(coalesce(p->>'empId', target.employee_id, '')),'');
    v_section := nullif(btrim(coalesce(p->>'section', target.section, '')),'');
    v_status := coalesce(p->>'status','');
    if length(v_name) not between 1 and 120 then raise exception 'Enter the user name (1-120 characters).'; end if;
    if v_emp is null or v_emp !~ '^[A-Za-z0-9][A-Za-z0-9 ./_-]{0,29}$' then raise exception 'Enter a valid ID (letters or digits, up to 30).'; end if;
    if v_section is null or not (v_section = any(wlf_private.sections())) then raise exception 'Choose a section.'; end if;
    if v_status not in ('Approved','Pending','Rejected') then raise exception 'Invalid status'; end if;
    v_role := case when coalesce((p->>'superAdmin')::boolean,false) then 'Super Admin' else wlf_private.role_for(v_section) end;
    if target.id=u.id and (v_role<>'Super Admin' or v_status<>'Approved') then
      raise exception 'Cannot remove your own Super Admin access';
    end if;
    if jsonb_typeof(p->'permissions')<>'array' or jsonb_array_length(p->'permissions')>500
       or exists(select 1 from jsonb_array_elements_text(p->'permissions') k
                 where not exists(select 1 from jsonb_array_elements(wlf_private.catalog()) x where x->>'key'=k)) then
      raise exception 'Invalid permissions';
    end if;
    update public.wlf_profiles set name=v_name, employee_id=v_emp, section=v_section, role=v_role, status=v_status,
      permissions=array(select distinct jsonb_array_elements_text(p->'permissions')), access_revision=access_revision+1
      where id=target.id returning * into target;
    return wlf_private.safe_user(target);
  elsif a='adminGetComponents' and u.role<>'Super Admin' then
    raise exception 'Permission denied: Super Admin only';
  elsif a='transitionSupportRequest' and p->>'action'='forward' then
    select category into cat from public.wlf_requests where id=nullif(p->>'id','')::uuid;
    if cat is not null and not exists(select 1 from public.wlf_profiles t
        where t.email=lower(btrim(coalesce(p->>'to',''))) and t.status='Approved' and t.role='R&I'
          and t.id<>u.id and ('support:'||cat||':request')=any(t.permissions)) then
      raise exception 'Select another approved R&I user who has access to this team.';
    end if;
  end if;

  result := wlf_private.rpc_before_sections(a,args);

  if a in ('getSession','getAppContext') then
    result := result||jsonb_build_object(
      'canCalculate', u.role='Super Admin' or exists(select 1 from unnest(u.permissions) k where k like 'calc:%'),
      'sectionsUpdate', true, 'sections', to_jsonb(wlf_private.sections()), 'build', '2.3.0');
  elsif a='getSupportWorkspace' and coalesce(p->>'category','')<>'' and u.role in ('Super Admin','R&I') then
    result := result||jsonb_build_object('teamUsers', wlf_private.team_users(p->>'category'),
      'teamSection', wlf_private.team_section(p->>'category'));
  elsif a='getMyWorkspaceProfile' and jsonb_typeof(result->'profile')='object' then
    result := jsonb_set(result,'{profile}',(result->'profile')||jsonb_build_object(
      'empId',coalesce(u.employee_id,''),'section',coalesce(u.section,''),'label',wlf_private.person_label(u.id)));
  end if;
  return result;
end
$$;

-- ---------------------------------------------------------------- grants
revoke all on function wlf_private.rpc_before_sections(text,jsonb) from public, anon, authenticated;
revoke all on function wlf_private.catalog_before_sections() from public, anon, authenticated;
revoke all on function wlf_private.rpc(text,jsonb) from public, anon;
grant execute on function wlf_private.rpc(text,jsonb) to authenticated;
revoke all on function wlf_private.sections() from public, anon, authenticated;
revoke all on function wlf_private.team_section(text) from public, anon, authenticated;
revoke all on function wlf_private.role_for(text) from public, anon, authenticated;
revoke all on function wlf_private.person_label(uuid) from public, anon, authenticated;
revoke all on function wlf_private.person_tag(uuid) from public, anon, authenticated;
revoke all on function wlf_private.team_users(text) from public, anon, authenticated;
revoke all on function wlf_private.split_identity_fields(jsonb) from public, anon, authenticated;
revoke all on function wlf_private.catalog() from public, anon, authenticated;
revoke all on function wlf_private.safe_user(public.wlf_profiles) from public, anon, authenticated;
revoke all on function wlf_private.directory() from public, anon, authenticated;
grant select on public.wlf_profiles to service_role;

notify pgrst, 'reload schema';
commit;

-- ---------------------------------------------------------------- check
select
  exists(select 1 from information_schema.columns where table_schema='public' and table_name='wlf_profiles' and column_name='employee_id') as profile_id_section_ready,
  not exists(select 1 from public.wlf_profiles where role not in ('Super Admin','R&I','User')) as admin_role_removed,
  not exists(select 1 from public.wlf_forms f, jsonb_array_elements(f.schema->'fields') x where x->>'autoFill'='identity') as support_forms_split,
  not exists(select 1 from public.wlf_ri_categories c, jsonb_array_elements(c.schema->'fields') x where x->>'autoFill'='identity') as ri_forms_split,
  coalesce((select employee_id='44711' and section='R&I Electrical' from public.wlf_profiles
    where email='liftrndelectrical@gmail.com' and role='Super Admin'),false) as super_admin_profile_ready;
