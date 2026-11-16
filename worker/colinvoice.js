// Reads GST tax invoices laid out in columns, as printed by Busy (standard "Billed to / Shipped to" layout and the
// customised "Party Details" layout), from rows of positioned text (src/pdftext.js rowsFromTextItems).
// Gives the invoice number and date, the customer (name, address, PIN, state, GSTIN, mobile), and product sets:
// printer item, model, serial numbers, and the care pack sold with it (years, print-head limit, service type).
// Returns null when the rows do not look like such an invoice, so the caller can fall back to plain-text reading.
import { detectBrandFromText, parseDayFirst } from './catalog.js';

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/;
const isColon = (s) => /^:+$/.test(s);

// A token that looks like a serial number: letters and at least 4 digits, 8–20 characters, not a GSTIN.
export function serialLike(tok) {
  const t = String(tok || '').toUpperCase();
  return /^[A-Z0-9][A-Z0-9-]{6,18}[A-Z0-9]$/.test(t) && /[A-Z]/.test(t) && (t.match(/\d/g) || []).length >= 4 && !GSTIN.test(t);
}
// A description line made only of serial numbers ("TEAT26150640, TEAT26150681", "S/N: X1, X2").
function serialsOfLine(line) {
  const l = norm(line).replace(/^(?:S\/?N|Sr\.?\s*No|Serial(?:\s*No\.?|s)?)\s*[:.-]?\s*/i, '');
  const toks = l.split(/[\s,;]+/).filter(Boolean);
  return toks.length && toks.every(serialLike) ? toks.map((t) => t.toUpperCase()) : null;
}

// Value of a "Label : value" pair in a row: the first cell after the label (skipping ":"), left of `stopX`.
function valueAfter(row, labelIdx, stopX = Infinity) {
  for (let i = labelIdx + 1; i < row.cells.length; i++) {
    const c = row.cells[i];
    if (c.x >= stopX) break;
    if (isColon(c.s)) continue;
    const v = c.s.replace(/^:\s*/, '').trim();
    if (v) return v;
  }
  // "Label : value" written as one cell
  const m = row.cells[labelIdx].s.match(/:\s*(.+)$/);
  return m ? m[1].trim() : '';
}
function findLabel(rows, re, { fromX = -Infinity, toX = Infinity, start = 0, end = rows.length } = {}) {
  for (let r = start; r < end; r++) {
    const cells = rows[r].cells;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      if (c.x >= fromX && c.x < toX && re.test(c.s.replace(/\s*:.*$/, '').trim())) return { r, i, row: rows[r] };
    }
  }
  return null;
}

function modelFrom(desc) {
  const d = norm(desc).replace(/\b(TSC(?:\s+Auto\s+ID)?|Printronix|Honeywell|Zebra)\b/gi, ' ').trim();
  const raw = norm(d.split(/[,(]/)[0]);
  const m = raw.match(/\b([A-Z]{1,4})[\s-]?(\d{2,4}[A-Z]?)\b/i);
  return { raw, code: m ? `${m[1]}${m[2]}`.toUpperCase() : raw.split(' ')[0] || '' };
}

export function parseColumnInvoice(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const hdr = rows.findIndex((r) => r.cells.some((c) => /Description\s+of\s+Goods/i.test(c.s)));
  if (hdr < 0) return null;
  const partyStd = findLabel(rows, /^Billed\s+to$/i, { end: hdr });
  const partyCus = findLabel(rows, /^Party\s+Details$/i, { end: hdr });
  if (!partyStd && !partyCus) return null;
  const layout = partyStd ? 'standard' : 'custom';
  const party = partyStd || partyCus;
  // The right-hand column starts at "Shipped to" (standard) or at the invoice labels (custom).
  const rightX = (partyStd ? party.row.cells.find((c) => /^Shipped\s+to/i.test(c.s))?.x : party.row.cells.find((c, i) => i > party.i && !isColon(c.s))?.x) ?? 280;
  const leftEnd = rightX - 4;

  // ---- invoice fields (anywhere above the item table) ----
  const field = (re, opts = {}) => {
    const f = findLabel(rows, re, { end: hdr, ...opts });
    return f ? valueAfter(f.row, f.i, f.row.cells[f.i].x < rightX - 4 ? rightX - 4 : Infinity) : '';
  };
  const invoiceNumber = field(/^Invoice\s+No\.?$/i);
  const invoiceDate = parseDayFirst(field(/^Dated$/i)) || null;
  const poRef = field(/^(?:P\.?\s*O\.?\s*No\.?\s*(?:&|\/)\s*Date|Po\s+No\s*&\s*Date)$/i);
  const placeOfSupply = field(/^Place\s+of\s+Supply$/i);

  // ---- customer: left column of the party block ----
  const leftCells = (r) => rows[r].cells.filter((c) => c.x < leftEnd);
  const labelRe = /^(Party\s+Mobile\s+No|Mobile\s+No\.?|GSTIN\s*\/\s*UIN|Party\s+GSTIN|GSTIN|State\s*Code|Contact|Phone|Email)\b/i;
  const lines = [];
  for (let r = party.r + 1; r < hdr; r++) {
    const cells = leftCells(r);
    if (!cells.length) continue;
    if (labelRe.test(cells[0].s)) break;
    lines.push(norm(cells.map((c) => c.s).join(' ')));
  }
  const name = (lines.shift() || '').replace(/[,\s]+$/, '');
  let postal = '';
  let state = '';
  let city = '';
  const address = [];
  for (const l of lines) {
    const st = l.match(/^([A-Za-z .&]+)\s*\((\d{2})\)$/);
    if (st) { state = norm(st[1]); continue; }
    const pin = l.match(/(?:^|\D)(\d{6})\s*(?:\s+([A-Za-z .&]+)\s*\(\d{2}\))?$/);
    if (pin && l.replace(/\D/g, '').length <= 8) {
      postal = pin[1];
      if (pin[2]) state = norm(pin[2]);
      const rest = norm(l.replace(pin[0], ''));
      if (rest) address.push(rest);
      continue;
    }
    address.push(l.replace(/[,\s]+$/, ''));
  }
  if (!state && placeOfSupply) state = norm(placeOfSupply.replace(/\(\d{2}\).*$/, ''));
  if (address.length) {
    city = address[address.length - 1].split(',').map((x) => x.trim()).filter(Boolean).pop() || '';
    city = city.replace(/^(?:Distt?\.?|District|Teh\.?|Tehsil)\s+/i, '');
    if (state) city = city.replace(new RegExp(`\\s*${state.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'), '').trim();
  }
  const gstinF = findLabel(rows, /^(?:GSTIN\s*\/\s*UIN|Party\s+GSTIN)$/i, { start: party.r, end: hdr, toX: leftEnd });
  const mobileF = findLabel(rows, /^(?:Party\s+Mobile\s+No|Mobile\s+No\.?)$/i, { start: party.r, end: hdr, toX: leftEnd });
  const gstin = gstinF ? valueAfter(gstinF.row, gstinF.i, leftEnd).toUpperCase() : '';
  const mobile = mobileF ? valueAfter(mobileF.row, mobileF.i, leftEnd).replace(/[^\d+]/g, '') : '';

  // ---- item table ----
  const head = rows[hdr].cells;
  const hsnX = head.find((c) => /HSN/i.test(c.s))?.x ?? 200;
  const qtyX = head.find((c) => /^Qty/i.test(c.s))?.x ?? hsnX + 60;
  const items = [];
  let cur = null;
  for (let r = hdr + 1; r < rows.length; r++) {
    const cells = rows[r].cells;
    if (cells.some((c) => /^(Sub\s*Total|Grand\s+Total|Add)\b/i.test(c.s) || /^Tax\s+Rate$/i.test(c.s))) break;
    if (/^Code$/i.test(cells[0]?.s) && cells.length === 1) continue;
    const first = cells[0];
    const sn = first && first.x < hsnX - 20 ? first.s.match(/^(\d{1,3})\.\s*(.*)$/) : null;
    if (sn) {
      let desc = sn[2];
      if (!desc && cells[1] && cells[1].x < hsnX - 5) desc = cells[1].s;
      const hsn = cells.find((c) => Math.abs(c.x - hsnX) < 25 && /^\d{4,8}$/.test(c.s))?.s || '';
      const q = cells.find((c) => Math.abs(c.x - qtyX) < 25 && /^\d+(?:\.\d+)?\b/.test(c.s))?.s || '';
      cur = { desc: norm(desc), hsn, qty: q ? Math.round(parseFloat(q)) : null, lines: [] };
      items.push(cur);
      continue;
    }
    const descCells = cells.filter((c) => c.x < hsnX - 5);
    if (cur && descCells.length && descCells.length === cells.length) cur.lines.push(norm(descCells.map((c) => c.s).join(' ')));
    else if (cur && !descCells.length) continue; // amount carried on its own line
  }

  // ---- classify and pair printers with care packs ----
  const printers = [];
  const packs = [];
  for (const it of items) {
    const text = `${it.desc} ${it.lines.join(' ')}`;
    if (/^9987/.test(it.hsn) || /service\s+pack|care\s*pack|warranty\s+pack|extended\s+warranty|\bAMC\b/i.test(it.desc)) {
      const years = Number(text.match(/(?:to|for|upto|up\s+to)\s+(\d{1,2})\s*(?:Years?|Yrs?)\b/i)?.[1] || text.match(/\b(\d{1,2})\s*(?:Years?|Yrs?)\b/i)?.[1]) || null;
      packs.push({
        itemName: it.desc, qty: it.qty, years,
        headLimit: Number(text.match(/Maximum\s+(\d+)\s+Print\s*Heads?/i)?.[1]) || null,
        service: /return\s+to\s+base|\bRTB\b/i.test(text) ? 'Return to base' : /on\s*-?\s*site/i.test(text) ? 'Onsite' : null,
        comprehensive: /comprehensive/i.test(text),
        reference: it.lines.find((l) => /^[A-Z]{2,8}\/[\w-]+\/\d+$/i.test(l)) || null,
        notes: it.lines,
      });
      continue;
    }
    const serials = [];
    const other = [];
    for (const l of it.lines) {
      const s = serialsOfLine(l);
      if (s) serials.push(...s); else other.push(l);
    }
    const isPrinter = /^8443/.test(it.hsn) || /\bprinter\b/i.test(it.desc) || serials.length > 0;
    if (!isPrinter) continue; // terms, freight, cables…
    const w = other.join(' ');
    const { raw, code } = modelFrom(it.desc);
    printers.push({
      itemName: it.desc, hsn: it.hsn, qty: it.qty, serials, brand: detectBrandFromText(it.desc), modelText: raw, model: code,
      warranty: {
        printerYears: Number(w.match(/PRINTER\s+(\d{1,2})\s+YEARS?/i)?.[1]) || null,
        headMonths: Number(w.match(/PRINT\s*HEAD\s+(\d{1,2})\s+MONTHS?/i)?.[1]) || null,
        headKm: Number(w.match(/(\d{1,4})\s*KM\b/i)?.[1]) || null,
      },
    });
  }
  // A care pack belongs to the printer above it with the same quantity, or else to the nearest printer above it.
  const sets = printers.map((p) => ({ ...p, carePack: null }));
  let pi = 0;
  for (const it of items) {
    const p = printers.find((x) => x.itemName === it.desc && x.qty === it.qty && !x._seen);
    if (p) { p._seen = true; pi = printers.indexOf(p); continue; }
    const pack = packs.find((x) => x.itemName === it.desc && !x._used);
    if (!pack) continue;
    pack._used = true;
    let target = -1;
    for (let k = pi; k >= 0; k--) if (sets[k] && !sets[k].carePack && sets[k].qty === pack.qty) { target = k; break; }
    if (target < 0) for (let k = pi; k >= 0; k--) if (sets[k] && !sets[k].carePack) { target = k; break; }
    if (target >= 0) sets[target].carePack = pack;
  }
  for (const s of sets) delete s._seen;

  const warnings = [];
  if (!invoiceNumber) warnings.push('Invoice number not found — enter it manually.');
  if (!name) warnings.push('Customer name not found — enter it manually.');
  if (!sets.length) warnings.push('No printer found on this invoice.');
  for (const s of sets) {
    if (s.qty && s.serials.length !== s.qty) warnings.push(`${s.itemName}: ${s.serials.length} serial number(s) for quantity ${s.qty} — check the serials.`);
    if (s.carePack && s.carePack.qty && s.qty && s.carePack.qty !== s.qty) warnings.push(`${s.carePack.itemName}: quantity ${s.carePack.qty} does not match ${s.qty} printer(s).`);
    if (!s.carePack) {
      const w = s.warranty;
      const desc = [w.printerYears && `printer ${w.printerYears} year${w.printerYears > 1 ? 's' : ''}`, w.headMonths && `print head ${w.headMonths} months${w.headKm ? ` or ${w.headKm} km` : ''}`].filter(Boolean).join(', ');
      warnings.push(`${s.itemName}: no care pack sold on this invoice${desc ? ` (standard warranty: ${desc})` : ''}.`);
    }
  }
  for (const p of packs) if (!p._used) warnings.push(`${p.itemName}: could not tell which printer it belongs to.`);
  for (const p of packs) delete p._used;

  return {
    format: `busy-${layout}`,
    invoiceNumber, invoiceDate, poRef, placeOfSupply,
    customer: { name, address: address.join(', '), city, postal, state, gstin: GSTIN.test(gstin) ? gstin : '', mobile },
    sets, warnings,
  };
}
