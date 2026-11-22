const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const {transformSync} = require('esbuild');
const Zip = require('jszip');
const {makeDB, IDS} = require('./pg-harness.cjs');

const chain = ['UPDATE_V220','UPDATE_SUPPORT_FORMS_20261107','UPDATE_DAMAGE_DEMAND_20261107','UPDATE_WORKSPACE_20261107','UPDATE_SECTIONS_V230','UPDATE_V240','UPDATE_V250','UPDATE_V251','UPDATE_V252','UPDATE_V253','UPDATE_V254','UPDATE_V255','UPDATE_V256','UPDATE_V257','UPDATE_V258','UPDATE_V259','UPDATE_V260','UPDATE_V261'];
const migration = fs.readFileSync('supabase/UPDATE_V262.sql', 'utf8');

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
        assert.equal(name, 'wlf_excel_admin');
        return {data: (await h.db.query('select public.wlf_excel_admin($1,$2,$3) result', [p.action, p.actor, p.payload])).rows[0].result};
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
const demand = (h, item, {received = true, claim = false, scReceived = false} = {}) => h.db.query(
  `insert into wlf_private.damage_demands(request_id,category,request_reference,requester_id,requester_name,requested_at,project,lift_id,controllers,problem_categories,form_schema,form_values,confirmed_by,confirmed_name,solution_statement,item_name,item_code,item_spec,quantity,create_operation,create_payload_hash,received_at,received_by,received_name,claim_at,claim_by,claim_name,claim_supplier,sc_received_at,sc_received_by,sc_received_name)
   values(gen_random_uuid(),'aftersales','R-1',$2,'u',now(),'P','1','{}','{}','{}','{}',$2,'rni','fixed',$1,'C-1','spec',2,gen_random_uuid(),'\\x00',
     ${received ? `now(),'${IDS.sa}','sa'` : 'null,null,null'},${claim ? `now(),'${IDS.sa}','sa','Sup A'` : 'null,null,null,null'},${scReceived ? `now(),'${IDS.sa}','sa'` : 'null,null,null'})`, [item, IDS.rni]);

test('Single-file Edge Function: Damage Demand and Supplier Claim backup, verified Clear, recovery and history delete', async t => {
  const h = await setup(t), mock = await mockDrive(), call = await singleFileHandler(h, mock);
  await demand(h, 'Door motor'); await demand(h, 'Cable', {claim: true, scReceived: true}); await demand(h, 'Waiting', {received: false});
  assert.equal((await call('excelBackup', {id: crypto.randomUUID(), kind: 'damage'}, 'admin')).status, 403);

  const id = crypto.randomUUID();
  const res = await call('excelBackup', {id, kind: 'damage', withClear: true});
  assert.equal(res.status, 200);
  const file = await res.json();
  assert.match(file.name, /^WLF-Damage-Demand-All-Dates-/);
  assert.deepEqual(await sheetNames(Buffer.from(file.bytes, 'base64')), ['Damage Demand']);
  const xml = await (await Zip.loadAsync(Buffer.from(file.bytes, 'base64'))).file('xl/worksheets/sheet1.xml').async('string');
  assert.match(xml, /Door motor/); assert.match(xml, /Waiting/); assert.match(xml, /Goods received/);
  assert.equal([...mock.uploads.values()].length, 2, 'workbook + recovery file are on Drive');
  assert.equal((await (await call('excelClear', {id, confirmed: true})).json()).cleared, 2);
  assert.equal((await h.db.query('select count(*)::int n from wlf_private.damage_demands')).rows[0].n, 1);
  assert.equal((await (await call('excelRestore', {id, confirmed: true})).json()).restored, 2);
  assert.equal((await h.db.query('select count(*)::int n from wlf_private.damage_demands')).rows[0].n, 3);

  const cid = crypto.randomUUID();
  const claim = await (await call('excelBackup', {id: cid, kind: 'claim', withClear: false})).json();
  assert.match(claim.name, /^WLF-Supplier-Claim-/);
  assert.deepEqual(await sheetNames(Buffer.from(claim.bytes, 'base64')), ['Supplier Claim']);
  assert.equal(claim.run.total, 1);
  assert.equal((await call('excelClear', {id: cid, confirmed: true})).status, 400, 'a backup made without Clear can never clear');

  const history = await (await call('excelHistory', {})).json();
  assert.equal(history.length, 2);
  assert.equal((await (await call('excelDeleteHistory', {id})).json()).deleted, 1);
  assert.equal((await call('excelDeleteHistory', {all: true, confirm: 'x'})).status, 400);
  assert.equal((await (await call('excelDeleteHistory', {all: true, confirm: 'DELETE'})).json()).deleted, 1);
  assert.equal((await call('excelDeleteHistory', {all: true, confirm: 'DELETE'}, 'admin')).status, 403);
  assert.equal((await (await call('excelHistory', {})).json()).length, 0);
});

test('Single-file Edge Function: R&I Project and QMS data workbooks', async t => {
  const h = await setup(t), mock = await mockDrive(), call = await singleFileHandler(h, mock);
  await h.db.query(`insert into public.wlf_ri_projects(id,owner,data,last_operation,last_payload_hash) values(gen_random_uuid(),$1,$2,gen_random_uuid(),'x')`,
    [IDS.sa, {name: 'Controller validation', status: 'Done', lead: 'x', brief: 'Brief & <more>', start: '2026-11-01', end: '2026-11-30',
      tasks: [{id: 't1', name: 'Verify wiring', owner: 'a@b.c', start: '2026-11-05', end: '2026-11-06', status: 'Done', progress: 100}]}]);
  await h.db.query("update public.wlf_profiles set permissions=array_cat(permissions,array['qms:components','qms:edit']) where id=$1", [IDS.rni]);
  const rows = (await h.rpc('sa', 'getCatalogue')).rows.filter(r => r.model === 'MOT 7.5 kW' && r.itemCode);
  await h.rpc('rni', 'saveQmsLift', [{id: crypto.randomUUID(), liftId: 'L-77', project: 'Eden Tower', address: 'Dhaka', deliveryDate: '2026-11-25', motorType: 'Gearless', liftType: 'Passenger',
    system: 'MOT', controllerModel: 'MOT 7.5 kW', serials: {motor: 'M-1', encoder: 'E', drive: 'D', ups: 'U', cartop: 'C', cop: 'P', copDisplay: 'X'}, selection: {inputs: {capacity: 1000}, categories: []}, items: rows.slice(0, 2).map((r, i) => ({catalogueId: r.id, section: 'control', serial: 'S' + i}))}]);

  const p = await (await call('excelBackup', {id: crypto.randomUUID(), kind: 'project', withClear: false})).json();
  assert.deepEqual(await sheetNames(Buffer.from(p.bytes, 'base64')), ['Projects', 'Tasks']);
  const pz = await Zip.loadAsync(Buffer.from(p.bytes, 'base64'));
  assert.match(await pz.file('xl/worksheets/sheet1.xml').async('string'), /Controller validation/);
  assert.match(await pz.file('xl/worksheets/sheet1.xml').async('string'), /Brief &amp; &lt;more&gt;/, 'text is escaped');
  assert.match(await pz.file('xl/worksheets/sheet2.xml').async('string'), /Verify wiring/);

  const q = await (await call('excelBackup', {id: crypto.randomUUID(), kind: 'qms', withClear: true})).json();
  assert.match(q.name, /^WLF-QMS-Data-/);
  assert.deepEqual(await sheetNames(Buffer.from(q.bytes, 'base64')), ['QMS Lifts', 'QMS Components', 'QMS Serial numbers']);
  const qz = await Zip.loadAsync(Buffer.from(q.bytes, 'base64'));
  const comp = await qz.file('xl/worksheets/sheet2.xml').async('string');
  assert.match(comp, /L-77/); assert.match(comp, new RegExp(rows[0].itemCode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(await qz.file('xl/worksheets/sheet3.xml').async('string'), /M-1/);
  assert.equal((await (await call('excelClear', {id: q.run.id, confirmed: true})).json()).cleared, 1);
  assert.equal((await h.rpc('rni', 'getQmsLifts', [{}])).rows.length, 0);
  assert.equal((await (await call('excelRestore', {id: q.run.id, confirmed: true})).json()).restored, 1);
  assert.equal((await h.rpc('rni', 'getQmsLifts', [{}])).rows.length, 1);
});

test('The ready-to-paste single file is up to date with the Edge Function sources', async () => {
  const {bundle} = await import('../scripts/bundle-maintenance.mjs');
  assert.equal(fs.readFileSync('supabase/functions/wlf-maintenance/index.single.ts', 'utf8'), bundle(),
    'run: node scripts/bundle-maintenance.mjs supabase/functions/wlf-maintenance/index.single.ts');
});
