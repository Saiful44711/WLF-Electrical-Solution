const test = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {makeDB, IDS} = require('./pg-harness.cjs');

const chain = ['UPDATE_V220','UPDATE_SUPPORT_FORMS_20261107','UPDATE_DAMAGE_DEMAND_20261107','UPDATE_WORKSPACE_20261107','UPDATE_SECTIONS_V230','UPDATE_V240','UPDATE_V250','UPDATE_V251'];
const migration = readFileSync('supabase/UPDATE_V252.sql','utf8');

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
const fill = (form, extra = {}) => ({...Object.fromEntries(form.fields.filter(f => !f.autoFill && !f.dependsOn).map(f => [f.id,
  f.type === 'multi' ? f.options.slice(0, 1) : f.type === 'date' ? '2026-11-17' : f.type === 'number' ? '12' : f.options?.[0] || 'Fixture'])), ...extra});
const create = async (h, category, values, who = 'user') => {
  const form = (await h.rpc(who, 'getSupportWorkspace', [{category}])).forms[category];
  return (await h.rpc(who, 'createSupportRequest', [{category, formRevision: form.revision, values: fill(form, values), mutationId: crypto.randomUUID()}])).ticket;
};

test('v2.5.2 migration is repeatable; five forms get the new categories and sub-category lists', async t => {
  const {h, ready} = await prepare(t, h => h.db.query("update public.wlf_profiles set permissions=array_append(permissions,'damage:receive') where id=$1", [IDS.admin]));
  assert.deepEqual(ready, {problem_sub_category_ready: true, problem_categories_ready: true, damage_receive_by_team_ready: true, v252_ready: true});
  assert.equal((await h.db.exec(migration)).at(-1).rows[0].v252_ready, true);
  assert.equal((await h.rpc('sa', 'getSession')).build, '2.5.2');
  const forms = (await h.rpc('sa', 'getSupportWorkspace')).forms;
  for (const team of ['commissioning','aftersales','production','qc','maintenance']) {
    const f = forms[team].fields, cat = f.find(x => x.id === 'problem_category'), sub = f.find(x => x.id === 'problem_sub');
    assert.equal(cat.options.length, 36, team);
    assert.equal(f.indexOf(sub), f.indexOf(cat) + 1, team + ' sub-category follows category');
    assert.equal(sub.dependsOn, 'problem_category');
    assert.deepEqual(Object.fromEntries(Object.keys(sub.optionMap).map(k => [k, sub.optionMap[k].length])),
      {'MOT drive Error': 100, 'NICE3000+ drive error': 157, 'NICE900 door drive error': 22, 'NBSL-G220 door drive error': 26, 'AVR related issue': 8});
    assert.ok(!cat.options.some(o => /releted|dirve|isuue|Proximitry/.test(o)));
  }
  assert.ok(!forms.installation.fields.some(x => x.id === 'problem_sub'), 'Installation unchanged');
  const admin = (await h.db.query('select permissions from public.wlf_profiles where id=$1', [IDS.admin])).rows[0].permissions;
  assert.ok(!admin.includes('damage:receive') && ['commissioning','aftersales','installation','maintenance'].every(k => admin.includes('damage:receive:' + k)));
});

test('Sub-category: required and checked for the first five categories, empty otherwise', async t => {
  const {h} = await prepare(t);
  await h.db.query("update public.wlf_profiles set permissions=array_cat(permissions,array['support:qc:request','support:aftersales:request','support:maintenance:request','support:commissioning:request']) where id=$1", [IDS.user]);
  await assert.rejects(create(h, 'commissioning', {problem_category: 'NICE3000+ drive error'}), /Required: Problem Sub-Category/);
  await assert.rejects(create(h, 'commissioning', {problem_category: 'NICE3000+ drive error', problem_sub: 'Er01'}), /Invalid choice: Problem Sub-Category/);
  const ok = await create(h, 'commissioning', {problem_category: 'NICE3000+ drive error', problem_sub: 'Err20 · Sub 5'});
  assert.equal(ok.values.problem_sub, 'Err20 · Sub 5');
  const avr = await create(h, 'qc', {problem_category: 'AVR related issue', problem_sub: '40 KVA'});
  assert.equal(avr.values.problem_sub, '40 KVA');
  const plain = await create(h, 'aftersales', {problem_category: 'Encoder problem', problem_sub: 'Er01'});
  assert.equal(plain.values.problem_sub, '', 'no sub-category for other categories');
  const other = await create(h, 'maintenance', {problem_category: 'Others: Car light dims'});
  assert.equal(other.values.problem_category, 'Others: Car light dims');
  // Super Admin edits a list through the normal form save
  const form = (await h.rpc('sa', 'getSupportWorkspace')).forms.commissioning;
  const fields = form.fields.map(f => f.id === 'problem_sub' ? {...f, optionMap: {...f.optionMap, 'AVR related issue': ['15 KVA', '150 KVA'], 'UPS related problem': ['1 KVA', '3 KVA']}} : f);
  const saved = await h.rpc('sa', 'saveSupportSchema', [{category: 'commissioning', revision: form.revision, schema: {fields}}]).catch(e => e);
  if (saved instanceof Error) throw saved;
  const after = (await h.rpc('sa', 'getSupportWorkspace')).forms.commissioning.fields.find(f => f.id === 'problem_sub');
  assert.deepEqual(after.optionMap['AVR related issue'], ['15 KVA', '150 KVA']);
  assert.deepEqual(after.optionMap['UPS related problem'], ['1 KVA', '3 KVA']);
  const bad = form.fields.map(f => f.id === 'problem_sub' ? {...f, optionMap: {'No such category': ['x']}} : f);
  const now = (await h.rpc('sa', 'getSupportWorkspace')).forms.commissioning;
  await assert.rejects(h.rpc('sa', 'saveSupportSchema', [{category: 'commissioning', revision: now.revision, schema: {fields: bad}}]), /does not match any Problem Category option/);
});

test('Damage Demand receive is checked per team; forwarded list shows only my unreceived requests', async t => {
  const {h} = await prepare(t);
  await h.db.query("update public.wlf_profiles set permissions=array_cat(permissions,array['support:commissioning:request','support:aftersales:request']) where id in ($1,$2)", [IDS.rni, IDS.rni2]);
  const ticket = await create(h, 'commissioning', {project: 'Forward Tower', lift: '501', problem_category: 'Encoder problem'});
  const tr = (who, t0, action, extra = {}) => h.rpc(who, 'transitionSupportRequest', [{id: t0.id, revision: t0.revision, action, mutationId: crypto.randomUUID(), ...extra}]).then(r => r.ticket);
  let tk = await tr('rni', ticket, 'receive');
  tk = await tr('rni', tk, 'forward', {to: 'rni2@example.test', comment: 'Please check encoder'});
  let mine = await h.rpc('rni2', 'getMyForwarded');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].project, 'Forward Tower');
  assert.equal(mine[0].comment, 'Please check encoder');
  assert.match(mine[0].forwardedBy, /\(RN-3\)$/);
  assert.deepEqual(await h.rpc('rni', 'getMyForwarded'), []);
  tk = await tr('rni2', tk, 'receive');
  assert.deepEqual(await h.rpc('rni2', 'getMyForwarded'), []);

  // damage demand from this request (commissioning) — receive needs damage:receive:commissioning
  const demand = await h.rpc('rni2', 'createDamageDemand', [{id: tk.id, revision: tk.revision, operation: crypto.randomUUID(),
    itemName: 'Encoder', quantity: '1', durationMinutes: '20', solutionStatement: 'Replace encoder.'}]);
  const id = demand.ticket.id;
  await h.db.query("update public.wlf_profiles set permissions=array_cat(permissions,array['damage:demand','damage:receive:aftersales']) where id=$1", [IDS.admin]);
  const list = await h.rpc('admin', 'getDamageDemands', [{}]);
  assert.equal(list.teamPending.commissioning, 1);
  await assert.rejects(h.rpc('admin', 'receiveDamageDemand', [{id}]), /Receive access for this team/);
  await h.db.query("update public.wlf_profiles set permissions=array_append(permissions,'damage:receive:commissioning') where id=$1", [IDS.admin]);
  const got = await h.rpc('admin', 'receiveDamageDemand', [{id}]);
  assert.equal(got.status, 'Received');
  assert.equal((await h.rpc('admin', 'getDamageDemands', [{}])).teamPending.commissioning, undefined);
});

test('Request access must carry Name, ID and Section; dashboard-made accounts still work', async t => {
  const {h} = await prepare(t);
  const add = (id, email, meta) => h.db.query('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)', [id, email, JSON.stringify(meta)]);
  await assert.rejects(add('00000000-0000-0000-0000-0000000000a1', 'a@example.test', {name: 'A', employeeId: '', section: 'Production'}), /Fill in Name, Employee ID and Section/);
  await assert.rejects(add('00000000-0000-0000-0000-0000000000a2', 'b@example.test', {name: 'B', employeeId: 'B-1', section: 'Nowhere'}), /Choose a section/);
  await add('00000000-0000-0000-0000-0000000000a3', 'c@example.test', {name: 'C', employeeId: 'US-5', section: 'Production'});
  const row = (await h.db.query("select employee_id, section, status from public.wlf_profiles where email='c@example.test'")).rows[0];
  assert.deepEqual(row, {employee_id: 'US-5', section: 'Production', status: 'Pending'}, 'duplicate ID is allowed (marked in User Management)');
  await add('00000000-0000-0000-0000-0000000000a4', 'd@example.test', {});
  assert.equal((await h.db.query("select count(*)::int n from public.wlf_profiles where email='d@example.test'")).rows[0].n, 1);
});
