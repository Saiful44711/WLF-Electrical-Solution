import fs from 'node:fs/promises';import {build}from'esbuild';import {createHash}from'node:crypto';import './seed-sql.mjs';
await fs.rm('dist',{recursive:true,force:true});await fs.mkdir('dist');
for(const f of ['form-fields.js','ri-workspace.js','damage-demand.js','damage-demand.css','excel-backup.js','release-v220.css','maintenance.js','maintenance.css','index.html','style.css','shell.css','support.css','app.js','transport.js','live-workspace.js','troubleshooting.js','troubleshooting.css','appearance.js','company-logo.png','icon-192.png','icon-512.png','app-icon.svg','config.js','component-core.js','pwa.js','manifest.webmanifest'])await fs.copyFile('web/'+f,'dist/'+f);
for(const f of ['logic.js','access-core.js','troubleshooting-core.js','ui-helpers.js'])await fs.copyFile('shared/'+f,'dist/'+f);
await fs.writeFile('dist/support-form-seed.js','var SUPPORT_FORM_SEED='+await fs.readFile('shared/support-forms.json','utf8')+';');
await build({entryPoints:['web/supabase-entry.js'],bundle:true,minify:true,format:'iife',outfile:'dist/supabase.js',target:'es2020'});
await build({entryPoints:['web/exports-entry.js'],bundle:true,minify:true,format:'iife',outfile:'dist/wlf-exports.js',target:'es2020'});
const assets=(await fs.readdir('dist')).sort();
const hash=createHash('sha256');
for(const file of assets){hash.update(file+'\0');hash.update(await fs.readFile('dist/'+file));}
const files=assets.map(f=>'./'+f);files.push('./');
let sw=await fs.readFile('web/sw.js','utf8');sw=sw.replace('__PRECACHE__',JSON.stringify(files)).replace('__CACHE_HASH__',hash.digest('hex').slice(0,16));await fs.writeFile('dist/sw.js',sw);await fs.writeFile('dist/.nojekyll','');
console.log('Built WLF 2.2.0 Supabase PWA. Configure web/config.js before deployment.');
