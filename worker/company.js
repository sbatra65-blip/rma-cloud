// Company: one private SQLite database per company (tickets, photos, masters, batches, settings).
// Nothing here can see any other company's data. Business rules are ported from the
// original RMASystem.Web services (TicketService, BatchService, ImportService, OemEmailService).
import { migrateMethods } from './migrate.js';
import { deviceMethods, migrateV3 } from './devices.js';
import { DurableObject } from 'cloudflare:workers';
import { uuid } from './crypto.js';
import { Checker, ValidationError, today, istParts, daysBetween } from './validate.js';
import { CP_DEFAULTS, carePackMethods, migrateCarePack } from './carepack.js';

const SCHEMA_VERSION = 3;
const CHUNK = 1_500_000; // bytes per stored file chunk (row limit is 2 MB)
const TEMPLATE_ID = 'oem-template';

export const STATUS = {
  OPEN: 'OPEN',
  AWAITING: 'AWAITING_OEM_RMA',
  OEM_RECEIVED: 'OEM_RMA_RECEIVED',
  DISPATCHED_OEM: 'DISPATCHED_TO_OEM',
  GOODS_RECEIVED: 'GOODS_RECEIVED_FROM_OEM',
  DISPATCHED_CUSTOMER: 'DISPATCHED_TO_CUSTOMER',
  CLOSED: 'CLOSED',
  CLOSED_RETURNED: 'CLOSED_RETURNED',
};
// Finished from the customer's side. Hidden when someone chooses "Active only".
export const COMPLETED = ['DISPATCHED_TO_CUSTOMER', 'CLOSED', 'CLOSED_RETURNED'];
export const STATUS_LABELS = {
  OPEN: 'Open',
  AWAITING_OEM_RMA: 'Awaiting OEM RMA',
  OEM_RMA_RECEIVED: 'OEM RMA Received',
  DISPATCHED_TO_OEM: 'Dispatched to OEM',
  GOODS_RECEIVED_FROM_OEM: 'Goods Received from OEM',
  DISPATCHED_TO_CUSTOMER: 'Dispatched to Customer',
  CLOSED: 'Closed',
  CLOSED_RETURNED: 'Closed – Returned',
};
const ALL_STATUS = Object.keys(STATUS_LABELS);
const CLOSED_SET = [STATUS.CLOSED, STATUS.CLOSED_RETURNED];
const label = (s) => STATUS_LABELS[s] || s;

// Words people used in the old Excel sheet → status (from ImportService.StatusMap).
const IMPORT_STATUS = {
  open: 'OPEN', new: 'OPEN', raised: 'OPEN', pending: 'OPEN',
  'sent to tsc': 'AWAITING_OEM_RMA', 'awaiting rma': 'AWAITING_OEM_RMA', 'email sent': 'AWAITING_OEM_RMA', 'sent to oem': 'AWAITING_OEM_RMA',
  'rma received': 'OEM_RMA_RECEIVED', 'tsc approved': 'OEM_RMA_RECEIVED', 'oem rma received': 'OEM_RMA_RECEIVED',
  'dispatched to tsc': 'DISPATCHED_TO_OEM', 'shipped to oem': 'DISPATCHED_TO_OEM', 'dispatched to oem': 'DISPATCHED_TO_OEM',
  'received from tsc': 'GOODS_RECEIVED_FROM_OEM', 'goods in': 'GOODS_RECEIVED_FROM_OEM', 'received from oem': 'GOODS_RECEIVED_FROM_OEM',
  'sent to customer': 'DISPATCHED_TO_CUSTOMER', 'challan done': 'DISPATCHED_TO_CUSTOMER', 'dispatched to customer': 'DISPATCHED_TO_CUSTOMER',
  closed: 'CLOSED', done: 'CLOSED', complete: 'CLOSED',
  returned: 'CLOSED_RETURNED', rejected: 'CLOSED_RETURNED', 'customer returned': 'CLOSED_RETURNED',
};

export const DEFAULT_SETTINGS = {
  company_email: '',
  company_phone: '',
  company_contact: '',
  company_address: '',
  company_city: '',
  oem_rma_email_to: 'tsc_rma@tscprinters.com',
  oem_rma_email_cc: '',
  oem_rma_email_subject: '{{EXCEL_FILE_STEM}}',
  oem_rma_email_body: [
    'Dear Sir,',
    '',
    'TSC {{PRINTER_MODEL}} printer {{FAULTY_PART}} is damaged. I sent it to you for the RMA please check it',
    '',
    '* {{FAULTY_PART}} Serial Number: {{FAULTY_PART_SERIAL}}',
    '* Printer Serial Number : {{PRINTER_SERIAL}}',
    '* Fault: {{FAULT_DESCRIPTION}}',
    '',
    'Kind regards,',
    '{{COMPANY_NAME}}',
    '{{COMPANY_EMAIL}}',
    '{{COMPANY_PHONE}}',
  ].join('\n'),
  reminder_emails: '1',
  reminder_extra_to: '',
  awaiting_days: '3',
  head_claim_limit: '2',
};
const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);

// ---------- Serial / part normalising (SerialNumberParser.CleanToken + TicketService.NormPart) ----------
export function normSn(raw) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim().replace(/[.:]+$/, '').replace(/\s+/g, '').toUpperCase();
  if (!s) return null;
  if (/^TEB\s*T?\d+$/i.test(s)) s = s.replace(/^TEB\s*T?/i, 'TEBT');
  const peel = s.match(/^(.+?)(84\d{6,})(?:PCS)?$/i);
  if (peel && /[A-Z]/i.test(peel[1])) s = peel[1].toUpperCase();
  return s;
}
export function normPart(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().toUpperCase().split(/\s+/).filter(Boolean).join(' ');
  return s || null;
}

// Fields a person can type on the RMA form, with their limits.
const TICKET_TEXT = [
  ['customer_company', 200, 'Company name'], ['customer_address', 1000, 'Address'], ['customer_city', 100, 'City'],
  ['customer_state', 100, 'State'], ['customer_postal', 20, 'Postal code'], ['customer_country', 100, 'Country'],
  ['customer_contact_name', 150, 'Contact name'], ['customer_phone', 50, 'Phone'], ['po_number', 100, 'PO number'],
  ['ship_to_company', 200, 'Ship-to company'], ['ship_to_address', 1000, 'Ship-to address'], ['ship_to_contact_name', 150, 'Ship-to contact'],
  ['ship_to_phone', 50, 'Ship-to phone'],
  ['printer_model', 100, 'Product model'], ['printer_sn', 100, 'Product serial number'], ['faulty_part', 200, 'Faulty part'],
  ['faulty_part_sn', 100, 'Faulty part SN'], ['faulty_part_no', 100, 'Faulty part number'], ['failure_description', 4000, 'Failure description'],
  ['fw_version', 50, 'Firmware version'], ['flash_initialized', 20, 'Flash initialised'],
];

function addDaysIso(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function httpError(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, extra });
}

export class Company extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  migrate() {
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
    const v = Number(this.one("SELECT value FROM meta WHERE key = 'schema'")?.value || 0);
    if (v >= SCHEMA_VERSION) return;
    if (v < 2) migrateCarePack(this.sql);
    if (v >= 1) {
      if (v < 3) migrateV3(this.sql);
      this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema', ?)", String(SCHEMA_VERSION));
      return;
    }
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_no TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'OPEN',
        is_imported INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        created_by TEXT, updated_by TEXT,
        customer_id INTEGER, model_id INTEGER,
        customer_company TEXT, customer_address TEXT, customer_city TEXT, customer_state TEXT, customer_postal TEXT,
        customer_country TEXT, customer_contact_name TEXT, customer_email TEXT, customer_phone TEXT, po_number TEXT,
        ship_to_company TEXT, ship_to_address TEXT, ship_to_contact_name TEXT, ship_to_email TEXT, ship_to_phone TEXT,
        printer_model TEXT, printer_sn TEXT, printer_sn_norm TEXT, faulty_part TEXT, faulty_part_sn TEXT, faulty_part_sn_norm TEXT,
        faulty_part_no TEXT, failure_description TEXT, tph_mileage REAL, printer_mileage REAL, fw_version TEXT,
        flash_initialized TEXT, purchase_date TEXT, delivery_to_user_date TEXT,
        oem_rma_number TEXT, oem_rma_assign_date TEXT, oem_email_sent_at INTEGER, oem_email_sent_by TEXT,
        excel_generated_at INTEGER, oem_dispatch_date TEXT, batch_code TEXT,
        goods_received_date TEXT, challan_number TEXT, challan_date TEXT, dispatch_to_customer_date TEXT, dispatch_docket TEXT,
        closed_at INTEGER, closure_type TEXT, closure_remarks TEXT,
        dup_reason TEXT, dup_at INTEGER, dup_by TEXT
      );
      CREATE INDEX IF NOT EXISTS tickets_status ON tickets(status);
      CREATE INDEX IF NOT EXISTS tickets_created ON tickets(created_at);
      CREATE INDEX IF NOT EXISTS tickets_psn ON tickets(printer_sn_norm);
      CREATE INDEX IF NOT EXISTS tickets_partsn ON tickets(faulty_part_sn_norm);
      CREATE INDEX IF NOT EXISTS tickets_oemrma ON tickets(oem_rma_number);
      CREATE INDEX IF NOT EXISTS tickets_batch ON tickets(batch_code);
      CREATE TABLE IF NOT EXISTS ticket_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL, at INTEGER NOT NULL,
        by_name TEXT, action TEXT NOT NULL, detail TEXT
      );
      CREATE INDEX IF NOT EXISTS ticket_events_t ON ticket_events(ticket_id);
      CREATE TABLE IF NOT EXISTS photos (
        id TEXT PRIMARY KEY, ticket_id INTEGER NOT NULL, direction TEXT NOT NULL, name TEXT, mime TEXT NOT NULL,
        size INTEGER NOT NULL, store TEXT NOT NULL, notes TEXT, captured_at INTEGER NOT NULL, captured_by TEXT
      );
      CREATE INDEX IF NOT EXISTS photos_ticket ON photos(ticket_id);
      CREATE TABLE IF NOT EXISTS file_chunks (file_id TEXT NOT NULL, seq INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (file_id, seq));
      CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, name TEXT, mime TEXT, size INTEGER, updated_at INTEGER, updated_by TEXT);
      CREATE TABLE IF NOT EXISTS oems (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER);
      CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY AUTOINCREMENT, oem_id INTEGER NOT NULL, code TEXT NOT NULL COLLATE NOCASE,
        name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER, UNIQUE (oem_id, code));
      CREATE TABLE IF NOT EXISTS models (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL, code TEXT NOT NULL COLLATE NOCASE,
        name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER, UNIQUE (product_id, code));
      CREATE TABLE IF NOT EXISTS customers (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name TEXT NOT NULL, state TEXT, city TEXT, address TEXT, postal TEXT, country TEXT, contact_name TEXT,
        email TEXT, phone TEXT, gstin TEXT, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER);
      CREATE INDEX IF NOT EXISTS customers_name ON customers(name COLLATE NOCASE);
      CREATE TABLE IF NOT EXISTS batches (id INTEGER PRIMARY KEY AUTOINCREMENT, batch_code TEXT NOT NULL UNIQUE,
        batch_month TEXT NOT NULL, dispatch_date TEXT NOT NULL, courier TEXT, docket TEXT, remarks TEXT,
        total INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, created_by TEXT);
      CREATE TABLE IF NOT EXISTS import_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, by_name TEXT,
        file_name TEXT, total INTEGER, imported INTEGER, duplicates INTEGER, errors INTEGER, summary TEXT);
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, user_id TEXT, by_name TEXT,
        action TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT, detail TEXT);
      CREATE INDEX IF NOT EXISTS audit_at ON audit(at);
    `);
    migrateV3(this.sql);
    this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema', ?)", String(SCHEMA_VERSION));
  }

  one(q, ...a) { return this.sql.exec(q, ...a).toArray()[0] || null; }
  all(q, ...a) { return this.sql.exec(q, ...a).toArray(); }
  audit(user, action, entity, entityId, detail) {
    this.sql.exec('INSERT INTO audit (at, user_id, by_name, action, entity, entity_id, detail) VALUES (?,?,?,?,?,?,?)',
      Date.now(), user?.userId || null, user?.name || 'System', action, entity, entityId === undefined || entityId === null ? null : String(entityId),
      detail ? JSON.stringify(detail).slice(0, 2000) : null);
  }
  event(ticketId, user, action, detail) {
    this.sql.exec('INSERT INTO ticket_events (ticket_id, at, by_name, action, detail) VALUES (?,?,?,?,?)',
      ticketId, Date.now(), user?.name || 'System', action, detail ? String(detail).slice(0, 1000) : null);
  }

  // RPC entry point; returns { data } or { error } so validation details survive.
  async call(method, user, args = {}) {
    const PERMS = {
      // read: everyone in the company
      bootstrap: 'read', dashboard: 'read', listTickets: 'read', getTicket: 'read', checkDuplicates: 'read', emailContext: 'read',
      deviceHistory: 'read', searchDevices: 'read', bulkClose: 'edit',
      getPhoto: 'read', listBatches: 'read', getBatch: 'read', batchCandidates: 'read', reminders: 'read', getTemplate: 'read',
      listMasters: 'read', importLog: 'read',
      // edit: everyone except Viewer
      createTicket: 'edit', updateTicket: 'edit', deleteTicket: 'edit', ticketAction: 'edit', markExcel: 'edit', recordOemEmail: 'edit',
      putPhoto: 'edit', deletePhoto: 'edit', createBatch: 'edit',
      // manage: Admin and Manager (masters, import)
      saveMaster: 'manage', deleteMaster: 'manage', importTickets: 'manage', importCustomers: 'manage',
      // admin only
      getSettings: 'read', saveSettings: 'admin', putTemplate: 'admin', deleteTemplate: 'admin', auditLog: 'admin',
      // system (cron)
      reminderDigest: 'system',
      // care pack (finer role checks inside each method)
      cpList: 'read', cpRegistry: 'read', cpGet: 'read', cpFindSerial: 'read', cpCustomers: 'read', cpSerials: 'read', cpPending: 'read',
      cpPoCandidates: 'read', cpGetPdf: 'read', cpDraftGet: 'read', cpOverrideLog: 'read',
      cpRegister: 'edit', cpZohoPreview: 'edit', cpUpdateHeader: 'edit', cpUpdateProduct: 'edit', cpOverride: 'edit', cpReplaceSerials: 'edit',
      cpDelete: 'edit', cpOemDetails: 'edit', cpPutPdf: 'edit', cpSetPaid: 'edit', cpRemoveDoc: 'edit', cpPoPreview: 'edit', cpPoConfirm: 'edit',
      cpZohoPos: 'edit', cpDraftSave: 'edit', cpDraftClear: 'edit', createChallan: 'edit',
      migrateStatus: 'admin', migrateMasters: 'admin', migrateTickets: 'admin', migratePhotoCheck: 'admin', migratePhoto: 'admin',
      migrateBatches: 'admin', migrateCarePacks: 'admin', migrateCpPdf: 'admin',
      cpSaveSettings: 'admin', zohoSaveConfig: 'admin', zohoConnect: 'admin', zohoTest: 'admin', zohoDisconnect: 'admin',
    };
    const need = PERMS[method];
    if (!need) return { error: { status: 400, message: 'Unknown action' } };
    const role = user?.role;
    const ok = need === 'read' ? !!role
      : need === 'edit' ? ['Admin', 'Manager', 'Technician'].includes(role)
      : need === 'manage' ? ['Admin', 'Manager'].includes(role)
      : need === 'admin' ? role === 'Admin'
      : need === 'system' ? role === 'System' : false;
    if (!ok) {
      const msg = need === 'edit' ? 'Your role can only view records.'
        : need === 'manage' ? 'Only an Admin or Manager can do this.' : 'Only an Admin can do this.';
      return { error: { status: 403, message: msg } };
    }
    try {
      return { data: await this[method](user, args) };
    } catch (e) {
      if (e instanceof ValidationError) return { error: { status: 422, message: e.message, fields: e.fields } };
      if (e && e.status) return { error: { status: e.status, message: e.message, ...(e.extra || {}) } };
      console.error('company', method, e);
      return { error: { status: 500, message: 'Something went wrong on the server.' } };
    }
  }

  // ---------- Settings ----------
  settings() {
    const out = { ...DEFAULT_SETTINGS, ...CP_DEFAULTS };
    for (const r of this.all("SELECT key, value FROM meta WHERE key LIKE 'set:%'")) out[r.key.slice(4)] = r.value;
    return out;
  }
  getSettings(user) {
    const s = this.settings();
    const tpl = this.one('SELECT name, size, updated_at, updated_by FROM files WHERE id = ?', TEMPLATE_ID);
    return { ...s, ...this.cpSettings(), template: tpl || null };
  }
  saveSettings(user, b) {
    const c = new Checker(b);
    c.email('company_email', { label: 'Company email' }).phone('company_phone', { label: 'Company phone' })
      .text('company_contact', { max: 100, label: 'Contact name' }).text('company_address', { max: 400, label: 'Address' })
      .text('company_city', { max: 100, label: 'City' })
      .text('oem_rma_email_to', { max: 1000, label: 'OEM email To' }).text('oem_rma_email_cc', { max: 1000, label: 'OEM email Cc' })
      .text('oem_rma_email_subject', { max: 300, label: 'Subject template' }).text('oem_rma_email_body', { max: 8000, label: 'Body template' })
      .bool('reminder_emails').text('reminder_extra_to', { max: 1000, label: 'Extra reminder recipients' })
      .number('awaiting_days', { min: 1, max: 60, int: true, label: 'Days before chasing OEM' })
      .number('head_claim_limit', { min: 0, max: 20, int: true, label: 'Print-head RMAs per printer before a reason is needed' });
    const v = c.out;
    for (const k of ['oem_rma_email_to', 'oem_rma_email_cc', 'reminder_extra_to']) {
      const bad = splitEmails(v[k], true).filter((e) => !/^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(e));
      if (bad.length) c.fail(k, `Not a valid email: ${bad[0]}`);
    }
    if (!splitEmails(v.oem_rma_email_to).length) c.fail('oem_rma_email_to', 'Enter at least one OEM email address');
    c.done();
    for (const k of SETTING_KEYS) {
      const val = v[k] === null || v[k] === undefined ? '' : String(v[k]);
      this.sql.exec('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', `set:${k}`, val);
    }
    this.audit(user, 'update', 'settings', null, null);
    return this.getSettings(user);
  }

  // ---------- Bootstrap: lists the screens need ----------
  bootstrap(user) {
    return {
      statuses: ALL_STATUS.map((s) => ({ value: s, label: label(s) })),
      masters: this.listMasters(user),
      settings: this.getSettings(user),
      carePack: this.cpMeta(),
    };
  }

  // ---------- Masters ----------
  listMasters() {
    return {
      oems: this.all('SELECT * FROM oems ORDER BY active DESC, name COLLATE NOCASE'),
      products: this.all('SELECT * FROM products ORDER BY active DESC, name COLLATE NOCASE'),
      models: this.all('SELECT * FROM models ORDER BY active DESC, code COLLATE NOCASE'),
      customers: this.all('SELECT * FROM customers ORDER BY active DESC, name COLLATE NOCASE'),
      cp_types: this.all('SELECT * FROM cp_types ORDER BY active DESC, duration_years, name COLLATE NOCASE'),
      categories: this.all('SELECT * FROM categories ORDER BY active DESC, id'),
    };
  }

  saveMaster(user, { kind, record }) {
    const now = Date.now();
    const r = record || {};
    const id = r.id ? Number(r.id) : null;
    if (kind === 'oems') {
      const v = new Checker(r).text('code', { required: true, max: 40, label: 'Code' }).text('name', { required: true, max: 200, label: 'Name' }).bool('active').done();
      v.code = v.code.toUpperCase();
      const clash = this.one('SELECT id FROM oems WHERE code = ? AND id != ?', v.code, id || 0);
      if (clash) throw new ValidationError({ code: 'Another OEM already uses this code' });
      if (id) this.sql.exec('UPDATE oems SET code = ?, name = ?, active = ? WHERE id = ?', v.code, v.name, v.active, id);
      else this.sql.exec('INSERT INTO oems (code, name, active, created_at) VALUES (?,?,1,?)', v.code, v.name, now);
    } else if (kind === 'products') {
      const v = new Checker(r).int('oem_id', { required: true, label: 'OEM' }).text('code', { required: true, max: 40, label: 'Code' })
        .text('name', { required: true, max: 200, label: 'Name' }).bool('active').done();
      v.code = v.code.toUpperCase();
      if (!this.one('SELECT 1 AS x FROM oems WHERE id = ?', v.oem_id)) throw new ValidationError({ oem_id: 'Choose an OEM' });
      if (this.one('SELECT id FROM products WHERE oem_id = ? AND code = ? AND id != ?', v.oem_id, v.code, id || 0)) {
        throw new ValidationError({ code: 'This OEM already has a product with this code' });
      }
      if (id) this.sql.exec('UPDATE products SET oem_id = ?, code = ?, name = ?, active = ? WHERE id = ?', v.oem_id, v.code, v.name, v.active, id);
      else this.sql.exec('INSERT INTO products (oem_id, code, name, active, created_at) VALUES (?,?,?,1,?)', v.oem_id, v.code, v.name, now);
    } else if (kind === 'models') {
      const v = new Checker(r).int('product_id', { required: true, label: 'Product' }).text('code', { required: true, max: 40, label: 'Model code' })
        .text('name', { required: true, max: 200, label: 'Name' }).int('category_id', { label: 'Category' }).bool('active').done();
      if (!this.one('SELECT 1 AS x FROM products WHERE id = ?', v.product_id)) throw new ValidationError({ product_id: 'Choose a product' });
      if (v.category_id && !this.one('SELECT 1 AS x FROM categories WHERE id = ?', v.category_id)) throw new ValidationError({ category_id: 'Choose a category' });
      if (this.one('SELECT id FROM models WHERE product_id = ? AND code = ? AND id != ?', v.product_id, v.code, id || 0)) {
        throw new ValidationError({ code: 'This product already has a model with this code' });
      }
      if (id) this.sql.exec('UPDATE models SET product_id = ?, code = ?, name = ?, category_id = ?, active = ? WHERE id = ?', v.product_id, v.code, v.name, v.category_id || null, v.active, id);
      else this.sql.exec('INSERT INTO models (product_id, code, name, category_id, active, created_at) VALUES (?,?,?,?,1,?)', v.product_id, v.code, v.name, v.category_id || null, now);
    } else if (kind === 'categories') {
      const v = new Checker(r).text('code', { required: true, max: 20, label: 'Code' }).text('name', { required: true, max: 80, label: 'Name' })
        .bool('has_head').bool('active').done();
      v.code = v.code.toUpperCase();
      if (this.one('SELECT id FROM categories WHERE code = ? AND id != ?', v.code, id || 0)) throw new ValidationError({ code: 'Another category already uses this code' });
      if (this.one('SELECT id FROM categories WHERE name = ? AND id != ?', v.name, id || 0)) throw new ValidationError({ name: 'This category already exists' });
      if (id) {
        this.sql.exec('UPDATE categories SET code = ?, name = ?, has_head = ?, active = ? WHERE id = ?', v.code, v.name, v.has_head ? 1 : 0, v.active, id);
        this.sql.exec('UPDATE tickets SET category = ? WHERE category_id = ?', v.name, id);
      } else this.sql.exec('INSERT INTO categories (code, name, has_head, active, created_at) VALUES (?,?,?,1,?)', v.code, v.name, v.has_head ? 1 : 0, now);
    } else if (kind === 'customers') {
      const v = this.checkCustomer(r);
      if (!v.code) v.code = this.nextCustomerCode();
      if (this.one('SELECT id FROM customers WHERE code = ? AND id != ?', v.code, id || 0)) throw new ValidationError({ code: 'Another customer already uses this code' });
      const cols = ['code', 'name', 'state', 'city', 'address', 'postal', 'country', 'contact_name', 'email', 'phone', 'gstin'];
      if (id) {
        this.sql.exec(`UPDATE customers SET ${cols.map((c) => `${c} = ?`).join(', ')}, active = ? WHERE id = ?`, ...cols.map((c) => v[c]), v.active, id);
      } else {
        this.sql.exec(`INSERT INTO customers (${cols.join(', ')}, active, created_at) VALUES (${cols.map(() => '?').join(',')}, 1, ?)`, ...cols.map((c) => v[c]), now);
      }
    } else if (kind === 'cp_types') {
      const v = new Checker(r).text('name', { required: true, max: 80, label: 'Name' }).number('duration_years', { required: true, min: 1, max: 10, int: true, label: 'Duration years' }).bool('active').done();
      if (this.one('SELECT id FROM cp_types WHERE name = ? AND id != ?', v.name, id || 0)) throw new ValidationError({ name: `Care pack type '${v.name}' already exists.` });
      if (id) this.sql.exec('UPDATE cp_types SET name = ?, duration_years = ?, active = ? WHERE id = ?', v.name, v.duration_years, v.active, id);
      else this.sql.exec('INSERT INTO cp_types (name, duration_years, active, created_at) VALUES (?,?,1,?)', v.name, v.duration_years, now);
    } else {
      throw httpError(400, 'Unknown list');
    }
    this.audit(user, id ? 'update' : 'create', kind, id, { code: r.code, name: r.name });
    return this.listMasters(user);
  }

  checkCustomer(r) {
    const c = new Checker(r).text('code', { max: 40, label: 'Code' }).text('name', { required: true, max: 200, label: 'Name' })
      .text('state', { max: 100, label: 'State' }).text('city', { max: 100, label: 'City' }).text('address', { max: 1000, label: 'Address' })
      .text('postal', { max: 20, label: 'Postal code' }).text('country', { max: 100, label: 'Country' })
      .text('contact_name', { max: 150, label: 'Contact name' }).email('email').phone('phone').gstin('gstin').bool('active');
    const v = c.done();
    if (v.code) v.code = v.code.toUpperCase();
    if (!v.country) v.country = 'India';
    return v;
  }
  nextCustomerCode() {
    const n = Number(this.one("SELECT value FROM meta WHERE key = 'seq:customer'")?.value || 0) + 1;
    let code;
    let i = n;
    do { code = `C${String(i).padStart(5, '0')}`; i++; } while (this.one('SELECT 1 AS x FROM customers WHERE code = ?', code));
    this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('seq:customer', ?)", String(i - 1));
    return code;
  }

  deleteMaster(user, { kind, id }) {
    id = Number(id);
    const uses = {
      oems: () => this.one('SELECT COUNT(*) AS n FROM products WHERE oem_id = ?', id).n,
      products: () => this.one('SELECT COUNT(*) AS n FROM models WHERE product_id = ?', id).n,
      models: () => this.one('SELECT COUNT(*) AS n FROM tickets WHERE model_id = ?', id).n + this.one('SELECT COUNT(*) AS n FROM cp_batches WHERE model_id = ?', id).n,
      customers: () => this.one('SELECT COUNT(*) AS n FROM tickets WHERE customer_id = ?', id).n
        + this.one('SELECT COUNT(*) AS n FROM cp_batches WHERE customer_id = ?', id).n,
      cp_types: () => this.one('SELECT COUNT(*) AS n FROM cp_batches WHERE cp_type_id = ?', id).n,
      categories: () => this.one('SELECT COUNT(*) AS n FROM tickets WHERE category_id = ?', id).n + this.one('SELECT COUNT(*) AS n FROM models WHERE category_id = ?', id).n,
    }[kind];
    if (!uses) throw httpError(400, 'Unknown list');
    const n = uses();
    if (n) throw httpError(409, `In use by ${n} record${n === 1 ? '' : 's'}. Mark it inactive instead.`);
    this.sql.exec(`DELETE FROM ${kind} WHERE id = ?`, id);
    this.audit(user, 'delete', kind, id, null);
    return this.listMasters(user);
  }

  importCustomers(user, { rows }) {
    if (!Array.isArray(rows) || !rows.length) throw new ValidationError({ _: 'No rows to import' });
    if (rows.length > 2000) throw new ValidationError({ _: 'Import at most 2000 customers at a time' });
    let added = 0, updated = 0;
    const errors = [];
    const now = Date.now();
    const cols = ['name', 'state', 'city', 'address', 'postal', 'country', 'contact_name', 'email', 'phone', 'gstin'];
    rows.forEach((r, i) => {
      try {
        const v = this.checkCustomer({ ...r, active: true });
        const existing = v.code ? this.one('SELECT id FROM customers WHERE code = ?', v.code)
          : this.one('SELECT id FROM customers WHERE name = ? COLLATE NOCASE', v.name);
        if (existing) {
          this.sql.exec(`UPDATE customers SET ${cols.map((c) => `${c} = COALESCE(?, ${c})`).join(', ')} WHERE id = ?`, ...cols.map((c) => v[c]), existing.id);
          updated++;
        } else {
          const code = v.code || this.nextCustomerCode();
          this.sql.exec(`INSERT INTO customers (code, ${cols.join(', ')}, active, created_at) VALUES (?, ${cols.map(() => '?').join(',')}, 1, ?)`, code, ...cols.map((c) => v[c]), now);
          added++;
        }
      } catch (e) {
        errors.push(`Row ${i + 2}: ${e.fields ? Object.values(e.fields).join('; ') : e.message}`);
      }
    });
    this.audit(user, 'import', 'customers', null, { added, updated, errors: errors.length });
    return { added, updated, errors: errors.slice(0, 50), masters: this.listMasters(user) };
  }

  // ---------- Ticket numbers: {PREFIX}-RMA-YYYYMM-NNNN ----------
  nextTicketNo(prefix, ym) {
    const key = `seq:${prefix}-${ym}`;
    let n = Number(this.one('SELECT value FROM meta WHERE key = ?', key)?.value || 0);
    let no;
    do { n++; no = `${prefix}-RMA-${ym}-${String(n).padStart(4, '0')}`; } while (this.one('SELECT 1 AS x FROM tickets WHERE ticket_no = ?', no));
    this.sql.exec('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', key, String(n));
    return no;
  }

  // ---------- Duplicate check (TicketService.CheckOpenDuplicatesAsync) ----------
  checkDuplicates(user, { printer_sn, faulty_part, faulty_part_no, faulty_part_sn, excludeId, category_id, model_id }) {
    const productSn = normSn(printer_sn);
    const partSn = normSn(faulty_part_sn);
    if (!productSn && !partSn) return { blocks: [], sameMachine: [], heads: null };
    const heads = this.headCheck({ printer_sn_norm: productSn, faulty_part, category_id: Number(category_id) || null, model_id: Number(model_id) || null }, excludeId);
    const open = this.all(
      `SELECT id, ticket_no, status, printer_sn, printer_sn_norm, faulty_part, faulty_part_no, faulty_part_sn, faulty_part_sn_norm, created_at
       FROM tickets WHERE closed_at IS NULL AND status NOT IN ('CLOSED','CLOSED_RETURNED') AND id != ?
         AND ((printer_sn_norm IS NOT NULL AND printer_sn_norm = ?) OR (faulty_part_sn_norm IS NOT NULL AND faulty_part_sn_norm = ?))
       ORDER BY created_at DESC LIMIT 200`,
      Number(excludeId || 0), productSn || '\u0000', partSn || '\u0000');
    const partKey = normPart(faulty_part);
    const partNo = normPart(faulty_part_no);
    const blocks = [];
    const sameMachine = [];
    const brief = (t) => ({ id: t.id, ticket_no: t.ticket_no, status: t.status, status_label: label(t.status), faulty_part: t.faulty_part,
      faulty_part_sn: t.faulty_part_sn, printer_sn: t.printer_sn, created_at: t.created_at });
    for (const t of open) {
      const tag = `${t.ticket_no} (${label(t.status)})`;
      if (partSn && t.faulty_part_sn_norm && partSn === t.faulty_part_sn_norm) {
        blocks.push({ ticket: brief(t), kind: 'SamePartSerial',
          reason: `Part serial ${t.faulty_part_sn_norm} is already on open RMA ${tag} for printer ${t.printer_sn || '—'}. One physical part should not be on two open RMAs.` });
        continue;
      }
      if (!(productSn && t.printer_sn_norm && productSn === t.printer_sn_norm)) continue;
      if (samePartOnMachine(partKey, partNo, partSn, t)) {
        blocks.push({ ticket: brief(t), kind: 'SamePartOnMachine', reason: samePartReason(t, tag, partSn) });
      } else {
        sameMachine.push(brief(t));
      }
    }
    return { blocks: blocks.slice(0, 20), sameMachine: sameMachine.slice(0, 20), heads };
  }

  // ---------- Tickets ----------
  checkTicket(b, { requireCore = true } = {}) {
    const c = new Checker(b);
    for (const [k, max, lbl] of TICKET_TEXT) c.text(k, { max, label: lbl });
    c.email('customer_email', { label: 'Email' }).email('ship_to_email', { label: 'Ship-to email' })
      .number('tph_mileage', { min: 0, max: 1e7, label: 'TPH mileage' }).number('printer_mileage', { min: 0, max: 1e8, label: 'Printer mileage' })
      .date('purchase_date', { label: 'Purchase date', notFuture: true }).date('delivery_to_user_date', { label: 'Delivery to user date', notFuture: true })
      .int('customer_id', { label: 'Customer' }).int('model_id', { label: 'Model' }).int('category_id', { label: 'Device category' });
    if (requireCore) {
      if (!c.out.customer_company) c.fail('customer_company', 'Company name is required');
      if (!c.out.printer_model) c.fail('printer_model', 'Product model is required');
      if (!c.out.printer_sn) c.fail('printer_sn', 'Product serial number is required');
      if (!c.out.faulty_part) c.fail('faulty_part', 'Faulty part is required');
      if (!c.out.failure_description) c.fail('failure_description', 'Failure description is required');
    }
    const v = c.done();
    if (v.customer_id && !this.one('SELECT 1 AS x FROM customers WHERE id = ?', v.customer_id)) v.customer_id = null;
    if (v.model_id && !this.one('SELECT 1 AS x FROM models WHERE id = ?', v.model_id)) v.model_id = null;
    this.resolveCategory(v);
    if (!v.customer_country) v.customer_country = 'India';
    if (v.printer_sn) v.printer_sn = normSn(v.printer_sn);
    if (v.faulty_part_sn) v.faulty_part_sn = normSn(v.faulty_part_sn);
    v.printer_sn_norm = normSn(v.printer_sn);
    v.faulty_part_sn_norm = normSn(v.faulty_part_sn);
    return v;
  }

  // Poka-yoke gate: duplicates block unless an Admin or authorised user gives a reason.
  applyDuplicateGate(user, v, overrideReason, excludeId) {
    const check = this.checkDuplicates(user, { ...v, excludeId });
    if (!check.blocks.length) return {};
    const reasons = check.blocks.slice(0, 3).map((b) => b.reason).join(' ');
    if (!overrideReason || !String(overrideReason).trim()) {
      throw httpError(409, `Duplicate RMA blocked. ${reasons} Close the existing ticket, or ask an Admin or authorised user to override with a reason.`,
        { code: 'duplicate', duplicates: check });
    }
    if (!user.dupOverride) {
      throw httpError(403, `Duplicate RMA blocked. ${reasons} Only an Admin or a user granted 'Duplicate RMA override' can override this.`,
        { code: 'duplicate', duplicates: check });
    }
    return {
      dup_reason: `${String(overrideReason).trim().slice(0, 500)} [overrode: ${check.blocks.map((b) => b.reason).join('; ')}]`.slice(0, 3000),
      dup_by: `${user.name} (${user.role})`,
      dup_at: Date.now(),
    };
  }

  createTicket(user, { ticket, overrideReason, addToCarePack, headReason }) {
    const v = this.checkTicket(ticket);
    // New RMAs: the customer is chosen from the customer list (dropdown), so names stay consistent for reports.
    const cust = v.customer_id ? this.one('SELECT id, name, active FROM customers WHERE id = ?', v.customer_id) : null;
    if (!cust || !cust.active) throw new ValidationError({ customer_company: 'Choose the customer from the list. An Admin or Manager can add a new customer.' });
    v.customer_company = cust.name;
    const device = this.cpEnsureEligible(v.printer_sn);
    const dup = this.applyDuplicateGate(user, v, overrideReason, 0);
    const head = this.applyHeadGate(user, v, headReason);
    if (!device && addToCarePack) {
      this.cpAddOverrideSerial(user, { serial: v.printer_sn, reason: addToCarePack.reason, batchId: addToCarePack.batchId, customer: v.customer_company, model: v.printer_model });
    }
    const now = Date.now();
    const ticketNo = this.nextTicketNo(user.ticketPrefix || 'INF', istParts(now).ym);
    const row = { ...v, ...dup, ...head, ticket_no: ticketNo, status: STATUS.OPEN, created_at: now, updated_at: now, created_by: user.name, updated_by: user.name };
    const cols = Object.keys(row);
    this.sql.exec(`INSERT INTO tickets (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(',')})`, ...cols.map((k) => row[k]));
    const id = this.one('SELECT last_insert_rowid() AS id').id;
    this.event(id, user, 'created', [dup.dup_reason ? `Duplicate override: ${overrideReason}` : null,
      head.head_override_reason ? `Print-head limit override: ${String(headReason).trim()}` : null].filter(Boolean).join(' · ') || null);
    this.audit(user, 'create', 'ticket', id, { ticketNo, dupOverride: !!dup.dup_reason, headOverride: !!head.head_override_reason });
    return this.getTicket(user, { id });
  }

  updateTicket(user, { id, ticket }) {
    const t = this.ticketRow(id);
    if (CLOSED_SET.includes(t.status) && user.role !== 'Admin') throw httpError(409, 'This RMA is closed. Only an Admin can edit a closed RMA.');
    const v = this.checkTicket(ticket);
    const changed = Object.keys(v).filter((k) => String(v[k] ?? '') !== String(t[k] ?? '') && !k.endsWith('_norm'));
    if (!changed.length) return this.getTicket(user, { id });
    // Re-check duplicates only when the serial / part identity changed.
    const idKeys = ['printer_sn', 'faulty_part', 'faulty_part_no', 'faulty_part_sn'];
    let dup = {};
    if (idKeys.some((k) => changed.includes(k)) && !CLOSED_SET.includes(t.status)) {
      const check = this.checkDuplicates(user, { ...v, excludeId: t.id });
      if (check.blocks.length) {
        throw httpError(409, `This change would make a duplicate open RMA. ${check.blocks.slice(0, 2).map((b) => b.reason).join(' ')}`,
          { code: 'duplicate', duplicates: check });
      }
      dup = {};
    }
    const row = { ...v, ...dup, updated_at: Date.now(), updated_by: user.name };
    const cols = Object.keys(row);
    this.sql.exec(`UPDATE tickets SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...cols.map((k) => row[k]), t.id);
    this.event(t.id, user, 'edited', `Changed: ${changed.map((k) => k.replace(/_/g, ' ')).join(', ')}`);
    this.audit(user, 'update', 'ticket', t.id, { changed });
    return this.getTicket(user, { id });
  }

  ticketRow(id) {
    const t = this.one('SELECT * FROM tickets WHERE id = ?', Number(id));
    if (!t) throw httpError(404, 'RMA not found.');
    return t;
  }

  getTicket(user, { id }) {
    const t = this.ticketRow(id);
    const photos = this.all('SELECT id, direction, name, mime, size, notes, captured_at, captured_by FROM photos WHERE ticket_id = ? ORDER BY captured_at, id', t.id);
    const events = this.all('SELECT at, by_name, action, detail FROM ticket_events WHERE ticket_id = ? ORDER BY at DESC, id DESC LIMIT 100', t.id);
    const sameMachine = t.printer_sn_norm ? this.all(
      `SELECT id, ticket_no, status, faulty_part, faulty_part_sn, created_at FROM tickets
       WHERE printer_sn_norm = ? AND id != ? AND closed_at IS NULL AND status NOT IN ('CLOSED','CLOSED_RETURNED') ORDER BY created_at DESC LIMIT 20`,
      t.printer_sn_norm, t.id).map((r) => ({ ...r, status_label: label(r.status) })) : [];
    const history = t.printer_sn_norm ? this.one('SELECT COUNT(*) AS n FROM tickets WHERE printer_sn_norm = ? AND id != ?', t.printer_sn_norm, t.id).n : 0;
    const del = this.canDelete(user, t);
    const cover = t.printer_sn ? this.cpFindSerial(user, { sn: t.printer_sn, loose: false }).device : null;
    return {
      ticket: { ...t, status_label: label(t.status) }, photos, events, sameMachine, otherTicketsOnPrinter: history, cover,
      canDelete: del.ok, deleteHint: del.reason, nextActions: this.nextActions(t),
    };
  }

  // Which status buttons make sense now (mirrors RMADetail.razor).
  nextActions(t) {
    switch (t.status) {
      case STATUS.OPEN: return ['mark_sent', 'oem_rma'];
      case STATUS.AWAITING: return ['oem_rma'];
      case STATUS.OEM_RECEIVED: return ['goods_received'];
      case STATUS.DISPATCHED_OEM: return ['goods_received'];
      case STATUS.GOODS_RECEIVED: return ['dispatch_customer'];
      case STATUS.DISPATCHED_CUSTOMER: return ['close', 'close_returned'];
      default: return [];
    }
  }

  ticketAction(user, { id, action, data = {} }) {
    const t = this.ticketRow(id);
    if (!this.nextActions(t).includes(action)) {
      throw httpError(409, `That step is not possible while the RMA is "${label(t.status)}". Reload to see the latest status.`);
    }
    const now = Date.now();
    const d = today();
    let set = {};
    let note = null;
    if (action === 'mark_sent') {
      set = { status: STATUS.AWAITING };
    } else if (action === 'oem_rma') {
      const v = new Checker(data).text('oem_rma_number', { required: true, max: 100, label: 'OEM RMA number' })
        .date('oem_rma_assign_date', { label: 'Date received', notFuture: true }).done();
      const clash = this.one('SELECT ticket_no FROM tickets WHERE oem_rma_number = ? COLLATE NOCASE AND id != ?', v.oem_rma_number, t.id);
      if (clash && !data.allowSame) {
        throw httpError(409, `OEM RMA # ${v.oem_rma_number} is already on ${clash.ticket_no}. Check the number, or confirm it covers both.`, { code: 'oem_rma_used', field: 'oem_rma_number' });
      }
      set = { status: STATUS.OEM_RECEIVED, oem_rma_number: v.oem_rma_number, oem_rma_assign_date: v.oem_rma_assign_date || d };
      note = v.oem_rma_number;
    } else if (action === 'goods_received') {
      const v = new Checker(data).date('goods_received_date', { label: 'Date received', notFuture: true }).done();
      set = { status: STATUS.GOODS_RECEIVED, goods_received_date: v.goods_received_date || d };
    } else if (action === 'dispatch_customer') {
      const v = new Checker(data).date('dispatch_to_customer_date', { label: 'Dispatch date', notFuture: true })
        .text('challan_number', { max: 100, label: 'Challan number' }).date('challan_date', { label: 'Challan date', notFuture: true })
        .text('dispatch_docket', { max: 200, label: 'Courier / docket' }).done();
      set = { status: STATUS.DISPATCHED_CUSTOMER, dispatch_to_customer_date: v.dispatch_to_customer_date || d,
        challan_number: v.challan_number, challan_date: v.challan_date || (v.challan_number ? d : null), dispatch_docket: v.dispatch_docket };
      note = [v.challan_number && `Challan ${v.challan_number}`, v.dispatch_docket].filter(Boolean).join(' · ') || null;
    } else if (action === 'close' || action === 'close_returned') {
      const v = new Checker(data).text('closure_remarks', { max: 2000, label: 'Remarks' }).done();
      set = { status: action === 'close' ? STATUS.CLOSED : STATUS.CLOSED_RETURNED, closed_at: now,
        closure_type: action === 'close' ? 'REPAIRED' : 'RETURNED', closure_remarks: v.closure_remarks };
      note = v.closure_remarks;
    }
    set.updated_at = now;
    set.updated_by = user.name;
    const cols = Object.keys(set);
    this.sql.exec(`UPDATE tickets SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...cols.map((k) => set[k]), t.id);
    this.event(t.id, user, `status: ${label(set.status)}`, note);
    this.audit(user, action, 'ticket', t.id, { from: t.status, to: set.status });
    return this.getTicket(user, { id: t.id });
  }

  // Poka-yoke: delete only before the OEM dispatch chain starts (TicketService.CanDeleteTicketAsync).
  canDelete(user, t) {
    if (!['Admin', 'Manager', 'Technician'].includes(user.role)) return { ok: false, reason: 'Your role cannot delete RMA tickets.' };
    if (t.batch_code) return { ok: false, reason: `Cannot delete — ticket is in OEM batch ${t.batch_code}.` };
    if (t.oem_dispatch_date) return { ok: false, reason: 'Cannot delete — OEM dispatch date is recorded.' };
    if (t.challan_number || t.challan_date) return { ok: false, reason: 'Cannot delete — delivery challan already recorded.' };
    if (t.dispatch_to_customer_date) return { ok: false, reason: 'Cannot delete — already dispatched to customer.' };
    if (t.closed_at || CLOSED_SET.includes(t.status)) return { ok: false, reason: 'Cannot delete — ticket is closed.' };
    if ([STATUS.DISPATCHED_OEM, STATUS.GOODS_RECEIVED, STATUS.DISPATCHED_CUSTOMER].includes(t.status)) {
      return { ok: false, reason: `Cannot delete — status is ${label(t.status)} (OEM chain started).` };
    }
    if (t.status === STATUS.OEM_RECEIVED || t.oem_rma_number) {
      if (user.role !== 'Admin') return { ok: false, reason: 'Cannot delete — OEM RMA # is assigned. Ask an Admin to delete.' };
      return { ok: true, reason: 'Admin may delete (OEM RMA assigned — confirm carefully).' };
    }
    if ([STATUS.OPEN, STATUS.AWAITING].includes(t.status)) return { ok: true, reason: 'Safe to delete — not yet dispatched to OEM.' };
    return { ok: false, reason: `Cannot delete — status is ${label(t.status)}.` };
  }

  deleteTicket(user, { id }) {
    const t = this.ticketRow(id);
    const d = this.canDelete(user, t);
    if (!d.ok) throw httpError(409, d.reason);
    const photos = this.all('SELECT id, store FROM photos WHERE ticket_id = ?', t.id);
    for (const p of photos) this.sql.exec('DELETE FROM file_chunks WHERE file_id = ?', p.id);
    this.sql.exec('DELETE FROM photos WHERE ticket_id = ?', t.id);
    this.sql.exec('DELETE FROM ticket_events WHERE ticket_id = ?', t.id);
    this.sql.exec('DELETE FROM tickets WHERE id = ?', t.id);
    this.audit(user, 'delete', 'ticket', t.id, { ticketNo: t.ticket_no, status: t.status });
    return { ok: true, r2Photos: photos.filter((p) => p.store === 'r2').map((p) => p.id) };
  }

  listTickets(user, { status = '', q = '', from = '', to = '', customer = '', open = '', show = '', limit = 500, batch = '', view = '', category = '' } = {}) {
    const where = [];
    const args = [];
    // Saved views on the RMA list.
    if (view === 'mine') { where.push('created_by = ?'); args.push(user.name); }
    if (view === 'late') { where.push("status = 'DISPATCHED_TO_OEM' AND oem_dispatch_date IS NOT NULL AND oem_dispatch_date <= ?"); args.push(addDaysIso(today(), -30)); }
    if (view === 'closedmonth') { where.push('closed_at >= ?'); args.push(Date.parse(today().slice(0, 8) + '01T00:00:00+05:30')); }
    if (view === 'heads') { where.push("head_override_reason IS NOT NULL"); }
    if (category && /^\d+$/.test(String(category))) { where.push('category_id = ?'); args.push(Number(category)); }
    if (status && ALL_STATUS.includes(status)) { where.push('status = ?'); args.push(status); }
    if (open === '1') where.push("status NOT IN ('CLOSED','CLOSED_RETURNED')");
    // "Active only": hides completed RMAs (closed, or sent back to the customer). A chosen stage always wins.
    if (show === 'active' && !status && view !== 'closedmonth') where.push(`status NOT IN (${COMPLETED.map(() => '?').join(',')})`), args.push(...COMPLETED);
    if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) { where.push('created_at >= ?'); args.push(Date.parse(from + 'T00:00:00+05:30')); }
    if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) { where.push('created_at <= ?'); args.push(Date.parse(to + 'T23:59:59+05:30')); }
    if (customer) { where.push('customer_company LIKE ?'); args.push(`%${String(customer).slice(0, 100)}%`); }
    if (batch) { where.push('batch_code = ?'); args.push(String(batch).slice(0, 40)); }
    if (q) {
      const s = `%${String(q).trim().slice(0, 100)}%`;
      const sn = normSn(q);
      where.push(`(ticket_no LIKE ? OR printer_sn LIKE ? OR customer_company LIKE ? OR oem_rma_number LIKE ? OR printer_model LIKE ?
        OR faulty_part LIKE ? OR faulty_part_sn LIKE ? OR po_number LIKE ? OR challan_number LIKE ?${sn ? ' OR printer_sn_norm = ? OR faulty_part_sn_norm = ?' : ''})`);
      args.push(s, s, s, s, s, s, s, s, s);
      if (sn) args.push(sn, sn);
    }
    const lim = Math.min(Math.max(Number(limit) || 500, 1), 5000);
    const rows = this.all(
      `SELECT t.*, (SELECT COUNT(*) FROM photos p WHERE p.ticket_id = t.id AND p.direction = 'INBOUND') AS inbound_photos,
              (SELECT COUNT(*) FROM photos p WHERE p.ticket_id = t.id AND p.direction = 'OUTBOUND') AS outbound_photos
       FROM tickets t ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`, ...args, lim + 1);
    const more = rows.length > lim;
    return {
      rows: rows.slice(0, lim).map((r) => {
        delete r.printer_sn_norm; delete r.faulty_part_sn_norm;
        return { ...r, status_label: label(r.status) };
      }),
      more,
    };
  }

  // Close many finished RMAs at once (old ones sent back to the customer, imported history…). Admin and Manager.
  bulkClose(user, { ids, type = 'close', remarks = '' } = {}) {
    if (!['Admin', 'Manager'].includes(user.role)) throw Object.assign(new Error('Only an Admin or Manager can close RMAs in bulk.'), { status: 403 });
    const list = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!list.length) throw new ValidationError({ ids: 'Select at least one RMA' });
    if (list.length > 1000) throw new ValidationError({ ids: 'Close at most 1000 at a time' });
    const why = String(remarks || '').trim().slice(0, 500);
    if (!why) throw new ValidationError({ remarks: 'Give a remark, e.g. "Delivered to customer, old RMAs closed"' });
    const toStatus = type === 'close_returned' ? STATUS.CLOSED_RETURNED : STATUS.CLOSED;
    const now = Date.now();
    let closed = 0;
    const skipped = [];
    for (const id of list) {
      const t = this.one('SELECT id, ticket_no, status FROM tickets WHERE id = ?', id);
      if (!t) continue;
      if (t.status === STATUS.CLOSED || t.status === STATUS.CLOSED_RETURNED) { skipped.push(t.ticket_no); continue; }
      this.sql.exec(`UPDATE tickets SET status = ?, closed_at = ?, closure_type = ?, closure_remarks = ?, updated_at = ?, updated_by = ? WHERE id = ?`,
        toStatus, now, toStatus === STATUS.CLOSED ? 'REPAIRED' : 'RETURNED', why, now, user.name, id);
      this.event(id, user, `status: ${label(toStatus)} (bulk close, was ${label(t.status)})`, why);
      closed++;
    }
    this.audit(user, 'bulk_close', 'ticket', null, { closed, skipped: skipped.length, to: toStatus });
    return { closed, skipped };
  }

  // ---------- Dashboard ----------
  dashboard(user, { show = '' } = {}) {
    const counts = Object.fromEntries(ALL_STATUS.map((s) => [s, 0]));
    for (const r of this.all('SELECT status, COUNT(*) AS n FROM tickets GROUP BY status')) counts[r.status] = r.n;
    const now = Date.now();
    const monthStart = Date.parse(today().slice(0, 8) + '01T00:00:00+05:30');
    const openRows = this.all("SELECT created_at FROM tickets WHERE status NOT IN ('CLOSED','CLOSED_RETURNED')");
    const ages = { under7: 0, d7to30: 0, over30: 0 };
    for (const r of openRows) {
      const d = (now - r.created_at) / 86400000;
      if (d < 7) ages.under7++; else if (d <= 30) ages.d7to30++; else ages.over30++;
    }
    const closedThisMonth = this.one("SELECT COUNT(*) AS n FROM tickets WHERE closed_at >= ?", monthStart).n;
    const createdThisMonth = this.one('SELECT COUNT(*) AS n FROM tickets WHERE created_at >= ?', monthStart).n;
    const avgClose = this.one('SELECT AVG(closed_at - created_at) AS ms FROM tickets WHERE closed_at IS NOT NULL AND closed_at >= ?', now - 180 * 86400000).ms;
    const recent = this.all(`SELECT id, ticket_no, status, customer_company, printer_model, printer_sn, faulty_part, created_at, updated_at FROM tickets
      ${show === 'active' ? `WHERE status NOT IN (${COMPLETED.map((c) => `'${c}'`).join(',')})` : ''} ORDER BY updated_at DESC LIMIT 8`)
      .map((r) => ({ ...r, status_label: label(r.status) }));
    const topParts = this.all(`SELECT faulty_part AS name, COUNT(*) AS n FROM tickets WHERE created_at >= ? AND faulty_part IS NOT NULL
      GROUP BY UPPER(faulty_part) ORDER BY n DESC LIMIT 5`, now - 365 * 86400000);
    const [y, m] = today().split('-').map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return {
      counts, open: openRows.length, ages, closedThisMonth, createdThisMonth,
      avgCloseDays: avgClose ? Math.round(avgClose / 86400000) : null,
      recent, topParts,
      reminders: this.reminders(user).items.length + this.cpReminders().length,
      ...this.workQueue(user),
      carePack: this.cpDashboard(),
      batchReady: counts.OEM_RMA_RECEIVED,
      lastWeekOfMonth: Number(today().slice(8, 10)) >= lastDay - 6,
      total: Object.values(counts).reduce((a, b) => a + b, 0),
    };
  }

  // Dashboard "Needs your next step": reminders plus RMAs waiting at the OEM for a long time, oldest first, each with its action.
  workQueue(user) {
    const now = Date.now();
    const items = this.reminders(user).items.map((i) => ({ ...i }));
    for (const t of this.all(`SELECT id, ticket_no, customer_company, printer_model, printer_sn, faulty_part, created_at, oem_dispatch_date
      FROM tickets WHERE status = 'DISPATCHED_TO_OEM' AND oem_dispatch_date IS NOT NULL`)) {
      const d = daysBetween(t.oem_dispatch_date, today());
      if (d >= 30) {
        items.push({ id: t.id, ticket_no: t.ticket_no, customer: t.customer_company || '—', serial: t.printer_sn || '—', model: t.printer_model,
          part: t.faulty_part, age: Math.floor((now - t.created_at) / 86400000), kind: `At OEM ${d} days — chase`, tone: 'late' });
      }
    }
    const action = (k) => (/Excel/.test(k) ? 'Make OEM Excel' : /email/i.test(k) ? 'Email OEM' : /Awaiting OEM RMA/.test(k) ? 'Add OEM RMA'
      : /dispatch to OEM/.test(k) ? 'Dispatch to OEM' : /send to customer/.test(k) ? 'Send to customer' : /chase/.test(k) ? 'Chase OEM' : 'Open');
    items.sort((a, b) => (b.tone === 'late') - (a.tone === 'late') || b.age - a.age);
    return { queue: items.slice(0, 10).map((i) => ({ ...i, action: action(i.kind) })), queueTotal: items.length };
  }

  // ---------- Reminders (Reminders.razor) ----------
  reminders(user) {
    const s = this.settings();
    const chase = Number(s.awaiting_days || 3);
    const now = Date.now();
    const rows = this.all(`SELECT id, ticket_no, status, customer_company, printer_model, printer_sn, faulty_part, created_at, updated_at,
      excel_generated_at, oem_email_sent_at, oem_dispatch_date, goods_received_date, oem_rma_assign_date
      FROM tickets WHERE status IN ('OPEN','AWAITING_OEM_RMA','OEM_RMA_RECEIVED','GOODS_RECEIVED_FROM_OEM') ORDER BY created_at LIMIT 500`);
    const items = [];
    for (const t of rows) {
      const age = Math.floor((now - t.created_at) / 86400000);
      const base = { id: t.id, ticket_no: t.ticket_no, customer: t.customer_company || '—', serial: t.printer_sn || '—', model: t.printer_model, part: t.faulty_part, age };
      if (t.status === STATUS.OPEN && !t.excel_generated_at) items.push({ ...base, kind: 'Generate OEM Excel', tone: 'todo' });
      else if (t.status === STATUS.OPEN || (t.status === STATUS.AWAITING && !t.oem_email_sent_at)) items.push({ ...base, kind: 'Send OEM email', tone: 'todo' });
      else if (t.status === STATUS.AWAITING && age >= chase) items.push({ ...base, kind: `Awaiting OEM RMA # (${age} days)`, tone: 'late' });
      else if (t.status === STATUS.OEM_RECEIVED && !t.oem_dispatch_date) items.push({ ...base, kind: 'OEM RMA received — dispatch to OEM pending', tone: 'todo' });
      else if (t.status === STATUS.GOODS_RECEIVED) {
        const waited = t.goods_received_date ? daysBetween(t.goods_received_date, today()) : 0;
        items.push({ ...base, kind: `Goods back from OEM — send to customer${waited >= 2 ? ` (${waited} days)` : ''}`, tone: waited >= 2 ? 'late' : 'todo' });
      }
    }
    return { items, awaitingDays: chase, carePack: this.cpReminders() };
  }

  // For the 9 am email: reminders plus settings, so the Worker can send one digest per company.
  reminderDigest(user) {
    const s = this.settings();
    const r = this.reminders(user);
    return { enabled: s.reminder_emails !== '0', extraTo: splitEmails(s.reminder_extra_to), ...r };
  }

  // ---------- OEM Excel + email ----------
  markExcel(user, { id }) {
    const t = this.ticketRow(id);
    const first = !t.excel_generated_at;
    this.sql.exec('UPDATE tickets SET excel_generated_at = ?, updated_at = ?, updated_by = ? WHERE id = ?', Date.now(), Date.now(), user.name, t.id);
    this.event(t.id, user, first ? 'OEM Excel generated' : 'OEM Excel regenerated', null);
    return { ok: true };
  }

  tokenMap(t, companyName) {
    const s = this.settings();
    const stem = excelStem(t);
    return {
      INTERNAL_TICKET: t.ticket_no || '', CUSTOMER: t.customer_company || '', PRINTER_MODEL: t.printer_model || '',
      PRINTER_SERIAL: t.printer_sn || '', FAULTY_PART: (t.faulty_part || 'Head').trim(), PART_CODE: t.faulty_part_no || '',
      FAULTY_PART_SERIAL: t.faulty_part_sn || t.printer_sn || '', FAULT_DESCRIPTION: t.failure_description || '',
      TPH_MILAGE: t.tph_mileage === null ? '' : String(+Number(t.tph_mileage).toFixed(2)),
      PRINTER_MILAGE: t.printer_mileage === null ? '' : String(+Number(t.printer_mileage).toFixed(2)),
      FW_VERSION: t.fw_version || '', FLASH_INITIALIZED: t.flash_initialized || '', OEM_RMA: t.oem_rma_number || '',
      PO_NUMBER: t.po_number || '', EXCEL_FILE_NAME: `${stem}.xlsx`, EXCEL_FILE_STEM: stem,
      COMPANY_NAME: companyName || '', COMPANY_EMAIL: s.company_email || '', COMPANY_PHONE: s.company_phone || '',
    };
  }

  emailContext(user, { id }) {
    const t = this.ticketRow(id);
    const s = this.settings();
    const map = this.tokenMap(t, user.companyName);
    const apply = (tpl) => String(tpl || '').replace(/\{\{([A-Z_]+)\}\}|@@([A-Z_]+)@@/gi, (m, a, b) => {
      const k = (a || b).toUpperCase();
      return k in map ? map[k] : m;
    });
    const subject = apply(s.oem_rma_email_subject).trim() || map.EXCEL_FILE_STEM;
    return {
      tokens: map, fileName: map.EXCEL_FILE_NAME, subject, body: apply(s.oem_rma_email_body).trim(),
      to: splitEmails(s.oem_rma_email_to), cc: splitEmails(s.oem_rma_email_cc), replyTo: s.company_email || null,
      excelGenerated: !!t.excel_generated_at, sentAt: t.oem_email_sent_at, sentBy: t.oem_email_sent_by,
    };
  }

  recordOemEmail(user, { id, to }) {
    const t = this.ticketRow(id);
    const now = Date.now();
    const set = { oem_email_sent_at: now, oem_email_sent_by: user.name, updated_at: now, updated_by: user.name };
    if (t.status === STATUS.OPEN) set.status = STATUS.AWAITING;
    if (!t.excel_generated_at) set.excel_generated_at = now;
    const cols = Object.keys(set);
    this.sql.exec(`UPDATE tickets SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...cols.map((k) => set[k]), t.id);
    this.event(t.id, user, 'OEM email sent', `To ${to.join(', ')}${set.status ? ' · status: Awaiting OEM RMA' : ''}`);
    this.audit(user, 'oem_email', 'ticket', t.id, { to });
    return { ok: true };
  }

  // ---------- Files (photos and the Excel template) ----------
  storeBytes(fileId, bytes) {
    this.sql.exec('DELETE FROM file_chunks WHERE file_id = ?', fileId);
    const view = new Uint8Array(bytes);
    for (let i = 0, seq = 0; i < view.length; i += CHUNK, seq++) {
      this.sql.exec('INSERT INTO file_chunks (file_id, seq, data) VALUES (?,?,?)', fileId, seq, view.slice(i, i + CHUNK).buffer);
    }
  }
  readBytes(fileId, size) {
    const chunks = this.all('SELECT data FROM file_chunks WHERE file_id = ? ORDER BY seq', fileId);
    const out = new Uint8Array(size);
    let off = 0;
    for (const ch of chunks) {
      const part = new Uint8Array(ch.data);
      out.set(part, off);
      off += part.length;
    }
    return out.buffer;
  }

  putPhoto(user, { ticketId, direction, name, mime, bytes, notes, r2Id }) {
    const t = this.ticketRow(ticketId);
    if (!['INBOUND', 'OUTBOUND'].includes(direction)) throw new ValidationError({ direction: 'Choose inbound or outbound' });
    const count = this.one('SELECT COUNT(*) AS n FROM photos WHERE ticket_id = ?', t.id).n;
    if (count >= 40) throw new ValidationError({ file: 'This RMA already has 40 photos. Delete some first.' });
    const id = r2Id || uuid();
    const size = typeof bytes === 'number' ? bytes : bytes.byteLength;
    this.sql.exec('INSERT INTO photos (id, ticket_id, direction, name, mime, size, store, notes, captured_at, captured_by) VALUES (?,?,?,?,?,?,?,?,?,?)',
      id, t.id, direction, name, mime, size, r2Id ? 'r2' : 'db', notes ? String(notes).slice(0, 300) : null, Date.now(), user.name);
    if (!r2Id) this.storeBytes(id, bytes);
    this.event(t.id, user, `${direction === 'INBOUND' ? 'Inbound' : 'Outbound'} photo added`, name);
    return { id, direction, name, mime, size };
  }

  getPhoto(user, { id }) {
    const p = this.one('SELECT * FROM photos WHERE id = ?', id);
    if (!p) throw httpError(404, 'Photo not found');
    return { meta: p, bytes: p.store === 'db' ? this.readBytes(p.id, p.size) : null };
  }

  deletePhoto(user, { id }) {
    const p = this.one('SELECT * FROM photos WHERE id = ?', id);
    if (!p) throw httpError(404, 'Photo not found');
    const t = this.ticketRow(p.ticket_id);
    if (CLOSED_SET.includes(t.status) && user.role !== 'Admin') throw httpError(409, 'This RMA is closed. Only an Admin can remove photos.');
    this.sql.exec('DELETE FROM file_chunks WHERE file_id = ?', id);
    this.sql.exec('DELETE FROM photos WHERE id = ?', id);
    this.event(p.ticket_id, user, 'Photo removed', p.name);
    return { ok: true, store: p.store, ticketId: p.ticket_id };
  }

  putTemplate(user, { name, bytes }) {
    this.storeBytes(TEMPLATE_ID, bytes);
    this.sql.exec('INSERT OR REPLACE INTO files (id, name, mime, size, updated_at, updated_by) VALUES (?,?,?,?,?,?)',
      TEMPLATE_ID, name, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes.byteLength, Date.now(), user.name);
    this.audit(user, 'upload', 'template', TEMPLATE_ID, { name, size: bytes.byteLength });
    return this.getSettings(user);
  }
  getTemplate() {
    const f = this.one('SELECT * FROM files WHERE id = ?', TEMPLATE_ID);
    if (!f) return null;
    return { name: f.name, bytes: this.readBytes(TEMPLATE_ID, f.size) };
  }
  deleteTemplate(user) {
    this.sql.exec('DELETE FROM file_chunks WHERE file_id = ?', TEMPLATE_ID);
    this.sql.exec('DELETE FROM files WHERE id = ?', TEMPLATE_ID);
    this.audit(user, 'delete', 'template', TEMPLATE_ID, null);
    return this.getSettings(user);
  }

  // ---------- Monthly OEM batches (BatchService) ----------
  batchCandidates() {
    return this.all(`SELECT id, ticket_no, oem_rma_number, printer_model, printer_sn, faulty_part, faulty_part_sn, customer_company, created_at, oem_rma_assign_date
      FROM tickets WHERE status = 'OEM_RMA_RECEIVED' ORDER BY created_at`);
  }

  createBatch(user, { ticketIds, dispatch_date, courier, docket, remarks }) {
    const v = new Checker({ dispatch_date, courier, docket, remarks }).date('dispatch_date', { required: true, label: 'Dispatch date', notFuture: true })
      .text('courier', { max: 100, label: 'Courier' }).text('docket', { max: 100, label: 'Docket / AWB' }).text('remarks', { max: 1000, label: 'Remarks' }).done();
    const ids = [...new Set((Array.isArray(ticketIds) ? ticketIds : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!ids.length) throw new ValidationError({ tickets: 'Tick at least one RMA to dispatch' });
    const rows = this.all(`SELECT id, ticket_no, status FROM tickets WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids);
    const wrong = rows.filter((r) => r.status !== STATUS.OEM_RECEIVED);
    if (rows.length !== ids.length || wrong.length) {
      throw httpError(409, `Only RMAs with an OEM RMA # can go in a batch${wrong.length ? `: ${wrong.map((w) => `${w.ticket_no} is ${label(w.status)}`).slice(0, 3).join(', ')}` : ''}. Reload and try again.`);
    }
    const ym = v.dispatch_date.slice(0, 7).replace('-', '');
    let code = `BATCH-${ym}`;
    for (let n = 2; this.one('SELECT 1 AS x FROM batches WHERE batch_code = ?', code); n++) code = `BATCH-${ym}-${n}`;
    const now = Date.now();
    this.sql.exec('INSERT INTO batches (batch_code, batch_month, dispatch_date, courier, docket, remarks, total, created_at, created_by) VALUES (?,?,?,?,?,?,?,?,?)',
      code, v.dispatch_date.slice(0, 7), v.dispatch_date, v.courier, v.docket, v.remarks, ids.length, now, user.name);
    for (const id of ids) {
      this.sql.exec('UPDATE tickets SET status = ?, oem_dispatch_date = ?, batch_code = ?, updated_at = ?, updated_by = ? WHERE id = ?',
        STATUS.DISPATCHED_OEM, v.dispatch_date, code, now, user.name, id);
      this.event(id, user, 'status: Dispatched to OEM', `Batch ${code}`);
    }
    this.audit(user, 'create', 'batch', code, { tickets: ids.length });
    return this.getBatch(user, { code });
  }

  listBatches() {
    return this.all('SELECT * FROM batches ORDER BY created_at DESC LIMIT 200');
  }
  getBatch(user, { code }) {
    const b = this.one('SELECT * FROM batches WHERE batch_code = ?', code);
    if (!b) throw httpError(404, 'Batch not found');
    const tickets = this.all(`SELECT id, ticket_no, status, oem_rma_number, printer_model, printer_sn, faulty_part, faulty_part_sn,
      failure_description, customer_company, created_at FROM tickets WHERE batch_code = ? ORDER BY ticket_no`, code)
      .map((r) => ({ ...r, status_label: label(r.status) }));
    return { batch: b, tickets };
  }

  // ---------- Import from the old Excel sheet / SQL Server export (ImportService) ----------
  importTickets(user, { rows, fileName, dryRun }) {
    if (!Array.isArray(rows) || !rows.length) throw new ValidationError({ _: 'No rows to import' });
    if (rows.length > 1000) throw new ValidationError({ _: 'Send at most 1000 rows at a time' });
    const result = { total: rows.length, imported: 0, duplicates: 0, errors: 0, duplicateList: [], errorList: [], created: [] };
    const seenSn = new Set();
    const seenRma = new Set();
    const prefix = user.ticketPrefix || 'INF';
    rows.forEach((raw, i) => {
      const rowNo = Number(raw._row) || i + 2;
      try {
        const r = Object.fromEntries(Object.entries(raw || {}).map(([k, val]) => [k, val === null || val === undefined ? '' : String(val).trim()]));
        const createdAt = parseLooseDate(r.created_at);
        const v = this.checkTicket({
          ...r,
          purchase_date: parseLooseDate(r.purchase_date)?.date || '',
          delivery_to_user_date: parseLooseDate(r.delivery_to_user_date)?.date || '',
          tph_mileage: cleanNumber(r.tph_mileage), printer_mileage: cleanNumber(r.printer_mileage),
          customer_email: /@/.test(r.customer_email || '') ? r.customer_email : '',
          ship_to_email: /@/.test(r.ship_to_email || '') ? r.ship_to_email : '',
        }, { requireCore: false });
        if (!v.printer_sn) throw new ValidationError({ printer_sn: 'Printer serial number is empty' });
        const oemRma = (r.oem_rma_number || '').slice(0, 100) || null;
        // Duplicates: same printer SN with same OEM RMA # / same legacy ticket, or same OEM RMA # anywhere.
        const legacyNo = (r.ticket_no || '').slice(0, 30) || null;
        if (legacyNo && (this.one('SELECT 1 AS x FROM tickets WHERE ticket_no = ?', legacyNo))) {
          result.duplicates++; result.duplicateList.push(`Row ${rowNo}: ticket ${legacyNo} already exists`); return;
        }
        if (oemRma && (seenRma.has(oemRma.toUpperCase()) || this.one('SELECT 1 AS x FROM tickets WHERE oem_rma_number = ? COLLATE NOCASE', oemRma))) {
          result.duplicates++; result.duplicateList.push(`Row ${rowNo}: OEM RMA # ${oemRma} already exists`); return;
        }
        const snKey = `${v.printer_sn_norm}|${normPart(v.faulty_part) || ''}|${v.faulty_part_sn_norm || ''}|${createdAt?.date || ''}`;
        if (seenSn.has(snKey) || this.one(`SELECT 1 AS x FROM tickets WHERE printer_sn_norm = ? AND IFNULL(UPPER(faulty_part),'') = ? AND IFNULL(faulty_part_sn_norm,'') = ?
            AND (? = '' OR substr(datetime(created_at/1000 + 19800, 'unixepoch'), 1, 10) = ?)`,
          v.printer_sn_norm, normPart(v.faulty_part) || '', v.faulty_part_sn_norm || '', createdAt?.date || '', createdAt?.date || '')) {
          result.duplicates++; result.duplicateList.push(`Row ${rowNo}: printer ${v.printer_sn} with the same part is already imported`); return;
        }
        const status = IMPORT_STATUS[(r.status || '').toLowerCase()] || (ALL_STATUS.includes((r.status || '').toUpperCase()) ? r.status.toUpperCase() : STATUS.OPEN);
        const created = createdAt?.ms || Date.now();
        if (dryRun) {
          seenSn.add(snKey); if (oemRma) seenRma.add(oemRma.toUpperCase());
          result.imported++;
          return;
        }
        const ticketNo = legacyNo || (createdAt ? this.nextTicketNo(prefix, istParts(created).ym) : this.nextImportNo(prefix));
        const closed = CLOSED_SET.includes(status);
        const extra = {
          oem_rma_number: oemRma,
          oem_rma_assign_date: parseLooseDate(r.oem_rma_assign_date)?.date || null,
          oem_dispatch_date: parseLooseDate(r.oem_dispatch_date)?.date || null,
          batch_code: (r.batch_code || '').slice(0, 30) || null,
          challan_number: (r.challan_number || '').slice(0, 100) || null,
          dispatch_to_customer_date: parseLooseDate(r.dispatch_to_customer_date)?.date || null,
          closed_at: closed ? (parseLooseDate(r.closed_at)?.ms || created) : null,
          closure_type: closed ? (status === STATUS.CLOSED ? 'REPAIRED' : 'RETURNED') : null,
          closure_remarks: (r.closure_remarks || '').slice(0, 2000) || null,
        };
        const row = { ...v, ...extra, ticket_no: ticketNo, status, is_imported: 1, created_at: created, updated_at: Date.now(), created_by: `Import (${user.name})`, updated_by: user.name };
        const cols = Object.keys(row);
        this.sql.exec(`INSERT INTO tickets (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(',')})`, ...cols.map((k) => row[k]));
        const id = this.one('SELECT last_insert_rowid() AS id').id;
        this.event(id, user, 'imported', fileName ? `From ${String(fileName).slice(0, 120)}` : null);
        seenSn.add(snKey); if (oemRma) seenRma.add(oemRma.toUpperCase());
        result.imported++;
        if (result.created.length < 20) result.created.push({ id, ticket_no: ticketNo });
      } catch (e) {
        result.errors++;
        result.errorList.push(`Row ${rowNo}: ${e.fields ? Object.values(e.fields).join('; ') : e.message}`);
      }
    });
    result.duplicateList = result.duplicateList.slice(0, 100);
    result.errorList = result.errorList.slice(0, 100);
    if (!dryRun) {
      this.sql.exec('INSERT INTO import_log (at, by_name, file_name, total, imported, duplicates, errors, summary) VALUES (?,?,?,?,?,?,?,?)',
        Date.now(), user.name, fileName ? String(fileName).slice(0, 200) : null, result.total, result.imported, result.duplicates, result.errors,
        JSON.stringify({ duplicates: result.duplicateList.slice(0, 20), errors: result.errorList.slice(0, 20) }));
      this.audit(user, 'import', 'tickets', null, { file: fileName, imported: result.imported, duplicates: result.duplicates, errors: result.errors });
    }
    this.fillMissingCategories();
    return result;
  }
  nextImportNo(prefix) {
    return this.nextTicketNo(prefix, 'IMPORT');
  }
  importLog() {
    return this.all('SELECT * FROM import_log ORDER BY at DESC LIMIT 50');
  }

  cpSaveSettings(user, b) {
    const c = new Checker(b).text('invoice_prefix', { max: 40, label: 'Invoice prefix' })
      .number('carepack_po_deadline_days', { required: true, min: 1, max: 30, int: true, label: 'PO deadline (days)' })
      .number('carepack_oem_payment_deadline_days', { required: true, min: 1, max: 45, int: true, label: 'OEM payment deadline (days)' })
      .bool('challan_enabled').bool('challan_auto_dispatch').text('challan_line_description', { max: 500, label: 'Challan line' }).text('challan_notes', { max: 1000, label: 'Challan notes' });
    const v = c.done();
    for (const [k, val] of Object.entries(v)) this.sql.exec('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', `set:${k}`, val === null ? '' : typeof val === 'boolean' ? (val ? '1' : '0') : String(val));
    this.audit(user, 'update', 'carepack_settings', null, v);
    return this.getSettings(user);
  }

  auditLog(user, { limit = 300 } = {}) {
    return this.all('SELECT * FROM audit ORDER BY at DESC LIMIT ?', Math.min(Number(limit) || 300, 1000));
  }
}

// ---------- helpers ----------
export function splitEmails(raw, keepInvalid = false) {
  const list = String(raw || '').split(/[,;\n\r]+/).map((s) => s.trim()).filter(Boolean);
  const out = keepInvalid ? list : list.filter((e) => e.includes('@'));
  return [...new Set(out.map((e) => e.toLowerCase()))];
}

// OEM file name: PrinterModel_PrinterSerialNo_ProblematicPart (ExcelService.BuildOemExcelFileName)
export function excelStem(t) {
  const clean = (v, fb) => {
    let s = String(v || '').trim() || fb;
    s = s.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/\s{2,}/g, ' ');
    return s;
  };
  return `${clean(t.printer_model, 'Model')}_${clean(t.printer_sn, 'SN')}_${clean(t.faulty_part, 'Part')}`;
}

function samePartOnMachine(partKey, partNo, partSn, t) {
  const tPartKey = normPart(t.faulty_part);
  if (!partKey || !tPartKey) return true;
  if (partKey !== tPartKey) return false;
  const tPartNo = normPart(t.faulty_part_no);
  if (partNo && tPartNo && partNo !== tPartNo) return false;
  const tPartSn = t.faulty_part_sn_norm;
  if (partSn && tPartSn && partSn !== tPartSn) return false;
  return true;
}
function samePartReason(t, tag, partSn) {
  if (!normPart(t.faulty_part)) return `Open RMA ${tag} on this printer has no faulty part recorded, so it may be for the same part.`;
  let r = `This printer already has open RMA ${tag} for ${t.faulty_part}`;
  const tPartSn = t.faulty_part_sn_norm;
  if (!partSn || !tPartSn) {
    r += `, and the part serial is blank on ${!partSn && !tPartSn ? 'both tickets' : !partSn ? 'this RMA' : 'the open RMA'}, so they cannot be told apart.`;
  } else {
    r += ` with the same part serial ${tPartSn}.`;
  }
  return r;
}

function cleanNumber(v) {
  const s = String(v ?? '').replace(/[^0-9.]/g, '');
  return s && Number.isFinite(Number(s)) ? s : '';
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
// Accepts 2026-07-18, 18-07-2026, 18/07/2026, 18-Jul-2026, 18 Jul 2026, Excel serial numbers, ISO with time.
// Day comes first for slashed dates (Indian format). Returns { date, ms } in IST, or null.
export function parseLooseDate(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  let y, m, d, hh = 12, mi = 0;
  let mm;
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const serial = Number(s);
    const ms = Date.UTC(1899, 11, 30) + Math.round(serial * 86400000);
    const dt = new Date(ms);
    y = dt.getUTCFullYear(); m = dt.getUTCMonth() + 1; d = dt.getUTCDate(); hh = dt.getUTCHours(); mi = dt.getUTCMinutes();
  } else if ((mm = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2}))?/))) {
    [y, m, d] = [Number(mm[1]), Number(mm[2]), Number(mm[3])];
    if (mm[4]) { hh = Number(mm[4]); mi = Number(mm[5]); }
  } else if ((mm = s.match(/^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2,4})(?:\s+(\d{1,2}):(\d{2}))?/))) {
    [d, m, y] = [Number(mm[1]), Number(mm[2]), Number(mm[3])];
    if (mm[4]) { hh = Number(mm[4]); mi = Number(mm[5]); }
  } else if ((mm = s.match(/^(\d{1,2})[-/ ]([A-Za-z]{3})[A-Za-z]*[-/ ,]+(\d{2,4})/))) {
    [d, m, y] = [Number(mm[1]), MONTHS[mm[2].toLowerCase()], Number(mm[3])];
  } else if ((mm = s.match(/^([A-Za-z]{3})[A-Za-z]*[ -](\d{1,2}),?[ -](\d{2,4})/))) {
    [m, d, y] = [MONTHS[mm[1].toLowerCase()], Number(mm[2]), Number(mm[3])];
  } else {
    return null;
  }
  if (y < 100) y += 2000;
  if (!m || m > 12 || !d || d > 31 || y < 1990 || y > 2100) return null;
  const date = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const ms = Date.UTC(y, m - 1, d, hh, mi) - 5.5 * 3600 * 1000;
  if (Number.isNaN(ms)) return null;
  return { date, ms };
}

Object.assign(Company.prototype, carePackMethods, migrateMethods, deviceMethods);
