// Create the release data fragment from the verified workbook extraction and the v2.1 seed.
import fs from 'node:fs/promises';

const filename = process.argv[2];
if (!filename) throw Error('Pass the approved workbook-data.js extraction.');
const text = await fs.readFile(filename, 'utf8');
const workbook = JSON.parse(text.split('const WLF_WORKBOOK = ')[1].trim().replace(/;$/, ''));
const original = JSON.parse(await fs.readFile('data/component-source.json', 'utf8'));
const oldForms = JSON.parse(await fs.readFile('shared/support-forms.json', 'utf8'));
const titles = {
  commissioning: 'Commissioning Team Support Request',
  aftersales: 'After Sales Team Support Request',
  production: 'Production Team Support Request',
  maintenance: 'Factory Maintenance Team Support Request',
  qc: 'QC Team Support Request',
  installation: 'Installation Team Support Request'
};
const field = ({id,label,type,required,options,autoFill}) =>
  ({id,label,type,required,options:options||[],...(autoFill ? {autoFill} : {})});

const support = Object.fromEntries(Object.entries(titles).map(([category,title]) => {
  const fields = workbook.supportSchemas[category].map(field);
  const problemAt = fields.findIndex(f => f.id === 'problem');
  if (!fields.some(f => f.id === 'sub')) {
    const legacy = oldForms[category]?.fields.find(f => f.id === 'field_295723266');
    fields.splice(problemAt,0,legacy
      ? {...field(legacy),id:'sub',label:'Sub Category',required:false}
      : {id:'sub',label:'Sub Category',type:'text',required:false,options:[]});
  } else {
    fields.find(f=>f.id==='sub').label='Sub Category';
  }
  if (!fields.some(f => f.id === 'controller')) {
    const options=[...new Set(Object.values(workbook.supportSchemas)
      .flatMap(schema=>schema.find(f=>f.id==='controller')?.options||[]))];
    fields.splice(fields.findIndex(f=>f.id==='problem_category'),0,{
      id:'controller',label:'Control System Brand',type:'select',required:false,options
    });
  }
  return [category,{title,fields}];
}));
const keys = workbook.componentHeaders.slice(1).map(f=>f.key);
const normalize = v=>String(v??'').trim().toLowerCase().replace(/[\s.-]+/g,'');
const orderedRows=workbook.components.filter(r=>r.serial!==55);
if (orderedRows.length!==original.records.length) throw Error('Workbook baseline alignment changed.');
const mapped = original.records.map((old,i)=>{
  const row=orderedRows[i];
  const incoming=keys.map(key=>row[key]);
  if (incoming.slice(0,7).some((value,j)=>normalize(value)!==normalize(old.values[j]))) {
    throw Error('Review component baseline alignment for ID '+old.id);
  }
  return {id:old.id,old:old.values,incoming:[...incoming,row.serial]};
});
const additional=workbook.components.find(r=>r.serial===55);
const extra=[...keys.map(key=>additional[key]),additional.serial];
const newHeaders=[...original.headers,'SL.N'];
const activity=workbook.categories.map((c,i)=>({id:c.id,section:c.group,name:c.name,position:i+1,schema:{fields:c.fields.map(field)}}));
const output={
  sources:workbook.sources, support, activity, componentCount:workbook.components.length,
  componentHeaderMap:{database:newHeaders,workbook:workbook.componentHeaders.map(f=>f.label)},
  extraComponentSerial:additional.serial, notes:workbook.componentNotes,
  assumptions:workbook.importAudit.assumptions
};
await fs.writeFile('data/workbook-v220-audit.json',JSON.stringify(output,null,2)+'\n');
const json = value => "'" + JSON.stringify(value).replaceAll("'","''") + "'::jsonb";
const quote = value => "'" + value.replaceAll("'","''") + "'";
let sql='-- Generated once from the two approved workbooks. Import is conditional and repeatable.\n';
sql += [
  'create table if not exists wlf_private.v220_import_audit (item text primary key, decision text not null, before_state jsonb, at timestamptz not null default now());',
  'alter table wlf_private.v220_import_audit enable row level security;',
  'revoke all on wlf_private.v220_import_audit from public,anon,authenticated;',
  'do $$',
  'declare old_headers jsonb; old_row public.wlf_components; old_form public.wlf_forms; incoming jsonb; component jsonb; key text; live_count int;',
  'begin',
  '  lock table public.wlf_components, public.wlf_settings, public.wlf_forms in share row exclusive mode;',
  "  if not exists(select 1 from wlf_private.v220_import_audit where item='component_headers') then",
  "    select value into old_headers from public.wlf_settings where wlf_settings.key='component_headers';",
  "    if old_headers is distinct from "+json(original.headers)+" then",
  "      insert into wlf_private.v220_import_audit(item,decision,before_state) values('component_headers','preserved: custom headers; review component import manually',old_headers);",
  '    else',
  "      insert into wlf_private.v220_import_audit(item,decision,before_state) values('component_headers','imported',old_headers);",
  "      update public.wlf_settings set value="+json(newHeaders)+" where wlf_settings.key='component_headers';",
  '      for component in select value from jsonb_array_elements('+json(mapped)+') loop',
  "        select * into old_row from public.wlf_components where id=(component->>'id')::bigint;",
  '        if not found then',
  "          insert into wlf_private.v220_import_audit(item,decision) values('component:'||(component->>'id'),'preserved: previously deleted');",
  "        elsif old_row.revision=1 and old_row.values=component->'old' then",
  "          update public.wlf_components set values=component->'incoming',revision=revision+1 where id=old_row.id;",
  "          insert into wlf_private.v220_import_audit(item,decision,before_state) values('component:'||old_row.id,'imported',to_jsonb(old_row));",
  '        else',
  "          insert into wlf_private.v220_import_audit(item,decision,before_state) values('component:'||old_row.id,'preserved: customized',to_jsonb(old_row));",
  '        end if;',
  '      end loop;',
  '      incoming='+json(extra)+';',
  "      if exists(select 1 from public.wlf_components r where r.values->0=incoming->0 and r.values->1=incoming->1 and",
  "          (select bool_and(lower(regexp_replace(btrim(r.values->>i),'[[:space:].-]+','','g'))=lower(regexp_replace(btrim(incoming->>i),'[[:space:].-]+','','g'))) from generate_series(2,5) i)) then",
  "        insert into wlf_private.v220_import_audit(item,decision) values('component:master-055','preserved: matching configuration exists');",
  '      else',
  '        insert into public.wlf_components(values) values(incoming);',
  "        insert into wlf_private.v220_import_audit(item,decision) values('component:master-055','inserted');",
  '      end if;',
  '      update public.wlf_components set values=values||jsonb_build_array(null::text) where jsonb_array_length(values)=23;',
  '    end if;',
  '  end if;',
  '  for key,incoming in select * from jsonb_each('+json(support)+') loop',
  "    if exists(select 1 from wlf_private.v220_import_audit where item='support:'||key) then continue; end if;",
  '    select * into old_form from public.wlf_forms where category=key;',
  '    if not found then',
  '      insert into public.wlf_forms(category,schema) values(key,incoming);',
  "      insert into wlf_private.v220_import_audit(item,decision) values('support:'||key,'inserted');",
  '    elsif old_form.revision=1 and old_form.schema=('+json(oldForms)+')->key then',
  '      update public.wlf_forms set schema=incoming,revision=revision+1 where category=key;',
  "      insert into wlf_private.v220_import_audit(item,decision,before_state) values('support:'||key,'imported',to_jsonb(old_form));",
  '    else',
  "      insert into wlf_private.v220_import_audit(item,decision,before_state) values('support:'||key,'preserved: customized',to_jsonb(old_form));",
  '    end if;',
  '  end loop;',
  'end',
  '$$;',
  "insert into public.wlf_ri_categories(id,section,name,position,schema)",
  "  select id,section,name,position,schema from jsonb_to_recordset("+json(activity)+")",
  "    as c(id text,section text,name text,position int,schema jsonb) on conflict(id) do nothing;",
  "insert into public.wlf_settings(key,value) values('component_master_notes',"+json(workbook.componentNotes.map(n=>n.text))+") on conflict do nothing;"
].join('\n')+'\n';
await fs.writeFile('supabase/release-v220/03-workbooks.sql',sql);
console.log('Workbook defaults:',Object.keys(support).length,'support forms,',activity.length,'activity forms,',mapped.length+1,'component rows');
console.log('Workbook status options:',activity.map(c=>[c.id,c.schema.fields.find(f=>f.id==='status')?.options]));
