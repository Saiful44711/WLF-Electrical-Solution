const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {makeDB, IDS} = require('./pg-harness.cjs');

const update = fs.readFileSync('supabase/UPDATE_DAMAGE_DEMAND_20261107.sql', 'utf8');
const previous = ['UPDATE_V220.sql', 'UPDATE_SUPPORT_FORMS_20261107.sql'];
const ready = {damage_demand_ready: true, access_options_ready: true, demand_table_private: true, support_forms_ready: true};
const teams = ['commissioning', 'aftersales', 'installation', 'maintenance', 'production', 'qc'];

async function setup(t) {
  const h = await makeDB();
  t.after(() => h.close());
  for (const file of previous) await h.db.exec(fs.readFileSync('supabase/' + file, 'utf8'));
  return h;
}

async function install(h) {
  const results = await h.db.exec(update);
  assert.deepEqual(results.at(-1).rows, [ready]);
}

async function request(h, category, who = 'sa', overrides = {}) {
  const form = (await h.rpc(who, 'getSupportWorkspace', [{category}])).forms[category];
  const values = Object.fromEntries(form.fields.map(field => [field.id,
    field.type === 'multi' ? field.options.slice(0, 2) :
      field.type === 'date' ? '2026-11-06' :
      field.type === 'number' ? '3210' : field.options[0] || 'Support fixture'
  ]));
  return (await h.rpc(who, 'createSupportRequest', [{category, formRevision: form.revision,
    values: {...values, ...overrides}, mutationId: crypto.randomUUID()}])).ticket;
}

async function transition(h, ticket, action, fields = {}, who = 'rni') {
  return (await h.rpc(who, 'transitionSupportRequest', [{id: ticket.id, revision: ticket.revision,
    action, mutationId: crypto.randomUUID(), ...fields}])).ticket;
}

function demandPayload(ticket, fields = {}) {
  return {id: ticket.id, revision: ticket.revision, operation: crypto.randomUUID(),
    itemName: 'Contactor', quantity: '2', durationMinutes: '12.50', solutionStatement: 'Replace the damaged part.',
    ...fields};
}

async function grant(h, who, permissions) {
  const access = (await h.rpc('sa', 'listAppUsers')).users.find(row => row.email === who + '@example.test');
  return h.rpc('sa', 'saveAppUserAccess', [{...access, permissions: [...new Set([...access.permissions, ...permissions])]}]);
}

test('Damage update is repeatable and preserves existing forms, requests, and access checks', async t => {
  const h = await setup(t);
  const forms = (await h.rpc('sa', 'getSupportWorkspace')).forms;
  const old = await request(h, 'commissioning', 'user', {project: 'Existing request'});
  await install(h);
  await install(h);
  assert.deepEqual((await h.rpc('sa', 'getSupportWorkspace')).forms, forms);
  const after = await h.rpc('user', 'getSupportRequest', [old.id]);
  assert.deepEqual(after.values, old.values);
  assert.deepEqual(after.formSchema, old.formSchema);
  assert.equal(after.revision, old.revision);
  assert.equal(after.durationMinutes, null);
  assert.equal(after.hardwareIssue, null);
  assert.equal(after.damageDemand, null);
  assert.equal((await h.rpc('user', 'getSession')).damageDemand, true);
  const catalog = (await h.rpc('sa', 'listAppUsers')).catalog;
  assert.deepEqual(catalog.filter(p => p.group === 'Damage Demand').map(p => p.key),
    ['damage:demand', 'damage:dashboard', 'damage:receive']);
  for (const who of ['user', 'rni', 'admin']) {
    await assert.rejects(h.rpc(who, 'getDamageDemands'), /Damage Demand access required/);
    await assert.rejects(h.rpc(who, 'getDamageDashboard'), /Dashboard access required/);
    await assert.rejects(h.rpc(who, 'getDamageReport'), /Dashboard access required/);
    await assert.rejects(h.rpc(who, 'saveAppUserAccess', [{email: who + '@example.test',
      permissions: ['damage:demand', 'damage:dashboard', 'damage:receive']}]), /Super Admin only/);
  }
  await assert.rejects(h.rpc('pending', 'getDamageDashboard'), /SESSION_EXPIRED/);
  await assert.rejects(h.rpc(null, 'getDamageDemands'), /permission denied/);
  await assert.rejects(h.as('user', () => h.db.query('select * from wlf_private.damage_demands')), /permission denied/);
  await assert.rejects(h.as('user', () => h.db.query("select wlf_private.damage_demands_api('getDamageDemands','{}')")), /permission denied/);
  await assert.rejects(h.as('user', () => h.db.query("select wlf_private.rpc_v220('getSession','[]')")), /permission denied/);
});

test('Assigned R&I creates a single validated snapshot and only granted Dispatch receives it', async t => {
  const h = await setup(t);
  await install(h);
  await h.db.query('update public.wlf_profiles set name=$2 where id=$1', [IDS.rni, 'Engineer - EMP310']);
  const original = await request(h, 'commissioning', 'user', {project: 'Bayside Tower', lift: '93821', problem: 'Main drive fault'});
  const draft = demandPayload(original);
  await assert.rejects(h.rpc('rni', 'createDamageDemand', [draft]), /Receive the request first/);
  const received = await transition(h, original, 'receive');
  const payload = demandPayload(received, {itemCode: 'CTR-12', itemSpec: '24 V DC',
    confirmedBy: 'forged identity', supportValues: {project: 'forged project'}});
  await assert.rejects(h.rpc('user', 'createDamageDemand', [payload]), /Only the assigned R&I/);
  await assert.rejects(h.rpc('rni2', 'createDamageDemand', [payload]), /Only the assigned R&I/);
  await assert.rejects(h.rpc('rni', 'createDamageDemand', [{...payload, revision: original.revision}]), /CONFLICT/);
  for (const [change, error] of [
    [{itemName: ' '}, /item name/],
    [{quantity: '1.5'}, /whole number/],
    [{quantity: '0'}, /whole number/],
    [{solutionStatement: ''}, /solution statement/],
    [{durationMinutes: '-5'}, /Duration must/]
  ]) {
    await assert.rejects(h.rpc('rni', 'createDamageDemand', [{...payload, ...change}]), error);
  }
  const invalidTransition = {review: {durationMinutes: '30', hardwareIssue: true}, comment: 'Test'};
  await assert.rejects(transition(h, received, 'solve', invalidTransition), /Submit the Damage Demand/);
  assert.equal((await h.rpc('rni', 'getSupportRequest', [received.id])).revision, received.revision);

  const {ticket} = await h.rpc('rni', 'createDamageDemand', [payload]);
  assert.equal(ticket.status, 'Received');
  assert.equal(ticket.hardwareIssue, true);
  assert.equal(ticket.durationMinutes, 12.5);
  assert.match(ticket.damageDemand.reference, /^DD-[0-9]+$/);
  assert.equal(ticket.damageDemand.status, 'Pending');
  assert.equal(ticket.damageDemand.solutionStatement, payload.solutionStatement);
  assert.equal((await h.rpc('rni', 'createDamageDemand', [payload])).ticket.revision, ticket.revision);
  await assert.rejects(h.rpc('rni', 'createDamageDemand', [{...payload, quantity: '3'}]), /Operation ID reused/);
  await assert.rejects(h.rpc('rni', 'createDamageDemand', [demandPayload(ticket)]), /already exists/);
  await assert.rejects(transition(h, ticket, 'solve', {comment: 'Changed', review: {
    durationMinutes: '15', hardwareIssue: false
  }}), /Hardware Issue is Yes/);
  const solved = await transition(h, ticket, 'solve', {comment: payload.solutionStatement,
    review: {durationMinutes: '15', hardwareIssue: true}});
  assert.equal(solved.status, 'Solved');
  assert.equal(solved.durationMinutes, 15);

  const detail = await h.rpc('sa', 'getDamageDemand', [{id: original.id}]);
  assert.equal(detail.confirmedBy, 'Engineer - EMP310');
  assert.equal(detail.requesterName, 'user');
  assert.equal(detail.durationMinutes, 12.5, 'Demand stores the duration at submission');
  assert.equal(detail.project, 'Bayside Tower');
  assert.deepEqual(detail.supportValues, original.values);
  assert.deepEqual(detail.supportForm, original.formSchema);
  assert.equal(detail.solutionStatement, payload.solutionStatement);
  assert.equal(detail.quantity, 2);
  assert.equal((await h.rpc('user', 'getSupportRequest', [original.id])).damageDemand.status, 'Pending');
  await assert.rejects(h.rpc('other', 'getSupportRequest', [original.id]), /Request not found/);
  await assert.rejects(h.rpc('user', 'getDamageDemand', [{id: original.id}]), /Damage Demand access required/);
  await assert.rejects(h.rpc('sa', 'receiveDamageDemand', [{id: original.id}]), /Receive permissions are required/);

  await grant(h, 'admin', ['damage:dashboard', 'damage:receive']);
  assert.equal((await h.rpc('admin', 'getDamageDashboard')).total, 1);
  await assert.rejects(h.rpc('admin', 'getDamageDemands'), /Damage Demand access required/);
  await assert.rejects(h.rpc('admin', 'receiveDamageDemand', [{id: original.id}]), /Receive permissions are required/);
  await grant(h, 'rni', ['damage:demand']);
  assert.equal((await h.rpc('rni', 'getDamageDemands', [{status: 'Pending'}])).total, 1);
  await assert.rejects(h.rpc('rni', 'receiveDamageDemand', [{id: original.id}]), /Receive permissions are required/);
  await grant(h, 'other', ['damage:demand', 'damage:receive']);
  await assert.rejects(h.rpc('other', 'getDamageDashboard'), /Dashboard access required/);

  const result = await h.rpc('other', 'receiveDamageDemand', [{id: original.id}]);
  assert.equal(result.status, 'Received');
  assert.equal(result.receivedBy, 'other');
  assert.equal((await h.rpc('other', 'receiveDamageDemand', [{id: original.id}])).receivedAt, result.receivedAt);
  await grant(h, 'admin', ['damage:demand']);
  await assert.rejects(h.rpc('admin', 'receiveDamageDemand', [{id: original.id}]), /Already received/);
  assert.equal((await h.rpc('other', 'getDamageDemands', [{status: 'Pending'}])).total, 0);
  assert.equal((await h.rpc('other', 'getDamageDemands', [{status: 'Received'}])).total, 1);
  const requester = await h.rpc('user', 'getSupportRequest', [original.id]);
  assert.equal(requester.damageDemand.status, 'Received');
  assert.equal(requester.damageDemand.solutionStatement, null);
  assert.equal(requester.status, 'Solved');

  await h.db.query("update public.wlf_profiles set status='Rejected' where id=$1", [IDS.other]);
  await assert.rejects(h.rpc('other', 'receiveDamageDemand', [{id: original.id}]), /SESSION_EXPIRED/);
});

test('Only four teams raise demands and filters, percentages, and Excel rows use the saved snapshots', async t => {
  const h = await setup(t);
  await install(h);
  const requests = {};
  for (const [index, team] of teams.entries()) {
    const initial = await request(h, team, 'sa', {project: 'Site ' + team, lift: String(4100 + index)});
    const ticket = await transition(h, initial, 'receive');
    requests[team] = ticket;
    if (team === 'production' || team === 'qc') {
      await assert.rejects(h.rpc('rni', 'createDamageDemand', [demandPayload(ticket)]), /available for Commissioning/);
      const saved = await transition(h, ticket, 'solve', {comment: 'Support complete',
        review: {durationMinutes: '0', hardwareIssue: true}});
      assert.equal(saved.durationMinutes, 0);
      assert.equal(saved.hardwareIssue, true);
      assert.equal(saved.damageDemand, null);
      continue;
    }
    const item = ['Contactor', 'contactor', 'Relay', 'Fuse'][index];
    await h.rpc('rni', 'createDamageDemand', [demandPayload(ticket, {itemName: item, quantity: String(index + 1)})]);
    const stamp = ['2026-11-06 17:59:59+00', '2026-11-06 18:00:00+00', '2026-11-07 17:59:59+00', '2026-11-07 18:00:00+00'][index];
    await h.db.query('update wlf_private.damage_demands set created_at=$2 where request_id=$1', [ticket.id, stamp]);
  }
  const sameDate = {from: '2026-11-07', to: '2026-11-07'};
  const report = await h.rpc('sa', 'getDamageReport', [sameDate]);
  assert.equal(report.total, 2);
  assert.equal(report.units, 5);
  assert.deepEqual(report.components.map(r => [r.label, r.percentage]), [['Relay', 60], ['contactor', 40]]);
  assert.deepEqual(new Set(report.rows.map(row => row.category)), new Set(['aftersales', 'installation']));
  const dashboard = await h.rpc('sa', 'getDamageDashboard');
  assert.equal(dashboard.total, 4);
  assert.equal(dashboard.units, 10);
  assert.equal(dashboard.pending, 4);
  assert.equal(dashboard.components.find(r => r.label.toLowerCase() === 'contactor').percentage, 30);
  assert.ok(dashboard.facets.controller.some(o => o.value === 'missing'));
  assert.ok(dashboard.facets.problemCategory.some(o => o.value === 'v:mechanical'));
  const lookup = (action, f) => h.rpc('sa', action, [f]).then(x => x.rows.map(r => r.category));
  assert.deepEqual(await lookup('getDamageDemands', {lift: '4102', project: 'SITE INSTALL'}), ['installation']);
  assert.deepEqual(await lookup('getDamageDashboard', {controller: 'missing', problemCategory: 'v:mechanical'}), ['installation']);
  assert.deepEqual(await lookup('getDamageDashboard', {category: 'commissioning', controller: 'v:nice3000+', component: 'v:contactor'}),
    ['commissioning']);
  assert.deepEqual(await lookup('getDamageDashboard', {category: 'production'}), []);
  await assert.rejects(h.rpc('sa', 'getDamageDemands', [{from: '2026-11-08', to: '2026-11-07'}]), /From date/);

  const before = await h.rpc('sa', 'getDamageDemand', [{id: requests.commissioning.id}]);
  const editable = await h.rpc('sa', 'getSupportRequest', [requests.commissioning.id]);
  await h.rpc('sa', 'editSupportRequest', [{id: editable.id, revision: editable.revision, mutationId: crypto.randomUUID(),
    values: {...editable.values, project: 'Renamed later'}}]);
  assert.deepEqual(await h.rpc('sa', 'getDamageDemand', [{id: editable.id}]), before);
  const updated = await h.rpc('rni', 'getSupportRequest', [editable.id]);
  const solved = await transition(h, updated, 'solve', {comment: 'Replacement resolved'});
  const run = crypto.randomUUID();
  const nonce = crypto.randomUUID();
  const backup = (action, p) => h.db.query('select public.wlf_backup_admin($1,$2,$3) result', [action, IDS.sa,
    {id: run, project: 'damage-test', ...p}]).then(r => r.rows[0].result);
  await backup('start', {});
  const archive = await backup('prepare', {batch: 0, nonce});
  const archived = archive.records.find(row => row.request.id === solved.id);
  assert.equal(archived.request.duration_minutes, 12.5);
  await backup('verify', {batch: 0, nonce, fileId: 'test-drive-file', sha256: 'a'.repeat(64)});
  assert.equal((await backup('clear', {batch: 0})).cleared, 3);
  assert.deepEqual(await h.rpc('sa', 'getDamageDemand', [{id: solved.id}]), before);
  await assert.rejects(h.rpc('sa', 'getSupportRequest', [solved.id]), /Request not found/);
  assert.equal((await backup('restore', {archive})).restored, 3);
  assert.equal((await h.rpc('sa', 'getSupportRequest', [solved.id])).damageDemand.reference, before.reference);
});
