// Care Pack module for the Company Durable Object (mixed into its prototype).
// Ported from CarePackService.cs with every UI-only check also enforced here.
import {
  BRANDS, CARE_PACK_TYPES, addDays, addYears, analyzeMismatch, buildLineSets, cleanSerial, crossValidate, daysUntil,
  detectBrandFromModel, detectDurationYears, eqCI, fmtDMY, serialsFromAnything,
} from './catalog.js';
import { Checker, ValidationError, today } from './validate.js';
import { encryptSecret, decryptSecret } from './crypto.js';
import { Zoho } from './zoho.js';

const err = (status, message, extra = {}) => Object.assign(new Error(message), { status, extra });
const blank = (s) => s === null || s === undefined || String(s).trim() === '';
const nz = (s) => (blank(s) ? null : String(s).trim());
const isAdmin = (u) => u.role === 'Admin';
const canImport = (u) => ['Admin', 'Manager'].includes(u.role);
const canEdit = (u) => ['Admin', 'Manager', 'Technician'].includes(u.role);
const STATUS_LABEL = { IMPORTED: 'Imported', PO_VALIDATED: 'PO Validated', COMPLETE: '100% Verified' };
const PDF_ID = (id) => `cp-oem-${id}`;
export const CP_DEFAULTS = {
  invoice_prefix: 'IS-GST-2627-',
  carepack_po_deadline_days: '25',
  carepack_oem_payment_deadline_days: '40',
  zoho_dc: 'in',
  zoho_org_id: '',
  zoho_client_id: '',
  challan_enabled: '1',
  challan_auto_dispatch: '1',
  challan_line_description: 'RMA replacement — {{PRINTER_MODEL}} S/N {{PRINTER_SERIAL}} — {{FAULTY_PART}} {{FAULTY_PART_SERIAL}} (OEM RMA {{OEM_RMA}})',
  challan_notes: 'Returned against RMA {{INTERNAL_TICKET}}. Not for sale.',
};

export function migrateCarePack(sql) {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS cp_types (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      duration_years INTEGER NOT NULL DEFAULT 5, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER);
    CREATE TABLE IF NOT EXISTS cp_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_number TEXT NOT NULL COLLATE NOCASE, line_set_index INTEGER NOT NULL DEFAULT 1,
      source TEXT NOT NULL DEFAULT 'manual', source_invoice_number TEXT, zoho_invoice_id TEXT,
      customer_id INTEGER, customer_name TEXT COLLATE NOCASE, customer_city TEXT, invoice_date TEXT,
      irn TEXT, irn_ack_no TEXT, irn_ack_date TEXT,
      oem_id INTEGER, product_id INTEGER, model_id INTEGER, cp_type_id INTEGER,
      oem_brand TEXT, care_pack_type TEXT, printer_model TEXT, duration_years INTEGER,
      printer_item_name TEXT, invoice_item_name TEXT, invoice_description TEXT, invoice_brand_detected TEXT,
      invoice_qty INTEGER NOT NULL DEFAULT 0, device_count INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'IMPORTED',
      po_number TEXT COLLATE NOCASE, zoho_po_id TEXT, po_validated_at INTEGER, po_validated_by TEXT, po_matched INTEGER NOT NULL DEFAULT 0,
      po_notes TEXT, po_serials TEXT, po_vendor TEXT, po_date TEXT, po_source TEXT,
      oem_invoice_number TEXT, oem_invoice_date TEXT, installation_date TEXT, oem_amount REAL, oem_currency TEXT DEFAULT 'USD',
      oem_paid INTEGER NOT NULL DEFAULT 0, oem_paid_at INTEGER, oem_paid_by TEXT,
      oem_pdf_name TEXT, oem_pdf_size INTEGER, verified INTEGER NOT NULL DEFAULT 0, verified_at INTEGER, verified_by TEXT,
      overridden INTEGER NOT NULL DEFAULT 0, notes TEXT, created_at INTEGER NOT NULL, created_by TEXT,
      UNIQUE (invoice_number, line_set_index)
    );
    CREATE INDEX IF NOT EXISTS cp_batches_created ON cp_batches(created_at);
    CREATE INDEX IF NOT EXISTS cp_batches_po ON cp_batches(po_number);
    CREATE TABLE IF NOT EXISTS cp_devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id INTEGER NOT NULL, model_id INTEGER, serial_number TEXT NOT NULL COLLATE NOCASE,
      oem_brand TEXT, care_pack_type TEXT, original_model TEXT, warranty_end TEXT,
      overridden INTEGER NOT NULL DEFAULT 0, override_by TEXT, override_at INTEGER, override_reason TEXT, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS cp_devices_serial ON cp_devices(serial_number);
    CREATE INDEX IF NOT EXISTS cp_devices_batch ON cp_devices(batch_id);
    CREATE TABLE IF NOT EXISTS cp_doc_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id INTEGER NOT NULL, invoice_number TEXT,
      action TEXT NOT NULL, snapshot TEXT NOT NULL, reason TEXT NOT NULL, by_name TEXT, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS cp_drafts (user_id TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, saved_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, kind));
  `);
  const now = Date.now();
  for (const [name, y] of [['1 Year', 1], ['2 Year', 2], ['3 Year', 3], ['4 Year', 4], ['5 Year', 5], ['Comprehensive Care Pack', 5]]) {
    sql.exec('INSERT OR IGNORE INTO cp_types (name, duration_years, created_at) VALUES (?,?,?)', name, y, now);
  }
}

export const carePackMethods = {
  // ---------- settings + years ----------
  cpSettings() {
    const s = this.settings();
    return {
      ...Object.fromEntries(Object.keys(CP_DEFAULTS).map((k) => [k, s[k] ?? CP_DEFAULTS[k]])),
      zoho_connected: !!this.one("SELECT value FROM meta WHERE key = 'zoho:refresh'")?.value,
      zoho_secret_set: !!this.one("SELECT value FROM meta WHERE key = 'zoho:secret'")?.value,
    };
  },
  limits() {
    const s = this.settings();
    const po = Number(s.carepack_po_deadline_days);
    const pay = Number(s.carepack_oem_payment_deadline_days);
    return { po: po > 0 ? po : 25, pay: pay > 0 ? pay : 40 };
  },
  // Years for a care pack type: the master's duration (deliberate fix), else digits in the name, else 5.
  yearsFor(type, explicit) {
    if (explicit >= 1 && explicit <= 10) return Number(explicit);
    const t = blank(type) ? null : this.one('SELECT duration_years FROM cp_types WHERE name = ?', String(type).trim());
    return t?.duration_years || detectDurationYears(type) || 5;
  },
  ensureNotExpired(end, inv, invoiceDate, type, years) {
    if (!end) throw err(422, `Cannot import ${inv}: invoice date is missing, so warranty end cannot be verified. Enter a valid sales invoice date and try again.`);
    if (end < today()) {
      throw err(422, `Cannot import ${inv}: care pack warranty already ended on ${fmtDMY(end)} (invoice ${fmtDMY(invoiceDate)} + ${years} year(s) from ${type || 'care pack'}). Expired care packs must not be registered.`);
    }
  },

  // ---------- serial look-ups (also used by RMA) ----------
  cpDeviceRow(d) {
    return d && {
      device_id: d.id, batch_id: d.batch_id, serial_number: d.serial_number, invoice_number: d.invoice_number, customer_name: d.customer_name,
      customer_city: d.customer_city, oem_brand: d.oem_brand || d.b_brand, printer_model: d.original_model || d.b_model,
      care_pack_type: d.care_pack_type || d.b_type, warranty_end: d.warranty_end, invoice_date: d.invoice_date,
      oem_invoice_number: d.oem_invoice_number, overridden: !!d.overridden, expired: !!(d.warranty_end && d.warranty_end < today()),
    };
  },
  cpDeviceSelect() {
    return `SELECT d.*, b.invoice_number, b.customer_name, b.customer_city, b.invoice_date, b.oem_invoice_number,
      b.oem_brand AS b_brand, b.printer_model AS b_model, b.care_pack_type AS b_type FROM cp_devices d JOIN cp_batches b ON b.id = d.batch_id`;
  },
  // Exact match first; the loose "contains" fallback only helps people find a serial for an RMA.
  cpFindSerial(user, { sn, loose = true }) {
    const c = cleanSerial(sn);
    if (!c) return { device: null };
    let d = this.one(`${this.cpDeviceSelect()} WHERE d.serial_number = ? OR d.serial_number = ? LIMIT 1`, c, String(sn).trim());
    if (!d && loose && c.length >= 4) d = this.one(`${this.cpDeviceSelect()} WHERE d.serial_number LIKE ? ORDER BY length(d.serial_number) LIMIT 1`, `%${c}%`);
    return { device: this.cpDeviceRow(d) };
  },
  cpEnsureEligible(serial) {
    const { device } = this.cpFindSerial(null, { sn: serial, loose: false });
    if (device?.expired) throw err(409, `RMA blocked: care pack / warranty for serial ${device.serial_number} ended on ${fmtDMY(device.warranty_end)}. Expired cover cannot start a new RMA.`);
    return device;
  },
  cpCustomers(user, { q = '' } = {}) {
    return this.all(`SELECT customer_name AS name, COUNT(*) AS invoices FROM cp_batches WHERE customer_name IS NOT NULL AND customer_name != ''
      ${q ? 'AND customer_name LIKE ?' : ''} GROUP BY customer_name ORDER BY customer_name LIMIT 200`, ...(q ? [`%${q}%`] : [])).map((r) => r.name);
  },
  cpSerials(user, { customer = '', q = '', take = 200 } = {}) {
    const where = [];
    const args = [];
    if (customer) { where.push('b.customer_name = ?'); args.push(customer); }
    if (q) {
      where.push(`(d.serial_number LIKE ? OR b.invoice_number LIKE ? OR b.printer_model LIKE ? OR d.original_model LIKE ?${customer ? '' : ' OR b.customer_name LIKE ?'})`);
      const s = `%${q}%`;
      args.push(s, s, s, s);
      if (!customer) args.push(s);
    }
    return this.all(`${this.cpDeviceSelect()} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY d.serial_number LIMIT ?`,
      ...args, Math.min(Math.max(Number(take) || 200, 1), 500)).map((d) => this.cpDeviceRow(d));
  },

  // Adds a serial missing from the registry while raising an RMA (with reason).
  cpAddOverrideSerial(user, { serial, reason, batchId, customer, model }) {
    if (!canEdit(user)) throw err(403, 'Your role cannot add care pack serials.');
    const sn = cleanSerial(serial);
    if (!sn) throw new ValidationError({ printer_sn: 'Serial number is required.' });
    const existing = this.one('SELECT id FROM cp_devices WHERE serial_number = ?', sn);
    if (existing) return existing.id;
    if (blank(reason)) throw err(422, 'Override reason is required when adding a new serial.');
    const now = Date.now();
    let b;
    if (batchId) {
      b = this.one('SELECT * FROM cp_batches WHERE id = ?', Number(batchId));
      if (!b) throw err(404, 'Selected care pack invoice not found.');
    } else {
      const inv = `RMA-ADD-${today().replace(/-/g, '')}`;
      b = this.one('SELECT * FROM cp_batches WHERE invoice_number = ? AND line_set_index = 1', inv);
      if (!b) {
        this.sql.exec(`INSERT INTO cp_batches (invoice_number, line_set_index, source, customer_name, printer_model, care_pack_type, printer_item_name,
          invoice_item_name, invoice_description, status, overridden, created_at, created_by) VALUES (?,1,'rma',?,?,?,?,?,?, 'IMPORTED', 1, ?, ?)`,
        inv, nz(customer), nz(model), 'Comprehensive Care Pack', 'Added from RMA (override)', 'RMA override serial',
        '[Added from RMA ticket — not from Zoho import]', now, user.name);
        b = this.one('SELECT * FROM cp_batches WHERE id = last_insert_rowid()');
      }
    }
    const years = this.yearsFor(b.care_pack_type, b.duration_years);
    const end = addYears(b.invoice_date || today(), years);
    this.sql.exec(`INSERT INTO cp_devices (batch_id, serial_number, oem_brand, care_pack_type, original_model, warranty_end, overridden,
      override_by, override_at, override_reason, created_at) VALUES (?,?,?,?,?,?,1,?,?,?,?)`,
    b.id, sn, b.oem_brand, b.care_pack_type, nz(model) || b.printer_model, end, user.name, now, String(reason).trim().slice(0, 1000), now);
    const n = this.one('SELECT COUNT(*) AS n FROM cp_devices WHERE batch_id = ?', b.id).n;
    this.sql.exec('UPDATE cp_batches SET device_count = ?, invoice_qty = MAX(invoice_qty, ?), overridden = 1 WHERE id = ?', n, n, b.id);
    this.audit(user, 'cp_add_from_rma', 'carepack', b.id, { serial: sn });
    return this.one('SELECT last_insert_rowid() AS id').id;
  },

  // ---------- registry list ----------
  cpList(user, { q = '' } = {}) {
    const s = `%${String(q).trim().slice(0, 100)}%`;
    const where = q ? `WHERE b.invoice_number LIKE ?1 OR b.customer_name LIKE ?1 OR b.printer_item_name LIKE ?1 OR b.invoice_item_name LIKE ?1
      OR b.printer_model LIKE ?1 OR b.oem_brand LIKE ?1 OR b.oem_invoice_number LIKE ?1 OR b.care_pack_type LIKE ?1 OR b.po_number LIKE ?1
      OR EXISTS (SELECT 1 FROM cp_devices d WHERE d.batch_id = b.id AND (d.serial_number LIKE ?1 OR d.original_model LIKE ?1))` : '';
    const rows = this.all(`SELECT b.id, b.invoice_number, b.line_set_index, b.customer_name, b.oem_brand, b.printer_model, b.care_pack_type,
      b.device_count, b.invoice_qty, b.po_number, b.oem_invoice_number, b.oem_pdf_name IS NOT NULL AS has_pdf, b.verified, b.status,
      b.created_at, b.overridden, b.invoice_date, b.oem_paid, b.duration_years,
      (SELECT MAX(warranty_end) FROM cp_devices d WHERE d.batch_id = b.id) AS max_end
      FROM cp_batches b ${where} ORDER BY b.created_at DESC LIMIT 2000`, ...(q ? [s] : []));
    const t = today();
    return {
      total: this.one('SELECT COUNT(*) AS n FROM cp_batches').n,
      rows: rows.map((r) => {
        const end = r.max_end || (r.invoice_date ? addYears(r.invoice_date, this.yearsFor(r.care_pack_type, r.duration_years)) : null);
        return { ...r, has_pdf: !!r.has_pdf, status_label: STATUS_LABEL[r.status] || r.status, warranty_end: end, expired: !!(end && end < t) };
      }),
    };
  },
  cpRegistry(user, { q = '' } = {}) {
    const rows = this.all(`SELECT b.invoice_number, b.customer_name, COALESCE(b.printer_item_name, b.invoice_item_name, b.printer_model, '') AS product,
      COALESCE(d.original_model, b.printer_model) AS model, b.oem_invoice_number, d.serial_number, COALESCE(d.care_pack_type, b.care_pack_type) AS length,
      d.warranty_end FROM cp_batches b LEFT JOIN cp_devices d ON d.batch_id = b.id ORDER BY b.created_at DESC, d.serial_number LIMIT 20000`);
    const t = today();
    const qq = String(q).trim().toLowerCase();
    return rows.filter((r) => !qq || Object.values(r).some((v) => String(v ?? '').toLowerCase().includes(qq)))
      .map((r) => ({ ...r, expired: !!(r.warranty_end && r.warranty_end < t) }));
  },

  // ---------- one batch ----------
  cpBatch(id) {
    const b = this.one('SELECT * FROM cp_batches WHERE id = ?', Number(id));
    if (!b) throw err(404, 'Care pack batch not found.');
    return b;
  },
  canEditDevices(b) {
    return blank(b.po_number) && b.status === 'IMPORTED' && !b.po_matched && !b.po_validated_at;
  },
  cpDeleteCheck(b) {
    if (!blank(b.po_number) || !blank(b.zoho_po_id)) return 'Cannot delete — OEM PO is linked to this invoice.';
    if (b.status !== 'IMPORTED') return `Cannot delete — status is ${STATUS_LABEL[b.status]} (chain started).`;
    if (b.po_validated_at || b.po_matched) return 'Cannot delete — PO validation already recorded.';
    if (!blank(b.oem_invoice_number) || b.oem_invoice_date) return 'Cannot delete — OEM invoice details are entered.';
    if (b.oem_pdf_name) return 'Cannot delete — OEM invoice PDF is stored.';
    if (b.verified) return 'Cannot delete — batch is 100% verified.';
    if (b.installation_date) return 'Cannot delete — installation date is set.';
    const rmas = this.all(`SELECT DISTINCT t.ticket_no FROM tickets t JOIN cp_devices d ON d.serial_number = t.printer_sn_norm
      WHERE d.batch_id = ? LIMIT 5`, b.id).map((r) => r.ticket_no);
    if (rmas.length) return `Cannot delete — device SN(s) linked to RMA: ${rmas.join(', ')}`;
    return null;
  },
  docGates(b) {
    const hasPay = !!b.oem_paid;
    const hasInv = !blank(b.oem_invoice_number) || !!b.oem_invoice_date || b.oem_amount !== null || !!b.oem_pdf_name;
    const hasPo = !blank(b.po_number) || !blank(b.zoho_po_id) || !!b.po_validated_at || !!b.po_matched;
    return {
      payment: hasPay ? { ok: true, reason: 'Admin can remove OEM payment from this invoice.' } : { ok: false, reason: 'No OEM payment to remove (not marked paid).' },
      invoice: hasPay ? { ok: false, reason: 'Cannot remove OEM invoice — OEM payment is still recorded. Remove payment first.' }
        : hasInv ? { ok: true, reason: 'Admin can remove OEM invoice from this invoice.' } : { ok: false, reason: 'No OEM invoice details to remove.' },
      po: hasPay ? { ok: false, reason: 'Cannot remove PO — OEM payment is still recorded. Remove payment, then OEM invoice, then PO.' }
        : hasInv ? { ok: false, reason: 'Cannot remove PO — OEM invoice is still linked. Remove OEM invoice first.' }
          : hasPo ? { ok: true, reason: 'Admin can remove the OEM PO from this invoice.' } : { ok: false, reason: 'No OEM PO linked to this invoice.' },
    };
  },
  cpGet(user, { id }) {
    const b = this.cpBatch(id);
    const devices = this.all('SELECT * FROM cp_devices WHERE batch_id = ? ORDER BY serial_number', b.id);
    const t = today();
    const lim = this.limits();
    const end = devices.reduce((m, d) => (d.warranty_end && (!m || d.warranty_end > m) ? d.warranty_end : m), null)
      || (b.invoice_date ? addYears(b.invoice_date, this.yearsFor(b.care_pack_type, b.duration_years)) : null);
    const rmas = this.all(`SELECT t.id, t.ticket_no, t.status, t.printer_sn, t.faulty_part FROM tickets t
      JOIN cp_devices d ON d.serial_number = t.printer_sn_norm WHERE d.batch_id = ? ORDER BY t.created_at DESC LIMIT 50`, b.id);
    const del = this.cpDeleteCheck(b);
    const poDue = b.invoice_date ? addDays(b.invoice_date, lim.po) : null;
    const payDue = b.oem_invoice_date ? addDays(b.oem_invoice_date, lim.pay) : null;
    return {
      batch: { ...b, status_label: STATUS_LABEL[b.status], po_serials: b.po_serials ? JSON.parse(b.po_serials) : [], warranty_end: end, expired: !!(end && end < t),
        po_due: blank(b.po_number) ? poDue : null, po_days: blank(b.po_number) && poDue ? daysUntil(poDue, t) : null,
        pay_due: !b.oem_paid ? payDue : null, pay_days: !b.oem_paid && payDue ? daysUntil(payDue, t) : null },
      devices: devices.map((d) => ({ ...d, expired: !!(d.warranty_end && d.warranty_end < t) })),
      audits: this.all('SELECT * FROM cp_doc_audit WHERE batch_id = ? ORDER BY at DESC', b.id),
      rmas,
      canEditDevices: canEdit(user) && this.canEditDevices(b),
      deleteHint: del || 'Safe to delete — no PO / OEM / RMA links.', canDelete: isAdmin(user) && !del,
      gates: this.docGates(b),
      sample: devices.find((d) => d.overridden) || devices[0] || null,
    };
  },

  // ---------- duplicates ----------
  ensureNoDuplicateSerials(serials, excludeBatchId = 0) {
    const counts = new Map();
    for (const s of serials) counts.set(s, (counts.get(s) || 0) + 1);
    const twice = [...counts].filter(([, n]) => n > 1).map(([s]) => s).slice(0, 5);
    if (twice.length) throw err(409, `Duplicate blocked: the same product serial is entered more than once in this registration: ${twice.join(', ')}`);
    const clashes = [];
    for (let i = 0; i < serials.length && clashes.length < 5; i += 50) {
      const chunk = serials.slice(i, i + 50);
      clashes.push(...this.all(`SELECT d.serial_number, b.invoice_number FROM cp_devices d JOIN cp_batches b ON b.id = d.batch_id
        WHERE d.batch_id != ? AND d.serial_number IN (${chunk.map(() => '?').join(',')}) LIMIT 5`, excludeBatchId, ...chunk));
    }
    if (clashes.length) {
      throw err(409, `Duplicate blocked: product serial number(s) already registered in Care Packs: ${clashes.slice(0, 5)
        .map((c) => `${c.serial_number} (invoice ${c.invoice_number})`).join('; ')}. Each serial can only be registered once.`);
    }
  },

  // ---------- register (manual, PDF prefill, or Zoho prefill — one path) ----------
  async cpRegister(user, p) {
    if (!canImport(user)) throw err(403, 'Your role cannot register care pack invoices.');
    const h = new Checker(p).text('invoice_number', { required: true, max: 50, label: 'Invoice number' })
      .text('source_invoice_number', { max: 50 }).text('customer_name', { max: 200, label: 'Customer' }).text('customer_city', { max: 100, label: 'City' })
      .date('invoice_date', { required: true, label: 'Sales invoice date', notFuture: true }).text('irn', { max: 128, label: 'IRN' })
      .text('irn_ack_no', { max: 50, label: 'Ack no.' }).text('irn_ack_date', { max: 30 }).text('notes', { max: 2000, label: 'Notes' })
      .text('edit_reason', { max: 1000, label: 'Reason' }).int('customer_id').bool('admin_override').bool('override_confirmed').done();
    const products = Array.isArray(p.products) ? p.products.slice(0, 50) : [];
    if (!products.length) throw new ValidationError({ _: 'Add at least one product with serial numbers.' });
    const source = p.source === 'zoho' ? 'zoho' : p.source === 'pdf' ? 'pdf' : 'manual';
    const inv = h.invoice_number;
    const srcInv = h.source_invoice_number || inv;
    const invoiceChanged = !eqCI(srcInv, inv);
    const reason = h.edit_reason;

    // Zoho: re-read the invoice here (never trust what the browser sends as "source").
    let zoho = null;
    if (source === 'zoho') {
      zoho = await this.cpZohoInvoice(srcInv);
      if (!zoho) throw err(404, `Invoice '${srcInv}' not found in Zoho Books.`);
    }
    const irn = h.irn || zoho?.irn || null;
    if (invoiceChanged && irn && blank(reason)) throw err(422, 'Invoice number was changed on an IRN invoice. Enter an edit/override reason before register.', { field: 'edit_reason' });
    if (h.admin_override && !isAdmin(user)) throw err(403, 'Only Admin can apply a formal override.');
    if (h.admin_override && (blank(reason) || !h.override_confirmed)) throw err(422, 'Admin override needs a reason and the confirmation tick.');

    // Same invoice: a manual/PDF register may not add to an invoice already in the registry; Zoho may add the sets not yet imported.
    const existingSets = this.all('SELECT line_set_index FROM cp_batches WHERE invoice_number = ?', inv).map((r) => r.line_set_index);
    if (existingSets.length && source !== 'zoho') {
      throw err(409, `Duplicate blocked: invoice ${inv} already exists in Care Packs. Open the existing record — do not register the same invoice again.`);
    }
    const used = new Set(existingSets);
    let next = 1;
    const plan = [];
    const fieldErrs = {};
    products.forEach((raw, i) => {
      const v = new Checker(raw).text('printer_item_name', { max: 200 }).text('care_pack_item_name', { max: 200 }).text('printer_model', { max: 100 })
        .text('oem_brand', { max: 50 }).text('care_pack_type', { max: 50 }).int('qty').int('line_set_index').int('oem_id').int('product_id')
        .int('model_id').int('cp_type_id').text('edit_reason', { max: 1000 }).bool('added').done();
      const serials = serialsFromAnything(raw.serial_text, Array.isArray(raw.serials) ? raw.serials : []);
      const qty = v.qty || serials.length;
      if (!serials.length) fieldErrs[`p${i}_serials`] = 'Enter at least one product serial number.';
      else if (qty !== serials.length) fieldErrs[`p${i}_serials`] = `Product qty is ${qty} but ${serials.length} serial(s) entered. Enter one serial per unit.`;
      if (blank(v.care_pack_type)) fieldErrs[`p${i}_care_pack_type`] = 'Care pack length is required for each product.';
      if (blank(v.printer_model)) fieldErrs[`p${i}_printer_model`] = 'Product model is required.';
      if (blank(v.oem_brand)) fieldErrs[`p${i}_oem_brand`] = 'OEM brand is required.';
      let idx = v.line_set_index;
      if (!idx || (source !== 'zoho' && used.has(idx))) { while (used.has(next)) next++; idx = next; }
      if (used.has(idx)) throw err(409, `Duplicate blocked: invoice ${inv} (product set #${idx}) already exists in Care Packs. Open the existing record — do not register again.`);
      used.add(idx);
      plan.push({ ...v, serials, qty, idx, index: i });
    });
    if (Object.keys(fieldErrs).length) throw new ValidationError(fieldErrs);
    this.ensureNoDuplicateSerials(plan.flatMap((x) => x.serials));

    const now = Date.now();
    const rows = plan.map((x) => {
      // Compare with what the source invoice said for this set (Zoho), to decide override + reason.
      const src = zoho?.sets.find((s) => s.setIndex === x.idx && !x.added) || null;
      const text = src ? src.description : [x.printer_item_name, x.care_pack_item_name].filter(Boolean).join('\n');
      const mm = src ? src.mismatch : analyzeMismatch(x.care_pack_item_name || x.printer_item_name, text);
      const edited = src && (!eqCI(x.oem_brand, src.oemBrand) || !eqCI(x.printer_model, src.printerModel) || (!blank(x.printer_item_name) && !eqCI(x.printer_item_name, src.printerItemName)));
      if ((edited || invoiceChanged) && irn && blank(x.edit_reason) && blank(reason)) {
        throw err(422, `Product set #${x.idx}: values differ from Zoho/IRN source. Enter an edit reason.`);
      }
      // Registering a brand that contradicts the model (e.g. Printronix care pack on a TSC TE310) needs an Admin override.
      const modelBrand = detectBrandFromModel(x.printer_model);
      const contradiction = modelBrand && !eqCI(modelBrand, x.oem_brand);
      if (contradiction && !h.admin_override) {
        throw err(422, `Product set #${x.idx}: ${x.oem_brand} is selected but ${x.printer_model} is a ${modelBrand} model. Correct the brand or model, or ask an Admin to override with a reason.`);
      }
      if (mm.hasMismatch && !(edited || h.admin_override || !blank(x.edit_reason) || !blank(reason))) {
        throw err(422, `Brand mismatch detected on product set #${x.idx}: ${mm.message}. Correct OEM / model with an edit reason, or Admin Override.`);
      }
      const years = this.yearsFor(x.care_pack_type, x.cp_type_id ? this.one('SELECT duration_years FROM cp_types WHERE id = ?', x.cp_type_id)?.duration_years : null);
      const end = addYears(h.invoice_date, years);
      this.ensureNotExpired(end, inv, h.invoice_date, x.care_pack_type, years);
      const overridden = !!(h.admin_override || invoiceChanged || edited || mm.hasMismatch || x.added && source === 'zoho' || !blank(x.edit_reason));
      const why = [x.edit_reason, reason].find((r) => !blank(r)) || (overridden ? (source === 'manual' ? 'Manual entry (Zoho unavailable)' : 'Edited on import') : null);
      return { x, src, mm, years, end, overridden, why };
    });

    const ids = [];
    this.ctx.storage.transactionSync(() => {
      for (const { x, src, mm, years, end, overridden, why } of rows) {
        const notes = [h.notes, x.added && '[Added product on import draft]', invoiceChanged && `Source invoice: ${srcInv}`, !blank(reason) && `Edit reason: ${reason}`]
          .filter(Boolean).join('\n') || null;
        const desc = src ? src.description : `[${source === 'pdf' ? 'From PDF' : 'Manual entry'} — no Zoho]\nProduct: ${x.printer_item_name || ''}\nCare pack: ${x.care_pack_item_name || ''}`;
        this.sql.exec(`INSERT INTO cp_batches (invoice_number, line_set_index, source, source_invoice_number, zoho_invoice_id, customer_id, customer_name,
          customer_city, invoice_date, irn, irn_ack_no, irn_ack_date, oem_id, product_id, model_id, cp_type_id, oem_brand, care_pack_type, printer_model,
          duration_years, printer_item_name, invoice_item_name, invoice_description, invoice_brand_detected, invoice_qty, device_count, status,
          overridden, notes, created_at, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'IMPORTED', ?,?,?,?)`,
        inv, x.idx, source, invoiceChanged ? srcInv : null, zoho?.invoiceId || null, h.customer_id, h.customer_name || zoho?.customerName || null,
        h.customer_city || zoho?.customerCity || null, h.invoice_date, irn, h.irn_ack_no || zoho?.irnAckNo || null, h.irn_ack_date || zoho?.irnAckDate || null,
        x.oem_id, x.product_id, x.model_id, x.cp_type_id, x.oem_brand, x.care_pack_type, x.printer_model, years,
        x.printer_item_name || src?.printerItemName || null, x.care_pack_item_name || src?.carePackItemName || x.printer_item_name || null, desc,
        mm.itemBrand || src?.oemBrand || x.oem_brand, x.qty, x.serials.length, overridden ? 1 : 0, notes, now, user.name);
        const bid = this.one('SELECT last_insert_rowid() AS id').id;
        ids.push(bid);
        for (const sn of x.serials) {
          this.sql.exec(`INSERT INTO cp_devices (batch_id, model_id, serial_number, oem_brand, care_pack_type, original_model, warranty_end, overridden,
            override_by, override_at, override_reason, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          bid, x.model_id, sn, x.oem_brand, x.care_pack_type, x.printer_model, end, overridden ? 1 : 0,
          overridden ? user.name : null, overridden ? now : null, overridden ? why : null, now);
        }
      }
    });
    this.sql.exec('DELETE FROM cp_drafts WHERE user_id = ?', user.userId);
    this.audit(user, 'register', 'carepack', ids.join(','), { invoice: inv, source, sets: ids.length, serials: rows.reduce((a, r) => a + r.x.serials.length, 0) });
    return { ids };
  },

  // ---------- edits after import ----------
  cpReapplyDevices(b, user, fields, reason, markOverride) {
    const now = Date.now();
    const sets = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
    this.sql.exec(`UPDATE cp_devices SET ${sets}, override_by = ?, override_at = ?, override_reason = ?${markOverride ? ', overridden = 1' : ''} WHERE batch_id = ?`,
      ...Object.values(fields), user.name, now, reason, b.id);
  },
  cpUpdateHeader(user, { id, invoice_number, customer_name, invoice_item_name, invoice_date, note }) {
    if (!isAdmin(user)) throw err(403, 'Only Admin can edit invoice number, customer, date, or care pack name.');
    const b = this.cpBatch(id);
    const v = new Checker({ invoice_number, customer_name, invoice_item_name, invoice_date, note }).text('invoice_number', { required: true, max: 50, label: 'Invoice number' })
      .text('customer_name', { max: 200 }).text('invoice_item_name', { max: 200 }).date('invoice_date', { label: 'Invoice date', notFuture: true }).text('note', { max: 500 }).done();
    if (this.one('SELECT 1 AS x FROM cp_batches WHERE invoice_number = ? AND line_set_index = ? AND id != ?', v.invoice_number, b.line_set_index, b.id)) {
      throw err(409, `Invoice ${v.invoice_number} set #${b.line_set_index} already exists. Choose a different invoice number.`);
    }
    const before = `${b.invoice_number}|${b.customer_name || ''}|${b.invoice_item_name || ''}|${b.invoice_date || ''}`;
    const date = v.invoice_date || b.invoice_date;
    this.sql.exec('UPDATE cp_batches SET invoice_number = ?, source_invoice_number = COALESCE(source_invoice_number, ?), customer_name = ?, invoice_item_name = COALESCE(?, invoice_item_name), invoice_date = ? WHERE id = ?',
      v.invoice_number, eqCI(v.invoice_number, b.invoice_number) ? null : b.invoice_number, v.customer_name, v.invoice_item_name, date, b.id);
    const audit = `Header edited by Admin ${user.name}${v.note ? `: ${v.note}` : ''} (was ${before})`;
    const fields = {};
    if (date !== b.invoice_date && date) fields.warranty_end = addYears(date, this.yearsFor(b.care_pack_type, b.duration_years));
    this.cpReapplyDevices(b, user, fields.warranty_end ? fields : { batch_id: b.id }, audit, false);
    this.audit(user, 'header', 'carepack', b.id, { before, after: v });
    return this.cpGet(user, { id });
  },
  cpUpdateProduct(user, { id, oem_brand, printer_model, care_pack_type, note }) {
    if (!canEdit(user)) throw err(403, 'Your role cannot change brand, product, or care pack period.');
    const b = this.cpBatch(id);
    const v = new Checker({ oem_brand, printer_model, care_pack_type, note }).text('oem_brand', { required: true, max: 50, label: 'Brand' })
      .text('printer_model', { max: 100 }).text('care_pack_type', { required: true, max: 50, label: 'Care pack period' }).text('note', { max: 500 }).done();
    if (!b.invoice_date) throw err(422, 'Invoice date is missing — cannot recalculate warranty end. Set invoice date first.');
    const mb = detectBrandFromModel(v.printer_model);
    if (mb && !eqCI(mb, v.oem_brand) && !isAdmin(user)) throw err(422, `${v.printer_model} is a ${mb} model. Only an Admin override can register it as ${v.oem_brand}.`);
    const t = this.one('SELECT * FROM cp_types WHERE name = ?', v.care_pack_type);
    const years = this.yearsFor(v.care_pack_type, t?.duration_years);
    const end = addYears(b.invoice_date, years);
    this.ensureNotExpired(end, b.invoice_number, b.invoice_date, v.care_pack_type, years);
    this.sql.exec('UPDATE cp_batches SET oem_brand = ?, printer_model = ?, care_pack_type = ?, cp_type_id = ?, duration_years = ? WHERE id = ?',
      v.oem_brand, v.printer_model, v.care_pack_type, t?.id || null, years, b.id);
    const audit = `Brand/product/period updated by ${user.name}${v.note ? `: ${v.note}` : ''}`;
    this.cpReapplyDevices(b, user, { oem_brand: v.oem_brand, original_model: v.printer_model, care_pack_type: v.care_pack_type, warranty_end: end }, audit, false);
    this.audit(user, 'product', 'carepack', b.id, v);
    return this.cpGet(user, { id });
  },
  cpOverride(user, { id, oem_brand, printer_model, care_pack_type, reason, confirmed }) {
    if (!isAdmin(user)) throw err(403, 'Only Admin can override.');
    if (blank(reason)) throw err(422, 'Override reason is mandatory.', { field: 'reason' });
    if (!confirmed) throw err(422, 'Confirm the override checkbox.');
    const b = this.cpBatch(id);
    if (!BRANDS.includes(oem_brand)) throw new ValidationError({ oem_brand: 'Choose a brand' });
    const years = this.yearsFor(care_pack_type || b.care_pack_type);
    const end = b.invoice_date ? addYears(b.invoice_date, years) : null;
    this.sql.exec('UPDATE cp_batches SET oem_brand = ?, printer_model = ?, care_pack_type = ?, duration_years = ?, overridden = 1 WHERE id = ?',
      oem_brand, nz(printer_model) || b.printer_model, nz(care_pack_type) || b.care_pack_type, years, b.id);
    this.cpReapplyDevices(b, user, { oem_brand, original_model: nz(printer_model) || b.printer_model, care_pack_type: nz(care_pack_type) || b.care_pack_type, warranty_end: end },
      String(reason).trim().slice(0, 1000), true);
    this.audit(user, 'override', 'carepack', b.id, { oem_brand, printer_model, care_pack_type, reason });
    return this.cpGet(user, { id });
  },
  cpReplaceSerials(user, { id, serial_text, qty, reason }) {
    if (!canEdit(user)) throw err(403, 'Viewers cannot edit serial numbers.');
    const b = this.cpBatch(id);
    if (!this.canEditDevices(b)) throw err(409, 'Serial numbers are locked after PO validation / OEM link. Delete is also blocked.');
    const list = serialsFromAnything(serial_text);
    if (!list.length) throw err(422, 'Provide at least one valid serial number.');
    if (qty && Number(qty) !== list.length) throw err(422, `Qty is ${qty} but ${list.length} serial(s) entered. Enter one serial per unit.`);
    this.ensureNoDuplicateSerials(list, b.id);
    const old = this.all('SELECT * FROM cp_devices WHERE batch_id = ?', b.id);
    const keep = new Map(old.map((d) => [d.serial_number.toUpperCase(), d]));
    const end = b.invoice_date ? addYears(b.invoice_date, this.yearsFor(b.care_pack_type, b.duration_years)) : null;
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM cp_devices WHERE batch_id = ?', b.id);
      for (const sn of list) {
        const prev = keep.get(sn);
        this.sql.exec(`INSERT INTO cp_devices (batch_id, model_id, serial_number, oem_brand, care_pack_type, original_model, warranty_end, overridden,
          override_by, override_at, override_reason, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        b.id, prev?.model_id ?? b.model_id, sn, b.oem_brand, b.care_pack_type, b.printer_model, end, b.overridden,
        user.name, now, `Serial list updated${blank(reason) ? '' : `: ${String(reason).trim()}`}`, prev?.created_at || now);
      }
      this.sql.exec('UPDATE cp_batches SET device_count = ?, invoice_qty = ? WHERE id = ?', list.length, list.length, b.id);
    });
    this.audit(user, 'serials', 'carepack', b.id, { before: old.length, after: list.length });
    return this.cpGet(user, { id });
  },
  cpDelete(user, { ids }) {
    if (!isAdmin(user)) throw err(403, 'Only Admin can delete care pack batches.');
    const done = [];
    const skipped = [];
    for (const id of (ids || []).map(Number).filter(Boolean)) {
      const b = this.one('SELECT * FROM cp_batches WHERE id = ?', id);
      if (!b) { skipped.push(`#${id}: not found`); continue; }
      const why = this.cpDeleteCheck(b);
      if (why) { skipped.push(`${b.invoice_number}: ${why}`); continue; }
      this.sql.exec('DELETE FROM cp_devices WHERE batch_id = ?', id);
      this.sql.exec('DELETE FROM cp_batches WHERE id = ?', id);
      this.audit(user, 'delete', 'carepack', id, { invoice: b.invoice_number, set: b.line_set_index, devices: b.device_count });
      done.push(b.invoice_number);
    }
    return { deleted: done.length, skipped };
  },

  // ---------- OEM invoice, PDF, payment ----------
  applyVerification(id, by) {
    const b = this.cpBatch(id);
    const complete = !blank(b.po_number) && !blank(b.oem_invoice_number) && !!b.oem_pdf_name;
    if (complete) {
      this.sql.exec("UPDATE cp_batches SET status = 'COMPLETE', verified = 1, verified_at = COALESCE(verified_at, ?), verified_by = COALESCE(verified_by, ?) WHERE id = ?",
        Date.now(), by || 'System', id);
    } else {
      this.sql.exec('UPDATE cp_batches SET status = ?, verified = 0, verified_at = NULL, verified_by = NULL WHERE id = ?', blank(b.po_number) ? 'IMPORTED' : 'PO_VALIDATED', id);
    }
  },
  cpOemDetails(user, { id, oem_invoice_number, oem_invoice_date, installation_date, oem_amount, oem_currency }) {
    if (!canEdit(user)) throw err(403, 'Your role cannot edit OEM invoice details.');
    const b = this.cpBatch(id);
    if (blank(b.po_number)) throw err(422, 'Link / validate the OEM PO first, then enter the OEM invoice.');
    const v = new Checker({ oem_invoice_number, oem_invoice_date, installation_date, oem_amount, oem_currency })
      .text('oem_invoice_number', { max: 100, label: 'OEM invoice number' }).date('oem_invoice_date', { label: 'OEM invoice date', notFuture: true })
      .date('installation_date', { label: 'Installation date' }).number('oem_amount', { min: 0, max: 1e10, label: 'Amount' })
      .oneOf('oem_currency', ['USD', 'INR'], { label: 'Currency' }).done();
    if (b.oem_paid && !eqCI(v.oem_invoice_number, b.oem_invoice_number)) throw err(409, 'This OEM invoice is marked paid. Remove the payment (Admin) before changing the invoice number.');
    this.sql.exec('UPDATE cp_batches SET oem_invoice_number = ?, oem_invoice_date = ?, installation_date = ?, oem_amount = ?, oem_currency = ? WHERE id = ?',
      v.oem_invoice_number, v.oem_invoice_date, v.installation_date, v.oem_amount, v.oem_currency || 'USD', b.id);
    this.applyVerification(b.id, user.name);
    this.audit(user, 'oem_invoice', 'carepack', b.id, v);
    return this.cpGet(user, { id });
  },
  cpPutPdf(user, { id, name, bytes }) {
    if (!canEdit(user)) throw err(403, 'Your role cannot upload OEM invoices.');
    const b = this.cpBatch(id);
    if (blank(b.po_number)) throw err(422, 'Link / validate the OEM PO first, then upload the OEM invoice PDF.');
    this.storeBytes(PDF_ID(b.id), bytes);
    this.sql.exec('UPDATE cp_batches SET oem_pdf_name = ?, oem_pdf_size = ? WHERE id = ?', name, bytes.byteLength, b.id);
    this.applyVerification(b.id, user.name);
    this.audit(user, 'oem_pdf', 'carepack', b.id, { name, size: bytes.byteLength });
    return this.cpGet(user, { id });
  },
  cpGetPdf(user, { id }) {
    const b = this.cpBatch(id);
    if (!b.oem_pdf_name) throw err(404, 'OEM invoice PDF not found.');
    return { name: b.oem_pdf_name, bytes: this.readBytes(PDF_ID(b.id), b.oem_pdf_size) };
  },
  cpSetPaid(user, { id, paid }) {
    if (!canEdit(user)) throw err(403, 'Your role cannot update payment status.');
    const b = this.cpBatch(id);
    if (blank(b.po_number)) throw err(422, 'Link an OEM PO before marking payment.');
    if (blank(b.oem_invoice_number)) throw err(422, 'Enter the OEM invoice number before marking payment.');
    if (!paid && b.oem_paid && !isAdmin(user)) throw err(403, 'Only Admin can undo a payment (Remove payment, with a reason).');
    this.sql.exec('UPDATE cp_batches SET oem_paid = ?, oem_paid_at = ?, oem_paid_by = ? WHERE id = ?', paid ? 1 : 0, paid ? Date.now() : null, paid ? user.name : null, b.id);
    this.audit(user, paid ? 'paid' : 'unpaid', 'carepack', b.id, null);
    return { ok: true };
  },
  cpPayments() {
    return this.all(`SELECT id, invoice_number, line_set_index, customer_name, po_number, oem_invoice_number, oem_invoice_date, oem_amount, oem_currency,
      oem_paid, oem_paid_at, oem_paid_by FROM cp_batches WHERE po_number IS NOT NULL AND po_number != '' AND oem_invoice_number IS NOT NULL AND oem_invoice_number != ''
      ORDER BY oem_paid, po_number, invoice_number`);
  },

  // Admin removes OEM payment → OEM invoice → PO, in that order, with reason, confirmation and a permanent audit row.
  cpRemoveDoc(user, { id, kind, reason, confirmed }) {
    if (!isAdmin(user)) throw err(403, 'Only Admin can remove OEM payment, OEM invoice, or PO.');
    if (blank(reason)) throw err(422, 'A reason is mandatory.', { field: 'reason' });
    if (!confirmed) throw err(422, 'Confirm the removal checkbox.');
    const b = this.cpBatch(id);
    const gate = this.docGates(b)[kind];
    if (!gate) throw err(400, 'Unknown document action.');
    if (!gate.ok) throw err(409, gate.reason);
    const t = (ms) => (ms ? new Date(ms + 19800000).toISOString().slice(0, 16).replace('T', ' ') : '');
    let snapshot;
    let label;
    if (kind === 'payment') {
      label = 'OEM payment';
      snapshot = `Paid=True; PaidAt=${t(b.oem_paid_at)}; PaidBy=${b.oem_paid_by || '—'}`;
      this.sql.exec('UPDATE cp_batches SET oem_paid = 0, oem_paid_at = NULL, oem_paid_by = NULL WHERE id = ?', b.id);
    } else if (kind === 'invoice') {
      label = 'OEM invoice';
      snapshot = `OEM inv=${b.oem_invoice_number || '—'}; Date=${fmtDMY(b.oem_invoice_date)}; Amount=${b.oem_amount ?? '—'} ${b.oem_currency || 'USD'}; PDF=${b.oem_pdf_name || 'none'}; Verified=${b.verified ? 'True' : 'False'}`;
      this.sql.exec('DELETE FROM file_chunks WHERE file_id = ?', PDF_ID(b.id));
      this.sql.exec(`UPDATE cp_batches SET oem_invoice_number = NULL, oem_invoice_date = NULL, oem_amount = NULL, oem_currency = 'USD', oem_pdf_name = NULL,
        oem_pdf_size = NULL, oem_paid = 0, oem_paid_at = NULL, oem_paid_by = NULL WHERE id = ?`, b.id);
    } else {
      label = 'OEM PO';
      snapshot = `PO=${b.po_number || '—'}; ZohoId=${b.zoho_po_id || '—'}; Matched=${b.po_matched ? 'True' : 'False'}; ValidatedAt=${t(b.po_validated_at)}; By=${b.po_validated_by || '—'}; Notes=${b.po_notes || '—'}`;
      this.sql.exec(`UPDATE cp_batches SET po_number = NULL, zoho_po_id = NULL, po_validated_at = NULL, po_validated_by = NULL, po_matched = 0, po_notes = NULL,
        po_serials = NULL, po_vendor = NULL, po_date = NULL, po_source = NULL WHERE id = ?`, b.id);
    }
    this.applyVerification(b.id, user.name);
    this.sql.exec('INSERT INTO cp_doc_audit (batch_id, invoice_number, action, snapshot, reason, by_name, at) VALUES (?,?,?,?,?,?,?)',
      b.id, b.invoice_number, label, snapshot, String(reason).trim().slice(0, 500), user.name, Date.now());
    this.audit(user, `remove_${kind}`, 'carepack', b.id, { reason, snapshot });
    return this.cpGet(user, { id });
  },
  cpOverrideLog(user) {
    if (!isAdmin(user)) throw err(403, 'Admin only. Your role cannot view the override log.');
    return {
      overrides: this.all(`SELECT d.batch_id, b.invoice_number, d.serial_number, b.invoice_brand_detected, d.oem_brand, d.override_by, d.override_at, d.override_reason
        FROM cp_devices d JOIN cp_batches b ON b.id = d.batch_id WHERE d.overridden = 1 ORDER BY d.override_at DESC LIMIT 1000`),
      removals: this.all('SELECT * FROM cp_doc_audit ORDER BY at DESC LIMIT 500'),
    };
  },

  // ---------- pending & deadline reports ----------
  cpPending() {
    const lim = this.limits();
    const t = today();
    const base = 'SELECT id, invoice_number, line_set_index, customer_name, oem_brand, printer_model, device_count, status, po_number, oem_invoice_number, oem_pdf_name, invoice_date, oem_invoice_date, oem_amount, oem_currency, oem_paid, created_at FROM cp_batches';
    const noPo = this.all(`${base} WHERE po_number IS NULL OR po_number = '' ORDER BY invoice_date`).map((b) => {
      const due = b.invoice_date ? addDays(b.invoice_date, lim.po) : null;
      const rem = due ? daysUntil(due, t) : null;
      return { ...b, due, days: rem, gap: rem === null ? 'OEM PO not issued / not linked (no invoice date)' : rem < 0
        ? `PO overdue by ${-rem} day(s) (limit ${lim.po} from sales invoice; contract max 30)` : `PO due in ${rem} day(s) (by ${fmtDMY(due)})` };
    }).sort((a, b) => (a.days ?? 1e9) - (b.days ?? 1e9));
    const docs = this.all(`${base} WHERE po_number IS NOT NULL AND po_number != '' AND verified = 0 ORDER BY created_at DESC`).map((b) => ({
      ...b, gap: [blank(b.oem_invoice_number) && 'OEM invoice number not entered', !b.oem_pdf_name && 'OEM invoice PDF not received'].filter(Boolean).join('; ') || 'Verification incomplete',
    }));
    const pay = this.all(`${base} WHERE oem_invoice_number IS NOT NULL AND oem_invoice_number != '' AND po_number IS NOT NULL AND po_number != '' AND oem_paid = 0
      AND oem_invoice_date IS NOT NULL`).map((b) => {
      const due = addDays(b.oem_invoice_date, lim.pay);
      const rem = daysUntil(due, t);
      return { ...b, due, days: rem, gap: `${rem < 0 ? `OEM payment overdue by ${-rem} day(s) (limit ${lim.pay}; contract max 45)` : `OEM payment due in ${rem} day(s) (by ${fmtDMY(due)})`}${b.oem_amount ? `; amount ${b.oem_amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })} ${b.oem_currency || 'USD'}` : ''}` };
    }).sort((a, b) => a.days - b.days);
    return { limits: lim, noPo, docs, pay, payments: this.cpPayments() };
  },
  cpDashboard() {
    const t = today();
    const lim = this.limits();
    const devices = this.one(`SELECT COUNT(*) AS n, SUM(warranty_end < ?1) AS expired, SUM(warranty_end >= ?1 AND warranty_end <= ?2) AS e30,
      SUM(warranty_end > ?2 AND warranty_end <= ?3) AS e60 FROM cp_devices`, t, addDays(t, 30), addDays(t, 60));
    const p = this.cpPending();
    return {
      batches: this.one('SELECT COUNT(*) AS n FROM cp_batches').n, verified: this.one('SELECT COUNT(*) AS n FROM cp_batches WHERE verified = 1').n,
      devices: devices.n || 0, expired: devices.expired || 0, expiring30: devices.e30 || 0, expiring60: devices.e60 || 0,
      poOverdue: p.noPo.filter((x) => x.days !== null && x.days < 0).length, poDueSoon: p.noPo.filter((x) => x.days !== null && x.days >= 0 && x.days <= 5).length,
      docsPending: p.docs.length, payOverdue: p.pay.filter((x) => x.days < 0).length, payDueSoon: p.pay.filter((x) => x.days >= 0 && x.days <= 5).length, limits: lim,
    };
  },
  cpReminders() {
    const p = this.cpPending();
    const out = [];
    for (const b of p.noPo) if (b.days !== null && b.days <= 5) out.push({ id: b.id, kind: b.days < 0 ? 'Care pack: OEM PO overdue' : 'Care pack: OEM PO due soon', invoice: b.invoice_number, customer: b.customer_name || '—', detail: b.gap, tone: b.days < 0 ? 'late' : 'todo' });
    for (const b of p.pay) if (b.days <= 5) out.push({ id: b.id, kind: b.days < 0 ? 'Care pack: OEM payment overdue' : 'Care pack: OEM payment due soon', invoice: b.invoice_number, customer: b.customer_name || '—', detail: b.gap, tone: b.days < 0 ? 'late' : 'todo' });
    for (const b of p.docs) out.push({ id: b.id, kind: 'Care pack: OEM documents pending', invoice: b.invoice_number, customer: b.customer_name || '—', detail: b.gap, tone: 'todo' });
    return out;
  },

  // ---------- PO linking ----------
  cpPoCandidates(user, { id }) {
    const b = this.cpBatch(id);
    const rows = this.all(`SELECT id, invoice_number, line_set_index, customer_name, device_count, invoice_qty, printer_model, invoice_date FROM cp_batches
      WHERE (po_number IS NULL OR po_number = '') AND id != ? ORDER BY invoice_date DESC, created_at DESC LIMIT 300`, b.id);
    rows.sort((a, c) => Number(eqCI(c.customer_name, b.customer_name)) - Number(eqCI(a.customer_name, b.customer_name)));
    return { batch: { ...b, po_serials: undefined }, candidates: rows.slice(0, 60) };
  },
  // Works out the PO link from what the user gave (manual details or a Zoho PO) + PO serials. Used by preview AND confirm.
  async cpPoWork(user, input) {
    if (!canEdit(user)) throw err(403, 'Viewers cannot validate or link an OEM PO.');
    const ids = [...new Set([Number(input.batchId), ...(input.linkIds || []).map(Number)])].filter(Boolean).slice(0, 60);
    const batches = ids.map((id) => this.one('SELECT * FROM cp_batches WHERE id = ?', id));
    if (batches.some((b) => !b)) throw err(404, 'Batch(es) not found.');
    const warnings = [];
    let po;
    let serials = serialsFromAnything('', Array.isArray(input.serials) ? input.serials : []);
    let source = input.serialSource || 'Manual entry';
    if (input.mode === 'zoho') {
      const z = await this.zoho();
      const d = await z.purchaseOrderById(String(input.zohoPoId || ''));
      if (!d) throw err(404, 'Purchase order not found in Zoho. Use Manual PO entry instead.');
      if (Zoho.excludedPoStatus(d.status)) throw err(422, `PO status '${d.status}' cannot be used. Draft and cancelled POs are excluded.`);
      po = { number: d.number, vendor: d.vendorName, ref: d.reference, currency: d.currency, date: d.date, qty: d.lineItems.reduce((a, l) => a + Number(l.quantity || 0), 0), zohoId: d.id };
      const desc = d.lineItems.map((l) => `${l.name || ''}\n${l.description || ''}`).join('\n');
      const mm = analyzeMismatch(d.lineItems[0]?.name, desc);
      if (mm.hasMismatch) warnings.push(`PO brand mismatch: ${mm.message}`);
      if (!serials.length) { serials = serialsFromAnything(desc); source = 'PO description'; }
    } else {
      const v = new Checker(input.po || {}).text('number', { required: true, max: 50, label: 'PO number' }).text('vendor', { max: 120 }).text('ref', { max: 60 })
        .text('currency', { max: 10 }).number('qty', { min: 0, max: 100000, int: true, label: 'PO qty' }).date('date', { label: 'PO date' }).done();
      po = { number: v.number, vendor: v.vendor, ref: v.ref, currency: v.currency || 'USD', date: v.date, qty: v.qty || 0, zohoId: null };
      warnings.push('Manual PO entry — Zoho was not used.');
    }
    for (const b of batches) {
      if (!blank(b.po_number) && !eqCI(b.po_number, po.number)) throw err(409, `Invoice ${b.invoice_number} already has PO ${b.po_number}. Admin can remove that PO from the invoice (reason + confirmation) before linking another.`);
    }
    if (po.ref && !batches.some((b) => eqCI(b.invoice_number, po.ref))) warnings.push(`PO Ref# is ${po.ref} (not one of the selected invoices). OK when clubbing multiple invoices.`);
    const invQty = batches.reduce((a, b) => a + (b.invoice_qty || b.device_count), 0);
    if (po.qty > 0 && invQty > 0) {
      if (po.qty < invQty) warnings.push(`PO qty (${po.qty}) is less than the selected invoices' qty (${invQty}). Verify the PO covers these devices.`);
      else if (po.qty > invQty) warnings.push(`PO qty (${po.qty}) > selected invoices (${invQty}) — expected when more invoices are clubbed on one OEM PO.`);
    }
    const parties = [...new Set(batches.map((b) => (b.customer_name || '').trim().toUpperCase()).filter(Boolean))];
    if (batches.length > 1 && parties.length > 1) warnings.push(`This OEM PO will link ${batches.length} invoices across ${parties.length} parties. Allowed — each invoice's serials must still appear on the PO.`);
    if (po.currency && !eqCI(po.currency, 'USD')) warnings.push(`PO currency is ${po.currency} not USD. Verify this is an OEM purchase order.`);
    if (!serials.length) warnings.push(input.mode === 'zoho' ? 'No serial numbers found on the PO. Upload the XLSX/PDF attachment or paste them.' : 'No PO serial numbers entered — link will record PO number only; SN match cannot be verified.');
    else if (invQty > 0 && serials.length < invQty * 0.5) warnings.push(`Only ${serials.length} serial numbers found on PO source. Selected invoices expect ~${invQty}. File may be incomplete.`);
    const already = this.all('SELECT invoice_number FROM cp_batches WHERE po_number = ? ORDER BY invoice_number LIMIT 40', po.number).map((r) => r.invoice_number)
      .filter((n) => !batches.some((b) => eqCI(b.invoice_number, n)));
    if (already.length) warnings.push(`This PO is already linked to ${already.length} other invoice(s): ${already.slice(0, 8).join(', ')}${already.length > 8 ? '…' : ''}.`);
    const lim = this.limits();
    const t = today();
    const matches = batches.map((b) => {
      const inv = this.all('SELECT serial_number FROM cp_devices WHERE batch_id = ?', b.id).map((d) => d.serial_number);
      const cross = crossValidate(inv, serials);
      const due = b.invoice_date ? addDays(b.invoice_date, lim.po) : null;
      const late = due && daysUntil(due, t) < 0;
      if (late) warnings.push(`Note: ${b.invoice_number} is past the ${lim.po}-day PO window (sales invoice ${fmtDMY(b.invoice_date)}).`);
      if (serials.length && !cross.perfect && cross.onlyInInvoice.length) warnings.push(`Invoice ${b.invoice_number}: ${cross.onlyInInvoice.length} serial(s) missing from PO.`);
      return { id: b.id, invoice_number: b.invoice_number, customer_name: b.customer_name, device_count: b.device_count, printer_model: b.printer_model,
        perfect: cross.perfect, matched: cross.matched.length, missing: cross.onlyInInvoice, extraOnPo: cross.onlyInPo.length, late: !!late, due };
    });
    return { po, serials, source, warnings: [...new Set(warnings)], matches, allMatch: serials.length > 0 && matches.every((m) => m.perfect) };
  },
  async cpPoPreview(user, input) { return this.cpPoWork(user, input); },
  async cpPoConfirm(user, input) {
    const w = await this.cpPoWork(user, input);
    const accept = input.acceptAnyway === true;
    const reason = nz(input.reason);
    const poOnly = input.mode !== 'zoho' && !w.serials.length;
    for (const m of w.matches) {
      if (m.perfect) continue;
      if (poOnly) {
        if (!accept) throw err(422, 'No PO serials entered. Tick "link PO number only" and give a reason, or paste the PO serials.');
        if (!reason) throw err(422, 'Reason is required to link a PO without serial check.', { field: 'reason' });
        if (m.late && !isAdmin(user)) throw err(403, `PO deadline exceeded for ${m.invoice_number} and serials are not checked. Admin must link it with a reason.`);
      } else {
        if (!accept) throw err(422, `Invoice ${m.invoice_number}: serial numbers do not match this PO (${m.missing.length} missing from PO). Resolve, paste PO serials, or Admin Accept Anyway.`);
        if (!isAdmin(user)) throw err(403, 'Only Admin can accept a mismatched PO validation.');
        if (!reason) throw err(422, 'Reason is required when accepting a mismatch.', { field: 'reason' });
      }
    }
    const now = Date.now();
    const lim = this.limits();
    const primary = w.matches[0];
    this.ctx.storage.transactionSync(() => {
      for (const m of w.matches) {
        let notes = accept && !m.perfect ? `${poOnly ? 'PO number only (serials not cross-checked)' : 'Accepted with discrepancies'}: ${reason}`
          : `${input.mode === 'zoho' ? '' : 'Manual PO — '}${m.perfect ? 'Perfect match (clubbed OK)' : 'Linked'}`;
        if (m.perfect && m.extraOnPo) notes += ` | Clubbed PO: ${m.extraOnPo} other SN(s) on same OEM PO`;
        if (m.id !== primary.id) notes += ` | Clubbed with invoice ${primary.invoice_number}`;
        if (m.late) notes += ` | LATE PO (limit ${lim.po}d from sales invoice; due ${fmtDMY(m.due)})`;
        this.sql.exec(`UPDATE cp_batches SET po_number = ?, zoho_po_id = ?, po_validated_at = ?, po_validated_by = ?, po_matched = ?, po_notes = ?, po_serials = ?,
          po_vendor = ?, po_date = ?, po_source = ? WHERE id = ?`,
        w.po.number, w.po.zohoId, now, user.name, m.perfect ? 1 : 0, notes, JSON.stringify(w.serials), w.po.vendor, w.po.date,
        `${w.source}${m.id !== primary.id ? ' (clubbed)' : ''}`, m.id);
        this.applyVerification(m.id, user.name);
      }
    });
    this.audit(user, 'po_link', 'carepack', w.matches.map((m) => m.id).join(','), { po: w.po.number, accept, reason });
    return { ok: true, po: w.po.number, linked: w.matches.length };
  },

  // ---------- Zoho ----------
  async zoho() {
    const s = this.settings();
    const secretEnc = this.one("SELECT value FROM meta WHERE key = 'zoho:secret'")?.value;
    const refreshEnc = this.one("SELECT value FROM meta WHERE key = 'zoho:refresh'")?.value;
    if (blank(s.zoho_client_id) || !secretEnc) throw err(422, 'Zoho is not set up for this company. Company settings → Zoho Books: save Client ID and Secret, then Connect with a fresh Self Client grant code.');
    if (!refreshEnc) throw err(422, 'Zoho Books is not connected. Company settings → Zoho Books → Connect with a fresh Self Client grant code.');
    if (blank(s.zoho_org_id)) throw err(422, 'Zoho Books organization ID not configured. Company settings → Zoho Books.');
    const key = this.env.ENC_KEY;
    return new Zoho({
      dc: s.zoho_dc, orgId: s.zoho_org_id, clientId: s.zoho_client_id,
      clientSecret: await decryptSecret(secretEnc, key), refreshToken: await decryptSecret(refreshEnc, key),
      cache: {
        get: () => { const c = this.one("SELECT value FROM meta WHERE key = 'zoho:access'")?.value; return c ? JSON.parse(c) : null; },
        set: (v) => this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('zoho:access', ?)", v ? JSON.stringify(v) : ''),
      },
    });
  },
  async zohoSaveConfig(user, { dc, org_id, client_id, client_secret }) {
    if (!isAdmin(user)) throw err(403, 'Only an Admin can do this.');
    const v = new Checker({ dc, org_id, client_id }).oneOf('dc', Object.keys(Zoho.DCS), { required: true, label: 'Data centre' })
      .text('org_id', { max: 50, label: 'Organisation ID' }).text('client_id', { max: 200, label: 'Client ID' }).done();
    for (const [k, val] of [['zoho_dc', v.dc], ['zoho_org_id', v.org_id || ''], ['zoho_client_id', v.client_id || '']]) {
      this.sql.exec('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', `set:${k}`, val);
    }
    if (!blank(client_secret)) this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('zoho:secret', ?)", await encryptSecret(String(client_secret).trim(), this.env.ENC_KEY));
    this.sql.exec("DELETE FROM meta WHERE key = 'zoho:access'");
    this.audit(user, 'zoho_config', 'settings', null, { dc: v.dc, org: v.org_id });
    return this.cpSettings();
  },
  async zohoConnect(user, { grant_code }) {
    if (!isAdmin(user)) throw err(403, 'Only an Admin can do this.');
    if (blank(grant_code)) throw new ValidationError({ grant_code: 'Paste a fresh grant code from api-console.zoho.com' });
    const s = this.settings();
    const secretEnc = this.one("SELECT value FROM meta WHERE key = 'zoho:secret'")?.value;
    if (blank(s.zoho_client_id) || !secretEnc) throw err(422, 'Save Client ID and Client Secret first.');
    const refresh = await Zoho.exchangeGrant({ dc: s.zoho_dc, clientId: s.zoho_client_id, clientSecret: await decryptSecret(secretEnc, this.env.ENC_KEY), code: String(grant_code).trim() });
    this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('zoho:refresh', ?)", await encryptSecret(refresh, this.env.ENC_KEY));
    this.sql.exec("DELETE FROM meta WHERE key = 'zoho:access'");
    this.audit(user, 'zoho_connect', 'settings', null, null);
    return { ...this.cpSettings(), message: await (await this.zoho()).test() };
  },
  async zohoTest(user) {
    if (!isAdmin(user)) throw err(403, 'Only an Admin can do this.');
    return { message: await (await this.zoho()).test() };
  },
  zohoDisconnect(user) {
    if (!isAdmin(user)) throw err(403, 'Only an Admin can do this.');
    this.sql.exec("DELETE FROM meta WHERE key IN ('zoho:refresh', 'zoho:access', 'zoho:secret')");
    this.audit(user, 'zoho_disconnect', 'settings', null, null);
    return this.cpSettings();
  },
  async cpZohoInvoice(number) {
    const z = await this.zoho();
    const inv = await z.invoiceByNumber(number);
    if (!inv) return null;
    return { ...inv, sets: buildLineSets(inv.lineItems, inv.notes) };
  },
  async cpZohoPreview(user, { invoice_number }) {
    if (!canImport(user)) throw err(403, 'Your role cannot import care pack invoices.');
    if (blank(invoice_number)) throw new ValidationError({ invoice_number: 'Enter the invoice number' });
    const inv = await this.cpZohoInvoice(String(invoice_number).trim());
    if (!inv) throw err(404, `Invoice '${invoice_number}' not found in Zoho Books.`);
    if (!inv.sets.length) throw err(422, 'Invoice has no usable line items.');
    const done = this.all('SELECT line_set_index FROM cp_batches WHERE invoice_number = ?', inv.invoiceNumber).map((r) => r.line_set_index);
    const available = inv.sets.filter((s) => !done.includes(s.setIndex));
    if (!available.length) throw err(409, `All line sets on ${inv.invoiceNumber} are already imported. Open from Care Packs.`);
    return { invoice: { ...inv, sets: undefined, lineItems: undefined }, sets: available, alreadyImported: done };
  },
  async cpZohoPos(user, { number, invoice }) {
    if (!canEdit(user)) throw err(403, 'Viewers cannot validate or link an OEM PO.');
    const z = await this.zoho();
    if (!blank(number)) {
      let d;
      try { d = await z.purchaseOrderByNumber(String(number).trim()); } catch (e) { throw err(502, `Zoho could not fetch that PO: ${e.message} — use Manual PO entry instead.`); }
      if (!d) throw err(404, `PO '${String(number).trim()}' was not found in Zoho. Check the number or use Manual PO entry.`);
      if (Zoho.excludedPoStatus(d.status)) throw err(422, `PO status '${d.status}' cannot be used (draft/cancelled excluded).`);
      return { pos: [{ ...d, quantity: d.lineItems.reduce((a, l) => a + Number(l.quantity || 0), 0) }] };
    }
    const list = (await z.purchaseOrders()).filter((p) => Zoho.isOemVendor(p.vendorName));
    list.sort((a, b) => Number(eqCI(b.reference, invoice)) - Number(eqCI(a.reference, invoice)) || String(b.date).localeCompare(String(a.date)));
    return { pos: list.slice(0, 300) };
  },

  // Delivery challan in Zoho Books for an RMA going back to the customer.
  async createChallan(user, { id }) {
    if (!canEdit(user)) throw err(403, 'Your role can only view records.');
    const s = this.settings();
    if (s.challan_enabled === '0') throw err(422, 'Delivery challan create is disabled (Company settings → Zoho Books).');
    const t = this.ticketRow(id);
    if (t.status !== 'GOODS_RECEIVED_FROM_OEM') throw err(409, 'Create the challan when the goods are back from the OEM.');
    const map = this.tokenMap(t, user.companyName);
    const fill = (tpl) => String(tpl || '').replace(/\{\{([A-Z_]+)\}\}/gi, (m, k) => map[k.toUpperCase()] ?? '');
    const z = await this.zoho();
    const customer = await z.findContact(t.customer_company);
    if (!customer) throw err(422, `Customer "${t.customer_company}" was not found in Zoho Books contacts. Use the exact Zoho customer name on the RMA, or add the contact in Zoho first.`);
    const ch = await z.createDeliveryChallan({
      customer_id: customer.contact_id, date: today(), reference_number: t.ticket_no, challan_type: 'others',
      notes: fill(s.challan_notes), line_items: [{ description: fill(s.challan_line_description), quantity: 1, unit: 'Nos' }],
    });
    return { number: ch.number, id: ch.id, autoDispatch: s.challan_auto_dispatch !== '0' };
  },

  // ---------- drafts (survive a refresh; one per user) ----------
  cpDraftGet(user) {
    const d = this.one("SELECT data, saved_at FROM cp_drafts WHERE user_id = ? AND kind = 'register'", user.userId);
    return d ? { data: JSON.parse(d.data), savedAt: d.saved_at } : null;
  },
  cpDraftSave(user, { data }) {
    const json = JSON.stringify(data || {});
    if (json.length > 400000) throw err(413, 'Draft is too large.');
    this.sql.exec("INSERT OR REPLACE INTO cp_drafts (user_id, kind, data, saved_at) VALUES (?, 'register', ?, ?)", user.userId, json, Date.now());
    return { ok: true };
  },
  cpDraftClear(user) {
    this.sql.exec("DELETE FROM cp_drafts WHERE user_id = ? AND kind = 'register'", user.userId);
    return { ok: true };
  },
  cpMeta() {
    return { brands: BRANDS, types: CARE_PACK_TYPES };
  },
};
