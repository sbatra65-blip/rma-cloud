// Customer status page: every RMA can have a private link (/t/<token>) that shows the customer where
// their printer is, without logging in. The token carries the company id (so the Worker knows which
// company to ask) plus 12 random bytes (so links cannot be guessed). Customers also get an email with
// the link when the RMA is raised and at each step they care about (company setting `customer_updates`).

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function makeTrackToken(companyId) {
  const hex = String(companyId).replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error('bad company id');
  const bytes = new Uint8Array(28);
  for (let i = 0; i < 16; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  bytes.set(crypto.getRandomValues(new Uint8Array(12)), 16);
  return b64url(bytes);
}

// Company id from a token, or null when it is not one of ours.
export function companyFromToken(token) {
  if (!/^[A-Za-z0-9_-]{37,38}$/.test(String(token || ''))) return null;
  try {
    const bin = atob(token.replace(/-/g, '+').replace(/_/g, '/'));
    if (bin.length !== 28) return null;
    const hex = [...bin.slice(0, 16)].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  } catch {
    return null;
  }
}

export function migrateV5(sql) {
  try { sql.exec('ALTER TABLE tickets ADD COLUMN track_token TEXT'); } catch { /* already there */ }
  sql.exec('CREATE UNIQUE INDEX IF NOT EXISTS tickets_track ON tickets(track_token)');
  sql.exec(`CREATE TABLE IF NOT EXISTS customer_notices (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL,
    kind TEXT NOT NULL, status TEXT, at INTEGER NOT NULL, taken_at INTEGER, sent_to TEXT, ok INTEGER, error TEXT)`);
  sql.exec('CREATE INDEX IF NOT EXISTS customer_notices_pending ON customer_notices(taken_at)');
}

// What the customer sees: five plain steps instead of the internal stages.
export const TRACK_STEPS = ['Received', 'With the manufacturer', 'Back at the service centre', 'Dispatched to you', 'Completed'];
const STEP_OF = {
  OPEN: 0, AWAITING_OEM_RMA: 1, OEM_RMA_RECEIVED: 1, DISPATCHED_TO_OEM: 1,
  GOODS_RECEIVED_FROM_OEM: 2, DISPATCHED_TO_CUSTOMER: 3, CLOSED: 4, CLOSED_RETURNED: 4,
};
const MESSAGE = {
  OPEN: 'We have received your item and logged the return.',
  AWAITING_OEM_RMA: 'We have raised the claim with the manufacturer and are waiting for their approval.',
  OEM_RMA_RECEIVED: 'The manufacturer has approved the claim. We are preparing the shipment to them.',
  DISPATCHED_TO_OEM: 'Your item is on its way to the manufacturer for repair or replacement.',
  GOODS_RECEIVED_FROM_OEM: 'The repaired or replacement part is back with us. We will dispatch it to you shortly.',
  DISPATCHED_TO_CUSTOMER: 'Your item has been dispatched to you.',
  CLOSED: 'This return is complete. Thank you for your patience.',
  CLOSED_RETURNED: 'This return has been closed and the item returned to you.',
};
// Steps that trigger a customer email (the rest are internal back-and-forth with the OEM).
const NOTIFY = ['OPEN', 'DISPATCHED_TO_OEM', 'GOODS_RECEIVED_FROM_OEM', 'DISPATCHED_TO_CUSTOMER', 'CLOSED', 'CLOSED_RETURNED'];

const istDate = (ms) => (ms ? new Date(ms + 5.5 * 3600e3).toISOString().slice(0, 10) : null);
const customerEmail = (t) => (t.customer_email || t.ship_to_email || '').trim();

export const trackMethods = {
  trackToken(ticketId, companyId) {
    const t = this.one('SELECT id, track_token FROM tickets WHERE id = ?', ticketId);
    if (!t) return null;
    if (t.track_token) return t.track_token;
    const token = makeTrackToken(companyId);
    this.sql.exec('UPDATE tickets SET track_token = ? WHERE id = ?', token, t.id);
    return token;
  },

  // Called wherever an RMA moves to a new stage. Only queues; the Worker sends after the change is saved.
  queueCustomerNotice(ticketId, status) {
    if (!NOTIFY.includes(status)) return;
    if (this.settings().customer_updates !== '1') return;
    const t = this.one('SELECT customer_email, ship_to_email, is_imported FROM tickets WHERE id = ?', ticketId);
    if (!t || t.is_imported || !customerEmail(t)) return;
    this.sql.exec("INSERT INTO customer_notices (ticket_id, kind, status, at) VALUES (?, 'update', ?, ?)", ticketId, status, Date.now());
  },

  centreProfile(companyName) {
    const s = this.settings();
    const logo = this.one('SELECT updated_at FROM files WHERE id = ?', 'company_logo');
    return { name: companyName || '', email: s.company_email || '', phone: s.company_phone || '', city: s.company_city || '', logoAt: logo?.updated_at || null };
  },

  trackSummary(t) {
    const step = STEP_OF[t.status] ?? 0;
    const dates = [istDate(t.created_at), t.oem_dispatch_date || istDate(t.oem_email_sent_at), t.goods_received_date, t.dispatch_to_customer_date, istDate(t.closed_at)];
    return {
      ticketNo: t.ticket_no, status: t.status, step, returned: t.status === 'CLOSED_RETURNED',
      message: MESSAGE[t.status] || '',
      steps: TRACK_STEPS.map((label, i) => ({ label: i === 4 && t.status === 'CLOSED_RETURNED' ? 'Closed – returned' : label, date: i <= step ? dates[i] || null : null, done: i < step || (i === step && step === 4), current: i === step && step < 4 })),
      item: [t.printer_model, t.faulty_part && t.faulty_part !== 'Printer' ? t.faulty_part : null].filter(Boolean).join(' · '),
      serial: t.printer_sn || '', customer: t.customer_company || '', docket: t.status === 'DISPATCHED_TO_CUSTOMER' || step === 4 ? t.dispatch_docket || '' : '',
      updatedAt: t.updated_at,
    };
  },

  // ----- for signed-in staff -----
  trackLink(user, { id }) {
    const t = this.one('SELECT id, customer_email, ship_to_email FROM tickets WHERE id = ?', Number(id));
    if (!t) throw Object.assign(new Error('RMA not found.'), { status: 404 });
    return { token: this.trackToken(t.id, user.companyId), email: customerEmail(t), updates: this.settings().customer_updates === '1' };
  },
  // Data for "Email status link to customer"; the Worker sends it and records the result.
  trackLinkMail(user, { id, to }) {
    const t = this.one('SELECT * FROM tickets WHERE id = ?', Number(id));
    if (!t) throw Object.assign(new Error('RMA not found.'), { status: 404 });
    const email = String(to || customerEmail(t)).trim();
    if (!/^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(email)) throw Object.assign(new Error('This RMA has no customer email. Add one to the RMA first.'), { status: 422 });
    const token = this.trackToken(t.id, user.companyId);
    this.event(t.id, user, 'status link emailed', `To ${email}`);
    return { to: email, token, view: this.trackSummary(t), centre: this.centreProfile(user.companyName), contact: t.customer_contact_name || '' };
  },
  // Queued step emails, taken once (the Worker sends them right after the change).
  takeCustomerNotices(user) {
    const rows = this.all('SELECT n.id, n.ticket_id, n.status FROM customer_notices n WHERE n.taken_at IS NULL ORDER BY n.id LIMIT 50');
    if (!rows.length) return { items: [] };
    const now = Date.now();
    const out = [];
    for (const n of rows) {
      this.sql.exec('UPDATE customer_notices SET taken_at = ? WHERE id = ?', now, n.id);
      const t = this.one('SELECT * FROM tickets WHERE id = ?', n.ticket_id);
      if (!t || !customerEmail(t)) continue;
      out.push({ noticeId: n.id, to: customerEmail(t), token: this.trackToken(t.id, user.companyId), view: { ...this.trackSummary(t), status: n.status, message: MESSAGE[n.status] || '' }, contact: t.customer_contact_name || '' });
    }
    return { items: out, centre: this.centreProfile(user.companyName) };
  },
  customerNoticeResults(user, { results = [] }) {
    for (const r of results.slice(0, 50)) {
      this.sql.exec('UPDATE customer_notices SET sent_to = ?, ok = ?, error = ? WHERE id = ?', r.to || null, r.ok ? 1 : 0, r.ok ? null : String(r.error || '').slice(0, 300), Number(r.noticeId));
      const n = this.one('SELECT ticket_id, status FROM customer_notices WHERE id = ?', Number(r.noticeId));
      if (n) this.event(n.ticket_id, null, r.ok ? 'customer emailed' : 'customer email failed', `${r.to}${r.ok ? '' : `: ${String(r.error || '').slice(0, 200)}`}`);
    }
    return { ok: true };
  },

  // ----- public (no login): the Worker checks the token / rate limits before calling -----
  trackView({ token, companyName }) {
    const t = this.one('SELECT * FROM tickets WHERE track_token = ?', String(token));
    if (!t) return null;
    return { ...this.trackSummary(t), centre: this.centreProfile(companyName) };
  },
  // "Check status" by RMA number: returns where to email the link (never shown to the person asking).
  trackLookup({ rmaNumber, companyId, companyName }) {
    const t = this.one('SELECT * FROM tickets WHERE ticket_no = ? COLLATE NOCASE', String(rmaNumber).trim());
    if (!t) return null;
    const email = customerEmail(t);
    if (!email) return { found: true, emailed: false };
    const sentToday = this.one("SELECT COUNT(*) AS n FROM customer_notices WHERE ticket_id = ? AND kind = 'lookup' AND at > ?", t.id, Date.now() - 86400e3).n;
    if (sentToday >= 3) return { found: true, emailed: false, limited: true };
    this.sql.exec("INSERT INTO customer_notices (ticket_id, kind, at, taken_at, sent_to) VALUES (?, 'lookup', ?, ?, ?)", t.id, Date.now(), Date.now(), email);
    this.event(t.id, null, 'status link requested', `Emailed to ${email}`);
    return { found: true, to: email, token: this.trackToken(t.id, companyId), view: this.trackSummary(t), centre: this.centreProfile(companyName), contact: t.customer_contact_name || '' };
  },
};
