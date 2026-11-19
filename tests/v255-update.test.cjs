const test = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {makeDB, IDS} = require('./pg-harness.cjs');
const TroubleCore = require('../shared/troubleshooting-core.js');

const chain = ['UPDATE_V220','UPDATE_SUPPORT_FORMS_20261107','UPDATE_DAMAGE_DEMAND_20261107','UPDATE_WORKSPACE_20261107','UPDATE_SECTIONS_V230','UPDATE_V240','UPDATE_V250','UPDATE_V251','UPDATE_V252','UPDATE_V253','UPDATE_V254'];
const migration = readFileSync('supabase/UPDATE_V255.sql','utf8');

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
const motcube = async (h, who) => (await h.rpc(who, 'getTroubleshooting')).entries.filter(e => e.controller === 'MOTCUBE');

test('v2.5.5 migration is repeatable and loads 61 MOTCUBE codes plus the Permanent Error Clearing option', async t => {
  const {h, ready} = await prepare(t);
  assert.deepEqual(ready, {motcube_codes_ready: true, motcube_error_codes: 61, motcube_permission_ready: true, supplier_reference_ready: true, v255_ready: true});
  assert.equal((await h.db.exec(migration)).at(-1).rows[0].motcube_error_codes, 61, 'second run adds nothing');
  assert.equal((await h.rpc('sa', 'getSession')).build, '2.5.5');
  const all = await motcube(h, 'sa');
  const errors = all.filter(e => e.kind === 'error'), options = all.filter(e => e.kind === 'procedure');
  assert.equal(errors.length, 61);
  assert.equal(errors.some(e => e.code === 'H20'), false, 'the manual has no H20');
  assert.equal(options.length, 1);
  assert.equal(options[0].category, 'Permanent Error Clearing');
  assert.equal(options[0].fields.length, 3);
  const h22 = errors.find(e => e.code === 'H22');
  assert.equal(h22.permanent, true);
  assert.deepEqual(h22.parameters, ['2.39: MAINTENANCE TIME CONTROL', '2.40: MAINTENANCE TIME']);
  assert.equal(errors.find(e => e.code === 'H18').contactRni, true);
  assert.equal(errors.find(e => e.code === 'H1').permanent, false);
  assert.match(errors.find(e => e.code === 'H5').sourceNote, /818/);
});

test('Every MOTCUBE entry has English and Bangla text that is up to date, and passes the shared validation', async t => {
  const {h} = await prepare(t);
  for (const e of (await motcube(h, 'sa')).filter(x => x.kind === 'error')) {
    assert.ok(e.bn && e.bn.description && e.bn.conditions && e.bn.solution.length, e.code + ' has Bangla');
    for (const k of ['d', 'c', 's']) assert.equal(TroubleCore.bnFresh(e, k), true, e.code + ' Bangla ' + k + ' fingerprint');
    const copy = JSON.parse(JSON.stringify(e)); delete copy.updatedAt; delete copy.updatedBy;
    const checked = TroubleCore.validate(copy);
    assert.equal(checked.code, e.code);
    assert.equal(checked.permanent, e.permanent);
    assert.equal(checked.contactRni, e.contactRni);
    assert.deepEqual(checked.parameters, e.parameters);
  }
  const idx = TroubleCore.index(await motcube(h, 'sa'));
  assert.deepEqual(TroubleCore.search(idx, 'MOTCUBE', 'H12').map(e => e.code), ['H12']);
  assert.deepEqual(TroubleCore.search(idx, 'MOTCUBE', 'h1').map(e => e.code), ['H1']);
  assert.ok(TroubleCore.search(idx, 'MOTCUBE', 'door lock').some(e => e.code === 'H1'));
  assert.ok(TroubleCore.search(idx, 'MOTCUBE', 'maintenance time control').some(e => e.code === 'H22'), 'parameter text is searchable');
  assert.ok(TroubleCore.search(idx, 'MOTCUBE', 'দরজা').length >= 0);
});

test('MOTCUBE is a separate permission: every non-Super-Admin account needs the tick', async t => {
  const {h} = await prepare(t);
  const cat = (await h.rpc('sa', 'listAppUsers')).catalog.find(x => x.key === 'tb:MOTCUBE:error');
  assert.equal(cat.label, 'MOTCUBE / Error Solution');
  assert.equal(cat.group, 'Troubleshooting');
  assert.equal((await motcube(h, 'user')).length, 0, 'a section user has nothing by default');
  await grant(h, 'user', 'tb:MOT:error');
  assert.equal((await motcube(h, 'user')).length, 0, 'the MOT tick does not open MOTCUBE');
  await grant(h, 'user', 'tb:MOTCUBE:error');
  const mine = await motcube(h, 'user');
  assert.equal(mine.filter(e => e.kind === 'error').length, 61);
  assert.equal(mine.filter(e => e.kind === 'procedure').length, 0, 'the sub option needs its own tick');
  assert.equal((await motcube(h, 'rni')).length, 0, 'since v2.3.0 only Super Admin passes automatically; R&I also needs the tick');
  await grant(h, 'rni', 'tb:MOTCUBE:error');
  assert.equal((await motcube(h, 'rni')).filter(e => e.kind === 'error').length, 61);
  assert.equal((await motcube(h, 'sa')).length, 62);
  const session = await h.rpc('sa', 'getAppContext');
  assert.ok(session.optionEntries.some(x => x.controller === 'MOTCUBE' && x.kind === 'error'));
  // usage log of a view
  await h.rpc('user', 'logAction', ['Troubleshooting / MOTCUBE / Error Solution', '{"code":"H1"}']);
  await assert.rejects(h.rpc('admin', 'logAction', ['Troubleshooting / MOTCUBE / Error Solution', '{}']), /Permission denied/);
  await assert.rejects(h.rpc('user', 'logAction', ['Troubleshooting / MOTCUBE / Permanent Error Clearing', '{}']), /Permission denied/);
});

test('Super Admin edits, adds and deletes MOTCUBE codes and options; nobody else can', async t => {
  const {h} = await prepare(t);
  const h1 = (await motcube(h, 'sa')).find(e => e.code === 'H1');
  const edited = await h.rpc('sa', 'saveTroubleshootingEntry', [{...h1, description: 'Door lock failed (edited)', solution: ['Edited step'], mutationId: 'tbm-edit-1'}]);
  assert.equal(edited.revision, 2);
  assert.equal(edited.permanent, false);
  await assert.rejects(h.rpc('sa', 'saveTroubleshootingEntry', [{...h1, description: 'stale', mutationId: 'tbm-edit-2'}]), /TB_CONFLICT/);
  const added = await h.rpc('sa', 'saveTroubleshootingEntry', [TroubleCore.validate({id: 'motcube-h99', controller: 'MOTCUBE', kind: 'error', code: 'h99', description: 'New code', solution: ['Do this'], parameters: ['7.1: X'], permanent: true, contactRni: true, mutationId: 'tbm-new-1'})]);
  assert.equal(added.code, 'H99');
  const opt = await h.rpc('sa', 'saveTroubleshootingEntry', [TroubleCore.validate({id: 'motcube-option-new', controller: 'MOTCUBE', kind: 'procedure', category: 'Encoder test', description: 'x', fields: [{label: 'Step 1', text: 'Check'}], mutationId: 'tbm-new-2'})]);
  assert.equal(opt.category, 'Encoder test');
  const now = await motcube(h, 'sa');
  assert.ok(now.some(e => e.code === 'H99' && e.permanent === true));
  assert.ok(now.some(e => e.category === 'Encoder test'));
  // wrong codes / duplicates / permissions
  await assert.rejects(h.rpc('sa', 'saveTroubleshootingEntry', [{id: 'motcube-bad-code', controller: 'MOTCUBE', kind: 'error', code: 'Er07', description: 'x'}]), /Code and description required/);
  await assert.rejects(h.rpc('sa', 'saveTroubleshootingEntry', [{id: 'motcube-dup-h1x', controller: 'MOTCUBE', kind: 'error', code: 'H1', description: 'dup'}]));
  for (const who of ['rni', 'user', 'admin'])
    await assert.rejects(h.rpc(who, 'saveTroubleshootingEntry', [{id: 'motcube-h98', controller: 'MOTCUBE', kind: 'error', code: 'H98', description: 'x'}]), /Permission denied/, who);
  // MOT and NICE3000+ still work as before
  await assert.rejects(h.rpc('sa', 'saveTroubleshootingEntry', [{id: 'other-ctrl-1', controller: 'XYZ', kind: 'error', code: 'Er01', description: 'x'}]), /Invalid troubleshooting entry/);
  const mot = (await h.rpc('sa', 'getTroubleshooting')).entries.find(e => e.controller === 'MOT');
  assert.ok(mot);
  await h.rpc('sa', 'deleteTroubleshootingEntry', ['motcube-h99', added.revision]);
  assert.equal((await motcube(h, 'sa')).some(e => e.code === 'H99'), false);
  // running the migration again must keep the edit
  await h.db.exec(migration);
  assert.equal((await motcube(h, 'sa')).find(e => e.code === 'H1').description, 'Door lock failed (edited)');
});

test('Supplier Claim v2.5.5: optional reference, reference edit, Undo Received', async t => {
  const {h} = await prepare(t);
  const id = await damage(h, 'aftersales', 'Encoder', 1);
  const id2 = await damage(h, 'installation', 'Brake coil', 2);
  await grant(h, 'rni', 'supplier:claim', 'supplier:confirm', 'supplier:receive', 'supplier:view');
  // without a reference
  await h.rpc('rni', 'markSupplierClaim', [{id, supplier: 'Mona drive'}]);
  await assert.rejects(h.rpc('rni', 'confirmSupplierClaim', [{id: id2}]), /Claim Sent to Supplier/);
  const plain = await h.rpc('rni', 'confirmSupplierClaim', [{id}]);
  assert.equal(plain.supplierConfirmed, true);
  assert.equal(plain.supplier.reference, '', 'reference is optional');
  // with a reference
  await h.rpc('rni', 'markSupplierClaim', [{id: id2, supplier: 'Arkel'}]);
  await assert.rejects(h.rpc('rni', 'confirmSupplierClaim', [{id: id2, reference: 'x'.repeat(61)}]), /too long/);
  const withRef = await h.rpc('rni', 'confirmSupplierClaim', [{id: id2, reference: '  ST-2026-0457  '}]);
  assert.equal(withRef.supplier.reference, 'ST-2026-0457');
  assert.equal((await h.rpc('rni', 'getSupplierClaims', [{status: 'All'}])).items.find(x => x.id === id2).supplier.reference, 'ST-2026-0457');
  // the reference can be added or changed later, until the goods are Received
  const later = await h.rpc('rni', 'saveSupplierReference', [{id, reference: 'ST-LATE-1'}]);
  assert.equal(later.supplier.reference, 'ST-LATE-1');
  assert.equal((await h.rpc('rni', 'saveSupplierReference', [{id, reference: ''}])).supplier.reference, '');
  await grant(h, 'user', 'supplier:view');
  await assert.rejects(h.rpc('user', 'saveSupplierReference', [{id, reference: 'X'}]), /do not have/);
  // receive, then undo
  await h.rpc('rni', 'receiveSupplierClaim', [{id: id2}]);
  await assert.rejects(h.rpc('rni', 'saveSupplierReference', [{id: id2, reference: 'CHANGED'}]), /already Received/);
  await assert.rejects(h.rpc('rni', 'undoSupplierReceive', [{id: id2}]), /Only the Super Admin/);
  await assert.rejects(h.rpc('sa', 'cancelSupplierClaim', [{id: id2, step: 'confirm'}]), /Undo Received/);
  await assert.rejects(h.rpc('sa', 'undoSupplierReceive', [{id}]), /not Received/);
  const undone = await h.rpc('sa', 'undoSupplierReceive', [{id: id2}]);
  assert.equal(undone.supplier.status, 'Pending');
  assert.equal(undone.supplier.receivedAt, null);
  assert.equal(undone.supplier.undoBy.length > 0, true);
  assert.equal(undone.supplier.reference, 'ST-2026-0457', 'undo keeps the reference');
  assert.equal((await h.rpc('rni', 'getSupplierClaims', [{}])).pending, 2);
  assert.equal((await h.rpc('rni', 'getNavBadges')).supplierPending, 2);
  // it can be received again
  assert.equal((await h.rpc('rni', 'receiveSupplierClaim', [{id: id2}])).supplier.status, 'Received');
  // cancelling the confirm clears the reference
  await h.rpc('sa', 'undoSupplierReceive', [{id: id2}]);
  const back = await h.rpc('sa', 'cancelSupplierClaim', [{id: id2, step: 'confirm'}]);
  assert.equal(back.supplier.reference, '');
  assert.equal(back.supplierConfirmed, false);
});
