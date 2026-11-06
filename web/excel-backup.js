/* Excel backup UI inside the existing Super Admin Storage & Backup page. */
const WlfExcelBackup=(()=>{
  'use strict';
  const h=value=>esc(String(value??''));
  const moduleNames={support:'Technical Support',activity:'R&I Team Activity'};
  const today=()=>AccessCore.dateKey(new Date());
  function mount(root,api) {
    let retry=null;
    const account=T();
    root.innerHTML='<section class="card wlf-module"><div><h3>Excel backup</h3>'+
      '<p class="note">Download one workbook and save a verified copy in Google Drive. Each support team or activity form has its own worksheet.</p></div>'+
      '<div class="wlf-period"><label>Period<select id="wlfExcelPeriod"><option value="all">All dates</option><option value="year">Last 12 months</option>'+
      '<option value="custom">From date → To date</option></select></label><label>From date<input id="wlfExcelFrom" type="date" disabled></label>'+
      '<label>To date<input id="wlfExcelTo" type="date" disabled></label></div>'+
      '<div class="wlf-choice-list"><label class="wlf-choice"><input type="radio" name="wlfExcelMode" value="keep" checked> Backup without Clear</label>'+
      '<label class="wlf-choice"><input type="radio" name="wlfExcelMode" value="clear"> Backup with Clear</label></div>'+
      '<div class="wlf-tools-actions"><button type="button" class="btn" data-excel-kind="support">Technical Support</button>'+
      '<button type="button" class="btn ghost" data-excel-kind="activity">R&amp;I Team Activity</button></div>'+
      '<p class="note">Period uses the submission date in Bangladesh time. Clear is offered for unchanged Solved support and Completed or Solved activity entries.</p>'+
      '<div id="wlfExcelStatus" role="status" aria-live="polite"></div></section>'+
      '<section class="card"><h3>Excel backup history</h3><div id="wlfExcelHistory" aria-live="polite">Loading Excel history…</div></section>';
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
            (run.cleared>0&&!run.restored_at?historyButton('Restore recovery copy','restore',run):'')+'</div></td></tr>').join('')||
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
      const eligible=run.kind==='support'?'Solved support requests':'Completed or Solved activity entries';
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
        if(action==='restore'){
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
      finally{if(current()){await history();api.lock(false);}}
    }
    async function start(kind) {
      if(api.busy()||!current())return;
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
        if(!current())return;
        retry=null;
        download(result);
        status('Excel download started. A verified copy was saved to Google Drive.');
        if(withClear&&result.run.total)await clear(result.run);
      }catch(err){status(err.message,true);}
      finally{if(current()){await history();api.lock(false);}}
    }
    root.querySelectorAll('[data-excel-kind]').forEach(b=>{b.onclick=()=>start(b.dataset.excelKind);});
    history();
  }
  return {mount};
})();
