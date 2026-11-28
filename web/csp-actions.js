/* WLF v2.7.2 · Content-Security-Policy: the page runs no inline script, so the old onclick="..." attributes became
   data-onclick="..." and data-onchange="...". This small dispatcher runs them: only calls of named global functions
   with plain arguments (numbers, quoted text, this, this.value, true, false, null) - nothing else is ever evaluated. */
(function () {
  'use strict';
  var CALL = /^\s*([A-Za-z_$][\w$]*)\s*\(([^()]*)\)\s*$/;
  function arg(token, el) {
    var t = token.trim();
    if (t === '') return undefined;
    if (t === 'this') return el;
    if (t === 'this.value') return el.value;
    if (t === 'this.checked') return el.checked;
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (t === 'null') return null;
    if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
    var q = /^'((?:[^'\\]|\\.)*)'$|^"((?:[^"\\]|\\.)*)"$/.exec(t);
    if (q) return (q[1] !== undefined ? q[1] : q[2]).replace(/\\(.)/g, '$1');
    throw new Error('Unsupported argument in a page action: ' + t);
  }
  function split(list) {
    var out = [], cur = '', quote = '';
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (quote) { cur += c; if (c === '\\') { cur += list[++i] || ''; } else if (c === quote) quote = ''; }
      else if (c === '"' || c === "'") { quote = c; cur += c; }
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
    if (cur.trim() !== '' || out.length) out.push(cur);
    return out;
  }
  function run(code, el, event) {
    String(code).split(';').forEach(function (statement) {
      if (!statement.trim()) return;
      var m = CALL.exec(statement);
      if (!m || typeof window[m[1]] !== 'function') throw new Error('Unknown page action: ' + statement.trim());
      window[m[1]].apply(el, split(m[2]).map(function (t) { return arg(t, el); }));
    });
  }
  window.WlfRunAction = run;
  window.closeSettingsDialog = function () { var d = document.getElementById('settingsDialog'); if (d && d.close) d.close(); };
  document.addEventListener('click', function (event) {
    var el = event.target.closest && event.target.closest('[data-onclick]');
    if (el && !el.disabled) run(el.getAttribute('data-onclick'), el, event);
  });
  document.addEventListener('change', function (event) {
    var el = event.target;
    if (el && el.hasAttribute && el.hasAttribute('data-onchange')) run(el.getAttribute('data-onchange'), el, event);
  });
})();
