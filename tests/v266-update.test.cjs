const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {readFileSync} = require('node:fs');
const {makeDB, IDS} = require('./pg-harness.cjs');

const chain = ['UPDATE_V220','UPDATE_SUPPORT_FORMS_20261107','UPDATE_DAMAGE_DEMAND_20261107','UPDATE_WORKSPACE_20261107','UPDATE_SECTIONS_V230','UPDATE_V240','UPDATE_V250','UPDATE_V251','UPDATE_V252','UPDATE_V253','UPDATE_V254','UPDATE_V255','UPDATE_V256','UPDATE_V257','UPDATE_V258','UPDATE_V259','UPDATE_V260','UPDATE_V261','UPDATE_V262','UPDATE_V263','UPDATE_V264','UPDATE_V265'];
const migration = readFileSync('supabase/UPDATE_V266.sql','utf8');

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


const SL = {motor: '1', encoder: '2', drive: '3', ups: '4', cartop: '5', cop: '6', copDisplay: '7'};

test('v2.6.6 migration is repeatable and reports the new build', async t => {
  const {h, ready} = await prepare(t);
  assert.equal(ready.admin_series_ready, true);
  assert.equal(ready.note_column_ready, true);
  assert.equal(ready.v266_ready, true);
  const again = (await h.db.exec(migration)).at(-1).rows[0];
  assert.equal(again.v266_ready, true);
  assert.equal((await h.rpc('sa', 'getSession')).build, '2.6.6');
});

test('Admin Panel series: 365 daily values per approved R&I user, in the right measure and day', async t => {
  const {h} = await prepare(t);
  await h.db.query("update public.wlf_profiles set role='R&I' where id=any($1)", [[IDS.rni, IDS.rni2]]);
  await h.db.query("update public.wlf_profiles set role='User' where id=$1", [IDS.user]);
  await give(h, 'admin', 'workspace:dashboard');
  await entry(h, 'rni', 'team', 'Completed', 90);
  await entry(h, 'rni', 'team', 'Ongoing', 30);
  await entry(h, 'rni', 'scm', 'Completed', 0, 40);
  await entry(h, 'rni', 'team', 'Completed', 500, 400);      // older than 365 days
  await entry(h, 'rni2', 'reports', 'Hold', null);
  const data = await h.rpc('admin', 'getAdminSeries', [{}]);
  assert.equal(data.days, 365);
  assert.equal(data.users.length, 2, 'only approved R&I users');
  assert.ok(data.users.every(u => Object.values(u.s).every(a => a.length === 365)));
  const me = data.users.find(u => u.id === IDS.rni).s;
  const sum = a => a.reduce((x, y) => x + Number(y), 0);
  assert.equal(sum(me.entries), 3, 'the 400-day-old entry is outside the 365 days');
  assert.equal(sum(me.completed), 2);
  assert.equal(sum(me.hours), 2, '120 minutes = 2 hours');
  assert.equal(Number(me.entries[364]), 2, 'today is the last value');
  assert.equal(Number(me.entries[364 - 40]), 1, '40 days ago');
  assert.equal(sum(me.received) + sum(me.solved) + sum(me.damage) + sum(me.claims), 0);
  const today = (await h.db.query("select (now() at time zone 'Asia/Dhaka')::date d")).rows[0].d;
  assert.equal(String(data.end).slice(0, 10), new Date(today).toISOString().slice(0, 10));
});

test('Admin Panel series needs the Admin Panel permission', async t => {
  const {h} = await prepare(t);
  await h.db.query("update public.wlf_profiles set role='R&I' where id=$1", [IDS.rni]);
  await assert.rejects(() => h.rpc('user', 'getAdminSeries', [{}]), /Admin Panel access required/);
  await assert.rejects(() => h.rpc('rni', 'getAdminSeries', [{}]), /Admin Panel access required/);
  assert.ok((await h.rpc('sa', 'getAdminSeries', [{}])).users.length >= 1);
});

test('Special note is saved by specialNote, tracked, optional and still in the backup', async t => {
  const {h} = await prepare(t);
  const cat = await h.rpc('sa', 'getCatalogue');
  const ctrl = cat.rows.find(r => r.model === 'MOT 7.5 kW' && r.itemCode);
  const paid = cat.rows.filter(r => r.system === 'MOT' && r.model === 'Paid feature' && r.grp === 'Remote Alarm');
  const lift = extra => ({id: '33333333-3333-4333-8333-333333333333', revision: 0, liftId: 'N-1', project: 'Note Tower', deliveryDate: '2026-11-24', motorType: 'Gearless',
    liftType: 'Passenger', system: 'MOT', controllerModel: 'MOT 7.5 kW', serials: SL, selection: null,
    items: [{catalogueId: ctrl.id, section: 'control'}, ...paid.map(r => ({catalogueId: r.id, section: 'paid'}))], ...extra});
  const saved = await h.rpc('sa', 'saveQmsLift', [lift({specialNote: '  Keep the spare key  '})]);
  assert.equal(saved.specialNote, 'Keep the spare key');
  assert.equal(saved.paidNote, undefined, 'the old key is gone');
  assert.equal(saved.parts.filter(p => p.section === 'paid').length, 4, 'paid feature rows are not touched by the note');
  const edited = await h.rpc('sa', 'saveQmsLift', [lift({revision: saved.revision, specialNote: 'Keep two spare keys'})]);
  assert.deepEqual(edited.history.at(-1).changed, ['Special note']);
  const cleared = await h.rpc('sa', 'saveQmsLift', [lift({revision: edited.revision})]);
  assert.equal(cleared.specialNote, '');
  await assert.rejects(h.rpc('sa', 'saveQmsLift', [lift({revision: cleared.revision, specialNote: 'x'.repeat(501)})]), /too long/);
  const again = await h.rpc('sa', 'saveQmsLift', [lift({revision: cleared.revision, specialNote: 'Old key name', paidNote: undefined})]);
  const exp = await h.rpc('sa', 'adminExportData', [{kind: 'qms', offset: 0, limit: 50}]);
  assert.equal(exp.rows.find(r => r.lift_id === 'N-1').paid_note, 'Old key name', 'backups keep using the same column');
  assert.equal(again.specialNote, 'Old key name');
});
