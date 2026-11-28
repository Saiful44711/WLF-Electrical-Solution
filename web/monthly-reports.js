/* WLF v2.7.0 · Monthly reports card in Storage & Backup (Super Admin).
   Technical Support, R&I Team Activity and Damage Demand: one Excel file per month.
   v2.7.2: all three sit in one Drive folder "Monthly Analysis Report"; plus the Monthly Excel backup card
   (previous month, six workbooks in "Monthly Excel Backup", never clears). */
const WlfMonthlyReports = (() => {
  'use strict';
  const h = v => esc(String(v ?? ''));
  const NAMES = {support: 'Technical Support', activity: 'R&I Team Activity', damage: 'Damage Demand'};
  const BACKUPS = {support: 'Technical Support', activity: 'R&I Team Activity', project: 'R&I Project Manager', qms: 'QMS Data', damage: 'Damage Demand', claim: 'Supplier Claim'};
  const FOLDERS = {support: 'Technical Support Monthly Report', activity: 'R&I Team Activity Monthly Report', damage: 'Damage Demand Monthly Report'};
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const monthName = m => MONTHS[Number(m.slice(5, 7)) - 1] + ' ' + m.slice(0, 4);
  const when = iso => iso ? new Date(iso).toLocaleString('en-GB', {timeZone: 'Asia/Dhaka', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false}) : '—';

  /* the Storage page can be drawn again while it is open (refresh, finished backups): keep the choices made on this card */
  const memo = {account: null, kinds: null, month: '', backups: null, bmonth: ''};
  function mount(root, api) {
    if (!root) return;
    if (memo.account !== T()) { memo.account = T(); memo.kinds = null; memo.month = ''; memo.backups = null; memo.bmonth = ''; }
    const account = T();
    const current = () => root.isConnected && T() === account;
    root.innerHTML = '<section class="card wlf-module" id="wlfMonthlyCard"><h3>Monthly reports</h3>' +
      '<p class="note">Three ready-to-submit Excel reports for each month, saved in the Google Drive folder <b>Monthly Analysis Report</b> (one folder per report): <b>Technical Support</b> (one sheet per section), ' +
      '<b>R&amp;I Team Activity</b> (one sheet per sector) and <b>Damage Demand</b> (one sheet per section). Months follow Bangladesh time. The reports only read data: nothing is changed or deleted.</p>' +
      '<div class="mr-auto"><div><b>Automatic</b><p class="note" id="wlfMonthlyAuto">Checking…</p></div>' +
      '<div class="wlf-tools-actions"><button type="button" class="btn" id="wlfMonthlyOn">Turn on</button><button type="button" class="btn ghost" id="wlfMonthlyOff">Turn off</button></div></div>' +
      '<div class="mr-make"><label>Month<input type="month" id="wlfMonthlyMonth"></label>' +
      '<div class="wlf-choice-list">' + Object.keys(NAMES).map(k => '<label class="wlf-choice"><input type="checkbox" value="' + k + '" data-monthly-kind' + (!memo.kinds || memo.kinds.includes(k) ? ' checked' : '') + '> ' + h(NAMES[k]) + '</label>').join('') + '</div>' +
      '<button type="button" class="btn" id="wlfMonthlyMake">Make report now</button></div>' +
      '<p class="note">Making a month again replaces that month\'s file in Google Drive (the old file goes to the Drive bin).</p>' +
      '<div id="wlfMonthlyStatus" role="status" aria-live="polite"></div>' +
      '<h4 style="margin:18px 0 6px">Saved reports</h4><div id="wlfMonthlyHistory" aria-live="polite">Loading…</div></section>' +
      '<section class="card wlf-module" id="wlfMbCard"><h3>Monthly Excel backup</h3>' +
      '<p class="note">Once a month the server saves the <b>previous month</b> of every module as an Excel workbook (the same format as the Backup buttons above) in the Google Drive folder ' +
      '<b>Monthly Excel Backup</b>, one folder per module. It only makes copies: <b>nothing is ever cleared</b>. The Backup buttons above keep working as before.</p>' +
      '<div class="mr-auto"><div><b>Automatic</b><p class="note" id="wlfMbAuto">Checking…</p></div>' +
      '<div class="wlf-tools-actions"><button type="button" class="btn" id="wlfMbOn">Turn on</button><button type="button" class="btn ghost" id="wlfMbOff">Turn off</button></div></div>' +
      '<div class="mr-make"><label>Month<input type="month" id="wlfMbMonth"></label>' +
      '<div class="wlf-choice-list">' + Object.keys(BACKUPS).map(k => '<label class="wlf-choice"><input type="checkbox" value="' + k + '" data-mb-kind' + (!memo.backups || memo.backups.includes(k) ? ' checked' : '') + '> ' + h(BACKUPS[k]) + '</label>').join('') +
      '<button type="button" class="btn" id="wlfMbMake">Make backup now</button></div>' +
      '<p class="note">Making a month again replaces that month\'s file (the old file goes to the Drive bin). A module with more than 1000 records in one month cannot be saved automatically: use the Backup buttons above with a shorter period.</p>' +
      '<div id="wlfMbStatus" role="status" aria-live="polite"></div>' +
      '<h4 style="margin:18px 0 6px">Saved monthly backups</h4><div id="wlfMbHistory" aria-live="polite">Loading…</div></section>';
    const get = s => root.querySelector(s);
    const remember = () => { memo.kinds = [...root.querySelectorAll('[data-monthly-kind]:checked')].map(x => x.value); memo.month = get('#wlfMonthlyMonth').value;
      memo.backups = [...root.querySelectorAll('[data-mb-kind]:checked')].map(x => x.value); memo.bmonth = get('#wlfMbMonth').value; };
    root.querySelectorAll('[data-monthly-kind],[data-mb-kind]').forEach(x => { x.onchange = remember; });
    get('#wlfMonthlyMonth').onchange = remember; get('#wlfMbMonth').onchange = remember;
    if (memo.month) get('#wlfMonthlyMonth').value = memo.month;
    if (memo.bmonth) get('#wlfMbMonth').value = memo.bmonth;
    const sayB = (msg, error = false) => { if (!current()) return; const n = get('#wlfMbStatus'); n.textContent = msg; n.classList.toggle('error', error); };
    const say = (msg, error = false) => { if (!current()) return; const n = get('#wlfMonthlyStatus'); n.textContent = msg; n.classList.toggle('error', error); };
    let state = null;
    async function load() {
      /* the month box never stays empty: last month (Bangladesh time) until the server answers */
      for (const id of ['#wlfMonthlyMonth', '#wlfMbMonth']) { const m = get(id); if (!m.value) { const d = new Date(Date.now() + 6 * 3600e3); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); m.value = d.toISOString().slice(0, 7); } }
      try {
        const [status, history, backups] = await Promise.all([api.edge('reportStatus'), api.edge('reportHistory'), api.edge('backupHistory').catch(err => ({error: err.message}))]);
        if (!current()) return;
        state = status;
        paintBackups(status, backups);
        const month = get('#wlfMonthlyMonth');
        if (!month.value) month.value = status.lastMonth;
        month.max = new Date(Date.now() + 6 * 3600e3).toISOString().slice(0, 7);
        const ready = status.cronReady && status.netReady;
        get('#wlfMonthlyAuto').innerHTML = status.enabled
          ? 'On. Every night between 02:00 and 05:00 (Bangladesh time) the server makes the reports of the last month that are still missing, so each month is ready on the 1st. ' +
            'Last check: ' + h(when(status.lastCheck)) + (status.lastError ? ' · <span class="error-text">Last problem: ' + h(status.lastError) + '</span>' : '')
          : 'Off. ' + (ready ? 'Press Turn on to make the reports every month by itself.' : 'First switch on the extensions <b>pg_cron</b> and <b>pg_net</b> in Supabase (Database → Extensions), then press Turn on.');
        get('#wlfMonthlyOn').hidden = !!status.enabled;
        get('#wlfMonthlyOff').hidden = !status.enabled;
        if (status.driveConfigured === false) say('Google Drive is not set up yet, so reports cannot be saved.', true);
        const pane = get('#wlfMonthlyHistory');
        pane.innerHTML = '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Month</th><th>Report</th><th>Records</th><th>Made by</th><th>Saved (Dhaka)</th><th>File</th><th></th></tr></thead><tbody>' +
          (history.map(r => '<tr><td>' + h(monthName(r.month)) + '</td><td>' + h(NAMES[r.kind]) + '</td><td>' + Number(r.records) + '</td><td>' + (r.source === 'schedule' ? 'Automatic' : 'Super Admin') +
            '</td><td>' + h(when(r.updatedAt)) + '</td><td><a href="https://drive.google.com/file/d/' + encodeURIComponent(r.fileId) + '/view" target="_blank" rel="noopener">' + h(r.fileName) + '</a></td>' +
            '<td><button type="button" class="btn ghost" data-monthly-delete="' + h(r.id) + '">Delete from list</button></td></tr>').join('') ||
            '<tr><td colspan="7">No monthly reports yet.</td></tr>') + '</tbody></table></div>' +
          '<p class="note">Google Drive: Monthly Analysis Report › ' + Object.values(FOLDERS).map(h).join(' · ') + '. Deleting from this list keeps the file in Drive.</p>';
        pane.querySelectorAll('[data-monthly-delete]').forEach(b => { b.onclick = () => run(async () => {
          if (!confirm('Delete this report from the list? The file stays in Google Drive.')) return;
          await api.edge('reportDeleteHistory', {id: b.dataset.monthlyDelete}); say('Removed from the list.');
        }); });
      } catch (err) {
        if (!current()) return;
        const old = /Unsupported action/i.test(err.message);
        const text = old ? 'The wlf-maintenance Edge Function in Supabase is older than this app. Deploy the v2.7.2 index.ts (Verify JWT off), then press Refresh.' : err.message;
        get('#wlfMonthlyAuto').textContent = old ? 'Not available yet: the Edge Function needs the v2.7.2 update.' : 'Could not check: ' + err.message;
        get('#wlfMonthlyHistory').innerHTML = '<p class="error-text">' + h(text) + '</p>';
      }
    }
    async function run(fn, out = say) {
      if (api.busy() || !current()) { out('Another backup or report is still running. Wait a moment and try again.', true); return; }
      api.lock(true);
      try { await fn(); } catch (err) { out(err.message, true); } finally { try { if (current()) await load(); } finally { api.lock(false); } }
    }
    get('#wlfMonthlyMake').onclick = () => run(async () => {
      const month = get('#wlfMonthlyMonth').value, kinds = [...root.querySelectorAll('[data-monthly-kind]:checked')].map(x => x.value);
      if (!/^\d{4}-\d{2}$/.test(month)) throw Error('Choose a month.');
      if (!kinds.length) throw Error('Choose at least one report.');
      say('Making ' + kinds.length + ' report(s) for ' + monthName(month) + ' and saving them in Google Drive…');
      const out = await api.edge('reportGenerate', {month, kinds});
      say('Saved in Google Drive: ' + out.made.map(m => m.fileName + ' (' + m.records + ' records)').join(' · '));
    });
    get('#wlfMonthlyOn').onclick = () => run(async () => {
      if (state && !(state.cronReady && state.netReady)) throw Error('Switch on pg_cron and pg_net in Supabase (Database → Extensions) first.');
      await api.edge('reportSchedule', {enable: true}); say('Automatic monthly reports are on.');
    });
    get('#wlfMonthlyOff').onclick = () => run(async () => {
      if (!confirm('Turn off automatic monthly reports? Saved reports stay in Google Drive.')) return;
      await api.edge('reportSchedule', {enable: false}); say('Automatic monthly reports are off.');
    });
    function paintBackups(status, list) {
      const ready = status.cronReady && status.netReady;
      get('#wlfMbMonth').max = new Date(Date.now() + 6 * 3600e3).toISOString().slice(0, 7);
      get('#wlfMbAuto').innerHTML = status.backupEnabled
        ? 'On. On the 1st, between 02:00 and 05:00 (Bangladesh time), the server saves last month\'s six workbooks (a missing one is tried again the next night). Last check: ' + h(when(status.lastCheck)) +
          (status.lastError ? ' · <span class="error-text">Last problem: ' + h(status.lastError) + '</span>' : '')
        : 'Off. ' + (ready ? 'Press Turn on to save every month by itself.' : 'First switch on the extensions <b>pg_cron</b> and <b>pg_net</b> in Supabase (Database → Extensions), then press Turn on.');
      get('#wlfMbOn').hidden = !!status.backupEnabled;
      get('#wlfMbOff').hidden = !status.backupEnabled;
      const pane = get('#wlfMbHistory');
      if (list && list.error) { pane.innerHTML = '<p class="error-text">' + h(/Unsupported|Unknown/i.test(list.error) ? 'Run UPDATE_V272.sql and deploy the v2.7.2 Edge Function to use the monthly backup.' : list.error) + '</p>'; return; }
      pane.innerHTML = '<div class="tbl-wrap"><table class="tbl" id="wlfMbTable"><thead><tr><th>Month</th><th>Module</th><th>Records</th><th>Saved (Dhaka)</th><th>File</th><th></th></tr></thead><tbody>' +
        ((list || []).map(r => '<tr><td>' + h(monthName(r.month)) + '</td><td>' + h(BACKUPS[r.kind] || r.kind) + '</td><td>' + Number(r.records) + '</td><td>' + h(when(r.createdAt)) +
          '</td><td><a href="https://drive.google.com/file/d/' + encodeURIComponent(r.fileId) + '/view" target="_blank" rel="noopener">' + h((BACKUPS[r.kind] || r.kind) + ' Backup ' + r.month + '.xlsx') + '</a></td>' +
          '<td><button type="button" class="btn ghost" data-mb-delete="' + h(r.id) + '">Delete from list</button></td></tr>').join('') || '<tr><td colspan="6">No monthly backups yet.</td></tr>') +
        '</tbody></table></div><p class="note">Google Drive: Monthly Excel Backup › ' + Object.values(BACKUPS).map(h).join(' · ') + '. Deleting from this list keeps the file in Drive.</p>';
      pane.querySelectorAll('[data-mb-delete]').forEach(b => { b.onclick = () => run(async () => {
        if (!confirm('Delete this backup from the list? The file stays in Google Drive.')) return;
        await api.edge('backupDeleteHistory', {id: b.dataset.mbDelete}); sayB('Removed from the list.');
      }, sayB); });
    }
    get('#wlfMbMake').onclick = () => run(async () => {
      const month = get('#wlfMbMonth').value, kinds = [...root.querySelectorAll('[data-mb-kind]:checked')].map(x => x.value);
      if (!/^\d{4}-\d{2}$/.test(month)) throw Error('Choose a month.');
      if (!kinds.length) throw Error('Choose at least one module.');
      sayB('Saving ' + kinds.length + ' backup(s) of ' + monthName(month) + ' in Google Drive…');
      try {
        const out = await api.edge('backupGenerate', {month, kinds});
        sayB('Saved in Google Drive: ' + out.made.map(m => m.fileName + ' (' + m.records + ' records)').join(' · '));
      } catch (err) { sayB(err.message, true); }
    }, sayB);
    get('#wlfMbOn').onclick = () => run(async () => {
      if (state && !(state.cronReady && state.netReady)) throw Error('Switch on pg_cron and pg_net in Supabase (Database → Extensions) first.');
      await api.edge('reportSchedule', {backup: true}); sayB('Automatic monthly Excel backup is on.');
    }, sayB);
    get('#wlfMbOff').onclick = () => run(async () => {
      if (!confirm('Turn off the automatic monthly Excel backup? Saved files stay in Google Drive.')) return;
      await api.edge('reportSchedule', {backup: false}); sayB('Automatic monthly Excel backup is off.');
    }, sayB);
    load();
  }
  return {mount};
})();
