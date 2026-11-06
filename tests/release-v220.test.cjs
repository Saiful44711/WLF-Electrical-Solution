const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {transformSync}=require('esbuild');
const Zip=require('jszip');
const {makeDB,IDS}=require('./pg-harness.cjs');

const upgrade=fs.readFileSync('supabase/UPDATE_V220.sql','utf8');
const v220Teams=['commissioning','aftersales','production','maintenance','qc','installation'];
const valuesFor=fields=>Object.fromEntries(fields.map(f=>[f.id,
  f.autoFill==='identity'?'Forged name':f.type==='date'?'2026-11-05':f.type==='number'?'1290':
    f.type==='multi'?f.options.slice(0,2):f.type==='checkbox'?(f.options?.length?f.options.slice(0,2):true):
    f.options?.[0]||'Workbook field value']));
const mutation=()=>({id:crypto.randomUUID(),operation:crypto.randomUUID(),revision:0});
async function dbTest(t,pre){
  const db=await makeDB(); t.after(()=>db.close()); if(pre)await pre(db); await db.db.exec(upgrade);return db;
}
async function addPermission(h,user,key) {
  await h.db.query('update public.wlf_profiles set permissions=array_append(permissions,$2) where id=$1',[IDS[user],key]);
}
async function makeSupport(h,category='commissioning',who='sa',overrides={}) {
  const form=(await h.rpc(who,'getSupportWorkspace',[{category}])).forms[category];
  const payload={category,formRevision:form.revision,mutationId:crypto.randomUUID(),values:{...valuesFor(form.fields),...overrides}};
  return {payload,result:await h.rpc(who,'createSupportRequest',[payload]),form};
}
async function makeActivity(h,category='wb-team',status='Completed',who='sa') {
  const form=(await h.rpc(who,'getRiCategories')).find(c=>c.id===category);
  const values=valuesFor(form.schema.fields); if(status)values.status=status;
  const payload={...mutation(),category,formRevision:form.revision,values};
  return {payload,result:await h.rpc(who,'saveRiEntry',[payload]),form};
}
function projectData(lead=IDS.sa) {
  return {name:'Controller validation',lead,collaborators:[],start:'2026-11-05',end:'2026-11-08',
    status:'In Progress',impact:'Product Development',brief:'Validate <controller> configuration.',financial:false,documentation:true,
    tasks:[{id:crypto.randomUUID(),name:'Verify wiring',owner:lead,start:'2026-11-05',end:'2026-11-05',status:'Done',progress:100}]};
}
const count=async(h,table)=>(await h.db.query('select count(*)::int n from '+table)).rows[0].n;
const backup=(h,action,payload,who='sa')=>h.db.query('select public.wlf_excel_admin($1,$2,$3) result',[action,IDS[who],payload]).then(x=>x.rows[0].result);

test('Workbook migration adds 6 teams, 6 activity forms and 78 component rows, retaining live edits and deletions',async t=>{
  const h=await dbTest(t,async h=>{
    await h.db.query("update public.wlf_components set values=jsonb_set(values,'{5}','\"CUSTOM MODEL\"'),revision=2 where id=3");
    await h.db.query('delete from public.wlf_components where id=4');
    await h.db.query("update public.wlf_forms set schema=jsonb_set(schema,'{title}','\"Local Commissioning Form\"'),revision=2 where category='commissioning'");
  });
  const forms=(await h.rpc('sa','getSupportWorkspace')).forms;
  assert.deepEqual(new Set(Object.keys(forms)),new Set(v220Teams));
  assert.equal(forms.commissioning.title,'Local Commissioning Form');
  assert.equal(forms.aftersales.fields.find(f=>f.id==='identity').label,'Name & ID');
  const cats=await h.rpc('sa','getRiCategories');
  assert.equal(cats.filter(c=>c.section==='reports').length,3);
  assert.equal(cats.length,6);
  const components=(await h.rpc('sa','adminGetComponents'));
  assert.equal(components.headers.length,24);
  assert.equal(components.records.length,77);
  assert.equal(components.records.find(r=>r.sheetRow===3).values[5],'CUSTOM MODEL');
  assert.equal(components.records.some(r=>r.sheetRow===4),false);
  assert.equal(components.records.filter(r=>r.values[23]===55).length,1);
  assert.ok(components.records.every(r=>r.values.length===24));
  await h.db.query("update public.wlf_ri_categories set name='My new Team Activity',revision=2 where id='wb-team'");
  await h.db.exec(upgrade);
  assert.equal((await h.rpc('sa','getRiCategories')).find(c=>c.id==='wb-team').name,'My new Team Activity');
  assert.deepEqual((await h.rpc('sa','adminGetComponents')).records,components.records);
});

test('Six support forms submit against the database with unique references, login identity and safe retry',async t=>{
  const h=await dbTest(t);
  const refs=new Set();
  for(const category of v220Teams){
    const {payload,result}=await makeSupport(h,category);
    assert.match(result.ticket.reference,/^TCS\d+-1290-\d{8}$/);
    assert.equal(result.ticket.values.identity,'sa');
    assert.equal(result.ticket.category,category);
    assert.equal((await h.rpc('sa','createSupportRequest',[payload])).id,result.id);
    refs.add(result.ticket.reference);
  }
  assert.equal(refs.size,6);
  assert.equal(await count(h,'public.wlf_requests'),6);
  assert.equal((await h.rpc('sa','getSupportSummary')).open.installation,1);
  await assert.rejects(h.rpc('user','createSupportRequest',[{category:'installation',mutationId:crypto.randomUUID(),values:{}}]),/Permission denied/);
  await addPermission(h,'user','support:installation:request');
  const {result}=await makeSupport(h,'installation','user');
  assert.equal(result.ticket.values.identity,'user');
  assert.equal((await h.rpc('user','getSupportWorkspace',[{category:'installation'}])).tickets.length,1);
});

test('Support fields have no protected type and both filters handle legacy and multi-select data',async t=>{
  const h=await dbTest(t,async h=>{
    const form=(await h.rpc('sa','getSupportWorkspace')).forms.commissioning;
    const old=await h.rpc('sa','createSupportRequest',[{category:'commissioning',mutationId:crypto.randomUUID(),values:valuesFor(form.fields)}]);
    assert.ok(old.id);
  });
  const commissioning=(await h.rpc('sa','getSupportWorkspace',[{category:'commissioning'}]));
  const legacy=commissioning.tickets[0];
  assert.match(legacy.reference,/^TCS-/);
  assert.ok(legacy.controller.length && legacy.sub.length>1);
  const form=commissioning.forms.commissioning;
  const newFields=[{id:'controller',label:'Control System Brand',type:'radio',required:true,options:['MOT','NICE3000+']},
    {id:'sub',label:'Sub Category',type:'checkbox',required:true,options:['Component','Wiring']},
    {id:'ok',label:'Acknowledged',type:'checkbox',required:true,options:[]}];
  await h.rpc('sa','saveSupportSchema',[{category:'commissioning',revision:form.revision,schema:{fields:newFields}}]);
  const {result,payload}=await makeSupport(h,'commissioning','sa',{controller:'MOT',sub:['Component','Wiring'],ok:true});
  assert.match(result.ticket.reference,/NO-LIFT/);
  assert.deepEqual(result.ticket.sub,['Component','Wiring']);
  const hits=await h.rpc('sa','getSupportWorkspace',[{category:'commissioning',controller:'mot',sub:'Wiring'}]);
  assert.deepEqual(hits.tickets.map(t=>t.id),[result.id]);
  assert.ok(hits.facets.sub.includes('Wiring'));
  const oldHits=await h.rpc('sa','getSupportWorkspace',[{category:'commissioning',controller:legacy.controller[0],sub:legacy.sub[1]}]);
  assert.ok(oldHits.tickets.some(t=>t.id===legacy.id));
  const detail=await h.rpc('sa','getSupportRequest',[legacy.id]);
  assert.equal(detail.values.field_1369800003,'Workbook field value');
  const update=await h.rpc('sa','editSupportRequest',[{id:result.id,revision:result.revision,mutationId:crypto.randomUUID(),
    values:{...payload.values,controller:'NICE3000+'}}]);
  assert.equal(update.ticket.reference,result.ticket.reference);
  assert.equal(update.ticket.values.ok,true);
  const next=(await h.rpc('sa','getSupportWorkspace')).forms.commissioning;
  await h.rpc('sa','saveSupportSchema',[{category:'commissioning',revision:next.revision,schema:{fields:[]}}]);
  assert.equal((await makeSupport(h,'commissioning')).result.ticket.formSchema.fields.length,0);
});

test('R&I access is individually granted across roles and entry status persists from the selected form value',async t=>{
  const h=await dbTest(t);
  for(const user of ['admin','rni','user']) await assert.rejects(h.rpc(user,'getRiCategories'),/access required/);
  await addPermission(h,'user','ri:activity');await addPermission(h,'rni','ri:activity');
  const {result,payload}=await makeActivity(h,'wb-team','Hold','user');
  assert.equal(result.status,'Hold');
  assert.equal(result.values.identity,'user');
  assert.equal((await h.rpc('user','saveRiEntry',[payload])).revision,1);
  const edit={...payload,operation:crypto.randomUUID(),revision:1,values:{...payload.values,status:'Ongoing'}};
  await assert.rejects(h.rpc('rni','saveRiEntry',[edit]),/Only the creator/);
  assert.equal((await h.rpc('user','saveRiEntry',[edit])).status,'Ongoing');
  assert.equal((await h.rpc('rni','getRiEntries',[{category:'wb-team',status:'Ongoing'}])).entries[0].status,'Ongoing');
  await assert.rejects(h.rpc('user','deleteRiEntry',[{...edit,revision:2}]),/Super Admin only/);
  await h.rpc('sa','deleteRiEntry',[{...edit,revision:2,operation:crypto.randomUUID()}]);
  assert.equal((await h.rpc('user','getRiEntries',[{category:'wb-team'}])).entries.length,0);
  assert.equal((await makeActivity(h,'report-aftersales','')).result.status,'Submitted');
  assert.equal((await makeActivity(h,'report-service','Solved')).result.status,'Solved');
  assert.deepEqual((await h.rpc('rni','getRiDashboard')).activity,{Solved:1,Submitted:1});
  assert.equal((await h.rpc('admin','getRiDashboard')).activity,null);
  await assert.rejects(h.as('user',()=>h.db.query('select * from public.wlf_ri_entries')),/permission denied/);
});

test('Archiving a category keeps historic records and its field schema can be restored',async t=>{
  const h=await dbTest(t);
  const entry=await makeActivity(h);
  const c=entry.form;
  const archived=await h.rpc('sa','setRiCategoryActive',[{category:c.id,revision:c.revision,active:false}]);
  await addPermission(h,'user','ri:activity');
  assert.equal((await h.rpc('user','getRiCategories')).some(x=>x.id===c.id),false);
  assert.equal((await h.rpc('sa','getRiEntries',[{category:c.id}])).entries[0].id,entry.result.id);
  await h.rpc('sa','setRiCategoryActive',[{category:c.id,revision:archived.revision,active:true}]);
  const custom='custom-'+crypto.randomUUID();
  const saved=await h.rpc('sa','saveRiCategory',[{category:custom,revision:0,name:'Custom report',section:'reports',fields:[
    {id:'approval',label:'Verified',type:'checkbox',required:false,options:[]}]}]);
  assert.equal(saved.schema.fields[0].type,'checkbox');
  assert.equal((await h.rpc('user','getRiCategories')).some(x=>x.id===custom),true);
});

test('Lead and collaborators can view but cannot mutate someone else’s project or tasks',async t=>{
  const h=await dbTest(t);
  await addPermission(h,'rni','ri:projects');await addPermission(h,'user','ri:projects');
  const data=projectData(IDS.rni);data.collaborators=[IDS.sa];
  const input={...mutation(),data};
  const r=await h.rpc('user','saveRiProject',[input]);
  assert.equal(r.owner,IDS.user);
  assert.equal(r.data.tasks[0].progress,100);
  const read=await h.rpc('rni','getRiProjects',[{lead:IDS.rni}]);
  assert.equal(read.projects[0].id,r.id);
  assert.ok(read.people.every(p=>p.id!==IDS.admin));
  const noTasks={...data,tasks:[]};
  const edit={id:r.id,revision:r.revision,operation:crypto.randomUUID(),data:noTasks};
  await assert.rejects(h.rpc('rni','saveRiProject',[edit]),/Only the project creator/);
  await assert.rejects(h.rpc('rni','deleteRiProject',[edit]),/Only the project creator/);
  await assert.rejects(h.rpc('admin','getRiProjects'),/access required/);
  const saved=await h.rpc('user','saveRiProject',[edit]);
  assert.deepEqual(saved.data.tasks,[]);
  assert.equal((await h.rpc('user','saveRiProject',[edit])).revision,2);
  await assert.rejects(h.rpc('user','saveRiProject',[{...edit,operation:crypto.randomUUID()}]),/CONFLICT/);
  await h.rpc('sa','deleteRiProject',[{...edit,revision:2,operation:crypto.randomUUID()}]);
  assert.equal((await h.rpc('user','getRiProjects')).projects.length,0);
});

test('Excel backup includes date boundaries and blocks a stale or unverified clear; only eligible archived rows are restored',async t=>{
  const h=await dbTest(t);
  const x=await makeActivity(h),changed=await makeActivity(h),keep=await makeActivity(h,'wb-team','Ongoing');
  const outside=await makeActivity(h);
  for(const r of [x,changed,keep])await h.db.query("update public.wlf_ri_entries set created_at='2026-11-05 18:00:00+00' where id=$1",[r.result.id]);
  await h.db.query("update public.wlf_ri_entries set created_at='2026-11-05 17:59:59+00' where id=$1",[outside.result.id]);
  const id=crypto.randomUUID(),nonce=crypto.randomUUID(),options={id,nonce,kind:'activity',from:'2026-11-06',to:'2026-11-06',withClear:true};
  const snapshot=await backup(h,'prepare',options);
  assert.equal(snapshot.total,3);
  assert.deepEqual(new Set(snapshot.records.map(r=>r.id)),new Set([x,changed,keep].map(r=>r.result.id)));
  await assert.rejects(backup(h,'clear',{id}),/Verified workbook/);
  await assert.rejects(backup(h,'history',{},'rni'),/Super Admin only/);
  await assert.rejects(h.as('user',()=>backup(h,'history',{})),/permission denied/);
  await h.rpc('sa','saveRiEntry',[{...changed.payload,revision:1,operation:crypto.randomUUID(),values:{...changed.payload.values,status:'Hold'}}]);
  const files={id,nonce,workbookId:'drive_xlsx',workbookHash:'1'.repeat(64),recoveryId:'drive_json',recoveryHash:'2'.repeat(64)};
  await backup(h,'verify',files);
  assert.equal((await backup(h,'clear',{id})).cleared,1);
  assert.equal((await backup(h,'clear',{id})).cleared,1);
  assert.equal(await count(h,'public.wlf_ri_entries'),3);
  await assert.rejects(h.rpc('sa','saveRiEntry',[x.payload]),/no longer available/);
  const archive={id,kind:'activity',project:'test',format:'WLF-EXCEL-RECOVERY-2.2',records:snapshot.records};
  assert.equal((await backup(h,'restore',{id,project:'test',archive})).restored,1);
  assert.equal(await count(h,'public.wlf_ri_entries'),4);
  assert.equal((await backup(h,'read',{id})).total,3);
});

test('Support Excel and legacy JSON recover all new teams with unchanged histories and IDs',async t=>{
  const h=await dbTest(t);
  const {result}=await makeSupport(h,'production');
  const received=await h.rpc('rni','transitionSupportRequest',[{id:result.id,revision:result.revision,
    action:'receive',mutationId:crypto.randomUUID()}]);
  const solved=await h.rpc('rni','transitionSupportRequest',[{id:result.id,revision:received.revision,
    action:'solve',comment:'Test resolution',mutationId:crypto.randomUUID()}]);
  const id=crypto.randomUUID(),nonce=crypto.randomUUID();
  const snapshot=await backup(h,'prepare',{id,nonce,kind:'support',withClear:true});
  assert.equal(snapshot.categories.length,6);
  assert.equal(snapshot.records[0].request.reference,solved.ticket.reference);
  assert.equal(snapshot.records[0].history.length,3);
  await backup(h,'verify',{id,nonce,workbookId:'drive_xlsx',workbookHash:'1'.repeat(64),recoveryId:'drive_json',recoveryHash:'2'.repeat(64)});
  assert.equal((await backup(h,'clear',{id})).cleared,1);
  assert.equal(await count(h,'public.wlf_requests'),0);
  const archive={id,kind:'support',project:'test',format:'WLF-EXCEL-RECOVERY-2.2',records:snapshot.records};
  assert.equal((await backup(h,'restore',{id,project:'test',archive})).restored,1);
  const restored=await h.rpc('sa','getSupportRequest',[result.id]);
  assert.equal(restored.reference,solved.ticket.reference);
  assert.equal(restored.history.length,3);
  assert.equal(restored.solution,'Test resolution');
});

async function mockDrive() {
  const uploads=new Map();
  let corrupt=false;
  async function drive(path,init={}) {
    if(path.includes('alt=media')){
      const id=path.split('/').at(-1).split('?')[0],file=uploads.get(id);
      if(!file)throw Error('Drive file missing');
      return new Response(corrupt?new Uint8Array([1,2,3]):file.bytes);
    }
    const boundary=init.headers['Content-Type'].split('boundary=')[1];
    const raw=Buffer.from(await new Response(init.body).arrayBuffer());
    const start=raw.indexOf('\r\n\r\n')+4,mid=raw.indexOf('\r\n--'+boundary,start);
    const metadata=JSON.parse(raw.subarray(start,mid).toString());
    const dataStart=raw.indexOf('\r\n\r\n',mid)+4, dataEnd=raw.lastIndexOf('\r\n--'+boundary+'--');
    const id='drive_excel_'+uploads.size;
    uploads.set(id,{metadata,bytes:raw.subarray(dataStart,dataEnd)});
    return Response.json({id});
  }
  return {uploads,drive,corrupt:value=>{corrupt=value;}};
}

test('Real Excel exporter and Edge handler verify binary Drive files before clearing and allow retry/download',async t=>{
  const h=await dbTest(t),mock=await mockDrive();
  await makeActivity(h);await makeActivity(h,'wb-sales','Ongoing');
  const {excelMaintenance}=await import('../supabase/functions/_shared/wlf-excel-edge.mjs');
  const source=fs.readFileSync('supabase/functions/wlf-maintenance/index.ts','utf8').replace(/^import [^;]+;/gm,'');
  const env={SUPABASE_URL:'https://test.supabase.co',SUPABASE_SECRET_KEYS:'{"default":"test-only"}',
    WLF_GOOGLE_CLIENT_ID:'id',WLF_GOOGLE_CLIENT_SECRET:'secret',WLF_GOOGLE_REFRESH_TOKEN:'refresh'};
  const sqlCalls=[];
  let handler;
  const createClient=()=>({
    auth:{getUser:async token=>({data:{user:{id:token==='admin'?IDS.admin:IDS.sa}}})},
    from:()=>({select:()=>({eq:(_,id)=>({single:async()=>({data:{id,role:id===IDS.sa?'Super Admin':'Admin',status:'Approved'}})})})}),
    rpc:async(name,p)=>{try{assert.equal(name,'wlf_excel_admin');sqlCalls.push(p.action);
      return {data:await backup(h,p.action,p.payload)};}catch(error){return {error};}}
  });
  vm.runInNewContext(transformSync(source,{loader:'ts',target:'es2022'}).code,{
    Response,Request,crypto,TextEncoder,URL,URLSearchParams,console,createClient,excelMaintenance,JSZip:Zip,
    Deno:{serve:fn=>{handler=fn;},env:{get:key=>env[key]}},
    fetch:async(url,init)=>{
      if(url.includes('oauth2.googleapis.com'))return Response.json({access_token:'test'});
      if(url.includes('q='))return Response.json({files:[{id:'test-folder'}]});
      return mock.drive(new URL(url).pathname+new URL(url).search,init);
    }
  });
  const invoke=(action,payload,token='sa')=>handler(new Request('https://test.example',{
    method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify({action,payload})
  }));
  const id=crypto.randomUUID(),p={id,kind:'activity',withClear:true};
  assert.equal((await invoke('excelBackup',p,'admin')).status,403);
  mock.corrupt(true);
  assert.equal((await invoke('excelBackup',p)).status,400);
  assert.equal(sqlCalls.includes('verify'),false);
  mock.corrupt(false);
  const resp=await invoke('excelBackup',p);
  assert.equal(resp.status,200);
  const workbook=await resp.json(),bytes=Buffer.from(workbook.bytes,'base64');
  const zip=await Zip.loadAsync(bytes);
  assert.ok(zip.file('xl/tables/table6.xml'));
  assert.match(await zip.file('xl/workbook.xml').async('string'),/Supplier &amp; SCM Cooperation/);
  assert.match(await zip.file('xl/worksheets/sheet1.xml').async('string'),/Completed/);
  assert.equal((await (await invoke('excelBackup',p)).json()).bytes,workbook.bytes);
  assert.equal((await (await invoke('excelDownload',{id})).json()).bytes,workbook.bytes);
  mock.corrupt(true);
  assert.equal((await invoke('excelClear',{id,confirmed:true})).status,400);
  assert.equal(sqlCalls.includes('clear'),false);
  mock.corrupt(false);
  assert.equal((await (await invoke('excelClear',{id,confirmed:true})).json()).cleared,1);
  assert.equal(await count(h,'public.wlf_ri_entries'),1);
  assert.equal((await (await invoke('excelRestore',{id,confirmed:true})).json()).restored,1);
});

test('Workbook stores formula-looking values as text and uses distinct formatted sheet and table names',async()=>{
  const {buildWorkbook}=await import('../supabase/functions/_shared/wlf-excel.mjs');
  const bytes=await buildWorkbook(Zip,[{name:'a/b',headers:['Name','NAME'],rows:[['=1+1',false]]},
    {name:'a?b',headers:['No records'],rows:[]}]);
  const zip=await Zip.loadAsync(bytes);
  const workbook=await zip.file('xl/workbook.xml').async('string'),sheet=await zip.file('xl/worksheets/sheet1.xml').async('string');
  assert.match(workbook,/name="a b \(2\)"/);
  assert.match(sheet,/<t xml:space="preserve">=1\+1<\/t>/);
  assert.doesNotMatch(sheet,/<f>/);
  assert.match(await zip.file('xl/tables/table1.xml').async('string'),/NAME \(2\)/);
});
