import fs from 'node:fs/promises';import {build,transform}from'esbuild';import {createHash}from'node:crypto';import './seed-sql.mjs';
await fs.rm('dist',{recursive:true,force:true});await fs.mkdir('dist');
for(const f of ['form-fields.js','ri-workspace.js','damage-demand.js','damage-demand.css','supplier-claim.js','supplier-claim.css','support-layout.css','workspace-overview.js','workspace-overview.css','qr.js','layout-pdf.js','hardware.js','hardware.css','admin-tools.js','admin-tools.css','excel-backup.js','monthly-reports.js','data-backup.js','release-v220.css','maintenance.js','maintenance.css','index.html','style.css','shell.css','support.css','app.js','transport.js','live-workspace.js','troubleshooting.js','troubleshooting.css','appearance.js','company-logo.png','icon-192.png','icon-512.png','app-icon.svg','config.js','component-core.js','pwa.js','push.js','manifest.webmanifest','csp-actions.js','system-status.js'])await fs.copyFile('web/'+f,'dist/'+f);
for(const f of ['logic.js','access-core.js','troubleshooting-core.js','ui-helpers.js'])await fs.copyFile('shared/'+f,'dist/'+f);
await fs.writeFile('dist/support-form-seed.js','var SUPPORT_FORM_SEED='+await fs.readFile('shared/support-forms.json','utf8')+';');
await build({entryPoints:['web/supabase-entry.js'],bundle:true,minify:true,format:'iife',outfile:'dist/supabase.js',target:'es2020'});
await build({entryPoints:['web/exports-entry.js'],bundle:true,minify:true,format:'iife',outfile:'dist/wlf-exports.js',target:'es2020'});
await build({entryPoints:['web/exports-lite-entry.js'],bundle:true,minify:true,format:'iife',outfile:'dist/wlf-exports-lite.js',target:'es2020'});
// v2.5.0 speed: smaller app files (names are kept, so nothing changes in behaviour). config.js stays readable.
for(const f of await fs.readdir('dist')){
 if(['config.js','supabase.js','logic.js','access-core.js','troubleshooting-core.js','ui-helpers.js'].includes(f)||f.startsWith('wlf-exports'))continue; // shared files stay byte-identical
 if(f.endsWith('.js'))await fs.writeFile('dist/'+f,(await transform(await fs.readFile('dist/'+f,'utf8'),{loader:'js',minifyWhitespace:true,minifySyntax:true,legalComments:'none'})).code);
 else if(f.endsWith('.css'))await fs.writeFile('dist/'+f,(await transform(await fs.readFile('dist/'+f,'utf8'),{loader:'css',minify:true})).code);
}
for(const f of ['pdf-reader.mjs','pdf-worker.mjs'])await fs.copyFile('web/'+f,'dist/'+f); // v2.6.9: PDF reader, loaded only when a layout PDF is chosen (not pre-cached)
// the build label in the menu always shows the version of package.json (it was typed by hand before and fell behind at 2.6.7)
{const version=JSON.parse(await fs.readFile('package.json','utf8')).version;const pwa=await fs.readFile('dist/pwa.js','utf8');if(!pwa.includes('__WLF_VERSION__'))throw Error('dist/pwa.js has no __WLF_VERSION__ label');for(const f of ['pwa.js','system-status.js']){const t=await fs.readFile('dist/'+f,'utf8');await fs.writeFile('dist/'+f,t.replaceAll('__WLF_VERSION__',version));}}
const assets=(await fs.readdir('dist')).sort();
const hash=createHash('sha256');
for(const file of assets){hash.update(file+'\0');hash.update(await fs.readFile('dist/'+file));}
const files=assets.filter(f=>!f.startsWith('pdf-')).map(f=>'./'+f);files.push('./');
let sw=await fs.readFile('web/sw.js','utf8');sw=sw.replace('__PRECACHE__',JSON.stringify(files)).replace('__CACHE_HASH__',hash.digest('hex').slice(0,16));await fs.writeFile('dist/sw.js',sw);await fs.writeFile('dist/.nojekyll','');
console.log('Built WLF 2.7.3 Supabase PWA. Configure web/config.js before deployment.');
