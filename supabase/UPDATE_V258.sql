-- =====================================================================
-- WLF Electrical Solution v2.5.8
--  * Support forms, field "Problem Category": new option "MOTCUBE drive error"
--    directly below "NICE3000+ drive error". Choosing it opens the Problem
--    Sub-Category list of MOTCUBE error codes (H1 to H62, there is no H20 in
--    the manual: 61 codes) and one code must be chosen, exactly like
--    "MOT drive Error". Done for every team form that has the Problem
--    Category and Problem Sub-Category fields. Requests already submitted keep
--    the form they were written with.
--  * Support request history shows Submitted / Received / Forwarded / Solved
--    (screen change only, no database change).
-- Run in Supabase > SQL Editor after v2.5.7 (UPDATE_V257.sql). Safe to run
-- twice. Back up first. If an RLS warning appears, choose "Run without RLS".
-- =====================================================================
begin;

do $pre$ begin
  if to_regprocedure('wlf_private.rpc_before_v257(text,jsonb)') is null then
    raise exception 'STOP: apply UPDATE_V257.sql (v2.5.7) first. Nothing was changed.';
  end if;
end $pre$;

-- ---------------------------------------------------------------- support forms: MOTCUBE drive error
do $forms$
declare
  cat constant text := 'MOTCUBE drive error';
  after_cat constant text := 'NICE3000+ drive error';
  codes constant jsonb := '["H1", "H2", "H3", "H4", "H5", "H6", "H7", "H8", "H9", "H10", "H11", "H12", "H13", "H14", "H15", "H16", "H17", "H18", "H19", "H21", "H22", "H23", "H24", "H25", "H26", "H27", "H28", "H29", "H30", "H31", "H32", "H33", "H34", "H35", "H36", "H37", "H38", "H39", "H40", "H41", "H42", "H43", "H44", "H45", "H46", "H47", "H48", "H49", "H50", "H51", "H52", "H53", "H54", "H55", "H56", "H57", "H58", "H59", "H60", "H61", "H62"]'::jsonb;
  old_help constant text := 'Opens a list for the first five problem categories (drive and door errors, AVR).';
  r record;
  f jsonb;
  nf jsonb;
begin
  for r in select category, schema from public.wlf_forms loop
    f := r.schema->'fields';
    if f is null or jsonb_typeof(f)<>'array' then continue; end if;
    -- both fields must exist (a form where Super Admin removed one of them is left alone)
    if not exists(select 1 from jsonb_array_elements(f) x where x->>'id'='problem_category') then continue; end if;
    if not exists(select 1 from jsonb_array_elements(f) x where x->>'id'='problem_sub' and x->>'dependsOn'='problem_category') then continue; end if;
    -- already there (also if Super Admin added it by hand): nothing to do
    if exists(select 1 from jsonb_array_elements(f) x, jsonb_array_elements_text(coalesce(x->'options','[]'::jsonb)) o
              where x->>'id'='problem_category' and o=cat) then continue; end if;
    nf := (select jsonb_agg(
        case
          when x->>'id'='problem_category' then jsonb_set(x,'{options}',
            (select jsonb_agg(v order by k) from (
               select e v, o::numeric k from jsonb_array_elements(coalesce(x->'options','[]'::jsonb)) with ordinality z(e,o)
               union all
               select to_jsonb(cat),
                      coalesce((select o from jsonb_array_elements_text(coalesce(x->'options','[]'::jsonb)) with ordinality z2(e,o) where e=after_cat),
                               jsonb_array_length(coalesce(x->'options','[]'::jsonb)))+0.5) w))
          when x->>'id'='problem_sub' and x->>'dependsOn'='problem_category' then
            jsonb_set(
              jsonb_set(x,'{optionMap}',coalesce(x->'optionMap','{}'::jsonb)||jsonb_build_object(cat,codes)),
              '{help}', to_jsonb(case when x->>'help'=old_help
                then 'Opens a list for the drive and door error categories (MOT, NICE3000+, MOTCUBE, NICE900, NBSL-G220) and AVR.'
                else coalesce(x->>'help','') end))
          else x end
        order by o)
      from jsonb_array_elements(f) with ordinality t(x,o));
    nf := wlf_private.form_fields(nf);
    update public.wlf_forms set schema=jsonb_set(schema,'{fields}',nf), revision=revision+1 where category=r.category;
  end loop;
end $forms$;

-- ---------------------------------------------------------------- rpc layer (build number only)
do $r$ begin
  if to_regprocedure('wlf_private.rpc_before_v258(text,jsonb)') is null then
    alter function wlf_private.rpc(text,jsonb) rename to rpc_before_v258;
  end if;
end $r$;
create or replace function wlf_private.rpc(a text, args jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  result := wlf_private.rpc_before_v258(a,args);
  if a in ('getSession','getAppContext') and jsonb_typeof(result)='object' then
    result := result || jsonb_build_object('build','2.5.8');
  end if;
  return result;
end
$$;

revoke all on function wlf_private.rpc_before_v258(text,jsonb) from public, anon, authenticated;
revoke all on function wlf_private.rpc(text,jsonb) from public, anon;
grant execute on function wlf_private.rpc(text,jsonb) to authenticated;

commit;

select
  (select count(*) from public.wlf_forms f
     where exists(select 1 from jsonb_array_elements(f.schema->'fields') x, jsonb_array_elements_text(coalesce(x->'options','[]'::jsonb)) o
                  where x->>'id'='problem_category' and o='MOTCUBE drive error'))  as forms_with_motcube,
  (select count(*) from public.wlf_forms f
     where exists(select 1 from jsonb_array_elements(f.schema->'fields') x where x->>'id'='problem_category')) as forms_with_problem_category,
  to_regprocedure('wlf_private.rpc_before_v258(text,jsonb)') is not null as v258_ready;
