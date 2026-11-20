-- =====================================================================
-- WLF Electrical Solution v2.6.0
--  * Hardware Catalogue: COP Faceplate is its own list (Hairline, Silver
--    Mirror, Golden Mirror, Black Mirror, Black Hairline, Rose Gold Mirror);
--    MOTCUBE 5.5 / 7.5 / 11 kW tables are ready (blank) for after-sales use.
--    The old "Value" column is now called Price (same numbers).
--  * Technical Support forms: a Controller Model list (MOT, NICE3000+,
--    MOTCUBE models) opens after the Control System Brand and must be chosen.
--    Raise Damage Demand then starts from that model.
--  * Components Data: Super Admin can replace all rows from a CSV file.
--  * QMS: every serial number is required; MOTCUBE is not a QMS controller.
-- Run in Supabase > SQL Editor after v2.5.9 (UPDATE_V259.sql). Safe to run
-- twice. Back up first. If an RLS warning appears, choose "Run without RLS".
-- =====================================================================
begin;

do $pre$ begin
  if to_regprocedure('wlf_private.rpc_before_v259(text,jsonb)') is null then
    raise exception 'STOP: apply UPDATE_V259.sql (v2.5.9) first. Nothing was changed.';
  end if;
end $pre$;

-- ---------------------------------------------------------------- catalogue: COP Faceplate list
update wlf_private.hw_catalogue set model='COP Faceplate', system=system
 where grp='COP Faceplate' and model='COP' and deleted_at is null;

insert into wlf_private.hw_catalogue(system,model,grp,hardware,item_name,sort)
select s.system,'COP Faceplate','COP Faceplate',n.name,n.name,
       coalesce((select max(c.sort) from wlf_private.hw_catalogue c where c.system=s.system and c.model='COP Faceplate'),0)+n.ord
from (select distinct system from wlf_private.hw_catalogue where system in ('MOT','NICE3000+') and deleted_at is null) s,
     (values (1,'Hairline'),(2,'Silver Mirror'),(3,'Golden Mirror'),(4,'Black Mirror'),(5,'Black Hairline'),(6,'Rose Gold Mirror')) n(ord,name)
where not exists (select 1 from wlf_private.hw_catalogue c
                  where c.system=s.system and c.model='COP Faceplate' and lower(c.hardware)=lower(n.name) and c.deleted_at is null);

-- ---------------------------------------------------------------- catalogue: MOTCUBE (blank tables, after-sales only)
insert into wlf_private.hw_catalogue(system,model,grp,hardware,sort)
select 'MOTCUBE', replace(c.model,'MOT ','MOTCUBE '), c.grp, c.hardware, c.sort
from wlf_private.hw_catalogue c
where c.system='MOT' and c.model in ('MOT 5.5 kW','MOT 7.5 kW','MOT 11 kW') and c.deleted_at is null
  and not exists (select 1 from wlf_private.hw_catalogue where system='MOTCUBE');

-- ---------------------------------------------------------------- Technical Support forms: Controller Model
do $forms$
declare
  fld jsonb := jsonb_build_object('id','controller_model','label','Controller Model','type','select','required',false,'autoFill','','options','[]'::jsonb,
    'help','Choose the controller model of this lift. Raise Damage Demand starts from this model.',
    'dependsOn','controller',
    'optionMap',jsonb_build_object(
      'MOT','["MOT 5.5 kW","MOT 7.5 kW","MOT 11 kW","MOT 15 kW","MOT 22 kW","MOT 37 kW"]'::jsonb,
      'NICE3000+','["NICE3000+ 7.5 kW","NICE3000+ 11 kW","NICE3000+ 15 kW","NICE3000+ 22 kW","NICE3000+ 30 kW","NICE3000+ 37 kW","NICE3000+ 45 kW"]'::jsonb,
      'MOTCUBE','["MOTCUBE 5.5 kW","MOTCUBE 7.5 kW","MOTCUBE 11 kW"]'::jsonb));
  r record; f jsonb; nf jsonb; pos integer;
begin
  for r in select category, schema from public.wlf_forms loop
    f := r.schema->'fields';
    if f is null or jsonb_typeof(f)<>'array' then continue; end if;
    if not exists(select 1 from jsonb_array_elements(f) x where x->>'id'='controller') then continue; end if;
    if exists(select 1 from jsonb_array_elements(f) x where x->>'id'='controller_model') then continue; end if;
    select o::integer into pos from jsonb_array_elements(f) with ordinality z(x,o) where x->>'id'='controller';
    nf := (select jsonb_agg(y order by k) from (
            select x y, o::numeric k from jsonb_array_elements(f) with ordinality z(x,o)
            union all select fld, pos+0.5) w);
    nf := wlf_private.form_fields(nf);
    update public.wlf_forms set schema=jsonb_set(schema,'{fields}',nf), revision=revision+1 where category=r.category;
  end loop;
end $forms$;

-- ---------------------------------------------------------------- rpc layer
do $r$ begin
  if to_regprocedure('wlf_private.rpc_before_v260(text,jsonb)') is null then
    alter function wlf_private.rpc(text,jsonb) rename to rpc_before_v260;
  end if;
end $r$;
create or replace function wlf_private.rpc(a text, args jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  p jsonb := coalesce(args->0,'{}');
  result jsonb;
  me public.wlf_profiles;
  hdr jsonb;
  rows_in jsonb;
  row_in jsonb;
  k text;
  removed integer;
  added integer;
begin
  if a='saveQmsLift' then
    if coalesce(p->>'system','')='MOTCUBE' then raise exception 'MOTCUBE is not a QMS controller.'; end if;
    foreach k in array array['motor','encoder','drive','ups','cartop','cop','copDisplay'] loop
      if btrim(coalesce(p->'serials'->>k,''))='' then
        raise exception 'Enter every serial number (missing: %).', k;
      end if;
    end loop;
  end if;
  if a='adminImportComponents' then
    select * into me from public.wlf_profiles where id=auth.uid();
    if not found or me.status<>'Approved' or me.role<>'Super Admin' then raise exception 'Permission denied'; end if;
    if octet_length(args::text)>2000000 then raise exception 'The file is too large.'; end if;
    rows_in := p->'rows';
    if jsonb_typeof(rows_in)<>'array' or jsonb_array_length(rows_in)=0 then raise exception 'The CSV has no data rows.'; end if;
    if jsonb_array_length(rows_in)>3000 then raise exception 'Too many rows (limit 3000).'; end if;
    select value into hdr from public.wlf_settings where key='component_headers';
    for row_in in select value from jsonb_array_elements(rows_in) loop
      if jsonb_typeof(row_in)<>'array' or jsonb_array_length(row_in)<>jsonb_array_length(hdr) then
        raise exception 'Every row needs exactly % columns.', jsonb_array_length(hdr);
      end if;
      for k in select i::text from generate_series(0,3) i loop
        if btrim(coalesce(row_in->>(k::integer),''))='' then raise exception 'The first four columns are required in every row.'; end if;
      end loop;
    end loop;
    select count(*) into removed from public.wlf_components;
    delete from public.wlf_components where true;
    insert into public.wlf_components(values) select value from jsonb_array_elements(rows_in);
    get diagnostics added = row_count;
    return jsonb_build_object('removed',removed,'added',added);
  end if;
  result := wlf_private.rpc_before_v260(a,args);
  if a in ('getSession','getAppContext') and jsonb_typeof(result)='object' then
    result := result || jsonb_build_object('build','2.6.0');
  end if;
  return result;
end
$$;

revoke all on function wlf_private.rpc_before_v260(text,jsonb) from public, anon, authenticated;
revoke all on function wlf_private.rpc(text,jsonb) from public, anon;
grant execute on function wlf_private.rpc(text,jsonb) to authenticated;

commit;

select
  (select count(distinct hardware) from wlf_private.hw_catalogue where system='MOT' and model='COP Faceplate' and deleted_at is null) as mot_faceplates,
  (select count(distinct model) from wlf_private.hw_catalogue where system='MOTCUBE' and deleted_at is null) as motcube_models,
  (select count(*) from public.wlf_forms f, jsonb_array_elements(f.schema->'fields') x where x->>'id'='controller_model') as forms_with_controller_model,
  to_regprocedure('wlf_private.rpc_before_v260(text,jsonb)') is not null as v260_ready;
