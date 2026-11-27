const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Zip = require('jszip');
const sample = require('./fixtures/report-sample.cjs');
const load = () => import('../supabase/functions/_shared/wlf-report.mjs');
const sheetsOf = async bytes => {
  const z = await Zip.loadAsync(bytes), wb = await z.file('xl/workbook.xml').async('string');
  const names = [...wb.matchAll(/<sheet name="([^"]+)"/g)].map(m => m[1].replace(/&amp;/g, '&'));
  return {z, names, sheet: async i => z.file('xl/worksheets/sheet' + i + '.xml').async('string')};
};

test('Technical Support report: summary, one sheet per section, all requests; top values highlighted', async () => {
  const {makeReport, reportFileName} = await load();
  const {bytes, records} = await makeReport('support', sample.support, Zip, '01 Dec 2026 02:00');
  assert.equal(records, 8);
  assert.equal(reportFileName('support', '2026-11'), 'Technical Support Monthly Report 2026-11.xlsx');
  const {names, sheet, z} = await sheetsOf(bytes);
  assert.deepEqual(names, ['Summary', 'Commissioning', 'After Sales', 'Production', 'Factory Maintenance', 'QC', 'Installation', 'All requests']);
  const s1 = await sheet(1);
  assert.match(s1, /Technical Support Monthly Report · November 2026/);
  assert.match(s1, /NICE3000\+ drive error \(3, 37\.5%\)/, 'most frequent problem named with count and share');
  /* the After Sales row (4 of 8) is the highlighted top section: style 9 = highlighted text */
  assert.match(s1, /<c r="A\d+" s="9" t="inlineStr"><is><t xml:space="preserve">After Sales<\/t>/);
  assert.match(s1, /Same problem on the same lift/);
  assert.match(s1, /TS-1001, TS-1002/, 'lift 5001 had the same problem twice');
  assert.match(s1, /Err38/);
  assert.match(s1, /orientation="landscape"/);
  assert.match(s1, /WLF Electrical Solution · Technical Support/);
  const styles = await z.file('xl/styles.xml').async('string');
  assert.match(styles, /formatCode="0\.0%"/);
  const qc = await sheet(6);
  assert.match(qc, /No records in this month\./, 'a section with no requests still has its sheet');
  const all = await sheet(8);
  assert.equal((all.match(/TS-10\d\d/g) || []).length, 8);
});

test('R&I Team Activity report: one sheet per sector in the order asked; "&" is safe in the footer', async () => {
  const {makeReport} = await load();
  const {bytes} = await makeReport('activity', sample.activity, Zip, '01 Dec 2026 02:00');
  const {names, sheet} = await sheetsOf(bytes);
  assert.deepEqual(names, ['Summary', 'Team R&I Activity', 'Supplier & SCM Communication', 'Reports', 'Sales Support', 'All entries']);
  const s1 = await sheet(1);
  assert.match(s1, /9\.8 hours/, '585 minutes in total');
  assert.match(s1, /R&amp;&amp;I Team Activity Monthly Report/, 'footer "&" doubled so Excel does not read "&I" as italic');
  assert.match(await sheet(6), /Subject: Control panel drawing for a 13-stop lift/);
});

test('Damage Demand report: problems, components, sections and users ranked; only a clear top is highlighted', async () => {
  const {makeReport} = await load();
  const {bytes, records} = await makeReport('damage', sample.damage, Zip, '01 Dec 2026 02:00');
  assert.equal(records, 4);
  const {names, sheet} = await sheetsOf(bytes);
  assert.deepEqual(names, ['Summary', 'Commissioning', 'After Sales', 'Factory Maintenance', 'Installation', 'All demands']);
  const s1 = await sheet(1);
  assert.match(s1, /Brake resistor · 80 ohm 2\.5 kW \(3 units\)/);
  assert.match(s1, /Damage by user \(requester\)/);
  /* Brake resistor and Encoder cable both have 3 units: a tie is not highlighted */
  assert.doesNotMatch(s1, /s="9" t="inlineStr"><is><t xml:space="preserve">Brake resistor</);
  assert.match(s1, /s="9" t="inlineStr"><is><t xml:space="preserve">NICE3000\+ drive error</, 'the clear top problem is highlighted');
});

test('Edge part: the schedule makes only the missing reports, records the check, replaces an old file', async () => {
  const {reportMaintenance} = await load();
  const calls = [], files = new Map(), trashed = [];
  const sql = async (a, x = {}) => {
    calls.push(a + (x.kind ? ':' + x.kind : ''));
    if (a === 'pending') return {month: '2026-11', kinds: ['support', 'damage']};
    if (a === 'data') return {...sample[x.kind], existing: x.kind === 'damage' ? {fileId: 'old_file_1'} : null};
    return {saved: true};
  };
  const drive = async (path, init = {}) => {
    if (path.includes('?alt=media')) return new Response(files.get(path.split('/').at(-1).split('?')[0]));
    if (init.method === 'PATCH') { trashed.push(path.split('/').at(-1)); return Response.json({}); }
    const raw = Buffer.from(await new Response(init.body).arrayBuffer()), b = init.headers['Content-Type'].split('boundary=')[1];
    const start = raw.indexOf('\r\n\r\n', raw.indexOf('\r\n--' + b, 10)) + 4, id = 'file_' + files.size + '_x';
    files.set(id, raw.subarray(start, raw.lastIndexOf('\r\n--' + b + '--')));
    return Response.json({id});
  };
  const out = await reportMaintenance({action: 'monthlyReports', sql, drive, folderFor: async k => 'folder_' + k, Zip});
  assert.deepEqual(out.made.map(m => m.fileName), ['Technical Support Monthly Report 2026-11.xlsx', 'Damage Demand Monthly Report 2026-11.xlsx']);
  assert.deepEqual(calls, ['pending', 'data:support', 'saved:support', 'data:damage', 'saved:damage', 'checked']);
  assert.deepEqual(trashed, ['old_file_1']);
  const {names} = await sheetsOf(files.get('file_0_x'));
  assert.equal(names[0], 'Summary');
  await assert.rejects(reportMaintenance({action: 'reportGenerate', payload: {month: '2026-11', kinds: []}, sql, drive, folderFor: async () => 'f', Zip}), /Choose at least one report/);
});

test('Edge Function: one-file bundle is current and the cron header is allowed', () => {
  const index = fs.readFileSync('supabase/functions/wlf-maintenance/index.ts', 'utf8');
  assert.match(index, /x-wlf-cron/);
  assert.match(index, /Not allowed for the schedule/);
  return import('../scripts/bundle-maintenance.mjs').then(({bundle}) =>
    assert.equal(fs.readFileSync('supabase/functions/wlf-maintenance/index.single.ts', 'utf8'), bundle(), 'run: node scripts/bundle-maintenance.mjs supabase/functions/wlf-maintenance/index.single.ts'));
});
