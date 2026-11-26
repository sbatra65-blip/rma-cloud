// Bulk OEM Excel: one download (ZIP) for the RMAs ticked on the RMA list.
// Inside: each RMA's own OEM form (your OEM template, filled, with its first five inbound photos — the same file
// "Generate OEM Excel" makes on one RMA) and one summary list of all of them, ready to email to the OEM.
import { api, downloadBlob, get, post } from './api.js';
import { fillOemTemplate, writeTable } from './excel.js';
import { fmtMs } from './ui.jsx';

export const BULK_EXCEL_MAX = 50;
const stamp = () => new Date().toISOString().slice(0, 10);
const safe = (s) => String(s || '').replace(/[\\/:*?"<>|]+/g, '_').trim();

export async function bulkOemExcel(ids, companyName, onProgress) {
  const list = ids.slice(0, BULK_EXCEL_MAX);
  const [{ default: JSZip }, tplRes] = await Promise.all([import('jszip'), api('GET', '/api/template', undefined, { raw: true })]);
  const template = await tplRes.arrayBuffer();
  const zip = new JSZip();
  const used = new Set();
  const done = [];
  const failed = [];
  for (let i = 0; i < list.length; i++) {
    onProgress?.(i + 1, list.length);
    try {
      const [d, ctx] = await Promise.all([get(`/api/rma/${list[i]}`), get(`/api/rma/${list[i]}/email`)]);
      const t = d.ticket;
      const photos = [];
      for (const p of d.photos.filter((x) => x.direction === 'INBOUND' && x.mime !== 'application/pdf').slice(0, 5)) {
        const r = await api('GET', `/api/photos/${p.id}`, undefined, { raw: true });
        photos.push(await r.blob());
      }
      const out = await fillOemTemplate(template.slice(0), ctx.tokens, photos);
      await post(`/api/rma/${t.id}/excel`);
      let name = safe(ctx.fileName || `${t.ticket_no}.xlsx`);
      if (!/\.xlsx$/i.test(name)) name += '.xlsx';
      if (used.has(name.toLowerCase())) name = name.replace(/\.xlsx$/i, ` (${safe(t.ticket_no)}).xlsx`);
      used.add(name.toLowerCase());
      zip.file(name, out.blob);
      done.push({ t, file: name, photos: out.embedded ?? photos.length });
    } catch (e) {
      failed.push({ id: list[i], error: e.message });
    }
  }
  if (!done.length) throw new Error(failed[0]?.error || 'No OEM Excel could be made');
  const summary = await writeTable({
    sheet: 'RMA list',
    title: `RMAs for the OEM — ${done.length} RMA${done.length === 1 ? '' : 's'}`,
    subtitle: `${companyName || ''} · Generated ${new Date().toLocaleString('en-IN')}`,
    headers: ['S.No.', 'Internal Ticket #', 'Date Raised', 'Customer Name', 'Printer Model', 'Printer SN', 'Faulty Part', 'Faulty Part No.', 'Faulty Part SN',
      'TPH Mileage', 'Printer Mileage', 'Firmware', 'Failure Description', 'OEM RMA #', 'Stage', 'Photos', 'Excel file'],
    widths: [6, 22, 14, 24, 15, 18, 15, 16, 18, 12, 14, 16, 36, 18, 22, 8, 34],
    rows: done.map(({ t, file, photos }, i) => [i + 1, t.ticket_no, fmtMs(t.created_at), t.customer_company || '', t.printer_model || '', t.printer_sn || '',
      t.faulty_part || '', t.faulty_part_no || '', t.faulty_part_sn || '', t.tph_mileage ?? '', t.printer_mileage ?? '', t.fw_version || '', t.failure_description || '', t.oem_rma_number || '',
      t.status_label || t.status, photos, file]),
    total: `Total RMAs: ${done.length}`,
  });
  zip.file(`RMA-list_${stamp()}.xlsx`, summary);
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  const name = `OEM-RMAs_${stamp()}_${done.length}.zip`;
  downloadBlob(blob, name);
  return { done: done.length, failed, skipped: ids.length - list.length, name };
}
