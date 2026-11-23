import {backupSheets,buildWorkbook,excelMime} from './wlf-excel.mjs';

const jsonMime='application/json';
const recoveryFormat='WLF-EXCEL-RECOVERY-2.2';
const encoder=new TextEncoder();
const maxDownload=12000000;
async function digest(bytes) {
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

export async function excelMaintenance({action,payload,sql,drive,folder,project,Zip}) {
  const id=payload.id;
  async function readFile(fileId,expected) {
    if(!/^[-a-zA-Z0-9_]{5,200}$/.test(fileId||''))throw Error('A verified backup file was not found.');
    const response=await drive('drive/v3/files/'+encodeURIComponent(fileId)+'?alt=media');
    if(Number(response.headers.get('content-length')||0)>maxDownload)throw Error('Verified file exceeds the download limit.');
    const bytes=new Uint8Array(await response.arrayBuffer());
    if(bytes.length>maxDownload||await digest(bytes)!==expected)throw Error('Google Drive verification failed. No clear was performed.');
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
    const file=await response.json(),sha256=await digest(bytes);
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

// ---- v2.6.3: Activity log archive and Backup of all other data (own Google Drive folders)
const fullFormat='WLF-FULL-2.6.3';
const dhaka=value=>new Date(value).toLocaleString('en-GB',{timeZone:'Asia/Dhaka',hour12:false});
async function driveRead(drive,fileId,expected) {
  if(!/^[-a-zA-Z0-9_]{5,200}$/.test(fileId||''))throw Error('A verified backup file was not found.');
  const response=await drive('drive/v3/files/'+encodeURIComponent(fileId)+'?alt=media');
  const bytes=new Uint8Array(await response.arrayBuffer());
  if(bytes.length>maxDownload||await digest(bytes)!==expected)throw Error('Google Drive verification failed.');
  return bytes;
}
async function driveSave(drive,bytes,name,mimeType,parent) {
  const boundary='wlf_'+crypto.randomUUID();
  const body=new Blob([
    '--'+boundary+'\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'+JSON.stringify({name,mimeType,parents:[parent]})+'\r\n',
    '--'+boundary+'\r\nContent-Type: '+mimeType+'\r\n\r\n',bytes,'\r\n--'+boundary+'--\r\n'
  ]);
  const response=await drive('upload/drive/v3/files?uploadType=multipart&fields=id',{method:'POST',headers:{'Content-Type':'multipart/related; boundary='+boundary},body});
  const file=await response.json(),sha256=await digest(bytes);
  await driveRead(drive,file.id,sha256);
  return {id:file.id,sha256};
}
export async function archiveMaintenance({action,payload,usageSql,fullSql,drive,folderFor,project,Zip}) {
  if(action==='usageArchive') {
    const snapshot=await usageSql('prepare');
    if(!snapshot.count)return {archived:0,remaining:0};
    const sheet={name:'Activity log',headers:['When (Dhaka)','User','Activity','Details'],
      rows:snapshot.rows.map(r=>[dhaka(r.at),r.who,r.action,r.details])};
    const bytes=await buildWorkbook(Zip,[sheet]);
    if(bytes.length>8000000)throw Error('The activity log file is too large. Nothing was deleted.');
    const stamp=d=>String(d).slice(0,10);
    const name='WLF-Activity-Log-'+stamp(snapshot.from)+'_to_'+stamp(snapshot.to)+'-'+crypto.randomUUID().slice(0,8)+'.xlsx';
    const saved=await driveSave(drive,bytes,name,excelMime,await folderFor('activity'));
    const done=await usageSql('finish',{maxId:snapshot.maxId,count:snapshot.count,cutoff:snapshot.cutoff,fileId:saved.id,sha256:saved.sha256});
    return {archived:done.deleted,remaining:snapshot.remaining};
  }
  if(action==='fullBackup') {
    const snapshot=await fullSql('export');
    const archive={format:fullFormat,project,created_at:new Date().toISOString(),id:snapshot.id,counts:snapshot.counts,tables:snapshot.tables};
    const bytes=encoder.encode(JSON.stringify(archive));
    if(bytes.length>maxDownload)throw Error('The backup file is too large to send. Nothing was changed.');
    const name='WLF-Backup-'+new Date().toISOString().slice(0,10)+'-'+snapshot.id.slice(0,8)+'.json';
    const saved=await driveSave(drive,bytes,name,jsonMime,await folderFor('full'));
    await fullSql('record',{id:snapshot.id,fileId:saved.id,sha256:saved.sha256,bytes:bytes.length,counts:snapshot.counts});
    return {id:snapshot.id,name,bytes:base64(bytes),counts:snapshot.counts};
  }
  if(action==='fullDownload'||action==='fullRestore') {
    if(action==='fullRestore'&&payload.confirmed!==true)throw Error('Confirm the restore first.');
    let archiveBytes,name='WLF-Backup.json';
    if(action==='fullRestore'&&payload.archive) {
      if(payload.archive.project&&payload.archive.project!==project)throw Error('This backup belongs to another project.');
      return fullSql('restore',{archive:payload.archive});
    }
    const run=await fullSql('read',{id:payload.id});
    archiveBytes=await driveRead(drive,run.file_id,run.sha256);
    if(action==='fullDownload')return {id:run.id,name:'WLF-Backup-'+String(run.created_at).slice(0,10)+'-'+run.id.slice(0,8)+'.json',bytes:base64(archiveBytes),counts:run.counts};
    const archive=JSON.parse(new TextDecoder().decode(archiveBytes));
    if(archive.project&&archive.project!==project)throw Error('This backup belongs to another project.');
    return fullSql('restore',{archive});
  }
  throw Error('Unsupported backup action');
}
