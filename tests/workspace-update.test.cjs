const test = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {makeDB, IDS} = require('./pg-harness.cjs');

const addressTeams = ['commissioning','aftersales','installation'];
const updates = ['UPDATE_V220','UPDATE_SUPPORT_FORMS_20261107','UPDATE_DAMAGE_DEMAND_20261107'];
const migration = readFileSync('supabase/UPDATE_WORKSPACE_20261107.sql','utf8');

async function prepare(t) {
  const h = await makeDB();
  t.after(() => h.close());
  for (const file of updates) await h.db.exec(readFileSync('supabase/'+file+'.sql','utf8'));
  return h;
}

async function install(h) {
  const results = await h.db.exec(migration);
  assert.deepEqual(results.at(-1).rows,[{
    project_address_ready:true, dashboard_and_profile_ready:true, qms_private:true, deletion_server_only:true
  }]);
}

async function submit(h, actor, address) {
  const category = 'commissioning';
  const form = (await h.rpc(actor,'getSupportWorkspace',[{category}])).forms[category];
  const values = Object.fromEntries(form.fields.filter(f => f.id!=='project_address').map(f => [
    f.id, f.type==='date' ? '2026-11-07' : f.type==='number' ? '90121' : f.options[0] || 'Workspace fixture'
  ]));
  if (address) values.project_address = address;
  return (await h.rpc(actor,'createSupportRequest',[{
    category,formRevision:form.revision,values,mutationId:crypto.randomUUID()
  }])).ticket;
}

async function grant(h, who, permissions) {
  const user = (await h.rpc('sa','listAppUsers')).users.find(row => row.email===who+'@example.test');
  await h.rpc('sa','saveAppUserAccess',[{...user,permissions:[...new Set([...user.permissions,...permissions])]}]);
}

test('Optional Project Address extends exactly three live forms and leaves submitted snapshots intact',async t => {
  const h = await prepare(t);
  const old = await submit(h,'user');
  const before = (await h.rpc('sa','getSupportWorkspace')).forms;
  await install(h);
  const after = (await h.rpc('sa','getSupportWorkspace')).forms;
  for (const [team,form] of Object.entries(after)) {
    const addresses = form.fields.filter(f => f.label==='Project Address');
    assert.equal(addresses.length,Number(addressTeams.includes(team)),team);
    if (addresses.length) {
      assert.equal(addresses[0].required,false);
      assert.equal(form.revision,before[team].revision+1);
      assert.deepEqual(form.fields.filter(f => f.id!=='project_address'),before[team].fields);
    } else assert.deepEqual(form,before[team]);
  }
  await install(h);
  assert.deepEqual((await h.rpc('sa','getSupportWorkspace')).forms,after);
  assert.deepEqual((await h.rpc('user','getSupportRequest',[old.id])).formSchema,old.formSchema);
  assert.equal((await submit(h,'user','Plot 14, Dhaka')).values.project_address,'Plot 14, Dhaka');
  assert.equal((await submit(h,'user')).values.project_address,'');
});

test('Workspace KPI data, previous-period comparison and exports use server-side scope',async t => {
  const h = await prepare(t);
  await install(h);
  await grant(h,'user',['workspace:dashboard','damage:demand']);
  await assert.rejects(h.rpc('admin','getWorkspaceDashboard'),/Dashboard access required/);
  await assert.rejects(h.rpc('admin','getWorkspaceReport'),/Dashboard access required/);
  await assert.rejects(h.rpc('pending','getMyWorkspaceProfile'),/SESSION_EXPIRED/);
  await assert.rejects(h.as('user',() => h.db.query("select wlf_private.workspace_insights('getWorkspaceDashboard','{}')")),/permission denied/);
  await assert.rejects(h.rpc('user','getWorkspaceReport',[{section:'damage'}]),/access to that section/);
  const mine = await submit(h,'user');
  const others = await submit(h,'other');
  await h.db.query("update public.wlf_requests set created_at='2026-11-07T10:00:00+06:00' where id in ($1,$2)",[mine.id,others.id]);
  await h.db.query("insert into public.wlf_usage(actor,action,at) values ($1,'Component Selection','2026-11-06T10:00:00+06:00'),($2,'Power Calculation','2026-11-07T09:00:00+06:00')",[IDS.user,IDS.other]);
  await h.db.query("update auth.users set last_sign_in_at='2026-11-07T12:00:00+06:00' where id=$1",[IDS.user]);
  const profile = await h.rpc('user','getMyWorkspaceProfile',[{member:IDS.other,section:'qms'}]);
  assert.equal(profile.profile.email,'user@example.test');
  assert.match(profile.profile.lastSignIn,/2026-11-07/);
  assert.equal(profile.recent.length,2);
  assert.ok(profile.recent.every(r => r.name==='user'));
  assert.ok(!profile.sections.some(s => s.section==='qms'));
  const scoped = await h.rpc('user','getWorkspaceDashboard',[{section:'support',from:'2026-11-07',to:'2026-11-07'}]);
  assert.equal(scoped.totals.activities,1);
  assert.match(scoped.recent[0].entry,new RegExp(mine.reference));
  assert.equal(scoped.previous.activities,0);
  const full = await h.rpc('sa','getWorkspaceReport',[{from:'2026-11-07',to:'2026-11-07'}]);
  assert.equal(full.totals.activities,3);
  assert.equal(full.previous.activities,1);
  assert.equal(full.totals.members,2);
  assert.equal(full.recent.length,3);
  assert.ok(full.recent.some(r => r.entry.includes(others.reference)));
  await assert.rejects(h.rpc('user','getWorkspaceDashboard',[{from:'2026-11-08',to:'2026-11-07'}]),/From date/);
});

test('QMS option gates shared project records, owner edits and retry receipts',async t => {
  const h = await prepare(t);
  await install(h);
  await grant(h,'user',['qms:components']);
  await grant(h,'rni',['qms:components']);
  const record = {
    id:crypto.randomUUID(),operation:crypto.randomUUID(),revision:0,project:'Bayside Tower',
    component:'Control panel',status:'Planned',quantity:'2',lift_id:'L-1',note:'Replacement stock'
  };
  await assert.rejects(h.rpc('other','getQmsComponents'),/QMS Component Tracking access required/);
  await assert.rejects(h.rpc('other','saveQmsComponent',[record]),/QMS Component Tracking access required/);
  await assert.rejects(h.rpc('user','saveQmsComponent',[{...record,quantity:'1.5'}]),/whole number/);
  const made = await h.rpc('user','saveQmsComponent',[record]);
  assert.deepEqual(await h.rpc('user','saveQmsComponent',[record]),made);
  const shared = (await h.rpc('rni','getQmsComponents',[{project:'bayside'}])).rows;
  assert.equal(shared.length,1);
  assert.equal(shared[0].canEdit,false);
  const change = {...record,operation:crypto.randomUUID(),revision:made.revision,status:'Verified'};
  await assert.rejects(h.rpc('rni','saveQmsComponent',[change]),/Only the creator or Super Admin/);
  assert.equal((await h.rpc('sa','saveQmsComponent',[change])).status,'Verified');
  await assert.rejects(h.rpc('user','saveQmsComponent',[{...change,operation:crypto.randomUUID()}]),/CONFLICT/);
  const data = await h.rpc('sa','getWorkspaceDashboard',[{section:'qms'}]);
  assert.equal(data.totals.completed,1);
  assert.equal(data.members[0].name,'user');
});

test('Super Admin deletes rejected Auth accounts while keeping linked work and releasing open assignments',async t => {
  const h = await prepare(t);
  await install(h);
  const ticket = await submit(h,'user');
  const received = (await h.rpc('rni','transitionSupportRequest',[{
    id:ticket.id,revision:ticket.revision,action:'receive',mutationId:crypto.randomUUID()
  }])).ticket;
  await h.db.query("update public.wlf_profiles set status='Rejected' where id=$1",[IDS.rni]);
  const reserve = (actor,email) => h.db.query(
    "select public.wlf_backup_admin('reserveDeleteUser',$1,$2) result",[actor,{email}]
  );
  await assert.rejects(reserve(IDS.admin,'rni@example.test'),/Super Admin only/);
  await assert.rejects(reserve(IDS.sa,'user@example.test'),/Only rejected/);
  await assert.rejects(h.as('sa',() => reserve(IDS.sa,'rni@example.test')),/permission denied/);
  assert.equal((await reserve(IDS.sa,'rni@example.test')).rows[0].result.id,IDS.rni);
  await assert.rejects(reserve(IDS.sa,'rni@example.test'),/deletion in progress/);
  await assert.rejects(h.db.query("update public.wlf_profiles set status='Approved' where id=$1",[IDS.rni]),/deletion in progress/);
  await h.db.query('delete from auth.users where id=$1',[IDS.rni]);
  const current = await h.rpc('sa','getSupportRequest',[ticket.id]);
  assert.equal(current.status,'Pending');
  assert.equal(current.assignedTo,'');
  assert.equal(current.revision,received.revision+1);
  assert.ok(current.history.some(event => event.action==='receive'));
  assert.ok(current.history.some(event => event.action==='assignee account closed'));
  assert.equal((await h.db.query("select count(*) n from public.wlf_history where actor=$1",[IDS.rni])).rows[0].n,1);
  const users = (await h.rpc('sa','listAppUsers')).users;
  assert.ok(users.every(u => u.email!=='rni@example.test' && !u.email.startsWith('deleted/')));
  await assert.rejects(h.rpc('rni','getSession'),/SESSION_EXPIRED/);
  const newId = crypto.randomUUID();
  await h.db.query('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)',[newId,'rni@example.test',{name:'New user'}]);
  const replacement = (await h.rpc('sa','listAppUsers')).users.find(u => u.email==='rni@example.test');
  assert.equal(replacement.status,'Pending');
  assert.equal(replacement.name,'New user');
});
