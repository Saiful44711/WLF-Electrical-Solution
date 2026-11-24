const test = require('node:test');
const assert = require('node:assert/strict');

const lift = {liftId: 'P-9', project: 'Paid Tower', address: 'Dhaka', deliveryDate: '2026-11-23', motorType: 'Gearless', liftType: 'Passenger', system: 'MOT',
  controllerModel: 'MOT 7.5 kW', createdName: 'A', updatedName: 'A', updatedAt: '2026-11-23T08:00:00Z', serials: {}, selection: null, specialNote: 'Install after handover',
  parts: [{section: 'paid', grp: 'Voice Announcer', hardware: 'Voice Announcer', code: '270428', name: 'G&Z-PLUS LIFT ANNOUNCER', brand: 'ARKEL', supplier: 'ARKEL', value: '4610.48'},
    {section: 'paid', grp: 'Regenerative drive', hardware: 'Regenerative drive 15 kW', spec: '15 kW', name: '', brand: 'MONARCH', supplier: 'MONARCH'}]};

test('table 7 lists every selected paid feature row and carries the note', async () => {
  const {qmsTables, qmsFlatRows, qmsSheets, qmsReport} = await import('../supabase/functions/_shared/wlf-excel.mjs');
  const {blocks} = qmsTables(lift);
  const t7 = blocks.find(b => b.no === 7);
  assert.equal(t7.columns.reduce((a, c) => a + c.span, 0), 10);
  assert.deepEqual(t7.rows.map(r => r.a), ['Voice Announcer', 'Regenerative drive']);
  assert.equal(t7.rows[0].price, 4610.48);
  assert.equal(t7.rows[1].code, 'no code');
  assert.equal(t7.note, undefined, 'the note is not part of Paid feature any more');
  const t8 = blocks.find(b => b.no === 8);
  assert.equal(t8.name, 'Special note');
  assert.deepEqual(t8.rows.map(r => r.a), ['Install after handover']);
  assert.equal(qmsFlatRows(lift).filter(r => r[5] === 7).length, 2, 'only the two paid rows');
  const flat8 = qmsFlatRows(lift).filter(r => r[5] === 8);
  assert.equal(flat8.length, 1);
  assert.equal(flat8[0][8], 'Install after handover');
  assert.equal(qmsReport(lift).blocks.at(-1).no, 8);
  const sheets = qmsSheets([{lift: {lift_id: 'P-9', project: 'x', special_note: 'N', paid_note: 'N', parts: lift.parts, serials: {}, system: 'MOT', controller_model: 'MOT 7.5 kW'}}]);
  assert.equal(sheets[0].headers.at(-1), 'Special note');
  assert.equal(sheets[0].rows[0].at(-1), 'N');
  assert.equal(sheets[1].rows[0][2], 'Paid feature');
  const empty = qmsTables({...lift, parts: [], specialNote: ''}).blocks.find(b => b.no === 7);
  assert.equal(empty.rows.length, 0);
  assert.equal(qmsFlatRows({...lift, parts: [], specialNote: ''}).filter(r => r[5] >= 7).length, 0);
});
