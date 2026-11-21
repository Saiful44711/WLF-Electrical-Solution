const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {readFileSync} = require('node:fs');
const {makeDB, IDS} = require('./pg-harness.cjs');
const C = require('../shared/access-core.js');

const chain = ['UPDATE_V220','UPDATE_SUPPORT_FORMS_20261107','UPDATE_DAMAGE_DEMAND_20261107','UPDATE_WORKSPACE_20261107','UPDATE_SECTIONS_V230','UPDATE_V240','UPDATE_V250','UPDATE_V251','UPDATE_V252','UPDATE_V253','UPDATE_V254','UPDATE_V255','UPDATE_V256','UPDATE_V257','UPDATE_V258','UPDATE_V259','UPDATE_V260'];
const migration = readFileSync('supabase/UPDATE_V261.sql','utf8');
const TEAMS = ['commissioning','aftersales','production','qc','maintenance'];


async function prepare(t, before) {
  const h = await makeDB();
  t.after(() => h.close());
  for (const file of chain) await h.db.exec(readFileSync('supabase/'+file+'.sql','utf8'));
  await h.db.query('alter table public.wlf_profiles disable trigger wlf_deletion_guard');
  for (const [who, emp, section] of [['sa','SA-1','R&I Electrical'],['rni','RN-3','R&I Electrical'],['rni2','RN-4','R&I Mechanical']])
    await h.db.query('update public.wlf_profiles set employee_id=$2, section=$3 where id=$1', [IDS[who], emp, section]);
  await h.db.query('alter table public.wlf_profiles enable trigger wlf_deletion_guard');
  if (before) await before(h);
  const results = await h.db.exec(migration);
  return {h, ready: results.at(-1).rows[0]};
}
const give = (h, who, ...keys) => h.db.query('update public.wlf_profiles set permissions=array_cat(permissions,$2) where id=$1', [IDS[who], keys]);
const lift = (extra = {}) => ({id: crypto.randomUUID(), liftId: 'L-100', project: 'Eden Tower', address: 'Dhaka', deliveryDate: '2026-11-25',
  motorType: 'Gearless', liftType: 'Passenger', system: 'MOT', controllerModel: 'MOT 7.5 kW',
  serials: {motor:'M',encoder:'E',drive: 'D-1',ups:'U',cartop:'C',cop:'P',copDisplay:'X'},
  selection: {inputs: {capacity: 1000}, categories: [{title: 'Selected Motor Data', items: [{label: 'Motor Model', value: 'MCK'}]}]}, items: [], ...extra});

test('v2.6.1 migration is repeatable and converts old QMS lifts without changing what they show', async t => {
  let before;
  const {h, ready} = await prepare(t, async h => {
    await give(h, 'rni', 'qms:components');
    const rows = (await h.rpc('sa', 'getCatalogue')).rows.filter(r => r.model === 'MOT 7.5 kW' && r.itemCode);
    const saved = await h.rpc('rni', 'saveQmsLift', [lift({items: rows.slice(0, 3).map((r, i) => ({catalogueId: r.id, section: 'control', serial: 'S' + i}))})]);
    // saved by the v2.6.0 code: full copy of every part
    before = await h.rpc('rni', 'getQmsLift', [{id: saved.id}]);
  });
  assert.equal(ready.v261_ready, true);
  assert.equal(Number(ready.unconverted_parts), 0);
  assert.ok(Number(ready.shared_rows) >= 3);
  assert.equal(Number(ready.qms_lifts), 1);
  const [{id}] = (await h.db.query('select id from wlf_private.qms_lifts')).rows;
  const after = await h.rpc('rni', 'getQmsLift', [{id}]);
  assert.deepEqual(after.parts, before.parts);
  assert.deepEqual(after.selection, before.selection);
  const raw = (await h.db.query('select parts, selection from wlf_private.qms_lifts')).rows[0];
  assert.ok(raw.parts.every(p => p.h && !p.name && !p.code), 'the lift row keeps only references');
  const again = await h.db.exec(migration);
  assert.equal(again.at(-1).rows[0].v261_ready, true);
  assert.equal((await h.rpc('sa', 'getSession')).build, '2.6.1');
});

test('v2.6.1 shared snapshots: same data is stored once, old lifts keep their day, new lifts follow the catalogue', async t => {
  const {h} = await prepare(t);
  await give(h, 'rni', 'qms:components', 'qms:edit');
  const rows = (await h.rpc('sa', 'getCatalogue')).rows.filter(r => r.model === 'MOT 7.5 kW' && r.itemCode);
  const items = rows.slice(0, 3).map((r, i) => ({catalogueId: r.id, section: 'control', serial: 'S' + i}));
  const a = await h.rpc('rni', 'saveQmsLift', [lift({items})]);
  const sharedAfterOne = Number((await h.db.query('select count(*) n from wlf_private.hw_snap')).rows[0].n);
  const b = await h.rpc('rni', 'saveQmsLift', [lift({id: crypto.randomUUID(), liftId: 'L-200', items})]);
  assert.equal(Number((await h.db.query('select count(*) n from wlf_private.hw_snap')).rows[0].n), sharedAfterOne, 'a second lift with the same data adds no copies');
  assert.equal(a.parts[0].name, b.parts[0].name);
  assert.equal(a.parts[0].catalogueId, rows[0].id);
  assert.equal(a.selection.categories[0].items[0].value, 'MCK');
  // the catalogue changes: the old lift keeps its data, a lift saved now gets the new data
  await h.rpc('sa', 'saveCatalogueRow', [{...rows[0], itemName: 'RENAMED LATER', value: 99}]);
  assert.notEqual((await h.rpc('rni', 'getQmsLift', [{id: a.id}])).parts[0].name, 'RENAMED LATER');
  const c = await h.rpc('rni', 'saveQmsLift', [lift({id: crypto.randomUUID(), liftId: 'L-300', items})]);
  assert.equal(c.parts[0].name, 'RENAMED LATER');
  assert.equal(Number(c.parts[0].value), 99);
  // editing only the project does not flag Components as changed; re-saving after the catalogue change does
  const e1 = await h.rpc('rni', 'saveQmsLift', [{...lift({items}), id: a.id, liftId: 'L-100', project: 'Eden 2', revision: 1}]);
  
  assert.equal(e1.parts[0].name, 'RENAMED LATER', 'an edited lift follows the catalogue of that day');
  assert.ok(e1.history.at(-1).changed.includes('Project'));
  const e2 = await h.rpc('rni', 'saveQmsLift', [{...lift({items}), id: a.id, liftId: 'L-100', project: 'Eden 2', revision: e1.revision}]);
  assert.equal(e2.history.at(-1).changed.length, 0, 'saving the same data again changes nothing');
  assert.equal((await h.rpc('rni', 'getQmsLifts', [{itemCode: rows[1].itemCode}])).rows.length, 3, 'search by item code still works');
  const size = (await h.db.query('select pg_column_size(parts)+pg_column_size(selection) s from wlf_private.qms_lifts where id=$1', [a.id])).rows[0].s;
  assert.ok(Number(size) < 1500, 'a lift row is small: ' + size);
});

test('v2.6.1 Storage & Backup: usage per table, catalogue and QMS backup and restore, Super Admin only', async t => {
  const {h} = await prepare(t);
  await give(h, 'rni', 'qms:components');
  const rows = (await h.rpc('sa', 'getCatalogue')).rows.filter(r => r.model === 'MOT 7.5 kW' && r.itemCode);
  const items = rows.slice(0, 3).map((r, i) => ({catalogueId: r.id, section: 'control', serial: 'S' + i}));
  const a = await h.rpc('rni', 'saveQmsLift', [lift({items})]);
  await h.rpc('rni', 'saveQmsLift', [lift({id: crypto.randomUUID(), liftId: 'L-201', items})]);
  for (const act of ['adminDataUsage', 'adminExportData', 'adminImportData']) await assert.rejects(h.rpc('rni', act, [{kind: 'qms', rows: []}]), /Permission denied/);
  const usage = await h.rpc('sa', 'adminDataUsage');
  const names = usage.tables.map(x => x.table);
  for (const n of ['wlf_private.qms_lifts', 'wlf_private.hw_catalogue', 'wlf_private.hw_snap', 'public.wlf_components']) assert.ok(names.includes(n), n);
  assert.ok(Number(usage.tables.find(x => x.table === 'wlf_private.hw_catalogue').rows) > 300);
  // catalogue backup / restore
  const cat = await h.rpc('sa', 'adminExportData', [{kind: 'catalogue'}]);
  assert.ok(cat.rows.length > 300 && Array.isArray(cat.suggest));
  const victim = cat.rows.find(r => r.model === 'MOT 7.5 kW' && r.item_code);
  await h.db.query('delete from wlf_private.hw_catalogue where id=$1', [victim.id]);
  await h.db.query("update wlf_private.hw_catalogue set item_name='CHANGED' where id=$1", [cat.rows.find(r => r.id !== victim.id && r.item_name).id]);
  const back = await h.rpc('sa', 'adminImportData', [{kind: 'catalogue', rows: cat.rows, suggest: cat.suggest}]);
  assert.equal(back.added, 1);
  assert.ok(back.updated > 300);
  assert.equal(Number((await h.db.query('select count(*) n from wlf_private.hw_catalogue where id=$1', [victim.id])).rows[0].n), 1);
  await assert.rejects(h.rpc('sa', 'adminImportData', [{kind: 'catalogue', rows: [{id: crypto.randomUUID()}]}]), /not a Hardware Catalogue backup/);
  // QMS backup / restore
  const q = await h.rpc('sa', 'adminExportData', [{kind: 'qms', offset: 0, limit: 1}]);
  assert.equal(q.total, 2);
  assert.equal(q.rows.length, 1);
  assert.ok(q.rows[0].parts[0].code, 'the file holds readable data, not references');
  const q2 = await h.rpc('sa', 'adminExportData', [{kind: 'qms', offset: 1, limit: 5}]);
  assert.equal(q2.rows.length, 1);
  assert.notEqual(q.rows[0].id, q2.rows[0].id);
  const same = await h.rpc('sa', 'adminImportData', [{kind: 'qms', rows: [...q.rows, ...q2.rows]}]);
  assert.deepEqual([same.added, same.skipped], [0, 2], 'restoring over existing lifts changes nothing');
  await h.db.query('delete from wlf_private.qms_lifts');
  const restored = await h.rpc('sa', 'adminImportData', [{kind: 'qms', rows: [...q.rows, ...q2.rows]}]);
  assert.deepEqual([restored.added, restored.skipped], [2, 0]);
  const got = await h.rpc('rni', 'getQmsLift', [{id: a.id}]);
  assert.equal(got.parts.length, 3);
  assert.equal(got.parts[0].serial, 'S0');
  assert.equal(got.selection.categories[0].items[0].value, 'MCK');
  const raw = (await h.db.query('select parts from wlf_private.qms_lifts where id=$1', [a.id])).rows[0];
  assert.ok(raw.parts.every(p => p.h && !p.name), 'restored lifts are stored as references too');
});
