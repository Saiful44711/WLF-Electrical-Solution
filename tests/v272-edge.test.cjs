const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {transformSync} = require('esbuild');
const Zip = require('jszip');
const {makeDB, IDS} = require('./pg-harness.cjs');

const chain = ['UPDATE_V220','UPDATE_SUPPORT_FORMS_20261107','UPDATE_DAMAGE_DEMAND_20261107','UPDATE_WORKSPACE_20261107','UPDATE_SECTIONS_V230','UPDATE_V240','UPDATE_V250','UPDATE_V251','UPDATE_V252','UPDATE_V253','UPDATE_V254','UPDATE_V255','UPDATE_V256','UPDATE_V257','UPDATE_V258','UPDATE_V259','UPDATE_V260','UPDATE_V261','UPDATE_V262','UPDATE_V263','UPDATE_V264','UPDATE_V265','UPDATE_V266','UPDATE_V267','UPDATE_V268','UPDATE_V270','UPDATE_V271','UPDATE_V272'];

/* a small Google Drive: folders found by their hidden mark, files uploaded and read back, PATCH moves and trashes */
function mockDrive() {
  const files = new Map(); let n = 0;
  async function call(url, init = {}) {
    const u = new URL(url), path = u.pathname, method = init.method || 'GET';
    if (path.endsWith('/token')) return Response.json({access_token: 'test'});
    if (method === 'GET' && u.searchParams.get('q')) {
      const q = u.searchParams.get('q'), m = /key='([^']+)' and value='([^']+)'/.exec(q);
      const hit = [...files.values()].filter(f => f.folder && !f.trashed && f.appProperties?.[m[1]] === m[2]);
      return Response.json({files: hit.slice(0, 1).map(f => ({id: f.id, parents: f.parents}))});
    }
    if (method === 'GET' && u.searchParams.get('alt') === 'media') return new Response(files.get(path.split('/').at(-1)).bytes);
    if (method === 'POST' && path === '/drive/v3/files') {
      const meta = JSON.parse(init.body), id = 'folder_' + (++n);
      files.set(id, {id, folder: true, name: meta.name, parents: meta.parents || ['root'], appProperties: meta.appProperties});
      return Response.json({id});
    }
    if (method === 'POST' && path.startsWith('/upload/')) {
      const boundary = init.headers['Content-Type'].split('boundary=')[1];
      const raw = Buffer.from(await new Response(init.body).arrayBuffer());
      const start = raw.indexOf('\r\n\r\n') + 4, mid = raw.indexOf('\r\n--' + boundary, start);
      const meta = JSON.parse(raw.subarray(start, mid).toString());
      const dataStart = raw.indexOf('\r\n\r\n', mid) + 4, dataEnd = raw.lastIndexOf('\r\n--' + boundary + '--');
      const id = 'file_' + (++n) + '_x';
      files.set(id, {id, name: meta.name, parents: meta.parents, bytes: raw.subarray(dataStart, dataEnd)});
      return Response.json({id});
    }
    if (method === 'PATCH') {
      const f = files.get(path.split('/').at(-1));
      const add = u.searchParams.get('addParents'), remove = u.searchParams.get('removeParents');
      if (add) f.parents = [...(f.parents || []).filter(p => !(remove || '').split(',').includes(p)), add];
      const body = init.body && init.body !== '{}' ? JSON.parse(init.body) : {};
      if (body.trashed) f.trashed = true;
      return Response.json({id: f.id});
    }
    throw Error('unexpected Drive call ' + method + ' ' + url);
  }
  return {files, call, byName: name => [...files.values()].find(f => f.name === name)};
}

async function handler(h, drive) {
  const {bundle} = await import('../scripts/bundle-maintenance.mjs');
  const code = bundle();
  assert.ok(!/[^\x00-\x7f]/.test(code), 'the pasted file is plain ASCII');
  const env = {SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SECRET_KEYS: '{"default":"test-only"}',
    WLF_GOOGLE_CLIENT_ID: 'id', WLF_GOOGLE_CLIENT_SECRET: 'secret', WLF_GOOGLE_REFRESH_TOKEN: 'refresh'};
  let serve;
  const createClient = () => ({
    auth: {getUser: async () => ({data: {user: {id: IDS.sa}}})},
    from: () => ({select: () => ({eq: (_, id) => ({single: async () => ({data: {id, role: 'Super Admin', status: 'Approved'}})})})}),
    rpc: async (name, p) => {
      try { return {data: (await h.db.query(`select public.${name}($1,$2,$3) result`, [p.action, p.actor, p.payload])).rows[0].result}; }
      catch (error) { return {error}; }
    }
  });
  vm.runInNewContext(transformSync(code.replace(/^import [^;]+;/gm, ''), {loader: 'ts', target: 'es2022'}).code, {
    Response, Request, crypto: globalThis.crypto, TextEncoder, TextDecoder, URL, URLSearchParams, Blob, btoa, atob, Uint8Array, console, createClient, JSZip: Zip,
    Deno: {serve: fn => { serve = fn; }, env: {get: key => env[key]}}, fetch: (url, init) => drive.call(url, init)
  });
  return (action, payload = {}, cron) => serve(new Request('https://test.example', {method: 'POST',
    headers: cron ? {'x-wlf-cron': cron} : {Authorization: 'Bearer sa'}, body: JSON.stringify({action, payload})})).then(r => r.json());
}
async function setup(t) {
  const h = await makeDB();
  t.after(() => h.close());
  for (const file of chain) await h.db.exec(fs.readFileSync('supabase/' + file + '.sql', 'utf8'));
  return h;
}

test('Edge Function reports its version for the System status card', async t => {
  const h = await setup(t), call = await handler(h, mockDrive());
  assert.deepEqual(await call('version'), {edge: '2.7.4', driveConfigured: true});
});

test('monthly Excel backup on the schedule: 3 files per call, folders Monthly Excel Backup / <category>, nothing cleared', async t => {
  const h = await setup(t), drive = mockDrive(), call = await handler(h, drive);
  const token = 'd'.repeat(48);
  await h.db.query('update wlf_private.report_settings set enabled=false, backup_enabled=true, token=$1, updated_by=$2 where id=1', [token, IDS.sa]);
  const first = await call('monthlyReports', {token}, token);
  assert.equal(first.made?.length, 3, JSON.stringify(first));
  const second = await call('monthlyReports', {token}, token);
  assert.equal(second.made.length, 3);
  assert.equal((await call('monthlyReports', {token}, token)).made.length, 0, 'nothing left for the month');
  const root = drive.byName('Monthly Excel Backup');
  assert.ok(root && root.parents[0] === 'root', 'one main folder');
  for (const sub of ['Technical Support', 'R&I Team Activity', 'R&I Project Manager', 'QMS Data', 'Damage Demand', 'Supplier Claim']) {
    const f = drive.byName(sub); assert.ok(f, sub); assert.deepEqual(f.parents, [root.id], sub + ' sits in the main folder');
  }
  const month = first.made[0].month;
  const support = drive.byName('Technical Support Backup ' + month + '.xlsx');
  assert.ok(support, 'file named by month'); assert.deepEqual(support.parents, [drive.byName('Technical Support').id]);
  const z = await Zip.loadAsync(support.bytes);
  assert.ok(z.file('xl/styles.xml') && z.file('xl/sharedStrings.xml'), 'styled workbook with shared strings');
  const hist = (await h.db.query("select public.wlf_report_admin('backupHistory',$1,'{}') r", [IDS.sa])).rows[0].r;
  assert.equal(hist.length, 6);
  assert.equal((await h.db.query('select count(*)::int n from wlf_private.excel_runs where with_clear')).rows[0].n, 0, 'the schedule never clears');
  // made again by hand: the older file goes to the Drive bin and the list keeps one row per month
  const again = await call('backupGenerate', {month, kinds: ['support']});
  assert.equal(again.made.length, 1, JSON.stringify(again));
  assert.equal(support.trashed, true);
  assert.equal((await h.db.query("select public.wlf_report_admin('backupHistory',$1,'{}') r", [IDS.sa])).rows[0].r.length, 6);
});

test('monthly reports go into Monthly Analysis Report; an old v2.7.0 report folder is moved there with its files', async t => {
  const h = await setup(t), drive = mockDrive(), call = await handler(h, drive);
  drive.files.set('old_folder', {id: 'old_folder', folder: true, name: 'Technical Support Monthly Report', parents: ['root'], appProperties: {wlfReportSupport: 'test'}});
  const made = await call('reportGenerate', {month: '2026-10', kinds: ['support', 'damage']});
  assert.equal(made.made.length, 2, JSON.stringify(made));
  const root = drive.byName('Monthly Analysis Report');
  assert.deepEqual(drive.files.get('old_folder').parents, [root.id], 'old folder moved, not duplicated');
  assert.deepEqual(drive.byName('Damage Demand Monthly Report').parents, [root.id]);
  const file = drive.byName('Technical Support Monthly Report 2026-10.xlsx');
  assert.deepEqual(file.parents, ['old_folder']);
  const sst = await (await Zip.loadAsync(file.bytes)).file('xl/sharedStrings.xml').async('string');
  assert.ok(sst.includes('Technical Support Monthly Report · October 2026'), 'spaces are kept');
});
