const test = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {makeDB, IDS} = require('./pg-harness.cjs');

const chain = eval(readFileSync('tests/v272-update.test.cjs', 'utf8').match(/const chain = (\[[^\]]*\])/)[1]);
const migration = readFileSync('supabase/UPDATE_V274.sql', 'utf8');

async function prepare(t, before) {
  const h = await makeDB();
  t.after(() => h.close());
  for (const file of [...chain, 'UPDATE_V272', 'UPDATE_V273']) await h.db.exec(readFileSync('supabase/' + file + '.sql', 'utf8'));
  if (before) await before(h);
  const results = await h.db.exec(migration);
  return {h, ready: results.at(-1).rows[0]};
}
const grant = (h, who, key) => h.db.query('update public.wlf_profiles set permissions=array_append(permissions,$2) where id=$1', [IDS[who], key]);
const asPerson = async (h, who) => { await h.db.exec('reset role'); await h.db.query("select set_config('request.jwt.claim.sub',$1,false)", [IDS[who]]); };

test('v2.7.4 migration is repeatable, reports the new build and removes the old catalogue edit permission', async t => {
  const {h, ready} = await prepare(t, async h => { await grant(h, 'rni', 'catalogue:edit'); });
  assert.equal(ready.v274_ready, true);
  assert.equal((await h.db.exec(migration)).at(-1).rows[0].v274_ready, true);
  assert.equal((await h.rpc('sa', 'getSession')).build, '2.7.4');
  const left = await h.db.query("select count(*)::int n from public.wlf_profiles where 'catalogue:edit'=any(permissions)");
  assert.equal(left.rows[0].n, 0);
  const keys = (await h.db.query('select jsonb_path_query_array(wlf_private.catalog(), \'$[*].key\') k')).rows[0].k;
  assert.ok(!keys.includes('catalogue:edit'), 'catalogue:edit can no longer be given');
  for (const k of ['catalogue:log', 'announcements:manage', 'components:log']) assert.ok(keys.includes(k), k);
  const groups = (await h.db.query('select x->>\'key\' k, x->>\'group\' g from jsonb_array_elements(wlf_private.catalog()) x')).rows;
  assert.equal(groups.find(x => x.k === 'components:log').g, 'Components Data');
});

test('only the Super Admin edits the Hardware Catalogue; the change log shows who changed what and the Super Admin chooses who sees it', async t => {
  const {h} = await prepare(t);
  await asPerson(h, 'sa');
  const ins = await h.db.query("insert into wlf_private.hw_catalogue(system,model,hardware,item_name,brand) values('MOT','MOT 5.5 kW','Drive','Drive A','Acme') returning id");
  const id = ins.rows[0].id;
  await h.db.query("update wlf_private.hw_catalogue set brand='Beta', sort=5 where id=$1", [id]);
  await h.db.query("update wlf_private.hw_catalogue set sort=6, revision=revision+1 where id=$1", [id]);   // order only: not logged
  await h.db.query("update wlf_private.hw_catalogue set deleted_at=now() where id=$1", [id]);
  await h.db.query("update wlf_private.hw_catalogue set deleted_at=null where id=$1", [id]);
  const log = await h.rpc('sa', 'getCatalogueLog', [{}]);
  assert.deepEqual(log.rows.map(r => r.action).reverse(), ['Added', 'Edited', 'Deleted', 'Restored']);
  const edit = log.rows.find(r => r.action === 'Edited');
  assert.deepEqual(edit.changes, [{field: 'Brand', old: 'Acme', new: 'Beta'}]);
  assert.match(edit.label, /MOT .* Drive A/);
  assert.equal(log.rows[0].who.length > 0, true);
  assert.equal((await h.rpc('sa', 'getCatalogueLog', [{q: 'beta'}])).total, 3);
  // nobody else sees the log until the Super Admin allows it
  await assert.rejects(h.rpc('user', 'getCatalogueLog', [{}]), /change log access required/);
  await grant(h, 'user', 'catalogue:log');
  assert.equal((await h.rpc('user', 'getCatalogueLog', [{}])).total, 4);
  await assert.rejects(h.rpc('rni', 'getCatalogueLog', [{}]), /change log access required/);
});

test('the Component change log needs only its own permission, no Usage Dashboard access', async t => {
  const {h} = await prepare(t);
  await assert.rejects(h.rpc('user', 'getComponentLog', [{}]), /Component change log access required/);
  await grant(h, 'user', 'components:log');
  assert.ok(Array.isArray((await h.rpc('user', 'getComponentLog', [{}])).rows));
  assert.ok(Array.isArray((await h.rpc('sa', 'getComponentLog', [{}])).rows));
});

test('Announcement can be given to a chosen person; others are refused', async t => {
  const {h} = await prepare(t);
  await assert.rejects(h.rpc('rni', 'getAnnouncementAdmin', [{}]), /Announcement access required/);
  assert.ok((await h.rpc('sa', 'getAnnouncementAdmin', [{}])).items);
  await grant(h, 'rni', 'announcements:manage');
  const x = await h.rpc('rni', 'getAnnouncementAdmin', [{}]);
  assert.ok(Array.isArray(x.items) && Array.isArray(x.sections));
  await assert.rejects(h.rpc('rni2', 'saveAnnouncement', [{title: 'x', body: 'y', sections: ['R&I Electrical']}]), /Announcement access required/);
});

test('the client rules match: Hardware Catalogue page for the Super Admin or a log viewer only', () => {
  const C = require('../shared/access-core.js');
  const sa = {status: 'Approved', role: 'Super Admin', permissions: []};
  const ri = {status: 'Approved', role: 'R&I', permissions: ['catalogue:edit', 'qms:components']};
  const viewer = {status: 'Approved', role: 'R&I', permissions: ['catalogue:log', 'components:log', 'announcements:manage']};
  assert.equal(C.catalogueAccess(sa), true);
  assert.equal(C.catalogueAccess(ri), false);
  assert.equal(C.catalogueRead(ri), true, 'QMS still reads the catalogue');
  assert.equal(C.catalogueLogAccess(viewer), true);
  assert.equal(C.catalogueLogAccess(ri), false);
  assert.equal(C.componentLogAccess(viewer), true);
  assert.equal(C.announcementAccess(viewer), true);
  assert.equal(C.announcementAccess(ri), false);
  assert.equal(C.apiCan(viewer, 'getCatalogueLog'), true);
  assert.equal(C.apiCan(ri, 'getCatalogueLog'), false);
  assert.equal(C.apiCan(viewer, 'saveAnnouncement'), true);
  assert.equal(C.apiCan(viewer, 'getRecycleBin'), false, 'the Recycle bin stays Super Admin only');
});
