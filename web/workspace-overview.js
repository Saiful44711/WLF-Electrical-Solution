/* Profile, KPI dashboard and project component register. */
const WlfOverview = (() => {
  'use strict';

  const el = id => document.getElementById(id);
  const h = value => esc(String(value ?? ''));
  const pageSize = 25;
  const qmsStatuses = ['Planned', 'In progress', 'Verified'];
  const count = value => Number(value || 0).toLocaleString('en-GB');
  const dateFormat = new Intl.DateTimeFormat('en-GB', {timeZone:'Asia/Dhaka', day:'numeric',month:'short',year:'numeric'});
  const clockFormat = new Intl.DateTimeFormat('en-GB', {
    timeZone:'Asia/Dhaka', day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'
  });
  const date = (value, clock = false) => value ? (clock ? clockFormat : dateFormat).format(new Date(value)) : '—';
  let profileRun = 0;
  let dashboardRun = 0;
  let qmsRun = 0;

  function duration(value) {
    const mins = Math.round(Number(value) || 0);
    return mins < 60 ? mins + 'm' : Math.floor(mins / 60) + 'h ' + mins % 60 + 'm';
  }

  function metric(label, value, tone, note = '') {
    return `<div class="overview-metric" data-tone="${tone}">
      <span>${h(label)}</span><strong>${h(value)}</strong>${note ? `<small>${h(note)}</small>` : ''}
    </div>`;
  }

  function delta(value, prior, format = count) {
    if (prior == null) return '';
    if (!prior) return 'Previous period · ' + format(0);
    const percent = Math.round((value - prior) * 100 / prior);
    return (percent > 0 ? '+' : '') + percent + '% vs previous period';
  }

  function bars(rows, label) {
    const max = Math.max(1, ...rows.map(row => Number(row.activities)));
    return rows.length ? `<ul class="overview-bars">${rows.map(row =>
      `<li><span>${h(label(row))}</span><meter min="0" max="${max}" value="${Number(row.activities)}"
        aria-label="${h(label(row))} activity count">${count(row.activities)}</meter><b>${count(row.activities)}</b></li>`
    ).join('')}</ul>` : '<p class="note">No activity in this period.</p>';
  }

  function table(headers, rows, label) {
    return `<div class="tbl-wrap overview-table" tabindex="0" aria-label="${h(label)}">
      <table class="tbl"><thead><tr>${headers.map(name => `<th scope="col">${h(name)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table>
    </div>`;
  }

  function paging(prefix, previous, next, text) {
    return `<div class="overview-paging">
      <button class="btn ghost" type="button" id="${prefix}Prev" ${previous ? '' : 'disabled'}>Previous</button>
      <span>${h(text)}</span>
      <button class="btn ghost" type="button" id="${prefix}Next" ${next ? '' : 'disabled'}>Next</button>
    </div>`;
  }

  function bindPaging(prefix, previous, next) {
    el(prefix + 'Prev').onclick = previous;
    el(prefix + 'Next').onclick = next;
  }

  function activityList(data, own, offset) {
    const prefix = own ? 'profileActivity' : 'dashboardActivity';
    const sections = new Map(data.sections.map(row => [row.section, row.label]));
    const records = data.recent.map(row => [
      h(date(row.happened_at,true)), h(sections.get(row.section)), h(row.entry),
      ...(own ? [] : [h(row.name)]), h(row.outcome), row.minutes == null ? '—' : h(duration(row.minutes))
    ]);
    const total = data.totals.activities;
    const headers = ['Logged (Dhaka)', 'Section', 'Work', ...(own ? [] : ['Member']), 'Outcome', 'Recorded time'];
    return `<section class="card overview-panel">
      <div class="overview-heading"><div><h3>${own ? 'My activity' : 'Activity log'}</h3>
        <p class="note">${count(total)} recorded activities</p></div></div>
      ${records.length ? table(headers, records, 'Work activity') : '<p class="note">No activities match.</p>'}
      ${total > pageSize ? paging(prefix, offset>0, offset+pageSize<total,
        count(offset+1)+'–'+count(Math.min(total,offset+pageSize))+' of '+count(total)) : ''}
    </section>`;
  }

  function identity(profile) {
    const initials = profile.name.trim().split(/\s+/).slice(0,2).map(part => Array.from(part)[0]).join('').toUpperCase() || 'U';
    return `<section class="card profile-hero">
      <div class="profile-person">
        <span class="profile-avatar" aria-hidden="true">${h(initials)}</span>
        <div><div class="overview-eyebrow">MY PROFILE</div><h3>${h(profile.name)}</h3>
          <p>${h(profile.role==='Super Admin'?'Super Admin':profile.role==='R&I'?'R&I user':'Section user')} · ${h(profile.email)}</p><span class="overview-pill">${h(profile.status)}</span></div>
      </div>
      <dl class="profile-account">
        <div><dt>ID</dt><dd>${h(profile.empId||'—')}</dd></div>
        <div><dt>Section</dt><dd>${h(profile.section||'—')}</dd></div>
        <div><dt>Member since</dt><dd>${h(date(profile.joinedAt))}</dd></div>
        <div><dt>Last sign-in</dt><dd>${h(date(profile.lastSignIn,true))}</dd></div>
      </dl>
    </section>`;
  }

  async function loadProfile(offset = 0) {
    const session = SESSION;
    const run = ++profileRun;
    const root = el('profileOverview');
    if (offset === 0) root.innerHTML = identity(session) + '<p class="note" id="profileStatus" role="status">Loading your activity…</p>';
    if (!session.workspaceUpdate) {
      el('profileStatus').textContent = 'Live activity is available after the workspace database update.';
      return;
    }
    try {
      const data = await rpc('getMyWorkspaceProfile',[T(),{offset}]);
      if (SESSION !== session || run !== profileRun) return;
      const {totals, projects} = data;
      root.innerHTML = `<div class="overview-stack">
        ${identity(data.profile)}
        <section class="overview-section">
          <div class="overview-heading"><div><h3>Performance</h3>
            <p class="note">Your recorded work across the sections you can access</p></div>
            <button class="btn ghost" id="profileRefresh" type="button">Refresh</button></div>
          <div class="overview-metrics">
            ${metric('Activities this month',count(totals.month_activities),'blue')}
            ${metric('All recorded activities',count(totals.activities),'violet',count(totals.completed)+' completed outcomes')}
            ${metric('Time this month',duration(totals.month_minutes),'teal')}
            ${metric('Total recorded time',duration(totals.minutes),'amber')}
          </div>
        </section>
        <div class="overview-columns">
          <section class="card overview-panel"><h3>Work breakdown</h3>
            <p class="note">First activity ${h(date(totals.first_at))} · Latest ${h(date(totals.last_at))}</p>
            ${bars(data.modules.filter(row => row.activities),row => row.label)}
          </section>
          ${projects ? `<section class="card overview-panel"><h3>Project contribution</h3>
            <dl class="overview-facts">${[
              ['Projects led',projects.led],['Collaborating on',projects.collaborating],
              ['Active projects',projects.active],['Completed projects',projects.completed]
            ].map(([label,value]) => `<div><dt>${label}</dt><dd>${count(value)}</dd></div>`).join('')}</dl>
          </section>` : ''}
        </div>
        <p class="note overview-status" id="profileStatus" role="status"></p>
      </div>`;
      el('profileRefresh').onclick = () => loadProfile();
    } catch (err) {
      if (SESSION === session && run === profileRun) el('profileStatus').textContent = cleanError(err);
    }
  }

  /* v2.5.3 Management Dashboard: menu-wise performance, this month by default, 12-month curves. */
  const palette = ['#5b6ee1','#159e82','#e08a1e','#d0457a','#7a5cd6','#2f8fd8','#8a9a2b'];
  const teamName = c => String((AccessCore.supportTitles && AccessCore.supportTitles[c]) || c)
    .replace(/ Team Support Request$/,'').replace(/ Support Request$/,'');
  const riSection = {team:'Team Activity',scm:'SCM & Supplier',sales:'Sales Support',reports:'Reports'};

  function hbars(rows) {
    const max = Math.max(1, ...rows.map(r => Number(r.value)));
    return `<div class="mgmt-hbar">${rows.map(r => `<div><span>${h(r.label)}</span><i style="width:${Math.max(1, Number(r.value) * 100 / max)}%"></i><b>${count(r.value)}</b></div>`).join('')}</div>`;
  }

  function people(list) {
    return list.length ? `<ul class="mgmt-people">${list.map(p => `<li>${h(p.name)}<b>${count(p.n)}</b></li>`).join('')}</ul>` : '';
  }

  /* v2.6.6 Admin Panel: one dashboard at a time, a user filter and curves (1, 3, 6, 12 months) on every dashboard. */
  const AP_DASH = [['team','R&I team activity'],['projects','R&I Project Manager'],['support','Technical Support'],['damage','Damage Demand'],['claims','Supplier claim'],['qms','QMS'],['curves','Performance curves']];
  const AP_METRICS = {
    team:[['entries','Activity entries'],['completed','Completed entries'],['hours','Time recorded (h)']],
    support:[['received','Support received'],['solved','Support solved'],['notSolved','Not solved'],['forwarded','Forwarded']],
    damage:[['damage','Damage demands raised']],
    claims:[['claims','Supplier claims raised']]};
  const AP_GROUP = {team:'R&I team activity', support:'Technical Support', damage:'Damage Demand', claims:'Supplier claim'};
  const AP = {dash:'team', user:'all', range:12, mode:'together', metric:{team:'entries', support:'received', damage:'damage', claims:'claims', curves:'entries'}, hidden:new Set()};
  let apData = null, apFilters = null, chartSeq = 0;
  const apCharts = {};
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  function apDate(end, i, days) {
    const [y, m, d] = String(end).slice(0, 10).split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d - (days - 1 - i)));
  }
  const round1 = v => Math.round(v * 10) / 10;
  /* Adds the 365 daily values up: 1 month = daily, 3 months = weekly, 6 and 12 months = calendar months. */
  function apSeries(arr, range, end) {
    const days = arr.length, labels = [], vals = [];
    const sum = list => round1(list.reduce((a, b) => a + Number(b), 0));
    if (range === 1) {
      for (let i = days - 30; i < days; i++) { const d = apDate(end, i, days); labels.push(d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()]); vals.push(Number(arr[i])); }
    } else if (range === 3) {
      for (let b = 12; b >= 0; b--) { const e = days - b * 7, d = apDate(end, e - 1, days); labels.push('Week to ' + d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()]); vals.push(sum(arr.slice(Math.max(0, e - 7), e))); }
    } else {
      const buckets = new Map();
      for (let i = 0; i < days; i++) {
        const d = apDate(end, i, days), key = d.getUTCFullYear() * 12 + d.getUTCMonth();
        if (!buckets.has(key)) buckets.set(key, {l:MONTHS[d.getUTCMonth()] + " '" + String(d.getUTCFullYear()).slice(2), a:[]});
        buckets.get(key).a.push(arr[i]);
      }
      const list = [...buckets.values()].slice(-range);
      list.forEach((b, i) => { labels.push(i === list.length - 1 ? b.l + ' (to date)' : b.l); vals.push(sum(b.a)); });
    }
    return {labels, vals};
  }
  function smooth(pts) {
    if (pts.length < 3) return 'M' + pts.map(p => p.join(',')).join('L');
    const n = pts.length, dx = [], m = [], t = [];
    for (let i = 0; i < n - 1; i++) { dx.push(pts[i + 1][0] - pts[i][0]); m.push((pts[i + 1][1] - pts[i][1]) / dx[i]); }
    t.push(m[0]); for (let i = 1; i < n - 1; i++) t.push(m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2); t.push(m[n - 2]);
    let d = 'M' + pts[0].map(v => v.toFixed(1)).join(',');
    for (let i = 0; i < n - 1; i++) { const k = dx[i] / 3; d += `C${(pts[i][0] + k).toFixed(1)},${(pts[i][1] + t[i] * k).toFixed(1)} ${(pts[i + 1][0] - k).toFixed(1)},${(pts[i + 1][1] - t[i + 1] * k).toFixed(1)} ${pts[i + 1][0].toFixed(1)},${pts[i + 1][1].toFixed(1)}`; }
    return d;
  }
  function apChart(users, o) {
    const id = 'apc' + (++chartSeq), n = o.labels.length, W = o.small ? 360 : 760, H = o.small ? 170 : 300, L = o.small ? 34 : 44, R = o.small ? 10 : 60, T = 14, B = 26;
    const all = users.flatMap(u => u.curve).concat(o.avg || []);
    let lo = Math.min(0, ...all), hi = Math.max(...all, 1);
    const raw = (hi - lo) / 3, mag = Math.pow(10, Math.floor(Math.log10(raw || 1))), step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(v => v >= raw) || mag;
    hi = Math.ceil(hi / step - 1e-9) * step;
    const x = i => L + (n > 1 ? i * (W - L - R) / (n - 1) : 0), y = v => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    let grid = '';
    for (let v = lo; v <= hi + 1e-9; v += step) { const r = Math.round(v * 100) / 100; grid += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(r)}" y2="${y(r)}"/><text x="${L - 6}" y="${y(r) + 4}" text-anchor="end">${r}</text>`; }
    const every = Math.max(1, Math.ceil(n / (o.small ? 4 : 8)));
    const ticks = o.labels.map((m, i) => (i % every === 0 || i === n - 1) && !(i !== n - 1 && n - 1 - i < every)
      ? `<text x="${x(i)}" y="${H - 7}" text-anchor="${i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}">${h(m.replace('Week to ', ''))}</text>` : '').join('');
    let defs = '', body = '';
    if (o.avg) body += `<path class="avg" d="${smooth(o.avg.map((v, i) => [x(i), y(v)]))}" fill="none"/>`;
    users.forEach((u, k) => {
      const pts = u.curve.map((v, i) => [x(i), y(v)]), d = smooth(pts);
      if (o.area) {
        defs += `<linearGradient id="${id}g${k}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${u.col}" stop-opacity=".32"/><stop offset="1" stop-color="${u.col}" stop-opacity="0"/></linearGradient>`;
        body += `<path d="${d}L${x(n - 1).toFixed(1)},${y(lo)}L${x(0).toFixed(1)},${y(lo)}Z" fill="url(#${id}g${k})"/>`;
      }
      body += `<path class="ln" data-u="${h(u.name)}" d="${d}" fill="none" stroke="${u.col}" stroke-width="${o.small ? 2.4 : 2.8}" stroke-linecap="round" stroke-linejoin="round"/>`;
      body += `<circle cx="${pts[n - 1][0].toFixed(1)}" cy="${pts[n - 1][1].toFixed(1)}" r="4.5" fill="${u.col}" class="endpoint"/>`;
    });
    if (!o.small) {
      const ends = users.map(u => ({u, y:y(u.curve[n - 1])})).sort((a, b) => a.y - b.y);
      for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 14) ends[i].y = ends[i - 1].y + 14;
      ends.forEach(e => { body += `<text x="${x(n - 1) + 9}" y="${e.y + 4}" style="fill:${e.u.col};font-weight:700">${count(e.u.curve[n - 1])}</text>`; });
    }
    apCharts[id] = {labels:o.labels, list:users, avg:o.avg, L, R, n};
    return `<div class="ap-chartwrap"><div class="ap-chartbox" data-chart="${id}"><svg class="ap-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${h(o.label)}"><defs>${defs}</defs>${grid}${ticks}${body}<line class="cursor" x1="0" x2="0" y1="${T}" y2="${H - B}" opacity="0"/></svg><div class="ap-tip" hidden></div></div></div>`;
  }
  function wireCharts(root) {
    root.querySelectorAll('.ap-chartbox').forEach(box => {
      const c = apCharts[box.dataset.chart], svg = box.querySelector('svg'), tip = box.querySelector('.ap-tip'), cur = svg.querySelector('.cursor'), vb = svg.viewBox.baseVal;
      const move = e => {
        const r = svg.getBoundingClientRect(), px = (e.clientX - r.left) / r.width * vb.width;
        let i = c.n > 1 ? Math.round((px - c.L) / ((vb.width - c.L - c.R) / (c.n - 1))) : 0; i = Math.max(0, Math.min(c.n - 1, i));
        const xx = c.L + (c.n > 1 ? i * (vb.width - c.L - c.R) / (c.n - 1) : 0);
        cur.setAttribute('x1', xx); cur.setAttribute('x2', xx); cur.setAttribute('opacity', '.6');
        const rows = c.list.slice().sort((a, b) => b.curve[i] - a.curve[i]);
        tip.innerHTML = `<b>${h(c.labels[i])}</b>` + rows.map(u => `<div><i style="background:${u.col}"></i>${h(u.name)}<em>${count(u.curve[i])}</em></div>`).join('') +
          (c.avg ? `<div class="avg">Team average<em>${count(c.avg[i])}</em></div>` : '');
        tip.hidden = false;
        tip.style.left = Math.max(0, Math.min(xx / vb.width * r.width + 12, r.width - tip.offsetWidth)) + 'px';
        svg.querySelectorAll('.ln').forEach(l => { l.style.opacity = c.list.length > 1 && rows[0].name !== l.dataset.u ? '.35' : '1'; });
      };
      const leave = () => { tip.hidden = true; cur.setAttribute('opacity', '0'); svg.querySelectorAll('.ln').forEach(l => { l.style.opacity = '1'; }); };
      box.addEventListener('pointermove', move); box.addEventListener('pointerleave', leave); box.addEventListener('pointerdown', move);
    });
    root.querySelectorAll('.ap-chartwrap').forEach(w => { w.scrollLeft = w.scrollWidth; });
  }

  const apUsers = () => (apData?.series?.users || []).map((u, i) => ({...u, col:palette[i % palette.length]}));
  const apSelected = () => AP.user === 'all' ? apUsers() : apUsers().filter(u => u.id === AP.user);
  const metricName = key => Object.values(AP_METRICS).flat().find(m => m[0] === key)?.[1] || key;

  function curveCard(dash) {
    const group = dash === 'curves' ? null : dash, key = AP.metric[dash];
    const everyone = apUsers(), mine = apSelected(), multi = mine.length > 1;
    if (!everyone.length) return apCard('Curve', '', '<p class="note">No approved R&amp;I users.</p>');
    const end = apData.series.end, name = metricName(key);
    const view = list => list.map(u => { const sr = apSeries(u.s[key] || [], AP.range, end); return {name:u.name, col:u.col, curve:sr.vals, labels:sr.labels}; });
    const base = view(everyone), labels = base[0].labels, nn = labels.length;
    const avg = labels.map((_, i) => round1(base.reduce((a, u) => a + u.curve[i], 0) / base.length));
    const shown = view(mine), visible = multi ? shown.filter(u => !AP.hidden.has(u.name)) : shown;
    let body;
    if (!multi) body = apChart(shown, {labels, avg, area:true, label:name + ' of ' + (shown[0]?.name || '')});
    else if (AP.mode === 'together') body = `<div class="ap-chips">${shown.map(u => `<button type="button" class="ap-chip ${AP.hidden.has(u.name) ? 'off' : ''}" data-ap-user="${h(u.name)}"><i style="background:${u.col}"></i>${h(u.name)}</button>`).join('')}</div>` +
      (visible.length ? apChart(visible, {labels, label:name + ' of all R&I users'}) : '<p class="note">Every line is hidden. Tap a name to show it.</p>');
    else body = `<div class="ap-minis">${shown.map(u => `<div class="ap-mini"><div class="ap-mini-head"><i style="background:${u.col}"></i>${h(u.name)}<b>${count(u.curve[nn - 1])}</b></div>${apChart([u], {labels, avg, area:true, small:true, label:name + ' of ' + u.name})}</div>`).join('')}</div>`;
    const unit = AP.range === 1 ? 'daily, last 30 days' : AP.range === 3 ? 'weekly, last 3 months' : 'monthly, last ' + AP.range + ' months';
    const options = group ? AP_METRICS[group].map(m => `<option value="${m[0]}" ${m[0] === key ? 'selected' : ''}>${h(m[1])}</option>`).join('')
      : Object.entries(AP_METRICS).map(([g, list]) => `<optgroup label="${h(AP_GROUP[g])}">${list.map(m => `<option value="${m[0]}" ${m[0] === key ? 'selected' : ''}>${h(m[1])}</option>`).join('')}</optgroup>`).join('');
    const title = (dash === 'curves' ? 'Performance curves' : 'Curve') + ' · ' + (multi ? 'all R&I users' : shown[0].name);
    return `<section class="card overview-panel mgmt-card ap-curve"><div class="ap-curve-head"><div><h3>${h(title)}</h3>
      <p class="note">${h(name)} · ${unit}.${multi && AP.mode === 'together' ? ' Hover or touch the chart to compare. Tap a name to hide a line.' : ' The dashed line is the team average.'}</p></div>
      <div class="ap-ctl"><label>Show<select id="apMetric">${options}</select></label>
        <label>Range<select id="apRange">${[[1,'1 month'],[3,'3 months'],[6,'6 months'],[12,'12 months']].map(([v, l]) => `<option value="${v}" ${v === AP.range ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        ${multi ? `<div class="ap-seg" role="group" aria-label="Curve layout"><button type="button" class="${AP.mode === 'together' ? 'on' : ''}" data-ap-mode="together">Together</button><button type="button" class="${AP.mode === 'separate' ? 'on' : ''}" data-ap-mode="separate">One by one</button></div>` : ''}</div></div>${body}</section>`;
  }

  const apCard = (title, note, body) => `<section class="card overview-panel mgmt-card"><h3>${h(title)}</h3>${note ? `<p class="note">${h(note)}</p>` : ''}${body}</section>`;
  const sumOf = (list, f) => list.reduce((t, u) => t + Number(f(u) || 0), 0);

  function apBody() {
    const data = apData, period = date(data.from) + ' – ' + date(data.to);
    const panelAll = data.panel?.users || [], panel = AP.user === 'all' ? panelAll : panelAll.filter(u => u.id === AP.user);
    const one = AP.user === 'all' ? null : panel[0];
    const who = one ? one.name : 'all R&I users';
    switch (AP.dash) {
    case 'team': {
      const tot = k => sumOf(panel, u => sumOf(u.sectors, x => x[k]));
      const kpi = `<div class="overview-metrics">${metric('Activity entries', count(tot('entries')), 'blue')}${metric('Time recorded', minutesText(tot('minutes')), 'teal')}${metric('Completed', count(tot('completed')), 'teal')}${metric('Ongoing', count(tot('ongoing')), 'amber')}${metric('Incomplete', count(tot('incomplete')), 'violet')}</div>`;
      const share = tot('minutes');
      const grid = one
        ? table(['Sector','Completed','Ongoing','Incomplete','Time invested'], one.sectors.map(x => [h(sectorName[x.section] || x.section), count(x.completed), count(x.ongoing), count(x.incomplete), h(minutesText(x.minutes))]), 'Activity by sector for ' + one.name)
        : table(['R&I user','Completed','Ongoing','Incomplete','Entries','Time invested','Share of time'], panel.map(u => {
          const m = sumOf(u.sectors, x => x.minutes);
          return [h(u.name), count(sumOf(u.sectors, x => x.completed)), count(sumOf(u.sectors, x => x.ongoing)), count(sumOf(u.sectors, x => x.incomplete)), count(sumOf(u.sectors, x => x.entries)), h(minutesText(m)), share ? Math.round(m * 100 / share) + '%' : '—'];
        }), 'Activity of every R&I user');
      const riRows = data.ri.filter(r => Number(r.total));
      const forms = one ? '' : apCard('Entries by form', period, riRows.length ? riRows.map(r => `<div class="mgmt-ri-form"><div class="mgmt-ri-head"><b>${h(r.form)}</b><span>${h(riSection[r.section] || r.section)} · <b>${count(r.total)}</b></span></div>${people(r.people)}</div>`).join('') : '<p class="note">No R&amp;I entries in this period.</p>');
      return apCard('R&I team activity · ' + who, period, kpi + grid) + curveCard('team') + forms;
    }
    case 'projects': {
      const pr = data.projects, st = ['In Progress','On Hold','Done','Cancelled'];
      return apCard('R&I Project Manager', 'All current projects · ' + count(pr.startedInPeriod) + ' started in this period',
        `<div class="overview-metrics">${st.map((s, i) => metric(s, count(pr.statuses[s]), ['blue','amber','teal','violet'][i])).join('')}</div>
        ${pr.leads.length ? table(['Project lead','Projects',...st], pr.leads.map(l => [h(l.name || '—'), count(l.total), ...st.map(s => count(l.statuses[s]))]), 'Projects by lead') : '<p class="note">No projects.</p>'}
        ${Object.keys(pr.tasks).length ? `<p class="note">Tasks: ${Object.entries(pr.tasks).map(([s, n]) => h(s) + ' ' + count(n)).join(' · ')}</p>` : ''}`);
    }
    case 'support': {
      const k = f => sumOf(panel, u => u.support?.[f]);
      const kpi = `<div class="overview-metrics">${metric('Support received', count(k('received')), 'blue')}${metric('Support solved', count(k('solved')), 'teal')}${metric('Not solved', count(k('notSolved')), 'amber')}${metric('Forwarded', count(k('forwarded')), 'violet')}</div>`;
      const byUser = table(['R&I user','Received','Solved','Not solved','Forwarded'], panel.map(u => [h(u.name), count(u.support?.received), count(u.support?.solved), count(u.support?.notSolved), count(u.support?.forwarded)]), 'Support by R&I user');
      const sp = data.support;
      const teams = one ? '' : apCard('Requests by team', period, sp.teams.length ? table(['Team','Requests','Solved','Not solved','Open'], sp.teams.map(t => [h(teamName(t.team)), count(t.total), count(t.solved), count(t.notSolved), count(t.open)]), 'Support by team') : '<p class="note">No support requests in this period.</p>');
      return apCard('Technical Support · ' + who, period, kpi + byUser) + curveCard('support') + teams;
    }
    case 'damage': {
      const kpi = `<div class="overview-metrics">${metric('Demands raised', count(sumOf(panel, u => u.damage)), 'amber')}</div>`;
      const byUser = table(['R&I user','Damage demands raised'], panel.map(u => [h(u.name), count(u.damage)]), 'Damage demands by R&I user');
      const dm = data.damage;
      const teams = one ? '' : apCard('Demands by team', period, (dm.teams.length ? table(['Team','Demands','Pending','Received','Units'], dm.teams.map(t => [h(teamName(t.team)), count(t.total), count(t.pending), count(t.received), count(t.quantity)]), 'Damage demands by team') : '<p class="note">No damage demands in this period.</p>') +
        (dm.top.length ? `<h4 class="mgmt-sub">Top ${dm.top.length} damaged components (units)</h4>` + hbars(dm.top.map(t => ({label:t.item, value:t.quantity}))) : ''));
      return apCard('Damage Demand · ' + who, period, kpi + byUser) + curveCard('damage') + teams;
    }
    case 'claims': {
      const kpi = `<div class="overview-metrics">${metric('Supplier claims raised', count(sumOf(panel, u => u.claims)), 'blue')}</div>`;
      const byUser = table(['R&I user','Supplier claims raised'], panel.map(u => [h(u.name), count(u.claims)]), 'Supplier claims by R&I user');
      return apCard('Supplier claim · ' + who, period, kpi + byUser) + curveCard('claims');
    }
    case 'qms': {
      const q = data.qms;
      return apCard('QMS', period + ' · ' + count(q.total) + ' lift records in total', `<div class="overview-metrics">${metric('Lifts recorded', count(q.lifts), 'violet')}${metric('All lift records', count(q.total), 'teal')}</div>${people(q.people)}`);
    }
    default: return curveCard('curves');
    }
  }

  function dashboardFilters(filters, data) {
    const users = apUsers();
    return `<form id="workspaceFilters" class="card overview-panel">
      <div class="overview-heading"><div><h3>Admin Panel</h3>
        <p class="note">Team performance. Dates use Dhaka time; this month by default. Curves have their own range.</p></div></div>
      <div class="overview-filters ap-filters">
        <label>Dashboard<select id="apDash">${AP_DASH.map(([v, l]) => `<option value="${v}" ${v === AP.dash ? 'selected' : ''}>${h(l)}</option>`).join('')}</select></label>
        <label>R&amp;I user<select id="apUser"><option value="all">All R&amp;I users (compare)</option>${users.map(u => `<option value="${h(u.id)}" ${u.id === AP.user ? 'selected' : ''}>${h(u.name)}</option>`).join('')}</select></label>
        <label>From<input type="date" name="from" value="${h(filters.from)}" required></label>
        <label>To<input type="date" name="to" value="${h(filters.to)}" required></label>
        <div class="overview-actions">
          <button class="btn" type="submit">Apply</button>
          <button class="btn ghost" type="button" id="workspaceExport" ${data ? '' : 'disabled'}>Download Excel</button>
          <button class="btn ghost" type="button" id="workspaceFull">Full screen</button>
        </div>
      </div>
      <p class="note overview-status" id="workspaceStatus" role="status"></p>
    </form>`;
  }

  const minutesText = m => { m = Math.round(Number(m || 0)); return m >= 60 ? Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0') + ' min' : m + ' min'; };
  const sectorName = {team:'Team Activity', scm:'SCM & Supplier communication', sales:'Sales Support', reports:'Reports'};

  function paintBody() {
    const root = el('apBody');
    if (!root) return;
    Object.keys(apCharts).forEach(k => delete apCharts[k]);
    root.innerHTML = apData ? apBody() : '<p class="note">Loading…</p>';
    wireCharts(root);
    const metricSelect = el('apMetric'), rangeSelect = el('apRange');
    if (metricSelect) metricSelect.onchange = () => { AP.metric[AP.dash] = metricSelect.value; paintBody(); };
    if (rangeSelect) rangeSelect.onchange = () => { AP.range = Number(rangeSelect.value); if (AP.range === 1) AP.mode = 'separate'; paintBody(); };
    root.querySelectorAll('[data-ap-mode]').forEach(b => { b.onclick = () => { AP.mode = b.dataset.apMode; paintBody(); }; });
    root.querySelectorAll('[data-ap-user]').forEach(b => { b.onclick = () => { const n = b.dataset.apUser; AP.hidden.has(n) ? AP.hidden.delete(n) : AP.hidden.add(n); paintBody(); }; });
  }

  function renderDashboard(data, filters) {
    apData = data; apFilters = filters;
    if (AP.user !== 'all' && !apUsers().some(u => u.id === AP.user)) AP.user = 'all';
    el('tab-workspace-dashboard').innerHTML = `<div class="overview-stack admin-panel">${dashboardFilters(filters, data)}<div id="apBody"></div></div>`;
    bindDashboard(filters, data);
    paintBody();
  }

  function bindDashboard(filters, data) {
    const form = el('workspaceFilters');
    form.onsubmit = event => {
      event.preventDefault();
      loadDashboard(Object.fromEntries(new FormData(form)));
    };
    el('apDash').onchange = event => { AP.dash = event.target.value; paintBody(); };
    el('apUser').onchange = event => { AP.user = event.target.value; paintBody(); };
    el('workspaceFull').onclick = () => {
      const node = el('tab-workspace-dashboard');
      if (document.fullscreenElement) document.exitFullscreen();
      else if (node.requestFullscreen) node.requestFullscreen().catch(() => { el('workspaceStatus').textContent = 'Full screen is not available in this browser.'; });
      else el('workspaceStatus').textContent = 'Full screen is not available in this browser.';
    };
    el('workspaceExport').onclick = () => {
      const edited = Object.fromEntries(new FormData(form));
      if (Object.keys(filters).some(key => edited[key] !== filters[key])) {
        el('workspaceStatus').textContent = 'Apply your date changes before downloading.';
        return;
      }
      exportDashboard(data);
    };
  }

  async function loadDashboard(filters) {
    const session = SESSION;
    const run = ++dashboardRun;
    const status = el('workspaceStatus');
    status.textContent = 'Loading Admin Panel…';
    try {
      const [data, panel, series] = await Promise.all([rpc('getManagementDashboard',[T(),filters]), rpc('getAdminPanel',[T(),filters]), rpc('getAdminSeries',[T()])]);
      data.panel = panel; data.series = series;
      if (SESSION === session && run === dashboardRun) renderDashboard(data,filters);
    } catch (err) {
      if (SESSION === session && run === dashboardRun && el('workspaceStatus')) el('workspaceStatus').textContent = cleanError(err);
    }
  }

  async function exportDashboard(data) {
    const status = el('workspaceStatus');
    const button = el('workspaceExport');
    button.disabled = true;
    status.textContent = 'Building Excel report…';
    try {
      const curve = (series) => Object.entries(series).map(([k, v]) => [teamName(k), ...v]);
      await WlfExports.excel([
        {name:'Period',headers:['Item','Value'],rows:[['From (Dhaka)',data.from],['To (Dhaka)',data.to],['Downloaded',date(new Date(),true)]]},
        {name:'R&I Team Activity',headers:['Form','Section','Total','Person','Entries'],
          rows:data.ri.flatMap(r => r.people.length ? r.people.map((p, i) => [i ? '' : r.form, i ? '' : (riSection[r.section] || r.section), i ? '' : r.total, p.name, p.n]) : [[r.form, riSection[r.section] || r.section, r.total, '', '']])},
        {name:'R&I Projects',headers:['Project','Lead','Status','End date','Tasks','Average progress %'],
          rows:data.projects.list.map(p => [p.name, p.lead, p.status, p.end, p.tasks, p.progress ?? ''])},
        {name:'Technical Support',headers:['Team','Requests','Solved','Not solved','Open'],
          rows:data.support.teams.map(t => [teamName(t.team), t.total, t.solved, t.notSolved, t.open])},
        {name:'R&I user activity',headers:['R&I user','Sector','Entries','Completed','Ongoing','Incomplete','Time invested (min)','Support received','Support solved','Support not solved','Support forwarded','Damage demands raised','Supplier claims raised'],
          rows:(data.panel?.users || []).flatMap(u => u.sectors.map((x, i) => [u.name, sectorName[x.section] || x.section, x.entries, x.completed, x.ongoing, x.incomplete, x.minutes,
            ...(i ? ['','','','','',''] : [u.support?.received ?? 0, u.support?.solved ?? 0, u.support?.notSolved ?? 0, u.support?.forwarded ?? 0, u.damage ?? 0, u.claims ?? 0])]))},
        {name:'R&I user curves',headers:['R&I user','Measure',...(data.series?.users?.length ? apSeries(data.series.users[0].s.entries, 12, data.series.end).labels : data.months)],
          rows:(data.series?.users || []).flatMap(u => Object.entries(AP_METRICS).flatMap(([g, list]) => list.map(m => [u.name, metricName(m[0]), ...apSeries(u.s[m[0]] || [], 12, data.series.end).vals])))},
        {name:'Support per month',headers:['Team',...data.months],rows:curve(data.support.curve)},
        {name:'Damage Demand',headers:['Team','Demands','Pending','Received','Units'],
          rows:data.damage.teams.map(t => [teamName(t.team), t.total, t.pending, t.received, t.quantity])},
        {name:'Top damaged components',headers:['Component','Units','Demands'],rows:data.damage.top.map(t => [t.item, t.quantity, t.demands])},
        {name:'Damage per month',headers:['Team',...data.months],rows:curve(data.damage.curve)},
        {name:'QMS',headers:['Measure','Lift records'],rows:[['Lifts recorded in this period', data.qms.lifts || 0],['All lift records', data.qms.total || 0]]}
      ],'WLF-Admin-Panel-'+data.from+'-to-'+data.to);
      if (status.isConnected) status.textContent = 'Excel downloaded.';
    } catch (err) {
      if (status.isConnected) status.textContent = cleanError(err);
    } finally {
      button.disabled = false;
    }
  }

  function openDashboard() {
    const today = AccessCore.dateKey(new Date());
    const filters = {from:today.slice(0,8)+'01', to:today};
    el('tab-workspace-dashboard').innerHTML = dashboardFilters(filters);
    bindDashboard(filters, null);
    loadDashboard(filters);
  }

  function qmsFilters(filters) {
    return `<form id="qmsFilters" class="card overview-panel">
      <div class="overview-heading">
        <div><div class="overview-eyebrow">QMS / COMPONENT TRACKING</div><h3>Project components</h3>
          <p class="note">Record components by project and update their tracking status.</p></div>
        <button class="btn" type="button" id="qmsAdd">+ Add component</button>
      </div>
      <div class="overview-filters qms-filters">
        <label>Project name<input name="project" value="${h(filters.project)}" maxlength="180" placeholder="Find a project"></label>
        <label>Status<select name="status">${WlfFields.option('','All statuses',filters.status)}
          ${qmsStatuses.map(s => WlfFields.option(s,s,filters.status)).join('')}</select></label>
        <button class="btn ghost" type="submit">Apply filters</button>
      </div>
      <p class="note overview-status" id="qmsStatus" role="status"></p>
    </form>`;
  }

  function bindQms(filters) {
    el('qmsFilters').onsubmit = event => {
      event.preventDefault();
      loadQms(Object.fromEntries(new FormData(event.currentTarget)));
    };
    el('qmsAdd').onclick = () => editComponent(null,filters,[]);
  }

  async function loadQms(filters, cursors = [], message = '') {
    const session = SESSION;
    const run = ++qmsRun;
    const status = el('qmsStatus');
    status.textContent = 'Loading project components…';
    try {
      const data = await rpc('getQmsComponents',[T(),{...filters,...cursors.at(-1)}]);
      if (SESSION !== session || run !== qmsRun) return;
      const rows = data.rows.map(row => [
        `<strong>${h(row.project)}</strong>${row.lift_id ? `<small>Lift ${h(row.lift_id)}</small>` : ''}`,
        `<strong>${h(row.component)}</strong><small>${h([row.item_code,row.model].filter(Boolean).join(' · '))}</small>`,
        count(row.quantity),`<span class="overview-pill" data-qms-status="${h(row.status)}">${h(row.status)}</span>`,
        h(row.ownerName),`<button class="btn ghost" type="button" data-qms-view="${h(row.id)}">${row.canEdit ? 'View / edit' : 'View'}</button>`
      ]);
      el('tab-qms').innerHTML = `<div class="overview-stack">${qmsFilters(filters)}
        <section class="card overview-panel"><h3>Component register</h3>
          ${rows.length ? table(['Project','Component','Quantity','Status','Recorded by','Details'],rows,'Project component register') :
            '<p class="note">No matching components.</p>'}
          ${cursors.length || data.hasMore ? paging('qmsPage',cursors.length,data.hasMore,'Page '+(cursors.length+1)) : ''}
        </section></div>`;
      bindQms(filters);
      el('qmsStatus').textContent = message;
      if (el('qmsPagePrev')) {
        const last = data.rows.at(-1);
        bindPaging('qmsPage',() => loadQms(filters,cursors.slice(0,-1)),
          () => loadQms(filters,[...cursors,{beforeAt:last.created_at,beforeId:last.id}]));
      }
      el('tab-qms').querySelectorAll('[data-qms-view]').forEach(button => {
        button.onclick = () => editComponent(data.rows.find(row => row.id === button.dataset.qmsView),filters,cursors);
      });
    } catch (err) {
      if (SESSION === session && run === qmsRun) status.textContent = cleanError(err);
    }
  }

  function editComponent(row, filters, cursors) {
    const dialog = el('qmsDialog');
    const session = SESSION;
    const editable = !row || row.canEdit;
    const input = (name,label,max,required = false) =>
      `<label>${label}<input name="${name}" maxlength="${max}" value="${h(row?.[name])}" ${required ? 'required' : ''}></label>`;
    dialog.innerHTML = `<h2 id="qmsDialogTitle">${row ? 'Component details' : 'Add project component'}</h2>
      <form id="qmsComponentForm">
        <fieldset class="qms-fields" ${editable ? '' : 'disabled'}>
          ${input('project','Project name *',180,true)}
          ${input('lift_id','Lift ID',120)}
          ${input('component','Component name *',180,true)}
          ${input('item_code','Item code',120)}
          ${input('model','Model / specification',180)}
          <label>Quantity *<input name="quantity" type="number" inputmode="numeric" min="1" max="999999" step="1" required value="${h(row?.quantity ?? 1)}"></label>
          <label>Status<select name="status">${qmsStatuses.map(s => WlfFields.option(s,s,row?.status || 'Planned')).join('')}</select></label>
          <label class="span-all">Notes<textarea name="note" maxlength="2000" rows="3">${h(row?.note)}</textarea></label>
        </fieldset>
        ${row ? `<p class="note">Recorded by ${h(row.ownerName)} · Updated ${h(date(row.updated_at,true))}</p>` : ''}
        <p class="note overview-status" id="qmsDialogStatus" role="status"></p>
        <div class="overview-actions">
          ${editable ? '<button class="btn" type="submit">Save component</button>' : ''}
          <button class="btn ghost" type="button" id="qmsClose">${editable ? 'Cancel' : 'Close'}</button>
        </div>
      </form>`;
    const close = el('qmsClose');
    close.onclick = () => dialog.close();
    dialog.oncancel = event => { if (close.disabled) event.preventDefault(); };
    dialog.showModal();
    if (!editable) return;
    const id = row?.id || crypto.randomUUID();
    let operation;
    let lastInput;
    el('qmsComponentForm').onsubmit = async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const button = form.querySelector('[type=submit]');
      const status = el('qmsDialogStatus');
      const payload = Object.fromEntries(new FormData(form));
      const signature = JSON.stringify(payload);
      if (signature !== lastInput) {
        operation = crypto.randomUUID();
        lastInput = signature;
      }
      button.disabled = close.disabled = true;
      status.textContent = 'Saving component…';
      try {
        await rpc('saveQmsComponent',[T(),{...payload,id,operation,revision:row?.revision || 0}]);
        if (SESSION !== session || !form.isConnected) return;
        dialog.close();
        loadQms(filters,row ? cursors : [],'Component saved.');
      } catch (err) {
        if (SESSION === session && form.isConnected) status.textContent = cleanError(err);
      } finally {
        button.disabled = close.disabled = false;
      }
    };
  }

  function open(tab) {
    if (tab === 'account') return loadProfile();
    if (tab === 'workspace-dashboard') return openDashboard();
    const filters = {project:'',status:''};
    el('tab-qms').innerHTML = qmsFilters(filters);
    bindQms(filters);
    loadQms(filters);
  }

  document.addEventListener('DOMContentLoaded',() => {
    const damageNav = document.querySelector('#nav [data-tab="supplier-claim"]') || document.querySelector('#nav [data-tab="damage-demand"]');
    damageNav.insertAdjacentHTML('afterend',
      '<button data-tab="qms" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8 12 3 3 5-6"/></svg>QMS</button>'+
      '<button data-tab="workspace-dashboard" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 20V11m5 9V5m5 15v-8m5 8V8M2 20h20"/></svg>Admin Panel</button>');
    document.querySelector('.content').insertAdjacentHTML('beforeend',
      '<section id="tab-qms" class="tab-content hidden"></section><section id="tab-workspace-dashboard" class="tab-content hidden"></section>');
    document.body.insertAdjacentHTML('beforeend','<dialog id="qmsDialog" aria-labelledby="qmsDialogTitle"></dialog>');
    PAGES.qms = ['QMS','Project-wise component tracking'];
    PAGES['workspace-dashboard'] = ['Admin Panel','Team performance, R&I user activity and menu-wise performance'];
  });

  window.addEventListener('wlf-logout',() => {
    profileRun++;
    dashboardRun++;
    qmsRun++;
    for (const id of ['profileOverview','tab-qms','tab-workspace-dashboard','qmsDialog']) el(id)?.replaceChildren();
    if (el('qmsDialog')?.open) el('qmsDialog').close();
  });

  return {open};
})();
