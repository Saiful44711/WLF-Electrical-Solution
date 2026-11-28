/* WLF v2.5.3: red counts in the menu, announcements, My work breakdown, the Usage Dashboard
   activity log and the Super Admin recycle bin. Every rule is checked again by the server. */
const WlfAdmin = (() => {
  'use strict';
  const el = id => document.getElementById(id);
  const h = v => esc(String(v ?? ''));
  const n = v => Number(v || 0).toLocaleString('en-GB');
  const clock = new Intl.DateTimeFormat('en-GB', {timeZone:'Asia/Dhaka', day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit'});
  const day = new Intl.DateTimeFormat('en-GB', {timeZone:'Asia/Dhaka', day:'numeric', month:'short', year:'numeric'});
  const when = v => v ? clock.format(new Date(v)) : '—';
  const onDay = v => v ? day.format(new Date(String(v).length === 10 ? v + 'T00:00:00+06:00' : v)) : '—';
  const sa = () => !!SESSION && SESSION.role === 'Super Admin' && SESSION.status === 'Approved';
  const annAllowed = () => !!SESSION && SESSION.status === 'Approved' && (SESSION.role === 'Super Admin' || (SESSION.permissions || []).includes('announcements:manage'));
  const today = () => AccessCore.dateKey(new Date());
  const monthStart = () => today().slice(0, 8) + '01';
  const team = c => String((AccessCore.supportTitles && AccessCore.supportTitles[c]) || c).replace(/ Team Support Request$/, '').replace(/ Support Request$/, '');
  const KIND = {request:'Support request', 'ri-entry':'R&I entry', project:'Project', task:'Project task', troubleshooting:'Troubleshooting',
    document:'Document link', 'doc-category':'Document sub menu', 'doc-folder':'Folder', announcement:'Announcement', 'qms-lift':'QMS lift record'};
  let epoch = 0;

  /* ------------------------------------------------------------ confirm dialog */
  function ask({title, text, button = 'Delete permanently', typed = ''}) {
    const d = el('wlfAdminDialog');
    d.innerHTML = `<h2 id="wlfAdminDialogTitle">${h(title)}</h2><p>${text}</p>
      ${typed ? `<label class="admin-typed"><span>Type <b>${h(typed)}</b> to confirm</span><input id="wlfAdminTyped" autocomplete="off" autocapitalize="characters" spellcheck="false"></label>` : ''}
      <div class="engineering-actions"><button type="button" class="btn danger" id="wlfAdminYes" ${typed ? 'disabled' : ''}>${h(button)}</button>
      <button type="button" class="btn ghost" id="wlfAdminNo">Cancel</button></div>`;
    return new Promise(resolve => {
      const done = v => { d.close(); resolve(v); };
      el('wlfAdminNo').onclick = () => done(false);
      d.oncancel = e => { e.preventDefault(); done(false); };
      el('wlfAdminYes').onclick = () => done(true);
      if (typed) el('wlfAdminTyped').oninput = e => { el('wlfAdminYes').disabled = e.target.value.trim() !== typed; };
      d.showModal();
      (typed ? el('wlfAdminTyped') : el('wlfAdminNo')).focus();
    });
  }

  /* ------------------------------------------------------------ red counts in the menu */
  let badgeBusy = false, badgeAt = 0;
  function setBadge(selector, id, count, title) {
    const button = document.querySelector(selector);
    if (!button) return;
    let b = el(id);
    if (!b) { button.insertAdjacentHTML('beforeend', `<span class="badge-count nav-badge" id="${id}" hidden></span>`); b = el(id); }
    b.textContent = count > 99 ? '99+' : String(count);
    b.hidden = !count;
    b.title = title;
    b.setAttribute('aria-label', title);
  }
  function paintBadges(x) {
    const fw = Number(x.forwarded || 0), an = Number(x.announcements || 0), dm = Number(x.damagePending || 0);
    setBadge('#nav button[data-tab="account"]', 'profileNavBadge', fw + an,
      [fw ? fw + ' forwarded to you' : '', an ? an + ' unread announcement' + (an > 1 ? 's' : '') : ''].filter(Boolean).join(' · ') || 'Nothing new');
    setBadge('#nav button[data-tab="damage-demand"]', 'damageNavBadge', dm, dm + ' pending demand' + (dm === 1 ? '' : 's'));
    const sc = Number(x.supplierPending || 0);
    setBadge('#nav button[data-tab="supplier-claim"]', 'supplierNavBadge', sc, sc + ' Supplier Claim' + (sc === 1 ? '' : 's') + ' waiting for goods');
  }
  async function refreshBadges(force) {
    if (!SESSION || badgeBusy || !navigator.onLine || (!force && Date.now() - badgeAt < 15000)) return;
    const run = epoch;
    badgeBusy = true; badgeAt = Date.now();
    try { const x = await rpc('getNavBadges', [T()]); if (run === epoch && SESSION) { paintBadges(x); if (Number(x.announcements || 0) > 0) announcementPopup(); } }
    catch (err) { /* the menu keeps its last counts */ }
    finally { badgeBusy = false; }
  }

  /* ------------------------------------------------------------ announcements on My Profile */
  async function loadAnnouncements() {
    const card = el('announceCard');
    if (!card || !SESSION) return;
    const run = epoch;
    try {
      const {items} = await rpc('getAnnouncements', [T()]);
      if (run !== epoch) return;
      const unread = items.filter(x => !x.read), read = items.filter(x => x.read);
      card.hidden = !items.length;
      const item = x => `<li class="announce-item${x.read ? ' read' : ''}"><div><b>${h(x.title)}</b>
          ${x.body ? `<p>${h(x.body)}</p>` : ''}<small>${h(x.by)} · ${h(when(x.updatedAt || x.at))}${x.expiresOn ? ' · until ' + h(onDay(x.expiresOn)) : ''}</small></div>
          ${x.read ? '<span class="overview-pill">Read</span>' : `<button type="button" class="btn" data-ann-read="${h(x.id)}">Read</button>`}</li>`;
      card.innerHTML = `<div class="card-head"><div class="card-icon ci-rose"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11v2a1 1 0 0 0 1 1h3l5 4V6L7 10H4a1 1 0 0 0-1 1z"/><path d="M16 9a3 3 0 0 1 0 6M19 6a7 7 0 0 1 0 12"/></svg></div>
        <div><h3>Announcements <span class="team-badge"${unread.length ? '' : ' hidden'}>${unread.length}</span></h3><p>Notices from Super Admin for your section. Press Read when you have seen one.</p></div></div>
        ${unread.length ? `<ul class="announce-list">${unread.map(item).join('')}</ul>` : '<p class="note">No new announcements.</p>'}
        ${read.length ? `<details class="announce-old"><summary>Read earlier (${read.length})</summary><ul class="announce-list">${read.map(item).join('')}</ul></details>` : ''}`;
      card.querySelectorAll('[data-ann-read]').forEach(b => b.onclick = async () => {
        b.disabled = true;
        try { await rpc('markAnnouncementRead', [T(), {id:b.dataset.annRead}]); await loadAnnouncements(); refreshBadges(true); }
        catch (err) { b.disabled = false; showMsg(cleanError(err), 'error'); }
      });
    } catch (err) { if (run === epoch && !card.innerHTML) card.hidden = true; }
  }

  /* ------------------------------------------------------------ v2.7.3: unread announcements open as a pop-up that stays until OK is pressed */
  let popupOpen = false;
  const popupSkipped = new Set();   // ones that could not be marked as read (offline): not shown again until the next sign-in
  function announcementDialog(x, index, total) {
    let d = el('wlfAnnouncePopup');
    if (!d) { d = document.createElement('dialog'); d.id = 'wlfAnnouncePopup'; d.className = 'wlf-announce-popup'; d.setAttribute('aria-labelledby', 'wlfAnnounceTitle'); document.body.appendChild(d); }
    d.innerHTML = `<div class="wlf-announce-body"><div class="wlf-announce-icon" aria-hidden="true"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11v2a1 1 0 0 0 1 1h3l5 4V6L7 10H4a1 1 0 0 0-1 1z"/><path d="M16 9a3 3 0 0 1 0 6"/></svg></div>
      <p class="wlf-announce-count">Announcement${total > 1 ? ' ' + (index + 1) + ' of ' + total : ''}</p>
      <h3 id="wlfAnnounceTitle">${h(x.title)}</h3>
      ${x.body ? `<div class="wlf-announce-text">${h(x.body)}</div>` : ''}
      <small>${h(x.by)} · ${h(when(x.updatedAt || x.at))}${x.expiresOn ? ' · until ' + h(onDay(x.expiresOn)) : ''}</small>
      <p class="wlf-announce-error" id="wlfAnnounceError" role="alert" hidden></p>
      <button type="button" class="btn" id="wlfAnnounceOk" autofocus>OK, I have read it</button></div>`;
    return new Promise(resolve => {
      const finish = () => { d.removeEventListener('close', finish); resolve(); };
      d.addEventListener('close', finish);
      d.oncancel = e => e.preventDefault();          // Escape does not close it: only OK does
      d.onclick = null;                              // a click outside does not close it either
      el('wlfAnnounceOk').onclick = async e => {
        const b = e.currentTarget; b.disabled = true;
        try { await rpc('markAnnouncementRead', [T(), {id: x.id}]); }
        catch (err) { popupSkipped.add(x.id); }      // offline: the notice stays unread and shows again at the next sign-in
        d.close();
      };
      try { d.showModal(); } catch (_) { d.setAttribute('open', ''); }
    });
  }
  async function announcementPopup() {
    if (!SESSION || popupOpen || !navigator.onLine) return;
    const run = epoch;
    popupOpen = true;
    try {
      const {items} = await rpc('getAnnouncements', [T()]);
      if (run !== epoch) return;
      const queue = items.filter(x => !x.read && !popupSkipped.has(x.id));
      for (let i = 0; i < queue.length; i++) {
        if (run !== epoch || !SESSION) break;
        await announcementDialog(queue[i], i, queue.length);
      }
    } catch (err) { /* the pop-up never blocks the app */ }
    finally { popupOpen = false; }
    if (run === epoch && SESSION) { loadAnnouncements(); refreshBadges(true); }
  }

  /* ------------------------------------------------------------ Usage Dashboard: activity log (7 days), From-To delete, component change log */
  let usage = {member:'', offset:0, before:null, downloaded:false};
  async function usageLog(state) {
    const card = el('usageLogCard');
    if (!card || !SESSION) return;
    const run = epoch;
    usage = {...usage, ...(state || {})};
    try {
      const x = await rpc('getUsageLog', [T(), {member:usage.member, offset:usage.offset}]);
      if (run !== epoch || !card.isConnected) return;
      const people = x.people || [];
      const old = x.old && Number(x.old.count) ? x.old : null;
      const end = Math.min(Number(x.total), usage.offset + 200);
      card.innerHTML = `${old ? `<div class="msg warn usage-old" role="alert"><b>${n(old.count)} activity log rows are older than 7 days</b> (oldest ${h(when(old.oldest))}).
          Rows older than 7 days are saved to Google Drive (folder WLF Activity backup) and then deleted automatically while you use the app. You can also download them as Excel now, or delete them now to free the space.
          <div class="engineering-actions"><button type="button" class="btn" id="usageOldDownload">Download old log (Excel)</button>
          <button type="button" class="btn danger" id="usageOldDelete" ${usage.downloaded ? '' : 'disabled'}>Delete old log…</button></div>
          <p class="note" id="usageOldStatus" role="status">${usage.downloaded ? 'Downloaded. You can delete the old rows now.' : 'Delete becomes available after the download.'}</p></div>` : ''}
        <div class="card"><div class="card-head"><div class="card-icon ci-indigo"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg></div>
          <div><h3>Activity log · last 7 days</h3><p>Who used what, newest first (Dhaka time)</p></div></div>
          ${people.length ? `<label class="usage-filter">User<select id="usageMember"><option value="">All users</option>${people.map(p => WlfFields.option(p.id, p.name, usage.member)).join('')}</select></label>` : ''}
          ${x.rows.length ? `<div class="tbl-wrap"><table class="tbl" id="usageLogTable"><thead><tr><th>When</th><th>User</th><th>Activity</th><th>Details</th></tr></thead><tbody>${x.rows.map(r =>
            `<tr><td>${h(when(r.at))}</td><td>${h(r.who)}</td><td>${h(r.action)}</td><td>${h(r.details)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="note">No activity in the last 7 days.</p>'}
          ${Number(x.total) > 200 ? `<div class="overview-paging"><button class="btn ghost" type="button" id="usagePrev" ${usage.offset ? '' : 'disabled'}>Previous</button>
            <span>${n(usage.offset + 1)}–${n(end)} of ${n(x.total)}</span><button class="btn ghost" type="button" id="usageNext" ${end < Number(x.total) ? '' : 'disabled'}>Next</button></div>` : `<p class="note">${n(x.total)} entries</p>`}
        </div>${x.all ? rangeBox(x.all) : ''}`;
      if (x.all) bindRange();
      if (el('usageMember')) el('usageMember').onchange = e => usageLog({member:e.target.value, offset:0});
      if (el('usagePrev')) { el('usagePrev').onclick = () => usageLog({offset:Math.max(0, usage.offset - 200)}); el('usageNext').onclick = () => usageLog({offset:usage.offset + 200}); }
      if (old) { el('usageOldDownload').onclick = downloadOldLog; el('usageOldDelete').onclick = deleteOldLog; }
    } catch (err) { if (run === epoch && card.isConnected) card.innerHTML = `<div class="msg error">${h(cleanError(err))}</div>`; }
  }
  function rangeBox(all) {
    return `<form class="card usage-range" id="usageRangeForm"><div class="overview-heading"><div><h3>Delete activity log by date</h3>
      <p class="note">Super Admin only. Removes every activity log row between the two Dhaka dates (both days included), also rows of the last 7 days. It cannot be undone.
      Stored now: ${n(all.count)} rows${all.oldest ? ` (${h(when(all.oldest))} to ${h(when(all.newest))})` : ''}.</p></div></div>
      <div class="overview-filters"><label>From<input type="date" name="from" required value="${h(range.from)}"></label>
      <label>To<input type="date" name="to" required value="${h(range.to)}"></label>
      <button type="submit" class="btn ghost">Check rows</button>
      <button type="button" class="btn danger" id="usageRangeDelete" ${range.checked ? '' : 'disabled'}>Delete rows…</button></div>
      <p class="note" id="usageRangeStatus" role="status">${range.checked ? h(range.checked) : 'Choose the dates and press Check rows first.'}</p></form>`;
  }
  let range = {from:'', to:'', count:null, checked:''};
  function bindRange() {
    const f = el('usageRangeForm'), s = el('usageRangeStatus');
    f.onsubmit = async e => {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(f));
      range = {from:v.from, to:v.to, count:null, checked:''};
      el('usageRangeDelete').disabled = true;
      s.textContent = 'Counting…';
      try {
        const x = await rpc('countUsageRange', [T(), {from:v.from, to:v.to}]);
        range.count = Number(x.count);
        range.checked = n(x.count) + ' activity log rows from ' + x.from + ' to ' + x.to + '.';
        s.textContent = range.checked;
        el('usageRangeDelete').disabled = !range.count;
      } catch (err) { s.textContent = cleanError(err); }
    };
    f.from.oninput = f.to.oninput = f.from.onchange = f.to.onchange = () => { range = {from:f.from.value, to:f.to.value, count:null, checked:''}; el('usageRangeDelete').disabled = true; s.textContent = 'Press Check rows again.'; };
    el('usageRangeDelete').onclick = async () => {
      if (!range.count) return;
      if (!await ask({title:'Delete the activity log of this period?', text:n(range.count) + ' rows from ' + range.from + ' to ' + range.to + ' will be removed from the database for good.', button:'Delete rows', typed:'DELETE'})) return;
      try {
        const x = await rpc('purgeUsageRange', [T(), {from:range.from, to:range.to, confirm:'DELETE'}]);
        range = {from:range.from, to:range.to, count:null, checked:n(x.deleted) + ' rows deleted (' + x.from + ' to ' + x.to + ').'};
        showMsg(n(x.deleted) + ' activity log rows deleted.', 'success');
        usageLog({offset:0});
        if (typeof loadStats === 'function') loadStats();
      } catch (err) { s.textContent = cleanError(err); }
    };
  }

  let clog = {from:'', to:'', q:'', rows:[]};
  function componentLogAllowed() {
    const u = SESSION || {}, p = u.permissions || [];
    return u.role === 'Super Admin' || p.includes('components:log');
  }
  async function componentLog(state) {
    const card = el('componentLogCard');
    if (!card || !SESSION) return;
    if (!componentLogAllowed()) { card.innerHTML = ''; return; }
    const run = epoch;
    clog = {...clog, ...(state || {})};
    try {
      const x = await rpc('getComponentLog', [T(), {from:clog.from, to:clog.to, q:clog.q}]);
      if (run !== epoch || !card.isConnected) return;
      clog.from = x.from; clog.to = x.to; clog.rows = x.rows;
      const changes = r => r.changes.map(c => r.action === 'Edited'
        ? `<li><b>${h(c.field)}</b>: <s>${h(c.old || '—')}</s> → ${h(c.new || '—')}</li>`
        : `<li><b>${h(c.field)}</b>: ${h(r.action === 'Deleted' ? c.old : c.new)}</li>`).join('');
      card.innerHTML = `<form class="card" id="componentLogForm"><div class="card-head"><div class="card-icon ci-teal"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v4l3 2"/><circle cx="12" cy="12" r="9"/></svg></div>
          <div><h3>Component change log</h3><p>Who added, edited or deleted Components Data (Dhaka time)</p></div></div>
        <div class="overview-filters"><label>From<input type="date" name="from" value="${h(clog.from)}"></label><label>To<input type="date" name="to" value="${h(clog.to)}"></label>
          <label>Search<input type="search" name="q" value="${h(clog.q)}" placeholder="Model, user, field…" autocomplete="off"></label>
          <button type="submit" class="btn ghost">Show</button><button type="button" class="btn ghost" id="componentLogExcel" ${x.rows.length ? '' : 'disabled'}>Excel</button></div>
        ${x.rows.length ? `<div class="tbl-wrap"><table class="tbl" id="componentLogTable"><thead><tr><th>When</th><th>User</th><th>Change</th><th>Component</th><th>Fields</th></tr></thead><tbody>${x.rows.map(r =>
          `<tr><td>${h(when(r.at))}</td><td>${h(r.who)}</td><td><span class="clog-${h(r.action.toLowerCase())}">${h(r.action)}</span></td><td>${h(r.label)}</td><td><ul class="clog-changes">${changes(r)}</ul></td></tr>`).join('')}</tbody></table></div>`
          : '<p class="note">No component changes in this period.</p>'}
        <p class="note">${n(x.total)} ${Number(x.total) === 1 ? 'change' : 'changes'}${Number(x.total) > x.rows.length ? ' · showing the newest ' + n(x.rows.length) : ''}</p></form>`;
      el('componentLogForm').onsubmit = e => { e.preventDefault(); componentLog(Object.fromEntries(new FormData(e.currentTarget))); };
      el('componentLogExcel').onclick = async () => {
        await WlfExports.excel([{name:'Component change log', headers:['When (Dhaka)', 'User', 'Change', 'Component', 'Field', 'Old value', 'New value'],
          rows:clog.rows.flatMap(r => (r.changes.length ? r.changes : [{field:'', old:'', new:''}]).map(c => [when(r.at), r.who, r.action, r.label, c.field, c.old, c.new]))}],
          'WLF-Component-Change-Log-' + clog.from + '-to-' + clog.to);
      };
    } catch (err) { if (run === epoch && card.isConnected) card.innerHTML = `<div class="msg error">${h(cleanError(err))}</div>`; }
  }
  /* v2.7.4: the Component change log sits at the top of Components Data; a person who has only the log (given by the Super Admin) sees only the log */
  function mountComponentLog() {
    const tabNode = el('tab-components');
    if (!tabNode || !SESSION) return;
    if (!el('componentLogCard')) tabNode.insertAdjacentHTML('afterbegin', '<div id="componentLogCard"></div>');
    tabNode.classList.toggle('log-only', SESSION.role !== 'Super Admin');
    componentLog();
  }
  async function downloadOldLog() {
    const b = el('usageOldDownload'), s = el('usageOldStatus');
    b.disabled = true;
    try {
      let rows = [], after = 0, before = null;
      for (;;) {
        s.textContent = 'Reading old log… ' + n(rows.length) + ' rows';
        const x = await rpc('exportOldUsageLog', [T(), {afterId:after, before}]);
        before = x.before; rows = rows.concat(x.rows);
        if (x.rows.length < 5000) break;
        after = x.rows.at(-1).id;
      }
      await WlfExports.excel([{name:'Activity log', headers:['When (Dhaka)', 'User', 'Activity', 'Details'], rows:rows.map(r => [when(r.at), r.who, r.action, r.details])}],
        'WLF-Activity-Log-before-' + AccessCore.dateKey(new Date(before)));
      usage.before = before; usage.downloaded = true;
      el('usageOldDelete').disabled = false;
      s.textContent = 'Downloaded ' + n(rows.length) + ' rows. Check the file, then you can delete them.';
    } catch (err) { s.textContent = cleanError(err); }
    finally { b.disabled = false; }
  }
  async function deleteOldLog() {
    if (!usage.downloaded || !usage.before) return;
    if (!await ask({title:'Delete the old activity log?', text:'All activity log rows older than 7 days (that you downloaded) will be removed from the database for good.', button:'Delete old log', typed:'DELETE'})) return;
    const s = el('usageOldStatus');
    try {
      const x = await rpc('purgeUsageLog', [T(), {before:usage.before, confirm:'DELETE'}]);
      usage.downloaded = false; usage.before = null;
      showMsg(n(x.deleted) + ' old activity log rows deleted.', 'success');
      usageLog({offset:0});
    } catch (err) { if (s) s.textContent = cleanError(err); }
  }

  /* ------------------------------------------------------------ Recycle bin */
  let bin = {items:[], purges:[], kind:'', query:'', selected:new Set()};
  async function loadBin(message) {
    const root = el('tab-recycle-bin');
    if (!root || !sa()) return;
    const run = epoch;
    if (!root.innerHTML) root.innerHTML = '<p class="note">Loading…</p>';
    try {
      const x = await rpc('getRecycleBin', [T()]);
      if (run !== epoch) return;
      bin.items = x.items; bin.purges = x.purges;
      bin.selected = new Set([...bin.selected].filter(id => x.items.some(i => String(i.id) === id)));
      renderBin(message);
    } catch (err) { if (run === epoch) root.innerHTML = `<div class="msg error">${h(cleanError(err))}</div>`; }
  }
  function renderBin(message = '') {
    const root = el('tab-recycle-bin');
    const q = bin.query.trim().toLowerCase();
    const rows = bin.items.filter(i => (!bin.kind || i.kind === bin.kind) && (!q || (i.label + ' ' + i.detail + ' ' + i.deletedBy).toLowerCase().includes(q)));
    const kinds = [...new Set(bin.items.map(i => i.kind))];
    root.innerHTML = `<div class="card"><div class="card-head"><div class="card-icon ci-rose"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6"/></svg></div>
        <div><h3>Recycle bin <span class="overview-pill">${n(bin.items.length)}</span></h3><p>Everything deleted in the app waits here until you restore it or delete it permanently. Nothing is removed automatically.</p></div></div>
        <div class="bin-tools">
          <label>Type<select id="binKind"><option value="">All types</option>${kinds.map(k => WlfFields.option(k, KIND[k] || k, bin.kind)).join('')}</select></label>
          <label>Search<input id="binQuery" value="${h(bin.query)}" placeholder="Name, reference, person"></label>
          <div class="engineering-actions"><button type="button" class="btn ghost" id="binRefresh">Refresh</button>
            <button type="button" class="btn danger" id="binDeleteSelected" ${bin.selected.size ? '' : 'disabled'}>Delete selected permanently (${bin.selected.size})</button>
            <button type="button" class="btn danger ghost-danger" id="binEmpty" ${bin.items.length ? '' : 'disabled'}>Empty bin</button></div>
        </div>
        <p class="note" id="binStatus" role="status">${h(message)}</p>
        ${rows.length ? `<div class="tbl-wrap"><table class="tbl bin-table" id="binTable"><thead><tr><th><input type="checkbox" id="binAll" aria-label="Select all shown"></th><th>Item</th><th>Type</th><th>Deleted by</th><th>Deleted</th><th>Actions</th></tr></thead><tbody>
          ${rows.map(i => `<tr data-bin-row="${h(i.id)}"><td><input type="checkbox" data-bin-pick="${h(i.id)}" ${bin.selected.has(String(i.id)) ? 'checked' : ''} aria-label="Select ${h(i.label)}"></td>
            <td><b>${h(i.label)}</b><small>${h(i.detail)}</small></td><td><span class="bin-kind" data-kind="${h(i.kind)}">${h(KIND[i.kind] || i.kind)}</span></td>
            <td>${h(i.deletedBy || '—')}</td><td>${h(when(i.deletedAt))}</td>
            <td class="bin-actions"><button type="button" class="btn" data-bin-restore="${h(i.id)}">Restore</button><button type="button" class="btn danger" data-bin-purge="${h(i.id)}">Delete permanently</button></td></tr>`).join('')}
          </tbody></table></div>` : `<p class="note">${bin.items.length ? 'Nothing matches the filter.' : 'The recycle bin is empty.'}</p>`}
      </div>
      <details class="card bin-log"><summary><b>Permanent delete log</b> <small>(who, when, how many — no content is kept)</small></summary>
        ${bin.purges.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>When</th><th>By</th><th>Action</th><th>Removed</th></tr></thead><tbody>${bin.purges.map(p =>
          `<tr><td>${h(when(p.at))}</td><td>${h(p.by)}</td><td>${h(p.what)}</td><td>${h(Object.entries(p.counts || {}).map(([k, v]) => (KIND[k] || (k === 'usage-log' ? 'Activity log rows' : k)) + ': ' + v).join(', '))}</td></tr>`).join('')}</tbody></table></div>` : '<p class="note">Nothing has been deleted permanently yet.</p>'}
      </details>`;
    el('binKind').onchange = e => { bin.kind = e.target.value; renderBin(); };
    el('binQuery').oninput = e => { bin.query = e.target.value; const pos = e.target.selectionStart; renderBin(); const q = el('binQuery'); q.focus(); q.setSelectionRange(pos, pos); };
    el('binRefresh').onclick = () => loadBin();
    if (el('binAll')) el('binAll').onchange = e => { rows.forEach(i => e.target.checked ? bin.selected.add(String(i.id)) : bin.selected.delete(String(i.id))); renderBin(); };
    root.querySelectorAll('[data-bin-pick]').forEach(c => c.onchange = () => { c.checked ? bin.selected.add(c.dataset.binPick) : bin.selected.delete(c.dataset.binPick); renderBin(); });
    root.querySelectorAll('[data-bin-restore]').forEach(b => b.onclick = () => restore(b.dataset.binRestore, b));
    root.querySelectorAll('[data-bin-purge]').forEach(b => b.onclick = () => purge([b.dataset.binPurge]));
    el('binDeleteSelected').onclick = () => purge([...bin.selected]);
    el('binEmpty').onclick = emptyBin;
  }
  async function restore(id, button) {
    const item = bin.items.find(i => String(i.id) === String(id));
    button.disabled = true;
    try {
      await rpc('restoreRecycleItem', [T(), {id:Number(id)}]);
      bin.selected.delete(String(id));
      await loadBin('Restored: ' + (item ? item.label : 'item') + '. It is back where it was.');
    } catch (err) { button.disabled = false; el('binStatus').textContent = cleanError(err); }
  }
  function summary(ids) {
    const c = {};
    ids.forEach(id => { const i = bin.items.find(x => String(x.id) === String(id)); if (i) c[i.kind] = (c[i.kind] || 0) + 1; });
    return Object.entries(c).map(([k, v]) => v + ' × ' + (KIND[k] || k)).join(', ');
  }
  async function purge(ids) {
    if (!ids.length) return;
    const one = ids.length === 1 && bin.items.find(i => String(i.id) === String(ids[0]));
    const extra = ids.some(id => (bin.items.find(i => String(i.id) === String(id)) || {}).kind === 'request') ? ' Support requests are removed with their history and damage demand.' : '';
    if (!await ask({title:'Delete permanently?', text:`<b>${n(ids.length)} item${ids.length > 1 ? 's' : ''}</b> (${h(summary(ids))})${one ? ' — “' + h(one.label) + '”' : ''} will be removed from the database for good. This cannot be undone.${h(extra)}`})) return;
    try {
      const x = await rpc('purgeRecycleItems', [T(), {ids:ids.map(Number)}]);
      ids.forEach(id => bin.selected.delete(String(id)));
      await loadBin(n(x.deleted) + ' item(s) deleted permanently.');
    } catch (err) { el('binStatus').textContent = cleanError(err); }
  }
  async function emptyBin() {
    if (!bin.items.length) return;
    if (!await ask({title:'Empty the recycle bin?', text:`${bin.items.length === 1 ? 'The only item' : 'All <b>' + n(bin.items.length) + ' items</b>'} (${h(summary(bin.items.map(i => i.id)))}) will be removed from the database for good. This cannot be undone.`, button:'Empty bin', typed:'DELETE'})) return;
    try {
      const x = await rpc('purgeRecycleItems', [T(), {all:true, confirm:'DELETE'}]);
      bin.selected.clear();
      await loadBin('Recycle bin emptied: ' + n(x.deleted) + ' item(s) deleted permanently.');
    } catch (err) { el('binStatus').textContent = cleanError(err); }
  }

  /* ------------------------------------------------------------ Announcement (Super Admin) */
  let ann = {items:[], sections:[], editing:null};
  async function loadAnnAdmin(message) {
    const root = el('tab-announcements');
    if (!root || !annAllowed()) return;
    const run = epoch;
    if (!root.innerHTML) root.innerHTML = '<p class="note">Loading…</p>';
    try {
      const x = await rpc('getAnnouncementAdmin', [T()]);
      if (run !== epoch) return;
      ann.items = x.items; ann.sections = x.sections;
      renderAnnAdmin(message);
    } catch (err) { if (run === epoch) root.innerHTML = `<div class="msg error">${h(cleanError(err))}</div>`; }
  }
  function renderAnnAdmin(message = '') {
    const root = el('tab-announcements'), e = ann.editing;
    const all = !e || !e.sections.length;
    root.innerHTML = `<form class="card" id="annForm"><div class="card-head"><div class="card-icon ci-rose"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11v2a1 1 0 0 0 1 1h3l5 4V6L7 10H4a1 1 0 0 0-1 1z"/><path d="M16 9a3 3 0 0 1 0 6M19 6a7 7 0 0 1 0 12"/></svg></div>
        <div><h3>${e ? 'Edit announcement' : 'New announcement'}</h3><p>Shown on My Profile of the chosen sections, with a red count in the menu and a phone/PC notification.</p></div></div>
        <div class="field"><label for="annTitle">Title *</label><input id="annTitle" name="title" maxlength="150" required value="${h(e?.title)}"></div>
        <div class="field"><label for="annBody">Message</label><textarea id="annBody" name="body" rows="4" maxlength="4000">${h(e?.body)}</textarea></div>
        <fieldset class="ann-sections"><legend>Sections *</legend>
          <label class="ann-all"><input type="checkbox" id="annAll" ${all ? 'checked' : ''}> <b>All sections</b></label>
          <div class="ann-grid">${ann.sections.map(s => `<label><input type="checkbox" name="section" value="${h(s)}" ${all ? 'disabled' : ''} ${e && e.sections.includes(s) ? 'checked' : ''}> ${h(s)}</label>`).join('')}</div>
        </fieldset>
        <div class="field ann-date"><label for="annEnd">Show until (optional)</label><input type="date" id="annEnd" name="expiresOn" value="${h(e?.expiresOn || '')}" min="${e ? '' : today()}"><small class="note">Leave empty to keep it until you delete it.</small></div>
        ${e ? '<label class="ann-resend"><input type="checkbox" id="annResend"> Send again as new (everyone sees it unread and gets a notification)</label>' : ''}
        <div class="engineering-actions"><button class="btn" type="submit">${e ? 'Save changes' : 'Publish'}</button>${e ? '<button class="btn ghost" type="button" id="annCancel">Cancel</button>' : ''}</div>
        <p class="note" id="annStatus" role="status">${h(message)}</p></form>
      <div class="card"><h3>Published announcements</h3>
        ${ann.items.length ? `<ul class="ann-admin-list">${ann.items.map(x => `<li class="ann-admin-item${x.active ? '' : ' ended'}">
          <div class="ann-admin-head"><b>${h(x.title)}</b><span class="overview-pill">${x.active ? 'Showing' : 'Ended'}</span></div>
          ${x.body ? `<p>${h(x.body)}</p>` : ''}
          <small>${h(x.sections.length ? x.sections.join(', ') : 'All sections')} · ${h(when(x.at))}${x.expiresOn ? ' · until ' + h(onDay(x.expiresOn)) : ''}</small>
          <details><summary>Read by ${n(x.reads)} of ${n(x.targets)}</summary><p class="note">${x.readers.length ? h(x.readers.join(', ')) : 'Nobody yet.'}</p></details>
          <div class="engineering-actions"><button type="button" class="btn ghost" data-ann-edit="${h(x.id)}">Edit</button><button type="button" class="btn danger" data-ann-delete="${h(x.id)}">Delete</button></div></li>`).join('')}</ul>` : '<p class="note">No announcements yet.</p>'}
      </div>`;
    el('annAll').onchange = ev => root.querySelectorAll('[name=section]').forEach(c => { c.disabled = ev.target.checked; });
    if (el('annCancel')) el('annCancel').onclick = () => { ann.editing = null; renderAnnAdmin(); };
    root.querySelectorAll('[data-ann-edit]').forEach(b => b.onclick = () => { ann.editing = ann.items.find(x => x.id === b.dataset.annEdit); renderAnnAdmin(); el('annTitle').focus(); });
    root.querySelectorAll('[data-ann-delete]').forEach(b => b.onclick = async () => {
      const x = ann.items.find(i => i.id === b.dataset.annDelete);
      if (!await ask({title:'Delete announcement?', text:`“${h(x.title)}” goes to the Recycle bin. You can restore it from there.`, button:'Delete'})) return;
      try { await rpc('deleteAnnouncement', [T(), {id:x.id}]); if (ann.editing && ann.editing.id === x.id) ann.editing = null; await loadAnnAdmin('Deleted. It is in the Recycle bin.'); refreshBadges(true); }
      catch (err) { el('annStatus').textContent = cleanError(err); }
    });
    el('annForm').onsubmit = async ev => {
      ev.preventDefault();
      const f = ev.currentTarget, button = f.querySelector('[type=submit]'), allSections = el('annAll').checked;
      const sections = [...f.querySelectorAll('[name=section]:checked')].map(c => c.value);
      if (!allSections && !sections.length) { el('annStatus').textContent = 'Tick at least one section, or All sections.'; return; }
      button.disabled = true; el('annStatus').textContent = 'Saving…';
      try {
        await rpc('saveAnnouncement', [T(), {id:e?.id || '', revision:e?.revision, title:el('annTitle').value, body:el('annBody').value,
          allSections, sections, expiresOn:el('annEnd').value, resend:!!(el('annResend') && el('annResend').checked)}]);
        const fresh = !e || (el('annResend') && el('annResend').checked);
        ann.editing = null;
        if (typeof pushFlush === 'function') pushFlush();
        await loadAnnAdmin(fresh ? 'Published. The chosen sections see it on My Profile and get a notification.' : 'Saved.');
        refreshBadges(true);
      } catch (err) { button.disabled = false; el('annStatus').textContent = cleanError(err); }
    };
  }

  /* ------------------------------------------------------------ wiring */
  function onTab(tab) {
    if (tab === 'account') loadAnnouncements();
    if (tab === 'recycle-bin') loadBin();
    if (tab === 'components') mountComponentLog();
    if (tab === 'announcements') { ann.editing = null; loadAnnAdmin(); }
  }
  document.addEventListener('DOMContentLoaded', () => {
    const icon = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
    document.querySelector('#nav [data-tab="dashboard"]').insertAdjacentHTML('afterend',
      `<button data-tab="announcements" hidden>${icon('<path d="M3 11v2a1 1 0 0 0 1 1h3l5 4V6L7 10H4a1 1 0 0 0-1 1z"/><path d="M16 9a3 3 0 0 1 0 6"/>')}Announcement</button>` +
      `<button data-tab="recycle-bin" hidden>${icon('<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6"/>')}Recycle Bin</button>`);
    document.querySelector('.content').insertAdjacentHTML('beforeend',
      '<section id="tab-announcements" class="tab-content hidden"></section><section id="tab-recycle-bin" class="tab-content hidden"></section>');
    el('forwardedCard').insertAdjacentHTML('beforebegin', '<div class="card profile-announce" id="announceCard" hidden></div>');
    document.body.insertAdjacentHTML('beforeend', '<dialog id="wlfAdminDialog" class="admin-dialog" aria-labelledby="wlfAdminDialogTitle"></dialog>');
    PAGES.announcements = ['Announcement', 'Notices for chosen sections: My Profile card, red count and notification'];
    PAGES['recycle-bin'] = ['Recycle Bin', 'Restore deleted items or delete them permanently'];
  });
  document.addEventListener('click', e => { const b = e.target.closest && e.target.closest('#nav button'); if (b) setTimeout(() => refreshBadges(true), 600); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshBadges(); });
  setInterval(() => { if (document.visibilityState === 'visible') refreshBadges(); }, 60000);
  window.addEventListener('wlf-ready', () => { badgeAt = 0; refreshBadges(true); });
  window.addEventListener('wlf-logout', () => {
    epoch++;
    popupSkipped.clear(); { const d = el('wlfAnnouncePopup'); if (d && d.open) d.close(); }
    for (const id of ['announceCard', 'tab-recycle-bin', 'tab-announcements', 'componentLogCard']) { const x = el(id); if (x) x.innerHTML = ''; }
    if (el('announceCard')) el('announceCard').hidden = true;
    for (const id of ['profileNavBadge', 'damageNavBadge', 'supplierNavBadge']) if (el(id)) el(id).hidden = true;
    bin = {items:[], purges:[], kind:'', query:'', selected:new Set()}; ann = {items:[], sections:[], editing:null};
    usage = {member:'', offset:0, before:null, downloaded:false}; range = {from:'', to:'', count:null, checked:''}; clog = {from:'', to:'', q:'', rows:[]};
  });
  return {open:onTab, refreshBadges, usageLog, componentLog, loadAnnouncements};
})();
