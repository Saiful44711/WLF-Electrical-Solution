/* WLF v2.7.0 · Monthly reports card in Storage & Backup (Super Admin).
   Technical Support, R&I Team Activity and Damage Demand: one Excel file per month in its own Google Drive folder. */
const WlfMonthlyReports = (() => {
  'use strict';
  const h = v => esc(String(v ?? ''));
  const NAMES = {support: 'Technical Support', activity: 'R&I Team Activity', damage: 'Damage Demand'};
  const FOLDERS = {support: 'Technical Support Monthly Report', activity: 'R&I Team Activity Monthly Report', damage: 'Damage Demand Monthly Report'};
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const monthName = m => MONTHS[Number(m.slice(5, 7)) - 1] + ' ' + m.slice(0, 4);
  const when = iso => iso ? new Date(iso).toLocaleString('en-GB', {timeZone: 'Asia/Dhaka', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false}) : '—';

  function mount(root, api) {
    if (!root) return;
    const account = T();
    const current = () => root.isConnected && T() === account;
    root.innerHTML = '<section class="card wlf-module" id="wlfMonthlyCard"><h3>Monthly reports</h3>' +
      '<p class="note">Three ready-to-submit Excel reports for each month, each in its own Google Drive folder: <b>Technical Support</b> (one sheet per section), ' +
      '<b>R&amp;I Team Activity</b> (one sheet per sector) and <b>Damage Demand</b> (one sheet per section). Months follow Bangladesh time. The reports only read data: nothing is changed or deleted.</p>' +
      '<div class="mr-auto"><div><b>Automatic</b><p class="note" id="wlfMonthlyAuto">Checking…</p></div>' +
      '<div class="wlf-tools-actions"><button type="button" class="btn" id="wlfMonthlyOn">Turn on</button><button type="button" class="btn ghost" id="wlfMonthlyOff">Turn off</button></div></div>' +
      '<div class="mr-make"><label>Month<input type="month" id="wlfMonthlyMonth"></label>' +
      '<div class="wlf-choice-list">' + Object.keys(NAMES).map(k => '<label class="wlf-choice"><input type="checkbox" value="' + k + '" data-monthly-kind checked> ' + h(NAMES[k]) + '</label>').join('') + '</div>' +
      '<button type="button" class="btn" id="wlfMonthlyMake">Make report now</button></div>' +
      '<p class="note">Making a month again replaces that month\'s file in Google Drive (the old file goes to the Drive bin).</p>' +
      '<div id="wlfMonthlyStatus" role="status" aria-live="polite"></div>' +
      '<h4 style="margin:18px 0 6px">Saved reports</h4><div id="wlfMonthlyHistory" aria-live="polite">Loading…</div></section>';
    const get = s => root.querySelector(s);
    const say = (msg, error = false) => { if (!current()) return; const n = get('#wlfMonthlyStatus'); n.textContent = msg; n.classList.toggle('error', error); };
    let state = null;
    async function load() {
      try {
        const [status, history] = await Promise.all([api.edge('reportStatus'), api.edge('reportHistory')]);
        if (!current()) return;
        state = status;
        const month = get('#wlfMonthlyMonth');
        if (!month.value) month.value = status.lastMonth;
        month.max = new Date(Date.now() + 6 * 3600e3).toISOString().slice(0, 7);
        const ready = status.cronReady && status.netReady;
        get('#wlfMonthlyAuto').innerHTML = status.enabled
          ? 'On. Every night at 02:00 (Bangladesh time) the server makes the reports of the last month that are still missing, so each month is ready on the 1st. ' +
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
          '<p class="note">Folders in Google Drive: ' + Object.values(FOLDERS).map(h).join(' · ') + '. Deleting from this list keeps the file in Drive.</p>';
        pane.querySelectorAll('[data-monthly-delete]').forEach(b => { b.onclick = () => run(async () => {
          if (!confirm('Delete this report from the list? The file stays in Google Drive.')) return;
          await api.edge('reportDeleteHistory', {id: b.dataset.monthlyDelete}); say('Removed from the list.');
        }); });
      } catch (err) { if (current()) get('#wlfMonthlyHistory').textContent = err.message; }
    }
    async function run(fn) {
      if (api.busy() || !current()) { say('Another backup or report is still running. Wait a moment and try again.', true); return; }
      api.lock(true);
      try { await fn(); } catch (err) { say(err.message, true); } finally { try { if (current()) await load(); } finally { api.lock(false); } }
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
    load();
  }
  return {mount};
})();
