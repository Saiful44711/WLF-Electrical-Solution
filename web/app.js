
var SESSION = null;
var TOKEN_KEY = 'wlf2_identity:'+DEFAULT_BACKEND;
var CREDIT = 'Design and develop by Md. Saiful Islam - Lift Electrical R&amp;I';
var ROLE_LABEL = { Admin: 'Admin', Full: 'Full + Troubleshooting', Selection: 'Selection + Troubleshooting' };
var PAGES = {
  selection:   ['Component Selection', 'Choose your lift parameters to get the recommended components'],
  calculation: ['Calculations', 'Speed, travel time, power, energy bill and solar sizing'],
  troubleshooting: ['Troubleshooting', 'Controller errors, subcodes and general procedures'],
  account:     ['My Account', 'Manage your password'],
  users:       ['User Management', 'Approve access requests and set access levels'],
  components:  ['Components Data', 'Add, edit or remove component records'],
  dashboard:   ['Usage Dashboard', 'See which user used which feature, and how often']
};
var navBound = false, compData = null, editingRow = null, msgTimer = null;
var INDEX = [], indexStamp = 0;

/* ---------------- helpers ---------------- */
function $(id) { return document.getElementById(id); }
function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function saveToken(t) { try { localStorage.setItem(TOKEN_KEY, t); } catch (e) {} }
function loadToken() { try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; } }
function clearToken() { try { localStorage.removeItem(TOKEN_KEY); } catch (e) {} }
function T() { return SESSION ? SESSION.token : ''; }

function showMsg(text, type, keep) {
  var el = $('globalMsg');
  el.innerHTML = '<div class="msg ' + (type || 'info') + '">' + esc(text) + '</div>';
  if (msgTimer) clearTimeout(msgTimer);
  if (!keep) msgTimer = setTimeout(function () { el.innerHTML = ''; }, 7000);
  window.scrollTo(0, 0);
}
function cleanError(err) {
  var m = (err && err.message) ? err.message : String(err);
  return m.replace(/^(Error|Exception):\s*/i, '');
}
function fail(err) {
  var m = cleanError(err);
  if (m.indexOf('SESSION_EXPIRED') !== -1) { forceLogout('Your session has expired. Please log in again.'); return; }
  showMsg(m, 'error');
}
function busy(btn, on, label) {
  if (!btn) return;
  if (on) { btn.setAttribute('data-label', btn.innerHTML); btn.disabled = true; btn.innerHTML = label || 'Please wait...'; }
  else { btn.disabled = false; if (btn.hasAttribute('data-label')) btn.innerHTML = btn.getAttribute('data-label'); }
}
function failWith(btn) { return function (err) { busy(btn, false); fail(err); }; }

// Usage logging runs in the background so it never slows the screen down
function track(action, details) {
  if (!SESSION) return;
  google.script.run.withFailureHandler(function () {}).logAction(SESSION.token, action, details || '');
}

/* ---------------- boot ---------------- */
document.addEventListener('DOMContentLoaded', function () {
  ['loginEmail', 'loginPassword'].forEach(function (id) {
    $(id).addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
  });
  ['regName', 'regEmail', 'regPassword'].forEach(function (id) {
    $(id).addEventListener('keydown', function (e) { if (e.key === 'Enter') doRegister(); });
  });
  ['sel-capacity', 'sel-speed', 'sel-usageType', 'sel-roping'].forEach(function (id) {
    $(id).addEventListener('change', updateBrands);
  });
  $('sel-brand').addEventListener('change', updateModels);
  document.querySelectorAll('#calcSeg button').forEach(function (b) {
    b.addEventListener('click', function () { openCalcPane(b.getAttribute('data-pane')); });
  });

  renderEngineeringForms();
  bindEngineInvalidation();
  toggleGearFields();
  var t = loadToken();
  if (!t) { showAuth(); return; }
  google.script.run
    .withSuccessHandler(startApp)
    .withFailureHandler(function () { clearToken(); showAuth(); })
    .getSession(t,{lean:true,clientBuild:'2.0.0'});
});

/* ---------------- auth ---------------- */
function showAuth() {
  $('loadingScreen').classList.add('hidden');
  $('app').classList.add('hidden');
  $('authScreen').classList.remove('hidden');
}
function setAuthMsg(text, type) {
  $('authMsg').innerHTML = text ? '<div class="msg ' + type + '">' + esc(text) + '</div>' : '';
}
function switchAuthTab(which) {
  setAuthMsg('', '');
  var login = which === 'login';
  $('loginForm').classList.toggle('hidden', !login);
  $('registerForm').classList.toggle('hidden', login);
  $('tabLogin').classList.toggle('active', login);
  $('tabRegister').classList.toggle('active', !login);
}
function doLogin() {
  var btn = $('loginBtn');
  if(btn.disabled)return;
  setAuthMsg('', '');
  busy(btn, true, 'Logging in...');
  google.script.run
    .withSuccessHandler(function (s) {
      busy(btn, false);
      $('loginPassword').value = '';
      startApp(s);
      track('Login', '');
    })
    .withFailureHandler(function (err) { busy(btn, false); setAuthMsg(cleanError(err), 'error'); })
    .login($('loginEmail').value, $('loginPassword').value,{lean:true,clientBuild:'2.0.0'});
}
function doRegister() {
  var btn = $('regBtn');
  setAuthMsg('', '');
  busy(btn, true, 'Sending...');
  google.script.run
    .withSuccessHandler(function (msg) {
      busy(btn, false);
      $('regPassword').value = '';
      switchAuthTab('login');
      setAuthMsg(msg, 'success');
    })
    .withFailureHandler(function (err) { busy(btn, false); setAuthMsg(cleanError(err), 'error'); })
    .register($('regName').value, $('regEmail').value, $('regPassword').value);
}
function forceLogout(msg) {
  clearToken(); if(typeof Troubleshooting!=='undefined')Troubleshooting.reset(); clearComponentDetails(); SESSION = null; INDEX = []; ENGINE_SELECTED = null; LAST_ENERGY = null;
  showAuth();
  switchAuthTab('login');
  if (msg) setAuthMsg(msg, 'info');
}
function logout() { forceLogout(''); }

/* ---------------- app start / navigation ---------------- */
function startApp(s) {
  if(typeof Troubleshooting!=='undefined'&&SESSION&&SESSION.email!==s.email)Troubleshooting.reset();
  SESSION = s; cacheSession(s);
  saveToken(s.token);
  $('loadingScreen').classList.add('hidden');
  $('authScreen').classList.add('hidden');
  $('app').classList.remove('hidden');

  $('sideName').textContent = s.name;
  $('sideRole').textContent = ROLE_LABEL[s.role] || s.role;
  $('avatar').textContent = (s.name || 'U').trim().charAt(0).toUpperCase();
  $('accountInfo').textContent = s.email;

  document.querySelectorAll('.need-calc').forEach(function (el) { el.classList.toggle('hidden', !s.canCalculate); });
  document.querySelectorAll('.need-admin').forEach(function (el) { el.classList.toggle('hidden', !s.isAdmin); });
  setPending(s.pendingCount || 0);
  if (s.isAdmin && s.pendingCount > 0) {
    showMsg(s.pendingCount + ' access request(s) are waiting for your approval. Open "User Management".', 'info', true);
  }
  if (s.indexError) showMsg(s.indexError, 'error', true);

  if (!navBound) {
    document.querySelectorAll('#nav button').forEach(function (b) {
      b.addEventListener('click', function () { openTab(b.getAttribute('data-tab')); });
    });
    navBound = true;
  }
  setIndex(s.index); seedComponentDetails(s.componentDetails);
  openTab('selection');
}

function setPending(n) {
  var b = $('pendingBadge');
  b.textContent = n;
  b.classList.toggle('hidden', !(n > 0));
}

function openTab(name) {
  document.querySelectorAll('#nav button').forEach(function (b) {
    b.classList.toggle('active', b.getAttribute('data-tab') === name);
  });
  document.querySelectorAll('.tab-content').forEach(function (c) { c.classList.add('hidden'); });
  $('tab-' + name).classList.remove('hidden');
  $('pageTitle').textContent = PAGES[name][0];
  $('pageSub').textContent = PAGES[name][1];
  closeSidebar();
  if (name === 'selection') maybeRefreshIndex();
  if (name === 'troubleshooting') Troubleshooting.open();
  if (name === 'users') loadUsers();
  if (name === 'components') loadComponentsAdmin();
  if (name === 'dashboard') loadStats();
  window.scrollTo(0, 0);
}
function toggleSidebar() {
  $('sidebar').classList.toggle('open');
  $('overlay').classList.toggle('show');
}
function closeSidebar() {
  $('sidebar').classList.remove('open');
  $('overlay').classList.remove('show');
}

/* ---------------- component selection (filtering happens in the browser = instant) ---------------- */
function uniq(rows, key, numeric) {
  var seen = {}, out = [];
  rows.forEach(function (r) {
    if (!seen.hasOwnProperty(r[key])) { seen[r[key]] = 1; out.push(r[key]); }
  });
  out.sort(numeric ? function (a, b) { return a - b; } : undefined);
  return out;
}

// Fill a <select>. keepValue = value to re-select if it still exists. placeholder = optional first option.
function fillSelect(id, values, keepValue, placeholder) {
  var el = $(id);
  el.innerHTML = '';
  if (placeholder !== undefined) {
    var p = document.createElement('option');
    p.value = ''; p.textContent = placeholder;
    el.appendChild(p);
  }
  values.forEach(function (v) {
    var o = document.createElement('option');
    o.value = v; o.textContent = v;
    el.appendChild(o);
  });
  if (keepValue !== undefined && keepValue !== null && keepValue !== '' && values.map(String).indexOf(String(keepValue)) !== -1) {
    el.value = String(keepValue);
  }
}

function setIndex(idx) {
  clearComponentDetails();
  var firstLoad = !INDEX.length;
  INDEX = idx || [];
  indexStamp = Date.now();
  fillSelect('sel-capacity', uniq(INDEX, 'c', true), $('sel-capacity').value);
  fillSelect('sel-speed', uniq(INDEX, 's', true), $('sel-speed').value);
  fillSelect('sel-usageType', uniq(INDEX, 'u', false), $('sel-usageType').value);
  fillSelect('sel-roping', uniq(INDEX, 'p', false), $('sel-roping').value);
  if(firstLoad && INDEX.length && !comboRows().length){var first=INDEX[0];$('sel-capacity').value=String(first.c);$('sel-speed').value=String(first.s);$('sel-usageType').value=first.u;$('sel-roping').value=first.p;}
  updateBrands();
}

function comboRows() {
  var c = Number($('sel-capacity').value), s = Number($('sel-speed').value);
  var u = $('sel-usageType').value, p = $('sel-roping').value;
  return INDEX.filter(function (r) { return r.c === c && r.s === s && r.u === u && r.p === p; });
}

function updateBrands() {
  var rows = comboRows();
  var brands = uniq(rows, 'b', false);
  fillSelect('sel-brand', brands, $('sel-brand').value, 'Any brand');
  $('sel-brand').disabled = !brands.length;
  $('comboHint').textContent = rows.length
    ? rows.length + ' motor option(s) match these parameters'
    : 'No motors are available for this combination';
  updateModels();
}

function updateModels() {
  var b = $('sel-brand').value;
  var models = b ? uniq(comboRows().filter(function (r) { return r.b === b; }), 'm', false) : [];
  fillSelect('sel-model', models, $('sel-model').value, b ? 'Any model' : 'Select a brand first');
  $('sel-model').disabled = !b;
}

function maybeRefreshIndex() {
  if (Date.now() - indexStamp < 120000) return; // data is fresh enough
  refreshIndexNow();
}
function refreshIndexNow() {
  google.script.run.withSuccessHandler(function (r) {
    if (r.error) { showMsg(r.error, 'error'); return; }
    setIndex(r.index); seedComponentDetails(r.componentDetails);
  }).withFailureHandler(function () {}).refreshIndex(T());
}

function searchComponents() {
  var rows = comboRows();
  var b = $('sel-brand').value, m = $('sel-model').value;
  if (b) rows = rows.filter(function (r) { return r.b === b; });
  if (m) rows = rows.filter(function (r) { return r.m === m; });

  $('matchesCard').classList.add('hidden');
  $('reportWrap').classList.add('hidden');
  track('Component Selection', JSON.stringify({
    capacity: $('sel-capacity').value, speed: $('sel-speed').value, usage: $('sel-usageType').value,
    roping: $('sel-roping').value, brand: b, model: m, results: rows.length
  }));

  if (!rows.length) {
    $('matchesCard').classList.remove('hidden');
    $('matchesList').innerHTML = '<div class="msg info" style="margin:0;">No matching components found for these selections.</div>';
    return;
  }
  if (rows.length === 1) { showDetails(rows[0].r, null, $('searchBtn')); return; }

  var html = '';
  rows.forEach(function (r) {
    html += '<button class="chip" onclick="showDetails(' + r.r + ', this)"><b>' + esc(r.b) + '</b><span>' +
      esc(r.m) + ' &middot; ' + esc(r.t) + '</span></button>';
  });
  $('matchesList').innerHTML = html;
  $('matchesCard').classList.remove('hidden');
}

function showDetails(sheetRow, chip, btn) {
  document.querySelectorAll('.chip').forEach(function (c) { c.classList.remove('active'); });
  if (chip) chip.classList.add('active');
  if (btn) busy(btn, true, 'Loading...');
  loadComponentDetails(sheetRow).then(function(d){if(btn)busy(btn,false);renderReport(d);}).catch(failWith(btn));
}

function renderReport(d) {
  ENGINE_SELECTED = d;
  var i = d.inputs;
  var html = '<div class="report-head"><div class="logo-mark"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M12 3v18"/><path d="M8.5 9.5L8.5 7M7 8.2l1.5-1.5L10 8.2"/><path d="M15.5 14.5V17M14 15.8l1.5 1.5 1.5-1.5"/></svg></div>' +
    '<img class="report-company-logo" src="' + companyLogoURL() + '" alt="Walton Lift"><div><h2>Lift Component Selection Report</h2><p>Generated ' + esc(new Date().toLocaleString()) +
    ' &middot; Prepared by ' + esc(SESSION.name) + '</p></div></div>';
  html += '<table class="crit"><tr><th>Capacity</th><th>Speed</th><th>Usage Type</th><th>Roping</th></tr><tr>' +
    '<td>' + esc(i.capacity) + ' kg</td><td>' + esc(i.speed) + ' m/s</td><td>' + esc(i.usageType) + '</td><td>' + esc(i.roping) + '</td></tr></table>';
  html += '<div class="tables">';
  d.categories.forEach(function (c, n) {
    html += '<div class="rt rt' + (n + 1) + '"><div class="rt-title">' + esc(c.title) + '</div><table><thead><tr><th>Parameter</th><th>Value</th></tr></thead><tbody>';
    c.items.forEach(function (it) {
      html += '<tr><td>' + esc(it.label) + '</td><td>' + esc(it.value) + '</td></tr>';
    });
    html += '</tbody></table></div>';
  });
  html += '</div><div class="report-foot">' + CREDIT + '</div>';
  $('report').innerHTML = html;
  $('reportWrap').classList.remove('hidden');
  $('reportWrap').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function printReport() {
  try { window.print(); }
  catch (e) { showMsg('Press Ctrl+P (Cmd+P on Mac) to print or save as PDF.', 'info'); }
}

/* ---------------- calculators ---------------- */
function openCalcPane(name) {
  document.querySelectorAll('#calcSeg button').forEach(function (b) {
    b.classList.toggle('active', b.getAttribute('data-pane') === name);
  });
  document.querySelectorAll('.calc-pane').forEach(function (p) { p.classList.add('hidden'); });
  $('pane-' + name).classList.remove('hidden');
}

function kvHtml(rows) {
  var h = '<div class="kv">';
  rows.forEach(function (r) {
    var cls = r[2] ? ' total' : '';
    h += '<div class="k' + cls + '">' + esc(r[0]) + '</div><div class="v' + cls + '">' + esc(r[1]) + '</div>';
  });
  return h + '</div>';
}

function profileSvg(t1, t2, total) {
  var W = 520, H = 200, left = 46, right = 22, top = 28, base = 150;
  var s = (W - left - right) / total;
  var x0 = left, x1 = left + t1 * s, x2 = left + (t1 + t2) * s, x3 = left + total * s, yTop = top + 12;
  function r2(v) { return Math.round(v * 100) / 100; }
  function tick(x, label) {
    return '<line x1="' + x + '" y1="' + base + '" x2="' + x + '" y2="' + (base + 6) + '" stroke="#94a3b8"/>' +
      '<text x="' + x + '" y="' + (base + 20) + '" font-size="11" fill="#64748b" text-anchor="middle">' + label + '</text>';
  }
  var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg">' +
    '<defs><linearGradient id="gProf" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7c3aed" stop-opacity=".55"/><stop offset="1" stop-color="#06b6d4" stop-opacity=".1"/></linearGradient></defs>' +
    '<line x1="' + left + '" y1="' + base + '" x2="' + (W - right) + '" y2="' + base + '" stroke="#cbd5e1" stroke-width="1.5"/>' +
    '<line x1="' + left + '" y1="' + top + '" x2="' + left + '" y2="' + base + '" stroke="#cbd5e1" stroke-width="1.5"/>' +
    '<polygon points="' + x0 + ',' + base + ' ' + x1 + ',' + yTop + ' ' + x2 + ',' + yTop + ' ' + x3 + ',' + base + '" fill="url(#gProf)" stroke="#4f46e5" stroke-width="2.5" stroke-linejoin="round"/>' +
    '<text x="6" y="' + (top + 4) + '" font-size="11" fill="#64748b">Speed</text>' +
    '<text x="' + (W - right) + '" y="' + (base - 8) + '" font-size="11" fill="#64748b" text-anchor="end">Time (s)</text>' +
    '<text x="' + ((x1 + x2) / 2) + '" y="' + (yTop - 8) + '" font-size="11" fill="#4f46e5" text-anchor="middle" font-weight="700">Rated speed</text>' +
    tick(x0, '0');
  if (x1 - x0 > 30) svg += tick(x1, r2(t1));
  if (t2 > 0 && x2 - x1 > 30 && x3 - x2 > 30) svg += tick(x2, r2(t1 + t2));
  svg += tick(x3, r2(total)) + '</svg>';
  return svg;
}

function calcTravelTime() {
  var input = { height: $('tt-height').value, speed: $('tt-speed').value, accDec: $('tt-acc').value };
  calculatorRun().withSuccessHandler(function (r) {
    var html = kvHtml([
      ['Acc/Dec time (t1)', r.t1 + ' s'],
      ['Acc/Dec distance', r.accelDistance + ' m'],
      ['Total Acc + Dec time', r.totalAccDecTime + ' s'],
      ['Total Acc + Dec distance', r.totalAccDecDist + ' m'],
      ['Remaining distance at rated speed (d2)', r.remainingDistance + ' m'],
      ['Time at rated speed (t2)', r.timeAtRatedSpeed + ' s'],
      ['Total travel time', r.totalTime + ' s', true]
    ]);
    if (r.warning) html = '<div class="msg info">' + esc(r.warning) + '</div>' + html;
    html += '<div class="graph">' + profileSvg(r.t1, r.timeAtRatedSpeed, r.totalTime) + '</div>';
    $('ttResult').innerHTML = html;
    track('Travel Time Calculation', JSON.stringify(input));
  }).withFailureHandler(fail).calculateTravelTime(T(), input);
}

function calcPower() {
  var input = {
    motorPowerKW: $('pw-motor').value, k2: $('pw-k2').value, k3: $('pw-k3').value,
    brakePowerBothW: $('pw-brake').value, tubeLightQty: $('pw-tube').value,
    panelLightQty: $('pw-panel').value, spotLightQty: $('pw-spot').value,
    crossFlowFanQty: $('pw-fan').value, othersFixedW: $('pw-others').value
  };
  calculatorRun().withSuccessHandler(function (r) {
    $('pwResult').innerHTML = kvHtml([
      ['Drive power', r.drivePowerW + ' W'],
      ['Brake power', r.brakePowerW + ' W'],
      ['Shaft lighting', r.shaftLightW + ' W'],
      ['Car light', r.carLightW + ' W'],
      ['Car fan', r.carFanW + ' W'],
      ['Others', r.othersFixedW + ' W'],
      ['Total power', r.totalPowerKW + ' kW', true],
      ['Suggested generator', r.suggestGeneratorKVA + ' kVA', true]
    ]);
    track('Power Calculation', JSON.stringify(input));
  }).withFailureHandler(fail).calculatePowerAndAVR(T(), input);
}

function toggleGearFields() {
  var geared = $('ss-type').value === 'Geared';
  $('ss-gearRow').classList.toggle('hidden', !geared);
  $('ss-slipRow').classList.toggle('hidden', !geared);
  $('ss-method').textContent = geared
    ? 'Geared induction machine: enter motor shaft RPM and the electrical frequency at the same operating point.'
    : 'Gearless machine: car speed from motor shaft RPM, sheave diameter and roping. Slip is not shown.';
  $('ssResult').innerHTML = '';
}

function calcSpeedSlip() {
  var input = {
    diameter: $('ss-diameter').value, roping: $('ss-roping').value, motorType: $('ss-type').value,
    gearA: $('ss-gearA').value, gearB: $('ss-gearB').value,
    ratedRpm: $('ss-rpm').value, frequency: $('ss-freq').value, poles: $('ss-poles').value
  };
  $('ssResult').innerHTML = '<p class="note">Calculating...</p>';
  calculatorRun().withSuccessHandler(function (r) {
    var rows = [['Lift Nominal Car Speed', r.carSpeed.toFixed(4) + ' m/s', true], ['Traction sheave speed', r.sheaveRpm + ' rpm']];
    if (r.motorType === 'Geared') {
      rows.push(['Gear reduction ratio', r.gearRatio + ':1']);
      rows.push(['Synchronous motor speed', r.syncRpm + ' rpm']);
      rows.push(['Slip speed', r.slipRpm + ' rpm']);
      rows.push(['Slip', r.slipPercent + ' %']);
      rows.push(['Rotor slip frequency', r.slipFrequency + ' Hz', true]);
    }
    var html = kvHtml(rows);
    (r.warnings || []).forEach(function (w) { html += '<div class="msg info">' + esc(w) + '</div>'; });
    html += '<p class="note">Car speed = π × sheave diameter (m) × motor shaft RPM ÷ (60 × gear ratio × roping ratio). Gearless gear ratio = 1.</p>';
    if (r.motorType === 'Geared') html += '<p class="note">Synchronous RPM = 120 × motor frequency ÷ poles. Slip (%) = (synchronous RPM − shaft RPM) ÷ synchronous RPM × 100. Slip Hz = slip fraction × motor frequency.</p>';
    $('ssResult').innerHTML = html;
    track('Speed & Slip Calculation', JSON.stringify(input));
  }).withFailureHandler(function (err) { $('ssResult').innerHTML = ''; fail(err); }).calculateSpeedSlip(T(), input);
}

function calcMotorPower() {
  var input = { ratedRpm: $('mp-rpm').value, torque: $('mp-torque').value };
  calculatorRun().withSuccessHandler(function (r) {
    $('mpResult').innerHTML = kvHtml([['Motor power required', r.motorPowerKW.toFixed(2) + ' kW', true]]) +
      '<p class="note">Motor power (kW) = Torque (Nm) &times; RPM &divide; 9550.</p>';
    track('Motor Power Justification', JSON.stringify(input));
  }).withFailureHandler(fail).calculateMotorPower(T(), input);
}

/* ---------------- account ---------------- */
function changePw() {
  var n1 = $('pwNew').value, n2 = $('pwNew2').value;
  if (n1 !== n2) { showMsg('The new passwords do not match.', 'error'); return; }
  google.script.run.withSuccessHandler(function (msg) {
    $('pwOld').value = ''; $('pwNew').value = ''; $('pwNew2').value = '';
    showMsg(msg, 'success');
  }).withFailureHandler(fail).changePassword(T(), $('pwOld').value, n1);
}

/* ---------------- admin: users ---------------- */
function loadUsers() {
  google.script.run.withSuccessHandler(function (users) {
    var tbody = document.querySelector('#usersTable tbody');
    var pending = 0, html = '';
    users.forEach(function (u) {
      if (u.status === 'Pending') pending++;
      var self = u.email.toLowerCase() === SESSION.email.toLowerCase();
      var opts = ['Admin', 'Full', 'Selection'].map(function (r) {
        return '<option value="' + r + '"' + (r === u.role ? ' selected' : '') + '>' + ROLE_LABEL[r] + '</option>';
      }).join('');
      var actions = '';
      if (u.status !== 'Approved') actions += '<button class="btn success sm" onclick="approveUser(' + u.row + ')">Approve</button>';
      if (u.status !== 'Rejected' && !self) actions += '<button class="btn danger sm" onclick="updateUser(' + u.row + ', null, \'Rejected\')">' + (u.status === 'Approved' ? 'Revoke' : 'Reject') + '</button>';
      actions += '<button class="btn ghost sm" onclick="resetPw(' + u.row + ')">Reset password</button>';
      html += '<tr><td><b>' + esc(u.name) + '</b></td><td>' + esc(u.email) + '</td>' +
        '<td><select id="role-' + u.row + '"' + (self ? ' disabled' : ' onchange="updateUser(' + u.row + ', this.value, null)"') + ' style="min-width:190px;padding:8px 10px;">' + opts + '</select></td>' +
        '<td><span class="pill ' + esc(u.status.toLowerCase()) + '">' + esc(u.status) + '</span></td>' +
        '<td><div class="actions">' + actions + '</div></td></tr>';
    });
    tbody.innerHTML = html || '<tr><td colspan="5">No users yet.</td></tr>';
    setPending(pending);
  }).withFailureHandler(fail).adminListUsers(T());
}
function approveUser(row) {
  updateUser(row, $('role-' + row).value, 'Approved');
}
function updateUser(row, role, status) {
  google.script.run.withSuccessHandler(function () { loadUsers(); })
    .withFailureHandler(function (e) { fail(e); loadUsers(); })
    .adminUpdateUser(T(), row, role, status);
}
function resetPw(row) {
  if (!confirm('Create a new temporary password for this user?')) return;
  google.script.run.withSuccessHandler(function (r) {
    $('tempPwBox').innerHTML = '<div class="msg info"><b>Temporary password for ' + esc(r.email) + ':</b> ' +
      '<code style="font-size:15px;font-weight:700;">' + esc(r.tempPassword) + '</code><br>' +
      'Share it privately. The user can change it from "My Account" after logging in.</div>';
  }).withFailureHandler(fail).adminResetPassword(T(), row);
}

/* ---------------- admin: components ---------------- */
function loadComponentsAdmin() {
  google.script.run.withSuccessHandler(function (d) {
    compData = d;
    $('compCount').textContent = d.records.length + ' components';
    $('compHeadRow').innerHTML = d.headers.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') + '<th>Actions</th>';
    var html = '';
    d.records.forEach(function (r) {
      html += '<tr>' + r.values.map(function (v) { return '<td>' + esc(v) + '</td>'; }).join('') +
        '<td><div class="actions"><button class="btn ghost sm" onclick="openEditor(' + r.sheetRow + ')">Edit</button>' +
        '<button class="btn danger sm" onclick="deleteComponent(' + r.sheetRow + ')">Delete</button></div></td></tr>';
    });
    document.querySelector('#componentsTable tbody').innerHTML = html;
  }).withFailureHandler(fail).adminGetComponents(T());
}

function openEditor(sheetRow) {
  if (!compData) return;
  editingRow = sheetRow;
  var rec = null;
  if (sheetRow !== null) {
    compData.records.forEach(function (r) { if (r.sheetRow === sheetRow) rec = r; });
  }
  $('editorTitle').textContent = sheetRow === null ? 'Add component' : 'Edit component';
  var html = '';
  compData.headers.forEach(function (h, i) {
    html += '<div class="field" style="margin:0;"><label>' + esc(h) + (i < 4 ? ' *' : '') + '</label>' +
      '<input type="text" id="ef-' + i + '" value="' + esc(rec ? rec.values[i] : '') + '"></div>';
  });
  $('editorFields').innerHTML = html;
  $('editorCard').classList.remove('hidden');
  window.scrollTo(0, 0);
}
function closeEditor() { $('editorCard').classList.add('hidden'); editingRow = null; }

function saveComponent() {
  var vals = compData.headers.map(function (h, i) { return $('ef-' + i).value; });
  var btn = $('saveCompBtn');
  busy(btn, true, 'Saving...');
  google.script.run.withSuccessHandler(function () {
    busy(btn, false);
    closeEditor();
    loadComponentsAdmin();
    refreshIndexNow();
    showMsg('Component saved.', 'success');
  }).withFailureHandler(failWith(btn)).adminSaveComponent(T(), editingRow, vals);
}

function deleteComponent(sheetRow) {
  if (!confirm('Delete this component permanently?')) return;
  google.script.run.withSuccessHandler(function () {
    loadComponentsAdmin();
    refreshIndexNow();
    showMsg('Component deleted.', 'success');
  }).withFailureHandler(fail).adminDeleteComponent(T(), sheetRow);
}

/* ---------------- admin: dashboard ---------------- */
function loadStats() {
  google.script.run.withSuccessHandler(function (s) {
    var active = s.rows.filter(function (r) { return r.total > 0; }).length;
    var colors = ['#64748b', '#4f46e5', '#06b6d4', '#f97316', '#16a34a', '#e11d48'];
    var max = Math.max.apply(null, s.totals.concat([1]));
    var calcs = 0;
    for (var k = 2; k < s.totals.length; k++) if(s.topics[k].indexOf('Troubleshooting / ')!==0) calcs += s.totals[k];

    var html = '<div class="kpis">' +
      '<div class="kpi k1"><b>' + s.totalEvents + '</b><span>Total actions</span></div>' +
      '<div class="kpi k2"><b>' + active + '</b><span>Active users</span></div>' +
      '<div class="kpi k3"><b>' + s.totals[1] + '</b><span>Component selections</span></div>' +
      '<div class="kpi k4"><b>' + calcs + '</b><span>Calculations run</span></div></div>';

    html += '<div class="card"><div class="card-head"><div class="card-icon ci-indigo"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V11M10 20V4M16 20v-6M22 20H2"/></svg></div>' +
      '<div><h3>Usage by feature</h3><p>How often each feature has been used</p></div></div><div class="bars">';
    s.topics.forEach(function (t, i) {
      html += '<div class="bar"><div class="bar-top"><span>' + esc(t) + '</span><b>' + s.totals[i] + '</b></div>' +
        '<div class="track"><div class="fill" style="width:' + Math.round(s.totals[i] / max * 100) + '%;background:' + colors[i % colors.length] + ';"></div></div></div>';
    });
    html += '</div></div>';

    html += '<div class="card"><div class="card-head"><div class="card-icon ci-teal"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.3-5 6.5-5s5.7 1.5 6.5 5"/></svg></div>' +
      '<div><h3>Usage by user</h3><p>Number of times each user used each feature</p></div></div>' +
      '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>User</th><th>Access</th>';
    s.topics.forEach(function (t) { html += '<th>' + esc(t) + '</th>'; });
    html += '<th>Total</th><th>Last active</th></tr></thead><tbody>';
    s.rows.forEach(function (r) {
      html += '<tr><td><b>' + esc(r.name) + '</b><br><span style="color:#64748b;font-size:12px;">' + esc(r.email) + '</span></td><td>' + esc(ROLE_LABEL[r.role] || r.role) + '</td>';
      r.counts.forEach(function (c) { html += '<td>' + c + '</td>'; });
      html += '<td><b>' + r.total + '</b></td><td>' + esc(r.lastActive) + '</td></tr>';
    });
    html += '</tbody></table></div></div>';
    $('statsArea').innerHTML = '<div id="techDashboard"></div><div id="tbDashboard"></div>'+html;
    if(typeof Troubleshooting!=='undefined')Troubleshooting.dashboard();if(typeof LiveWorkspace!=='undefined')LiveWorkspace.renderSupportDashboard();
  }).withFailureHandler(fail).adminStats(T());
}


var ENGINE_SELECTED = null, LAST_ENERGY = null;
// key, label, example/default, min, max, step, help
var ENERGY_BASIC = [
  ['capacity','Lift capacity (kg)',630,1,50000,1],
  ['speed','Rated car speed (m/s)',1,.01,20,'any'],
  ['motorPowerKW','Motor output (kW)',5.5,.01,1000,'any','Use motor nameplate kW.'],
  ['tripDistance','Average one-way distance (m)',15,.01,1000,'any','Average journey distance, not always the full shaft height.'],
  ['trips','One-way trips / operating day',200,0,50000,1,'Up + down trips. One round trip counts as two.'],
  ['tariff','Electricity rate / kWh','',0,100000,'any','Enter the rate from your electricity bill.'],
  ['lightW','Car lights: total watts',48,0,100000,'any'],
  ['lightHours','Car light hours / day',16,0,24,'any'],
  ['fanW','Car fans: total watts',50,0,100000,'any'],
  ['fanHours','Car fan hours / day',8,0,24,'any']
];
var ENERGY_ADVANCED = [
  ['carMass','Empty car + sling mass (kg)',800,1,100000,'any','Enter the real mass for this lift.'],
  ['balance','Counterweight balance (%)',40,0,100,'any','Counterweight = empty car mass + this fraction of rated capacity.'],
  ['upLoad','Average passenger load going up (%)',50,0,100,'any','Percentage of lift capacity.'],
  ['downLoad','Average passenger load going down (%)',20,0,100,'any'],
  ['upShare','Share of trips going up (%)',50,0,100,'any'],
  ['acceleration','Acceleration / deceleration (m/s²)',.5,.01,3,'any'],
  ['frictionPercent','Equivalent friction (% of moving weight)',3,0,20,'any','Engineering estimate. Calibrate against measured energy.'],
  ['extraMass','Extra equivalent rotational inertia (kg)',100,0,100000,'any'],
  ['mechanicalEfficiency','Transmission efficiency (%)',85,.01,100,'any','Use your machine/transmission estimate; geared and gearless differ.'],
  ['motorEfficiency','Motor efficiency (%)',90,.01,100,'any'],
  ['driveEfficiency','Elevator drive efficiency (%)',95,.01,100,'any'],
  ['regenEfficiency','Effective regeneration recovery (%)',0,0,100,'any','Keep 0 for a braking-resistor system. Use a verified recovery value for a regenerative system.'],
  ['controlW','Standing controller / standby load (W)',80,0,100000,'any','Always-on control load, excluding the light and fan entered above. Applied 24 h/day.'],
  ['brakeW','Brake coil total watts while moving',324,0,100000,'any'],
  ['doorW','Door drive watts while operating',150,0,100000,'any'],
  ['doorSeconds','Door operating seconds / trip',10,0,600,'any'],
  ['monthDays','Calendar days in month',30,1,31,1],
  ['monthActiveDays','Days with trips in month',30,0,31,1],
  ['yearDays','Calendar days in year',365,365,366,1],
  ['yearActiveDays','Days with trips in year',365,0,366,1]
];
var SOLAR_BASIC = [
  ['motorPowerKW','Motor output (kW)',5.5,.01,1000,'any'],
  ['motorCurrent','Motor nameplate current (A)','',.01,10000,'any','Required for elevator drive current selection.'],
  ['voltage','Three-phase line voltage (V)',400,100,1000,'any'],
  ['auxiliaryW','Lights + fan + controls + brake (W)',502,0,100000,'any','Loads that can be on together, excluding the traction motor.'],
  ['dailyKWh','Daily AC energy required (kWh)',10,0,100000,'any','Use your meter or copy the Energy Bill result.'],
  ['solarCoverage','Daily energy supplied by solar (%)',100,0,100,'any','Energy target. This does not mean continuous solar-only operation.'],
  ['sunHours','Design peak sun hours / day',4,.1,12,'any','Use your location and design-season irradiance. 4 is an example.'],
  ['panelW','One panel rated watts',550,1,2000,'any'],
  ['backupHours','Battery backup duration (hours)',2,.01,168,'any'],
  ['backupDuty','Motor running time during backup (%)',10,0,100,'any','Example: 10 means 6 minutes running per hour. Auxiliaries run throughout backup.']
];
var SOLAR_ADVANCED = [
  ['motorEfficiency','Motor efficiency (%)',90,.01,100,'any'],
  ['driveEfficiency','Elevator drive efficiency (%)',95,.01,100,'any'],
  ['inputPF','True input power factor (%)',90,.01,100,'any','Elevator controller input PF, including distortion; not motor cos φ.'],
  ['margin','AC supply & backup energy margin (%)',25,0,100,'any'],
  ['surgePercent','Short-duration motor demand (%)',150,100,400,'any','Use the required elevator acceleration/overload duty.'],
  ['surgeSeconds','Required overload duration (seconds)',60,1,600,1],
  ['solarYield','Overall PV-to-load yield (%)',70,.01,100,'any','Includes temperature, soiling, wiring, conversion and storage losses for your system.'],
  ['inverterEfficiency','Battery inverter efficiency (%)',92,.01,100,'any'],
  ['batteryEfficiency','Battery discharge efficiency (%)',95,.01,100,'any'],
  ['dod','Usable battery depth of discharge (%)',80,.01,100,'any'],
  ['retainedCapacity','Battery capacity at replacement (%)',80,.01,100,'any','Allows for ageing.'],
  ['moduleV','Battery module nominal voltage (V)',51.2,1,1000,'any','Must match the chosen inverter battery input.'],
  ['minimumV','Minimum operating battery voltage (V)',44.8,1,1000,'any','Use the supported battery/inverter cutoff voltage.'],
  ['moduleAh','One battery module capacity (Ah)',100,1,100000,'any'],
  ['moduleCurrent','One module continuous discharge (A)',100,.01,100000,'any','Use module/BMS datasheet limit.'],
  ['modulePeakCurrent','One module peak discharge (A)',150,.01,100000,'any','Use module/BMS datasheet limit.'],
  ['modulePeakSeconds','Module peak-current rating duration (s)',10,1,3600,'any','For longer overloads, the calculator uses the module continuous current limit.'],
  ['parallelLimit','Manufacturer maximum parallel modules',8,1,1000,1]
];

function engineFields(prefix, fields) {
  return '<div class="engineering-grid">' + fields.map(function (f) {
    var id = prefix + '-' + f[0];
    return '<div class="field"><label for="' + id + '">' + esc(f[1]) + '</label>' +
      '<input type="number" inputmode="' + (f[5] === 1 ? 'numeric' : 'decimal') + '" id="' + id + '" value="' + esc(f[2]) + '" min="' + f[3] + '" max="' + f[4] + '" step="' + f[5] + '">' +
      (f[6] ? '<small>' + esc(f[6]) + '</small>' : '') + '</div>';
  }).join('') + '</div>';
}
function renderEngineeringForms() {
  $('energyForm').innerHTML = '<p class="note example-note">Example values are prefilled. Replace them with your lift data; expand the assumptions before using the result.</p>' +
    '<button class="btn ghost sm" onclick="useSelectedLift(\'energy\')">Use selected lift / motor</button>' +
    engineFields('en', ENERGY_BASIC) +
    '<div class="field currency-field"><label for="en-currency">Currency</label><input id="en-currency" value="BDT" maxlength="12"></div>' +
    '<details class="assumptions"><summary>Lift balance, losses &amp; operating days</summary>' + engineFields('en', ENERGY_ADVANCED) + '</details>' +
    '<button id="energyBtn" class="btn" onclick="calcEnergyBill()">Calculate energy &amp; cost</button>';
  $('solarForm').innerHTML = '<p class="note example-note">Sourcing estimate for an AC solar/battery supply feeding the existing elevator controller. Example settings require review.</p>' +
    '<div class="engineering-actions"><button class="btn ghost sm" onclick="useSelectedLift(\'solar\')">Use selected motor</button>' +
    '<button class="btn ghost sm" onclick="useEnergyForSolar()">Use latest energy result</button></div>' + engineFields('so', SOLAR_BASIC) +
    '<details class="assumptions"><summary>Inverter duty, battery module &amp; losses</summary>' + engineFields('so', SOLAR_ADVANCED) + '</details>' +
    '<button id="solarBtn" class="btn" onclick="calcSolarSizing()">Calculate sourcing requirements</button>';
}
function engineInput(prefix, basic, advanced) {
  var input = {};
  basic.concat(advanced).forEach(function (f) { input[f[0]] = $(prefix + '-' + f[0]).value; });
  return input;
}
function engineWarnings(items) {
  return (items || []).map(function (w) { return '<div class="msg info">' + esc(w) + '</div>'; }).join('');
}
function engineN(n, places) { return Number(n).toLocaleString(undefined, {minimumFractionDigits: places || 0, maximumFractionDigits: places || 0}); }
function engineMetric(label, value, unit) {
  return '<div class="engineering-metric"><span>' + esc(label) + '</span><b>' + esc(value) + '</b><small>' + esc(unit) + '</small></div>';
}
function invalidateEnergy() {
  LAST_ENERGY = null;
  $('energyResult').innerHTML = '';
}
function bindEngineInvalidation() {
  $('energyForm').addEventListener('input', invalidateEnergy);
  $('solarForm').addEventListener('input', function () { $('solarResult').innerHTML = ''; });
}
function useSelectedLift(which) {
  if (!ENGINE_SELECTED) { showMsg('First search components and open a motor recommendation. Then return to this calculator.', 'info'); return; }
  var values = {};
  ENGINE_SELECTED.categories.forEach(function (c) { c.items.forEach(function (it) { values[it.label] = it.value; }); });
  var motor = Number(values['Motor Power (kW)']);
  if (!(motor > 0)) { showMsg('The selected motor has no numeric kW value. Enter its nameplate rating manually.', 'error'); return; }
  if (which === 'energy') {
    $('en-capacity').value = ENGINE_SELECTED.inputs.capacity;
    $('en-speed').value = ENGINE_SELECTED.inputs.speed;
    $('en-motorPowerKW').value = motor;
    invalidateEnergy();
  } else {
    $('so-motorPowerKW').value = motor;
    var amps = parseFloat(values['Motor Rated Current (A)']);
    $('so-motorCurrent').value = isFinite(amps) && amps > 0 ? amps : '';
    $('solarResult').innerHTML = '';
  }
  showMsg('Selected motor copied. Review the remaining lift and operating assumptions.', 'success');
}
function useEnergyForSolar() {
  if (!LAST_ENERGY) { showMsg('Calculate Energy Bill first, then use this button.', 'info'); return; }
  $('so-dailyKWh').value = LAST_ENERGY.dailyKWh;
  $('so-motorPowerKW').value = LAST_ENERGY.motorPowerKW;
  $('so-auxiliaryW').value = LAST_ENERGY.auxiliaryW;
  $('so-backupDuty').value = Math.round(LAST_ENERGY.movingHours / 24 * 10000) / 100;
  $('solarResult').innerHTML = '';
  showMsg('Daily energy, motor kW, auxiliaries and average daily running share copied. Adjust backup running share for your actual outage period.', 'success');
}
function calcEnergyBill() {
  var input = engineInput('en', ENERGY_BASIC, ENERGY_ADVANCED);
  input.currency = $('en-currency').value;
  var signature = JSON.stringify(input), btn = $('energyBtn');
  LAST_ENERGY = null;
  $('energyResult').innerHTML = '';
  busy(btn, true, 'Calculating...');
  calculatorRun().withSuccessHandler(function (r) {
    busy(btn, false);
    var current = engineInput('en', ENERGY_BASIC, ENERGY_ADVANCED); current.currency = $('en-currency').value;
    if (JSON.stringify(current) !== signature) { showMsg('Inputs changed while calculating. Calculate again.', 'info'); return; }
    LAST_ENERGY = r;
    var html = '<div class="engineering-metrics">' + engineMetric('Daily', engineN(r.dailyKWh, 2), 'kWh / operating day') +
      engineMetric('Monthly', engineN(r.monthlyKWh, 2), 'kWh / selected month') + engineMetric('Annually', engineN(r.annualKWh, 2), 'kWh / selected year') + '</div>';
    if (r.dailyCost !== null) html += '<div class="engineering-metrics cost-metrics">' +
      engineMetric('Daily energy cost', engineN(r.dailyCost, 2), r.currency) + engineMetric('Monthly energy cost', engineN(r.monthlyCost, 2), r.currency) +
      engineMetric('Annual energy cost', engineN(r.annualCost, 2), r.currency) + '</div><p class="note">Energy charge at your entered flat rate. VAT, demand charges, fixed charges and tariff slabs are not included.</p>';
    html += '<details class="assumptions"><summary>Daily energy breakdown &amp; assumptions</summary>' + kvHtml([
      ['Traction electricity before recovery', r.tractionKWh + ' kWh'], ['Brake coils', r.brakeKWh + ' kWh'],
      ['Door operation', r.doorKWh + ' kWh'], ['Lights + fan + standing controls', r.standingKWh + ' kWh'],
      ['Estimated regeneration credit', r.recoveredKWh + ' kWh'], ['Counterweight mass', r.counterweightKg + ' kg'],
      ['Time per average trip', r.tripSeconds + ' s'], ['Moving time per day', r.movingHours + ' h'],
      ['Peak estimated shaft demand', r.peakShaftKW + ' kW'],
      ['Month: operating / calendar days', r.monthActiveDays + ' / ' + r.monthDays],
      ['Year: operating / calendar days', r.yearActiveDays + ' / ' + r.yearDays]
    ]) + '<p class="note">Standing controls and the entered light/fan hours apply on non-trip days too. This trip model is an engineering estimate, not an ISO energy-class certificate.</p></details>' + engineWarnings(r.warnings);
    html += '<button class="btn ghost" onclick="openCalcPane(\'solar\'); useEnergyForSolar();">Use this result for solar sizing</button>';
    $('energyResult').innerHTML = html;
    track('Energy Bill Calculation', 'Capacity=' + input.capacity + ' kg; trips/day=' + input.trips + '; energy=' + r.dailyKWh + ' kWh/day');
  }).withFailureHandler(function (err) { busy(btn, false); fail(err); }).calculateEnergyBill(T(), input);
}
function calcSolarSizing() {
  var input = engineInput('so', SOLAR_BASIC, SOLAR_ADVANCED), signature = JSON.stringify(input), btn = $('solarBtn');
  $('solarResult').innerHTML = '';
  busy(btn, true, 'Calculating...');
  calculatorRun().withSuccessHandler(function (r) {
    busy(btn, false);
    if (JSON.stringify(engineInput('so', SOLAR_BASIC, SOLAR_ADVANCED)) !== signature) { showMsg('Inputs changed while calculating. Calculate again.', 'info'); return; }
    var html = '<div class="engineering-metrics">' + engineMetric('AC supply minimum', engineN(r.inverterKW, 2), 'kW continuous') +
      engineMetric('Battery bank', engineN(r.bankKWh, 2), 'kWh nominal') + engineMetric('Solar panels', r.panelCount, r.panelW + ' W each') + '</div>';
    if (!r.configurationValid) html += '<div class="msg error">Battery module configuration exceeds its parallel limit. Change the battery module or system voltage before selection.</div>';
    html += '<h4>1. Elevator motor drive / controller</h4>' + kvHtml([
      ['Motor power class for sourcing', r.driveClassKW + ' kW or larger'], ['Required continuous motor output current', 'At least ' + r.driveCurrentA + ' A'],
      ['Required motor overload current', r.drivePeakCurrentA + ' A for ' + r.overloadSeconds + ' s']
    ]) + '<p class="note">Keep an elevator-rated drive with the correct motor technology, brake control and feedback. kW class alone does not establish compatibility.</p>';
    html += '<h4>2. Three-phase solar / battery AC supply</h4>' + kvHtml([
      ['AC voltage', r.voltage + ' V line-to-line, three-phase'], ['Minimum continuous active power', r.inverterKW + ' kW'],
      ['Minimum continuous apparent power', r.inverterKVA + ' kVA'], ['Minimum AC line current', r.inverterCurrentA + ' A'],
      ['Required short-duration active power', r.inverterPeakKW + ' kW for ' + r.overloadSeconds + ' s'],
      ['Required short-duration apparent power', r.inverterPeakKVA + ' kVA for ' + r.overloadSeconds + ' s']
    ]);
    html += '<h4>3. Battery modules</h4>' + kvHtml([
      ['Energy during selected backup window', r.backupEnergyKWh + ' kWh AC'], ['Required nominal battery energy', r.requiredBatteryKWh + ' kWh'],
      ['Module quantity in parallel', r.moduleCount + ' at ' + r.moduleVoltage + ' V nominal'], ['Selected bank capacity', r.bankAh + ' Ah / ' + r.bankKWh + ' kWh'],
      ['Usable AC energy after losses and ageing', r.usableACKWh + ' kWh'], ['Required continuous DC current', r.dcCurrentA + ' A'],
      ['Required peak DC current', r.dcPeakCurrentA + ' A'], ['Minimum modules: energy / continuous / peak', r.energyModuleCount + ' / ' + r.continuousModuleCount + ' / ' + r.peakModuleCount]
    ]);
    html += '<h4>4. Solar panel array</h4>' + kvHtml([
      ['Required array for daily energy target', r.pvRequiredKWp + ' kWp'], ['Panel quantity', r.panelCount + ' × ' + r.panelW + ' W'],
      ['Selected array nameplate', r.installedPVKWp + ' kWp'], ['Estimated daily energy at design sun hours', r.pvDailyKWh + ' kWh']
    ]) + engineWarnings(r.warnings);
    $('solarResult').innerHTML = html;
    track('Solar Sizing Calculation', 'Motor=' + input.motorPowerKW + ' kW; modules=' + r.moduleCount + '; PV=' + r.installedPVKWp + ' kWp');
  }).withFailureHandler(function (err) { busy(btn, false); fail(err); }).calculateSolarSizing(T(), input);
}
