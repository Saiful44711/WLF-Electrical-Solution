/* WLF v2.6.9 · reads the project details out of a Walton lift layout PDF (the "WALTON LIFT SPECIFICATION" sheet).
   Everything happens in the browser: the PDF is never uploaded. The PDF reader (pdf.js) is loaded only when a file is chosen. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api; else root.WlfLayout = api;
})(globalThis, function (root) {
  'use strict';
  const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim();
  const same = (a, b) => clean(a).toLowerCase() === clean(b).toLowerCase();
  const LINE = 4;                                   /* points: items this close in height are on one line */

  /* items: [{page, x, y, w, str}] in PDF units (y grows upwards). Returns the values found. */
  function parseItems(items) {
    /* some PDF writers join the colon to its neighbour (": Value" or "Label :"): split them so every colon stands alone */
    const list = [];
    for (const i of items) {
      const str = clean(i.str);
      let m;
      if (!str) continue;
      if (str.length > 1 && (m = /^:\s*(.+)$/.exec(str))) { list.push({...i, str: ':'}, {...i, x: i.x + 4, str: clean(m[1])}); }
      else if (str.length > 1 && (m = /^([A-Za-z][^:]*?)\s*:$/.exec(str))) { list.push({...i, str: clean(m[1])}, {...i, x: i.x + (i.w || 0), str: ':'}); }
      else list.push({...i, str});
    }
    if (!list.some(i => same(i.str, 'Project Name'))) throw new Error('This does not look like a Walton lift layout PDF (the “Project Name” line was not found).');
    list.sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
    let section = '';
    for (const it of list) { const m = /^(\d+)\.\s+([A-Z].*)$/.exec(it.str); if (m && it.x < 150) section = m[2].toUpperCase(); it.section = section; }
    const lineOf = it => list.filter(o => o.page === it.page && Math.abs(o.y - it.y) <= LINE).sort((a, b) => a.x - b.x);
    /* an item is a label when a colon follows it directly on its line */
    const isLabel = (line, k) => line[k + 1] && line[k + 1].str === ':';
    function valueOf(label, sectionPart) {
      const candidates = list.filter(i => same(i.str, label) && (!sectionPart || i.section.includes(sectionPart)));
      for (const lab of candidates) {
        const line = lineOf(lab), k = line.indexOf(lab);
        if (!isLabel(line, k) && !line.slice(k + 1).some(i => i.str === ':')) continue;
        let j = k + 1; while (line[j] && line[j].str === ':') j++;
        const parts = [];
        for (; j < line.length; j++) { if (isLabel(line, j) || line[j].str === ':') break; parts.push(line[j].str); }
        if (parts.length) return clean(parts.join(' '));
      }
      return '';
    }
    /* second layout style ("LIFT TECHNICAL SPECIFICATIONS" table): the label sits in one cell and the value in the cell to its right,
       on the same line, with no colon. The value may be split into several pieces that touch each other. */
    const isSpecPage = page => list.some(i => i.page === page && /^lift technical specifications?$/i.test(i.str));
    const bare = t => clean(t).replace(/\s*:$/, '');
    function cellAfter(lab) {
      const right = list.filter(o => o.page === lab.page && o !== lab && Math.abs(o.y - lab.y) <= LINE + 1 && o.x > lab.x + (lab.w || 0) - 1).sort((a, b) => a.x - b.x);
      if (!right.length || right[0].x - (lab.x + (lab.w || 0)) > 260) return '';
      const parts = [right[0]];
      for (let j = 1; j < right.length; j++) { const prev = parts[parts.length - 1]; if (right[j].x - (prev.x + (prev.w || 0)) > 25) break; parts.push(right[j]); }
      return clean(parts.map(i => i.str).join(' '));
    }
    function cellOf(labels, near) {
      const want = labels.map(l => l.toLowerCase());
      let cands = list.filter(i => want.includes(bare(i.str).toLowerCase()));
      if (near) cands = cands.filter(near);
      cands.sort((a, b) => (isSpecPage(b.page) - isSpecPage(a.page)) || a.page - b.page);
      for (const lab of cands) { const v = cellAfter(lab); if (v && !want.includes(bare(v).toLowerCase())) return v; }
      return '';
    }
    const brandLabel = list.find(i => /^(traction )?machine brand$/i.test(bare(i.str)));
    const raw = {
      project: valueOf('Project Name') || cellOf(['Project Name']),
      address: valueOf('Address') || cellOf(['Address', 'Location', 'Project Location', 'Site Address']),
      liftId: valueOf('Lift ID') || cellOf(['Lift ID']),
      capacity: valueOf('Rated Capacity', 'GENERAL'), speed: valueOf('Rated Speed', 'GENERAL'), roping: valueOf('Roping Type', 'GENERAL'),
      usage: valueOf('Usage', 'GENERAL'), room: valueOf('Lift Type', 'GENERAL'), motorBrand: valueOf('Machine Brand', 'TRACTION'), motorModel: valueOf('Model', 'TRACTION')};
    for (const k of ['capacity', 'speed', 'roping', 'usage', 'room']) if (!raw[k]) raw[k] = valueOf({capacity: 'Rated Capacity', speed: 'Rated Speed', roping: 'Roping Type', usage: 'Usage', room: 'Lift Type'}[k]);
    const table = {capacity: ['Rated Capacity'], speed: ['Rated Speed'], roping: ['Roping', 'Roping Type'], usage: ['Usage Type', 'Usage'], room: ['Type of Lift', 'Lift Type'], motorBrand: ['Traction Machine Brand', 'Machine Brand']};
    for (const k of Object.keys(table)) if (!raw[k]) raw[k] = cellOf(table[k]);
    /* the machine "MODEL" row is the one just under the machine brand row */
    if (!raw.motorModel && brandLabel) raw.motorModel = cellOf(['Model', 'Machine Model'], i => i.page === brandLabel.page && i.y < brandLabel.y && brandLabel.y - i.y < 45 && Math.abs(i.x - brandLabel.x) < 200);
    /* "GEARLESS - SM190.11B-20 - (240 X 6R X 6.5mm)" -> "SM190.11B-20" */
    if (/ - /.test(raw.motorModel)) { const parts = raw.motorModel.replace(/\([^)]*\)/g, '').split(/\s+-\s+|^-\s*|\s*-$/).map(clean).filter(x => x && !/^gear(less|ed)$/i.test(x)); if (parts.length) raw.motorModel = parts.find(x => /\d/.test(x)) || parts[0]; }
    const avrCell = cellOf(['AVR', 'AVR Capacity']);
    const room = (/^\s*(MRL|MR)\b/i.exec(raw.room || '') || [])[1] || (/machine\s*room\s*less/i.test(raw.room || '') ? 'MRL' : /machine\s*room/i.test(raw.room || '') ? 'MR' : '');
    const all = list.map(i => i.str).join(' ');
    const avr = /AVR[^\[\]]{0,80}\[\s*(\d+(?:\.\d+)?)\s*KVA\s*\]/i.exec(all) || (/^\s*no\b/i.test(avrCell) ? null : /(\d+(?:\.\d+)?)\s*KVA/i.exec(avrCell));
    const number = text => { const m = /(\d+(?:\.\d+)?)/.exec(text || ''); return m ? m[1] : ''; };
    return {
      raw: {...raw, avr: avr ? avr[1] + ' KVA' : ''},
      values: {project: raw.project, address: raw.address, liftId: raw.liftId, capacity: number(raw.capacity), speed: number(raw.speed),
        roping: clean(raw.roping).replace(/\s*:\s*/g, ':'), usage: raw.usage, room: room.toUpperCase(), motorBrand: raw.motorBrand, motorModel: raw.motorModel, avrKva: avr ? avr[1] : ''}};
  }

  async function readFile(file) {
    if (!file) throw new Error('Choose a PDF file.');
    if (file.size > 25 * 1024 * 1024) throw new Error('The PDF is larger than 25 MB.');
    const url = name => new URL(name, root.__wlfLayoutBase || (typeof location !== 'undefined' ? location.href : 'file:///')).href;
    const pdfjs = await import(url('pdf-reader.mjs'));
    root.pdfjsWorker = await import(url('pdf-worker.mjs'));      /* runs the reader inside this page: no extra worker file needed */
    const task = pdfjs.getDocument({data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false}), doc = await task.promise;
    const items = [];
    for (let n = 1; n <= Math.min(doc.numPages, 12); n++) {
      const content = await (await doc.getPage(n)).getTextContent();
      for (const it of content.items) if (it.str) items.push({page: n, x: it.transform[4], y: it.transform[5], w: it.width, str: it.str});
    }
    try { await task.destroy(); } catch (err) { /* nothing to clean */ }
    return parseItems(items);
  }
  if (typeof document !== 'undefined' && document.currentScript) root.__wlfLayoutBase = document.currentScript.src;
  return {parseItems, readFile};
});
