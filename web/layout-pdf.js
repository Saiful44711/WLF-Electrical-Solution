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
    const raw = {
      project: valueOf('Project Name'), address: valueOf('Address'), liftId: valueOf('Lift ID'),
      capacity: valueOf('Rated Capacity', 'GENERAL'), speed: valueOf('Rated Speed', 'GENERAL'), roping: valueOf('Roping Type', 'GENERAL'),
      usage: valueOf('Usage', 'GENERAL'), room: valueOf('Lift Type', 'GENERAL'), motorBrand: valueOf('Machine Brand', 'TRACTION'), motorModel: valueOf('Model', 'TRACTION')};
    for (const k of ['capacity', 'speed', 'roping', 'usage', 'room']) if (!raw[k]) raw[k] = valueOf({capacity: 'Rated Capacity', speed: 'Rated Speed', roping: 'Roping Type', usage: 'Usage', room: 'Lift Type'}[k]);
    const room = (/^\s*(MRL|MR)\b/i.exec(raw.room || '') || [])[1] || (/machine\s*room\s*less/i.test(raw.room || '') ? 'MRL' : /machine\s*room/i.test(raw.room || '') ? 'MR' : '');
    const all = list.map(i => i.str).join(' ');
    const avr = /AVR[^\[\]]{0,80}\[\s*(\d+(?:\.\d+)?)\s*KVA\s*\]/i.exec(all);
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
