const test = require('node:test');
const assert = require('node:assert/strict');
const QR = require('../web/qr.js');

test('QR code: sizes follow the text length, finder squares are in place, long text still fits', () => {
  const small = QR.matrix('WLF');
  assert.equal(small.length, 21);
  for (const [x, y] of [[0, 0], [14, 0], [0, 14]]) { assert.equal(small[y][x], true); assert.equal(small[y + 3][x + 3], true); assert.equal(small[y + 1][x + 1], false); }
  const lift = 'WLF QMS\nLift ID: L-101\nProject: Walton Tower\nController: NICE 7.5 kW\nMotor: MCK-100\nCOP display: CD-1\nLOP display: LD-1\nTransom display: TD-1\nAVR: 15 KVA\nhttps://example.github.io/WLF-Electrical-Solution/#qms=L-101';
  const m = QR.matrix(lift);
  assert.ok(m.length <= 61, 'a lift label stays a small, easy-to-scan code (' + m.length + ' modules)');
  assert.ok(m.every(r => r.length === m.length));
  assert.throws(() => QR.matrix('x'.repeat(3000)), /too long/);
  assert.match(QR.svg(lift), /^<svg[^>]+viewBox/);
});
test('QR has no serial number code path', () => {
  const src = require('node:fs').readFileSync('web/hardware.js', 'utf8');
  const fn = src.slice(src.indexOf('function qrFacts'), src.indexOf('function qrPanel'));
  assert.ok(!/serial/i.test(fn));
});

test('QR facts: models are taken from the right parts of the lift', () => {
  const src = require('node:fs').readFileSync('web/hardware.js', 'utf8');
  const fn = src.slice(src.indexOf('function qrFacts'), src.indexOf('const qrLink'));
  const qrFacts = new Function(fn + '; return qrFacts;')();
  const rec = {liftId: 'L-1', project: 'P', controllerModel: 'NICE 7.5 kW',
    selection: {categories: [{items: [{label: 'Motor Brand', value: 'Z'}, {label: 'Motor Model', value: 'MCK-100'}]}]},
    parts: [{section: 'cop', grp: 'COP Display', hardware: 'CD-9'}, {section: 'cop', grp: 'COP Button', hardware: 'CB-1'},
      {section: 'lop', hardware: 'LD-3'}, {section: 'transom', hardware: 'TD-2'}, {section: 'avr', model: 'AVR 15 KVA'}]};
  assert.deepEqual(Object.fromEntries(qrFacts(rec)), {'Lift ID': 'L-1', Project: 'P', Controller: 'NICE 7.5 kW', Motor: 'MCK-100', 'COP display': 'CD-9', 'LOP display': 'LD-3', 'Transom display': 'TD-2', AVR: '15 KVA'});
});
