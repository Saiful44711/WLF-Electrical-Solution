/* Damage Demand workflow and reporting for the authenticated WLF workspace. */
const WlfDamage = (() => {
  'use strict';

  const el = id => document.getElementById(id);
  const h = value => esc(String(value ?? ''));
  const teams = ['commissioning', 'aftersales', 'installation', 'maintenance'];
  const teamName = key => (AccessCore.supportTitles[key] || key).replace(/ Team Support Request$/, '');
  const teamChoices = teams.map(key => [key, teamName(key)]);
  const allowed = option => AccessCore.damageAccess(SESSION, option);
  const capable = () => SESSION?.damageDemand === true;
  const time = value => value ? new Date(value).toLocaleString('en-GB', {timeZone: 'Asia/Dhaka'}) : '';
  const visible = () => !el('tab-damage-demand')?.classList.contains('hidden');
  let state;
  let detailRun = 0;

  const reportColumns = [
    ['Demand ID', d => d.reference],
    ['Support request ID', d => d.requestReference],
    ['Support team', d => teamName(d.category)],
    ['Project name', d => d.project],
    ['Lift ID', d => d.lift],
    ['Controller', d => d.controllers.join(', ')],
    ['Problem category', d => d.problemCategories.join(', ')],
    ['Item name', d => d.itemName],
    ['Item code', d => d.itemCode],
    ['Item model/spec', d => d.itemSpec],
    ['Item quantity', d => d.quantity],
    ['Duration (Min)', d => d.durationMinutes],
    ['Request submitted by', d => d.requesterName],
    ['Confirmation by', d => d.confirmedBy],
    ['Demand status', d => d.status],
    ['Demand submitted (Dhaka)', d => time(d.createdAt)],
    ['Received by', d => d.receivedBy],
    ['Received at (Dhaka)', d => time(d.receivedAt)],
    ['Supplier Claim', d => d.supplierClaim ? 'Yes' : 'No'],
    ['Supplier Confirmed', d => d.supplierConfirmed ? 'Yes' : 'No']
  ];

  async function call(action, payload) {
    const account = SESSION;
    const result = await rpc(action, [T(), payload]);
    if (account !== SESSION) throw Error('Session changed.');
    return result;
  }

  function statusBadge(status) {
    const style = status === 'Received' ? 'received' : 'pending';
    return `<span class="support-status status-${style}">${h(status)}</span>`;
  }

  function supportSummary(ticket, readOnly) {
    if (!capable()) return '';
    const demand = ticket.damageDemand;
    const details = readOnly ? [
      ticket.durationMinutes != null ? `Duration (Min) ${h(ticket.durationMinutes)}` : '',
      ticket.hardwareIssue != null ? `Hardware Issue ${ticket.hardwareIssue ? 'Yes' : 'No'}` : ''
    ].filter(Boolean) : [];
    if (!demand && !details.length) return '';
    return `<div class="damage-ticket-summary">${details.map(detail => `<span>${detail}</span>`).join('')}
      ${demand ? `<span id="supportDamageStatus"><b>Damage Demand ${h(demand.reference)}</b> ${statusBadge(demand.status)}</span>` : ''}</div>`;
  }

  function supportInputs(ticket, draft) {
    if (!capable()) return '';
    const duration = draft ? draft.durationMinutes : ticket.durationMinutes;
    const issue = ticket.damageDemand ? true : draft ? draft.hardwareIssue : ticket.hardwareIssue;
    return `<div class="damage-review-inputs">
      <label for="supportDuration">Duration (Min)</label>
      <input id="supportDuration" type="number" inputmode="decimal" min="0" max="999999.99" step="0.01" value="${h(duration)}">
      <fieldset id="supportHardware" ${ticket.damageDemand ? 'disabled' : ''}>
        <legend>Hardware Issue?</legend>
        <label><input type="radio" name="support-hardware" value="false" ${issue === false ? 'checked' : ''}> No</label>
        <label><input type="radio" name="support-hardware" value="true" ${issue === true ? 'checked' : ''}> Yes</label>
      </fieldset>
      ${!teams.includes(ticket.category) ? '<p class="note">Hardware issues are recorded with the support response for this team.</p>' : ''}
    </div>`;
  }

  function readReview() {
    const duration = el('supportDuration');
    if (!duration) return null;
    const choice = el('supportHardware').querySelector('input:checked')?.value;
    return {durationMinutes: duration.value, hardwareIssue: choice == null ? null : choice === 'true'};
  }

  function dialog(title, body) {
    const node = el('wlfDamageDialog');
    node.innerHTML = `<h2 id="damageDialogTitle">${h(title)}</h2>${body}`;
    node.oncancel = event => { if (node.querySelector('[data-damage-busy]')) event.preventDefault(); };
    if (!node.open) node.showModal();
    else node.querySelector('[data-damage-close]')?.focus();
    return node;
  }

  function bindSupport(ticket, isCurrent, onSaved) {
    const hardware = el('supportHardware');
    if (!hardware || hardware.disabled || !teams.includes(ticket.category)) return;
    let previous = readReview().hardwareIssue;
    hardware.onchange = event => {
      if (event.target.value === 'false') {
        previous = false;
        return;
      }
      const node = dialog('Raise Damage Demand', `
        <p class="note">The request details and solution statement will be copied when you submit.</p>
        <form id="damageCreateForm">
          <label>Confirmation by<input name="confirmedBy" value="${h(SESSION.name)}" readonly></label>
          <label>Item name *<input name="itemName" required maxlength="180" autofocus></label>
          <div class="review-fields">
            <label>Item code<input name="itemCode" maxlength="120"></label>
            <label>Item Model/Spec<input name="itemSpec" maxlength="240"></label>
          </div>
          <label>Item Quantity *<input name="quantity" type="number" inputmode="numeric" min="1" max="999999" step="1" required></label>
          <p role="status" aria-live="polite"></p>
          <div class="engineering-actions">
            <button type="submit" class="btn">Submit demand</button>
            <button type="button" class="btn ghost" data-damage-close>Cancel</button>
          </div>
        </form>`);
      const form = el('damageCreateForm');
      const submit = form.querySelector('[type=submit]');
      const cancel = form.querySelector('[data-damage-close]');
      const message = form.querySelector('[role=status]');
      let operation;
      let lastPayload;

      function cancelDemand() {
        const currentHardware = el('supportHardware');
        if (isCurrent() && currentHardware && !currentHardware.disabled) {
          for (const choice of currentHardware.querySelectorAll('input')) {
            choice.checked = previous != null && choice.value === String(previous);
          }
        }
        node.close();
      }
      cancel.onclick = cancelDemand;
      node.oncancel = event => {
        event.preventDefault();
        if (!cancel.disabled) cancelDemand();
      };
      form.onsubmit = async event => {
        event.preventDefault();
        const solution = el('supportComment')?.value.trim();
        const duration = el('supportDuration');
        if (!isCurrent() || !duration) {
          message.textContent = 'This request changed. Reopen it before submitting.';
          return;
        }
        if (!solution) {
          message.textContent = 'Enter a solution statement on the support request first.';
          return;
        }
        if (!duration.validity.valid) {
          message.textContent = 'Enter a valid Duration (Min) on the support request.';
          return;
        }
        const {itemName, itemCode, itemSpec, quantity} = Object.fromEntries(new FormData(form));
        const payload = {id: ticket.id, revision: ticket.revision, itemName, itemCode, itemSpec,
          quantity, durationMinutes: duration.value, solutionStatement: solution};
        const signature = JSON.stringify(payload);
        if (signature !== lastPayload) {
          operation = crypto.randomUUID();
          lastPayload = signature;
        }
        submit.disabled = cancel.disabled = true;
        form.dataset.damageBusy = '';
        message.textContent = 'Submitting demand…';
        try {
          const result = await call('createDamageDemand', {...payload, operation});
          if (node.contains(form) && node.open) node.close();
          if (isCurrent()) onSaved(result);
        } catch (err) {
          if (node.contains(form)) message.textContent = cleanError(err);
        } finally {
          delete form.dataset.damageBusy;
          submit.disabled = cancel.disabled = false;
        }
      };
    };
  }

  const filterInput = (label, name, type, value) => `<label>${h(label)}<input name="${name}"
    type="${type}" value="${h(value)}" ${type === 'text' ? 'maxlength="200"' : ''}></label>`;

  function filterSelect(label, name, options, current = '', all = 'All') {
    const option = WlfFields.option;
    const available = options.some(([value]) => value === current);
    return `<label>${h(label)}<select name="${name}">${option('', all, current)}
      ${current && !available ? option(current, current.replace(/^v:/, ''), current) : ''}
      ${options.map(([value, text]) => option(value, text, current)).join('')}</select></label>`;
  }

  function table(rows, queue) {
    const headers = ['Demand / Support request', 'Team', 'Project / Lift ID',
      ...(queue ? [] : ['Controller', 'Problem category']), 'Item', 'Quantity', 'Status', 'Submitted (Dhaka)'];
    return `<div class="tbl-wrap" tabindex="0" aria-label="Damage demand records"><table class="tbl damage-table">
      <thead><tr>${headers.map(label => `<th scope="col">${h(label)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(d => `<tr>
        <td>${allowed('demand') ? `<button type="button" class="btn ghost damage-link" data-damage-view="${h(d.id)}">${h(d.reference)}</button>` : h(d.reference)}
          <small>${h(d.requestReference)}</small></td>
        <td>${h(teamName(d.category))}</td><td>${h(d.project || 'Not recorded')}<small>${h(d.lift)}</small></td>
        ${queue ? '' : `<td>${h(d.controllers.join(', ') || 'Not recorded')}</td><td>${h(d.problemCategories.join(', ') || 'Not recorded')}</td>`}
        <td>${h(d.itemName)}<small>${h([d.itemCode, d.itemSpec].filter(Boolean).join(' · '))}</small></td>
        <td>${h(d.quantity)}</td><td>${statusBadge(d.status)}${d.supplierConfirmed ? '<small class="supplier-tag">Supplier Confirmed</small>' : d.supplierClaim ? '<small class="supplier-tag">Supplier Claim</small>' : ''}</td><td>${h(time(d.createdAt))}</td>
      </tr>`).join('')}</tbody>
    </table></div>`;
  }

  function chart(data) {
    return `<section class="card damage-chart" aria-labelledby="damageChartTitle">
      <h3 id="damageChartTitle">Damage percentage by component</h3>
      <p class="note">Each component’s damaged units as a share of all damaged units in the filtered demands.</p>
      ${data.components.length ? `<div class="damage-chart-rows">${data.components.map(row => `
        <div class="damage-chart-row">
          <div><strong>${h(row.label)}</strong><span>${h(row.units)} units · ${h(row.percentage)}%</span></div>
          <meter min="0" max="100" value="${h(row.percentage)}" aria-label="${h(row.label)} damage share">${h(row.percentage)}%</meter>
        </div>`).join('')}</div>` : '<p class="note">No damaged components match these filters.</p>'}
    </section>`;
  }

  function render() {
    const root = el('tab-damage-demand');
    const {pane, filters, data, cursors, listStatus, advanced} = state;
    const queue = pane === 'demand';
    const facets = key => (data?.facets?.[key] || []).map(({value, label}) => [value, label]);
    const tabs = ['demand', 'dashboard'].filter(allowed).map(option =>
      `<button type="button" class="btn ghost ${pane === option ? 'active' : ''}" aria-pressed="${pane === option}"
        data-damage-pane="${option}">${option === 'demand' ? 'Demand' : 'Dashboard'}</button>`).join('');

    root.innerHTML = `<div class="wlf-module damage-workspace">
      <section class="card damage-controls">
        <div class="damage-toolbar">
          <div class="wlf-section-tabs" aria-label="Damage Demand options">${tabs}</div>
          <div class="engineering-actions">
            <button type="button" class="btn ghost" id="damageRefresh">Refresh</button>
            ${queue ? '' : '<button type="button" class="btn ghost" id="damageExport">Download filtered Excel</button>'}
          </div>
        </div>
        <form id="damageFilters">
          <div class="damage-filter-fields">
            ${filterSelect('Support team', 'category', teamChoices, filters.category, 'All teams')}
            ${queue ? filterSelect('Status', 'status', [['Pending', 'Pending'], ['Received', 'Received']], filters.status, 'All statuses') :
              filterSelect('Component', 'component', facets('component'), filters.component)}
            ${queue ? filterInput('Project name', 'project', 'text', filters.project) :
              filterSelect('Controller', 'controller', facets('controller'), filters.controller)}
            <div class="engineering-actions">
            <button type="submit" class="btn">Apply filters</button>
            <button type="button" class="btn ghost" id="damageReset">Reset filters</button>
            </div>
          </div>
          <details class="damage-more-filters" ${advanced ? 'open' : ''}>
            <summary>More filters${filters.from || filters.to || filters.lift || filters.problemCategory ? ' · active' : ''}</summary>
            <div class="damage-filter-fields">
              ${filterInput('From date (Dhaka)', 'from', 'date', filters.from)}
              ${filterInput('To date (Dhaka)', 'to', 'date', filters.to)}
              ${queue ? filterInput('Lift ID', 'lift', 'text', filters.lift) :
                filterSelect('Problem category', 'problemCategory', facets('problemCategory'), filters.problemCategory)}
            </div>
          </details>
        </form>
        <p id="damageStatus" role="status" aria-live="polite"></p>
      </section>
      ${!queue && data ? `<section class="damage-metrics" aria-label="Filtered demand totals">
        ${[['All demands', data.total, '', 'all'], ['Pending', data.pending, 'Pending', 'pending'],
            ['Received', data.received, 'Received', 'received'], ['Damaged units', data.units, null, 'units']]
          .map(([label, value, status, tone]) => {
            const content = `<span>${label}</span><b>${h(value)}</b>`;
            return status === null ? `<div class="damage-metric" data-tone="${tone}">${content}</div>` :
              `<button type="button" class="damage-metric" data-tone="${tone}" data-damage-status="${status}"
                 aria-controls="damageResults" aria-pressed="${listStatus === status}">${content}</button>`;
          }).join('')}
        </section>` : ''}
      ${queue && data ? `<nav class="damage-team-tabs" aria-label="Demands by team">${[['', 'All teams', Object.values(data.teamPending || {}).reduce((a, b) => a + Number(b || 0), 0)],
          ...teams.map(t => [t, teamName(t), Number(data.teamPending?.[t] || 0)])].map(([value, label, n]) =>
          `<button type="button" class="damage-team-tab${(filters.category || '') === value ? ' active' : ''}" aria-pressed="${(filters.category || '') === value}" data-damage-team="${h(value)}">
            <span>${h(label)}</span>${n ? `<b aria-label="${n} pending">${n}</b>` : ''}${allowed('receive') && value && !AccessCore.damageAccess(SESSION, 'receive', value) ? '<small>view only</small>' : ''}</button>`).join('')}</nav>` : ''}
      ${data ? `<section class="card damage-results" id="damageResults">
        <div class="review-heading"><h3 tabindex="-1">${queue ? 'Demand list' : listStatus ? listStatus + ' demands' : 'Filtered demand records'}</h3>
          <span class="note">${h(data.pageTotal ?? data.total)} match · showing ${data.rows.length}</span></div>
        ${!data.rows.length ? '<p class="note">No demands match these filters.</p>' : queue ? teams.map(team => {
          const rows = data.rows.filter(d => d.category === team);
          return rows.length ? `<section class="damage-team"><h4>${h(teamName(team))}</h4>${table(rows, true)}</section>` : '';
        }).join('') : table(data.rows, false)}
        <div class="engineering-actions">
          <button type="button" class="btn ghost" id="damagePrevious" ${cursors.length ? '' : 'disabled'}>Previous page</button>
          <button type="button" class="btn ghost" id="damageNext" ${data.nextCursor ? '' : 'disabled'}>Next page</button>
        </div></section>` : ''}
      ${!queue && data ? chart(data) : ''}
    </div>`;

    document.querySelectorAll('#nav [data-damage-nav]').forEach(button => {
      const current = button.dataset.damageNav === pane;
      button.classList.toggle('active', current);
    });
    root.querySelectorAll('[data-damage-pane]').forEach(button => button.onclick = () => setPane(button.dataset.damagePane));
    root.querySelectorAll('[data-damage-view]').forEach(button => button.onclick = () => openDetail(button.dataset.damageView));
    root.querySelectorAll('[data-damage-team]').forEach(button => button.onclick = () => {
      state.filters = {...state.filters, category: button.dataset.damageTeam};
      state.cursors = [];
      load(true);
    });
    root.querySelectorAll('[data-damage-status]').forEach(button => button.onclick = () => {
      if (button.dataset.damageStatus === state.listStatus) return;
      state.listStatus = button.dataset.damageStatus;
      state.cursors = [];
      load(true);
    });
    const form = el('damageFilters');
    const more = form.querySelector('details');
    more.ontoggle = () => { if (more.isConnected) state.advanced = more.open; };
    form.oninput = () => { form.dataset.unsavedFilters = ''; };
    form.onsubmit = event => {
      event.preventDefault();
      const next = Object.fromEntries(new FormData(event.currentTarget));
      if (next.from && next.to && next.from > next.to) {
        el('damageStatus').textContent = 'From date must be on or before To date.';
        return;
      }
      delete form.dataset.unsavedFilters;
      state.filters = next;
      state.cursors = [];
      load();
    };
    el('damageReset').onclick = () => setPane(pane);
    el('damageRefresh').onclick = () => load();
    if (el('damageExport')) el('damageExport').onclick = exportReport;
    if (el('damagePrevious')) el('damagePrevious').onclick = () => {
      if (!state.loading) {
        state.cursors.pop();
        load();
      }
    };
    if (el('damageNext')) el('damageNext').onclick = () => {
      if (!state.loading) {
        state.cursors.push(data.nextCursor);
        load();
      }
    };
  }

  async function load(focusList = false) {
    const target = state;
    const run = ++target.run;
    const message = el('damageStatus');
    target.loading = true;
    message.textContent = 'Loading demands…';
    try {
      const queue = target.pane === 'demand';
      const data = await call(queue ? 'getDamageDemands' : 'getDamageDashboard',
        {...target.filters, status: queue ? target.filters.status : target.listStatus, cursor: target.cursors.at(-1)});
      if (state === target && run === target.run) {
        target.data = data;
        render();
        if (focusList && visible()) el('damageResults').querySelector('h3').focus();
      }
    } catch (err) {
      if (state === target && run === target.run) {
        message.textContent = cleanError(err);
        target.cursors = [...target.loadedCursors];
      }
    } finally {
      if (state === target && run === target.run) {
        target.loading = false;
        target.loadedCursors = [...target.cursors];
      }
    }
  }

  function setPane(pane) {
    if (!allowed(pane)) return;
    detailRun++;
    state = {pane, filters: {}, listStatus: '', advanced: false, cursors: [], loadedCursors: [], run: 0, data: null, loading: false};
    render();
    load();
  }

  function open(pane) {
    setPane(['demand', 'dashboard'].includes(pane) && allowed(pane) ? pane : allowed('demand') ? 'demand' : 'dashboard');
  }

  function detailValues(pairs) {
    return `<dl class="wlf-entry-values damage-details">${pairs.map(([name, value]) =>
      `<dt>${h(name)}</dt><dd>${h(WlfFields.display(value) || 'Not recorded')}</dd>`).join('')}</dl>`;
  }

  const yn = on => `<b class="supplier-yn ${on ? 'yes' : 'no'}">${on ? 'Yes' : 'No'}</b>`;
  const can = option => AccessCore.supplierAccess(SESSION, option);

  function supplierBlock(d) {
    const sp = d.supplier || {};
    const claim = can('claim') && !d.supplierClaim;
    const confirm = can('confirm') && d.supplierClaim && !d.supplierConfirmed;
    const admin = SESSION?.role === 'Super Admin' && d.supplierClaim && sp.status !== 'Received';
    return `<section class="supplier-box" aria-labelledby="supplierBoxTitle"><h3 id="supplierBoxTitle">Supplier claim</h3>
      <dl class="wlf-entry-values damage-details">
        <dt>Supplier Claim</dt><dd>${yn(d.supplierClaim)}${d.supplierClaim ? `<small>${h(sp.name)} · ${h(sp.date || '')} · by ${h(sp.claimBy)} · ${h(time(sp.claimAt))}${sp.note ? ' · ' + h(sp.note) : ''}</small>` : ''}</dd>
        <dt>Supplier Confirmed</dt><dd>${yn(d.supplierConfirmed)}${d.supplierConfirmed ? `<small>by ${h(sp.confirmBy)} · ${h(time(sp.confirmAt))}</small>` : ''}</dd>
        ${d.supplierConfirmed ? `<dt>Supplier Claim goods</dt><dd>${statusBadge(sp.status)}${sp.status === 'Received' ? `<small>by ${h(sp.receivedBy)} · ${h(time(sp.receivedAt))}</small>` : ''}</dd>` : ''}
      </dl>
      <form id="supClaimForm" class="supplier-form" hidden>
        <label>Supplier name<input name="supplier" maxlength="120" required autocomplete="off"></label>
        <label>Claim date<input name="date" type="date"></label>
        <label>Note (optional)<textarea name="note" maxlength="500" rows="2"></textarea></label>
        <div class="engineering-actions"><button type="submit" class="btn">Save: Supplier Claim = Yes</button>
          <button type="button" class="btn ghost" id="supClaimCancel">Back</button></div>
      </form>
      <div class="engineering-actions supplier-actions">
        ${claim ? '<button type="button" class="btn" id="supClaimOpen">Set Supplier Claim = Yes</button>' : ''}
        ${confirm ? '<button type="button" class="btn" id="supConfirm">Set Supplier Confirmed = Yes</button>' : ''}
        ${admin && d.supplierConfirmed ? '<button type="button" class="btn ghost-danger" data-sup-cancel="confirm">Cancel Supplier Confirmed</button>' : ''}
        ${admin ? '<button type="button" class="btn ghost-danger" data-sup-cancel="claim">Cancel Supplier Claim</button>' : ''}
      </div></section>`;
  }

  function bindSupplier(node, d) {
    const status = el('damageDetailStatus');
    const run = async (action, payload, done, buttons) => {
      buttons.forEach(b => b.disabled = true);
      status.textContent = 'Saving…';
      try {
        const saved = await call(action, payload);
        if (node.open) renderDetail(saved, done);
        if (visible() && state?.pane === 'demand') load();
        if (typeof WlfSupplier !== 'undefined') WlfSupplier.refresh();
      } catch (err) {
        if (node.contains(status)) status.textContent = cleanError(err);
        buttons.forEach(b => b.disabled = false);
      }
    };
    const all = () => Array.from(node.querySelectorAll('.supplier-box button'));
    const form = el('supClaimForm');
    const open = el('supClaimOpen');
    if (open) open.onclick = () => { form.hidden = false; open.hidden = true; form.elements.supplier.focus(); };
    if (el('supClaimCancel')) el('supClaimCancel').onclick = () => { form.hidden = true; if (open) open.hidden = false; };
    if (form) form.onsubmit = event => {
      event.preventDefault();
      const f = form.elements;
      if (!f.supplier.value.trim()) { status.textContent = 'Enter the supplier name.'; f.supplier.focus(); return; }
      run('markSupplierClaim', {id: d.id, supplier: f.supplier.value.trim(), date: f.date.value, note: f.note.value.trim()}, 'Supplier Claim = Yes saved.', all());
    };
    const confirm = el('supConfirm');
    if (confirm) confirm.onclick = () => run('confirmSupplierClaim', {id: d.id}, 'Supplier Confirmed = Yes saved. The item is now in the Supplier Claim menu as Pending.', all());
    node.querySelectorAll('[data-sup-cancel]').forEach(b => b.onclick = () => {
      if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Click again to confirm: ' + b.textContent; return; }
      run('cancelSupplierClaim', {id: d.id, step: b.dataset.supCancel}, 'Cancelled.', all());
    });
  }

  function renderDetail(d, message = '') {
    const node = dialog('Damage Demand ' + d.reference, `
      <div class="damage-detail-header">${statusBadge(d.status)}<span>${h(teamName(d.category))}</span></div>
      ${detailValues([
        ['Support request ID', d.requestReference], ['Request submitted by', d.requesterName],
        ['Requested at (Dhaka)', time(d.requestedAt)], ['Demand submitted (Dhaka)', time(d.createdAt)],
        ['Confirmation by', d.confirmedBy], ['Duration (Min)', d.durationMinutes],
        ['Item name', d.itemName], ['Item code', d.itemCode],
        ['Item Model/Spec', d.itemSpec], ['Item Quantity', d.quantity],
        ...(d.receivedAt ? [['Received by', d.receivedBy], ['Received at (Dhaka)', time(d.receivedAt)]] : [])
      ])}
      <h3>Solution statement</h3><p class="damage-solution">${h(d.solutionStatement)}</p>
      <details class="support-form-values"><summary>Submitted support form details</summary>
        ${detailValues((d.supportForm?.fields || []).map(field => [field.label, d.supportValues?.[field.id]]))}
      </details>
      ${supplierBlock(d)}
      <p id="damageDetailStatus" role="status" aria-live="polite">${h(message)}</p>
      <div class="engineering-actions">
        ${d.status === 'Pending' && state?.pane === 'demand' && AccessCore.damageAccess(SESSION, 'receive', d.category) ? '<button type="button" class="btn" id="damageReceive">Receive demand</button>' : ''}
        <button type="button" class="btn ghost" data-damage-close>Close</button>
      </div>`);
    const close = node.querySelector('[data-damage-close]');
    close.onclick = () => node.close();
    bindSupplier(node, d);
    const receive = el('damageReceive');
    if (!receive) return;
    receive.onclick = async () => {
      receive.disabled = close.disabled = true;
      receive.dataset.damageBusy = '';
      const status = el('damageDetailStatus');
      status.textContent = 'Receiving demand…';
      try {
        const saved = await call('receiveDamageDemand', {id: d.id});
        if (node.open && node.contains(receive)) renderDetail(saved, 'Demand received.');
        if (state?.pane === 'demand' && visible()) load();
      } catch (err) {
        if (node.contains(status)) status.textContent = cleanError(err);
      } finally {
        delete receive.dataset.damageBusy;
        receive.disabled = close.disabled = false;
      }
    };
  }

  async function openDetail(id) {
    const run = ++detailRun;
    const message = el('damageStatus');
    try {
      const d = await call('getDamageDemand', {id});
      if (run === detailRun && visible()) renderDetail(d);
    } catch (err) {
      if (run === detailRun && message.isConnected) message.textContent = cleanError(err);
    }
  }

  async function exportReport() {
    const target = state;
    const button = el('damageExport');
    const message = el('damageStatus');
    if (Object.hasOwn(el('damageFilters').dataset, 'unsavedFilters')) {
      message.textContent = 'Apply filters before downloading the report.';
      return;
    }
    const filters = {...target.filters, status: target.listStatus};
    button.disabled = true;
    message.textContent = 'Building Excel report…';
    try {
      const report = await call('getDamageReport', filters);
      if (state !== target) return;
      await WlfExports.excel([
        {name: 'Damage demands', headers: reportColumns.map(([name]) => name),
          rows: report.rows.map(row => reportColumns.map(([, value]) => value(row)))},
        {name: 'Component breakdown', headers: ['Component', 'Damaged units', 'Demand count', 'Share (%)'],
          rows: report.components.map(row => [row.label, row.units, row.demands, row.percentage])}
      ], 'WLF-Damage-Demand-' + AccessCore.dateKey(new Date()));
      message.textContent = `Excel downloaded for ${report.total} demand(s).`;
    } catch (err) {
      message.textContent = cleanError(err);
    } finally {
      button.disabled = false;
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelector('#nav [data-tab="ri-projects"]').insertAdjacentHTML('afterend',
      '<button data-tab="damage-demand" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 7l9-4 9 4v10l-9 4-9-4zm0 0l9 4 9-4m-9 4v10"/></svg>Damage Demand</button>');
    // v2.5.3: Demand / Dashboard are chosen with the buttons at the top of the page, not in the menu.
    document.querySelector('.content').insertAdjacentHTML('beforeend', '<section id="tab-damage-demand" class="tab-content hidden"></section>');
    document.body.insertAdjacentHTML('beforeend', '<dialog id="wlfDamageDialog" aria-labelledby="damageDialogTitle"></dialog>');
    PAGES['damage-demand'] = ['Damage Demand', 'Replacement demands and component damage reports'];
  });

  function reset() {
    state = null;
    detailRun++;
    const node = el('wlfDamageDialog');
    if (node?.open) node.close();
    node?.replaceChildren();
    el('tab-damage-demand')?.replaceChildren();
  }

  window.addEventListener('wlf-logout', reset);
  window.addEventListener('wlf-ready', reset);
  return {open, supportSummary, supportInputs, readReview, bindSupport};
})();
