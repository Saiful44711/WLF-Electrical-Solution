const test = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {makeDB, IDS} = require('./pg-harness.cjs');

const chain = ['UPDATE_V220','UPDATE_SUPPORT_FORMS_20261107','UPDATE_DAMAGE_DEMAND_20261107','UPDATE_WORKSPACE_20261107','UPDATE_SECTIONS_V230','UPDATE_V240','UPDATE_V250','UPDATE_V251','UPDATE_V252','UPDATE_V253','UPDATE_V254','UPDATE_V255','UPDATE_V256','UPDATE_V257','UPDATE_V258','UPDATE_V259','UPDATE_V260','UPDATE_V261','UPDATE_V262','UPDATE_V263','UPDATE_V264','UPDATE_V265','UPDATE_V266'];
const migration = readFileSync('supabase/UPDATE_V267.sql','utf8');

async function prepare(t) {
  const h = await makeDB();
  t.after(() => h.close());
  for (const file of chain) await h.db.exec(readFileSync('supabase/'+file+'.sql','utf8'));
  const results = await h.db.exec(migration);
  return {h, ready: results.at(-1).rows[0]};
}
const give = (h, who, ...keys) => h.db.query('update public.wlf_profiles set permissions=array_cat(permissions,$2) where id=$1', [IDS[who], keys]);
const SL = {motor: '1', encoder: '2', drive: '3', ups: '4', cartop: '5', cop: '6', copDisplay: '7', avr: 'AV-1', battery: 'B1,B2,B3,B4,B5'};
const lift = (ctrl, extra) => ({id: '44444444-4444-4444-8444-444444444444', revision: 0, liftId: 'V7-1', project: 'Serial Tower', address: 'Dhaka', deliveryDate: '2026-11-24',
  motorType: 'Gearless', liftType: 'Passenger', system: 'MOT', controllerModel: 'MOT 7.5 kW', serials: SL, selection: null, items: [{catalogueId: ctrl, section: 'control'}], ...extra});
const ctrlOf = async h => (await h.rpc('sa', 'getCatalogue')).rows.find(r => r.model === 'MOT 7.5 kW' && r.itemCode).id;

test('v2.6.7 migration is repeatable, reports ready and the new build', async t => {
  const {h, ready} = await prepare(t);
  assert.equal(ready.serials_permission_ready, true);
  assert.equal(Number(ready.avr_15_rows), 15);
  assert.equal(Number(ready.avr_models_with_data), 6);
  assert.equal(ready.v267_ready, true);
  const again = (await h.db.exec(migration)).at(-1).rows[0];
  assert.equal(Number(again.avr_15_rows), 15, 'running again replaces the rows, it does not double them');
  assert.equal((await h.rpc('sa', 'getSession')).build, '2.6.7');
  const perms = await h.rpc('sa', 'getPermissionCatalog').catch(() => null);
  if (perms) assert.ok(JSON.stringify(perms).includes('qms:serials'));
});

test('AVR catalogue: 6 models x 15 rows from the sheet, other sizes left blank', async t => {
  const {h} = await prepare(t);
  const rows = (await h.rpc('sa', 'getCatalogue')).rows.filter(r => r.system === 'AVR');
  for (const kva of [15, 20, 30, 40, 60, 100]) {
    const m = rows.filter(r => r.model === 'AVR ' + kva + ' KVA');
    assert.equal(m.length, 15, kva + ' KVA has 15 rows');
    const full = m.find(r => r.hardware === 'Full AVR');
    assert.ok(full.itemCode && Number(full.value) > 0 && full.brand === 'SAKO' && full.supplier === 'SAKO', kva + ' KVA Full AVR row');
    assert.ok(m.some(r => r.grp === 'Cooling Fan' && /3 Pcs/.test(r.spec)));
  }
  const m15 = rows.filter(r => r.model === 'AVR 15 KVA');
  assert.equal(Number(m15.find(r => r.hardware === 'Full AVR').value), 35944.85);
  assert.equal(m15.find(r => r.hardware === 'Full AVR').itemCode, '314445');
  assert.equal(rows.find(r => r.model === 'AVR 40 KVA' && r.hardware === 'Full AVR').itemCode, '187765');
  const blank = rows.filter(r => r.model === 'AVR 80 KVA');
  assert.ok(blank.length > 0 && blank.every(r => !r.hardware && !r.itemCode), '80 KVA stays blank');
});

test('Address, motor type and lift type are required by the server', async t => {
  const {h} = await prepare(t);
  const c = await ctrlOf(h);
  await assert.rejects(h.rpc('sa', 'saveQmsLift', [lift(c, {address: ' '})]), /Enter the address/);
  await assert.rejects(h.rpc('sa', 'saveQmsLift', [lift(c, {motorType: ''})]), /Select the motor type/);
  await assert.rejects(h.rpc('sa', 'saveQmsLift', [lift(c, {liftType: ''})]), /Select the lift type/);
  const ok = await h.rpc('sa', 'saveQmsLift', [lift(c, {})]);
  assert.equal(ok.address, 'Dhaka');
  assert.equal(ok.serials.battery, 'B1,B2,B3,B4,B5');
  await assert.rejects(h.rpc('sa', 'saveQmsLift', [lift(c, {id: '55555555-5555-4555-8555-555555555555', liftId: 'V7-2', serials: {...SL, battery: 'x'.repeat(201)}})]), /200 characters/);
});

test('every item of the chosen AVR model is saved with the lift', async t => {
  const {h} = await prepare(t);
  const cat = (await h.rpc('sa', 'getCatalogue')).rows;
  const avr = cat.filter(r => r.system === 'AVR' && r.model === 'AVR 30 KVA');
  const saved = await h.rpc('sa', 'saveQmsLift', [lift(await ctrlOf(h), {items: [{catalogueId: cat.find(r => r.model === 'MOT 7.5 kW' && r.itemCode).id, section: 'control'}, ...avr.map(r => ({catalogueId: r.id, section: 'avr'}))]})]);
  const parts = saved.parts.filter(p => p.section === 'avr');
  assert.equal(parts.length, 15);
  assert.ok(parts.every(p => p.model === 'AVR 30 KVA'));
  assert.equal(parts.find(p => p.hardware === 'Full AVR').code, '231085');
});

test('Serial numbers are shown, listed and downloaded only with the serials permission; others keep stored values', async t => {
  const {h} = await prepare(t);
  const c = await ctrlOf(h);
  await h.rpc('sa', 'saveQmsLift', [lift(c, {})]);
  const id = lift(c, {}).id;
  await give(h, 'admin', 'qms:components', 'qms:edit');
  await h.db.query("update public.wlf_profiles set workspace_update=true where id=$1", [IDS.admin]).catch(() => {});
  const asSa = await h.rpc('sa', 'getQmsLift', [{id}]);
  assert.equal(asSa.serialsHidden, false);
  assert.equal(asSa.serials.avr, 'AV-1');
  const hidden = await h.rpc('admin', 'getQmsLift', [{id}]);
  assert.equal(hidden.serialsHidden, true);
  assert.deepEqual(hidden.serials, {}, 'no serial number reaches this account');
  const full = await h.rpc('admin', 'getQmsLifts', [{full: true}]);
  assert.deepEqual(full.rows[0].serials ?? {}, {}, 'the paged download has none either');
  assert.equal(full.rows[0].serialsHidden, true);
  // editing without the permission: blank serial fields keep the stored ones, a typed one replaces only that one
  const edited = await h.rpc('admin', 'saveQmsLift', [lift(c, {revision: hidden.revision, project: 'Renamed Tower', serials: {avr: 'AV-2'}})]);
  assert.equal(edited.serialsHidden, true);
  const after = await h.rpc('sa', 'getQmsLift', [{id}]);
  assert.equal(after.project, 'Renamed Tower');
  assert.deepEqual(after.serials, {...SL, avr: 'AV-2'});
  await give(h, 'admin', 'qms:serials');
  const now = await h.rpc('admin', 'getQmsLift', [{id}]);
  assert.equal(now.serialsHidden, false);
  assert.equal(now.serials.battery, 'B1,B2,B3,B4,B5');
});

test('QMS Data filter by Recorded from / to and paged full download', async t => {
  const {h} = await prepare(t);
  const c = await ctrlOf(h);
  const ids = ['66666666-6666-4666-8666-666666666661', '66666666-6666-4666-8666-666666666662', '66666666-6666-4666-8666-666666666663'];
  for (const [i, id] of ids.entries()) await h.rpc('sa', 'saveQmsLift', [lift(c, {id, liftId: 'P-' + i})]);
  await h.db.query("update wlf_private.qms_lifts set created_at='2026-10-05 10:00+06' where lift_id='P-0'");
  await h.db.query("update wlf_private.qms_lifts set created_at='2026-11-10 10:00+06' where lift_id='P-1'");
  await h.db.query("update wlf_private.qms_lifts set created_at='2026-11-20 10:00+06' where lift_id='P-2'");
  const ids2 = async f => (await h.rpc('sa', 'getQmsLifts', [{full: true, ...f}])).rows.map(r => r.liftId);
  assert.deepEqual(await ids2({}), ['P-0', 'P-1', 'P-2'], 'oldest first');
  assert.deepEqual(await ids2({from: '2026-11-01'}), ['P-1', 'P-2']);
  assert.deepEqual(await ids2({from: '2026-11-01', to: '2026-11-10'}), ['P-1']);
  assert.deepEqual(await ids2({to: '2026-10-31'}), ['P-0']);
  const page = await h.rpc('sa', 'getQmsLifts', [{full: true, offset: 1}]);
  assert.deepEqual(page.rows.map(r => r.liftId), ['P-1', 'P-2']);
  assert.equal(page.more, false);
  await assert.rejects(h.rpc('sa', 'getQmsLifts', [{from: '2026-12-01', to: '2026-11-01'}]), /From date must not be after/);
});
