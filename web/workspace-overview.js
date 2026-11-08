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
          <p>${h(profile.role)} · ${h(profile.email)}</p><span class="overview-pill">${h(profile.status)}</span></div>
      </div>
      <dl class="profile-account">
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
        ${activityList(data,true,offset)}
        <p class="note overview-status" id="profileStatus" role="status"></p>
      </div>`;
      el('profileRefresh').onclick = () => loadProfile();
      if (el('profileActivityPrev')) bindPaging('profileActivity',() => loadProfile(offset-pageSize),() => loadProfile(offset+pageSize));
    } catch (err) {
      if (SESSION === session && run === profileRun) el('profileStatus').textContent = cleanError(err);
    }
  }

  function dashboardFilters(filters, data) {
    const opt = WlfFields.option;
    const sectionOptions = (data?.sections || []).map(s => opt(s.section,s.label,filters.section)).join('');
    const people = data?.people || [];
    const memberOptions = people.map(person => opt(person.id,person.name,filters.member)).join('');
    const missingMember = filters.member && !people.some(person => person.id === filters.member);
    return `<form id="workspaceFilters" class="card overview-panel">
      <div class="overview-heading"><div><h3>Filters &amp; report</h3>
        <p class="note">Activity dates use Dhaka time. Clear both dates to see all time.</p></div></div>
      <div class="overview-filters">
        <label>From<input type="date" name="from" value="${h(filters.from)}"></label>
        <label>To<input type="date" name="to" value="${h(filters.to)}"></label>
        <label>Team member<select name="member">${opt('','All members',filters.member)}
          ${missingMember ? opt(filters.member,'Selected member',filters.member) : ''}${memberOptions}</select></label>
        <label>Section<select name="section">${opt('','All sections',filters.section)}${sectionOptions}</select></label>
        <div class="overview-actions">
          <button class="btn" type="submit">Apply filters</button>
          <button class="btn ghost" type="button" id="workspaceExport" ${data ? '' : 'disabled'}>Download Excel</button>
        </div>
      </div>
      <p class="note overview-status" id="workspaceStatus" role="status"></p>
    </form>`;
  }

  function renderDashboard(data, filters, offset) {
    const root = el('tab-workspace-dashboard');
    const t = data.totals;
    const prior = data.previous || {};
    root.innerHTML = `<div class="overview-stack">
      ${dashboardFilters(filters,data)}
      <section class="overview-section">
        <div class="overview-heading"><div><h3>Team KPIs</h3><p class="note">${h(filters.from ? date(filters.from) : 'All earlier dates')} to ${h(filters.to ? date(filters.to) : 'latest activity')} · Accessible sections</p></div></div>
        <div class="overview-metrics">
          ${metric('Recorded activities',count(t.activities),'blue',delta(t.activities,prior.activities))}
          ${metric('Completed outcomes',count(t.completed),'teal',delta(t.completed,prior.completed))}
          ${metric('Recorded time',duration(t.minutes),'violet',delta(t.minutes,prior.minutes,duration))}
          ${metric('Active members',count(t.members),'amber',delta(t.members,prior.members))}
        </div>
      </section>
      <div class="overview-columns">
        <section class="card overview-panel"><h3>Weekly activity trend</h3><p class="note">Activity count by week, up to 12 weeks with records</p>
          ${bars(data.weeks,row => date(row.week))}</section>
        <section class="card overview-panel"><h3>Activity by section</h3><p class="note">Count of recorded actions and work entries</p>
          ${bars(data.modules.filter(row => row.activities),row => row.label)}</section>
      </div>
      <section class="card overview-panel">
        <div class="overview-heading"><div><h3>Team performance</h3>
          <p class="note">Completed outcomes include solved requests, completed R&amp;I work, received demands and verified QMS entries.</p></div></div>
        ${data.members.length ? table(['Member','Role','Activities','Completed','Recorded time','Last activity'],
          data.members.map(row => [h(row.name),h(row.role),count(row.activities),count(row.completed),
            duration(row.minutes),h(date(row.last_at,true))]),'Team performance') :
          '<p class="note">No team activity matches these filters.</p>'}
      </section>
      ${activityList(data,false,offset)}
    </div>`;
    bindDashboard(filters);
    if (el('dashboardActivityPrev')) bindPaging('dashboardActivity',
      () => loadDashboard(filters,offset-pageSize),() => loadDashboard(filters,offset+pageSize));
  }

  function bindDashboard(filters) {
    const form = el('workspaceFilters');
    form.onsubmit = event => {
      event.preventDefault();
      loadDashboard(Object.fromEntries(new FormData(form)));
    };
    el('workspaceExport').onclick = () => {
      const edited = Object.fromEntries(new FormData(form));
      if (Object.keys(filters).some(key => edited[key] !== filters[key])) {
        el('workspaceStatus').textContent = 'Apply your filter changes before downloading.';
        return;
      }
      exportDashboard(filters);
    };
  }

  async function loadDashboard(filters, offset = 0) {
    const session = SESSION;
    const run = ++dashboardRun;
    const status = el('workspaceStatus');
    status.textContent = 'Loading KPI data…';
    try {
      const data = await rpc('getWorkspaceDashboard',[T(),{...filters,offset}]);
      if (SESSION === session && run === dashboardRun) renderDashboard(data,filters,offset);
    } catch (err) {
      if (SESSION === session && run === dashboardRun) status.textContent = cleanError(err);
    }
  }

  async function exportDashboard(filters) {
    const session = SESSION;
    const run = dashboardRun;
    const status = el('workspaceStatus');
    const button = el('workspaceExport');
    button.disabled = true;
    status.textContent = 'Building Excel report…';
    try {
      const data = await rpc('getWorkspaceReport',[T(),filters]);
      if (SESSION !== session || run !== dashboardRun) return;
      const t = data.totals;
      const labels = new Map(data.sections.map(s => [s.section,s.label]));
      await WlfExports.excel([
        {name:'KPIs',headers:['Metric','Selected period','Previous period'],rows:[
          ['From (Dhaka)',filters.from],['To (Dhaka)',filters.to],
          ['Section',labels.get(filters.section) || 'All sections'],
          ['Member',data.people.find(p => p.id === filters.member)?.name || (filters.member ? 'Selected member' : 'All members')],
          ['Recorded activities',t.activities,data.previous?.activities ?? ''],
          ['Completed outcomes',t.completed,data.previous?.completed ?? ''],
          ['Recorded minutes',t.minutes,data.previous?.minutes ?? ''],
          ['Active members',t.members,data.previous?.members ?? '']
        ]},
        {name:'Team performance',headers:['Member','Role','Activities','Completed','Recorded minutes','Last activity (Dhaka)'],
          rows:data.members.map(r => [r.name,r.role,r.activities,r.completed,r.minutes,date(r.last_at,true)])},
        {name:'Sections',headers:['Section','Activities','Completed','Recorded minutes'],
          rows:data.modules.map(r => [r.label,r.activities,r.completed,r.minutes])},
        {name:'Activity log',headers:['Logged (Dhaka)','Section','Work','Member','Outcome','Recorded minutes'],
          rows:data.recent.map(r => [date(r.happened_at,true),labels.get(r.section),r.entry,r.name,r.outcome,r.minutes ?? ''])}
      ],'WLF-Workspace-KPIs-'+AccessCore.dateKey(new Date()));
      if (status.isConnected) status.textContent = 'Excel downloaded.';
    } catch (err) {
      if (status.isConnected) status.textContent = cleanError(err);
    } finally {
      button.disabled = false;
    }
  }

  function openDashboard() {
    const now = new Date();
    const filters = {
      from:AccessCore.dateKey(new Date(now.getTime()-29*86400000)), to:AccessCore.dateKey(now), member:'',section:''
    };
    el('tab-workspace-dashboard').innerHTML = dashboardFilters(filters);
    bindDashboard(filters);
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
    const damageNav = document.querySelector('#nav [data-damage-nav="dashboard"]');
    damageNav.insertAdjacentHTML('afterend',
      '<button data-tab="qms" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8 12 3 3 5-6"/></svg>QMS</button>'+
      '<button data-tab="workspace-dashboard" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 20V11m5 9V5m5 15v-8m5 8V8M2 20h20"/></svg>Dashboard</button>');
    document.querySelector('.content').insertAdjacentHTML('beforeend',
      '<section id="tab-qms" class="tab-content hidden"></section><section id="tab-workspace-dashboard" class="tab-content hidden"></section>');
    document.body.insertAdjacentHTML('beforeend','<dialog id="qmsDialog" aria-labelledby="qmsDialogTitle"></dialog>');
    PAGES.qms = ['QMS','Project-wise component tracking'];
    PAGES['workspace-dashboard'] = ['Dashboard','Workspace KPIs, team performance and reporting'];
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
