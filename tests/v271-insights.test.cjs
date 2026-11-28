const test = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {makeDB, IDS} = require('./pg-harness.cjs');

const chain = ['UPDATE_V220','UPDATE_SUPPORT_FORMS_20261107','UPDATE_DAMAGE_DEMAND_20261107','UPDATE_WORKSPACE_20261107','UPDATE_SECTIONS_V230','UPDATE_V240','UPDATE_V250','UPDATE_V251','UPDATE_V252','UPDATE_V253','UPDATE_V254','UPDATE_V255','UPDATE_V256','UPDATE_V257','UPDATE_V258','UPDATE_V259','UPDATE_V260','UPDATE_V261','UPDATE_V262','UPDATE_V263','UPDATE_V264','UPDATE_V265','UPDATE_V266','UPDATE_V267','UPDATE_V268','UPDATE_V270'];
const migration = readFileSync('supabase/UPDATE_V271.sql','utf8');

async function prepare(t) {
  const h = await makeDB();
  t.after(() => h.close());
  for (const file of chain) await h.db.exec(readFileSync('supabase/'+file+'.sql','utf8'));
  const results = await h.db.exec(migration);
  return {h, ready: results.at(-1).rows[0]};
}
const part = (section, grp, hardware, spec, name, code, extra = {}) => ({section, grp, hardware, spec, name, code, brand: 'B', supplier: 'S', ...extra});
async function lift(h, liftId, project, system, controller, parts, motor, at = '2026-11-10T06:00:00Z', deleted = false) {
  const selection = motor ? {inputs: {capacity: 630}, categories: [{title: 'Motor', items: [{label: 'Motor Brand', value: motor[0]}, {label: 'Motor Model', value: motor[1]}]}]} : null;
  await h.db.query(`insert into wlf_private.qms_lifts(id,lift_id,project,system,controller_model,parts,selection,created_by,created_at,deleted_at)
    values(gen_random_uuid(),$1,$2,$3,$4,wlf_private.qms_parts_pack($5::jsonb),wlf_private.qms_sel_pack($6::jsonb),$7,$8,$9)`,
    [liftId, project, system, controller, JSON.stringify(parts), selection && JSON.stringify(selection), IDS.sa, at, deleted ? at : null]);
}
async function claim(h, item, supplier, qty, confirmAt, receivedAt, catalogueSupplier = '') {
  await h.db.query(`insert into wlf_private.damage_demands(request_id,category,request_reference,requester_id,requester_name,requested_at,project,lift_id,controllers,problem_categories,form_schema,form_values,confirmed_by,confirmed_name,solution_statement,item_name,item_code,item_spec,quantity,create_operation,create_payload_hash,created_at,
      supplier,claim_at,claim_supplier,confirm_at,sc_received_at)
    values(gen_random_uuid(),'aftersales','R-1',$1,'u',now(),'P','1','{NICE3000+}','{Drive}','{}','{}',$1,'rni','fixed',$2,'','',$3,gen_random_uuid(),'\\x00','2026-11-02T05:00:00Z',
      $4,$5,$6,$7,$8)`, [IDS.rni, item, qty, catalogueSupplier, confirmAt || '2026-11-02T06:00:00Z', supplier, confirmAt, receivedAt]);
}

test('v2.7.1 migration is repeatable and reports the new build', async t => {
  const {h, ready} = await prepare(t);
  assert.equal(ready.v271_ready, true);
  assert.equal((await h.db.exec(migration)).at(-1).rows[0].v271_ready, true);
  assert.equal((await h.rpc('sa', 'getSession')).build, '2.7.1');
});

test('QMS dashboard: projects and lifts per control system; category -> model -> projects and Lift IDs', async t => {
  const {h} = await prepare(t);
  const lop = part('lop', 'LOP', 'LOP display W-1', '', 'Hall display', '900');
  const cb = part('control', 'Circuit Breaker', 'Main CB', '25 A', '4 pole MCB', '111');
  const avr = n => Array.from({length: 3}, (_, i) => part('avr', i ? 'Circuit Breaker' : 'AVR 15 KVA', 'Full AVR', '', '', '', {model: 'AVR 15 KVA'}));
  await lift(h, 'L-1', 'Tower A', 'NICE3000+', 'NICE 7.5 kW', [cb, lop, ...avr()], ['Ziehl Abegg', 'SM 190-11B-20']);
  await lift(h, 'L-2', 'Tower A', 'NICE3000+', 'NICE 7.5 kW', [cb, lop], ['Ziehl Abegg', 'SM 190-11B-20']);
  await lift(h, 'L-3', 'Tower B', 'MOT', 'MOT 5.5 kW', [cb], ['Monadrive', 'MCK100-E']);
  await lift(h, 'L-4', 'Old Site', 'MOT', 'MOT 5.5 kW', [cb], null, '2026-09-01T06:00:00Z');
  await lift(h, 'L-5', 'Deleted', 'MOT', 'MOT 5.5 kW', [cb], null, '2026-11-11T06:00:00Z', true);
  const d = await h.rpc('sa', 'getAdminInsights', [{from: '2026-11-01', to: '2026-11-30'}]);
  const q = d.qms;
  assert.equal(q.lifts, 3); assert.equal(q.projects, 2); assert.equal(q.allLifts, 4, 'deleted lifts never count');
  assert.deepEqual(q.systems.map(s => [s.system, s.projects, s.lifts]), [['NICE3000+', 1, 2], ['MOT', 1, 1]]);
  assert.deepEqual(q.systems[0].controllers, [{model: 'NICE 7.5 kW', lifts: 2}]);
  const cat = name => q.categories.find(c => c.category === name);
  assert.deepEqual(q.categories.slice(0, 3).map(c => c.category), ['Controller', 'Motor', 'AVR'], 'controller, motor and AVR first');
  assert.equal(cat('AVR').models[0].lifts, 1, 'an AVR model with many rows counts once per lift');
  assert.equal(cat('AVR').models[0].model, 'AVR 15 KVA');
  assert.ok(!cat('Circuit Breaker').models.some(m => m.model === 'Full AVR'), 'AVR inner rows do not leak into Circuit Breaker');
  const breaker = cat('Circuit Breaker').models[0];
  assert.deepEqual([breaker.model, breaker.code, breaker.lifts, breaker.projects], ['Main CB · 25 A · 4 pole MCB', '111', 3, 2]);
  assert.deepEqual(breaker.sites.map(s => s.liftId).sort(), ['L-1', 'L-2', 'L-3']);
  const motor = cat('Motor').models.find(m => m.model === 'SM 190-11B-20');
  assert.deepEqual([motor.brand, motor.lifts, motor.projects], ['Ziehl Abegg', 2, 1]);
  assert.deepEqual(cat('LOP').models[0].sites.map(s => s.project), ['Tower A', 'Tower A']);
  const all = await h.rpc('sa', 'getAdminInsights', [{from: '2026-11-01', to: '2026-11-30', qmsScope: 'all'}]);
  assert.equal(all.qmsScope, 'all'); assert.equal(all.qms.lifts, 4);
  assert.equal(all.qms.categories.find(c => c.category === 'Circuit Breaker').models[0].lifts, 4);
});

test('Supplier Claim dashboard: Pending / Received, every supplier, the components claimed most', async t => {
  const {h} = await prepare(t);
  await claim(h, 'Brake resistor', 'ARKEL', 2, '2026-11-03T06:00:00Z', null);
  await claim(h, 'Brake resistor', 'ARKEL', 3, '2026-11-04T06:00:00Z', '2026-11-20T06:00:00Z');
  await claim(h, 'Drive', 'ARKEL', 1, '2026-11-05T06:00:00Z', null);
  await claim(h, 'SMPS', '', 4, '2026-11-06T06:00:00Z', null, 'Schneider');
  await claim(h, 'UPS', 'Old Co', 1, '2026-10-06T06:00:00Z', null);            /* October: outside the period, still pending now */
  await claim(h, 'Fan', 'ARKEL', 1, null, null);                                 /* first Yes only: waiting for the second Yes */
  const c = (await h.rpc('sa', 'getAdminInsights', [{from: '2026-11-01', to: '2026-11-30'}])).claims;
  assert.deepEqual([c.claims, c.pending, c.received, c.units, c.waiting, c.pendingNow], [4, 3, 1, 10, 1, 4]);
  assert.deepEqual(c.suppliers.map(s => [s.supplier, s.claims, s.pending, s.received, s.units]), [['ARKEL', 3, 2, 1, 6], ['Schneider', 1, 1, 0, 4]]);
  assert.deepEqual([c.suppliers[0].topItem, c.suppliers[0].topUnits], ['Brake resistor', 5]);
  assert.deepEqual(c.components.map(k => [k.item, k.supplier, k.units]), [['Brake resistor', 'ARKEL', 5], ['SMPS', 'Schneider', 4], ['Drive', 'ARKEL', 1]]);
});

test('Admin Panel dashboards need the Admin Panel permission', async t => {
  const {h} = await prepare(t);
  await assert.rejects(() => h.rpc('user', 'getAdminInsights', [{}]), /Admin Panel access required|not allowed|permission/i);
  await assert.rejects(() => h.rpc('rni', 'getAdminInsights', [{}]), /Admin Panel access required|not allowed|permission/i);
});
