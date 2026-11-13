// Excel work happens in the browser, so the server never has to run heavy file code.
//  - fillOemTemplate: copies the OEM RMA form (.xlsx) and fills @@TOKENS@@ and @@photo1..5@@,
//    editing the workbook XML directly so logos, borders and merged cells stay untouched.
//  - writeTable: a simple formatted sheet (packing list, reports).
//  - readTable: reads .xlsx or .csv for import.
const NS = {
  main: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  rel: 'http://schemas.openxmlformats.org/package/2006/relationships',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  xdr: 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  ct: 'http://schemas.openxmlformats.org/package/2006/content-types',
};
const T_DRAWING = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing';
const T_IMAGE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
const EMU = 9525; // per pixel
// Photo boxes on the OEM form: 3 per row, 2 rows (fills the form's photo area).
const PHOTO_W = 300;
const PHOTO_H = 225;
const PER_ROW = 3;
const GAP = 12;

const parse = (xml) => new DOMParser().parseFromString(xml.replace(/^﻿/, ''), 'application/xml');
const serialize = (doc) => new XMLSerializer().serializeToString(doc);
const dirOf = (p) => p.slice(0, p.lastIndexOf('/') + 1);
const relsPath = (p) => `${dirOf(p)}_rels/${p.slice(p.lastIndexOf('/') + 1)}.rels`;
function resolve(base, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = (dirOf(base) + target).split('/');
  const out = [];
  for (const s of parts) {
    if (s === '..') out.pop();
    else if (s !== '.') out.push(s);
  }
  return out.join('/');
}
function relative(fromPart, toPart) {
  const a = dirOf(fromPart).split('/').filter(Boolean);
  const b = toPart.split('/');
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return '../'.repeat(a.length - i) + b.slice(i).join('/');
}
const byLocal = (node, name) => [...node.getElementsByTagNameNS('*', name)];
const colIndex = (ref) => [...ref.replace(/\d+/g, '')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
const rowIndex = (ref) => Number(ref.replace(/[A-Z]+/gi, '')) - 1;
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function replaceTokens(text, tokens, photoTokensToDrop) {
  let s = text;
  for (const [k, v] of Object.entries(tokens)) {
    s = s.replace(new RegExp(`@@${escRe(k)}@@`, 'gi'), v ?? '');
  }
  for (const t of photoTokensToDrop) s = s.replace(new RegExp(escRe(t), 'gi'), '');
  if (s !== text && photoTokensToDrop.length) s = s.replace(/ {2,}/g, ' ').trim();
  return s;
}
// Rewrites the text of one <si> / <is> string item, keeping it a single run.
function rewriteItem(item, tokens, drop) {
  const ts = byLocal(item, 't');
  const text = ts.map((t) => t.textContent).join('');
  if (!text.includes('@@')) return false;
  const next = replaceTokens(text, tokens, drop);
  if (next === text) return false;
  ts[0].textContent = next;
  ts[0].setAttribute('xml:space', 'preserve');
  for (const t of ts.slice(1)) t.textContent = '';
  return true;
}

async function relsOf(zip, part) {
  const p = relsPath(part);
  const f = zip.file(p);
  const doc = f ? parse(await f.async('string')) : parse(`<Relationships xmlns="${NS.rel}"/>`);
  return { path: p, doc };
}
function addRel(relsDoc, type, target) {
  const root = relsDoc.documentElement;
  const ids = byLocal(root, 'Relationship').map((r) => r.getAttribute('Id'));
  let n = ids.length + 1;
  while (ids.includes(`rId${n}`)) n++;
  const el = relsDoc.createElementNS(NS.rel, 'Relationship');
  el.setAttribute('Id', `rId${n}`);
  el.setAttribute('Type', type);
  el.setAttribute('Target', target);
  root.appendChild(el);
  return `rId${n}`;
}

async function imageInfo(blob) {
  let b = blob;
  if (!/^image\/(jpeg|png)$/.test(blob.type)) {
    // Excel can't show WEBP; turn anything else into JPEG first.
    const bmp = await createImageBitmap(blob);
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0);
    b = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.88));
  }
  const bmp = await createImageBitmap(b).catch(() => null);
  return { blob: b, ext: b.type === 'image/png' ? 'png' : 'jpeg', w: bmp?.width || 4, h: bmp?.height || 3 };
}

/**
 * @param {ArrayBuffer} templateBytes the OEM form
 * @param {Record<string,string>} tokens e.g. { PRINTER_MODEL: 'TE310', ... }
 * @param {Blob[]} photos up to 5 inbound photos, oldest first
 * @returns {Promise<{ blob: Blob, embedded: number, missingTokens: string[] }>}
 */
export async function fillOemTemplate(templateBytes, tokens, photos = []) {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(templateBytes);
  const wbPath = 'xl/workbook.xml';
  const wbRels = await relsOf(zip, wbPath);
  const rels = byLocal(wbRels.doc, 'Relationship');
  const sstRel = rels.find((r) => r.getAttribute('Type').endsWith('/sharedStrings'));
  const sstPath = sstRel ? resolve(wbPath, sstRel.getAttribute('Target')) : null;
  const wb = parse(await zip.file(wbPath).async('string'));
  const sheets = byLocal(wb, 'sheet').map((s) => {
    const rid = s.getAttributeNS(NS.r, 'id') || s.getAttribute('r:id');
    const rel = rels.find((r) => r.getAttribute('Id') === rid);
    return { name: s.getAttribute('name'), path: resolve(wbPath, rel.getAttribute('Target')) };
  });

  const list = photos.slice(0, 5);
  // All five photo marks are cleared (unused ones would otherwise print as text on the OEM form).
  const photoTokens = [1, 2, 3, 4, 5].map((i) => `@@photo${i}@@`);
  const sst = sstPath && zip.file(sstPath) ? parse(await zip.file(sstPath).async('string')) : null;
  const items = sst ? byLocal(sst.documentElement, 'si') : [];
  const itemText = items.map((si) => byLocal(si, 't').map((t) => t.textContent).join(''));

  // Where are the photo tokens? (a cell whose text holds @@photo…@@)
  let anchor = null;
  const sheetDocs = new Map();
  for (const sh of sheets) {
    const doc = parse(await zip.file(sh.path).async('string'));
    sheetDocs.set(sh.path, doc);
    for (const c of byLocal(doc, 'c')) {
      let text = '';
      if (c.getAttribute('t') === 's') text = itemText[Number(byLocal(c, 'v')[0]?.textContent)] || '';
      else if (c.getAttribute('t') === 'inlineStr') text = byLocal(c, 't').map((t) => t.textContent).join('');
      if (!anchor && /@@photo\d@@/i.test(text)) anchor = { sheet: sh, ref: c.getAttribute('r') };
      if (c.getAttribute('t') === 'inlineStr') {
        const is = byLocal(c, 'is')[0];
        if (is) rewriteItem(is, tokens, anchor && anchor.sheet === sh ? photoTokens : []);
      }
    }
  }
  for (const si of items) rewriteItem(si, tokens, anchor ? photoTokens : []);
  if (sst) zip.file(sstPath, serialize(sst));

  let embedded = 0;
  if (anchor && list.length) {
    const doc = sheetDocs.get(anchor.sheet.path);
    embedded = await placePhotos(zip, anchor.sheet.path, doc, anchor.ref, list);
  }
  for (const [p, doc] of sheetDocs) zip.file(p, serialize(doc));

  // Tokens the template asks for that we had no value for (left as-is, like the original app).
  const left = new Set();
  for (const t of itemText) for (const m of t.matchAll(/@@([A-Za-z_0-9]+)@@/g)) {
    if (!(m[1].toUpperCase() in tokens) && !/^photo\d$/i.test(m[1])) left.add(m[1]);
  }

  const blob = await zip.generateAsync({
    type: 'blob', compression: 'DEFLATE', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  return { blob, embedded, missingTokens: [...left] };
}

async function placePhotos(zip, sheetPath, sheetDoc, anchorRef, photos) {
  // Column widths / row heights in pixels, to turn "N pixels right of the anchor" into cell positions.
  const fmt = byLocal(sheetDoc, 'sheetFormatPr')[0];
  const defW = Number(fmt?.getAttribute('defaultColWidth') || 8.43);
  const defH = Number(fmt?.getAttribute('defaultRowHeight') || 15);
  const colW = new Map();
  for (const col of byLocal(sheetDoc, 'col')) {
    for (let i = Number(col.getAttribute('min')); i <= Math.min(Number(col.getAttribute('max')), 200); i++) colW.set(i - 1, Number(col.getAttribute('width')));
  }
  const rowH = new Map();
  for (const row of byLocal(sheetDoc, 'row')) if (row.getAttribute('ht')) rowH.set(Number(row.getAttribute('r')) - 1, Number(row.getAttribute('ht')));
  const cpx = (i) => Math.trunc((colW.has(i) ? colW.get(i) : defW) * 7 + 5);
  const rpx = (i) => Math.round((rowH.has(i) ? rowH.get(i) : defH) * 96 / 72);
  const walk = (start, offset, size) => {
    let i = start;
    let off = offset;
    while (off >= size(i) && i < start + 400) { off -= size(i); i++; }
    return { i, off };
  };

  // Find or create the drawing part for this sheet.
  const sheetRels = await relsOf(zip, sheetPath);
  let drawRel = byLocal(sheetRels.doc, 'Relationship').find((r) => r.getAttribute('Type') === T_DRAWING);
  let drawingPath;
  let drawing;
  if (drawRel) {
    drawingPath = resolve(sheetPath, drawRel.getAttribute('Target'));
    drawing = parse(await zip.file(drawingPath).async('string'));
  } else {
    let n = 1;
    while (zip.file(`xl/drawings/drawing${n}.xml`)) n++;
    drawingPath = `xl/drawings/drawing${n}.xml`;
    drawing = parse(`<xdr:wsDr xmlns:xdr="${NS.xdr}" xmlns:a="${NS.a}" xmlns:r="${NS.r}"/>`);
    const rid = addRel(sheetRels.doc, T_DRAWING, relative(sheetPath, drawingPath));
    zip.file(sheetRels.path, serialize(sheetRels.doc));
    const d = sheetDoc.createElementNS(sheetDoc.documentElement.namespaceURI, `${sheetDoc.documentElement.prefix ? sheetDoc.documentElement.prefix + ':' : ''}drawing`);
    d.setAttributeNS(NS.r, 'r:id', rid);
    // <drawing> must come after pageSetup/headerFooter etc.; appending before legacyDrawing/tableParts/extLst is good enough.
    const before = byLocal(sheetDoc.documentElement, 'legacyDrawing')[0] || byLocal(sheetDoc.documentElement, 'tableParts')[0] || byLocal(sheetDoc.documentElement, 'extLst')[0];
    sheetDoc.documentElement.insertBefore(d, before || null);
    await addOverride(zip, `/${drawingPath}`, 'application/vnd.openxmlformats-officedocument.drawing+xml');
  }
  const drawRels = await relsOf(zip, drawingPath);
  const root = drawing.documentElement;
  let nextId = Math.max(0, ...byLocal(root, 'cNvPr').map((e) => Number(e.getAttribute('id')) || 0)) + 1;
  const ac = colIndex(anchorRef);
  const ar = rowIndex(anchorRef);
  const el = (ns, name, attrs = {}, kids = []) => {
    const pfx = ns === NS.xdr ? 'xdr' : ns === NS.a ? 'a' : '';
    const e = drawing.createElementNS(ns, pfx ? `${pfx}:${name}` : name);
    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith('r:')) e.setAttributeNS(NS.r, k, v); else e.setAttribute(k, v);
    }
    for (const k of kids) e.appendChild(typeof k === 'string' ? drawing.createTextNode(k) : k);
    return e;
  };
  let placed = 0;
  for (let i = 0; i < photos.length; i++) {
    const img = await imageInfo(photos[i]);
    const scale = Math.min(PHOTO_W / img.w, PHOTO_H / img.h);
    const w = Math.max(1, Math.round(img.w * scale));
    const h = Math.max(1, Math.round(img.h * scale));
    const media = `xl/media/rma_photo_${i + 1}_${Math.random().toString(36).slice(2, 8)}.${img.ext}`;
    zip.file(media, await img.blob.arrayBuffer());
    const rid = addRel(drawRels.doc, T_IMAGE, relative(drawingPath, media));
    const x = walk(ac, (placed % PER_ROW) * (PHOTO_W + GAP) + Math.round((PHOTO_W - w) / 2), cpx);
    const y = walk(ar, 28 + Math.floor(placed / PER_ROW) * (PHOTO_H + GAP), rpx);
    const id = nextId++;
    const anchor = el(NS.xdr, 'oneCellAnchor', {}, [
      el(NS.xdr, 'from', {}, [
        el(NS.xdr, 'col', {}, [String(x.i)]), el(NS.xdr, 'colOff', {}, [String(x.off * EMU)]),
        el(NS.xdr, 'row', {}, [String(y.i)]), el(NS.xdr, 'rowOff', {}, [String(y.off * EMU)]),
      ]),
      el(NS.xdr, 'ext', { cx: String(w * EMU), cy: String(h * EMU) }),
      el(NS.xdr, 'pic', {}, [
        el(NS.xdr, 'nvPicPr', {}, [
          el(NS.xdr, 'cNvPr', { id: String(id), name: `RMA photo ${i + 1}` }),
          el(NS.xdr, 'cNvPicPr', {}, [el(NS.a, 'picLocks', { noChangeAspect: '1' })]),
        ]),
        el(NS.xdr, 'blipFill', {}, [el(NS.a, 'blip', { 'r:embed': rid }), el(NS.a, 'stretch', {}, [el(NS.a, 'fillRect')])]),
        el(NS.xdr, 'spPr', {}, [
          el(NS.a, 'xfrm', {}, [el(NS.a, 'off', { x: '0', y: '0' }), el(NS.a, 'ext', { cx: String(w * EMU), cy: String(h * EMU) })]),
          el(NS.a, 'prstGeom', { prst: 'rect' }, [el(NS.a, 'avLst')]),
        ]),
      ]),
      el(NS.xdr, 'clientData'),
    ]);
    root.appendChild(anchor);
    placed++;
    await addDefault(zip, img.ext, img.ext === 'png' ? 'image/png' : 'image/jpeg');
  }
  zip.file(drawingPath, serialize(drawing));
  zip.file(drawRels.path, serialize(drawRels.doc));
  return placed;
}

async function contentTypes(zip) {
  return parse(await zip.file('[Content_Types].xml').async('string'));
}
async function addDefault(zip, ext, type) {
  const doc = await contentTypes(zip);
  if (byLocal(doc, 'Default').some((d) => d.getAttribute('Extension').toLowerCase() === ext)) return;
  const e = doc.createElementNS(NS.ct, 'Default');
  e.setAttribute('Extension', ext);
  e.setAttribute('ContentType', type);
  doc.documentElement.insertBefore(e, doc.documentElement.firstChild);
  zip.file('[Content_Types].xml', serialize(doc));
}
async function addOverride(zip, partName, type) {
  const doc = await contentTypes(zip);
  if (byLocal(doc, 'Override').some((d) => d.getAttribute('PartName') === partName)) return;
  const e = doc.createElementNS(NS.ct, 'Override');
  e.setAttribute('PartName', partName);
  e.setAttribute('ContentType', type);
  doc.documentElement.appendChild(e);
  zip.file('[Content_Types].xml', serialize(doc));
}

export async function blobToBase64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

// ---------- Simple sheets (packing list, reports) ----------
export async function writeTable({ sheet = 'Sheet1', title, subtitle, headers, rows, widths, total }) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'TrackMyRMA';
  const ws = wb.addWorksheet(sheet.slice(0, 31));
  let r = 1;
  const last = String.fromCharCode(64 + headers.length);
  if (title) {
    ws.mergeCells(`A${r}:${last}${r}`);
    const c = ws.getCell(`A${r}`);
    c.value = title;
    c.font = { bold: true, size: 13, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };
    c.alignment = { horizontal: 'center' };
    r++;
  }
  if (subtitle) {
    ws.mergeCells(`A${r}:${last}${r}`);
    const c = ws.getCell(`A${r}`);
    c.value = subtitle;
    c.font = { size: 9, color: { argb: 'FF808080' } };
    c.alignment = { horizontal: 'center' };
    r++;
  }
  const head = ws.getRow(r);
  headers.forEach((h, i) => {
    const c = head.getCell(i + 1);
    c.value = h;
    c.font = { bold: true };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } };
    c.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  });
  ws.views = [{ state: 'frozen', ySplit: r }];
  rows.forEach((vals, i) => {
    const row = ws.getRow(r + 1 + i);
    vals.forEach((v, j) => {
      const c = row.getCell(j + 1);
      c.value = v ?? '';
      c.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
      c.alignment = { vertical: 'top', wrapText: typeof v === 'string' && v.length > 30 };
      if (i % 2 === 0) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEBF3FB' } };
    });
  });
  (widths || headers.map(() => 16)).forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  if (total) {
    const tr = r + rows.length + 2;
    ws.mergeCells(`A${tr}:${last}${tr}`);
    const c = ws.getCell(`A${tr}`);
    c.value = total;
    c.font = { bold: true };
    c.alignment = { horizontal: 'right' };
  }
  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

// ---------- Read a sheet for import ----------
function cellText(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    // Excel dates come in as UTC midnight; keep the calendar date (and time if any).
    const iso = v.toISOString();
    return iso.slice(11, 16) === '00:00' ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
  }
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((t) => t.text).join('');
    if (v.text !== undefined) return cellText(v.text);
    if (v.result !== undefined) return cellText(v.result);
    if (v.error) return '';
  }
  return String(v).trim();
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',' || ch === ';' || ch === '\t') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); rows.push(row); row = []; cur = '';
    } else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim()));
}

/** @returns {Promise<{ columns: string[], rows: Record<string,string>[], sheet: string }>} */
export async function readTable(file) {
  let grid;
  let sheet = '';
  if (/\.csv$/i.test(file.name) || file.type === 'text/csv') {
    grid = parseCsv((await file.text()).replace(/^﻿/, ''));
  } else if (/\.xlsx$/i.test(file.name)) {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await file.arrayBuffer());
    const ws = wb.worksheets.find((w) => w.actualRowCount > 0) || wb.worksheets[0];
    if (!ws) throw new Error('The workbook has no sheets.');
    sheet = ws.name;
    grid = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const vals = [];
      for (let c = 1; c <= ws.columnCount; c++) vals.push(cellText(row.getCell(c).value));
      grid.push(vals);
    });
  } else {
    throw new Error('Choose an .xlsx or .csv file. Old .xls files: open in Excel and "Save as" .xlsx first.');
  }
  if (grid.length < 2) throw new Error('The sheet needs a header row and at least one data row.');
  const seen = {};
  const columns = grid[0].map((h, i) => {
    let name = String(h || '').trim() || `Column ${i + 1}`;
    if (seen[name]) name = `${name} (${++seen[name]})`; else seen[name] = 1;
    return name;
  });
  const rows = grid.slice(1).map((vals, i) => {
    const o = { _row: i + 2 };
    columns.forEach((c, j) => { o[c] = String(vals[j] ?? '').trim(); });
    return o;
  }).filter((o) => columns.some((c) => o[c]));
  return { columns, rows, sheet };
}
