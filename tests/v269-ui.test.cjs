const test = require('node:test');
const assert = require('node:assert/strict');
const {pathToFileURL} = require('node:url');
const path = require('node:path');
const {layoutPdf} = require('./pdf-fixture.cjs');
const Layout = require('../web/layout-pdf.js');
const fs = require('node:fs');
const QR = require('../web/qr.js');

/* pdf.js expects a few browser classes at start-up; text reading does not use them */
for (const name of ['DOMMatrix', 'Path2D', 'ImageData']) globalThis[name] ??= class {};

const sample = {project: 'Test Project Alpha', address: 'Road 5, Test City', liftId: 'T-9001', capacity: '450', speed: '1.0', roping: '2:1', usage: 'Passenger', brand: 'Walton', model: 'MCK 100', avr: '15'};

test('layout PDF: the labelled values are read, units removed', async () => {
  globalThis.__wlfLayoutBase = pathToFileURL(path.resolve('web') + '/layout-pdf.js').href;
  const {values} = await Layout.readFile(new File([layoutPdf(sample)], 'layout.pdf'));
  assert.deepEqual(values, {project: 'Test Project Alpha', address: 'Road 5, Test City', liftId: 'T-9001', capacity: '450', speed: '1.0', roping: '2:1',
    usage: 'Passenger', room: 'MR', motorBrand: 'Walton', motorModel: 'MCK 100', avrKva: '15'});
});
test('layout PDF: a missing AVR line leaves AVR empty; a different PDF is refused with a readable message', async () => {
  globalThis.__wlfLayoutBase = pathToFileURL(path.resolve('web') + '/layout-pdf.js').href;
  const noAvr = await Layout.readFile(new File([layoutPdf({...sample, avr: ''})], 'layout.pdf'));
  assert.equal(noAvr.values.avrKva, '');
  await assert.rejects(Layout.readFile(new File([Buffer.from('not a pdf')], 'x.pdf')));
  assert.throws(() => Layout.parseItems([{page: 1, x: 10, y: 10, w: 10, str: 'Invoice'}]), /does not look like a Walton lift layout PDF/);
});
test('layout PDF reader files are not pre-cached and the build copies them', () => {
  const build = fs.readFileSync('scripts/build-pwa.mjs', 'utf8');
  assert.match(build, /startsWith\('pdf-'\)/);
  assert.ok(fs.statSync('web/pdf-reader.mjs').size > 100000 && fs.statSync('web/pdf-worker.mjs').size > 100000);
});
test('QR label: no link, Paid feature names included, serials never', () => {
  const src = fs.readFileSync('web/hardware.js', 'utf8');
  assert.ok(!/qrLink|#qms=|followQrLink/.test(src));
  const fn = src.slice(src.indexOf('function qrFacts'), src.indexOf('function qrPanel'));
  assert.ok(!/serial/i.test(fn));
  const facts = new Function(fn.slice(0, fn.indexOf('function qrText')) + '; return qrFacts;')();
  const rec = {liftId: 'L-1', project: 'P', controllerModel: 'C', selection: null,
    parts: [{section: 'paid', grp: 'Regenerative drive'}, {section: 'paid', grp: 'Regenerative drive'}, {section: 'paid', grp: 'Fire mode'}]};
  assert.equal(Object.fromEntries(facts(rec))['Paid features'], 'Regenerative drive, Fire mode');
  assert.ok(!facts({...rec, parts: []}).some(([k]) => k === 'Paid features'), 'no Paid features line when there is none');
});
test('serial numbers: scan buttons and duplicate warning exist', () => {
  const src = fs.readFileSync('web/hardware.js', 'utf8');
  assert.match(src, /new BarcodeDetector\(\)/);
  assert.match(src, /same number is entered more than once/);
  assert.match(src, /facingMode: \{ideal: 'environment'\}/);
});

test('layout PDF, table style ("LIFT TECHNICAL SPECIFICATIONS", no colons): values are read from the cell to the right', () => {
  const it = (x, y, str, w) => ({page: 3, x, y, w: w ?? str.length * 5, str});
  const items = [
    it(325, 1125, 'LIFT TECHNICAL SPECIFICATIONS'),
    it(43, 1096, 'PROJECT NAME', 60), it(150, 1096, 'TEST PROJECT BETA'), it(505, 1103, 'SALES ID'), it(614, 1103, '100002'),
    it(515, 1080, 'LIFT ID', 30), it(614, 1080, 'T-9002'), it(72, 1064, 'LOCATION', 40), it(150, 1063, 'ROAD 7, TEST TOWN'),
    it(133, 1014, 'TYPE OF LIFT', 60), it(305, 1014, 'MRL'), it(429, 1013, 'FWJ FLOOR DESIGNATION'),
    it(138, 992, 'USAGE TYPE', 50), it(281, 992, 'PASSENGER', 40), it(459, 990, 'TRANSOM POSITION'),
    it(111, 971, 'RATED CAPACITY', 70), it(267, 971, '630 KG , 8 PERSONS.', 80), it(462, 968, 'TRANSOM DISPLAY'),
    it(132, 949, 'RATED SPEED', 55), it(292, 949, '1.5 M/SEC', 40),
    it(58, 861, 'TRACTION MACHINE BRAND', 110), it(275, 860, 'TEST BRAND', 45), it(452, 861, 'FWJ LOP FACEPLATE'),
    it(164, 838, 'MODEL', 28), it(220, 838, 'GEARLESS', 40), it(265, 838, '- AB123-4 -', 60), it(333, 838, '(240 X 6R)', 40), it(469, 837, 'FWJ LOP DISPLAY'),
    it(516, 529, 'ROPING', 30), it(693, 529, '2 : 1', 15), it(535, 132, 'AVR', 15), it(658, 132, 'YES - 10 KVA', 50)];
  assert.deepEqual(Layout.parseItems(items).values, {project: 'TEST PROJECT BETA', address: 'ROAD 7, TEST TOWN', liftId: 'T-9002', capacity: '630', speed: '1.5', roping: '2:1',
    usage: 'PASSENGER', room: 'MRL', motorBrand: 'TEST BRAND', motorModel: 'AB123-4', avrKva: '10'});
  const noAvr = items.slice(0, -1).concat(it(658, 132, 'NO', 10));
  assert.equal(Layout.parseItems(noAvr).values.avrKva, '');
});
