// Bulk RMA from photo zips: draft RMAs (mixed into the Company Durable Object's prototype).
// One zip = one printer, named with its serial. The browser unpacks the photos; each zip becomes a draft here.
// A draft is NOT an RMA: no RMA number, no customer email, not in reports or the trial count.
// The operator opens the draft on the normal New RMA form; on Accept the RMA is created with every normal
// check, and the draft's photos move onto the RMA (the chosen five first, so they fill the OEM Excel boxes).
// Tables are created on first use and nothing existing is changed, so an older version of the app ignores them.
import { ValidationError } from './validate.js';
import { isHeadPart } from './devices.js';

export const DRAFT_PARTS = ['Print head', 'Main board', 'Power supply', 'Front panel', 'Accessories', 'Other'];
export const DRAFT_MAX_PHOTOS = 20;
export const DRAFT_MAX_OPEN = 500;
export const DRAFT_KEEP_DAYS = 30;
const DAY = 86400000;
const REPEAT_DAYS = 90;

const err = (status, message, extra) => Object.assign(new Error(message), { status, extra });
const snNorm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '') || null;
const partNorm = (s) => String(s || '').trim().toUpperCase().replace(/\s+/g, ' ') || null;
// Same faulty part? Print heads match whatever they were called ("Head", "TPH", "Print head").
export function samePart(a, b) {
  if (!partNorm(a) || !partNorm(b)) return true;
  if (isHeadPart(a) && isHeadPart(b)) return true;
  return partNorm(a) === partNorm(b);
}
// The printer serial from a zip file name: "TEBT25160110.zip", "TEBT25160110 (1).zip", "tebt 2516 0110.ZIP".
export function serialFromName(name) {
  let s = String(name || '').split(/[\\/]/).pop().replace(/\.zip$/i, '');
  s = s.replace(/\s*\(\d+\)\s*$/, '').replace(/\s*-\s*copy$/i, '');
  return s.toUpperCase().replace(/[^A-Z0-9_-]/g, '').replace(/^[-_]+|[-_]+$/g, '');
}

export const draftMethods = {
  draftsReady() {
    if (this._draftsReady) return;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS rma_drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, printer_sn TEXT NOT NULL, printer_sn_norm TEXT, faulty_part TEXT,
      source_name TEXT, photo_order TEXT, created_at INTEGER NOT NULL, created_by TEXT, updated_at INTEGER, updated_by TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS rma_draft_photos (
      id TEXT PRIMARY KEY, draft_id INTEGER NOT NULL, name TEXT, mime TEXT NOT NULL, size INTEGER NOT NULL, store TEXT NOT NULL,
      seq INTEGER NOT NULL, added_at INTEGER NOT NULL)`);
    this.sql.exec('CREATE INDEX IF NOT EXISTS rma_draft_photos_draft ON rma_draft_photos(draft_id)');
    this._draftsReady = true;
  },
  bulkOn() {
    return this.one("SELECT value FROM meta WHERE key = 'set:bulk_photos'")?.value !== '0';
  },
  draftsGuard(user) {
    if (user && (user.role === 'Viewer' || user.bulkPhotos === false)) throw err(403, 'Bulk RMA from photos is switched off for your login. Ask your Admin.', { code: 'bulk_user_off' });
    if (!this.bulkOn()) throw err(403, 'Bulk RMA from photos is switched off. An Admin can switch it on in Company settings.', { code: 'bulk_off' });
    this.draftsReady();
  },
  // Admin switch (Company settings). Off hides the screens; drafts already made are kept.
  bulkPhotosSet(user, { on }) {
    this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('set:bulk_photos', ?)", on ? '1' : '0');
    this.audit(user, 'update', 'settings', null, { bulk_photos: !!on });
    return this.getSettings(user);
  },

  // What the app knows about each serial: cover (care pack / warranty) and RMAs already raised for it.
  draftCheck(user, { items = [] } = {}) {
    this.draftsGuard(user);
    if (!Array.isArray(items) || items.length > 100) throw new ValidationError({ items: 'Check at most 100 serials at a time' });
    return { items: items.map((it) => this.draftCheckOne(String(it?.sn || '').trim(), it?.part || '', Number(it?.draftId) || 0)) };
  },
  draftCheckOne(sn, part, draftId = 0) {
    const norm = snNorm(sn);
    if (!norm) return { sn, error: 'No serial number in the file name' };
    const { device } = this.cpFindSerial(null, { sn, loose: false });
    const tickets = this.all(`SELECT id, ticket_no, status, faulty_part, closed_at, created_at FROM tickets
      WHERE printer_sn_norm = ? ORDER BY created_at DESC LIMIT 50`, norm);
    const brief = (t) => ({ id: t.id, ticket_no: t.ticket_no, status: t.status, status_label: this.statusLabel(t.status), faulty_part: t.faulty_part, created_at: t.created_at });
    const isOpen = (t) => !t.closed_at && !['CLOSED', 'CLOSED_RETURNED'].includes(t.status);
    const open = tickets.filter(isOpen);
    const likely = part ? open.filter((t) => samePart(part, t.faulty_part)) : [];
    const since = Date.now() - REPEAT_DAYS * DAY;
    const repeat = part ? tickets.filter((t) => !isOpen(t) && t.created_at >= since && partNorm(t.faulty_part) && samePart(part, t.faulty_part)) : [];
    const drafts = this.all('SELECT id FROM rma_drafts WHERE printer_sn_norm = ? AND id != ?', norm, draftId).map((d) => d.id);
    return {
      sn, device,
      cover: !device ? 'none' : device.expired ? 'expired' : 'covered',
      open: open.map(brief), likely: likely.map(brief), repeat: repeat.map(brief), drafts,
    };
  },

  draftCreate(user, { printer_sn, faulty_part, source_name }) {
    this.draftsGuard(user);
    const sn = String(printer_sn || '').trim().slice(0, 100);
    if (!snNorm(sn)) throw new ValidationError({ printer_sn: 'Serial number is required (from the zip file name)' });
    const part = String(faulty_part || '').trim().slice(0, 200);
    if (!part) throw new ValidationError({ faulty_part: 'Choose the faulty part' });
    const { device } = this.cpFindSerial(null, { sn, loose: false });
    if (device?.expired) throw err(409, `Care pack / warranty for serial ${device.serial_number} has ended. Expired cover cannot start an RMA, so no draft was made.`);
    if (this.one('SELECT COUNT(*) AS n FROM rma_drafts').n >= DRAFT_MAX_OPEN) {
      throw err(409, `There are already ${DRAFT_MAX_OPEN} drafts. Accept or delete some first.`);
    }
    const now = Date.now();
    this.sql.exec(`INSERT INTO rma_drafts (printer_sn, printer_sn_norm, faulty_part, source_name, created_at, created_by, updated_at, updated_by)
      VALUES (?,?,?,?,?,?,?,?)`, sn, snNorm(sn), part, String(source_name || '').slice(0, 200) || null, now, user.name, now, user.name);
    const id = this.one('SELECT last_insert_rowid() AS id').id;
    this.audit(user, 'create', 'draft', id, { serial: sn, part, zip: source_name || null });
    return { id };
  },

  draftPhotoPut(user, { draftId, name, mime, bytes, r2Id }) {
    this.draftsGuard(user);
    const d = this.draftRow(draftId);
    const n = this.one('SELECT COUNT(*) AS n FROM rma_draft_photos WHERE draft_id = ?', d.id).n;
    if (n >= DRAFT_MAX_PHOTOS) throw new ValidationError({ file: `A draft can hold ${DRAFT_MAX_PHOTOS} photos` });
    const id = r2Id || crypto.randomUUID();
    const size = typeof bytes === 'number' ? bytes : bytes.byteLength;
    this.sql.exec('INSERT INTO rma_draft_photos (id, draft_id, name, mime, size, store, seq, added_at) VALUES (?,?,?,?,?,?,?,?)',
      id, d.id, String(name || 'photo.jpg').slice(0, 120), mime, size, r2Id ? 'r2' : 'db', n + 1, Date.now());
    if (!r2Id) this.storeBytes(id, bytes);
    return { id };
  },
  draftPhotoGet(user, { id }) {
    this.draftsReady();
    const p = this.one('SELECT * FROM rma_draft_photos WHERE id = ?', id);
    if (!p) throw err(404, 'Photo not found');
    return { meta: p, bytes: p.store === 'db' ? this.readBytes(p.id, p.size) : null };
  },

  draftRow(id) {
    const d = this.one('SELECT * FROM rma_drafts WHERE id = ?', Number(id) || 0);
    if (!d) throw err(404, 'This draft is not there any more. It may have been accepted or deleted.');
    return d;
  },
  draftView(d, withCheck = true) {
    const photos = this.all('SELECT id, name, mime, size, seq FROM rma_draft_photos WHERE draft_id = ? ORDER BY seq', d.id);
    let order = [];
    try { order = JSON.parse(d.photo_order || '[]'); } catch { /* none chosen */ }
    const ids = new Set(photos.map((p) => p.id));
    order = order.filter((x) => ids.has(x));
    return { ...d, photos, photo_order: order, check: withCheck ? this.draftCheckOne(d.printer_sn, d.faulty_part, d.id) : null };
  },
  draftList(user) {
    this.draftsGuard(user);
    const r2 = this.draftPurgeOld();
    const rows = this.all('SELECT * FROM rma_drafts ORDER BY created_at, id LIMIT 500');
    return { drafts: rows.map((d) => this.draftView(d)), keepDays: DRAFT_KEEP_DAYS, parts: DRAFT_PARTS, r2Photos: r2 };
  },
  draftCount(user) {
    if (!this.bulkOn() || user?.role === 'Viewer' || user?.bulkPhotos === false) return { n: 0, on: false };
    this.draftsReady();
    return { n: this.one('SELECT COUNT(*) AS n FROM rma_drafts').n, on: true };
  },
  draftGet(user, { id }) {
    this.draftsGuard(user);
    const d = this.draftRow(id);
    const next = this.one('SELECT id FROM rma_drafts WHERE id != ? ORDER BY created_at, id LIMIT 1', d.id);
    return { draft: this.draftView(d), nextId: next?.id || null, parts: DRAFT_PARTS };
  },
  draftUpdate(user, { id, faulty_part, photo_order }) {
    this.draftsGuard(user);
    const d = this.draftRow(id);
    const part = faulty_part === undefined ? d.faulty_part : String(faulty_part || '').trim().slice(0, 200);
    if (!part) throw new ValidationError({ faulty_part: 'Choose the faulty part' });
    const order = Array.isArray(photo_order) ? photo_order.map(String).slice(0, 5) : null;
    this.sql.exec('UPDATE rma_drafts SET faulty_part = ?, photo_order = COALESCE(?, photo_order), updated_at = ?, updated_by = ? WHERE id = ?',
      part, order ? JSON.stringify(order) : null, Date.now(), user.name, d.id);
    return { draft: this.draftView(this.draftRow(d.id)) };
  },
  // Deletes drafts and their photos. Returns photo ids kept in R2 so the Worker can remove them too.
  draftDelete(user, { ids }) {
    this.draftsGuard(user);
    const list = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Boolean).slice(0, 500);
    if (!list.length) throw new ValidationError({ ids: 'Choose the drafts to delete' });
    const r2 = [];
    let n = 0;
    for (const id of list) {
      const d = this.one('SELECT * FROM rma_drafts WHERE id = ?', id);
      if (!d) continue;
      r2.push(...this.draftDrop(d.id));
      this.audit(user, 'delete', 'draft', d.id, { serial: d.printer_sn, part: d.faulty_part });
      n++;
    }
    return { deleted: n, r2Photos: r2 };
  },
  draftDrop(id) {
    const photos = this.all('SELECT id, store FROM rma_draft_photos WHERE draft_id = ?', id);
    for (const p of photos) this.sql.exec('DELETE FROM file_chunks WHERE file_id = ?', p.id);
    this.sql.exec('DELETE FROM rma_draft_photos WHERE draft_id = ?', id);
    this.sql.exec('DELETE FROM rma_drafts WHERE id = ?', id);
    return photos.filter((p) => p.store === 'r2').map((p) => p.id);
  },
  draftPurgeOld() {
    const old = this.all('SELECT id, printer_sn FROM rma_drafts WHERE created_at < ?', Date.now() - DRAFT_KEEP_DAYS * DAY);
    const r2 = [];
    for (const d of old) {
      r2.push(...this.draftDrop(d.id));
      this.audit({ name: 'System', role: 'System' }, 'delete', 'draft', d.id, { serial: d.printer_sn, reason: `not accepted in ${DRAFT_KEEP_DAYS} days` });
    }
    return r2;
  },

  // Called by createTicket once the RMA exists: the draft's photos become the RMA's inbound photos.
  // The chosen photos go first (in the chosen order), so the OEM Excel's five photo boxes get them.
  draftAttach(user, draftId, ticketId, photoOrder) {
    this.draftsReady();
    const d = this.draftRow(draftId);
    const photos = this.all('SELECT * FROM rma_draft_photos WHERE draft_id = ? ORDER BY seq', d.id);
    let chosen = Array.isArray(photoOrder) ? photoOrder.map(String) : null;
    if (!chosen) { try { chosen = JSON.parse(d.photo_order || '[]'); } catch { chosen = []; } }
    const rank = new Map(chosen.slice(0, 5).map((id, i) => [id, i]));
    photos.sort((a, b) => (rank.has(a.id) ? rank.get(a.id) : 100 + a.seq) - (rank.has(b.id) ? rank.get(b.id) : 100 + b.seq));
    const room = Math.max(0, 40 - this.one('SELECT COUNT(*) AS n FROM photos WHERE ticket_id = ?', ticketId).n);
    const base = Date.now();
    photos.slice(0, room).forEach((p, i) => {
      this.sql.exec('INSERT INTO photos (id, ticket_id, direction, name, mime, size, store, notes, captured_at, captured_by) VALUES (?,?,?,?,?,?,?,?,?,?)',
        p.id, ticketId, 'INBOUND', p.name, p.mime, p.size, p.store, null, base + i, d.created_by || user.name);
    });
    // Photos over the 40-per-RMA limit are dropped with the draft.
    const extra = photos.slice(room);
    for (const p of extra) this.sql.exec('DELETE FROM file_chunks WHERE file_id = ?', p.id);
    this.sql.exec('DELETE FROM rma_draft_photos WHERE draft_id = ?', d.id);
    this.sql.exec('DELETE FROM rma_drafts WHERE id = ?', d.id);
    this.event(ticketId, user, 'Created from photo zip', `${d.source_name || d.printer_sn} · ${Math.min(photos.length, room)} photo${photos.length === 1 ? '' : 's'}`);
    this.audit(user, 'accept', 'draft', d.id, { ticketId, photos: Math.min(photos.length, room) });
    return { photos: Math.min(photos.length, room), r2Dropped: extra.filter((p) => p.store === 'r2').map((p) => p.id) };
  },
};
