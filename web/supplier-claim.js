/* WLF v2.5.4: Supplier Claim menu. A damage demand with "Supplier Confirmed = Yes" waits here as Pending
   until the goods physically arrive, then it is marked Received. It does not change the demand's own status. */
const WlfSupplier = (() => {
  'use strict';
  const el = id => document.getElementById(id);
  const h = value => esc(String(value ?? ''));
  const time = value => value ? new Date(value).toLocaleString('en-GB', {timeZone: 'Asia/Dhaka'}) : '';
  const teamName = key => (AccessCore.supportTitles[key] || key).replace(/ Team Support Request$/, '');
  const visible = () => !el('tab-supplier-claim')?.classList.contains('hidden');
  let filter = 'Pending', data = null, run = 0;

  async function call(action, payload) {
    const account = SESSION;
    const result = await rpc(action, [T(), payload]);
    if (account !== SESSION) throw Error('Session changed.');
    return result;
  }

  function badge(status) {
    return `<span class="support-status status-${status === 'Received' ? 'received' : 'pending'}">${h(status)}</span>`;
  }

  function render(message = '') {
    const root = el('tab-supplier-claim');
    if (!root || !data) return;
    const tab = (name, count) => `<button type="button" class="damage-metric" data-sc-filter="${name}" aria-pressed="${filter === name}"><b>${count ?? ''}</b><span>${name === 'All' ? 'All' : name}</span></button>`;
    const rows = data.items;
    root.innerHTML = `<section class="card supplier-card" aria-labelledby="scTitle">
      <h3 id="scTitle">Supplier Claim</h3>
      <p class="note">Damage demands where Supplier Confirmed = Yes. They stay Pending until the goods are physically received from the supplier.</p>
      <div class="damage-metrics supplier-filters" role="group" aria-label="Status">
        ${tab('Pending', data.pending)}${tab('Received', data.received)}${tab('All', data.pending + data.received)}
      </div>
      <p id="scStatus" role="status" aria-live="polite">${h(message)}</p>
      ${rows.length ? `<div class="tbl-wrap" tabindex="0" aria-label="Supplier claims"><table class="tbl supplier-table">
        <thead><tr>${['Demand', 'Team', 'Item', 'Quantity', 'Supplier', 'Confirmed (Dhaka)', 'Status', ''].map(x => `<th scope="col">${h(x)}</th>`).join('')}</tr></thead>
        <tbody>${rows.map(d => `<tr>
          <td data-label="Demand"><b>${h(d.reference)}</b><small>${h(d.requestReference)}</small></td>
          <td data-label="Team">${h(teamName(d.category))}<small>${h(d.project || '')}</small></td>
          <td data-label="Item">${h(d.itemName)}<small>${h([d.itemCode, d.itemSpec].filter(Boolean).join(' · '))}</small></td>
          <td data-label="Quantity">${h(d.quantity)}</td>
          <td data-label="Supplier">${h(d.supplier.name)}<small>${h(d.supplier.date || '')}${d.supplier.note ? ' · ' + h(d.supplier.note) : ''}</small></td>
          <td data-label="Confirmed (Dhaka)">${h(time(d.supplier.confirmAt))}<small>${h(d.supplier.confirmBy)}</small></td>
          <td data-label="Status">${badge(d.supplier.status)}${d.supplier.status === 'Received' ? `<small>${h(d.supplier.receivedBy)} · ${h(time(d.supplier.receivedAt))}</small>` : ''}</td>
          <td class="sc-act">${d.supplier.status === 'Pending' && data.canReceive ? `<button type="button" class="btn" data-sc-receive="${h(d.id)}">Received</button>` : ''}</td>
        </tr>`).join('')}</tbody></table></div>`
        : `<p class="note supplier-empty">${filter === 'Pending' ? 'Nothing is waiting for the supplier.' : 'No records.'}</p>`}
    </section>`;
    root.querySelectorAll('[data-sc-filter]').forEach(b => b.onclick = () => { filter = b.dataset.scFilter; load(); });
    root.querySelectorAll('[data-sc-receive]').forEach(b => b.onclick = async () => {
      if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Click again: goods received'; return; }
      b.disabled = true;
      try {
        await call('receiveSupplierClaim', {id: b.dataset.scReceive});
        await load('Marked as Received.');
        if (typeof WlfAdmin !== 'undefined') WlfAdmin.refreshBadges(true);
      } catch (err) { b.disabled = false; el('scStatus').textContent = cleanError(err); }
    });
  }

  async function load(message = '') {
    const mine = ++run;
    try {
      const result = await call('getSupplierClaims', {status: filter});
      if (mine !== run || !visible()) return;
      data = result;
      render(message);
    } catch (err) {
      if (mine === run && el('tab-supplier-claim')) el('tab-supplier-claim').innerHTML = `<section class="card"><p role="alert">${h(cleanError(err))}</p></section>`;
    }
  }

  function open() { filter = 'Pending'; data = null; load(); }
  function refresh() { if (visible()) load(); else if (typeof WlfAdmin !== 'undefined') WlfAdmin.refreshBadges(true); }

  document.addEventListener('DOMContentLoaded', () => {
    const anchor = document.querySelector('#nav [data-tab="damage-demand"]') || document.querySelector('#nav [data-tab="ri-projects"]');
    anchor.insertAdjacentHTML('afterend', '<button data-tab="supplier-claim" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 18V6a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v11h2"/><path d="M14 9h4l4 4v4h-2"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/></svg>Supplier Claim</button>');
    document.querySelector('.content').insertAdjacentHTML('beforeend', '<section id="tab-supplier-claim" class="tab-content hidden"></section>');
    PAGES['supplier-claim'] = ['Supplier Claim', 'Damaged items claimed from the supplier, waiting for the goods'];
  });
  const clear = () => { run++; data = null; if (el('tab-supplier-claim')) el('tab-supplier-claim').replaceChildren(); };
  window.addEventListener('wlf-logout', clear);
  return {open, refresh};
})();
