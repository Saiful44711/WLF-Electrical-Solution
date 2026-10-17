import fs from 'node:fs/promises';
const sql=v=>"'"+JSON.stringify(v).replaceAll("'","''")+"'::jsonb",str=v=>"'"+v.replaceAll("'","''")+"'";
const components=JSON.parse(await fs.readFile('data/component-source.json','utf8')),forms=JSON.parse(await fs.readFile('shared/support-forms.json','utf8')),tb=JSON.parse(await fs.readFile('web/troubleshooting-seed.json','utf8'));
let out='-- WLF reference seed: insert only; NEVER replaces edited production rows.\nbegin;\n';
out+=`insert into public.wlf_settings(key,value)values('component_headers',${sql(components.headers)})on conflict do nothing;\n`;
for(const r of components.records)out+=`insert into public.wlf_components(id,values)values(${r.id},${sql(r.values)})on conflict do nothing;\n`;
out+="select setval(pg_get_serial_sequence('public.wlf_components','id'),greatest((select coalesce(max(id),1)from public.wlf_components),1));\n";
for(const [c,f]of Object.entries(forms))out+=`insert into public.wlf_forms(category,schema)values(${str(c)},${sql(f)})on conflict do nothing;\n`;
for(const e of [...tb.entries,...(tb.general||[]),...(tb.procedures||[])]){const key=e.controller==='GENERAL'||e.kind==='procedure'?'procedure:'+e.category.toLowerCase().replace(/[^a-z0-9]+/g,''):e.code;out+=`insert into public.wlf_troubleshooting(id,controller,option_key,content,revision)values(${str(e.id)},${str(e.controller)},${str(key)},${sql(e)},${e.revision||1})on conflict do nothing;\n`;}
out+='commit;\n';await fs.writeFile('supabase/seed.sql',out);
await fs.writeFile('supabase/01_SETUP.sql',(await fs.readFile('supabase/schema.sql','utf8'))+'\n'+await fs.readFile('supabase/api.sql','utf8')+'\n'+out);
console.log('Generated SQL with',components.records.length,'components,',tb.entries.length,'errors,',Object.keys(forms).length,'forms');
