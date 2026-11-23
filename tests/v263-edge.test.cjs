const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const {transformSync} = require('esbuild');
const Zip = require('jszip');
const {makeDB, IDS} = require('./pg-harness.cjs');

const chain = ['UPDATE_V220','UPDATE_SUPPORT_FORMS_20261107','UPDATE_DAMAGE_DEMAND_20261107','UPDATE_WORKSPACE_20261107','UPDATE_SECTIONS_V230','UPDATE_V240','UPDATE_V250','UPDATE_V251','UPDATE_V252','UPDATE_V253','UPDATE_V254','UPDATE_V255','UPDATE_V256','UPDATE_V257','UPDATE_V258','UPDATE_V259','UPDATE_V260','UPDATE_V261','UPDATE_V262'];
const migration = fs.readFileSync('supabase/UPDATE_V263.sql', 'utf8');

async function mockDrive() {
  const uploads = new Map();
  async function drive(path, init = {}) {
    if (path.includes('alt=media')) {
      const file = uploads.get(path.split('/').at(-1).split('?')[0]);
      if (!file) throw Error('Drive file missing');
      return new Response(file.bytes);
    }
    const boundary = init.headers['Content-Type'].split('boundary=')[1];
    const raw = Buffer.from(await new Response(init.body).arrayBuffer());
    const start = raw.indexOf('\r\n\r\n') + 4, mid = raw.indexOf('\r\n--' + boundary, start);
    const metadata = JSON.parse(raw.subarray(start, mid).toString());
    const dataStart = raw.indexOf('\r\n\r\n', mid) + 4, dataEnd = raw.lastIndexOf('\r\n--' + boundary + '--');
    const id = 'drive_file_' + uploads.size;
    uploads.set(id, {metadata, bytes: raw.subarray(dataStart, dataEnd)});
    return Response.json({id});
  }
  return {uploads, drive};
}

// The Edge Function exactly as it is pasted into the Supabase dashboard (ONE file)
async function singleFileHandler(h, mock) {
  const {bundle} = await import('../scripts/bundle-maintenance.mjs');
  const source = bundle().replace(/^import [^;]+;/gm, '');
  assert.ok(!/from '\.\.?\//.test(bundle()), 'no relative import is left');
  const env = {SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SECRET_KEYS: '{"default":"test-only"}',
    WLF_GOOGLE_CLIENT_ID: 'id', WLF_GOOGLE_CLIENT_SECRET: 'secret', WLF_GOOGLE_REFRESH_TOKEN: 'refresh'};
  let handler;
  const createClient = () => ({
    auth: {getUser: async token => ({data: {user: {id: token === 'admin' ? IDS.admin : IDS.sa}}})},
    from: () => ({select: () => ({eq: (_, id) => ({single: async () => ({data: {id, role: id === IDS.sa ? 'Super Admin' : 'Admin', status: 'Approved'}})})})}),
    rpc: async (name, p) => {
      try {
        assert.ok(['wlf_excel_admin', 'wlf_usage_admin', 'wlf_full_admin', 'wlf_backup_admin'].includes(name));
        return {data: (await h.db.query('select public.' + name + '($1,$2,$3) result', [p.action, p.actor, p.payload])).rows[0].result};
      } catch (error) { return {error}; }
    }
  });
  vm.runInNewContext(transformSync(source, {loader: 'ts', target: 'es2022'}).code, {
    Response, Request, crypto: globalThis.crypto, TextEncoder, TextDecoder, URL, URLSearchParams, Blob, btoa, atob, Uint8Array, console, createClient, JSZip: Zip,
    Deno: {serve: fn => { handler = fn; }, env: {get: key => env[key]}},
    fetch: async (url, init) => {
      if (url.includes('oauth2.googleapis.com')) return Response.json({access_token: 'test'});
      if (url.includes('q=')) return Response.json({files: [{id: 'test-folder'}]});
      return mock.drive(new URL(url).pathname + new URL(url).search, init);
    }
  });
  return (action, payload, token = 'sa') => handler(new Request('https://test.example', {
    method: 'POST', headers: {Authorization: 'Bearer ' + token}, body: JSON.stringify({action, payload})}));
}

async function setup(t) {
  const h = await makeDB();
  t.after(() => h.close());
  for (const file of chain) await h.db.exec(fs.readFileSync('supabase/' + file + '.sql', 'utf8'));
  await h.db.exec(migration);
  return h;
}
const sheetNames = async bytes => (await (await Zip.loadAsync(bytes)).file('xl/workbook.xml').async('string')).match(/<sheet name="[^"]+"/g).map(x => x.slice(13, -1));

test('Single-file Edge Function: Activity log goes to its own Drive file, is verified, and only then deleted', async t => {
  const h = await setup(t), mock = await mockDrive(), call = await singleFileHandler(h, mock);
  await h.db.query('delete from public.wlf_usage');
  await h.db.query("insert into public.wlf_usage(actor,action,details,at) select $1,'Login','row '||g, now()-interval '9 days' from generate_series(1,5) g", [IDS.sa]);
  await h.db.query("insert into public.wlf_usage(actor,action,details) values($1,'Login','fresh')", [IDS.sa]);
  const response = await call('usageArchive', {});
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.archived, 5);
  assert.equal(result.remaining, 0);
  assert.equal(Number((await h.db.query('select count(*) n from public.wlf_usage')).rows[0].n), 1);
  const files = [...mock.uploads.values()];
  assert.equal(files.length, 1);
  assert.match(files[0].metadata.name, /^WLF-Activity-Log-.*\.xlsx$/);
  assert.deepEqual(await sheetNames(files[0].bytes), ['Activity log']);
  assert.equal((await (await call('usageArchive', {})).json()).archived, 0, 'nothing left to archive');
  assert.equal((await (await call('usageHistory', {})).json()).length, 1);
  assert.equal((await call('usageArchive', {}, 'admin')).status, 403);
});

test('Single-file Edge Function: a Drive failure deletes nothing', async t => {
  const h = await setup(t), mock = await mockDrive(), call = await singleFileHandler(h, mock);
  await h.db.query('delete from public.wlf_usage');
  await h.db.query("insert into public.wlf_usage(actor,action,details,at) select $1,'Login','row '||g, now()-interval '9 days' from generate_series(1,3) g", [IDS.sa]);
  const original = mock.drive;
  mock.drive = async () => { throw Error('Google Drive request failed (500). Nothing was cleared.'); };
  const response = await call('usageArchive', {});
  assert.notEqual(response.status, 200);
  assert.equal(Number((await h.db.query('select count(*) n from public.wlf_usage')).rows[0].n), 3);
  mock.drive = original;
});

test('Single-file Edge Function: Backup saves a verified JSON in its own folder, downloads, restores and deletes history', async t => {
  const h = await setup(t), mock = await mockDrive(), call = await singleFileHandler(h, mock);
  const made = await (await call('fullBackup', {})).json();
  assert.match(made.name, /^WLF-Backup-.*\.json$/);
  assert.ok(made.counts['hardware-catalogue'] > 100);
  const bytes = Buffer.from(made.bytes, 'base64');
  assert.equal(JSON.parse(bytes.toString()).format, 'WLF-FULL-2.6.3');
  assert.equal([...mock.uploads.values()][0].bytes.length, bytes.length, 'the Drive copy is the same file');
  const history = await (await call('fullHistory', {})).json();
  assert.equal(history.length, 1);
  const again = await (await call('fullDownload', {id: made.id})).json();
  assert.equal(again.bytes, made.bytes);
  await h.db.query("delete from wlf_private.hw_suggest");
  const restore = await (await call('fullRestore', {id: made.id, confirmed: true})).json();
  assert.ok(restore.restored['hardware-suggest'] >= 1);
  assert.equal((await call('fullRestore', {id: made.id})).status, 400, 'restore needs confirmation');
  assert.equal((await (await call('fullDeleteHistory', {id: made.id})).json()).deleted, 1);
  assert.equal((await call('fullBackup', {}, 'admin')).status, 403);
});
