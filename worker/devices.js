// Device categories (printers, mobile terminals, …), the print-head claim limit, and RMA history per device.
import { ValidationError } from './validate.js';
import { normSn } from './company.js';

// Schema v3: categories master, category on RMAs and models, head-limit override fields.
export function migrateV3(sql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    has_head INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER)`);
  const add = (t, c, d) => { try { sql.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`); } catch { /* already there */ } };
  add('tickets', 'category_id', 'INTEGER');
  add('tickets', 'category', 'TEXT');
  add('tickets', 'head_override_reason', 'TEXT');
  add('tickets', 'head_override_by', 'TEXT');
  add('tickets', 'head_override_at', 'INTEGER');
  add('models', 'category_id', 'INTEGER');
  if (!sql.exec('SELECT COUNT(*) AS n FROM categories').one().n) {
    const now = Date.now();
    sql.exec("INSERT INTO categories (code, name, has_head, active, created_at) VALUES ('PRN', 'Printer', 1, 1, ?)", now);
    sql.exec("INSERT INTO categories (code, name, has_head, active, created_at) VALUES ('MT', 'Mobile terminal', 0, 1, ?)", now);
  }
  sql.exec("UPDATE tickets SET category_id = (SELECT id FROM categories WHERE code = 'PRN'), category = 'Printer' WHERE category_id IS NULL");
  sql.exec('CREATE INDEX IF NOT EXISTS tickets_printer_sn ON tickets(printer_sn_norm)');
}

// Schema v4: serial of the new / repaired part received back from the OEM.
export function migrateV4(sql) {
  const add = (t, c, d) => { try { sql.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`); } catch { /* already there */ } };
  add('tickets', 'received_part_sn', 'TEXT');
  add('tickets', 'received_part_sn_norm', 'TEXT');
  add('tickets', 'received_part_at', 'INTEGER');
  add('tickets', 'received_part_by', 'TEXT');
  add('tickets', 'part_sn_note', 'TEXT');
  sql.exec('CREATE INDEX IF NOT EXISTS tickets_received_sn ON tickets(received_part_sn_norm)');
}

// Stages where the part is back from the OEM, so its serial can be recorded.
export const RECEIVED_STAGES = ['GOODS_RECEIVED_FROM_OEM', 'DISPATCHED_TO_CUSTOMER', 'CLOSED', 'CLOSED_RETURNED'];

// "Head", "Print head", "TPH", "Thermal print head" … but not "Head cable" style parts that only mention it.
export function isHeadPart(part) {
  const p = String(part || '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!p) return false;
  if (/\b(cable|sensor|bracket|spring|cover|lever|connector|cleaner|pen)\b/.test(p)) return false;
  if (/\btph\b/.test(p)) return true;
  const core = p.replace(/\b(assy|assembly|unit|kit|module|replacement|new|set|dpi|mm|inch|for|the|of|and)\b/g, ' ').replace(/\s+/g, ' ').trim();
  return /^(thermal )?(print ?)?head$/.test(core);
}

export const deviceMethods = {
  defaultCategory() {
    return this.one("SELECT * FROM categories WHERE code = 'PRN'") || this.one('SELECT * FROM categories WHERE active = 1 ORDER BY id LIMIT 1');
  },
  // Fills category_id / category on an RMA being saved: chosen one, else the model's, else Printer.
  resolveCategory(v) {
    let cat = v.category_id ? this.one('SELECT * FROM categories WHERE id = ?', v.category_id) : null;
    if (!cat && v.model_id) cat = this.one('SELECT c.* FROM categories c JOIN models m ON m.category_id = c.id WHERE m.id = ?', v.model_id);
    if (!cat) cat = this.defaultCategory();
    v.category_id = cat?.id || null;
    v.category = cat?.name || null;
    return cat;
  },
  fillMissingCategories() {
    const c = this.defaultCategory();
    if (c) this.sql.exec('UPDATE tickets SET category_id = ?, category = ? WHERE category_id IS NULL', c.id, c.name);
  },

  headLimit() {
    const n = Number(this.settings().head_claim_limit);
    return Number.isFinite(n) ? Math.max(0, Math.min(20, Math.round(n))) : 2;
  },
  // Earlier print-head RMAs on this printer (any status: each one was a claim).
  headClaims(printerSnNorm, excludeId = 0) {
    if (!printerSnNorm) return [];
    return this.all(`SELECT id, ticket_no, status, faulty_part, faulty_part_sn, created_at, closed_at FROM tickets
      WHERE printer_sn_norm = ? AND id != ? ORDER BY created_at`, printerSnNorm, Number(excludeId) || 0)
      .filter((t) => isHeadPart(t.faulty_part));
  },
  // Returns null when no warning, else { limit, count, tickets }.
  headCheck({ printer_sn_norm, faulty_part, category_id, model_id }, excludeId = 0) {
    const limit = this.headLimit();
    if (!limit || !isHeadPart(faulty_part)) return null;
    const cat = this.resolveCategory({ category_id, model_id });
    if (cat && !cat.has_head) return null;
    const prior = this.headClaims(printer_sn_norm, excludeId);
    if (prior.length < limit) return null;
    return { limit, count: prior.length, tickets: prior.map((t) => ({ id: t.id, ticket_no: t.ticket_no, status: t.status, faulty_part: t.faulty_part, created_at: t.created_at })) };
  },
  // A 3rd (or limit+1) head on one printer needs a reason. Anyone raising RMAs can give it; it is saved on the RMA.
  applyHeadGate(user, v, headReason) {
    const h = this.headCheck(v);
    if (!h) return {};
    const reason = String(headReason || '').trim();
    if (!reason) {
      throw Object.assign(new Error(`Printer ${v.printer_sn} already has ${h.count} print-head RMA${h.count === 1 ? '' : 's'} (${h.tickets.map((t) => t.ticket_no).join(', ')}). The limit is ${h.limit}. Give a reason to raise another head RMA.`),
        { status: 409, extra: { code: 'head_limit', heads: h } });
    }
    return { head_override_reason: `${reason.slice(0, 500)} [${h.count} earlier head RMA${h.count === 1 ? '' : 's'}: ${h.tickets.map((t) => t.ticket_no).join(', ')}]`.slice(0, 1500),
      head_override_by: `${user.name} (${user.role})`, head_override_at: Date.now() };
  },

  // ---------- Device history ----------
  // Every RMA ever raised for one device serial, plus RMAs where that serial was the faulty part.
  deviceHistory(user, { sn }) {
    const key = normSn(sn) || '';
    if (key.replace(/[^A-Z0-9]/g, '').length < 3) throw new ValidationError({ sn: 'Enter at least 3 letters or digits of the serial' });
    const cols = `id, ticket_no, status, category, customer_company, customer_city, printer_model, printer_sn, faulty_part, faulty_part_sn,
      faulty_part_no, failure_description, tph_mileage, printer_mileage, purchase_date, created_at, created_by, oem_rma_number, oem_rma_assign_date,
      oem_dispatch_date, batch_code, goods_received_date, received_part_sn, received_part_at, received_part_by, dispatch_to_customer_date, challan_number,
      closed_at, closure_type, closure_remarks, dup_reason, head_override_reason, part_sn_note`;
    // Match the cleaned serial, or the same letters and digits ignoring - / . (people type "H1001" for "H-1001").
    const alnum = key.replace(/[^A-Z0-9]/g, '');
    const bare = (c) => `REPLACE(REPLACE(REPLACE(REPLACE(${c}, '-', ''), '/', ''), '.', ''), '_', '')`;
    const tickets = this.all(`SELECT ${cols} FROM tickets WHERE printer_sn_norm = ? OR ${bare('printer_sn_norm')} = ? ORDER BY created_at`, key, alnum);
    const own = new Set(tickets.map((t) => t.id));
    const asPart = this.all(`SELECT ${cols} FROM tickets WHERE faulty_part_sn_norm = ? OR ${bare('faulty_part_sn_norm')} = ?
      OR received_part_sn_norm = ? OR ${bare('received_part_sn_norm')} = ? ORDER BY created_at`, key, alnum, key, alnum)
      .filter((t) => !own.has(t.id))
      .map((t) => ({ ...t, role: normSn(t.received_part_sn || '')?.replace(/[^A-Z0-9]/g, '') === alnum ? 'received' : 'faulty' }));
    let cover = null;
    try { cover = this.cpFindSerial(user, { sn: key, loose: false }).device || null; } catch { /* care packs off */ }
    const parts = {};
    for (const t of tickets) {
      const p = String(t.faulty_part || 'Not set').trim();
      parts[p] = (parts[p] || 0) + 1;
    }
    const days = (t) => (t.closed_at ? Math.round((t.closed_at - t.created_at) / 86400000) : null);
    const closed = tickets.filter((t) => t.closed_at);
    return {
      serial: tickets[0]?.printer_sn || asPart[0]?.faulty_part_sn || key,
      summary: {
        total: tickets.length,
        open: tickets.filter((t) => !t.closed_at).length,
        heads: tickets.filter((t) => isHeadPart(t.faulty_part)).length,
        headLimit: this.headLimit(),
        first: tickets[0]?.created_at || null,
        last: tickets[tickets.length - 1]?.created_at || null,
        avgDays: closed.length ? Math.round(closed.reduce((a, t) => a + days(t), 0) / closed.length) : null,
        models: [...new Set(tickets.map((t) => t.printer_model).filter(Boolean))],
        customers: [...new Set(tickets.map((t) => t.customer_company).filter(Boolean))],
        categories: [...new Set(tickets.map((t) => t.category).filter(Boolean))],
        missingReceived: tickets.filter((t) => RECEIVED_STAGES.includes(t.status) && !t.received_part_sn).length,
        // The head now in the printer: the last head received back from the OEM for it.
        currentHead: [...tickets].reverse().find((t) => isHeadPart(t.faulty_part) && t.received_part_sn) || null,
        parts: Object.entries(parts).sort((a, b) => b[1] - a[1]).map(([part, n]) => ({ part, n })),
      },
      tickets: tickets.map((t) => ({ ...t, days: days(t), head: isHeadPart(t.faulty_part), canReceive: RECEIVED_STAGES.includes(t.status) })),
      asPart,
      cover,
    };
  },
  // The part now fitted in this printer: the last one of the same kind received back from the OEM.
  // A new RMA for that part should carry that serial; returns { last, entered, match }.
  lastPartCheck({ printer_sn_norm, faulty_part, faulty_part_sn }, excludeId = 0) {
    if (!printer_sn_norm || !faulty_part) return null;
    const head = isHeadPart(faulty_part);
    const key = String(faulty_part).toLowerCase().replace(/[^a-z0-9]/g, '');
    const prev = this.all(`SELECT id, ticket_no, status, faulty_part, faulty_part_sn, received_part_sn, received_part_sn_norm, received_part_at, goods_received_date
      FROM tickets WHERE printer_sn_norm = ? AND id != ? AND received_part_sn_norm IS NOT NULL ORDER BY COALESCE(received_part_at, created_at) DESC LIMIT 50`,
      printer_sn_norm, Number(excludeId) || 0)
      .find((t) => (head ? isHeadPart(t.faulty_part) : String(t.faulty_part || '').toLowerCase().replace(/[^a-z0-9]/g, '') === key));
    if (!prev) return null;
    const bare = (x) => String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const entered = normSn(faulty_part_sn) || '';
    return { last: { id: prev.id, ticket_no: prev.ticket_no, faulty_part: prev.faulty_part, received_part_sn: prev.received_part_sn, goods_received_date: prev.goods_received_date },
      entered, match: entered ? bare(entered) === bare(prev.received_part_sn) : null };
  },
  // Faulty part serial differs from the one last received for this printer: ask why (saved on the RMA).
  applyPartSerialGate(v, partSnNote, excludeId = 0) {
    const c = this.lastPartCheck(v, excludeId);
    if (!c || c.match !== false) return {};
    const note = String(partSnNote || '').trim();
    if (!note) {
      throw Object.assign(new Error(`The last ${c.last.faulty_part} received from the OEM for printer ${v.printer_sn} (on ${c.last.ticket_no}) was serial ${c.last.received_part_sn}, but this RMA says ${c.entered}. Check the part, or give a reason.`),
        { status: 409, extra: { code: 'part_serial_mismatch', partCheck: c } });
    }
    return { part_sn_note: `${note.slice(0, 500)} [expected ${c.last.received_part_sn} from ${c.last.ticket_no}, entered ${c.entered}]` };
  },

  // Record or correct the serial of the part received back from the OEM (after "Goods received").
  setReceivedPart(user, { id, received_part_sn }) {
    const t = this.one('SELECT id, ticket_no, status, received_part_sn FROM tickets WHERE id = ?', Number(id));
    if (!t) throw Object.assign(new Error('RMA not found'), { status: 404 });
    if (!RECEIVED_STAGES.includes(t.status)) throw new ValidationError({ received_part_sn: 'Mark the goods as received from the OEM first' });
    const sn = String(received_part_sn || '').trim().replace(/\s+/g, '').toUpperCase().slice(0, 100);
    if (!sn) throw new ValidationError({ received_part_sn: 'Enter the serial number of the part received from the OEM' });
    if (sn === (t.received_part_sn || '')) return { ticket: this.one('SELECT * FROM tickets WHERE id = ?', t.id) };
    const now = Date.now();
    this.sql.exec('UPDATE tickets SET received_part_sn = ?, received_part_sn_norm = ?, received_part_at = ?, received_part_by = ?, updated_at = ?, updated_by = ? WHERE id = ?',
      sn, normSn(sn), now, user.name, now, user.name, t.id);
    this.event(t.id, user, t.received_part_sn ? `Received part serial changed: ${t.received_part_sn} → ${sn}` : `Received part serial: ${sn}`, null);
    return { ticket: this.one('SELECT * FROM tickets WHERE id = ?', t.id) };
  },

  // Serials for the device search box: from RMAs and the care pack registry.
  searchDevices(user, { q }) {
    const key = (normSn(q) || '').replace(/[%_]/g, '');
    if (key.replace(/[^A-Z0-9]/g, '').length < 3) return [];
    const like = `%${key}%`;
    const rows = this.all(`SELECT printer_sn AS serial, MAX(printer_model) AS model, MAX(customer_company) AS customer, MAX(category) AS category,
      COUNT(*) AS rmas, MAX(created_at) AS last FROM tickets WHERE printer_sn_norm LIKE ? GROUP BY printer_sn_norm ORDER BY last DESC LIMIT 30`, like);
    const seen = new Set(rows.map((r) => String(r.serial).toUpperCase()));
    let cp = [];
    try {
      cp = this.all(`SELECT d.serial_number AS serial, d.original_model AS model, b.customer_name AS customer FROM cp_devices d
        JOIN cp_batches b ON b.id = d.batch_id WHERE UPPER(REPLACE(d.serial_number, ' ', '')) LIKE ? LIMIT 30`, like)
        .filter((r) => !seen.has(String(r.serial).toUpperCase())).map((r) => ({ ...r, rmas: 0, last: null, category: null }));
    } catch { /* care packs off */ }
    return [...rows, ...cp].slice(0, 30);
  },
};
