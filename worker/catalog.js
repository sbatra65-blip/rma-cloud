// Care Pack rules shared by the Worker and the browser (pure JavaScript, no platform APIs).
// Ported from the desktop app: SerialNumberParser, OemBrandCatalog, InvoiceCarePackSetBuilder,
// BrandMismatchDetector and the PDF invoice field patterns.

export const BRANDS = ['TSC Auto ID', 'Printronix', 'Honeywell'];
export const CARE_PACK_TYPES = ['1 Year', '2 Year', '3 Year', '4 Year', '5 Year', 'Comprehensive Care Pack'];
const MODEL_BRANDS = [
  ['Printronix', ['T310', 'T330', 'T4000', 'T6000', 'T6000E', 'T6304', 'T6304E', 'T8000']],
  ['TSC Auto ID', ['TE310', 'TE210', 'TE200', 'TTP', 'MB240', 'DA210', 'DA310']],
  ['Honeywell', ['PM45', 'PM43', 'PX4', 'PX6']],
];
const MODEL_MAP = new Map();
for (const [brand, models] of MODEL_BRANDS) for (const m of models) MODEL_MAP.set(m.toUpperCase(), { brand, key: m });
const MODEL_KEYS = [...MODEL_MAP.values()].map((v) => v.key).sort((a, b) => b.length - a.length);
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const blank = (s) => s === null || s === undefined || String(s).trim() === '';
export const eqCI = (a, b) => String(a ?? '').trim().toUpperCase() === String(b ?? '').trim().toUpperCase();

// ---------- Brand / model / duration ----------
export function detectBrandFromText(text) {
  if (blank(text)) return null;
  const t = String(text).toUpperCase();
  // Deliberate fix: the desktop app also treated any "CCP" + "PRINT" text as Printronix,
  // which wrongly tagged TSC invoices that say "printer ... 3YCCP".
  if (t.includes('PRINTRONIX')) return 'Printronix';
  if (t.includes('HONEYWELL')) return 'Honeywell';
  if (t.includes('TSC') || t.includes('AUTO ID')) return 'TSC Auto ID';
  return null;
}
export function detectBrandFromModel(model) {
  if (blank(model)) return null;
  const m = String(model).trim().toUpperCase();
  if (MODEL_MAP.has(m)) return MODEL_MAP.get(m).brand;
  for (const key of MODEL_KEYS) if (m.startsWith(key.toUpperCase())) return MODEL_MAP.get(key.toUpperCase()).brand;
  return null;
}
export function detectModelFromText(text) {
  if (blank(text)) return null;
  for (const key of MODEL_KEYS) if (new RegExp(`\\b${escRe(key)}\\b`, 'i').test(text)) return key;
  const m = String(text).match(/\b(T\d{3,4}e?)\b/i);
  return m ? m[1].toUpperCase() : null;
}
export function detectDurationYears(text) {
  if (blank(text)) return null;
  const m = String(text).match(/(\d)\s*[Yy]ear|\b(\d)YCCP\b|\b(\d)\s*Y\b/);
  if (!m) return null;
  const g = m[1] || m[2] || m[3];
  return g ? Number(g) : null;
}
export const carePackTypeFromYears = (y) => (y >= 1 && y <= 5 ? `${y} Year` : '5 Year');

export function analyzeMismatch(itemName, description) {
  const itemBrand = detectBrandFromText(itemName) ?? detectBrandFromText(description);
  const model = detectModelFromText(description) ?? detectModelFromText(itemName);
  const modelBrand = detectBrandFromModel(model);
  const cpType = carePackTypeFromYears(detectDurationYears(description) ?? detectDurationYears(itemName));
  const has = !!(itemBrand && modelBrand && !eqCI(itemBrand, modelBrand));
  return {
    hasMismatch: has, itemBrand, modelBrand, model, carePackType: cpType,
    message: has ? `${itemBrand} care pack selected but ${model} is a ${modelBrand} model` : 'Brand and model are consistent',
  };
}

// ---------- Serial numbers ----------
const REJECT = new Set(('PCS PC NOS NO QTY QUANTITY HSN SAC GST GSTIN IGST CGST SGST TOTAL RATE AMOUNT PART SEE NOTES TERMS AND CONDITIONS '
  + 'YEAR YEARS PRINTER PRINTERS COMPREHENSIVE CARE PACK FOR THE THIS INVOICE PRINTRONIX HONEYWELL TSC BARCODE MODEL').split(' '));
const LABELED = /\b(?:S\.?\s*No\.?\s*#?|Serial\s*(?:No\.?|Number|#)?|S\/?N)\s*[:#]?\s*(.+?)(?=(?:\r?\n\s*(?:PART|HSN|Qty|Rate|Amount|Comprehensive|Care\s*Pack|#\s*\d)|\r?\n\r?\n|$))/gis;

/** Cleans one serial: trims, removes spaces, upper-cases, fixes "TEB T…", peels glued HSN codes. */
export function cleanToken(token) {
  if (blank(token)) return { sn: null, fixed: false };
  const stripped = String(token).trim().replace(/[.:]+$/, '');
  const fixed = /\s/.test(stripped);
  let s = stripped.replace(/\s+/g, '').toUpperCase();
  if (!s) return { sn: null, fixed };
  if (/^TEBT?\d+$/i.test(s)) s = s.replace(/^TEB\s*T?/i, 'TEBT');
  const peel = s.match(/^(.+?)(84\d{6,})(?:PCS)?$/i);
  if (peel && /[A-Z]/i.test(peel[1])) s = peel[1].toUpperCase();
  return { sn: s, fixed };
}
export const cleanSerial = (s) => cleanToken(s).sn || (blank(s) ? null : String(s).trim().toUpperCase());

function isNoise(sn) {
  if (blank(sn)) return true;
  const s = sn.trim().toUpperCase();
  // Serials always carry a digit; all-letter tokens are words ("LABELROLL"), and 6–12 digit runs are HSN / phone numbers.
  return REJECT.has(s) || /^\d{6,12}$/.test(s) || !/\d/.test(s);
}
// "A123 B456 C789" is three serials; "TEB T25370458" / "tebt 25370458" is one serial with a stray space.
const serialLike = (w) => /\d/.test(w) && w.replace(/[^A-Za-z0-9]/g, '').length >= 5 && !isNoise(w);
function splitSpaced(piece) {
  const words = String(piece).trim().split(/\s+/).filter(Boolean);
  return words.length > 1 && words.every(serialLike) ? words : [piece];
}
function finalize(list) {
  const seen = new Set();
  const out = { serials: [], spaceFixed: [], duplicates: [], rawCount: 0 };
  for (const [tok, fixed] of list) {
    out.rawCount++;
    if (fixed) out.spaceFixed.push(`→ ${tok}`);
    const k = tok.toUpperCase();
    if (seen.has(k)) { if (!out.duplicates.some((d) => d.toUpperCase() === k)) out.duplicates.push(tok); continue; }
    seen.add(k);
    out.serials.push(tok);
  }
  return out;
}
function labeled(text) {
  const list = [];
  for (const m of String(text).matchAll(LABELED)) {
    let body = m[1].split(/\bPART\s*#|\bHSN\b|\bSAC\b|\d{8}\s*PCS\b/i)[0];
    body = body.replace(/(\d)(84\d{6})(?!\d)/g, '$1');
    for (const piece of body.split(/[,;\r\n\t]/).map((p) => p.trim()).filter(Boolean).flatMap(splitSpaced)) {
      if (piece.split(/\s+/).length > 2) continue; // a sentence after the list, not a serial
      const c = cleanToken(piece);
      if (c.sn && /\d/.test(c.sn)) list.push([c.sn, c.fixed]);
    }
  }
  return list;
}
/** Serials from a pasted block, one per line or comma-separated (labelled "S/N:" blocks preferred). */
export function parseSerials(text) {
  if (blank(text)) return finalize([]);
  const lab = labeled(text);
  if (lab.length) return finalize(lab);
  const list = [];
  for (const line of String(text).split(/[\r\n]+/).filter(Boolean)) {
    for (const tok of line.split(/[,;\t]/).filter(Boolean).flatMap(splitSpaced)) {
      const c = cleanToken(tok);
      if (c.sn && !isNoise(c.sn)) list.push([c.sn, c.fixed]);
    }
  }
  return finalize(list);
}
/** Serials from free text such as a whole PDF page. */
export function extractSerialsLoose(text) {
  if (blank(text)) return finalize([]);
  const lab = labeled(text);
  if (lab.length) return finalize(lab);
  const list = [];
  for (const m of String(text).matchAll(/\bTEB\s*T?\s*\d{8}\b/gi)) {
    const c = cleanToken(m[0]);
    if (c.sn) list.push([c.sn, false]);
  }
  for (const m of String(text).matchAll(/\b[A-Za-z0-9][A-Za-z0-9-]*\b/g)) {
    const c = cleanToken(m[0]);
    if (c.sn && !isNoise(c.sn) && /\d/.test(c.sn) && c.sn.length >= 5) list.push([c.sn, false]);
  }
  return finalize(list);
}
/** Best effort for anything the user pastes: labelled → line list → loose text → raw lines. */
export function serialsFromAnything(text, extra = []) {
  const out = [];
  const seen = new Set();
  const add = (s) => { const c = cleanSerial(s); if (c && !seen.has(c)) { seen.add(c); out.push(c); } };
  if (!blank(text)) {
    let p = parseSerials(text);
    if (!p.serials.length) p = extractSerialsLoose(text);
    p.serials.forEach(add);
  }
  extra.forEach(add);
  if (!out.length && !blank(text)) String(text).split(/[\r\n,;]+/).forEach(add);
  return out;
}

export function detectQty(text) {
  if (blank(text)) return null;
  for (const re of [/\b(?:qty|quantity)\s*[:=]?\s*(\d{1,4})\b/i, /\b(\d{1,4})\s*(?:pcs|pc|nos|no\.?|units?|printers?)\b/i, /\b(?:pcs|pc|nos|units?)\s*[:=]?\s*(\d{1,4})\b/i]) {
    const m = String(text).match(re);
    if (m && Number(m[1]) > 0 && Number(m[1]) < 10000) return Number(m[1]);
  }
  return null;
}

/** Invoice serials must all be on the PO (one OEM PO may cover several invoices). */
export function crossValidate(invoiceSns, poSns) {
  const inv = new Set(invoiceSns.map((s) => s.toUpperCase()));
  const po = new Set(poSns.map((s) => s.toUpperCase()));
  const matched = [...inv].filter((s) => po.has(s)).sort();
  const onlyInPo = [...po].filter((s) => !inv.has(s)).sort();
  const onlyInInvoice = [...inv].filter((s) => !po.has(s)).sort();
  const total = Math.max(inv.size, 1);
  return {
    matched, onlyInPo, onlyInInvoice,
    mismatchPercent: Math.round((onlyInInvoice.length / total) * 1000) / 10,
    perfect: onlyInInvoice.length === 0 && inv.size > 0 && po.size > 0,
  };
}

// ---------- Zoho invoice → product line sets (InvoiceCarePackSetBuilder) ----------
const upperText = (l) => `${l.name || ''} ${l.description || ''}`.toUpperCase();
function isCarePackLine(l) {
  const t = upperText(l);
  return t.includes('CARE PACK') || t.includes('CAREPACK') || t.includes('YCCP') || /\b\d\s*Y\s*CCP\b/.test(t)
    || (t.includes('CCP') && (t.includes('COMPREHENSIVE') || t.includes('YEAR')));
}
function isPrinterLine(l) {
  if (isCarePackLine(l)) return false;
  const t = upperText(l);
  if (t.includes('PRINTER') || t.includes('BARCODE')) return true;
  return parseSerials(`${l.name || ''}\n${l.description || ''}`).serials.length > 0;
}
const lineText = (l) => [l.name, l.description].filter((x) => !blank(x)).join('\n');
function firstSerials(...texts) {
  for (const t of texts) {
    if (blank(t)) continue;
    let p = parseSerials(t);
    if (!p.serials.length) p = extractSerialsLoose(t);
    if (p.serials.length) return p.serials;
  }
  return [];
}
function buildOne(index, printers, cp, notes, qtyOverride) {
  const parts = [...printers.map(lineText), cp ? lineText(cp) : '', index === 1 ? notes || '' : ''].filter((x) => !blank(x));
  const combined = parts.join('\n');
  const printerText = printers.map((p) => `${p.name || ''}\n${p.description || ''}`).join('\n');
  const cpText = cp ? `${cp.name || ''}\n${cp.description || ''}` : '';
  const serials = firstSerials(printerText, cpText, notes);
  const printerName = printers[0]?.name || cp?.name || 'Line item';
  const model = detectModelFromText(printerText) ?? detectModelFromText(printerName);
  const brandFromPrinter = detectBrandFromText(printerName) ?? detectBrandFromText(printerText) ?? detectBrandFromModel(model);
  const cpDesc = cp ? cpText : combined;
  const cpType = carePackTypeFromYears(detectDurationYears(cpDesc) ?? detectDurationYears(combined));
  const itemBrand = detectBrandFromText(cp?.name) ?? detectBrandFromText(cpDesc) ?? brandFromPrinter;
  const mm = analyzeMismatch(cp?.name ?? printerName, combined);
  if (blank(mm.model) && model) { mm.model = model; mm.modelBrand = detectBrandFromModel(model) ?? mm.modelBrand; }
  let qty;
  if (qtyOverride > 0) qty = qtyOverride;
  else if (printers.length === 1 && Number(printers[0].quantity) > 0) qty = Math.trunc(printers[0].quantity);
  else qty = Math.trunc(Number(cp?.quantity) > 0 ? cp.quantity : printers.reduce((a, p) => a + Number(p.quantity || 0), 0));
  if (qty <= 0) qty = serials.length || 1;
  if (serials.length && qty <= 1) qty = serials.length;
  return {
    setIndex: index, printerItemName: printerName, carePackItemName: cp?.name || null,
    printerModel: mm.model ?? model, oemBrand: itemBrand ?? mm.itemBrand ?? mm.modelBrand,
    carePackType: mm.carePackType ?? cpType, qty, serials, description: combined, mismatch: mm,
  };
}
/** Groups invoice lines into printer + care pack sets. lines: [{ name, description, quantity }] */
export function buildLineSets(lines, notes) {
  const sets = [];
  let pending = [];
  let index = 1;
  const flush = (cp) => {
    if (!pending.length && !cp) return;
    if (pending.length <= 1) sets.push(buildOne(index++, pending, cp, notes));
    else for (const p of pending) sets.push(buildOne(index++, [p], cp, notes, Math.max(1, Math.trunc(p.quantity || 0))));
    pending = [];
  };
  for (const l of lines) {
    if (isCarePackLine(l)) { if (pending.length) flush(l); else sets.push(buildOne(index++, [], l, notes)); }
    else if (isPrinterLine(l)) pending.push(l);
  }
  if (pending.length) flush(null);
  if (!sets.length && lines.length) {
    const all = `${lines.map((l) => `${l.name || ''}\n${l.description || ''}`).join('\n')}\n${notes || ''}`;
    const cp = lines.find(isCarePackLine);
    const mm = analyzeMismatch(cp?.name ?? lines[0].name, all);
    sets.push({ setIndex: 1, printerItemName: lines[0].name, carePackItemName: cp?.name || null, printerModel: mm.model,
      oemBrand: mm.itemBrand ?? mm.modelBrand, carePackType: mm.carePackType, qty: Math.max(1, Math.trunc(cp?.quantity ?? lines[0].quantity ?? 1)),
      serials: firstSerials(all), description: all, mismatch: mm });
  }
  return sets;
}

// ---------- Sales invoice PDF text → prefill (PreviewSalesInvoicePdf) ----------
function matchFirst(text, patterns) {
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1]) {
      const v = m[1].trim().replace(/[.,;]+$/, '');
      if (v) return v;
    }
  }
  return null;
}
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
export function parseDayFirst(raw) {
  if (blank(raw)) return null;
  const s = String(raw).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[-/. ](\d{1,2}|[A-Za-z]{3})[A-Za-z]*[-/. ](\d{2,4})$/);
  if (!m) return null;
  const d = Number(m[1]);
  const mo = /\d/.test(m[2]) ? Number(m[2]) : MON[m[2].toLowerCase()];
  let y = Number(m[3]);
  if (y < 100) y += 2000;
  if (!mo || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
export function parseInvoicePdfText(fullText) {
  const t = String(fullText || '');
  const i = 'im';
  let serials = extractSerialsLoose(t).serials;
  if (!serials.length) serials = parseSerials(t).serials;
  const model = detectModelFromText(t) ?? matchFirst(t, [new RegExp(String.raw`\b(T\d{3,4}[A-Za-z]?|TE\d{3}|MB\d{3}|T6\d{3}[A-Za-z]?)\b`, i)]);
  const lower = t.toLowerCase();
  const cpType = CARE_PACK_TYPES.find((c) => lower.includes(c.toLowerCase()))
    ?? (/\b3\s*Year/i.test(t) ? '3 Year' : /\b5\s*Year/i.test(t) ? '5 Year' : /\b1\s*Year/i.test(t) ? '1 Year' : '3 Year');
  const out = {
    invoiceNumber: matchFirst(t, [/\b(IS[- ]?GST[- ]?\d{2,4}[- ]?\d+)\b/im, /Invoice\s*(?:No\.?|Number|#)\s*[:.]?\s*([A-Z0-9][-A-Z0-9/]+)/im, /Inv\.?\s*No\.?\s*[:.]?\s*([A-Z0-9][-A-Z0-9/]+)/im]) || '',
    customerName: matchFirst(t, [/(?:Bill\s*To|Buyer|Customer\s*Name|Sold\s*To)\s*[:.]?\s*([A-Za-z0-9 &.,'-]{3,80})/im, /M\/s\.?\s+([A-Za-z0-9 &.,'-]{3,80})/im]),
    customerCity: matchFirst(t, [/(?:City|Place)\s*[:.]?\s*([A-Za-z ]{2,40})/im]),
    invoiceDate: parseDayFirst(matchFirst(t, [/Invoice\s*Date\s*[:.]?\s*(\d{1,2}[-/]\d{1,2}[-/]\d{2,4})/im, /Dated\s*[:.]?\s*(\d{1,2}[-/]\d{1,2}[-/]\d{2,4})/im,
      /\b(\d{1,2}[-/](?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[-/]\d{2,4})\b/im])),
    irn: matchFirst(t, [/\bIRN\s*[:.]?\s*([A-Za-z0-9]{20,100})/im]),
    irnAckNo: matchFirst(t, [/Ack\s*No\.?\s*[:.]?\s*([A-Za-z0-9-]+)/im]),
    printerModel: model,
    oemBrand: detectBrandFromText(t) ?? detectBrandFromModel(model),
    carePackType: cpType,
    printerItemName: matchFirst(t, [/((?:TSC|Printronix|Zebra|Honeywell)[^\n]{0,80}Printer[^\n]{0,40})/im, /(Barcode\s+Printer[^\n]{0,60})/im]),
    carePackItemName: matchFirst(t, [/((?:Comprehensive\s+)?Care\s*Pack[^\n]{0,80})/im, /(YCCP[^\n]{0,60})/im]),
    serials,
    warnings: [],
  };
  out.qty = detectQty(t) ?? Math.max(1, serials.length);
  if (!serials.length) out.warnings.push('No serial numbers detected. Paste them manually after review.');
  if (!out.invoiceNumber) out.warnings.push('Invoice number not found — enter it manually.');
  if (!out.customerName) out.warnings.push('Customer name not found — enter it manually.');
  return out;
}

// ---------- Dates ----------
/** Adds whole years; 29 Feb → 28 Feb in non-leap years (same as .NET DateOnly.AddYears). */
export function addYears(iso, years) {
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number);
  const last = new Date(Date.UTC(y + years, m, 0)).getUTCDate();
  return `${y + years}-${String(m).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}
export function addDays(iso, days) {
  if (!iso) return null;
  const t = Date.parse(iso + 'T00:00:00Z') + days * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}
export const daysUntil = (iso, today) => (iso ? Math.round((Date.parse(iso + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000) : null);
export const fmtDMY = (iso) => {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return `${d}-${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1]}-${y}`;
};
