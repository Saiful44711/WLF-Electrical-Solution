const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');

const lift = {liftId: '12345', project: 'Test 2', address: 'Dhaka', deliveryDate: '2026-11-20', motorType: 'Gearless', liftType: 'Passenger', system: 'MOT', controllerModel: 'MOT 7.5 kW',
  createdName: 'Md. Saiful Islam', updatedName: 'Md. Saiful Islam', updatedAt: '2026-11-20T08:56:00Z', serials: {motor: 'SL-10000', encoder: 'ECN-12234'},
  selection: {inputs: {capacity: 450, speed: 1, usageType: 'MR', roping: '2:1'}, categories: [
    {title: '1. Selected Motor Data', items: [{label: 'Motor Brand', value: 'Ziehl Abegg'}, {label: 'Motor Power (kW)', value: 3.3}, {label: 'SDB main breaker rating', value: '32'}]},
    {title: 'Recommended controller', items: [{label: 'Controller', value: 'MOT 7.5 kW'}]}]},
  parts: [
    {section: 'control', grp: 'Circuit Breaker', hardware: 'Controller Main 4 pole CB', spec: '25 A', code: '379863', name: '4 pole miniature circuit breaker 25 A', brand: 'Schneider', value: 2294.5},
    {section: 'control', grp: 'Drive', hardware: 'Drive', spec: '', code: '183167'},
    {section: 'lop', hardware: 'WM-LOP-208 Black', code: '500835', name: 'LOP Black Glass', brand: 'Walton', value: '1000'},
    {section: 'cop', grp: 'COP Button', hardware: 'A18-Blue', name: '', brand: ''},
    {section: 'cable', hardware: 'Traveling cable', code: '183001', name: 'Travelling Cable TVVB 36 core'},
    {section: 'avr', model: 'AVR 20 KVA', code: '900001', name: 'AVR Servo', supplier: 'Y'},
    {section: 'other', hardware: 'Emergency Light', supplier: 'Masen'}]};

test('QMS tables follow the six tables of QMS Data, with prices as numbers and "no code" kept', async () => {
  const {qmsTables} = await import('../supabase/functions/_shared/wlf-excel.mjs');
  const {blocks} = qmsTables(lift);
  const byNo = n => blocks.filter(b => b.no === n);
  assert.deepEqual([...new Set(blocks.map(b => b.no))], [1, 2, 3, 4, 5, 6, 7]);
  for (const b of blocks) if (b.columns.length) assert.equal(b.columns.reduce((a, c) => a + c.span, 0), 10, 'grid width of table ' + b.no);
  assert.deepEqual(byNo(1)[0].columns.map(c => c.head), ['Project', 'Lift ID', 'Address', 'Delivery', 'Motor type', 'Lift type']);
  assert.equal(byNo(1)[0].rows[0].delivery, '20 Nov 2026');
  assert.equal(byNo(2).length, 3, 'inputs, motor data and one recommended block');
  assert.deepEqual(byNo(3)[0].columns.map(c => c.head), ['Group', 'Hardware', 'Spec', 'Item code', 'Item name', 'Brand', 'Price (৳)']);
  assert.equal(byNo(3)[0].rows[0].price, 2294.5);
  assert.equal(byNo(4)[0].rows.length, 7);
  assert.equal(byNo(4)[0].rows[2].spec, '—');
  const t5 = byNo(5)[0].rows;
  assert.equal(t5.find(r => r.b === 'A18-Blue').code, 'no code');
  assert.equal(t5.find(r => r.b === 'WM-LOP-208 Black').price, 1000);
  assert.equal(t5.find(r => r.a === 'COP · Button').b, 'A18-Blue');
  const t6 = byNo(6)[0].rows;
  assert.equal(t6[0].a, 'AVR 20 KVA');
  assert.equal(t6.at(-1).a, 'SDB main breaker rating');
  assert.equal(t6.at(-1).spec, '32 A');
});

test('the lift Excel is one print-ready sheet with every table and opens as a valid workbook', async () => {
  const {buildReportWorkbook, qmsReport} = await import('../supabase/functions/_shared/wlf-excel.mjs');
  const bytes = await buildReportWorkbook(JSZip, qmsReport(lift));
  const zip = await JSZip.loadAsync(bytes);
  const files = Object.keys(zip.files);
  assert.ok(files.includes('xl/worksheets/sheet1.xml') && files.includes('xl/styles.xml'));
  assert.equal(files.filter(f => /worksheets\/sheet\d+\.xml$/.test(f)).length, 1, 'exactly one sheet');
  const sheet = await zip.file('xl/worksheets/sheet1.xml').async('string');
  for (const text of ['QMS — Lift 12345 · Test 2', '1 · Project information', '2 · Selected motor', '3 · Control system — MOT · MOT 7.5 kW', '4 · Serial numbers',
    '5 · COP · LOP · Transom · Travelling cable', '6 · Other components (including AVR)', 'Ziehl Abegg', 'no code', 'SL-10000'])
    assert.ok(sheet.includes(text), 'missing ' + text);
  assert.match(sheet, /orientation="landscape"/);
  assert.match(sheet, /fitToWidth="1" fitToHeight="0"/);
  assert.match(sheet, /Design &amp;&amp; Developed by Md\. Saiful Islam/);
  assert.match(sheet, /<c r="J\d+" s="6"><v>2294.5<\/v>/, 'price is a number cell');
  assert.ok(!/<v>NaN<\/v>/.test(sheet));
  const merges = [...sheet.matchAll(/<mergeCell ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"/g)];
  assert.ok(merges.length > 20);
  // a very long item name must get a taller row (wrapped text)
  const long = {...lift, parts: [{section: 'lop', hardware: 'M', code: '1', name: 'X'.repeat(400)}]};
  const tall = await (await JSZip.loadAsync(await buildReportWorkbook(JSZip, qmsReport(long)))).file('xl/worksheets/sheet1.xml').async('string');
  assert.match(tall, /ht="(\d{3})"/);
});

test('the Excel backup gets one flat QMS Output Tables sheet that stays usable with many lifts', async () => {
  const {qmsSheets, qmsFlatHeaders} = await import('../supabase/functions/_shared/wlf-excel.mjs');
  const rec = l => ({lift: {lift_id: l.liftId, project: l.project, address: l.address, delivery_date: l.deliveryDate, motor_type: l.motorType, lift_type: l.liftType, system: l.system,
    controller_model: l.controllerModel, created_name: 'a', updated_name: 'b', created_at: '2026-11-20T00:00:00Z', updated_at: '2026-11-20T00:00:00Z', serials: l.serials, selection: l.selection, parts: l.parts}});
  const sheets = qmsSheets([rec(lift), rec({...lift, liftId: '777', project: 'Other'})]);
  assert.deepEqual(sheets.map(s => s.name), ['QMS Lifts', 'QMS Components', 'QMS Serial numbers', 'QMS Output Tables']);
  const flat = sheets[3];
  assert.deepEqual(flat.headers, qmsFlatHeaders);
  assert.ok(flat.rows.every(r => r.length === flat.headers.length), 'every row matches the header width');
  assert.deepEqual([...new Set(flat.rows.map(r => r[0]))], ['12345', '777']);
  assert.deepEqual([...new Set(flat.rows.filter(r => r[0] === '777').map(r => r[5]))], [1, 2, 3, 4, 5, 6]);
  const price = flat.rows.find(r => r[11] === '379863');
  assert.equal(price[15], 2294.5);
  assert.equal(price[6], 'Control system');
  assert.equal(flat.rows.find(r => r[10] === 'ECN-12234')[8], 'Encoder');
  assert.equal(flat.rows.find(r => r[7] === 'Inputs' && r[9] === 'Capacity')[10], 450);
  assert.equal(flat.rows.filter(r => r[11] === 'no code').length >= 2, true);
});
