-- Technical Support input fields from Technical support form.xlsx.
-- Run the complete file in the existing WLF v2.2 Supabase SQL Editor.
-- The previous definitions are recorded in a private audit table in this transaction.
begin;

do $$
begin
  if to_regprocedure('wlf_private.save_support_v220(text,jsonb)') is null
      or to_regprocedure('wlf_private.form_fields(jsonb)') is null then
    raise exception 'WLF v2.2 database required. Select the existing updated project.';
  end if;
end
$$;

create table if not exists wlf_private.support_form_updates (
  update_id text not null,
  category text not null,
  source_sha256 text not null,
  before_state jsonb not null,
  applied_state jsonb not null,
  applied_at timestamptz not null default now(),
  primary key (update_id, category)
);
alter table wlf_private.support_form_updates enable row level security;
revoke all on wlf_private.support_form_updates from public, anon, authenticated;

do $$
declare
  source_forms jsonb = '{"aftersales":{"title":"After Sales Team Support Request","fields":[{"id":"date","label":"Date","type":"date","help":"","required":true,"autoFill":"today","options":[]},{"id":"identity","label":"Name & ID","type":"text","help":"","required":true,"autoFill":"identity","options":[]},{"id":"area_csm","label":"Area CSM","type":"select","help":"","required":true,"autoFill":"","options":["Alamgir Hosen(54655)","Ashraful Alam(54950)","Mehedi Hasan(55514)","Ahmed Ashiq(54760)","Palash Chandra Roy(55009)"]},{"id":"project","label":"Project Name","type":"text","help":"","required":true,"autoFill":"","options":[]},{"id":"lift","label":"Lift ID","type":"number","help":"","required":true,"autoFill":"","options":[]},{"id":"controller","label":"Control System Brand","type":"select","help":"","required":true,"autoFill":"","options":["NICE3000+","MOT","MOTCUBE","Hydraulic-ARL700","Hydraulic-PLC","Home Lift"]},{"id":"problem_category","label":"Problem Category","type":"select","help":"","required":true,"autoFill":"","options":["Drive system related problem","Cartop board related problem","CPC/Call card related problem","COP display Issue","LOP display problem","Traction Machine related problem","Encoder problem","UPS/ARD related Issue","Braking Resistor problem","Intercom set issue","Light issue","Transformer","Door inverter","Switch","Sensor","Battery","Fan","AVR","Vibration/Rollback","Bumping","MOTCUBE Activation","Parameters Issue","Other:"]},{"id":"problem","label":"Problem Details","type":"text","help":"","required":true,"autoFill":"","options":[]},{"id":"remarks","label":"Remarks","type":"text","help":"","required":false,"autoFill":"","options":[]}]},"commissioning":{"title":"Commissioning Team Support Request","fields":[{"id":"date","label":"Date","type":"date","help":"","required":true,"autoFill":"today","options":[]},{"id":"identity","label":"Name & ID","type":"text","help":"","required":true,"autoFill":"identity","options":[]},{"id":"pm","label":"PM","type":"select","help":"","required":true,"autoFill":"","options":["Md. Rejaul Karim(47869)","Masum(51111)"]},{"id":"project","label":"Project Name","type":"text","help":"","required":true,"autoFill":"","options":[]},{"id":"lift","label":"Lift ID","type":"number","help":"","required":true,"autoFill":"","options":[]},{"id":"controller","label":"Control System Brand","type":"select","help":"","required":true,"autoFill":"","options":["NICE3000+","MOT","MOTCUBE","Hydraulic-ARL700","Hydraulic-PLC","Home Lift"]},{"id":"problem_category","label":"Problem Category","type":"select","help":"","required":true,"autoFill":"","options":["Drive system related problem","Cartop board related problem","CPC/Call card related problem","COP display Issue","LOP display problem","Traction Machine related problem","Encoder problem","UPS/ARD related Issue","Braking Resistor problem","Intercom set issue","Light issue","Transformer","Door inverter","Switch","Sensor","Battery","Fan","AVR","Vibration/Rollback","Bumping","MOTCUBE Activation","Parameters Issue","Other:"]},{"id":"problem","label":"Problem Details","type":"text","help":"","required":true,"autoFill":"","options":[]},{"id":"remarks","label":"Remarks","type":"text","help":"","required":false,"autoFill":"","options":[]}]},"production":{"title":"Production Team Support Request","fields":[{"id":"date","label":"Date","type":"date","help":"","required":true,"autoFill":"today","options":[]},{"id":"identity","label":"Name & ID","type":"text","help":"","required":true,"autoFill":"identity","options":[]},{"id":"project","label":"Project Name","type":"text","help":"","required":true,"autoFill":"","options":[]},{"id":"lift","label":"Lift ID","type":"number","help":"","required":true,"autoFill":"","options":[]},{"id":"controller","label":"Control System Brand","type":"select","help":"","required":true,"autoFill":"","options":["NICE3000+","MOT","MOTCUBE","Hydraulic-ARL700","Hydraulic-PLC","Home Lift"]},{"id":"problem_category","label":"Problem Category","type":"select","help":"","required":true,"autoFill":"","options":["Drive system related problem","Cartop board related problem","CPC/Call card related problem","COP display Issue","LOP display problem","Traction Machine related problem","Encoder problem","UPS/ARD related Issue","Braking Resistor problem","Intercom set issue","Light issue","Transformer","Door inverter","Switch","Sensor","Battery","Fan","AVR","Vibration/Rollback","Bumping","MOTCUBE Activation","Parameters Issue","Other:"]},{"id":"problem","label":"Problem Details","type":"text","help":"","required":true,"autoFill":"","options":[]},{"id":"remarks","label":"Remarks","type":"text","help":"","required":false,"autoFill":"","options":[]}]},"qc":{"title":"QC Team Support Request","fields":[{"id":"date","label":"Date","type":"date","help":"","required":true,"autoFill":"today","options":[]},{"id":"identity","label":"Name & ID","type":"text","help":"","required":true,"autoFill":"identity","options":[]},{"id":"project","label":"Project Name","type":"text","help":"","required":true,"autoFill":"","options":[]},{"id":"lift","label":"Lift ID","type":"number","help":"","required":true,"autoFill":"","options":[]},{"id":"controller","label":"Control System Brand","type":"select","help":"","required":true,"autoFill":"","options":["NICE3000+","MOT","MOTCUBE","Hydraulic-ARL700","Hydraulic-PLC","Home Lift"]},{"id":"problem_category","label":"Problem Category","type":"select","help":"","required":true,"autoFill":"","options":["Drive system related problem","Cartop board related problem","CPC/Call card related problem","COP display Issue","LOP display problem","Traction Machine related problem","Encoder problem","UPS/ARD related Issue","Braking Resistor problem","Intercom set issue","Light issue","Transformer","Door inverter","Switch","Sensor","Battery","Fan","AVR","Vibration/Rollback","Bumping","MOTCUBE Activation","Parameters Issue","Other:"]},{"id":"problem","label":"Problem Details","type":"text","help":"","required":true,"autoFill":"","options":[]},{"id":"remarks","label":"Remarks","type":"text","help":"","required":false,"autoFill":"","options":[]}]},"maintenance":{"title":"Factory Maintenance Team Support Request","fields":[{"id":"date","label":"Date","type":"date","help":"","required":true,"autoFill":"today","options":[]},{"id":"identity","label":"Name & ID","type":"text","help":"","required":true,"autoFill":"identity","options":[]},{"id":"project","label":"Project Name","type":"text","help":"","required":true,"autoFill":"","options":[]},{"id":"lift","label":"Lift ID","type":"number","help":"","required":true,"autoFill":"","options":[]},{"id":"controller","label":"Control System Brand","type":"select","help":"","required":true,"autoFill":"","options":["NICE3000+","MOT","MOTCUBE","Hydraulic-ARL700","Hydraulic-PLC","Home Lift"]},{"id":"problem_category","label":"Problem Category","type":"select","help":"","required":true,"autoFill":"","options":["Drive system related problem","Cartop board related problem","CPC/Call card related problem","COP display Issue","LOP display problem","Traction Machine related problem","Encoder problem","UPS/ARD related Issue","Braking Resistor problem","Intercom set issue","Light issue","Transformer","Door inverter","Switch","Sensor","Battery","Fan","AVR","Vibration/Rollback","Bumping","MOTCUBE Activation","Parameters Issue","Other:"]},{"id":"problem","label":"Problem Details","type":"text","help":"","required":true,"autoFill":"","options":[]},{"id":"remarks","label":"Remarks","type":"text","help":"","required":false,"autoFill":"","options":[]}]},"installation":{"title":"Installation Team Support Request","fields":[{"id":"date","label":"Date","type":"date","help":"","required":true,"autoFill":"today","options":[]},{"id":"identity","label":"Name & ID","type":"text","help":"","required":true,"autoFill":"identity","options":[]},{"id":"pm","label":"PM","type":"select","help":"","required":true,"autoFill":"","options":["Sabbir Ahmmed(55395)","Elias Hossain(52449)","Ashikur Rahman Akash(42976)","Taiful Islam(69313)"]},{"id":"project","label":"Project Name","type":"text","help":"","required":true,"autoFill":"","options":[]},{"id":"lift","label":"Lift ID","type":"number","help":"","required":true,"autoFill":"","options":[]},{"id":"capacity","label":"Capacity","type":"number","help":"","required":true,"autoFill":"","options":[]},{"id":"problem_category","label":"Problem Category","type":"select","help":"","required":true,"autoFill":"","options":["Mechanical","Electrical"]},{"id":"sub","label":"Problem Sub-Category","type":"select","help":"","required":true,"autoFill":"","options":["1. Asthetics","2. Steel Rope","3. Motor Related Issue","4. Door Related Issue","5. Vibration","6. Bumping","7. Electrical Layout","8. Slow Speed Issue","9. SDB Requirement","10. Others"]},{"id":"problem","label":"Problem Details","type":"text","help":"","required":true,"autoFill":"","options":[]},{"id":"remarks","label":"Remarks","type":"text","help":"","required":false,"autoFill":"","options":[]}]}}'::jsonb;
  workbook_update constant text = 'support-forms-20261107-2972fc9c03fe';
  workbook_sha constant text = '2972fc9c03fec1ebfd00f17c28d6254263d29b35b9e7b6cb0690951abc7c965b';
  entry record;
  live_form public.wlf_forms;
  previous_update wlf_private.support_form_updates;
  next_fields jsonb;
  before_state jsonb;
begin
  lock table public.wlf_forms in share row exclusive mode;
  for entry in select key, value from jsonb_each(source_forms) loop
    select * into live_form from public.wlf_forms where category = entry.key for update;
    if not found then
      raise exception 'Missing support team: %. Confirm that the v2.2 update is installed.', entry.key;
    end if;

    next_fields = wlf_private.form_fields(entry.value->'fields');
    select * into previous_update from wlf_private.support_form_updates
      where update_id = workbook_update and category = entry.key;
    if found then
      if previous_update.source_sha256 <> workbook_sha
          or live_form.schema->'fields' is distinct from next_fields then
        raise exception 'Workbook already applied; % was changed afterward. Review the saved definition before applying it again.', entry.key;
      end if;
      continue;
    end if;

    before_state = to_jsonb(live_form);
    if live_form.schema->'fields' is distinct from next_fields then
      update public.wlf_forms
        set schema = jsonb_set(schema, '{fields}', next_fields), revision = revision + 1
        where category = entry.key
        returning * into live_form;
    end if;

    insert into wlf_private.support_form_updates
      (update_id, category, source_sha256, before_state, applied_state)
      values (workbook_update, entry.key, workbook_sha, before_state, to_jsonb(live_form));
  end loop;
end
$$;

commit;

-- Six results, with field counts 9/9/8/8/8/10 and fields_match = true.
select
  f.category,
  jsonb_array_length(f.schema->'fields') as field_count,
  f.schema->'fields' = a.applied_state->'schema'->'fields' as fields_match,
  (select jsonb_agg(field->>'label' order by position)
   from jsonb_array_elements(f.schema->'fields') with ordinality fields(field, position)) as field_names
from public.wlf_forms f
join wlf_private.support_form_updates a on a.category = f.category
where a.update_id = 'support-forms-20261107-2972fc9c03fe'
order by array_position(array['aftersales','commissioning','production','qc','maintenance','installation'], f.category);
