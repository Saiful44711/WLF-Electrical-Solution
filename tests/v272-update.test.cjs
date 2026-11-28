const test = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {makeDB, IDS} = require('./pg-harness.cjs');

const chain = ['UPDATE_V220','UPDATE_SUPPORT_FORMS_20261107','UPDATE_DAMAGE_DEMAND_20261107','UPDATE_WORKSPACE_20261107','UPDATE_SECTIONS_V230','UPDATE_V240','UPDATE_V250','UPDATE_V251','UPDATE_V252','UPDATE_V253','UPDATE_V254','UPDATE_V255','UPDATE_V256','UPDATE_V257','UPDATE_V258','UPDATE_V259','UPDATE_V260','UPDATE_V261','UPDATE_V262','UPDATE_V263','UPDATE_V264','UPDATE_V265','UPDATE_V266','UPDATE_V267','UPDATE_V268','UPDATE_V270','UPDATE_V271'];
const migration = readFileSync('supabase/UPDATE_V272.sql','utf8');

async function prepare(t) {
  const h = await makeDB();
  t.after(() => h.close());
  for (const file of chain) await h.db.exec(readFileSync('supabase/'+file+'.sql','utf8'));
  const results = await h.db.exec(migration);
  return {h, ready: results.at(-1).rows[0]};
}
const signUp = (h, id, email, meta) => h.db.query('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)', [id, email, JSON.stringify(meta)]);
const admin = async (h, action, actor, payload = {}) => (await h.db.query('select public.wlf_report_admin($1,$2,$3) r', [action, actor, payload])).rows[0].r;

test('v2.7.2 migration is repeatable and reports the new build', async t => {
  const {h, ready} = await prepare(t);
  assert.equal(ready.v272_ready, true);
  assert.equal((await h.db.exec(migration)).at(-1).rows[0].v272_ready, true);
  assert.equal((await h.rpc('sa', 'getSession')).build, '2.7.2');
  for (const ix of ['wlf_requests_created_idx', 'wlf_history_at_idx', 'wlf_ri_entries_created_idx', 'qms_lifts_created_idx', 'damage_demands_claim_idx'])
    assert.ok((await h.db.query('select to_regclass($1) r', ['public.' + ix])).rows[0].r || (await h.db.query('select to_regclass($1) r', ['wlf_private.' + ix])).rows[0].r, ix);
});

test('Request access: a sign-up with a name but no Employee ID or Section is refused; dashboard accounts still work', async t => {
  const {h} = await prepare(t);
  await assert.rejects(signUp(h, '00000000-0000-0000-0000-0000000000b1', 'old-app@example.test', {name: 'Old App User'}), /Fill in Name, Employee ID and Section/);
  await assert.rejects(signUp(h, '00000000-0000-0000-0000-0000000000b2', 'half@example.test', {name: 'Half', employeeId: 'E-1'}), /Fill in Name, Employee ID and Section/);
  await assert.rejects(signUp(h, '00000000-0000-0000-0000-0000000000b3', 'blank@example.test', {name: ' ', employeeId: 'E-2', section: 'Production'}), /Fill in Name/);
  assert.equal((await h.db.query("select count(*)::int n from public.wlf_profiles where email in ('old-app@example.test','half@example.test','blank@example.test')")).rows[0].n, 0, 'nothing was saved');
  await signUp(h, '00000000-0000-0000-0000-0000000000b4', 'full@example.test', {name: 'Full', employeeId: 'E-3', section: 'Production'});
  await signUp(h, '00000000-0000-0000-0000-0000000000b5', 'dash@example.test', {});
  const rows = (await h.db.query("select email, employee_id, section, status from public.wlf_profiles where email in ('full@example.test','dash@example.test') order by email")).rows;
  assert.deepEqual(rows, [{email: 'dash@example.test', employee_id: null, section: null, status: 'Pending'}, {email: 'full@example.test', employee_id: 'E-3', section: 'Production', status: 'Pending'}]);
});

test('an account without Employee ID and Section cannot be approved; with both it can; approved accounts can still be edited', async t => {
  const {h} = await prepare(t);
  await signUp(h, '00000000-0000-0000-0000-0000000000c1', 'dash2@example.test', {});
  const row = async () => (await h.rpc('sa', 'listAppUsers')).users.find(u => u.email === 'dash2@example.test');
  let u = await row();
  await assert.rejects(h.rpc('sa', 'saveAppUserAccess', [{...u, status: 'Approved'}]), /Fill in the Employee ID and the Section before approving/);
  await assert.rejects(h.rpc('sa', 'saveAppUserAccess', [{...u, empId: 'D-9', status: 'Approved'}]), /before approving/);
  assert.equal((await row()).status, 'Pending');
  await h.rpc('sa', 'saveAppUserAccess', [{...u, empId: 'D-9', section: 'Production', status: 'Approved'}]);
  u = await row();
  assert.equal(u.status, 'Approved');
  await h.rpc('sa', 'saveAppUserAccess', [{...u, permissions: u.permissions}]);   // later edits keep working
});

test('error log: any signed-in account can write, only the Super Admin reads or clears; 30 per hour, 7 days', async t => {
  const {h} = await prepare(t);
  assert.equal((await h.rpc('user', 'logClientError', [{page: 'qms', message: 'TypeError: x is undefined', detail: 'at hardware.js:1', version: '2.7.2'}])).saved, true);
  await assert.rejects(h.rpc('user', 'getClientErrors', [{}]), /Super Admin only/);
  const list = await h.rpc('sa', 'getClientErrors', [{}]);
  assert.equal(list.total, 1); assert.equal(list.errors[0].page, 'qms'); assert.match(list.errors[0].message, /x is undefined/); assert.ok(list.errors[0].who);
  for (let i = 0; i < 40; i++) await h.rpc('user', 'logClientError', [{message: 'loop ' + i, detail: 'x'.repeat(5000)}]);
  const after = await h.rpc('sa', 'getClientErrors', [{}]);
  assert.equal(after.total, 30, 'at most 30 per account per hour');
  assert.ok(after.errors.every(e => e.detail.length <= 2000), 'long text is cut');
  await h.db.query("update wlf_private.client_errors set at=now()-interval '8 days'");
  assert.equal((await h.rpc('sa', 'getClientErrors', [{}])).total, 0, 'older than 7 days is removed');
  await h.rpc('user', 'logClientError', [{message: 'again'}]);
  assert.equal((await h.rpc('sa', 'clearClientErrors', [{}])).deleted, 1);
});

test('snapshot clean-up keeps snapshots of live and binned lifts and removes the rest', async t => {
  const {h} = await prepare(t);
  const pack = async parts => (await h.db.query('select wlf_private.qms_parts_pack($1::jsonb) p', [JSON.stringify(parts)])).rows[0].p;
  const live = await pack([{section: 'control', grp: 'Drive', hardware: 'Drive A'}]);
  const binned = await pack([{section: 'control', grp: 'Drive', hardware: 'Drive B'}]);
  await pack([{section: 'control', grp: 'Drive', hardware: 'Orphan C'}]);
  await h.db.query(`insert into wlf_private.qms_lifts(id,lift_id,project,parts,created_by) values(gen_random_uuid(),'G-1','P',$1,$3),(gen_random_uuid(),'G-2','P',$2,$3)`, [JSON.stringify(live), JSON.stringify(binned), IDS.sa]);
  await h.db.query("update wlf_private.qms_lifts set deleted_at=now() where lift_id='G-2'");
  assert.equal((await h.db.query('select wlf_private.hw_snap_gc() n')).rows[0].n, 1, 'only the orphan goes');
  const left = (await h.db.query('select body->>\'hardware\' hw from wlf_private.hw_snap order by 1')).rows.map(r => r.hw);
  assert.ok(left.includes('Drive A') && left.includes('Drive B') && !left.includes('Orphan C'));
});

test('monthly Excel backup: pending kinds for last month, receipts only for a matching run, history and the schedule token', async t => {
  const {h} = await prepare(t);
  await h.db.query("update wlf_private.report_settings set backup_enabled=true, token=repeat('a',48), updated_by=$1 where id=1", [IDS.sa]);
  const pend = await admin(h, 'pending', null, {token: 'a'.repeat(48)});
  assert.deepEqual(pend.kinds, [], 'reports are off');
  assert.deepEqual(pend.backups, ['support', 'activity', 'project', 'qms', 'damage', 'claim']);
  assert.equal((await admin(h, 'backupActor', null, {token: 'a'.repeat(48)})).actor, IDS.sa);
  await assert.rejects(admin(h, 'pending', null, {token: 'b'.repeat(48)}), /not allowed/);
  await assert.rejects(admin(h, 'history', null, {token: 'a'.repeat(48)}), /Not allowed for the schedule/);
  const id = '00000000-0000-0000-0000-00000000ab01';
  await h.db.query(`insert into wlf_private.excel_runs(id,actor,kind,date_from,date_to,with_clear,workbook_id,workbook_hash) values($1,$2,'qms',$3,$4,false,'file_abc_123',repeat('c',64))`, [id, IDS.sa, pend.from, pend.to]);
  await assert.rejects(admin(h, 'backupSaved', null, {token: 'a'.repeat(48), id, month: '2020-01'}), /month from 2024|receipt rejected/);
  assert.equal((await admin(h, 'backupSaved', null, {token: 'a'.repeat(48), id, month: pend.month})).saved, true);
  assert.deepEqual((await admin(h, 'pending', null, {token: 'a'.repeat(48)})).backups, ['support', 'activity', 'project', 'damage', 'claim']);
  const hist = await admin(h, 'backupHistory', IDS.sa);
  assert.equal(hist.length, 1); assert.equal(hist[0].kind, 'qms'); assert.equal(hist[0].month, pend.month);
  assert.equal((await admin(h, 'backupDeleteHistory', IDS.sa, {id})).deleted, 1);
  assert.equal((await admin(h, 'status', IDS.sa)).backupEnabled, true);
});
