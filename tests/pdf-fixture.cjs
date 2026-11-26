/* Builds a small PDF that has the same labelled layout as the Walton lift specification sheet (made-up data, no real project). */
function layoutPdf(v) {
  const rows = [];                                   /* [x, y, text] */
  const put = (x, y, t) => rows.push([x, y, t]);
  put(225, 760, 'WALTON LIFT SPECIFICATION'); put(415, 760, 'Date'); put(466, 760, ':'); put(496, 760, '12-Oct-26');
  const pair = (lx, cx, vx, y, label, value, dy) => { put(lx, y, label); put(cx, y - (dy || 0), ':'); put(vx, y, value); };
  pair(113, 175, 182, 738, 'Project Name', v.project); pair(369, 419, 427, 738, 'Sales ID', '100001');
  pair(113, 175, 182, 729, 'Address', v.address); pair(369, 419, 427, 729, 'Lift ID', v.liftId);
  pair(113, 175, 182, 720, 'Lift Series', 'CLASSIC'); pair(369, 419, 427, 720, 'Engr. (ID)', '1 - Test');
  put(113, 700, '1. LIFT GENERAL INFORMATION');
  pair(113, 209, 217, 685, 'Lift Type', v.room || 'MR(Machine Room)'); pair(346, 454, 462, 685, 'Rated Capacity', v.capacity + ' KG');
  pair(113, 209, 217, 676, 'Usage', v.usage); pair(346, 454, 462, 676, 'Persons(For Passengers)', '5');
  put(113, 667, 'Floors/Stops/Openings'); put(232, 667, '8'); put(278, 667, '8'); put(325, 667, '8'); put(209, 665, ':'); put(346, 667, 'Rated Speed'); put(454, 665, ':'); put(462, 667, v.speed + ' m/s');
  pair(113, 209, 217, 658, 'Roping Type', v.roping); pair(346, 454, 462, 658, 'Category', 'Traction');
  put(113, 640, '2. TRACTION MACHINE INFORMATION');
  put(113, 625, 'Machine Brand'); put(209, 624, ':'); put(217, 625, v.brand); put(346, 625, 'Rated Power (KW)'); put(454, 624, ':'); put(462, 625, '3.9');
  pair(113, 209, 217, 616, 'Model', v.model); pair(346, 454, 462, 616, 'Rated Current (A)', '10');
  put(113, 560, '7. WALTON LIFT DEFAULT SAFETY FEATURES'); put(113, 530, 'ADDITIONAL PAID FEATURES');
  if (v.avr) put(113, 515, 'AVR (Based on Machine Power Rating) [' + v.avr + 'KVA]');
  const esc = t => String(t).replace(/[\\()]/g, '\\$&');
  const stream = rows.map(([x, y, t]) => `BT /F1 8 Tf ${x} ${y} Td (${esc(t)}) Tj ET`).join('\n');
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let out = '%PDF-1.4\n'; const offsets = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
module.exports = {layoutPdf};
