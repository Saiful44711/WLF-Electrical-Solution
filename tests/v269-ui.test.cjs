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
