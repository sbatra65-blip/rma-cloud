// One-time move from the old Windows RMA System (SQL Server + photo folders) into a company.
// Called by tools/migrate-from-sqlserver.ps1 with a migration key an Admin creates in Settings.
// Every call is safe to repeat: rows that already exist are skipped, never duplicated or overwritten.
import { ValidationError } from './validate.js';
import { addYears } from './catalog.js';

const blank = (s) => s === null || s === undefined || String(s).trim() === '';
const nz = (s, max = 2000) => (blank(s) ? null : String(s).trim().slice(0, max));
const num = (v) => (blank(v) || !Number.isFinite(Number(v)) ? null : Number(v));
const normSn = (s) => (blank(s) ? null : String(s).toUpperCase().replace(/[^A-Z0-9]/g, '') || null);
// Old system dates are local India time without a zone ("2026-05-14T10:32:00"). Store as epoch ms.
function istMs(s) {
  if (blank(s)) return null;
  const t = String(s).trim();
  const ms = /[zZ]|[+-]\d\d:?\d\d$/.test(t) ? Date.parse(t) : Date.parse(`${t.replace(' ', 'T')}+05:30`);
  return Number.isFinite(ms) ? ms : null;
}
const dateOnly = (s) => (blank(s) ? null : (String(s).match(/^\d{4}-\d{2}-\d{2}/) || [null])[0]);
const STATUSES = ['OPEN', 'AWAITING_OEM_RMA', 'OEM_RMA_RECEIVED', 'DISPATCHED_TO_OEM', 'GOODS_RECEIVED_FROM_OEM', 'DISPATCHED_TO_CUSTOMER', 'CLOSED', 'CLOSED_RETURNED'];
const MAX_ROWS = 200;

export const migrateMethods = {
  migrateStatus() {
    const n = (q) => this.one(q).n;
    return {
      tickets: n('SELECT COUNT(*) AS n FROM tickets'),
      migratedTickets: n("SELECT COUNT(*) AS n FROM tickets WHERE created_by LIKE 'Migrated%'"),
      photos: n('SELECT COUNT(*) AS n FROM photos'),
      customers: n('SELECT COUNT(*) AS n FROM customers'),
      models: n('SELECT COUNT(*) AS n FROM models'),
      batches: n('SELECT COUNT(*) AS n FROM batches'),
      carePacks: n('SELECT COUNT(*) AS n FROM cp_batches'),
      carePackDevices: n('SELECT COUNT(*) AS n FROM cp_devices'),
    };
  },

  // Masters first, so tickets can link to customers and models.
  migrateMasters(user, { oems = [], products = [], models = [], customers = [], cpTypes = [] }) {
    const now = Date.now();
    const out = { oems: 0, products: 0, models: 0, customers: 0, cpTypes: 0 };
    for (const o of oems) {
      const code = nz(o.code, 20)?.toUpperCase();
      if (!code || this.one('SELECT 1 AS x FROM oems WHERE code = ?', code)) continue;
      this.sql.exec('INSERT INTO oems (code, name, active, created_at) VALUES (?,?,?,?)', code, nz(o.name, 120) || code, o.active === false ? 0 : 1, istMs(o.created_at) || now);
      out.oems++;
    }
    const oemId = (code) => this.one('SELECT id FROM oems WHERE code = ?', String(code || '').toUpperCase())?.id;
    for (const p of products) {
      const oid = oemId(p.oem_code);
      const code = nz(p.code, 20)?.toUpperCase();
      if (!oid || !code || this.one('SELECT 1 AS x FROM products WHERE oem_id = ? AND code = ?', oid, code)) continue;
      this.sql.exec('INSERT INTO products (oem_id, code, name, active, created_at) VALUES (?,?,?,?,?)', oid, code, nz(p.name, 120) || code, p.active === false ? 0 : 1, istMs(p.created_at) || now);
      out.products++;
    }
    for (const m of models) {
      const pid = this.one('SELECT p.id FROM products p JOIN oems o ON o.id = p.oem_id WHERE o.code = ? AND p.code = ?', String(m.oem_code || '').toUpperCase(), String(m.product_code || '').toUpperCase())?.id;
      const code = nz(m.code, 40)?.toUpperCase();
      if (!pid || !code || this.one('SELECT 1 AS x FROM models WHERE product_id = ? AND code = ?', pid, code)) continue;
      this.sql.exec('INSERT INTO models (product_id, code, name, active, created_at) VALUES (?,?,?,?,?)', pid, code, nz(m.name, 120) || code, m.active === false ? 0 : 1, istMs(m.created_at) || now);
      out.models++;
    }
    for (const c of customers) {
      const name = nz(c.name, 200);
      if (!name || this.one('SELECT 1 AS x FROM customers WHERE name = ? COLLATE NOCASE', name)) continue;
      let code = nz(c.code, 20)?.toUpperCase() || null;
      if (!code || this.one('SELECT 1 AS x FROM customers WHERE code = ?', code)) code = this.nextCustomerCode ? this.nextCustomerCode() : `C${String(Date.now()).slice(-6)}${out.customers}`;
      this.sql.exec(`INSERT INTO customers (code, name, state, city, address, postal, country, contact_name, email, phone, gstin, active, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, code, name, nz(c.state, 100), nz(c.city, 100), nz(c.address, 500), nz(c.postal, 20), nz(c.country, 100) || 'India',
      nz(c.contact_name, 150), nz(c.email, 200), nz(c.phone, 50), nz(c.gstin, 20)?.toUpperCase() || null, c.active === false ? 0 : 1, istMs(c.created_at) || now);
      out.customers++;
    }
    for (const t of cpTypes) {
      const name = nz(t.name, 50);
      if (!name || this.one('SELECT 1 AS x FROM cp_types WHERE name = ? COLLATE NOCASE', name)) continue;
      this.sql.exec('INSERT INTO cp_types (name, duration_years, active, created_at) VALUES (?,?,?,?)', name, Math.max(1, Math.min(10, Number(t.duration_years) || 3)), t.active === false ? 0 : 1, now);
      out.cpTypes++;
    }
    this.audit(user, 'migrate_masters', 'migration', null, out);
    return out;
  },

  migrateTickets(user, { rows }) {
    if (!Array.isArray(rows) || !rows.length) throw new ValidationError({ _: 'No rows' });
    if (rows.length > MAX_ROWS) throw new ValidationError({ _: `Send at most ${MAX_ROWS} tickets per call` });
    const res = { created: 0, skipped: 0, errors: [] };
    let customersAdded = 0;
    // The old system often had no customer list; build it from the RMAs so the new customer dropdown is filled.
    const custByName = (n, r) => {
      if (blank(n)) return null;
      const name = String(n).trim().slice(0, 200);
      const hit = this.one('SELECT id FROM customers WHERE name = ? COLLATE NOCASE', name);
      if (hit) return hit.id;
      this.sql.exec(`INSERT INTO customers (code, name, state, city, address, postal, country, contact_name, email, phone, active, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,1,?)`, this.nextCustomerCode(), name, nz(r.customer_state, 100), nz(r.customer_city, 100), nz(r.customer_address, 500),
      nz(r.customer_postal, 20), nz(r.customer_country, 100) || 'India', nz(r.customer_contact_name, 150), nz(r.customer_email, 200), nz(r.customer_phone, 50), Date.now());
      customersAdded++;
      return this.one('SELECT last_insert_rowid() AS id').id;
    };
    const modelByCode = (c) => (blank(c) ? null : this.one('SELECT id FROM models WHERE code = ? COLLATE NOCASE', String(c).trim())?.id);
    for (const r of rows) {
      const ticketNo = nz(r.ticket_no, 30);
      try {
        if (!ticketNo) throw new Error('ticket number missing');
        if (this.one('SELECT 1 AS x FROM tickets WHERE ticket_no = ?', ticketNo)) { res.skipped++; continue; }
        const status = STATUSES.includes(String(r.status || '').toUpperCase()) ? String(r.status).toUpperCase() : 'OPEN';
        const created = istMs(r.created_at) || Date.now();
        const closed = status === 'CLOSED' || status === 'CLOSED_RETURNED';
        const row = {
          ticket_no: ticketNo, status, is_imported: r.is_imported ? 1 : 0, created_at: created, updated_at: istMs(r.updated_at) || created,
          created_by: `Migrated${nz(r.created_by, 60) ? ` (${nz(r.created_by, 60)})` : ''}`, updated_by: user.name,
          customer_id: custByName(r.customer_company, r), model_id: modelByCode(r.printer_model),
          customer_company: nz(r.customer_company, 200), customer_address: nz(r.customer_address), customer_city: nz(r.customer_city, 100),
          customer_state: nz(r.customer_state, 100), customer_postal: nz(r.customer_postal, 20), customer_country: nz(r.customer_country, 100),
          customer_contact_name: nz(r.customer_contact_name, 150), customer_email: nz(r.customer_email, 200), customer_phone: nz(r.customer_phone, 50),
          po_number: nz(r.po_number, 100), ship_to_company: nz(r.ship_to_company, 200), ship_to_address: nz(r.ship_to_address),
          ship_to_contact_name: nz(r.ship_to_contact_name, 150), ship_to_email: nz(r.ship_to_email, 200), ship_to_phone: nz(r.ship_to_phone, 50),
          printer_model: nz(r.printer_model, 100), printer_sn: nz(r.printer_sn, 100), printer_sn_norm: normSn(r.printer_sn),
          faulty_part: nz(r.faulty_part, 200), faulty_part_sn: nz(r.faulty_part_sn, 100), faulty_part_sn_norm: normSn(r.faulty_part_sn),
          faulty_part_no: nz(r.faulty_part_no, 100), failure_description: nz(r.failure_description, 4000),
          tph_mileage: num(r.tph_mileage), printer_mileage: num(r.printer_mileage), fw_version: nz(r.fw_version, 50), flash_initialized: nz(r.flash_initialized, 20),
          purchase_date: dateOnly(r.purchase_date), delivery_to_user_date: dateOnly(r.delivery_to_user_date),
          oem_rma_number: nz(r.oem_rma_number, 100), oem_rma_assign_date: dateOnly(r.oem_rma_assign_date),
          oem_email_sent_at: istMs(r.oem_email_sent_at), oem_email_sent_by: nz(r.oem_email_sent_by, 100),
          oem_dispatch_date: dateOnly(r.oem_dispatch_date), batch_code: nz(r.batch_code, 30),
          challan_number: nz(r.challan_number, 100), challan_date: dateOnly(r.challan_date), dispatch_to_customer_date: dateOnly(r.dispatch_to_customer_date),
          closed_at: closed ? (istMs(r.closed_at) || istMs(r.updated_at) || created) : null,
          closure_type: closed ? (nz(r.closure_type, 30) || (status === 'CLOSED' ? 'REPAIRED' : 'RETURNED')) : null,
          closure_remarks: nz(r.closure_remarks), dup_reason: nz(r.dup_reason), dup_at: istMs(r.dup_at), dup_by: nz(r.dup_by, 100),
        };
        const cols = Object.keys(row);
        this.sql.exec(`INSERT INTO tickets (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(',')})`, ...cols.map((k) => row[k]));
        const id = this.one('SELECT last_insert_rowid() AS id').id;
        this.sql.exec('INSERT INTO ticket_events (ticket_id, at, by_name, action, detail) VALUES (?,?,?,?,?)', id, created, nz(r.created_by, 60) || 'Old system', 'RMA raised', 'In the old Windows RMA System');
        this.sql.exec('INSERT INTO ticket_events (ticket_id, at, by_name, action, detail) VALUES (?,?,?,?,?)', id, Date.now(), user.name, 'Migrated to cloud', `Status ${status}`);
        res.created++;
      } catch (e) {
        res.errors.push({ ticket_no: ticketNo || '(none)', error: e.message });
      }
    }
    // Keep the next new RMA number after the migrated ones.
    this.fillMissingCategories();
    res.customersAdded = customersAdded;
    this.audit(user, 'migrate_tickets', 'migration', null, { created: res.created, skipped: res.skipped, customersAdded, errors: res.errors.length });
    return res;
  },

  migratePhotoCheck(user, { ticketNo, direction, name }) {
    const t = this.one('SELECT id FROM tickets WHERE ticket_no = ?', ticketNo);
    if (!t) return { ticket: false };
    return { ticket: true, exists: !!this.one('SELECT 1 AS x FROM photos WHERE ticket_id = ? AND direction = ? AND name = ?', t.id, direction, name) };
  },

  migratePhoto(user, { ticketNo, direction, name, mime, bytes, capturedAt, capturedBy, notes, r2Id }) {
    const t = this.one('SELECT id FROM tickets WHERE ticket_no = ?', ticketNo);
    if (!t) throw new ValidationError({ ticket_no: `RMA ${ticketNo} is not in the cloud yet. Move tickets before photos.` });
    if (this.one('SELECT 1 AS x FROM photos WHERE ticket_id = ? AND direction = ? AND name = ?', t.id, direction, name)) return { skipped: true };
    const id = r2Id || crypto.randomUUID();
    const size = typeof bytes === 'number' ? bytes : bytes.byteLength;
    this.sql.exec('INSERT INTO photos (id, ticket_id, direction, name, mime, size, store, notes, captured_at, captured_by) VALUES (?,?,?,?,?,?,?,?,?,?)',
      id, t.id, direction, name, mime, size, r2Id ? 'r2' : 'db', nz(notes, 300), istMs(capturedAt) || Date.now(), nz(capturedBy, 100) || 'Old system');
    if (!r2Id) this.storeBytes(id, bytes);
    return { id, size };
  },

  migrateBatches(user, { rows }) {
    if (!Array.isArray(rows)) throw new ValidationError({ _: 'No rows' });
    let created = 0;
    for (const b of rows) {
      const code = nz(b.batch_code, 30);
      if (!code || this.one('SELECT 1 AS x FROM batches WHERE batch_code = ?', code)) continue;
      const total = this.one('SELECT COUNT(*) AS n FROM tickets WHERE batch_code = ?', code).n || Number(b.total) || 0;
      this.sql.exec('INSERT INTO batches (batch_code, batch_month, dispatch_date, remarks, total, created_at, created_by) VALUES (?,?,?,?,?,?,?)',
        code, nz(b.batch_month, 7) || (dateOnly(b.dispatch_date) || '').slice(0, 7) || '0000-00', dateOnly(b.dispatch_date) || dateOnly(b.created_at) || '1970-01-01',
        nz(b.remarks), total, istMs(b.created_at) || Date.now(), 'Migrated');
      created++;
    }
    return { created };
  },

  migrateCarePacks(user, { rows }) {
    if (!Array.isArray(rows) || !rows.length) throw new ValidationError({ _: 'No rows' });
    if (rows.length > MAX_ROWS) throw new ValidationError({ _: `Send at most ${MAX_ROWS} care pack invoices per call` });
    const res = { created: 0, skipped: 0, devices: 0, errors: [] };
    for (const b of rows) {
      const inv = nz(b.invoice_number, 50);
      const set = Number(b.line_set_index) || 1;
      try {
        if (!inv) throw new Error('invoice number missing');
        if (this.one('SELECT 1 AS x FROM cp_batches WHERE invoice_number = ? AND line_set_index = ?', inv, set)) { res.skipped++; continue; }
        const devices = Array.isArray(b.devices) ? b.devices : [];
        const st = String(b.status || '').toUpperCase();
        const verified = b.verified || st === 'COMPLETE' ? 1 : 0;
        const type = this.one('SELECT id, duration_years FROM cp_types WHERE name = ? COLLATE NOCASE', nz(b.care_pack_type) || '');
        const created = istMs(b.created_at) || Date.now();
        this.ctx.storage.transactionSync(() => {
          this.sql.exec(`INSERT INTO cp_batches (invoice_number, line_set_index, source, source_invoice_number, zoho_invoice_id, customer_id, customer_name, customer_city,
            invoice_date, irn, irn_ack_no, irn_ack_date, cp_type_id, oem_brand, care_pack_type, printer_model, duration_years, printer_item_name, invoice_item_name,
            invoice_description, invoice_brand_detected, invoice_qty, device_count, status, po_number, zoho_po_id, po_validated_at, po_validated_by, po_matched, po_notes,
            po_source, oem_invoice_number, oem_invoice_date, installation_date, oem_amount, oem_currency, oem_paid, oem_paid_at, oem_paid_by,
            verified, verified_at, verified_by, overridden, notes, created_at, created_by)
            VALUES (?,?, 'migrated', ?,?,?,?,?, ?,?,?,?, ?,?,?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?)`,
          inv, set, nz(b.source_invoice_number, 50), nz(b.zoho_invoice_id, 50),
          this.one('SELECT id FROM customers WHERE name = ? COLLATE NOCASE', nz(b.customer_name) || '')?.id || null, nz(b.customer_name, 200), nz(b.customer_city, 200),
          dateOnly(b.invoice_date), nz(b.irn, 128), nz(b.irn_ack_no, 50), nz(b.irn_ack_date, 30),
          type?.id || null, nz(b.oem_brand, 50), nz(b.care_pack_type, 50), nz(b.printer_model, 100), type?.duration_years || null,
          nz(b.printer_item_name, 200), nz(b.invoice_item_name, 200), nz(b.invoice_description), nz(b.invoice_brand_detected, 50),
          Number(b.invoice_qty) || devices.length, devices.length, verified ? 'COMPLETE' : nz(b.po_number) ? 'PO_VALIDATED' : 'IMPORTED',
          nz(b.po_number, 50), nz(b.zoho_po_id, 50), istMs(b.po_validated_at), nz(b.po_validated_by, 100), b.po_matched ? 1 : 0, nz(b.po_notes),
          nz(b.po_number) ? 'Migrated' : null, nz(b.oem_invoice_number, 100), dateOnly(b.oem_invoice_date), dateOnly(b.installation_date),
          num(b.oem_amount), nz(b.oem_currency, 10) || 'USD', b.oem_paid ? 1 : 0, istMs(b.oem_paid_at), nz(b.oem_paid_by, 100),
          verified, istMs(b.verified_at), nz(b.verified_by, 100), b.overridden ? 1 : 0, 'Migrated from the old Windows RMA System', created, `Migrated${nz(b.created_by, 60) ? ` (${nz(b.created_by, 60)})` : ''}`);
          const bid = this.one('SELECT last_insert_rowid() AS id').id;
          for (const d of devices) {
            const sn = nz(d.serial_number, 100);
            if (!sn) continue;
            const end = dateOnly(d.warranty_end) || (dateOnly(b.invoice_date) && type ? addYears(dateOnly(b.invoice_date), type.duration_years) : null);
            this.sql.exec(`INSERT INTO cp_devices (batch_id, model_id, serial_number, oem_brand, care_pack_type, original_model, warranty_end, overridden,
              override_by, override_at, override_reason, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            bid, this.one('SELECT id FROM models WHERE code = ? COLLATE NOCASE', nz(d.original_model) || nz(b.printer_model) || '')?.id || null,
            sn, nz(d.oem_brand, 50) || nz(b.oem_brand, 50), nz(d.care_pack_type, 50) || nz(b.care_pack_type, 50), nz(d.original_model, 100) || nz(b.printer_model, 100),
            end, d.overridden ? 1 : 0, nz(d.override_by, 100), istMs(d.override_at), nz(d.override_reason), created);
            res.devices++;
          }
        });
        res.created++;
      } catch (e) {
        res.errors.push({ invoice: `${inv || '(none)'}${set > 1 ? ` #${set}` : ''}`, error: e.message });
      }
    }
    this.audit(user, 'migrate_carepacks', 'migration', null, { created: res.created, skipped: res.skipped, devices: res.devices, errors: res.errors.length });
    return res;
  },

  migrateCpPdf(user, { invoice, set, name, bytes }) {
    const b = this.one('SELECT id, oem_pdf_name FROM cp_batches WHERE invoice_number = ? AND line_set_index = ?', invoice, Number(set) || 1);
    if (!b) throw new ValidationError({ invoice: `Care pack invoice ${invoice} is not in the cloud yet.` });
    if (b.oem_pdf_name) return { skipped: true };
    this.storeBytes(`cp-oem-${b.id}`, bytes);
    this.sql.exec('UPDATE cp_batches SET oem_pdf_name = ?, oem_pdf_size = ? WHERE id = ?', name, bytes.byteLength, b.id);
    return { ok: true };
  },
};
