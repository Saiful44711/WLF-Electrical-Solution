/* v2.5.9: Hardware Catalogue, QMS lift records and the catalogue picker used by Raise Damage Demand. v2.6.0: motor-first QMS form with controller/AVR suggestions, serial table, prices. */
const WlfHardware = (() => {
  'use strict';

  const el = id => document.getElementById(id);
  const h = value => esc(String(value ?? ''));
  const CONTROL_SKIP = ['LOP', 'COP', 'Transom', 'COP Faceplate', 'Other components'];
  const QMS_SKIP = ['AVR', 'MOTCUBE'];            /* AVR is picked as an AVR size; MOTCUBE is no longer delivered, so it is not a QMS controller */
  const SYSTEM_ORDER = ['MOT', 'NICE3000+', 'MOTCUBE', 'AVR'];
  const MODEL_TAIL = ['COP', 'LOP', 'Transom', 'COP Faceplate', 'Other components'];   /* controller models first (small to big), then these */
  const sizeOf = text => { const m = String(text).match(/(\d+(?:\.\d+)?)\s*(?:kw|kva)\b/i); return m ? parseFloat(m[1]) : null; };
  const modelRank = m => { const i = MODEL_TAIL.indexOf(m); return i < 0 ? 0 : 100 + i; };
  const byModel = (a, b) => modelRank(a) - modelRank(b) || (sizeOf(a) ?? 1e9) - (sizeOf(b) ?? 1e9) || a.localeCompare(b, undefined, {numeric: true});
  const bySystem = (a, b) => { const x = SYSTEM_ORDER.indexOf(a), y = SYSTEM_ORDER.indexOf(b); return (x < 0 ? 99 : x) - (y < 0 ? 99 : y) || a.localeCompare(b); };
  const dateFormat = new Intl.DateTimeFormat('en-GB', {timeZone: 'Asia/Dhaka', day: 'numeric', month: 'short', year: 'numeric'});
  const clockFormat = new Intl.DateTimeFormat('en-GB', {timeZone: 'Asia/Dhaka', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'});
  const when = (v, clock) => v ? (clock ? clockFormat : dateFormat).format(new Date(v)) : '—';
  const money = v => v == null || v === '' ? '' : Number(v).toLocaleString('en-GB', {minimumFractionDigits: 2, maximumFractionDigits: 2});
  const label = r => r.itemName || r.hardware || '';
  const usable = r => !!(r.itemName || r.hardware);

  let CAT = {rows: [], map: [], canEdit: false, at: 0};
  let loading = null;
  let session = null;
  let selected = {system: '', model: ''};
  let catalogueRun = 0;
  let qmsRun = 0;

  /* ---------------------------------------------------------------- data */
  async function loadCatalogue(force) {
    if (SESSION !== session) { session = SESSION; CAT = {rows: [], map: [], canEdit: false, at: 0}; }
    if (!force && CAT.at && Date.now() - CAT.at < 60000) return CAT;
    if (loading) return loading;
    loading = rpc('getCatalogue', [T(), {}]).then(data => {
      CAT = {rows: data.rows, map: data.map, canEdit: data.canEdit, at: Date.now()};
      return CAT;
    }).finally(() => { loading = null; });
    return loading;
  }
  const systems = () => [...new Set(CAT.rows.map(r => r.system))].sort(bySystem);
  const modelsOf = system => [...new Set(CAT.rows.filter(r => r.system === system).map(r => r.model))].sort(byModel);
  const rowsOf = (system, model) => CAT.rows.filter(r => r.system === system && r.model === model);
  const byId = id => CAT.rows.find(r => r.id === id);
  const controlSystems = () => systems().filter(s => !QMS_SKIP.includes(s) && modelsOf(s).some(m => !CONTROL_SKIP.includes(m)));
  const controlModels = system => modelsOf(system).filter(m => !CONTROL_SKIP.includes(m));

  function dialog() {
    let node = el('hwDialog');
    if (!node) {
      document.body.insertAdjacentHTML('beforeend', '<dialog id="hwDialog" class="hw-dialog" aria-labelledby="hwDialogTitle"></dialog>');
      node = el('hwDialog');
    }
    return node;
  }
  function openDialog(title, body) {
    const node = dialog();
    node.innerHTML = `<h2 id="hwDialogTitle">${h(title)}</h2>${body}`;
    node.oncancel = () => {};
    if (!node.open) node.showModal();
    return node;
  }
  const closeDialog = () => { const n = el('hwDialog'); if (n && n.open) n.close(); };

  const optionList = (values, current, blank) =>
    (blank != null ? `<option value="">${h(blank)}</option>` : '') +
    values.map(v => `<option value="${h(v)}" ${String(v) === String(current ?? '') ? 'selected' : ''}>${h(v)}</option>`).join('');

  /* ---------------------------------------------------------------- Hardware Catalogue */
  function groupHtml() {
    const sys = systems();
    return sys.map(s => `<div class="hw-sys"><button type="button" class="hw-sys-btn ${selected.system === s ? 'open' : ''}" data-hw-system="${h(s)}">
        <b>${h(s)}</b><span class="hw-count">${modelsOf(s).length}</span></button>
      ${selected.system === s ? `<div class="hw-models">${modelsOf(s).map(m =>
        `<button type="button" class="hw-model ${selected.model === m ? 'on' : ''}" data-hw-model="${h(m)}">${h(m)}<small>${rowsOf(s, m).length}</small></button>`).join('')}</div>` : ''}</div>`).join('');
  }

  function catalogueTable(query) {
    const q = String(query || '').trim().toLowerCase();
    let rows = rowsOf(selected.system, selected.model);
    if (q) rows = rows.filter(r => [r.itemCode, r.itemName, r.hardware, r.spec, r.brand, r.grp].join(' ').toLowerCase().includes(q));
    if (!selected.model) return '<p class="note">Select a control system and a model on the left.</p>';
    if (!rows.length) return '<p class="note">No matching rows.</p>';
    return `<div class="tbl-wrap" tabindex="0"><table class="tbl hw-table"><thead><tr><th>#</th><th>Group</th><th>Hardware</th><th>Spec</th><th>Item code</th><th>Item name</th><th>Brand</th><th>Supplier</th><th>Price (৳)</th>${CAT.canEdit ? '<th></th>' : ''}</tr></thead><tbody>${
      rows.map((r, i) => `<tr class="${usable(r) ? '' : 'hw-blank'}"><td>${i + 1}</td><td>${h(r.grp)}</td><td>${h(r.hardware)}</td><td>${h(r.spec)}</td>
        <td>${r.itemCode ? h(r.itemCode) : (usable(r) ? '<span class="hw-nocode">no code</span>' : '…')}</td><td>${h(r.itemName)}</td><td>${h(r.brand)}</td><td>${h(r.supplier)}</td><td>${h(money(r.value))}</td>
        ${CAT.canEdit ? `<td class="hw-actions"><button type="button" class="btn ghost" data-hw-edit="${h(r.id)}">Edit</button><button type="button" class="btn ghost danger" data-hw-del="${h(r.id)}">Delete</button></td>` : ''}</tr>`).join('')}</tbody></table></div>`;
  }

  function paintCatalogue(message) {
    const root = el('tab-catalogue');
    if (!root) return;
    const q = el('hwSearch')?.value || '';
    const edit = CAT.canEdit;
    root.innerHTML = `<div class="card hw-card">
      <div class="hw-head"><div><div class="overview-eyebrow">ONE DATABASE FOR QMS + DAMAGE DEMAND</div><h3>Hardware Catalogue</h3></div>
        <div class="hw-toolbar">
          <button class="btn ghost" type="button" id="hwExport">Export Excel</button>
          ${edit ? '<button class="btn ghost" type="button" id="hwImport">Import CSV</button><button class="btn ghost" type="button" id="hwMap">Problem suggestions</button><button class="btn" type="button" id="hwNewModel">+ New component model</button>' : ''}
        </div></div>
      <div class="hw-layout"><nav class="hw-side" aria-label="Control systems and models">${groupHtml()}</nav>
        <div class="hw-main">
          <div class="hw-bar"><b>${selected.model ? h(selected.system) + ' › ' + h(selected.model) : 'Choose a model'}</b>
            <input id="hwSearch" type="search" placeholder="Search code / name…" value="${h(q)}" aria-label="Search the catalogue">
            ${edit && selected.model ? '<button class="btn ghost" type="button" id="hwAddRow">+ Add row</button><button class="btn ghost" type="button" id="hwRename">Rename model</button><button class="btn ghost danger" type="button" id="hwDelModel">Delete model</button>' : ''}</div>
          <div id="hwTable">${catalogueTable(q)}</div>
          <p class="note">Rows with a missing item code show an amber “no code”. Delete is not permanent for saved QMS records: they keep their own copy.${edit ? '' : ' You can view the catalogue; the Super Admin edits it.'}</p>
        </div></div>
      <p class="note overview-status" id="hwStatus" role="status">${h(message || '')}</p></div>`;
    bindCatalogue();
  }

  async function catalogueCall(action, payload, message) {
    const status = el('hwStatus');
    if (status) status.textContent = 'Saving…';
    try {
      const result = await rpc(action, [T(), payload]);
      await loadCatalogue(true);
      closeDialog();
      paintCatalogue(message || 'Saved.');
      return result;
    } catch (err) {
      const text = cleanError(err);
      const node = el('hwDialogStatus') || el('hwStatus');
      if (node) node.textContent = text;
      return null;
    }
  }

  function rowForm(row) {
    const systemsList = systems();
    return openDialog(row ? 'Edit row' : 'Add row', `<form id="hwRowForm" class="hw-form">
      <label>Control system *<input name="system" list="hwSystems" required maxlength="60" value="${h(row?.system ?? selected.system)}"></label>
      <label>Model *<input name="model" required maxlength="80" value="${h(row?.model ?? selected.model)}"></label>
      <label>Hardware group<input name="grp" maxlength="80" value="${h(row?.grp)}" placeholder="Drive, Contactor…"></label>
      <label>Hardware name<input name="hardware" maxlength="160" value="${h(row?.hardware)}"></label>
      <label>Spec<input name="spec" maxlength="240" value="${h(row?.spec)}"></label>
      <label>Item code<input name="itemCode" maxlength="60" value="${h(row?.itemCode)}"></label>
      <label class="hw-wide">Item name<input name="itemName" maxlength="240" value="${h(row?.itemName)}"></label>
      <label>Brand<input name="brand" maxlength="80" value="${h(row?.brand)}"></label>
      <label>Supplier<input name="supplier" maxlength="80" value="${h(row?.supplier)}"></label>
      <label>Price (৳)<input name="value" inputmode="decimal" maxlength="16" value="${h(row?.value ?? '')}"></label>
      <datalist id="hwSystems">${systemsList.map(s => `<option value="${h(s)}">`).join('')}</datalist>
      <p class="note overview-status hw-wide" id="hwDialogStatus" role="status"></p>
      <div class="overview-actions hw-wide"><button class="btn" type="submit">Save row</button><button class="btn ghost" type="button" id="hwCancel">Cancel</button></div></form>`);
  }

  function bindCatalogue() {
    const root = el('tab-catalogue');
    root.querySelectorAll('[data-hw-system]').forEach(b => b.onclick = () => {
      selected = {system: b.dataset.hwSystem, model: ''};
      paintCatalogue();
    });
    root.querySelectorAll('[data-hw-model]').forEach(b => b.onclick = () => {
      selected.model = b.dataset.hwModel;
      paintCatalogue();
    });
    el('hwSearch').oninput = event => { el('hwTable').innerHTML = catalogueTable(event.target.value); bindRows(); };
    bindRows();
    el('hwExport').onclick = exportCatalogue;
    if (!CAT.canEdit) return;
    el('hwNewModel').onclick = newModel;
    el('hwImport').onclick = importCsv;
    el('hwMap').onclick = editMap;
    if (el('hwAddRow')) el('hwAddRow').onclick = () => {
      rowForm(null);
      el('hwCancel').onclick = closeDialog;
      el('hwRowForm').onsubmit = async event => {
        event.preventDefault();
        await catalogueCall('saveCatalogueRow', Object.fromEntries(new FormData(event.currentTarget)), 'Row added.');
      };
    };
    if (el('hwRename')) el('hwRename').onclick = () => {
      openDialog('Rename model', `<form id="hwRenameForm" class="hw-form"><label class="hw-wide">New name for ${h(selected.model)}<input name="to" required maxlength="80" value="${h(selected.model)}"></label>
        <p class="note overview-status hw-wide" id="hwDialogStatus" role="status"></p>
        <div class="overview-actions hw-wide"><button class="btn" type="submit">Rename</button><button class="btn ghost" type="button" id="hwCancel">Cancel</button></div></form>`);
      el('hwCancel').onclick = closeDialog;
      el('hwRenameForm').onsubmit = async event => {
        event.preventDefault();
        const to = new FormData(event.currentTarget).get('to');
        if (await catalogueCall('renameCatalogueModel', {system: selected.system, from: selected.model, to}, 'Model renamed.')) { selected.model = to; paintCatalogue('Model renamed.'); }
      };
    };
    if (el('hwDelModel')) el('hwDelModel').onclick = () => {
      openDialog('Delete model', `<p>Delete <b>${h(selected.system)} › ${h(selected.model)}</b> and its ${rowsOf(selected.system, selected.model).length} rows from the catalogue? Saved QMS records keep their own copy.</p>
        <p class="note overview-status" id="hwDialogStatus" role="status"></p>
        <div class="overview-actions"><button class="btn danger" type="button" id="hwConfirm">Delete model</button><button class="btn ghost" type="button" id="hwCancel">Cancel</button></div>`);
      el('hwCancel').onclick = closeDialog;
      el('hwConfirm').onclick = async () => {
        if (await catalogueCall('deleteCatalogueModel', {system: selected.system, model: selected.model}, 'Model deleted.')) { selected.model = ''; paintCatalogue('Model deleted.'); }
      };
    };
  }

  function bindRows() {
    const root = el('hwTable');
    if (!root || !CAT.canEdit) return;
    root.querySelectorAll('[data-hw-edit]').forEach(b => b.onclick = () => {
      const row = byId(b.dataset.hwEdit);
      rowForm(row);
      el('hwCancel').onclick = closeDialog;
      el('hwRowForm').onsubmit = async event => {
        event.preventDefault();
        await catalogueCall('saveCatalogueRow', {...Object.fromEntries(new FormData(event.currentTarget)), id: row.id, revision: row.revision}, 'Row saved.');
      };
    });
    root.querySelectorAll('[data-hw-del]').forEach(b => b.onclick = async () => {
      const row = byId(b.dataset.hwDel);
      openDialog('Delete row', `<p>Delete this row (${h(row.itemCode || row.hardware || 'empty row')})?</p>
        <p class="note overview-status" id="hwDialogStatus" role="status"></p>
        <div class="overview-actions"><button class="btn danger" type="button" id="hwConfirm">Delete</button><button class="btn ghost" type="button" id="hwCancel">Cancel</button></div>`);
      el('hwCancel').onclick = closeDialog;
      el('hwConfirm').onclick = () => catalogueCall('deleteCatalogueRow', {id: row.id}, 'Row deleted.');
    });
  }

  function newModel() {
    openDialog('New component model', `<form id="hwModelForm" class="hw-form">
      <label>Control system *<input name="system" list="hwSystems" required maxlength="60" value="${h(selected.system)}" placeholder="MOT, NICE3000+, AVR…"></label>
      <label>New model name *<input name="model" required maxlength="80" placeholder="e.g. MOT 45 kW or AVR 150 KVA"></label>
      <label class="hw-wide">Copy all rows from (optional)<select name="copyFrom"><option value="">Start with 6 blank rows</option>${
        CAT.rows.length ? [...new Set(CAT.rows.map(r => r.system + '\u0001' + r.model))].map(k => { const [s, m] = k.split('\u0001'); return `<option value="${h(s)}\u0001${h(m)}">${h(s)} › ${h(m)}</option>`; }).join('') : ''}</select></label>
      <datalist id="hwSystems">${systems().map(s => `<option value="${h(s)}">`).join('')}</datalist>
      <p class="note overview-status hw-wide" id="hwDialogStatus" role="status"></p>
      <div class="overview-actions hw-wide"><button class="btn" type="submit">Create model</button><button class="btn ghost" type="button" id="hwCancel">Cancel</button></div></form>`);
    el('hwCancel').onclick = closeDialog;
    el('hwModelForm').onsubmit = async event => {
      event.preventDefault();
      const f = Object.fromEntries(new FormData(event.currentTarget));
      let copyFrom = '';
      if (f.copyFrom) {
        const [fromSystem, fromModel] = f.copyFrom.split('\u0001');
        copyFrom = fromModel;
        if (fromSystem !== f.system.trim()) {
          el('hwDialogStatus').textContent = 'Copy only from a model of the same control system.';
          return;
        }
      }
      if (await catalogueCall('newCatalogueModel', {system: f.system, model: f.model, copyFrom}, 'Model created.')) {
        selected = {system: f.system.trim(), model: f.model.trim()};
        paintCatalogue('Model created. Fill in the rows.');
      }
    };
  }

  function csvParse(text) {
    const rows = [];
    let row = [], cell = '', quoted = false;
    const delim = text.split('\n', 1)[0].includes('\t') ? '\t' : ',';
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
      } else if (c === '"') quoted = true;
      else if (c === delim) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(r => r.some(x => String(x).trim()));
  }

  const CSV_HEAD = ['Control system', 'Model', 'Group', 'Hardware', 'Spec', 'Item code', 'Item name', 'Brand', 'Supplier', 'Price'];
  function importCsv() {
    openDialog('Import rows from CSV', `<form id="hwImportForm" class="hw-form">
      <p class="note hw-wide">Excel: File › Save as › CSV. First row must be the headers: ${h(CSV_HEAD.join(', '))}. Rows are added to the catalogue (existing rows are not changed).</p>
      <label class="hw-wide">CSV file<input type="file" name="file" accept=".csv,.tsv,.txt" required></label>
      <p class="note overview-status hw-wide" id="hwDialogStatus" role="status"></p>
      <div class="overview-actions hw-wide"><button class="btn" type="submit">Import</button><button class="btn ghost" type="button" id="hwCancel">Cancel</button></div></form>`);
    el('hwCancel').onclick = closeDialog;
    el('hwImportForm').onsubmit = async event => {
      event.preventDefault();
      const file = event.currentTarget.file.files[0];
      const status = el('hwDialogStatus');
      try {
        const rows = csvParse((await file.text()).replace(/^﻿/, ''));
        const head = rows.shift().map(x => String(x).trim().toLowerCase());
        const idx = name => head.indexOf(name.toLowerCase());
        if (idx('Control system') < 0 || idx('Model') < 0) throw new Error('The first row must contain “Control system” and “Model” columns.');
        const get = (r, name) => idx(name) < 0 ? '' : String(r[idx(name)] ?? '').trim();
        const payload = rows.map(r => ({system: get(r, 'Control system'), model: get(r, 'Model'), grp: get(r, 'Group'), hardware: get(r, 'Hardware'),
          spec: get(r, 'Spec'), itemCode: get(r, 'Item code'), itemName: get(r, 'Item name'), brand: get(r, 'Brand'), supplier: get(r, 'Supplier'), value: get(r, 'Price') || get(r, 'Value')}));
        if (!payload.length) throw new Error('The file has no data rows.');
        status.textContent = 'Importing ' + payload.length + ' rows…';
        const result = await catalogueCall('importCatalogue', {rows: payload}, 'Imported ' + payload.length + ' rows.');
        if (!result && el('hwDialogStatus')) return;
      } catch (err) { status.textContent = cleanError(err); }
    };
  }

  async function exportCatalogue() {
    const status = el('hwStatus');
    try {
      status.textContent = 'Preparing Excel…';
      await WlfExports.excel([{name: 'Hardware Catalogue', headers: CSV_HEAD,
        rows: CAT.rows.map(r => [r.system, r.model, r.grp, r.hardware, r.spec, r.itemCode, r.itemName, r.brand, r.supplier, r.value ?? ''])}], 'Hardware-Catalogue');
      status.textContent = 'Excel downloaded.';
    } catch (err) { status.textContent = cleanError(err); }
  }

  function editMap() {
    const rows = CAT.map.map(m => `<tr><td><input data-map-key value="${h(m.keyword)}" maxlength="60"></td><td><input data-map-groups value="${h(m.groups.join(', '))}"></td></tr>`).join('');
    openDialog('Problem suggestions', `<p class="note">When a Problem Category contains the word on the left, Raise Damage Demand suggests the hardware groups on the right (comma separated, e.g. Drive, Contactor). Leave the word empty to remove a line.</p>
      <form id="hwMapForm"><div class="tbl-wrap"><table class="tbl hw-table"><thead><tr><th>Word in the problem</th><th>Suggest hardware groups</th></tr></thead><tbody id="hwMapRows">${rows}</tbody></table></div>
      <button class="btn ghost" type="button" id="hwMapAdd">+ Add line</button>
      <p class="note overview-status" id="hwDialogStatus" role="status"></p>
      <div class="overview-actions"><button class="btn" type="submit">Save suggestions</button><button class="btn ghost" type="button" id="hwCancel">Cancel</button></div></form>`);
    el('hwCancel').onclick = closeDialog;
    el('hwMapAdd').onclick = () => el('hwMapRows').insertAdjacentHTML('beforeend', '<tr><td><input data-map-key maxlength="60"></td><td><input data-map-groups></td></tr>');
    el('hwMapForm').onsubmit = async event => {
      event.preventDefault();
      const payload = [...el('hwMapRows').querySelectorAll('tr')].map(tr => ({
        keyword: tr.querySelector('[data-map-key]').value.trim(),
        groups: tr.querySelector('[data-map-groups]').value.split(',').map(x => x.trim()).filter(Boolean)})).filter(x => x.keyword);
      await catalogueCall('saveCatalogueMap', {rows: payload}, 'Suggestions saved.');
    };
  }

  async function openCatalogue() {
    const root = el('tab-catalogue');
    const run = ++catalogueRun;
    root.innerHTML = '<div class="card"><p class="note">Loading the catalogue…</p></div>';
    try {
      await loadCatalogue(true);
      if (run !== catalogueRun) return;
      if (!selected.system || !systems().includes(selected.system)) selected = {system: systems()[0] || '', model: ''};
      paintCatalogue();
    } catch (err) {
      if (run === catalogueRun) root.innerHTML = `<div class="card"><p class="note">${h(cleanError(err))}</p></div>`;
    }
  }

  /* ---------------------------------------------------------------- QMS */
  const SECTION_NAMES = {control: 'Control system', lop: 'LOP', cop: 'COP', faceplate: 'COP faceplate', transom: 'Transom', cable: 'Travelling cable', other: 'Other components', avr: 'AVR'};
  const SERIALS = [['motor', 'Motor SL'], ['encoder', 'Encoder SL'], ['drive', 'Drive SL'], ['ups', 'UPS SL'], ['cartop', 'Cartop PCB SL'], ['cop', 'COP PCB SL'], ['copDisplay', 'COP Display SL']];
  let draft = null;

  function pieces(system) {
    const of = (model, grp) => rowsOf(system, model).filter(r => usable(r) && (!grp || r.grp === grp));
    const others = of('Other components');
    return {
      lop: of('LOP'), cop: [...of('COP', 'COP Display'), ...of('COP', 'COP Button')], faceplate: of('COP Faceplate'),
      transom: of('Transom'), cable: others.filter(r => /travel/i.test(r.hardware)), other: others.filter(r => !/travel/i.test(r.hardware)),
    };
  }
  const optionLabel = r => [label(r), r.itemCode ? '· ' + r.itemCode : '· no code', r.spec ? '· ' + r.spec : ''].join(' ');

  function newDraft() { return {id: crypto.randomUUID(), revision: 0, liftId: '', project: '', address: '', deliveryDate: '', motorType: 'Gearless', liftType: 'Passenger',
    system: '', controllerModel: '', serials: {}, selection: null, parts: [], pick: {}}; }

  function draftFromRecord(rec) {
    const d = {...newDraft(), id: rec.id, revision: rec.revision, liftId: rec.liftId, project: rec.project, address: rec.address || '', deliveryDate: rec.deliveryDate || '',
      motorType: rec.motorType || 'Gearless', liftType: rec.liftType || 'Passenger', system: rec.system, controllerModel: rec.controllerModel,
      serials: rec.serials || {}, selection: rec.selection || null, parts: rec.parts || [], pick: {}};
    return d;
  }

  const savedPart = (section, hardware) => draft.parts.find(p => p.section === section && (hardware == null || p.hardware === hardware));

  function selectHtml(name, rows, chosenId, required) {
    const seen = new Set(rows.map(r => r.id));
    const extra = chosenId && !seen.has(chosenId) ? draft.parts.find(p => p.catalogueId === chosenId) : null;
    return `<select name="${h(name)}" ${required ? 'required' : ''}><option value="">${required ? 'Select…' : '— none —'}</option>${
      extra ? `<option value="${h(extra.catalogueId)}" selected>${h((extra.name || extra.hardware) + ' · ' + (extra.code || 'no code'))} (saved)</option>` : ''}${
      rows.map(r => `<option value="${h(r.id)}" ${r.id === chosenId ? 'selected' : ''}>${h(optionLabel(r))}</option>`).join('')}</select>`;
  }

  function controlBlock() {
    if (!draft.system || !draft.controllerModel) return '<p class="note">Pick a suggested controller above, or choose the control system and controller model.</p>';
    const rows = rowsOf(draft.system, draft.controllerModel).filter(usable);
    const groups = [];
    rows.forEach(r => { let g = groups.find(x => x.hardware === r.hardware); if (!g) groups.push(g = {hardware: r.hardware, rows: []}); g.rows.push(r); });
    const auto = groups.filter(g => g.rows.length === 1).length;
    const choices = groups.filter(g => g.rows.length > 1);
    return `<p class="note hw-auto"><b>${h(draft.controllerModel)}</b>: ${auto} items are added automatically (see them in QMS Data).</p>${choices.length ? `<div class="hw-grid">${choices.map(g => {
      const saved = savedPart('control', g.hardware);
      const chosen = draft.pick['control:' + g.hardware] || saved?.catalogueId || '';
      return `<label>${h(g.hardware)} *${selectHtml('control:' + g.hardware, g.rows, chosen, true).replace('<select ', '<select data-control-pick ')}</label>`;
    }).join('')}</div>` : ''}`;
  }

  /* Controller and AVR suggestions come from the motor chosen above (Component Selection data). */
  function suggestions() {
    const cats = draft.selection?.categories || [];
    const value = (title, start) => { const it = (cats.find(c => title.test(c.title))?.items || []).find(x => x.label.startsWith(start)); const v = String(it?.value ?? '').trim(); return v && v !== '-' ? v : ''; };
    const size = v => { const n = parseFloat(v); return Number.isFinite(n) ? String(n) : ''; };
    const sdb = value(/Power Supply/i, 'SDB');
    return {mot: size(value(/MOT Control/i, 'Controller Power')), nice: size(value(/NICE3000/i, 'Controller Power')), avr: size(value(/Power Supply/i, 'Recommended AVR')),
      sdb: sdb && /^[\d.]+$/.test(sdb) ? sdb + ' A' : sdb};
  }
  const sdbOf = sel => { const it = (sel?.categories || []).flatMap(c => c.items || []).find(x => /^SDB/i.test(x.label)); const v = String(it?.value ?? '').trim(); return v && v !== '-' ? (/^[\d.]+$/.test(v) ? v + ' A' : v) : ''; };
  function suggestHtml() {
    if (!draft.selection) return '<p class="note">Select a motor to get the controller and AVR suggestions.</p>';
    const s = suggestions();
    const ctrl = (system, size) => {
      if (!size) return `<span class="note">No ${h(system)} controller is listed for this motor.</span>`;
      const model = system + ' ' + size + ' kW';
      return modelsOf(system).includes(model)
        ? `<button type="button" class="chip hw-chip ${draft.system === system && draft.controllerModel === model ? 'on' : ''}" data-suggest-ctrl="${h(system)}" data-model="${h(model)}">${h(model)}</button>`
        : `<span class="note">${h(model)} is not in the catalogue yet.</span>`;
    };
    const avrModel = s.avr ? 'AVR ' + s.avr + ' KVA' : '';
    const avr = !avrModel ? '<span class="note">No AVR is listed for this motor.</span>'
      : modelsOf('AVR').includes(avrModel) ? `<button type="button" class="chip hw-chip ${draft.pick.avrModel === avrModel ? 'on' : ''}" data-suggest-avr="${h(avrModel)}">${h(avrModel)}</button>`
      : `<span class="note">${h(avrModel)} is not in the catalogue yet.</span>`;
    return `<div class="hw-suggest-box"><div class="overview-eyebrow">SUGGESTED CONTROLLERS (CHOOSE ONE TO FILL THE CONTROL SYSTEM)</div><div class="hw-chips">${ctrl('MOT', s.mot)}${ctrl('NICE3000+', s.nice)}</div>
      <div class="overview-eyebrow">SUGGESTED AVR</div><div class="hw-chips">${avr}</div>
      ${s.sdb ? `<p class="note">SDB main breaker <b>${h(s.sdb)}</b> is recorded with the lift from Component Selection.</p>` : ''}</div>`;
  }

  function motorBlock() {
    const motor = draft.selection?.categories?.[0];
    const index = typeof INDEX !== 'undefined' ? INDEX : [];
    const have = index.length > 0;
    const uniqSorted = (key, numeric) => [...new Set(index.map(r => r[key]))].sort(numeric ? (a, b) => a - b : undefined);
    const i = draft.selection?.inputs || {};
    return `<div class="hw-grid hw-motor">
      <label>Capacity (kg)<select name="m-c">${optionList(uniqSorted('c', true), i.capacity, 'Any')}</select></label>
      <label>Speed (m/s)<select name="m-s">${optionList(uniqSorted('s', true), i.speed, 'Any')}</select></label>
      <label>Usage type<select name="m-u">${optionList(uniqSorted('u'), i.usageType, 'Any')}</select></label>
      <label>Roping<select name="m-p">${optionList(uniqSorted('p'), i.roping, 'Any')}</select></label>
      <label>Motor brand<select name="m-b"><option value="">Any</option></select></label>
      <label>Motor model<select name="m-m"><option value="">Any</option></select></label></div>
      <div class="hw-motor-actions"><button type="button" class="btn ghost" id="hwMotorSearch" ${have ? '' : 'disabled'}>Search motors</button>
        <button type="button" class="btn ghost" id="hwMotorClear" ${draft.selection ? '' : 'hidden'}>Clear motor</button>
        <span class="note" id="hwMotorNote">${have ? '' : 'The motor list needs Component Selection access. Open Component Selection once, then come back.'}</span></div>
      <div id="hwMotorMatches" class="chips"></div>
      <div id="hwMotorResult">${motor ? motorTables(draft.selection) : '<p class="note">No motor selected yet.</p>'}</div>`;
  }
  const motorTables = sel => (sel.categories || []).map(c => `<div class="hw-sub"><div class="overview-eyebrow">${h(c.title)}</div><table class="tbl hw-table"><tbody>${
    c.items.map(it => `<tr><td class="hw-k">${h(it.label)}</td><td>${h(it.value)}</td></tr>`).join('')}</tbody></table></div>`).join('');

  function qmsForm(record) {
    const d = draft;
    const sys = controlSystems();
    const p = pieces(d.system);
    const avrSizes = modelsOf('AVR');
    const savedAvr = savedPart('avr');
    const avrModel = d.pick.avrModel ?? savedAvr?.model ?? '';
    const avrRows = avrModel ? rowsOf('AVR', avrModel).filter(usable) : [];
    const sec = (title, body) => `<fieldset class="hw-sec"><legend>${title}</legend>${body}</fieldset>`;
    const pickOf = (section, nth) => (d.parts.filter(x => x.section === section)[nth || 0] || {}).catalogueId || '';
    const field = (name, text, rows, section, nth) => `<label>${text}${selectHtml(name, rows, d.pick[name] ?? pickOf(section, nth), false)}</label>`;
    const copRows = p.cop;
    const copDisplays = copRows.filter(r => r.grp === 'COP Display'), copButtons = copRows.filter(r => r.grp === 'COP Button');
    const otherChecked = new Set(d.pickOther ?? d.parts.filter(x => x.section === 'other').map(x => x.catalogueId));
    return `<form id="qmsLiftForm" class="hw-qms" novalidate>
      ${sec('1 · Project information', `<div class="hw-grid">
        <label>Lift ID *<input name="liftId" required maxlength="80" value="${h(d.liftId)}" ${record && !record.canEdit ? 'readonly' : ''}></label>
        <label>Project name *<input name="project" required maxlength="180" value="${h(d.project)}"></label>
        <label>Address<input name="address" maxlength="240" value="${h(d.address)}"></label>
        <label>Delivery date *<input type="date" name="deliveryDate" required value="${h(d.deliveryDate)}"></label>
        <label>Motor type<select name="motorType">${optionList(['Gearless', 'Gear'], d.motorType)}</select></label>
        <label>Lift type<select name="liftType">${optionList(['Passenger', 'Cargo'], d.liftType)}</select></label></div>`)}
      ${sec('2 · Motor selection (same inputs as Component Selection)', motorBlock() + '<div id="hwSuggest">' + suggestHtml() + '</div>')}
      ${sec('3 · Control system and serial numbers', `<div class="hw-grid">
        <label>Control system *<select name="system" required>${optionList(sys, d.system, 'Select…')}</select></label>
        <label>Controller model *<select name="controllerModel" required>${optionList(d.system ? controlModels(d.system) : [], d.controllerModel, 'Select…')}</select></label></div>
        ${controlBlock()}
        <div class="hw-grid hw-serials">${SERIALS.map(([k, t]) => `<label>${t} *<input name="sl-${k}" required maxlength="80" value="${h(d.serials[k])}"></label>`).join('')}</div>`)}
      ${sec('4 · LOP · COP · Transom · Travelling cable', `<div class="hw-grid">
        ${field('lop', 'LOP model', p.lop, 'lop')}${field('cop0', 'COP display', copDisplays, 'cop', 0)}${field('cop1', 'COP button', copButtons, 'cop', 1)}
        ${field('faceplate', 'COP faceplate', p.faceplate, 'faceplate')}${field('transom', 'Transom display', p.transom, 'transom')}${field('cable', 'Travelling cable', p.cable, 'cable')}</div>`)}
      ${sec('5 · Other components (including AVR)', `<div class="hw-grid">
        <label>AVR size<select name="avrModel">${optionList(avrSizes, avrModel, '— none —')}</select></label>
        <label>AVR item<select name="avr"><option value="">— none —</option>${avrRows.map(r => `<option value="${h(r.id)}" ${(d.pick.avr ?? savedAvr?.catalogueId) === r.id ? 'selected' : ''}>${h(optionLabel(r))}</option>`).join('')}</select></label></div>
        ${avrModel && !avrRows.length ? '<p class="note">This AVR size has no items yet. The Super Admin fills them in the Hardware Catalogue.</p>' : ''}
        <div class="hw-checks">${p.other.map(r => `<label class="hw-check"><input type="checkbox" name="other" value="${h(r.id)}" ${otherChecked.has(r.id) ? 'checked' : ''}> ${h(optionLabel(r))}${r.supplier ? ' <small>' + h(r.supplier) + '</small>' : ''}</label>`).join('') || '<p class="note">No other components for this control system.</p>'}</div>`)}
      <p class="note overview-status" id="qmsLiftStatus" role="status"></p>
      <div class="overview-actions"><button class="btn" type="submit">${record ? 'Save changes' : 'Save lift record'}</button>
        ${record ? '<button class="btn ghost" type="button" id="qmsLiftCancel">Cancel</button>' : '<button class="btn ghost" type="reset" id="qmsLiftReset">Clear form</button>'}</div></form>`;
  }

  function readDraft() {
    const f = el('qmsLiftForm');
    if (!f) return;
    const v = name => (f.elements[name]?.value ?? '').trim();
    Object.assign(draft, {liftId: v('liftId'), project: v('project'), address: v('address'), deliveryDate: v('deliveryDate'),
      motorType: v('motorType'), liftType: v('liftType'), system: v('system'), controllerModel: v('controllerModel')});
    draft.serials = Object.fromEntries(SERIALS.map(([k]) => [k, v('sl-' + k)]).filter(x => x[1]));
    f.querySelectorAll('select[name^="control:"]').forEach(s => { draft.pick[s.name] = s.value; });
    for (const k of ['lop', 'cop0', 'cop1', 'faceplate', 'transom', 'cable', 'avr']) if (f.elements[k]) draft.pick[k] = f.elements[k].value;
    draft.pick.avrModel = v('avrModel');
    draft.pickOther = [...f.querySelectorAll('input[name=other]:checked')].map(x => x.value);
  }

  function buildItems() {
    const items = [];
    const rows = rowsOf(draft.system, draft.controllerModel).filter(usable);
    const seen = new Set();
    for (const r of rows) {
      if (seen.has(r.hardware)) continue;
      seen.add(r.hardware);
      const group = rows.filter(x => x.hardware === r.hardware);
      const id = group.length === 1 ? group[0].id : draft.pick['control:' + r.hardware];
      if (!id) throw new Error('Select the item for “' + r.hardware + '”.');
      items.push({catalogueId: id, section: 'control'});
    }
    const add = (key, section) => { if (draft.pick[key]) items.push({catalogueId: draft.pick[key], section}); };
    add('lop', 'lop'); add('cop0', 'cop'); add('cop1', 'cop'); add('faceplate', 'faceplate'); add('transom', 'transom'); add('cable', 'cable');
    if (draft.pick.avrModel) {
      const all = rowsOf('AVR', draft.pick.avrModel), use = all.filter(usable);
      if (draft.pick.avr) items.push({catalogueId: draft.pick.avr, section: 'avr'});
      else if (use.length) throw new Error('Select the AVR item for ' + draft.pick.avrModel + ', or set the AVR size to none.');
      else if (all[0]) items.push({catalogueId: all[0].id, section: 'avr'});   /* size not filled in the catalogue yet: the size is recorded */
    }
    for (const id of draft.pickOther || []) items.push({catalogueId: id, section: 'other'});
    return items;
  }

  function bindQmsForm(record, back) {
    const f = el('qmsLiftForm');
    const repaint = keep => { if (!keep) readDraft(); el('qmsPanel').innerHTML = qmsForm(record); bindQmsForm(record, back); };
    f.elements.system.onchange = () => { readDraft(); draft.controllerModel = ''; draft.pick = {}; draft.pickOther = []; draft.parts = []; repaint(); };
    f.elements.controllerModel.onchange = () => { readDraft(); for (const k of Object.keys(draft.pick)) if (k.startsWith('control:')) delete draft.pick[k]; draft.parts = draft.parts.filter(x => x.section !== 'control'); repaint(); };
    f.elements.avrModel.onchange = () => { readDraft(); setAvr(draft.pick.avrModel); repaint(true); };
    bindSuggest(f, repaint);
    f.querySelectorAll('[data-control-pick]').forEach(s => s.onchange = () => { readDraft(); repaint(); });
    bindMotor(f, () => { el('hwSuggest').innerHTML = suggestHtml(); bindSuggest(f, repaint); });
    if (el('qmsLiftCancel')) el('qmsLiftCancel').onclick = back;
    f.onsubmit = async event => {
      event.preventDefault();
      readDraft();
      const status = el('qmsLiftStatus');
      const button = f.querySelector('[type=submit]');
      try {
        for (const [k, t] of [['liftId', 'Lift ID'], ['project', 'Project name'], ['deliveryDate', 'Delivery date'], ['system', 'Control system'], ['controllerModel', 'Controller model']])
          if (!draft[k]) throw new Error('Enter or select: ' + t + '.');
        for (const [k, t] of SERIALS) if (!draft.serials[k]) throw new Error('Enter the ' + t + '. Every serial number is required.');
        const items = buildItems();
        button.disabled = true;
        status.textContent = 'Saving…';
        const saved = await rpc('saveQmsLift', [T(), {id: draft.id, revision: draft.revision, liftId: draft.liftId, project: draft.project, address: draft.address,
          deliveryDate: draft.deliveryDate, motorType: draft.motorType, liftType: draft.liftType, system: draft.system, controllerModel: draft.controllerModel,
          serials: draft.serials, selection: draft.selection, items}]);
        if (record) { showLift(saved, 'Changes saved.'); return; }
        draft = newDraft();
        el('qmsPanel').innerHTML = qmsForm(null);
        bindQmsForm(null);
        el('qmsLiftStatus').textContent = 'Lift ' + saved.liftId + ' saved. Find it under QMS Data.';
        window.scrollTo(0, 0);
      } catch (err) {
        status.textContent = cleanError(err);
        button.disabled = false;
      }
    };
    f.onreset = () => setTimeout(() => { draft = newDraft(); el('qmsPanel').innerHTML = qmsForm(null); bindQmsForm(null); }, 0);
  }

  /* AVR size chosen (by hand or from the suggestion): a single item is taken automatically; blank sizes record the size only */
  function setAvr(model) {
    draft.pick.avrModel = model || '';
    const use = model ? rowsOf('AVR', model).filter(usable) : [];
    draft.pick.avr = use.length === 1 ? use[0].id : '';
  }
  function bindSuggest(f, repaint) {
    f.querySelectorAll('[data-suggest-ctrl]').forEach(b => b.onclick = () => {
      readDraft();
      draft.system = b.dataset.suggestCtrl; draft.controllerModel = b.dataset.model;
      for (const k of Object.keys(draft.pick)) if (k.startsWith('control:')) delete draft.pick[k];
      draft.parts = draft.parts.filter(x => x.section !== 'control');
      repaint(true);      /* the form still shows the old values, so the new choice must not be read back from it */
    });
    f.querySelectorAll('[data-suggest-avr]').forEach(b => b.onclick = () => { readDraft(); setAvr(b.dataset.suggestAvr); repaint(true); });
  }

  function bindMotor(f, afterChange) {
    if (typeof INDEX === 'undefined' || !INDEX.length) return;
    const val = n => f.elements[n].value;
    const rowsNow = () => INDEX.filter(r => (!val('m-c') || r.c === Number(val('m-c'))) && (!val('m-s') || r.s === Number(val('m-s'))) &&
      (!val('m-u') || r.u === val('m-u')) && (!val('m-p') || r.p === val('m-p')));
    const fillBrands = () => {
      const rows = rowsNow();
      const keepB = val('m-b');
      f.elements['m-b'].innerHTML = optionList([...new Set(rows.map(r => r.b))], keepB, 'Any');
      const rowsB = rows.filter(r => !val('m-b') || r.b === val('m-b'));
      const keepM = val('m-m');
      f.elements['m-m'].innerHTML = optionList([...new Set(rowsB.map(r => r.m))], keepM, 'Any');
    };
    fillBrands();
    for (const n of ['m-c', 'm-s', 'm-u', 'm-p', 'm-b']) f.elements[n].onchange = fillBrands;
    el('hwMotorSearch').onclick = () => {
      let rows = rowsNow().filter(r => (!val('m-b') || r.b === val('m-b')) && (!val('m-m') || r.m === val('m-m')));
      const box = el('hwMotorMatches');
      if (!rows.length) { box.innerHTML = '<p class="note">No matching motor.</p>'; return; }
      box.innerHTML = rows.map(r => `<button type="button" class="chip hw-motor-chip" data-motor-row="${r.r}"><b>${h(r.b)}</b><span>${h(r.m)} · ${h(r.t)}</span></button>`).join('');
      box.querySelectorAll('[data-motor-row]').forEach(b => b.onclick = async () => {
        b.disabled = true;
        try {
          draft.selection = await loadComponentDetails(Number(b.dataset.motorRow));
          el('hwMotorResult').innerHTML = motorTables(draft.selection);
          box.innerHTML = '';
          el('hwMotorClear').hidden = false;
          el('hwMotorNote').textContent = 'Motor selected.';
          if (afterChange) afterChange();
        } catch (err) { el('hwMotorNote').textContent = cleanError(err); b.disabled = false; }
      });
    };
    el('hwMotorClear').onclick = () => { draft.selection = null; el('hwMotorResult').innerHTML = '<p class="note">No motor selected yet.</p>'; el('hwMotorClear').hidden = true; if (afterChange) afterChange(); };
  }

  /* ---- QMS data: search by Lift ID, five tables, Excel */
  const tbl = (head, rows, empty) => rows.length ? `<div class="tbl-wrap" tabindex="0"><table class="tbl hw-table"><thead><tr>${head.map(x => `<th>${h(x)}</th>`).join('')}</tr></thead><tbody>${
    rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : `<p class="note">${h(empty || 'Nothing recorded.')}</p>`;
  const codeCell = p => p.code ? h(p.code) : '<span class="hw-nocode">no code</span>';

  function liftTables(rec) {
    const parts = s => rec.parts.filter(p => s.includes(p.section));
    const motor = rec.selection?.categories?.[0];
    const rest = (rec.selection?.categories || []).slice(1);
    return `<section class="card hw-out"><div class="overview-eyebrow">1 · PROJECT INFORMATION</div>${tbl(['Project', 'Lift ID', 'Address', 'Delivery', 'Motor type', 'Lift type'],
        [[h(rec.project), h(rec.liftId), h(rec.address), h(when(rec.deliveryDate)), h(rec.motorType), h(rec.liftType)]])}</section>
      <section class="card hw-out"><div class="overview-eyebrow">2 · SELECTED MOTOR</div>${motor ? `<div class="hw-sub"><table class="tbl hw-table"><tbody>
        ${Object.entries({Capacity: rec.selection.inputs?.capacity, Speed: rec.selection.inputs?.speed, 'Usage type': rec.selection.inputs?.usageType, Roping: rec.selection.inputs?.roping})
          .map(([k, v]) => `<tr><td class="hw-k">${k}</td><td>${h(v)}</td></tr>`).join('')}</tbody></table></div>${motorTables({categories: [motor]})}` : '<p class="note">No motor was recorded.</p>'}
        ${rest.length ? `<details><summary>Recommended controller / power supply (from Component Selection)</summary>${motorTables({categories: rest})}</details>` : ''}</section>
      <section class="card hw-out"><div class="overview-eyebrow">3 · CONTROL SYSTEM — ${h(rec.system)} · ${h(rec.controllerModel)}</div>${
        tbl(['Group', 'Hardware', 'Spec', 'Item code', 'Item name', 'Brand', 'Price (৳)'], parts(['control']).map(p => [h(p.grp), h(p.hardware), h(p.spec), codeCell(p), h(p.name), h(p.brand), h(money(p.value))]))}</section>
      <section class="card hw-out"><div class="overview-eyebrow">4 · SERIAL NUMBERS</div>${
        tbl(['Part', 'Serial number'], SERIALS.map(([k, t]) => [h(t.replace(/ SL$/, '')), h(rec.serials?.[k]) || '—']), 'No serial numbers were recorded.')}</section>
      <section class="card hw-out"><div class="overview-eyebrow">5 · COP · LOP · TRANSOM · TRAVELLING CABLE</div>${
        tbl(['Part', 'Model', 'Item code', 'Item name', 'Brand', 'Price (৳)'], parts(['lop', 'cop', 'faceplate', 'transom', 'cable']).map(p => [h(SECTION_NAMES[p.section] + (p.grp && p.section === 'cop' ? ' · ' + p.grp.replace('COP ', '') : '')), h(p.hardware), codeCell(p), h(p.name), h(p.brand), h(money(p.value))]))}</section>
      <section class="card hw-out"><div class="overview-eyebrow">6 · OTHER COMPONENTS (INCLUDING AVR)</div>${
        tbl(['Category', 'Item code', 'Item name', 'Spec', 'Supplier', 'Brand', 'Price (৳)'], [
          ...parts(['avr', 'other']).map(p => [h(p.section === 'avr' ? p.model : p.hardware), codeCell(p), h(p.name), h(p.spec), h(p.supplier), h(p.brand), h(money(p.value))]),
          ...(sdbOf(rec.selection) ? [['SDB main breaker rating', '—', '—', h(sdbOf(rec.selection)), '', '', '']] : [])])}</section>`;
  }

  const FLAT_HEAD = ['Lift ID', 'Project', 'Address', 'Delivery date', 'Motor type', 'Lift type', 'Control system', 'Controller model', 'Section', 'Group', 'Hardware', 'Spec', 'Item code', 'Item name', 'Brand', 'Supplier', 'Price (BDT)', 'Serial'];
  const sdbRow = rec => sdbOf(rec.selection) ? [{section: 'other', hardware: 'SDB main breaker rating', spec: sdbOf(rec.selection), name: 'From Component Selection'}] : [];
  const flat = rec => ((rec.parts.length || sdbOf(rec.selection)) ? [...rec.parts, ...sdbRow(rec)] : [{}]).map(p => [rec.liftId, rec.project, rec.address || '', rec.deliveryDate || '', rec.motorType || '', rec.liftType || '', rec.system, rec.controllerModel,
    SECTION_NAMES[p.section] || '', p.grp || '', p.hardware || '', p.spec || '', p.code || '', p.name || '', p.brand || '', p.supplier || '', p.value ?? '', p.serial || '']);

  async function downloadLifts(records, name, status) {
    try {
      status.textContent = 'Preparing Excel…';
      const sheets = [{name: 'QMS data', headers: FLAT_HEAD, rows: records.flatMap(flat)}];
      if (records.length === 1) {
        const rec = records[0];
        sheets.unshift({name: 'Project', headers: ['Project', 'Lift ID', 'Address', 'Delivery date', 'Motor type', 'Lift type', 'Control system', 'Controller model', ...SERIALS.map(x => x[1])],
          rows: [[rec.project, rec.liftId, rec.address || '', rec.deliveryDate || '', rec.motorType || '', rec.liftType || '', rec.system, rec.controllerModel, ...SERIALS.map(([k]) => rec.serials?.[k] || '')]]});
        if (rec.selection) sheets.push({name: 'Motor selection', headers: ['Section', 'Parameter', 'Value'],
          rows: [...Object.entries(rec.selection.inputs || {}).map(([k, v]) => ['Input', k, v]), ...(rec.selection.categories || []).flatMap(c => c.items.map(it => [c.title, it.label, it.value]))]});
      }
      await WlfExports.excel(sheets, name);
      status.textContent = 'Excel downloaded.';
    } catch (err) { status.textContent = cleanError(err); }
  }

  function showLift(rec, message) {
    qmsRun++;
    const panel = el('qmsPanel');
    const edit = rec.canEdit, del = rec.canDelete;
    const hist = (rec.history || []).map(x => `<li>${h(when(x.at, true))} · ${h(x.by)} · ${h(x.action)}${x.changed?.length ? ' (' + h(x.changed.join(', ')) + ')' : ''}</li>`).join('');
    panel.innerHTML = `<div class="card hw-out"><div class="hw-head"><div><div class="overview-eyebrow">QMS DATA</div><h3>${h(rec.liftId)} · ${h(rec.project)}</h3>
        <p class="note">Recorded by ${h(rec.createdName)} · Updated ${h(when(rec.updatedAt, true))} by ${h(rec.updatedName)}</p></div>
      <div class="hw-toolbar"><button class="btn ghost" type="button" id="qmsBack">Back to search</button><button class="btn ghost" type="button" id="qmsExcel">Download Excel</button>
        ${edit ? '<button class="btn" type="button" id="qmsEdit">Edit</button>' : ''}${del ? '<button class="btn danger" type="button" id="qmsDelete">Delete</button>' : ''}</div></div>
      <p class="note overview-status" id="qmsLiftStatus" role="status">${h(message || '')}</p></div>
      ${liftTables(rec)}
      <details class="card hw-out"><summary>Change history</summary><ul class="hw-history">${hist}</ul></details>`;
    el('qmsBack').onclick = openData;
    el('qmsExcel').onclick = () => downloadLifts([rec], 'QMS-' + rec.liftId, el('qmsLiftStatus'));
    if (edit) el('qmsEdit').onclick = async () => {
      await loadCatalogue();
      if (typeof maybeRefreshIndex === 'function') maybeRefreshIndex();
      draft = draftFromRecord(rec);
      panel.innerHTML = qmsForm(rec);
      bindQmsForm(rec, () => showLift(rec));
    };
    if (del) el('qmsDelete').onclick = () => {
      openDialog('Delete lift record', `<p>Delete the record of lift <b>${h(rec.liftId)}</b>? The Lift ID becomes free for a new record.</p>
        <p class="note overview-status" id="hwDialogStatus" role="status"></p>
        <div class="overview-actions"><button class="btn danger" type="button" id="hwConfirm">Delete</button><button class="btn ghost" type="button" id="hwCancel">Cancel</button></div>`);
      el('hwCancel').onclick = closeDialog;
      el('hwConfirm').onclick = async () => {
        try { await rpc('deleteQmsLift', [T(), {id: rec.id}]); closeDialog(); openData('Lift record deleted.'); }
        catch (err) { el('hwDialogStatus').textContent = cleanError(err); }
      };
    };
  }

  async function searchLifts(filters, message) {
    const run = ++qmsRun;
    const status = el('qmsDataStatus');
    status.textContent = 'Searching…';
    try {
      const data = await rpc('getQmsLifts', [T(), filters]);
      if (run !== qmsRun) return;
      el('qmsResults').innerHTML = tbl(['Lift ID', 'Project', 'Delivery', 'Controller', 'Updated', ''],
        data.rows.map(r => [`<b>${h(r.liftId)}</b>`, h(r.project), h(when(r.deliveryDate)), h(r.controllerModel), h(when(r.updatedAt)), `<button class="btn ghost" type="button" data-qms-open="${h(r.id)}">Open</button>`]),
        'No lift record matches.');
      status.textContent = message || data.rows.length + ' record(s)' + (data.rows.length >= 60 ? ' (first 60 shown, narrow the search)' : '');
      el('qmsResults').querySelectorAll('[data-qms-open]').forEach(b => b.onclick = async () => {
        try { showLift(await rpc('getQmsLift', [T(), {id: b.dataset.qmsOpen}])); } catch (err) { status.textContent = cleanError(err); }
      });
      if (data.rows.length === 1 && filters.liftId && data.rows[0].liftId.toLowerCase() === filters.liftId.trim().toLowerCase())
        showLift(await rpc('getQmsLift', [T(), {id: data.rows[0].id}]));
    } catch (err) { if (run === qmsRun) status.textContent = cleanError(err); }
  }

  function openData(message) {
    qmsRun++;
    setTab('data');
    el('qmsPanel').innerHTML = `<form id="qmsSearch" class="card hw-out"><div class="hw-head"><div><div class="overview-eyebrow">QMS DATA</div><h3>Search by Lift ID</h3></div>
        <div class="hw-toolbar"><button class="btn ghost" type="button" id="qmsAllExcel">Download Excel (these results)</button></div></div>
      <div class="hw-grid"><label>Lift ID<input name="liftId" maxlength="80" autocomplete="off"></label><label>Project<input name="project" maxlength="180" autocomplete="off"></label>
        <label>Component item code or name<input name="itemCode" maxlength="120" autocomplete="off"></label><label>&nbsp;<button class="btn" type="submit">Search</button></label></div>
      <p class="note overview-status" id="qmsDataStatus" role="status">${h(typeof message === 'string' ? message : '')}</p></form><div id="qmsResults"></div>`;
    const form = el('qmsSearch');
    const filters = () => Object.fromEntries([...new FormData(form)].map(([k, v]) => [k, String(v).trim()]));
    form.onsubmit = event => { event.preventDefault(); searchLifts(filters()); };
    el('qmsAllExcel').onclick = async () => {
      try {
        const data = await rpc('getQmsLifts', [T(), {...filters(), full: true}]);
        if (!data.rows.length) { el('qmsDataStatus').textContent = 'No lift record matches.'; return; }
        await downloadLifts(data.rows, 'QMS-data', el('qmsDataStatus'));
      } catch (err) { el('qmsDataStatus').textContent = cleanError(err); }
    };
    searchLifts(filters(), typeof message === 'string' ? message : '');
  }

  function setTab(name) {
    const a = el('qmsTabInput'), b = el('qmsTabData');
    if (!a) return;
    a.classList.toggle('active', name === 'input');
    b.classList.toggle('active', name === 'data');
  }

  async function openQms() {
    const root = el('tab-qms');
    const run = ++qmsRun;
    root.innerHTML = `<div class="hw-stack"><div class="hw-tabs" role="tablist"><button type="button" class="btn" id="qmsTabInput">QMS Input</button><button type="button" class="btn ghost" id="qmsTabData">QMS Data</button></div>
      <div id="qmsPanel"><div class="card"><p class="note">Loading the catalogue…</p></div></div></div>`;
    el('qmsTabInput').onclick = () => openInput();
    el('qmsTabData').onclick = () => openData();
    try {
      await loadCatalogue(true);
      if (run !== qmsRun) return;
      if (typeof maybeRefreshIndex === 'function') maybeRefreshIndex();
      openInput();
    } catch (err) {
      if (run === qmsRun) el('qmsPanel').innerHTML = `<div class="card"><p class="note">${h(cleanError(err))}</p></div>`;
    }
  }

  function openInput() {
    qmsRun++;
    setTab('input');
    draft = newDraft();
    el('qmsPanel').innerHTML = `<div class="card hw-out"><div class="overview-eyebrow">QMS · PRE-DELIVERY QC INPUT</div><h3>New lift record</h3>
      <p class="note">Every list comes from the Hardware Catalogue. The item code, name, spec and brand are copied into the record when you save, so later catalogue changes never rewrite an old lift.</p></div>${qmsForm(null)}`;
    bindQmsForm(null);
  }

  /* ---------------------------------------------------------------- Raise Damage Demand picker */
  function suggestedGroups(ticket) {
    const text = [ticket?.values?.problem_category, ...(ticket?.sub || []), ticket?.values?.problem_sub].filter(Boolean).join(' ').toLowerCase();
    const groups = new Set();
    for (const m of CAT.map) if (text.includes(m.keyword)) m.groups.forEach(g => groups.add(g));
    return groups;
  }

  /* Returns {html, bind(form), read()}; read() throws a readable error when the choice is incomplete. */
  async function demandPicker(ticket) {
    await loadCatalogue(true);
    const controllers = (ticket?.controller || []).map(String);
    const sys = systems();
    const start = sys.find(s => controllers.some(c => c.toLowerCase() === s.toLowerCase()) && controlModels(s).length) || controlSystems()[0] || '';
    const wantModel = String(ticket?.values?.controller_model || '').trim();      /* v2.6.0: the support request records the controller model */
    const wantSystem = wantModel ? sys.find(s => modelsOf(s).includes(wantModel)) : '';
    const state = {model: '', supplier: '', picked: '', showAll: false, manual: false};
    const groups = suggestedGroups(ticket);
    const modelOptions = () => sys.map(s => `<optgroup label="${h(s)}">${modelsOf(s).map(m => `<option value="${h(s + '\u0001' + m)}">${h(m)}</option>`).join('')}</optgroup>`).join('');
    const html = `<div class="hw-demand">
      <p class="note">Control system: <b>${h(controllers.join(', ') || '—')}</b>${wantModel ? ' · Model: <b>' + h(wantModel) + '</b>' : ''} · Problem: <b>${h([ticket?.values?.problem_category, ...(ticket?.sub || [])].filter(Boolean).join(' / ') || '—')}</b></p>
      <div class="review-fields"><label>Component model *<select id="hwDemModel" name="hwModel"><option value="">Select…</option>${modelOptions()}</select></label>
      <label>Supplier name *<select id="hwDemSupplier" name="hwSupplier"><option value="">Select…</option></select></label></div>
      <div id="hwDemSuggest"></div><div id="hwDemList"></div>
      <label class="hw-check"><input type="checkbox" id="hwDemManual" name="hwDemManual"> Not in the catalogue (type it)</label>
      <div id="hwDemManualBox" hidden><label>Item name *<input name="itemName" maxlength="180"></label>
        <div class="review-fields"><label>Item code<input name="itemCode" maxlength="120"></label><label>Item Model/Spec<input name="itemSpec" maxlength="240"></label></div></div></div>`;
    const rowsNow = () => {
      if (!state.model) return [];
      const [s, m] = state.model.split('\u0001');
      return rowsOf(s, m).filter(r => usable(r) && (!state.supplier || r.supplier === state.supplier));
    };
    function paint() {
      const rows = rowsNow();
      const sug = rows.filter(r => groups.has(r.grp) || groups.has(r.hardware));
      const shown = state.showAll || !sug.length ? rows : sug;
      el('hwDemSuggest').innerHTML = state.model && sug.length ? `<div class="hw-suggest"><div class="overview-eyebrow">SUGGESTED FOR THIS PROBLEM</div>
        <div class="hw-chips">${sug.slice(0, 12).map(r => `<button type="button" class="chip hw-pick ${state.picked === r.id ? 'on' : ''}" data-dem-pick="${h(r.id)}">${h(label(r))}${r.spec ? ' ' + h(r.spec) : ''}</button>`).join('')}
        <button type="button" class="chip" id="hwDemAll">${state.showAll ? 'Show suggestions only' : 'Show all ' + rows.length + ' parts'}</button></div></div>` : '';
      el('hwDemList').innerHTML = state.model ? tbl(['', 'Item code', 'Item name', 'Spec', 'Brand'], shown.map(r => [
        `<input type="radio" name="hwDemPick" value="${h(r.id)}" ${state.picked === r.id ? 'checked' : ''} aria-label="Select ${h(label(r))}">`,
        r.itemCode ? h(r.itemCode) : '<span class="hw-nocode">no code</span>', h(r.itemName || r.hardware), h(r.spec), h(r.brand)]), 'No parts for this model and supplier.') : '';
      document.querySelectorAll('[data-dem-pick]').forEach(b => b.onclick = () => { state.picked = b.dataset.demPick; paint(); });
      document.querySelectorAll('input[name=hwDemPick]').forEach(r => r.onchange = () => { state.picked = r.value; paint(); });
      if (el('hwDemAll')) el('hwDemAll').onclick = () => { state.showAll = !state.showAll; paint(); };
    }
    function bind() {
      const model = el('hwDemModel'), supplier = el('hwDemSupplier');
      model.onchange = () => {
        state.model = model.value; state.picked = ''; state.supplier = '';
        const suppliers = [...new Set(rowsNow().map(r => r.supplier).filter(Boolean))];
        supplier.innerHTML = '<option value="">' + 'Select…' + '</option>' + suppliers.map(x => `<option value="${h(x)}">${h(x)}</option>`).join('');
        if (suppliers.length === 1) { supplier.value = suppliers[0]; state.supplier = suppliers[0]; }
        paint();
      };
      supplier.onchange = () => { state.supplier = supplier.value; state.picked = ''; paint(); };
      el('hwDemManual').onchange = event => {
        state.manual = event.target.checked;
        el('hwDemManualBox').hidden = !state.manual;
        for (const n of ['hwDemModel', 'hwDemSupplier']) el(n).disabled = state.manual;
        el('hwDemList').hidden = el('hwDemSuggest').hidden = state.manual;
      };
      const first = start ? (controlModels(start)[0] || modelsOf(start)[0]) : '';
      if (wantSystem) { model.value = wantSystem + '\u0001' + wantModel; model.onchange(); }
      else if (first) { model.value = start + '\u0001' + first; model.onchange(); }
    }
    function read(form) {
      if (state.manual) {
        const f = Object.fromEntries(new FormData(form));
        if (!String(f.itemName || '').trim()) throw new Error('Enter the item name.');
        return {manual: 'true', itemName: f.itemName, itemCode: f.itemCode || '', itemSpec: f.itemSpec || ''};
      }
      if (!state.model) throw new Error('Select the component model.');
      if (!state.supplier) throw new Error('Select the supplier name.');
      if (!state.picked) throw new Error('Select the component to demand.');
      return {catalogId: state.picked};
    }
    return {html, bind, read};
  }

  /* ---------------------------------------------------------------- page wiring */
  document.addEventListener('DOMContentLoaded', () => {
    const anchor = document.querySelector('#nav [data-tab="qms"]');
    if (anchor) anchor.insertAdjacentHTML('afterend',
      '<button data-tab="catalogue" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/></svg>Hardware Catalogue</button>');
    document.querySelector('.content').insertAdjacentHTML('beforeend', '<section id="tab-catalogue" class="tab-content hidden"></section>');
    if (typeof PAGES !== 'undefined') {
      PAGES.catalogue = ['Hardware Catalogue', 'One hardware database for QMS and Damage Demand'];
      PAGES.qms = ['QMS', 'Lift-wise component record for QC'];
    }
  });
  window.addEventListener('wlf-logout', () => {
    catalogueRun++; qmsRun++; session = null; CAT = {rows: [], map: [], canEdit: false, at: 0}; draft = null; selected = {system: '', model: ''};
    for (const id of ['tab-catalogue', 'tab-qms', 'hwDialog']) el(id)?.replaceChildren();
    if (el('hwDialog')?.open) el('hwDialog').close();
  });

  return {openCatalogue, openQms, demandPicker};
})();
