// Server only. No secret belongs in web/config.js or GitHub.
import {createClient} from 'npm:@supabase/supabase-js@2.118.0';
import JSZip from 'npm:jszip@3.10.1';
import {excelMaintenance,archiveMaintenance} from '../_shared/wlf-excel-edge.mjs';
import {reportMaintenance} from '../_shared/wlf-report.mjs';
const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization,x-client-info,apikey,content-type,x-wlf-cron','Access-Control-Allow-Methods':'POST,OPTIONS','Content-Type':'application/json','Cache-Control':'no-store'};
const EDGE_VERSION='2.7.4';   // shown on the System status card; must match the app
const digest=async(text:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))).map(x=>x.toString(16).padStart(2,'0')).join('');
Deno.serve(async(req)=>{
 if(req.method==='OPTIONS')return new Response('ok',{headers});
 let status=400;
 try{
 if(req.method!=='POST')throw Error('POST required');
 const url=Deno.env.get('SUPABASE_URL')!,keys=JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')||'{}'),key=keys.default||Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
 if(!url||!key)throw Error('Server configuration missing');
 const admin=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
 // v2.7.0: the monthly schedule (pg_cron + pg_net) calls with its own token instead of a signed-in Super Admin
 const cronToken=req.headers.get('x-wlf-cron')||'';
 let auth:any={user:{id:null}};
 if(cronToken){
  if(!/^[a-f0-9]{48}$/.test(cronToken)){status=401;throw Error('Schedule token rejected');}
 }else{
 const token=(req.headers.get('Authorization')||'').replace(/^Bearer\s+/i,'');
 const r=await admin.auth.getUser(token);if(r.error||!r.data.user){status=401;throw Error('Sign in required');}
 auth=r.data;
 const {data:me,error:meError}=await admin.from('wlf_profiles').select('id,role,status').eq('id',auth.user.id).single();
 if(meError||me?.role!=='Super Admin'||me?.status!=='Approved'){status=403;throw Error('Super Admin only');}
 }
 if(Number(req.headers.get('content-length')||0)>12000000)throw Error('Request too large');
 const body=await req.json(),action=body.action,p=body.payload||{};
 if(cronToken&&action!=='monthlyReports'){status=403;throw Error('Not allowed for the schedule');}
 async function reportSql(a:string,x:any={}){const r=await admin.rpc('wlf_report_admin',{action:a,actor:auth.user.id,payload:cronToken?{...x,token:cronToken}:x});if(r.error)throw Error(r.error.message);return r.data;}
 const selfUrl=url.replace(/\/$/,'')+'/functions/v1/wlf-maintenance';
 const project=new URL(url).hostname.split('.')[0];
 async function sql(action:string,payload:any={}){const r=await admin.rpc('wlf_backup_admin',{action,actor:auth.user.id,payload});if(r.error)throw Error(r.error.message);return r.data;}
async function usageSql(action:string,payload:any={}){const r=await admin.rpc('wlf_usage_admin',{action,actor:auth.user.id,payload});if(r.error)throw Error(r.error.message);return r.data;}
 async function fullSql(action:string,payload:any={}){const r=await admin.rpc('wlf_full_admin',{action,actor:auth.user.id,payload});if(r.error)throw Error(r.error.message);return r.data;}
 async function excelSql(action:string,payload:any={}){const r=await admin.rpc('wlf_excel_admin',{action,actor:auth.user.id,payload});if(r.error)throw Error(r.error.message);return r.data;}
 const clientId=Deno.env.get('WLF_GOOGLE_CLIENT_ID'),clientSecret=Deno.env.get('WLF_GOOGLE_CLIENT_SECRET'),refreshToken=Deno.env.get('WLF_GOOGLE_REFRESH_TOKEN');
 const configured=!!(clientId&&clientSecret&&refreshToken);
 if(action==='version')return new Response(JSON.stringify({edge:EDGE_VERSION,driveConfigured:configured}),{headers});
 if(action==='status')return new Response(JSON.stringify({...await sql('status'),driveConfigured:configured}),{headers});
 if(['reportStatus','reportHistory','reportDeleteHistory','reportSchedule','backupHistory','backupDeleteHistory'].includes(action))
  {const out=await reportMaintenance({action,payload:p,sql:reportSql,selfUrl});return new Response(JSON.stringify(action==='reportStatus'?{...out,driveConfigured:configured}:out),{headers});}
 const reportAction=['reportGenerate','monthlyReports','backupGenerate'].includes(action);
 if(cronToken&&!configured){await reportSql('checked',{error:'Google Drive is not set up'});throw Error('Google Drive setup required');}
 if(action==='deleteRejectedUser'){
 const target=await sql('reserveDeleteUser',{email:p.email});try{const {error}=await admin.auth.admin.deleteUser(target.id);if(error)throw error;}finally{await sql('releaseDeleteUser',{id:target.id});}
 return new Response(JSON.stringify({deleted:true}),{headers});
 }
 if(action==='usageHistory')return new Response(JSON.stringify(await usageSql('history')),{headers});
 if(action==='fullHistory')return new Response(JSON.stringify(await fullSql('history')),{headers});
 if(action==='fullDeleteHistory')return new Response(JSON.stringify(await fullSql('deleteHistory',p.all?{all:true,confirm:p.confirm}:{id:p.id})),{headers});
 if(action==='excelHistory')return new Response(JSON.stringify(await excelSql('history')),{headers});
 if(action==='deleteBackupHistory')return new Response(JSON.stringify(await sql('deleteBackupHistory',p.all?{all:true,confirm:p.confirm}:{id:p.id})),{headers});
 if(action==='excelDeleteHistory')return new Response(JSON.stringify(await excelSql('deleteHistory',p.all?{all:true,confirm:p.confirm}:{id:p.id})),{headers});
 const excelAction=['excelBackup','excelDownload','excelClear','excelRestore'].includes(action);
 const archiveAction=['usageArchive','fullBackup','fullDownload','fullRestore'].includes(action);
 if(action==='start')return new Response(JSON.stringify(await sql('start',p)),{headers});
 if(action==='restore'){
 if(JSON.stringify(p.archive||{}).length>10000000)throw Error('Archive part too large');
 return new Response(JSON.stringify(await sql('restore',{archive:p.archive,project})),{headers});}
 if(action==='files')return new Response(JSON.stringify(await sql('files',p)),{headers});
 if(action==='abandon')return new Response(JSON.stringify(await sql('abandon',p)),{headers});
 if(!excelAction&&!archiveAction&&!reportAction&&!['backupPart','downloadPart','clearPart'].includes(action))throw Error('Unsupported action');
 if(!configured)throw Error('Google Drive setup required. Read GOOGLE_DRIVE_SETUP_BN.html in the update package.');
 const tr=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:clientId!,client_secret:clientSecret!,refresh_token:refreshToken!,grant_type:'refresh_token'})});
 const t=await tr.json();if(!tr.ok||!t.access_token)throw Error('Google Drive authorization expired or invalid. Reconnect using the setup guide.');
 async function drive(path:string,init:any={}){const r=await fetch('https://www.googleapis.com/'+path,{...init,headers:{Authorization:'Bearer '+t.access_token,...(init.headers||{})}});if(!r.ok)throw Error('Google Drive request failed ('+r.status+'). Nothing was cleared.');return r;}
 /* v2.7.2: monthly files live in one main folder each: "Monthly Analysis Report" (3 report folders) and
    "Monthly Excel Backup" (one folder per category). Folders are found by a hidden mark, not by name; an old
    report folder from v2.7.0 is moved into the main folder with its files. */
 const FOLDERS:any={backup:['wlfProject','WLF Backups — '],activity:['wlfActivityProject','WLF Activity backup — '],full:['wlfFullProject','WLF Full Backup — '],
  reportRoot:['wlfReportRoot','Monthly Analysis Report'],
  reportSupport:['wlfReportSupport','Technical Support Monthly Report','reportRoot'],reportActivity:['wlfReportActivity','R&I Team Activity Monthly Report','reportRoot'],reportDamage:['wlfReportDamage','Damage Demand Monthly Report','reportRoot'],
  backupRoot:['wlfMonthlyBackupRoot','Monthly Excel Backup'],
  mb_support:['wlfMonthlyBackupSupport','Technical Support','backupRoot'],mb_activity:['wlfMonthlyBackupActivity','R&I Team Activity','backupRoot'],
  mb_project:['wlfMonthlyBackupProject','R&I Project Manager','backupRoot'],mb_qms:['wlfMonthlyBackupQms','QMS Data','backupRoot'],
  mb_damage:['wlfMonthlyBackupDamage','Damage Demand','backupRoot'],mb_claim:['wlfMonthlyBackupClaim','Supplier Claim','backupRoot']};
 const folderCache:any={};
 async function driveFolder(kind='backup'):Promise<string>{
 if(folderCache[kind])return folderCache[kind];
 const cfg=FOLDERS[kind];if(!cfg)throw Error('Unknown Drive folder');
 const parent=cfg[2]?await driveFolder(cfg[2]):null;
 const q="mimeType='application/vnd.google-apps.folder' and trashed=false and appProperties has { key='"+cfg[0]+"' and value='"+project+"' }";
 const found=(await(await drive('drive/v3/files?q='+encodeURIComponent(q)+'&fields=files(id,parents)&pageSize=1')).json()).files?.[0];
 let folder=found?.id;
 if(folder&&parent&&!(found.parents||[]).includes(parent)){
  await drive('drive/v3/files/'+encodeURIComponent(folder)+'?addParents='+encodeURIComponent(parent)+((found.parents||[]).length?'&removeParents='+encodeURIComponent(found.parents.join(',')):'')+'&fields=id',{method:'PATCH',headers:{'Content-Type':'application/json'},body:'{}'});
 }
 if(!folder){const plain=kind.startsWith('report')||kind.startsWith('mb_')||kind==='backupRoot';
  const r=await drive('drive/v3/files?fields=id',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:cfg[1]+(plain?'':project),mimeType:'application/vnd.google-apps.folder',appProperties:{[cfg[0]]:project},...(parent?{parents:[parent]}:{})})});folder=(await r.json()).id;}
  if(!/^[a-zA-Z0-9_-]+$/.test(folder||''))throw Error('Drive did not return a backup folder ID.');
  return folderCache[kind]=folder;
 }
 /* v2.7.2: one monthly Excel backup (previous month, never clears) in the name of a Super Admin */
 async function backupOne(kind:string,month:string,from:string,to:string,actor:string){
  const exSql=async(a:string,x:any={})=>{const r=await admin.rpc('wlf_excel_admin',{action:a,actor,payload:x});if(r.error)throw Error(r.error.message);return r.data;};
  const id=crypto.randomUUID();
  const res=await excelMaintenance({action:'excelBackup',payload:{kind,from,to,withClear:false,id},sql:exSql,drive,folder:()=>driveFolder('mb_'+kind),project,Zip:JSZip,monthly:month});
  const saved=await reportSql('backupSaved',{id,month});
  for(const old of saved?.replaced||[]){if(/^[-a-zA-Z0-9_]{5,200}$/.test(old||''))try{await drive('drive/v3/files/'+encodeURIComponent(old),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({trashed:true})});}catch(_){/* already removed by hand */}}
  return {kind,month,backup:true,fileName:res.name,records:res.records};
 }
 if(reportAction){
  const backup=async(kind:string,month:string,from:string,to:string)=>backupOne(kind,month,from,to,cronToken?(await reportSql('backupActor')).actor:auth.user.id);
  const result=await reportMaintenance({action,payload:p,sql:reportSql,drive,folderFor:driveFolder,Zip:JSZip,selfUrl,backup});
  return new Response(JSON.stringify(result),{headers});
 }
 if(archiveAction){
  const result=await archiveMaintenance({action,payload:p,usageSql,fullSql,drive,folderFor:driveFolder,project,Zip:JSZip});
  return new Response(JSON.stringify(result),{headers});
 }
 if(excelAction){
  const result=await excelMaintenance({action,payload:p,sql:excelSql,drive,folder:driveFolder,project,Zip:JSZip});
  return new Response(JSON.stringify(result),{headers});
 }
 async function verifiedFile(){const f=await sql('download',p);if(!f?.verified||!f.file_id)throw Error('Verified archive part not found');const r=await drive('drive/v3/files/'+encodeURIComponent(f.file_id)+'?alt=media');const text=await r.text();if(await digest(text)!==f.sha256)throw Error('Backup integrity mismatch. Clear blocked.');const data=JSON.parse(text);if(data.project!==project||data.run!==p.id||data.batch!==p.batch)throw Error('Backup identity mismatch. Clear blocked.');return {text,data};}
 if(action==='downloadPart'){const f=await verifiedFile();return new Response(f.text,{headers});}
 if(action==='clearPart'){await verifiedFile();return new Response(JSON.stringify(await sql('clear',p)),{headers});}
 const nonce=crypto.randomUUID(),archive=await sql('prepare',{...p,project,nonce});
 if(archive.alreadyVerified)return new Response(JSON.stringify({alreadyVerified:true}),{headers});
 const text=JSON.stringify(archive),bytes=new TextEncoder().encode(text);if(bytes.length>8000000)throw Error('Archive part exceeds safe server memory limit. Nothing was cleared.');
 const folder=await driveFolder();
 const boundary='wlf_'+crypto.randomUUID(),meta={name:'WLF-Support-'+archive.run+'-part-'+p.batch+'.json',parents:[folder],mimeType:'application/json'};
 const multipart='--'+boundary+'\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'+JSON.stringify(meta)+'\r\n--'+boundary+'\r\nContent-Type: application/json\r\n\r\n'+text+'\r\n--'+boundary+'--';
 const upload=await drive('upload/drive/v3/files?uploadType=multipart&fields=id',{method:'POST',headers:{'Content-Type':'multipart/related; boundary='+boundary},body:multipart});
 const file=await upload.json();if(!/^[a-zA-Z0-9_-]+$/.test(file.id||''))throw Error('Drive did not return an archive ID');
 const saved=await(await drive('drive/v3/files/'+file.id+'?alt=media')).text(),sha256=await digest(text);
 if(await digest(saved)!==sha256)throw Error('Uploaded backup failed integrity verification. Nothing was cleared.');
 await sql('verify',{...p,nonce,fileId:file.id,sha256});
 return new Response(JSON.stringify({verified:true,fileId:file.id,sha256,records:archive.records.length}),{headers});
 }catch(e){return new Response(JSON.stringify({error:(e as Error).message}),{status,headers});}
});
