const test = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {makeDB, IDS} = require('./pg-harness.cjs');

const chain = ['UPDATE_V220','UPDATE_SUPPORT_FORMS_20261107','UPDATE_DAMAGE_DEMAND_20261107','UPDATE_WORKSPACE_20261107','UPDATE_SECTIONS_V230'];
const migration = readFileSync('supabase/UPDATE_V240.sql','utf8');

async function prepare(t) {
  const h = await makeDB();
  t.after(() => h.close());
  for (const file of chain) await h.db.exec(readFileSync('supabase/'+file+'.sql','utf8'));
  const results = await h.db.exec(migration);
  return {h, ready: results.at(-1).rows[0]};
}
const folder = (h, who, payload) => h.rpc(who, 'saveDocumentFolder', [payload]);

test('v2.4.0 migration is repeatable and fixes the two spellings', async t => {
  const {h, ready} = await prepare(t);
  assert.deepEqual(ready, {document_folders_ready: true, document_folder_column_ready: true, folders_protected: true,
    spelling_fixed: true, task_and_folder_rules_ready: true});
  assert.equal((await h.db.exec(migration)).at(-1).rows[0].spelling_fixed, true);
  const form = (await h.db.query("select schema::text s from public.wlf_forms where category='installation'")).rows[0].s;
  assert.ok(form.includes('1. Aesthetics') && !form.includes('Asthetics'));
  const tb = (await h.db.query("select count(*)::int n from public.wlf_troubleshooting where content::text like '%runs in up direction%'")).rows[0].n;
  assert.ok(tb >= 1);
  assert.equal((await h.rpc('sa', 'getSession')).build, '2.4.1');
});

test('Super Admin builds nested folders; rules keep them safe; everyone approved can read them', async t => {
  const {h} = await prepare(t);
  const docs = await h.rpc('sa', 'getDocuments');
  const bom = docs.categories.find(c => c.name === 'BOM'), sop = docs.categories.find(c => c.name === 'SOP');
  assert.deepEqual(docs.folders, []);
  const y2026 = await folder(h, 'sa', {category: bom.id, name: ' 2026 '});
  assert.equal(y2026.name, '2026');
  const nice = await folder(h, 'sa', {category: bom.id, parent: y2026.id, name: 'NICE3000+'});
  await assert.rejects(folder(h, 'sa', {category: bom.id, parent: y2026.id, name: 'nice3000+'}), /already exists/);
  await assert.rejects(folder(h, 'user', {category: bom.id, name: 'X'}), /Super Admin only/);
  await assert.rejects(folder(h, 'sa', {category: sop.id, parent: y2026.id, name: 'X'}), /same sub menu/);
  // depth limit: 2026 > NICE > 3 > 4 > 5 > 6 ok, 7th refused
  let parent = nice.id;
  for (const n of ['L3','L4','L5','L6']) parent = (await folder(h, 'sa', {category: bom.id, parent, name: n})).id;
  await assert.rejects(folder(h, 'sa', {category: bom.id, parent, name: 'L7'}), /6 levels/);
  // no loops on move
  await assert.rejects(folder(h, 'sa', {id: y2026.id, revision: y2026.revision, category: bom.id, parent: nice.id, name: '2026'}), /into itself/);
  const renamed = await folder(h, 'sa', {id: nice.id, revision: nice.revision, category: bom.id, parent: y2026.id, name: 'NICE'});
  assert.equal(renamed.revision, nice.revision + 1);
  await assert.rejects(folder(h, 'sa', {id: nice.id, revision: nice.revision, category: bom.id, parent: '', name: 'Old'}), /CONFLICT/);

  const doc = await h.rpc('sa', 'saveDocument', [{category: bom.id, folder: renamed.id, name: 'Main BOM',
    url: 'https://drive.google.com/file/d/abc/view', extra: {}}]);
  assert.equal(doc.folder, renamed.id);
  await assert.rejects(h.rpc('sa', 'saveDocument', [{category: sop.id, folder: renamed.id, name: 'Wrong',
    url: 'https://drive.google.com/file/d/x/view', extra: {}}]), /same sub menu/);
  const moved = await h.rpc('sa', 'saveDocument', [{...doc, folder: ''}]);
  assert.equal(moved.folder, null);
  const back = await h.rpc('sa', 'saveDocument', [{...moved, folder: y2026.id}]);
  assert.equal(back.folder, y2026.id);
  const untouched = await h.rpc('sa', 'saveDocument', [{id: back.id, revision: back.revision, category: bom.id, name: 'Main BOM v2',
    url: back.url, extra: {}}]);
  assert.equal(untouched.folder, y2026.id, 'older clients without a folder field keep the folder');

  const seen = await h.rpc('user', 'getDocuments');
  assert.equal(seen.folders.length, 6);
  assert.equal(seen.documents.find(d => d.id === back.id).folder, y2026.id);
  const leaf = (await h.rpc('sa', 'getDocuments')).folders.find(f => f.name === 'L6');
  await assert.rejects(h.rpc('sa', 'deleteDocumentFolder', [{id: y2026.id, revision: y2026.revision}]), /not empty/);
  assert.equal(await h.rpc('sa', 'deleteDocumentFolder', [{id: leaf.id, revision: leaf.revision}]), true);
  await assert.rejects(h.rpc('user', 'deleteDocumentFolder', [{id: y2026.id, revision: 1}]), /Super Admin only/);
  await h.rpc('sa', 'deleteDocumentCategory', [bom]);
  assert.equal((await h.db.query('select count(*)::int n from public.wlf_document_folders')).rows[0].n, 0);
  await assert.rejects(h.as('user', () => h.db.query("insert into public.wlf_document_folders(category,name) values($1,'x')", [sop.id])));
});

test('Task Assignee must be the project lead or a collaborator; people show Name (ID)', async t => {
  const {h} = await prepare(t);
  await h.db.query('alter table public.wlf_profiles disable trigger wlf_deletion_guard');
  for (const [who, emp] of [['sa','SA-1'],['rni','RN-3'],['rni2','RN-4'],['user','US-5']])
    await h.db.query("update public.wlf_profiles set employee_id=$2, section='R&I Electrical', permissions=array_append(permissions,'ri:projects') where id=$1", [IDS[who], emp]);
  await h.db.query('alter table public.wlf_profiles enable trigger wlf_deletion_guard');
  const base = {name: 'Regen drive', lead: IDS.sa, collaborators: [IDS.rni], start: '2026-11-01', end: '2026-12-31',
    impact: 'Product Development', status: 'In Progress', brief: '', financial: false, documentation: false};
  const task = (owner, extra = {}) => ({id: crypto.randomUUID(), name: 'Bench test', owner, start: '2026-11-02', end: '2026-11-05',
    status: 'Pending', progress: 0, ...extra});
  const save = (row, data) => h.rpc('sa', 'saveRiProject', [{id: row?.id || crypto.randomUUID(), operation: crypto.randomUUID(),
    revision: row?.revision || 0, data}]);
  let row = await save(null, {...base, tasks: [task(IDS.rni)]});
  await assert.rejects(save(row, {...base, tasks: [...row.data.tasks, task(IDS.rni2)]}), /Assignee/);
  await assert.rejects(save(row, {...base, tasks: [...row.data.tasks, task('')]}), /Assignee/);
  row = await save(row, {...base, tasks: [...row.data.tasks, task(IDS.sa)]});
  // the task dialog's "Add user" adds the person as a collaborator in the same save
  row = await save(row, {...base, collaborators: [IDS.rni, IDS.rni2], tasks: [...row.data.tasks, task(IDS.rni2)]});
  assert.deepEqual(row.data.collaborators, [IDS.rni, IDS.rni2]);
  assert.equal(row.data.tasks.length, 3);
  // removing a collaborator keeps their earlier task, but a new task cannot go to them
  row = await save(row, {...base, collaborators: [IDS.rni], tasks: row.data.tasks});
  await assert.rejects(save(row, {...base, collaborators: [IDS.rni], tasks: [...row.data.tasks, task(IDS.rni2)]}), /Assignee/);
  const list = await h.rpc('sa', 'getRiProjects', [{}]);
  const people = Object.fromEntries(list.people.map(p => [p.id, p.name]));
  assert.match(people[IDS.rni], /\(RN-3\)$/);
  assert.match(list.projects[0].owner_name, /\(SA-1\)$/);
});
