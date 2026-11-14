// Builds a full backup ZIP in the browser: data.json, one CSV per table, and (optionally) every photo and file.
const csv = (rows) => {
  if (!rows.length) return '';
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v) => { if (v === null || v === undefined) return ''; const t = String(v); return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  return '﻿' + [cols.join(','), ...rows.map((r) => cols.map((k) => cell(r[k])).join(','))].join('\r\n');
};
const safe = (t) => String(t || 'file').replace(/[^\w.-]+/g, '_').slice(0, 80);

export async function buildBackupZip({ dataUrl, fileUrl, photos = true, onStep = () => {} }) {
  onStep('Reading data…');
  const res = await fetch(dataUrl, { credentials: 'same-origin' });
  const d = await res.json();
  if (!res.ok) throw new Error(d?.error || 'Could not read the data');
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  zip.file('data.json', JSON.stringify(d, null, 1));
  for (const [name, rows] of Object.entries(d.tables)) if (rows.length) zip.file(`tables/${name}.csv`, csv(rows));
  const files = [...(photos ? d.photos.map((p) => ({ kind: 'photo', id: p.id, path: `photos/${safe(p.ticket_no || p.ticket_id)}/${p.direction}-${safe(p.name || p.id)}` })) : []),
    ...d.files.map((f) => ({ kind: 'file', id: f.id, path: `files/${safe(f.id)}-${safe(f.name)}` }))];
  let done = 0;
  const missing = [];
  for (const f of files) {
    onStep(`Downloading photos and files ${++done} of ${files.length}…`);
    const r = await fetch(fileUrl(f.kind, f.id), { credentials: 'same-origin' });
    if (r.ok) zip.file(f.path, await r.arrayBuffer()); else missing.push(f.path);
  }
  zip.file('README.txt', [`${d.company.name} (${d.company.code}) — backup taken ${d.exportedAt}`, '',
    'data.json   everything in one file (used to restore)', 'tables/     one CSV per table (opens in Excel)', 'photos/     RMA photos by RMA number',
    'files/      care pack PDFs, OEM template and other files', '', 'Zoho keys and other secrets are not included.',
    missing.length ? `Could not download: ${missing.join(', ')}` : ''].join('\r\n'));
  onStep('Making the ZIP…');
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  return { blob, company: d.company, missing };
}
