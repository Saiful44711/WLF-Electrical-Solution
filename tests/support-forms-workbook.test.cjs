const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { makeDB } = require('./pg-harness.cjs');

const workbook = require('../data/technical-support-forms-20261107.json');
const upgrade = fs.readFileSync('supabase/UPDATE_V220.sql', 'utf8');
const update = fs.readFileSync('supabase/UPDATE_SUPPORT_FORMS_20261107.sql', 'utf8');
const expectedCounts = { aftersales: 9, commissioning: 9, production: 8, qc: 8, maintenance: 8, installation: 10 };

async function makeUpgradedDB(t) {
  const h = await makeDB();
  t.after(() => h.close());
  await h.db.exec(upgrade);
  return h;
}

function valuesFor(form, overrides = {}) {
  return {
    ...Object.fromEntries(form.fields.map(field => [field.id,
      field.autoFill === 'today' ? '2000-01-01' :
      field.autoFill === 'identity' ? 'Forged identity' :
      field.type === 'multi' ? field.options.slice(0, 1) :
      field.type === 'number' ? '12345' :
      field.options.length ? field.options[0] :
      field.required ? 'Workbook request' : ''])),
    ...overrides,
  };
}

function requestFor(category, form, overrides = {}) {
  return { category, formRevision: form.revision, mutationId: crypto.randomUUID(), values: valuesFor(form, overrides) };
}

test('Workbook update replaces all six field sets, including customised definitions, and keeps submitted snapshots', async t => {
  const h = await makeUpgradedDB(t);
  const legacyForm = (await h.rpc('sa', 'getSupportWorkspace')).forms.commissioning;
  const legacy = await h.rpc('sa', 'createSupportRequest', [requestFor('commissioning', legacyForm)]);
  const beforeRequest = (await h.db.query('select to_jsonb(r) as record from public.wlf_requests r where id = $1', [legacy.id])).rows[0].record;
  const beforeHistory = (await h.db.query('select * from public.wlf_history where request_id = $1 order by id', [legacy.id])).rows;
  await h.rpc('sa', 'saveSupportSchema', [{
    category: 'commissioning', revision: legacyForm.revision,
    schema: { fields: [...legacyForm.fields, { id: 'custom-live', label: 'Local custom field', type: 'text', required: false, options: [] }] },
  }]);
  const beforeForm = (await h.db.query("select to_jsonb(f) as record from public.wlf_forms f where category = 'commissioning'")).rows[0].record;

  await h.db.exec(update);
  const forms = (await h.rpc('sa', 'getSupportWorkspace')).forms;
  for (const [category, form] of Object.entries(workbook.forms)) {
    assert.equal(forms[category].fields.length, expectedCounts[category]);
    assert.deepEqual(forms[category].fields, form.fields, category);
  }
  assert.deepEqual((await h.db.query('select to_jsonb(r) as record from public.wlf_requests r where id = $1', [legacy.id])).rows[0].record, beforeRequest);
  assert.deepEqual((await h.db.query('select * from public.wlf_history where request_id = $1 order by id', [legacy.id])).rows, beforeHistory);
  assert.deepEqual((await h.db.query("select before_state from wlf_private.support_form_updates where category = 'commissioning'")).rows[0].before_state, beforeForm);
  const oldTicket = await h.rpc('sa', 'getSupportRequest', [legacy.id]);
  assert.equal(oldTicket.formSchema.fields.some(field => field.id === 'sub'), true);
  assert.equal(forms.commissioning.fields.some(field => field.id === 'sub'), false);
  assert.equal((await h.db.query('select count(*)::int as n from wlf_private.support_form_updates')).rows[0].n, 6);
});

test('All workbook forms submit through the public RPC with server autofill, required fields and exact choices', async t => {
  const h = await makeUpgradedDB(t);
  await h.db.exec(update);
  const forms = (await h.rpc('sa', 'getSupportWorkspace')).forms;
  const today = (await h.db.query("select to_char(now() at time zone 'Asia/Dhaka', 'YYYY-MM-DD') as today")).rows[0].today;
  for (const [category, form] of Object.entries(forms)) {
    const saved = await h.rpc('sa', 'createSupportRequest', [requestFor(category, form)]);
    assert.equal(saved.ticket.values.date, today);
    assert.equal(saved.ticket.values.identity, 'sa');
    assert.equal(saved.ticket.values.remarks, '');
    assert.deepEqual(Object.keys(saved.ticket.values).sort(), form.fields.map(field => field.id).sort());
    assert.match(saved.ticket.reference, /^TCS\d+-12345-\d{8}$/);
    await assert.rejects(h.rpc('sa', 'createSupportRequest', [requestFor(category, form, { project: '' })]), /Required: Project Name/);
    await assert.rejects(h.rpc('sa', 'createSupportRequest', [requestFor(category, form, { lift: 'not-a-number' })]), /Enter a number for Lift ID/);
    await assert.rejects(h.rpc('sa', 'createSupportRequest', [requestFor(category, form, { problem_category: 'Unlisted choice' })]), /Invalid choice: Problem Category/);
  }
  for (const category of ['production', 'qc', 'maintenance']) {
    assert.equal(forms[category].fields.some(field => field.id === 'pm' || field.id === 'sub'), false);
  }
  assert.equal(forms.installation.fields.some(field => field.id === 'controller'), false);
  assert.equal(forms.installation.fields.find(field => field.id === 'sub').label, 'Problem Sub-Category');
  assert.equal(forms.installation.fields.find(field => field.id === 'sub').type, 'select');
  assert.deepEqual(forms.installation.fields.find(field => field.id === 'sub').options, workbook.forms.installation.fields.find(field => field.id === 'sub').options);
  await assert.rejects(h.rpc('sa', 'createSupportRequest', [requestFor('installation', forms.installation, { sub: '' })]), /Required: Problem Sub-Category/);
});

test('Repeating the update is idempotent, rejects stale submissions, and detects later form edits', async t => {
  const h = await makeUpgradedDB(t);
  const oldForm = (await h.rpc('sa', 'getSupportWorkspace')).forms.commissioning;
  await h.db.exec(update);
  const before = (await h.db.query('select category, schema, revision from public.wlf_forms order by category')).rows;
  await h.db.exec(update);
  assert.deepEqual((await h.db.query('select category, schema, revision from public.wlf_forms order by category')).rows, before);
  await assert.rejects(h.rpc('sa', 'createSupportRequest', [requestFor('commissioning', oldForm)]), /CONFLICT: Form changed/);

  const current = (await h.rpc('sa', 'getSupportWorkspace')).forms.commissioning;
  const edited = current.fields.map(field => field.id === 'remarks' ? { ...field, label: 'Later local remarks' } : field);
  await h.rpc('sa', 'saveSupportSchema', [{ category: 'commissioning', revision: current.revision, schema: { fields: edited } }]);
  await assert.rejects(h.db.exec(update), /Workbook already applied/);
  await h.db.exec('rollback');
  assert.deepEqual((await h.rpc('sa', 'getSupportWorkspace')).forms.commissioning.fields, edited);
});

test('A failed six-team update rolls back every definition, and the audit table is private', async t => {
  const h = await makeUpgradedDB(t);
  await h.db.query("delete from public.wlf_forms where category = 'production'");
  const before = (await h.db.query('select category, schema, revision from public.wlf_forms order by category')).rows;
  await assert.rejects(h.db.exec(update), /Missing support team/);
  await h.db.exec('rollback');
  assert.deepEqual((await h.db.query('select category, schema, revision from public.wlf_forms order by category')).rows, before);
  assert.equal((await h.db.query("select to_regclass('wlf_private.support_form_updates') as audit")).rows[0].audit, null);
  await h.db.query("insert into public.wlf_forms(category, schema) values('production', $1)", [JSON.stringify(workbook.forms.production)]);
  await h.db.exec(update);
  const security = (await h.db.query("select c.relrowsecurity, has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE') as anon_access, has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE') as user_access from pg_class c where c.oid = 'wlf_private.support_form_updates'::regclass")).rows[0];
  assert.deepEqual(security, { relrowsecurity: true, anon_access: false, user_access: false });
  await assert.rejects(h.as('user', () => h.db.query('select * from wlf_private.support_form_updates')), /permission denied/i);
});

test('The targeted update requires the existing v2.2 database', async t => {
  const h = await makeDB();
  t.after(() => h.close());
  await assert.rejects(h.db.exec(update), /WLF v2.2 database required/);
  await h.db.exec('rollback');
});
