const test = require('node:test');
const assert = require('node:assert/strict');

test('Technical Support menu Excel leaves out the yellow bookkeeping columns; backups keep every column', async () => {
  const {supportSheets} = await import('../supabase/functions/_shared/wlf-excel.mjs');
  const schema = {fields: [{id: 'p', label: 'Project Name', type: 'text'}, {id: 'c', label: 'Controller', type: 'text'}]};
  const ticket = {category: 'commissioning', reference: 'CM-1', status: 'Solved', createdBy: 'a@x', createdAt: '2026-11-01', updatedAt: '2026-11-02', assignedTo: 'b@x', solvedBy: 'b@x', solvedAt: '2026-11-02', solution: 'Fixed', values: {p: 'Tower', c: 'NICE'}, formSchema: schema};
  const cats = [{id: 'commissioning', name: 'Commissioning', schema}];
  const lean = supportSheets(cats, [ticket], {lean: true})[0];
  assert.deepEqual(lean.headers, ['Workflow status', 'Solved at (UTC)', 'Solution', 'Project Name', 'Controller']);
  assert.deepEqual(lean.rows[0], ['Solved', '2026-11-02', 'Fixed', 'Tower', 'NICE']);
  const full = supportSheets(cats, [ticket])[0];
  assert.ok(full.headers.includes('Request ID') && full.headers.includes('Assigned to') && full.headers.includes('Submitted by'));
});
test('the CSV button of the Technical Support menu is gone', () => {
  const src = require('node:fs').readFileSync('web/live-workspace.js', 'utf8');
  assert.ok(!/downloadSupportCSV/.test(src) && !/function exportCSV/.test(src));
  assert.match(src, /\{lean:true\}/);
});
