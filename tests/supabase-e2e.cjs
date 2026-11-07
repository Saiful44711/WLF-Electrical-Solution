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
const {excelMaintenance}=await import('../supabase/functions/_shared/wlf-excel-edge.mjs');await h.db.query("update public.wlf_profiles set status='Rejected'where id=$1",[IDS.other]);fs.mkdirSync('test-results',{recursive:true});server=http.createServer((req,res)=>{const url=new URL(req.url,'http://localhost');let rel=url.pathname.replace(/^\/wlf\//,'');if(url.pathname==='/wlf/')rel='index.html';if(!url.pathname.startsWith('/wlf/')||rel.includes('..')){res.writeHead(404);res.end();return;}if(rel==='config.js'){res.setHeader('Content-Type','application/javascript');res.end(testConfig);return;}const f=path.join('dist',rel);if(!fs.existsSync(f)){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',mime[path.extname(f)]||'text/plain');if(rel==='sw.js'&&shellVersion==='v210'){
 const sw=fs.readFileSync(f,'utf8').replace('wlf-pwa-2.2.0-ri-support','wlf-pwa-2.1.0-storage-documents');res.end(sw);return;}
 res.end(rel==='supabase.js'?fs.readFileSync(f,'utf8')+mockRealtime:fs.readFileSync(f));});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined,args:['--no-sandbox']});context=await browser.newContext({viewport:{width:1280,height:900}});page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
await context.route('https://wlf-test.supabase.co/**',async route=>{let request=route.request(),url=new URL(request.url()),body=request.postDataJSON(),data,status=200;try{
if(url.pathname==='/auth/v1/token'){let name=body.email?.split('@')[0]||'sa',id=IDS[name];if(!id||body.password!==(passwords[name]||'test-password-123')){status=400;data={msg:'Invalid login credentials'};}else data={access_token:jwt(id),refresh_token:'refresh-'+name,expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,token_type:'bearer',user:{id,email:name+'@example.test',aud:'authenticated',role:'authenticated',app_metadata:{provider:'email'},user_metadata:{name}}};}
else if(url.pathname==='/auth/v1/user'){const id=JSON.parse(Buffer.from(request.headers().authorization.split('.')[1],'base64url').toString()).sub;const name=Object.keys(IDS).find(k=>IDS[k]===id);passwords[name]=body.password;data={id,email:name+'@example.test',aud:'authenticated',role:'authenticated',user_metadata:{name}};}else if(url.pathname==='/auth/v1/logout')data={};else if(url.pathname==='/rest/v1/rpc/wlf_rpc'){rpcCount++;let id=JSON.parse(Buffer.from(request.headers().authorization.split('.')[1],'base64url').toString()).sub,name=Object.keys(IDS).find(k=>IDS[k]===id);data=await sequential(()=>h.rpc(name,body.action,body.args));}
else if(url.pathname==='/functions/v1/wlf-maintenance'){
 const id=JSON.parse(Buffer.from(request.headers().authorization.split('.')[1],'base64url').toString()).sub;
 if(id!==IDS.sa)throw Error('Super Admin only');const p=body.payload||{};
 const sql=async(action,payload=p)=>(await h.db.query('select public.wlf_backup_admin($1,$2,$3)result',[action,id,payload])).rows[0].result;
 const excelSql=async(action,payload={})=>sequential(async()=>(await h.db.query('select public.wlf_excel_admin($1,$2,$3) result',[action,id,payload])).rows[0].result);
 if(body.action==='status')data={...await sequential(()=>sql('status')),driveConfigured:true};
 else if(body.action==='excelHistory')data=await excelSql('history');
 else if(body.action.startsWith('excel'))data=await excelMaintenance({action:body.action,payload:p,sql:excelSql,
  drive,folder:async()=>'test-folder',project:'wlf-test',Zip});
 else if(body.action==='backupPart'){let nonce=crypto.randomUUID(),part=await sql('prepare',{...p,project:'wlf-test',nonce});if(!part.alreadyVerified){archiveParts.set(p.id+':'+p.batch,part);await sql('verify',{...p,nonce,fileId:'drive_sample_'+p.batch,sha256:'a'.repeat(64)});}data={verified:true};}
 else if(body.action==='downloadPart')data=archiveParts.get(p.id+':'+p.batch);
 else if(body.action==='restore')data=await sql('restore',{archive:p.archive,project:'wlf-test'});
 else if(body.action==='deleteRejectedUser'){let target=await sql('reserveDeleteUser',{email:p.email});await h.db.query('delete from auth.users where id=$1',[target.id]);await sql('releaseDeleteUser',{id:target.id});data={deleted:true};}
 else data=await sql(({clearPart:'clear'})[body.action]||body.action);
 }
else throw Error('Unexpected mocked route '+url.pathname);
}catch(e){status=400;data={message:e.message,code:'P0001'};}await route.fulfill({status,contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:JSON.stringify(data)});});
await page.goto(origin+'/wlf/');await page.locator('#loginEmail').waitFor();
await page.locator('#tabRegister').click();await page.getByLabel('FULL NAME-ID').waitFor();
await page.locator('#tabLogin').click();

async function login(name){await page.locator('#loginEmail').fill(name+'@example.test');await page.locator('#loginPassword').fill('test-password-123');await page.locator('#loginBtn').click();await page.locator('#app').waitFor({state:'visible'});await page.waitForFunction(()=>SESSION&&!SESSION.bootstrapPending);await page.evaluate(()=>openTab('account'));await page.locator('#tab-account [onclick=\"changePw()\"]').waitFor({state:'visible'});for(const [old,next]of [['test-password-123','changed-password-123'],['changed-password-123','test-password-123']]){await page.locator('#pwOld').fill(old);await page.locator('#pwNew').fill(next);await page.locator('#pwNew2').fill(next);await page.locator('#tab-account button').click();await page.waitForFunction(()=>document.getElementById('pwNew').value==='');} }
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
   if(node.type==='checkbox'||node.type==='radio'){
    if(!checked.has(node.name)){node.checked=true;checked.add(node.name);}
   }else if(node.tagName==='SELECT'){
    const option=[...node.options].find(o=>o.value);
    node.value=value??option?.value??'';
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
 await page.locator('[data-support-category="'+team+'"]').click();
 await page.locator('#newSupportRequest').click();
 const controls = await page.locator('#supportRequestForm [name]').evaluateAll(nodes => nodes.map(node => ({
  id: node.name,
  label: node.closest('.field').querySelector('label').textContent.replace(/\s+\*$/, ''),
  required: node.required,
  readOnly: Boolean(node.readOnly),
  tag: node.tagName,
  inputMode: node.getAttribute('inputmode'),
  value: node.value,
  options: node.tagName === 'SELECT' ? Array.from(node.options).slice(1).map(option => option.value) : [],
 })));
 assert.equal(controls.length, expectedForm.fields.length, team);
 for (const [index, field] of expectedForm.fields.entries()) {
  const control = controls[index];
  assert.equal(control.id, field.id, team+' field order');
  assert.equal(control.label, field.label, team+' field label');
  assert.equal(control.required, field.required, team+' required field');
  assert.equal(control.readOnly, Boolean(field.autoFill), team+' autofill');
  assert.deepEqual(control.options, field.options, team+' dropdown choices');
  if (field.type === 'select') assert.equal(control.tag, 'SELECT');
  if (field.type === 'number') assert.equal(control.inputMode, 'decimal');
  if (field.autoFill === 'identity') assert.equal(control.value, 'sa');
  if (field.autoFill === 'today') assert.match(control.value, /^\d{4}-\d{2}-\d{2}$/);
 }
 await page.screenshot({path:'test-results/support-fields-'+team+'.png',fullPage:true});
 await page.locator('#closeSupportForm').click();
 await page.locator('#supportHome').click();
}
// Existing troubleshooting editors remain available to Super Admin.
await tab('troubleshooting');await page.locator('[data-section="GENERAL"]').waitFor({state:'visible'});await page.locator('[data-section="GENERAL"]').click();assert(await page.locator('#tbAdd').isVisible());await page.locator('#tbAdd').click();assert(await page.locator('.tb-field-label').first().isVisible());await page.evaluate(()=>document.getElementById('tbEditor').close());await page.locator('#tbBack').click();await page.locator('[data-section="MOT"]').click();assert(await page.locator('#tbAddOption').isVisible());await page.locator('#tbErrors').click();assert(await page.locator('#tbAdd').isVisible());await page.locator('#tbSearch').fill('Er07');await page.locator('#tbEdit').waitFor();await page.locator('#tbEdit').click();assert(await page.locator('[data-add-step]').first().isVisible());await page.evaluate(()=>document.getElementById('tbEditor').close());
// Actual document CRUD against upgraded PostgreSQL and role-restricted UI.
await tab('documents');await page.locator('#wlfAddCategory').click();await page.locator('#wlfCategoryName').fill('Training');await page.locator('#wlfCategoryFields').fill('Revision\nModel');await page.locator('#wlfCategoryForm button:not([type=button])').click();await page.locator('[data-doc-category]').filter({hasText:'Training'}).click();await page.locator('#wlfAddDocument').click();await page.locator('#wlfDocumentName').fill('Commissioning Checklist');await page.locator('#wlfDocumentUrl').fill('https://drive.google.com/file/d/synthetic_test/view');await page.locator('[data-doc-field="0"]').fill('R1');await page.locator('[data-doc-field="1"]').fill('Demo model');await page.locator('#wlfDocumentForm button:not([type=button])').click();await page.locator('#wlfDocList a').filter({hasText:'Commissioning Checklist'}).waitFor();assert.equal(await page.locator('#wlfDocList a').getAttribute('target'),'_blank');await page.locator('[data-edit-doc]').click();await page.locator('#wlfDocumentName').fill('Updated Checklist');await page.locator('#wlfDocumentForm button:not([type=button])').click();await page.locator('#wlfDocList a').filter({hasText:'Updated Checklist'}).waitFor();await page.setViewportSize({width:390,height:844});await page.evaluate(()=>closeSidebar());await page.waitForFunction(()=>document.getElementById('sidebar').getBoundingClientRect().right<=1);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:'test-results/v210-documents-mobile.png',fullPage:true});await page.setViewportSize({width:1280,height:900});
// Search and rejected deletion keep the existing approval/access editor.
await tab('users');await page.locator('#userAccessSearch').fill('user@example.test');assert.equal(await page.locator('.access-user:visible').count(),1);await page.locator('#userAccessSearch').fill('other@example.test');await page.locator('.access-user:visible summary').click();page.once('dialog',d=>d.accept());await page.locator('.access-delete').click();await page.waitForFunction(()=>!document.querySelector('[data-access-user="other@example.test"]'));
// One solved support fixture tests date filters, backup-only, clear, download and restore UI.
let vals={};for(const f of require('../data/workbook-v220-audit.json').support.commissioning.fields)vals[f.id]=f.type==='multi'?[f.options[0]]:f.type==='date'?'2026-09-12':f.type==='number'?'8888':f.options.length?f.options[0]:'Browser backup test';let seed=await h.rpc('user','createSupportRequest',[{category:'commissioning',values:vals,mutationId:'browser-backup-create-0001'}]);seed=await h.rpc('rni','transitionSupportRequest',[{id:seed.id,revision:seed.revision,action:'receive',mutationId:'browser-backup-receive-001'}]);await h.rpc('rni','transitionSupportRequest',[{id:seed.id,revision:seed.revision,action:'solve',comment:'Backup test solved',mutationId:'browser-backup-solve-0001'}]);
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
await page.getByRole('button',{name:'Reports',exact:true}).click();
assert.equal(await page.locator('[data-ri-action=category]').count(),3);
await page.getByRole('button',{name:'Electrical & Electronic Components Service Report',exact:true}).click();
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
await page.locator('#wlfRiDialog [name=lead]').fill('user');
await page.locator('#wlfRiDialog button[type=submit]').click();
await page.locator('[data-project]').waitFor();
await checkRiMobileFit('#tab-ri-projects');
await page.locator('[data-ri-action=add-task]').click();
await checkRiMobileFit('#wlfRiDialog');
await page.locator('#wlfRiDialog [name=name]').fill('Record controller tests');
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
await tab('dashboard');await page.locator('#tbDashboard .kpi').first().waitFor();assert.equal(await page.locator('#tbDashboard .kpi').count(),3);assert.equal((await page.locator('#tbDashboard').innerText()).includes('General subcategories'),false);const desktop=await page.evaluate(()=>{let logo=document.querySelector('.header-company-logo').getBoundingClientRect(),title=document.getElementById('pageTitle').getBoundingClientRect(),menu=document.querySelector('.appearance-menu').getBoundingClientRect(),top=document.querySelector('.topbar').getBoundingClientRect();return{left:logo.x<title.x,right:menu.x>title.right,edge:top.right-menu.right};});assert.ok(desktop.left&&desktop.right&&desktop.edge<40);await page.screenshot({path:'test-results/header-desktop-dashboard.png',fullPage:true});assert.equal(await page.locator('#nav [data-tab=users]').isVisible(),true);await tab('users');await page.locator('[data-access-user="user@example.test"]').waitFor({state:'attached'});
assert.equal(await page.locator('#nav [data-tab=ri-projects] + [data-tab=damage-demand]').isVisible(),true);
await tab('damage-demand');
await page.locator('#tab-damage-demand').getByText('No demands match these filters.').waitFor();
assert.equal(await page.locator('[data-damage-pane]').count(),2);
await tab('users');
for (const [name,keys] of [['admin',['damage:demand','damage:receive']],['rni',['damage:dashboard']]]) {
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
await page.getByRole('button',{name:'Reports',exact:true}).click();
await page.getByRole('button',{name:'Electrical & Electronic Components Service Report',exact:true}).click();
await page.locator('#riEntryList tbody tr').filter({hasText:'Solved'}).waitFor();
assert.equal(await page.locator('[data-ri-action=edit-entry],[data-ri-action=delete-entry]').count(),0);
assert.equal(await page.locator('#nav [data-tab=dashboard]').isVisible(),false);assert.equal(await page.locator('#nav [data-tab=components]').isVisible(),false);assert.equal(await page.locator('#nav [data-tab=storage]').isVisible(),false);await tab('documents');await page.locator('[data-doc-category]').filter({hasText:'Training'}).click();await page.locator('#wlfDocList a').filter({hasText:'Updated Checklist'}).waitFor();assert.equal(await page.locator('#wlfAddDocument,#wlfAddCategory,[data-edit-doc],[data-delete-doc]').count(),0);assert.equal(await page.locator('#nav [data-tab=users]').isVisible(),false);await page.evaluate(()=>openTab('users'));assert.equal(await page.locator('#tab-users').isVisible(),false);
// Real imported components available; browser-local calculation makes no calculator RPC.
await tab('selection');await page.locator('#sel-capacity').selectOption('450');await page.locator('#sel-speed').selectOption('1');await page.locator('#sel-usageType').selectOption('MR');await page.locator('#sel-roping').selectOption('2:1');await page.locator('#searchBtn').click();if(await page.locator('#matchesList .chip').count())await page.locator('#matchesList .chip').first().click();await page.locator('#reportWrap').waitFor({state:'visible'});
await page.evaluate(()=>{APK_SETTINGS.theme='dark';applyTheme();});await page.screenshot({path:'test-results/supabase-components-dark.png',fullPage:true});
await tab('calculation');await page.evaluate(()=>openCalcPane('power'));for(const [id,v]of Object.entries({'pw-motor':'3.9','pw-k2':'.95','pw-k3':'.95','pw-brake':'324','pw-tube':'4','pw-panel':'0','pw-spot':'4','pw-fan':'2','pw-others':'500'}))await page.locator('#'+id).fill(v);await page.locator('#pane-power button').click();await page.locator('#pwResult').filter({hasText:'8.668'}).waitFor();
const result=await page.evaluate(()=>LiftCore.calculate('calculatePowerAndAVR',{motorPowerKW:3.9,k2:.95,k3:.95,brakePowerBothW:324,tubeLightQty:4,panelLightQty:0,spotLightQty:4,crossFlowFanQty:2,othersFixedW:500}));assert.equal(result.suggestGeneratorKVA,8.668);
await tab('troubleshooting');await page.locator('[data-section="NICE3000+"]').click();await page.locator('#tbErrors').click();const searchBefore=rpcCount;await page.locator('#tbSearch').fill('Err38');await page.locator('#tbDetail').filter({hasText:'Err38'}).waitFor();assert.ok((await page.locator('#tbDetail').innerText()).includes('102'));await page.locator('#tbSubSearch').fill('102');await page.locator('#tbDetail').filter({hasText:'102'}).waitFor();assert.equal(rpcCount,searchBefore);
await category();await page.locator('#newSupportRequest').click();await page.locator('#supportRequestForm').waitFor();assert.equal(await page.locator('#supportRequestForm [name=identity]').inputValue(),'user');
await fillDynamic('#supportRequestForm',{lift:'991234'});await page.locator('#submitSupportRequest').click();await page.locator('#supportDetail h3').filter({hasText:/TCS\d+-991234-\d{8}/}).waitFor();const id=await page.locator('#supportDetail').getAttribute('data-record-id');assert.equal(await page.locator('#editSupportForm,#deleteSupportTicket,#receiveSupport').count(),0);assert.equal(await page.locator('#supportBadge').innerText(),'1');await logout();
await login('admin');assert.equal(await page.locator('#nav [data-tab=components]').isVisible(),false);await category();assert.equal(await page.locator('#newSupportRequest').count(),0);await page.locator('#supportFilterQuery').fill('991234');await page.waitForTimeout(450);assert.equal(await page.locator('#supportFilterQuery').evaluate(n=>document.activeElement===n),true);await page.locator(`[data-ticket="${id}"]`).click();await page.locator('#supportDetail h3').waitFor();assert.equal(await page.locator('#receiveSupport').count(),0);const download=page.waitForEvent('download');await page.locator('#downloadSupportCSV').click();await(await download).saveAs('test-results/support-report.csv');assert.ok(fs.readFileSync('test-results/support-report.csv','utf8').match(/TCS\d+-991234-\d{8}/));await logout();
await login('rni');
await tab('dashboard');
await page.locator('#rniPerformanceTable').waitFor();
assert.equal((await page.locator('#rniPerformanceTable').innerText()).includes('rni2@example.test'),false);
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
assert.deepEqual(await dialog.locator('input').evaluateAll(nodes=>nodes.map(node=>node.name)),
 ['confirmedBy','itemName','itemCode','itemSpec','quantity']);
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
await page.locator('#damageFilters [name=lift]').fill('991234');
await page.locator('#damageFilters [name=project]').fill('Browser verification');
await page.getByRole('button',{name:'Apply filters',exact:true}).click();
await page.locator('#damageStatus').filter({hasNotText:'Loading'}).waitFor({state:'attached'});
await page.locator('[data-damage-view]').click();
await dialog.getByRole('heading',{name:'Solution statement'}).waitFor();
await dialog.getByText('Replace the damaged main contactor.',{exact:true}).waitFor();
await dialog.getByText('Submitted support form details',{exact:true}).click();
assert.ok(await dialog.getByText('991234',{exact:true}).isVisible());
await page.locator('#damageReceive').click();
await page.locator('#damageDetailStatus').filter({hasText:'Demand received.'}).waitFor();
assert.equal(await dialog.locator('.support-status').innerText(),'Received');
await dialog.getByRole('button',{name:'Close',exact:true}).click();
await page.locator('#tab-damage-demand').getByText('No demands match these filters.').waitFor();
await page.locator('#damageFilters [name=status]').selectOption('Received');
await page.getByRole('button',{name:'Apply filters',exact:true}).click();
await page.locator('[data-damage-view]').waitFor();
await logout();

await login('user');
await category();
await page.locator(`[data-ticket="${id}"]`).click();
await page.locator('#supportDamageStatus').filter({hasText:'Received'}).waitFor();
assert.match(await page.locator('#supportDetail').innerText(),/Duration \(Min\) 22.5/);

await page.setViewportSize({width:390,height:844});await page.evaluate(()=>closeSidebar());await page.waitForFunction(()=>document.getElementById('sidebar').getBoundingClientRect().right<=1);const mobile=await page.evaluate(()=>{let logo=document.querySelector('.header-company-logo').getBoundingClientRect(),title=document.getElementById('pageTitle').getBoundingClientRect(),menu=document.querySelector('.appearance-menu').getBoundingClientRect();return{left:logo.x<title.x,right:menu.x>title.right,edge:innerWidth-menu.right};});assert.ok(mobile.left&&mobile.right&&mobile.edge<25);await page.locator('.appearance-menu summary').click();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.locator('.appearance-menu summary').click();await page.screenshot({path:'test-results/supabase-mobile-support.png',fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
// Actual service worker caches project-subpath shell; downloaded references work offline.
await tab('troubleshooting');await page.locator('[data-section="NICE3000+"]').click();await page.locator('#tbErrors').click();await page.locator('#tbSearch').fill('Err38');await page.waitForFunction(()=>navigator.serviceWorker.controller!==null);await context.setOffline(true);await page.reload();await page.locator('#app').waitFor({state:'visible'});await tab('troubleshooting');await page.locator('[data-section="NICE3000+"]').click();await page.locator('#tbErrors').click();await page.locator('#tbSearch').fill('Err38');await page.locator('#tbDetail').filter({hasText:'Err38'}).waitFor();assert.equal(await page.evaluate(()=>navigator.onLine),false);
assert.deepEqual(errors,[]);console.log('PASS WLF browser including Damage Demand submission, option grants, Dispatch receive, requester status, filtered chart and Excel, PWA update, activity, project, Excel and PPTX exports, plus documents CRUD/custom fields/read-only access, user search/rejected deletion, date-filtered Drive-simulated backup-only/clear/download/restore, R&I isolation; PGlite-backed Supabase SDK: imported components, local formulas/search, support form/roles/CSV, realtime callback draft preservation, mobile dark layout, actual PWA service-worker offline reload under GitHub project subpath. Auth and realtime delivery mocked; no hosted Supabase/device test.');
})().catch(async err=>{console.error(err);console.error('Page errors',errors);if(page&&!page.isClosed()){console.error((await page.locator('body').innerText()).slice(-3500));await page.screenshot({path:'test-results/failure.png',fullPage:true});}process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();if(server)server.close();if(h)await h.close();});
