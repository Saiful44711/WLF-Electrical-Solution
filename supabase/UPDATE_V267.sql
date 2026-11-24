-- WLF v2.6.7 · AVR model in the control system section with its own input/output table, AVR and Battery serial numbers, required Address / Motor type / Lift type,
-- Serial numbers table permission, QMS Data Excel in the backup format with a Recorded from / to filter, AVR Hardware Catalogue data
-- Requires UPDATE_V266.sql (v2.6.6). Safe to run again. Back up first.
begin;

do $c$ begin
  if to_regprocedure('wlf_private.rpc_before_v266(text,jsonb)') is null and to_regprocedure('wlf_private.rpc_before_v267(text,jsonb)') is null then
    raise exception 'Run UPDATE_V266.sql first (v2.6.6 is not installed).';
  end if;
end $c$;

-- ---------------------------------------------------------------- 1. permission: who may see and download the Serial numbers table
do $c$ begin
  if to_regprocedure('wlf_private.catalog_before_v267()') is null then
    alter function wlf_private.catalog() rename to catalog_before_v267;
  end if;
end $c$;
create or replace function wlf_private.catalog() returns jsonb
language sql stable security definer set search_path='' as $$
  select wlf_private.catalog_before_v267() || jsonb_build_array(
    jsonb_build_object('key','qms:serials','label','QMS / See and download the Serial numbers table','group','QMS'))
$$;
revoke all on function wlf_private.catalog_before_v267() from public, anon, authenticated;

-- ---------------------------------------------------------------- 2. lift view: Serial numbers are sent only to users with the permission
create or replace function wlf_private.qms_lift_view(r wlf_private.qms_lifts, detailed boolean) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare base jsonb;
begin
  base := jsonb_build_object('id',r.id,'liftId',r.lift_id,'project',r.project,'deliveryDate',r.delivery_date,
    'system',r.system,'controllerModel',r.controller_model,'updatedAt',r.updated_at,'updatedName',r.updated_name,
    'createdName',r.created_name,'revision',r.revision,'specialNote',r.paid_note);
  if detailed then
    base := base || jsonb_build_object('address',r.address,'motorType',r.motor_type,'liftType',r.lift_type,
      'serials',case when wlf_private.hw_has('qms:serials') then r.serials else '{}'::jsonb end,'serialsHidden',not wlf_private.hw_has('qms:serials'),'selection',wlf_private.qms_sel_open(r.selection),'parts',wlf_private.qms_parts_open(r.parts),'history',r.history,'createdAt',r.created_at,
      'canEdit',wlf_private.hw_has('qms:edit'),'canDelete',wlf_private.hw_has('qms:delete'));
  end if;
  return base;
end
$$;

-- ---------------------------------------------------------------- 3. lift API (QMS)
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
  sections text[] := array['control','lop','cop','faceplate','transom','cable','other','avr','paid'];
  d_from date; d_to date; skip integer; sers jsonb; sk text; sv jsonb;
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
    if coalesce(p->>'from','')<>'' then
      if (p->>'from') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception 'Enter a valid From date.'; end if;
      d_from := (p->>'from')::date;
    end if;
    if coalesce(p->>'to','')<>'' then
      if (p->>'to') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception 'Enter a valid To date.'; end if;
      d_to := (p->>'to')::date;
    end if;
    if d_from is not null and d_to is not null and d_from>d_to then raise exception 'From date must not be after To date.'; end if;
    skip := greatest(0,coalesce(nullif(p->>'offset','')::integer,0));
    -- paged download (full): oldest first, 50 lifts per page; the screen asks for the next page until 'more' is false
    if coalesce((p->>'full')::boolean,false) then
      select coalesce(jsonb_agg(wlf_private.qms_lift_view(y,true) order by y.created_at,y.id),'[]') into rows
      from (select z.* from wlf_private.qms_lifts z where z.deleted_at is null
        and (term='' or lower(z.lift_id) like '%'||term||'%')
        and (lid='' or lower(z.project) like '%'||lid||'%')
        and (d_from is null or (z.created_at at time zone 'Asia/Dhaka')::date>=d_from)
        and (d_to is null or (z.created_at at time zone 'Asia/Dhaka')::date<=d_to)
        and (code_term='' or exists(select 1 from jsonb_array_elements(wlf_private.qms_parts_open(z.parts)) pp
             where lower(pp->>'code')=code_term or lower(pp->>'name') like '%'||code_term||'%'))
        order by z.created_at,z.id offset skip limit 50) y;
      return jsonb_build_object('rows',rows,'more',jsonb_array_length(rows)=50,'next',skip+jsonb_array_length(rows));
    end if;
    select coalesce(jsonb_agg(wlf_private.qms_lift_view(x,false) order by x.updated_at desc),'[]') into rows
    from (select * from wlf_private.qms_lifts z where z.deleted_at is null
      and (term='' or lower(z.lift_id) like '%'||term||'%')
      and (lid='' or lower(z.project) like '%'||lid||'%')
      and (d_from is null or (z.created_at at time zone 'Asia/Dhaka')::date>=d_from)
      and (d_to is null or (z.created_at at time zone 'Asia/Dhaka')::date<=d_to)
      and (code_term='' or exists(select 1 from jsonb_array_elements(wlf_private.qms_parts_open(z.parts)) pp
           where lower(pp->>'code')=code_term or lower(pp->>'name') like '%'||code_term||'%'))
      order by z.updated_at desc limit 60) x;
    return jsonb_build_object('rows',rows,'more',false);
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
    if wlf_private.hw_clean(p->>'address',240,'Address')='' then raise exception 'Enter the address.'; end if;
    if wlf_private.hw_clean(p->>'motorType',40,'Motor type')='' then raise exception 'Select the motor type.'; end if;
    if wlf_private.hw_clean(p->>'liftType',40,'Lift type')='' then raise exception 'Select the lift type.'; end if;
    if coalesce(p->>'deliveryDate','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception 'Select the delivery date.'; end if;
    sys := wlf_private.hw_clean(p->>'system',60,'Control system'); mdl := wlf_private.hw_clean(p->>'controllerModel',80,'Controller model');
    if sys='' or mdl='' then raise exception 'Select the control system and the controller model.'; end if;
    if jsonb_typeof(coalesce(p->'items','[]'))<>'array' or jsonb_array_length(coalesce(p->'items','[]'))>300 then raise exception 'Too many components selected.'; end if;
    if octet_length(coalesce(p->'selection','{}')::text)>60000 then raise exception 'Motor selection data is too large.'; end if;
    if jsonb_typeof(coalesce(p->'serials','{}'))<>'object' then raise exception 'Invalid serial numbers.'; end if;
    for sk,sv in select * from jsonb_each(coalesce(p->'serials','{}')) loop
      if jsonb_typeof(sv)<>'string' or length(sv#>>'{}')>200 then raise exception 'Each serial number can have at most 200 characters.'; end if;
    end loop;
    sers := coalesce(p->'serials','{}');
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
        serials,selection,parts,paid_note,created_by,created_name,updated_by,updated_name,history)
      values((p->>'id')::uuid,lid,wlf_private.hw_clean(p->>'project',180,'Project name'),wlf_private.hw_clean(p->>'address',240,'Address'),
        (p->>'deliveryDate')::date,wlf_private.hw_clean(p->>'motorType',40,'Motor type'),wlf_private.hw_clean(p->>'liftType',40,'Lift type'),
        sys,mdl,sers,selc,snap,wlf_private.hw_clean(coalesce(p->>'specialNote',p->>'paidNote'),500,'Special note'),u.id,who,u.id,who,
        jsonb_build_array(jsonb_build_object('at',now(),'by',who,'action','created')))
      returning * into q;
    else
      if q.deleted_at is not null then raise exception 'This lift record was deleted.'; end if;
      if not wlf_private.hw_has('qms:serials') then
        sers := coalesce(q.serials,'{}')||coalesce((select jsonb_object_agg(k,v) from jsonb_each(coalesce(p->'serials','{}')) e(k,v) where btrim(v#>>'{}')<>''),'{}');
      end if;
      if not wlf_private.hw_has('qms:edit') then raise exception 'QMS edit permission required.'; end if;
      if q.revision is distinct from (p->>'revision')::integer then raise exception 'CONFLICT: This lift record was changed by someone else. Refresh and review.'; end if;
      if exists(select 1 from wlf_private.qms_lifts where lower(btrim(lift_id))=lower(lid) and deleted_at is null and id<>q.id) then
        raise exception 'This Lift ID already exists. Search it in QMS Data and edit that record.'; end if;
      if q.lift_id is distinct from lid then changes := array_append(changes,'Lift ID'); end if;
      if q.project is distinct from btrim(p->>'project') then changes := array_append(changes,'Project'); end if;
      if q.delivery_date is distinct from (p->>'deliveryDate')::date then changes := array_append(changes,'Delivery date'); end if;
      if q.controller_model is distinct from mdl then changes := array_append(changes,'Controller model'); end if;
      if q.serials is distinct from sers then changes := array_append(changes,'Serial numbers'); end if;
      if q.selection is distinct from selc then changes := array_append(changes,'Motor selection'); end if;
      if q.parts is distinct from snap then changes := array_append(changes,'Components'); end if;
      if q.paid_note is distinct from wlf_private.hw_clean(coalesce(p->>'specialNote',p->>'paidNote'),500,'Special note') then changes := array_append(changes,'Special note'); end if;
      update wlf_private.qms_lifts set lift_id=lid,project=wlf_private.hw_clean(p->>'project',180,'Project name'),
        address=wlf_private.hw_clean(p->>'address',240,'Address'),delivery_date=(p->>'deliveryDate')::date,
        motor_type=wlf_private.hw_clean(p->>'motorType',40,'Motor type'),lift_type=wlf_private.hw_clean(p->>'liftType',40,'Lift type'),
        system=sys,controller_model=mdl,serials=sers,selection=selc,parts=snap,paid_note=wlf_private.hw_clean(coalesce(p->>'specialNote',p->>'paidNote'),500,'Special note'),
        updated_by=u.id,updated_name=who,updated_at=now(),revision=revision+1,
        history=history||jsonb_build_array(jsonb_build_object('at',now(),'by',who,'action','edited','changed',to_jsonb(changes)))
        where id=q.id returning * into q;
    end if;
    return wlf_private.qms_lift_view(q,true);
  end if;

  raise exception 'Unknown action.';
end
$$;

-- ---------------------------------------------------------------- 4. AVR Hardware Catalogue from the "AVR Specification" sheet (6 models x 15 rows)
-- AVR models that are not in the sheet (for example 80 KVA) are left exactly as they are (blank). Running this again replaces the same models, so rows never double.
do $s$
declare ms text[] := array['AVR 15 KVA','AVR 20 KVA','AVR 30 KVA','AVR 40 KVA','AVR 60 KVA','AVR 100 KVA'];
begin
  update wlf_private.hw_catalogue set deleted_at=now(),updated_at=now(),revision=revision+1
    where system='AVR' and model=any(ms) and deleted_at is null;
  insert into wlf_private.hw_catalogue(system,model,grp,hardware,spec,item_code,brand,supplier,value,sort)
  select 'AVR',v.model,v.grp,v.hardware,v.spec,coalesce(v.code,''),coalesce(v.brand,''),coalesce(v.supplier,''),v.price,v.sort
  from (values
  ('AVR 15 KVA','AVR 15 KVA','Full AVR','Automatic Voltage Regulator (AVR) - 15 KVA','314445','SAKO','SAKO',35944.85,1),
  ('AVR 15 KVA','Circuit Breaker','Input Circuit Breaker (Bypass Circuit Breaker)','DZ47-63,D-25,6KA -1 Pcs','','','',null,2),
  ('AVR 15 KVA','Circuit Breaker','Steady Circuit Breaker','DZ47-63,D-25,6KA -1 Pcs','','','',null,3),
  ('AVR 15 KVA','Trip Coil','Trip Coil ( MX+ OFF )','AC/DC 24-48V -1 Pcs','','','',null,4),
  ('AVR 15 KVA','Relay','Power Relay','JOX-16F ( T91 )-1C ,(40/30A ,250VAC/28VDC),Coil Voltage 12V DC -3 Pcs','','','',null,5),
  ('AVR 15 KVA','Transformer','Buck Boost Transformer','BD-5KVA ( 175-265 Q ) -3 Pcs','','','',null,6),
  ('AVR 15 KVA','Transformer','Auto transformer','BD-5KVA ( 175-265 Q ) -3 Pcs','','','',null,7),
  ('AVR 15 KVA','SPD','Surge Protective Device ( SPD )','HJH2-40 ( UC~385V, Imax-40KA ) -1 Pcs','','','',null,8),
  ('AVR 15 KVA','Main PCB','Main PCB Board','TNS Integrated Board (S-V-V1.0.2) -1 Pcs','','','',null,9),
  ('AVR 15 KVA','Display Board','Display Board','(TM1680_HSN_12582_S_V1.0.1) -1 Pcs','','','',null,10),
  ('AVR 15 KVA','Capacitor Board','Capacitor Board','(TNS_HW_V1.0.1) -1 Pcs','','','',null,11),
  ('AVR 15 KVA','Power Supply Board','Power Supply Board','24v DC - 1 Pcs','','','',null,12),
  ('AVR 15 KVA','Power Supply Board','Power Supply Board','12v DC - 1 Pcs','','','',null,13),
  ('AVR 15 KVA','Cooling Fan','Cooling Fan','220-240V, 50-60HZ – 3 Pcs','','','',null,14),
  ('AVR 15 KVA','Connector','Connector','Connector Type - M4','','','',null,15),
  ('AVR 20 KVA','AVR 20 KVA','Full AVR','Automatic Voltage Regulator (AVR) - 20 KVA','221077','SAKO','SAKO',46378.74,1),
  ('AVR 20 KVA','Circuit Breaker','Input Circuit Breaker (Bypass Circuit Breaker)','D-32,6KA -1 Pcs','','','',null,2),
  ('AVR 20 KVA','Circuit Breaker','Steady Circuit Breaker','D-32,6KA -1 Pcs','','','',null,3),
  ('AVR 20 KVA','Trip Coil','Trip Coil ( MX+ OFF )','AC/DC 24-48V -1 Pcs','','','',null,4),
  ('AVR 20 KVA','Relay','Power Relay','JOQX-60F-DF05-1H ,Coil Voltage 12V DC -3 Pcs','','','',null,5),
  ('AVR 20 KVA','Transformer','Buck Boost Transformer','BD-7.5KVA ( 175-265 R ) -3 Pcs','','','',null,6),
  ('AVR 20 KVA','Transformer','Auto transformer','BD-7.5KVA ( 175-265 R ) -3 Pcs','','','',null,7),
  ('AVR 20 KVA','SPD','Surge Protective Device ( SPD )','HJH2-40 ( UC~385V, Imax-40KA ) -1 Pcs','','','',null,8),
  ('AVR 20 KVA','Main PCB','Main PCB Board','TNS Integrated Board (S-V-V1.0.3) -1 Pcs','','','',null,9),
  ('AVR 20 KVA','Display Board','Display Board','(TM1680_HSN_12582_S_V1.0.1) -1 Pcs','','','',null,10),
  ('AVR 20 KVA','Capacitor Board','Capacitor Board','(TNS_HW_V1.0.1) -1 Pcs','','','',null,11),
  ('AVR 20 KVA','Power Supply Board','Power Supply Board','24v DC - 1 Pcs','','','',null,12),
  ('AVR 20 KVA','Power Supply Board','Power Supply Board','12v DC - 1 Pcs','','','',null,13),
  ('AVR 20 KVA','Cooling Fan','Cooling Fan','220-240V, 50-60HZ – 3 Pcs','','','',null,14),
  ('AVR 20 KVA','Connector','Connector','Screw Type – M6 Bolt','','','',null,15),
  ('AVR 30 KVA','AVR 30 KVA','Full AVR','Automatic Voltage Regulator (AVR) - 30 KVA','231085','SAKO','SAKO',40000,1),
  ('AVR 30 KVA','Circuit Breaker','Input Circuit Breaker (Bypass Circuit Breaker)','D-50,6KA -1 Pcs','','','',null,2),
  ('AVR 30 KVA','Circuit Breaker','Steady Circuit Breaker','D-50,6KA -1 Pcs','','','',null,3),
  ('AVR 30 KVA','Trip Coil','Trip Coil ( MX+ OFF )','AC/DC 24-48V -1 Pcs','','','',null,4),
  ('AVR 30 KVA','Relay','Power Relay','JOX-70A ( DF06-B ) -3 Pcs','','','',null,5),
  ('AVR 30 KVA','Transformer','Buck Boost Transformer','BD-10KVA ( 175-265 Q ) -3 Pcs','','','',null,6),
  ('AVR 30 KVA','Transformer','Auto transformer','BD-10KVA ( 175-265 Q ) -3 Pcs','','','',null,7),
  ('AVR 30 KVA','SPD','Surge Protective Device ( SPD )','HJH2-40 ( UC~385V, Imax-40KA ) -1 Pcs','','','',null,8),
  ('AVR 30 KVA','Main PCB','Main PCB Board','TNS Integrated Board (S-V-V1.0.3) -1 Pcs','','','',null,9),
  ('AVR 30 KVA','Display Board','Display Board','(TM1680_HSN_12582_S_V1.0.1) -1 Pcs','','','',null,10),
  ('AVR 30 KVA','Capacitor Board','Capacitor Board','(TNS_HW_V1.0.1) -1 Pcs','','','',null,11),
  ('AVR 30 KVA','Power Supply Board','Power Supply Board','24v DC - 1 Pcs','','','',null,12),
  ('AVR 30 KVA','Power Supply Board','Power Supply Board','12v DC - 1 Pcs','','','',null,13),
  ('AVR 30 KVA','Cooling Fan','Cooling Fan','220-240V, 50-60HZ – 3 Pcs','','','',null,14),
  ('AVR 30 KVA','Connector','Connector','Screw Type - M6 Bolt','','','',null,15),
  ('AVR 40 KVA','AVR 40 KVA','Full AVR','Automatic Voltage Regulator (AVR) - 40 KVA','187765','SAKO','SAKO',100000,1),
  ('AVR 40 KVA','Circuit Breaker','Input Circuit Breaker (Bypass Circuit Breaker)','D-63,6KA -1 Pcs','','','',null,2),
  ('AVR 40 KVA','Circuit Breaker','Steady Circuit Breaker','D-63,6KA -1 Pcs','','','',null,3),
  ('AVR 40 KVA','Trip Coil','Trip Coil ( MX+ OFF )','AC/DC 24-48V -1 Pcs','','','',null,4),
  ('AVR 40 KVA','Relay','Power Relay','JOX-90A ( DF07-B ) -3 Pcs','','','',null,5),
  ('AVR 40 KVA','Transformer','Buck Boost Transformer','Not Found -3 Pcs','','','',null,6),
  ('AVR 40 KVA','Transformer','Auto transformer','Not Found -3 Pcs','','','',null,7),
  ('AVR 40 KVA','SPD','Surge Protective Device ( SPD )','HJH2-40 ( UC~385V, Imax-40KA ) -1 Pcs','','','',null,8),
  ('AVR 40 KVA','Main PCB','Main PCB Board','TNS Integrated Board (S-V-V1.0.3) -1 Pcs','','','',null,9),
  ('AVR 40 KVA','Display Board','Display Board','(TM1680_HSN_18011_S_V1.0.1) -1 Pcs','','','',null,10),
  ('AVR 40 KVA','Capacitor Board','Capacitor Board','(TNS_HW_V1.0.1) -1 Pcs','','','',null,11),
  ('AVR 40 KVA','Power Supply Board','Power Supply Board','24v DC - 1 Pcs','','','',null,12),
  ('AVR 40 KVA','Power Supply Board','Power Supply Board','12v DC - 1 Pcs','','','',null,13),
  ('AVR 40 KVA','Cooling Fan','Cooling Fan','220-240V, 50-60HZ – 3 Pcs','','','',null,14),
  ('AVR 40 KVA','Connector','Connector','Screw Type - M6 Bolt','','','',null,15),
  ('AVR 60 KVA','AVR 60 KVA','Full AVR','Automatic Voltage Regulator (AVR) - 60 KVA','309116','SAKO','SAKO',70000,1),
  ('AVR 60 KVA','Circuit Breaker','Input Circuit Breaker (Bypass Circuit Breaker)','D-100,10KA -1 Pcs','','','',null,2),
  ('AVR 60 KVA','Circuit Breaker','Steady Circuit Breaker','D-100,10KA -1 Pcs','','','',null,3),
  ('AVR 60 KVA','Trip Coil','Trip Coil ( MX+ OFF )','AC/DC 24-48V -1 Pcs','','','',null,4),
  ('AVR 60 KVA','Relay','Power Relay','JOX-100A ( DF10-B ),Coil Voltage 12V DC -3 Pcs','','','',null,5),
  ('AVR 60 KVA','Transformer','Buck Boost Transformer','BD-20KVA ( 175-265 R ) -3 Pcs','','','',null,6),
  ('AVR 60 KVA','Transformer','Auto transformer','BD-20KVA ( 175-265 R ) -3 Pcs','','','',null,7),
  ('AVR 60 KVA','SPD','Surge Protective Device ( SPD )','HJH2-40 ( UC~385V, Imax-40KA ) -1 Pcs','','','',null,8),
  ('AVR 60 KVA','Main PCB','Main PCB Board','TNS Integrated Board (S-V-V1.0.3) -1 Pcs','','','',null,9),
  ('AVR 60 KVA','Display Board','Display Board','(TM1680_HSN_180118_S_V1.0.1) -1 Pcs','','','',null,10),
  ('AVR 60 KVA','Capacitor Board','Capacitor Board','(TNS_HW_V1.0.1) -1 Pcs','','','',null,11),
  ('AVR 60 KVA','Power Supply Board','Power Supply Board','24v DC - 1 Pcs','','','',null,12),
  ('AVR 60 KVA','Power Supply Board','Power Supply Board','12v DC - 1 Pcs','','','',null,13),
  ('AVR 60 KVA','Cooling Fan','Cooling Fan','220-240V, 50-60HZ – 3 Pcs','','','',null,14),
  ('AVR 60 KVA','Connector','Connector','Screw Type - M6 Bolt','','','',null,15),
  ('AVR 100 KVA','AVR 100 KVA','Full AVR','Automatic Voltage Regulator (AVR) - 100 KVA','372973','SAKO','SAKO',170000,1),
  ('AVR 100 KVA','Circuit Breaker','Input Circuit Breaker (Bypass Circuit Breaker)','D-125,10KA -1 Pcs','','','',null,2),
  ('AVR 100 KVA','Circuit Breaker','Steady Circuit Breaker','D-125,10KA -1 Pcs','','','',null,3),
  ('AVR 100 KVA','Trip Coil','Trip Coil ( MX+ OFF )','AC/DC 24-48V -1 Pcs','','','',null,4),
  ('AVR 100 KVA','Relay','Power Relay','WJOX-150F-1H_150A ,Coil Voltage 12V DC -3 Pcs','','','',null,5),
  ('AVR 100 KVA','Transformer','Buck Boost Transformer','BD-30KVA ( 175-265 R ) -3 Pcs','','','',null,6),
  ('AVR 100 KVA','Transformer','Auto transformer','BD-30KVA ( 175-265 R ) -3 Pcs','','','',null,7),
  ('AVR 100 KVA','SPD','Surge Protective Device ( SPD )','HJH2-40 ( UC~385V, Imax-40KA ) -1 Pcs','','','',null,8),
  ('AVR 100 KVA','Main PCB','Main PCB Board','TNS Integrated Board (S-V-V1.0.3) -1 Pcs','','','',null,9),
  ('AVR 100 KVA','Display Board','Display Board','(TM1680_HSN_180118_S_V1.0.1) -1 Pcs','','','',null,10),
  ('AVR 100 KVA','Capacitor Board','Capacitor Board','(TNS_HW_V1.0.1) -1 Pcs','','','',null,11),
  ('AVR 100 KVA','Power Supply Board','Power Supply Board','24v DC - 1 Pcs','','','',null,12),
  ('AVR 100 KVA','Power Supply Board','Power Supply Board','12v DC - 1 Pcs','','','',null,13),
  ('AVR 100 KVA','Cooling Fan','Cooling Fan','220-240V, 50-60HZ – 3 Pcs','','','',null,14),
  ('AVR 100 KVA','Connector','Connector','Screw Type – M10 Bolt','','','',null,15)
  ) as v(model,grp,hardware,spec,code,brand,supplier,price,sort);
end $s$;

-- ---------------------------------------------------------------- 5. API wrapper
do $r$ begin
  if to_regprocedure('wlf_private.rpc_before_v267(text,jsonb)') is null then
    alter function wlf_private.rpc(text,jsonb) rename to rpc_before_v267;
  end if;
end $r$;

create or replace function wlf_private.rpc(a text, args jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb; kept jsonb;
begin
  -- a user who may not see Serial numbers edits a lift with the fields blank: the stored values are put back before the older "every serial number" check runs
  if a='saveQmsLift' and not wlf_private.hw_has('qms:serials') then
    select q.serials into kept from wlf_private.qms_lifts q where q.id=nullif(args->0->>'id','')::uuid and q.deleted_at is null;
    if kept is not null then
      args := jsonb_set(args,'{0,serials}',kept||coalesce((select jsonb_object_agg(k,v) from jsonb_each(coalesce(args->0->'serials','{}')) e(k,v) where jsonb_typeof(v)='string' and btrim(v#>>'{}')<>''),'{}'));
    end if;
  end if;
  result := wlf_private.rpc_before_v267(a,args);
  if a in ('getSession','getAppContext') and jsonb_typeof(result)='object' then
    result := result || jsonb_build_object('build','2.6.7');
  end if;
  return result;
end
$$;
revoke all on function wlf_private.rpc_before_v267(text,jsonb) from public, anon, authenticated;
revoke all on function wlf_private.rpc(text,jsonb) from public, anon;
grant execute on function wlf_private.rpc(text,jsonb) to authenticated;

notify pgrst, 'reload schema';
commit;

select
  exists(select 1 from jsonb_array_elements(wlf_private.catalog()) e where e->>'key'='qms:serials') as serials_permission_ready,
  (select count(*) from wlf_private.hw_catalogue where system='AVR' and model='AVR 15 KVA' and deleted_at is null) as avr_15_rows,
  (select count(distinct model) from wlf_private.hw_catalogue where system='AVR' and deleted_at is null and item_code<>'') as avr_models_with_data,
  to_regprocedure('wlf_private.rpc_before_v267(text,jsonb)') is not null as v267_ready;
