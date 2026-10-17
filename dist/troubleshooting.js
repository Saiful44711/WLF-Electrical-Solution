/* Troubleshooting UI: data is loaded only on first entry; shared policy/validation is TroubleCore. */
var Troubleshooting=(function(){
 var data=null,indexed=[],section='',view='home',selected='',query='',subquery='',busy=false,epoch=0,editor=null,syncing=false,activeOwner='',activeProcedure='',viewTimer=null,lastView='';
 function el(id){return document.getElementById(id);}function h(s){return esc(s);}function copy(o){return JSON.parse(JSON.stringify(o));}
 function owner(){return SESSION?SESSION.email:'';}function scope(){return (typeof modeScope==='function'?modeScope():'supabase')+':'+owner();}
 function key(kind){return 'wlf-tb-'+kind+':'+scope();}function read(kind,fallback){try{return JSON.parse(localStorage.getItem(key(kind)))||fallback;}catch(e){return fallback;}}
 function write(kind,value){localStorage.setItem(key(kind),JSON.stringify(value));}function admin(){return !!SESSION&&TroubleCore.can(SESSION.role,'saveTroubleshootingEntry');}
 function call(action,args){return new Promise(function(resolve,reject){google.script.run.withSuccessHandler(resolve).withFailureHandler(reject)[action].apply(null,args);});}
 function status(text,error){var node=el('tbStatus');if(node){node.textContent=text;node.classList.toggle('tb-error',!!error);}}
 function pending(){return read('outbox',[]);}function entries(){var all=data?copy(data.entries):[];pending().forEach(function(op){var i=all.findIndex(function(e){return e.id===op.id;});if(op.action==='delete'){if(i>=0)all.splice(i,1);}else{var value=copy(op.record);value.pending=true;if(i>=0)all[i]=value;else all.push(value);}});return all;}
 function mount(){var root=el('tbRoot');if(!root||root.dataset.ready)return;root.dataset.ready='1';root.innerHTML='<div class="tb-heading"><div><p class="tb-eyebrow">FIELD REFERENCE</p><h3>Troubleshooting</h3><p>Controller faults, subcodes and your team’s approved procedures.</p></div><button class="btn ghost" id="tbRefresh">Refresh data</button></div><p id="tbStatus" role="status"></p><div id="tbPending"></div><div id="tbWorkspace"></div><dialog id="tbEditor"><div id="tbEditorBody"></div></dialog><dialog id="tbDelete"><h3>Delete this entry?</h3><p>This removes it from the shared troubleshooting list after sync. Source manuals stay unchanged.</p><div class="engineering-actions"><button class="btn" id="tbDeleteConfirm">Delete entry</button><button class="btn ghost" id="tbDeleteCancel">Cancel</button></div></dialog>';
 el('tbRefresh').onclick=function(){load(true);};el('tbDeleteCancel').onclick=function(){el('tbDelete').close();};
 }
 function reset(){clearTimeout(viewTimer);lastView='';activeProcedure='';epoch++;busy=false;syncing=false;data=null;indexed=[];section='';view='home';selected='';query='';subquery='';editor=null;activeOwner='';['tbEditor','tbDelete'].forEach(function(id){var d=el(id);if(d&&d.open)d.close();});var r=el('tbRoot');if(r){r.innerHTML='';delete r.dataset.ready;}}
 async function open(){if(!SESSION)return;mount();if(activeOwner&&activeOwner!==owner())reset();activeOwner=owner();mount();if(!data){var cached=read('cache',null);if(cached){data=cached;render();}await load(false);}else render();if(admin())sync(true);}
 async function load(force){
  if(!SESSION||busy)return;var token=T(),who=owner(),run=epoch;busy=true;el('tbRefresh').disabled=true;
  if(data)render();status(navigator.onLine?'Loading troubleshooting reference…':'Offline · showing downloaded reference');
  try{if(!navigator.onLine){if(!data)throw Error('Connect once and open Troubleshooting to download the manual reference for offline use.');return;}
   var result=await call('getTroubleshooting',[token]);if(run!==epoch||owner()!==who)return;
   if(!result||!Array.isArray(result.entries))throw Error('Troubleshooting API is not installed. Deploy the matching backend files.');
   data={entries:result.entries,downloadedAt:new Date().toISOString(),updatedAt:result.updatedAt};write('cache',data);render();status('');
  }catch(err){if(run===epoch){render();status((data?'Using saved reference. ':'')+cleanError(err),true);}}
  finally{if(run===epoch){busy=false;if(el('tbRefresh'))el('tbRefresh').disabled=false;}}
 }
 function render(){
  if(!el('tbWorkspace'))return;indexed=TroubleCore.index(entries());renderPending();
  if(view==='procedure'){renderProcedure();return;}if(view==='home'){renderHome();return;}if(view==='menu'){renderMenu();return;}renderList();
 }
 function count(type){return entries().filter(function(e){return e.controller===type&&(type==='GENERAL'||e.kind!=='procedure');}).length;}
 function renderHome(){el('tbWorkspace').innerHTML='<div class="tb-sections">'+[['MOT','MOT Controller','ARKEL ARCODE V2.14 · confirmed mapping'],['NICE3000+','NICE3000+ Controller','NICE3000new · uploaded manual revision'],['GENERAL','General Solution','Your subcategories and procedure fields']].map(function(x){return '<button class="tb-section" data-section="'+x[0]+'"><span class="tb-symbol">'+(x[0]==='GENERAL'?'↳':x[0]==='MOT'?'M':'N')+'</span><strong>'+h(x[1])+'</strong><small>'+h(x[2])+'</small><span class="tb-count">'+count(x[0])+' '+(x[0]==='GENERAL'?'subcategories':'error codes')+' →</span></button>';}).join('')+'</div>';
  el('tbWorkspace').querySelectorAll('[data-section]').forEach(function(b){b.onclick=function(){section=b.dataset.section;query='';subquery='';selected='';view=section==='GENERAL'?'list':'menu';render();};});
 }
 function title(){return section==='MOT'?'MOT Controller':section==='NICE3000+'?'NICE3000+ Controller':'General Solution';}
 function backButton(){return '<button class="tb-back" id="tbBack">← '+(view==='menu'||section==='GENERAL'?'Troubleshooting':title())+'</button>';}
 function bindBack(){el('tbBack').onclick=function(){view=view==='menu'||section==='GENERAL'?'home':'menu';selected='';activeProcedure='';render();};}
 function renderMenu(){
  var options=entries().filter(function(e){return e.controller===section&&e.kind==='procedure';});
  el('tbWorkspace').innerHTML=backButton()+'<div class="tb-list-heading"><h3>'+h(title())+'</h3>'+(admin()?'<button class="btn" id="tbAddOption">+ Add option</button>':'')+'</div><div class="tb-menu-grid"><button id="tbErrors" class="tb-section tb-menu-item"><strong>Error Solution</strong><small>Search an error code and view its solution.</small><span class="tb-count">'+count(section)+' error codes →</span></button>'+options.map(function(e){return '<div class="tb-option-card"><button class="tb-section tb-menu-item" data-procedure="'+h(e.id)+'"><strong>'+h(e.category)+'</strong><small>'+h(e.description||'View procedure')+'</small></button>'+(admin()?'<div class="tb-option-tools"><button data-option-edit="'+h(e.id)+'">Edit</button><button data-option-delete="'+h(e.id)+'">Delete</button></div>':'')+'</div>';}).join('')+'</div>';
  bindBack();el('tbErrors').onclick=function(){view='list';render();};
  if(el('tbAddOption'))el('tbAddOption').onclick=function(){edit(null,true);};
  el('tbWorkspace').querySelectorAll('[data-procedure]').forEach(function(b){b.onclick=function(){activeProcedure=b.dataset.procedure;view='procedure';render();};});
  el('tbWorkspace').querySelectorAll('[data-option-edit]').forEach(function(b){b.onclick=function(){edit(options.find(function(e){return e.id===b.dataset.optionEdit;}));};});
  el('tbWorkspace').querySelectorAll('[data-option-delete]').forEach(function(b){b.onclick=function(){confirmDelete(options.find(function(e){return e.id===b.dataset.optionDelete;}));};});
 }
 function renderProcedure(){
  var e=entries().find(function(e){return e.id===activeProcedure&&e.controller===section&&e.kind==='procedure';});
  if(!e){view='menu';renderMenu();return;}el('tbWorkspace').innerHTML=backButton()+'<article id="tbDetail" class="tb-detail tb-procedure-detail"></article>';bindBack();detail(e);
 }
 function renderList(){
  var name=section==='GENERAL'?'Subcategory or procedure':'Error code or description';
  el('tbWorkspace').innerHTML=backButton()+'<div class="tb-list-heading"><h3>'+h(title())+(section==='GENERAL'?'':' / Error Solution')+'</h3>'+(admin()?'<button class="btn" id="tbAdd">'+(section==='GENERAL'?'+ Add subcategory':'+ Add error code')+'</button>':'')+'</div><div class="tb-search"><div class="field"><label for="tbSearch">'+name+'</label><input id="tbSearch" autocomplete="off" placeholder="'+(section==='MOT'?'Er07 or motor current':section==='NICE3000+'?'Err38 or Err38 102':'Drive IGBT Test')+'" value="'+h(query)+'"></div>'+(section==='NICE3000+'?'<div class="field"><label for="tbSubSearch">Subcode (optional)</label><input id="tbSubSearch" inputmode="numeric" placeholder="102" value="'+h(subquery)+'"></div>':'')+'</div><div class="tb-result-grid"><div><p class="tb-result-count" id="tbCount"></p><div id="tbResults"></div></div><article id="tbDetail" class="tb-detail"></article></div>';
  bindBack();el('tbSearch').oninput=function(){query=this.value;selected='';renderResults();};if(el('tbSubSearch'))el('tbSubSearch').oninput=function(){subquery=this.value;selected='';renderResults();};if(admin())el('tbAdd').onclick=function(){edit(null);};renderResults();
 }
 function matches(){return TroubleCore.search(indexed,section,query,subquery).filter(function(e){return section==='GENERAL'||e.kind!=='procedure';});}
 function renderResults(){var list=matches();el('tbCount').textContent=list.length+' result(s)'+(list.length>40?' · first 40 shown; refine search':'');
  el('tbResults').innerHTML=list.slice(0,40).map(function(e){return '<button class="tb-entry'+(e.id===selected?' active':'')+'" data-id="'+h(e.id)+'"><b>'+h(e.code||e.category)+'</b><span>'+h(e.description||'Procedure fields')+'</span><small>'+((e.subcodes||[]).length?(e.subcodes.length+' subcodes · '):'')+(e.pending?'Pending sync':e.reserved?'Reserved':'View solution')+'</small></button>';}).join('')||'<p class="note">No matching entry. Try the main error code or clear the subcode filter.</p>';
  el('tbResults').querySelectorAll('[data-id]').forEach(function(b){b.onclick=function(){selected=b.dataset.id;renderResults();if(matchMedia('(max-width:900px)').matches)el('tbDetail').scrollIntoView({block:'start',behavior:matchMedia('(prefers-reduced-motion:reduce)').matches?'auto':'smooth'});};});
  if(!selected&&list.length===1)selected=list[0].id;
  if(selected){var e=list.find(function(e){return e.id===selected;});if(e){detail(e);return;}}
  el('tbDetail').innerHTML='<div class="tb-empty"><span>⌕</span><h4>Choose a '+(section==='GENERAL'?'subcategory':'fault code')+'</h4><p>Its description and solution appear here.</p></div>';
 }
 function solutionList(ss){return ss&&ss.length?'<ol class="tb-steps">'+ss.map(function(s){return '<li>'+h(s)+'</li>';}).join(''):'<p class="note">No separate solution is specified for this reserved/source entry.</p>';}
 function detail(e){
  var codeText=e.code||e.category,isProcedure=TroubleCore.isProcedure(e);
  el('tbDetail').innerHTML='<div class="tb-detail-heading"><div><p class="tb-eyebrow">'+h(title())+'</p><h3>'+h(codeText)+'</h3></div>'+(admin()?'<div class="tb-admin-tools"><button class="btn ghost" id="tbEdit">Edit</button><button class="btn ghost" id="tbDeleteEntry">Delete</button></div>':'')+'</div>'+(e.description?'<h4>'+h(e.description)+'</h4>':'')+(e.pending?'<p class="tb-pending-tag">Pending sync · local copy</p>':'')+(e.sourceNote?'<p class="note">'+h(e.sourceNote)+'</p>':'')+(e.conditions?'<details><summary>Conditions</summary><p>'+h(e.conditions)+'</p></details>':'')+(isProcedure?'<div class="tb-procedure">'+((e.fields||[]).length?e.fields.map(function(f){return '<section><h4>'+h(f.label)+'</h4><p>'+h(f.text)+'</p></section>';}).join(''):'<p class="note">No procedure added yet.</p>')+'</div>':(e.subcodes||[]).length?'<div id="tbSubcodeDetail"></div>':'<h4>Solution</h4>'+solutionList(e.solution));
  if(!isProcedure&&(e.subcodes||[]).length){
   var combined=query.trim().match(/^(?:err?|e)?\s*0*\d+[-.\s,/:]+(\d+)$/i),target=subquery.trim()||(combined?combined[1]:''),codes=e.subcodes.filter(function(sc){return !target||sc.code===String(Number(target));});
   el('tbSubcodeDetail').innerHTML=codes.map(function(sc){return '<section class="tb-subcode-block" data-subcode="'+h(sc.code)+'"><h4>Subcode '+h(sc.code)+': '+h(sc.description)+'</h4>'+solutionList(sc.solution)+'</section>';}).join('');
  }
  logView(e,typeof target==='string'?target:'');
  if(admin()){el('tbEdit').onclick=function(){edit(e);};el('tbDeleteEntry').onclick=function(){confirmDelete(e);};}
 }
 function logView(e,target){
  var id=e.id+':'+(target||'all');if(id===lastView)return;lastView=id;clearTimeout(viewTimer);var who=owner(),run=epoch;
  viewTimer=setTimeout(function(){if(run===epoch&&who===owner()&&typeof track==='function')track('Troubleshooting / '+e.controller+' / '+(TroubleCore.isProcedure(e)?e.category:'Error Solution'),JSON.stringify({code:e.code||'',subcode:target||''}));},300);
 }
 async function dashboard(){
  var node=el('tbDashboard');if(!node||!admin())return;var who=owner(),run=epoch;node.innerHTML='<p class="note">Loading troubleshooting summary…</p>';
  try{var records=data?entries():navigator.onLine?(await call('getTroubleshooting',[T()])).entries:(read('cache',{entries:[]}).entries);if(run!==epoch||who!==owner()||!el('tbDashboard'))return;
   var errors=records.filter(function(e){return !TroubleCore.isProcedure(e);}),options=records.filter(function(e){return e.kind==='procedure';}),general=records.filter(function(e){return e.controller==='GENERAL';}),subcodes=errors.reduce(function(n,e){return n+(e.subcodes||[]).length;},0);
   el('tbDashboard').innerHTML='<div class="card"><h3>Troubleshooting overview</h3><div class="kpis">'+[['Error codes',errors.length],['NICE subcodes',subcodes],['Controller options',options.length],['General subcategories',general.length]].map(function(x,i){return '<div class="kpi k'+(i+1)+'"><b>'+x[1]+'</b><span>'+x[0]+'</span></div>';}).join('')+'</div><p class="note">Admin: manage all options · Approved users: view and search</p></div>';
  }catch(err){if(run===epoch&&el('tbDashboard'))el('tbDashboard').textContent=cleanError(err);}
 }
 function stepFields(values,prefix){return '<div class="tb-step-fields" data-step-list="'+prefix+'">'+(values&&values.length?values:['']).map(function(v){return '<div class="tb-step-row"><textarea class="tb-step-input" rows="3" placeholder="Solution step">'+h(v)+'</textarea><button type="button" class="tb-remove" aria-label="Remove solution step">×</button></div>';}).join('')+'</div><button type="button" class="btn ghost tb-small" data-add-step="'+prefix+'">+ Add solution field</button>';}
 function subEditor(sc,i){return '<details class="tb-sub-editor" open data-subeditor><summary>Subcode '+h(sc.code||'new')+'</summary><div class="tb-sub-fields"><div class="field"><label>Subcode</label><input class="tb-sc-code" inputmode="numeric" value="'+h(sc.code||'')+'"></div><div class="field"><label>Subcode description</label><textarea class="tb-sc-description" rows="2">'+h(sc.description||'')+'</textarea></div>'+stepFields(sc.solution,'sub-'+i)+'<button type="button" class="tb-remove-sub btn ghost tb-small">Remove subcode</button></div></details>';}
 function fieldEditor(f){return '<div class="tb-custom-field"><label>Procedure field label</label><input class="tb-field-label" value="'+h(f.label||'')+'" placeholder="Test procedure - step 1"><label>Procedure text</label><textarea class="tb-field-text" rows="4">'+h(f.text||'')+'</textarea><button type="button" class="tb-remove-field btn ghost tb-small">Remove field</button></div>';}
 function bindDynamic(){el('tbEditorBody').querySelectorAll('[data-add-step]').forEach(function(b){b.onclick=function(){var list=el('tbEditorBody').querySelector('[data-step-list="'+b.dataset.addStep+'"]');list.insertAdjacentHTML('beforeend','<div class="tb-step-row"><textarea class="tb-step-input" rows="3" placeholder="Solution step"></textarea><button type="button" class="tb-remove" aria-label="Remove solution step">×</button></div>');bindDynamic();};});el('tbEditorBody').querySelectorAll('.tb-remove').forEach(function(b){b.onclick=function(){b.parentNode.remove();};});el('tbEditorBody').querySelectorAll('.tb-remove-sub').forEach(function(b){b.onclick=function(){b.closest('[data-subeditor]').remove();};});el('tbEditorBody').querySelectorAll('.tb-remove-field').forEach(function(b){b.onclick=function(){b.closest('.tb-custom-field').remove();};});}
 function edit(entry,newOption){
  if(!admin())return;editor=entry?copy(entry):{id:'tb-'+crypto.randomUUID(),controller:section,kind:newOption?'procedure':'error',code:'',category:'',description:'',conditions:'',solution:[],subcodes:[],fields:[],revision:0};
  var procedure=TroubleCore.isProcedure(editor);
  el('tbEditorBody').innerHTML='<div class="tb-editor-head"><h3>'+(entry?'Edit entry':'Add '+(procedure?'option':'error code'))+'</h3><button class="tb-back" id="tbCloseEditor">Close</button></div><p class="note">Changes are shared after server validation. Offline changes stay in your outbox until sync.</p>'+(procedure?'<label for="tbCategory">Option / subcategory name</label><input id="tbCategory" value="'+h(editor.category)+'" placeholder="Drive IGBT Test">':'<label for="tbEditCode">Error code</label><input id="tbEditCode" value="'+h(editor.code)+'" placeholder="'+(section==='MOT'?'Er07':'Err38')+'">')+'<label for="tbEditDescription">'+(procedure?'Summary (optional)':'Error description')+'</label><textarea id="tbEditDescription" rows="2">'+h(editor.description)+'</textarea>'+(procedure?'<div id="tbCustomFields">'+(editor.fields.length?editor.fields:[{label:editor.kind==='procedure'?'':'Test procedure',text:''}]).map(fieldEditor).join('')+'</div><button class="btn ghost" id="tbAddField">+ Add procedure field</button>':'<label>Solution fields</label>'+stepFields(editor.solution,'base')+(section==='NICE3000+'?'<h4>Subcodes</h4><div id="tbSubEditors">'+editor.subcodes.map(subEditor).join('')+'</div><button class="btn ghost" id="tbAddSub">+ Add subcode</button>':''))+'<p id="tbEditStatus" role="status"></p><div class="engineering-actions"><button class="btn" id="tbSave">Save entry</button><button class="btn ghost" id="tbCancelEdit">Cancel</button></div>';
  ['tbCloseEditor','tbCancelEdit'].forEach(function(id){el(id).onclick=function(){el('tbEditor').close();};});
  if(el('tbAddSub'))el('tbAddSub').onclick=function(){el('tbSubEditors').insertAdjacentHTML('beforeend',subEditor({code:'',description:'',solution:[]},Date.now()));bindDynamic();};
  if(el('tbAddField'))el('tbAddField').onclick=function(){el('tbCustomFields').insertAdjacentHTML('beforeend',fieldEditor({label:'',text:''}));bindDynamic();};
  el('tbSave').onclick=saveEditor;bindDynamic();el('tbEditor').showModal();
 }
 function values(node){return Array.from(node.querySelectorAll('.tb-step-input')).map(function(t){return t.value;}).filter(function(t){return t.trim();});}
 async function saveEditor(){
  if(!admin())return;var value=copy(editor);value.description=el('tbEditDescription').value;
  if(TroubleCore.isProcedure(value)){value.category=el('tbCategory').value;value.fields=Array.from(el('tbCustomFields').querySelectorAll('.tb-custom-field')).map(function(n){return {label:n.querySelector('.tb-field-label').value,text:n.querySelector('.tb-field-text').value};}).filter(function(f){return f.label.trim()||f.text.trim();});}
  else{value.code=el('tbEditCode').value;value.solution=values(el('tbEditorBody').querySelector('[data-step-list="base"]'));if(value.controller==='NICE3000+')value.subcodes=Array.from(el('tbSubEditors').querySelectorAll('[data-subeditor]')).map(function(n){var code=n.querySelector('.tb-sc-code').value,old=editor.subcodes.find(function(s){return s.code===code;});return {code:code,description:n.querySelector('.tb-sc-description').value,solution:values(n),pages:old&&old.pages||[]};});}
  try{value.mutationId='tbm-'+crypto.randomUUID();value=TroubleCore.validate(value);queue({id:value.id,action:'save',record:value});el('tbEditor').close();selected=value.id;if(value.kind==='procedure'){activeProcedure=value.id;view='procedure';}query='';subquery='';render();if(navigator.onLine)await sync(false);else status('Saved on this device. Pending sync when online.');}catch(err){el('tbEditStatus').textContent=cleanError(err);}
 }
 function queue(op){var q=pending(),old=q.find(function(x){return x.id===op.id;});if(old){if(op.action==='save'&&old.action==='save')op.record.revision=old.record.revision;q=q.filter(function(x){return x.id!==op.id;});}q.push(op);write('outbox',q);}
 function confirmDelete(e){if(!admin())return;el('tbDelete').showModal();el('tbDeleteConfirm').onclick=async function(){var q=pending(),existing=q.find(function(op){return op.id===e.id;});if(existing&&existing.action==='save'&&existing.record.revision===0){write('outbox',q.filter(function(op){return op.id!==e.id;}));}else queue({id:e.id,action:'delete',revision:existing&&existing.record?existing.record.revision:e.revision});el('tbDelete').close();selected='';if(e.kind==='procedure'){view='menu';activeProcedure='';}render();if(navigator.onLine)await sync(false);};}
 function renderPending(){var q=pending();el('tbPending').innerHTML=q.length?'<div class="tb-outbox"><b>'+q.length+' pending change(s)</b><p>'+h(q.find(function(op){return op.error;})&&q.find(function(op){return op.error;}).error||'Waiting for online sync. Only your account can sync these changes.')+'</p>'+(admin()?'<button id="tbSync" class="btn ghost tb-small">Sync now</button><button id="tbDiscard" class="tb-back">Discard pending changes</button>':'')+'</div>':'';if(el('tbSync'))el('tbSync').onclick=function(){sync(false);};if(el('tbDiscard'))el('tbDiscard').onclick=function(){if(confirm('Discard local pending troubleshooting changes? Server data is unchanged.')){write('outbox',[]);render();}};}
 async function sync(quiet){
  if(syncing||!admin()||!navigator.onLine||!data)return;var who=owner(),token=T(),run=epoch;syncing=true;
  try{while(owner()===who&&run===epoch&&navigator.onLine){var op=pending()[0];if(!op)break;
   try{var result=op.action==='save'?await call('saveTroubleshootingEntry',[token,op.record]):await call('deleteTroubleshootingEntry',[token,op.id,op.revision]);if(owner()!==who||run!==epoch)return;
    data.entries=data.entries.filter(function(e){return e.id!==op.id;});if(op.action==='save')data.entries.push(result);data.downloadedAt=new Date().toISOString();write('cache',data);
    // Read again after network completion; do not overwrite edits made while syncing.
    var q=pending(),live=q.find(function(x){return x.id===op.id;});if(live&&JSON.stringify(live)===JSON.stringify(op))q=q.filter(function(x){return x.id!==op.id;});else if(live&&op.action==='save'){if(live.action==='save')live.record.revision=result.revision;else live.revision=result.revision;}write('outbox',q);
   }catch(err){if(owner()!==who||run!==epoch)return;var q=pending(),live=q.find(function(x){return x.id===op.id;});if(live)live.error=cleanError(err);write('outbox',q);if(!quiet)status('Pending: '+cleanError(err),true);break;}
  }if(run===epoch){render();if(!pending().length)status('');}}
  finally{if(run===epoch)syncing=false;}
 }
 window.addEventListener('online',function(){if(data)sync(true);});
 return {open:open,reset:reset,sync:sync,entries:entries,dashboard:dashboard};
})();
