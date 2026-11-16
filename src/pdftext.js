// Reads the text of a PDF in the browser (pdf.js). Text PDFs only — scans have no text.
export async function pdfText(file) {
  const pdfjs = await import('pdfjs-dist');
  const worker = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = worker;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
  const pages = [];
  for (let i = 1; i <= Math.min(doc.numPages, 50); i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    // Rebuild lines from the y position of each text run so labels and values stay together.
    let lastY = null;
    let line = '';
    const lines = [];
    for (const it of content.items) {
      const y = Math.round(it.transform?.[5] ?? 0);
      if (lastY !== null && Math.abs(y - lastY) > 2) { lines.push(line); line = ''; }
      line += (line && !line.endsWith(' ') && !it.str.startsWith(' ') ? ' ' : '') + it.str;
      lastY = y;
      if (it.hasEOL) { lines.push(line); line = ''; lastY = null; }
    }
    if (line) lines.push(line);
    pages.push(lines.map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n'));
  }
  return pages.join('\n');
}

// Rows with their cells and x positions, for invoices laid out in columns (Busy, Tally).
// Each row: { y, cells: [{ x, s }] }, top of the page first. Runs closer than `gap` are joined into one cell.
export function rowsFromTextItems(items, page = 1, gap = 6) {
  const runs = items
    .filter((it) => it.str && it.str.trim())
    .map((it) => ({ x: it.transform[4], y: it.transform[5], w: it.width || 0, s: it.str }));
  runs.sort((a, b) => b.y - a.y || a.x - b.x);
  const rows = [];
  for (const r of runs) {
    let row = rows.find((q) => Math.abs(q.y - r.y) <= 2.5);
    if (!row) { row = { page, y: r.y, runs: [] }; rows.push(row); }
    row.runs.push(r);
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map((row) => {
    row.runs.sort((a, b) => a.x - b.x);
    const cells = [];
    for (const r of row.runs) {
      const last = cells[cells.length - 1];
      if (last && r.x - last.end < gap) {
        last.s += (r.x - last.end > 1.5 && !last.s.endsWith(' ') && !r.s.startsWith(' ') ? ' ' : '') + r.s;
        last.end = Math.max(last.end, r.x + r.w);
      } else cells.push({ x: r.x, s: r.s, end: r.x + r.w });
    }
    return { page, y: row.y, cells: cells.map((c) => ({ x: Math.round(c.x), s: c.s.replace(/\s+/g, ' ').trim() })).filter((c) => c.s) };
  });
}

export async function pdfRows(file) {
  const pdfjs = await import('pdfjs-dist');
  const worker = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = worker;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
  const rows = [];
  for (let i = 1; i <= Math.min(doc.numPages, 20); i++) {
    const page = await doc.getPage(i);
    rows.push(...rowsFromTextItems((await page.getTextContent()).items, i));
  }
  return rows;
}
