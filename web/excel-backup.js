/* Excel backup UI inside the existing Super Admin Storage & Backup page. */
const WlfExcelBackup=(()=>{
  'use strict';
  const h=value=>esc(String(value??''));
  const moduleNames={support:'Technical Support',activity:'R&I Team Activity',project:'R&I Project Manager',qms:'QMS data',damage:'Damage Demand',claim:'Supplier Claim'};
  const clearText={support:'Solved support requests',activity:'Completed or Solved activity entries',project:'projects whose status is Done',
    qms:'QMS lift records (every lift in this backup)',damage:'demands that are Received (and, if sent to the supplier, whose claim goods are Received)',
    claim:'supplier claims whose goods are Received'};
  const today=()=>AccessCore.dateKey(new Date());
  function mount(root,api) {
    let retry=null;
    const account=T();
    root.innerHTML='<section class="card wlf-module" id="wlfBackupCard"><div><h3>Backup</h3>'+
      '<p class="note">One place for every backup. <b>Work data</b>: choose a period, then press a button to download an Excel workbook and save a verified copy in Google Drive. Technical Support, R&amp;I Team Activity, R&amp;I Project Manager, QMS data (every output table, lift by lift), Damage Demand and Supplier Claim each get their own workbook; these can also be cleared after the backup. <b>Settings and reference data</b> (further down this card) are backed up only and are never cleared.</p></div>'+
      '<div class="wlf-period"><label>Period<select id="wlfExcelPeriod"><option value="all">All dates</option><option value="year">Last 12 months</option>'+
      '<option value="custom">From date → To date</option></select></label><label>From date<input id="wlfExcelFrom" type="date" disabled></label>'+
      '<label>To date<input id="wlfExcelTo" type="date" disabled></label></div>'+
      '<div class="wlf-choice-list"><label class="wlf-choice"><input type="radio" name="wlfExcelMode" value="keep" checked> Backup without Clear</label>'+
      '<label class="wlf-choice"><input type="radio" name="wlfExcelMode" value="clear"> Backup with Clear</label></div>'+
      '<div class="wlf-tools-actions">'+Object.keys(moduleNames).map((k,i)=>'<button type="button" class="btn'+(i?' ghost':'')+'" data-excel-kind="'+k+'">'+h(moduleNames[k])+'</button>').join('')+'</div>'+
      '<p class="note">Period uses the created date in Bangladesh time (Supplier Claim: the date the claim was raised). Backup without Clear never removes anything. Backup with Clear removes a record only after the Excel file and a recovery copy are saved and verified on Google Drive, and only if it was not changed afterwards: Solved support requests, Completed or Solved activity entries, Done projects, all QMS lifts of the period, Received demands and Received supplier claims. Every backup is also downloaded to this computer.</p>'+
      '<div id="wlfExcelStatus" role="status" aria-live="polite"></div>'+
      '<div id="wlfFullBackup" style="margin-top:22px;padding-top:18px;border-top:1px solid var(--line,rgba(128,128,128,.35))"><h4 style="margin:0 0 6px">Settings and reference data</h4>'+
      '<p class="note">Saved as one file in its own Google Drive folder (WLF Full Backup) and downloaded to this computer: users and access (for reference), settings, support forms, R&amp;I categories, Troubleshooting, Components Data, Documents Links, Hardware Catalogue and announcements. '+
      'This part is backup only: Clear never touches it. Restore only adds what is missing and never deletes. Accounts belong to Supabase Auth and are not restored here.</p>'+
      '<div class="wlf-tools-actions"><button type="button" class="btn" id="wlfFullNow">Backup now</button>'+
      '<label class="btn ghost" for="wlfFullFile" style="cursor:pointer;text-transform:none;letter-spacing:normal">Restore from a backup file</label><input type="file" id="wlfFullFile" accept=".json,application/json" hidden>'+
      '<button type="button" class="btn ghost" id="wlfFullDeleteAll">Delete all history</button></div>'+
      '<div id="wlfFullStatus" role="status" aria-live="polite"></div>'+
      '</div></section>'+
      '<section class="card"><div class="wlf-tools-actions" style="justify-content:space-between"><h3>Backup history · work data</h3><button type="button" class="btn ghost" id="wlfExcelDeleteAll">Delete all history</button></div>'+
      '<p class="note">Deleting history only removes the list entry here. The files already saved in Google Drive stay there. A deleted entry can no longer download, review Clear or restore from this page.</p>'+
      '<div id="wlfExcelHistory" aria-live="polite">Loading Excel history…</div></section>'+
      '<section class="card"><h3>Backup history · settings and reference data</h3><div id="wlfFullHistory" aria-live="polite">Loading backup history…</div></section>';
    const get=selector=>root.querySelector(selector);
    const period=get('#wlfExcelPeriod'),from=get('#wlfExcelFrom'),to=get('#wlfExcelTo');
    const current=()=>root.isConnected&&T()===account;
    const status=(message,error=false)=>{
      if(!current())return;
      const node=get('#wlfExcelStatus');
      node.textContent=message;node.classList.toggle('error',error);
    };
    function selectPeriod() {
      const custom=period.value==='custom';
      from.disabled=to.disabled=!custom;
      if(period.value==='all')from.value=to.value='';
      else if(period.value==='year'){
        const end=today(),start=new Date(end+'T00:00:00Z');
        start.setUTCFullYear(start.getUTCFullYear()-1);
        if(start.toISOString().slice(5,10)!==end.slice(5,10))start.setUTCDate(0);
        from.value=start.toISOString().slice(0,10);to.value=end;
      }else if(!to.value)to.value=today();
    }
    period.onchange=selectPeriod;
    function download(result) {
      const binary=atob(result.bytes), bytes=new Uint8Array(binary.length);
      for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
      WlfExports.download(bytes,result.name);
    }
    async function history() {
      try{
        const runs=await api.edge('excelHistory');
        if(!current())return;
        const pane=get('#wlfExcelHistory');
        pane.innerHTML='<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Saved (Dhaka)</th><th>Module</th><th>Period</th>'+
          '<th>Records</th><th>Cleared</th><th>State</th><th>Actions</th></tr></thead><tbody>'+
          (runs.map(run=>'<tr><td>'+h(new Date(run.created_at).toLocaleString('en-GB',{timeZone:'Asia/Dhaka'}))+
            '</td><td>'+h(moduleNames[run.kind])+'</td><td>'+h(run.date_from?run.date_from+' → '+run.date_to:'All dates')+
            '</td><td>'+Number(run.total)+'</td><td>'+Number(run.cleared)+'</td><td>'+
            (run.restored_at?'Restored':run.clear_finished?'Clear reviewed':run.with_clear?'Verified · Clear available':'Verified on Drive')+
            '</td><td><div class="wlf-tools-actions">'+historyButton('Download Excel','download',run)+
            (run.with_clear&&!run.clear_finished&&run.actor===account?historyButton('Review Clear','clear',run):'')+
            (run.cleared>0&&!run.restored_at?historyButton('Restore recovery copy','restore',run):'')+historyButton('Delete','delete',run)+'</div></td></tr>').join('')||
            '<tr><td colspan="7">No verified Excel backups yet.</td></tr>')+'</tbody></table></div>';
        pane.querySelectorAll('[data-excel-action]').forEach(b=>{
          b.disabled=api.busy();
          b.onclick=()=>runHistory(b.dataset.excelAction,runs.find(run=>run.id===b.dataset.excelId));
        });
      }catch(err){if(current())get('#wlfExcelHistory').textContent=err.message;}
    }
    function historyButton(label,action,run) {
      return '<button class="btn ghost" type="button" data-excel-action="'+action+'" data-excel-id="'+h(run.id)+'">'+label+'</button>';
    }
    async function clear(run) {
      const eligible=clearText[run.kind]||'records';
      if(!confirm('Clear eligible '+eligible+' from this verified workbook? Records changed since the backup will be kept.'))return;
      status('Checking the workbook and recovery copy on Drive…');
      const result=await api.edge('excelClear',{id:run.id,confirmed:true});
      status(result.cleared+' record(s) cleared · '+(result.total-result.cleared)+' kept.');
      LiveWorkspace.refreshNotifications();
    }
    async function runHistory(action,run) {
      if(api.busy()||!current()||!run)return;
      api.lock(true);
      try{
        if(action==='delete'){
          const open=run.with_clear&&run.cleared>0&&!run.restored_at;
          if(!confirm('Delete this backup from the history list?'+(open?'\n\nWarning: it cleared '+run.cleared+' record(s) and they are not restored yet. After deleting, this page can no longer restore them (the recovery file stays in Google Drive).':'')+'\n\nThe files in Google Drive are not deleted.'))return;
          await api.edge('excelDeleteHistory',{id:run.id});
          status('Backup history entry deleted.');
        }else if(action==='restore'){
          if(!confirm('Restore the records cleared by this backup from its verified recovery copy?'))return;
          status('Restoring from Drive…');
          const result=await api.edge('excelRestore',{id:run.id,confirmed:true});
          status(result.restored+' record(s) restored.');
          LiveWorkspace.refreshNotifications();
        }else{
          status('Downloading the verified workbook…');
          download(await api.edge('excelDownload',{id:run.id}));
          status('Excel download started.');
          if(action==='clear')await clear(run);
        }
      }catch(err){status(err.message,true);}
      finally{try{if(current())await history();}finally{api.lock(false);}}
    }
    async function start(kind) {
      if(!current())return;
      if(api.busy()){status('Another backup is still running. Wait a moment and try again.',true);return;}
      if(!api.configured){status('Configure Google Drive before starting an Excel backup.',true);return;}
      const withClear=get('input[name=wlfExcelMode]:checked').value==='clear';
      const payload={kind,from:from.value,to:to.value,withClear};
      if(period.value!=='all'&&(!payload.from||!payload.to||payload.from>payload.to)){
        status('Enter a valid From and To date.',true);return;
      }
      const key=JSON.stringify(payload);
      if(retry?.key!==key)retry={key,id:crypto.randomUUID()};
      api.lock(true);
      try{
        status('Building and verifying the workbook in Google Drive…');
        const result=await api.edge('excelBackup',{...payload,id:retry.id});
        retry=null;
        download(result);
        status('Excel download started. A verified copy was saved to Google Drive.');
        if(current()&&withClear&&result.run.total)await clear(result.run);
      }catch(err){status(err.message,true);}
      finally{try{if(current())await history();}finally{api.lock(false);}}
    }
    get('#wlfExcelDeleteAll').onclick=async()=>{
      if(api.busy()||!current())return;
      const typed=prompt('Delete ALL Excel backup history entries?\nFiles in Google Drive are not deleted, but recovery from this page will no longer be possible.\n\nType DELETE to continue.');
      if(typed===null)return;
      api.lock(true);
      try{
        const result=await api.edge('excelDeleteHistory',{all:true,confirm:typed.trim()});
        status(result.deleted+' history entr'+(result.deleted===1?'y':'ies')+' deleted.');
      }catch(err){status(err.message,true);}
      finally{try{if(current())await history();}finally{api.lock(false);}}
    };
    const fullStatus=(message,error=false)=>{
      if(!current())return;
      const node=get('#wlfFullStatus');node.textContent=message;node.classList.toggle('error',error);
    };
    const total=counts=>Object.values(counts||{}).reduce((sum,n)=>sum+Number(n||0),0);
    const kb=bytes=>(Number(bytes)/1024<1024?(Number(bytes)/1024).toFixed(0)+' KB':(Number(bytes)/1048576).toFixed(1)+' MB');
    function saveJson(result) {
      const binary=atob(result.bytes), bytes=new Uint8Array(binary.length);
      for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
      WlfExports.download(bytes,result.name);
    }
    async function fullHistory() {
      try{
        const runs=await api.edge('fullHistory');
        if(!current())return;
        const pane=get('#wlfFullHistory');
        pane.innerHTML='<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Saved (Dhaka)</th><th>Records</th><th>Size</th><th>Actions</th></tr></thead><tbody>'+
          (runs.map(run=>'<tr><td>'+h(new Date(run.created_at).toLocaleString('en-GB',{timeZone:'Asia/Dhaka'}))+'</td><td>'+total(run.counts)+'</td><td>'+kb(run.bytes)+
            '</td><td><div class="wlf-tools-actions"><button type="button" class="btn ghost" data-full-action="download" data-id="'+h(run.id)+'">Download</button>'+
            '<button type="button" class="btn ghost" data-full-action="restore" data-id="'+h(run.id)+'">Restore missing data</button>'+
            '<button type="button" class="btn ghost" data-full-action="delete" data-id="'+h(run.id)+'">Delete</button></div></td></tr>').join('')||
            '<tr><td colspan="4">No backups yet.</td></tr>')+'</tbody></table></div>';
        pane.querySelectorAll('[data-full-action]').forEach(b=>{b.onclick=()=>fullRun(b.dataset.fullAction,b.dataset.id);});
      }catch(err){if(current())get('#wlfFullHistory').textContent=err.message;}
    }
    const restoredText=out=>Object.entries(out.restored||{}).filter(([,n])=>n>0).map(([k,n])=>n+' '+k).join(', ')||'nothing was missing';
    async function fullRun(action,id) {
      if(api.busy()||!current())return;
      api.lock(true);
      try{
        if(action==='delete'){
          if(!confirm('Delete this backup from the history list?\n\nThe file in Google Drive is not deleted.'))return;
          await api.edge('fullDeleteHistory',{id});fullStatus('Backup history entry deleted.');
        }else if(action==='restore'){
          if(!confirm('Restore missing data from this backup? Existing data is kept. Nothing is deleted. Users are not restored.'))return;
          fullStatus('Checking the file on Drive and restoring…');
          fullStatus('Restored: '+restoredText(await api.edge('fullRestore',{id,confirmed:true}))+'.');
          LiveWorkspace.refreshNotifications();
        }else{
          fullStatus('Downloading the verified backup…');
          saveJson(await api.edge('fullDownload',{id}));fullStatus('Backup download started.');
        }
      }catch(err){fullStatus(err.message,true);}
      finally{try{if(current())await fullHistory();}finally{api.lock(false);}}
    }
    get('#wlfFullNow').onclick=async()=>{
      if(api.busy()||!current())return;
      if(!api.configured){fullStatus('Configure Google Drive before starting a backup.',true);return;}
      api.lock(true);
      try{
        fullStatus('Collecting data and verifying the file in Google Drive…');
        const result=await api.edge('fullBackup');
        saveJson(result);
        fullStatus('Backup download started. A verified copy was saved to Google Drive ('+total(result.counts)+' records).');
      }catch(err){fullStatus(err.message,true);}
      finally{try{if(current())await fullHistory();}finally{api.lock(false);}}
    };
    get('#wlfFullDeleteAll').onclick=async()=>{
      if(api.busy()||!current())return;
      const typed=prompt('Delete ALL backup history entries?\nFiles in Google Drive are not deleted, but restoring from this page will no longer be possible.\n\nType DELETE to continue.');
      if(typed===null)return;
      api.lock(true);
      try{
        const result=await api.edge('fullDeleteHistory',{all:true,confirm:typed.trim()});
        fullStatus(result.deleted+' history entr'+(result.deleted===1?'y':'ies')+' deleted.');
      }catch(err){fullStatus(err.message,true);}
      finally{try{if(current())await fullHistory();}finally{api.lock(false);}}
    };
    get('#wlfFullFile').onchange=async event=>{
      const file=event.target.files[0];event.target.value='';
      if(!file||api.busy()||!current())return;
      api.lock(true);
      try{
        if(file.size>10000000)throw Error('Choose a backup file under 10 MB.');
        const archive=JSON.parse(await file.text());
        if(archive.format!=='WLF-FULL-2.6.3')throw Error('This is not a WLF Backup file.');
        if(!confirm('Restore missing data from this file? Existing data is kept. Nothing is deleted. Users are not restored.'))return;
        fullStatus('Restoring…');
        fullStatus('Restored: '+restoredText(await api.edge('fullRestore',{archive,confirmed:true}))+'.');
        LiveWorkspace.refreshNotifications();
      }catch(err){fullStatus(err.message,true);}
      finally{api.lock(false);}
    };
    root.querySelectorAll('[data-excel-kind]').forEach(b=>{b.onclick=()=>start(b.dataset.excelKind);});
    fullHistory();
    history();
  }
  return {mount};
})();
