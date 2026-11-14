// Builds a full backup ZIP in the browser: data.json, one CSV per table, and (optionally) every photo and file.
const csv = (rows) => {
  if (!rows.length) return '';
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v) => { if (v === null || v === undefined) return ''; const t = String(v); return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  return '﻿' + [cols.join(','), ...rows.map((r) => cols.map((k) => cell(r[k])).join(','))].join('\r\n');
};
const safe = (t) => String(t || 'file').replace(/[^\w.-]+/g, '_').slice(0, 80);

const isPdf = (x) => x.mime === 'application/pdf' || /\.pdf$/i.test(x.name || '');
const pdfName = (n) => (/\.pdf$/i.test(n) ? n : `${n}.pdf`);

// photos / pdfs: include RMA photos, and every PDF (RMA PDFs and challans, care pack OEM invoices, OEM batch challans).
export async function buildBackupZip({ dataUrl, fileUrl, photos = true, pdfs = true, onStep = () => {} }) {
  onStep('Reading data…');
  const res = await fetch(dataUrl, { credentials: 'same-origin' });
  const d = await res.json();
  if (!res.ok) throw new Error(d?.error || 'Could not read the data');
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  zip.file('data.json', JSON.stringify(d, null, 1));
  for (const [name, rows] of Object.entries(d.tables)) if (rows.length) zip.file(`tables/${name}.csv`, csv(rows));
  const cpInvoice = Object.fromEntries((d.tables.cp_batches || []).map((b) => [`cp-oem-${b.id}`, b.invoice_number]));
  const files = [];
  for (const p of d.photos) {
    const rma = safe(p.ticket_no || p.ticket_id);
    if (isPdf(p)) { if (pdfs) files.push({ kind: 'photo', id: p.id, path: `pdfs/rma/${rma}/${p.direction}-${safe(pdfName(p.name || String(p.id)))}` }); }
    else if (photos) files.push({ kind: 'photo', id: p.id, path: `photos/${rma}/${p.direction}-${safe(p.name || p.id)}` });
  }
  for (const f of d.files) {
    if (!isPdf(f)) { files.push({ kind: 'file', id: f.id, path: `files/${safe(f.id)}-${safe(f.name)}` }); continue; }
    if (!pdfs) continue;
    const batch = f.id.match(/^batch_challan_(.+)$/);
    const path = cpInvoice[f.id] ? `pdfs/care-packs/${safe(cpInvoice[f.id])}-${safe(pdfName(f.name || 'oem-invoice'))}`
      : batch ? `pdfs/oem-batches/${safe(batch[1])}-${safe(pdfName(f.name || 'challan'))}`
        : `pdfs/other/${safe(f.id)}-${safe(pdfName(f.name || 'file'))}`;
    files.push({ kind: 'file', id: f.id, path });
  }
  let done = 0;
  const missing = [];
  for (const f of files) {
    onStep(`Downloading photos, PDFs and files ${++done} of ${files.length}…`);
    const r = await fetch(fileUrl(f.kind, f.id), { credentials: 'same-origin' });
    if (r.ok) zip.file(f.path, await r.arrayBuffer()); else missing.push(f.path);
  }
  zip.file('README.txt', [`${d.company.name} (${d.company.code}) — backup taken ${d.exportedAt}`, '',
    'data.json   everything in one file (used to restore)', 'tables/     one CSV per table (opens in Excel)', 'photos/     RMA photos by RMA number',
    'pdfs/       rma/ (PDFs and challans by RMA number), care-packs/ (OEM invoices), oem-batches/ (challans)',
    'files/      OEM template, logo and other files', '', 'Zoho keys and other secrets are not included.',
    missing.length ? `Could not download: ${missing.join(', ')}` : ''].join('\r\n'));
  onStep('Making the ZIP…');
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  return { blob, company: d.company, missing };
}
