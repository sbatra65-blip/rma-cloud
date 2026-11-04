// End-to-end API checks against `wrangler dev` (http://localhost:8787 by default).
// Starts from an empty database: run `rm -rf .wrangler/state` first if you ran it before.
import { createHmac } from 'node:crypto';

const BASE = process.env.BASE || 'http://localhost:8787';
let pass = 0;
let fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`, extra ?? ''); }
};

// ---- TOTP (RFC 6238) with replay-safe counters ----
function b32decode(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0;
  const out = [];
  for (const ch of s.replace(/=+$/, '')) {
    value = (value << 5) | A.indexOf(ch);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function hotp(secret, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', b32decode(secret)).update(buf).digest();
  const off = mac[mac.length - 1] & 15;
  return String(((mac.readUInt32BE(off) & 0x7fffffff) % 1_000_000)).padStart(6, '0');
}
const used = new Map();
async function totp(secret) {
  for (;;) {
    const now = Math.floor(Date.now() / 30000);
    const last = used.get(secret) ?? -1;
    const c = Math.max(now, last + 1);
    if (c <= now + 1) { used.set(secret, c); return hotp(secret, c); }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// ---- tiny client with its own cookie jar ----
function client(ua = 'smoke') {
  let cookie = '';
  return async function call(method, path, body, { raw = false, headers = {} } = {}) {
    const isBin = body instanceof Uint8Array || body instanceof ArrayBuffer;
    const res = await fetch(BASE + path, {
      method,
      headers: {
        Origin: BASE, 'User-Agent': ua, ...(cookie ? { Cookie: cookie } : {}),
        ...(body !== undefined && !isBin ? { 'Content-Type': 'application/json' } : {}), ...headers,
      },
      body: body === undefined ? undefined : isBin ? body : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) {
      const v = set.split(';')[0];
      cookie = v.endsWith('=') ? '' : v;
    }
    if (raw) return res;
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : null;
    return { status: res.status, data };
  };
}

async function enroll(api, setup) {
  const r = await api('POST', '/api/auth/enroll', { setupToken: setup.setupToken, code: await totp(setup.secret) });
  return r;
}
async function login(api, companyCode, email, password, secret, endOther = false) {
  const a = await api('POST', '/api/auth/login', { companyCode, email, password });
  if (a.status !== 200) return a;
  return api('POST', '/api/auth/login/verify', { loginToken: a.data.loginToken, code: await totp(secret), endOther });
}

const PW = 'Correct-Horse-91!x';
const PW2 = 'Battery-Staple-73#q';
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(60).fill(1), 0xff, 0xd9]);

console.log('Setup and login');
const owner = client('Chrome on Windows PC');
let r = await owner('GET', '/api/setup');
ok(r.data?.needsSetup === true, 'fresh database needs setup', r.data);
r = await owner('POST', '/api/setup', { name: 'Sanjay', email: 'owner@example.com', password: 'short', confirm: 'short', companyName: 'Infinite Solutions', companyCode: 'INF', ticketPrefix: 'INF' });
ok(r.status === 422 && r.data.fields?.password, 'weak password rejected');
r = await owner('POST', '/api/setup', { name: 'Sanjay', email: 'owner@example.com', password: PW, confirm: PW, companyName: 'Infinite Solutions', companyCode: 'inf', ticketPrefix: 'INF' });
ok(r.status === 200 && r.data.secret && r.data.otpauth.includes('INF'), 'setup returns authenticator secret', r.data);
const setupA = r.data;
const ownerSecret = setupA.secret;
r = await owner('POST', '/api/auth/enroll', { setupToken: setupA.setupToken, code: '000000' });
ok(r.status === 400, 'wrong enroll code rejected');
r = await enroll(owner, setupA);
ok(r.status === 200 && r.data.recoveryCodes?.length === 10 && r.data.user.isOwner && r.data.user.role === 'Admin', 'enroll signs in as owner Admin with 10 recovery codes', r.data);
const ownerRecovery = r.data.recoveryCodes;
r = await owner('GET', '/api/setup');
ok(r.data.needsSetup === false, 'setup closed after first login');
r = await owner('POST', '/api/setup', { name: 'X', email: 'x@example.com', password: PW, confirm: PW, companyName: 'Hijack', companyCode: 'HJ', ticketPrefix: 'HJ' });
ok(r.status === 409, 'second setup refused');
r = await owner('GET', '/api/auth/me');
ok(r.status === 200 && r.data.user.company.code === 'INF', 'session works (me)');

const anon = client();
r = await anon('GET', '/api/dashboard');
ok(r.status === 401, 'no session → 401');
r = await anon('POST', '/api/auth/login', { companyCode: 'INF', email: 'owner@example.com', password: PW }, { headers: { Origin: 'https://evil.example' } });
ok(r.status === 403, 'cross-site POST blocked');
r = await anon('POST', '/api/auth/login', { companyCode: 'NOPE', email: 'owner@example.com', password: PW });
ok(r.status === 401, 'wrong company code → same 401');
r = await anon('POST', '/api/auth/login', { companyCode: 'INF', email: 'owner@example.com', password: 'Wrong-pass-123!' });
ok(r.status === 401, 'wrong password → 401');
r = await login(anon, 'INF', 'owner@example.com', PW, ownerSecret);
ok(r.status === 409 && r.data.active, 'second device blocked while owner is signed in');

console.log('RMA tickets');
const base = {
  customer_company: 'Acme Logistics', customer_city: 'Delhi', printer_model: 'TE310', printer_sn: 'teb t25370458',
  faulty_part: 'Head', faulty_part_sn: 'h-1001', failure_description: 'Lines on print', tph_mileage: '12.5',
};
r = await owner('POST', '/api/rma', { ticket: { ...base, printer_sn: '' } });
ok(r.status === 422 && r.data.fields?.printer_sn, 'serial required');
r = await owner('POST', '/api/rma', { ticket: base });
ok(r.status === 200 && /^INF-RMA-\d{6}-0001$/.test(r.data.ticket.ticket_no) && r.data.ticket.printer_sn === 'TEBT25370458', 'create RMA, number + serial cleaned', r.data?.ticket?.ticket_no);
const t1 = r.data.ticket;
r = await owner('POST', '/api/rma', { ticket: { ...base, faulty_part_sn: ' h-1001.' } });
ok(r.status === 409 && r.data.code === 'duplicate', 'same part SN blocked as duplicate');
r = await owner('POST', '/api/rma', { ticket: { ...base, faulty_part: 'Platen roller', faulty_part_sn: 'P-9' } });
ok(r.status === 200, 'different part on same printer allowed');
const t2 = r.data.ticket;
ok(r.data.sameMachine.length === 1, 'detail shows other open RMA on same printer');
r = await owner('POST', '/api/rma', { ticket: { ...base, faulty_part_sn: 'H-1001' }, overrideReason: 'Customer sent second head by mistake' });
ok(r.status === 200 && r.data.ticket.dup_reason?.includes('Customer sent'), 'Admin override with reason stamped');
const t3 = r.data.ticket;

r = await owner('GET', '/api/rma?q=TEBT25370458');
ok(r.data.rows.length === 3, 'search by serial');
r = await owner('POST', `/api/rma/${t1.id}/action`, { action: 'goods_received' });
ok(r.status === 409, 'out-of-order status step blocked');
r = await owner('POST', `/api/rma/${t1.id}/action`, { action: 'oem_rma', data: { oem_rma_number: 'TEBT25-RMA-1' } });
ok(r.status === 200 && r.data.ticket.status === 'OEM_RMA_RECEIVED', 'OEM RMA # saved');
r = await owner('POST', `/api/rma/${t2.id}/action`, { action: 'oem_rma', data: { oem_rma_number: 'TEBT25-RMA-1' } });
ok(r.status === 409 && r.data.code === 'oem_rma_used', 'same OEM RMA # on another ticket warned');

r = await owner('POST', `/api/rma/${t1.id}/photos`, JPEG, { headers: { 'X-Direction': 'INBOUND', 'X-File-Name': 'head.jpg' } });
ok(r.status === 200 && r.data.id, 'photo upload');
const photoId = r.data.id;
r = await owner('POST', `/api/rma/${t1.id}/photos`, new TextEncoder().encode('<script>alert(1)</script>'), { headers: { 'X-File-Name': 'x.jpg' } });
ok(r.status === 422, 'non-image upload rejected');
let res = await owner('GET', `/api/photos/${photoId}`, undefined, { raw: true });
ok(res.status === 200 && res.headers.get('content-type') === 'image/jpeg', 'photo download');
res = await owner('GET', '/api/template', undefined, { raw: true });
ok(res.status === 200 && (await res.arrayBuffer()).byteLength > 50000, 'default OEM Excel template served');
r = await owner('GET', `/api/rma/${t1.id}/email`);
ok(r.data.fileName === 'TE310_TEBT25370458_Head.xlsx' && r.data.to.includes('tsc_rma@tscprinters.com'), 'OEM email draft + file name', r.data?.fileName);

r = await owner('DELETE', `/api/rma/${t3.id}`);
ok(r.status === 200, 'delete OPEN ticket');

console.log('Batch to OEM and closing');
r = await owner('GET', '/api/batches');
ok(r.data.candidates.length === 1, 'one ticket ready for batch');
r = await owner('POST', '/api/batches', { ticketIds: [t1.id, t2.id], dispatch_date: new Date().toISOString().slice(0, 10) });
ok(r.status === 409, 'batch refuses ticket without OEM RMA #');
r = await owner('POST', '/api/batches', { ticketIds: [t1.id], dispatch_date: new Date().toISOString().slice(0, 10), courier: 'Blue Dart', docket: 'BD123' });
ok(r.status === 200 && /^BATCH-\d{6}$/.test(r.data.batch.batch_code) && r.data.tickets[0].status === 'DISPATCHED_TO_OEM', 'batch created, ticket dispatched');
r = await owner('DELETE', `/api/rma/${t1.id}`);
ok(r.status === 409, 'cannot delete after OEM dispatch');
for (const [action, data] of [['goods_received', {}], ['dispatch_customer', { challan_number: 'DC-77' }], ['close', { closure_remarks: 'Head replaced' }]]) {
  r = await owner('POST', `/api/rma/${t1.id}/action`, { action, data });
}
ok(r.status === 200 && r.data.ticket.status === 'CLOSED' && r.data.ticket.closure_type === 'REPAIRED', 'goods back → customer → closed');
ok(r.data.events.length >= 6, 'history recorded');
r = await owner('POST', '/api/rma', { ticket: { ...base } });
ok(r.status === 200, 'closed RMA no longer blocks a new one for same part');

console.log('Dashboard, reminders, import, masters');
r = await owner('GET', '/api/dashboard');
ok(r.status === 200 && r.data.total === 3 && r.data.counts.CLOSED === 1, 'dashboard counts', r.data?.counts);
r = await owner('GET', '/api/reminders');
ok(r.data.items.some((i) => i.kind === 'Generate OEM Excel'), 'reminders list');
r = await owner('POST', '/api/import/rma', { fileName: 'old.xlsx', rows: [
  { _row: 2, printer_sn: 'TEBT2200001', printer_model: 'TE200', customer_company: 'Old Co', status: 'Closed', created_at: '15-03-2025', oem_rma_number: 'OLD-1' },
  { _row: 3, printer_sn: 'TEBT2200002', status: 'sent to tsc', created_at: '45000' },
  { _row: 4, printer_sn: '', status: 'open' },
  { _row: 5, printer_sn: 'TEBT2200003', oem_rma_number: 'OLD-1' },
] });
ok(r.data.imported === 2 && r.data.errors === 1 && r.data.duplicates === 1, 'import: 2 in, 1 error, 1 duplicate', r.data);
r = await owner('GET', '/api/rma?q=TEBT2200001');
ok(r.data.rows[0]?.ticket_no === 'INF-RMA-202503-0001' && r.data.rows[0].status === 'CLOSED', 'imported ticket numbered by its own month');
r = await owner('POST', '/api/masters/oems', { code: 'tsc', name: 'TSC Auto ID' });
ok(r.status === 200 && r.data.oems[0].code === 'TSC', 'add OEM');
r = await owner('POST', '/api/masters/products', { oem_id: r.data.oems[0].id, code: 'DT', name: 'Desktop printers' });
r = await owner('POST', '/api/masters/models', { product_id: r.data.products[0].id, code: 'TE310', name: 'TE310 300 dpi' });
ok(r.data.models.length === 1, 'add product and model');
r = await owner('POST', '/api/masters/customers', { name: 'Acme Logistics', city: 'Delhi', gstin: 'bad' });
ok(r.status === 422 && r.data.fields?.gstin, 'GSTIN validated');
r = await owner('POST', '/api/import/customers', { rows: [{ name: 'Acme Logistics', city: 'Delhi' }, { name: 'Beta Retail', email: 'ops@beta.in' }] });
ok(r.data.added === 2 && r.data.masters.customers[0].code.startsWith('C'), 'customer import with auto codes');


console.log('Several parts from one printer, same day');
r = await owner('POST', '/api/rma', { ticket: { ...base, printer_sn: 'TEBT7770001', faulty_part: 'Head', faulty_part_sn: 'HX-1' } });
const mp1 = r.data.ticket;
r = await owner('POST', '/api/rma', { ticket: { ...base, printer_sn: 'TEBT7770001', faulty_part: 'Main board', faulty_part_sn: 'MB-9', failure_description: 'No power' } });
ok(r.status === 200 && r.data.sameMachine.some((t) => t.id === mp1.id), 'second part on same printer same day allowed, linked as same machine');
r = await owner('POST', '/api/rma', { ticket: { ...base, printer_sn: 'TEBT7770001', faulty_part: 'Platen roller', faulty_part_sn: '' } });
ok(r.status === 200, 'third part (no part serial) allowed');
r = await owner('POST', '/api/rma', { ticket: { ...base, printer_sn: 'TEBT7770001', faulty_part: 'platen  ROLLER', faulty_part_sn: '' } });
ok(r.status === 409, 'same part type again with no serial blocked');
r = await owner('GET', `/api/rma/${mp1.id}/email`);
ok(r.data.fileName === 'TE310_TEBT7770001_Head.xlsx', 'each part gets its own Excel name');

console.log('Care Pack');
const cp = (o = {}) => ({ invoice_number: 'IS-GST-2627-0300', invoice_date: '2026-10-01', customer_name: 'Acme Logistics', source: 'manual',
  products: [{ printer_model: 'TE310', oem_brand: 'TSC Auto ID', care_pack_type: '3 Year', serial_text: 'S/N: CPX0001, CPX0002', qty: 2 }], ...o });
r = await owner('POST', '/api/carepack/register', cp({ products: [{ printer_model: 'TE310', oem_brand: 'TSC Auto ID', care_pack_type: '3 Year', serial_text: 'CPX0001', qty: 2 }] }));
ok(r.status === 422 && r.data.fields?.p0_serials, 'qty must equal serial count');
r = await owner('POST', '/api/carepack/register', cp({ products: [{ printer_model: 'TE310', oem_brand: 'Printronix', care_pack_type: '3 Year', serial_text: 'CPX0001, CPX0002', qty: 2 }] }));
ok(r.status === 422 && /TSC Auto ID model/.test(r.data.error), 'brand that contradicts model blocked');
r = await owner('POST', '/api/carepack/register', cp({ invoice_date: '2020-01-01', products: [{ printer_model: 'TE310', oem_brand: 'TSC Auto ID', care_pack_type: '1 Year', serial_text: 'OLD1', qty: 1 }] }));
ok(r.status === 422 && /already ended/.test(r.data.error), 'expired care pack cannot be registered');
r = await owner('POST', '/api/carepack/register', cp({ products: [
  { printer_model: 'TE310', oem_brand: 'TSC Auto ID', care_pack_type: '3 Year', serial_text: 'S/N: CPX0001, CPX0002', qty: 2 },
  { printer_model: 'T6304E', oem_brand: 'Printronix', care_pack_type: '5 Year', serial_text: 't6ev 900001', qty: 1 }] }));
ok(r.status === 200 && r.data.ids.length === 2, 'manual register: 2 product sets');
const cpId = r.data.ids[0];
r = await owner('POST', '/api/carepack/register', cp({ invoice_number: 'IS-GST-2627-0301', products: [{ printer_model: 'TE310', oem_brand: 'TSC Auto ID', care_pack_type: '3 Year', serial_text: 'cpx0002', qty: 1 }] }));
ok(r.status === 409 && /CPX0002 \(invoice IS-GST-2627-0300\)/.test(r.data.error), 'serial already registered elsewhere blocked');
r = await owner('POST', '/api/carepack/register', cp({ products: [{ printer_model: 'TE310', oem_brand: 'TSC Auto ID', care_pack_type: '3 Year', serial_text: 'NEW0009', qty: 1 }] }));
ok(r.status === 409 && /already exists/.test(r.data.error), 'same invoice cannot be registered twice');
r = await owner('GET', '/api/carepack/serial?sn=cpx 0001');
ok(r.data.device?.warranty_end === '2029-10-01' && !r.data.device.expired, 'serial lookup + 3-year cover end');
r = await owner('GET', `/api/carepack/${cpId}`);
ok(r.data.canDelete && r.data.canEditDevices, 'fresh batch editable and deletable');

r = await owner('POST', '/api/rma', { ticket: { ...base, printer_sn: 'CPX0001', faulty_part: 'Head', faulty_part_sn: 'ZZ1' } });
ok(r.status === 200 && r.data.cover?.serial_number === 'CPX0001', 'RMA shows care pack cover');
r = await owner('GET', `/api/carepack/${cpId}`);
ok(!r.data.canDelete && /linked to RMA/.test(r.data.deleteHint), 'batch delete blocked once an RMA uses its serial');
r = await owner('POST', '/api/rma', { ticket: { ...base, printer_sn: 'NOTINCP9', faulty_part: 'Head', faulty_part_sn: 'ZZ2' }, addToCarePack: { reason: 'SN missing from import' } });
ok(r.status === 200 && r.data.cover?.serial_number === 'NOTINCP9' && r.data.cover.overridden, 'RMA adds missing serial to care pack (override)', JSON.stringify(r.data).slice(0, 300));

// PO: manual with serials missing → blocked; then perfect match
const poIn = (o = {}) => ({ batchId: cpId, mode: 'manual', po: { number: 'PO-2627-0087', vendor: 'TSC AUTO ID', currency: 'USD', qty: 2 }, ...o });
r = await owner('POST', '/api/carepack/po-preview', poIn({ serials: ['CPX0001'] }));
ok(r.status === 200 && !r.data.allMatch && r.data.matches[0].missing[0] === 'CPX0002', 'PO preview shows missing serial');
r = await owner('POST', '/api/carepack/po-confirm', poIn({ serials: ['CPX0001'] }));
ok(r.status === 422, 'mismatched PO not linked without Accept Anyway');
r = await owner('POST', '/api/carepack/po-confirm', poIn({ serials: ['CPX0001', 'CPX0002', 'OTHER77'] }));
ok(r.status === 200 && r.data.linked === 1, 'perfect (clubbed) PO linked');
r = await owner('GET', `/api/carepack/${cpId}`);
ok(r.data.batch.status === 'PO_VALIDATED' && !r.data.canEditDevices && r.data.batch.po_matched, 'serials locked after PO');
r = await owner('POST', `/api/carepack/${cpId}/oem`, { oem_invoice_number: 'TSC-INV-55', oem_invoice_date: '2026-10-20', oem_amount: 1200, oem_currency: 'USD' });
r = await owner('POST', `/api/carepack/${cpId}/pdf`, new TextEncoder().encode('%PDF-1.4 fake'), { headers: { 'X-File-Name': 'oem.pdf' } });
ok(r.status === 200 && r.data.batch.status === 'COMPLETE' && r.data.batch.verified, '100% verified after PO + OEM invoice + PDF');
r = await owner('POST', `/api/carepack/${cpId}/paid`, { paid: true });
r = await owner('POST', `/api/carepack/${cpId}/remove`, { kind: 'po', reason: 'wrong', confirmed: true });
ok(r.status === 409 && /payment is still recorded/.test(r.data.error), 'remove order enforced (payment first)');
for (const kind of ['payment', 'invoice', 'po']) r = await owner('POST', `/api/carepack/${cpId}/remove`, { kind, reason: 'Wrong PO linked', confirmed: true });
ok(r.status === 200 && r.data.batch.status === 'IMPORTED' && r.data.audits.length === 3, 'payment → invoice → PO removed with 3 audit rows');
r = await owner('GET', '/api/carepack/pending');
ok(r.status === 200 && r.data.noPo.length >= 2, 'pending report');
r = await owner('GET', '/api/dashboard');
ok(r.data.carePack.devices === 4 && r.data.carePack.batches === 3, 'dashboard care pack counts', r.data.carePack);

console.log('Users and roles (company INF)');
r = await owner('POST', '/api/admin/users', { name: 'Ravi Tech', email: 'ravi@example.com', role: 'Technician' });
ok(r.status === 200 && r.data.link.includes('/invite#token='), 'invite technician (link returned)');
const ravi = client('Chrome on Android');
const raviToken = decodeURIComponent(r.data.link.split('token=')[1]);
r = await ravi('POST', '/api/auth/invite/check', { token: raviToken });
ok(r.data.company.code === 'INF', 'invite shows company');
r = await ravi('POST', '/api/auth/invite/accept', { token: raviToken, password: PW2, confirm: PW2 });
const raviSecret = r.data.secret;
r = await enroll(ravi, r.data);
ok(r.status === 200 && r.data.user.role === 'Technician', 'technician set up with 2FA');
r = await ravi('POST', '/api/masters/oems', { code: 'HON', name: 'Honeywell' });
ok(r.status === 403, 'technician cannot edit masters');
r = await ravi('GET', '/api/admin/users');
ok(r.status === 403, 'technician cannot manage users');
r = await ravi('POST', '/api/rma', { ticket: { ...base, printer_sn: 'TEBT9990001', faulty_part_sn: 'X1' } });
ok(r.status === 200, 'technician can raise RMA');
const raviTicket = r.data.ticket;
r = await ravi('POST', '/api/rma', { ticket: { ...base, printer_sn: 'TEBT9990001', faulty_part_sn: 'X1' }, overrideReason: 'please' });
ok(r.status === 403, 'technician without permission cannot override duplicate');
r = await owner('GET', '/api/admin/users');
const raviRow = r.data.users.find((u) => u.email === 'ravi@example.com');
r = await owner('POST', `/api/admin/users/${raviRow.id}`, { role: 'Viewer' });
r = await ravi('POST', `/api/rma/${raviTicket.id}/action`, { action: 'mark_sent' });
ok(r.status === 403, 'role change applies at once (now Viewer)');
r = await owner('POST', `/api/admin/users/${raviRow.id}`, { disabled: true });
r = await ravi('GET', '/api/dashboard');
ok(r.status === 401, 'disabled user signed out immediately');
r = await owner('POST', `/api/admin/users/${setupA ? (await owner('GET', '/api/auth/me')).data.user.id : ''}`, { role: 'Viewer' });
ok(r.status === 422, 'admin cannot demote self');
r = await owner('GET', '/api/admin/login-log');
ok(r.data.some((e) => e.event === 'login_failed') && r.data.some((e) => e.event === 'user_invited'), 'login log records events');

console.log('Console: setup and access');
const KEY = process.env.CONSOLE_SETUP_KEY || 'local-console-setup-key-123';
const opc = client('Edge on Windows PC');
let pageRes = await fetch(`${BASE}/console`);
ok(pageRes.status === 200 && (await pageRes.text()).includes('RMA Cloud Console'), 'console page served at /console');
pageRes = await fetch(`${BASE}/console/companies/x`);
ok(pageRes.status === 200 && (await pageRes.text()).includes('RMA Cloud Console'), 'console deep link served');
pageRes = await fetch(`${BASE}/rma`);
ok(!(await pageRes.text()).includes('RMA Cloud Console'), 'app pages are not the console');
r = await opc('GET', '/api/console/setup');
ok(r.data.needsSetup && r.data.keyConfigured, 'console needs setup; key configured');
r = await opc('POST', '/api/console/setup', { key: 'wrong', name: 'Op', email: 'op@provider.example', password: PW, confirm: PW });
ok(r.status === 422 && r.data.fields?.key, 'wrong setup key refused');
r = await opc('POST', '/api/console/setup', { key: KEY, name: 'Op One', email: 'op@provider.example', password: PW, confirm: PW });
ok(r.status === 200 && r.data.otpauth.includes('Console'), 'console setup → own authenticator entry');
const opSecret = r.data.secret;
r = await opc('POST', '/api/console/enroll', { setupToken: r.data.setupToken, code: await totp(opSecret) });
ok(r.status === 200 && r.data.recoveryCodes.length === 10, 'operator enrolled with 10 recovery codes');
r = await opc('GET', '/api/console/setup');
ok(!r.data.needsSetup, 'console setup closed after first operator');
r = await owner('GET', '/api/console/companies');
ok(r.status === 401, 'company login cannot open the console');
r = await opc('GET', '/api/bootstrap');
ok(r.status === 401, 'console login cannot open company data');
r = await opc('GET', '/api/console/companies');
ok(r.status === 200 && r.data.companies.some((c) => c.code === 'INF'), 'operator lists companies');

console.log('Second company: created from the console, with limits');
r = await opc('POST', '/api/console/companies', { company: { name: 'Sister Concern Pvt Ltd', code: 'inf', maxUsers: 2, maxConcurrent: 1 }, admin: { name: 'Priya', email: 'owner@example.com' } });
ok(r.status === 409 && r.data.fields?.code, 'duplicate login code refused');
r = await opc('POST', '/api/console/companies', { company: { name: 'Sister Concern Pvt Ltd', code: 'SCP', ticketPrefix: 'SCP', maxUsers: 2, maxConcurrent: 1,
  modules: ['batches'], contactEmail: 'accounts@scp.example', gstin: '07AAACX1234Q1Z5' }, admin: { name: 'Priya', email: 'owner@example.com' } });
ok(r.status === 200 && r.data.company.code === 'SCP' && r.data.link.includes('/invite#token='), 'console creates SCP with first Admin invite (same email allowed)');
const scpId = r.data.company.id;
const scpToken = decodeURIComponent(r.data.link.split('token=')[1]);
const priya = client('Safari on iPhone / iPad');
r = await priya('POST', '/api/auth/invite/accept', { token: scpToken, password: PW2, confirm: PW2 });
ok(r.status === 200 && r.data.otpauth.includes('SCP'), 'separate authenticator entry for SCP');
const scpSecret = r.data.secret;
ok(scpSecret !== ownerSecret, 'different 2FA secret from INF login');
r = await enroll(priya, r.data);
ok(r.status === 200 && r.data.user.company.code === 'SCP' && !r.data.user.isOwner && r.data.user.company.modules.join() === 'batches', 'SCP Admin signed in, modules = batches only');
r = await priya('GET', '/api/rma');
ok(r.data.rows.length === 0, 'SCP sees none of INF\'s RMAs');
r = await priya('POST', '/api/rma', { ticket: { ...base } });
ok(r.status === 200 && r.data.ticket.ticket_no.startsWith('SCP-RMA-'), 'SCP numbering + same serial allowed in other company');
r = await priya('GET', `/api/rma/${t1.id}`);
ok(r.status === 404 || (r.data?.ticket?.customer_company !== 'Acme Logistics' || r.data.ticket.ticket_no.startsWith('SCP')), 'INF ticket id not readable from SCP');
r = await priya('GET', '/api/carepack');
ok(r.status === 403 && r.data.code === 'module_off', 'care packs switched off for SCP');
r = await priya('GET', '/api/import/log');
ok(r.status === 403, 'import switched off for SCP');
r = await priya('GET', '/api/batches');
ok(r.status === 200, 'batches on for SCP');
r = await priya('GET', '/api/admin/users');
ok(r.data.users.length === 1 && r.data.users[0].email === 'owner@example.com', 'SCP user list only has SCP logins');
r = await opc('POST', `/api/console/companies/${scpId}/users`, { name: 'Ravi', email: 'ravi@scp.example', role: 'Technician' });
ok(r.status === 200 && r.data.link, 'console adds 2nd SCP user');
const scpRaviToken = decodeURIComponent(r.data.link.split('token=')[1]);
r = await opc('POST', `/api/console/companies/${scpId}/users`, { name: 'Third', email: 'third@scp.example', role: 'Viewer' });
ok(r.status === 409 && /at most 2/.test(r.data.error), 'max users (2) enforced');
const scpRavi = client('Chrome on Android');
r = await scpRavi('POST', '/api/auth/invite/accept', { token: scpRaviToken, password: PW2, confirm: PW2 });
const scpRaviSetup = r.data;
r = await scpRavi('POST', '/api/auth/enroll', { setupToken: scpRaviSetup.setupToken, code: await totp(scpRaviSetup.secret) });
ok(r.status === 409 && r.data.code === 'seats_full', 'signed-in-at-once limit (1) blocks 2nd person');
r = await opc('GET', `/api/console/companies/${scpId}`);
ok(r.data.company.online === 1 && r.data.sessions.length === 1, 'console sees 1 of 1 seats in use');
r = await priya('POST', '/api/auth/logout');
r = await enroll(scpRavi, scpRaviSetup);
ok(r.status === 200, 'seat free after logout → 2nd person signs in');
r = await login(priya, 'SCP', 'owner@example.com', PW2, scpSecret);
ok(r.status === 409 && r.data.code === 'seats_full', 'login refused while seat is taken');
r = await opc('POST', `/api/console/companies/${scpId}/signout-all`);
ok(r.status === 200 && r.data.ended === 1, 'console signs everyone out');
r = await scpRavi('GET', '/api/auth/me');
ok(r.status === 401, 'signed-out session ends');
const third = client('Firefox on Linux');
r = await login(third, 'SCP', 'owner@example.com', PW, ownerSecret);
ok(r.status === 401, 'INF password does not open SCP login');
r = await login(third, 'SCP', 'owner@example.com', PW2, scpSecret);
ok(r.status === 200 && r.data.user.company.code === 'SCP', 'SCP login with its own password + 2FA');
r = await owner('GET', '/api/auth/me');
ok(r.status === 200 && r.data.user.company.code === 'INF', 'INF session unaffected by SCP login');
const y = new Date(Date.now() - 86400000 + 19800000).toISOString().slice(0, 10);
r = await opc('POST', `/api/console/companies/${scpId}`, { name: 'Sister Concern Pvt Ltd', ticketPrefix: 'SCP', maxUsers: 2, maxConcurrent: 1, modules: ['batches'], validUntil: y });
ok(r.status === 200 && r.data.expired, 'console sets end date in the past');
r = await third('GET', '/api/auth/me');
ok(r.status === 401, 'expired company: session ended');
r = await third('POST', '/api/auth/login', { companyCode: 'SCP', email: 'owner@example.com', password: PW2 });
ok(r.status === 403 && /ended on/.test(r.data.error), 'expired company: login refused with clear message');
r = await opc('POST', `/api/console/companies/${scpId}`, { name: 'Sister Concern Pvt Ltd', ticketPrefix: 'SCP', maxUsers: 2, maxConcurrent: 1, modules: ['batches'], validUntil: null, active: false, suspendReason: 'Renewal pending.' });
r = await third('POST', '/api/auth/login', { companyCode: 'SCP', email: 'owner@example.com', password: PW2 });
ok(r.status === 403 && /suspended\. Renewal pending/.test(r.data.error), 'suspended company: login refused with reason');
r = await opc('POST', `/api/console/companies/${scpId}`, { name: 'Sister Concern Pvt Ltd', ticketPrefix: 'SCP', maxUsers: 2, maxConcurrent: 1, modules: ['batches'], active: true });
r = await login(third, 'SCP', 'owner@example.com', PW2, scpSecret);
ok(r.status === 200, 'reactivated company: login works');
r = await opc('GET', `/api/console/companies/${scpId}`);
ok(r.data.consoleLog.some((l) => l.action === 'company_suspended') && r.data.log.some((l) => l.event === 'login_refused'), 'console and login logs record it');
r = await opc('POST', '/api/console/operators', { name: 'Op Two', email: 'op2@provider.example' });
ok(r.status === 200 && r.data.link.includes('/console/invite#token='), 'operator invite link');
const op2 = client('Safari on Mac');
r = await op2('POST', '/api/console/invite/accept', { token: decodeURIComponent(r.data.link.split('token=')[1]), password: PW2, confirm: PW2 });
r = await op2('POST', '/api/console/enroll', { setupToken: r.data.setupToken, code: await totp(r.data.secret) });
ok(r.status === 200, 'second operator enrolled');
const op2Id = (await opc('GET', '/api/console/operators')).data.operators.find((o) => o.email === 'op2@provider.example').id;
r = await opc('POST', `/api/console/operators/${op2Id}`, { disabled: true });
r = await op2('GET', '/api/console/companies');
ok(r.status === 401, 'disabled operator signed out');
r = await opc('POST', '/api/console/logout');
r = await opc('POST', '/api/console/login', { email: 'op@provider.example', password: PW });
r = await opc('POST', '/api/console/login/verify', { loginToken: r.data.loginToken, code: await totp(opSecret) });
ok(r.status === 200 && r.data.op.email === 'op@provider.example', 'operator logs in with password + 2FA');

console.log('Recovery and reset');
r = await owner('POST', '/api/auth/logout');
const phone = client('Chrome on Android');
let a = await phone('POST', '/api/auth/login', { companyCode: 'INF', email: 'owner@example.com', password: PW });
r = await phone('POST', '/api/auth/login/verify', { loginToken: a.data.loginToken, recoveryCode: ownerRecovery[0] });
ok(r.status === 200 && r.data.user.recoveryLeft === 9, 'recovery code login, 9 left');
r = await phone('POST', '/api/auth/logout');
a = await phone('POST', '/api/auth/login', { companyCode: 'INF', email: 'owner@example.com', password: PW });
r = await phone('POST', '/api/auth/login/verify', { loginToken: a.data.loginToken, recoveryCode: ownerRecovery[0] });
ok(r.status === 401, 'used recovery code rejected');
r = await phone('POST', '/api/auth/forgot', { companyCode: 'INF', email: 'owner@example.com' });
ok(r.status === 200, 'forgot password answers ok');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
