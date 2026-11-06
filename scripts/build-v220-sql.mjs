import fs from 'node:fs/promises';

const dir = 'supabase/release-v220/';
const names = (await fs.readdir(dir)).filter(name => /^\d\d-.*\.sql$/.test(name)).sort();
const contents = await Promise.all(names.map(name => fs.readFile(dir + name,'utf8')));
const sql = '-- WLF v2.2.0 upgrade. Run in the existing v2.1 Supabase project.\n'
  + 'begin;\n' + contents.join('\n') + '\ncommit;\n';
await fs.writeFile('supabase/UPDATE_V220.sql',sql);
