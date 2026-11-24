const {chromium}=require('playwright'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');const {makeDB,IDS}=require('./pg-harness.cjs');
let h,browser,context,page,server,errors=[],rpcCount=0;const passwords={};
const mime={'.html':'text/html','.js':'application/javascript','.css':'text/css','.webmanifest':'application/manifest+json','.png':'image/png','.svg':'image/svg+xml'};
const testConfig="window.WLF_CONFIG={supabaseUrl:'https://wlf-test.supabase.co',supabasePublishableKey:'sb_publishable_test_public_key',offlineHours:24};";
const archiveParts=new Map();
const Zip=require('jszip');
const supportWorkbook=require('../data/technical-support-forms-20261107.json');
const excelFiles=new Map();
let shellVersion='v210';
let dbQueue=Promise.resolve();
function sequential(fn){const run=dbQueue.then(fn);dbQueue=run.catch(()=>{});return run;}
async function drive(path,init={}){
  if(path.includes('?alt=media')){
    const id=path.split('/').at(-1).split('?')[0],bytes=excelFiles.get(id);
    if(!bytes)throw Error('Backup file missing');
    return new Response(bytes);
  }
  const boundary=init.headers['Content-Type'].split('boundary=')[1];
  const raw=Buffer.from(await new Response(init.body).arrayBuffer());
  const metaEnd=raw.indexOf('\r\n--'+boundary,raw.indexOf('\r\n\r\n')+4);
  const bytes=raw.subarray(raw.indexOf('\r\n\r\n',metaEnd)+4,raw.lastIndexOf('\r\n--'+boundary+'--'));
  const id='test_excel_'+excelFiles.size;
  excelFiles.set(id,bytes);
  return Response.json({id});
}
const mockRealtime=`;{const original=window.createWlfClient;window.__listeners=[];window.createWlfClient=function(...args){const sb=original(...args);sb.channel=function(){const listeners=[];return {on(event,filter,cb){listeners.push({table:filter.table,cb});return this;},subscribe(cb){window.__listeners=listeners;setTimeout(()=>cb('SUBSCRIBED'),0);return this;}};};sb.removeAllChannels=async()=>{window.__listeners=[];return[];};sb.removeChannel=async()=>{};return sb;};window.__emitRealtime=table=>window.__listeners.filter(x=>x.table===table).forEach(x=>x.cb({table,eventType:'UPDATE'}));}`;
function jwt(id){return [Buffer.from('{"alg":"none"}').toString('base64url'),Buffer.from(JSON.stringify({sub:id,role:'authenticated',aud:'authenticated',exp:Math.floor(Date.now()/1000)+3600})).toString('base64url'),'test'].join('.');}
(async()=>{
h=await makeDB();
await h.db.exec(fs.readFileSync('supabase/UPDATE_V220.sql','utf8'));
await h.db.exec(fs.readFileSync('supabase/UPDATE_SUPPORT_FORMS_20261107.sql','utf8'));
await h.db.exec(fs.readFileSync('supabase/UPDATE_DAMAGE_DEMAND_20261107.sql','utf8'));
await h.db.exec(fs.readFileSync('supabase/UPDATE_WORKSPACE_20261107.sql','utf8'));
await h.db.exec(fs.readFileSync('supabase/UPDATE_SECTIONS_V230.sql','utf8'));
await h.db.exec(fs.readFileSync('supabase/UPDATE_V240.sql','utf8'));await h.db.exec(fs.readFileSync('supabase/UPDATE_V250.sql','utf8'));await h.db.exec(fs.readFileSync('supabase/UPDATE_V251.sql','utf8'));await h.db.exec(fs.readFileSync('supabase/UPDATE_V252.sql','utf8'));await h.db.exec(fs.readFileSync('supabase/UPDATE_V253.sql','utf8'));await h.db.exec(fs.readFileSync('supabase/UPDATE_V254.sql','utf8'));await h.db.exec(fs.readFileSync('supabase/UPDATE_V255.sql','utf8'));await h.db.exec(fs.readFileSync('supabase/UPDATE_V256.sql','utf8'));await h.db.exec(fs.readFileSync('supabase/UPDATE_V257.sql','utf8'));await h.db.exec(fs.readFileSync('supabase/UPDATE_V258.sql','utf8'));await h.db.exec(fs.readFileSync('supabase/UPDATE_V259.sql','utf8'));await h.db.exec(fs.readFileSync('supabase/UPDATE_V260.sql','utf8'));await h.db.exec(fs.readFileSync('supabase/UPDATE_V261.sql','utf8'));await h.db.exec(fs.readFileSync('supabase/UPDATE_V262.sql','utf8'));await h.db.exec(fs.readFileSync('supabase/UPDATE_V263.sql','utf8'));await h.db.exec(fs.readFileSync('supabase/UPDATE_V264.sql','utf8'));await h.db.exec(fs.readFileSync('supabase/UPDATE_V265.sql','utf8'));await h.db.exec(fs.readFileSync('supabase/UPDATE_V266.sql','utf8'));await h.db.exec(fs.readFileSync('supabase/UPDATE_V267.sql','utf8')); await h.db.exec(fs.readFileSync('supabase/UPDATE_V268.sql','utf8'));await h.db.exec("update wlf_private.usage_housekeeping set last_run=now()+interval '30 days'");
await h.db.exec('alter table public.wlf_profiles disable trigger wlf_deletion_guard');
for(const [name,emp,section] of [['sa','SA-1','R&I Electrical'],['admin','AD-2','Sales'],['rni','RN-3','R&I Electrical'],['rni2','RN-4','R&I Mechanical'],['user','US-5','Commissioning'],['other','OT-6','After Sales'],['pending','PD-7','QM']])await h.db.query('update public.wlf_profiles set employee_id=$2,section=$3 where id=$1',[IDS[name],emp,section]);
await h.db.query("update public.wlf_profiles set permissions=array['selection','calc:power','calc:speed','calc:travel','calc:motor','calc:energy','calc:solar','tb:MOT:error','tb:NICE3000+:error','support:commissioning:request','support:aftersales:request','dashboard'] where id=$1",[IDS.admin]);
await h.db.exec('alter table public.wlf_profiles enable trigger wlf_deletion_guard');
await h.rpc('other','logAction',['Component Selection','Linked history fixture']);
const {excelMaintenance,archiveMaintenance}=await import('../supabase/functions/_shared/wlf-excel-edge.mjs');await h.db.query("update public.wlf_profiles set status='Rejected'where id=$1",[IDS.other]);fs.mkdirSync('test-results',{recursive:true});server=http.createServer((req,res)=>{const url=new URL(req.url,'http://localhost');let rel=url.pathname.replace(/^\/wlf\//,'');if(url.pathname==='/wlf/')rel='index.html';if(!url.pathname.startsWith('/wlf/')||rel.includes('..')){res.writeHead(404);res.end();return;}if(rel==='config.js'){res.setHeader('Content-Type','application/javascript');res.end(testConfig);return;}const f=path.join('dist',rel);if(!fs.existsSync(f)){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',mime[path.extname(f)]||'text/plain');if(rel==='sw.js'&&shellVersion==='v210'){
 const sw=fs.readFileSync(f,'utf8').replace('wlf-pwa-2.6.8-bin','wlf-pwa-2.1.0-storage-documents');res.end(sw);return;}
 res.end(rel==='supabase.js'?fs.readFileSync(f,'utf8')+mockRealtime:fs.readFileSync(f));});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined,args:['--no-sandbox']});context=await browser.newContext({viewport:{width:1280,height:900}});await context.addInitScript(()=>{try{if(!localStorage.getItem('wlf-usage-archive'))localStorage.setItem('wlf-usage-archive',String(Date.now()));}catch(_){}});page=await context.newPage();await page.addInitScript(()=>{const open=()=>document.querySelectorAll('#tab-storage details:not([data-forced])').forEach(d=>{d.open=true;d.dataset.forced='1';});new MutationObserver(open).observe(document,{childList:true,subtree:true});});globalThis.consoleErrors=[];page.on('console',m=>{if(m.type()==='error'||m.type()==='warning')globalThis.consoleErrors.push(m.text().slice(0,300));});/* v2.5.1: confirmation popup after each save; count it and press OK */globalThis.savedPopups=[];globalThis.savedLocator=page.locator('#wlfSavedDialog[open]');globalThis.savedHandler=async d=>{globalThis.savedPopups.push(await d.locator('h3').innerText());await d.locator('[data-saved-close]').click();};await page.addLocatorHandler(globalThis.savedLocator,globalThis.savedHandler);page.on('pageerror',e=>errors.push(e.message));
await context.route('https://wlf-test.supabase.co/**',async route=>{let request=route.request(),url=new URL(request.url()),body=request.postDataJSON(),data,status=200;try{
if(url.pathname==='/auth/v1/token'){let name=body.email?.split('@')[0]||'sa',id=IDS[name];if(!id||body.password!==(passwords[name]||'test-password-123')){status=400;data={msg:'Invalid login credentials'};}else data={access_token:jwt(id),refresh_token:'refresh-'+name,expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,token_type:'bearer',user:{id,email:name+'@example.test',aud:'authenticated',role:'authenticated',app_metadata:{provider:'email'},user_metadata:{name}}};}
else if(url.pathname==='/auth/v1/user'){const id=JSON.parse(Buffer.from(request.headers().authorization.split('.')[1],'base64url').toString()).sub;const name=Object.keys(IDS).find(k=>IDS[k]===id);passwords[name]=body.password;data={id,email:name+'@example.test',aud:'authenticated',role:'authenticated',user_metadata:{name}};}else if(url.pathname==='/auth/v1/logout')data={};else if(url.pathname==='/rest/v1/rpc/wlf_rpc'){rpcCount++;let id=JSON.parse(Buffer.from(request.headers().authorization.split('.')[1],'base64url').toString()).sub,name=Object.keys(IDS).find(k=>IDS[k]===id);data=await sequential(()=>h.rpc(name,body.action,body.args));}
else if(url.pathname==='/functions/v1/wlf-maintenance'){
 const id=JSON.parse(Buffer.from(request.headers().authorization.split('.')[1],'base64url').toString()).sub;
 if(id!==IDS.sa)throw Error('Super Admin only');const p=body.payload||{};
 if(process.env.WLF_EDGE_DELAY)await new Promise(r=>setTimeout(r,Number(process.env.WLF_EDGE_DELAY)));
 const sql=async(action,payload=p)=>(await h.db.query('select public.wlf_backup_admin($1,$2,$3)result',[action,id,payload])).rows[0].result;
 const excelSql=async(action,payload={})=>sequential(async()=>(await h.db.query('select public.wlf_excel_admin($1,$2,$3) result',[action,id,payload])).rows[0].result);
 if(body.action==='status')data={...await sequential(()=>sql('status')),driveConfigured:true};
 else if(body.action==='excelHistory')data=await excelSql('history');
 else if(body.action==='excelDeleteHistory')data=await excelSql('deleteHistory',p.all?{all:true,confirm:p.confirm}:{id:p.id});
 else if(body.action.startsWith('excel')){(globalThis.edgeLog||(globalThis.edgeLog=[])).push(body.action+(p.kind?':'+p.kind:'')+(p.withClear?':clear':''));data=await excelMaintenance({action:body.action,payload:p,sql:excelSql,
  drive,folder:async()=>'test-folder',project:'wlf-test',Zip});globalThis.edgeLog.push(body.action+' ok');}
 else if(['usageHistory','fullHistory','fullDeleteHistory'].includes(body.action)){const fn=body.action==='usageHistory'?'wlf_usage_admin':'wlf_full_admin',act=body.action==='fullDeleteHistory'?'deleteHistory':'history';data=await sequential(async()=>(await h.db.query('select public.'+fn+'($1,$2,$3) result',[act,id,act==='deleteHistory'?(p.all?{all:true,confirm:p.confirm}:{id:p.id}):{}])).rows[0].result);}
 else if(['usageArchive','fullBackup','fullDownload','fullRestore'].includes(body.action)){const make=fn=>(a,x={})=>sequential(async()=>(await h.db.query('select public.'+fn+'($1,$2,$3) result',[a,id,x])).rows[0].result);(globalThis.edgeLog||(globalThis.edgeLog=[])).push(body.action);
  data=await archiveMaintenance({action:body.action,payload:p,usageSql:make('wlf_usage_admin'),fullSql:make('wlf_full_admin'),drive,folderFor:async()=>'test-folder',project:'wlf-test',Zip});}
 else if(body.action==='backupPart'){let nonce=crypto.randomUUID(),part=await sql('prepare',{...p,project:'wlf-test',nonce});if(!part.alreadyVerified){archiveParts.set(p.id+':'+p.batch,part);await sql('verify',{...p,nonce,fileId:'drive_sample_'+p.batch,sha256:'a'.repeat(64)});}data={verified:true};}
 else if(body.action==='downloadPart')data=archiveParts.get(p.id+':'+p.batch);
 else if(body.action==='restore')data=await sql('restore',{archive:p.archive,project:'wlf-test'});
 else if(body.action==='deleteRejectedUser'){let target=await sql('reserveDeleteUser',{email:p.email});await h.db.query('delete from auth.users where id=$1',[target.id]);await sql('releaseDeleteUser',{id:target.id});data={deleted:true};}
 else data=await sql(({clearPart:'clear'})[body.action]||body.action);
 }
else throw Error('Unexpected mocked route '+url.pathname);
}catch(e){status=400;data={message:e.message,code:'P0001'};if(url.pathname==='/functions/v1/wlf-maintenance')(globalThis.edgeLog||(globalThis.edgeLog=[])).push((body&&body.action)+' ERROR '+e.message);}await route.fulfill({status,contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:JSON.stringify(data)});});
await page.goto(origin+'/wlf/');await page.locator('#loginEmail').waitFor();
await page.locator('#tabRegister').click();await page.locator('#regName').waitFor();await page.locator('#regName').fill('New Person');await page.locator('#regSection').selectOption('Factory Maintenance');assert.equal(await page.locator('#regSection option').count(),14);await page.locator('#regEmail').fill('new.person@example.test');await page.locator('#regPassword').fill('long-password-1');await page.locator('#regBtn').click();await page.locator('#authMsg').filter({hasText:'ID'}).waitFor();await page.locator('#regId').fill('NP-9');await page.locator('#regPassword').fill('');
await page.locator('#tabLogin').click();

async function login(name){await page.locator('#loginEmail').fill(name+'@example.test');await page.locator('#loginPassword').fill('test-password-123');await page.locator('#loginBtn').click();await page.locator('#app').waitFor({state:'visible'});await page.waitForFunction(()=>SESSION&&!SESSION.bootstrapPending);await page.evaluate(()=>openTab('account'));await page.locator('#tab-account [onclick=\"changePw()\"]').waitFor({state:'visible'});for(const [old,next]of [['test-password-123','changed-password-123'],['changed-password-123','test-password-123']]){await page.locator('#pwOld').fill(old);await page.locator('#pwNew').fill(next);await page.locator('#pwNew2').fill(next);await page.locator('#tab-account [onclick="changePw()"]').click();await page.waitForFunction(()=>document.getElementById('pwNew').value==='');} }
async function logout(){await page.evaluate(()=>logout());await page.locator('#authScreen').waitFor({state:'visible'});}
async function tab(name){await page.evaluate(name=>openTab(name),name);}
async function checkRiMobileFit(selector){
 const width=page.viewportSize().width;
 const layout=await page.locator(selector).evaluate((root,width)=>{
  const scroller='.tbl-wrap, .wlf-gantt';
  const controls=[root,...root.querySelectorAll('.card, .review-fields, .wlf-choice, .btn, input, select, textarea, '+scroller)];
  const clipped=controls.filter(node=>{
   const region=node.closest(scroller);
   if(region&&region!==node)return false;
   const box=node.getBoundingClientRect();
   return box.width>0&&(box.left<-1||box.right>width+1);
  }).map(node=>node.id||node.textContent.trim().slice(0,60)||node.tagName);
  return {scrollWidth:document.documentElement.scrollWidth,clipped};
 },width);
 assert.ok(layout.scrollWidth<=width+1,selector+' expands the phone page to '+layout.scrollWidth+' px');
 assert.deepEqual(layout.clipped,[],selector+' has clipped controls at '+width+' px');
}
async function fillDynamic(selector,overrides={}){
 await page.locator(selector+' [name]').evaluateAll((nodes,overrides)=>{
  const checked=new Set();
  for(const node of nodes){
   if(node.readOnly)continue;
   const value=overrides[node.name];
   if(node.type==='hidden'&&value===undefined&&node.name==='controller_model'){ /* v2.6.0: pick the first model of the chosen brand, like the popup would */
    const holder=node.closest('.wlf-dependent'),brand=node.form.elements.controller&&node.form.elements.controller.value,list=holder?((JSON.parse(holder.dataset.optionMap||'{}'))[brand]||[]):[];
    if(list.length){node.value=list[0];const btn=holder.querySelector('.wlf-pick');if(btn)btn.textContent=list[0];}
    continue;}
   if(node.type==='hidden'&&value===undefined)continue; /* server-filled or chosen in a popup (v2.5.2) */
   if(node.type==='checkbox'||node.type==='radio'){
    if(!checked.has(node.name)){node.checked=true;checked.add(node.name);}
   }else if(node.tagName==='SELECT'){
    const option=node.name==='problem_category'&&[...node.options].find(o=>o.value==='Encoder problem')||[...node.options].find(o=>o.value);
    node.value=value??option?.value??'';node.dispatchEvent(new Event('change',{bubbles:true}));
   }else if(node.type==='date')node.value=value??'2026-11-05';
   else node.value=value??(node.inputMode==='decimal'?'10':'Browser verification');
  }
 },overrides);
}

async function category(){await tab('technical');await page.locator('[data-support-category="commissioning"]').click();await page.locator('#supportFilterQuery').waitFor();}
await login('sa');
// The appearance/update menu is inside the signed-in application shell.
await page.waitForFunction(()=>navigator.serviceWorker.controller!==null);
await page.locator('.appearance-menu summary').click();
const updateButton=page.locator('#updateWlf');
assert.equal(await updateButton.isVisible(),false,'Initial service-worker install should not offer an update');
shellVersion='v220';
await page.evaluate(async()=>{const registration=await navigator.serviceWorker.ready;await registration.update();});
await updateButton.waitFor({state:'visible'});
assert.equal(await page.evaluate(async()=>Boolean((await navigator.serviceWorker.ready).waiting)),true);
page.once('dialog',d=>d.accept());
await Promise.all([page.waitForEvent('load'),updateButton.click()]);
await page.waitForFunction(async()=>{
 const keys=await caches.keys();
 return keys.some(key=>key.startsWith('wlf-pwa-2.2.0')) && !keys.some(key=>key.startsWith('wlf-pwa-2.1.0'));
});
await page.locator('#app').waitFor({state:'visible'});
await page.waitForFunction(()=>SESSION&&!SESSION.bootstrapPending);
// All six Technical Support request forms must match the uploaded workbook.
await tab('technical');
for (const [team, expectedForm] of Object.entries(supportWorkbook.forms)) {
 const expectedFields = expectedForm.fields.map(field=>({...field,options:(field.options||[]).map(o=>o==='1. Asthetics'?'1. Aesthetics':o)})); // v2.4.0 spelling fix
 // v2.3.0: the single Name & ID field is split into locked Name and ID fields.
 const identityAt = expectedFields.findIndex(field=>field.autoFill==='identity');
 expectedFields.splice(identityAt,1,{id:'login_name',label:'Name',type:'text',required:true,autoFill:'name',options:[]},{id:'login_id',label:'ID',type:'text',required:true,autoFill:'empid',options:[]});
 if (['commissioning','aftersales','installation'].includes(team)) {
  expectedFields.splice(expectedFields.findIndex(field=>field.label==='Project Name')+1,0,
   {id:'project_address',label:'Project Address',type:'textarea',required:false,options:[]});
 }
 /* v2.5.2: new Problem Category list (36) and a Problem Sub-Category (hidden value, chosen in a popup) on five team forms */
 if (['commissioning','aftersales','production','qc','maintenance'].includes(team)) {
  const liveCats=(await sequential(()=>h.rpc('sa','getSupportWorkspace'))).forms[team].fields.find(f=>f.id==='problem_category').options;
  assert.equal(liveCats.length,37);assert.equal(liveCats[0],'MOT drive Error');assert.equal(liveCats.at(-1),'Others');
  const at=expectedFields.findIndex(f=>f.id==='problem_category');
  expectedFields[at]={...expectedFields[at],options:liveCats};
  expectedFields.splice(at+1,0,{id:'problem_sub',label:'',type:'dependent',required:false,autoFill:'dependent',options:[]});
 }
 /* v2.6.0: Controller Model (hidden value, chosen in a popup) right after the Control System Brand */
 {const ci=expectedFields.findIndex(f=>f.id==='controller');if(ci>=0)expectedFields.splice(ci+1,0,{id:'controller_model',label:'',type:'dependent',required:false,autoFill:'dependent',options:[]});}
 await page.locator('[data-support-category="'+team+'"]').click();
 for(let k=0;k<3&&!(await page.locator('#newSupportRequest').isVisible());k++){await page.waitForTimeout(1500);if(!(await page.locator('#newSupportRequest').isVisible()))await page.locator('[data-support-category="'+team+'"]').click().catch(()=>{});} // the home list can re-render right after the click (pre-existing test race)
 await page.locator('#newSupportRequest').click();
 const controls = await page.locator('#supportRequestForm [name]').evaluateAll(nodes => nodes.map(node => ({
  id: node.name,
  label: node.type === 'hidden' ? '' : node.closest('.field').querySelector('label').textContent.replace(/\s+\*$/, ''),
  hidden: node.type === 'hidden',
  required: node.required,
  readOnly: Boolean(node.readOnly),
  tag: node.tagName,
  inputMode: node.getAttribute('inputmode'),
  value: node.value,
  options: node.tagName === 'SELECT' ? Array.from(node.options).slice(1).map(option => option.value) : [],
 })));
 assert.equal(controls.length, expectedFields.length, team);
 for (const [index, field] of expectedFields.entries()) {
  const control = controls[index];
  assert.equal(control.id, field.id, team+' field order');
  /* v2.5.1: Name, ID and today's date are filled by the server and hidden in the form */
  assert.equal(control.hidden, Boolean(field.autoFill), team+' autofill hidden');
  if (!field.autoFill) { assert.equal(control.label, field.label, team+' field label'); assert.equal(control.required, field.required, team+' required field'); }
  assert.deepEqual(control.options, field.options, team+' dropdown choices');
  if (field.type === 'select') assert.equal(control.tag, 'SELECT');
  if (field.type === 'textarea') assert.equal(control.tag, 'TEXTAREA');
  if (field.type === 'number') assert.equal(control.inputMode, 'decimal');
  if (field.autoFill === 'name') assert.equal(control.value, 'sa');
  if (field.autoFill === 'empid') assert.equal(control.value, 'SA-1');
  if (field.autoFill === 'today') assert.match(control.value, /^\d{4}-\d{2}-\d{2}$/);
 }
 await page.screenshot({path:'test-results/support-fields-'+team+'.png',fullPage:true});
 await page.locator('#closeSupportForm').click();
 await page.locator('#supportHome').click();
}
// Existing troubleshooting editors remain available to Super Admin.
await tab('troubleshooting');await page.locator('[data-section="GENERAL"]').waitFor({state:'visible'});await page.locator('[data-section="GENERAL"]').click();assert(await page.locator('#tbAdd').isVisible());await page.locator('#tbAdd').click();assert(await page.locator('.tb-field-label').first().isVisible());await page.evaluate(()=>document.getElementById('tbEditor').close());await page.locator('#tbBack').click();await page.locator('[data-section="MOT"]').click();assert(await page.locator('#tbAddOption').isVisible());await page.locator('#tbErrors').click();assert(await page.locator('#tbAdd').isVisible());await page.locator('#tbSearch').fill('Er07');await page.locator('#tbEdit').waitFor();await page.locator('#tbEdit').click();assert(await page.locator('[data-add-step]').first().isVisible());await page.evaluate(()=>document.getElementById('tbEditor').close());
// Actual document CRUD against upgraded PostgreSQL and role-restricted UI.
await tab('documents');await page.locator('#wlfAddCategory').click();await page.locator('#wlfCategoryName').fill('Training');await page.locator('#wlfCategoryFields').fill('Revision\nModel');await page.locator('#wlfCategoryForm button:not([type=button])').click();await page.locator('[data-doc-category]').filter({hasText:'Training'}).click();await page.locator('#wlfAddDocument').click();await page.locator('#wlfDocumentName').fill('Commissioning Checklist');await page.locator('#wlfDocumentUrl').fill('https://drive.google.com/file/d/synthetic_test/view');await page.locator('[data-doc-field="0"]').fill('R1');await page.locator('[data-doc-field="1"]').fill('Demo model');await page.locator('#wlfDocumentForm button:not([type=button])').click();await page.locator('#wlfDocList a').filter({hasText:'Commissioning Checklist'}).waitFor();assert.equal(await page.locator('#wlfDocList a').getAttribute('target'),'_blank');await page.locator('[data-edit-doc]').click();await page.locator('#wlfDocumentName').fill('Updated Checklist');await page.locator('#wlfDocumentForm button:not([type=button])').click();await page.locator('#wlfDocList a').filter({hasText:'Updated Checklist'}).waitFor();/* v2.4.0 folders */await page.locator('#wlfAddFolder').click();await page.locator('#wlfFolderName').fill('Manuals 2026');await page.locator('#wlfFolderForm button:not([type=button])').click();await page.locator('#wlfDocPath').filter({hasText:'Manuals 2026'}).waitFor();await page.locator('#wlfDocList').getByText('This folder is empty.').waitFor();await page.locator('#wlfAddDocument').click();assert.notEqual(await page.locator('#wlfDocumentFolder').inputValue(),'');await page.locator('#wlfDocumentName').fill('Folder Manual');await page.locator('#wlfDocumentUrl').fill('https://drive.google.com/file/d/folder_test/view');await page.locator('#wlfDocumentForm button:not([type=button])').click();await page.locator('#wlfDocList a').filter({hasText:'Folder Manual'}).waitFor();await page.locator('#wlfAddFolder').click();await page.locator('#wlfFolderName').fill('NICE3000+');await page.locator('#wlfFolderForm button:not([type=button])').click();await page.locator('#wlfDocPath').filter({hasText:'NICE3000+'}).waitFor();await page.locator('#wlfDocPath .wlf-path-link').first().click();await page.locator('#wlfDocList [data-open-folder]').filter({hasText:'Manuals 2026'}).waitFor();assert.equal(await page.locator('#wlfDocList a').filter({hasText:'Folder Manual'}).count(),0);await page.locator('#wlfDocSearch').fill('folder man');await page.locator('#wlfDocList a').filter({hasText:'Folder Manual'}).waitFor();assert.match(await page.locator('#wlfDocList').innerText(),/📁 Manuals 2026/);await page.locator('#wlfDocSearch').fill('');await page.locator('#wlfDocList [data-delete-folder]').first().click();await page.locator('#wlfDocStatus').filter({hasText:'not empty'}).waitFor();await page.locator('#wlfDocList [data-open-folder]').filter({hasText:'Manuals 2026'}).click();await page.locator('#wlfDocPath').filter({hasText:'Manuals 2026'}).waitFor();fs.mkdirSync('test-results/v240',{recursive:true});await page.screenshot({path:'test-results/v240/documents-folders-desktop.png'});await page.locator('#wlfDocPath .wlf-path-link').first().click();await page.setViewportSize({width:390,height:844});await page.evaluate(()=>closeSidebar());await page.waitForFunction(()=>document.getElementById('sidebar').getBoundingClientRect().right<=1);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:'test-results/v210-documents-mobile.png',fullPage:true});await page.setViewportSize({width:1280,height:900});
// Search and rejected deletion keep the existing approval/access editor.
await tab('users');await page.locator('#userAccessSearch').fill('user@example.test');assert.equal(await page.locator('.access-user:visible').count(),1);await page.locator('#userAccessSearch').fill('other@example.test');await page.locator('.access-user:visible summary').click();page.once('dialog',d=>d.accept());await page.locator('.access-delete').click();await page.waitForFunction(()=>!document.querySelector('[data-access-user="other@example.test"]'));
assert.equal((await sequential(()=>h.db.query("select count(*) n from public.wlf_usage where actor=$1",[IDS.other]))).rows[0].n,1);
assert.equal((await sequential(()=>h.db.query("select count(*) n from auth.users where id=$1",[IDS.other]))).rows[0].n,0);
const pickModel=async model=>{await page.locator('.wlf-dependent[data-dep-name=controller_model] .wlf-pick').click();const b=page.locator('#wlfPicker [data-pick="'+model+'"]');await b.click({timeout:8000}).catch(async e=>{throw Error('PICK-DIAG '+await page.evaluate(()=>{const d=document.getElementById('wlfPicker');return d?('open='+d.open+' '+d.innerText.slice(0,200)+' | controller='+document.querySelector('#supportRequestForm [name=controller]')?.value):'no picker; controller='+document.querySelector('#supportRequestForm [name=controller]')?.value;}));});};/* v2.6.0: the Controller Model list opens right after the brand is chosen */
const withModel=v=>({controller_model:'NICE3000+ 7.5 kW',...v});/* v2.6.0: the Controller Model is required for MOT / NICE3000+ / MOTCUBE */
// One solved support fixture tests date filters, backup-only, clear, download and restore UI.
let vals={};for(const f of require('../data/workbook-v220-audit.json').support.commissioning.fields)vals[f.id]=f.type==='multi'?[f.options[0]]:f.type==='date'?'2026-09-12':f.type==='number'?'8888':f.options.length?f.options[0]:'Browser backup test';vals.problem_category='Encoder problem';vals.controller='NICE3000+';vals.controller_model='NICE3000+ 7.5 kW';/* v2.5.2 category list; v2.6.0 controller model */let seed=await h.rpc('user','createSupportRequest',[{category:'commissioning',values:vals,mutationId:'browser-backup-create-0001'}]);seed=await h.rpc('rni','transitionSupportRequest',[{id:seed.id,revision:seed.revision,action:'receive',mutationId:'browser-backup-receive-001'}]);await h.rpc('rni','transitionSupportRequest',[{id:seed.id,revision:seed.revision,action:'solve',comment:'Backup test solved',mutationId:'browser-backup-solve-0001'}]);
await h.db.query("update public.wlf_requests set created_at='2026-09-12 06:00:00+00' where id=$1",[seed.id]);
await tab('storage');await page.locator('#wlfBackupPeriod').selectOption('custom');await page.locator('#wlfBackupFrom').fill('2026-09-01');await page.locator('#wlfBackupTo').fill('2026-09-30');await page.locator('#wlfBackupOnly').click();await page.locator('#wlfBackupStatus').filter({hasText:'Backup saved and verified'}).waitFor();assert.equal((await h.db.query('select count(*)n from public.wlf_requests where id=$1',[seed.id])).rows[0].n,1);await page.locator('#wlfRefreshStorage').click();await page.locator('[data-backup-id]').click();const archiveDownload=page.waitForEvent('download');await page.locator('[data-download-part]').click();const file=await archiveDownload;await file.saveAs('test-results/v210-support-backup.json');assert.equal(JSON.parse(fs.readFileSync('test-results/v210-support-backup.json','utf8')).records.length,1);await page.locator('#wlfReviewClear').click();await page.locator('#wlfClearConsent').check();await page.locator('#wlfConfirmClear').click();await page.locator('#wlfBackupStatus').filter({hasText:'1 unchanged Solved records cleared'}).waitFor();assert.equal((await h.db.query('select count(*)n from public.wlf_requests where id=$1',[seed.id])).rows[0].n,0);await page.locator('#wlfRestore').click();await page.locator('#wlfRestoreFile').setInputFiles('test-results/v210-support-backup.json');page.once('dialog',d=>d.accept());await page.locator('#wlfRestoreGo').click();await page.locator('#wlfRestoreStatus').filter({hasText:'1 support record(s) restored'}).waitFor();await page.locator('#wlfCancel').click();await page.screenshot({path:'test-results/v210-storage-desktop.png',fullPage:true});
// Verify the database-backed form editor and component table filters.
await category();
await page.locator('#manageSupportFields').click();
await page.locator('#supportSchemaEditor [data-field-id=remarks] .schema-type').selectOption('checkbox');
await page.locator('#saveSchemaFields').click();
await page.locator('#supportSchemaEditor').waitFor({state:'detached'});
await page.locator('#newSupportRequest').click();
assert.equal(await page.locator('#supportRequestForm [name=remarks]').getAttribute('type'),'checkbox');
await page.locator('#closeSupportForm').click();
await tab('components');
await page.locator('#compCount').filter({hasText:'78 of 78'}).waitFor();
const six=['1350','1','MR','2:1','Montanari','MGV34S'];
for(const [i,value] of six.entries())await page.locator('#compFilter-'+i).selectOption(value);
assert.equal(await page.locator('#componentsTable tbody tr').count(),1);

// Activity reports, user ownership and the recorded status.
await sequential(()=>h.db.query("update public.wlf_profiles set permissions=permissions||array['ri:activity','ri:projects'] where id in ($1,$2)",[IDS.user,IDS.rni]));
await page.setViewportSize({width:360,height:800});
await tab('ri-activity');
await page.locator('#riEntryList .tbl-wrap').waitFor();
await page.evaluate(()=>setAppearance('dark'));
await checkRiMobileFit('#tab-ri-activity');
await page.screenshot({path:'test-results/ri-team-activity-mobile.png',fullPage:true});
await page.evaluate(()=>setAppearance('light'));
/* v2.5.0: all activity/report forms in one list, grouped by tab */
assert.equal(await page.locator('#riCategoryPicker optgroup[label="Reports"] option').count(),3);
assert.equal(await page.locator('#riCategoryPicker optgroup').count(),4);
await page.locator('#riCategoryPicker').selectOption({label:'Electrical & Electronic Components Service Report'});
await page.locator('#riActivityForm h3').filter({hasText:'Electrical & Electronic Components Service Report'}).waitFor();
await fillDynamic('#riSubmitForm',{status:'Solved'});
await page.locator('#riSubmitForm [type=submit]').click();
await page.locator('#riSubmitStatus').filter({hasText:'Saved · Solved'}).waitFor();
await page.locator('#riEntryList tbody tr').filter({hasText:'Solved'}).waitFor();
await page.setViewportSize({width:320,height:760});
await checkRiMobileFit('#tab-ri-activity');
await page.screenshot({path:'test-results/v220-activity.png',fullPage:true});

// Project creation, task update, Gantt and real PPTX download.
await tab('ri-projects');
await page.locator('[data-ri-action=new-project]').click();
await checkRiMobileFit('#wlfRiDialog');
await page.locator('#wlfRiDialog [name=name]').fill('WLF Electrical solution software development');
await page.locator('#wlfRiDialog [name=lead]').fill('user (US-5)');
await page.locator('#wlfRiDialog button[type=submit]').click();
await page.locator('[data-project]').waitFor();
await checkRiMobileFit('#tab-ri-projects');
await page.locator('[data-ri-action=add-task]').click();
await checkRiMobileFit('#wlfRiDialog');
await page.locator('#wlfRiDialog [name=name]').fill('Record controller tests');
assert.equal(await page.locator('#wlfRiDialog [name=owner]').inputValue(),'');assert.match(await page.locator('#wlfRiDialog').innerText(),/assignee/i);assert.doesNotMatch(await page.locator('#wlfRiDialog').innerText(),/assign user/i);const ownerOptions=await page.locator('#wlfRiDialog [name=owner] option').allTextContents();assert.equal(ownerOptions[0],'Select user');assert.match(ownerOptions[1],/^user \(US-5\) · Project lead$/);await page.locator('#wlfRiDialog button[type=submit]').click();assert.equal(await page.locator('#wlfRiDialog').isVisible(),true);await page.locator('#wlfRiDialog [name=owner]').selectOption({index:1});
await page.locator('#wlfRiDialog [name=progress]').fill('65');
await page.locator('#wlfRiDialog button[type=submit]').click();
await page.locator('.wlf-gantt-bar span').waitFor();
await checkRiMobileFit('#tab-ri-projects');
for(const selector of ['.wlf-gantt','[data-project] .tbl-wrap']){
 assert.ok(await page.locator(selector).evaluate(node=>{
  node.scrollLeft=node.scrollWidth;
  const scrolls=node.scrollLeft>0;
  node.scrollLeft=0;
  return scrolls;
 }),selector+' scrolls within its project card');
}
await page.screenshot({path:'test-results/ri-project-manager-mobile.png',fullPage:true});
await page.setViewportSize({width:1280,height:900});
await page.evaluate(()=>setAppearance('system'));
const pptx=page.waitForEvent('download');
await page.locator('[data-ri-action=project-ppt]').click();
await(await pptx).saveAs('test-results/v220-project.pptx');
const pptZip=await Zip.loadAsync(fs.readFileSync('test-results/v220-project.pptx'));
assert.ok(pptZip.file('ppt/slides/slide2.xml'));
assert.match(await pptZip.file('ppt/slides/slide2.xml').async('string'),/Record controller tests/);
await page.screenshot({path:'test-results/v220-project.png',fullPage:true});

// Excel export uses the real Edge workbook generator, with a fake Drive connection.
await tab('storage');
await page.locator('[data-excel-kind=support]').waitFor();
const excel=page.waitForEvent('download');
await page.locator('[data-excel-kind=support]').click();
await(await excel).saveAs('test-results/v220-support.xlsx');
const excelZip=await Zip.loadAsync(fs.readFileSync('test-results/v220-support.xlsx'));
assert.ok(excelZip.file('xl/tables/table6.xml'));
assert.match(await excelZip.file('xl/workbook.xml').async('string'),/Factory Maintenance/);
await page.locator('#wlfExcelStatus').filter({hasText:'verified copy'}).waitFor();
await page.screenshot({path:'test-results/v220-storage.png',fullPage:true});
await tab('dashboard');await page.locator('#usageLogCard').waitFor();assert.equal(await page.locator('#tbDashboard,#riDashboard').count(),0,'the R&I cards and the Troubleshooting overview are gone from the Usage dashboard');const desktop=await page.evaluate(()=>{let logo=document.querySelector('.header-company-logo').getBoundingClientRect(),title=document.getElementById('pageTitle').getBoundingClientRect(),menu=document.querySelector('.appearance-menu').getBoundingClientRect(),top=document.querySelector('.topbar').getBoundingClientRect();return{left:logo.x<title.x,right:menu.x>title.right,edge:top.right-menu.right};});assert.ok(desktop.left&&desktop.right&&desktop.edge<40);await page.screenshot({path:'test-results/header-desktop-dashboard.png',fullPage:true});assert.equal(await page.locator('#nav [data-tab=users]').isVisible(),true);await tab('users');await page.locator('[data-access-user="user@example.test"]').waitFor({state:'attached'});
assert.equal(await page.locator('#nav [data-tab=ri-projects] + [data-tab=damage-demand]').isVisible(),true);
await tab('damage-demand');
await page.locator('#tab-damage-demand').getByText('No demands match these filters.').waitFor();
assert.equal(await page.locator('[data-damage-pane]').count(),2);
await tab('users');
assert.match(await page.locator('[data-access-user="admin@example.test"]').locator('xpath=..').locator('summary').innerText(),/admin \(AD-2\)[\s\S]*Section user · Sales · Approved/);
for (const [name,keys] of [['admin',['damage:demand','damage:receive:commissioning']],['rni',['damage:dashboard']]]) {
 const access=page.locator(`[data-access-user="${name}@example.test"]`);
 await access.locator('xpath=..').locator('summary').click();
 for (const key of keys) await access.locator(`input[value="${key}"]`).check();
 const save=page.waitForResponse(response=>response.url().endsWith('/rest/v1/rpc/wlf_rpc')&&
  response.request().postDataJSON()?.action==='saveAppUserAccess');
 await access.locator('.access-save').click();
 assert.ok((await save).ok());
}
await logout();assert.equal(await page.locator('#tab-users .access-user').count(),0);
await login('user');
assert.equal(await page.locator('#nav [data-tab=damage-demand]').isVisible(),false);
await tab('ri-projects');
await page.locator('[data-project] summary').click();
assert.equal(await page.locator('[data-ri-action=add-task],[data-ri-action=delete-project]').count(),0);
await tab('ri-activity');
await page.locator('#riCategoryPicker').selectOption({label:'Electrical & Electronic Components Service Report'});
await page.locator('#riEntryList tbody tr').filter({hasText:'Solved'}).waitFor();
assert.equal(await page.locator('[data-ri-action=edit-entry],[data-ri-action=delete-entry]').count(),0);
assert.equal(await page.locator('#nav [data-tab=dashboard]').isVisible(),false);assert.equal(await page.locator('#nav [data-tab=components]').isVisible(),false);assert.equal(await page.locator('#nav [data-tab=storage]').isVisible(),false);await tab('documents');await page.locator('[data-doc-category]').filter({hasText:'Training'}).click();await page.locator('#wlfDocList a').filter({hasText:'Updated Checklist'}).waitFor();assert.equal(await page.locator('#wlfAddDocument,#wlfAddCategory,[data-edit-doc],[data-delete-doc]').count(),0);assert.equal(await page.locator('#nav [data-tab=users]').isVisible(),false);await page.evaluate(()=>openTab('users'));assert.equal(await page.locator('#tab-users').isVisible(),false);
// Real imported components available; browser-local calculation makes no calculator RPC.
await tab('selection');await page.locator('#sel-capacity').selectOption('450');await page.locator('#sel-speed').selectOption('1');await page.locator('#sel-usageType').selectOption('MR');await page.locator('#sel-roping').selectOption('2:1');await page.locator('#searchBtn').click();if(await page.locator('#matchesList .chip').count())await page.locator('#matchesList .chip').first().click();await page.locator('#reportWrap').waitFor({state:'visible'});assert.match(await page.locator('#reportWrap').innerText(),/Recommended MOT Control System/);assert.doesNotMatch(await page.locator('#reportWrap').innerText(),/Recommended ARKEL Control System/);
await page.evaluate(()=>{APK_SETTINGS.theme='dark';applyTheme();});await page.screenshot({path:'test-results/supabase-components-dark.png',fullPage:true});
await tab('calculation');await page.evaluate(()=>openCalcPane('power'));for(const [id,v]of Object.entries({'pw-motor':'3.9','pw-k2':'.95','pw-k3':'.95','pw-brake':'324','pw-tube':'4','pw-panel':'0','pw-spot':'4','pw-fan':'2','pw-others':'500'}))await page.locator('#'+id).fill(v);await page.locator('#pane-power button').click();await page.locator('#pwResult').filter({hasText:'8.668'}).waitFor();
const result=await page.evaluate(()=>LiftCore.calculate('calculatePowerAndAVR',{motorPowerKW:3.9,k2:.95,k3:.95,brakePowerBothW:324,tubeLightQty:4,panelLightQty:0,spotLightQty:4,crossFlowFanQty:2,othersFixedW:500}));assert.equal(result.suggestGeneratorKVA,8.668);
await tab('troubleshooting');await page.locator('[data-section="NICE3000+"]').click();await page.locator('#tbErrors').click();const searchBefore=rpcCount;await page.locator('#tbSearch').fill('Err38');await page.locator('#tbDetail').filter({hasText:'Err38'}).waitFor();assert.ok((await page.locator('#tbDetail').innerText()).includes('102'));await page.locator('#tbSubSearch').fill('102');await page.locator('#tbDetail').filter({hasText:'102'}).waitFor();assert.equal(rpcCount,searchBefore);
await category();await page.locator('#newSupportRequest').click();await page.locator('#supportRequestForm').waitFor();assert.equal(await page.locator('#supportRequestForm [name=login_name]').inputValue(),'user');assert.equal(await page.locator('#supportRequestForm [name=login_id]').inputValue(),'US-5');assert.equal(await page.locator('#supportRequestForm [name=login_id]').evaluate(n=>n.type),'hidden');
await fillDynamic('#supportRequestForm',{lift:'991234',project_address:'Plot 14, Dhaka'});await page.locator('#submitSupportRequest').click();await page.locator('#supportDetail h3').filter({hasText:/TCS\d+-991234-\d{8}/}).waitFor();const id=await page.locator('#supportDetail').getAttribute('data-record-id');assert.equal(await page.locator('#editSupportForm,#deleteSupportTicket,#receiveSupport').count(),0);assert.equal(await page.locator('#supportBadge').innerText(),'1');await logout();
// v2.3.0: no Admin read-all role. A section user with team access submits and sees only own requests.
await login('admin');assert.equal(await page.locator('#nav [data-tab=components]').isVisible(),false);await category();assert.equal(await page.locator('#newSupportRequest').count(),1);assert.equal(await page.locator(`[data-ticket="${id}"]`).count(),0);assert.equal(await page.locator('#downloadSupportCSV').count(),0);assert.equal(await page.locator('#supportFilterRequester').isVisible(),false);await logout();
// Super Admin: SUPPORT USER filter lists the Commissioning section with Name (ID); card and history show Name (ID).
await login('sa');await category();await page.locator('#supportFilterRequester').waitFor();assert.deepEqual(await page.locator('#supportFilterRequester option').allTextContents(),['All Commissioning users','user (US-5)']);await page.locator('#supportFilterRequester').selectOption('user@example.test');await page.locator(`[data-ticket="${id}"]`).waitFor();assert.match(await page.locator(`[data-ticket="${id}"] small`).innerText(),/^user \(US-5\) · /);await page.locator(`[data-ticket="${id}"]`).click();await page.locator('.support-timeline li').first().waitFor();assert.match(await page.locator('#supportDetail').innerText(),/Submitted by user \(US-5\)/);assert.match(await page.locator('.support-timeline li').first().innerText(),/user \(US-5\)/);assert.equal((await page.locator('#supportDetail').innerText()).includes('user@example.test'),false);const download=page.waitForEvent('download');await page.locator('#downloadSupportExcel').click();await(await download).saveAs('test-results/support-report.xlsx');assert.ok((await require('jszip').loadAsync(fs.readFileSync('test-results/support-report.xlsx'))).file('xl/worksheets/sheet1.xml'),'Technical Support Excel downloads');await page.locator('#supportFilterRequester').selectOption('');await logout();
await login('rni');
assert.equal(await page.locator('#nav [data-tab=dashboard]').isVisible(),false,'v2.5.6: R&I needs the Usage Dashboard tick');
await page.locator('.appearance-menu summary').click();
await page.locator('#realtimeStatus').filter({hasText:'Realtime connected'}).waitFor();
await page.locator('.appearance-menu summary').click();
await tab('damage-demand');
await page.locator('#damageChartTitle').waitFor();
assert.equal(await page.locator('[data-damage-pane=demand]').count(),0);

await category();
assert.equal(await page.locator('#newSupportRequest').count(),0);
await page.locator(`[data-ticket="${id}"]`).click();
await page.locator('#receiveSupport').click();
await page.locator('#supportComment').fill('Replace the damaged main contactor.');
await page.locator('#supportDuration').fill('22.5');
await page.locator('#supportHardware input[value=false]').check();
await page.evaluate(()=>window.__emitRealtime('wlf_requests'));
await page.waitForTimeout(700);
assert.equal(await page.locator('#supportComment').inputValue(),'Replace the damaged main contactor.');
assert.equal(await page.locator('#supportDuration').inputValue(),'22.5');
assert.equal(await page.locator('#supportHardware input[value=false]').isChecked(),true);
assert.equal(await page.locator('#supportBadge').innerText(),'1');

await page.locator('#supportHardware input[value=true]').check();
let dialog=page.locator('#wlfDamageDialog');
await dialog.waitFor();
assert.deepEqual(await dialog.locator('input').evaluateAll(nodes=>nodes.filter(node=>node.type!=='radio').map(node=>node.name)),
 ['confirmedBy','hwDemManual','itemName','itemCode','itemSpec','quantity']);
assert.equal(await dialog.locator('#hwDemModel').count(),1);
assert.equal(await dialog.locator('#hwDemSupplier').count(),1);
assert.ok((await dialog.locator('#hwDemModel option').count())>20,'every catalogue model is listed');
await dialog.locator('#hwDemList tbody tr').first().waitFor();
assert.equal(await dialog.locator('#hwDemSupplier').inputValue()!=='' || (await dialog.locator('#hwDemSupplier option').count())>1,true);
assert.equal(await dialog.locator('[name=confirmedBy]').inputValue(),'rni');
assert.equal(await dialog.locator('[name=confirmedBy]').evaluate(n=>n.readOnly),true);
assert.equal(await dialog.getByText('Replace the damaged main contactor.',{exact:true}).count(),0);
const canceled=await dialog.getByRole('button',{name:'Cancel',exact:true}).evaluate(button=>{
 const popup=button.closest('dialog');
 button.click();
 return {closed:!popup.open,noChecked:document.querySelector('#supportHardware input[value=false]').checked};
});
assert.deepEqual(canceled,{closed:true,noChecked:true});
await page.locator('#supportHardware input[value=true]').check();
await dialog.waitFor();
await page.keyboard.press('Escape');
await dialog.waitFor({state:'hidden'});
assert.equal(await page.locator('#supportHardware input[value=false]').isChecked(),true);
await page.locator('#supportHardware input[value=true]').check();
await dialog.locator('#hwDemManual').check();
await dialog.locator('[name=itemName]').fill('Main contactor');
await dialog.locator('[name=itemCode]').fill('=1+1');
await dialog.locator('[name=itemSpec]').fill('24 V DC');
await dialog.locator('[name=quantity]').fill('1.5');
assert.equal(await dialog.locator('[name=quantity]').evaluate(n=>n.validity.valid),false);
await dialog.locator('[name=quantity]').fill('2');
await page.setViewportSize({width:390,height:844});
await page.screenshot({path:'test-results/damage-demand-popup-mobile.png'});
assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
await page.setViewportSize({width:1280,height:900});
await dialog.getByRole('button',{name:'Submit demand',exact:true}).click();
await page.locator('#supportActionStatus').filter({hasText:'Damage demand submitted to Dispatch.'}).waitFor();
const demandStatus=page.locator('#supportDamageStatus');
assert.match(await demandStatus.innerText(),/DD-\d+.*Pending/s);
assert.equal(await page.locator('#supportHardware input[value=true]').isChecked(),true);
assert.equal(await page.locator('#supportHardware input[value=true]').isDisabled(),true);
assert.equal(await page.locator('#supportComment').inputValue(),'Replace the damaged main contactor.');
await page.locator('#solveSupport').click();
await page.locator('#supportDetail .support-status').filter({hasText:'Solved'}).waitFor();
assert.equal(await page.locator('#supportBadge').isVisible(),false);
await page.screenshot({path:'test-results/damage-demand-support-status.png',fullPage:true});

await tab('damage-demand');
await page.locator('#damageChartTitle').waitFor();
assert.equal(await page.locator('[data-damage-pane=dashboard]').count(),1);
await page.locator('#damageFilters [name=category]').selectOption('commissioning');
await page.locator('#damageFilters [name=component]').selectOption('v:main contactor');
const today=await page.evaluate(()=>AccessCore.dateKey(new Date()));
await page.locator('#damageFilters summary').click();
await page.locator('#damageFilters [name=from]').fill(today);
await page.locator('#damageFilters [name=to]').fill(today);
const filteredDashboard=page.waitForResponse(response=>response.url().endsWith('/rest/v1/rpc/wlf_rpc')&&
 response.request().postDataJSON()?.action==='getDamageDashboard');
await page.getByRole('button',{name:'Apply filters',exact:true}).click();
assert.ok((await filteredDashboard).ok());
await page.locator('.damage-chart').getByText('2 units · 100%').waitFor();
assert.equal(await page.locator('.damage-chart meter').getAttribute('value'),'100');
const damageFile=page.waitForEvent('download');
await page.locator('#damageExport').click();
const exportedDamage=await damageFile;
assert.match(exportedDamage.suggestedFilename(),/^WLF-Damage-Demand-.*\.xlsx$/);
await exportedDamage.saveAs('test-results/damage-demand.xlsx');
const damageZip=await Zip.loadAsync(fs.readFileSync('test-results/damage-demand.xlsx'));
assert.ok(damageZip.file('xl/tables/table2.xml'));
const damageSheet=await damageZip.file('xl/worksheets/sheet1.xml').async('string');
assert.match(damageSheet,/Main contactor/);
assert.match(damageSheet,/=1\+1/);
assert.doesNotMatch(damageSheet,/<f>/);
assert.match(await damageZip.file('xl/worksheets/sheet2.xml').async('string'),/<v>100<\/v>/);
await page.locator('[data-damage-status=Pending]').click();
await page.getByRole('heading',{name:'Pending demands',exact:true}).waitFor();
assert.match(await page.locator('#damageResults tbody').innerText(),/Main contactor/);
await page.locator('[data-damage-status=Received]').click();
await page.getByRole('heading',{name:'Received demands',exact:true}).waitFor();
await page.locator('#damageResults').getByText('No demands match these filters.').waitFor();
assert.equal(await page.locator('[data-damage-status=Pending] b').innerText(),'1');
await page.screenshot({path:'test-results/damage-demand-dashboard.png',fullPage:true});
await page.setViewportSize({width:390,height:844});
await page.evaluate(()=>closeSidebar());
await page.waitForFunction(()=>document.getElementById('sidebar').getBoundingClientRect().right<=1);
assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
await page.screenshot({path:'test-results/damage-demand-dashboard-mobile.png',fullPage:true});
await page.setViewportSize({width:1280,height:900});
await logout();

await login('user');
await category();
await page.locator(`[data-ticket="${id}"]`).click();
await page.locator('#supportDamageStatus').filter({hasText:'Pending'}).waitFor();
assert.equal(await page.locator('#nav [data-tab=damage-demand]').isVisible(),false);
await logout();

await login('admin');
await tab('damage-demand');
await page.locator('[data-damage-view]').waitFor();
assert.equal(await page.locator('[data-damage-pane=dashboard]').count(),0);
await page.locator('#damageFilters summary').click();
await page.locator('#damageFilters [name=lift]').fill('991234');
await page.locator('#damageFilters [name=project]').fill('Browser verification');
await page.getByRole('button',{name:'Apply filters',exact:true}).click();
await page.locator('#damageStatus').filter({hasNotText:'Loading'}).waitFor({state:'attached'});
await page.locator('[data-damage-view]').click();
await dialog.getByRole('heading',{name:'Solution statement'}).waitFor();
await dialog.getByText('Replace the damaged main contactor.',{exact:true}).waitFor();
await dialog.getByText('Submitted support form details',{exact:true}).click();
assert.ok(await dialog.getByText('991234',{exact:true}).isVisible());
assert.ok(await dialog.getByText('Plot 14, Dhaka',{exact:true}).isVisible());
await page.locator('#damageReceive').click();
await page.locator('#damageDetailStatus').filter({hasText:'Demand received.'}).waitFor();
assert.equal(await dialog.locator('.support-status').innerText(),'Received');
await dialog.getByRole('button',{name:'Close',exact:true}).click();
await page.locator('#damageResults tbody .support-status').filter({hasText:'Received'}).waitFor();
assert.equal(await page.locator('#damageFilters [name=status]').inputValue(),'');
await page.locator('[data-damage-view]').click();
await dialog.getByRole('heading',{name:'Solution statement'}).waitFor();
assert.equal(await dialog.locator('#damageReceive').count(),0);
await dialog.getByRole('button',{name:'Close',exact:true}).click();
await logout();

await login('sa');
assert.equal(await page.locator('#nav [data-tab=damage-demand] + [data-tab=supplier-claim] + [data-tab=qms] + [data-tab=catalogue] + [data-tab=workspace-dashboard]').count(),1);assert.equal(await page.locator('#nav [data-damage-nav]').count(),0,'v2.5.3: no Demand/Dashboard sub-items in the menu');
fs.mkdirSync('test-results/v259',{recursive:true});fs.mkdirSync('test-results/v260',{recursive:true});
await tab('qms');
await page.locator('#qmsLiftForm').waitFor();
await page.locator('#qmsLiftForm [name=liftId]').fill('L-101');
await page.locator('#qmsLiftForm [name=project]').fill('WLF North Tower');
await page.locator('#qmsLiftForm [name=address]').fill('Gulshan-2, Dhaka');
/* v2.6.7: Address, Motor type and Lift type are required and have no default */
for(const n of ['address','motorType','liftType']) assert.equal(await page.locator('#qmsLiftForm [name='+n+']').getAttribute('required')!==null,true,n+' is required');
assert.equal(await page.locator('#qmsLiftForm [name=motorType]').inputValue(),'');assert.equal(await page.locator('#qmsLiftForm [name=liftType]').inputValue(),'');
await page.locator('#qmsLiftForm [name=motorType]').selectOption('Gearless');await page.locator('#qmsLiftForm [name=liftType]').selectOption('Passenger');
await page.locator('#qmsLiftForm [name=deliveryDate]').fill('2026-11-25');
/* v2.6.0: motor first (section 2), then suggested controllers and AVR fill the rest */
const order=await page.locator('#qmsLiftForm legend').allInnerTexts();
assert.match(order[1],/^2 · Motor selection/);assert.match(order[2],/^3 · Control system/);
assert.equal(await page.locator('#qmsLiftForm [name=sl-drive]').getAttribute('required')!==null,true,'serial numbers are required');
assert.equal(await page.locator('#hwMotorSearch').isDisabled(),false,'motor list is available from Component Selection data');
await page.locator('#hwMotorSearch').click();await page.locator('.hw-motor-chip').first().click();await page.locator('#hwMotorResult table').first().waitFor();
const motorModel=await page.locator('#hwMotorResult table').first().innerText();
await page.locator('#hwSuggest [data-suggest-ctrl]').first().waitFor();
const suggested=await page.locator('#hwSuggest [data-suggest-ctrl]').allInnerTexts();
assert.ok(suggested.some(x=>/^MOT \d/.test(x)),'a MOT controller is suggested: '+suggested);
await page.locator('#hwSuggest [data-suggest-ctrl]').first().click();
assert.match(await page.locator('#qmsLiftForm [name=system]').inputValue(),/MOT|NICE3000\+/);
const chosenModel=await page.locator('#qmsLiftForm [name=controllerModel]').inputValue();
assert.equal(chosenModel,suggested[0],'the suggestion filled the controller model');
assert.match(await page.locator('.hw-auto').innerText(),/items are added automatically/);
assert.equal(await page.locator('#qmsLiftForm .hw-table thead').evaluateAll(a=>a.filter(e=>!e.closest('#hwAvr')).length),0,'the long controller list is not opened');
for(const sel of await page.locator('[data-control-pick]').all()) await sel.selectOption({index:1});
/* v2.6.7: the AVR model follows the motor by itself, sits in the control system section, and can be changed by hand */
assert.match(await page.locator('#qmsLiftForm [name=avrModel]').inputValue(),/^AVR \d+ KVA$/,'the motor selection filled the AVR model');
assert.equal(await page.locator('#qmsLiftForm [name=avr]').count(),0,'there is no AVR item dropdown any more');
assert.equal(await page.locator('#hwAvr').locator('xpath=ancestor::fieldset[1]/legend').innerText().then(x=>/^3 · Control system/.test(x)),true,'AVR model is in the control system section');
await page.locator('#qmsLiftForm [name=avrModel]').selectOption('AVR 30 KVA');
assert.equal(await page.locator('#hwAvr tbody tr').count(),15,'all 15 items of AVR 30 KVA are listed in their own table');
assert.ok((await page.locator('#hwAvr').innerText()).includes('Full AVR'));
assert.equal(await page.locator('#qmsLiftForm [name=sl-avr]').getAttribute('required')!==null,true,'AVR SL is required once an AVR model is chosen');
assert.equal(await page.locator('#qmsLiftForm [name=sl-battery]').evaluate(e=>e.tagName),'TEXTAREA');assert.equal(await page.locator('#qmsLiftForm [name=sl-battery]').getAttribute('required'),null,'Battery SL is optional');
await page.locator('#qmsLiftForm [name=lop]').selectOption({index:1});
await page.locator('#qmsLiftForm [name=cop0]').selectOption({index:1});
await page.locator('#qmsLiftForm [name=transom]').selectOption({index:1});
await page.locator('#qmsLiftForm [name=cable]').selectOption({index:1});
const faceplates=await page.locator('#qmsLiftForm [name=faceplate] option').allInnerTexts();
for(const name of ['Hairline','Silver Mirror','Golden Mirror','Black Mirror','Black Hairline','Rose Gold Mirror']) assert.ok(faceplates.some(x=>x.startsWith(name)),'faceplate '+name);
assert.equal((await page.locator('#qmsLiftForm [name=controllerModel] option').allInnerTexts()).filter(x=>/kW/.test(x)).join('|'),['MOT 5.5 kW','MOT 7.5 kW','MOT 11 kW','MOT 15 kW','MOT 22 kW','MOT 37 kW'].join('|'),'controller models run from small to big');
assert.ok(!(await page.locator('#qmsLiftForm [name=system] option').allInnerTexts()).includes('MOTCUBE'),'MOTCUBE is not a QMS controller');
await page.locator('#qmsLiftForm input[name=other]').first().check();
const qmsSubmit=async()=>{const b=page.locator('#qmsLiftForm [type=submit]');await b.scrollIntoViewIfNeeded();await b.focus();await page.waitForTimeout(200);await b.click();};/* CI lesson (v2.5.1): focus first so scrolling cannot move the button between mousedown and mouseup */
/* every serial number is required */
await qmsSubmit();
await page.locator('#qmsLiftStatus').filter({hasText:/Enter the Motor SL/}).waitFor();
const fillSerials=async()=>{for(const [k,v] of Object.entries({motor:'M-100',encoder:'E-200',drive:'D-88213',ups:'U-300',cartop:'CT-400',cop:'CP-500',copDisplay:'CD-600',avr:'AV-700',battery:'BAT-1, BAT-2, BAT-3, BAT-4, BAT-5'})) await page.locator('#qmsLiftForm [name=sl-'+k+']').fill(v);};
await page.locator('#qmsLiftForm [name=sl-motor]').fill('M-100');await page.locator('#qmsLiftForm [name=sl-encoder]').fill('E-200');
await qmsSubmit();
await page.locator('#qmsLiftStatus').filter({hasText:/Enter the Drive SL/}).waitFor();
await fillSerials();
await page.screenshot({path:'test-results/v260/03-qms-input-desktop.png',fullPage:true});
{const vp=page.viewportSize();await page.setViewportSize({width:360,height:800});await page.waitForTimeout(300);
const over=await page.evaluate(()=>({sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth,wide:[...document.querySelectorAll('#qmsLiftForm *')].filter(e=>!e.closest('.tbl-wrap')&&e.getBoundingClientRect().right>document.documentElement.clientWidth+1).slice(0,3).map(e=>e.tagName+'.'+e.className)}));
await page.screenshot({path:'test-results/v260/03-qms-motor-selected-360.png',fullPage:true});
if(over.sw>over.cw+1||over.wide.length)throw Error('MOBILE-OVERFLOW '+JSON.stringify(over));
await page.setViewportSize(vp);}
await qmsSubmit();
await page.locator('#qmsLiftStatus').filter({hasText:'Lift L-101 saved'}).waitFor().catch(async e=>{throw Error('QMS-DIAG status=['+(await page.locator('#qmsLiftStatus').innerText().catch(()=>'?'))+'] errors='+JSON.stringify(errors)+' console='+JSON.stringify((globalThis.consoleErrors||[]).slice(-5))+' disabled='+(await page.locator('#qmsLiftForm [type=submit]').isDisabled().catch(()=>'?')));});
await page.locator('#qmsLiftForm [name=liftId]').fill('l-101 ');
await page.locator('#qmsLiftForm [name=project]').fill('Other');
await page.locator('#qmsLiftForm [name=deliveryDate]').fill('2026-11-26');await page.locator('#qmsLiftForm [name=address]').fill('Banani');await page.locator('#qmsLiftForm [name=motorType]').selectOption('Gear');await page.locator('#qmsLiftForm [name=liftType]').selectOption('Cargo');
await page.locator('#qmsLiftForm [name=system]').selectOption('MOT');
await page.locator('#qmsLiftForm [name=controllerModel]').selectOption('MOT 5.5 kW');
for(const sel of await page.locator('[data-control-pick]').all()) await sel.selectOption({index:1});
await fillSerials();
await qmsSubmit();
await page.locator('#qmsLiftStatus').filter({hasText:'Lift ID already exists'}).waitFor();
await page.locator('#qmsTabData').click();
await page.locator('#qmsSearch [name=liftId]').fill('L-101');
await page.locator('#qmsSearch [type=submit]').click();
await page.locator('.hw-out h3').filter({hasText:'L-101'}).waitFor();
assert.equal(await page.locator('.hw-out .overview-eyebrow').count()>=9,true,'nine output tables');
const qmsText=await page.locator('#tab-qms').innerText();
for(const word of ['PROJECT INFORMATION','SELECTED MOTOR','Capacity','CONTROL SYSTEM','SERIAL NUMBERS','COP · LOP','6 · AVR — AVR 30 KVA','7 · OTHER COMPONENTS','SDB main breaker','Price','WLF North Tower','D-88213','E-200','CP-500','AV-700','BAT-1, BAT-2, BAT-3, BAT-4, BAT-5','Cooling Fan']) assert.ok(qmsText.toLowerCase().includes(word.toLowerCase()),word);
await page.screenshot({path:'test-results/v260/04-qms-data-desktop.png',fullPage:true});
const qmsDl=page.waitForEvent('download');
await page.locator('#qmsExcel').click();
await (await qmsDl).saveAs('test-results/v259/qms-L-101.xlsx');
const qmsZip=await Zip.loadAsync(fs.readFileSync('test-results/v259/qms-L-101.xlsx'));
assert.match(await qmsZip.file('xl/worksheets/sheet1.xml').async('string'),/L-101/);assert.equal(qmsZip.file('xl/worksheets/sheet2.xml'),null,'v2.6.4: one sheet only');assert.match(await qmsZip.file('xl/worksheets/sheet1.xml').async('string'),/Travelling Cable TVVB 36 core/);
await page.locator('#qmsEdit').click();
await page.locator('#qmsLiftForm [name=project]').fill('WLF North Tower 2');
await qmsSubmit();
await page.locator('.hw-out h3').filter({hasText:'WLF North Tower 2'}).waitFor();
assert.match(await page.locator('.hw-history').textContent(),/edited \(Project\)/);
await tab('workspace-dashboard');
await page.locator('#workspaceFilters h3',{hasText:'Admin Panel'}).waitFor();
await page.locator('#apBody .mgmt-card').first().waitFor();
assert.deepEqual(await page.locator('#apDash option').allInnerTexts(),['R&I team activity','R&I Project Manager','Technical Support','Damage Demand','Supplier claim','QMS','Performance curves']);
await page.selectOption('#apDash','qms');
assert.equal(await page.locator('#apBody .overview-metric').filter({hasText:'Lifts recorded'}).locator('strong').innerText(),'1');
await page.selectOption('#apDash','support');
assert.equal(await page.locator('#apBody svg.ap-chart').count()>=1,true,'Technical Support has a curve');
assert.equal(await page.locator('#workspaceFilters [name=from]').inputValue(),(await page.evaluate(()=>AccessCore.dateKey(new Date()))).slice(0,8)+'01','this month by default');
const kpiFile=page.waitForEvent('download');
await page.locator('#workspaceExport').click();
await (await kpiFile).saveAs('test-results/workspace-kpis.xlsx');
const kpiZip=await Zip.loadAsync(fs.readFileSync('test-results/workspace-kpis.xlsx'));
assert.match(await kpiZip.file('xl/worksheets/sheet11.xml').async('string'),/Lifts recorded/);
await page.evaluate(()=>setAppearance('light'));
await page.screenshot({path:'test-results/workspace-kpis.png'});
await page.setViewportSize({width:320,height:760});
await page.waitForFunction(()=>document.getElementById('sidebar').getBoundingClientRect().right<=1);
await checkRiMobileFit('#tab-workspace-dashboard');
await page.screenshot({path:'test-results/workspace-kpis-mobile.png'});
await tab('qms');
await page.locator('#qmsLiftForm').waitFor();
await checkRiMobileFit('#tab-qms');
await page.screenshot({path:'test-results/v260/03-qms-input-mobile.png',fullPage:true});
await page.setViewportSize({width:1280,height:900});
await logout();

await login('user');
assert.equal(await page.locator('#nav [data-tab=qms]').isVisible(),false);
assert.equal(await page.locator('#nav [data-tab=workspace-dashboard]').isVisible(),false);
await tab('account');
await page.getByRole('heading',{name:'Performance'}).waitFor();assert.equal(await page.getByRole('heading',{name:'My activity'}).count(),0,'My activity is removed from My Profile');
assert.equal(await page.locator('#pageTitle').innerText(),'My Profile');
assert.equal(await page.locator('#profileOverview').getByText('Drive unit',{exact:false}).count(),0);
assert.match(await page.locator('#profileOverview').innerText(),/user@example.test/);assert.match(await page.locator('#profileOverview').innerText(),/US-5/);assert.match(await page.locator('#profileOverview').innerText(),/Commissioning/);
await page.screenshot({path:'test-results/workspace-profile.png'});
await page.setViewportSize({width:320,height:760});
await page.waitForFunction(()=>document.getElementById('sidebar').getBoundingClientRect().right<=1);
await page.evaluate(()=>setAppearance('dark'));
await checkRiMobileFit('#tab-account');
await page.screenshot({path:'test-results/workspace-profile-mobile.png'});
await page.setViewportSize({width:1280,height:900});
await category();
await page.locator(`[data-ticket="${id}"]`).click();
await page.locator('#supportDamageStatus').filter({hasText:'Received'}).waitFor();
assert.match(await page.locator('#supportDetail').innerText(),/Duration \(Min\) 22.5/);

await page.setViewportSize({width:390,height:844});await page.evaluate(()=>closeSidebar());await page.waitForFunction(()=>document.getElementById('sidebar').getBoundingClientRect().right<=1);const mobile=await page.evaluate(()=>{let logo=document.querySelector('.header-company-logo').getBoundingClientRect(),title=document.getElementById('pageTitle').getBoundingClientRect(),menu=document.querySelector('.appearance-menu').getBoundingClientRect();return{left:logo.x<title.x,right:menu.x>title.right,edge:innerWidth-menu.right};});assert.ok(mobile.left&&mobile.right&&mobile.edge<25);await page.locator('.appearance-menu summary').click();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.locator('.appearance-menu summary').click();await page.screenshot({path:'test-results/supabase-mobile-support.png',fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
// Actual service worker caches project-subpath shell; downloaded references work offline.
/* ---- v2.5.0: duplicate ID, copy access, change history, old-request colours, Bangla troubleshooting, notifications, activity layout ---- */
{
await logout();await login('sa');fs.mkdirSync('test-results/v250',{recursive:true});
const v250shot=async(name,{full=false,mobileOnlyTop=false}={})=>{for(const [w,hh,label] of [[1440,900,'desktop'],[390,844,'mobile']]){await page.setViewportSize({width:w,height:hh});if(w<500)await page.evaluate(()=>closeSidebar());await page.waitForTimeout(120);for(const theme of ['light','dark']){await page.evaluate(t=>setAppearance(t),theme);await page.waitForTimeout(120);await page.screenshot({path:`test-results/v250/${name}-${label}-${theme}.png`,fullPage:full});}if(w<500)assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' fits phone width');}await page.setViewportSize({width:1280,height:900});await page.evaluate(()=>setAppearance('light'));};
await sequential(()=>h.db.query('alter table public.wlf_profiles disable trigger wlf_deletion_guard'));
await sequential(()=>h.db.query("update public.wlf_profiles set employee_id='RN-3' where id=$1",[IDS.rni2]));
await sequential(()=>h.db.query('alter table public.wlf_profiles enable trigger wlf_deletion_guard'));
await tab('users');await page.locator('#userAccessSearch').fill('');await page.locator('.access-user').first().waitFor();
await page.locator('#userDupCount').filter({hasText:'2 user(s)'}).waitFor();assert.equal(await page.locator('.access-user mark.dup-id').count(),2);
const target=page.locator('.access-user').filter({has:page.locator('[data-access-user="user@example.test"]')});
await target.locator('summary').click();
await target.locator('.access-copy').selectOption('rni@example.test');await target.locator('.access-copy-btn').click();
await page.locator('#accessStatus').filter({hasText:'Copied'}).waitFor();
const rniPerms=(await sequential(()=>h.db.query('select permissions from public.wlf_profiles where id=$1',[IDS.rni]))).rows[0].permissions;
assert.deepEqual((await target.locator('.access-group input:checked').evaluateAll(n=>n.map(x=>x.value))).sort(),[...rniPerms].sort());
await target.locator('.access-save').click();await page.locator('#accessStatus').filter({hasText:'Saved'}).waitFor();
await target.locator('.access-history-btn').click();await target.locator('.access-history li').first().waitFor();
assert.match(await target.locator('.access-history').innerText(),/by .*\(SA-1\)/);
await target.locator('.dup-id-warning').count().then(n=>assert.equal(n,0));
const dupBox=page.locator('.access-user').filter({has:page.locator('[data-access-user="rni2@example.test"]')});await dupBox.locator('summary').click();await dupBox.locator('.dup-id-warning').waitFor();
await dupBox.scrollIntoViewIfNeeded();await v250shot('01-user-duplicate-id');
await target.scrollIntoViewIfNeeded();await target.locator('.access-tools').scrollIntoViewIfNeeded();await v250shot('02-user-copy-access-history');
// old-request colours
const reqForm=(await h.rpc('user','getSupportWorkspace',[{category:'commissioning'}])).forms.commissioning;
for(let i=0;i<2;i++)await sequential(()=>h.rpc('user','createSupportRequest',[{category:'commissioning',formRevision:reqForm.revision,mutationId:crypto.randomUUID(),values:withModel(Object.fromEntries(reqForm.fields.filter(f=>!f.dependsOn).map(f=>[f.id,f.id==='problem_category'?'Encoder problem':f.type==='multi'?f.options.slice(0,1):f.type==='date'?'2026-11-15':f.type==='number'?'1200':f.type==='checkbox'?(f.options?.length?[]:false):f.options?.[0]||('Aged request '+(i+1))])))}]));
const open=(await sequential(()=>h.db.query("select id from public.wlf_requests where category='commissioning' and status<>'Solved' and deleted_at is null order by created_at desc limit 2"))).rows;
assert(open.length>=2,'two open commissioning requests');
await sequential(()=>h.db.query("update public.wlf_requests set created_at=now()-interval '4 days' where id=$1",[open[0].id]));
await sequential(()=>h.db.query("update public.wlf_requests set created_at=now()-interval '2 days 1 hour' where id=$1",[open[1].id]));
await page.evaluate(()=>{if(window.LiveWorkspace&&LiveWorkspace.reset)LiveWorkspace.reset();});
await tab('technical');await page.locator('[data-support-category="commissioning"]').click();await page.locator('#supportRefresh').click();
await page.locator('.support-request.aged-red').first().waitFor();await page.locator('.support-request.aged-yellow').first().waitFor();
assert.match(await page.locator('.support-request.aged-red .age-badge').first().innerText(),/4 days old/);
await v250shot('03-support-old-request-colours');
await page.locator('.age-settings summary').click();await page.locator('#ageYellow').fill('1');await page.locator('#ageRed').fill('5');await page.locator('#ageSave').click();
await page.locator('.age-legend').filter({hasText:'5+ days'}).first().waitFor();assert.equal(await page.locator('.support-request.aged-red').count(),0);
await page.locator('.age-settings summary').click();await page.locator('#ageYellow').fill('2');await page.locator('#ageRed').fill('3');await page.locator('#ageSave').click();await page.locator('.support-request.aged-red').first().waitFor();
// Bangla troubleshooting
await tab('troubleshooting');await page.locator('[data-section="NICE3000+"]').click();await page.locator('#tbErrors').click();await page.locator('#tbSearch').fill('Err20 5');
await page.locator('#tbDetail [data-subcode="5"]').waitFor();await page.locator('[data-tb-lang="bn"]').click();
await page.locator('#tbDetail [data-subcode="5"][lang="bn"]').waitFor();assert.match(await page.locator('#tbDetail').innerText(),/সাবকোড 5: SIN\/COS encoder-এর cable/);
await page.locator('#tbSearch').fill('');await page.locator('#tbSearch').fill('Err02');await page.locator('#tbDetail h4').filter({hasText:'সমাধান'}).waitFor();assert.match(await page.locator('#tbDetail .tb-steps li').first().innerText(),/^কারণ: /);
await v250shot('04-troubleshooting-bangla');
await page.locator('#tbBack').click();await page.locator('#tbBack').click();await page.locator('[data-section="MOT"]').click();await page.locator('#tbErrors').click();await page.locator('#tbSearch').fill('Er04');await page.locator('#tbDetail [lang="bn"]').first().waitFor();
await page.locator('[data-tb-lang="en"]').click();await page.locator('#tbDetail').filter({hasText:'No connection with ENCA board'}).waitFor();
// notifications card
await tab('account');await page.locator('#pushCard h3').filter({hasText:'Notifications'}).waitFor();assert.equal(await page.locator('#pushOn').count(),1);
await page.locator('#pushCard').scrollIntoViewIfNeeded();await v250shot('05-profile-notifications');
// R&I Team Activity: form left, recent entries right on wide screens
await tab('ri-activity');await page.locator('#riCategoryPicker').selectOption({label:'Team Activity'});await page.locator('#riEntryList .tbl-wrap').waitFor();
await page.setViewportSize({width:1440,height:900});const cols=await page.evaluate(()=>{const a=document.getElementById('riActivityForm').getBoundingClientRect(),b=document.getElementById('riEntryList').getBoundingClientRect();return {sameRow:Math.abs(a.top-b.top)<4,leftFirst:a.right<=b.left+1};});
assert.deepEqual(cols,{sameRow:true,leftFirst:true});await page.setViewportSize({width:1280,height:900});
await page.evaluate(()=>window.scrollTo(0,0));await v250shot('06-ri-team-activity-split');
await page.setViewportSize({width:390,height:844});const stacked=await page.evaluate(()=>document.getElementById('riEntryList').getBoundingClientRect().top>document.getElementById('riActivityForm').getBoundingClientRect().bottom-2);assert.equal(stacked,true);await page.setViewportSize({width:1280,height:900});
/* ---- v2.5.1: hidden auto-fill fields, Other name box, Sales dates, saved popup, compact list, Bangla editor ---- */
fs.mkdirSync('test-results/v251',{recursive:true});
const v251shot=async name=>{for(const [w,hh,label] of [[1440,900,'desktop'],[390,844,'mobile']]){await page.setViewportSize({width:w,height:hh});if(w<500)await page.evaluate(()=>closeSidebar());await page.waitForTimeout(120);for(const theme of ['light','dark']){await page.evaluate(t=>setAppearance(t),theme);await page.waitForTimeout(120);await page.screenshot({path:`test-results/v251/${name}-${label}-${theme}.png`});}if(w<500)assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' fits phone');}await page.setViewportSize({width:1280,height:900});await page.evaluate(()=>setAppearance('light'));};
await tab('ri-activity');await page.locator('#riCategoryPicker').selectOption({label:'Team Activity'});await page.locator('#riSubmitForm').waitFor();
assert.equal(await page.locator('#riSubmitForm [name=project]').count(),0,'Project / Task Name removed');
for(const n of ['date','login_name','login_id'])assert.equal(await page.locator('#riSubmitForm [name='+n+']').getAttribute('type'),'hidden',n+' hidden');
assert.equal(await page.locator('#riSubmitForm [name=subject]').evaluate(n=>n.closest('.field').classList.contains('span-all')),true,'Task Name full width');
assert.equal(await page.locator('[data-other-for=task_category]').isHidden(),true);
await page.locator('#riSubmitForm [name=subject]').fill('Vendor audit for door operator supplier');
await page.locator('#riSubmitForm input[name=task_category][value="Others"]').check();await page.locator('[data-other-for=task_category]').waitFor();
await page.locator('#riSubmitForm [name=duration_minute]').fill('45');
const before=globalThis.savedPopups.length;
await page.locator('#riSubmitForm [type=submit]').click();await page.locator('#riSubmitStatus').filter({hasText:'Write the others name'}).waitFor();
await page.locator('[data-other-for=task_category]').fill('Vendor audit');await v251shot('01-team-activity-form');
await page.locator('#riSubmitForm [type=submit]').click();await page.waitForFunction(n=>globalThis.savedPopups?true:true,before);
await page.locator('#riEntryList summary').filter({hasText:'Vendor audit for door operator supplier'}).first().waitFor();
assert.equal(globalThis.savedPopups.length,before+1);assert.equal(globalThis.savedPopups.at(-1),'Entry submitted');
const saved=(await sequential(()=>h.db.query("select values from public.wlf_ri_entries where category='wb-team' order by created_at desc limit 1"))).rows[0].values;
assert.deepEqual(saved.task_category,['Others: Vendor audit']);assert.equal(saved.date,(await sequential(()=>h.db.query("select to_char((now() at time zone 'Asia/Dhaka')::date,'YYYY-MM-DD') d"))).rows[0].d);
const rowH=await page.locator('#riEntryList tbody tr').first().evaluate(n=>n.getBoundingClientRect().height);assert(rowH<110,'compact entry row '+rowH);
await page.setViewportSize({width:1440,height:900});await page.locator('#riEntryList').scrollIntoViewIfNeeded();await page.screenshot({path:'test-results/v251/02-recent-entries-desktop-light.png'});await page.setViewportSize({width:1280,height:900});
await page.locator('#riCategoryPicker').selectOption({label:'Sales Support'});await page.locator('#riSubmitForm [name=start_date]').waitFor();
assert.equal(await page.locator('#riSubmitForm [name=start_date]').getAttribute('type'),'date');assert.equal(await page.locator('#riSubmitForm [name=end_date]').evaluate(n=>n.required),false);
await page.locator('#riSubmitForm [name=support_category]').selectOption('Other:');await page.locator('[data-other-for=support_category]').waitFor();
await page.locator('#riCategoryPicker').selectOption({label:'Supplier & SCM Cooperation'});await page.locator('#riSubmitForm [name=problem]').waitFor();
assert.equal(await page.locator('#riSubmitForm [name=problem]').evaluate(n=>n.closest('.field').classList.contains('span-all')),true,'SCM Task Details full width');
// Technical Support: Other box and saved popup
await tab('technical');if(await page.locator('#supportHome').isVisible())await page.locator('#supportHome').click();await page.locator('[data-support-category="commissioning"]').click();await page.locator('#newSupportRequest').click();await page.locator('#supportRequestForm').waitFor();
await page.locator('#supportRequestForm [name=pm]').selectOption({index:1});await page.locator('#supportRequestForm [name=project]').fill('Popup Tower');await page.locator('#supportRequestForm [name=lift]').fill('77');
await page.locator('#supportRequestForm [name=controller]').selectOption('MOT');await pickModel('MOT 7.5 kW');await page.locator('#supportRequestForm [name=problem_category]').selectOption('Others');
await page.locator('[data-other-for=problem_category]').fill('Landing door lock');await page.locator('#supportRequestForm [name=problem]').fill('Door lock contact opens at floor 3');
await page.removeLocatorHandler(globalThis.savedLocator);await page.locator('#supportRequestForm [type=submit]').click();
const savedDlg=page.locator('#wlfSavedDialog[open]');await savedDlg.waitFor();assert.equal(await savedDlg.locator('h3').innerText(),'Request submitted');assert.match(await savedDlg.innerText(),/Reference\s*TCS/);
await v251shot('05-support-saved-popup');await savedDlg.locator('[data-saved-close]').click();await page.addLocatorHandler(globalThis.savedLocator,globalThis.savedHandler);
assert.equal((await sequential(()=>h.db.query("select values->>'problem_category' v from public.wlf_requests where values->>'project'='Popup Tower'"))).rows[0].v,'Others: Landing door lock');
// Troubleshooting: Bangla editor; change English only -> that part shows English in Bangla view
await page.evaluate(()=>{if(window.__tbTrace)return;window.__tbTrace=[];const t0=performance.now(),T=(...a)=>{if(window.__tbTrace.length<400)window.__tbTrace.push(Math.round(performance.now()-t0)+'ms '+a.join(' '));};window.__tbT=T;
 ['mousedown','mouseup','click'].forEach(k=>document.addEventListener(k,e=>T(k,e.target.tagName+'#'+(e.target.id||'')+'.'+String(e.target.className||'').slice(0,24),'trusted='+e.isTrusted,Math.round(e.clientX)+','+Math.round(e.clientY)),true));
 const sm=HTMLDialogElement.prototype.showModal,cl=HTMLDialogElement.prototype.close;
 HTMLDialogElement.prototype.showModal=function(){T('showModal',this.id,'wasOpen='+this.open,(new Error().stack||'').split('\n').slice(2,6).map(x=>x.trim().slice(0,70)).join(' < '));return sm.apply(this,arguments);};
 HTMLDialogElement.prototype.close=function(){T('close()',this.id,'wasOpen='+this.open,(new Error().stack||'').split('\n').slice(2,5).map(x=>x.trim().slice(0,70)).join(' < '));return cl.apply(this,arguments);};
 document.addEventListener('close',e=>T('close-event',e.target.id),true);
 const si=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){T('setItem',String(k).slice(0,40),'len='+String(v).length);try{return si.apply(this,arguments);}catch(err){T('setItem FAILED',err.name,err.message.slice(0,80));throw err;}};
 window.addEventListener('error',e=>T('window.error',String(e.message).slice(0,120)));window.addEventListener('unhandledrejection',e=>T('unhandledrejection',String(e.reason&&e.reason.message||e.reason).slice(0,120)));});
const tbState=()=>page.evaluate(()=>{const b=document.getElementById('tbSave'),d=document.getElementById('tbEditor'),r=b&&b.getBoundingClientRect(),hit=r&&document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
 return JSON.stringify({saveButtons:document.querySelectorAll('#tbSave').length,editors:document.querySelectorAll('#tbEditor').length,openDialogs:Array.from(document.querySelectorAll('dialog[open]')).map(x=>x.id),onclick:b?typeof b.onclick:'no button',disabled:b&&b.disabled,rect:r&&[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)],hit:hit&&(hit.tagName+'#'+hit.id),viewport:[innerWidth,innerHeight],heading:(document.querySelector('#tbEditorBody h3')||{}).textContent,code:(document.getElementById('tbEditCode')||{}).value,status:(document.getElementById('tbEditStatus')||{}).textContent,bnChecked:(document.getElementById('tbBnChecked')||{}).checked,online:navigator.onLine,storageChars:Object.keys(localStorage).reduce((n,k)=>n+k.length+localStorage.getItem(k).length,0)});});
const tbSaved=async()=>{const beforeState=await tbState();await page.evaluate(()=>window.__tbT('--- test clicks Save ---'));await page.locator('#tbSave').focus();await page.waitForTimeout(150);await page.locator('#tbSave').click();try{await page.locator('#tbEditor').waitFor({state:'hidden',timeout:20000});}catch(err){throw Error('TB-DIAG before='+beforeState+' || after='+(await tbState())+' || trace='+JSON.stringify(await page.evaluate(()=>window.__tbTrace.slice(-60)))+' || Troubleshooting save did not close. Editor message: '+(await page.locator('#tbEditStatus').innerText().catch(()=>'?'))+' | outbox: '+(await page.locator('#tbPending').innerText().catch(()=>'?'))+' | console: '+JSON.stringify((globalThis.consoleErrors||[]).filter(x=>!/status of 400/.test(x))).slice(-800)+' | admin: '+(await page.evaluate(()=>!!SESSION&&SESSION.role)));}/* wait until the change has reached the server before the next step */await page.waitForFunction(()=>!document.querySelector('#tbPending .tb-outbox')&&!document.querySelector('#tbDetail .tb-pending-tag'),null,{timeout:30000});};
await tab('troubleshooting');for(let i=0;i<4&&!(await page.locator('[data-section="NICE3000+"]').isVisible());i++)await page.locator('#tbBack').click();await page.locator('[data-section="NICE3000+"]').click();await page.locator('#tbErrors').click();await page.locator('#tbSearch').fill('Err02');
await page.locator('[data-tb-lang="bn"]').click();await page.locator('#tbDetail [lang="bn"]').first().waitFor();await page.locator('#tbEdit').click();
await page.locator('.tb-bn-editor[open] #tbBnDescription').waitFor();assert.match(await page.locator('#tbBnDescription').inputValue(),/[ঀ-৿]/);
await page.locator('#tbEditDescription').fill((await page.locator('#tbEditDescription').inputValue())+' (checked)');
await page.locator('[data-step-list="base"] .tb-step-input').last().fill('Check the new step');
await page.locator('#tbEditorBody').evaluate(n=>n.scrollTop=0);await v251shot('03-troubleshooting-bangla-editor');
await tbSaved();
await page.locator('#tbDetail .tb-lang-note').filter({hasText:'হালনাগাদ হয়নি'}).waitFor();
assert.match(await page.locator('#tbDetail h4').first().innerText(),/\(checked\)$/);assert.match(await page.locator('#tbDetail').innerText(),/Check the new step/);
await v251shot('04-troubleshooting-bangla-stale');
await page.locator('#tbEdit').click();await page.locator('#tbBnDescription').fill('ড্রাইভ ওভারকারেন্ট (পরীক্ষিত)');await page.locator('#tbBnChecked').check();await tbSaved();
await page.locator('#tbDetail h4[lang="bn"]').filter({hasText:'পরীক্ষিত'}).waitFor();assert.equal(await page.locator('#tbDetail .tb-lang-note').filter({hasText:'হালনাগাদ'}).count(),0);
await page.locator('[data-tb-lang="en"]').click();
/* ---- v2.5.2: team badges, sub-category popup + editor, forwarded list, damage team tabs, Request access required, MOT title ---- */
fs.mkdirSync('test-results/v252',{recursive:true});
const v252shot=async(name,{phone=true}={})=>{for(const [w,hh,label] of [[1440,900,'desktop'],[390,844,'mobile']]){if(label==='mobile'&&!phone)continue;await page.setViewportSize({width:w,height:hh});if(w<500)await page.evaluate(()=>{if(typeof closeSidebar==='function')closeSidebar();});await page.waitForTimeout(150);for(const theme of ['light','dark']){await page.evaluate(t=>{if(typeof setAppearance==='function')setAppearance(t);},theme);await page.waitForTimeout(120);await page.screenshot({path:`test-results/v252/${name}-${label}-${theme}.png`});}if(w<500)assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' fits phone');}await page.setViewportSize({width:1280,height:900});await page.evaluate(()=>{if(typeof setAppearance==='function')setAppearance('light');});};
// team cards carry the same count as the menu badge
await tab('technical');if(await page.locator('#supportHome').isVisible())await page.locator('#supportHome').click();
await page.locator('[data-team-badge="commissioning"]').waitFor({state:'attached'});
const cardCount=await page.locator('[data-support-category="commissioning"] .support-team-name small').innerText();const badgeText=await page.locator('[data-team-badge="commissioning"]').innerText();
assert.equal(cardCount,badgeText+' unsolved');assert.ok(Number(badgeText)>0);assert.equal(await page.locator('[data-team-badge="commissioning"]').isVisible(),true);
await v252shot('01-support-team-badges');
// sub-category popup
await page.locator('[data-support-category="commissioning"]').click();await page.locator('#supportFilterQuery').waitFor();for(let i=0;i<4&&!(await page.locator('#supportRequestForm').isVisible());i++){await page.locator('#newSupportRequest').click();await page.locator('#supportRequestForm').waitFor({timeout:4000}).catch(()=>{});}await page.locator('#supportRequestForm').waitFor();
assert.equal(await page.locator('.wlf-dependent[data-dep-name=problem_sub]').isHidden(),true,'no sub-category before a category is chosen');
await page.locator('#supportRequestForm [name=pm]').selectOption({index:1});await page.locator('#supportRequestForm [name=project]').fill('Subcat Tower');await page.locator('#supportRequestForm [name=lift]').fill('252');
await page.locator('#supportRequestForm [name=controller]').selectOption('NICE3000+');await pickModel('NICE3000+ 7.5 kW');await page.locator('#supportRequestForm [name=problem]').fill('Err20 during travel');
await page.locator('#supportRequestForm [name=problem_category]').selectOption('NICE3000+ drive error');await page.locator('.wlf-dependent[data-dep-name=problem_sub]').waitFor();
await page.locator('.wlf-dependent[data-dep-name=problem_sub] .wlf-pick').click();await page.locator('#wlfPicker[open] .wlf-picker-search').fill('err20');
assert.equal(await page.locator('#wlfPicker [data-pick]:visible').count(),14);await v252shot('02-subcategory-popup');
await page.locator('#wlfPicker [data-pick="Err20 · Sub 5"]').click();assert.equal(await page.locator('.wlf-dependent[data-dep-name=problem_sub] .wlf-pick').innerText(),'Err20 · Sub 5');
await page.locator('#supportRequestForm [name=problem_category]').selectOption('Encoder problem');assert.equal(await page.locator('.wlf-dependent[data-dep-name=problem_sub]').isHidden(),true);
await page.locator('#supportRequestForm [name=problem_category]').selectOption('AVR related issue');
await page.locator('#supportRequestForm [type=submit]').click();await page.locator('#wlfPicker[open]').waitFor();await page.locator('#wlfPicker [data-pick="40 KVA"]').click();
await page.locator('#supportRequestForm [type=submit]').click();await page.locator('#supportDetail h3').filter({hasText:/-252-/}).waitFor();
assert.deepEqual((await sequential(()=>h.db.query("select values->>'problem_category' c, values->>'problem_sub' s from public.wlf_requests where values->>'project'='Subcat Tower'"))).rows[0],{c:'AVR related issue',s:'40 KVA'});
// Super Admin edits the lists
await page.locator('#supportHome').click();await page.locator('[data-support-category="commissioning"]').click();await page.locator('#manageSupportFields').click();
await page.locator('.schema-sublists[data-depends-on=problem_category]').waitFor();assert.equal(await page.locator('.schema-sublists[data-depends-on=problem_category] .schema-sublist').count(),6);assert.equal(await page.locator('.schema-sublists[data-depends-on=problem_category] .schema-sublist').filter({hasText:'MOTCUBE drive error'}).count(),1,'v2.5.8: MOTCUBE list is editable by Super Admin');
const avrList=page.locator('.schema-sublists[data-depends-on=problem_category] .schema-sublist').filter({hasText:'AVR related issue'});await avrList.locator('summary').click();
await avrList.locator('textarea').fill('15 KVA\n20 KVA\n150 KVA');
await page.locator('.schema-sublists[data-depends-on=problem_category] .schema-sublist-new').focus();await page.locator('.schema-sublists[data-depends-on=problem_category] .schema-sublist-new').selectOption('UPS related problem');await page.locator('.schema-sublists[data-depends-on=problem_category] [data-wlf-field="add-list"]').click();
await page.locator('.schema-sublists[data-depends-on=problem_category] .schema-sublist-items[data-key="UPS related problem"]').fill('1 KVA\n2 KVA');
await page.locator('.schema-sublists[data-depends-on=problem_category]').scrollIntoViewIfNeeded();await v252shot('03-subcategory-editor',{phone:false});
await page.locator('#saveSchemaFields').click();await page.waitForFunction(()=>!document.getElementById('supportSchemaEditor'));
const savedSub=(await sequential(()=>h.rpc('sa','getSupportWorkspace'))).forms.commissioning.fields.find(f=>f.id==='problem_sub');
assert.deepEqual(savedSub.optionMap['AVR related issue'],['15 KVA','20 KVA','150 KVA']);assert.deepEqual(savedSub.optionMap['UPS related problem'],['1 KVA','2 KVA']);
// forwarded to me
await sequential(()=>h.db.query("update public.wlf_profiles set permissions=array(select distinct unnest(permissions||array['support:commissioning:request'])) where id in ($1,$2)",[IDS.rni,IDS.rni2]));
const fwForm=(await sequential(()=>h.rpc('user','getSupportWorkspace',[{category:'commissioning'}]))).forms.commissioning;
let fw=(await sequential(()=>h.rpc('user','createSupportRequest',[{category:'commissioning',formRevision:fwForm.revision,mutationId:crypto.randomUUID(),values:withModel(Object.fromEntries(fwForm.fields.filter(f=>!f.dependsOn&&!f.autoFill).map(f=>[f.id,f.id==='problem_category'?'Encoder problem':f.id==='project'?'Forward Plaza':f.type==='date'?'2026-11-17':f.type==='number'?'77':f.type==='checkbox'?(f.options?.length?[]:false):f.type==='multi'?f.options.slice(0,1):f.options?.[0]||'Forward test'])))}]))).ticket;
fw=(await sequential(()=>h.rpc('rni','transitionSupportRequest',[{id:fw.id,revision:fw.revision,action:'receive',mutationId:crypto.randomUUID()}]))).ticket;
fw=(await sequential(()=>h.rpc('rni','transitionSupportRequest',[{id:fw.id,revision:fw.revision,action:'forward',to:'rni2@example.test',comment:'Please check the encoder wiring',mutationId:crypto.randomUUID()}]))).ticket;
await logout();await login('rni2');await tab('account');
await page.locator('#forwardedCard .forwarded-item').filter({hasText:'Forward Plaza'}).waitFor();
assert.match(await page.locator('#forwardedCard').innerText(),/Please check the encoder wiring/);
await page.locator('#forwardedCard').scrollIntoViewIfNeeded();await v252shot('04-profile-forwarded');
await page.locator('#forwardedCard .forwarded-item').filter({hasText:'Forward Plaza'}).click();
await page.locator('#supportDetail h3').filter({hasText:fw.reference}).waitFor();await page.locator('#receiveSupport').click();
await page.locator('#supportDetail').filter({hasText:'Received'}).first().waitFor();await tab('account');
await page.locator('#forwardedCard .note').filter({hasText:'Nothing waiting'}).waitFor();
// Request access: every field required
await logout();await page.locator('#tabRegister').click();await page.locator('#regBtn').click();
assert.equal(await page.locator('#registerForm .invalid').count(),5);assert.equal(await page.evaluate(()=>document.activeElement.id),'regName');
assert.equal(await page.locator('#registerForm .req').count(),6);await v252shot('05-request-access-required');
await page.locator('#tabLogin').click();
// Damage Demand by team (Super Admin sees the tabs)
await login('sa');await page.locator('#nav [data-tab=damage-demand]').click();await page.locator('.damage-team-tabs').waitFor();
assert.equal(await page.locator('.damage-team-tab').count(),5);await v252shot('06-damage-demand-teams');
await page.locator('.damage-team-tab[data-damage-team="aftersales"]').click();await page.locator('.damage-team-tab.active[data-damage-team="aftersales"]').waitFor();
await page.locator('.damage-team-tab[data-damage-team=""]').click();await page.locator('.damage-team-tab.active[data-damage-team=""]').waitFor();
/* ---- v2.5.3: My Profile first, menu red counts, Announcement, Recycle bin, Usage log 30 days, my work breakdown ---- */
fs.mkdirSync('test-results/v253',{recursive:true});
const v253shot=async(name,{phone=true}={})=>{for(const [w,hh,label] of [[1440,900,'desktop'],[390,844,'mobile']]){if(label==='mobile'&&!phone)continue;await page.setViewportSize({width:w,height:hh});if(w<500)await page.evaluate(()=>{if(typeof closeSidebar==='function')closeSidebar();});await page.waitForTimeout(150);for(const theme of ['light','dark']){await page.evaluate(t=>{if(typeof setAppearance==='function')setAppearance(t);},theme);await page.waitForTimeout(120);await page.screenshot({path:`test-results/v253/${name}-${label}-${theme}.png`});}if(w<500)assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' fits phone');}await page.setViewportSize({width:1280,height:900});await page.evaluate(()=>{if(typeof setAppearance==='function')setAppearance('light');});};
// the app opens on My Profile
await logout();await page.locator('#loginEmail').fill('sa@example.test');await page.locator('#loginPassword').fill('test-password-123');await page.locator('#loginBtn').click();await page.locator('#app').waitFor({state:'visible'});await page.waitForFunction(()=>SESSION&&!SESSION.bootstrapPending);
assert.equal(await page.locator('#nav button.active').getAttribute('data-tab'),'account');assert.equal(await page.locator('#pageTitle').innerText(),'My Profile');assert.equal(await page.locator('#tab-account').isVisible(),true);
// Damage Demand red count = pending demands
const pendingDemands=Number((await sequential(()=>h.db.query('select count(*)::int n from wlf_private.damage_demands where received_at is null'))).rows[0].n);
if(pendingDemands){await page.locator('#damageNavBadge:not([hidden])').waitFor();assert.equal(await page.locator('#damageNavBadge').innerText(),String(pendingDemands));}
assert.equal(await page.locator('#nav [data-damage-nav]').count(),0);
// Announcement for Commissioning
await page.locator('#nav [data-tab=announcements]').click();await page.locator('#annForm').waitFor();
await page.locator('#annTitle').fill('Site safety week');await page.locator('#annBody').fill('Wear helmets on every site.\nReport any unsafe lift pit.');
await page.locator('#annAll').uncheck();await page.locator('#annForm [name=section][value="Commissioning"]').check();await page.locator('#annEnd').fill('2099-12-31');
await page.locator('#annForm [type=submit]').click();await page.locator('#annStatus').filter({hasText:'Published'}).waitFor();
await page.locator('.ann-admin-item').filter({hasText:'Site safety week'}).waitFor();assert.match(await page.locator('.ann-admin-item').first().innerText(),/Read by 0 of 1/);
await v253shot('01-announcement-admin');
// Recycle bin: things deleted elsewhere wait here
const binForm=(await sequential(()=>h.rpc('user','getSupportWorkspace',[{category:'commissioning'}]))).forms.commissioning;
const binReq=(await sequential(()=>h.rpc('user','createSupportRequest',[{category:'commissioning',formRevision:binForm.revision,mutationId:crypto.randomUUID(),values:withModel(Object.fromEntries(binForm.fields.filter(f=>!f.dependsOn&&!f.autoFill).map(f=>[f.id,f.id==='problem_category'?'Encoder problem':f.id==='project'?'Bin Tower':f.type==='date'?'2026-11-17':f.type==='number'?'77':f.type==='checkbox'?(f.options?.length?[]:false):f.type==='multi'?f.options.slice(0,1):f.options?.[0]||'Bin test'])))}]))).ticket;
await sequential(()=>h.rpc('sa','deleteSupportRequest',[{id:binReq.id,revision:binReq.revision,mutationId:crypto.randomUUID()}]));
const binCat=(await sequential(()=>h.rpc('sa','getDocuments'))).categories[0];
const binDoc=await sequential(()=>h.rpc('sa','saveDocument',[{category:binCat.id,name:'Bin manual',url:'https://drive.google.com/file/d/bin/view',extra:{}}]));
await sequential(()=>h.rpc('sa','deleteDocument',[binDoc]));
const binDoc2=await sequential(()=>h.rpc('sa','saveDocument',[{category:binCat.id,name:'Old drawing',url:'https://drive.google.com/file/d/bin2/view',extra:{}}]));
await sequential(()=>h.rpc('sa','deleteDocument',[binDoc2]));
await page.locator('#nav [data-tab=recycle-bin]').click();await page.locator('#binTable').waitFor();
await page.locator('#binTable tr').filter({hasText:binReq.reference}).waitFor();await page.locator('#binTable tr').filter({hasText:'Bin manual'}).waitFor();
await v253shot('02-recycle-bin');
await page.locator('#binTable tr').filter({hasText:'Bin manual'}).locator('[data-bin-restore]').click();await page.locator('#binStatus').filter({hasText:'Restored: Bin manual'}).waitFor();
assert.ok((await sequential(()=>h.rpc('sa','getDocuments'))).documents.some(d=>d.id===binDoc.id),'document restored');
await page.locator('#binTable tr').filter({hasText:'Old drawing'}).locator('[data-bin-purge]').click();await page.locator('#wlfAdminDialog[open]').waitFor();
assert.match(await page.locator('#wlfAdminDialog').innerText(),/1 item/);await v253shot('03-recycle-bin-confirm',{phone:false});
await page.locator('#wlfAdminYes').click();await page.locator('#binStatus').filter({hasText:'deleted permanently'}).waitFor();
assert.equal(await page.locator('#binTable tr').filter({hasText:'Old drawing'}).count(),0);
await page.locator('#binEmpty').click();await page.locator('#wlfAdminDialog[open]').waitFor();assert.equal(await page.locator('#wlfAdminYes').isDisabled(),true);
await page.locator('#wlfAdminTyped').fill('delete');assert.equal(await page.locator('#wlfAdminYes').isDisabled(),true);
await page.locator('#wlfAdminTyped').fill('DELETE');await v253shot('04-recycle-bin-empty',{phone:false});await page.locator('#wlfAdminYes').click();
await page.locator('#binStatus').filter({hasText:'Recycle bin emptied'}).waitFor();assert.equal((await sequential(()=>h.db.query('select 1 from public.wlf_requests where id=$1',[binReq.id]))).rows.length,0);
await page.locator('.bin-log summary').click();assert.match(await page.locator('.bin-log').innerText(),/Empty bin/);
// Usage Dashboard: last 7 days + old log download, then DELETE
await sequential(()=>h.db.query("insert into public.wlf_usage(actor,action,details,at) values($1,'Login','',now()-interval '45 days'),($1,'Power Calculation','old',now()-interval '40 days')",[IDS.user]));
await page.locator('#nav [data-tab=dashboard]').click();await page.locator('#usageLogTable').waitFor();await page.locator('.usage-old').waitFor();
assert.match(await page.locator('.usage-old').innerText(),/2 activity log rows are older than 7 days/);
await page.locator('#usageMember').selectOption({label:'user (US-5)'});
await page.waitForFunction(()=>{const c=[...document.querySelectorAll('#usageLogTable tbody td:nth-child(2)')].map(x=>x.textContent);return c.length>0&&c.every(t=>t==='user (US-5)')&&document.getElementById('usageMember').value!=='';});
assert.equal(await page.locator('#usageOldDelete').isDisabled(),true);await v253shot('05-usage-log');
const oldLog=page.waitForEvent('download');await page.locator('#usageOldDownload').click();await (await oldLog).saveAs('test-results/v253/old-activity-log.xlsx');
assert.match(await (await Zip.loadAsync(fs.readFileSync('test-results/v253/old-activity-log.xlsx'))).file('xl/worksheets/sheet1.xml').async('string'),/Power Calculation/);
await page.locator('#usageOldDelete:not([disabled])').click();await page.locator('#wlfAdminTyped').fill('DELETE');await page.locator('#wlfAdminYes').click();
await page.locator('#globalMsg').filter({hasText:'2 old activity log rows deleted'}).waitFor();
assert.equal((await sequential(()=>h.db.query("select count(*)::int n from public.wlf_usage where at<now()-interval '7 days'"))).rows[0].n,0);
// Management Dashboard screenshots
await tab('workspace-dashboard');await page.locator('#apBody .mgmt-card').first().waitFor();await v253shot('06-management-dashboard');
// the Commissioning user: red count, announcement card, Read, my work breakdown
await logout();await login('user');await tab('account');
await page.locator('#announceCard .announce-item').filter({hasText:'Site safety week'}).waitFor();
await page.locator('#profileNavBadge:not([hidden])').waitFor();const before253=Number(await page.locator('#profileNavBadge').innerText());assert.ok(before253>=1);
assert.equal(await page.locator('#myActivityCard').count(),0,'v2.5.6: My Activity removed');
await page.locator('#announceCard').scrollIntoViewIfNeeded();await v253shot('07-profile-announcement');
await page.locator('[data-ann-read]').first().click();await page.locator('#announceCard .announce-old').waitFor();
await page.waitForFunction(n=>{const b=document.getElementById('profileNavBadge');return b&&(b.hidden?0:Number(b.textContent))===n-1;},before253);
await logout();await login('admin');await tab('account');await page.waitForTimeout(400);assert.equal(await page.locator('#announceCard').isHidden(),true,'Sales section does not get the Commissioning announcement');
await logout();await login('sa');
/* ---- v2.5.4: Component Selection reset, R&I Electrical support push, Supplier Claim ---- */
fs.mkdirSync('test-results/v254',{recursive:true});
const v254shot=async(name,{phone=true}={})=>{for(const [w,hh,label] of [[1440,900,'desktop'],[390,844,'mobile']]){if(label==='mobile'&&!phone)continue;await page.setViewportSize({width:w,height:hh});if(w<500)await page.evaluate(()=>{if(typeof closeSidebar==='function')closeSidebar();});await page.waitForTimeout(150);for(const theme of ['light','dark']){await page.evaluate(t=>{if(typeof setAppearance==='function')setAppearance(t);},theme);await page.waitForTimeout(120);await page.screenshot({path:`test-results/v254/${name}-${label}-${theme}.png`});}if(w<500)assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' fits phone');}await page.setViewportSize({width:1280,height:900});await page.evaluate(()=>{if(typeof setAppearance==='function')setAppearance('light');});};
// 1) Component Selection: Reset clears only this tab
await tab('selection');await page.locator('#sel-capacity option').nth(1).waitFor({state:'attached'});
await page.evaluate(()=>{const first=id=>{const s=document.getElementById(id);s.value=s.options[1].value;s.dispatchEvent(new Event('change'));};first('sel-capacity');});
await page.locator('#searchBtn').click();
await page.waitForFunction(()=>!document.getElementById('matchesCard').classList.contains('hidden')||!document.getElementById('reportWrap').classList.contains('hidden'));
await page.evaluate(()=>{const chip=document.querySelector('#matchesList .chip');if(chip)chip.click();});
await page.waitForFunction(()=>!document.getElementById('reportWrap').classList.contains('hidden'));
assert.notEqual(await page.locator('#sel-capacity').inputValue(),'');
assert.ok((await page.locator('#report').innerHTML()).length>100,'a report is shown before Reset');
await page.evaluate(()=>{document.getElementById('en-capacity').value='1234';});
await v254shot('01-selection-before-reset',{phone:false});
await page.locator('#resetSelBtn').click();
for(const id of ['sel-capacity','sel-speed','sel-usageType','sel-roping','sel-brand','sel-model'])assert.equal(await page.locator('#'+id).inputValue(),'',id+' cleared');
assert.equal(await page.locator('#reportWrap').isHidden(),true);assert.equal(await page.locator('#matchesCard').isHidden(),true);
assert.equal((await page.locator('#report').innerHTML()).trim(),'');assert.equal(await page.locator('#matchesList .chip').count(),0);
assert.match(await page.locator('#selResetNote').innerText(),/Cleared/);
assert.equal(await page.evaluate(()=>document.getElementById('en-capacity').value),'1234','Calculations are not touched');
assert.equal(await page.evaluate(()=>ENGINE_SELECTED),null);
await v254shot('02-selection-after-reset');
// search again after Reset works for a new entry
await page.evaluate(()=>{const s=document.getElementById('sel-capacity');s.value=s.options[1].value;s.dispatchEvent(new Event('change'));});
await page.locator('#searchBtn').click();await page.waitForFunction(()=>!document.getElementById('matchesCard').classList.contains('hidden')||!document.getElementById('reportWrap').classList.contains('hidden'));
assert.equal(await page.locator('#selResetNote').innerText(),'');
await page.evaluate(()=>{document.getElementById('resetSelBtn').click();});

// 2) Supplier Claim on a Damage Demand (Super Admin has every permission)
const demandId=(await sequential(()=>h.db.query('select request_id from wlf_private.damage_demands order by demand_no limit 1'))).rows[0]?.request_id;
assert.ok(demandId,'a damage demand exists from the earlier steps');
const dispatchBefore=(await sequential(()=>h.db.query('select received_at is null as pending from wlf_private.damage_demands where request_id=$1',[demandId]))).rows[0].pending;
await tab('damage-demand');await page.locator('[data-damage-view]').first().waitFor();
await page.locator(`[data-damage-view="${demandId}"]`).click();
await page.locator('.supplier-box').waitFor();
assert.match(await page.locator('.supplier-box').innerText(),/Supplier Claimed\s*No[\s\S]*Supplier Confirmed\s*No/);
assert.equal(await page.locator('#supConfirm').count(),0,'Supplier Confirmed cannot be set before Supplier Claim');
await page.locator('#supClaimOpen').click();
await page.locator('#supClaimForm [name=supplier]').fill('Arkel Elektronik');await page.locator('#supClaimForm [name=note]').fill('Warranty claim e-mailed');
await v254shot('03-supplier-claim-form',{phone:true});
await page.locator('#supClaimForm [type=submit]').click();
await page.locator('#damageDetailStatus').filter({hasText:'Claim Sent to Supplier saved'}).waitFor();
assert.match(await page.locator('.supplier-box').innerText(),/Supplier Claimed\s*Yes[\s\S]*Arkel Elektronik/);
await page.locator('#supConfirm').click();await page.locator('#supConfirmForm [name=reference]').fill('ST-2026-0457');await v254shot('03b-supplier-confirm-form',{phone:true});
await page.locator('#supConfirmForm [type=submit]').click();
await page.locator('#damageDetailStatus').filter({hasText:'Supplier Accepted Claim saved'}).waitFor();
assert.match(await page.locator('.supplier-box').innerText(),/Claim reference\s*ST-2026-0457/);
assert.match(await page.locator('.supplier-box').innerText(),/Supplier Confirmed\s*Yes/);
await v254shot('04-demand-supplier-yes-yes');
assert.equal((await sequential(()=>h.db.query('select received_at is null as pending from wlf_private.damage_demands where request_id=$1',[demandId]))).rows[0].pending,dispatchBefore,'demand Pending/Received untouched');
await page.locator('[data-damage-close]').click();
// 3) the Supplier Claim menu: Pending, then Received
await page.evaluate(()=>WlfAdmin.refreshBadges(true));await page.locator('#supplierNavBadge:not([hidden])').waitFor();assert.equal(await page.locator('#supplierNavBadge').innerText(),'1');
await tab('supplier-claim');await page.locator('.supplier-table tr').filter({hasText:'Arkel Elektronik'}).waitFor();
assert.equal(await page.locator('#pageTitle').innerText(),'Supplier Claim');
await v254shot('05-supplier-claim-pending');
await page.setViewportSize({width:390,height:844});await page.evaluate(()=>{if(typeof closeSidebar==='function')closeSidebar();});await page.waitForTimeout(150);{const bb=await page.locator('[data-sc-receive]').boundingBox();assert.ok(bb&&bb.x>=0&&bb.x+bb.width<=391,'Received button fits on a phone: '+JSON.stringify(bb));}await page.setViewportSize({width:1280,height:900});
await page.locator('[data-sc-receive]').click();await page.locator('[data-sc-receive]').click();
await page.locator('#scStatus').filter({hasText:'Marked as Received'}).waitFor();
await page.locator('#supplierNavBadge[hidden]').waitFor({state:'attached'});
await page.locator('[data-sc-filter=Received]').click();await page.locator('.supplier-table tr').filter({hasText:'Arkel Elektronik'}).filter({hasText:'Received'}).waitFor();
await v254shot('06-supplier-claim-received');
assert.equal((await sequential(()=>h.db.query('select received_at is null as pending from wlf_private.damage_demands where request_id=$1',[demandId]))).rows[0].pending,dispatchBefore,'dispatch status still untouched after goods Received');
// 4) permissions are given by the Super Admin, nobody has them by default
await sequential(()=>h.db.query("update public.wlf_profiles set permissions=array_append(permissions,'supplier:view') where id=$1",[IDS.rni]));
await logout();await login('admin');await page.waitForTimeout(300);
assert.equal(await page.locator('#nav [data-tab=supplier-claim]').isHidden(),true,'no permission: no Supplier Claim menu');
await logout();await login('rni');await page.locator('#nav [data-tab=supplier-claim]').waitFor({state:'visible'});
await tab('supplier-claim');await page.locator('.supplier-card').waitFor();assert.equal(await page.locator('[data-sc-receive]').count(),0,'view-only user has no Received button');
await logout();await login('sa');
await logout();await login('user');
}
/* ---- v2.5.5 ---- */
fs.mkdirSync('test-results/v255',{recursive:true});
{
const v255shot=async(name,{phone=true}={})=>{for(const [w,hh,label] of [[1440,900,'desktop'],[390,844,'mobile']]){if(label==='mobile'&&!phone)continue;await page.setViewportSize({width:w,height:hh});if(w<500)await page.evaluate(()=>{if(typeof closeSidebar==='function')closeSidebar();});await page.waitForTimeout(150);for(const theme of ['light','dark']){await page.evaluate(t=>{if(typeof setAppearance==='function')setAppearance(t);},theme);await page.waitForTimeout(120);await page.screenshot({path:`test-results/v255/${name}-${label}-${theme}.png`,fullPage:false});}}await page.evaluate(()=>{if(typeof setAppearance==='function')setAppearance('light');});await page.setViewportSize({width:1440,height:900});};
// 1) light theme: motor option chips are readable when Search runs with no lift parameters
await tab('selection');await page.locator('#sel-capacity option').nth(1).waitFor({state:'attached'});
await page.emulateMedia({colorScheme:'dark'});await page.evaluate(()=>setAppearance('light'));
await page.locator('#searchBtn').click();
await page.waitForFunction(()=>!document.getElementById('matchesCard').classList.contains('hidden'));
await page.locator('#matchesList .chip').first().waitFor();
const chipInfo=await page.evaluate(()=>{const lum=c=>{const m=c.match(/[\d.]+/g).map(Number);const f=v=>{v/=255;return v<=.03928?v/12.92:Math.pow((v+.055)/1.055,2.4)};return .2126*f(m[0])+.7152*f(m[1])+.0722*f(m[2]);};const out=[];document.querySelectorAll('#matchesList .chip').forEach((c,i)=>{if(i>2)return;const bg=getComputedStyle(c).backgroundImage!=='none'?getComputedStyle(c).backgroundImage:getComputedStyle(c).backgroundColor;const fg=getComputedStyle(c.querySelector('b')).color;out.push({bg,fg});});return out;});
for(const c of chipInfo)assert.notEqual(c.fg,'rgb(255, 255, 255)','light theme chip text must be dark even when the OS is dark');assert.equal(chipInfo.length>0,true);
await v255shot('01-motor-options');await page.emulateMedia({colorScheme:'light'});
// 2) Supplier Claim page: the demand opens from Pending and from Received; reference; Super Admin Undo Received
await logout();await login('sa');
await tab('supplier-claim');await page.locator('[data-sc-filter=Received]').click();
await page.locator('.supplier-table [data-sc-open]').first().waitFor();
await page.locator('.supplier-table [data-sc-open]').first().click();
await page.locator('.supplier-box').waitFor();
let box=await page.locator('.supplier-box').innerText();
assert.match(box,/Claim reference\s*ST-2026-0457/);assert.match(box,/Received/);
assert.equal(await page.locator('#damageReceive').count(),0,'no Receive demand button when opened from the Supplier page');
assert.equal(await page.locator('#supRefOpen').count(),0,'reference is locked after goods Received');
await v255shot('02-supplier-demand-received');
const undo=page.locator('[data-sup-undo-received]');await undo.click();await undo.click();
await page.locator('#damageDetailStatus').filter({hasText:'Received was undone'}).waitFor();
assert.match(await page.locator('.supplier-box').innerText(),/Pending[\s\S]*Received was undone by/);
const undoRow=(await sequential(()=>h.db.query('select sc_received_at is null as pending,sc_undo_name from wlf_private.damage_demands where claim_supplier is not null order by demand_no limit 1',[]))).rows[0];
assert.equal(undoRow.pending,true);assert.ok(undoRow.sc_undo_name);
await page.locator('#supRefOpen').click();await page.locator('#supRefForm [name=reference]').fill('ST-LATE-9');await page.locator('#supRefForm [type=submit]').click();
await page.locator('#damageDetailStatus').filter({hasText:'Reference saved'}).waitFor();
assert.match(await page.locator('.supplier-box').innerText(),/ST-LATE-9/);
await v255shot('03-supplier-demand-after-undo');
await page.locator('[data-damage-close]').click();
await page.locator('[data-sc-filter=Pending]').click();
await page.locator('.supplier-table [data-sc-open]').first().waitFor();
await page.locator('.supplier-table [data-sc-open]').first().click();await page.locator('.supplier-box').waitFor();
assert.match(await page.locator('.supplier-box').innerText(),/Supplier Confirmed\s*Yes/);
assert.equal(await page.locator('#damageReceive').count(),0);
await page.locator('[data-damage-close]').click();
assert.match(await page.locator('.supplier-table').innerText(),/Ref: ST-LATE-9/);
await v255shot('04-supplier-pending-with-ref');
// 3) MOTCUBE troubleshooting
await tab('troubleshooting');
await page.locator('[data-section="MOTCUBE"]').waitFor();
await v255shot('05-troubleshooting-home');
await page.locator('[data-section="MOTCUBE"]').click();
assert.match(await page.locator('#tbWorkspace').innerText(),/Error Solution[\s\S]*Permanent Error Clearing|Permanent Error Clearing[\s\S]*Error Solution/);
await v255shot('06-motcube-menu');
await page.locator('#tbErrors').click();
await page.locator('#tbSearch').fill('H22');
await page.locator('#tbDetail h3').filter({hasText:'H22'}).waitFor();
assert.match(await page.locator('#tbDetail').innerText(),/Permanent error/);assert.match(await page.locator('#tbDetail').innerText(),/MAINTENANCE TIME/);
await v255shot('07-motcube-h22');
await page.locator('[data-tb-lang=bn]').click();await page.waitForTimeout(150);
assert.match(await page.locator('#tbDetail').innerText(),/স্থায়ী ত্রুটি/);
assert.ok(await page.locator('#tbDetail [lang=bn]').count()>0,'Bangla text shown');
await v255shot('08-motcube-h22-bangla');
await page.locator('[data-tb-lang=en]').click();
await page.locator('#tbSearch').fill('door lock');
assert.ok(await page.locator('#tbResults .tb-entry').count()>0,'text search works');
await page.locator('#tbSearch').fill('h1');
await page.locator('#tbResults .tb-entry b').filter({hasText:/^H1$/}).first().click();
await page.locator('#tbEdit').click();
assert.ok(await page.locator('#tbPermanent').count()>0&&await page.locator('#tbParameters').count()>0,'MOTCUBE editor has permanent and parameters');
await v255shot('09-motcube-editor',{phone:false});
await page.locator('#tbEditDescription').fill('Door lock fault (edited in e2e)');await page.locator('#tbSave').click();
await page.waitForFunction(()=>!document.getElementById('tbEditor').open);
await page.waitForFunction(async()=>true);
const saved=(await sequential(()=>h.db.query("select content->>'description' d,revision from public.wlf_troubleshooting where id='motcube-h1'"))).rows[0];
assert.equal(saved.d,'Door lock fault (edited in e2e)');assert.equal(saved.revision,2);
// a section user without the tick does not see MOTCUBE; with the tick sees it but cannot edit
await logout();await login('user');await tab('troubleshooting');
await page.locator('[data-section="MOT"]').waitFor();assert.equal(await page.locator('[data-section="MOTCUBE"]').isHidden(),true,'no tick: no MOTCUBE tile');
await sequential(()=>h.db.query("update public.wlf_profiles set permissions=array_append(permissions,'tb:MOTCUBE:error') where id=$1",[IDS.user]));
await logout();await login('user');await tab('troubleshooting');
await page.locator('[data-section="MOTCUBE"]').waitFor({state:'visible'});await page.locator('[data-section="MOTCUBE"]').click();await page.locator('#tbErrors').click();
await page.locator('#tbSearch').fill('H12');await page.locator('#tbDetail h3').filter({hasText:'H12'}).waitFor();
assert.equal(await page.locator('#tbEdit').count(),0,'a User cannot edit MOTCUBE');
await v255shot('10-motcube-user-view');
await logout();await login('user');
}
/* ---- v2.5.6 ---- */
fs.mkdirSync('test-results/v256',{recursive:true});
{
const v256shot=async(name,{phone=true,at=null}={})=>{for(const [w,hh,label] of [[1440,900,'desktop'],[390,844,'mobile']]){if(label==='mobile'&&!phone)continue;await page.setViewportSize({width:w,height:hh});if(w<500)await page.evaluate(()=>{if(typeof closeSidebar==='function')closeSidebar();});await page.waitForTimeout(200);if(at)await page.locator(at).first().evaluate(n=>n.scrollIntoView({block:'start'}));await page.waitForTimeout(100);for(const theme of ['light','dark']){await page.evaluate(t=>{if(typeof setAppearance==='function')setAppearance(t);},theme);await page.waitForTimeout(120);await page.screenshot({path:`test-results/v256/${name}-${label}-${theme}.png`,fullPage:false});}}await page.evaluate(()=>{if(typeof setAppearance==='function')setAppearance('light');});await page.setViewportSize({width:1440,height:900});};
await logout();await login('sa');
// 1) Components data: search all columns + sticky key columns
await tab('components');await page.locator('#compFilter-0').waitFor({state:'attached'});
await page.evaluate(()=>{document.querySelectorAll('#componentAdminFilters select').forEach(x=>{x.value='';x.dispatchEvent(new Event('change'));});});
await page.waitForFunction(()=>/^(\d+) of \1 components$/.test(document.getElementById('compCount').textContent));
const allRows=await page.locator('#componentsTable tbody tr').count();assert.ok(allRows>10);
const model=await page.evaluate(()=>{const i=compData.headers.indexOf('Motor Model');return String(compData.records[0].values[i]);});
const cap=await page.evaluate(()=>String(compData.records[0].values[0]));
await page.locator('#compSearch').fill(cap+' '+model.toLowerCase());
await page.waitForFunction(n=>document.querySelectorAll('#componentsTable tbody tr').length<n,allRows,{timeout:8000}).catch(async e=>{console.log('DBG',allRows,cap,model,await page.locator('#componentsTable tbody tr').count(),await page.locator('#compSearch').inputValue(),await page.locator('#compCount').innerText());throw e;});
const found=await page.locator('#componentsTable tbody tr').count();assert.ok(found>=1&&found<allRows,'search narrows the table');
assert.match(await page.locator('#compCount').innerText(),new RegExp('^'+found+' of '));
await page.locator('#compSearch').fill('zz-no-such-thing');await page.locator('#componentsTable tbody td.note').waitFor();
await page.locator('#compSearch').fill('');await page.waitForFunction(n=>document.querySelectorAll('#componentsTable tbody tr').length===n,allRows);
const stick=async()=>page.evaluate(()=>{const w=document.querySelector('.comp-wrap');w.scrollLeft=5000;const r=document.querySelector('#componentsTable tbody tr');const wl=w.getBoundingClientRect();const first=r.cells[0].getBoundingClientRect(),act=r.cells[r.cells.length-1].getBoundingClientRect(),mi=compData.headers.indexOf('Motor Model'),m=r.cells[mi].getBoundingClientRect();return {scrolled:w.scrollLeft>0,firstLeft:Math.round(first.left-wl.left),actRight:Math.round(wl.right-act.right),modelVisible:m.right<=wl.right&&m.left>=wl.left-1};});
let st=await stick();assert.ok(st.scrolled);assert.ok(Math.abs(st.firstLeft)<=2,'Capacity stays at the left: '+JSON.stringify(st));assert.ok(st.actRight>=-2&&st.actRight<=20,'Edit/Delete stays at the right: '+JSON.stringify(st));assert.equal(st.modelVisible,true,'Motor Model stays visible on desktop');
await v256shot('01-components-sticky',{phone:false});
await page.setViewportSize({width:390,height:844});await page.evaluate(()=>{if(typeof closeSidebar==='function')closeSidebar();stickComponentColumns();});await page.waitForTimeout(250);
st=await stick();assert.ok(Math.abs(st.firstLeft)<=2,'phone: Capacity stays');
await page.locator('.comp-wrap').evaluate(n=>n.scrollIntoView({block:'start'}));for(const theme of ['light','dark']){await page.evaluate(t=>setAppearance(t),theme);await page.waitForTimeout(120);await page.screenshot({path:`test-results/v256/02-components-sticky-mobile-${theme}.png`});}
await page.evaluate(()=>setAppearance('light'));await page.setViewportSize({width:1440,height:900});await page.evaluate(()=>{document.querySelector('.comp-wrap').scrollLeft=0;stickComponentColumns();});
// edit one component through the screen -> change log
await page.locator('#compSearch').fill(cap+' '+model);await page.locator('#componentsTable tbody tr').first().locator('button',{hasText:'Edit'}).click();
const pIdx=await page.evaluate(()=>compData.headers.indexOf('Motor Power (KW)'));
const oldP=await page.locator('#ef-'+pIdx).inputValue();await page.locator('#ef-'+pIdx).fill('99.5');await page.locator('#saveCompBtn').click();
await page.locator('#globalMsg').filter({hasText:'Component saved'}).waitFor();
// 2) Usage Dashboard: 7 days, no Technical Support, change log, From-To delete
await tab('dashboard');await page.locator('#usageLogTable').waitFor();
assert.equal(await page.locator('#techDashboard,#rniPerformanceTable').count(),0,'Technical Support is not in the Usage Dashboard');
assert.match(await page.locator('#statsArea').innerText(),/Actions · last 7 days[\s\S]*Activity log · last 7 days|Activity log · last 7 days[\s\S]*Actions · last 7 days/);
await page.locator('#componentLogTable').waitFor();
const clogText=await page.locator('#componentLogTable').innerText();
assert.match(clogText,/Edited/);assert.match(clogText,new RegExp('Motor Power \\(KW\\): '+oldP.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\s*→\\s*99\\.5'));
await v256shot('03-component-change-log',{at:'#componentLogCard'});
const clogDl=page.waitForEvent('download');await page.locator('#componentLogExcel').click();await (await clogDl).saveAs('test-results/v256/component-change-log.xlsx');
assert.match(await (await Zip.loadAsync(fs.readFileSync('test-results/v256/component-change-log.xlsx'))).file('xl/worksheets/sheet1.xml').async('string'),/99.5/);
// From-To delete
await sequential(()=>h.db.query("insert into public.wlf_usage(actor,action,details,at) values($1,'Login','range-test',now()-interval '20 days'),($1,'Login','range-test',now()-interval '21 days')",[IDS.user]));
await tab('dashboard');await page.locator('#usageRangeForm').waitFor();await page.locator('#componentLogTable').waitFor();await page.waitForTimeout(300);
const d20=await page.evaluate(()=>{const f=n=>new Date(Date.now()+6*3600e3-n*86400e3).toISOString().slice(0,10);return [f(22),f(19)];});
await page.locator('#usageRangeForm [name=from]').fill(d20[0]);await page.locator('#usageRangeForm [name=to]').fill(d20[1]);
assert.equal(await page.locator('#usageRangeDelete').isDisabled(),true);
await page.locator('#usageRangeForm [type=submit]').click();await page.locator('#usageRangeStatus').filter({hasText:/^2 activity log rows/}).waitFor();
await v256shot('04-usage-range-delete',{at:'#usageRangeForm'});
await page.locator('#usageRangeDelete').click();await page.locator('#wlfAdminTyped').fill('DELETE');await page.locator('#wlfAdminYes').click();
await page.locator('#globalMsg').filter({hasText:'2 activity log rows deleted'}).waitFor();
assert.equal((await sequential(()=>h.db.query("select count(*)::int n from public.wlf_usage where details='range-test'"))).rows[0].n,0);
// 3) Management Dashboard lists every team
await tab('workspace-dashboard');await page.locator('#apBody .mgmt-card').first().waitFor();await page.selectOption('#apDash','support');await page.locator('#apBody .mgmt-card').nth(2).waitFor();
const mg=await page.locator('#tab-workspace-dashboard').innerText();
for(const team of ['Commissioning','After Sales','Production','Factory Maintenance','QC','Installation'])assert.match(mg,new RegExp(team),team+' listed');
await v256shot('05-dashboard-all-teams',{at:'#apBody .mgmt-card >> nth=2'});
// 4) Usage Dashboard tick: a User with the tick sees it (no delete box, no change log without that tick)
await logout();await login('user');assert.equal(await page.locator('#nav [data-tab=dashboard]').isVisible(),false,'no tick: no Usage Dashboard');
await sequential(()=>h.db.query("update public.wlf_profiles set permissions=array_append(permissions,'usage:dashboard') where id=$1",[IDS.user]));
await logout();await login('user');await page.locator('#nav [data-tab=dashboard]').waitFor({state:'visible'});
await tab('dashboard');await page.locator('#usageLogTable').waitFor();
assert.equal(await page.locator('#usageRangeForm').count(),0,'range delete is Super Admin only');assert.equal(await page.locator('.usage-old').count(),0);
assert.equal(await page.locator('#componentLogTable').count(),0,'change log needs its own tick');
await sequential(()=>h.db.query("update public.wlf_profiles set permissions=array_append(permissions,'components:log') where id=$1",[IDS.user]));
await logout();await login('user');await tab('dashboard');await page.locator('#componentLogTable').waitFor();
await v256shot('06-usage-dashboard-user',{at:'#componentLogCard'});
assert.equal(await page.locator('#nav [data-tab=components]').isVisible(),false,'Components data stays Super Admin only');
await tab('account');assert.equal(await page.locator('#myActivityCard').count(),0);await v256shot('07-my-profile',{phone:true});
await sequential(()=>h.db.query("update public.wlf_profiles set permissions=array_remove(array_remove(permissions,'usage:dashboard'),'components:log') where id=$1",[IDS.user]));
await logout();await login('user');
}
/* ---- v2.5.7 ---- */
fs.mkdirSync('test-results/v257',{recursive:true});
{
const v257shot=async(name,{phone=true,at=null}={})=>{for(const [w,hh,label] of [[1440,900,'desktop'],[390,844,'mobile']]){if(label==='mobile'&&!phone)continue;await page.setViewportSize({width:w,height:hh});if(w<500)await page.evaluate(()=>{if(typeof closeSidebar==='function')closeSidebar();});await page.waitForTimeout(200);if(w<500&&await page.locator('#supportRefresh').count()){await page.locator('#supportRefresh').first().click();await page.waitForTimeout(700);}await page.evaluate(()=>window.scrollTo(0,0));if(at)await page.locator(at).first().evaluate(n=>n.scrollIntoView({block:'start'}));await page.waitForTimeout(100);for(const theme of ['light','dark']){await page.evaluate(t=>{if(typeof setAppearance==='function')setAppearance(t);},theme);await page.waitForTimeout(120);await page.screenshot({path:`test-results/v257/${name}-${label}-${theme}.png`,fullPage:false});}}await page.evaluate(()=>{if(typeof setAppearance==='function')setAppearance('light');});await page.setViewportSize({width:1440,height:900});};
const mark=()=>page.evaluate(()=>({n:Number(document.getElementById('profileBadge').textContent||0),shown:!document.getElementById('profileBadge').hidden,dot:!!document.getElementById('menuDot')}));
await logout();await login('user');
const before=await mark();
await category();await page.locator('.support-split').waitFor();
// 1) split screen: list + filters on the left, form / request on the right, using the whole content width
const m=await page.evaluate(()=>{const l=document.querySelector('.support-left').getBoundingClientRect(),r=document.querySelector('.support-right').getBoundingClientRect(),c=document.querySelector('.content'),cs=getComputedStyle(c),inner=c.clientWidth-parseFloat(cs.paddingLeft)-parseFloat(cs.paddingRight);return {l:l.width,r:r.width,lx:l.left,rx:r.left,inner,split:document.querySelector('.support-split').getBoundingClientRect().width};});
assert.ok(m.rx>=m.lx+m.l-1,'right pane sits beside the list: '+JSON.stringify(m));assert.ok(Math.abs(m.l-m.r)<8,'two equal halves: '+JSON.stringify(m));assert.ok(m.split>=m.inner-2,'uses the whole width: '+JSON.stringify(m));
assert.equal(await page.locator('.support-left #supportFilterQuery').count(),1);assert.equal(await page.locator('.support-left #supportRequests').count(),1);assert.equal(await page.locator('.support-right #supportDetail').count(),1);assert.equal(await page.locator('.support-right #supportFormArea').count(),1);
// 2) compact form opens in the right pane and the detail steps aside
await page.locator('#newSupportRequest').click();await page.locator('#supportRequestForm').waitFor();
assert.equal(await page.locator('.support-right #supportRequestForm').count(),1);assert.equal(await page.locator('#supportDetail').isVisible(),false,'form replaces the detail while open');
const sz=await page.evaluate(()=>{const f=document.querySelector('#supportRequestForm');return {lift:f.querySelector('[name=lift]').getBoundingClientRect().height,ta:f.querySelector('textarea[name=project_address]').getBoundingClientRect().height,cols:getComputedStyle(f.querySelector('.review-fields')).gridTemplateColumns.split(' ').length};});
assert.ok(sz.lift<=40,'Lift ID is compact: '+JSON.stringify(sz));assert.ok(sz.ta<=80,'Project Address starts small: '+JSON.stringify(sz));assert.equal(sz.cols,2);
await v257shot('01-support-form-open');
await page.setViewportSize({width:390,height:844});await page.evaluate(()=>{if(typeof closeSidebar==='function')closeSidebar();});await page.waitForTimeout(200);
const ph=await page.evaluate(()=>({form:document.querySelector('#supportRequestForm').getBoundingClientRect().top,list:document.querySelector('#supportRequests').getBoundingClientRect().top,cols:getComputedStyle(document.querySelector('#supportRequestForm .review-fields')).gridTemplateColumns.split(' ').length,wide:document.documentElement.scrollWidth-innerWidth}));
assert.ok(ph.wide<=1,'no sideways scroll on a phone: '+JSON.stringify(ph));assert.equal(ph.cols,1);
await page.locator('#supportRefresh').first().click();await page.waitForTimeout(700);assert.equal(await page.locator('#supportFilterPanel').evaluate(n=>n.open),false,'Filters start closed on a phone');assert.equal(await page.locator('#supportRequestForm').count(),1,'an open form survives the refresh');
await page.setViewportSize({width:1440,height:900});
// 3) submit: the form closes, the red mark appears on My Profile and the top menu
await fillDynamic('#supportRequestForm',{lift:'775577',project_address:'Plot 5, Dhaka'});await page.locator('#submitSupportRequest').click();
await page.locator('#supportDetail h3').filter({hasText:/TCS\d+-775577-\d{8}/}).waitFor();
assert.equal(await page.locator('#supportFormArea > *').count(),0);assert.equal(await page.locator('#supportDetail').isVisible(),true);
const id=await page.locator('#supportDetail').getAttribute('data-record-id');
await page.waitForFunction(()=>!document.getElementById('profileBadge').hidden);
let now=await mark();assert.equal(now.n,before.n+1,'red count goes up by one: '+JSON.stringify([before,now]));assert.equal(now.dot,false,'v2.6.0: the top menu has no red dot');
assert.match(await page.locator('#profileBadge').getAttribute('title'),/not solved yet/);
await v257shot('02-support-detail-red-mark');
// 4) R&I receives and solves it: the requester gets a push and the red mark goes
await sequential(()=>h.db.query("insert into wlf_private.push_subscriptions(endpoint,profile,p256dh,auth) values('https://push.example/e2e',$1,repeat('a',40),repeat('b',16)) on conflict do nothing",[IDS.user]));
await sequential(()=>h.db.query('delete from wlf_private.push_outbox'));
const rev=(await sequential(()=>h.db.query('select revision from public.wlf_requests where id=$1',[id]))).rows[0].revision;
let tk=(await sequential(()=>h.rpc('rni','transitionSupportRequest',[{id,revision:rev,action:'receive',mutationId:crypto.randomUUID()}]))).ticket;
await sequential(()=>h.rpc('rni','transitionSupportRequest',[{id,revision:tk.revision,action:'solve',comment:'Fixed on site',mutationId:crypto.randomUUID()}]));
const pushed=(await sequential(()=>h.db.query('select title,body from wlf_private.push_outbox where profile=$1',[IDS.user]))).rows;
assert.deepEqual(pushed.map(r=>r.title),['Your support request was solved']);assert.match(pushed[0].body,/775577/);
await logout();await login('user');
now=await mark();assert.equal(now.n,before.n,'red count is back: '+JSON.stringify([before,now]));assert.equal(now.dot,false);
await sequential(()=>h.db.query('delete from wlf_private.push_subscriptions where endpoint=$1',['https://push.example/e2e']));
await v257shot('03-after-solved',{phone:false});
}
fs.mkdirSync('test-results/v259',{recursive:true});
/* ---- v2.5.8 ---- */
fs.mkdirSync('test-results/v258',{recursive:true});
{
const v258shot=async(name,{phone=true}={})=>{for(const [w,hh,label] of [[1440,900,'desktop'],[390,844,'mobile']]){if(label==='mobile'&&!phone)continue;await page.setViewportSize({width:w,height:hh});if(w<500)await page.evaluate(()=>{if(typeof closeSidebar==='function')closeSidebar();});await page.waitForTimeout(250);for(const theme of ['light','dark']){await page.evaluate(t=>{if(typeof setAppearance==='function')setAppearance(t);},theme);await page.waitForTimeout(120);await page.screenshot({path:`test-results/v258/${name}-${label}-${theme}.png`,fullPage:false});}}await page.evaluate(()=>{if(typeof setAppearance==='function')setAppearance('light');});await page.setViewportSize({width:1440,height:900});};
await logout();await login('user');await category();
for(let i=0;i<4&&!(await page.locator('#supportRequestForm').isVisible());i++){await page.locator('#newSupportRequest').click();await page.locator('#supportRequestForm').waitFor({timeout:4000}).catch(()=>{});}
await page.locator('#supportRequestForm').waitFor();
// 1) MOTCUBE drive error sits right below NICE3000+ drive error
const opts=await page.locator('#supportRequestForm [name=problem_category] option').allTextContents();
const at=opts.indexOf('NICE3000+ drive error');assert.ok(at>0);assert.equal(opts[at+1],'MOTCUBE drive error');assert.equal(opts[at+2],'NICE900 door drive error');
await page.locator('#supportRequestForm [name=pm]').selectOption({index:1});await page.locator('#supportRequestForm [name=project]').fill('Cube Tower');await page.locator('#supportRequestForm [name=lift]').fill('582');
await page.locator('#supportRequestForm [name=controller]').selectOption('MOTCUBE');await pickModel('MOTCUBE 7.5 kW');await page.locator('#supportRequestForm [name=problem]').fill('H8 on every start');
await page.locator('#supportRequestForm [name=problem_category]').selectOption('MOTCUBE drive error');await page.locator('.wlf-dependent[data-dep-name=problem_sub]').waitFor();
// 2) the H code is mandatory: submitting without it opens the list (61 codes, no H20)
await page.locator('#supportRequestForm [type=submit]').click();await page.locator('#wlfPicker[open]').waitFor();
assert.equal(await page.locator('#wlfPicker [data-pick]').count(),61);assert.equal(await page.locator('#wlfPicker [data-pick="H20"]').count(),0);
assert.equal(await page.locator('#wlfPicker [data-pick]').first().getAttribute('data-pick'),'H1');assert.equal(await page.locator('#wlfPicker [data-pick]').last().getAttribute('data-pick'),'H62');
await page.locator('#wlfPicker .wlf-picker-search').fill('h6');assert.ok(await page.locator('#wlfPicker [data-pick]:visible').count()===4,'search h6 finds H6, H60, H61, H62');
await v258shot('01-motcube-popup');
await page.locator('#wlfPicker [data-pick="H62"]').click();assert.equal(await page.locator('.wlf-dependent[data-dep-name=problem_sub] .wlf-pick').innerText(),'H62');
await page.locator('#supportRequestForm [type=submit]').click();await page.locator('#supportDetail h3').filter({hasText:/-582-/}).waitFor();
const cubeId=await page.locator('#supportDetail').getAttribute('data-record-id');
assert.equal((await sequential(()=>h.db.query("select values->>'problem_sub' s, values->>'problem_category' c from public.wlf_requests where id=$1",[cubeId]))).rows[0].s,'H62');
// 3) history labels are written in proper case
const labels=async()=>page.locator('.support-timeline li > b').allInnerTexts();
assert.deepEqual(await labels(),['Submitted']);
await sequential(()=>h.db.query("update public.wlf_profiles set permissions=array_append(permissions,'support:commissioning:request') where id=$1 and not 'support:commissioning:request'=any(permissions)",[IDS.rni2]));
let rev=(await sequential(()=>h.db.query('select revision from public.wlf_requests where id=$1',[cubeId]))).rows[0].revision;
let tk=(await sequential(()=>h.rpc('rni','transitionSupportRequest',[{id:cubeId,revision:rev,action:'receive',mutationId:crypto.randomUUID()}]))).ticket;
tk=(await sequential(()=>h.rpc('rni','transitionSupportRequest',[{id:cubeId,revision:tk.revision,action:'forward',to:'rni2@example.test',comment:'Please check',mutationId:crypto.randomUUID()}]))).ticket;
tk=(await sequential(()=>h.rpc('rni2','transitionSupportRequest',[{id:cubeId,revision:tk.revision,action:'receive',mutationId:crypto.randomUUID()}]))).ticket;
tk=(await sequential(()=>h.rpc('rni2','transitionSupportRequest',[{id:cubeId,revision:tk.revision,action:'notSolved',comment:'Needs a visit',mutationId:crypto.randomUUID()}]))).ticket;
tk=(await sequential(()=>h.rpc('rni2','transitionSupportRequest',[{id:cubeId,revision:tk.revision,action:'receive',mutationId:crypto.randomUUID()}]))).ticket;
await sequential(()=>h.rpc('rni2','transitionSupportRequest',[{id:cubeId,revision:tk.revision,action:'solve',comment:'Fixed',mutationId:crypto.randomUUID()}]));
await logout();await login('user');await category();await page.locator(`[data-ticket="${cubeId}"]`).click();await page.locator('.support-timeline li').nth(6).waitFor();
const shown=await labels();assert.deepEqual(shown,['Submitted','Received','Forwarded','Received','Not Solved','Received','Solved']);
assert.ok(shown.every(x=>/^[A-Z]/.test(x)),'every history label starts with a capital letter');
const arrows=await page.locator('.support-timeline li small').allInnerTexts();assert.equal(arrows.filter(x=>x.includes('→')).length,1,'only the forward shows an arrow (to whom); Receive no longer repeats the same name');assert.match(arrows[2],/→ rni2 \(RN-3\)/);
await v258shot('02-history-labels');
// the exported report reads the same way
await logout();await login('sa');await category();await page.locator('#supportFilterRequester').selectOption('user@example.test');await page.locator(`[data-ticket="${cubeId}"]`).waitFor();
assert.equal(await page.locator('#downloadSupportCSV').count(),0,'v2.6.8: the CSV button is gone');
{const [dl]=await Promise.all([page.waitForEvent('download',{timeout:60000}),page.locator('#downloadSupportExcel').click()]);await dl.saveAs('test-results/support-report-v268.xlsx');
 const zz=await require('jszip').loadAsync(fs.readFileSync('test-results/support-report-v268.xlsx'));const sx=await zz.file('xl/worksheets/sheet1.xml').async('string');
 for(const gone of ['Request ID','Submitted by','Submitted at','Last updated','Assigned to','Solved by','Activity history'])assert.ok(!sx.includes(gone),'column removed from the Technical Support Excel: '+gone);
 for(const kept of ['Workflow status','Solution'])assert.ok(sx.includes(kept),'column kept: '+kept);
 assert.ok(Object.keys(zz.files).some(n=>/xl\/tables\/table\d+\.xml/.test(n)),'the sheet is a real Excel table');}
await page.locator('#supportFilterRequester').selectOption('');await logout();await login('user');
}
/* ---- v2.5.9 ---- */
{
const v259shot=async(name,{phone=true,full=false}={})=>{for(const [w,hh,label] of [[1440,900,'desktop'],[390,844,'mobile']]){if(label==='mobile'&&!phone)continue;await page.setViewportSize({width:w,height:hh});if(w<500)await page.evaluate(()=>{if(typeof closeSidebar==='function')closeSidebar();});await page.waitForTimeout(250);for(const theme of ['light','dark']){await page.evaluate(t=>{if(typeof setAppearance==='function')setAppearance(t);},theme);await page.waitForTimeout(120);await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:`test-results/v259/${name}-${label}-${theme}.png`,fullPage:full});}}await page.evaluate(()=>{if(typeof setAppearance==='function')setAppearance('light');});await page.setViewportSize({width:1440,height:900});};
// 1) a normal R&I user sees neither the catalogue nor QMS until the Super Admin ticks it
await logout();await login('rni');
assert.equal(await page.locator('#nav [data-tab=catalogue]').isVisible(),false);assert.equal(await page.locator('#nav [data-tab=qms]').isVisible(),false);
// 2) Super Admin: Hardware Catalogue
await logout();await login('sa');
await tab('catalogue');await page.locator('.hw-layout').waitFor();
await page.locator('[data-hw-system="AVR"]').click();await page.locator('[data-hw-model="AVR 80 KVA"]').click();
assert.equal(await page.locator('#hwTable tbody tr').count(),10,'AVR 80 KVA has ten blank rows (not in the AVR sheet)');
await page.locator('[data-hw-edit]').first().click();
await page.locator('#hwRowForm [name=itemCode]').fill('900080');await page.locator('#hwRowForm [name=itemName]').fill('AVR Servo Stabilizer 80 KVA');
await page.locator('#hwRowForm [name=spec]').fill('3 Phase');await page.locator('#hwRowForm [name=brand]').fill('Demo brand');await page.locator('#hwRowForm [name=supplier]').fill('Demo supplier');await page.locator('#hwRowForm [name=value]').fill('1250.5');
await page.locator('#hwRowForm [type=submit]').click();
await page.locator('#hwTable').getByText('AVR Servo Stabilizer 80 KVA').waitFor();
assert.match(await page.locator('#hwTable').innerText(),/1,250\.50/);
await v259shot('05-catalogue-avr');
await page.locator('#hwNewModel').click();await page.locator('#hwModelForm [name=system]').fill('AVR');await page.locator('#hwModelForm [name=model]').fill('AVR 150 KVA');await page.locator('#hwModelForm [type=submit]').click();
await page.locator('[data-hw-model="AVR 150 KVA"].on').waitFor();assert.equal(await page.locator('#hwTable tbody tr').count(),6);
await page.locator('[data-hw-system="MOT"]').click();await page.locator('[data-hw-model="MOT 7.5 kW"]').click();assert.equal(await page.locator('#hwTable tbody tr').count(),31);
await page.locator('#hwSearch').fill('UPS');assert.ok(await page.locator('#hwTable tbody tr').count()>=2);await page.locator('#hwSearch').fill('');
const catDl=page.waitForEvent('download');await page.locator('#hwExport').click();await(await catDl).saveAs('test-results/v259/catalogue.xlsx');
assert.match(await(await Zip.loadAsync(fs.readFileSync('test-results/v259/catalogue.xlsx'))).file('xl/worksheets/sheet1.xml').async('string'),/AVR Servo Stabilizer 80 KVA/);
await page.locator('#hwMap').click();assert.ok((await page.locator('#hwMapRows tr').count())>=10);await page.locator('#hwCancel').click();
await v259shot('06-catalogue-mot');
// 3) the new AVR item shows up in the QMS form
await tab('qms');await page.locator('#qmsLiftForm').waitFor();
await page.locator('#qmsLiftForm [name=avrModel]').selectOption('AVR 80 KVA');
assert.match(await page.locator('#hwAvr').innerText(),/AVR Servo Stabilizer 80 KVA/);
// 4) Raise Damage Demand takes the part from the catalogue
await logout();await login('user');await category();
for(let i=0;i<4&&!(await page.locator('#supportRequestForm').isVisible());i++){await page.locator('#newSupportRequest').click();await page.locator('#supportRequestForm').waitFor({timeout:4000}).catch(()=>{});}
await page.locator('#supportRequestForm').waitFor();
await page.locator('#supportRequestForm [name=pm]').selectOption({index:1});await page.locator('#supportRequestForm [name=project]').fill('Catalogue Tower');await page.locator('#supportRequestForm [name=lift]').fill('7001');
await page.locator('#supportRequestForm [name=controller]').selectOption('MOTCUBE');await pickModel('MOTCUBE 7.5 kW');await page.locator('#supportRequestForm [name=problem]').fill('Drive trips');
await page.locator('#supportRequestForm [name=problem_category]').selectOption('MOTCUBE drive error');await page.locator('.wlf-dependent[data-dep-name=problem_sub]').waitFor();
await page.locator('#supportRequestForm [type=submit]').click();await page.locator('#wlfPicker[open]').waitFor();await page.locator('#wlfPicker [data-pick="H8"]').click();
await page.locator('#supportRequestForm [type=submit]').click();await page.locator('#supportDetail h3').filter({hasText:/-7001-/}).waitFor();
const demandReq=await page.locator('#supportDetail').getAttribute('data-record-id');
const rr=(await sequential(()=>h.db.query('select revision from public.wlf_requests where id=$1',[demandReq]))).rows[0].revision;
await sequential(()=>h.rpc('rni','transitionSupportRequest',[{id:demandReq,revision:rr,action:'receive',mutationId:crypto.randomUUID()}]));
await logout();await login('rni');await category();
await page.locator(`[data-ticket="${demandReq}"]`).click();
await page.locator('#supportComment').fill('Replace the drive card.');await page.locator('#supportDuration').fill('30');
await page.locator('#supportHardware input[value=true]').check();
const dd=page.locator('#wlfDamageDialog');await dd.waitFor();
await dd.locator('#hwDemModel').waitFor();
await page.waitForFunction(()=>{const s=document.getElementById('hwDemModel');return s&&s.selectedIndex>0;});
assert.equal(await dd.locator('#hwDemModel').evaluate(n=>n.options[n.selectedIndex].text),'MOTCUBE 7.5 kW','v2.6.0: the demand starts from the controller model of the request');
assert.match(await dd.locator('#hwDemList').innerText(),/no code/,'MOTCUBE parts are listed by name; codes are blank until the Super Admin fills them');
await dd.locator('#hwDemModel').selectOption({label:'NICE3000+ 11 kW'});
await dd.locator('#hwDemList tbody tr').first().waitFor();assert.ok(await dd.locator('#hwDemSuggest .hw-pick').count()>=1,'drive problem suggests drive parts');assert.match(await dd.locator('#hwDemSuggest').innerText(),/SUGGESTED FOR THIS PROBLEM/);
await dd.locator('#hwDemSupplier').selectOption('Monarch');
await dd.locator('#hwDemList input[name=hwDemPick]').first().check();
const pickedCode=await dd.locator('#hwDemList input[name=hwDemPick]:checked').evaluate(n=>n.closest('tr').children[1].innerText);
await dd.locator('[name=quantity]').fill('2');
await v259shot('07-raise-demand-picker');
await dd.getByRole('button',{name:'Submit demand',exact:true}).click();
await page.locator('#supportActionStatus').filter({hasText:'Damage demand submitted to Dispatch.'}).waitFor();
const dem=(await sequential(()=>h.db.query('select item_code,item_name,item_spec,component_model,supplier,catalog_id,quantity from wlf_private.damage_demands where request_id=$1',[demandReq]))).rows[0];
assert.equal(dem.component_model,'NICE3000+ 11 kW');assert.ok(dem.catalog_id);assert.equal(dem.quantity,2);assert.match(dem.item_spec,/Model: NICE3000\+ 11 kW/);
if(pickedCode.trim()!=='no code')assert.equal(dem.item_code,pickedCode.trim());
await logout();await login('user');
}
/* ---- v2.6.0 ---- */
{
await logout();await login('sa');
// units sit in the parameter names (Component Selection)
await tab('selection');await page.locator('#sel-capacity').selectOption('450');await page.locator('#sel-speed').selectOption('1');await page.locator('#sel-usageType').selectOption('MR');await page.locator('#sel-roping').selectOption('2:1');await page.locator('#searchBtn').click();
await page.locator('#matchesList .chip').first().click();
const selText=await page.locator('#tab-selection').innerText();
for(const word of ['UPS (VA)','ARD (A)','Controller Current (A)','Recommended AVR Rating (KVA)','Main Power Cable Size (RM)','SDB Main Breaker Rating (A)']) assert.ok(selText.includes(word),word);
assert.ok(!/\b14 A\b|\b1500 VA\b|\b32 A\b/.test(selText.replace(/Brake Resistor[^\n]*/g,'')),'values no longer repeat the unit');
await page.screenshot({path:'test-results/v260/01-component-units.png',fullPage:true});
// no red dot on the top menu
assert.equal(await page.locator('#menuDot').count(),0);
// catalogue order and Price
await tab('catalogue');await page.locator('.hw-sys-btn').first().waitFor();
assert.deepEqual(await page.locator('.hw-sys-btn b').allInnerTexts(),['MOT','NICE3000+','MOTCUBE','AVR'],'catalogue systems: controllers first, then AVR');
await page.locator('[data-hw-system="MOT"]').click();
assert.deepEqual((await page.locator('.hw-model').evaluateAll(n=>n.map(x=>x.firstChild.textContent.trim()))),['MOT 5.5 kW','MOT 7.5 kW','MOT 11 kW','MOT 15 kW','MOT 22 kW','MOT 37 kW','COP','LOP','Transom','COP Faceplate','Other components','Paid feature']);
await page.locator('[data-hw-model="MOT 7.5 kW"]').click();
assert.match(await page.locator('#hwTable thead').innerText(),/Price \(৳\)/i);
await page.locator('[data-hw-system="MOTCUBE"]').click();
assert.deepEqual((await page.locator('.hw-model').evaluateAll(n=>n.map(x=>x.firstChild.textContent.trim()))),['MOTCUBE 5.5 kW','MOTCUBE 7.5 kW','MOTCUBE 11 kW']);
await page.locator('[data-hw-system="AVR"]').click();
assert.deepEqual((await page.locator('.hw-model').evaluateAll(n=>n.map(x=>x.firstChild.textContent.trim()))),['AVR 15 KVA','AVR 20 KVA','AVR 30 KVA','AVR 40 KVA','AVR 60 KVA','AVR 80 KVA','AVR 100 KVA','AVR 120 KVA','AVR 150 KVA']);
await page.screenshot({path:'test-results/v260/02-catalogue.png'});
// Components Data: CSV download and import (replace all)
await tab('components');await page.locator('#componentsTable tbody tr').first().waitFor();
const rowsBefore=(await sequential(()=>h.db.query('select values from public.wlf_components order by id'))).rows.map(r=>JSON.stringify(r.values));
const csvDl=page.waitForEvent('download');await page.locator('#compCsvDownload').click();await (await csvDl).saveAs('test-results/v260/components-download.csv');
const csvLines=fs.readFileSync('test-results/v260/components-download.csv','utf8').trim().split(/\r?\n/);
assert.equal(csvLines.length,rowsBefore.length+1);assert.equal(csvLines[0].replace(/^﻿/,'').split(',').length,24);
const importCsv=async file=>{await page.locator('#compCsvFile').setInputFiles(file);await page.locator('#compImport h3').waitFor();};
fs.writeFileSync('test-results/v260/bad.csv','Capacity (KG),Speed\n450,1\n');
await importCsv('test-results/v260/bad.csv');
assert.match(await page.locator('#compImport').innerText(),/problem.*Nothing was changed/s);assert.equal(await page.locator('#compImportGo').isDisabled(),true);
await page.screenshot({path:'test-results/v260/03-components-import-error.png'});
await page.locator('#compImportCancel').click();
const real=fs.readFileSync('tests/fixtures/components-2026-11-20.csv','utf8').trim().split(/\r?\n/);
await importCsv('tests/fixtures/components-2026-11-20.csv');
assert.match(await page.locator('#compImport').innerText(),new RegExp('\\b'+(real.length-1)+'\\b rows are ready'));
await page.screenshot({path:'test-results/v260/04-components-import-preview.png'});
await page.locator('#compImportGo').click();
await page.locator('#msgBar,.msg.success,.toast').filter({hasText:/Components Data replaced/}).first().waitFor({timeout:20000}).catch(()=>{});
await page.waitForFunction(n=>/(\d+) of \d+ components/.test(document.getElementById('compCount').textContent)&&document.getElementById('compCount').textContent.includes('of '+n),real.length-1,{timeout:20000});
const nowRows=(await sequential(()=>h.db.query('select values from public.wlf_components order by id'))).rows;
assert.equal(nowRows.length,real.length-1);assert.equal(typeof nowRows[0].values[0],'number','numbers are stored as numbers');assert.equal(nowRows[0].values.length,24);
assert.equal(nowRows.filter(r=>r.values[2]==='MRL').length>0,true);
assert.equal(nowRows.some(r=>r.values[3]!=='2:1'&&r.values[3]!=='4:1'),false,'roping stays text');
// the new data drives the motor list and suggestions
await tab('selection');await page.locator('#sel-capacity').selectOption('450');await page.locator('#sel-speed').selectOption('1');await page.locator('#sel-usageType').selectOption('MR');await page.locator('#sel-roping').selectOption('2:1');await page.locator('#searchBtn').click();await page.locator('#matchesList .chip').first().waitFor();
await tab('components');await page.locator('#componentsTable tbody tr').first().waitFor();
await page.screenshot({path:'test-results/v260/05-components-after-import.png'});
// v2.6.1: QMS Data fits a phone, no 1/2 marks on the QMS tabs, Back button steps back through pages
{const vp=page.viewportSize();await page.setViewportSize({width:360,height:800});
await tab('qms');
assert.equal((await page.locator('#qmsTabInput').innerText()).trim(),'QMS Input');assert.equal((await page.locator('#qmsTabData').innerText()).trim(),'QMS Data');
await page.locator('#qmsTabData').click();await page.locator('#qmsResults .tbl').waitFor();await page.waitForTimeout(300);
const over=await page.evaluate(()=>({sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth,wide:[...document.querySelectorAll('#qmsPanel *')].filter(e=>{const r=e.getBoundingClientRect();return r.right>document.documentElement.clientWidth+1&&!e.closest('.tbl-wrap');}).slice(0,3).map(e=>e.tagName+'.'+e.className)}));
await page.screenshot({path:'test-results/v260/06-qms-data-360.png',fullPage:true});
if(over.sw>over.cw+1||over.wide.length)throw Error('MOBILE-OVERFLOW-DATA '+JSON.stringify(over));
await page.setViewportSize(vp);
await tab('account');await tab('qms');
await page.goBack();await page.locator('#tab-account').waitFor({state:'visible'});assert.equal(await page.locator('#tab-qms').isVisible(),false);
await page.goForward();await page.locator('#tab-qms').waitFor({state:'visible'});
await page.goBack();await page.locator('#tab-account').waitFor({state:'visible'});
await tab('account');}
// v2.6.1: QMS rows keep references only; Storage & Backup shows the new options, backs up and restores them
{const raw=(await sequential(()=>h.db.query('select parts, selection from wlf_private.qms_lifts limit 1'))).rows[0];
assert.ok(raw.parts.length&&raw.parts.every(p=>p.h&&!p.name&&!p.code),'QMS rows keep references, not copies');assert.ok(!raw.selection||raw.selection.h,'motor data is a reference too');
await tab('storage');await page.locator('#wlfUsageTable table').waitFor();
const usageText=await page.locator('#wlfUsageTable').innerText();for(const n of['QMS lift records','Hardware Catalogue','Components Data','Technical Support','Activity log (usage)'])assert.ok(usageText.includes(n),'usage lists '+n);
await page.screenshot({path:'test-results/v260/07-storage-desktop.png',fullPage:true});
const vp=page.viewportSize();await page.setViewportSize({width:360,height:800});await page.waitForTimeout(300);
const over=await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);await page.screenshot({path:'test-results/v260/07-storage-360.png',fullPage:true});
if(over>1)throw Error('MOBILE-OVERFLOW-STORAGE '+over);await page.setViewportSize(vp);
const dc=page.waitForEvent('download');await page.locator('#wlfBackupCatalogue').click();const cat=await dc;await cat.saveAs('test-results/v260/catalogue-backup.json');
const catJson=JSON.parse(fs.readFileSync('test-results/v260/catalogue-backup.json','utf8'));assert.equal(catJson.kind,'catalogue');assert.ok(catJson.rows.length>300);
await page.locator('#wlfDataStatus').filter({hasText:'Hardware Catalogue backup downloaded'}).waitFor();
const dq=page.waitForEvent('download');await page.locator('#wlfBackupQms').click();const qd=await dq;await qd.saveAs('test-results/v260/qms-backup.json');
const qmsJson=JSON.parse(fs.readFileSync('test-results/v260/qms-backup.json','utf8'));assert.equal(qmsJson.kind,'qms');assert.ok(qmsJson.rows.length>=1);assert.ok(qmsJson.rows[0].parts[0].code,'the QMS file holds readable data');
page.once('dialog',d=>d.accept());await page.locator('#wlfDataRestoreFile').setInputFiles('test-results/v260/qms-backup.json');
await page.locator('#wlfDataStatus').filter({hasText:/QMS restored: 0 lift\(s\) added/}).waitFor();
page.once('dialog',d=>d.accept());await page.locator('#wlfDataRestoreFile').setInputFiles('test-results/v260/catalogue-backup.json');
await page.locator('#wlfDataStatus').filter({hasText:/Hardware Catalogue restored: 0 row\(s\) added/}).waitFor();
fs.writeFileSync('test-results/v260/bad-backup.json','{"hello":1}');page.once('dialog',d=>d.accept());await page.locator('#wlfDataRestoreFile').setInputFiles('test-results/v260/bad-backup.json');
await page.locator('#wlfDataStatus').filter({hasText:'not a WLF'}).waitFor();
await tab('account');}
// v2.6.2: Excel backup for R&I Project, QMS data, Damage Demand, Supplier Claim; history delete; QMS lift in the Recycle bin; Documents Links permission
{fs.mkdirSync('test-results/v262',{recursive:true});page.removeAllListeners('dialog');if(process.env.WLF_SLOW){const cdp=await page.context().newCDPSession(page);await cdp.send('Emulation.setCPUThrottlingRate',{rate:Number(process.env.WLF_SLOW)});}
await tab('storage');await page.locator('[data-excel-kind=claim]').waitFor();
for(const k of['support','activity','project','qms','damage','claim'])assert.equal(await page.locator('[data-excel-kind='+k+']').count(),1,'button '+k);
await page.locator('#wlfExcelHistory table').waitFor();await page.screenshot({path:'test-results/v262/01-storage-excel-desktop.png',fullPage:true});
{const legacy=await page.locator('[data-backup-delete]').count();assert.ok(legacy>=1,'the Support backup history has a Delete button');
page.once('dialog',d=>{assert.match(d.message(),/not deleted/);d.accept();});await page.locator('[data-backup-delete]').first().click();
await page.locator('#wlfBackupStatus').filter({hasText:/history entry deleted/}).waitFor();await page.locator('#wlfExcelHistory table').waitFor();
assert.equal(await page.locator('[data-backup-delete]').count(),legacy-1);await page.locator('#wlfBackupDeleteAll').waitFor();}
const vp=page.viewportSize();await page.setViewportSize({width:360,height:800});await page.waitForTimeout(300);
const over=await page.evaluate(()=>({sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth}));await page.screenshot({path:'test-results/v262/01-storage-excel-360.png',fullPage:true});
if(over.sw>over.cw+1)throw Error('MOBILE-OVERFLOW-EXCEL '+JSON.stringify(over));await page.setViewportSize(vp);
await page.evaluate(()=>setAppearance('dark'));await page.waitForTimeout(300);await page.locator('#wlfExcelDeleteAll').scrollIntoViewIfNeeded();await page.screenshot({path:'test-results/v262/01-storage-excel-dark.png',fullPage:false});await page.setViewportSize({width:360,height:800});await page.waitForTimeout(200);await page.locator('#wlfExcelDeleteAll').scrollIntoViewIfNeeded();await page.screenshot({path:'test-results/v262/01-storage-excel-dark-360.png',fullPage:false});await page.setViewportSize(vp);await page.evaluate(()=>setAppearance('light'));
const book=async(path)=>Zip.loadAsync(fs.readFileSync(path));
const excelDownload=async(kind,file,attempt=1)=>{await page.waitForFunction(()=>[...document.querySelectorAll('[data-excel-kind]')].every(b=>!b.disabled),null,{timeout:60000});
 // Capture the bytes the app hands to the browser, so a CI Chrome that throttles repeated automatic downloads cannot fail the test.
 await page.evaluate(()=>{const s=document.querySelector('#wlfExcelStatus');if(s)s.textContent='';window.__wlfExcel=null;window.__wlfRoot=document.querySelector('#wlfExcelBackupRoot');const W=window.WlfExports;if(W&&!W.__wrapped){const orig=W.download;W.download=function(data,name){try{const u=data instanceof Uint8Array?data:new Uint8Array(data);let b='';for(let i=0;i<u.length;i+=32768)b+=String.fromCharCode.apply(null,u.subarray(i,i+32768));window.__wlfExcel={name,b64:btoa(b)};}catch(e){window.__wlfExcel={name,error:String(e)};}return orig.apply(this,arguments);};W.__wrapped=true;}});
 const logStart=(globalThis.edgeLog||[]).length;
 const c=page.waitForFunction(()=>window.__wlfExcel,null,{timeout:attempt===1?45000:90000}).then(async()=>{const x=await page.evaluate(()=>window.__wlfExcel);if(!x.b64)throw Error(x.error);fs.writeFileSync(file,Buffer.from(x.b64,'base64'));return 'captured';});c.catch(()=>{});
 if(!(process.env.WLF_DROP_CLICK===kind&&attempt===1))await page.locator('[data-excel-kind='+kind+']').click();
 if(process.env.WLF_FORCE_REMOUNT===kind&&attempt===1)await page.evaluate(()=>WlfTools.storage());
 try{await c;}catch(e){
  const info='On-screen status: "'+(await page.locator('#wlfExcelStatus').innerText().catch(()=>'?'))+'"; busy buttons: '+(await page.locator('[data-excel-kind]:disabled').count())+
   '; page re-rendered: '+(await page.evaluate(()=>window.__wlfRoot!==document.querySelector('#wlfExcelBackupRoot')))+'; mode: '+(await page.locator('input[name=wlfExcelMode]:checked').getAttribute('value').catch(()=>'?'))+
   '; edge calls: '+((globalThis.edgeLog||[]).slice(logStart).join(' | ')||'none')+'; console: '+globalThis.consoleErrors.slice(-3).join(' | ');
  if(attempt===1){console.log('WARN Excel '+kind+' first attempt gave no file, retrying once. '+info);
   if(kind==='damage'){await page.locator('input[name=wlfExcelMode][value=clear]').check();if(!page.listenerCount('dialog'))page.once('dialog',d=>d.accept());}return excelDownload(kind,file,2);}
  throw Error('Excel '+kind+': no download. '+info);}};
// QMS data without clear: downloaded, saved to Drive, nothing removed
const liftsBefore=Number((await sequential(()=>h.db.query('select count(*) n from wlf_private.qms_lifts where deleted_at is null'))).rows[0].n);assert.ok(liftsBefore>=1);
let dl;await excelDownload('qms','test-results/v262/qms.xlsx');
await page.locator('#wlfExcelStatus').filter({hasText:'verified copy'}).waitFor();
assert.match(await(await book('test-results/v262/qms.xlsx')).file('xl/workbook.xml').async('string'),/QMS Components/);
assert.equal(Number((await sequential(()=>h.db.query('select count(*) n from wlf_private.qms_lifts where deleted_at is null'))).rows[0].n),liftsBefore);
// R&I Project and Supplier Claim without clear
await excelDownload('project','test-results/v262/project.xlsx');
await page.locator('#wlfExcelStatus').filter({hasText:'verified copy'}).waitFor();assert.match(await(await book('test-results/v262/project.xlsx')).file('xl/workbook.xml').async('string'),/Projects/);
await excelDownload('claim','test-results/v262/claim.xlsx');
await page.locator('#wlfExcelStatus').filter({hasText:'verified copy'}).waitFor();assert.match(await(await book('test-results/v262/claim.xlsx')).file('xl/workbook.xml').async('string'),/Supplier Claim/);
// Damage Demand with clear, then restore from the history row
await sequential(()=>h.db.query(`insert into wlf_private.damage_demands(request_id,category,request_reference,requester_id,requester_name,requested_at,project,lift_id,controllers,problem_categories,form_schema,form_values,confirmed_by,confirmed_name,solution_statement,item_name,item_code,item_spec,quantity,create_operation,create_payload_hash,received_at,received_by,received_name)
 values(gen_random_uuid(),'aftersales','R-E2E',$1,'u',now(),'P','1','{}','{}','{}','{}',$1,'rni','fixed','Received fixture','C-1','spec',2,gen_random_uuid(),'\\x00',now(),$1,'sa')`,[IDS.sa]));
const demandsBefore=Number((await sequential(()=>h.db.query('select count(*) n from wlf_private.damage_demands'))).rows[0].n);
const eligible=Number((await sequential(()=>h.db.query("select count(*) n from wlf_private.damage_demands d where wlf_private.excel_eligible('damage',d)"))).rows[0].n);
await page.locator('input[name=wlfExcelMode][value=clear]').check();
page.once('dialog',d=>d.accept());
await excelDownload('damage','test-results/v262/damage.xlsx');
{const cleared=page.locator('#wlfExcelStatus').filter({hasText:/record\(s\) cleared/});
 if(!await cleared.waitFor({timeout:20000}).then(()=>true,()=>false)){ // page was re-rendered mid-run: finish through the history row
  const row=page.locator('#wlfExcelHistory tr').filter({hasText:'Damage Demand'}).first().locator('[data-excel-action=clear]');
  await row.waitFor({timeout:30000});if(!page.listenerCount('dialog'))page.once('dialog',d=>d.accept());await row.click();await cleared.waitFor();}}
assert.equal(Number((await sequential(()=>h.db.query('select count(*) n from wlf_private.damage_demands'))).rows[0].n),demandsBefore-eligible);
assert.match(await(await book('test-results/v262/damage.xlsx')).file('xl/workbook.xml').async('string'),/Damage Demand/);
await page.locator('#wlfExcelHistory tr').filter({hasText:'Damage Demand'}).first().locator('[data-excel-action=restore]').waitFor();await page.screenshot({path:'test-results/v262/02-history-desktop.png',fullPage:true});
assert.ok(eligible>=1,'a Received demand exists');page.once('dialog',d=>d.accept());await page.locator('#wlfExcelHistory tr').filter({hasText:'Damage Demand'}).first().locator('[data-excel-action=restore]').click();
await page.locator('#wlfExcelStatus').filter({hasText:/record\(s\) restored/}).waitFor();
assert.equal(Number((await sequential(()=>h.db.query('select count(*) n from wlf_private.damage_demands'))).rows[0].n),demandsBefore);
// history: delete one row, then all
const rowsBefore=await page.locator('#wlfExcelHistory tbody tr').count();assert.ok(rowsBefore>=5);
page.once('dialog',d=>{assert.match(d.message(),/not deleted/);d.accept();});
await page.locator('#wlfExcelHistory tr').filter({hasText:'Supplier Claim'}).first().locator('[data-excel-action=delete]').click();
await page.locator('#wlfExcelStatus').filter({hasText:'history entry deleted'}).waitFor();await page.waitForFunction(n=>document.querySelectorAll('#wlfExcelHistory tbody tr').length===n-1,rowsBefore);
page.once('dialog',d=>d.dismiss());await page.locator('#wlfExcelDeleteAll').click();await page.waitForTimeout(200);assert.equal(await page.locator('#wlfExcelHistory tbody tr').count(),rowsBefore-1,'cancel keeps the history');
page.once('dialog',d=>d.accept('DELETE'));await page.locator('#wlfExcelDeleteAll').click();
await page.locator('#wlfExcelStatus').filter({hasText:/history entr(y|ies) deleted/}).waitFor();await page.locator('#wlfExcelHistory').filter({hasText:'No verified Excel backups yet'}).waitFor();
await page.screenshot({path:'test-results/v262/03-history-empty.png',fullPage:true});
// QMS: delete a lift -> Recycle bin -> restore -> delete -> delete permanently
await tab('qms');await page.locator('#qmsTabData').click();await page.locator('#qmsResults .tbl').waitFor();
const qmsLabel=(await page.locator('#qmsResults [data-qms-open]').first().innerText()).trim();
await page.locator('#qmsResults [data-qms-open]').first().click();await page.locator('#qmsDelete').waitFor();
await page.locator('#qmsDelete').click();assert.match(await page.locator('body').innerText(),/moves to the Recycle bin/);
await page.locator('#hwConfirm').click();await page.locator('#qmsResults').filter({hasText:'moved to the Recycle bin'}).waitFor().catch(()=>{});
assert.equal(Number((await sequential(()=>h.db.query('select count(*) n from wlf_private.qms_lifts where deleted_at is null'))).rows[0].n),liftsBefore-1);
await page.locator('#nav [data-tab=recycle-bin]').click();await page.locator('#binTable').waitFor();
const qmsRow=page.locator('#binTable tr').filter({hasText:'QMS lift record'});await qmsRow.waitFor();await page.screenshot({path:'test-results/v262/04-recycle-bin-qms.png',fullPage:true});
await qmsRow.locator('[data-bin-restore]').click();await page.locator('#binStatus').filter({hasText:/Restored/}).waitFor();
assert.equal(Number((await sequential(()=>h.db.query('select count(*) n from wlf_private.qms_lifts where deleted_at is null'))).rows[0].n),liftsBefore);
const lid=(await sequential(()=>h.db.query('select id from wlf_private.qms_lifts where deleted_at is null limit 1'))).rows[0].id;
await sequential(()=>h.rpc('sa','deleteQmsLift',[{id:lid}]));
await tab('qms');await tab('recycle-bin');await page.locator('#binTable tr').filter({hasText:'QMS lift record'}).locator('[data-bin-purge]').click();await page.locator('#wlfAdminDialog[open]').waitFor();
await page.locator('#wlfAdminYes').click();await page.locator('#binStatus').filter({hasText:/deleted/i}).waitFor();
assert.equal(Number((await sequential(()=>h.db.query('select count(*) n from wlf_private.qms_lifts where id=$1',[lid]))).rows[0].n),0,'permanently removed from the database');
await tab('account');}
// v2.6.2: Documents Links follows the new permission; only the Super Admin sees the edit buttons
{const setDocs=on=>sequential(()=>h.db.query(on?"update public.wlf_profiles set permissions=array_append(array_remove(permissions,'documents:view'),'documents:view'),access_revision=access_revision+1 where id=$1":"update public.wlf_profiles set permissions=array_remove(permissions,'documents:view'),access_revision=access_revision+1 where id=$1",[IDS.user]));
await logout();await setDocs(true);await login('user');
await page.locator('#nav [data-tab=documents]').waitFor({state:'visible'});await tab('documents');await page.locator('#tab-documents').waitFor({state:'visible'});await page.waitForTimeout(400);
assert.equal(await page.locator('#wlfAddCategory').isVisible().catch(()=>false),false,'a normal user cannot add or edit documents');
await page.screenshot({path:'test-results/v262/05-documents-user.png',fullPage:true});await tab('account');
await logout();await setDocs(false);await login('user');await page.locator('#nav [data-tab=documents]').waitFor({state:'hidden'});
assert.equal(await page.locator('#nav [data-tab=documents]').isVisible(),false,'Documents Links is hidden without the permission');
await logout();await setDocs(true);await login('user');}
}
// v2.6.3: no saved calculations; Backup card; Activity log archive to Drive
{
await logout();await login('sa');fs.mkdirSync('test-results/v263',{recursive:true});
await tab('calculation');assert.equal(await page.locator('#saveRecordBtn,#recordsBtn,#recordsDialog').count(),0,'Save calculation and Records are removed');
await page.locator('#printCalcBtn').waitFor();await page.screenshot({path:'test-results/v263/01-calculation-pdf.png',fullPage:false});
await page.emulateMedia({media:'print'});await page.evaluate(()=>document.body.classList.add('printing-calc'));await page.screenshot({path:'test-results/v263/02-calculation-print.png',fullPage:false});await page.evaluate(()=>document.body.classList.remove('printing-calc'));await page.emulateMedia({media:'screen'});
await tab('storage');await page.locator('#wlfFullBackup').waitFor();await page.locator('#wlfFullHistory').filter({hasText:'No backups yet'}).waitFor();
const capture=async(clickTarget,file)=>{await page.evaluate(()=>{window.__wlfExcel=null;const W=window.WlfExports;if(!W.__wrapped2){const orig=W.download;W.download=function(data,name){try{const u=data instanceof Uint8Array?data:new Uint8Array(data);let b='';for(let i=0;i<u.length;i+=32768)b+=String.fromCharCode.apply(null,u.subarray(i,i+32768));window.__wlfExcel={name,b64:btoa(b)};}catch(e){window.__wlfExcel={name,error:String(e)};}return orig.apply(this,arguments);};W.__wrapped2=true;}});
 await clickTarget.click();await page.waitForFunction(()=>window.__wlfExcel,null,{timeout:60000});const x=await page.evaluate(()=>window.__wlfExcel);fs.writeFileSync(file,Buffer.from(x.b64,'base64'));return x.name;};
const name=await capture(page.locator('#wlfFullNow'),'test-results/v263/backup.json');
assert.match(name,/^WLF-Backup-.*\.json$/);const saved=JSON.parse(fs.readFileSync('test-results/v263/backup.json','utf8'));assert.equal(saved.format,'WLF-FULL-2.6.3');assert.ok(saved.tables['hardware-catalogue'].length>100);
await page.locator('#wlfFullStatus').filter({hasText:'verified copy'}).waitFor();await page.locator('#wlfFullHistory [data-full-action=download]').first().waitFor();
assert.equal(await page.locator('#wlfFullHistory tbody tr').count(),1);
await page.locator('#wlfFullBackup').scrollIntoViewIfNeeded();await page.screenshot({path:'test-results/v263/03-backup-desktop.png',fullPage:false});
await capture(page.locator('#wlfFullHistory [data-full-action=download]').first(),'test-results/v263/backup2.json');assert.equal(JSON.parse(fs.readFileSync('test-results/v263/backup2.json','utf8')).id,saved.id);
await sequential(()=>h.db.query('delete from wlf_private.hw_suggest'));
page.removeAllListeners('dialog');page.once('dialog',d=>d.accept());await page.locator('#wlfFullHistory [data-full-action=restore]').first().click();
await page.locator('#wlfFullStatus').filter({hasText:/Restored: .*hardware-suggest/}).waitFor();
assert.ok(Number((await sequential(()=>h.db.query('select count(*) n from wlf_private.hw_suggest'))).rows[0].n)>=1);
await page.setViewportSize({width:360,height:800});await page.evaluate(()=>setAppearance('dark'));await page.waitForTimeout(300);await page.locator('#wlfFullBackup').scrollIntoViewIfNeeded();await page.screenshot({path:'test-results/v263/04-backup-360-dark.png',fullPage:false});await page.evaluate(()=>setAppearance('light'));await page.setViewportSize({width:1280,height:900});
page.removeAllListeners('dialog');page.once('dialog',d=>d.accept());await page.locator('#wlfFullHistory [data-full-action=delete]').first().click();
await page.locator('#wlfFullHistory').filter({hasText:'No backups yet'}).waitFor();
// Activity log: older than 7 days goes to Drive first, then is deleted
await sequential(()=>h.db.query("insert into public.wlf_usage(actor,action,details,at) select $1,'Login','old row '||g, now()-interval '10 days' from generate_series(1,4) g",[IDS.sa]));
const filesBefore=excelFiles.size;
await page.evaluate(()=>{localStorage.removeItem('wlf-usage-archive');window.dispatchEvent(new Event('wlf-ready'));});
await page.locator('#globalMsg').filter({hasText:/saved to Google Drive \(WLF Activity backup\)/}).waitFor({timeout:30000});
assert.ok(excelFiles.size>filesBefore,'a file was saved to Drive');
assert.equal(Number((await sequential(()=>h.db.query("select count(*) n from public.wlf_usage where at<now()-interval '7 days'"))).rows[0].n),0);
await page.screenshot({path:'test-results/v263/05-usage-archived.png',fullPage:false});
}

// v2.6.4: Admin Panel, one Backup card, QMS lift Excel in one sheet
{
await logout();await login('sa');fs.mkdirSync('test-results/v264',{recursive:true});
const v264shot=async name=>{await page.screenshot({path:'test-results/v264/'+name+'.png',fullPage:false});};
// Admin Panel
assert.equal((await page.locator('#nav [data-tab=workspace-dashboard]').innerText()).trim(),'Admin Panel','menu is renamed');
await tab('workspace-dashboard');await page.locator('#workspaceFilters h3',{hasText:'Admin Panel'}).waitFor();await page.locator('#apBody .mgmt-card').first().waitFor();
await page.selectOption('#apDash','team');
const panelText=await page.locator('#tab-workspace-dashboard').innerText();
assert.match(panelText,/Curve/);assert.match(panelText,/Time invested/i);
await page.selectOption('#apUser',{index:1});const oneText=await page.locator('#apBody').innerText();assert.match(oneText,/Team Activity/);assert.match(oneText,/SCM & Supplier communication/);await page.selectOption('#apUser','all');
assert.doesNotMatch(panelText,/Who handled them/,'the who-handled table is gone from Technical Support');
assert.ok(await page.locator('#workspaceFull').isVisible(),'Full screen button');
const wide=await page.evaluate(()=>{const a=document.querySelector('#tab-workspace-dashboard .admin-panel');return a.getBoundingClientRect().width;});assert.ok(wide>900,'the panel uses the width: '+wide);
// the numbers on screen are the numbers of the database
const dbTotals=(await sequential(()=>h.db.query(`select count(*) filter(where h.action='receive') rec,count(*) filter(where h.action='solve') sol,count(*) filter(where h.action='forward') fwd
  from public.wlf_history h join public.wlf_requests r on r.id=h.request_id and r.deleted_at is null join public.wlf_profiles u on u.id=h.actor and u.role='R&I' and u.status='Approved'
  where h.at>=date_trunc('month',now() at time zone 'Asia/Dhaka') at time zone 'Asia/Dhaka' and h.action in ('receive','forward','solve','notSolved')`))).rows[0];
const panel=await page.evaluate(()=>rpc('getAdminPanel',[T(),{}]));
const sum=k=>panel.users.reduce((t,u)=>t+Number(u.support[k]),0);
assert.deepEqual([sum('received'),sum('solved'),sum('forwarded')],[Number(dbTotals.rec),Number(dbTotals.sol),Number(dbTotals.fwd)],'support numbers match the database');
assert.ok(panel.users.length>=1&&panel.users.every(u=>u.sectors.length===4&&u.curve['Activity entries'].length===12));
console.log('Admin Panel users',panel.users.map(u=>u.name+' support '+JSON.stringify(u.support)+' sectors '+u.sectors.map(x=>x.entries+'/'+x.minutes).join(',')).join(' | '));
await v264shot('01-admin-panel-desktop');
await page.locator('#apBody').scrollIntoViewIfNeeded();await v264shot('02-admin-panel-user');
await page.evaluate(()=>setAppearance('dark'));await page.waitForTimeout(300);await page.locator('#apBody').scrollIntoViewIfNeeded();await v264shot('03-admin-panel-user-dark');
await page.setViewportSize({width:360,height:800});await page.waitForTimeout(300);
const over=await page.evaluate(()=>({sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth}));
if(over.sw>over.cw+1)throw Error('MOBILE-OVERFLOW-ADMIN-PANEL '+JSON.stringify(over));
await page.locator('#apBody').scrollIntoViewIfNeeded();await v264shot('04-admin-panel-360-dark');
await page.setViewportSize({width:1280,height:900});await page.evaluate(()=>setAppearance('light'));
// who sees it is chosen per user: a user without the tick has no Admin Panel
await logout();await login('user');assert.equal(await page.locator('#nav [data-tab=workspace-dashboard]').isVisible(),false);
await logout();await login('sa');
// one Backup card
await tab('storage');await page.locator('#wlfBackupCard').waitFor();
assert.equal((await page.locator('#wlfBackupCard h3').first().innerText()).trim(),'Backup');
assert.equal(await page.locator('#wlfBackupCard #wlfFullBackup').count(),1,'reference-data backup sits inside the Backup card');
assert.equal(await page.locator('#wlfBackupCard [data-excel-kind]').count(),6);
assert.match(await page.locator('#wlfBackupCard .wlf-tools-actions').first().innerText(),/R&I Project Manager/);
assert.equal(await page.locator('#tab-storage h3',{hasText:/^Technical Support backup/}).count(),0,'no second Technical Support card');
await page.locator('#wlfBackupCard').scrollIntoViewIfNeeded();await v264shot('05-backup-card');
await page.evaluate(()=>document.querySelectorAll('#tab-storage details').forEach(d=>{d.open=false;}));
// QMS lift Excel: one sheet with all six tables
{const rows=(await sequential(()=>h.db.query("select id,hardware from wlf_private.hw_catalogue where system='MOT' and model='MOT 7.5 kW' and deleted_at is null order by hardware,id"))).rows;
 const seen=new Set(),items=[];for(const r of rows){if(!seen.has(r.hardware)){seen.add(r.hardware);items.push({catalogueId:r.id,section:'control'});}}
 for(const lid of ['X-264','X-265'])await page.evaluate(([items,id,lid])=>rpc('saveQmsLift',[T(),{id,liftId:lid,project:'Report Tower',address:'Uttara, Dhaka',deliveryDate:'2026-11-23',motorType:'Gearless',liftType:'Passenger',system:'MOT',controllerModel:'MOT 7.5 kW',
  serials:{motor:'M-264',encoder:'E-264',drive:'D-264',ups:'U-264',cartop:'C-264',cop:'P-264',copDisplay:'CD-264'},selection:{inputs:{capacity:450,speed:1,usageType:'MR',roping:'2:1'},categories:[{title:'1. Selected Motor Data',items:[{label:'Motor Brand',value:'Ziehl Abegg'}]}]},items}]),[items,crypto.randomUUID(),lid]);}
await tab('qms');await page.locator('#qmsTabData').click();await page.locator('#qmsSearch [name=liftId]').waitFor();
await page.locator('#qmsSearch [name=liftId]').fill('X-264');await page.locator('#qmsSearch button[type=submit]').click();
await page.locator('#qmsExcel').waitFor({timeout:30000});
const [dl]=await Promise.all([page.waitForEvent('download',{timeout:60000}),page.locator('#qmsExcel').click()]);
assert.equal(dl.suggestedFilename(),'QMS-X-264.xlsx');await dl.saveAs('test-results/v264/QMS-X-264.xlsx');
await page.locator('#qmsLiftStatus').filter({hasText:'Excel downloaded.'}).waitFor();
{const JSZip=require('jszip');const zip=await JSZip.loadAsync(fs.readFileSync('test-results/v264/QMS-X-264.xlsx'));
 const sheets=Object.keys(zip.files).filter(f=>/^xl\/worksheets\/sheet\d+\.xml$/.test(f));assert.equal(sheets.length,1,'one sheet');
 const xml=await zip.file(sheets[0]).async('string');
 for(const t of ['1 · Project information','2 · Selected motor','3 · Control system','4 · Serial numbers','5 · COP · LOP · Transom · Travelling cable','6 · AVR','7 · Other components','X-264','Report Tower','Uttara, Dhaka','M-264','D-264','Ziehl Abegg'])assert.ok(xml.includes(t),'sheet has '+t);}
// several lifts at once: one flat sheet
await page.locator('#qmsBack').click();await page.locator('#qmsSearch [name=liftId]').fill('');await page.locator('#qmsSearch button[type=submit]').click();
await page.locator('#qmsResults table').waitFor();
const [dl2]=await Promise.all([page.waitForEvent('download',{timeout:60000}),page.locator('#qmsAllExcel').click()]);
assert.match(dl2.suggestedFilename(),/^QMS-data-\d{4}-\d{2}-\d{2}\.xlsx$/);await dl2.saveAs('test-results/v264/QMS-data.xlsx');
{const JSZip=require('jszip');const zip=await JSZip.loadAsync(fs.readFileSync('test-results/v264/QMS-data.xlsx'));const wb=await zip.file('xl/workbook.xml').async('string');for(const n of ['QMS Lifts','QMS Components','QMS Serial numbers','QMS Output Tables'])assert.ok(wb.includes(n),'v2.6.7: the download has the backup sheet '+n);
 const xml=await zip.file('xl/worksheets/sheet4.xml').async('string');for(const t of ['Lift ID','Table name','X-264','Control system','Serial numbers'])assert.ok(xml.includes(t),'flat sheet has '+t);
 assert.ok((await zip.file('xl/worksheets/sheet3.xml').async('string')).includes('M-264'),'serial numbers sheet has the serials');}
await page.setViewportSize({width:1280,height:900});await page.screenshot({path:'test-results/v264/06-qms-data.png',fullPage:false});
}
// v2.6.5: Paid feature information (chips, kW choice, special note, table 7), Select all / Clear all
fs.mkdirSync('test-results/v265',{recursive:true});
{const shot=async(name,full)=>{await page.screenshot({path:'test-results/v265/'+name+'.png',fullPage:!!full});};
 const form='#qmsLiftForm ';
 const basics=async(id,system)=>{await tab('qms');await page.locator('#qmsTabInput').click();await page.locator(form).waitFor();
  await page.locator(form+'[name=liftId]').fill(id);await page.locator(form+'[name=project]').fill('Paid Tower');await page.locator(form+'[name=deliveryDate]').fill('2026-11-27');await page.locator(form+'[name=address]').fill('Mirpur');await page.locator(form+'[name=motorType]').selectOption('Gearless');await page.locator(form+'[name=liftType]').selectOption('Passenger');
  await page.locator(form+'[name=system]').selectOption(system);await page.locator(form+'[name=controllerModel]').selectOption({index:1});
  for(const sel of await page.locator('[data-control-pick]').all()) await sel.selectOption({index:1});
  for(const [k,v] of Object.entries({motor:'M-1',encoder:'E-1',drive:'D-1',ups:'U-1',cartop:'C-1',cop:'P-1',copDisplay:'CD-1'})) await page.locator(form+'[name=sl-'+k+']').fill(v);};
 const submit=async()=>{const b=page.locator(form+'[type=submit]');await b.scrollIntoViewIfNeeded();await b.focus();await page.waitForTimeout(200);await b.click();};
 await basics('PF-MOT','MOT');
 const total=await page.locator(form+'input[name=other]').count();assert.ok(total>1,'other components exist');
 await page.locator('[data-other-all]').click();assert.equal(await page.locator(form+'input[name=other]:checked').count(),total,'Select all ticks every component');
 await page.locator('[data-other-none]').click();assert.equal(await page.locator(form+'input[name=other]:checked').count(),0,'Clear all unticks them');
 await page.locator('[data-other-all]').click();
 const motChips=await page.locator('[data-paid-chip]').allInnerTexts();
 assert.deepEqual(motChips,['Voice Announcer','Access Controller Card+Finger','Access Controller Card+Finger+Password','Access Controller AI Face','RFID Card','Cloud Monitoring','Remote Alarm','BMS','Regenerative drive']);
 assert.deepEqual(await page.locator(form+'legend').allInnerTexts().then(a=>a.slice(-2)),['6 · Paid feature information','7 · Special note']);
 await page.locator('[data-paid-chip="Voice Announcer"]').click();await page.locator('[data-paid-chip="Remote Alarm"]').click();await page.locator('[data-paid-chip="Regenerative drive"]').click();
 assert.equal(await page.locator('[data-paid-chip].on').count(),3);
 assert.equal(await page.locator('select[name^="paidkw:"]').count(),0,'MOT has one Regenerative drive, so no kW choice');
 assert.equal(await page.locator(form+'input[name=other]:checked').count(),total,'chip clicks keep the other components ticked');
 await page.locator(form+'[name=specialNote]').fill('Install after handover');
 await page.locator('[data-paid-chip="BMS"]').scrollIntoViewIfNeeded();await shot('01-paid-input-desktop');
 {const vp=page.viewportSize();await page.setViewportSize({width:360,height:800});await page.evaluate(()=>setAppearance('dark'));await page.waitForTimeout(300);
  await page.locator('[data-paid-chip="BMS"]').scrollIntoViewIfNeeded();await shot('02-paid-input-360-dark');
  const over=await page.evaluate(()=>({sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth}));if(over.sw>over.cw+1)throw Error('MOBILE-OVERFLOW '+JSON.stringify(over));
  await page.evaluate(()=>setAppearance('light'));await page.setViewportSize(vp);}
 await submit();await page.locator('#qmsLiftStatus').filter({hasText:'Lift PF-MOT saved'}).waitFor();
 await basics('PF-NICE','NICE3000+');
 const niceChips=await page.locator('[data-paid-chip]').allInnerTexts();assert.ok(niceChips.includes('Regenerative drive')&&niceChips.includes('BMS'));
 await page.locator('[data-paid-chip="Regenerative drive"]').click();
 const kw=page.locator('select[name="paidkw:Regenerative drive"]');await kw.waitFor();
 assert.deepEqual((await kw.locator('option').allInnerTexts()).slice(1).map(x=>x.split(' ·')[0]),['5 kW','7 kW','11 kW','15 kW','18 kW','22 kW','30 kW']);
 await submit();await page.locator('#qmsLiftStatus').filter({hasText:/Choose the option \(kW\)/}).waitFor();
 await kw.selectOption({label:'15 kW · 494757'});await shot('03-paid-input-nice-kw');
 await submit();await page.locator('#qmsLiftStatus').filter({hasText:'Lift PF-NICE saved'}).waitFor();
 await page.locator('#qmsTabData').click();await page.locator('#qmsSearch [name=liftId]').fill('PF-MOT');await page.locator('#qmsSearch button[type=submit]').click();await page.locator('#qmsExcel').waitFor({timeout:30000});
 const t7=page.locator('.hw-out').filter({hasText:'8 · PAID FEATURE INFORMATION'});
 const t7text=await t7.innerText();
 for(const x of ['Voice Announcer','270428','G&Z-PLUS LIFT ANNOUNCER','Remote Alarm','Arline-M Center Module','Arline-S-Int Speaking Uni','Regenerative drive','321528'])assert.ok(t7text.includes(x),'table 8 has '+x);
 assert.ok(!t7text.includes('Install after handover'),'the note is not inside Paid feature');
 {const t8=await page.locator('.hw-out').filter({hasText:'9 · SPECIAL NOTE'}).innerText();assert.ok(t8.includes('Install after handover'),'table 9 holds the special note');}
 assert.equal(await t7.locator('tbody tr').count(),1+4+1,'one Voice Announcer row, four Remote Alarm rows and one Regenerative drive row');
 await t7.scrollIntoViewIfNeeded();await shot('04-paid-output-desktop');
 const [dl]=await Promise.all([page.waitForEvent('download',{timeout:60000}),page.locator('#qmsExcel').click()]);
 await dl.saveAs('test-results/v265/QMS-PF-MOT.xlsx');
 {const JSZip=require('jszip');const zip=await JSZip.loadAsync(fs.readFileSync('test-results/v265/QMS-PF-MOT.xlsx'));const xml=await zip.file('xl/worksheets/sheet1.xml').async('string');
  for(const t of ['8 · Paid feature information','Arline-M Center Module','9 · Special note','Install after handover','G&amp;Z-PLUS LIFT ANNOUNCER'])assert.ok(xml.includes(t),'Excel has '+t);}
 await page.locator('#qmsEdit').click();await page.locator(form).waitFor();
 assert.equal(await page.locator('[data-paid-chip].on').count(),3,'saved paid features are ticked when editing');
 assert.equal(await page.locator(form+'[name=specialNote]').inputValue(),'Install after handover');
 await page.locator('[data-paid-chip="Remote Alarm"]').click();await submit();await page.locator('#qmsLiftStatus').filter({hasText:'Changes saved.'}).waitFor();
 assert.equal(await page.locator('.hw-out').filter({hasText:'8 · PAID FEATURE INFORMATION'}).locator('tbody tr').count(),2,'Remote Alarm switched off');
 await page.locator('#qmsBack').click();await page.locator('#qmsSearch [name=liftId]').fill('PF-');await page.locator('#qmsSearch button[type=submit]').click();await page.locator('#qmsResults table').waitFor();
 const [dl3]=await Promise.all([page.waitForEvent('download',{timeout:60000}),page.locator('#qmsAllExcel').click()]);await dl3.saveAs('test-results/v265/QMS-data.xlsx');
 {const JSZip=require('jszip');const zip=await JSZip.loadAsync(fs.readFileSync('test-results/v265/QMS-data.xlsx'));const xml=await zip.file('xl/worksheets/sheet4.xml').async('string');
  for(const t of ['Paid feature information','Regenerative Device - MCTC-AFE-4015N'])assert.ok(xml.includes(t),'flat sheet has '+t);}
}
// v2.6.6: Admin Panel (one dashboard at a time, user filter, curves with 1/3/6/12 month range)
fs.mkdirSync('test-results/v266',{recursive:true});
{const shot=async(name)=>{await page.screenshot({path:'test-results/v266/'+name+'.png',fullPage:false});};
 await tab('workspace-dashboard');await page.locator('#apBody .mgmt-card').first().waitFor();
 const body='#apBody ';
 // every dashboard has its own curve and the range changes it
 const series=await page.evaluate(()=>rpc('getAdminSeries',[T()]));
 assert.equal(series.days,365);assert.ok(series.users.length>=2,'two or more R&I users: '+series.users.length);
 assert.ok(series.users.every(u=>Object.values(u.s).every(a=>a.length===365)));
 const dbEntries=Number((await sequential(()=>h.db.query(`select count(*) n from public.wlf_ri_entries e join public.wlf_profiles p on p.id=e.owner and p.role='R&I' and p.status='Approved' where e.deleted_at is null and e.created_at>=now()-interval '364 days'`))).rows[0].n);
 assert.ok(series.users.reduce((t,u)=>t+u.s.entries.reduce((a,b)=>a+Number(b),0),0)<=dbEntries+0&&dbEntries>=0,'the curve never counts more than the database');
 for(const dash of ['team','support','damage','claims','curves']){
  await page.selectOption('#apDash',dash);await page.locator(body+'svg.ap-chart').first().waitFor();
  for(const r of ['1','3','6','12']){await page.selectOption('#apRange',r);assert.ok(await page.locator(body+'svg.ap-chart').count()>=1,dash+' range '+r);}
  assert.equal(await page.locator('#apRange').inputValue(),'12');
 }
 // team dashboard: compare everyone, then one user
 await page.selectOption('#apDash','team');await page.selectOption('#apRange','12');await page.locator('[data-ap-mode=together]').click();
 assert.match(await page.locator(body).innerText(),/Share of time/i);
 assert.ok(await page.locator(body+'.ap-chip').count()>=2,'a name chip per R&I user');
 await page.locator(body+'.ap-chip').first().click();assert.ok(await page.locator(body+'.ap-chip.off').count()===1,'a line can be hidden');await page.locator(body+'.ap-chip.off').click();
 await page.locator(body+'.ap-chartbox').first().scrollIntoViewIfNeeded();const box=await page.locator(body+'.ap-chartbox').first().boundingBox();await page.mouse.move(box.x+box.width*.4,box.y+100);await page.mouse.move(box.x+box.width*.6,box.y+110);
 await page.locator(body+'.ap-tip:not([hidden])').waitFor();assert.match(await page.locator(body+'.ap-tip').first().innerText(),/'\d\d/,'the hover box names the month');
 await shot('01-admin-panel-team-curves');
 await page.selectOption('#apRange','1');assert.ok(await page.locator(body+'.ap-mini').count()>=2,'1 month opens one chart per user');
 assert.equal(await page.locator('.ap-seg button.on').innerText(),'One by one');
 await shot('02-admin-panel-1-month');
 await page.selectOption('#apRange','3');await page.locator('[data-ap-mode=together]').click();
 const first=await page.locator('#apUser option').nth(1).getAttribute('value');
 await page.selectOption('#apUser',first);assert.equal(await page.locator(body+'.ap-chip').count(),0,'one user: no name chips');assert.equal(await page.locator('.ap-seg').count(),0);
 assert.ok(await page.locator(body+'svg.ap-chart path.avg').count()===1,'team average line for one user');
 // support, damage and claims show the user table plus their own metrics
 await page.selectOption('#apUser','all');
 await page.selectOption('#apDash','support');assert.deepEqual(await page.locator('#apMetric option').allInnerTexts(),['Support received','Support solved','Not solved','Forwarded']);
 await page.selectOption('#apDash','damage');assert.deepEqual(await page.locator('#apMetric option').allInnerTexts(),['Damage demands raised']);
 await page.selectOption('#apDash','curves');assert.ok(await page.locator('#apMetric optgroup').count()===4,'every measure in one list');
 await page.selectOption('#apMetric','solved');await shot('03-admin-panel-performance-curves');
 // phone, dark: no sideways page scroll
 await page.evaluate(()=>setAppearance('dark'));await page.setViewportSize({width:360,height:800});await page.selectOption('#apDash','support');await page.waitForTimeout(300);
 const over=await page.evaluate(()=>({sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth}));if(over.sw>over.cw+1)throw Error('MOBILE-OVERFLOW-ADMIN-PANEL-266 '+JSON.stringify(over));
 await page.locator('#apBody').scrollIntoViewIfNeeded();await shot('04-admin-panel-360-dark');
 await page.setViewportSize({width:1280,height:900});await page.evaluate(()=>setAppearance('light'));
 // Excel carries the curves
 await page.selectOption('#apDash','team');
 const apFile=page.waitForEvent('download');await page.locator('#workspaceExport').click();await (await apFile).saveAs('test-results/v266/admin-panel.xlsx');
 const apZip=await Zip.loadAsync(fs.readFileSync('test-results/v266/admin-panel.xlsx'));
 assert.match(await apZip.file('xl/workbook.xml').async('string'),/R&amp;I user curves/);
}
// v2.6.7: AVR model with its own tables, AVR/Battery serials, serial-number permission, QMS Data Excel in the backup format with a Recorded from/to filter
fs.mkdirSync('test-results/v267',{recursive:true});
{const shot=async(name,full)=>{await page.screenshot({path:'test-results/v267/'+name+'.png',fullPage:!!full});};
 const JSZip=require('jszip');
{const ctrl=(await sequential(()=>h.db.query("select id,hardware from wlf_private.hw_catalogue where system='MOT' and model='MOT 7.5 kW' and deleted_at is null order by hardware,id"))).rows;
  const avr=(await sequential(()=>h.db.query("select id from wlf_private.hw_catalogue where system='AVR' and model='AVR 30 KVA' and deleted_at is null order by sort"))).rows;
  const seen=new Set(),items=[];for(const r of ctrl){if(!seen.has(r.hardware)){seen.add(r.hardware);items.push({catalogueId:r.id,section:'control'});}}
  for(const r of avr)items.push({catalogueId:r.id,section:'avr'});
  await tab('qms');
  await page.evaluate(([items,id])=>rpc('saveQmsLift',[T(),{id,liftId:'V7-1',project:'AVR Tower',address:'Uttara, Dhaka',deliveryDate:'2026-11-24',motorType:'Gearless',liftType:'Passenger',system:'MOT',controllerModel:'MOT 7.5 kW',
   serials:{motor:'M-267',encoder:'E-267',drive:'D-267',ups:'U-267',cartop:'C-267',cop:'P-267',copDisplay:'CD-267',avr:'AV-700',battery:'BAT-1, BAT-2, BAT-3, BAT-4, BAT-5'},selection:null,items}]),[items,crypto.randomUUID()]);}
 await tab('qms');await page.locator('#qmsTabData').click();await page.locator('#qmsSearch [name=liftId]').fill('V7-1');await page.locator('#qmsSearch [type=submit]').click();await page.locator('#qmsExcel').waitFor({timeout:30000});
 const t6=page.locator('.hw-out').filter({hasText:'6 · AVR'});assert.equal(await t6.locator('tbody tr').count(),15,'AVR table lists all 15 items of AVR 30 KVA');
 assert.ok((await t6.innerText()).includes('Full AVR'));
 const order=await page.locator('.hw-out .overview-eyebrow').allInnerTexts();assert.ok(order.findIndex(x=>/^6 · AVR/.test(x))>=0&&order.findIndex(x=>/^6 · AVR/.test(x))+1===order.findIndex(x=>/^7 · OTHER/.test(x)),'AVR table comes right before Other components: '+order);
 const t4=await page.locator('.hw-out').filter({hasText:'4 · SERIAL NUMBERS'}).innerText();for(const x of ['AVR','AV-700','Battery','BAT-1, BAT-2, BAT-3, BAT-4, BAT-5'])assert.ok(t4.includes(x),'serial table has '+x);
 await t6.scrollIntoViewIfNeeded();await shot('01-qms-output-avr-desktop');
 {const [d]=await Promise.all([page.waitForEvent('download',{timeout:60000}),page.locator('#qmsExcel').click()]);await d.saveAs('test-results/v267/QMS-L-101.xlsx');
  const xml=await (await JSZip.loadAsync(fs.readFileSync('test-results/v267/QMS-L-101.xlsx'))).file('xl/worksheets/sheet1.xml').async('string');
  for(const t of ['6 · AVR','7 · Other components','AV-700','BAT-1, BAT-2','Cooling Fan'])assert.ok(xml.includes(t),'report has '+t);}
 await page.locator('#qmsBack').click();
 assert.equal(await page.locator('#qmsSearch [name=from]').count(),1);assert.equal(await page.locator('#qmsSearch [name=to]').count(),1);
 await page.locator('#qmsSearch [name=from]').fill('2999-01-01');await page.locator('#qmsSearch [type=submit]').click();await page.locator('#qmsDataStatus').filter({hasText:/^0 record|No lift record/}).waitFor();
 await page.locator('#qmsAllExcel').click();await page.locator('#qmsDataStatus').filter({hasText:'No lift record matches'}).waitFor();
 await page.locator('#qmsSearch [name=from]').fill('2000-01-01');await page.locator('#qmsSearch [name=to]').fill('2999-12-31');await page.locator('#qmsSearch [type=submit]').click();await page.locator('#qmsResults table').waitFor();
 {const [d]=await Promise.all([page.waitForEvent('download',{timeout:60000}),page.locator('#qmsAllExcel').click()]);await d.saveAs('test-results/v267/QMS-data.xlsx');
  const zip=await JSZip.loadAsync(fs.readFileSync('test-results/v267/QMS-data.xlsx'));const wb=await zip.file('xl/workbook.xml').async('string');
  for(const n of ['QMS Lifts','QMS Components','QMS Serial numbers','QMS Output Tables'])assert.ok(wb.includes(n),n);
  const serials=await zip.file('xl/worksheets/sheet3.xml').async('string');for(const t of ['AV-700','BAT-1, BAT-2','D-267'])assert.ok(serials.includes(t),'serials sheet has '+t);
  const lifts=await zip.file('xl/worksheets/sheet1.xml').async('string');for(const t of ['AVR model','AVR 30 KVA','Gearless'])assert.ok(lifts.includes(t),'lifts sheet has '+t);}
 await shot('02-qms-data-filter-desktop');
 await sequential(()=>h.db.query("update public.wlf_profiles set permissions=array(select distinct unnest(permissions||array['qms:components','qms:edit'])) where id=$1",[IDS.admin]));
 await logout();await login('admin');await tab('qms');await page.locator('#qmsTabData').click();
 await page.locator('#qmsSearch [name=liftId]').fill('V7-1');await page.locator('#qmsSearch [type=submit]').click();await page.locator('#qmsExcel').waitFor({timeout:30000});
 const hiddenText=await page.locator('#tab-qms').innerText();
 assert.ok(!hiddenText.includes('D-267')&&!hiddenText.includes('AV-700')&&!hiddenText.includes('BAT-1'),'no serial number reaches this account');
 assert.ok(hiddenText.includes('Serial numbers are not shown to your account'));
 await shot('03-qms-serials-hidden-desktop');
 {const [d]=await Promise.all([page.waitForEvent('download',{timeout:60000}),page.locator('#qmsExcel').click()]);await d.saveAs('test-results/v267/QMS-L-101-hidden.xlsx');
  const xml=await (await JSZip.loadAsync(fs.readFileSync('test-results/v267/QMS-L-101-hidden.xlsx'))).file('xl/worksheets/sheet1.xml').async('string');
  assert.ok(!xml.includes('D-267')&&!xml.includes('AV-700'),'the lift Excel has no serial numbers');assert.ok(xml.includes('Serial numbers are not shown to this account'));}
 await page.locator('#qmsBack').click();await page.locator('#qmsSearch [type=submit]').click();await page.locator('#qmsResults table').waitFor();
 {const [d]=await Promise.all([page.waitForEvent('download',{timeout:60000}),page.locator('#qmsAllExcel').click()]);await d.saveAs('test-results/v267/QMS-data-hidden.xlsx');
  const zip=await JSZip.loadAsync(fs.readFileSync('test-results/v267/QMS-data-hidden.xlsx'));const wb=await zip.file('xl/workbook.xml').async('string');
  assert.ok(!wb.includes('QMS Serial numbers'),'no serial sheet for this account');
  for(const name of Object.keys(zip.files).filter(n=>/worksheets\/sheet\d+\.xml/.test(n)))assert.ok(!(await zip.file(name).async('string')).includes('D-267'),'no serial value in '+name);}
 await page.locator('#qmsSearch [name=liftId]').fill('V7-1');await page.locator('#qmsSearch [type=submit]').click();await page.locator('#qmsEdit').waitFor({timeout:30000});
 await page.locator('#qmsEdit').click();await page.locator('#qmsLiftForm').waitFor();
 assert.equal(await page.locator('#qmsLiftForm [name=sl-drive]').inputValue(),'','stored serials are not sent to the form');
 assert.equal(await page.locator('#qmsLiftForm [name=sl-drive]').getAttribute('required'),null);
 await page.locator('#qmsLiftForm [name=project]').fill('AVR Tower 3');
 {const b=page.locator('#qmsLiftForm [type=submit]');await b.scrollIntoViewIfNeeded();await b.focus();await page.waitForTimeout(200);await b.click();}
 await page.locator('.hw-out h3').filter({hasText:'AVR Tower 3'}).waitFor();
 const kept=await h.db.query("select serials from wlf_private.qms_lifts where lift_id='V7-1'");assert.equal(kept.rows[0].serials.drive,'D-267');assert.equal(kept.rows[0].serials.avr,'AV-700');
 await sequential(()=>h.db.query("update public.wlf_profiles set permissions=array_append(permissions,'qms:serials') where id=$1",[IDS.admin]));
 await logout();await login('admin');await tab('qms');await page.locator('#qmsTabData').click();
 await page.locator('#qmsSearch [name=liftId]').fill('V7-1');await page.locator('#qmsSearch [type=submit]').click();await page.locator('#qmsExcel').waitFor({timeout:30000});
 assert.ok((await page.locator('#tab-qms').innerText()).includes('D-267'),'with the permission the serial numbers show');
 await logout();await login('sa');await tab('qms');await page.locator('#qmsTabInput').click();await page.locator('#qmsLiftForm').waitFor();
 {const vp=page.viewportSize();await page.setViewportSize({width:360,height:800});await page.evaluate(()=>setAppearance('dark'));await page.waitForTimeout(300);
  await page.locator('#qmsLiftForm [name=sl-battery]').scrollIntoViewIfNeeded();await shot('04-qms-input-battery-360-dark');
  const over=await page.evaluate(()=>({sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth}));if(over.sw>over.cw+1)throw Error('MOBILE-OVERFLOW '+JSON.stringify(over));
  await page.evaluate(()=>setAppearance('light'));await page.setViewportSize(vp);}
 await page.locator('#qmsLiftForm [name=avrModel]').scrollIntoViewIfNeeded();await shot('05-qms-input-desktop');
}
// v2.6.8: Catalogue import replaces whole model tables (Excel and CSV), QR label on the QMS lift page, QR link opens the lift
fs.mkdirSync('test-results/v268',{recursive:true});
{const shot=async(name,full)=>{await page.screenshot({path:'test-results/v268/'+name+'.png',fullPage:!!full});};
 const JSZip268=require('jszip');const {execFileSync}=require('child_process');
 const head=['Control system','Model','Group','Hardware','Spec','Item code','Item name','Brand','Supplier','Price'];
 const {buildWorkbook}=await import('../supabase/functions/_shared/wlf-excel.mjs');
 const xlsx=Buffer.from(await buildWorkbook(JSZip268,[{name:'Catalogue',headers:head,rows:[['AVR','AVR 80 KVA','Full AVR','Full AVR','80 KVA','X80-1','AVR 80','SAKO','SAKO',5000],['AVR','AVR 80 KVA','Cooling Fan','Cooling Fan','3 Pcs','X80-2','Fan','','',120],['AVR','AVR 80 KVA','Fuse','Fuse','','X80-3','Fuse','','','']]}]));
 fs.writeFileSync('test-results/v268/avr80.xlsx',xlsx);
 fs.writeFileSync('test-results/v268/avr777.csv','﻿'+head.join(',')+'\nAVR,AVR 777 KVA,Full AVR,Full AVR,120 KVA,X777-1,AVR 120,SAKO,SAKO,9000\nAVR,AVR 777 KVA,Fuse,Fuse,,X777-2,Fuse,,,\n');
 await tab('catalogue');await page.locator('.hw-layout').waitFor();
 const rowsOf=async model=>(await sequential(()=>h.db.query("select item_code from wlf_private.hw_catalogue where system='AVR' and model=$1 and deleted_at is null order by sort",[model]))).rows.map(r=>r.item_code);
 const before15=(await rowsOf('AVR 15 KVA')).length;assert.equal(before15,15);
 assert.equal(await page.locator('#hwImport').innerText(),'Import model data');
 await page.locator('#hwImport').click();await page.locator('#hwImportForm').waitFor();
 await page.locator('#hwImportForm [name=file]').setInputFiles('test-results/v268/avr80.xlsx');await page.locator('#hwImportCheck').click();
 await page.locator('#hwImportPreview table').waitFor({timeout:30000});
 {const t=await page.locator('#hwImportPreview').innerText();assert.match(t,/AVR 80 KVA/);assert.match(t,/Old rows replaced/);}
 assert.equal((await rowsOf('AVR 80 KVA')).length,10,'checking the file changed nothing');
 await shot('01-import-preview-desktop');
 await page.locator('#hwImportGo').click();await page.locator('#hwImportForm').waitFor({state:'hidden',timeout:30000});
 assert.deepEqual(await rowsOf('AVR 80 KVA'),['X80-1','X80-2','X80-3'],'the Excel file replaced the whole AVR 80 KVA table');
 assert.equal((await rowsOf('AVR 15 KVA')).length,before15,'other models are untouched');
 await page.locator('#hwImport').click();await page.locator('#hwImportForm').waitFor();
 await page.locator('#hwImportForm [name=file]').setInputFiles('test-results/v268/avr777.csv');await page.locator('#hwImportCheck').click();
 await page.locator('#hwImportPreview table').waitFor({timeout:30000});assert.match(await page.locator('#hwImportPreview').innerText(),/New model is added/);
 await page.locator('#hwImportGo').click();await page.locator('#hwImportForm').waitFor({state:'hidden',timeout:30000});
 assert.deepEqual(await rowsOf('AVR 777 KVA'),['X777-1','X777-2']);
 await page.locator('#hwImport').click();await page.locator('#hwImportForm').waitFor();
 fs.writeFileSync('test-results/v268/bad.csv','Model,Hardware\nAVR 5,x\n');await page.locator('#hwImportForm [name=file]').setInputFiles('test-results/v268/bad.csv');await page.locator('#hwImportCheck').click();
 await page.locator('#hwDialogStatus').filter({hasText:'Control system'}).waitFor();assert.equal(await page.locator('#hwImportGo').isHidden(),true);
 await page.locator('#hwCancel').click();
 // QR label
 await tab('qms');await page.locator('#qmsTabData').click();await page.locator('#qmsSearch [name=liftId]').fill('V7-1');await page.locator('#qmsSearch [type=submit]').click();await page.locator('#hwQr').waitFor({timeout:30000});
 {const t=await page.locator('#hwQr').innerText();for(const x of ['Lift ID','V7-1','AVR Tower 3','MOT 7.5 kW','COP display','LOP display','Transom display','AVR'])assert.ok(t.includes(x),'QR panel shows '+x);
  assert.ok(!t.includes('D-267')&&!t.includes('AV-700')&&!t.includes('BAT-1'),'no serial number in the QR panel');}
 await page.locator('#hwQr').scrollIntoViewIfNeeded();await shot('02-qr-panel-desktop');
 const decoder='import sys,cv2\nimg=cv2.imread(sys.argv[1])\nimg=cv2.copyMakeBorder(img,40,40,40,40,cv2.BORDER_CONSTANT,value=(255,255,255))\nr,_,_=cv2.QRCodeDetectorAruco().detectAndDecode(img)\nprint(r)\n';
 fs.writeFileSync('test-results/v268/decode.py',decoder);
 let canDecode=true;try{execFileSync('python3',['-c','import cv2'],{stdio:'ignore'});}catch(e){canDecode=false;console.log('NOTE: python cv2 not installed, QR decoding check skipped');}
 {const [d]=await Promise.all([page.waitForEvent('download',{timeout:60000}),page.locator('#qrSave').click()]);assert.match(d.suggestedFilename(),/^QR-V7-1\.png$/);await d.saveAs('test-results/v268/QR-V7-1.png');
  assert.equal(fs.readFileSync('test-results/v268/QR-V7-1.png').subarray(1,4).toString(),'PNG');
  if(canDecode){const txt=execFileSync('python3',['test-results/v268/decode.py','test-results/v268/QR-V7-1.png']).toString();
   assert.match(txt,/^WLF QMS\nLift ID: V7-1\nProject: AVR Tower 3\nController: MOT 7\.5 kW\n/);assert.match(txt,/AVR: 30 KVA/);assert.match(txt,/#qms=V7-1/);assert.ok(!/D-267|AV-700|BAT-1/.test(txt),'scanned text has no serial number');}}
 if(canDecode){await page.locator('#hwQrImg svg').screenshot({path:'test-results/v268/qr-screen.png'});
  assert.match(execFileSync('python3',['test-results/v268/decode.py','test-results/v268/qr-screen.png']).toString(),/Lift ID: V7-1/,'the QR on the screen can be scanned');}
 {const [pop]=await Promise.all([page.waitForEvent('popup',{timeout:15000}),page.locator('#qrPrint').click()]);await pop.waitForLoadState();assert.ok((await pop.content()).includes('V7-1'));await pop.close();}
 {const vp=page.viewportSize();await page.setViewportSize({width:390,height:844});await page.evaluate(()=>setAppearance('dark'));await page.waitForTimeout(300);
  await page.locator('#hwQr').scrollIntoViewIfNeeded();await shot('03-qr-panel-390-dark');
  const over=await page.evaluate(()=>({sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth}));if(over.sw>over.cw+1)throw Error('MOBILE-OVERFLOW '+JSON.stringify(over));
  await page.evaluate(()=>setAppearance('light'));await page.setViewportSize(vp);}
 // the QR link opens the lift after sign-in
 await page.evaluate(()=>{history.replaceState(null,'',location.pathname+'#qms=V7-1');});await page.reload();
 await page.locator('#hwQr').waitFor({timeout:60000});assert.match(await page.locator('#tab-qms h3').first().innerText(),/V7-1/);
 assert.equal(await page.evaluate(()=>location.hash),'','the link is removed from the address bar after opening');
 await shot('04-qr-link-opened-desktop');
}
await tab('troubleshooting');await page.locator('[data-section="NICE3000+"]').click();await page.locator('#tbErrors').click();await page.locator('#tbSearch').fill('Err38');await page.waitForFunction(()=>navigator.serviceWorker.controller!==null);await context.setOffline(true);await page.reload();await page.locator('#app').waitFor({state:'visible'});await tab('troubleshooting');await page.locator('[data-section="NICE3000+"]').click();await page.locator('#tbErrors').click();await page.locator('#tbSearch').fill('Err38');await page.locator('#tbDetail').filter({hasText:'Err38'}).waitFor();assert.equal(await page.evaluate(()=>navigator.onLine),false);
assert.deepEqual(errors,[]);console.log('PASS WLF browser including My Profile, workspace KPIs, QMS, Project Address, Damage Demand submission, option grants, Dispatch receive, requester status, filtered chart and Excel, PWA update, activity, project, Excel and PPTX exports, plus documents CRUD/custom fields/read-only access, user search/rejected deletion, date-filtered Drive-simulated backup-only/clear/download/restore, R&I isolation; PGlite-backed Supabase SDK: imported components, local formulas/search, support form/roles/CSV, realtime callback draft preservation, mobile dark layout, actual PWA service-worker offline reload under GitHub project subpath. Auth and realtime delivery mocked; no hosted Supabase/device test.');
})().catch(async err=>{console.error(err);console.error('Page errors',errors);if(page&&!page.isClosed()){console.error((await page.locator('body').innerText()).slice(-3500));await page.screenshot({path:'test-results/failure.png',fullPage:true}).catch(()=>{});}console.error('\n==== FAILURE SUMMARY (copy everything below this line) ====\n'+String(err&&err.message||err).slice(0,9000));process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();if(server)server.close();if(h)await h.close();});
