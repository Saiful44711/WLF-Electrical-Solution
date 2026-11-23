-- WLF v2.6.5 · QMS Paid feature information (input chips, output table 7, special note)
-- Requires UPDATE_V264.sql (v2.6.4). Safe to run again. Back up first.
begin;

do $c$ begin
  if to_regprocedure('wlf_private.rpc_before_v264(text,jsonb)') is null and to_regprocedure('wlf_private.rpc_before_v265(text,jsonb)') is null then
    raise exception 'Run UPDATE_V264.sql first (v2.6.4 is not installed).';
  end if;
end $c$;

-- ---------------------------------------------------------------- 1. optional special note on a lift record
alter table wlf_private.qms_lifts add column if not exists paid_note text not null default '';

-- ---------------------------------------------------------------- 2. Paid feature rows (from QMS_Paid_feature_information_input_output.xlsx)
-- One model called 'Paid feature' under each control system. Group = the chip name. Seeded only when the system has no Paid feature rows yet.
do $seed$ begin
  if not exists(select 1 from wlf_private.hw_catalogue where system='MOT' and model='Paid feature') then
    insert into wlf_private.hw_catalogue(system,model,grp,hardware,spec,item_code,item_name,brand,supplier,value,sort) values
  ('MOT','Paid feature','Voice Announcer','Voice Announcer','','270428','G&Z-PLUS LIFT ANNOUNCER','ARKEL','ARKEL',4610.48,1),
  ('MOT','Paid feature','Access Controller Card+Finger','Access Controller Card+Finger','','271338','Access Controller with card+Finger WAC22','Walton','Walton',9953.34,2),
  ('MOT','Paid feature','Access Controller Card+Finger+Password','Access Controller Card+Finger+Password','','271339','Access Controller with card +finger+password WAC33','Walton','Walton',11475,3),
  ('MOT','Paid feature','Access Controller AI Face','Access Controller AI Face','','473059','AI access controller- WAC44E','Walton','Walton',38475,4),
  ('MOT','Paid feature','RFID Card','RFID Card','','271340','RFID Card','Walton','Walton',19.61,5),
  ('MOT','Paid feature','Cloud Monitoring','Cloud Monitoring','','190727','Arkel Arlift','','',10080.53,6),
  ('MOT','Paid feature','Remote Alarm','Remote Alarm','','190728','Arline-M Center Module','ARKEL','ARKEL',8990.43,7),
  ('MOT','Paid feature','Remote Alarm','Remote Alarm','','190730','Arline-S Cop Speaking Unit','ARKEL','ARKEL',998.15,8),
  ('MOT','Paid feature','Remote Alarm','Remote Alarm','','190729','Arline-S General Speaking Un','ARKEL','ARKEL',1998.42,9),
  ('MOT','Paid feature','Remote Alarm','Remote Alarm','','190731','Arline-S-Int Speaking Uni','ARKEL','ARKEL',1499.13,10),
  ('MOT','Paid feature','BMS','BMS','','','','','',null,11),
  ('MOT','Paid feature','Regenerative drive','Regenerative drive','','321528','Regenerative Device RGN-B06 (Arkel)','ARKEL','ARKEL',93072.84,12);
  end if;
  if not exists(select 1 from wlf_private.hw_catalogue where system='NICE3000+' and model='Paid feature') then
    insert into wlf_private.hw_catalogue(system,model,grp,hardware,spec,item_code,item_name,brand,supplier,value,sort) values
  ('NICE3000+','Paid feature','Voice Announcer','Voice Announcer','','','','MONARCH','MONARCH',null,1),
  ('NICE3000+','Paid feature','Access Controller Card+Finger','Access Controller Card+Finger','','271338','Access Controller with card+Finger WAC22','Walton','Walton',9953.34,2),
  ('NICE3000+','Paid feature','Access Controller Card+Finger+Password','Access Controller Card+Finger+Password','','271339','Access Controller with card +finger+password WAC33','Walton','Walton',11475,3),
  ('NICE3000+','Paid feature','Access Controller AI Face','Access Controller AI Face','','473059','AI access controller- WAC44E','Walton','Walton',38475,4),
  ('NICE3000+','Paid feature','RFID Card','RFID Card','','271340','RFID Card','Walton','Walton',19.61,5),
  ('NICE3000+','Paid feature','Cloud Monitoring','Cloud Monitoring','','','','MONARCH','MONARCH',null,6),
  ('NICE3000+','Paid feature','Remote Alarm','Remote Alarm','','','','MONARCH','MONARCH',null,7),
  ('NICE3000+','Paid feature','Remote Alarm','Remote Alarm','','','','MONARCH','MONARCH',null,8),
  ('NICE3000+','Paid feature','Remote Alarm','Remote Alarm','','','','MONARCH','MONARCH',null,9),
  ('NICE3000+','Paid feature','Remote Alarm','Remote Alarm','','','','MONARCH','MONARCH',null,10),
  ('NICE3000+','Paid feature','BMS','BMS','','','','','',null,11),
  ('NICE3000+','Paid feature','Regenerative drive','Regenerative drive 5 kW','5 kW','','','MONARCH','MONARCH',null,12),
  ('NICE3000+','Paid feature','Regenerative drive','Regenerative drive 7 kW','7 kW','','','MONARCH','MONARCH',null,13),
  ('NICE3000+','Paid feature','Regenerative drive','Regenerative drive 11 kW','11 kW','','','MONARCH','MONARCH',null,14),
  ('NICE3000+','Paid feature','Regenerative drive','Regenerative drive 15 kW','15 kW','494757','Regenerative Device - MCTC-AFE-4015N','MONARCH','MONARCH',117926.68,15),
  ('NICE3000+','Paid feature','Regenerative drive','Regenerative drive 18 kW','18 kW','','','MONARCH','MONARCH',null,16),
  ('NICE3000+','Paid feature','Regenerative drive','Regenerative drive 22 kW','22 kW','','','MONARCH','MONARCH',null,17),
  ('NICE3000+','Paid feature','Regenerative drive','Regenerative drive 30 kW','30 kW','','','MONARCH','MONARCH',null,18);
  end if;
end $seed$;

-- ---------------------------------------------------------------- 3. QMS reader and writer (section 'paid' and the note)
create or replace function wlf_private.qms_lift_view(r wlf_private.qms_lifts, detailed boolean) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare base jsonb;
begin
  base := jsonb_build_object('id',r.id,'liftId',r.lift_id,'project',r.project,'deliveryDate',r.delivery_date,
    'system',r.system,'controllerModel',r.controller_model,'updatedAt',r.updated_at,'updatedName',r.updated_name,
    'createdName',r.created_name,'revision',r.revision,'paidNote',r.paid_note);
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
  sections text[] := array['control','lop','cop','faceplate','transom','cable','other','avr','paid'];
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
        serials,selection,parts,paid_note,created_by,created_name,updated_by,updated_name,history)
      values((p->>'id')::uuid,lid,wlf_private.hw_clean(p->>'project',180,'Project name'),wlf_private.hw_clean(p->>'address',240,'Address'),
        (p->>'deliveryDate')::date,wlf_private.hw_clean(p->>'motorType',40,'Motor type'),wlf_private.hw_clean(p->>'liftType',40,'Lift type'),
        sys,mdl,coalesce(p->'serials','{}'),selc,snap,wlf_private.hw_clean(p->>'paidNote',500,'Special note'),u.id,who,u.id,who,
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
      if q.paid_note is distinct from wlf_private.hw_clean(p->>'paidNote',500,'Special note') then changes := array_append(changes,'Paid feature note'); end if;
      update wlf_private.qms_lifts set lift_id=lid,project=wlf_private.hw_clean(p->>'project',180,'Project name'),
        address=wlf_private.hw_clean(p->>'address',240,'Address'),delivery_date=(p->>'deliveryDate')::date,
        motor_type=wlf_private.hw_clean(p->>'motorType',40,'Motor type'),lift_type=wlf_private.hw_clean(p->>'liftType',40,'Lift type'),
        system=sys,controller_model=mdl,serials=coalesce(p->'serials','{}'),selection=selc,parts=snap,paid_note=wlf_private.hw_clean(p->>'paidNote',500,'Special note'),
        updated_by=u.id,updated_name=who,updated_at=now(),revision=revision+1,
        history=history||jsonb_build_array(jsonb_build_object('at',now(),'by',who,'action','edited','changed',to_jsonb(changes)))
        where id=q.id returning * into q;
    end if;
    return wlf_private.qms_lift_view(q,true);
  end if;

  raise exception 'Unknown action.';
end
$$;



-- ---------------------------------------------------------------- 4. API wrapper
do $r$ begin
  if to_regprocedure('wlf_private.rpc_before_v265(text,jsonb)') is null then
    alter function wlf_private.rpc(text,jsonb) rename to rpc_before_v265;
  end if;
end $r$;

create or replace function wlf_private.rpc(a text, args jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  result := wlf_private.rpc_before_v265(a,args);
  if a in ('getSession','getAppContext') and jsonb_typeof(result)='object' then
    result := result || jsonb_build_object('build','2.6.5');
  end if;
  return result;
end
$$;
revoke all on function wlf_private.rpc_before_v265(text,jsonb) from public, anon, authenticated;
revoke all on function wlf_private.rpc(text,jsonb) from public, anon;
grant execute on function wlf_private.rpc(text,jsonb) to authenticated;

notify pgrst, 'reload schema';
commit;

select
  (select count(*) from wlf_private.hw_catalogue where model='Paid feature' and system='MOT' and deleted_at is null) as mot_paid_rows,
  (select count(*) from wlf_private.hw_catalogue where model='Paid feature' and system='NICE3000+' and deleted_at is null) as nice_paid_rows,
  exists(select 1 from information_schema.columns where table_schema='wlf_private' and table_name='qms_lifts' and column_name='paid_note') as paid_note_ready,
  to_regprocedure('wlf_private.rpc_before_v265(text,jsonb)') is not null as v265_ready;
