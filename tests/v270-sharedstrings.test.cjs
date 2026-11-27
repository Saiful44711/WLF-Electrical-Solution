const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const JSZip = require('jszip');
const raw = JSZip.__rawLoadAsync || JSZip.loadAsync.bind(JSZip);
const url = f => require('node:url').pathToFileURL(path.join(__dirname, '..', f)).href;

/* Google Sheets drops the spaces of inline strings, so every text cell must come from xl/sharedStrings.xml */
async function check(bytes, phrase) {
  const z = await raw(bytes);
  const sst = await z.file('xl/sharedStrings.xml').async('string');
  assert.ok(sst.includes(phrase), 'shared strings keep the spaces: ' + phrase);
  for (const n of Object.keys(z.files).filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))) assert.ok(!(await z.file(n).async('string')).includes('inlineStr'), n + ' has no inline strings');
  assert.match(await z.file('[Content_Types].xml').async('string'), /sharedStrings\.xml" ContentType="application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sharedStrings\+xml"/);
  assert.match(await z.file('xl/_rels/workbook.xml.rels').async('string'), /Target="sharedStrings\.xml"/);
}

test('v2.7.0: monthly reports, table workbooks and the lift report sheet use shared strings (Google Sheets keeps the spaces)', async () => {
  const {makeReport} = await import(url('supabase/functions/_shared/wlf-report.mjs'));
  const sample = require('./fixtures/report-sample.cjs');
  for (const kind of ['support', 'activity', 'damage']) { const r = await makeReport(kind, sample[kind], JSZip, '27 Nov 2026 10:00'); await check(r.bytes || r, 'Monthly Report · '); }
  const {buildWorkbook, buildReportWorkbook} = await import(url('supabase/functions/_shared/wlf-excel.mjs'));
  await check(await buildWorkbook(JSZip, [{name: 'Two words', headers: ['Lift ID', 'Project name'], rows: [['L 1', 'Green Tower Phase 2']]}]), 'Green Tower Phase 2');
  await check(await buildReportWorkbook(JSZip, {name: 'QMS Report', title: 'QMS — Lift L 1', blocks: []}), 'QMS — Lift L 1');
});
