const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {readFileSync} = require('node:fs');
const {makeDB, IDS} = require('./pg-harness.cjs');
const C = require('../shared/access-core.js');

const chain = ['UPDATE_V220','UPDATE_SUPPORT_FORMS_20261107','UPDATE_DAMAGE_DEMAND_20261107','UPDATE_WORKSPACE_20261107','UPDATE_SECTIONS_V230','UPDATE_V240','UPDATE_V250','UPDATE_V251','UPDATE_V252','UPDATE_V253','UPDATE_V254','UPDATE_V255','UPDATE_V256','UPDATE_V257','UPDATE_V258','UPDATE_V259'];
const migration = readFileSync('supabase/UPDATE_V260.sql','utf8');
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


const SERIALS = {motor: 'M-1', encoder: 'E-1', drive: 'D-1', ups: 'U-1', cartop: 'C-1', cop: 'P-1', copDisplay: 'S-1'};
const catalogue = async h => (await h.rpc('sa', 'getCatalogue', [{}]));
/* a Problem Category that needs no sub-category, so only the Controller Model rule is under test */
const plain = async (h, category, extra) => {
  const form = (await h.rpc('user', 'getSupportWorkspace', [{category}])).forms[category];
  const sub = form.fields.find(f => f.id === 'problem_sub'), cat = form.fields.find(f => f.id === 'problem_category');
  const free = sub && cat ? cat.options.find(o => !(sub.optionMap?.[o]?.length)) : undefined;
  return create(h, category, {...(free ? {problem_category: free, problem_sub: ''} : {}), ...extra});
};

test('v2.6.0 migration is repeatable: faceplates, MOTCUBE tables and the Controller Model field', async t => {
  const {h, ready} = await prepare(t);
  assert.equal(ready.v260_ready, true);
  assert.equal(ready.mot_faceplates, 6);
  assert.equal(ready.motcube_models, 3);
  assert.ok(ready.forms_with_controller_model >= 3, 'every form with a Control System Brand got the Controller Model');
  const again = (await h.db.exec(migration)).at(-1).rows[0];
  assert.deepEqual(again, ready, 'second run changes nothing');
  const cat = await catalogue(h);
  const names = system => cat.rows.filter(r => r.system === system && r.model === 'COP Faceplate').map(r => r.hardware).sort();
  const want = ['Black Hairline', 'Black Mirror', 'Golden Mirror', 'Hairline', 'Rose Gold Mirror', 'Silver Mirror'];
  assert.deepEqual(names('MOT'), want);
  assert.deepEqual(names('NICE3000+'), want);
  assert.equal(cat.rows.filter(r => r.model === 'COP' && r.grp === 'COP Faceplate').length, 0, 'faceplates left the COP list');
  const cube = cat.rows.filter(r => r.system === 'MOTCUBE');
  assert.deepEqual([...new Set(cube.map(r => r.model))].sort(), ['MOTCUBE 11 kW', 'MOTCUBE 5.5 kW', 'MOTCUBE 7.5 kW']);
  assert.equal(cube.filter(r => r.model === 'MOTCUBE 7.5 kW').length, cat.rows.filter(r => r.system === 'MOT' && r.model === 'MOT 7.5 kW').length);
  assert.ok(cube.every(r => !r.itemCode && !r.itemName && r.value == null), 'MOTCUBE tables are blank');
  assert.equal((await h.rpc('sa', 'getSession')).build, '2.6.0');
});

test('Controller Model: chosen after the Control System Brand, required, and checked on the server', async t => {
  const {h} = await prepare(t);
  const all = await forms(h);
  for (const [category, form] of Object.entries(all)) {
    const ids = form.fields.map(f => f.id);
    if (!ids.includes('controller')) { assert.ok(!ids.includes('controller_model'), category); continue; }
    assert.equal(ids.indexOf('controller_model'), ids.indexOf('controller') + 1, category + ': right after the brand');
    const field = form.fields.find(f => f.id === 'controller_model');
    assert.equal(field.dependsOn, 'controller');
    assert.equal(field.optionMap.MOT.length, 6);
    assert.equal(field.optionMap['NICE3000+'].length, 7);
    assert.deepEqual(field.optionMap.MOTCUBE, ['MOTCUBE 5.5 kW', 'MOTCUBE 7.5 kW', 'MOTCUBE 11 kW']);
  }
  const cat = 'commissioning';
  await assert.rejects(plain(h, cat, {controller: 'MOT', controller_model: ''}), /Required: Controller Model/);
  await assert.rejects(plain(h, cat, {controller: 'MOT', controller_model: 'NICE3000+ 7.5 kW'}), /Invalid choice: Controller Model/);
  const ok = await plain(h, cat, {controller: 'NICE3000+', controller_model: 'NICE3000+ 11 kW'});
  assert.equal(ok.values.controller_model, 'NICE3000+ 11 kW');
  const home = await plain(h, cat, {controller: 'Home Lift', controller_model: ''});
  assert.equal(home.values.controller_model, '', 'brands without a model list need none');
});

test('QMS: every serial number is required and MOTCUBE is not a QMS controller', async t => {
  const {h} = await prepare(t);
  const call = (extra = {}) => h.rpc('sa', 'saveQmsLift', [lift({serials: SERIALS, ...extra})]);
  const saved = await call({liftId: 'L-200'});
  assert.equal(saved.liftId, 'L-200');
  for (const k of Object.keys(SERIALS)) {
    const missing = {...SERIALS, [k]: ''};
    await assert.rejects(call({liftId: 'L-201', serials: missing}), /Enter every serial number/, k);
  }
  await assert.rejects(call({liftId: 'L-202', serials: {drive: 'D-1'}}), /Enter every serial number/);
  await assert.rejects(call({liftId: 'L-203', system: 'MOTCUBE', controllerModel: 'MOTCUBE 7.5 kW'}), /MOTCUBE is not a QMS controller/);
});

test('Components Data CSV import: Super Admin only, whole-table replace, logged', async t => {
  const {h} = await prepare(t);
  const before = (await h.rpc('sa', 'adminGetComponents')).records.length;
  assert.ok(before > 0);
  const headers = (await h.rpc('sa', 'adminGetComponents')).headers;
  const row = (n) => headers.map((x, i) => i === 0 ? 450 : i === 1 ? 1 : i === 2 ? 'MR' : i === 3 ? '2:1' : i === 5 ? 'Model ' + n : 'x');
  for (const who of ['admin', 'rni', 'user']) await assert.rejects(h.rpc(who, 'adminImportComponents', [{rows: [row(1)]}]), /Permission denied/, who);
  await assert.rejects(h.rpc('sa', 'adminImportComponents', [{rows: []}]), /no data rows/);
  await assert.rejects(h.rpc('sa', 'adminImportComponents', [{rows: [row(1).slice(1)]}]), /exactly \d+ columns/);
  await assert.rejects(h.rpc('sa', 'adminImportComponents', [{rows: [row(1).map((x, i) => i === 3 ? '' : x)]}]), /first four columns/);
  assert.equal((await h.rpc('sa', 'adminGetComponents')).records.length, before, 'a rejected file changes nothing');
  const done = await h.rpc('sa', 'adminImportComponents', [{rows: [row(1), row(2), row(3)]}]);
  assert.deepEqual(done, {removed: before, added: 3});
  const now = await h.rpc('sa', 'adminGetComponents');
  assert.equal(now.records.length, 3);
  assert.equal(now.records[0].values[5], 'Model 1');
  const logged = (await h.db.query("select count(*)::int n from wlf_private.component_log where action='Added'")).rows[0].n;
  assert.ok(logged >= 3, 'the change log records the new rows');
});
