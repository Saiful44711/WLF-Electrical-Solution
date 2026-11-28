const test = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {makeDB, IDS} = require('./pg-harness.cjs');

const chain = eval(readFileSync('tests/v272-update.test.cjs', 'utf8').match(/const chain = (\[[^\]]*\])/)[1]);
const migration = readFileSync('supabase/UPDATE_V273.sql', 'utf8');

async function prepare(t) {
  const h = await makeDB();
  t.after(() => h.close());
  for (const file of [...chain, 'UPDATE_V272']) await h.db.exec(readFileSync('supabase/' + file + '.sql', 'utf8'));
  const results = await h.db.exec(migration);
  await h.db.query('alter table public.wlf_profiles disable trigger wlf_deletion_guard');
  for (const [who, emp] of [['sa', 'SA-1'], ['rni', 'RN-3'], ['rni2', 'RN-4'], ['user', 'US-5']])
    await h.db.query("update public.wlf_profiles set employee_id=$2, section='R&I Electrical', permissions=array_append(permissions,'ri:projects') where id=$1", [IDS[who], emp]);
  await h.db.query('alter table public.wlf_profiles enable trigger wlf_deletion_guard');
  return {h, ready: results.at(-1).rows[0]};
}
const base = lead => ({name: 'Regen drive', lead, collaborators: [], start: '2026-11-01', end: '2026-12-31', impact: 'Product Development', status: 'In Progress', brief: '', financial: false, documentation: false, tasks: []});
const save = (h, who, data, row) => h.rpc(who, 'saveRiProject', [{id: row?.id || crypto.randomUUID(), operation: crypto.randomUUID(), revision: row?.revision || 0, data}]);
const names = async (h, who) => (await h.rpc(who, 'getRiProjects', [{}])).projects.map(r => r.data.name).sort();

test('v2.7.3 migration is repeatable and reports the new build', async t => {
  const {h, ready} = await prepare(t);
  assert.equal(ready.v273_ready, true);
  assert.equal((await h.db.exec(migration)).at(-1).rows[0].v273_ready, true);
  assert.equal((await h.rpc('sa', 'getSession')).build, '2.7.3');
});

test('a hidden project is seen only by the person who created it and the Super Admin, and can be shown again', async t => {
  const {h} = await prepare(t);
  const mine = await save(h, 'user', {...base(IDS.user), name: 'Mine'});
  const open = await save(h, 'rni', {...base(IDS.rni), name: 'Open'});
  assert.deepEqual(await names(h, 'rni2'), ['Mine', 'Open']);
  // only the creator or the Super Admin may hide
  await assert.rejects(h.rpc('rni', 'setRiProjectHidden', [{id: mine.id, hidden: true}]), /Only the person who created the project or the Super Admin/);
  const hid = await h.rpc('user', 'setRiProjectHidden', [{id: mine.id, hidden: true}]);
  assert.equal(hid.hidden, true);
  assert.equal(hid.revision, mine.revision, 'hiding does not change the revision');
  assert.deepEqual(await names(h, 'rni2'), ['Open']);
  assert.deepEqual(await names(h, 'rni'), ['Open']);
  assert.deepEqual(await names(h, 'user'), ['Mine', 'Open'], 'the creator still sees it');
  assert.deepEqual(await names(h, 'sa'), ['Mine', 'Open'], 'Super Admin sees it');
  assert.equal((await h.rpc('sa', 'getRiProjects', [{}])).projects.find(r => r.data.name === 'Mine').hidden, true);
  // the creator can still edit it with the revision they hold
  const edited = await save(h, 'user', {...base(IDS.user), name: 'Mine', brief: 'changed'}, hid);
  assert.equal(edited.hidden, true, 'editing keeps it hidden');
  // dashboards and My work do not count it for other people
  const asUser = async (who, sql) => { await h.db.exec('reset role'); await h.db.query("select set_config('request.jwt.claim.sub',$1,false)", [IDS[who]]); return (await h.db.query(sql)).rows[0]; };
  assert.equal((await asUser('rni2', 'select count(*)::int n from wlf_private.ri_projects_visible')).n, 1);
  assert.equal((await asUser('user', 'select count(*)::int n from wlf_private.ri_projects_visible')).n, 2);
  assert.equal((await asUser('sa', 'select count(*)::int n from wlf_private.ri_projects_visible')).n, 2);
  // the management dashboard (project list, counts) is built from the visible projects only
  await h.db.query("update public.wlf_profiles set permissions=array_append(permissions,'workspace:dashboard') where id=$1", [IDS.rni2]);
  const mgmt = async who => JSON.stringify((await asUser(who, "select wlf_private.management_dashboard('{}'::jsonb) d")).d);
  assert.ok(!(await mgmt('rni2')).includes('"Mine"'), 'others do not see the hidden project in the dashboard');
  assert.ok((await mgmt('sa')).includes('"Mine"'), 'Super Admin sees it in the dashboard');
  // show again
  await h.rpc('user', 'setRiProjectHidden', [{id: mine.id, hidden: false}]);
  assert.deepEqual(await names(h, 'rni2'), ['Mine', 'Open']);
  // the Super Admin can hide somebody else's project too
  await h.rpc('sa', 'setRiProjectHidden', [{id: open.id, hidden: true}]);
  assert.deepEqual(await names(h, 'rni2'), ['Mine']);
  await assert.rejects(h.rpc('rni2', 'setRiProjectHidden', [{id: '00000000-0000-0000-0000-00000000dead', hidden: true}]), /no longer available/);
});

test('a restored backup of older projects (no hidden value) still works and is treated as not hidden', async t => {
  const {h} = await prepare(t);
  await h.db.query("insert into public.wlf_ri_projects(id,owner,data,last_operation,last_payload_hash,hidden) values($1,$2,$3,$4,'x',null)",
    ['00000000-0000-0000-0000-0000000000c1', IDS.user, JSON.stringify(base(IDS.user)), '00000000-0000-0000-0000-0000000000c2']);
  assert.deepEqual(await names(h, 'rni2'), ['Regen drive']);
});
