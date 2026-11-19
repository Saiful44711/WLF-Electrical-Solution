const test = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {makeDB, IDS} = require('./pg-harness.cjs');

const chain = ['UPDATE_V220','UPDATE_SUPPORT_FORMS_20261107','UPDATE_DAMAGE_DEMAND_20261107','UPDATE_WORKSPACE_20261107','UPDATE_SECTIONS_V230','UPDATE_V240','UPDATE_V250','UPDATE_V251','UPDATE_V252','UPDATE_V253'];
const migration = readFileSync('supabase/UPDATE_V254.sql','utf8');

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
const fillFields = (fields, extra = {}) => ({...Object.fromEntries(fields.filter(f => !f.autoFill && !f.dependsOn && f.type !== 'checkbox').map(f => [f.id,
  f.type === 'multi' ? f.options.slice(0, 1) : f.type === 'date' ? '2026-11-17' : f.type === 'number' ? '12' : f.options?.[0] || 'Fixture'])), ...extra});
const createSupport = async (h, category = 'commissioning', who = 'user') => {
  const form = (await h.rpc(who, 'getSupportWorkspace', [{category}])).forms[category];
  return (await h.rpc(who, 'createSupportRequest', [{category, formRevision: form.revision, values: fillFields(form.fields, {problem_category: 'Encoder problem'}), mutationId: crypto.randomUUID()}])).ticket;
};
const damage = (h, category, item, qty, received = false) => h.db.query(`insert into wlf_private.damage_demands(request_id,category,request_reference,requester_id,requester_name,requested_at,project,lift_id,controllers,problem_categories,form_schema,form_values,confirmed_by,confirmed_name,solution_statement,item_name,item_code,item_spec,quantity,create_operation,create_payload_hash,received_at,received_by,received_name)
  values(gen_random_uuid(),$1,'R-1',$3,'u',now(),'P','1','{}','{}','{}','{}',$3,'rni','fixed',$2,'','',$4,gen_random_uuid(),'\\x00',${received ? "now(),'" + IDS.sa + "','sa'" : 'null,null,null'}) returning request_id`, [category, item, IDS.rni, qty]).then(r => r.rows[0].request_id);
const sub = (h, who, n) => h.db.query("insert into wlf_private.push_subscriptions(endpoint,profile,p256dh,auth) values($1,$2,repeat('a',40),repeat('b',16))", ['https://push.example/' + n, IDS[who]]);

test('v2.5.4 migration is repeatable and adds the four Supplier Claim permissions', async t => {
  const {h, ready} = await prepare(t);
  assert.deepEqual(ready, {supplier_permissions_ready: true, supplier_columns_ready: true, support_push_ready: true, v254_ready: true});
  assert.equal((await h.db.exec(migration)).at(-1).rows[0].v254_ready, true);
  assert.equal((await h.rpc('sa', 'getSession')).build, '2.5.4');
  const cat = (await h.rpc('sa', 'listAppUsers')).catalog.filter(x => x.group === 'Supplier Claim').map(x => x.key);
  assert.deepEqual(cat.sort(), ['supplier:claim', 'supplier:confirm', 'supplier:receive', 'supplier:view']);
  // old demand features still there
  assert.ok(Array.isArray((await h.rpc('sa', 'getDamageDemands', [{}])).rows));
});

test('A new support request notifies R&I Electrical users only, never the sender', async t => {
  const {h} = await prepare(t);
  await sub(h, 'rni', 1); await sub(h, 'rni2', 2); await sub(h, 'user', 3); await sub(h, 'sa', 4);
  await h.db.query('delete from wlf_private.push_outbox');
  const ticket = await createSupport(h, 'commissioning', 'user');
  const out = (await h.db.query('select profile,title,body from wlf_private.push_outbox order by profile')).rows;
  assert.deepEqual(out.map(r => r.profile).sort(), [IDS.rni, IDS.sa].sort(), 'R&I Electrical (rni, sa) only');
  assert.equal(out[0].title, 'New technical support request');
  assert.ok(out[0].body.includes(ticket.reference), out[0].body);
  // a request written by an R&I Electrical person (here the Super Admin) does not notify the writer
  await h.db.query('delete from wlf_private.push_outbox');
  await createSupport(h, 'commissioning', 'sa');
  const out2 = (await h.db.query('select profile from wlf_private.push_outbox')).rows.map(r => r.profile);
  assert.ok(!out2.includes(IDS.sa), 'sender not notified');
  assert.ok(out2.includes(IDS.rni));
});

test('A pending / inactive R&I Electrical user gets nothing', async t => {
  const {h} = await prepare(t);
  await sub(h, 'rni', 1);
  await h.db.query("update public.wlf_profiles set status='Rejected' where id=$1", [IDS.rni]);
  await h.db.query('delete from wlf_private.push_outbox');
  await createSupport(h, 'commissioning', 'user');
  assert.equal((await h.db.query('select count(*)::int n from wlf_private.push_outbox where profile=$1', [IDS.rni])).rows[0].n, 0);
});

test('Supplier Claim: two Yes/No steps, separate from demand Pending/Received', async t => {
  const {h} = await prepare(t);
  const id = await damage(h, 'commissioning', 'Encoder card', 2);
  await grant(h, 'user', 'damage:demand');
  const d0 = (await h.rpc('sa', 'getDamageDemand', [{id}]));
  assert.equal(d0.supplierClaim, false);
  assert.equal(d0.supplierConfirmed, false);
  assert.equal(d0.status, 'Pending');
  // nobody has the permission yet
  for (const a of ['markSupplierClaim', 'confirmSupplierClaim', 'receiveSupplierClaim'])
    await assert.rejects(h.rpc('rni', a, [{id, supplier: 'Arkel'}]), /do not have/, a);
  await assert.rejects(h.rpc('rni', 'getSupplierClaims', [{}]), /do not have access/);
  await grant(h, 'rni', 'supplier:claim', 'supplier:confirm', 'supplier:receive', 'supplier:view');
  // step 2 before step 1 is refused
  await assert.rejects(h.rpc('rni', 'confirmSupplierClaim', [{id}]), /Supplier Claim = Yes first/);
  await assert.rejects(h.rpc('rni', 'markSupplierClaim', [{id, supplier: ''}]), /supplier name/);
  const c1 = await h.rpc('rni', 'markSupplierClaim', [{id, supplier: 'Arkel', note: 'Warranty claim sent'}]);
  assert.equal(c1.supplierClaim, true);
  assert.equal(c1.supplierConfirmed, false);
  assert.equal(c1.supplier.name, 'Arkel');
  assert.equal(c1.status, 'Pending', 'demand status untouched');
  await assert.rejects(h.rpc('rni', 'markSupplierClaim', [{id, supplier: 'Arkel'}]), /already Yes/);
  assert.equal((await h.rpc('rni', 'getSupplierClaims', [{}])).items.length, 0, 'not in the menu until confirmed');
  const c2 = await h.rpc('rni', 'confirmSupplierClaim', [{id}]);
  assert.equal(c2.supplierConfirmed, true);
  assert.equal(c2.supplier.status, 'Pending');
  assert.equal(c2.status, 'Pending', 'demand status still untouched');
  await assert.rejects(h.rpc('rni', 'confirmSupplierClaim', [{id}]), /already Yes/);
  const list = await h.rpc('rni', 'getSupplierClaims', [{}]);
  assert.equal(list.pending, 1);
  assert.equal(list.received, 0);
  assert.equal(list.items[0].itemName, 'Encoder card');
  const c3 = await h.rpc('rni', 'receiveSupplierClaim', [{id}]);
  assert.equal(c3.supplier.status, 'Received');
  assert.equal(c3.status, 'Pending', 'dispatch Received is a different thing and is still Pending');
  await assert.rejects(h.rpc('rni', 'receiveSupplierClaim', [{id}]), /Already received/);
  assert.equal((await h.rpc('rni', 'getSupplierClaims', [{status: 'Pending'}])).items.length, 0);
  assert.equal((await h.rpc('rni', 'getSupplierClaims', [{status: 'Received'}])).items.length, 1);
  // and the other way: dispatch Received does not touch the supplier fields
  const id2 = await damage(h, 'installation', 'Brake coil', 1, true);
  const d2 = await h.rpc('sa', 'getDamageDemand', [{id: id2}]);
  assert.equal(d2.status, 'Received');
  assert.equal(d2.supplierClaim, false);
});

test('Supplier Claim: view-only users cannot act; receiving needs its own permission; menu badge counts Pending', async t => {
  const {h} = await prepare(t);
  const id = await damage(h, 'aftersales', 'Door motor', 1);
  await grant(h, 'rni', 'supplier:claim', 'supplier:confirm');
  await h.rpc('rni', 'markSupplierClaim', [{id, supplier: 'Supplier A'}]);
  await h.rpc('rni', 'confirmSupplierClaim', [{id}]);
  await grant(h, 'user', 'supplier:view');
  assert.equal((await h.rpc('user', 'getSupplierClaims', [{}])).items.length, 1);
  assert.equal((await h.rpc('user', 'getSupplierClaims', [{}])).canReceive, false);
  await assert.rejects(h.rpc('user', 'receiveSupplierClaim', [{id}]), /do not have/);
  await assert.rejects(h.rpc('user', 'markSupplierClaim', [{id, supplier: 'x'}]), /do not have/);
  assert.equal((await h.rpc('user', 'getNavBadges')).supplierPending, 1);
  assert.equal((await h.rpc('sa', 'getNavBadges')).supplierPending, 1);
  assert.equal((await h.rpc('admin', 'getNavBadges')).supplierPending, null, 'no permission: no number');
  await assert.rejects(h.rpc('admin', 'getSupplierClaims', [{}]), /do not have access/);
});

test('Super Admin can cancel a wrong Yes, but not after the goods are Received', async t => {
  const {h} = await prepare(t);
  const id = await damage(h, 'maintenance', 'Fan', 3);
  await grant(h, 'rni', 'supplier:claim', 'supplier:confirm', 'supplier:receive');
  await h.rpc('rni', 'markSupplierClaim', [{id, supplier: 'S1'}]);
  await h.rpc('rni', 'confirmSupplierClaim', [{id}]);
  await assert.rejects(h.rpc('rni', 'cancelSupplierClaim', [{id, step: 'confirm'}]), /Only the Super Admin/);
  const back = await h.rpc('sa', 'cancelSupplierClaim', [{id, step: 'confirm'}]);
  assert.equal(back.supplierConfirmed, false);
  assert.equal(back.supplierClaim, true);
  await h.rpc('rni', 'confirmSupplierClaim', [{id}]);
  const none = await h.rpc('sa', 'cancelSupplierClaim', [{id, step: 'claim'}]);
  assert.equal(none.supplierClaim, false);
  assert.equal(none.supplierConfirmed, false, 'cancelling step 1 also clears step 2');
  await h.rpc('rni', 'markSupplierClaim', [{id, supplier: 'S2'}]);
  await h.rpc('rni', 'confirmSupplierClaim', [{id}]);
  await h.rpc('rni', 'receiveSupplierClaim', [{id}]);
  await assert.rejects(h.rpc('sa', 'cancelSupplierClaim', [{id, step: 'confirm'}]), /already Received/);
});

test('Supplier Claim tables are not readable by ordinary users', async t => {
  const {h} = await prepare(t);
  await assert.rejects(h.as('user', () => h.db.query('select * from wlf_private.damage_demands')), /permission denied/);
});
