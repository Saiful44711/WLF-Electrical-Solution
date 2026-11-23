const test = require('node:test');
const assert = require('node:assert/strict');

const lift = {liftId: 'P-9', project: 'Paid Tower', address: 'Dhaka', deliveryDate: '2026-11-23', motorType: 'Gearless', liftType: 'Passenger', system: 'MOT',
  controllerModel: 'MOT 7.5 kW', createdName: 'A', updatedName: 'A', updatedAt: '2026-11-23T08:00:00Z', serials: {}, selection: null, paidNote: 'Install after handover',
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
  assert.equal(t7.note, 'Install after handover');
  const flat = qmsFlatRows(lift).filter(r => r[5] === 7);
  assert.equal(flat.length, 3, 'two rows and the note');
  assert.equal(flat.at(-1)[8], 'Special note');
  assert.equal(flat.at(-1)[10], 'Install after handover');
  assert.equal(qmsReport(lift).blocks.at(-1).no, 7);
  const sheets = qmsSheets([{lift: {lift_id: 'P-9', project: 'x', paid_note: 'N', parts: lift.parts, serials: {}, system: 'MOT', controller_model: 'MOT 7.5 kW'}}]);
  assert.equal(sheets[0].headers.at(-1), 'Paid feature note');
  assert.equal(sheets[0].rows[0].at(-1), 'N');
  assert.equal(sheets[1].rows[0][2], 'Paid feature');
  const empty = qmsTables({...lift, parts: [], paidNote: ''}).blocks.find(b => b.no === 7);
  assert.equal(empty.rows.length, 0);
  assert.equal(qmsFlatRows({...lift, parts: [], paidNote: ''}).filter(r => r[5] === 7).length, 0);
});
