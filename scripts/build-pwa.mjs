import fs from 'node:fs/promises';import {build}from'esbuild';import './seed-sql.mjs';
await fs.rm('dist',{recursive:true,force:true});await fs.mkdir('dist');
for(const f of ['index.html','style.css','shell.css','support.css','app.js','transport.js','live-workspace.js','troubleshooting.js','troubleshooting.css','appearance.js','company-logo.png','icon-192.png','icon-512.png','app-icon.svg','config.js','component-core.js','pwa.js','manifest.webmanifest'])await fs.copyFile('web/'+f,'dist/'+f);
for(const f of ['logic.js','access-core.js','troubleshooting-core.js','ui-helpers.js'])await fs.copyFile('shared/'+f,'dist/'+f);
await fs.writeFile('dist/support-form-seed.js','var SUPPORT_FORM_SEED='+await fs.readFile('shared/support-forms.json','utf8')+';');
await build({entryPoints:['web/supabase-entry.js'],bundle:true,minify:true,format:'iife',outfile:'dist/supabase.js',target:'es2020'});
const files=(await fs.readdir('dist')).map(f=>'./'+f);files.push('./');
let sw=await fs.readFile('web/sw.js','utf8');sw=sw.replace('__PRECACHE__',JSON.stringify(files));await fs.writeFile('dist/sw.js',sw);await fs.writeFile('dist/.nojekyll','');
console.log('Built WLF 2.0.0 Supabase PWA. Configure web/config.js before deployment.');
