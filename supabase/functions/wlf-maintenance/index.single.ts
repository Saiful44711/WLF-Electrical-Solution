// @ts-nocheck
// Server only. No secret belongs in web/config.js or GitHub.
import {createClient} from 'npm:@supabase/supabase-js@2.118.0';
import JSZip from 'npm:jszip@3.10.1';

// ---- Excel workbook writer (from _shared/wlf-excel.mjs)
/* Write Office Open XML tables. All untrusted form text is emitted as inline text cells. */
const excelMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const packageRels = 'http://schemas.openxmlformats.org/package/2006/relationships';
const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const text = value => String(value??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g,'')
  .replace(/[&<>"']/g, char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[char]));
const override = (part,type) => '<Override PartName="/xl/'+part+'" ContentType="'+type+'"/>';
const rel = (id,type,target) => '<Relationship Id="'+id+'" Type="'+office+'/'+type+'" Target="'+target+'"/>';
const relationships = children => '<Relationships xmlns="'+packageRels+'">'+children+'</Relationships>';
function letters(index) {
  let result='';
  for (let n=index+1;n;n=Math.floor((n-1)/26)) result=String.fromCharCode(65+(n-1)%26)+result;
  return result;
}
function unique(label,fallback,seen,limit) {
  const base=(label||fallback).slice(0,limit);
  let name=base, i=1;
  while (seen.has(name.toLowerCase())) {
    const suffix=' ('+(++i)+')';
    name=base.slice(0,limit-suffix.length)+suffix;
  }
  seen.add(name.toLowerCase());
  return name;
}
function cell(value,address) {
  if (typeof value==='number' && Number.isFinite(value)) return '<c r="'+address+'"><v>'+value+'</v></c>';
  if (typeof value==='boolean') return '<c r="'+address+'" t="b"><v>'+Number(value)+'</v></c>';
  const display=Array.isArray(value)?value.join(', '):String(value??'');
  return '<c r="'+address+'" t="inlineStr"><is><t xml:space="preserve">'+text(display.slice(0,32767))+'</t></is></c>';
}

async function buildWorkbook(Zip,groups) {
  if (!groups.length) groups=[{name:'Activity',headers:['Record ID'],rows:[]}];
  const zip = new Zip(), names=new Set(), sheets=[], workbookRelationships=[], overrides=[];
  function add(path,xml) { zip.file(path,declaration+xml); }
  add('_rels/.rels',relationships(rel('rId1','officeDocument','xl/workbook.xml')));
  for (const [index, group] of groups.entries()) {
    const number=index+1, relation='rId'+number, table='WLFTable'+number;
    const file='worksheets/sheet'+number+'.xml', tableFile='tables/table'+number+'.xml';
    const name=unique(String(group.name??'').replace(/[:\\/?*[\]]/g,' ').trim().replace(/^'+|'+$/g,'').trim(),'Sheet '+number,names,31);
    const seen=new Set(), headers=group.headers.map((header,i)=>unique(String(header??'').trim(),'Column '+(i+1),seen,220));
    const rows=[headers,...(group.rows.length?group.rows:[[]])];
    const range='A1:'+letters(headers.length-1)+rows.length;
    sheets.push('<sheet name="'+text(name)+'" sheetId="'+number+'" r:id="'+relation+'"/>');
    workbookRelationships.push(rel(relation,'worksheet',file));
    overrides.push(override(file,'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'),
      override(tableFile,'application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml'));
    const data=rows.map((row,i)=>'<row r="'+(i+1)+'">'+headers.map((_,j)=>cell(row[j],letters(j)+(i+1))).join('')+'</row>').join('');
    const columns=headers.map((header,i)=>'<col min="'+(i+1)+'" max="'+(i+1)+'" width="'+
      Math.max(14,Math.min(43,header.length+4))+'" customWidth="1"/>').join('');
    add('xl/'+file,'<worksheet xmlns="'+main+'" xmlns:r="'+office+'"><dimension ref="'+range+'"/>'+
      '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'+
      '<cols>'+columns+'</cols><sheetData>'+data+'</sheetData><tableParts count="1"><tablePart r:id="rId1"/></tableParts></worksheet>');
    add('xl/worksheets/_rels/sheet'+number+'.xml.rels',relationships(rel('rId1','table','../'+tableFile)));
    add('xl/'+tableFile,'<table xmlns="'+main+'" id="'+number+'" name="'+table+'" displayName="'+table+
      '" ref="'+range+'" totalsRowShown="0"><autoFilter ref="'+range+'"/><tableColumns count="'+headers.length+'">'+
      headers.map((header,i)=>'<tableColumn id="'+(i+1)+'" name="'+text(header)+'"/>').join('')+'</tableColumns>'+
      '<tableStyleInfo name="TableStyleMedium2" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/></table>');
  }
  add('xl/workbook.xml','<workbook xmlns="'+main+'" xmlns:r="'+office+'"><bookViews><workbookView/></bookViews><sheets>'+sheets.join('')+'</sheets></workbook>');
  add('xl/_rels/workbook.xml.rels',relationships(workbookRelationships.join('')));
  add('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'+
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'+
    '<Default Extension="xml" ContentType="application/xml"/>'+
    override('workbook.xml','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml')+
    overrides.join('')+'</Types>');
  return zip.generateAsync({type:'uint8array',compression:'DEFLATE',compressionOptions:{level:3}});
}

const supportNames={
  commissioning:'Commissioning',aftersales:'After Sales',production:'Production',
  maintenance:'Factory Maintenance',qc:'QC',installation:'Installation'
};
const fieldKey=field=>field.id+'\0'+field.label;
function formSheet(name,schema,records,baseHeaders,baseRow,getForm) {
  const columns=new Map();
  for (const form of [schema,...records.map(getForm)]) {
    for (const field of form?.fields||[]) columns.set(fieldKey(field),field.label);
  }
  return {
    name,headers:[...baseHeaders,...columns.values()],
    rows:records.map(record=>{
      const vals=new Map((getForm(record)||schema)?.fields?.map(f=>[fieldKey(f),record.values?.[f.id]])||[]);
      return [...baseRow(record),...Array.from(columns.keys(),key=>vals.get(key)??'')];
    })
  };
}
function supportSheets(categories,tickets) {
  return categories.map(c=>formSheet(supportNames[c.id]||c.name,c.schema,tickets.filter(r=>r.category===c.id),
    ['Request ID','Workflow status','Submitted by','Submitted at (UTC)','Last updated (UTC)','Assigned to','Solved by','Solved at (UTC)','Solution'],
    r=>[r.reference,r.status,r.authorName||r.createdBy,r.createdAt,r.updatedAt,r.assigneeName||r.assignedTo,
      r.solverName||r.solvedBy,r.solvedAt,r.solution],r=>r.formSchema));
}
function activitySheets(categories,entries) {
  return categories.map(c=>formSheet(c.name,c.schema,entries.filter(r=>r.category===c.id),
    ['Entry ID','Recorded status','Submitted by','Submitted at (UTC)','Last updated (UTC)'],
    r=>[r.id,r.status,r.author_name,r.created_at,r.updated_at],r=>r.form_schema));
}
const when=value=>value?String(value):'';
const hwSections={control:'Control system',lop:'LOP',cop:'COP',faceplate:'COP faceplate',transom:'Transom',cable:'Travelling cable',other:'Other components',avr:'AVR'};
function projectSheets(records) {
  const tasks=r=>Array.isArray(r.project?.data?.tasks)?r.project.data.tasks:[];
  const progress=list=>list.length?Math.round(list.reduce((sum,t)=>sum+Number(t.progress||0),0)/list.length):0;
  return [
    {name:'Projects',headers:['Project ID','Project','Status','Lead','Start','End','Created by','Created at (UTC)','Updated at (UTC)','Tasks','Progress %','Brief'],
      rows:records.map(r=>{const d=r.project.data||{};return [r.project.id,d.name,d.status,d.lead,d.start,d.end,r.ownerName,when(r.project.created_at),
        when(r.project.updated_at),tasks(r).length,progress(tasks(r)),d.brief];})},
    {name:'Tasks',headers:['Project','Task','Assignee','Start','End','Status','Progress %'],
      rows:records.flatMap(r=>tasks(r).map(t=>[r.project.data?.name,t.name,t.owner,t.start,t.end,t.status,Number(t.progress||0)]))}
  ];
}
function qmsSheets(records) {
  const lifts=records.map(r=>r.lift);
  return [
    {name:'QMS Lifts',headers:['Lift ID','Project','Address','Delivery date','Motor type','Lift type','Control system','Controller model','Created by','Created at (UTC)','Updated by','Updated at (UTC)','Components'],
      rows:lifts.map(l=>[l.lift_id,l.project,l.address,l.delivery_date,l.motor_type,l.lift_type,l.system,l.controller_model,l.created_name,when(l.created_at),
        l.updated_name,when(l.updated_at),(l.parts||[]).length])},
    {name:'QMS Components',headers:['Lift ID','Project','Section','Group','Hardware','Spec','Item code','Item name','Brand','Supplier','Price (BDT)','Serial'],
      rows:lifts.flatMap(l=>(l.parts||[]).map(p=>[l.lift_id,l.project,hwSections[p.section]||p.section||'',p.grp,p.hardware,p.spec,p.code,p.name,p.brand,p.supplier,
        p.value===null||p.value===undefined||p.value===''?'':Number(p.value),p.serial]))},
    {name:'QMS Serial numbers',headers:['Lift ID','Project','Part','Serial number'],
      rows:lifts.flatMap(l=>Object.entries(l.serials||{}).filter(([,v])=>v).map(([k,v])=>[l.lift_id,l.project,k,v]))}
  ];
}
function demandSheets(records) {
  const d=records.map(r=>r.demand);
  return [{name:'Damage Demand',headers:['Demand no','Request','Team','Project','Lift ID','Requested by','Requested at (UTC)','Controllers','Problem categories','Item name','Item code','Item spec','Quantity',
    'Solution','Duration (min)','Confirmed by','Received by','Received at (UTC)','Supplier claim','Supplier'],
    rows:d.map(x=>[x.demand_no,x.request_reference,x.category,x.project,x.lift_id,x.requester_name,when(x.requested_at),x.controllers,x.problem_categories,x.item_name,x.item_code,
      x.item_spec,x.quantity,x.solution_statement,x.duration_minutes===null?'':Number(x.duration_minutes),x.confirmed_name,x.received_name||'',when(x.received_at),
      x.claim_at?(x.sc_received_at?'Goods received':x.confirm_at?'Confirmed':'Yes'):'No',x.claim_supplier||''])}];
}
function claimSheets(records) {
  const d=records.map(r=>r.demand);
  return [{name:'Supplier Claim',headers:['Demand no','Request','Team','Project','Lift ID','Item name','Item code','Quantity','Supplier','Claim date','Claim raised by','Claim raised at (UTC)',
    'Note','Confirmed by','Confirmed at (UTC)','Goods received by','Goods received at (UTC)'],
    rows:d.map(x=>[x.demand_no,x.request_reference,x.category,x.project,x.lift_id,x.item_name,x.item_code,x.quantity,x.claim_supplier||'',x.claim_date||'',x.claim_name||'',
      when(x.claim_at),x.claim_note||'',x.confirm_name||'',when(x.confirm_at),x.sc_received_name||'',when(x.sc_received_at)])}];
}
function backupSheets(snapshot) {
  if (snapshot.kind==='project') return projectSheets(snapshot.records);
  if (snapshot.kind==='qms') return qmsSheets(snapshot.records);
  if (snapshot.kind==='damage') return demandSheets(snapshot.records);
  if (snapshot.kind==='claim') return claimSheets(snapshot.records);
  if (snapshot.kind==='activity') return activitySheets(snapshot.categories,snapshot.records.map(r=>r.entry));
  return supportSheets(snapshot.categories,snapshot.records.map(item=>{
    const r=item.request;
    return {
      category:r.category,reference:r.reference,status:r.status,values:r.values,formSchema:r.form_schema,
      authorName:item.authorName,assigneeName:item.assigneeName,solverName:item.solverName,
      createdAt:r.created_at,updatedAt:r.updated_at,solvedAt:r.solved_at,solution:r.solution
    };
  }));
}

// ---- Excel backup handler (from _shared/wlf-excel-edge.mjs)
const jsonMime='application/json';
const recoveryFormat='WLF-EXCEL-RECOVERY-2.2';
const encoder=new TextEncoder();
const maxDownload=12000000;
async function excelDigest(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
}
function base64(bytes) {
  let result='';
  for(let offset=0;offset<bytes.length;offset+=32766) {
    result+=btoa(String.fromCharCode(...bytes.subarray(offset,offset+32766)));
  }
  return result;
}
function fileName(run,extension='xlsx') {
  const module={support:'Technical-Support',activity:'RI-Team-Activity',project:'RI-Project',qms:'QMS-Data',damage:'Damage-Demand',claim:'Supplier-Claim'}[run.kind]||'Backup';
  const period=run.date_from?run.date_from+'_to_'+run.date_to:'All-Dates';
  return 'WLF-'+module+'-'+period+'-'+run.id.slice(0,8)+'.'+extension;
}

async function excelMaintenance({action,payload,sql,drive,folder,project,Zip}) {
  const id=payload.id;
  async function readFile(fileId,expected) {
    if(!/^[-a-zA-Z0-9_]{5,200}$/.test(fileId||''))throw Error('A verified backup file was not found.');
    const response=await drive('drive/v3/files/'+encodeURIComponent(fileId)+'?alt=media');
    if(Number(response.headers.get('content-length')||0)>maxDownload)throw Error('Verified file exceeds the download limit.');
    const bytes=new Uint8Array(await response.arrayBuffer());
    if(bytes.length>maxDownload||await excelDigest(bytes)!==expected)throw Error('Google Drive verification failed. No clear was performed.');
    return bytes;
  }
  async function saveFile(bytes,name,mimeType,parent) {
    const boundary='wlf_'+crypto.randomUUID();
    const metadata={name,mimeType,parents:[parent],appProperties:{wlfExcelRun:id}};
    const body=new Blob([
      '--'+boundary+'\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'+JSON.stringify(metadata)+'\r\n',
      '--'+boundary+'\r\nContent-Type: '+mimeType+'\r\n\r\n',bytes,'\r\n--'+boundary+'--\r\n'
    ]);
    const response=await drive('upload/drive/v3/files?uploadType=multipart&fields=id',{
      method:'POST',headers:{'Content-Type':'multipart/related; boundary='+boundary},body
    });
    const file=await response.json(),sha256=await excelDigest(bytes);
    await readFile(file.id,sha256);
    return {id:file.id,sha256};
  }
  const encodeDownload=(run,bytes)=>({run,name:fileName(run),bytes:base64(bytes)});
  if(action==='excelBackup') {
    const nonce=crypto.randomUUID(), snapshot=await sql('prepare',{...payload,nonce});
    if(snapshot.verified) {
      const run=await sql('read',{id});
      return encodeDownload(run,await readFile(run.workbook_id,run.workbook_hash));
    }
    try {
      const bytes=await buildWorkbook(Zip,backupSheets(snapshot));
      if(bytes.length>4000000)throw Error('Workbook is too large. Choose a shorter date range.');
      const run={id,kind:snapshot.kind,date_from:payload.from,date_to:payload.to};
      const parent=await folder(),workbook=await saveFile(bytes,fileName(run),excelMime,parent);
      let recovery;
      if(payload.withClear) {
        const archive={format:recoveryFormat,project,id,kind:run.kind,records:snapshot.records};
        recovery=await saveFile(encoder.encode(JSON.stringify(archive)),fileName(run,'recovery.json'),jsonMime,parent);
      }
      const verified=await sql('verify',{id,nonce,workbookId:workbook.id,workbookHash:workbook.sha256,
        recoveryId:recovery?.id,recoveryHash:recovery?.sha256});
      return encodeDownload(verified,bytes);
    } catch(err) {
      try { await sql('release',{id,nonce}); } catch (_) { /* The short database lease also expires. */ }
      throw err;
    }
  }
  const run=await sql('read',{id});
  if(action==='excelDownload')return encodeDownload(run,await readFile(run.workbook_id,run.workbook_hash));
  if(action==='excelClear') {
    if(payload.confirmed!==true||!run.with_clear)throw Error('Confirm Clear for a verified backup first.');
    if(run.clear_finished)return run;
    await readFile(run.workbook_id,run.workbook_hash);
    await readFile(run.recovery_id,run.recovery_hash);
    return sql('clear',{id});
  }
  if(action==='excelRestore') {
    if(payload.confirmed!==true)throw Error('Confirm recovery before restoring.');
    const archive=JSON.parse(new TextDecoder().decode(await readFile(run.recovery_id,run.recovery_hash)));
    return sql('restore',{id,project,archive});
  }
  throw Error('Unsupported Excel backup action');
}

// ---- Request handler
const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization,x-client-info,apikey,content-type','Access-Control-Allow-Methods':'POST,OPTIONS','Content-Type':'application/json','Cache-Control':'no-store'};
const digest=async(text:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))).map(x=>x.toString(16).padStart(2,'0')).join('');
Deno.serve(async(req)=>{
 if(req.method==='OPTIONS')return new Response('ok',{headers});
 let status=400;
 try{
 if(req.method!=='POST')throw Error('POST required');
 const url=Deno.env.get('SUPABASE_URL')!,keys=JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')||'{}'),key=keys.default||Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
 if(!url||!key)throw Error('Server configuration missing');
 const admin=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
 const token=(req.headers.get('Authorization')||'').replace(/^Bearer\s+/i,'');
 const {data:auth,error:authError}=await admin.auth.getUser(token);if(authError||!auth.user){status=401;throw Error('Sign in required');}
 const {data:me,error:meError}=await admin.from('wlf_profiles').select('id,role,status').eq('id',auth.user.id).single();
 if(meError||me?.role!=='Super Admin'||me?.status!=='Approved'){status=403;throw Error('Super Admin only');}
 if(Number(req.headers.get('content-length')||0)>12000000)throw Error('Request too large');
 const body=await req.json(),action=body.action,p=body.payload||{};
 const project=new URL(url).hostname.split('.')[0];
 async function sql(action:string,payload:any={}){const r=await admin.rpc('wlf_backup_admin',{action,actor:auth.user.id,payload});if(r.error)throw Error(r.error.message);return r.data;}
 async function excelSql(action:string,payload:any={}){const r=await admin.rpc('wlf_excel_admin',{action,actor:auth.user.id,payload});if(r.error)throw Error(r.error.message);return r.data;}
 const clientId=Deno.env.get('WLF_GOOGLE_CLIENT_ID'),clientSecret=Deno.env.get('WLF_GOOGLE_CLIENT_SECRET'),refreshToken=Deno.env.get('WLF_GOOGLE_REFRESH_TOKEN');
 const configured=!!(clientId&&clientSecret&&refreshToken);
 if(action==='status')return new Response(JSON.stringify({...await sql('status'),driveConfigured:configured}),{headers});
 if(action==='deleteRejectedUser'){
 const target=await sql('reserveDeleteUser',{email:p.email});try{const {error}=await admin.auth.admin.deleteUser(target.id);if(error)throw error;}finally{await sql('releaseDeleteUser',{id:target.id});}
 return new Response(JSON.stringify({deleted:true}),{headers});
 }
 if(action==='excelHistory')return new Response(JSON.stringify(await excelSql('history')),{headers});
 if(action==='deleteBackupHistory')return new Response(JSON.stringify(await sql('deleteBackupHistory',p.all?{all:true,confirm:p.confirm}:{id:p.id})),{headers});
 if(action==='excelDeleteHistory')return new Response(JSON.stringify(await excelSql('deleteHistory',p.all?{all:true,confirm:p.confirm}:{id:p.id})),{headers});
 const excelAction=['excelBackup','excelDownload','excelClear','excelRestore'].includes(action);
 if(action==='start')return new Response(JSON.stringify(await sql('start',p)),{headers});
 if(action==='restore'){
 if(JSON.stringify(p.archive||{}).length>10000000)throw Error('Archive part too large');
 return new Response(JSON.stringify(await sql('restore',{archive:p.archive,project})),{headers});}
 if(action==='files')return new Response(JSON.stringify(await sql('files',p)),{headers});
 if(action==='abandon')return new Response(JSON.stringify(await sql('abandon',p)),{headers});
 if(!excelAction&&!['backupPart','downloadPart','clearPart'].includes(action))throw Error('Unsupported action');
 if(!configured)throw Error('Google Drive setup required. Read GOOGLE_DRIVE_SETUP_BN.html in the update package.');
 const tr=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:clientId!,client_secret:clientSecret!,refresh_token:refreshToken!,grant_type:'refresh_token'})});
 const t=await tr.json();if(!tr.ok||!t.access_token)throw Error('Google Drive authorization expired or invalid. Reconnect using the setup guide.');
 async function drive(path:string,init:any={}){const r=await fetch('https://www.googleapis.com/'+path,{...init,headers:{Authorization:'Bearer '+t.access_token,...(init.headers||{})}});if(!r.ok)throw Error('Google Drive request failed ('+r.status+'). Nothing was cleared.');return r;}
 async function driveFolder(){
 const q="mimeType='application/vnd.google-apps.folder' and trashed=false and appProperties has { key='wlfProject' and value='"+project+"' }";
 const folders=await(await drive('drive/v3/files?q='+encodeURIComponent(q)+'&fields=files(id)&pageSize=1')).json();let folder=folders.files?.[0]?.id;
 if(!folder){const r=await drive('drive/v3/files?fields=id',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'WLF Backups — '+project,mimeType:'application/vnd.google-apps.folder',appProperties:{wlfProject:project}})});folder=(await r.json()).id;}
  if(!/^[a-zA-Z0-9_-]+$/.test(folder||''))throw Error('Drive did not return a backup folder ID.');
  return folder;
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
