import fs from 'node:fs/promises';

const source = JSON.parse(await fs.readFile('data/technical-support-forms-20261107.json', 'utf8'));
const expectedTeams = ['aftersales', 'commissioning', 'production', 'qc', 'maintenance', 'installation'];
if (Object.keys(source.forms).join(',') !== expectedTeams.join(',')) {
  throw new Error('The support workbook must define all six teams in the reviewed order.');
}
if (!/^[a-f0-9]{64}$/.test(source.source.sha256)) {
  throw new Error('The workbook source checksum is missing.');
}

const quote = value => "'" + value.replaceAll("'", "''") + "'";
const updateId = 'support-forms-20261107-' + source.source.sha256.slice(0, 12);
const forms = quote(JSON.stringify(source.forms)) + '::jsonb';

const sql = `-- Technical Support input fields from Technical support form.xlsx.
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
  source_forms jsonb = ${forms};
  workbook_update constant text = ${quote(updateId)};
  workbook_sha constant text = ${quote(source.source.sha256)};
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
where a.update_id = ${quote(updateId)}
order by array_position(array['aftersales','commissioning','production','qc','maintenance','installation'], f.category);
`;

await fs.writeFile('supabase/UPDATE_SUPPORT_FORMS_20261107.sql', sql);
console.log('Generated support form update for ' + expectedTeams.length + ' teams.');
