const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {readFileSync} = require('node:fs');
const {makeDB, IDS} = require('./pg-harness.cjs');

const chain = ['UPDATE_V220','UPDATE_SUPPORT_FORMS_20261107','UPDATE_DAMAGE_DEMAND_20261107','UPDATE_WORKSPACE_20261107','UPDATE_SECTIONS_V230','UPDATE_V240','UPDATE_V250','UPDATE_V251','UPDATE_V252','UPDATE_V253','UPDATE_V254','UPDATE_V255','UPDATE_V256'];
const migration = readFileSync('supabase/UPDATE_V257.sql','utf8');

async function prepare(t) {
  const h = await makeDB();
  t.after(() => h.close());
  for (const file of chain) await h.db.exec(readFileSync('supabase/'+file+'.sql','utf8'));
  await h.db.query('alter table public.wlf_profiles disable trigger wlf_deletion_guard');
  for (const [who, emp, section] of [['sa','SA-1','R&I Electrical'],['rni','RN-3','R&I Electrical'],['rni2','RN-4','R&I Mechanical'],['user','US-5','Commissioning'],['admin','AD-2','Production']])
    await h.db.query('update public.wlf_profiles set employee_id=$2, section=$3 where id=$1', [IDS[who], emp, section]);
  await h.db.query('alter table public.wlf_profiles enable trigger wlf_deletion_guard');
  const results = await h.db.exec(migration);
  return {h, ready: results.at(-1).rows[0]};
}
const grant = (h, who, ...keys) => h.db.query('update public.wlf_profiles set permissions=array_cat(permissions,$2) where id=$1', [IDS[who], keys]);
const sub = (h, who, n) => h.db.query("insert into wlf_private.push_subscriptions(endpoint,profile,p256dh,auth) values($1,$2,repeat('a',40),repeat('b',16))", ['https://push.example/' + n, IDS[who]]);
const outbox = async (h, who = 'user') => (await h.db.query('select profile,title,body from wlf_private.push_outbox where profile=$1 order by id', [IDS[who]])).rows;
const fillFields = (fields, extra = {}) => ({...Object.fromEntries(fields.filter(f => !f.autoFill && !f.dependsOn && f.type !== 'checkbox').map(f => [f.id,
  f.type === 'multi' ? f.options.slice(0, 1) : f.type === 'date' ? '2026-11-17' : f.type === 'number' ? '12' : f.options?.[0] || 'Fixture'])), ...extra});
const createSupport = async (h, category = 'commissioning', who = 'user') => {
  const form = (await h.rpc(who, 'getSupportWorkspace', [{category}])).forms[category];
  return (await h.rpc(who, 'createSupportRequest', [{category, formRevision: form.revision, values: fillFields(form.fields, {problem_category: 'Encoder problem'}), mutationId: crypto.randomUUID()}])).ticket;
};
const move = async (h, who, ticket, action, extra = {}) => (await h.rpc(who, 'transitionSupportRequest', [{id: ticket.id, revision: ticket.revision, action, mutationId: crypto.randomUUID(), ...extra}])).ticket;

test('v2.5.7 migration is repeatable and reports build 2.5.7', async t => {
  const {h, ready} = await prepare(t);
  assert.deepEqual(ready, {support_result_push_ready: true, demand_received_push_ready: true, usage_autopurge_ready: true, v257_ready: true});
  assert.deepEqual((await h.db.exec(migration)).at(-1).rows[0], ready, 'second run is the same');
  assert.equal((await h.rpc('sa', 'getSession')).build, '2.5.7');
});

test('The requester gets a push when the request is Solved, Not Solved or Forwarded; nobody else, never for Receive', async t => {
  const {h} = await prepare(t);
  await grant(h, 'rni', 'support:commissioning:request');
  await grant(h, 'rni2', 'support:commissioning:request');
  await sub(h, 'user', 1); await sub(h, 'rni', 2); await sub(h, 'rni2', 3); await sub(h, 'sa', 4);
  let a = await createSupport(h, 'commissioning', 'user');
  await h.db.query('delete from wlf_private.push_outbox');
  a = await move(h, 'rni', a, 'receive');
  assert.equal((await outbox(h)).length, 0, 'Receive sends nothing');
  a = await move(h, 'rni', a, 'forward', {to: 'rni2@example.test', comment: 'Please check'});
  let out = await outbox(h);
  assert.equal(out.length, 1, 'only the requester is counted here (the R&I user who receives the forwarded request has their own, older notification)');
  assert.equal(out[0].title, 'Your support request was forwarded');
  assert.ok(out[0].body.includes(a.reference) && out[0].body.includes('forwarded to'), out[0].body);
  a = await move(h, 'rni2', a, 'receive');
  a = await move(h, 'rni2', a, 'solve', {comment: 'Fixed'});
  out = await outbox(h);
  assert.deepEqual(out.map(r => r.title), ['Your support request was forwarded', 'Your support request was solved']);
  assert.ok(out[1].body.includes(' · by '), out[1].body);
  assert.ok(out.every(r => r.profile === IDS.user));
  for (const other of ['rni', 'sa']) assert.ok(!(await outbox(h, other)).some(r => /Your support request/.test(r.title)), other + ' gets no requester message');

  let b = await createSupport(h, 'commissioning', 'user');
  await h.db.query('delete from wlf_private.push_outbox');
  b = await move(h, 'rni', b, 'receive');
  b = await move(h, 'rni', b, 'notSolved', {comment: 'Needs a site visit'});
  out = await outbox(h);
  assert.deepEqual(out.map(r => r.title), ['Your support request was marked not solved']);

  // a requester who never enabled notifications has no queued message
  await h.db.query('delete from wlf_private.push_subscriptions where profile=$1', [IDS.user]);
  await h.db.query('delete from wlf_private.push_outbox');
  let c = await createSupport(h, 'commissioning', 'user');
  c = await move(h, 'rni', c, 'receive');
  await move(h, 'rni', c, 'solve', {comment: 'ok'});
  assert.equal((await outbox(h)).length, 0);
});

test('Own unsolved count (red mark) counts every own request until it is Solved', async t => {
  const {h} = await prepare(t);
  await grant(h, 'rni', 'support:commissioning:request');
  assert.equal((await h.rpc('user', 'getSupportSummary')).mine, 0);
  let a = await createSupport(h, 'commissioning', 'user');
  const b = await createSupport(h, 'commissioning', 'user');
  let s = await h.rpc('user', 'getSupportSummary');
  assert.equal(s.mine, 2);
  assert.deepEqual(s.mineByTeam, {commissioning: 2});
  assert.equal((await h.rpc('rni', 'getSupportSummary')).mine, 0, 'handlers are counted only for requests they submitted');
  a = await move(h, 'rni', a, 'receive');
  assert.equal((await h.rpc('user', 'getSupportSummary')).mine, 2, 'Received is not solved');
  a = await move(h, 'rni', a, 'notSolved', {comment: 'later'});
  assert.equal((await h.rpc('user', 'getSupportSummary')).mine, 2, 'Not Solved stays red');
  a = await move(h, 'rni', a, 'receive');
  await move(h, 'rni', a, 'solve', {comment: 'done'});
  s = await h.rpc('user', 'getSupportSummary');
  assert.equal(s.mine, 1);
  const b2 = await move(h, 'rni', b, 'receive');
  await move(h, 'rni', b2, 'solve', {comment: 'done'});
  assert.equal((await h.rpc('user', 'getSupportSummary')).mine, 0);
});

test('A received Damage Demand notifies the person who submitted the request', async t => {
  const {h} = await prepare(t);
  await sub(h, 'user', 1); await sub(h, 'sa', 2);
  const id = crypto.randomUUID();
  await h.db.query(`insert into wlf_private.damage_demands(request_id,category,request_reference,requester_id,requester_name,requested_at,project,lift_id,controllers,problem_categories,form_schema,form_values,confirmed_by,confirmed_name,solution_statement,item_name,item_code,item_spec,quantity,create_operation,create_payload_hash)
    values($1,'commissioning','R-77',$2,'u',now(),'P','1','{}','{}','{}','{}',$3,'rni','fixed','Contactor','','',3,gen_random_uuid(),'\\x00')`, [id, IDS.user, IDS.rni]);
  await h.db.query('delete from wlf_private.push_outbox');
  await h.db.query("update wlf_private.damage_demands set received_at=now(),received_by=$2,received_name='sa' where request_id=$1", [id, IDS.sa]);
  const out = await outbox(h);
  assert.equal(out.length, 1);
  assert.equal((await outbox(h, 'sa')).length, 0, 'the person who pressed Receive is not notified');
  assert.equal(out[0].title, 'Your Damage Demand was received');
  assert.match(out[0].body, /R-77 · Contactor × 3/);
  await h.db.query("update wlf_private.damage_demands set solution_statement='changed' where request_id=$1", [id]);
  assert.equal((await outbox(h)).length, 1, 'later edits do not notify again');
});

test('Activity log rows older than 7 days are deleted automatically, at most once an hour', async t => {
  const {h} = await prepare(t);
  const add = (who, days) => h.db.query("insert into public.wlf_usage(actor,action,details,at) values($1,'Login','',now()-make_interval(days=>$2))", [IDS[who], days]);
  await h.db.query("update wlf_private.usage_housekeeping set last_run=now()+interval '1 day'");
  await add('user', 9); await add('rni', 40); await add('user', 1);
  assert.equal((await h.db.query('select count(*)::int n from public.wlf_usage')).rows[0].n, 3, 'nothing is removed while the hourly check is not due');
  await h.db.query("update wlf_private.usage_housekeeping set last_run=now()-interval '2 hours'");
  await add('sa', 0);
  assert.deepEqual((await h.db.query("select count(*)::int n, count(*) filter (where at<now()-interval '7 days')::int old from public.wlf_usage")).rows[0], {n: 2, old: 0});
  const log = (await h.db.query("select what,counts from wlf_private.purge_log where what like '%automatic%'")).rows;
  assert.equal(log.length, 1);
  assert.equal(log[0].counts['usage-log'], 2);
  await add('user', 20);
  await add('sa', 0);
  assert.equal((await h.db.query("select count(*)::int n from public.wlf_usage where at<now()-interval '7 days'")).rows[0].n, 1, 'a second check within the hour does nothing');
});
