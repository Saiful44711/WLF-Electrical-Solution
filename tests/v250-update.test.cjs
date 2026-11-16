const test = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {makeDB, IDS} = require('./pg-harness.cjs');

const chain = ['UPDATE_V220','UPDATE_SUPPORT_FORMS_20261107','UPDATE_DAMAGE_DEMAND_20261107','UPDATE_WORKSPACE_20261107','UPDATE_SECTIONS_V230','UPDATE_V240'];
const migration = readFileSync('supabase/UPDATE_V250.sql','utf8');

async function prepare(t, before) {
  const h = await makeDB();
  t.after(() => h.close());
  for (const file of chain) await h.db.exec(readFileSync('supabase/'+file+'.sql','utf8'));
  await h.db.query('alter table public.wlf_profiles disable trigger wlf_deletion_guard');
  for (const [who, emp, section] of [['sa','SA-1','R&I Electrical'],['rni','RN-3','R&I Electrical'],['rni2','RN-4','R&I Mechanical'],['user','US-5','Commissioning']])
    await h.db.query('update public.wlf_profiles set employee_id=$2, section=$3 where id=$1', [IDS[who], emp, section]);
  await h.db.query('alter table public.wlf_profiles enable trigger wlf_deletion_guard');
  if (before) await before(h);
  const results = await h.db.exec(migration);
  return {h, ready: results.at(-1).rows[0]};
}
const svc = async (h, action, payload = {}) => {
  await h.db.exec('set role service_role');
  try { return (await h.db.query('select public.wlf_push_service($1,$2) r', [action, JSON.stringify(payload)])).rows[0].r; }
  finally { await h.db.exec('reset role'); }
};

test('v2.5.0 migration is repeatable, adds Bangla troubleshooting and fixes Cancelled', async t => {
  const {h, ready} = await prepare(t, async h => {
    await h.db.query("update public.wlf_troubleshooting set content=content-'bn' where content ? 'bn'");
    await h.db.query(`insert into public.wlf_ri_entries(id,category,owner,author_name,status,form_schema,values,last_operation,last_payload_hash)
      select gen_random_uuid(),'wb-team',$1,'sa','Canceled',schema,'{"status":"Canceled"}',gen_random_uuid(),'x' from public.wlf_ri_categories where id='wb-team'`, [IDS.sa]);
  });
  assert.equal(ready.change_history_ready, true);
  assert.equal(ready.push_ready, true);
  assert.equal(ready.support_colours_ready, true);
  assert.equal(ready.cancelled_spelling_fixed, true);
  assert.ok(Number(ready.bangla_entries) >= 160);
  assert.equal(ready.v250_rules_ready, true);
  const again = (await h.db.exec(migration)).at(-1).rows[0];
  assert.equal(again.v250_rules_ready, true);
  const entry = (await h.db.query("select content, revision from public.wlf_troubleshooting where id='nice-err20'")).rows[0];
  assert.match(entry.content.bn.description, /[ঀ-৿]/);
  assert.equal(entry.content.revision, entry.revision);
  assert.ok(entry.content.bn.subcodes.every(s => entry.content.subcodes.some(e => e.code === s.code)));
  const err02 = (await h.db.query("select content from public.wlf_troubleshooting where id='nice-err02'")).rows[0].content;
  assert.match(err02.bn.solution[0], /^কারণ: .+ \| /);
  const tb = await h.rpc('user', 'getTroubleshooting');
  const list = Array.isArray(tb) ? tb : (tb.entries || tb.records || []);
  assert.ok(JSON.stringify(list).includes('"bn"'), 'Bangla reaches the app');
  const row = (await h.db.query("select status, values->>'status' v from public.wlf_ri_entries where author_name='sa'")).rows[0];
  assert.deepEqual(row, {status: 'Cancelled', v: 'Cancelled'});
  const session = await h.rpc('sa', 'getSession');
  assert.equal(session.build, '2.5.0');
  assert.deepEqual(session.supportAging, {yellowDays: 2, redDays: 3});
});

test('User Management change history is recorded for Super Admin only', async t => {
  const {h} = await prepare(t);
  const list = (await h.rpc('sa', 'listAppUsers')).users;
  const target = list.find(x => x.email === 'user@example.test');
  const saved = await h.rpc('sa', 'saveAppUserAccess', [{email: target.email, accessRevision: target.accessRevision ?? target.access_revision,
    name: 'User Five', empId: 'US-55', section: 'Commissioning', status: 'Approved', superAdmin: false,
    permissions: [...target.permissions.filter(k => k !== 'dashboard'), 'ri:projects']}]);
  assert.equal(saved.name, 'User Five');
  const log = await h.rpc('sa', 'getUserAccessLog', [{email: target.email}]);
  assert.equal(log.length, 1);
  assert.deepEqual(log[0].changes.name, {from: 'user', to: 'User Five'});
  assert.deepEqual(log[0].changes.empId, {from: 'US-5', to: 'US-55'});
  assert.deepEqual(log[0].changes.added, ['ri:projects']);
  assert.deepEqual(log[0].changes.removed, ['dashboard']);
  assert.match(log[0].by, /\(SA-1\)$/);
  await assert.rejects(h.rpc('rni', 'getUserAccessLog', [{email: target.email}]), /Super Admin only/);
  // saving without a change adds nothing
  await h.rpc('sa', 'saveAppUserAccess', [{email: target.email, accessRevision: saved.accessRevision ?? saved.access_revision,
    name: 'User Five', empId: 'US-55', section: 'Commissioning', status: 'Approved', superAdmin: false, permissions: saved.permissions}]);
  assert.equal((await h.rpc('sa', 'getUserAccessLog', [{email: target.email}])).length, 1);
  await assert.rejects(h.as('sa', () => h.db.query('select * from wlf_private.access_log')));
});

test('Old-request colour days: Super Admin can change, others cannot', async t => {
  const {h} = await prepare(t);
  await assert.rejects(h.rpc('rni', 'saveSupportAging', [{yellowDays: 1, redDays: 2}]), /Super Admin only/);
  await assert.rejects(h.rpc('sa', 'saveSupportAging', [{yellowDays: 3, redDays: 3}]), /red greater/);
  assert.deepEqual(await h.rpc('sa', 'saveSupportAging', [{yellowDays: 1, redDays: 4}]), {yellowDays: 1, redDays: 4});
  assert.deepEqual((await h.rpc('user', 'getAppContext')).supportAging, {yellowDays: 1, redDays: 4});
});

test('Push: own devices only, new access request and forward create outbox rows, service API is locked', async t => {
  const {h} = await prepare(t);
  const sub = who => ({endpoint: 'https://push.example.test/' + who, p256dh: 'B'.repeat(87), auth: 'A'.repeat(22), device: 'test'});
  await assert.rejects(h.rpc('user', 'savePushSubscription', [{...sub('x'), endpoint: 'http://bad'}]), /Invalid/);
  for (const who of ['sa', 'rni', 'rni2']) assert.equal((await h.rpc(who, 'savePushSubscription', [sub(who)])).devices, 1);
  assert.equal((await h.rpc('rni', 'getPushStatus', [{endpoint: sub('rni').endpoint}])).subscribed, true);
  assert.equal((await h.rpc('user', 'deletePushSubscription', [{endpoint: sub('rni').endpoint}])).devices, 0);
  assert.equal((await h.rpc('rni', 'getPushStatus', [{endpoint: sub('rni').endpoint}])).subscribed, true, 'another user cannot remove it');
  await assert.rejects(h.as('user', () => h.db.query("select public.wlf_push_service('claim','{}')")));
  await assert.rejects(h.as('user', () => h.db.query('select * from wlf_private.push_subscriptions')));

  // a new sign-up notifies the Super Admin who has a device
  const newId = '00000000-0000-0000-0000-000000000099';
  await h.db.query("insert into auth.users(id,email,raw_user_meta_data) values($1,'new@example.test',$2)",
    [newId, JSON.stringify({name: 'New Person', employeeId: 'NP-9', section: 'Production'})]);
  let claimed = await svc(h, 'claim');
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].title, 'New access request');
  assert.match(claimed[0].body, /New Person \(NP-9\)/);
  assert.equal(claimed[0].subscriptions[0].endpoint, sub('sa').endpoint);
  assert.equal(await svc(h, 'done', {ids: [claimed[0].id]}), true);
  assert.deepEqual(await svc(h, 'claim'), []);

  // keys are stored once
  assert.equal(await svc(h, 'keys'), null);
  assert.deepEqual(await svc(h, 'keys', {publicKey: 'PUB', privateKey: 'PRIV'}), {publicKey: 'PUB', privateKey: 'PRIV'});
  assert.deepEqual(await svc(h, 'keys', {publicKey: 'OTHER', privateKey: 'X'}), {publicKey: 'PUB', privateKey: 'PRIV'});
  assert.equal((await h.rpc('user', 'getSession')).pushPublicKey, 'PUB');

  // forwarding a support request notifies the receiver
  await h.db.query("update public.wlf_profiles set permissions=array_append(permissions,'support:commissioning:request') where id in ($1,$2)", [IDS.rni, IDS.rni2]);
  const form = (await h.rpc('user', 'getSupportWorkspace', [{category: 'commissioning'}])).forms.commissioning;
  const values = Object.fromEntries(form.fields.map(f => [f.id,
    f.type === 'multi' ? f.options.slice(0,1) : f.type === 'date' ? '2026-11-15' :
    f.type === 'number' ? '1200' : f.type === 'checkbox' ? (f.options?.length ? [] : false) : f.options?.[0] || 'Fixture value']));
  let ticket = (await h.rpc('user', 'createSupportRequest', [{category: 'commissioning', formRevision: form.revision, values, mutationId: crypto.randomUUID()}])).ticket;
  ticket = (await h.rpc('rni', 'transitionSupportRequest', [{id: ticket.id, revision: ticket.revision, action: 'receive', mutationId: crypto.randomUUID()}])).ticket;
  assert.deepEqual(await svc(h, 'claim'), [], 'receive alone sends nothing');
  ticket = (await h.rpc('rni', 'transitionSupportRequest', [{id: ticket.id, revision: ticket.revision, action: 'forward',
    to: 'rni2@example.test', comment: 'Please check', mutationId: crypto.randomUUID()}])).ticket;
  assert.equal(ticket.status, 'Forwarded');
  claimed = await svc(h, 'claim');
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].title, 'Support request forwarded to you');
  assert.equal(claimed[0].subscriptions[0].endpoint, sub('rni2').endpoint);
  assert.equal(await svc(h, 'gone', {endpoints: [sub('rni2').endpoint]}), true);
  assert.equal((await h.rpc('rni2', 'getPushStatus', [{}])).devices, 0);
});

test('wlf-push Edge Function encrypts (RFC 8291) and signs (VAPID) correctly', async t => {
  const nodeCrypto = require('node:crypto');
  const {transformSync} = require('esbuild');
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const src = readFileSync('supabase/functions/wlf-push/index.ts', 'utf8').replace(/^import \{createClient\}.*$/m, 'const createClient = null;');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wlfpush-')), 'push.mjs');
  fs.writeFileSync(file, transformSync(src, {loader: 'ts', format: 'esm'}).code);
  t.after(() => fs.rmSync(path.dirname(file), {recursive: true, force: true}));
  const push = await import(file);
  // browser side keys
  const ua = nodeCrypto.createECDH('prime256v1'); ua.generateKeys();
  const auth = nodeCrypto.randomBytes(16);
  const b64 = b => Buffer.from(b).toString('base64url');
  const message = {title: 'New access request', body: 'নতুন অনুরোধ · Test (T-1)', url: './#users'};
  const keys = await push.createKeys();
  let captured;
  const status = await push.send({endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh: b64(ua.getPublicKey()), auth: b64(auth)},
    message, keys, 'https://example.supabase.co', async (url, init) => { captured = {url, init}; return new Response('', {status: 201}); });
  assert.equal(status, 201);
  assert.equal(captured.init.headers['Content-Encoding'], 'aes128gcm');
  // independent decrypt (receiver side)
  const body = Buffer.from(captured.init.body);
  const salt = body.subarray(0, 16), rs = body.readUInt32BE(16), idlen = body[20], asPub = body.subarray(21, 21 + idlen), cipher = body.subarray(21 + idlen);
  assert.equal(rs, 4096); assert.equal(idlen, 65);
  const shared = ua.computeSecret(asPub);
  const h = (k, d) => nodeCrypto.createHmac('sha256', k).update(d).digest();
  const ikm = h(h(auth, shared), Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPub, Buffer.from([1])]));
  const prk = h(salt, ikm);
  const cek = h(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = h(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const dec = nodeCrypto.createDecipheriv('aes-128-gcm', cek, nonce);
  dec.setAuthTag(cipher.subarray(cipher.length - 16));
  const plain = Buffer.concat([dec.update(cipher.subarray(0, cipher.length - 16)), dec.final()]);
  assert.equal(plain.at(-1), 2);
  assert.deepEqual(JSON.parse(plain.subarray(0, -1).toString('utf8')), message);
  // VAPID header verifies with the public key
  const m = captured.init.headers.Authorization.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/);
  assert.ok(m);
  assert.equal(m[4], keys.publicKey);
  const claims = JSON.parse(Buffer.from(m[2], 'base64url'));
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  assert.ok(claims.exp > Date.now() / 1000 && claims.exp <= Date.now() / 1000 + 24 * 3600);
  const pub = Buffer.from(keys.publicKey, 'base64url');
  const verifyKey = nodeCrypto.createPublicKey({key: {kty: 'EC', crv: 'P-256', x: b64(pub.subarray(1, 33)), y: b64(pub.subarray(33))}, format: 'jwk'});
  assert.ok(nodeCrypto.verify('sha256', Buffer.from(m[1] + '.' + m[2]), {key: verifyKey, dsaEncoding: 'ieee-p1363'}, Buffer.from(m[3], 'base64url')));
});
