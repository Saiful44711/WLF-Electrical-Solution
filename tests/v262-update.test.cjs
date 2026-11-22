const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {readFileSync} = require('node:fs');
const {makeDB, IDS} = require('./pg-harness.cjs');

const chain = ['UPDATE_V220','UPDATE_SUPPORT_FORMS_20261107','UPDATE_DAMAGE_DEMAND_20261107','UPDATE_WORKSPACE_20261107','UPDATE_SECTIONS_V230','UPDATE_V240','UPDATE_V250','UPDATE_V251','UPDATE_V252','UPDATE_V253','UPDATE_V254','UPDATE_V255','UPDATE_V256','UPDATE_V257','UPDATE_V258','UPDATE_V259','UPDATE_V260','UPDATE_V261'];
const migration = readFileSync('supabase/UPDATE_V262.sql','utf8');

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
const give = (h, who, ...keys) => h.db.query('update public.wlf_profiles set permissions=array_cat(permissions,$2) where id=$1', [IDS[who], keys]);
const backup = (h, action, payload, who = 'sa') => h.db.query('select public.wlf_excel_admin($1,$2,$3) result', [action, IDS[who], payload]).then(x => x.rows[0].result);
const one = async (h, sql, args) => (await h.db.query(sql, args)).rows[0];
const lift = (extra = {}) => ({id: crypto.randomUUID(), liftId: 'L-100', project: 'Eden Tower', address: 'Dhaka', deliveryDate: '2026-11-25',
  motorType: 'Gearless', liftType: 'Passenger', system: 'MOT', controllerModel: 'MOT 7.5 kW',
  serials: {motor:'M',encoder:'E',drive: 'D-1',ups:'U',cartop:'C',cop:'P',copDisplay:'X'},
  selection: {inputs: {capacity: 1000}, categories: [{title: 'Selected Motor Data', items: [{label: 'Motor Model', value: 'MCK'}]}]}, items: [], ...extra});
const demand = (h, {received = false, claim = false, scReceived = false, item = 'Door motor'} = {}) => h.db.query(
  `insert into wlf_private.damage_demands(request_id,category,request_reference,requester_id,requester_name,requested_at,project,lift_id,controllers,problem_categories,form_schema,form_values,confirmed_by,confirmed_name,solution_statement,item_name,item_code,item_spec,quantity,create_operation,create_payload_hash,received_at,received_by,received_name,claim_at,claim_by,claim_name,claim_supplier,sc_received_at,sc_received_by,sc_received_name)
   values(gen_random_uuid(),'aftersales','R-1',$2,'u',now(),'P','1','{}','{}','{}','{}',$2,'rni','fixed',$1,'C-1','spec',2,gen_random_uuid(),'\\x00',
     ${received ? `now(),'${IDS.sa}','sa'` : 'null,null,null'},${claim ? `now(),'${IDS.sa}','sa','Sup A'` : 'null,null,null,null'},${scReceived ? `now(),'${IDS.sa}','sa'` : 'null,null,null'}) returning request_id`,
  [item, IDS.rni]).then(r => r.rows[0].request_id);
const project = (h, status, name) => h.db.query(`insert into public.wlf_ri_projects(id,owner,data,last_operation,last_payload_hash) values(gen_random_uuid(),$1,$2,gen_random_uuid(),'x') returning id`,
  [IDS.sa, {name, status, brief: '', start: '2026-11-01', end: '2026-11-30', lead: 'x', tasks: []}]).then(r => r.rows[0].id);

// one complete backup round: prepare -> (file saved) -> verify -> clear
async function run(h, kind, withClear, extra = {}) {
  const id = crypto.randomUUID(), nonce = crypto.randomUUID();
  const snap = await backup(h, 'prepare', {id, kind, withClear, nonce, ...extra});
  const hex = c => c.repeat(64).slice(0, 64);
  const done = await backup(h, 'verify', {id, nonce, workbookId: 'wb_' + id.slice(0, 8), workbookHash: hex('a'),
    ...(withClear ? {recoveryId: 'rc_' + id.slice(0, 8), recoveryHash: hex('b')} : {})});
  return {id, snap, done};
}

test('v2.6.2 migration is repeatable and adds the Documents Links permission for existing users only', async t => {
  const {h, ready} = await prepare(t);
  assert.equal(ready.v262_ready, true);
  assert.equal(ready.documents_permission_ready, true);
  assert.equal(Number(ready.users_without_documents), 0);
  assert.equal((await h.db.exec(migration)).at(-1).rows[0].v262_ready, true);
  assert.equal((await h.rpc('sa', 'getSession')).build, '2.6.2');
  const perms = (await one(h, 'select permissions from public.wlf_profiles where id=$1', [IDS.user])).permissions;
  assert.ok(perms.includes('documents:view'));
  assert.equal(perms.filter(x => x === 'documents:view').length, 1, 'no duplicate after running twice');
  const cat = (await h.rpc('sa', 'listAppUsers')).catalog.filter(x => x.key === 'documents:view');
  assert.equal(cat.length, 1);
});

test('Documents Links: the Super Admin chooses who can open it; only the Super Admin can change it', async t => {
  const {h} = await prepare(t);
  assert.ok(Array.isArray((await h.rpc('user', 'getDocuments')).categories), 'existing user keeps access');
  await h.db.query("update public.wlf_profiles set permissions=array_remove(permissions,'documents:view') where id=$1", [IDS.user]);
  await assert.rejects(h.rpc('user', 'getDocuments'), /not enabled/);
  await give(h, 'user', 'documents:view');
  assert.ok((await h.rpc('user', 'getDocuments')).categories);
  assert.ok((await h.rpc('sa', 'getDocuments')).categories, 'Super Admin always');
  await assert.rejects(h.rpc('user', 'saveDocumentCategory', [{name: 'X', fields: []}]), /Super Admin only/);
  await assert.rejects(h.rpc('rni', 'saveDocumentCategory', [{name: 'X', fields: []}]), /Super Admin only/);
  await assert.rejects(h.rpc('user', 'saveDocumentFolder', [{name: 'F'}]), /Super Admin only/);
  const cat = await h.rpc('sa', 'saveDocumentCategory', [{name: 'Manuals', fields: []}]);
  assert.ok(cat.id);
  await assert.rejects(h.rpc('user', 'deleteDocumentCategory', [{id: cat.id, revision: 1}]), /Super Admin only/);
});

test('Excel backup: R&I Project without clear keeps everything; with clear removes only Done projects and restores them', async t => {
  const {h} = await prepare(t);
  const done = await project(h, 'Done', 'Finished job'), open = await project(h, 'In Progress', 'Running job');
  const a = await run(h, 'project', false);
  assert.equal(a.snap.total, 2);
  assert.equal(a.snap.records.find(r => r.id === done).eligible, true);
  assert.equal(a.snap.records.find(r => r.id === open).eligible, false);
  assert.equal(a.snap.records[0].ownerName.length > 0, true);
  await assert.rejects(backup(h, 'clear', {id: a.id}), /Verified workbook and recovery file required/);
  assert.equal((await one(h, 'select count(*)::int n from public.wlf_ri_projects')).n, 2);
  const b = await run(h, 'project', true);
  const cleared = await backup(h, 'clear', {id: b.id});
  assert.equal(cleared.cleared, 1);
  assert.deepEqual((await h.db.query('select id from public.wlf_ri_projects')).rows.map(r => r.id), [open]);
  const restored = await backup(h, 'restore', {id: b.id, project: 'p1', archive: {format: 'WLF-EXCEL-RECOVERY-2.2', project: 'p1', id: b.id, kind: 'project', records: b.snap.records}});
  assert.equal(restored.restored, 1);
  assert.equal((await one(h, 'select count(*)::int n from public.wlf_ri_projects')).n, 2);
  await assert.rejects(backup(h, 'restore', {id: b.id, project: 'p1', archive: {format: 'WLF-EXCEL-RECOVERY-2.2', project: 'p1', id: b.id, kind: 'project', records: b.snap.records}}), /cannot be applied/);
});

test('Excel backup: a project changed after the backup is not cleared', async t => {
  const {h} = await prepare(t);
  const id = await project(h, 'Done', 'Edited later');
  const id2 = crypto.randomUUID(), nonce = crypto.randomUUID();
  await backup(h, 'prepare', {id: id2, kind: 'project', withClear: true, nonce});
  await backup(h, 'verify', {id: id2, nonce, workbookId: 'wb_12345', workbookHash: 'a'.repeat(64), recoveryId: 'rc_12345', recoveryHash: 'b'.repeat(64)});
  await h.db.query("update public.wlf_ri_projects set data=jsonb_set(data,'{brief}','\"changed\"') where id=$1", [id]);
  assert.equal((await backup(h, 'clear', {id: id2})).cleared, 0);
  assert.equal((await one(h, 'select count(*)::int n from public.wlf_ri_projects')).n, 1);
});

test('Excel backup: QMS data exports the full lift with its parts, clears it and restores it identically', async t => {
  const {h} = await prepare(t);
  await give(h, 'rni', 'qms:components', 'qms:edit', 'qms:delete');
  const rows = (await h.rpc('sa', 'getCatalogue')).rows.filter(r => r.model === 'MOT 7.5 kW' && r.itemCode);
  const saved = await h.rpc('rni', 'saveQmsLift', [lift({items: rows.slice(0, 3).map((r, i) => ({catalogueId: r.id, section: 'control', serial: 'S' + i}))})]);
  const before = await h.rpc('rni', 'getQmsLift', [{id: saved.id}]);
  const a = await run(h, 'qms', false);
  assert.equal(a.snap.total, 1);
  const rec = a.snap.records[0].lift;
  assert.equal(rec.parts.length, 3);
  assert.ok(rec.parts.every(p => p.code && !p.h), 'the file holds the real data, not references');
  assert.equal(rec.parts[0].serial, 'S0');
  assert.equal((await one(h, 'select count(*)::int n from wlf_private.qms_lifts')).n, 1, 'backup without clear changes nothing');
  const b = await run(h, 'qms', true);
  assert.equal((await backup(h, 'clear', {id: b.id})).cleared, 1);
  assert.equal((await one(h, 'select count(*)::int n from wlf_private.qms_lifts')).n, 0);
  assert.equal((await one(h, 'select count(*)::int n from wlf_private.hw_snap')).n, 0, 'unused shared rows are removed too');
  const r = await backup(h, 'restore', {id: b.id, project: 'p1', archive: {format: 'WLF-EXCEL-RECOVERY-2.2', project: 'p1', id: b.id, kind: 'qms', records: b.snap.records}});
  assert.equal(r.restored, 1);
  const after = await h.rpc('rni', 'getQmsLift', [{id: saved.id}]);
  assert.deepEqual(after.parts, before.parts);
  assert.deepEqual(after.selection, before.selection);
});

test('Excel backup: Damage Demand and Supplier Claim use the same record with clear rules for each', async t => {
  const {h} = await prepare(t);
  const pending = await demand(h, {item: 'Pending'});
  const received = await demand(h, {received: true, item: 'Received only'});
  const claimOpen = await demand(h, {received: true, claim: true, item: 'Claim open'});
  const claimDone = await demand(h, {received: true, claim: true, scReceived: true, item: 'Claim done'});
  const d = await run(h, 'damage', false);
  assert.equal(d.snap.total, 4);
  const elig = Object.fromEntries(d.snap.records.map(r => [r.demand.item_name, r.eligible]));
  assert.deepEqual(elig, {Pending: false, 'Received only': true, 'Claim open': false, 'Claim done': true});
  const c = await run(h, 'claim', false);
  assert.equal(c.snap.total, 2, 'only demands that went to the supplier');
  assert.deepEqual(Object.fromEntries(c.snap.records.map(r => [r.demand.item_name, r.eligible])), {'Claim open': false, 'Claim done': true});
  // clear with backup: Damage Demand
  const w = await run(h, 'damage', true);
  assert.equal((await backup(h, 'clear', {id: w.id})).cleared, 2);
  const left = (await h.db.query('select item_name from wlf_private.damage_demands order by item_name')).rows.map(r => r.item_name);
  assert.deepEqual(left, ['Claim open', 'Pending']);
  const no = (await one(h, 'select demand_no from wlf_private.damage_demands where item_name=$1', ['Pending'])).demand_no;
  const r = await backup(h, 'restore', {id: w.id, project: 'p1', archive: {format: 'WLF-EXCEL-RECOVERY-2.2', project: 'p1', id: w.id, kind: 'damage', records: w.snap.records}});
  assert.equal(r.restored, 2);
  const back = (await h.db.query("select item_name,demand_no,received_at is not null rec from wlf_private.damage_demands order by item_name")).rows;
  assert.equal(back.length, 4);
  assert.ok(back.find(x => x.item_name === 'Claim done').demand_no, 'the old demand number is kept');
  // clear with backup: Supplier Claim
  const s = await run(h, 'claim', true);
  assert.equal((await backup(h, 'clear', {id: s.id})).cleared, 1);
  assert.equal((await one(h, "select count(*)::int n from wlf_private.damage_demands where item_name='Claim done'")).n, 0);
  void pending; void received; void claimOpen; void claimDone; void no;
});

test('Excel backup history: delete one row, or all rows with a typed confirmation; Super Admin only', async t => {
  const {h} = await prepare(t);
  const a = await run(h, 'project', false), b = await run(h, 'damage', false), c = await run(h, 'claim', false);
  assert.equal((await backup(h, 'history', {})).length, 3);
  assert.equal((await backup(h, 'deleteHistory', {id: a.id})).deleted, 1);
  assert.deepEqual((await backup(h, 'history', {})).map(r => r.id).sort(), [b.id, c.id].sort());
  await assert.rejects(backup(h, 'deleteHistory', {all: true}), /Type DELETE/);
  await assert.rejects(backup(h, 'deleteHistory', {all: true, confirm: 'delete'}), /Type DELETE/);
  await assert.rejects(backup(h, 'deleteHistory', {all: true, confirm: 'DELETE'}, 'rni'), /Super Admin only/);
  assert.equal((await backup(h, 'deleteHistory', {all: true, confirm: 'DELETE'})).deleted, 2);
  assert.equal((await backup(h, 'history', {})).length, 0);
});

test('QMS: a deleted lift goes to the Recycle bin; restore brings it back, deleting from the bin removes it for good', async t => {
  const {h} = await prepare(t);
  await give(h, 'rni', 'qms:components', 'qms:edit', 'qms:delete');
  const rows = (await h.rpc('sa', 'getCatalogue')).rows.filter(r => r.model === 'MOT 7.5 kW' && r.itemCode);
  const saved = await h.rpc('rni', 'saveQmsLift', [lift({liftId: 'WRONG-1', items: rows.slice(0, 2).map(r => ({catalogueId: r.id, section: 'control', serial: 'S'}))})]);
  await h.rpc('rni', 'deleteQmsLift', [{id: saved.id}]);
  assert.equal((await h.rpc('rni', 'getQmsLifts', [{}])).rows.length, 0);
  let bin = await h.rpc('sa', 'getRecycleBin');
  const item = bin.items.find(x => x.kind === 'qms-lift');
  assert.ok(item, 'the lift is in the Recycle bin');
  assert.equal(item.label, 'WRONG-1');
  assert.match(item.detail, /Eden Tower/);
  await assert.rejects(h.rpc('rni', 'getRecycleBin'), /Super Admin only/);
  // restore
  await h.rpc('sa', 'restoreRecycleItem', [{id: item.id}]);
  assert.equal((await h.rpc('rni', 'getQmsLifts', [{}])).rows.length, 1);
  assert.equal((await h.rpc('sa', 'getRecycleBin')).items.filter(x => x.kind === 'qms-lift').length, 0);
  assert.equal((await h.rpc('rni', 'getQmsLift', [{id: saved.id}])).parts.length, 2, 'parts come back with the lift');
  // delete again, then delete permanently
  await h.rpc('rni', 'deleteQmsLift', [{id: saved.id}]);
  bin = await h.rpc('sa', 'getRecycleBin');
  const again = bin.items.find(x => x.kind === 'qms-lift');
  await h.rpc('sa', 'purgeRecycleItems', [{ids: [again.id]}]);
  assert.equal((await one(h, 'select count(*)::int n from wlf_private.qms_lifts')).n, 0, 'gone from the database');
  assert.equal((await one(h, 'select count(*)::int n from wlf_private.hw_snap')).n, 0, 'its shared rows are cleaned');
  assert.equal((await h.rpc('sa', 'getRecycleBin')).items.length, 0);
});

test('QMS: restoring a lift whose Lift ID was used again explains what to do', async t => {
  const {h} = await prepare(t);
  await give(h, 'rni', 'qms:components', 'qms:edit', 'qms:delete');
  const first = await h.rpc('rni', 'saveQmsLift', [lift({liftId: 'DUP-1'})]);
  await h.rpc('rni', 'deleteQmsLift', [{id: first.id}]);
  await h.rpc('rni', 'saveQmsLift', [lift({liftId: 'DUP-1', id: crypto.randomUUID()})]);
  const item = (await h.rpc('sa', 'getRecycleBin')).items.find(x => x.kind === 'qms-lift');
  await assert.rejects(h.rpc('sa', 'restoreRecycleItem', [{id: item.id}]), /Cannot restore "DUP-1"/);
});

test('Lifts deleted before v2.6.2 appear in the Recycle bin after the update', async t => {
  let id;
  const {h} = await prepare(t, async h => {
    await give(h, 'rni', 'qms:components', 'qms:edit', 'qms:delete');
    id = (await h.rpc('rni', 'saveQmsLift', [lift({liftId: 'OLD-1'})])).id;
    await h.rpc('rni', 'deleteQmsLift', [{id}]);
  });
  const item = (await h.rpc('sa', 'getRecycleBin')).items.find(x => x.kind === 'qms-lift');
  assert.equal(item.label, 'OLD-1');
});

test('Support data backup history: delete one entry or all entries; Super Admin only', async t => {
  const {h} = await prepare(t);
  const add = () => h.db.query("insert into wlf_private.backup_runs(id,actor,total,cleared,state) values(gen_random_uuid(),$1,3,1,'Cleared') returning id", [IDS.sa]).then(r => r.rows[0].id);
  const a = await add(); await add(); await add();
  const call = (payload, who = 'sa') => h.db.query("select public.wlf_backup_admin('deleteBackupHistory',$1,$2) r", [IDS[who], payload]).then(r => r.rows[0].r);
  assert.equal((await call({id: a})).deleted, 1);
  await assert.rejects(call({all: true}), /Type DELETE/);
  await assert.rejects(call({all: true, confirm: 'DELETE'}, 'rni'), /Super Admin only/);
  assert.equal((await call({all: true, confirm: 'DELETE'})).deleted, 2);
  assert.equal((await one(h, 'select count(*)::int n from wlf_private.backup_runs')).n, 0);
  // the old actions still work through the new wrapper
  assert.ok((await h.db.query("select public.wlf_backup_admin('status',$1,'{}') r", [IDS.sa])).rows[0].r);
});
