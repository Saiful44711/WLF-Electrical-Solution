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
