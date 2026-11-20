const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {readFileSync} = require('node:fs');
const {makeDB, IDS} = require('./pg-harness.cjs');
const C = require('../shared/access-core.js');

const chain = ['UPDATE_V220','UPDATE_SUPPORT_FORMS_20261107','UPDATE_DAMAGE_DEMAND_20261107','UPDATE_WORKSPACE_20261107','UPDATE_SECTIONS_V230','UPDATE_V240','UPDATE_V250','UPDATE_V251','UPDATE_V252','UPDATE_V253','UPDATE_V254','UPDATE_V255','UPDATE_V256','UPDATE_V257','UPDATE_V258'];
const migration = readFileSync('supabase/UPDATE_V259.sql','utf8');
const TEAMS = ['commissioning','aftersales','production','qc','maintenance'];

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
const fill = (form, extra = {}) => ({...Object.fromEntries(form.fields.filter(f => !f.autoFill && !f.dependsOn && f.type !== 'checkbox').map(f => [f.id,
  f.type === 'multi' ? f.options.slice(0, 1) : f.type === 'date' ? '2026-11-17' : f.type === 'number' ? '12' : f.options?.[0] || 'Fixture'])), ...extra});
const create = async (h, category, values, who = 'user') => {
  const form = (await h.rpc(who, 'getSupportWorkspace', [{category}])).forms[category];
  return (await h.rpc(who, 'createSupportRequest', [{category, formRevision: form.revision, values: fill(form, values), mutationId: crypto.randomUUID()}])).ticket;
};
const forms = async h => (await h.rpc('sa', 'getSupportWorkspace')).forms;


const give = (h, who, ...keys) => h.db.query('update public.wlf_profiles set permissions=array_cat(permissions,$2) where id=$1', [IDS[who], keys]);
const lift = (extra = {}) => ({id: crypto.randomUUID(), liftId: 'L-100', project: 'Eden Tower', address: 'Dhaka', deliveryDate: '2026-11-25',
  motorType: 'Gearless', liftType: 'Passenger', system: 'MOT', controllerModel: 'MOT 7.5 kW', serials: {drive: 'D-1'},
  selection: {inputs: {capacity: 1000}}, items: [], ...extra});
const count = (cat, system, model) => cat.rows.filter(r => r.system === system && r.model === model).length;

test('v2.5.9 migration is repeatable, seeds the catalogue and adds the AVR sizes', async t => {
  const {h, ready} = await prepare(t);
  assert.equal(ready.avr_sizes, 8);
  assert.equal(ready.qms_lifts_ready, true);
  assert.equal(ready.v259_ready, true);
  assert.equal(ready.controller_rows, 414);
  assert.deepEqual((await h.db.exec(migration)).at(-1).rows[0], ready, 'second run changes nothing');
  assert.equal((await h.rpc('sa', 'getSession')).build, '2.5.9');
  const cat = await h.rpc('sa', 'getCatalogue');
  assert.equal(cat.canEdit, true);
  assert.equal(count(cat, 'MOT', 'MOT 7.5 kW'), 31);
  assert.equal(count(cat, 'NICE3000+', 'NICE3000+ 45 kW'), 24, 'the four mislabelled encoder rows belong to 45 kW');
  assert.equal(count(cat, 'NICE3000+', 'NICE3000+ 11 kW'), 24);
  for (const k of [15, 20, 30, 40, 60, 80, 100, 120]) assert.equal(count(cat, 'AVR', `AVR ${k} KVA`), 10);
  assert.ok(cat.map.some(m => m.keyword === 'drive'));
  const catalog = (await h.rpc('sa', 'listAppUsers')).catalog.map(p => p.key);
  for (const k of ['qms:edit', 'qms:delete', 'catalogue:edit']) assert.ok(catalog.includes(k), k);
});

test('catalogue: only Super Admin or a ticked person can change it; readers are limited', async t => {
  const {h} = await prepare(t);
  await assert.rejects(h.rpc('user', 'getCatalogue'), /Catalogue access required/);
  await give(h, 'rni', 'damage:demand');
  assert.equal((await h.rpc('rni', 'getCatalogue')).canEdit, false);
  await assert.rejects(h.rpc('rni', 'saveCatalogueRow', [{system: 'AVR', model: 'AVR 20 KVA', itemName: 'x'}]), /edit permission required/);
  const row = (await h.rpc('sa', 'getCatalogue')).rows.find(r => r.model === 'AVR 20 KVA');
  const saved = await h.rpc('sa', 'saveCatalogueRow', [{...row, itemName: 'AVR Servo 20 KVA', itemCode: '900001', spec: '3 Phase', brand: 'X', supplier: 'Y', value: '1250.50'}]);
  assert.equal(saved.revision, 2);
  await assert.rejects(h.rpc('sa', 'saveCatalogueRow', [{...row, itemName: 'stale'}]), /CONFLICT/);
  await give(h, 'admin', 'catalogue:edit');
  const added = await h.rpc('admin', 'saveCatalogueRow', [{system: 'MOT', model: 'MOT 45 kW', hardware: 'Drive', itemCode: '1'}]);
  assert.equal(added.model, 'MOT 45 kW');
  await h.rpc('admin', 'deleteCatalogueRow', [{id: added.id}]);
  assert.equal((await h.rpc('sa', 'getCatalogue')).rows.some(r => r.id === added.id), false);
  await h.rpc('sa', 'newCatalogueModel', [{system: 'MOT', model: 'MOT 55 kW', copyFrom: 'MOT 7.5 kW'}]);
  assert.equal(count(await h.rpc('sa', 'getCatalogue'), 'MOT', 'MOT 55 kW'), 31);
  await assert.rejects(h.rpc('sa', 'newCatalogueModel', [{system: 'MOT', model: 'mot 55 kw'}]), /already exists/);
  await h.rpc('sa', 'renameCatalogueModel', [{system: 'MOT', from: 'MOT 55 kW', to: 'MOT 56 kW'}]);
  await h.rpc('sa', 'deleteCatalogueModel', [{system: 'MOT', model: 'MOT 56 kW'}]);
  assert.equal(count(await h.rpc('sa', 'getCatalogue'), 'MOT', 'MOT 56 kW'), 0);
  const imp = await h.rpc('sa', 'importCatalogue', [{rows: [{system: 'AVR', model: 'AVR 15 KVA', itemName: 'Imported', value: 'abc'}, {system: '', model: ''}]}]);
  assert.equal(imp.imported, 1);
});

test('QMS lift records: unique Lift ID, snapshot of parts, edit and delete need their own tick', async t => {
  const {h} = await prepare(t);
  const rows = (await h.rpc('sa', 'getCatalogue')).rows.filter(r => r.model === 'MOT 7.5 kW' && r.itemCode);
  const items = rows.slice(0, 3).map((r, i) => ({catalogueId: r.id, section: 'control', serial: 'S' + i}));
  await assert.rejects(h.rpc('rni', 'saveQmsLift', [lift()]), /QMS access required/);
  await give(h, 'rni', 'qms:components');
  await give(h, 'rni2', 'qms:components');
  const first = lift({items});
  const saved = await h.rpc('rni', 'saveQmsLift', [first]);
  assert.equal(saved.parts.length, 3);
  assert.equal(saved.parts[0].serial, 'S0');
  assert.equal(saved.canEdit, false);
  await assert.rejects(h.rpc('rni2', 'saveQmsLift', [lift()]), /Lift ID already exists/);
  await assert.rejects(h.rpc('rni2', 'saveQmsLift', [lift({liftId: ' l-100 '})]), /Lift ID already exists/, 'case and spaces do not make a new ID');
  await assert.rejects(h.rpc('rni', 'saveQmsLift', [lift({id: first.id, revision: 1, project: 'Changed'})]), /edit permission required/);
  await h.rpc('rni2', 'saveQmsLift', [lift({id: crypto.randomUUID(), liftId: 'L-101', project: 'Sky Plaza'})]);
  // later catalogue changes never rewrite the saved record
  await h.rpc('sa', 'saveCatalogueRow', [{...rows[0], itemName: 'RENAMED LATER'}]);
  const again = await h.rpc('rni', 'getQmsLift', [{id: first.id}]);
  assert.notEqual(again.parts[0].name, 'RENAMED LATER');
  await give(h, 'rni', 'qms:edit');
  const edited = await h.rpc('rni', 'saveQmsLift', [{...first, project: 'Eden Tower 2', revision: 1}]);
  assert.equal(edited.revision, 2);
  assert.equal(edited.history.at(-1).action, 'edited');
  assert.ok(edited.history.at(-1).changed.includes('Project'));
  await assert.rejects(h.rpc('rni', 'saveQmsLift', [{...first, project: 'Stale', revision: 1}]), /CONFLICT/);
  await assert.rejects(h.rpc('rni', 'saveQmsLift', [{...first, liftId: 'L-101', revision: 2}]), /Lift ID already exists/);
  await assert.rejects(h.rpc('rni', 'deleteQmsLift', [{id: first.id}]), /delete permission required/);
  const search = await h.rpc('rni', 'getQmsLifts', [{liftId: 'l-10'}]);
  assert.equal(search.rows.length, 2);
  assert.equal((await h.rpc('rni', 'getQmsLifts', [{itemCode: rows[1].itemCode}])).rows.length, 1);
  await give(h, 'rni', 'qms:delete');
  await h.rpc('rni', 'deleteQmsLift', [{id: first.id}]);
  assert.equal((await h.rpc('rni', 'getQmsLifts', [{liftId: 'L-100'}])).rows.length, 0);
  await h.rpc('rni', 'saveQmsLift', [lift({id: crypto.randomUUID()})]);
  await assert.rejects(h.as('user', () => h.db.query('select * from wlf_private.qms_lifts')), /permission denied/);
});

test('Raise Damage Demand takes the item from the catalogue; manual entry needs the explicit flag', async t => {
  const {h} = await prepare(t);
  const part = (await h.rpc('sa', 'getCatalogue')).rows.find(r => r.model === 'NICE3000+ 11 kW' && r.itemCode === '522404');
  const original = await create(h, 'commissioning', {project: 'Bayside', lift: '777', problem_category: 'MOTCUBE drive error', problem_sub: 'H6'});
  const received = (await h.rpc('rni', 'transitionSupportRequest', [{id: original.id, revision: original.revision, action: 'receive', mutationId: crypto.randomUUID()}])).ticket;
  await give(h, 'rni', 'damage:demand');
  const base = {id: received.id, revision: received.revision, operation: crypto.randomUUID(), quantity: '2', durationMinutes: '5', solutionStatement: 'Replace the card.'};
  await assert.rejects(h.rpc('rni', 'createDamageDemand', [{...base, itemName: 'typed'}]), /Hardware Catalogue/);
  await assert.rejects(h.rpc('rni', 'createDamageDemand', [{...base, catalogId: crypto.randomUUID()}]), /no longer in the catalogue/);
  const made = await h.rpc('rni', 'createDamageDemand', [{...base, catalogId: part.id, itemName: 'forged', itemCode: 'forged'}]);
  const row = (await h.db.query('select item_name,item_code,item_spec,component_model,supplier,brand,catalog_id from wlf_private.damage_demands where request_id=$1', [received.id])).rows[0];
  assert.equal(row.item_code, '522404');
  assert.match(row.item_name, /PG Card/);
  assert.match(row.item_spec, /Model: NICE3000\+ 11 kW/);
  assert.equal(row.component_model, 'NICE3000+ 11 kW');
  assert.equal(row.supplier, 'Monarch');
  assert.equal(row.catalog_id, part.id);
  assert.ok(made);
});

test('Management dashboard QMS card counts the new lift records', async t => {
  const {h} = await prepare(t);
  await give(h, 'rni', 'qms:components');
  await give(h, 'admin', 'workspace:dashboard');
  await h.rpc('rni', 'saveQmsLift', [lift({liftId: 'L-1'})]);
  await h.rpc('rni', 'saveQmsLift', [lift({id: crypto.randomUUID(), liftId: 'L-2'})]);
  const data = await h.rpc('admin', 'getManagementDashboard', [{}]);
  assert.equal(Number(data.qms.total), 2);
  assert.equal(Number(data.qms.lifts), 2);
  assert.equal(data.qms.people.length, 1);
});
