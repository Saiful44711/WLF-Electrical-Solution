const test = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {makeDB, IDS} = require('./pg-harness.cjs');
const TroubleCore = require('../shared/troubleshooting-core.js');

const chain = ['UPDATE_V220','UPDATE_SUPPORT_FORMS_20261107','UPDATE_DAMAGE_DEMAND_20261107','UPDATE_WORKSPACE_20261107','UPDATE_SECTIONS_V230','UPDATE_V240','UPDATE_V250','UPDATE_V251','UPDATE_V252','UPDATE_V253','UPDATE_V254','UPDATE_V255'];
const migration = readFileSync('supabase/UPDATE_V256.sql','utf8');

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
const grant = (h, who, ...keys) => h.db.query('update public.wlf_profiles set permissions=array_cat(permissions,$2) where id=$1', [IDS[who], keys]);
const damage = (h, category, item, qty) => h.db.query(`insert into wlf_private.damage_demands(request_id,category,request_reference,requester_id,requester_name,requested_at,project,lift_id,controllers,problem_categories,form_schema,form_values,confirmed_by,confirmed_name,solution_statement,item_name,item_code,item_spec,quantity,create_operation,create_payload_hash)
  values(gen_random_uuid(),$1,'R-1',$3,'u',now(),'P','1','{}','{}','{}','{}',$3,'rni','fixed',$2,'','',$4,gen_random_uuid(),'\\x00') returning request_id`, [category, item, IDS.rni, qty]).then(r => r.rows[0].request_id);
const crypto = require('node:crypto');
const fillFields = (fields, extra = {}) => ({...Object.fromEntries(fields.filter(f => !f.autoFill && !f.dependsOn && f.type !== 'checkbox').map(f => [f.id,
  f.type === 'multi' ? f.options.slice(0, 1) : f.type === 'date' ? '2026-11-17' : f.type === 'number' ? '12' : f.options?.[0] || 'Fixture'])), ...extra});
const createSupport = async (h, category = 'commissioning', who = 'user') => {
  const form = (await h.rpc(who, 'getSupportWorkspace', [{category}])).forms[category];
  return (await h.rpc(who, 'createSupportRequest', [{category, formRevision: form.revision, values: fillFields(form.fields, {problem_category: 'Encoder problem'}), mutationId: crypto.randomUUID()}])).ticket;
};

const usage = (h, who, action, daysAgo) => h.db.query(`insert into public.wlf_usage(actor,action,details,at) values($1,$2,'',now()-make_interval(days=>$3))`, [IDS[who], action, daysAgo]);
const dhaka = d => new Date(Date.now() + 6 * 3600e3 - d * 86400e3).toISOString().slice(0, 10);

test('v2.5.6 migration is repeatable; My Activity is removed; supplier labels renamed', async t => {
  const {h, ready} = await prepare(t);
  assert.deepEqual(ready, {my_activity_removed: true, usage_permissions_ready: true, component_log_ready: true, v256_ready: true});
  assert.deepEqual((await h.db.exec(migration)).at(-1).rows[0], ready, 'second run is the same');
  assert.equal((await h.rpc('sa', 'getSession')).build, '2.5.6');
  await assert.rejects(h.rpc('user', 'getMyActivity'), /removed/);
  await assert.rejects(h.rpc('sa', 'getMyActivity'), /removed/);
  const cat = (await h.rpc('sa', 'listAppUsers')).catalog;
  assert.equal(cat.filter(x => x.key === 'usage:dashboard').length, 1);
  assert.equal(cat.find(x => x.key === 'usage:dashboard').group, 'Usage Dashboard');
  assert.equal(cat.find(x => x.key === 'components:log').group, 'Usage Dashboard');
  assert.match(cat.find(x => x.key === 'supplier:claim').label, /Claim Sent to Supplier/);
  assert.match(cat.find(x => x.key === 'supplier:confirm').label, /Supplier Accepted Claim/);
  assert.equal(new Set(cat.map(x => x.key)).size, cat.length, 'no duplicate keys');
});

test('Usage Dashboard: 7 days, needs the tick (Admin / R&I lose automatic access), holders see every user', async t => {
  const {h} = await prepare(t);
  await usage(h, 'user', 'Component Selection', 1);
  await usage(h, 'rni', 'Power Calculation', 2);
  await usage(h, 'user', 'Component Selection', 9);
  await usage(h, 'admin', 'Login', 40);
  for (const who of ['rni', 'admin', 'user']) {
    await assert.rejects(h.rpc(who, 'getUsageLog'), /Usage Dashboard access required/, who);
    await assert.rejects(h.rpc(who, 'adminStats'), /Permission denied/, who);
  }
  const sa = await h.rpc('sa', 'getUsageLog');
  assert.equal(sa.days, 7);
  assert.equal(sa.total, 2);
  assert.deepEqual(sa.old, {count: 2, oldest: sa.old.oldest});
  assert.equal(sa.all.count, 4);
  await grant(h, 'user', 'usage:dashboard');
  const u = await h.rpc('user', 'getUsageLog');
  assert.equal(u.total, 2, 'a ticked User sees every user');
  assert.equal(u.old, null, 'old-log tools stay Super Admin only');
  assert.equal(u.people.length, 2);
  assert.equal((await h.rpc('user', 'getUsageLog', [{member: IDS.rni}])).total, 1);
  const stats = await h.rpc('user', 'adminStats');
  const total = r => r.total;
  assert.equal(stats.rows.reduce((n, r) => n + Number(total(r)), 0), 2, 'stats count the last 7 days only');
  await assert.rejects(h.rpc('user', 'exportOldUsageLog', [{}]), /Super Admin only/);
  await assert.rejects(h.rpc('user', 'purgeUsageRange', [{from: dhaka(3), to: dhaka(0), confirm: 'DELETE'}]), /Super Admin only/);
  // old 7-day download/delete flow
  const exp = await h.rpc('sa', 'exportOldUsageLog', [{}]);
  assert.equal(exp.rows.length, 2);
  assert.equal((await h.rpc('sa', 'purgeUsageLog', [{before: exp.before, confirm: 'DELETE'}])).deleted, 2);
  assert.equal((await h.rpc('sa', 'getRecycleBin')).purges[0].what, 'Usage log older than 7 days');
});

test('Super Admin deletes the activity log of a From-To period', async t => {
  const {h} = await prepare(t);
  for (const d of [0, 1, 2, 3, 10]) await usage(h, 'user', 'Login', d);
  await assert.rejects(h.rpc('sa', 'countUsageRange', [{from: dhaka(3)}]), /both From and To/);
  await assert.rejects(h.rpc('sa', 'countUsageRange', [{from: dhaka(0), to: dhaka(3)}]), /From date must be/);
  const c = await h.rpc('sa', 'countUsageRange', [{from: dhaka(2), to: dhaka(1)}]);
  assert.equal(c.count, 2);
  await assert.rejects(h.rpc('sa', 'purgeUsageRange', [{from: dhaka(2), to: dhaka(1)}]), /Type DELETE/);
  assert.equal((await h.rpc('sa', 'purgeUsageRange', [{from: dhaka(2), to: dhaka(1), confirm: 'DELETE'}])).deleted, 2);
  assert.equal((await h.db.query('select count(*)::int n from public.wlf_usage')).rows[0].n, 3);
  assert.equal((await h.rpc('sa', 'getRecycleBin')).purges[0].what, `Activity log ${dhaka(2)} to ${dhaka(1)}`);
  await grant(h, 'rni', 'usage:dashboard');
  await assert.rejects(h.rpc('rni', 'countUsageRange', [{from: dhaka(2), to: dhaka(1)}]), /Super Admin only/);
});

test('Component change log records add / edit / delete with old and new values; viewing needs both ticks', async t => {
  const {h} = await prepare(t);
  const d = await h.rpc('sa', 'adminGetComponents');
  const v = d.records[0].values.slice(); v[0] = '7777'; v[5] = 'TEST-MOTOR';
  await h.rpc('sa', 'adminSaveComponent', [null, v]);
  const row = (await h.rpc('sa', 'adminGetComponents')).records.find(x => String(x.values[0]) === '7777');
  const v2 = row.values.slice(); v2[7] = '9.9';
  await h.rpc('sa', 'adminSaveComponent', [row.sheetRow, v2]);
  await h.rpc('sa', 'adminSaveComponent', [row.sheetRow, v2]);
  await h.rpc('sa', 'adminDeleteComponent', [row.sheetRow]);
  await h.db.query(`select set_config('request.jwt.claim.sub','',false)`);
  await h.db.query(`update public.wlf_components set values=jsonb_set(values,'{1}','"9"') where id=(select min(id) from public.wlf_components)`);
  const log = await h.rpc('sa', 'getComponentLog', [{}]);
  assert.deepEqual(log.rows.map(r => r.action), ['Edited', 'Deleted', 'Edited', 'Added'], 'saving without changes is not logged');
  const [sql, del, edit, add] = log.rows;
  assert.equal(sql.who, 'Database (SQL Editor)');
  assert.ok(add.who.length > 0 && add.who !== 'Database (SQL Editor)');
  assert.match(add.label, /7777 KG/);
  assert.match(add.label, /TEST-MOTOR/);
  assert.ok(add.changes.some(c => c.field === 'Capacity (KG)' && c.old === '' && c.new === '7777'));
  assert.deepEqual(edit.changes, [{field: 'Motor Power (KW)', old: String(row.values[7] ?? ''), new: '9.9'}]);
  assert.ok(del.changes.every(c => c.new === ''));
  assert.equal((await h.rpc('sa', 'getComponentLog', [{q: 'test-motor'}])).total, 3);
  assert.equal((await h.rpc('sa', 'getComponentLog', [{from: '2020-01-01', to: '2020-01-02'}])).total, 0);
  await grant(h, 'user', 'components:log');
  await assert.rejects(h.rpc('user', 'getComponentLog'), /Component change log access required/, 'needs the Usage Dashboard tick too');
  await grant(h, 'user', 'usage:dashboard');
  assert.equal((await h.rpc('user', 'getComponentLog')).total, 4);
  await grant(h, 'rni', 'usage:dashboard');
  await assert.rejects(h.rpc('rni', 'getComponentLog'), /access required/);
});

test('Management Dashboard lists every Technical Support and Damage Demand team, also with no requests', async t => {
  const {h} = await prepare(t);
  await grant(h, 'admin', 'workspace:dashboard');
  await createSupport(h);
  await damage(h, 'aftersales', 'Encoder', 3);
  const d = await h.rpc('admin', 'getManagementDashboard');
  assert.deepEqual(d.support.teams.map(x => x.team), ['commissioning', 'aftersales', 'production', 'maintenance', 'qc', 'installation']);
  assert.equal(d.support.teams[0].total, 1);
  assert.deepEqual(d.support.teams[4], {team: 'qc', total: 0, solved: 0, notSolved: 0, open: 0});
  assert.deepEqual(Object.keys(d.support.curve).sort(), ['aftersales', 'commissioning', 'installation', 'maintenance', 'production', 'qc']);
  assert.equal(d.support.curve.qc.length, 12);
  assert.deepEqual(d.damage.teams.map(x => x.team), ['commissioning', 'aftersales', 'installation', 'maintenance']);
  assert.deepEqual(d.damage.teams[1], {team: 'aftersales', total: 1, pending: 1, received: 0, quantity: 3});
  assert.deepEqual(d.damage.teams[0], {team: 'commissioning', total: 0, pending: 0, received: 0, quantity: 0});
  assert.equal(Object.keys(d.damage.curve).length, 4);
});
