/* WLF v2.6.8 · QR code encoder (byte mode, error correction M, versions 1–40). No outside library.
   WlfQr.matrix(text) → array of rows of booleans; WlfQr.svg(text,opts) → SVG string; WlfQr.png(text,opts) → Promise<Blob>. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.WlfQr = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
  const BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];

  function rawModules(v) {
    let r = (16 * v + 128) * v + 64;
    if (v >= 2) { const n = Math.floor(v / 7) + 2; r -= (25 * n - 10) * n - 55; if (v >= 7) r -= 36; }
    return r;
  }
  const dataCodewords = v => Math.floor(rawModules(v) / 8) - ECC_PER_BLOCK[v] * BLOCKS[v];

  /* Reed–Solomon over GF(256), polynomial 0x11D */
  function rsDivisor(degree) {
    const result = new Array(degree).fill(0); result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < degree; j++) { result[j] = gfMul(result[j], root); if (j + 1 < degree) result[j] ^= result[j + 1]; }
      root = gfMul(root, 2);
    }
    return result;
  }
  function gfMul(x, y) { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((y >>> i) & 1) * x; } return z; }
  function rsRemainder(data, divisor) {
    const result = divisor.map(() => 0);
    for (const b of data) {
      const factor = b ^ result.shift(); result.push(0);
      divisor.forEach((coef, i) => { result[i] ^= gfMul(coef, factor); });
    }
    return result;
  }

  function utf8(text) { return Array.from(new TextEncoder().encode(text)); }

  function encodeData(bytes, version) {
    const bits = [];
    const push = (value, length) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
    push(4, 4); push(bytes.length, version < 10 ? 8 : 16);
    bytes.forEach(b => push(b, 8));
    const capacity = dataCodewords(version) * 8;
    push(0, Math.min(4, capacity - bits.length));
    push(0, (8 - bits.length % 8) % 8);
    for (let pad = 0xEC; bits.length < capacity; pad ^= 0xEC ^ 0x11) push(pad, 8);
    const out = [];
    for (let i = 0; i < bits.length; i += 8) { let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]; out.push(b); }
    return out;
  }

  function addEcc(data, version) {
    const blocks = BLOCKS[version], eccLen = ECC_PER_BLOCK[version], raw = Math.floor(rawModules(version) / 8);
    const shortBlocks = blocks - raw % blocks, shortLen = Math.floor(raw / blocks);
    const divisor = rsDivisor(eccLen), parts = [];
    for (let i = 0, k = 0; i < blocks; i++) {
      const len = shortLen - eccLen + (i < shortBlocks ? 0 : 1);
      const dat = data.slice(k, k + len); k += len;
      const ecc = rsRemainder(dat, divisor);
      if (i < shortBlocks) dat.push(0);
      parts.push({dat, ecc});
    }
    const result = [];
    for (let i = 0; i < parts[0].dat.length; i++) parts.forEach((p, j) => { if (i !== shortLen - eccLen || j >= shortBlocks) result.push(p.dat[i]); });
    for (let i = 0; i < eccLen; i++) parts.forEach(p => result.push(p.ecc[i]));
    return result;
  }

  function build(version, codewords, mask) {
    const size = version * 4 + 17;
    const modules = Array.from({length: size}, () => new Array(size).fill(false));
    const fixed = Array.from({length: size}, () => new Array(size).fill(false));
    const set = (x, y, dark) => { modules[y][x] = dark; fixed[y][x] = true; };
    for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    const finder = (cx, cy) => {
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, dist !== 2 && dist !== 4);
      }
    };
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    const align = [];
    if (version > 1) {
      const n = Math.floor(version / 7) + 2, step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (n * 2 - 2)) * 2;
      align.push(6); for (let pos = size - 7; align.length < n; pos -= step) align.splice(1, 0, pos);
    }
    align.forEach((cx, i) => align.forEach((cy, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }));
    const format = m => {
      const data = (0 << 3) | m;               /* error correction M = 0 */
      let rem = data; for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const bits = ((data << 10) | rem) ^ 0x5412, bit = i => ((bits >>> i) & 1) !== 0;
      for (let i = 0; i <= 5; i++) set(8, i, bit(i));
      set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
      for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
      for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
      for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
      set(8, size - 8, true);
    };
    format(0);
    if (version >= 7) {
      let rem = version; for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
      const bits = (version << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const dark = ((bits >>> i) & 1) !== 0, a = size - 11 + i % 3, b = Math.floor(i / 3);
        set(a, b, dark); set(b, a, dark);
      }
    }
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
        const x = right - j, upward = ((right + 1) & 2) === 0, y = upward ? size - 1 - vert : vert;
        if (!fixed[y][x] && i < codewords.length * 8) { modules[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0; i++; }
      }
    }
    if (mask >= 0) {
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        let invert;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = x * y % 2 + x * y % 3 === 0; break;
          case 6: invert = (x * y % 2 + x * y % 3) % 2 === 0; break;
          default: invert = ((x + y) % 2 + x * y % 3) % 2 === 0;
        }
        if (!fixed[y][x] && invert) modules[y][x] = !modules[y][x];
      }
      format(mask);
    }
    return modules;
  }

  function penalty(m) {
    const size = m.length; let score = 0;
    const runs = line => {
      let s = 0, run = 1;
      for (let i = 1; i < line.length; i++) { if (line[i] === line[i - 1]) { run++; if (run === 5) s += 3; else if (run > 5) s++; } else run = 1; }
      return s;
    };
    for (let y = 0; y < size; y++) { score += runs(m[y]); score += runs(m.map(r => r[y])); }
    for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) if (m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) score += 3;
    const pat = [true, false, true, true, true, false, true, false, false, false, false];
    const finderLike = line => {
      let s = 0;
      for (let i = 0; i + 11 <= line.length; i++) {
        if (pat.every((v, k) => line[i + k] === v)) s += 40;
        if (pat.every((v, k) => line[i + 10 - k] === v)) s += 40;
      }
      return s;
    };
    for (let y = 0; y < size; y++) { score += finderLike(m[y]); score += finderLike(m.map(r => r[y])); }
    const dark = m.reduce((a, r) => a + r.filter(Boolean).length, 0);
    score += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
    return score;
  }

  function matrix(text) {
    const bytes = utf8(String(text));
    let version = 1;
    while (version <= 40 && (bytes.length * 8 + 4 + (version < 10 ? 8 : 16) > dataCodewords(version) * 8)) version++;
    if (version > 40) throw Error('The text is too long for a QR code.');
    const codewords = addEcc(encodeData(bytes, version), version);
    let best = null, bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      const m = build(version, codewords, mask), s = penalty(m);
      if (s < bestScore) { bestScore = s; best = m; }
    }
    return best;
  }

  function svg(text, opts) {
    opts = opts || {};
    const m = matrix(text), quiet = opts.quiet == null ? 4 : opts.quiet, n = m.length + quiet * 2;
    let path = '';
    m.forEach((row, y) => row.forEach((dark, x) => { if (dark) path += 'M' + (x + quiet) + ' ' + (y + quiet) + 'h1v1h-1z'; }));
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + n + ' ' + n + '" shape-rendering="crispEdges" role="img" aria-label="' + (opts.label || 'QR code') + '"><rect width="' + n + '" height="' + n + '" fill="#fff"/><path d="' + path + '" fill="#000"/></svg>';
  }

  /* PNG with the Lift ID printed under the code (label to stick on the control panel) */
  function png(text, opts) {
    opts = opts || {};
    const m = matrix(text), quiet = 4, cells = m.length + quiet * 2, scale = Math.max(4, Math.floor((opts.size || 640) / cells)), side = cells * scale;
    const caption = opts.caption || '', capH = caption ? Math.round(scale * 6) : 0;
    const canvas = document.createElement('canvas'); canvas.width = side; canvas.height = side + capH;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000';
    m.forEach((row, y) => row.forEach((dark, x) => { if (dark) ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale); }));
    if (caption) {
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      let px = Math.round(capH * 0.55); ctx.font = '700 ' + px + 'px system-ui,Arial,sans-serif';
      while (ctx.measureText(caption).width > side * 0.92 && px > 10) { px -= 2; ctx.font = '700 ' + px + 'px system-ui,Arial,sans-serif'; }
      ctx.fillText(caption, side / 2, side + capH * 0.42);
    }
    return new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(Error('Could not make the image.')), 'image/png'));
  }

  return {matrix, svg, png, capacity: v => dataCodewords(v)};
});
