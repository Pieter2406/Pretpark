// Ticket import: a PDF (pdf.js) or a screenshot/photo → find every QR/barcode (zxing-wasm) → keep a sharp crop of
// each code (that's what the gate scans) plus a picture of the whole ticket. Libraries load only when importing.
let pdfjsP = null, zxP = null;
function loadPdf() {
  pdfjsP ??= import('./vendor/pdf.min.mjs').then((m) => { m.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href; return m; });
  return pdfjsP;
}
function loadZx() {
  zxP ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = new URL('./vendor/zxing-reader.js', import.meta.url).href;
    s.onload = () => {
      const wasm = new URL('./vendor/zxing_reader.wasm', import.meta.url).href;
      window.ZXingWASM.setZXingModuleOverrides({ locateFile: (path, prefix) => (path.endsWith('.wasm') ? wasm : prefix + path) });
      resolve(window.ZXingWASM);
    };
    s.onerror = () => { zxP = null; reject(new Error('barcode reader failed to load')); };
    document.head.append(s);
  });
  return zxP;
}

const canvasOf = (w, h) => { const c = document.createElement('canvas'); c.width = Math.round(w); c.height = Math.round(h); return c; };

// Renders one page at a time (yields a canvas, frees it after use): a 12-page PDF never holds 12 big canvases (iOS limit)
async function* pdfPages(file) {
  const pdfjs = await loadPdf();
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  for (let i = 1; i <= Math.min(pdf.numPages, 12); i++) {
    const page = await pdf.getPage(i);
    const vp1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: Math.min(4, 2200 / vp1.width) });
    const c = canvasOf(vp.width, vp.height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    page.cleanup();
    yield c;
    c.width = c.height = 0;
  }
  await pdf.destroy();
}
async function* imagePages(file) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 3000 / Math.max(bmp.width, bmp.height));
  const c = canvasOf(bmp.width * k, bmp.height * k);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  yield c;
  c.width = c.height = 0;
}
function toJpeg(src, maxW) {
  const k = Math.min(1, maxW / src.width);
  const c = canvasOf(src.width * k, src.height * k);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.82);
}
function cropCode(src, pos, linear) {
  const pts = [pos.topLeft, pos.topRight, pos.bottomLeft, pos.bottomRight];
  let x0 = Math.min(...pts.map((p) => p.x)), x1 = Math.max(...pts.map((p) => p.x));
  let y0 = Math.min(...pts.map((p) => p.y)), y1 = Math.max(...pts.map((p) => p.y));
  if (linear && y1 - y0 < (x1 - x0) * 0.3) { const cy = (y0 + y1) / 2, h = (x1 - x0) * 0.3; y0 = cy - h / 2; y1 = cy + h / 2; }
  const m = Math.max(x1 - x0, y1 - y0) * 0.12 + 10; // quiet zone
  x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(src.width, x1 + m); y1 = Math.min(src.height, y1 + m);
  const w = x1 - x0, h = y1 - y0;
  // small codes are enlarged with sharp pixels; big ones (a phone photo) shrunk to ≤ 1000 px so the server takes them
  const k = Math.max(w, h) > 1000 ? 1000 / Math.max(w, h) : Math.max(1, Math.ceil(700 / Math.max(w, h)));
  const c = canvasOf(w * k, h * k);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = k < 1;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(src, x0, y0, w, h, 0, 0, c.width, c.height);
  const png = c.toDataURL('image/png');
  return png.length < 800_000 ? png : c.toDataURL('image/jpeg', 0.92); // a noisy photo makes a huge PNG
}

// Returns [{ code, format, crop, page, pageNo, source }]
export async function readTickets(files, onProgress = () => {}) {
  const zx = await loadZx();
  const found = [];
  let n = 0;
  const failed = [];
  for (const file of files) {
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    onProgress(`${file.name} openen…`);
    let i = 0;
    const before = found.length;
    // one unreadable file (e.g. a HEIC on Android) never cancels the others
    try { for await (const c of isPdf ? pdfPages(file) : imagePages(file)) {
      onProgress(`Codes zoeken (${++n})…`);
      const data = c.getContext('2d').getImageData(0, 0, c.width, c.height);
      const results = (await zx.readBarcodesFromImageData(data, { tryHarder: true, maxNumberOfSymbols: 10, formats: [] }))
        .filter((r) => r.isValid && r.text);
      const page = toJpeg(c, 1300);
      i++;
      if (!results.length) found.push({ code: null, format: '', crop: null, page, pageNo: i, source: file.name });
      for (const r of results) {
        const linear = !/QR|Aztec|DataMatrix|PDF417|MaxiCode/i.test(r.format);
        found.push({ code: r.text, format: r.format, crop: cropCode(c, r.position, linear), page, pageNo: i, source: file.name });
      }
    } } catch (e) { console.error(e); failed.push(file.name); found.length = before; continue; }
    // pages without a code (terms, ads) only count when the whole file has no code at all
    const mine = found.slice(before);
    if (mine.some((t) => t.code)) found.splice(before, found.length - before, ...mine.filter((t) => t.code));
  }
  // one ticket per code (the same code on two pages is still one ticket)
  const seen = new Set();
  const out = found.filter((t) => !t.code || (!seen.has(t.code) && seen.add(t.code)));
  out.failed = failed;
  return out;
}
