const test = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {makeDB, IDS} = require('./pg-harness.cjs');

const chain = ['UPDATE_V220','UPDATE_SUPPORT_FORMS_20261107','UPDATE_DAMAGE_DEMAND_20261107','UPDATE_WORKSPACE_20261107','UPDATE_SECTIONS_V230','UPDATE_V240','UPDATE_V250','UPDATE_V251','UPDATE_V252'];
const migration = readFileSync('supabase/UPDATE_V253.sql','utf8');

async function prepare(t, before) {
  const h = await makeDB();
  t.after(() => h.close());
  for (const file of chain) await h.db.exec(readFileSync('supabase/'+file+'.sql','utf8'));
  await h.db.query('alter table public.wlf_profiles disable trigger wlf_deletion_guard');
  for (const [who, emp, section] of [['sa','SA-1','R&I Electrical'],['rni','RN-3','R&I Electrical'],['rni2','RN-4','R&I Mechanical'],['user','US-5','Commissioning'],['admin','AD-2','Production']])
    await h.db.query('update public.wlf_profiles set employee_id=$2, section=$3 where id=$1', [IDS[who], emp, section]);
  await h.db.query('alter table public.wlf_profiles enable trigger wlf_deletion_guard');
  if (before) await before(h);
  const results = await h.db.exec(migration);
  return {h, ready: results.at(-1).rows[0]};
}
const grant = (h, who, ...keys) => h.db.query('update public.wlf_profiles set permissions=array_cat(permissions,$2) where id=$1', [IDS[who], keys]);
const fillFields = (fields, extra = {}) => ({...Object.fromEntries(fields.filter(f => !f.autoFill && !f.dependsOn && f.type !== 'checkbox').map(f => [f.id,
  f.type === 'multi' ? f.options.slice(0, 1) : f.type === 'date' ? '2026-11-17' : f.type === 'number' ? '12' : f.options?.[0] || 'Fixture'])), ...extra});
const createSupport = async (h, category = 'commissioning', who = 'user') => {
  const form = (await h.rpc(who, 'getSupportWorkspace', [{category}])).forms[category];
  return (await h.rpc(who, 'createSupportRequest', [{category, formRevision: form.revision, values: fillFields(form.fields, {problem_category: 'Encoder problem'}), mutationId: crypto.randomUUID()}])).ticket;
};
const createEntry = async (h, who = 'sa', category = 'wb-team') => {
  const form = (await h.rpc(who, 'getRiCategories')).find(c => c.id === category);
  return h.rpc(who, 'saveRiEntry', [{id: crypto.randomUUID(), operation: crypto.randomUUID(), revision: 0, category, formRevision: form.revision, values: fillFields(form.schema.fields)}]);
};
const projectData = (tasks) => ({name: 'Controller validation', lead: IDS.sa, collaborators: [], start: '2026-11-05', end: '2026-11-30',
  status: 'In Progress', impact: 'Product Development', brief: '', financial: false, documentation: false,
  tasks: tasks.map(n => ({id: crypto.randomUUID(), name: n, owner: IDS.sa, start: '2026-11-05', end: '2026-11-10', status: 'Pending', progress: 0}))});
const bin = async h => (await h.rpc('sa', 'getRecycleBin')).items;
const damage = (h, category, item, qty, received = false) => h.db.query(`insert into wlf_private.damage_demands(request_id,category,request_reference,requester_id,requester_name,requested_at,project,lift_id,controllers,problem_categories,form_schema,form_values,confirmed_by,confirmed_name,solution_statement,item_name,item_code,item_spec,quantity,create_operation,create_payload_hash,received_at,received_by,received_name)
  values(gen_random_uuid(),$1,'R-1',$3,'u',now(),'P','1','{}','{}','{}','{}',$3,'rni','fixed',$2,'','',$4,gen_random_uuid(),'\\x00',${received ? "now(),'" + IDS.sa + "','sa'" : 'null,null,null'})`, [category, item, IDS.rni, qty]);

test('v2.5.3 migration is repeatable, keeps old deleted items in the bin, and is Super Admin only', async t => {
  const {h, ready} = await prepare(t, async h => {
    const t1 = await createSupport(h);
    await h.rpc('sa', 'deleteSupportRequest', [{id: t1.id, revision: t1.revision, mutationId: crypto.randomUUID()}]);
  });
  assert.deepEqual(ready, {recycle_bin_ready: true, items_in_recycle_bin: 1, announcements_ready: true, management_dashboard_ready: true, v253_ready: true});
  assert.equal((await h.db.exec(migration)).at(-1).rows[0].v253_ready, true);
  assert.equal((await h.rpc('sa', 'getSession')).build, '2.5.3');
  const items = await bin(h);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'request');
  assert.match(items[0].deletedBy, /sa/);
  for (const who of ['admin', 'rni', 'user']) {
    for (const [a, p] of [['getRecycleBin', {}], ['restoreRecycleItem', {id: items[0].id}], ['purgeRecycleItems', {all: true, confirm: 'DELETE'}],
                         ['saveAnnouncement', {title: 'x', allSections: true}], ['getAnnouncementAdmin', {}], ['purgeUsageLog', {confirm: 'DELETE'}], ['exportOldUsageLog', {}]])
      await assert.rejects(h.rpc(who, a, [p]), /Permission denied/, who + ' ' + a);
  }
  await assert.rejects(h.as('user', () => h.db.query('select * from wlf_private.recycle_bin')), /permission denied/);
  await assert.rejects(h.as('user', () => h.db.query("select wlf_private.recycle_api('getRecycleBin','{}',null)")), /permission denied/);
});

test('Everything deleted goes to the recycle bin and can be restored', async t => {
  const {h} = await prepare(t);
  await grant(h, 'sa', 'ri:projects');
  // support request
  const req = await createSupport(h);
  await h.rpc('sa', 'deleteSupportRequest', [{id: req.id, revision: req.revision, mutationId: crypto.randomUUID()}]);
  // R&I entry
  const entry = await createEntry(h);
  await h.rpc('sa', 'deleteRiEntry', [{id: entry.id, category: entry.category, revision: entry.revision, operation: crypto.randomUUID()}]);
  // project + task
  const proj = await h.rpc('sa', 'saveRiProject', [{id: crypto.randomUUID(), operation: crypto.randomUUID(), revision: 0, data: projectData(['Wiring', 'Testing'])}]);
  const kept = {...proj.data, tasks: proj.data.tasks.slice(0, 1)};
  const p2 = await h.rpc('sa', 'saveRiProject', [{id: proj.id, revision: proj.revision, operation: crypto.randomUUID(), data: kept}]);
  // troubleshooting
  const tb = (await h.db.query("select id,revision from public.wlf_troubleshooting where not deleted order by id limit 1")).rows[0];
  await h.rpc('sa', 'deleteTroubleshootingEntry', [tb.id, tb.revision]);
  // documents: link, folder, sub menu
  let cat = (await h.rpc('sa', 'getDocuments')).categories[0];
  const doc = await h.rpc('sa', 'saveDocument', [{category: cat.id, name: 'Lift Manual', url: 'https://drive.google.com/file/d/x/view', extra: {}}]);
  await h.rpc('sa', 'deleteDocument', [doc]);
  const folder = await h.rpc('sa', 'saveDocumentFolder', [{category: cat.id, name: 'Drawings'}]);
  await h.rpc('sa', 'deleteDocumentFolder', [folder]);
  const cat2 = await h.rpc('sa', 'saveDocumentCategory', [{name: 'Manuals', fields: ['Revision']}]);
  const outer = await h.rpc('sa', 'saveDocumentFolder', [{category: cat2.id, name: 'A'}]);
  const inner = await h.rpc('sa', 'saveDocumentFolder', [{category: cat2.id, name: 'Same', parent: outer.id}]);
  await h.rpc('sa', 'saveDocumentFolder', [{category: cat2.id, name: 'Same'}]);
  await h.rpc('sa', 'saveDocument', [{category: cat2.id, folder: inner.id, name: 'Inside', url: 'https://drive.google.com/file/d/y/view', extra: {Revision: 'R1'}}]);
  await h.rpc('sa', 'deleteDocumentCategory', [cat2]);
  // announcement
  const ann = await h.rpc('sa', 'saveAnnouncement', [{title: 'Safety week', body: 'Wear helmets', allSections: true}]);
  await h.rpc('sa', 'deleteAnnouncement', [{id: ann.id}]);

  const items = await bin(h);
  assert.deepEqual(items.map(i => i.kind).sort(), ['announcement','doc-category','doc-folder','document','request','ri-entry','task','troubleshooting']);
  assert.equal(items.find(i => i.kind === 'task').label, 'Testing');
  assert.ok(items.every(i => /sa/.test(i.deletedBy)));
  // not visible anywhere while in the bin
  assert.ok(!(await h.rpc('sa', 'getSupportWorkspace', [{category: 'commissioning'}])).tickets.some(x => x.id === req.id));
  assert.ok(!(await h.rpc('sa', 'getDocuments')).categories.some(c => c.id === cat2.id));

  // project delete -> bin; task restore refused until project restored
  await h.rpc('sa', 'deleteRiProject', [{id: proj.id, revision: p2.revision, operation: crypto.randomUUID()}]);
  const all = await bin(h);
  await assert.rejects(h.rpc('sa', 'restoreRecycleItem', [{id: all.find(i => i.kind === 'task').id}]), /Restore the project/);
  for (const kind of ['project','task','request','ri-entry','troubleshooting','document','doc-folder','doc-category','announcement'])
    await h.rpc('sa', 'restoreRecycleItem', [{id: all.find(i => i.kind === kind).id}]);
  assert.equal((await bin(h)).length, 0);
  const restoredProject = (await h.rpc('sa', 'getRiProjects')).projects.find(x => x.id === proj.id);
  assert.deepEqual(restoredProject.data.tasks.map(x => x.name), ['Wiring', 'Testing']);
  assert.ok((await h.rpc('sa', 'getSupportWorkspace', [{category: 'commissioning'}])).tickets.some(x => x.id === req.id));
  assert.equal((await h.db.query('select deleted from public.wlf_troubleshooting where id=$1', [tb.id])).rows[0].deleted, false);
  const docs = await h.rpc('sa', 'getDocuments');
  assert.ok(docs.documents.some(d => d.id === doc.id));
  assert.ok(docs.folders.some(f => f.id === folder.id));
  assert.equal(docs.folders.filter(f => f.category === cat2.id).length, 3);
  assert.equal(docs.documents.find(d => d.name === 'Inside').folder, inner.id);
  assert.equal((await h.rpc('user', 'getAnnouncements')).items[0].title, 'Safety week');
  const hist = (await h.db.query("select action from public.wlf_history where request_id=$1 order by id", [req.id])).rows.map(r => r.action);
  assert.deepEqual(hist.slice(-2), ['delete', 'restore']);
});

test('Delete permanently, Empty bin needs DELETE, and the purge log keeps only counts', async t => {
  const {h} = await prepare(t);
  const req = await createSupport(h);
  await damage(h, 'commissioning', 'Encoder', 1);
  await h.db.query('update wlf_private.damage_demands set request_id=$1', [req.id]);
  await h.rpc('sa', 'deleteSupportRequest', [{id: req.id, revision: req.revision, mutationId: crypto.randomUUID()}]);
  const entry = await createEntry(h);
  await h.rpc('sa', 'deleteRiEntry', [{id: entry.id, category: entry.category, revision: entry.revision, operation: crypto.randomUUID()}]);
  const tb = (await h.db.query("select id,revision from public.wlf_troubleshooting where not deleted order by id limit 1")).rows[0];
  await h.rpc('sa', 'deleteTroubleshootingEntry', [tb.id, tb.revision]);
  let items = await bin(h);
  const out = await h.rpc('sa', 'purgeRecycleItems', [{ids: [items.find(i => i.kind === 'request').id]}]);
  assert.deepEqual(out, {deleted: 1, counts: {request: 1}});
  for (const sql of ['select 1 from public.wlf_requests where id=$1', 'select 1 from public.wlf_history where request_id=$1', 'select 1 from public.wlf_operations where request_id=$1', 'select 1 from wlf_private.damage_demands where request_id=$1'])
    assert.equal((await h.db.query(sql, [req.id])).rows.length, 0, sql);
  await assert.rejects(h.rpc('sa', 'purgeRecycleItems', [{all: true}]), /Type DELETE/);
  await assert.rejects(h.rpc('sa', 'purgeRecycleItems', [{all: true, confirm: 'delete'}]), /Type DELETE/);
  assert.equal((await h.rpc('sa', 'purgeRecycleItems', [{all: true, confirm: 'DELETE'}])).deleted, 2);
  assert.equal((await h.db.query('select 1 from public.wlf_ri_entries where id=$1', [entry.id])).rows.length, 0);
  assert.equal((await h.db.query('select 1 from wlf_private.ri_entry_archive where id=$1', [entry.id])).rows.length, 1);
  assert.equal((await h.db.query('select 1 from public.wlf_troubleshooting where id=$1', [tb.id])).rows.length, 0);
  const view = await h.rpc('sa', 'getRecycleBin');
  assert.equal(view.items.length, 0);
  assert.deepEqual(view.purges.map(p => p.what), ['Empty bin', 'Delete permanently']);
  assert.deepEqual(view.purges[0].counts, {'ri-entry': 1, troubleshooting: 1});
  await assert.rejects(h.rpc('sa', 'purgeRecycleItems', [{all: true, confirm: 'DELETE'}]), /Nothing to delete/);
});

test('Announcements reach the chosen sections, count as unread until Read, and push', async t => {
  const {h} = await prepare(t);
  await h.db.query("insert into wlf_private.push_subscriptions(endpoint,profile,p256dh,auth) values('https://push.example/1',$1,repeat('a',40),repeat('b',16)),('https://push.example/2',$2,repeat('a',40),repeat('b',16))", [IDS.user, IDS.admin]);
  await assert.rejects(h.rpc('sa', 'saveAnnouncement', [{title: '', allSections: true}]), /Enter a title/);
  await assert.rejects(h.rpc('sa', 'saveAnnouncement', [{title: 'x', sections: []}]), /Tick at least one/);
  await assert.rejects(h.rpc('sa', 'saveAnnouncement', [{title: 'x', sections: ['Nowhere']}]), /Unknown section/);
  await assert.rejects(h.rpc('sa', 'saveAnnouncement', [{title: 'x', allSections: true, expiresOn: '2020-01-01'}]), /already passed/);
  const a1 = await h.rpc('sa', 'saveAnnouncement', [{title: 'Commissioning meeting', body: 'Sunday 10am', sections: ['Commissioning']}]);
  const outbox = (await h.db.query('select profile,title,url from wlf_private.push_outbox order by id')).rows;
  assert.deepEqual(outbox.map(o => [o.profile, o.title, o.url]), [[IDS.user, 'Announcement: Commissioning meeting', './#account']]);
  assert.equal((await h.rpc('user', 'getNavBadges')).announcements, 1);
  assert.equal((await h.rpc('admin', 'getNavBadges')).announcements, 0);
  assert.equal((await h.rpc('admin', 'getAnnouncements')).items.length, 0);
  assert.equal((await h.rpc('user', 'markAnnouncementRead', [{id: a1.id}])).unread, 0);
  assert.equal((await h.rpc('user', 'getAnnouncements')).items[0].read, true);
  await h.rpc('sa', 'saveAnnouncement', [{title: 'Holiday', allSections: true, expiresOn: '2099-01-01'}]);
  assert.equal((await h.rpc('admin', 'getNavBadges')).announcements, 1);
  let admin = (await h.rpc('sa', 'getAnnouncementAdmin')).items;
  const meeting = admin.find(x => x.id === a1.id);
  assert.equal(meeting.targets, 1);
  assert.equal(meeting.reads, 1);
  assert.deepEqual(meeting.readers, ['user (US-5)']);
  const edited = await h.rpc('sa', 'saveAnnouncement', [{id: a1.id, revision: meeting.revision, title: 'Commissioning meeting moved', body: 'Monday', sections: ['Commissioning'], resend: true}]);
  assert.equal(edited.revision, 2);
  assert.equal((await h.rpc('user', 'getNavBadges')).announcements, 2);
  await assert.rejects(h.rpc('sa', 'saveAnnouncement', [{id: a1.id, revision: 1, title: 'x', allSections: true}]), /CONFLICT/);
  await h.db.query("update wlf_private.announcements set expires_on='2020-01-01' where id=$1", [a1.id]);
  assert.equal((await h.rpc('user', 'getNavBadges')).announcements, 1, 'expired announcements disappear');
});

test('Usage log: 30 days visible, Super Admin downloads then deletes older rows', async t => {
  const {h} = await prepare(t);
  await h.db.query("delete from public.wlf_usage");
  await h.db.query("insert into public.wlf_usage(actor,action,details,at) values($1,'Login','',now()-interval '40 days'),($1,'Power Calculation','x',now()-interval '35 days'),($1,'Login','',now()-interval '2 days'),($2,'Login','',now())", [IDS.user, IDS.rni]);
  const sa = await h.rpc('sa', 'getUsageLog');
  assert.equal(sa.total, 2);
  assert.equal(sa.old.count, 2);
  assert.equal(sa.people.length, 2);
  const filtered = await h.rpc('sa', 'getUsageLog', [{member: IDS.user}]);
  assert.deepEqual(filtered.rows.map(r => r.who), ['user (US-5)']);
  const rni = await h.rpc('rni', 'getUsageLog', [{member: IDS.user}]);
  assert.deepEqual(rni.rows.map(r => r.who), ['rni (RN-3)'], 'R&I sees only their own log');
  assert.equal(rni.old, null);
  await assert.rejects(h.rpc('user', 'getUsageLog'), /Permission denied/);
  const stats = await h.rpc('sa', 'adminStats');
  assert.equal(Number(stats.totalEvents), 2, 'usage counts cover the last 30 days');
  const exp = await h.rpc('sa', 'exportOldUsageLog', [{}]);
  assert.equal(exp.rows.length, 2);
  await assert.rejects(h.rpc('sa', 'purgeUsageLog', [{before: exp.before}]), /Type DELETE/);
  assert.equal((await h.rpc('sa', 'purgeUsageLog', [{before: exp.before, confirm: 'DELETE'}])).deleted, 2);
  assert.equal((await h.db.query('select count(*)::int n from public.wlf_usage')).rows[0].n, 2);
  assert.equal((await h.rpc('sa', 'getRecycleBin')).purges[0].what, 'Usage log older than 30 days');
});

test('My activity shows only my own work; Management Dashboard needs Dashboard access', async t => {
  const {h} = await prepare(t);
  await grant(h, 'admin', 'workspace:dashboard');
  const r1 = await createSupport(h);
  await createSupport(h);
  await h.rpc('rni', 'transitionSupportRequest', [{id: r1.id, revision: r1.revision, action: 'receive', mutationId: crypto.randomUUID()}]);
  await createEntry(h, 'sa');
  await damage(h, 'commissioning', 'Encoder', 3);
  await damage(h, 'commissioning', 'Encoder', 2, true);
  await damage(h, 'aftersales', 'Door motor', 1);
  const mine = await h.rpc('user', 'getMyActivity');
  assert.deepEqual(mine.supportCreated, [{team: 'commissioning', total: 2, solved: 0, open: 2}]);
  assert.deepEqual(mine.supportWork, []);
  assert.deepEqual(mine.ri, []);
  const rni = await h.rpc('rni', 'getMyActivity', [{from: '2025-01-01', to: '2027-12-31'}]);
  assert.deepEqual(rni.supportWork, [{team: 'commissioning', received: 1, forwarded: 0, solved: 0, notSolved: 0}]);
  assert.equal(rni.damage.confirmed, 3);
  assert.equal((await h.rpc('sa', 'getMyActivity')).ri[0].total, 1);
  await assert.rejects(h.rpc('user', 'getMyActivity', [{from: '2026-12-01', to: '2026-11-01'}]), /From date/);

  await assert.rejects(h.rpc('user', 'getManagementDashboard'), /Dashboard access required/);
  const d = await h.rpc('admin', 'getManagementDashboard');
  assert.equal(d.months.length, 12);
  assert.equal(d.support.teams.find(x => x.team === 'commissioning').total, 2);
  assert.equal(d.support.people[0].received, 1);
  assert.equal(d.support.curve.commissioning.length, 12);
  assert.equal(d.support.curve.commissioning[11], 2);
  assert.deepEqual(d.damage.top[0], {item: 'Encoder', quantity: 5, demands: 2});
  assert.equal(d.damage.teams.find(x => x.team === 'commissioning').pending, 1);
  assert.equal(d.ri.find(x => x.id === 'wb-team').total, 1);
  assert.equal(d.ri.find(x => x.id === 'wb-team').people[0].n, 1);
  assert.equal(d.supplier.comingSoon, true);
  const badges = await h.rpc('sa', 'getNavBadges');
  assert.equal(badges.damagePending, 2);
  assert.equal((await h.rpc('user', 'getNavBadges')).damagePending, null);
});
