const test = require('node:test');
const assert = require('node:assert/strict');

const lift = {liftId: 'A-1', project: 'Tower', address: 'Dhaka', deliveryDate: '2026-11-24', motorType: 'Gearless', liftType: 'Passenger', system: 'MOT', controllerModel: 'MOT 7.5 kW',
  serials: {motor: 'M1', avr: 'AV-1', battery: 'B1,B2,B3,B4,B5'}, specialNote: '',
  parts: [{section: 'avr', model: 'AVR 15 KVA', grp: 'Full AVR', hardware: 'Full AVR', spec: '15 KVA', code: '314445', name: '', brand: 'SAKO', supplier: 'SAKO', value: 35944.85},
    {section: 'avr', model: 'AVR 15 KVA', grp: 'Cooling Fan', hardware: 'Cooling Fan', spec: '3 Pcs', code: '', name: '', brand: '', supplier: '', value: null}]};

test('AVR has its own table 6 before Other components; AVR SL and Battery SL are in the serial table', async () => {
  const {qmsTables, qmsFlatRows} = await import('../supabase/functions/_shared/wlf-excel.mjs');
  const {blocks} = qmsTables(lift);
  const t4 = blocks.find(b => b.no === 4), t6 = blocks.find(b => b.no === 6), t7 = blocks.find(b => b.no === 7);
  assert.deepEqual(t4.rows.map(r => r.a).slice(-2), ['AVR', 'Battery']);
  assert.equal(t4.rows.at(-1).spec, 'B1,B2,B3,B4,B5');
  assert.equal(t6.name, 'AVR — AVR 15 KVA');
  assert.equal(t6.rows.length, 2);
  assert.equal(t6.rows[0].price, 35944.85);
  assert.equal(t6.columns.reduce((a, c) => a + c.span, 0), 10);
  assert.ok(t7.name.startsWith('Other components') && !t7.rows.some(r => /AVR/.test(r.a)));
  assert.equal(qmsFlatRows(lift).filter(r => r[5] === 6).length, 2);
  assert.ok(qmsFlatRows(lift).some(r => r[5] === 4 && r[8] === 'Battery' && r[10] === 'B1,B2,B3,B4,B5'));
});

test('a lift whose serial numbers are hidden never puts them in any sheet', async () => {
  const {qmsTables, qmsFlatRows, qmsSheets} = await import('../supabase/functions/_shared/wlf-excel.mjs');
  const hidden = {...lift, serials: {}, serialsHidden: true};
  const t4 = qmsTables(hidden).blocks.find(b => b.no === 4);
  assert.equal(t4.rows.length, 0);
  assert.equal(t4.hidden, true);
  assert.equal(qmsFlatRows(hidden).filter(r => r[5] === 4).length, 0);
  assert.deepEqual(qmsSheets([{lift: hidden}]).map(s => s.name), ['QMS Lifts', 'QMS Components', 'QMS Output Tables']);
  const mixed = qmsSheets([{lift}, {lift: hidden}]);
  const serials = mixed.find(s => s.name === 'QMS Serial numbers');
  assert.deepEqual(serials.rows.map(r => r[0]), ['A-1', 'A-1', 'A-1']);
  assert.deepEqual(serials.rows.map(r => r[2]), ['Motor', 'AVR', 'Battery']);
});

test('the QMS Data download is the backup workbook: camelCase lifts and raw database rows give the same sheets', async () => {
  const {qmsSheets} = await import('../supabase/functions/_shared/wlf-excel.mjs');
  const raw = {lift_id: 'A-1', project: 'Tower', address: 'Dhaka', delivery_date: '2026-11-24', motor_type: 'Gearless', lift_type: 'Passenger', system: 'MOT', controller_model: 'MOT 7.5 kW',
    serials: lift.serials, paid_note: 'Note', parts: lift.parts, created_name: 'Sa', created_at: '2026-11-20T04:00:00Z'};
  const a = qmsSheets([{lift: raw}]);
  const b = qmsSheets([{lift: {...lift, specialNote: 'Note', createdName: 'Sa', createdAt: '2026-11-20T04:00:00Z'}}]);
  assert.deepEqual(a.map(s => [s.name, s.rows.length]), b.map(s => [s.name, s.rows.length]));
  assert.equal(a[0].headers.includes('AVR model'), true);
  assert.equal(a[0].rows[0][a[0].headers.indexOf('AVR model')], 'AVR 15 KVA');
  assert.equal(a[0].rows[0].at(-1), 'Note');
  assert.equal(a[0].rows[0][a[0].headers.indexOf('Created by')], 'Sa');
});
