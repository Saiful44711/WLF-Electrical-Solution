/* Builds ONE self-contained index.ts for the wlf-maintenance Edge Function, so it can be pasted
   into the Supabase dashboard editor (the editor cannot import ../_shared files).
   Usage: node scripts/bundle-maintenance.mjs <output file> */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','supabase','functions');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

export function bundle() {
  const excel=read('_shared/wlf-excel.mjs').replace(/^export /gm,'');
  const edge=read('_shared/wlf-excel-edge.mjs').replace(/^import [^;]+;\s*/m,'').replace(/^export /gm,'').replace(/(?<![.\w])digest\b/g,'excelDigest');
  const index=read('wlf-maintenance/index.ts');
  const importLine=/^import \{excelMaintenance,archiveMaintenance\} from '\.\.\/_shared\/wlf-excel-edge\.mjs';\r?\n/m;
  if(!importLine.test(index))throw Error('index.ts no longer imports excelMaintenance the expected way');
  const block=index.match(/^(?:import [^\n]+\n)+/m);
  const head=index.slice(0,block.index)+block[0].replace(importLine,'');
  const rest=index.slice(block.index+block[0].length);
  const out=head+'\n// ---- Excel workbook writer (from _shared/wlf-excel.mjs)\n'+excel+'\n// ---- Excel backup handler (from _shared/wlf-excel-edge.mjs)\n'+edge+'\n// ---- Request handler\n'+rest;
  const left=out.match(/.{0,40}from '\.\.?\/.{0,40}/);if(left)throw Error('A relative import is left in the bundle: '+left[0]);
  return '// @ts-nocheck\n'+out;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  const target=process.argv[2];
  if(!target)throw Error('Give the output file path');
  fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.writeFileSync(target,bundle());
  console.log('Wrote '+target);
}
