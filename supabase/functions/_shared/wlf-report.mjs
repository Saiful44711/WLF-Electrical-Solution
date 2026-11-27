/* WLF v2.7.0 · Monthly reports: Technical Support, R&I Team Activity and Damage Demand.
   Pure functions: data from wlf_report_admin('data') in, a styled, print-ready .xlsx out. Used by the wlf-maintenance Edge Function. */

const reportMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const OREL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PREL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const xmlText = v => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
  .replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'}[c]));
const col = i => { let s = ''; for (let n = i + 1; n; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; };

/* ------------------------------------------------------------------ styles
   cellXfs index: 0 plain · 1 title · 2 subtitle · 3 block heading · 4 table header
   text/int/pct/dec: 5/6/7/8 normal · 9/10/11/12 highlighted · 13/14/15/16 total row · 17 note */
const STYLES = XML + '<styleSheet xmlns="' + MAIN + '">' +
  '<numFmts count="2"><numFmt numFmtId="164" formatCode="0.0%"/><numFmt numFmtId="165" formatCode="#,##0.0"/></numFmts>' +
  '<fonts count="6"><font><sz val="10"/><name val="Calibri"/><family val="2"/></font>' +
  '<font><b/><sz val="16"/><color rgb="FF1F3864"/><name val="Calibri"/><family val="2"/></font>' +
  '<font><i/><sz val="10"/><color rgb="FF595959"/><name val="Calibri"/><family val="2"/></font>' +
  '<font><b/><sz val="12"/><color rgb="FF1F4E79"/><name val="Calibri"/><family val="2"/></font>' +
  '<font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>' +
  '<font><b/><sz val="10"/><name val="Calibri"/><family val="2"/></font></fonts>' +
  '<fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FF1F4E79"/><bgColor indexed="64"/></patternFill></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFFFE699"/><bgColor indexed="64"/></patternFill></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFE7E6E6"/><bgColor indexed="64"/></patternFill></fill></fills>' +
  '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>' +
  '<border><left style="thin"><color rgb="FFA6A6A6"/></left><right style="thin"><color rgb="FFA6A6A6"/></right>' +
  '<top style="thin"><color rgb="FFA6A6A6"/></top><bottom style="thin"><color rgb="FFA6A6A6"/></bottom><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="19">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="0" fontId="4" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>' +
  [[0, 0], [3, 0], [164, 0], [165, 0], [0, 3], [3, 3], [164, 3], [165, 3], [0, 4], [3, 4], [164, 4], [165, 4]].map(([fmt, fill], i) =>
    '<xf numFmtId="' + fmt + '" fontId="' + (fill ? 5 : 0) + '" fillId="' + fill + '" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">' +
    '<alignment vertical="top"' + (i % 4 === 0 ? ' wrapText="1"' : '') + '/></xf>').join('') +
  '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="3" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="top" wrapText="1"/></xf>' +
  '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
const KIND = {text: 0, int: 1, pct: 2, dec: 3};
const styleOf = (type, mode) => type === 'value' ? 18 : 5 + (mode === 'hl' ? 4 : mode === 'total' ? 8 : 0) + (KIND[type] ?? 0);

/* sheet = {name, title, subtitle, blocks:[{heading, note, headers, types, rows:[{cells, mode}], empty}]} */
function sheetXml(sheet) {
  const rows = [], merges = [];
  let r = 0, width = 1;
  const widths = [];
  const measure = (i, v, header, cap = 58) => {
    const s = String(v ?? ''), longest = header ? Math.max(...s.split(' ').map(w => w.length), Math.ceil(s.length / 2)) : Math.max(...s.split('\n').map(x => x.length));
    widths[i] = Math.max(widths[i] || 0, Math.min(cap, longest));
  };
  const put = cells => { r += 1; rows.push('<row r="' + r + '">' + cells.map(([v, s], i) => cellXml(v, s, col(i) + r)).join('') + '</row>'); };
  for (const b of sheet.blocks) width = Math.max(width, b.headers ? b.headers.length : 2);
  put([[sheet.title, 1]]); merges.push('A1:' + col(Math.max(width, 4) - 1) + '1');
  put([[sheet.subtitle, 2]]); merges.push('A2:' + col(Math.max(width, 4) - 1) + '2');
  for (const b of sheet.blocks) {
    r += 1; rows.push('<row r="' + r + '"/>');
    put([[b.heading, 3]]);
    if (b.note) put([[b.note, 17]]);
    if (!b.rows.length) { put([[b.empty || 'No records in this month.', 17]]); continue; }
    put(b.headers.map(hd => [hd, 4]));
    b.headers.forEach((hd, i) => measure(i, hd, true));
    for (const row of b.rows) {
      put(row.cells.map((v, i) => [v, styleOf(b.types[i] || 'text', row.mode)]));
      row.cells.forEach((v, i) => measure(i, b.types[i] === 'pct' ? '100.0%' : typeof v === 'number' ? v.toLocaleString('en-US') : v, false, (b.widths || [])[i] || 58));
    }
  }
  const cols = widths.map((w, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + Math.max(10, Math.min(60, (w || 8) + 2)) + '" customWidth="1"/>').join('');
  return XML + '<worksheet xmlns="' + MAIN + '" xmlns:r="' + OREL + '"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' +
    '<dimension ref="A1:' + col(width - 1) + r + '"/><sheetViews><sheetView workbookViewId="0" showGridLines="0"/></sheetViews>' +
    '<sheetFormatPr defaultRowHeight="15"/>' + (cols ? '<cols>' + cols + '</cols>' : '') + '<sheetData>' + rows.join('') + '</sheetData>' +
    '<mergeCells count="' + merges.length + '">' + merges.map(m => '<mergeCell ref="' + m + '"/>').join('') + '</mergeCells>' +
    '<printOptions horizontalCentered="1"/><pageMargins left="0.4" right="0.4" top="0.5" bottom="0.6" header="0.3" footer="0.3"/>' +
    '<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>' +
    '<headerFooter><oddFooter>&amp;L' + xmlText(String(sheet.footer || '').replace(/&/g, '&&')) + '&amp;RPage &amp;P of &amp;N</oddFooter></headerFooter></worksheet>';
}
/* Text goes into one shared string table (xl/sharedStrings.xml), the standard Excel way.
   Google Sheets drops the spaces of inline strings, so inline text is not used. */
let REPORT_SST = null;
function reportSharedIndex(t) {
  let i = REPORT_SST.map.get(t);
  if (i === undefined) { i = REPORT_SST.list.length; REPORT_SST.list.push(t); REPORT_SST.map.set(t, i); }
  return i;
}
function cellXml(v, s, ref) {
  if (typeof v === 'number' && Number.isFinite(v)) return '<c r="' + ref + '" s="' + s + '"><v>' + v + '</v></c>';
  return '<c r="' + ref + '" s="' + s + '" t="s"><v>' + reportSharedIndex(String(v ?? '').slice(0, 32000)) + '</v></c>';
}
function reportSharedStringsXml() {
  return XML + '<sst xmlns="' + MAIN + '" count="' + REPORT_SST.list.length + '" uniqueCount="' + REPORT_SST.list.length + '">' +
    REPORT_SST.list.map(t => '<si><t xml:space="preserve">' + xmlText(t) + '</t></si>').join('') + '</sst>';
}
export async function buildMonthlyWorkbook(Zip, sheets) {
  const zip = new Zip(), seen = new Set();
  const rel = (id, type, target) => '<Relationship Id="' + id + '" Type="' + OREL + '/' + type + '" Target="' + target + '"/>';
  const names = sheets.map((s, i) => {
    let base = String(s.name || 'Sheet ' + (i + 1)).replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31) || 'Sheet ' + (i + 1), name = base, n = 1;
    while (seen.has(name.toLowerCase())) name = base.slice(0, 27) + ' (' + (++n) + ')';
    seen.add(name.toLowerCase());
    return name;
  });
  zip.file('_rels/.rels', XML + '<Relationships xmlns="' + PREL + '">' + rel('rId1', 'officeDocument', 'xl/workbook.xml') + '</Relationships>');
  zip.file('xl/workbook.xml', XML + '<workbook xmlns="' + MAIN + '" xmlns:r="' + OREL + '"><bookViews><workbookView/></bookViews><sheets>' +
    names.map((n, i) => '<sheet name="' + xmlText(n) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join('') + '</sheets>' +
    '<definedNames>' + names.map((n, i) => '<definedName name="_xlnm.Print_Titles" localSheetId="' + i + '">\'' + xmlText(n.replace(/'/g, "''")) + '\'!$1:$2</definedName>').join('') + '</definedNames></workbook>');
  zip.file('xl/_rels/workbook.xml.rels', XML + '<Relationships xmlns="' + PREL + '">' + names.map((_, i) => rel('rId' + (i + 1), 'worksheet', 'worksheets/sheet' + (i + 1) + '.xml')).join('') +
    rel('rId' + (names.length + 1), 'styles', 'styles.xml') + rel('rId' + (names.length + 2), 'sharedStrings', 'sharedStrings.xml') + '</Relationships>');
  zip.file('xl/styles.xml', STYLES);
  REPORT_SST = {list: [], map: new Map()};
  try { sheets.forEach((s, i) => zip.file('xl/worksheets/sheet' + (i + 1) + '.xml', sheetXml(s))); zip.file('xl/sharedStrings.xml', reportSharedStringsXml()); } finally { REPORT_SST = null; }
  zip.file('[Content_Types].xml', XML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
    names.map((_, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('') + '</Types>');
  return zip.generateAsync({type: 'uint8array', compression: 'DEFLATE', compressionOptions: {level: 6}});
}

/* ------------------------------------------------------------------ helpers */
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthName = m => MONTHS[Number(m.slice(5, 7)) - 1] + ' ' + m.slice(0, 4);
const dhakaTime = iso => { if (!iso) return ''; const d = new Date(new Date(iso).getTime() + 6 * 3600e3); return String(d.getUTCDate()).padStart(2, '0') + ' ' + MONTHS[d.getUTCMonth()].slice(0, 3) + ' ' + d.getUTCFullYear() + ' ' + String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0'); };
const share = (n, total) => total ? n / total : 0;
const clean = v => (Array.isArray(v) ? v.map(clean).filter(Boolean).join(', ') : String(v ?? '').replace(/\s+/g, ' ').trim());
const fieldsOf = schema => Array.isArray(schema) ? schema : Array.isArray(schema?.fields) ? schema.fields : [];
function countBy(list, key, weight) {
  const m = new Map();
  for (const x of list) for (const k of [].concat(key(x))) { if (!k) continue; const e = m.get(k) || {key: k, n: 0, w: 0, items: []}; e.n += 1; e.w += weight ? weight(x) : 1; e.items.push(x); m.set(k, e); }
  return [...m.values()].sort((a, b) => (weight ? b.w - a.w : 0) || b.n - a.n || String(a.key).localeCompare(String(b.key)));
}
/* highlight the first row only when it is a real, single top value */
const top = (rows, value) => rows.map((r, i) => ({...r, mode: i === 0 && rows.length && value(rows[0]) > 0 && (rows.length === 1 || value(rows[1]) < value(rows[0])) ? 'hl' : r.mode}));
const block = (heading, headers, types, rows, extra = {}) => ({heading, headers, types, rows, ...extra});
const pctText = p => (p * 100).toFixed(1) + '%';
const header = (kind, month, generated) => ({footer: 'WLF Electrical Solution · ' + kind + ' · ' + monthName(month) + ' · Generated ' + generated});

/* ------------------------------------------------------------------ Technical Support */
const sectionName = name => String(name || '').replace(/ Team$/, '');
function supportFacts(r) {
  const fields = fieldsOf(r.schema), values = r.values || {};
  const pick = test => { const f = fields.find(test); return f ? clean(values[f.id]) : ''; };
  const errorFields = fields.filter(f => /error/i.test(f.label || f.id || '') && !/category/i.test(f.label || ''));
  const errors = errorFields.flatMap(f => clean(values[f.id]).split(/\s*[,;]\s*/)).map(x => x.trim()).filter(x => x && !/^(none|n\/?a|-)$/i.test(x));
  return {
    problem: pick(f => f.id === 'problem_category' || /problem\s*category/i.test(f.label || '')) || 'Not given',
    lift: pick(f => f.id === 'lift' || /lift\s*id/i.test(f.label || '')),
    project: pick(f => f.id === 'project' || /^project/i.test(f.label || '')),
    details: pick(f => f.id === 'problem' || /^(problem|problem details|description)$/i.test(f.label || '')),
    errors: [...new Set(errors)]
  };
}
const isOpen = s => !['Solved', 'Not Solved'].includes(s);
function supportBlocks(list, totalAll, scopeLabel) {
  const total = list.length, solved = list.filter(r => r.status === 'Solved'), notSolved = list.filter(r => r.status === 'Not Solved').length;
  const hours = solved.filter(r => r.solvedAt).map(r => (new Date(r.solvedAt) - new Date(r.at)) / 3600e3).filter(x => x >= 0);
  const problems = countBy(list, r => r.f.problem), errors = countBy(list, r => r.f.errors);
  const repeat = countBy(list.filter(r => r.f.lift), r => r.f.lift + '\u0000' + r.f.problem).filter(e => e.n > 1);
  const people = countBy(list, r => r.requester || 'Unknown');
  const blocks = [];
  blocks.push({heading: 'Overview', headers: ['Item', 'Value'], types: ['text', 'value'], rows: [
    ['Support requests', total], ...(totalAll != null ? [['Share of all support requests', pctText(share(total, totalAll))]] : []),
    ['Solved', solved.length], ['Not solved', notSolved], ['Still open (pending, received or forwarded)', total - solved.length - notSolved],
    ['Solve rate', pctText(share(solved.length, total))], ['Forwarded at least once', list.filter(r => r.forwards > 0).length],
    ['Average time to solve', hours.length ? (hours.reduce((a, b) => a + b, 0) / hours.length).toFixed(1) + ' hours' : '—'],
    ['Most frequent problem', problems.length ? problems[0].key + ' (' + problems[0].n + ', ' + pctText(share(problems[0].n, total)) + ')' : '—']
  ].map(c => ({cells: c}))});
  blocks.push(block('Problems ' + scopeLabel + ' · most frequent first', ['Problem category', 'Requests', 'Share', 'Solved', 'Still open'], ['text', 'int', 'pct', 'int', 'int'],
    top(problems.map(e => ({cells: [e.key, e.n, share(e.n, total), e.items.filter(r => r.status === 'Solved').length, e.items.filter(r => isOpen(r.status)).length]})), r => r.cells[1]),
    {note: 'Highlighted: the problem that came most often (the repeat problem of the month).'}));
  blocks.push(block('Error codes reported', ['Error code', 'Times', 'Share of requests'], ['text', 'int', 'pct'],
    top(errors.slice(0, 25).map(e => ({cells: [e.key, e.n, share(e.n, total)]})), r => r.cells[1]), {empty: 'No error codes were entered this month.'}));
  blocks.push(block('Same problem on the same lift (2 or more times this month)', ['Lift ID', 'Project', 'Section', 'Problem category', 'Times', 'References'],
    ['text', 'text', 'text', 'text', 'int', 'text'],
    repeat.map(e => ({cells: [e.items[0].f.lift, e.items[0].f.project, [...new Set(e.items.map(r => r.section))].join(', '), e.items[0].f.problem, e.n, e.items.map(r => r.reference).join(', ')], mode: 'hl'})),
    {empty: 'No lift had the same problem twice this month.'}));
  blocks.push(block('Support needed by requester', ['Requester', 'Section', 'Requests', 'Share'], ['text', 'text', 'int', 'pct'],
    top(people.slice(0, 25).map(e => ({cells: [e.key, [...new Set(e.items.map(r => r.section))].join(', '), e.n, share(e.n, total)]})), r => r.cells[2])));
  return blocks;
}
export function supportReport(data, generated) {
  const teams = new Map((data.teams || []).map(t => [t.id, sectionName(t.name)]));
  const list = (data.records || []).map(r => ({...r, section: teams.get(r.team) || r.team, f: supportFacts(r)}));
  const total = list.length, month = data.month, info = header('Technical Support Monthly Report', month, generated);
  const sub = 'Month: ' + monthName(month) + ' (Bangladesh time) · Generated ' + generated + ' · Section = the section of the person who sent the request';
  const bySection = [...teams.entries()].map(([id, name]) => { const xs = list.filter(r => r.team === id); return {name, xs}; }).sort((a, b) => b.xs.length - a.xs.length);
  const summary = {name: 'Summary', title: 'Technical Support Monthly Report · ' + monthName(month), subtitle: sub, ...info, blocks: []};
  const sectionBlock = block('Support by section', ['Section', 'Requests', 'Share', 'Solved', 'Not solved', 'Still open'], ['text', 'int', 'pct', 'int', 'int', 'int'],
    [...top(bySection.map(s => ({cells: [s.name, s.xs.length, share(s.xs.length, total), s.xs.filter(r => r.status === 'Solved').length, s.xs.filter(r => r.status === 'Not Solved').length, s.xs.filter(r => isOpen(r.status)).length]})), r => r.cells[1]),
      {cells: ['Total', total, total ? 1 : 0, list.filter(r => r.status === 'Solved').length, list.filter(r => r.status === 'Not Solved').length, list.filter(r => isOpen(r.status)).length], mode: 'total'}],
    {note: 'Highlighted: the section that needed the most support.'});
  const all = supportBlocks(list, null, 'in all sections');
  summary.blocks.push(all[0], sectionBlock, ...all.slice(1));
  const given = (data.given || []).slice().sort((a, b) => b.solved - a.solved || b.received - a.received);
  summary.blocks.push(block('Support given by R&I members', ['R&I member', 'Received', 'Solved', 'Not solved', 'Forwarded'], ['text', 'int', 'int', 'int', 'int'],
    top(given.map(g => ({cells: [g.name, g.received, g.solved, g.notSolved, g.forwarded]})), r => r.cells[2]), {note: 'Counted from the actions taken in this month.'}));
  const sheets = [summary];
  for (const [id, name] of teams) sheets.push({name, title: 'Technical Support · ' + name + ' · ' + monthName(month), subtitle: sub, ...info,
    blocks: supportBlocks(list.filter(r => r.team === id), total, 'in ' + name)});
  const order = [...teams.keys()];
  sheets.push({name: 'All requests', title: 'Technical Support · All requests · ' + monthName(month), subtitle: sub, ...info, blocks: [
    block('All support requests of the month, by section', ['Section', 'Reference', 'Date (Dhaka)', 'Requester', 'Lift ID', 'Project', 'Problem category', 'Error code', 'Problem', 'Status', 'Solved by', 'Solution'],
      ['text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text'],
      list.slice().sort((a, b) => order.indexOf(a.team) - order.indexOf(b.team) || String(a.at).localeCompare(String(b.at)))
        .map(r => ({cells: [r.section, r.reference, dhakaTime(r.at), r.requester, r.f.lift, r.f.project, r.f.problem, r.f.errors.join(', '), r.f.details, r.status, r.solver, clean(r.solution)]})),
      {widths: [14, 12, 17, 20, 9, 18, 18, 12, 40, 10, 18, 34]})]});
  return {sheets, records: total};
}

/* ------------------------------------------------------------------ R&I Team Activity */
const SECTORS = [['team', 'Team R&I Activity'], ['scm', 'Supplier & SCM Communication'], ['reports', 'Reports'], ['sales', 'Sales Support']];
const stateOf = s => /^(completed|solved|done)$/i.test(s || '') ? 'done' : /^(ongoing|in progress)$/i.test(s || '') ? 'ongoing' : 'other';
const hoursOf = xs => Math.round(xs.reduce((a, e) => a + Number(e.minutes || 0), 0) / 6) / 10;
function details(e) {
  const v = e.values || {};
  return fieldsOf(e.schema).filter(f => !/^(status|duration|duration_min|duration_minute)$/.test(f.id) && clean(v[f.id]))
    .map(f => (f.label || f.id) + ': ' + clean(v[f.id])).join(' · ');
}
function activityCounts(xs) { return [xs.length, xs.filter(e => stateOf(e.status) === 'done').length, xs.filter(e => stateOf(e.status) === 'ongoing').length, xs.filter(e => stateOf(e.status) === 'other').length, hoursOf(xs)]; }
export function activityReport(data, generated) {
  const list = data.records || [], total = list.length, month = data.month, info = header('R&I Team Activity Monthly Report', month, generated);
  const sub = 'Month: ' + monthName(month) + ' (Bangladesh time) · Generated ' + generated;
  const H = ['Entries', 'Share', 'Completed', 'Ongoing', 'Other status', 'Time (hours)'], T = ['int', 'pct', 'int', 'int', 'int', 'dec'];
  const row = (name, xs, base) => { const c = activityCounts(xs); return {cells: [name, c[0], share(c[0], base), c[1], c[2], c[3], c[4]]}; };
  const sectors = SECTORS.map(([k, name]) => ({k, name, xs: list.filter(e => e.sector === k)}));
  const members = countBy(list, e => e.member || 'Unknown');
  const summary = {name: 'Summary', title: 'R&I Team Activity Monthly Report · ' + monthName(month), subtitle: sub, ...info, blocks: [
    {heading: 'Overview', headers: ['Item', 'Value'], types: ['text', 'value'], rows: [
      ['Activity entries', total], ['Completed', activityCounts(list)[1]], ['Ongoing', activityCounts(list)[2]], ['Other status', activityCounts(list)[3]],
      ['Time invested', hoursOf(list) + ' hours'], ['R&I members with entries', members.length],
      ['Busiest sector', total ? sectors.slice().sort((a, b) => b.xs.length - a.xs.length)[0].name : '—']].map(c => ({cells: c}))},
    block('Activity by sector', ['Sector', ...H], ['text', ...T], [...top(sectors.slice().sort((a, b) => b.xs.length - a.xs.length).map(s => row(s.name, s.xs, total)), r => r.cells[1]),
      {...row('Total', list, total), mode: 'total'}]),
    block('Activity by R&I member', ['R&I member', ...SECTORS.map(s => s[1]), 'Total', 'Share', 'Time (hours)'], ['text', 'int', 'int', 'int', 'int', 'int', 'pct', 'dec'],
      top(members.map(m => ({cells: [m.key, ...SECTORS.map(([k]) => m.items.filter(e => e.sector === k).length), m.n, share(m.n, total), hoursOf(m.items)]})), r => r.cells[5]),
      {note: 'Highlighted: the member with the most entries this month.'}),
    block('Most used forms', ['Form', 'Sector', 'Entries', 'Share'], ['text', 'text', 'int', 'pct'],
      top(countBy(list, e => e.form).slice(0, 20).map(f => ({cells: [f.key, (SECTORS.find(s => s[0] === f.items[0].sector) || [, ''])[1], f.n, share(f.n, total)]})), r => r.cells[2]))]};
  const sheets = [summary];
  for (const s of sectors) {
    const n = s.xs.length;
    sheets.push({name: s.name, title: 'R&I Team Activity · ' + s.name + ' · ' + monthName(month), subtitle: sub, ...info, blocks: [
      {heading: 'Overview', headers: ['Item', 'Value'], types: ['text', 'value'], rows: [['Entries', n], ['Share of all R&I entries', pctText(share(n, total))],
        ['Completed', activityCounts(s.xs)[1]], ['Ongoing', activityCounts(s.xs)[2]], ['Other status', activityCounts(s.xs)[3]], ['Time invested', hoursOf(s.xs) + ' hours']].map(c => ({cells: c}))},
      block('By form', ['Form', ...H], ['text', ...T], top(countBy(s.xs, e => e.form).map(f => row(f.key, f.items, n)), r => r.cells[1])),
      block('By R&I member', ['R&I member', ...H], ['text', ...T], top(countBy(s.xs, e => e.member || 'Unknown').map(m => row(m.key, m.items, n)), r => r.cells[1]))]});
  }
  const order = SECTORS.map(x => x[0]);
  sheets.push({name: 'All entries', title: 'R&I Team Activity · All entries · ' + monthName(month), subtitle: sub, ...info, blocks: [
    block('All activity entries of the month, by sector', ['Sector', 'Date (Dhaka)', 'R&I member', 'Form', 'Status', 'Time (min)', 'Details'], ['text', 'text', 'text', 'text', 'text', 'dec', 'text'],
      list.slice().sort((a, b) => order.indexOf(a.sector) - order.indexOf(b.sector) || String(a.at).localeCompare(String(b.at)))
        .map(e => ({cells: [(SECTORS.find(x => x[0] === e.sector) || [, e.sector])[1], dhakaTime(e.at), e.member, e.form, e.status, Number(e.minutes || 0), details(e)]})),
      {widths: [22, 17, 20, 22, 12, 10, 60]})]});
  return {sheets, records: total};
}

/* ------------------------------------------------------------------ Damage Demand */
const qty = d => Number(d.quantity || 0);
const componentKey = d => [d.item, d.model].filter(Boolean).join('\u0000');
function damageBlocks(list, units, scope) {
  const n = list.length, u = list.reduce((a, d) => a + qty(d), 0);
  const problems = countBy(list, d => (d.problems || []).length ? d.problems : ['Not given']);
  const parts = countBy(list, componentKey, qty), users = countBy(list, d => d.requester || 'Unknown', qty);
  return [
    {heading: 'Overview', headers: ['Item', 'Value'], types: ['text', 'value'], rows: [
      ['Damage demands', n], ['Units (total quantity)', u], ...(units != null ? [['Share of all damaged units', pctText(share(u, units))]] : []),
      ['Received from stock', list.filter(d => d.received).length], ['Waiting', list.filter(d => !d.received).length], ['Sent to supplier (claim)', list.filter(d => d.claimed).length],
      ['Most frequent problem', problems.length ? problems[0].key + ' (' + problems[0].n + ', ' + pctText(share(problems[0].n, n)) + ')' : '—'],
      ['Component failing most', parts.length ? parts[0].items[0].item + (parts[0].items[0].model ? ' · ' + parts[0].items[0].model : '') + ' (' + parts[0].w + ' units)' : '—']].map(c => ({cells: c}))},
    block('Problems ' + scope + ' · most frequent first', ['Problem category', 'Demands', 'Share', 'Units'], ['text', 'int', 'pct', 'int'],
      top(problems.map(e => ({cells: [e.key, e.n, share(e.n, n), e.items.reduce((a, d) => a + qty(d), 0)]})), r => r.cells[1])),
    block('Components failing most', ['Component', 'Model', 'Brand', 'Units', 'Demands', 'Share of units'], ['text', 'text', 'text', 'int', 'int', 'pct'],
      top(parts.slice(0, 25).map(e => ({cells: [e.items[0].item, e.items[0].model, [...new Set(e.items.map(d => d.brand).filter(Boolean))].join(', '), e.w, e.n, share(e.w, u)]})), r => r.cells[3]),
      {note: 'Highlighted: the component with the most damaged units.'}),
    block('Damage by user (requester)', ['User', 'Section', 'Demands', 'Units', 'Share of units'], ['text', 'text', 'int', 'int', 'pct'],
      top(users.slice(0, 25).map(e => ({cells: [e.key, [...new Set(e.items.map(d => d.section))].join(', '), e.n, e.w, share(e.w, u)]})), r => r.cells[3]),
      {note: 'Highlighted: the user under whom the most units were damaged.'})
  ];
}
export function damageReport(data, generated) {
  const teams = new Map((data.teams || []).map(t => [t.id, sectionName(t.name)]));
  const list = (data.records || []).map(d => ({...d, section: teams.get(d.team) || d.team}));
  const month = data.month, info = header('Damage Demand Monthly Report', month, generated), units = list.reduce((a, d) => a + qty(d), 0);
  const sub = 'Month: ' + monthName(month) + ' (Bangladesh time) · Generated ' + generated;
  const sections = [...teams.entries()].map(([id, name]) => ({name, xs: list.filter(d => d.team === id)})).sort((a, b) => b.xs.reduce((s, d) => s + qty(d), 0) - a.xs.reduce((s, d) => s + qty(d), 0));
  const blocks = damageBlocks(list, null, 'in all sections');
  const secRows = sections.map(s => { const u = s.xs.reduce((a, d) => a + qty(d), 0); return {cells: [s.name, s.xs.length, u, share(u, units)]}; });
  blocks.splice(1, 0, block('Damage by section', ['Section', 'Demands', 'Units', 'Share of units'], ['text', 'int', 'int', 'pct'],
    [...top(secRows, r => r.cells[2]), {cells: ['Total', list.length, units, units ? 1 : 0], mode: 'total'}], {note: 'Highlighted: the section with the most damaged units.'}));
  blocks.push(block('Damage by controller', ['Controller', 'Demands', 'Units'], ['text', 'int', 'int'],
    top(countBy(list, d => (d.controllers || []).length ? d.controllers : ['Not given'], qty).map(e => ({cells: [e.key, e.n, e.w]})), r => r.cells[2])));
  const sheets = [{name: 'Summary', title: 'Damage Demand Monthly Report · ' + monthName(month), subtitle: sub, ...info, blocks}];
  for (const [id, name] of teams) sheets.push({name, title: 'Damage Demand · ' + name + ' · ' + monthName(month), subtitle: sub, ...info,
    blocks: damageBlocks(list.filter(d => d.team === id), units, 'in ' + name)});
  const order = [...teams.keys()];
  sheets.push({name: 'All demands', title: 'Damage Demand · All demands · ' + monthName(month), subtitle: sub, ...info, blocks: [
    block('All damage demands of the month, by section', ['Section', 'Reference', 'Date (Dhaka)', 'Requester', 'Project', 'Lift ID', 'Controller', 'Problem', 'Component', 'Model', 'Brand', 'Qty', 'Confirmed by', 'Status'],
      ['text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'int', 'text', 'text'],
      list.slice().sort((a, b) => order.indexOf(a.team) - order.indexOf(b.team) || String(a.at).localeCompare(String(b.at)))
        .map(d => ({cells: [d.section, d.reference, dhakaTime(d.at), d.requester, d.project, d.liftId, clean(d.controllers), clean(d.problems), d.item, d.model, d.brand, qty(d), d.confirmedBy,
          d.claimed ? 'Sent to supplier' : d.received ? 'Received' : 'Waiting']})),
      {widths: [16, 10, 17, 20, 18, 9, 12, 22, 22, 16, 12, 6, 18, 14]})]});
  return {sheets, records: list.length};
}

/* ------------------------------------------------------------------ Edge Function part */
export const REPORTS = {
  support: {title: 'Technical Support Monthly Report', folder: 'reportSupport', build: supportReport},
  activity: {title: 'R&I Team Activity Monthly Report', folder: 'reportActivity', build: activityReport},
  damage: {title: 'Damage Demand Monthly Report', folder: 'reportDamage', build: damageReport}
};
export const reportFileName = (kind, month) => REPORTS[kind].title + ' ' + month + '.xlsx';
const nowDhaka = () => dhakaTime(new Date().toISOString());
async function sha(bytes) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join(''); }

export async function makeReport(kind, data, Zip, generated = nowDhaka()) {
  if (!REPORTS[kind]) throw Error('Unknown report');
  const {sheets, records} = REPORTS[kind].build(data, generated);
  return {bytes: await buildMonthlyWorkbook(Zip, sheets), records};
}

/* sql(action,payload) = wlf_report_admin; drive(path,init) = Google Drive call; folderFor(name) = folder id */
export async function reportMaintenance({action, payload = {}, sql, drive, folderFor, Zip, selfUrl}) {
  if (action === 'reportStatus') return sql('status');
  if (action === 'reportHistory') return sql('history');
  if (action === 'reportDeleteHistory') return sql('deleteHistory', {id: payload.id});
  if (action === 'reportSchedule') return sql('schedule', {enable: payload.enable === true, url: selfUrl});
  async function one(kind, month) {
    const data = await sql('data', {kind, month});
    const {bytes, records} = await makeReport(kind, data, Zip);
    const name = reportFileName(kind, month), parent = await folderFor(REPORTS[kind].folder), boundary = 'wlf_' + crypto.randomUUID();
    const body = new Blob(['--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify({name, mimeType: reportMime, parents: [parent], appProperties: {wlfReport: kind + ':' + month}}) + '\r\n',
      '--' + boundary + '\r\nContent-Type: ' + reportMime + '\r\n\r\n', bytes, '\r\n--' + boundary + '--\r\n']);
    const file = await (await drive('upload/drive/v3/files?uploadType=multipart&fields=id', {method: 'POST', headers: {'Content-Type': 'multipart/related; boundary=' + boundary}, body})).json();
    if (!/^[-a-zA-Z0-9_]{5,200}$/.test(file.id || '')) throw Error('Drive did not return a report file ID.');
    const hash = await sha(bytes), saved = new Uint8Array(await (await drive('drive/v3/files/' + encodeURIComponent(file.id) + '?alt=media')).arrayBuffer());
    if (await sha(saved) !== hash) throw Error('The report saved in Google Drive failed verification.');
    await sql('saved', {kind, month, fileId: file.id, fileName: name, sha256: hash, records});
    /* a report made again for the same month replaces the old file: the old one goes to the Drive bin */
    if (data.existing?.fileId && data.existing.fileId !== file.id) {
      try { await drive('drive/v3/files/' + encodeURIComponent(data.existing.fileId), {method: 'PATCH', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({trashed: true})}); } catch (_) { /* already removed by hand */ }
    }
    return {kind, month, fileId: file.id, fileName: name, records};
  }
  if (action === 'reportGenerate') {
    const kinds = [...new Set(payload.kinds || [])].filter(k => REPORTS[k]);
    if (!kinds.length) throw Error('Choose at least one report.');
    const made = [];
    for (const k of kinds) made.push(await one(k, payload.month));
    return {made};
  }
  if (action === 'monthlyReports') {
    const made = [];
    try {
      const pending = await sql('pending');
      for (const k of pending.kinds) made.push(await one(k, pending.month));
      await sql('checked', {});
    } catch (err) {
      try { await sql('checked', {error: err.message}); } catch (_) { /* nothing more to record */ }
      throw err;
    }
    return {made};
  }
  throw Error('Unsupported report action');
}
