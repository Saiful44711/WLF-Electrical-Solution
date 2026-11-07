-- WLF Electrical Solution. Apply to the existing v2.2 project in SQL Editor.
begin;

do $$
begin
  if to_regprocedure('wlf_private.rpc_v210(text,jsonb)') is null
     or to_regprocedure('wlf_private.field_choices(jsonb,jsonb,text)') is null
     or (select count(*) from public.wlf_forms) <> 6 then
    raise exception 'This update requires the WLF v2.2 database with all six Technical Support teams.';
  end if;
  if to_regprocedure('wlf_private.rpc_v220(text,jsonb)') is null then
    alter function wlf_private.rpc(text,jsonb) rename to rpc_v220;
  end if;
  if to_regprocedure('wlf_private.catalog_v220()') is null then
    alter function wlf_private.catalog() rename to catalog_v220;
  end if;
end
$$;

alter table public.wlf_requests
  add column if not exists duration_minutes numeric(8,2) check (duration_minutes >= 0),
  add column if not exists hardware_issue boolean;

-- This is a point-in-time demand record. It remains available after a support
-- request is archived by the existing Storage tools.
create table if not exists wlf_private.damage_demands (
  request_id uuid primary key,
  demand_no bigint generated always as identity unique,
  category text not null check (category in ('commissioning','aftersales','installation','maintenance')),
  request_reference text not null,
  requester_id uuid not null,
  requester_name text not null,
  requested_at timestamptz not null,
  project text not null,
  lift_id text not null,
  controllers text[] not null,
  problem_categories text[] not null,
  form_schema jsonb not null,
  form_values jsonb not null,
  confirmed_by uuid not null,
  confirmed_name text not null,
  created_at timestamptz not null default now(),
  duration_minutes numeric(8,2) check (duration_minutes >= 0),
  solution_statement text not null,
  item_name text not null check (length(item_name) between 1 and 180),
  item_code text not null check (length(item_code) <= 120),
  item_spec text not null check (length(item_spec) <= 240),
  quantity integer not null check (quantity between 1 and 999999),
  create_operation uuid not null,
  create_payload_hash bytea not null,
  received_at timestamptz,
  received_by uuid,
  received_name text,
  check ((received_at is null and received_by is null and received_name is null)
      or (received_at is not null and received_by is not null and received_name is not null))
);
alter table wlf_private.damage_demands enable row level security;
revoke all on wlf_private.damage_demands from public, anon, authenticated, service_role;
create index if not exists wlf_damage_demands_date_idx on wlf_private.damage_demands(created_at);
create index if not exists wlf_damage_demands_team_idx on wlf_private.damage_demands(category,demand_no desc);

create or replace function wlf_private.catalog()
returns jsonb language sql stable security definer set search_path='' as $$
  select wlf_private.catalog_v220() || '[
    {"key":"damage:demand","label":"Demand / View demand queue","group":"Damage Demand"},
    {"key":"damage:dashboard","label":"Dashboard / View and download reports","group":"Damage Demand"},
    {"key":"damage:receive","label":"Dispatch / Receive demands (also enable Demand)","group":"Damage Demand"}
  ]'::jsonb
$$;

-- Add the problem-category field role while keeping all existing field roles.
create or replace function wlf_private.field_role(field jsonb)
returns text language sql immutable set search_path='' as $$
  select case
    when field->>'id' in ('identity','field_1674702979')
      or lower(field->>'label') in ('name & id','name & (id)','name (id)','full name-id','responder name & id') then 'identity'
    when field->>'id' in ('controller','field_620050161','field_637986521')
      or lower(field->>'label') in ('controller','control system','control system brand') then 'controller'
    when field->>'id' in ('sub','field_295723266')
      or lower(regexp_replace(coalesce(field->>'label',''),'[^a-zA-Z]+','','g')) in ('subcategory','problemsubcategory') then 'sub'
    when field->>'id'='problem_category'
      or lower(regexp_replace(coalesce(field->>'label',''),'[^a-zA-Z]+','','g'))='problemcategory' then 'problem-category'
    when field->>'id' in ('lift','field_1369800003') or lower(field->>'label') in ('lift id','project lift id') then 'lift'
    when field->>'id' in ('project','field_1866778380','field_702543330')
      or lower(field->>'label') in ('project name','project / task name') then 'project'
    when field->>'id' = 'status' or lower(field->>'label') in ('task status','project/task status','solution status') then 'status'
    else '' end
$$;

create or replace function wlf_private.damage_team(team text)
returns boolean language sql immutable set search_path='' as $$
  select team in ('commissioning','aftersales','installation','maintenance')
$$;

create or replace function wlf_private.damage_duration(raw text)
returns numeric language plpgsql immutable set search_path='' as $$
begin
  if coalesce(raw,'')='' then return null; end if;
  if raw !~ '^[0-9]{1,6}([.][0-9]{1,2})?$' then
    raise exception 'Duration must be 0 to 999999.99 minutes, with up to two decimal places.';
  end if;
  return raw::numeric;
end
$$;

create or replace function wlf_private.damage_demand_row(d wlf_private.damage_demands)
returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object(
    'id',d.request_id,'number',d.demand_no,'reference','DD-'||d.demand_no,
    'category',d.category,'requestReference',d.request_reference,'requesterName',d.requester_name,
    'project',d.project,'lift',d.lift_id,'controllers',d.controllers,'problemCategories',d.problem_categories,
    'itemName',d.item_name,'itemCode',d.item_code,'itemSpec',d.item_spec,'quantity',d.quantity,
    'status',case when d.received_at is null then 'Pending' else 'Received' end,
    'createdAt',d.created_at,'receivedAt',d.received_at,'receivedBy',d.received_name,
    'confirmedBy',d.confirmed_name,'durationMinutes',d.duration_minutes
  )
$$;

create or replace function wlf_private.damage_demand_detail(d wlf_private.damage_demands)
returns jsonb language sql stable set search_path='' as $$
  select wlf_private.damage_demand_row(d)||jsonb_build_object(
    'supportForm',d.form_schema,'supportValues',d.form_values,'requestedAt',d.requested_at,
    'solutionStatement',d.solution_statement
  )
$$;

create or replace function wlf_private.damage_support_ticket(ticket jsonb)
returns jsonb language sql stable set search_path='' as $$
  select ticket || jsonb_build_object(
    'durationMinutes',r.duration_minutes,'hardwareIssue',r.hardware_issue,
    'damageDemand',case when d.request_id is not null then jsonb_build_object(
      'reference','DD-'||d.demand_no,
      'status',case when d.received_at is null then 'Pending' else 'Received' end,
      'receivedAt',d.received_at,
      'solutionStatement',case when u.role='R&I' and r.assigned_to=u.id then d.solution_statement end
    ) end
  )
  from public.wlf_requests r
  cross join wlf_private.me() u
  left join wlf_private.damage_demands d on d.request_id=r.id
    and (d.requester_id=u.id or u.role in ('Super Admin','R&I') or 'damage:demand'=any(u.permissions))
  where r.id=(ticket->>'id')::uuid
$$;

create or replace function wlf_private.create_damage_demand(p jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare
  u public.wlf_profiles := wlf_private.me();
  r public.wlf_requests;
  d wlf_private.damage_demands;
  operation uuid := (p->>'operation')::uuid;
  payload_hash bytea := sha256(convert_to(p::text,'UTF8'));
  item text := btrim(coalesce(p->>'itemName',''));
  item_code text := btrim(coalesce(p->>'itemCode',''));
  item_spec text := btrim(coalesce(p->>'itemSpec',''));
  quantity_text text := btrim(coalesce(p->>'quantity',''));
  statement text := btrim(coalesce(p->>'solutionStatement',''));
  duration numeric;
begin
  if u.role <> 'R&I' then raise exception 'Only the assigned R&I user can raise a demand.'; end if;
  if operation is null then raise exception 'Missing operation ID.'; end if;

  select * into r from public.wlf_requests where id=(p->>'id')::uuid and deleted_at is null for update;
  if not found then raise exception 'Support request no longer available.'; end if;

  select * into d from wlf_private.damage_demands where request_id=r.id;
  if found then
    if d.confirmed_by=u.id and d.create_operation=operation then
      if d.create_payload_hash<>payload_hash then raise exception 'Operation ID reused with different data.'; end if;
      return jsonb_build_object('ticket',wlf_private.damage_support_ticket(wlf_private.ticket(r)),
        'summary',wlf_private.summary());
    end if;
    raise exception 'A demand already exists for this request. Refresh the request.';
  end if;

  if r.status<>'Received' or r.assigned_to is distinct from u.id then
    raise exception 'Receive the request first. Only the assigned R&I user can raise its demand.';
  end if;
  if r.revision is distinct from (p->>'revision')::integer then
    raise exception 'CONFLICT: Request changed. Refresh and review.';
  end if;
  if not wlf_private.damage_team(r.category) then
    raise exception 'Replacement demands are available for Commissioning, After Sales, Installation and Factory Maintenance.';
  end if;
  if jsonb_typeof(p->'itemName') is distinct from 'string' or length(item) not between 1 and 180 then
    raise exception 'Enter an item name of up to 180 characters.';
  end if;
  if length(item_code)>120 or length(item_spec)>240 then raise exception 'Item code or model/spec is too long.'; end if;
  if quantity_text !~ '^[0-9]{1,6}$' or quantity_text::integer<1 then
    raise exception 'Item quantity must be a whole number from 1 to 999999.';
  end if;
  if jsonb_typeof(p->'solutionStatement') is distinct from 'string' or length(statement) not between 1 and 6000 then
    raise exception 'Enter the solution statement on the support request before submitting the demand.';
  end if;
  duration := wlf_private.damage_duration(p->>'durationMinutes');

  insert into wlf_private.damage_demands (
    request_id,category,request_reference,requester_id,requester_name,requested_at,project,lift_id,
    controllers,problem_categories,form_schema,form_values,confirmed_by,confirmed_name,duration_minutes,
    solution_statement,item_name,item_code,item_spec,quantity,create_operation,create_payload_hash
  ) values (
    r.id,r.category,r.reference,r.created_by,(select name from public.wlf_profiles where id=r.created_by),r.created_at,
    wlf_private.field_display(r.form_schema,r.values,'project'),wlf_private.field_display(r.form_schema,r.values,'lift'),
    array(select wlf_private.field_choices(r.form_schema,r.values,'controller')),
    array(select wlf_private.field_choices(r.form_schema,r.values,'problem-category')),
    r.form_schema,r.values,u.id,u.name,duration,statement,item,item_code,item_spec,quantity_text::integer,operation,payload_hash
  ) returning * into d;

  update public.wlf_requests set duration_minutes=duration,hardware_issue=true,
    revision=revision+1,updated_at=now() where id=r.id returning * into r;
  insert into public.wlf_history(request_id,actor,action,comment,to_user)
    values(r.id,u.id,'damage demand','DD-'||d.demand_no||' submitted to Dispatch',r.assigned_to);
  return jsonb_build_object('ticket',wlf_private.damage_support_ticket(wlf_private.ticket(r)),
    'summary',wlf_private.summary());
end
$$;

create or replace function wlf_private.save_support_review(request_id uuid, review jsonb)
returns void language plpgsql set search_path='' as $$
declare
  team text;
  has_demand boolean;
  issue boolean;
  duration numeric;
begin
  if jsonb_typeof(review) is distinct from 'object'
     or coalesce(jsonb_typeof(review->'hardwareIssue'),'null') not in ('boolean','null') then
    raise exception 'Choose Yes or No for Hardware Issue.';
  end if;
  issue := (review->>'hardwareIssue')::boolean;
  duration := wlf_private.damage_duration(review->>'durationMinutes');
  select r.category into team from public.wlf_requests r where r.id=request_id;
  select exists(select 1 from wlf_private.damage_demands d where d.request_id=save_support_review.request_id) into has_demand;
  if has_demand and issue is distinct from true then
    raise exception 'Hardware Issue is Yes because a demand already exists.';
  end if;
  if not has_demand and issue and wlf_private.damage_team(team) then
    raise exception 'Submit the Damage Demand before saving Hardware Issue as Yes.';
  end if;
  update public.wlf_requests set duration_minutes=duration,hardware_issue=issue where id=request_id;
end
$$;

create or replace function wlf_private.damage_filter_choice(choices text[], filter_value text)
returns boolean language sql immutable set search_path='' as $$
  select coalesce(filter_value,'')='' or (filter_value='missing' and cardinality(choices)=0)
    or exists(select 1 from unnest(choices) choice where 'v:'||lower(choice)=filter_value)
$$;

create or replace function wlf_private.damage_facets()
returns jsonb language sql stable set search_path='' as $$
  with choices as (
    select 'controller' as kind, choice from wlf_private.damage_demands
    cross join lateral unnest(case when cardinality(controllers)=0 then array[null::text] else controllers end) choice
    union all
    select 'problemCategory', choice from wlf_private.damage_demands
    cross join lateral unnest(case when cardinality(problem_categories)=0 then array[null::text] else problem_categories end) choice
    union all
    select 'component', item_name from wlf_private.damage_demands
  ), options as (
    select kind,coalesce('v:'||lower(choice),'missing') as value,coalesce(min(choice),'Not recorded') as label
    from choices group by kind,lower(choice)
  ), grouped as (
    select kind,jsonb_agg(jsonb_build_object('value',value,'label',label) order by lower(label),value) as items
    from options group by kind
  )
  select coalesce(jsonb_object_agg(kind,items),'{}') from grouped
$$;

create or replace function wlf_private.damage_demands_api(a text,p jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare
  u public.wlf_profiles := wlf_private.me();
  demand_access boolean := u.role='Super Admin' or 'damage:demand'=any(u.permissions);
  report_access boolean := u.role='Super Admin' or 'damage:dashboard'=any(u.permissions);
  receive_access boolean := demand_access and 'damage:receive'=any(u.permissions);
  d wlf_private.damage_demands;
  from_date date;
  to_date date;
  cursor_no bigint;
  page_size integer := case when a='getDamageReport' then 2500 else 25 end;
  include_stats boolean := a in ('getDamageDashboard','getDamageReport');
  result jsonb;
begin
  if a='receiveDamageDemand' then
    if not receive_access then raise exception 'Demand and Dispatch Receive permissions are required.'; end if;
    update wlf_private.damage_demands set received_at=now(),received_by=u.id,received_name=u.name
      where request_id=(p->>'id')::uuid and received_at is null returning * into d;
    if not found then
      select * into d from wlf_private.damage_demands where request_id=(p->>'id')::uuid;
      if not found then raise exception 'Damage demand not found.'; end if;
      if d.received_by is distinct from u.id then raise exception 'Already received by Dispatch. Refresh the list.'; end if;
    end if;
    return wlf_private.damage_demand_detail(d);
  end if;

  if include_stats then
    if not report_access then raise exception 'Damage Demand Dashboard access required.'; end if;
  elsif not demand_access then
    raise exception 'Damage Demand access required.';
  end if;
  if a='getDamageDemand' then
    select * into d from wlf_private.damage_demands where request_id=(p->>'id')::uuid;
    if not found then raise exception 'Damage demand not found.'; end if;
    return wlf_private.damage_demand_detail(d);
  end if;

  from_date := nullif(p->>'from','')::date;
  to_date := nullif(p->>'to','')::date;
  if from_date>to_date then raise exception 'From date must be on or before To date.'; end if;
  if a<>'getDamageReport' then cursor_no := nullif(p->>'cursor','')::bigint; end if;

  with filtered as materialized (
    select dmd.* from wlf_private.damage_demands dmd
    where (from_date is null or dmd.created_at >= from_date::timestamp at time zone 'Asia/Dhaka')
      and (to_date is null or dmd.created_at < (to_date+1)::timestamp at time zone 'Asia/Dhaka')
      and (coalesce(p->>'category','')='' or dmd.category=p->>'category')
      and (coalesce(p->>'status','')='' or p->>'status'=case when dmd.received_at is null then 'Pending' else 'Received' end)
      and position(lower(left(btrim(coalesce(p->>'lift','')),200)) in lower(dmd.lift_id))>0
      and position(lower(left(btrim(coalesce(p->>'project','')),200)) in lower(dmd.project))>0
      and wlf_private.damage_filter_choice(dmd.controllers,p->>'controller')
      and wlf_private.damage_filter_choice(dmd.problem_categories,p->>'problemCategory')
      and wlf_private.damage_filter_choice(array[dmd.item_name],p->>'component')
  ), page as materialized (
    select f.* from filtered f where cursor_no is null or f.demand_no<cursor_no
    order by f.demand_no desc limit page_size
  ), counts as (
    select count(*) as total,count(*) filter (where received_at is null) as pending,coalesce(sum(quantity),0) as units
    from filtered
  ), components as (
    select min(item_name) as component,sum(quantity) as units,count(*) as demands
    from filtered group by lower(item_name)
  )
  select jsonb_build_object(
    'rows',coalesce((select jsonb_agg(wlf_private.damage_demand_row(page) order by page.demand_no desc) from page),'[]'),
    'total',counts.total,
    'nextCursor',case when exists(select 1 from filtered where demand_no<(select min(demand_no) from page))
      then (select min(demand_no)::text from page) end
  ) || case when include_stats then jsonb_build_object(
    'pending',counts.pending,'received',counts.total-counts.pending,'units',counts.units,
    'components',coalesce((select jsonb_agg(jsonb_build_object(
      'label',c.component,'units',c.units,'demands',c.demands,
      'percentage',round(c.units*100.0/nullif(counts.units,0),2)
    ) order by c.units desc,lower(c.component)) from components c),'[]')
  ) else '{}'::jsonb end
  into result from counts;

  if a='getDamageReport' and (result->>'total')::bigint>page_size then
    raise exception 'More than 2500 demands match. Select a shorter date range or additional filters.';
  end if;
  if a='getDamageDashboard' then result := result||jsonb_build_object('facets',wlf_private.damage_facets()); end if;
  return result;
end
$$;

create or replace function wlf_private.rpc(a text,args jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  p jsonb := coalesce(args->0,'{}');
  result jsonb;
begin
  if not wlf_private.approved() then raise exception 'SESSION_EXPIRED: Account is pending approval or inactive'; end if;
  if octet_length(args::text)>100000 then raise exception 'Request too large'; end if;

  if a='createDamageDemand' then
    return wlf_private.create_damage_demand(p);
  elsif a in ('getDamageDemands','getDamageDemand','getDamageDashboard','getDamageReport','receiveDamageDemand') then
    return wlf_private.damage_demands_api(a,p);
  end if;

  result := wlf_private.rpc_v220(a,args);
  if a in ('getSession','getAppContext') then
    return result||jsonb_build_object('damageDemand',true);
  elsif a='getSupportRequest' then
    return wlf_private.damage_support_ticket(result);
  elsif a in ('transitionSupportRequest','createSupportRequest','editSupportRequest') and result ? 'ticket' then
    -- The existing transition checks assignment, revision and retry ID first.
    -- Review validation or write failure rolls back the whole transition.
    if a='transitionSupportRequest' and p->>'action'<>'receive' and p ? 'review'
       and not coalesce((result->>'duplicate')::boolean,false) then
      perform wlf_private.save_support_review((result->>'id')::uuid,p->'review');
    end if;
    return jsonb_set(result,'{ticket}',wlf_private.damage_support_ticket(result->'ticket'));
  end if;
  return result;
end
$$;

revoke all on function wlf_private.rpc_v220(text,jsonb),wlf_private.catalog_v220(),
  wlf_private.catalog(),wlf_private.damage_team(text),wlf_private.damage_duration(text),
  wlf_private.damage_demand_row(wlf_private.damage_demands),wlf_private.damage_demand_detail(wlf_private.damage_demands),
  wlf_private.damage_support_ticket(jsonb),wlf_private.create_damage_demand(jsonb),wlf_private.save_support_review(uuid,jsonb),
  wlf_private.damage_filter_choice(text[],text),wlf_private.damage_facets(),wlf_private.damage_demands_api(text,jsonb)
  from public, anon, authenticated, service_role;
revoke all on function wlf_private.rpc(text,jsonb) from public, anon;
grant execute on function wlf_private.rpc(text,jsonb) to authenticated;

notify pgrst,'reload schema';
commit;

select
  to_regprocedure('wlf_private.rpc_v220(text,jsonb)') is not null as damage_demand_ready,
  (select count(*)=3 from jsonb_array_elements(wlf_private.catalog()) p where p->>'key' like 'damage:%') as access_options_ready,
  (select relrowsecurity from pg_class where oid='wlf_private.damage_demands'::regclass)
    and not has_table_privilege('authenticated','wlf_private.damage_demands','SELECT')
    and not has_table_privilege('anon','wlf_private.damage_demands','SELECT') as demand_table_private,
  (select count(*)=6 from public.wlf_forms) as support_forms_ready;
