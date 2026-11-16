const test = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {makeDB, IDS} = require('./pg-harness.cjs');
const TroubleCore = require('../shared/troubleshooting-core.js');

const chain = ['UPDATE_V220','UPDATE_SUPPORT_FORMS_20261107','UPDATE_DAMAGE_DEMAND_20261107','UPDATE_WORKSPACE_20261107','UPDATE_SECTIONS_V230','UPDATE_V240','UPDATE_V250'];
const migration = readFileSync('supabase/UPDATE_V251.sql','utf8');

async function prepare(t, before) {
  const h = await makeDB();
  t.after(() => h.close());
  for (const file of chain) await h.db.exec(readFileSync('supabase/'+file+'.sql','utf8'));
  if (before) await before(h);
  const results = await h.db.exec(migration);
  return {h, ready: results.at(-1).rows[0]};
}
const fill = fields => Object.fromEntries(fields.filter(f => !f.autoFill).map(f => [f.id,
  f.type === 'multi' ? f.options.slice(0,1) : f.type === 'date' ? '' : f.type === 'number' ? '30'
  : f.type === 'checkbox' ? (f.options?.length ? [] : false) : f.options?.[0] || 'Fixture']));

test('v2.5.1 migration is repeatable; forms and Bangla tracking are ready', async t => {
  const {h, ready} = await prepare(t, h => h.db.query("update public.wlf_troubleshooting set content=jsonb_set(content,'{bn}',(content->'bn')-'src') where content ? 'bn'"));
  assert.deepEqual(ready, {other_name_ready: true, team_task_name_only: true, sales_dates_ready: true, bangla_tracking_ready: true, v251_ready: true});
  assert.equal((await h.db.exec(migration)).at(-1).rows[0].v251_ready, true);
  assert.equal((await h.rpc('sa', 'getSession')).build, '2.5.1');
  const sales = (await h.db.query("select schema from public.wlf_ri_categories where id='wb-sales'")).rows[0].schema.fields.map(f => f.id);
  assert.deepEqual(sales.slice(sales.indexOf('problem'), sales.indexOf('problem') + 3), ['problem', 'start_date', 'end_date']);
  // every seeded Bangla part matches its English source
  const rows = (await h.db.query("select content from public.wlf_troubleshooting where content ? 'bn'")).rows.map(r => r.content);
  assert.equal(rows.length, 166);
  for (const e of rows) {
    for (const k of ['d','c','s']) assert.equal(TroubleCore.bnFresh(e, k), true, e.id + ' ' + k);
    for (const sc of e.bn.subcodes || []) assert.equal(TroubleCore.bnFresh(e, 'sub', sc.code), true, e.id + ' sub ' + sc.code);
  }
});

test('"Other: <name>" is accepted; plain wrong choices are still refused', async t => {
  const {h} = await prepare(t);
  await h.db.query('alter table public.wlf_profiles disable trigger wlf_deletion_guard');
  await h.db.query("update public.wlf_profiles set employee_id='US-5', section='Commissioning', permissions=array_append(permissions,'ri:activity') where id=$1", [IDS.user]);
  await h.db.query('alter table public.wlf_profiles enable trigger wlf_deletion_guard');
  const ctx = {categories: await h.rpc('user', 'getRiCategories', [{}])};
  const sales = ctx.categories.find(c => c.id === 'wb-sales');
  const save = values => h.rpc('user', 'saveRiEntry', [{id: crypto.randomUUID(), operation: crypto.randomUUID(), category: sales.id,
    formRevision: sales.revision, revision: 0, values}]);
  const base = fill(sales.schema.fields);
  const ok = await save({...base, support_category: 'Other: Site survey', start_date: '2026-11-01', end_date: ''});
  assert.equal(ok.values.support_category, 'Other: Site survey');
  assert.equal(ok.values.date, (await h.db.query("select to_char((now() at time zone 'Asia/Dhaka')::date,'YYYY-MM-DD') d")).rows[0].d, 'date is always today');
  await assert.rejects(save({...base, support_category: 'Something else'}), /Invalid choice/);
  const team = ctx.categories.find(c => c.id === 'wb-team');
  assert.equal(team.schema.fields.some(f => f.id === 'project'), false);
  const entry = await h.rpc('user', 'saveRiEntry', [{id: crypto.randomUUID(), operation: crypto.randomUUID(), category: team.id,
    formRevision: team.revision, revision: 0, values: {...fill(team.schema.fields), task_category: ['Others: Vendor audit', 'SOP']}}]);
  assert.deepEqual(entry.values.task_category, ['Others: Vendor audit', 'SOP']);
});

test('Bangla fingerprint: changed English makes that part stale, other parts stay Bangla', () => {
  const seed = require('../web/troubleshooting-seed.json');
  const e = JSON.parse(JSON.stringify(seed.entries.find(x => x.id === 'nice-err20')));
  const v = TroubleCore.validate({...e, mutationId: 'tbm-test'});
  assert.deepEqual(v.bn.src, e.bn.src, 'validate keeps src');
  assert.equal(TroubleCore.bnFresh(v, 'd'), true);
  v.description += ' (updated)';
  assert.equal(TroubleCore.bnFresh(v, 'd'), false);
  const code = v.subcodes[0].code;
  assert.equal(TroubleCore.bnFresh(v, 'sub', code), true);
  v.subcodes[0].solution = [...v.subcodes[0].solution, 'New step'];
  assert.equal(TroubleCore.bnFresh(v, 'sub', code), false);
});
