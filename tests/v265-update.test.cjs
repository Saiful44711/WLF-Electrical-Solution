const test = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {makeDB} = require('./pg-harness.cjs');

const chain = ['UPDATE_V220','UPDATE_SUPPORT_FORMS_20261107','UPDATE_DAMAGE_DEMAND_20261107','UPDATE_WORKSPACE_20261107','UPDATE_SECTIONS_V230','UPDATE_V240','UPDATE_V250','UPDATE_V251','UPDATE_V252','UPDATE_V253','UPDATE_V254','UPDATE_V255','UPDATE_V256','UPDATE_V257','UPDATE_V258','UPDATE_V259','UPDATE_V260','UPDATE_V261','UPDATE_V262','UPDATE_V263','UPDATE_V264'];
const migration = readFileSync('supabase/UPDATE_V265.sql', 'utf8');
async function prepare(t) {
  const h = await makeDB();
  t.after(() => h.close());
  for (const file of chain) await h.db.exec(readFileSync('supabase/' + file + '.sql', 'utf8'));
  const results = await h.db.exec(migration);
  return {h, ready: results.at(-1).rows[0]};
}
const SL = {motor: '1', encoder: '2', drive: '3', ups: '4', cartop: '5', cop: '6', copDisplay: '7'};
const paid = (cat, sys) => cat.rows.filter(r => r.system === sys && r.model === 'Paid feature');

test('v2.6.5 migration seeds the paid feature rows once and is repeatable', async t => {
  const {h, ready} = await prepare(t);
  assert.equal(Number(ready.mot_paid_rows), 12);
  assert.equal(Number(ready.nice_paid_rows), 18);
  assert.equal(ready.paid_note_ready, true);
  assert.equal(ready.v265_ready, true);
  const again = (await h.db.exec(migration)).at(-1).rows[0];
  assert.equal(Number(again.mot_paid_rows), 12, 'running again adds nothing');
  assert.equal((await h.rpc('sa', 'getSession')).build, '2.6.5');
  const cat = await h.rpc('sa', 'getCatalogue');
  const mot = paid(cat, 'MOT'), nice = paid(cat, 'NICE3000+');
  assert.equal(mot.filter(r => r.grp === 'Remote Alarm').length, 4);
  assert.equal(mot.find(r => r.grp === 'Cloud Monitoring').itemCode, '190727');
  assert.equal(nice.filter(r => r.grp === 'Regenerative drive').length, 7);
  assert.equal(nice.find(r => r.spec === '15 kW').itemCode, '494757');
  assert.equal(Number(mot.find(r => r.grp === 'Voice Announcer').value), 4610.48);
  assert.ok(mot.every(r => r.hardware), 'every row has a name, so it can be selected');
});

test('a lift saves paid feature rows and an optional special note, and edits are tracked', async t => {
  const {h} = await prepare(t);
  const cat = await h.rpc('sa', 'getCatalogue');
  const ctrl = cat.rows.find(r => r.model === 'MOT 7.5 kW' && r.itemCode);
  const alarms = paid(cat, 'MOT').filter(r => r.grp === 'Remote Alarm');
  const lift = extra => ({id: '11111111-1111-4111-8111-111111111111', revision: 0, liftId: 'P-1', project: 'Paid Tower', deliveryDate: '2026-11-23', motorType: 'Gearless',
    liftType: 'Passenger', system: 'MOT', controllerModel: 'MOT 7.5 kW', serials: SL, selection: null,
    items: [{catalogueId: ctrl.id, section: 'control'}, ...alarms.map(r => ({catalogueId: r.id, section: 'paid'}))], ...extra});
  const saved = await h.rpc('sa', 'saveQmsLift', [lift({paidNote: '  Needs GSM SIM  '})]);
  assert.equal(saved.paidNote, 'Needs GSM SIM');
  assert.equal(saved.parts.filter(p => p.section === 'paid').length, 4);
  assert.equal((await h.rpc('sa', 'getQmsLift', [{id: saved.id}])).paidNote, 'Needs GSM SIM');
  const noNote = await h.rpc('sa', 'saveQmsLift', [lift({revision: saved.revision})]);
  assert.equal(noNote.paidNote, '', 'the note is optional');
  assert.deepEqual(noNote.history.at(-1).changed, ['Paid feature note']);
  await assert.rejects(h.rpc('sa', 'saveQmsLift', [lift({revision: noNote.revision, paidNote: 'x'.repeat(501)})]), /too long/);
  await assert.rejects(h.rpc('sa', 'saveQmsLift', [lift({revision: noNote.revision, items: [{catalogueId: ctrl.id, section: 'nope'}]})]), /Invalid component section/);
});

test('the note travels in the JSON backup, restore and the Excel backup data', async t => {
  const {h} = await prepare(t);
  const cat = await h.rpc('sa', 'getCatalogue');
  const ctrl = cat.rows.find(r => r.model === 'MOT 7.5 kW' && r.itemCode);
  const regen = paid(cat, 'NICE3000+').find(r => r.spec === '15 kW');
  const saved = await h.rpc('sa', 'saveQmsLift', [{id: '22222222-2222-4222-8222-222222222222', revision: 0, liftId: 'P-2', project: 'Backup Tower', deliveryDate: '2026-11-23',
    motorType: 'Gearless', liftType: 'Passenger', system: 'NICE3000+', controllerModel: 'NICE', serials: SL, selection: null, paidNote: 'Keep spare', items: [{catalogueId: regen.id, section: 'paid'}]}]);
  assert.equal(saved.paidNote, 'Keep spare');
  const exp = await h.rpc('sa', 'adminExportData', [{kind: 'qms', offset: 0, limit: 50}]);
  const row = exp.rows.find(r => r.lift_id === 'P-2');
  assert.equal(row.paid_note, 'Keep spare');
  assert.equal(row.parts.find(p => p.section === 'paid').spec, '15 kW');
  await h.db.query("delete from wlf_private.qms_lifts where lift_id='P-2'");
  const back = await h.rpc('sa', 'adminImportData', [{kind: 'qms', rows: exp.rows}]);
  assert.ok(back.added >= 1);
  assert.equal((await h.db.query("select paid_note from wlf_private.qms_lifts where lift_id='P-2'")).rows[0].paid_note, 'Keep spare');
});
