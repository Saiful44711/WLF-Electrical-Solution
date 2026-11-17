-- =====================================================================
-- WLF Electrical Solution v2.5.2
--  * Technical Support forms (Commissioning, After Sales, Production, QC,
--    Factory Maintenance): new Problem Category list (36) and a Problem
--    Sub-Category that opens for drive/door errors and AVR. Super Admin can
--    edit the sub-category lists in Manage form fields. Installation unchanged.
--  * Damage Demand: Receive access per team (Commissioning, After Sales,
--    Installation, Factory Maintenance). Holders of the old single Receive
--    option get all four.
--  * My Profile: requests forwarded to you that you have not received yet.
--  * Request access: Name, Employee ID and Section are required.
-- Run in Supabase > SQL Editor after v2.5.1 (UPDATE_V251.sql). Safe to run
-- twice. Back up first. If an RLS warning appears, choose "Run without RLS".
-- =====================================================================
begin;

do $pre$ begin
  if to_regprocedure('wlf_private.rpc_before_v251(text,jsonb)') is null then
    raise exception 'STOP: apply UPDATE_V251.sql (v2.5.1) first. Nothing was changed.';
  end if;
end $pre$;

-- ---------------------------------------------------------------- form rules (sub-category)
CREATE OR REPLACE FUNCTION wlf_private.form_fields(fields jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
declare field jsonb; field_id text; label text; kind text; auto_fill text; choices jsonb; result jsonb='[]';
  parent jsonb; dep text; omap jsonb; k text; lst jsonb;
begin
  if jsonb_typeof(fields) is distinct from 'array' or jsonb_array_length(fields)>60
      or octet_length(fields::text)>60000 then
    raise exception 'A form can contain up to 60 fields and 60 KB of settings.';
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
        or (kind in ('select','multi','radio') and jsonb_array_length(choices)=0 and coalesce(field->>'dependsOn','')='') then
      raise exception 'Check the options for %.', label;
    end if;
    if kind not in ('select','multi','radio','checkbox') then choices='[]'; end if;
    if (auto_fill in ('identity','name','empid') and kind not in ('text','textarea')) or (auto_fill='today' and kind<>'date') then
      auto_fill='none';
    end if;
    -- v2.5.2: a sub-category list that depends on an earlier select field (dependsOn + optionMap)
    dep=nullif(btrim(coalesce(field->>'dependsOn','')),'');
    omap=null;
    if dep is not null then
      select f into parent from jsonb_array_elements(result) f where f->>'id'=dep;
      if parent is null or parent->>'type' not in ('select','radio') or kind<>'select' then
        raise exception 'Sub-category list for % must follow a single-choice field.', label;
      end if;
      omap=coalesce(field->'optionMap','{}');
      if jsonb_typeof(omap)<>'object' then raise exception 'Check the sub-category lists for %.', label; end if;
      for k,lst in select * from jsonb_each(omap) loop
        if not (parent->'options' @> jsonb_build_array(k)) then
          raise exception 'Sub-category list "%" does not match any % option. Rename or remove it.', k, parent->>'label';
        end if;
        if jsonb_typeof(lst)<>'array' or jsonb_array_length(lst)>400
           or exists(select 1 from jsonb_array_elements(lst) c where jsonb_typeof(c)<>'string' or length(btrim(c#>>'{}')) not between 1 and 300)
           or (select count(distinct btrim(value)) from jsonb_array_elements_text(lst))<>jsonb_array_length(lst) then
          raise exception 'Check the sub-category list for "%" (1-400 different lines).', k;
        end if;
      end loop;
      omap=(select coalesce(jsonb_object_agg(key,value),'{}') from jsonb_each(omap) where jsonb_array_length(value)>0);
      choices='[]'; auto_fill='';
    end if;
    result=result||jsonb_build_array(jsonb_build_object('id',field_id,'label',label,'type',kind,
      'help',left(coalesce(field->>'help',''),2000),'required',case when dep is null then coalesce((field->>'required')::boolean,false) else false end,
      'autoFill',auto_fill,'options',choices)
      ||case when dep is null then '{}'::jsonb else jsonb_build_object('dependsOn',dep,'optionMap',omap) end);
  end loop;
  return result;
end
$function$;

CREATE OR REPLACE FUNCTION wlf_private.form_values(form jsonb, vals jsonb, identity_name text, submitted_on date, previous jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
declare f jsonb; x jsonb; txt text; field_id text; kind text; auto_fill text; choices jsonb; result jsonb='{}'; allowed jsonb;
begin
  if jsonb_typeof(vals) is distinct from 'object' or octet_length(vals::text)>64000 then
    raise exception 'Invalid or oversized submission.';
  end if;
  for f in select value from jsonb_array_elements(form->'fields') loop
    field_id=f->>'id'; kind=f->>'type'; choices=coalesce(f->'options','[]');
    auto_fill=coalesce(f->>'autoFill','');
    if coalesce(f->>'dependsOn','')<>'' then
      allowed=f->'optionMap'->(result->>(f->>'dependsOn'));
      x=coalesce(vals->field_id,'""');
      if jsonb_typeof(x) not in ('string','number') then raise exception 'Invalid field: %.',f->>'label'; end if;
      txt=btrim(x#>>'{}');
      if jsonb_typeof(allowed)='array' and jsonb_array_length(allowed)>0 then
        if txt='' then raise exception 'Required: %.',f->>'label'; end if;
        if not (allowed @> jsonb_build_array(txt)) then raise exception 'Invalid choice: %.',f->>'label'; end if;
        result=result||jsonb_build_object(field_id,txt);
      else
        result=result||jsonb_build_object(field_id,'');
      end if;
      continue;
    end if;
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
        where a<>'""' and not(choices @> jsonb_build_array(a)) and not wlf_private.other_choice(choices,a)) then
      raise exception 'Invalid choice: %.',f->>'label';
    end if;
    result=result||jsonb_build_object(field_id,x);
  end loop;
  return result;
end
$function$;

-- ---------------------------------------------------------------- support forms
do $forms$
declare
  cats jsonb := '["MOT drive Error", "NICE3000+ drive error", "NICE900 door drive error", "NBSL-G220 door drive error", "AVR related issue", "MOT parameters issue", "NICE3000+ parameters issue", "UPS related problem", "ARD related problem", "Cartop board related problem", "CPC/Call card related problem", "COP display issue", "MOT compatible COP display customization", "NICE3000+ compatible COP display customization", "MOT compatible LOP issue", "NICE3000+ compatible LOP issue", "MOT compatible transom display issue", "NICE3000+ compatible transom display issue", "Traction machine related problem", "Encoder problem", "Vibration", "Rollback/jarking", "Bumping", "Braking resistor related problem", "Intercom set issue", "Light issue", "MOT Transformer issue", "NICE3000+ transformer issue", "Limit Switch", "Centra load cell issue", "Micro switch issue", "Proximity sensor issue", "Battery issue", "Cross flow fan issue", "Possible hardware issue", "Others"]';
  sub jsonb := '{"id": "problem_sub", "label": "Problem Sub-Category", "type": "select", "required": false, "autoFill": "", "options": [], "help": "Opens a list for the first five problem categories (drive and door errors, AVR).", "dependsOn": "problem_category", "optionMap": {"MOT drive Error": ["Er01", "Er02", "Er03", "Er04", "Er05", "Er06", "Er07", "Er08", "Er09", "Er10", "Er11", "Er12", "Er13", "Er14", "Er15", "Er16", "Er17", "Er18", "Er19", "Er20", "Er21", "Er22", "Er23", "Er24", "Er25", "Er26", "Er27", "Er28", "Er29", "Er30", "Er31", "Er32", "Er33", "Er34", "Er35", "Er36", "Er37", "Er38", "Er39", "Er40", "Er41", "Er42", "Er43", "Er44", "Er45", "Er47", "Er48", "Er49", "Er50", "Er51", "Er52", "Er53", "Er54", "Er55", "Er56", "Er57", "Er58", "Er59", "Er60", "Er61", "Er62", "Er63", "Er65", "Er66", "Er71", "Er72", "Er73", "Er74", "Er75", "Er76", "Er79", "Er80", "Er81", "Er82", "Er83", "Er84", "Er85", "Er86", "Er87", "Er89", "Er90", "Er91", "Er92", "Er93", "Er94", "Er95", "Er96", "Er97", "Er98", "Er99", "Er100", "Er101", "Er102", "Er104", "Er108", "Er110", "Er111", "Er112", "Er113", "Er114"], "NICE3000+ drive error": ["Err02", "Err03", "Err04", "Err05", "Err06", "Err07", "Err08", "Err09", "Err10", "Err11", "Err12", "Err13", "Err14", "Err15 · Sub 1", "Err15 · Sub 2", "Err16 · Sub 1", "Err16 · Sub 2", "Err16 · Sub 3", "Err17 · Sub 1", "Err17 · Sub 2", "Err17 · Sub 3", "Err18", "Err19 · Sub 1", "Err19 · Sub 5", "Err19 · Sub 8", "Err19 · Sub 9", "Err19 · Sub 12", "Err20 · Sub 1", "Err20 · Sub 2", "Err20 · Sub 3", "Err20 · Sub 4", "Err20 · Sub 5", "Err20 · Sub 7", "Err20 · Sub 8", "Err20 · Sub 9", "Err20 · Sub 12", "Err20 · Sub 13", "Err20 · Sub 14", "Err20 · Sub 15", "Err20 · Sub 19", "Err20 · Sub 55", "Err21 · Sub 2", "Err21 · Sub 3", "Err22 · Sub 101", "Err22 · Sub 102", "Err22 · Sub 103", "Err23 · Sub 1", "Err23 · Sub 2", "Err23 · Sub 3", "Err23 · Sub 4", "Err24 · Sub 101", "Err25 · Sub 101", "Err25 · Sub 102", "Err25 · Sub 103", "Err26 · Sub 101", "Err27", "Err28", "Err29 · Sub 101", "Err29 · Sub 102", "Err30 · Sub 101", "Err30 · Sub 102", "Err31", "Err32", "Err33 · Sub 101", "Err33 · Sub 102", "Err33 · Sub 103", "Err33 · Sub 104", "Err33 · Sub 105", "Err33 · Sub 106", "Err34", "Err35 · Sub 101", "Err35 · Sub 102", "Err35 · Sub 103", "Err35 · Sub 104", "Err35 · Sub 105", "Err35 · Sub 106", "Err35 · Sub 107", "Err35 · Sub 108", "Err35 · Sub 109", "Err35 · Sub 110", "Err35 · Sub 111", "Err35 · Sub 112", "Err35 · Sub 113", "Err35 · Sub 114", "Err35 · Sub 115", "Err36 · Sub 101", "Err36 · Sub 102", "Err36 · Sub 103", "Err36 · Sub 104", "Err36 · Sub 105", "Err37 · Sub 101", "Err37 · Sub 102", "Err37 · Sub 103", "Err37 · Sub 104", "Err37 · Sub 105", "Err37 · Sub 106", "Err37 · Sub 107", "Err37 · Sub 108", "Err37 · Sub 109", "Err38 · Sub 101", "Err38 · Sub 102", "Err38 · Sub 103", "Err38 · Sub 104", "Err38 · Sub 105", "Err38 · Sub 106", "Err38 · Sub 107", "Err39 · Sub 101", "Err40", "Err41 · Sub 101", "Err42 · Sub 101", "Err42 · Sub 102", "Err43 · Sub 101", "Err44 · Sub 101", "Err45 · Sub 101", "Err45 · Sub 102", "Err45 · Sub 103", "Err45 · Sub 106", "Err46 · Sub 101", "Err46 · Sub 102", "Err47 · Sub 101", "Err47 · Sub 102", "Err47 · Sub 103", "Err47 · Sub 106", "Err48 · Sub 101", "Err49 · Sub 101", "Err50 · Sub 101", "Err50 · Sub 102", "Err51 · Sub 101", "Err52 · Sub 101", "Err53 · Sub 101", "Err53 · Sub 102", "Err53 · Sub 104", "Err53 · Sub 105", "Err53 · Sub 106", "Err53 · Sub 107", "Err54 · Sub 102", "Err55 · Sub 101", "Err56 · Sub 101", "Err56 · Sub 102", "Err56 · Sub 103", "Err56 · Sub 104", "Err57 · Sub 101", "Err57 · Sub 102", "Err57 · Sub 103", "Err58 · Sub 101", "Err58 · Sub 102", "Err59", "Err60", "Err61", "Err62 · Sub 101", "Err63", "Err64 · Sub 101", "Err65", "Err66", "Err74 · Sub 1", "Err94 · Sub 103", "Err94 · Sub 104"], "NICE900 door drive error": ["Er02", "Er03", "Er04", "Er05", "Er06", "Er07", "Er09", "Er10", "Er11", "Er13", "Er14", "Er16", "Er18", "Er19", "Er20", "Er26", "Er27", "Er28", "Er30", "Er31", "Er32", "Er33"], "NBSL-G220 door drive error": ["E01.0", "E02.0", "E02.1", "E02.2", "E03.0", "E04.0", "E04.1", "E04.2", "E05.0", "E06.0", "E07.0", "E08.0", "E09.0", "E10.0", "E11.0", "E12.0", "E13.0", "E14.0", "E15.0", "E16.0", "E17.0", "E18.0", "E19.0", "E19.1", "E20.0", "E21.0"], "AVR related issue": ["15 KVA", "20 KVA", "30 KVA", "40 KVA", "60 KVA", "80 KVA", "100 KVA", "120 KVA"]}}';
  t text; f jsonb; nf jsonb; pos integer;
begin
  foreach t in array array['commissioning','aftersales','production','qc','maintenance'] loop
    select schema->'fields' into f from public.wlf_forms where category=t;
    if f is null or not exists(select 1 from jsonb_array_elements(f) x where x->>'id'='problem_category') then continue; end if;
    -- already done (and maybe edited by Super Admin since): leave it alone
    if exists(select 1 from jsonb_array_elements(f) x where x->>'id'='problem_sub') then continue; end if;
    select o::integer into pos from jsonb_array_elements(f) with ordinality z(x,o) where x->>'id'='problem_category';
    nf := (select jsonb_agg(y order by k) from (
            select case when x->>'id'='problem_category' then jsonb_set(x,'{options}',cats) else x end y, o::numeric k
              from jsonb_array_elements(f) with ordinality z(x,o)
            union all select sub, pos+0.5) w);
    nf := wlf_private.form_fields(nf);
    update public.wlf_forms set schema=jsonb_set(schema,'{fields}',nf), revision=revision+1 where category=t;
  end loop;
end $forms$;

-- ---------------------------------------------------------------- Damage Demand receive per team
do $cat$ begin
  if to_regprocedure('wlf_private.catalog_before_v252()') is null then
    alter function wlf_private.catalog() rename to catalog_before_v252;
  end if;
end $cat$;
create or replace function wlf_private.catalog() returns jsonb
language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(e order by o, s),'[]') from (
    select e, o, 0 s from jsonb_array_elements(wlf_private.catalog_before_v252()) with ordinality x(e,o) where e->>'key'<>'damage:receive'
    union all
    select jsonb_build_object('key','damage:receive:'||t.k,'label','Receive demands · '||t.n,'group',coalesce(e->>'group','Damage Demand')), o, t.s
      from jsonb_array_elements(wlf_private.catalog_before_v252()) with ordinality x(e,o),
           (values ('commissioning','Commissioning',1),('aftersales','After Sales',2),('installation','Installation',3),('maintenance','Factory Maintenance',4)) t(k,n,s)
     where e->>'key'='damage:receive') z
$$;
update public.wlf_profiles set
  permissions=array(select distinct k from unnest(array_remove(permissions,'damage:receive')
    ||array['damage:receive:commissioning','damage:receive:aftersales','damage:receive:installation','damage:receive:maintenance']) k order by k),
  access_revision=access_revision+1
 where 'damage:receive'=any(permissions) and auth_user_id is not null;

-- ---------------------------------------------------------------- Request access: required fields
create or replace function wlf_private.new_user() returns trigger
language plpgsql security definer set search_path='' as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data,'{}'::jsonb);
  sec text := nullif(btrim(coalesce(meta->>'section','')),'');
  emp text := nullif(btrim(coalesce(meta->>'employeeId','')),'');
  nm text := nullif(btrim(coalesce(meta->>'name','')),'');
begin
  -- v2.5.2: a request from the app's Request access form must carry Name, ID and Section.
  -- (Accounts added by an administrator in the Supabase dashboard have no such form data.)
  if meta ? 'employeeId' or meta ? 'section' then
    if nm is null or emp is null or sec is null then
      raise exception 'Fill in Name, Employee ID and Section.';
    end if;
    if emp !~ '^[A-Za-z0-9][A-Za-z0-9 ./_-]{0,29}$' then raise exception 'Enter a valid Employee ID (letters or digits, up to 30).'; end if;
    if not (sec = any(wlf_private.sections())) then raise exception 'Choose a section from the list.'; end if;
  end if;
  if sec is not null and not (sec = any(wlf_private.sections())) then sec := null; end if;
  if emp is not null and emp !~ '^[A-Za-z0-9][A-Za-z0-9 ./_-]{0,29}$' then emp := null; end if;
  insert into public.wlf_profiles(id,auth_user_id,email,name,employee_id,section,role) values(
    new.id,new.id,lower(new.email),
    left(coalesce(nm,split_part(new.email,'@',1)),120),
    emp, sec, wlf_private.role_for(sec));
  return new;
end
$$;

-- ---------------------------------------------------------------- RPC layer
do $layer$ begin
  if to_regprocedure('wlf_private.rpc_before_v252(text,jsonb)') is null then
    alter function wlf_private.rpc(text,jsonb) rename to rpc_before_v252;
  end if;
end $layer$;

create or replace function wlf_private.rpc(a text, args jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  p jsonb := coalesce(args->0,'{}');
  u public.wlf_profiles;
  d wlf_private.damage_demands;
  result jsonb;
begin
  u := wlf_private.me();
  if u.id is null or u.status is distinct from 'Approved' then
    raise exception 'SESSION_EXPIRED: Account is pending approval or inactive';
  end if;

  if a='getMyForwarded' then
    return coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'reference',r.reference,'category',r.category,
        'project',coalesce(r.values->>'project',''),'lift',coalesce(r.values->>'lift',''),
        'forwardedBy',coalesce(wlf_private.person_label(fh.actor),''),'comment',coalesce(fh.comment,''),
        'forwardedAt',coalesce(fh.at,r.updated_at)) order by coalesce(fh.at,r.updated_at) desc)
      from public.wlf_requests r
      left join lateral (select h.actor,h.comment,h.at from public.wlf_history h
                          where h.request_id=r.id and h.action='forward' order by h.at desc, h.id desc limit 1) fh on true
      where r.assigned_to=u.id and r.status='Forwarded' and r.deleted_at is null),'[]'::jsonb);

  elsif a='receiveDamageDemand' then
    -- v2.5.2: receive only for the teams this user may receive for
    select * into d from wlf_private.damage_demands where request_id=nullif(p->>'id','')::uuid;
    if not found then raise exception 'Damage demand not found.'; end if;
    if not (u.role='Super Admin' or ('damage:demand'=any(u.permissions) and ('damage:receive:'||d.category)=any(u.permissions))) then
      raise exception 'You do not have Receive access for this team''s demands.';
    end if;
    update wlf_private.damage_demands set received_at=now(),received_by=u.id,received_name=u.name
      where request_id=d.request_id and received_at is null returning * into d;
    if not found then
      select * into d from wlf_private.damage_demands where request_id=nullif(p->>'id','')::uuid;
      if d.received_by is distinct from u.id then raise exception 'Already received by Dispatch. Refresh the list.'; end if;
    end if;
    return wlf_private.damage_demand_detail(d);
  end if;

  result := wlf_private.rpc_before_v252(a,args);

  if a='getDamageDemands' and jsonb_typeof(result)='object' then
    result := result||jsonb_build_object('teamPending',(select coalesce(jsonb_object_agg(category,n),'{}'::jsonb)
      from (select category,count(*) n from wlf_private.damage_demands where received_at is null group by category) z));
  elsif a in ('getSession','getAppContext') then
    result := result||jsonb_build_object('build','2.5.2','problemSubCategories',true,'damageReceiveByTeam',true);
  end if;
  return result;
end
$$;

revoke all on function wlf_private.rpc_before_v252(text,jsonb) from public, anon, authenticated;
revoke all on function wlf_private.rpc(text,jsonb) from public, anon;
grant execute on function wlf_private.rpc(text,jsonb) to authenticated;
revoke all on function wlf_private.catalog_before_v252() from public, anon, authenticated;

notify pgrst, 'reload schema';
commit;

-- ---------------------------------------------------------------- check
select
  (select count(*) from public.wlf_forms f, jsonb_array_elements(f.schema->'fields') x where x->>'id'='problem_sub')=5 as problem_sub_category_ready,
  (select count(*) from public.wlf_forms f, jsonb_array_elements(f.schema->'fields') x
     where x->>'id'='problem_category' and x->'options' @> '["MOT drive Error","Others"]')=5 as problem_categories_ready,
  (select count(*) from jsonb_array_elements(wlf_private.catalog()) x where x->>'key' like 'damage:receive:%')=4
    and not exists(select 1 from public.wlf_profiles where 'damage:receive'=any(permissions) and auth_user_id is not null) as damage_receive_by_team_ready,
  to_regprocedure('wlf_private.rpc_before_v252(text,jsonb)') is not null as v252_ready;
