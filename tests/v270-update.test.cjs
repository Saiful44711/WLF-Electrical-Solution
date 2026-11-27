const test = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {makeDB, IDS} = require('./pg-harness.cjs');

const chain = ['UPDATE_V220','UPDATE_SUPPORT_FORMS_20261107','UPDATE_DAMAGE_DEMAND_20261107','UPDATE_WORKSPACE_20261107','UPDATE_SECTIONS_V230','UPDATE_V240','UPDATE_V250','UPDATE_V251','UPDATE_V252','UPDATE_V253','UPDATE_V254','UPDATE_V255','UPDATE_V256','UPDATE_V257','UPDATE_V258','UPDATE_V259','UPDATE_V260','UPDATE_V261','UPDATE_V262','UPDATE_V263','UPDATE_V264','UPDATE_V265','UPDATE_V266','UPDATE_V267','UPDATE_V268'];
const migration = readFileSync('supabase/UPDATE_V270.sql','utf8');

async function prepare(t) {
  const h = await makeDB();
  t.after(() => h.close());
  for (const file of chain) await h.db.exec(readFileSync('supabase/'+file+'.sql','utf8'));
  const results = await h.db.exec(migration);
  return {h, ready: results.at(-1).rows[0]};
}
const admin = async (h, action, actor, payload = {}) => (await h.db.query('select public.wlf_report_admin($1,$2,$3) r', [action, actor, payload])).rows[0].r;
/* Dhaka time: 2026-10-31 23:30 +06 is still October, 2026-11-01 00:10 +06 is November */
async function fixtures(h) {
  const req = (team, at, status, problem, lift) => h.db.query(`insert into public.wlf_requests(id,category,status,created_by,values,form_schema,reference,created_at)
    values(gen_random_uuid(),$1,$2,$3,$4,$5,'T-'||floor(random()*1e6),$6)`, [team, status, IDS.user,
    JSON.stringify({problem_category: problem, lift}), JSON.stringify({fields: [{id: 'problem_category', label: 'Problem Category', type: 'select'}, {id: 'lift', label: 'Lift ID'}]}), at]);
  await req('aftersales', '2026-10-31T17:30:00Z', 'Solved', 'Electrical', '11');      /* 23:30 Dhaka, Oct */
  await req('aftersales', '2026-10-31T18:10:00Z', 'Pending', 'Electrical', '11');     /* 00:10 Dhaka, Nov */
  await req('commissioning', '2026-11-15T06:00:00Z', 'Solved', 'Mechanical', '12');
  await h.db.query(`insert into wlf_private.damage_demands(request_id,category,request_reference,requester_id,requester_name,requested_at,project,lift_id,controllers,problem_categories,form_schema,form_values,confirmed_by,confirmed_name,solution_statement,item_name,item_code,item_spec,quantity,create_operation,create_payload_hash,created_at)
    values(gen_random_uuid(),'aftersales','R-1',$1,'u',now(),'P','1','{NICE3000+}','{Drive}','{}','{}',$1,'rni','fixed','Brake resistor','','',2,gen_random_uuid(),'\\x00','2026-11-03T05:00:00Z')`, [IDS.rni]);
}

test('v2.7.0 migration is repeatable and reports the new build', async t => {
  const {h, ready} = await prepare(t);
  assert.equal(ready.v270_ready, true);
  assert.equal((await h.db.exec(migration)).at(-1).rows[0].v270_ready, true);
  assert.equal((await h.rpc('sa', 'getSession')).build, '2.7.0');
});

test('report data uses Bangladesh month bounds; only Super Admin; app users cannot call it', async t => {
  const {h} = await prepare(t);
  await fixtures(h);
  const nov = await admin(h, 'data', IDS.sa, {kind: 'support', month: '2026-11'});
  assert.equal(nov.records.length, 2, '00:10 on 1 November (Dhaka) counts for November');
  assert.deepEqual(nov.records.map(r => r.team).sort(), ['aftersales', 'commissioning']);
  assert.equal(nov.teams.length, 6);
  assert.equal((await admin(h, 'data', IDS.sa, {kind: 'support', month: '2026-10'})).records.length, 1);
  const dmg = await admin(h, 'data', IDS.sa, {kind: 'damage', month: '2026-11'});
  assert.equal(dmg.records[0].item, 'Brake resistor');
  assert.deepEqual(dmg.records[0].problems, ['Drive']);
  assert.equal((await admin(h, 'data', IDS.sa, {kind: 'activity', month: '2026-11'})).records.length, 0);
  await assert.rejects(admin(h, 'data', IDS.rni, {kind: 'support', month: '2026-11'}), /Super Admin only/);
  await assert.rejects(admin(h, 'data', IDS.sa, {kind: 'support', month: '2026-13'}), /Choose a month/);
  await assert.rejects(h.as('sa', () => h.db.query("select public.wlf_report_admin('history',$1,'{}')", [IDS.sa])), /permission denied/);
});

test('receipts: one row per report and month, replaced on a second run; pending lists the missing ones', async t => {
  const {h} = await prepare(t);
  const last = (await admin(h, 'status', IDS.sa)).lastMonth;
  assert.match(last, /^\d{4}-\d{2}$/);
  const save = id => admin(h, 'saved', IDS.sa, {kind: 'support', month: last, fileId: id, fileName: 'a.xlsx', sha256: 'a'.repeat(64), records: 3});
  await save('file_one_1');
  await save('file_two_2');
  const hist = await admin(h, 'history', IDS.sa);
  assert.equal(hist.length, 1);
  assert.equal(hist[0].fileId, 'file_two_2');
  assert.equal(hist[0].source, 'manual');
  await assert.rejects(admin(h, 'saved', IDS.sa, {kind: 'support', month: last, fileId: 'bad id!', sha256: 'a'.repeat(64)}), /rejected/);
  /* the schedule may only run with its token, and only when switched on */
  await assert.rejects(admin(h, 'pending', null, {token: 'x'}), /not allowed/);
  await h.db.query("update wlf_private.report_settings set enabled=true, token='tok123'");
  const pending = await admin(h, 'pending', null, {token: 'tok123'});
  assert.deepEqual(pending, {month: last, kinds: ['activity', 'damage']});
  await assert.rejects(admin(h, 'history', null, {token: 'tok123'}), /Not allowed for the schedule/);
  await assert.rejects(admin(h, 'pending', null, {token: 'wrong'}), /not allowed/);
});

test('turning the schedule on needs pg_cron and pg_net; a wrong address is refused; off always works', async t => {
  const {h} = await prepare(t);
  const url = 'https://abcxyz.supabase.co/functions/v1/wlf-maintenance';
  const cron = (await h.db.query("select to_regnamespace('cron') is not null c")).rows[0].c;
  if (!cron) await assert.rejects(admin(h, 'schedule', IDS.sa, {enable: true, url}), /pg_cron and pg_net/);
  assert.deepEqual(await admin(h, 'schedule', IDS.sa, {enable: false}), {enabled: false});
  if (cron) await assert.rejects(admin(h, 'schedule', IDS.sa, {enable: true, url: 'https://evil.example/x'}), /address rejected/);
});
