const test = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {makeDB, IDS} = require('./pg-harness.cjs');

const chain = ['UPDATE_V220','UPDATE_SUPPORT_FORMS_20261107','UPDATE_DAMAGE_DEMAND_20261107','UPDATE_WORKSPACE_20261107','UPDATE_SECTIONS_V230','UPDATE_V240','UPDATE_V250','UPDATE_V251','UPDATE_V252','UPDATE_V253','UPDATE_V254','UPDATE_V255','UPDATE_V256','UPDATE_V257','UPDATE_V258','UPDATE_V259','UPDATE_V260','UPDATE_V261','UPDATE_V262','UPDATE_V263','UPDATE_V264','UPDATE_V265','UPDATE_V266','UPDATE_V267'];
const migration = readFileSync('supabase/UPDATE_V268.sql','utf8');

async function prepare(t) {
  const h = await makeDB();
  t.after(() => h.close());
  for (const file of chain) await h.db.exec(readFileSync('supabase/'+file+'.sql','utf8'));
  const results = await h.db.exec(migration);
  return {h, ready: results.at(-1).rows[0]};
}
const row = (system, model, grp, code, extra) => ({system, model, grp, hardware: grp, itemCode: code, itemName: 'n-' + code, value: '10', ...extra});
const mine = async (h, system, model) => (await h.rpc('sa', 'getCatalogue')).rows.filter(r => r.system === system && r.model === model);

test('v2.6.8 migration is repeatable and reports the new build', async t => {
  const {h, ready} = await prepare(t);
  assert.equal(ready.v268_ready, true);
  assert.equal((await h.db.exec(migration)).at(-1).rows[0].v268_ready, true);
  assert.equal((await h.rpc('sa', 'getSession')).build, '2.6.8');
});

test('import replaces the whole model table; other models stay; a preview changes nothing', async t => {
  const {h} = await prepare(t);
  const before15 = (await mine(h, 'AVR', 'AVR 15 KVA')).length, before20 = (await mine(h, 'AVR', 'AVR 20 KVA')).length;
  assert.equal(before15, 15);
  const rows = [row('AVR', 'AVR 15 KVA', 'Full AVR', 'N1'), row('AVR', 'AVR 15 KVA', 'Cooling Fan', 'N2'), row('avr', 'avr 15 kva', 'Fuse', 'N3')];
  const dry = await h.rpc('sa', 'replaceCatalogueTables', [{rows, dryRun: true}]);
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.tables.map(x => [x.model, x.oldRows, x.newRows, x.isNew]), [['AVR 15 KVA', 15, 3, false]]);
  assert.equal((await mine(h, 'AVR', 'AVR 15 KVA')).length, 15, 'preview did not change anything');
  const done = await h.rpc('sa', 'replaceCatalogueTables', [{rows}]);
  assert.equal(done.rows, 3);
  const now = await mine(h, 'AVR', 'AVR 15 KVA');
  assert.deepEqual(now.map(r => r.itemCode), ['N1', 'N2', 'N3'], 'rows come in the order of the file');
  assert.equal((await mine(h, 'AVR', 'AVR 20 KVA')).length, before20, 'another model is untouched');
  const again = await h.rpc('sa', 'replaceCatalogueTables', [{rows}]);   /* same file twice does not double the rows */
  assert.equal((await mine(h, 'AVR', 'AVR 15 KVA')).length, 3);
  assert.equal(again.tables[0].oldRows, 3);
});

test('import can add a new model and replace two models at once', async t => {
  const {h} = await prepare(t);
  const res = await h.rpc('sa', 'replaceCatalogueTables', [{rows: [row('NICE3000+', 'NICE 7.5 kW', 'Drive', 'D1'), row('AVR', 'AVR 100 KVA', 'Full AVR', 'F1'), row('AVR', 'AVR 100 KVA', 'Fan', 'F2')]}]);
  assert.equal(res.tables.length, 2);
  assert.equal(res.tables.find(x => x.model === 'NICE 7.5 kW').isNew, true);
  assert.equal((await mine(h, 'AVR', 'AVR 100 KVA')).length, 2);
});

test('rows without a model are skipped; an unusable file and a user without catalogue rights are refused', async t => {
  const {h} = await prepare(t);
  await assert.rejects(h.rpc('sa', 'replaceCatalogueTables', [{rows: [{system: '', model: '', itemCode: 'x'}]}]), /No usable rows/);
  await assert.rejects(h.rpc('sa', 'replaceCatalogueTables', [{rows: []}]), /No rows/);
  const big = Array.from({length: 2001}, (_, i) => row('AVR', 'AVR 15 KVA', 'g', 'c' + i));
  await assert.rejects(h.rpc('sa', 'replaceCatalogueTables', [{rows: big}]), /2000/);
  const before = (await mine(h, 'AVR', 'AVR 15 KVA')).length;
  await assert.rejects(h.rpc('user', 'replaceCatalogueTables', [{rows: [row('AVR', 'AVR 15 KVA', 'g', 'z')]}]), /permission|access|Unsupported/i);
  assert.equal((await mine(h, 'AVR', 'AVR 15 KVA')).length, before);
});
