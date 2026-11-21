-- =====================================================================
-- WLF Electrical Solution v2.6.1
--  * QMS lift records no longer keep a full private copy of every part and
--    of the motor data. Each distinct catalogue row (as it was when the lift
--    was saved) is stored ONCE in wlf_private.hw_snap and the lift keeps a
--    short reference. A lift still shows exactly the data of the day it was
--    saved; a changed catalogue only affects lifts saved or edited later.
--    Existing lifts are converted in this script (nothing is lost).
--  * Storage & Backup: Super Admin can see database use per option, download
--    a backup of the Hardware Catalogue and of the QMS lift records, and
--    restore from such a file (adds what is missing, never deletes).
-- Run in Supabase > SQL Editor after v2.6.0 (UPDATE_V260.sql). Safe to run
-- twice. Back up first. If an RLS warning appears, choose "Run without RLS".
-- =====================================================================
begin;

do $pre$ begin
  if to_regprocedure('wlf_private.rpc_before_v260(text,jsonb)') is null then
    raise exception 'STOP: apply UPDATE_V260.sql (v2.6.0) first. Nothing was changed.';
  end if;
end $pre$;

-- ---------------------------------------------------------------- shared snapshot rows
create table if not exists wlf_private.hw_snap(
  h text primary key,
  body jsonb not null,
  created_at timestamptz not null default now()
);
alter table wlf_private.hw_snap enable row level security;
revoke all on wlf_private.hw_snap from public, anon, authenticated;

create or replace function wlf_private.hw_snap_put(b jsonb) returns text
language plpgsql security definer set search_path='' as $$
declare k text := md5(b::text);
begin
  insert into wlf_private.hw_snap(h,body) values(k,b) on conflict (h) do nothing;
  return k;
end
$$;

create or replace function wlf_private.qms_parts_open(parts jsonb) returns jsonb
language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(
    case when e ? 'h' then coalesce((select s.body from wlf_private.hw_snap s where s.h=e->>'h'),'{}'::jsonb) || (e - 'h') else e end
    order by o),'[]'::jsonb)
  from jsonb_array_elements(case when jsonb_typeof(parts)='array' then parts else '[]'::jsonb end) with ordinality t(e,o)
$$;

create or replace function wlf_private.qms_sel_open(sel jsonb) returns jsonb
language sql stable security definer set search_path='' as $$
  select case when sel is not null and jsonb_typeof(sel)='object' and sel ? 'h' and (select count(*) from jsonb_object_keys(sel))=1
    then (select s.body from wlf_private.hw_snap s where s.h=sel->>'h') else sel end
$$;

create or replace function wlf_private.qms_parts_pack(parts jsonb) returns jsonb
language sql volatile security definer set search_path='' as $$
  select coalesce(jsonb_agg(
    case when e ? 'h' then e
         else jsonb_build_object('section',e->>'section','serial',coalesce(e->>'serial',''),'h',wlf_private.hw_snap_put(e - 'section' - 'serial')) end
    order by o),'[]'::jsonb)
  from jsonb_array_elements(case when jsonb_typeof(parts)='array' then parts else '[]'::jsonb end) with ordinality t(e,o)
$$;

create or replace function wlf_private.qms_sel_pack(sel jsonb) returns jsonb
language sql volatile security definer set search_path='' as $$
  select case when sel is null or jsonb_typeof(sel)<>'object' or sel ? 'h' then sel
              else jsonb_build_object('h',wlf_private.hw_snap_put(sel)) end
$$;
revoke all on function wlf_private.hw_snap_put(jsonb), wlf_private.qms_parts_open(jsonb), wlf_private.qms_sel_open(jsonb),
  wlf_private.qms_parts_pack(jsonb), wlf_private.qms_sel_pack(jsonb) from public, anon, authenticated;

-- existing lifts: convert once
update wlf_private.qms_lifts
   set parts=wlf_private.qms_parts_pack(parts), selection=wlf_private.qms_sel_pack(selection)
 where exists (select 1 from jsonb_array_elements(case when jsonb_typeof(parts)='array' then parts else '[]'::jsonb end) e where not (e ? 'h'))
    or (selection is not null and jsonb_typeof(selection)='object' and not (selection ? 'h'));

-- ---------------------------------------------------------------- readers and writer use the shared rows
create or replace function wlf_private.qms_lift_view(r wlf_private.qms_lifts, detailed boolean) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare base jsonb;
begin
  base := jsonb_build_object('id',r.id,'liftId',r.lift_id,'project',r.project,'deliveryDate',r.delivery_date,
    'system',r.system,'controllerModel',r.controller_model,'updatedAt',r.updated_at,'updatedName',r.updated_name,
    'createdName',r.created_name,'revision',r.revision);
  if detailed then
    base := base || jsonb_build_object('address',r.address,'motorType',r.motor_type,'liftType',r.lift_type,
      'serials',r.serials,'selection',wlf_private.qms_sel_open(r.selection),'parts',wlf_private.qms_parts_open(r.parts),'history',r.history,'createdAt',r.created_at,
      'canEdit',wlf_private.hw_has('qms:edit'),'canDelete',wlf_private.hw_has('qms:delete'));
  end if;
  return base;
end
$$;

create or replace function wlf_private.hw_api(a text, p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  u public.wlf_profiles := wlf_private.me();
  can_read boolean := wlf_private.hw_has('catalogue:edit') or wlf_private.hw_has('qms:components') or wlf_private.hw_has('damage:demand') or u.role='R&I';
  can_edit boolean := wlf_private.hw_has('catalogue:edit');
  r wlf_private.hw_catalogue;
  q wlf_private.qms_lifts;
  rows jsonb;
  n integer;
  rev integer;
  sys text; mdl text;
  it jsonb;
  c wlf_private.hw_catalogue;
  snap jsonb := '[]';
  selc jsonb;
  changes text[] := '{}';
  who text := coalesce(nullif(u.name,''),u.email);
  lid text; term text; code_term text;
  sections text[] := array['control','lop','cop','faceplate','transom','cable','other','avr'];
begin
  if u.id is null or u.status<>'Approved' then raise exception 'SESSION_EXPIRED: Account is pending approval or inactive'; end if;

  -- ---- catalogue (read)
  if a='getCatalogue' then
    if not can_read then raise exception 'Hardware Catalogue access required.'; end if;
    select coalesce(jsonb_agg(wlf_private.hw_row(x) order by x.system,x.model,x.sort,x.created_at),'[]') into rows
      from wlf_private.hw_catalogue x where x.deleted_at is null;
    return jsonb_build_object('rows',rows,'canEdit',can_edit,
      'map',coalesce((select jsonb_agg(jsonb_build_object('keyword',keyword,'groups',groups) order by keyword) from wlf_private.hw_suggest),'[]'));
  end if;

  -- ---- catalogue (write)
  if a in ('saveCatalogueRow','deleteCatalogueRow','newCatalogueModel','renameCatalogueModel','deleteCatalogueModel','importCatalogue','saveCatalogueMap') then
    if not can_edit then raise exception 'Hardware Catalogue edit permission required.'; end if;
  end if;

  if a='saveCatalogueRow' then
    sys := wlf_private.hw_clean(p->>'system',60,'Control system'); mdl := wlf_private.hw_clean(p->>'model',80,'Model');
    if sys='' or mdl='' then raise exception 'Select the control system and model.'; end if;
    if coalesce(p->>'value','')<>'' and (p->>'value') !~ '^[0-9]{1,12}([.][0-9]{1,2})?$' then raise exception 'Value must be a number.'; end if;
    if nullif(p->>'id','') is not null then
      select * into r from wlf_private.hw_catalogue where id=(p->>'id')::uuid and deleted_at is null for update;
      if not found then raise exception 'This row was deleted. Refresh the catalogue.'; end if;
      if r.revision is distinct from (p->>'revision')::integer then raise exception 'CONFLICT: This row was changed by someone else. Refresh and try again.'; end if;
      update wlf_private.hw_catalogue set system=sys,model=mdl,grp=wlf_private.hw_clean(p->>'grp',80,'Group'),
        hardware=wlf_private.hw_clean(p->>'hardware',160,'Hardware'),spec=wlf_private.hw_clean(p->>'spec',240,'Spec'),
        item_code=wlf_private.hw_clean(p->>'itemCode',60,'Item code'),item_name=wlf_private.hw_clean(p->>'itemName',240,'Item name'),
        brand=wlf_private.hw_clean(p->>'brand',80,'Brand'),supplier=wlf_private.hw_clean(p->>'supplier',80,'Supplier'),
        value=nullif(p->>'value','')::numeric,revision=revision+1,updated_at=now(),updated_by=u.id
        where id=r.id returning * into r;
    else
      insert into wlf_private.hw_catalogue(system,model,grp,hardware,spec,item_code,item_name,brand,supplier,value,sort,updated_by)
      values(sys,mdl,wlf_private.hw_clean(p->>'grp',80,'Group'),wlf_private.hw_clean(p->>'hardware',160,'Hardware'),
        wlf_private.hw_clean(p->>'spec',240,'Spec'),wlf_private.hw_clean(p->>'itemCode',60,'Item code'),
        wlf_private.hw_clean(p->>'itemName',240,'Item name'),wlf_private.hw_clean(p->>'brand',80,'Brand'),
        wlf_private.hw_clean(p->>'supplier',80,'Supplier'),nullif(p->>'value','')::numeric,
        coalesce((select max(sort) from wlf_private.hw_catalogue where system=sys and model=mdl and deleted_at is null),0)+1,u.id)
      returning * into r;
    end if;
    return wlf_private.hw_row(r);
  end if;

  if a='deleteCatalogueRow' then
    update wlf_private.hw_catalogue set deleted_at=now(),updated_at=now(),updated_by=u.id,revision=revision+1
      where id=(p->>'id')::uuid and deleted_at is null;
    return jsonb_build_object('ok',true);
  end if;

  if a='newCatalogueModel' then
    sys := wlf_private.hw_clean(p->>'system',60,'Control system'); mdl := wlf_private.hw_clean(p->>'model',80,'Model');
    if sys='' or mdl='' then raise exception 'Enter the control system and the new model name.'; end if;
    if exists(select 1 from wlf_private.hw_catalogue where lower(system)=lower(sys) and lower(model)=lower(mdl) and deleted_at is null) then
      raise exception 'This model already exists in the catalogue.'; end if;
    if nullif(p->>'copyFrom','') is not null then
      insert into wlf_private.hw_catalogue(system,model,grp,hardware,spec,item_code,item_name,brand,supplier,value,sort,updated_by)
      select sys,mdl,grp,hardware,spec,item_code,item_name,brand,supplier,value,sort,u.id
        from wlf_private.hw_catalogue where system=sys and model=p->>'copyFrom' and deleted_at is null;
      get diagnostics n = row_count;
    else
      insert into wlf_private.hw_catalogue(system,model,grp,sort,updated_by)
        select sys,mdl,case when upper(sys)='AVR' then 'AVR' else '' end,g,u.id from generate_series(1,6) g;
      n := 6;
    end if;
    return jsonb_build_object('ok',true,'rows',n);
  end if;

  if a='renameCatalogueModel' then
    sys := wlf_private.hw_clean(p->>'system',60,'Control system'); mdl := wlf_private.hw_clean(p->>'to',80,'Model');
    if mdl='' then raise exception 'Enter the new model name.'; end if;
    if exists(select 1 from wlf_private.hw_catalogue where system=sys and model=mdl and deleted_at is null) then
      raise exception 'A model with this name already exists.'; end if;
    update wlf_private.hw_catalogue set model=mdl,updated_at=now(),updated_by=u.id,revision=revision+1
      where system=sys and model=p->>'from' and deleted_at is null;
    return jsonb_build_object('ok',true);
  end if;

  if a='deleteCatalogueModel' then
    update wlf_private.hw_catalogue set deleted_at=now(),updated_at=now(),updated_by=u.id,revision=revision+1
      where system=p->>'system' and model=p->>'model' and deleted_at is null;
    get diagnostics n = row_count;
    return jsonb_build_object('ok',true,'rows',n);
  end if;

  if a='importCatalogue' then
    if jsonb_typeof(p->'rows')<>'array' or jsonb_array_length(p->'rows')=0 then raise exception 'No rows to import.'; end if;
    if jsonb_array_length(p->'rows')>2000 then raise exception 'Import at most 2000 rows at a time.'; end if;
    n := 0;
    for it in select * from jsonb_array_elements(p->'rows') loop
      sys := wlf_private.hw_clean(it->>'system',60,'Control system'); mdl := wlf_private.hw_clean(it->>'model',80,'Model');
      if sys='' or mdl='' then continue; end if;
      insert into wlf_private.hw_catalogue(system,model,grp,hardware,spec,item_code,item_name,brand,supplier,value,sort,updated_by)
      values(sys,mdl,wlf_private.hw_clean(it->>'grp',80,'Group'),wlf_private.hw_clean(it->>'hardware',160,'Hardware'),
        wlf_private.hw_clean(it->>'spec',240,'Spec'),wlf_private.hw_clean(it->>'itemCode',60,'Item code'),
        wlf_private.hw_clean(it->>'itemName',240,'Item name'),wlf_private.hw_clean(it->>'brand',80,'Brand'),
        wlf_private.hw_clean(it->>'supplier',80,'Supplier'),
        case when coalesce(it->>'value','') ~ '^[0-9]{1,12}([.][0-9]{1,2})?$' then (it->>'value')::numeric end,
        coalesce((select max(sort) from wlf_private.hw_catalogue where system=sys and model=mdl and deleted_at is null),0)+1,u.id);
      n := n+1;
    end loop;
    return jsonb_build_object('ok',true,'imported',n);
  end if;

  if a='saveCatalogueMap' then
    if jsonb_typeof(p->'rows')<>'array' or jsonb_array_length(p->'rows')>200 then raise exception 'Invalid suggestion list.'; end if;
    delete from wlf_private.hw_suggest where true;
    for it in select * from jsonb_array_elements(p->'rows') loop
      if btrim(coalesce(it->>'keyword',''))='' then continue; end if;
      insert into wlf_private.hw_suggest(keyword,groups)
        values(lower(btrim(it->>'keyword')),coalesce((select array_agg(btrim(g)) from jsonb_array_elements_text(it->'groups') g where btrim(g)<>''),'{}'))
        on conflict (keyword) do update set groups=excluded.groups;
    end loop;
    return jsonb_build_object('ok',true);
  end if;

  -- ---- QMS lift records
  if a in ('getQmsLifts','getQmsLift','saveQmsLift','deleteQmsLift') then
    if not wlf_private.hw_has('qms:components') then raise exception 'QMS access required.'; end if;
  end if;

  if a='getQmsLifts' then
    term := lower(btrim(coalesce(p->>'liftId',''))); lid := lower(btrim(coalesce(p->>'project','')));
    code_term := lower(btrim(coalesce(p->>'itemCode','')));
    select coalesce(jsonb_agg(wlf_private.qms_lift_view(x,coalesce((p->>'full')::boolean,false)) order by x.updated_at desc),'[]') into rows
    from (select * from wlf_private.qms_lifts z where z.deleted_at is null
      and (term='' or lower(z.lift_id) like '%'||term||'%')
      and (lid='' or lower(z.project) like '%'||lid||'%')
      and (code_term='' or exists(select 1 from jsonb_array_elements(wlf_private.qms_parts_open(z.parts)) pp
           where lower(pp->>'code')=code_term or lower(pp->>'name') like '%'||code_term||'%'))
      order by z.updated_at desc limit case when coalesce((p->>'full')::boolean,false) then 300 else 60 end) x;
    return jsonb_build_object('rows',rows);
  end if;

  if a='getQmsLift' then
    select * into q from wlf_private.qms_lifts where id=(p->>'id')::uuid and deleted_at is null;
    if not found then raise exception 'This lift record was not found.'; end if;
    return wlf_private.qms_lift_view(q,true);
  end if;

  if a='deleteQmsLift' then
    if not wlf_private.hw_has('qms:delete') then raise exception 'QMS delete permission required.'; end if;
    update wlf_private.qms_lifts set deleted_at=now(),deleted_by=u.id,revision=revision+1,
      history=history||jsonb_build_array(jsonb_build_object('at',now(),'by',who,'action','deleted'))
      where id=(p->>'id')::uuid and deleted_at is null;
    return jsonb_build_object('ok',true);
  end if;

  if a='saveQmsLift' then
    lid := wlf_private.hw_clean(p->>'liftId',80,'Lift ID');
    if lid='' then raise exception 'Enter the Lift ID.'; end if;
    if wlf_private.hw_clean(p->>'project',180,'Project name')='' then raise exception 'Enter the project name.'; end if;
    if coalesce(p->>'deliveryDate','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception 'Select the delivery date.'; end if;
    sys := wlf_private.hw_clean(p->>'system',60,'Control system'); mdl := wlf_private.hw_clean(p->>'controllerModel',80,'Controller model');
    if sys='' or mdl='' then raise exception 'Select the control system and the controller model.'; end if;
    if jsonb_typeof(coalesce(p->'items','[]'))<>'array' or jsonb_array_length(coalesce(p->'items','[]'))>300 then raise exception 'Too many components selected.'; end if;
    if octet_length(coalesce(p->'selection','{}')::text)>60000 then raise exception 'Motor selection data is too large.'; end if;
    if jsonb_typeof(coalesce(p->'serials','{}'))<>'object' then raise exception 'Invalid serial numbers.'; end if;
    for it in select * from jsonb_array_elements(coalesce(p->'items','[]')) loop
      if not (it->>'section' = any(sections)) then raise exception 'Invalid component section.'; end if;
      select * into c from wlf_private.hw_catalogue where id=(it->>'catalogueId')::uuid;
      if not found then raise exception 'A selected component is no longer in the catalogue. Reload the form.'; end if;
      -- v2.6.1: the catalogue row as it is right now is stored once (shared by every lift that uses the same data)
      snap := snap||jsonb_build_array(jsonb_build_object('section',it->>'section','serial',left(btrim(coalesce(it->>'serial','')),80),
        'h',wlf_private.hw_snap_put(jsonb_build_object('system',c.system,'model',c.model,'grp',c.grp,
        'hardware',c.hardware,'spec',c.spec,'code',c.item_code,'name',c.item_name,'brand',c.brand,'supplier',c.supplier,
        'value',c.value,'catalogueId',c.id))));
    end loop;
    selc := case when p->'selection' is null or jsonb_typeof(p->'selection')='null' then null
                 else jsonb_build_object('h',wlf_private.hw_snap_put(p->'selection')) end;

    select * into q from wlf_private.qms_lifts where id=(p->>'id')::uuid for update;
    if not found then
      if not wlf_private.hw_has('qms:components') then raise exception 'QMS access required.'; end if;
      if exists(select 1 from wlf_private.qms_lifts where lower(btrim(lift_id))=lower(lid) and deleted_at is null) then
        raise exception 'This Lift ID already exists. Search it in QMS Data and edit that record.'; end if;
      insert into wlf_private.qms_lifts(id,lift_id,project,address,delivery_date,motor_type,lift_type,system,controller_model,
        serials,selection,parts,created_by,created_name,updated_by,updated_name,history)
      values((p->>'id')::uuid,lid,wlf_private.hw_clean(p->>'project',180,'Project name'),wlf_private.hw_clean(p->>'address',240,'Address'),
        (p->>'deliveryDate')::date,wlf_private.hw_clean(p->>'motorType',40,'Motor type'),wlf_private.hw_clean(p->>'liftType',40,'Lift type'),
        sys,mdl,coalesce(p->'serials','{}'),selc,snap,u.id,who,u.id,who,
        jsonb_build_array(jsonb_build_object('at',now(),'by',who,'action','created')))
      returning * into q;
    else
      if q.deleted_at is not null then raise exception 'This lift record was deleted.'; end if;
      if not wlf_private.hw_has('qms:edit') then raise exception 'QMS edit permission required.'; end if;
      if q.revision is distinct from (p->>'revision')::integer then raise exception 'CONFLICT: This lift record was changed by someone else. Refresh and review.'; end if;
      if exists(select 1 from wlf_private.qms_lifts where lower(btrim(lift_id))=lower(lid) and deleted_at is null and id<>q.id) then
        raise exception 'This Lift ID already exists. Search it in QMS Data and edit that record.'; end if;
      if q.lift_id is distinct from lid then changes := array_append(changes,'Lift ID'); end if;
      if q.project is distinct from btrim(p->>'project') then changes := array_append(changes,'Project'); end if;
      if q.delivery_date is distinct from (p->>'deliveryDate')::date then changes := array_append(changes,'Delivery date'); end if;
      if q.controller_model is distinct from mdl then changes := array_append(changes,'Controller model'); end if;
      if q.serials is distinct from coalesce(p->'serials','{}') then changes := array_append(changes,'Serial numbers'); end if;
      if q.selection is distinct from selc then changes := array_append(changes,'Motor selection'); end if;
      if q.parts is distinct from snap then changes := array_append(changes,'Components'); end if;
      update wlf_private.qms_lifts set lift_id=lid,project=wlf_private.hw_clean(p->>'project',180,'Project name'),
        address=wlf_private.hw_clean(p->>'address',240,'Address'),delivery_date=(p->>'deliveryDate')::date,
        motor_type=wlf_private.hw_clean(p->>'motorType',40,'Motor type'),lift_type=wlf_private.hw_clean(p->>'liftType',40,'Lift type'),
        system=sys,controller_model=mdl,serials=coalesce(p->'serials','{}'),selection=selc,parts=snap,
        updated_by=u.id,updated_name=who,updated_at=now(),revision=revision+1,
        history=history||jsonb_build_array(jsonb_build_object('at',now(),'by',who,'action','edited','changed',to_jsonb(changes)))
        where id=q.id returning * into q;
    end if;
    return wlf_private.qms_lift_view(q,true);
  end if;

  raise exception 'Unknown action.';
end
$$;


-- ---------------------------------------------------------------- RPC wrapper
do $mig$ begin
  if to_regprocedure('wlf_private.rpc_before_v261(text,jsonb)') is null then
    alter function wlf_private.rpc(text,jsonb) rename to rpc_before_v261;
  end if;
end $mig$;

create or replace function wlf_private.rpc(a text, args jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  p jsonb := coalesce(args->0,'{}');
  result jsonb;
  me public.wlf_profiles;
  kind text;
  lim integer;
  off integer;
  total integer;
  rows_in jsonb;
  r jsonb;
  added integer := 0;
  skipped integer := 0;
  changed integer := 0;
  n integer;
  rec wlf_private.qms_lifts;
  t record;
  cnt bigint;
  usage jsonb := '[]';
begin
  if a in ('adminDataUsage','adminExportData','adminImportData') then
    select * into me from public.wlf_profiles where id=auth.uid();
    if not found or me.status<>'Approved' or me.role<>'Super Admin' then raise exception 'Permission denied'; end if;
    kind := coalesce(p->>'kind','');

    if a='adminDataUsage' then
      for t in select n.nspname sch, c.relname rel, pg_total_relation_size(c.oid) bytes
               from pg_class c join pg_namespace n on n.oid=c.relnamespace
               where n.nspname in ('public','wlf_private') and c.relkind='r' order by 3 desc loop
        execute format('select count(*) from %I.%I',t.sch,t.rel) into cnt;
        usage := usage||jsonb_build_array(jsonb_build_object('table',t.sch||'.'||t.rel,'rows',cnt,'bytes',t.bytes));
      end loop;
      return jsonb_build_object('tables',usage,'at',now());
    end if;

    if a='adminExportData' then
      if kind='catalogue' then
        return jsonb_build_object('app','WLF','kind','catalogue','version','2.6.1','exportedAt',now(),
          'rows',(select coalesce(jsonb_agg(to_jsonb(x) order by x.system,x.model,x.sort,x.created_at),'[]') from wlf_private.hw_catalogue x),
          'suggest',(select coalesce(jsonb_agg(to_jsonb(s) order by s.keyword),'[]') from wlf_private.hw_suggest s));
      elsif kind='qms' then
        lim := least(greatest(coalesce((p->>'limit')::integer,100),1),200); off := greatest(coalesce((p->>'offset')::integer,0),0);
        select count(*) into total from wlf_private.qms_lifts;
        return jsonb_build_object('app','WLF','kind','qms','version','2.6.1','exportedAt',now(),'total',total,'offset',off,
          'rows',(select coalesce(jsonb_agg(q.z order by q.ord),'[]') from (
             select to_jsonb(x) || jsonb_build_object('parts',wlf_private.qms_parts_open(x.parts),'selection',wlf_private.qms_sel_open(x.selection)) as z,
                    row_number() over (order by x.created_at,x.id) as ord
             from (select * from wlf_private.qms_lifts order by created_at,id offset off limit lim) x) q));
      end if;
      raise exception 'Unknown backup kind.';
    end if;

    if a='adminImportData' then
      if octet_length(args::text)>4000000 then raise exception 'The backup part is too large.'; end if;
      rows_in := p->'rows';
      if jsonb_typeof(rows_in)<>'array' then raise exception 'The file has no rows.'; end if;
      if kind='catalogue' then
        if jsonb_array_length(rows_in)>6000 then raise exception 'Too many catalogue rows.'; end if;
        for r in select value from jsonb_array_elements(rows_in) loop
          if coalesce(r->>'id','')='' or coalesce(r->>'system','')='' or coalesce(r->>'model','')='' then raise exception 'The file is not a Hardware Catalogue backup.'; end if;
          if exists(select 1 from wlf_private.hw_catalogue where id=(r->>'id')::uuid) then changed := changed+1; else added := added+1; end if;
        end loop;
        insert into wlf_private.hw_catalogue(id,system,model,grp,hardware,spec,item_code,item_name,brand,supplier,value,sort,revision,created_at,updated_at,updated_by,deleted_at)
          select x.id,x.system,x.model,coalesce(x.grp,''),coalesce(x.hardware,''),coalesce(x.spec,''),coalesce(x.item_code,''),coalesce(x.item_name,''),
                 coalesce(x.brand,''),coalesce(x.supplier,''),x.value,coalesce(x.sort,0),coalesce(x.revision,1),coalesce(x.created_at,now()),coalesce(x.updated_at,now()),x.updated_by,x.deleted_at
          from jsonb_populate_recordset(null::wlf_private.hw_catalogue, rows_in) x
          on conflict (id) do update set system=excluded.system,model=excluded.model,grp=excluded.grp,hardware=excluded.hardware,spec=excluded.spec,
            item_code=excluded.item_code,item_name=excluded.item_name,brand=excluded.brand,supplier=excluded.supplier,value=excluded.value,sort=excluded.sort,
            revision=greatest(wlf_private.hw_catalogue.revision,excluded.revision)+1,updated_at=now(),deleted_at=excluded.deleted_at;
        if jsonb_typeof(p->'suggest')='array' then
          insert into wlf_private.hw_suggest(keyword,groups)
            select x.keyword,coalesce(x.groups,'{}') from jsonb_populate_recordset(null::wlf_private.hw_suggest, p->'suggest') x
            on conflict (keyword) do update set groups=excluded.groups;
        end if;
        return jsonb_build_object('added',added,'updated',changed);
      elsif kind='qms' then
        if jsonb_array_length(rows_in)>200 then raise exception 'Too many lifts in one part.'; end if;
        for r in select value from jsonb_array_elements(rows_in) loop
          if coalesce(r->>'id','')='' or coalesce(r->>'lift_id','')='' then raise exception 'The file is not a QMS backup.'; end if;
          rec := jsonb_populate_record(null::wlf_private.qms_lifts, r);
          rec.parts := wlf_private.qms_parts_pack(rec.parts); rec.selection := wlf_private.qms_sel_pack(rec.selection);
          insert into wlf_private.qms_lifts select (rec).* on conflict do nothing;
          get diagnostics n = row_count;
          if n=1 then added := added+1; else skipped := skipped+1; end if;
        end loop;
        return jsonb_build_object('added',added,'skipped',skipped);
      end if;
      raise exception 'Unknown backup kind.';
    end if;
  end if;
  result := wlf_private.rpc_before_v261(a,args);
  if a in ('getSession','getAppContext') and jsonb_typeof(result)='object' then
    result := result || jsonb_build_object('build','2.6.1');
  end if;
  return result;
end
$$;

revoke all on function wlf_private.rpc_before_v261(text,jsonb) from public, anon, authenticated;
revoke all on function wlf_private.rpc(text,jsonb) from public, anon;
grant execute on function wlf_private.rpc(text,jsonb) to authenticated;

commit;

select
  (select count(*) from wlf_private.qms_lifts) as qms_lifts,
  (select count(*) from wlf_private.qms_lifts q, jsonb_array_elements(q.parts) e where not (e ? 'h')) as unconverted_parts,
  (select count(*) from wlf_private.hw_snap) as shared_rows,
  to_regprocedure('wlf_private.rpc_before_v261(text,jsonb)') is not null as v261_ready;
