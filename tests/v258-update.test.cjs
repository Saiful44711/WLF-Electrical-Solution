const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {readFileSync} = require('node:fs');
const {makeDB, IDS} = require('./pg-harness.cjs');
const C = require('../shared/access-core.js');

const chain = ['UPDATE_V220','UPDATE_SUPPORT_FORMS_20261107','UPDATE_DAMAGE_DEMAND_20261107','UPDATE_WORKSPACE_20261107','UPDATE_SECTIONS_V230','UPDATE_V240','UPDATE_V250','UPDATE_V251','UPDATE_V252','UPDATE_V253','UPDATE_V254','UPDATE_V255','UPDATE_V256','UPDATE_V257'];
const migration = readFileSync('supabase/UPDATE_V258.sql','utf8');
const TEAMS = ['commissioning','aftersales','production','qc','maintenance'];

async function prepare(t, before) {
  const h = await makeDB();
  t.after(() => h.close());
  for (const file of chain) await h.db.exec(readFileSync('supabase/'+file+'.sql','utf8'));
  await h.db.query('alter table public.wlf_profiles disable trigger wlf_deletion_guard');
  for (const [who, emp, section] of [['sa','SA-1','R&I Electrical'],['rni','RN-3','R&I Electrical'],['rni2','RN-4','R&I Mechanical'],['user','US-5','Commissioning'],['admin','AD-2','Production']])
    await h.db.query('update public.wlf_profiles set employee_id=$2, section=$3 where id=$1', [IDS[who], emp, section]);
  await h.db.query('alter table public.wlf_profiles enable trigger wlf_deletion_guard');
  if (before) await before(h);
  const results = await h.db.exec(migration);
  return {h, ready: results.at(-1).rows[0]};
}
const fill = (form, extra = {}) => ({...Object.fromEntries(form.fields.filter(f => !f.autoFill && !f.dependsOn && f.type !== 'checkbox').map(f => [f.id,
  f.type === 'multi' ? f.options.slice(0, 1) : f.type === 'date' ? '2026-11-17' : f.type === 'number' ? '12' : f.options?.[0] || 'Fixture'])), ...extra});
const create = async (h, category, values, who = 'user') => {
  const form = (await h.rpc(who, 'getSupportWorkspace', [{category}])).forms[category];
  return (await h.rpc(who, 'createSupportRequest', [{category, formRevision: form.revision, values: fill(form, values), mutationId: crypto.randomUUID()}])).ticket;
};
const forms = async h => (await h.rpc('sa', 'getSupportWorkspace')).forms;

test('v2.5.8 migration is repeatable, reports build 2.5.8 and adds MOTCUBE drive error to the five forms', async t => {
  const {h, ready} = await prepare(t);
  assert.deepEqual(ready, {forms_with_motcube: 5, forms_with_problem_category: 6, v258_ready: true});
  const before = await forms(h);
  assert.deepEqual((await h.db.exec(migration)).at(-1).rows[0], ready, 'second run is the same');
  const after = await forms(h);
  assert.equal((await h.rpc('sa', 'getSession')).build, '2.5.8');
  for (const team of TEAMS) {
    assert.equal(after[team].revision, before[team].revision, team + ': a second run does not bump the form again');
    const f = after[team].fields, cat = f.find(x => x.id === 'problem_category'), sub = f.find(x => x.id === 'problem_sub');
    assert.equal(cat.options.length, 37, team);
    const i = cat.options.indexOf('NICE3000+ drive error');
    assert.equal(cat.options[i + 1], 'MOTCUBE drive error', team + ': right below NICE3000+ drive error');
    assert.equal(cat.options[i + 2], 'NICE900 door drive error', team + ': the rest keeps its order');
    const codes = sub.optionMap['MOTCUBE drive error'];
    assert.equal(codes.length, 61);
    assert.deepEqual([codes[0], codes[18], codes[19], codes.at(-1)], ['H1', 'H19', 'H21', 'H62'], 'H20 is not in the manual');
    assert.ok(!codes.includes('H20'));
    assert.deepEqual(Object.keys(sub.optionMap).sort(), ['AVR related issue', 'MOT drive Error', 'MOTCUBE drive error', 'NBSL-G220 door drive error', 'NICE3000+ drive error', 'NICE900 door drive error'].sort());
    assert.equal(sub.optionMap['MOT drive Error'].length, 100, 'other lists untouched');
    assert.match(sub.help, /MOTCUBE/);
  }
  assert.deepEqual(after.installation.fields.find(x => x.id === 'problem_category').options, ['Mechanical', 'Electrical'], 'Installation only has Mechanical / Electrical and is untouched');
});

test('Choosing MOTCUBE drive error needs one H code; other categories are unchanged', async t => {
  const {h} = await prepare(t);
  await h.db.query("update public.wlf_profiles set permissions=array_cat(permissions,array['support:qc:request','support:aftersales:request']) where id=$1", [IDS.user]);
  await assert.rejects(create(h, 'commissioning', {problem_category: 'MOTCUBE drive error'}), /Required: Problem Sub-Category/);
  await assert.rejects(create(h, 'commissioning', {problem_category: 'MOTCUBE drive error', problem_sub: 'Er01'}), /Invalid choice: Problem Sub-Category/);
  await assert.rejects(create(h, 'commissioning', {problem_category: 'MOTCUBE drive error', problem_sub: 'H20'}), /Invalid choice: Problem Sub-Category/);
  const ok = await create(h, 'commissioning', {problem_category: 'MOTCUBE drive error', problem_sub: 'H62'});
  assert.deepEqual([ok.values.problem_category, ok.values.problem_sub], ['MOTCUBE drive error', 'H62']);
  const qc = await create(h, 'qc', {problem_category: 'MOTCUBE drive error', problem_sub: 'H1'});
  assert.equal(qc.values.problem_sub, 'H1');
  const mot = await create(h, 'aftersales', {problem_category: 'MOT drive Error', problem_sub: 'Er01'});
  assert.equal(mot.values.problem_sub, 'Er01');
  const plain = await create(h, 'aftersales', {problem_category: 'Encoder problem', problem_sub: 'H1'});
  assert.equal(plain.values.problem_sub, '', 'no sub-category for other categories');
});

test('A form that Super Admin already changed is respected', async t => {
  const {h} = await prepare(t, async h => {
    // aftersales: Super Admin already added the option by hand; qc: Super Admin removed the sub-category field
    for (const [team, fn] of [
      ['aftersales', f => f.map(x => x.id === 'problem_category' ? {...x, options: [...x.options, 'MOTCUBE drive error']} : x)],
      ['qc', f => f.filter(x => x.id !== 'problem_sub')]]) {
      const cur = (await h.db.query('select schema from public.wlf_forms where category=$1', [team])).rows[0].schema;
      throw_if(cur);
      await h.db.query('update public.wlf_forms set schema=jsonb_set(schema,\'{fields}\',$2::jsonb) where category=$1', [team, JSON.stringify(fn(cur.fields))]);
    }
  }).catch(e => { throw e; });
  const f = await forms(h);
  const count = team => f[team].fields.find(x => x.id === 'problem_category').options.filter(o => o === 'MOTCUBE drive error').length;
  assert.equal(count('aftersales'), 1, 'not added twice');
  assert.equal(count('qc'), 0, 'a form without the sub-category field is left alone');
  assert.equal(count('commissioning'), 1);
});

function throw_if(schema) { assert.ok(Array.isArray(schema.fields)); }

test('Activity history labels are written in proper case', () => {
  assert.deepEqual(['submit', 'receive', 'forward', 'solve', 'notSolved', 'pending'].map(C.historyLabel),
    ['Submitted', 'Received', 'Forwarded', 'Solved', 'Not Solved', 'Kept Pending']);
  assert.equal(C.historyLabel('someNewAction_x'), 'Some New Action X');
  assert.equal(C.historyLabel(''), '');
  assert.equal(C.historyLabel(null), '');
});
