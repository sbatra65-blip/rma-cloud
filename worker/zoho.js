// Zoho Books client (Self Client OAuth). One per company; credentials come from the company's own settings.
const DCS = {
  com: ['https://accounts.zoho.com', 'https://www.zohoapis.com'],
  in: ['https://accounts.zoho.in', 'https://www.zohoapis.in'],
  eu: ['https://accounts.zoho.eu', 'https://www.zohoapis.eu'],
  au: ['https://accounts.zoho.com.au', 'https://www.zohoapis.com.au'],
  jp: ['https://accounts.zoho.jp', 'https://www.zohoapis.jp'],
  ca: ['https://accounts.zohocloud.ca', 'https://www.zohoapis.ca'],
  sa: ['https://accounts.zoho.sa', 'https://www.zohoapis.sa'],
};
const zerr = (status, message) => Object.assign(new Error(message), { status });
const str = (v) => (v === null || v === undefined ? null : String(v));
const first = (...vals) => vals.map(str).find((v) => v && v.trim()) ?? null;

async function tokenPost(accounts, form) {
  const res = await fetch(`${accounts}/oauth/v2/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { error: 'non_json', raw: text.slice(0, 300) }; }
}

export class Zoho {
  static DCS = DCS;
  static excludedPoStatus(s) { return ['draft', 'cancelled', 'canceled', 'deleted'].includes(String(s || '').trim().toLowerCase()); }
  static isOemVendor(name) { const n = String(name || '').toUpperCase(); return n.includes('TSC') || n.includes('PRINTRONIX') || n.includes('HONEYWELL'); }

  // Turns a one-time Self Client grant code into a long-lived refresh token.
  static async exchangeGrant({ dc, clientId, clientSecret, code }) {
    const [accounts] = DCS[dc] || DCS.com;
    const r = await tokenPost(accounts, { code, client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code' });
    if (r.refresh_token) return r.refresh_token;
    const why = r.error === 'invalid_code'
      ? 'the grant code is invalid, expired or already used. Generate a NEW code (it lasts a few minutes) with scope ZohoBooks.fullaccess.all and try again'
      : r.error === 'invalid_client' ? 'Client ID / Secret are wrong, or belong to a different data centre than the one selected'
        : `${r.error || 'no refresh token returned'}${r.raw ? `: ${r.raw}` : ''}`;
    throw zerr(422, `Zoho connect failed — ${why}. (Calling ${accounts}.)`);
  }

  constructor({ dc, orgId, clientId, clientSecret, refreshToken, cache }) {
    [this.accounts, this.api] = DCS[dc] || DCS.com;
    Object.assign(this, { orgId, clientId, clientSecret, refreshToken, cache });
  }

  async token(force = false) {
    const c = this.cache.get();
    if (!force && c && c.exp > Date.now()) return c.token;
    const r = await tokenPost(this.accounts, { refresh_token: this.refreshToken, client_id: this.clientId, client_secret: this.clientSecret, grant_type: 'refresh_token' });
    if (r.access_token) {
      const life = Number(r.expires_in) > 60 ? Number(r.expires_in) : 3300;
      this.cache.set({ token: r.access_token, exp: Date.now() + Math.max(60, life - 120) * 1000 });
      return r.access_token;
    }
    // Rate limited: keep using a token that expired less than 10 minutes ago.
    if (c && (/too many requests/i.test(JSON.stringify(r)) || r.error === 'Access Denied') && c.exp + 600000 > Date.now()) return c.token;
    throw zerr(502, `Zoho sign-in failed (${r.error || 'unknown'}). Reconnect Zoho Books in Company settings with a fresh grant code.`);
  }

  async call(method, path, { query = {}, body } = {}, retried = false) {
    const url = new URL(`${this.api}/books/v3/${path}`);
    url.searchParams.set('organization_id', this.orgId);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Zoho-oauthtoken ${await this.token(retried)}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && !retried) {
      this.cache.set(null);
      return this.call(method, path, { query, body }, true);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || (data.code && data.code !== 0)) throw zerr(502, `Zoho Books said: ${data.message || `HTTP ${res.status}`}${data.code ? ` (code ${data.code})` : ''}`);
    return data;
  }

  async test() {
    const d = await this.call('GET', `organizations/${encodeURIComponent(this.orgId)}`);
    return `Connected to Zoho Books: ${d.organization?.name || this.orgId}`;
  }

  async invoiceByNumber(number) {
    const list = await this.call('GET', 'invoices', { query: { invoice_number: number } });
    const hit = (list.invoices || []).find((i) => String(i.invoice_number).toUpperCase() === number.toUpperCase()) || list.invoices?.[0];
    if (!hit) return null;
    const { invoice: i } = await this.call('GET', `invoices/${hit.invoice_id}`);
    if (!i) return null;
    const e = i.einvoice_details && typeof i.einvoice_details === 'object' ? i.einvoice_details : {};
    return {
      invoiceId: str(i.invoice_id), invoiceNumber: str(i.invoice_number) || number, customerName: str(i.customer_name), customerCity: str(i.billing_address?.city),
      date: str(i.date), total: Number(i.total || 0), status: str(i.status), irn: first(e.irn, i.irn), irnAckNo: first(e.ack_no, e.ack_number),
      irnAckDate: first(e.ack_date), notes: first(i.notes, i.terms, i.customer_notes),
      lineItems: (i.line_items || []).map((l) => ({
        name: first(l.name, l.item_name) || '', description: first(l.description, l.item_description, l.line_item_description, l.header_name),
        quantity: Number(l.quantity || 0), rate: Number(l.rate || 0),
      })),
    };
  }

  poSummary(p) {
    return {
      id: str(p.purchaseorder_id), number: str(p.purchaseorder_number), reference: str(p.reference_number), vendorName: str(p.vendor_name),
      date: str(p.date), status: str(p.status) || 'issued', currency: str(p.currency_code), total: Number(p.total || 0),
      quantity: Number(p.quantity ?? p.total_quantity ?? 0),
    };
  }
  // All issued/closed POs, newest first (pages through instead of stopping at the first 200).
  async purchaseOrders(maxPages = 5) {
    const out = [];
    for (let page = 1; page <= maxPages; page++) {
      const d = await this.call('GET', 'purchaseorders', { query: { filter_by: 'Status.All', per_page: 200, page, sort_column: 'date', sort_order: 'D' } });
      out.push(...(d.purchaseorders || []).map((p) => this.poSummary(p)));
      if (!d.page_context?.has_more_page) break;
    }
    return out.filter((p) => !Zoho.excludedPoStatus(p.status));
  }
  async purchaseOrderById(id) {
    if (!id) return null;
    const { purchaseorder: p } = await this.call('GET', `purchaseorders/${encodeURIComponent(id)}`);
    if (!p) return null;
    return { ...this.poSummary(p), lineItems: (p.line_items || []).map((l) => ({ name: str(l.name), description: str(l.description), quantity: Number(l.quantity || 0) })) };
  }
  async purchaseOrderByNumber(number) {
    for (const q of [{ purchaseorder_number: number }, { search_text: number }]) {
      const d = await this.call('GET', 'purchaseorders', { query: q });
      const list = d.purchaseorders || [];
      if (!list.length) continue;
      const hit = list.find((p) => String(p.purchaseorder_number).toUpperCase() === number.toUpperCase()) || list[0];
      return this.purchaseOrderById(hit.purchaseorder_id);
    }
    return null;
  }

  // Customer contact by exact name (Zoho requires customer_id on a delivery challan).
  async findContact(name) {
    if (!name) return null;
    const d = await this.call('GET', 'contacts', { query: { contact_name: name, contact_type: 'customer' } });
    const list = d.contacts || [];
    return list.find((c) => String(c.contact_name).toUpperCase() === name.toUpperCase()) || null;
  }
  async createDeliveryChallan(body) {
    const d = await this.call('POST', 'deliverychallans', { body });
    const c = d.deliverychallan || d.delivery_challan || {};
    return { id: str(c.deliverychallan_id || c.delivery_challan_id), number: str(c.deliverychallan_number || c.delivery_challan_number) };
  }
}
