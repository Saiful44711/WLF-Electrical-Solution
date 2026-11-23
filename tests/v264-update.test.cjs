const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {readFileSync} = require('node:fs');
const {makeDB, IDS} = require('./pg-harness.cjs');

const chain = ['UPDATE_V220','UPDATE_SUPPORT_FORMS_20261107','UPDATE_DAMAGE_DEMAND_20261107','UPDATE_WORKSPACE_20261107','UPDATE_SECTIONS_V230','UPDATE_V240','UPDATE_V250','UPDATE_V251','UPDATE_V252','UPDATE_V253','UPDATE_V254','UPDATE_V255','UPDATE_V256','UPDATE_V257','UPDATE_V258','UPDATE_V259','UPDATE_V260','UPDATE_V261','UPDATE_V262','UPDATE_V263'];
const migration = readFileSync('supabase/UPDATE_V264.sql','utf8');

async function prepare(t) {
  const h = await makeDB();
  t.after(() => h.close());
  for (const file of chain) await h.db.exec(readFileSync('supabase/'+file+'.sql','utf8'));
  const results = await h.db.exec(migration);
  return {h, ready: results.at(-1).rows[0]};
}
const give = (h, who, ...keys) => h.db.query('update public.wlf_profiles set permissions=array_cat(permissions,$2) where id=$1', [IDS[who], keys]);
async function entry(h, who, section, status, minutes, daysAgo = 0, key = 'duration_minute') {
  const cat = (await h.db.query('select id from public.wlf_ri_categories where section=$1 order by position limit 1', [section])).rows[0].id;
  await h.db.query(`insert into public.wlf_ri_entries(id,category,owner,author_name,created_at,updated_at,status,form_schema,values,last_operation,last_payload_hash)
    values($1,$2,$3,'x',now()-($4||' days')::interval,now(),$5,'{}'::jsonb,$6,$7,'h')`,
    [crypto.randomUUID(), cat, IDS[who], String(daysAgo), status, JSON.stringify(minutes === null ? {} : {[key]: minutes}), crypto.randomUUID()]);
}

test('v2.6.4 migration is repeatable and renames the Dashboard permission to Admin Panel', async t => {
  const {h, ready} = await prepare(t);
  assert.equal(ready.admin_panel_ready, true);
  assert.equal(ready.v264_ready, true);
  assert.match(ready.permission_label, /^Admin Panel \//);
  const again = (await h.db.exec(migration)).at(-1).rows[0];
  assert.equal(again.v264_ready, true);
  assert.equal((await h.rpc('sa', 'getSession')).build, '2.6.4');
  const keys = (await h.db.query("select e from jsonb_array_elements(wlf_private.catalog()) e where e->>'key'='workspace:dashboard'")).rows;
  assert.equal(keys.length, 1, 'the permission is listed once');
  assert.equal(keys[0].e.group, 'Admin Panel');
});

test('Admin Panel shows each approved R&I user: sectors, status split, minutes, support, damage demands and curves', async t => {
  const {h} = await prepare(t);
  await h.db.query("update public.wlf_profiles set role='R&I' where id=any($1)", [[IDS.rni, IDS.rni2]]);
  await h.db.query("update public.wlf_profiles set role='User' where id=$1", [IDS.user]);
  await give(h, 'admin', 'workspace:dashboard');
  await entry(h, 'rni', 'team', 'Completed', 30);
  await entry(h, 'rni', 'team', 'Ongoing', 45);
  await entry(h, 'rni', 'team', 'Hold', 10);
  await entry(h, 'rni', 'scm', 'Completed', 90, 0, 'duration_min');
  await entry(h, 'rni', 'sales', 'Cancelled', null);
  await entry(h, 'rni', 'team', 'Completed', 500, 400);       // outside the period and the 12-month curve
  await entry(h, 'rni2', 'reports', 'Completed', 20);
  const data = await h.rpc('admin', 'getAdminPanel', [{}]);
  assert.equal(data.months.length, 12);
  const names = data.users.map(u => u.name);
  assert.equal(data.users.length, 2, 'only approved R&I users, not other roles: ' + names);
  const me = data.users.find(u => u.id === IDS.rni);
  const sector = k => me.sectors.find(x => x.section === k);
  assert.deepEqual(me.sectors.map(x => x.section), ['team', 'scm', 'sales', 'reports']);
  assert.deepEqual([sector('team').completed, sector('team').ongoing, sector('team').incomplete, Number(sector('team').minutes)], [1, 1, 1, 85]);
  assert.equal(Number(sector('scm').minutes), 90);
  assert.equal(sector('sales').incomplete, 1);
  assert.equal(Number(sector('sales').minutes), 0);
  assert.equal(Number(sector('reports').entries), 0);
  assert.equal(me.curve['Activity entries'].length, 12);
  assert.equal(Number(me.curve['Activity entries'][11]), 5, 'this month holds the 5 recent entries');
  assert.equal(Number(me.curve['Activity entries'].reduce((a, b) => a + Number(b), 0)), 5, 'the 400-day-old entry is outside 12 months');
  assert.equal(Number(me.support.received), 0);
  assert.equal(Number(me.damage), 0);
  assert.equal(Number(me.claims), 0);
});

test('Admin Panel needs the permission and the support numbers follow the period', async t => {
  const {h} = await prepare(t);
  await h.db.query("update public.wlf_profiles set role='R&I' where id=$1", [IDS.rni]);
  await assert.rejects(() => h.rpc('user', 'getAdminPanel', [{}]), /Admin Panel access required/);
  await assert.rejects(() => h.rpc('rni', 'getAdminPanel', [{}]), /Admin Panel access required/);
  assert.ok((await h.rpc('sa', 'getAdminPanel', [{from: '2026-01-01', to: '2026-01-31'}])).users.length >= 1);
  await assert.rejects(() => h.rpc('sa', 'getAdminPanel', [{from: '2026-02-01', to: '2026-01-01'}]), /From date must be/);
});
