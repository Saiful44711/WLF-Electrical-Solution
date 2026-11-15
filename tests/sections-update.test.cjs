const test = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {makeDB, IDS} = require('./pg-harness.cjs');
const Access = require('../shared/access-core.js');
const Logic = require('../shared/logic.js');

const chain = ['UPDATE_V220','UPDATE_SUPPORT_FORMS_20261107','UPDATE_DAMAGE_DEMAND_20261107','UPDATE_WORKSPACE_20261107'];
const migration = readFileSync('supabase/UPDATE_SECTIONS_V230.sql','utf8');
const cleanup = readFileSync('supabase/CLEANUP_KEEP_SUPER_ADMIN_V230.sql','utf8');
const SA_EMAIL = 'liftrndelectrical@gmail.com';

async function prepare(t, before) {
  const h = await makeDB();
  t.after(() => h.close());
  for (const file of chain) await h.db.exec(readFileSync('supabase/'+file+'.sql','utf8'));
  await h.db.query('update public.wlf_profiles set email=$2 where id=$1',[IDS.sa, SA_EMAIL]);
  if (before) await before(h);
  const results = await h.db.exec(migration);
  return {h, ready: results.at(-1).rows[0]};
}
async function profile(h, who) {
  return (await h.db.query('select * from public.wlf_profiles where id=$1',[IDS[who]])).rows[0];
}
async function setProfile(h, who, fields) {
  const keys = Object.keys(fields);
  await h.db.query('alter table public.wlf_profiles disable trigger wlf_deletion_guard');
  await h.db.query('update public.wlf_profiles set '+keys.map((k,i)=>k+'=$'+(i+2)).join(',')+' where id=$1',
    [IDS[who], ...keys.map(k=>fields[k])]);
  await h.db.query('alter table public.wlf_profiles enable trigger wlf_deletion_guard');
}
function valuesFor(fields) {
  return Object.fromEntries(fields.map(f => [f.id,
    f.type === 'multi' ? f.options.slice(0,1) : f.type === 'date' ? '2026-11-15' :
    f.type === 'number' ? '1200' : f.type === 'checkbox' ? (f.options?.length ? [] : false) : f.options?.[0] || 'Fixture value']));
}
async function request(h, category, who, overrides = {}) {
  const form = (await h.rpc(who, 'getSupportWorkspace', [{category}])).forms[category];
  return (await h.rpc(who, 'createSupportRequest', [{category, formRevision: form.revision,
    values: {...valuesFor(form.fields), ...overrides}, mutationId: crypto.randomUUID()}])).ticket;
}

test('Migration is repeatable, removes Admin, adds Name/ID/Section and fills the Super Admin profile', async t => {
  const {h, ready} = await prepare(t);
  assert.deepEqual(ready, {profile_id_section_ready: true, admin_role_removed: true, support_forms_split: true,
    ri_forms_split: true, super_admin_profile_ready: true});
  const again = await h.db.exec(migration);
  assert.equal(again.at(-1).rows[0].super_admin_profile_ready, true);
  const sa = await profile(h, 'sa');
  assert.deepEqual([sa.email, sa.name, sa.employee_id, sa.section, sa.role, sa.status],
    [SA_EMAIL, 'Md. Saiful Islam', '44711', 'R&I Electrical', 'Super Admin', 'Approved']);
  const admin = await profile(h, 'admin');
  assert.equal(admin.role, 'User');
  assert.deepEqual(admin.permissions, []);
  await assert.rejects(h.db.query("update public.wlf_profiles set role='Admin' where id=$1",[IDS.user]), /check constraint/);
  await assert.rejects(h.db.query("update public.wlf_profiles set section='Marketing' where id=$1",[IDS.user]), /check constraint/);
  const listed = (await h.db.query('select wlf_private.sections() s')).rows[0].s;
  assert.deepEqual(listed, Access.sections);
  assert.deepEqual(Logic.sections, Access.sections);
  assert.equal(listed.length, 13);
  assert.ok(listed.includes('Factory Maintenance'));
});

test('Only Super Admin gets options automatically; R&I and section users need explicit options', async t => {
  const {h} = await prepare(t);
  await h.db.query("update public.wlf_profiles set permissions='{}' where id=$1",[IDS.rni]);
  const can = async (who, key) => h.as(who, async () => (await h.db.query('select wlf_private.can($1) ok',[key])).rows[0].ok);
  assert.equal(await can('sa', 'selection'), true);
  assert.equal(await can('rni', 'selection'), false);
  assert.equal(await can('rni', 'support:commissioning:request'), false);
  assert.equal(await can('user', 'selection'), true);
  await assert.rejects(h.rpc('rni', 'adminGetComponents'), /Super Admin only/);
  const session = await h.rpc('rni', 'getSession');
  assert.equal(session.canCalculate, false);
  assert.equal(session.build, '2.3.0');
  assert.equal(Access.read({status:'Approved', role:'R&I', permissions:[]}, 'selection'), false);
  assert.equal(Access.read({status:'Approved', role:'Super Admin', permissions:[]}, 'selection'), true);
  assert.equal(Access.canReport({status:'Approved', role:'User', permissions:['dashboard']}), false);
});

test('Sign-up stores Name, ID and Section; R&I sections become R&I users but stay Pending', async t => {
  const {h} = await prepare(t);
  const add = async (id, email, meta) => {
    await h.db.query('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)',[id, email, JSON.stringify(meta)]);
    return (await h.db.query('select * from public.wlf_profiles where id=$1',[id])).rows[0];
  };
  const a = await add(crypto.randomUUID(), 'New.RnI@Example.test',
    {name: ' Rahim Uddin ', employeeId: 'E-2045', section: 'R&I Mechanical', role: 'Super Admin', status: 'Approved'});
  assert.deepEqual([a.email, a.name, a.employee_id, a.section, a.role, a.status, a.permissions],
    ['new.rni@example.test', 'Rahim Uddin', 'E-2045', 'R&I Mechanical', 'R&I', 'Pending', []]);
  const b = await add(crypto.randomUUID(), 'odd@example.test', {name: 'Odd', employeeId: '<script>', section: 'Marketing'});
  assert.deepEqual([b.employee_id, b.section, b.role], [null, null, 'User']);
  const c = await add(crypto.randomUUID(), 'comm@example.test', {name: 'Karim', employeeId: '9001', section: 'Commissioning'});
  assert.deepEqual([c.section, c.role], ['Commissioning', 'User']);
  assert.throws(() => Logic.registration('Rahim', 'r@example.test', 'password-123', '', 'Sales'), /ID/);
  assert.throws(() => Logic.registration('Rahim', 'r@example.test', 'password-123', '77', 'Marketing'), /section/);
  assert.deepEqual(Logic.registration(' Rahim ', 'R@Example.test', 'password-123', ' 77 ', 'QM'),
    {name: 'Rahim', email: 'r@example.test', password: 'password-123', employeeId: '77', section: 'QM'});
});

test('Super Admin edits Name, ID, Section and type; the type follows the section', async t => {
  const {h} = await prepare(t);
  const row = email => h.rpc('sa', 'listAppUsers').then(d => d.users.find(u => u.email === email));
  const save = async (email, fields, who = 'sa') => {
    const u = await row(email);
    return h.rpc(who, 'saveAppUserAccess', [{email, accessRevision: u.accessRevision, name: u.name, empId: u.empId,
      section: u.section, status: u.status, superAdmin: u.role === 'Super Admin', permissions: u.permissions, ...fields}]);
  };
  let saved = await save('rni2@example.test', {name: 'Shafiq', empId: '5501', section: 'R&I Electrical', permissions: ['support:qc:request']});
  assert.deepEqual([saved.role, saved.section, saved.empId, saved.label], ['R&I', 'R&I Electrical', '5501', 'Shafiq (5501)']);
  saved = await save('rni2@example.test', {section: 'Commissioning'});
  assert.equal(saved.role, 'User');
  saved = await save('rni2@example.test', {section: 'Sales', superAdmin: true});
  assert.equal(saved.role, 'Super Admin');
  await assert.rejects(save('user@example.test', {empId: ''}), /valid ID/);
  await assert.rejects(save('user@example.test', {empId: '12', section: ''}), /section/);
  await assert.rejects(save('user@example.test', {empId: '12', section: 'Sales', permissions: ['nope']}), /Invalid permissions/);
  await assert.rejects(save(SA_EMAIL, {superAdmin: false}), /own Super Admin/);
  await setProfile(h, 'user', {employee_id: '12', section: 'Sales'});
  await assert.rejects(h.rpc('rni', 'saveAppUserAccess', [{email: 'user@example.test', accessRevision: 0}]), /Super Admin only/);
  const catalog = (await h.rpc('sa', 'listAppUsers')).catalog;
  const team = catalog.find(x => x.key === 'support:commissioning:request');
  assert.equal(team.label, 'Commissioning Team');
});

test('Support and R&I forms use locked Name and ID fields filled on the server', async t => {
  const {h} = await prepare(t);
  const forms = (await h.db.query('select category, schema from public.wlf_forms order by category')).rows;
  assert.equal(forms.length, 6);
  for (const f of forms) {
    const ids = f.schema.fields.map(x => x.id);
    assert.ok(!ids.includes('identity'), f.category);
    const at = ids.indexOf('login_name');
    assert.ok(at >= 0, f.category);
    assert.equal(ids[at + 1], 'login_id');
    assert.deepEqual(f.schema.fields.slice(at, at + 2).map(x => [x.label, x.autoFill, x.required]), [['Name','name',true],['ID','empid',true]]);
  }
  const ri = (await h.db.query('select id, schema from public.wlf_ri_categories')).rows;
  assert.ok(ri.length > 0);
  for (const c of ri) assert.ok(c.schema.fields.some(x => x.autoFill === 'name') && c.schema.fields.some(x => x.autoFill === 'empid'), c.id);

  await setProfile(h, 'user', {name: 'Liakot Biswas', employee_id: '3301', section: 'Commissioning'});
  const ticket = await request(h, 'commissioning', 'user', {login_name: 'Someone Else', login_id: '999'});
  const detail = await h.rpc('sa', 'getSupportRequest', [ticket.id]);
  const t1 = detail.ticket || detail;
  assert.equal(t1.values.login_name, 'Liakot Biswas');
  assert.equal(t1.values.login_id, '3301');
  assert.equal(t1.createdByLabel, 'Liakot Biswas (3301)');
  assert.equal(t1.history[0].actorLabel, 'Liakot Biswas (3301)');

  await setProfile(h, 'rni', {name: 'Saiful R&I', employee_id: '44712', section: 'R&I Electrical', permissions: []});
  await assert.rejects(h.rpc('rni', 'getRiCategories'), /R&I Team Activity access required/);
  await setProfile(h, 'rni', {permissions: ['ri:activity']});
  const cat = (await h.rpc('rni', 'getRiCategories')).find(c => c.id === 'wb-team');
  const entry = await h.rpc('rni', 'saveRiEntry', [{id: crypto.randomUUID(), operation: crypto.randomUUID(), revision: 0,
    category: 'wb-team', formRevision: cat.revision, values: {...valuesFor(cat.schema.fields), login_name: 'X', login_id: 'Y', status: 'Completed'}}]);
  assert.equal(entry.values.login_name, 'Saiful R&I');
  assert.equal(entry.values.login_id, '44712');
  assert.equal(entry.author_name, 'Saiful R&I (44712)');

  const fields = (await h.db.query("select wlf_private.form_fields($1::jsonb) f",
    [JSON.stringify([{id:'n1',label:'Name',type:'text',autoFill:'name'},{id:'n2',label:'ID',type:'date',autoFill:'empid'}])])).rows[0].f;
  assert.deepEqual(fields.map(f => f.autoFill), ['name', 'none']);
});

test('Tickets show Name (ID); SUPPORT USER lists the team section and filters by requester; forwarding needs team access', async t => {
  const {h} = await prepare(t);
  await setProfile(h, 'user', {name: 'Liakot Biswas', employee_id: '3301', section: 'Commissioning'});
  await setProfile(h, 'other', {name: 'Mitu', employee_id: '3302', section: 'Commissioning', permissions: ['support:commissioning:request']});
  await setProfile(h, 'admin', {name: 'Sales Person', employee_id: '1100', section: 'Sales'});
  await setProfile(h, 'rni', {name: 'Saiful R&I', employee_id: '44712', section: 'R&I Electrical', permissions: ['support:commissioning:request']});
  await setProfile(h, 'rni2', {name: 'Rafi', employee_id: '44713', section: 'R&I Mechanical', permissions: ['support:qc:request']});
  const mine = await request(h, 'commissioning', 'user');
  await request(h, 'commissioning', 'other');
  const ws = await h.rpc('sa', 'getSupportWorkspace', [{category: 'commissioning'}]);
  assert.equal(ws.teamSection, 'Commissioning');
  assert.deepEqual(ws.teamUsers.map(u => u.label), ['Liakot Biswas (3301)', 'Mitu (3302)']);
  assert.equal(ws.tickets.length, 2);
  const filtered = await h.rpc('sa', 'getSupportWorkspace', [{category: 'commissioning', requester: 'user@example.test'}]);
  assert.deepEqual(filtered.tickets.map(x => x.id), [mine.id]);
  assert.equal(filtered.tickets[0].createdByLabel, 'Liakot Biswas (3301)');
  const own = await h.rpc('user', 'getSupportWorkspace', [{category: 'commissioning'}]);
  assert.equal(own.teamUsers, undefined);
  assert.deepEqual(own.tickets.map(x => x.id), [mine.id]);

  const directory = (await h.rpc('rni', 'getSupportWorkspace', [{category: 'commissioning'}])).users;
  assert.deepEqual(directory.map(u => [u.label, u.teams]).sort(), [['Rafi (44713)', ['qc']], ['Saiful R&I (44712)', ['commissioning']]]);
  let ticket = (await h.rpc('rni', 'transitionSupportRequest', [{id: mine.id, revision: mine.revision, action: 'receive', mutationId: crypto.randomUUID()}])).ticket;
  assert.equal(ticket.assignedToLabel, 'Saiful R&I (44712)');
  await assert.rejects(h.rpc('rni', 'transitionSupportRequest', [{id: ticket.id, revision: ticket.revision, action: 'forward',
    to: 'rni2@example.test', comment: 'Please check', mutationId: crypto.randomUUID()}]), /access to this team/);
  await setProfile(h, 'rni2', {permissions: ['support:qc:request', 'support:commissioning:request']});
  ticket = (await h.rpc('rni', 'transitionSupportRequest', [{id: ticket.id, revision: ticket.revision, action: 'forward',
    to: 'rni2@example.test', comment: 'Please check', mutationId: crypto.randomUUID()}])).ticket;
  const last = ticket.history.find(ev => ev.action === 'forward');
  assert.deepEqual([last.actorLabel, last.toLabel], ['Saiful R&I (44712)', 'Rafi (44713)']);
  ticket = (await h.rpc('rni2', 'transitionSupportRequest', [{id: ticket.id, revision: ticket.revision, action: 'receive', mutationId: crypto.randomUUID()}])).ticket;
  ticket = (await h.rpc('rni2', 'transitionSupportRequest', [{id: ticket.id, revision: ticket.revision, action: 'solve',
    comment: 'Fixed', mutationId: crypto.randomUUID()}])).ticket;
  assert.equal(ticket.solvedByLabel, 'Rafi (44713)');
  assert.equal(Access.handler({status: 'Approved', role: 'R&I', teams: ['qc']}, 'commissioning'), false);
  assert.equal(Access.handler({status: 'Approved', role: 'R&I', teams: ['qc']}, 'qc'), true);
  const me = await h.rpc('user', 'getMyWorkspaceProfile', [{}]);
  assert.deepEqual([me.profile.empId, me.profile.section], ['3301', 'Commissioning']);
});

test('Cleanup keeps only the Super Admin and the reference data', async t => {
  const {h} = await prepare(t);
  await setProfile(h, 'user', {employee_id: '3301', section: 'Commissioning'});
  await request(h, 'commissioning', 'user');
  const before = (await h.db.query('select (select count(*) from public.wlf_components)::int c, (select count(*) from public.wlf_forms)::int f')).rows[0];
  const out = (await h.db.exec(cleanup)).at(-1).rows[0];
  assert.match(out.note, /Deleted login accounts: 6/);
  assert.equal(Number(out.profiles_left), 1);
  assert.equal(Number(out.support_requests_left), 0);
  const after = (await h.db.query('select (select count(*) from public.wlf_components)::int c, (select count(*) from public.wlf_forms)::int f')).rows[0];
  assert.deepEqual(after, before);
  const left = (await h.db.query('select email, role, status from public.wlf_profiles')).rows;
  assert.deepEqual(left, [{email: SA_EMAIL, role: 'Super Admin', status: 'Approved'}]);
  assert.equal((await h.db.query('select count(*)::int n from auth.users')).rows[0].n, 1);
  assert.equal((await h.rpc('sa', 'getSession')).email, SA_EMAIL);
});
