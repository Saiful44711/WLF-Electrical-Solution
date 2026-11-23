const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {readFileSync} = require('node:fs');
const {makeDB, IDS} = require('./pg-harness.cjs');

const chain = ['UPDATE_V220','UPDATE_SUPPORT_FORMS_20261107','UPDATE_DAMAGE_DEMAND_20261107','UPDATE_WORKSPACE_20261107','UPDATE_SECTIONS_V230','UPDATE_V240','UPDATE_V250','UPDATE_V251','UPDATE_V252','UPDATE_V253','UPDATE_V254','UPDATE_V255','UPDATE_V256','UPDATE_V257','UPDATE_V258','UPDATE_V259','UPDATE_V260','UPDATE_V261','UPDATE_V262'];
const migration = readFileSync('supabase/UPDATE_V263.sql','utf8');

async function prepare(t) {
  const h = await makeDB();
  t.after(() => h.close());
  for (const file of chain) await h.db.exec(readFileSync('supabase/'+file+'.sql','utf8'));
  const results = await h.db.exec(migration);
  return {h, ready: results.at(-1).rows[0]};
}
const usage = (h, who, args, actor = 'sa') => h.db.query('select public.wlf_usage_admin($1,$2,$3) result', [who, IDS[actor], args]).then(x => x.rows[0].result);
const full = (h, who, args, actor = 'sa') => h.db.query('select public.wlf_full_admin($1,$2,$3) result', [who, IDS[actor], args]).then(x => x.rows[0].result);
const addUsage = (h, days, n = 1, action = 'Login') => h.db.query(
  `insert into public.wlf_usage(actor,action,details,at) select $1,$2,'row '||g, now()-($3||' days')::interval from generate_series(1,$4) g`, [IDS.sa, action, String(days), n]);
const count = async h => Number((await h.db.query('select count(*) n from public.wlf_usage')).rows[0].n);
const sha = 'a'.repeat(64);

test('v2.6.3 migration is repeatable, reports ready and calculations can no longer be saved', async t => {
  const {h, ready} = await prepare(t);
  assert.equal(ready.usage_archive_ready, true);
  assert.equal(ready.full_backup_ready, true);
  assert.equal(ready.v263_ready, true);
  assert.equal((await h.db.exec(migration)).at(-1).rows[0].v263_ready, true);
  assert.equal((await h.rpc('sa', 'getSession')).build, '2.6.3');
  await assert.rejects(() => h.rpc('sa', 'saveEngineeringRecord', [{id: crypto.randomUUID(), action: 'calculateTravel'}]), /Saving calculations has been removed/);
});

test('Usage log archive deletes only the rows that were saved to Drive and never newer rows', async t => {
  const {h} = await prepare(t);
  await h.db.query('delete from public.wlf_usage');
  await addUsage(h, 10, 3); await addUsage(h, 2, 4);
  const snap = await usage(h, 'prepare', {});
  assert.equal(snap.count, 3);
  assert.equal(snap.rows.length, 3);
  assert.equal(snap.remaining, 0);
  await new Promise(r => setTimeout(r, 20));
  await addUsage(h, 9, 1); // arrives after the file was made: must survive
  await assert.rejects(() => usage(h, 'finish', {maxId: snap.maxId, count: snap.count, cutoff: snap.cutoff, fileId: 'bad id', sha256: sha}), /verified Drive file is missing/);
  assert.equal(await count(h), 8, 'nothing deleted without a verified file');
  const done = await usage(h, 'finish', {maxId: snap.maxId, count: snap.count, cutoff: snap.cutoff, fileId: 'drive_file_1', sha256: sha});
  assert.equal(done.deleted, 3);
  assert.equal(await count(h), 5, 'rows of the last 7 days and the late old row stay');
  const history = await usage(h, 'history', {});
  assert.equal(history.length, 1);
  assert.equal(history[0].rows, 3);
  const log = (await h.db.query("select counts from wlf_private.purge_log where what like 'Activity log saved to Google Drive%'")).rows;
  assert.equal(log.length, 1);
});

test('Usage log archive handles a large backlog in several rounds and refuses non Super Admins', async t => {
  const {h} = await prepare(t);
  await h.db.query('delete from public.wlf_usage');
  await addUsage(h, 12, 20050);
  const first = await usage(h, 'prepare', {});
  assert.equal(first.count, 20000);
  assert.equal(first.remaining, 50);
  await usage(h, 'finish', {maxId: first.maxId, count: first.count, cutoff: first.cutoff, fileId: 'drive_file_a', sha256: sha});
  const second = await usage(h, 'prepare', {});
  assert.equal(second.count, 50);
  assert.equal(second.remaining, 0);
  await assert.rejects(() => usage(h, 'prepare', {}, 'rni'), /Super Admin only/);
  await assert.rejects(() => usage(h, 'finish', {maxId: 1, count: 1, cutoff: new Date().toISOString(), fileId: 'drive_file_a', sha256: sha}), /Only rows older than 7 days/);
});

test('The automatic safety net now removes only rows older than 30 days', async t => {
  const {h} = await prepare(t);
  await h.db.query('delete from public.wlf_usage');
  await addUsage(h, 10, 2); await addUsage(h, 40, 2);
  await h.db.query("update wlf_private.usage_housekeeping set last_run=now()-interval '3 hours'");
  await h.db.query("insert into public.wlf_usage(actor,action,details) values($1,'Login','new')", [IDS.sa]);
  assert.equal(Number((await h.db.query("select count(*) n from public.wlf_usage where at<now()-interval '30 days'")).rows[0].n), 0);
  assert.equal(Number((await h.db.query("select count(*) n from public.wlf_usage where at<now()-interval '7 days'")).rows[0].n), 2);
});

test('Backup of all other data: export, record, history, restore missing data only, delete history', async t => {
  const {h} = await prepare(t);
  const category = crypto.randomUUID(), folder = crypto.randomUUID(), doc = crypto.randomUUID();
  await h.db.query("insert into public.wlf_document_categories(id,name,fields) values($1,'Manuals','[]')", [category]);
  await h.db.query("insert into public.wlf_document_folders(id,category,name) values($1,$2,'NICE')", [folder, category]);
  await h.db.query("insert into public.wlf_documents(id,category,folder,name,url,extra) values($1,$2,$3,'Guide','https://example.test/g','{}')", [doc, category, folder]);
  const snap = await full(h, 'export', {});
  assert.ok(snap.id);
  assert.equal(snap.counts.documents, 1);
  assert.equal(snap.counts['document-folders'], 1);
  assert.ok(snap.counts.users >= 5, 'users are listed for reference');
  assert.ok(snap.counts['hardware-catalogue'] > 100);
  const archive = {format: 'WLF-FULL-2.6.3', id: snap.id, tables: snap.tables};
  await full(h, 'record', {id: snap.id, fileId: 'drive_file_9', sha256: sha, bytes: 1234, counts: snap.counts});
  assert.equal((await full(h, 'history', {})).length, 1);
  assert.equal((await full(h, 'read', {id: snap.id})).file_id, 'drive_file_9');

  await h.db.query('delete from public.wlf_documents'); await h.db.query('delete from public.wlf_document_folders');
  await h.db.query("update public.wlf_document_categories set name='Changed' where id=$1", [category]);
  const profilesBefore = Number((await h.db.query('select count(*) n from public.wlf_profiles')).rows[0].n);
  const out = await full(h, 'restore', {archive});
  assert.equal(out.restored.documents, 1);
  assert.equal(out.restored['document-folders'], 1);
  assert.equal(out.restored.users, undefined, 'users are never restored from here');
  assert.equal(Number((await h.db.query('select count(*) n from public.wlf_profiles')).rows[0].n), profilesBefore);
  assert.equal((await h.db.query("select name from public.wlf_document_categories where id=$1", [category])).rows[0].name, 'Changed', 'existing data is kept');
  assert.equal((await h.db.query('select name from public.wlf_documents where id=$1', [doc])).rows[0].name, 'Guide');
  const again = await full(h, 'restore', {archive});
  assert.equal(again.restored.documents ?? 0, 0, 'restoring twice adds nothing');

  await assert.rejects(() => full(h, 'restore', {archive: {format: 'x', tables: {}}}), /Invalid backup file/);
  await assert.rejects(() => full(h, 'export', {}, 'rni'), /Super Admin only/);
  await assert.rejects(() => full(h, 'deleteHistory', {all: true}), /Type DELETE/);
  assert.equal((await full(h, 'deleteHistory', {id: snap.id})).deleted, 1);
  assert.equal((await full(h, 'history', {})).length, 0);
});
