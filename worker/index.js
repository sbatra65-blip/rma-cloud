// API router. Static PWA files are served by Cloudflare's asset handler; only /api/* reaches here.
import { Directory, ROLES } from './directory.js';
import { Company, splitEmails } from './company.js';
import { Checker, ValidationError, checkPassword } from './validate.js';
import { inviteEmail, inviteLink, oemEmailHtml, passwordChangedEmail, reminderEmail, resetEmail, sendMail } from './mail.js';
import { uuid } from './crypto.js';
import defaultTemplate from './default-template.xlsx';

export { Directory, Company };

const COOKIE = '__Host-rma_sid';
const MAX_PHOTO = 10 * 1024 * 1024;
const MAX_TEMPLATE = 5 * 1024 * 1024;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
};

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...extra },
  });
}
function err(status, message, more = {}) {
  return json({ error: message, ...more }, status);
}
function sessionCookie(token) {
  // No Max-Age: the cookie ends when the browser closes; the server also ends it after the idle limit.
  return `${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict`;
}
function clearCookie() {
  return `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
}
function readCookie(request) {
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=');
  }
  return null;
}
function clientInfo(request) {
  const ua = request.headers.get('User-Agent') || '';
  const device = /iPhone|iPad/.test(ua) ? 'iPhone / iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac'
    : /Windows/.test(ua) ? 'Windows PC' : /Linux/.test(ua) ? 'Linux' : 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox'
    : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const cf = request.cf || {};
  return {
    ua: `${browser} on ${device}`,
    ip: request.headers.get('CF-Connecting-IP') || 'local',
    place: [cf.city, cf.country].filter(Boolean).join(', '),
  };
}

async function checkNewPassword(password, email, field = 'password') {
  const problem = checkPassword(password, email);
  if (problem) throw new ValidationError({ [field]: problem });
  if (await isBreached(password)) throw new ValidationError({ [field]: 'This password appears in known data breaches. Choose a different one.' });
}

async function body(request, limit = 64 * 1024) {
  const text = await request.text();
  if (text.length > limit) throw new ValidationError({ _: 'Request is too large' });
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new ValidationError({ _: 'Request was not valid JSON' });
  }
}

// Password found in public breach lists? (k-anonymity: only 5 hash characters leave the server)
async function isBreached(password) {
  try {
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(password));
    const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    const res = await fetch(`https://api.pwnedpasswords.com/range/${hex.slice(0, 5)}`, { headers: { 'Add-Padding': 'true' } });
    if (!res.ok) return false;
    const suffix = hex.slice(5);
    return (await res.text()).split('\n').some((line) => line.startsWith(suffix) && Number(line.split(':')[1]) > 0);
  } catch {
    return false;
  }
}

// Check the real file type from its first bytes, not from the name.
function sniff(bytes) {
  const b = new Uint8Array(bytes.slice(0, 16));
  const ascii = (i, n) => String.fromCharCode(...b.slice(i, i + n));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && ascii(1, 3) === 'PNG') return 'image/png';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp';
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return 'application/zip';
  return null;
}

const dir = (env) => env.DIRECTORY.get(env.DIRECTORY.idFromName('directory'));
const company = (env, id) => env.COMPANY.get(env.COMPANY.idFromName(id));

function raise(r) {
  const { status, message, ...rest } = r.error;
  throw Object.assign(new Error(message), { status, more: rest });
}
async function dcall(env, method, args) {
  const r = await dir(env).call(method, args);
  if (r.error) raise(r);
  return r.data;
}
async function ccall(env, user, method, args) {
  const r = await company(env, user.companyId).call(method, user, args);
  if (r.error) raise(r);
  return r.data;
}

const companyCode = (v) => String(v || '').trim().toUpperCase();
const CODE_RE = /^[A-Z0-9]{2,12}$/;

async function emailInvite(env, url, actor, data, { reset = false, companyName } = {}) {
  const mail = inviteEmail({
    appName: env.APP_NAME || 'RMA Cloud', appUrl: url.origin, name: data.user.name, token: data.invite.token,
    days: data.invite.days, companies: [companyName || actor.companyName], invitedBy: actor.name, reset,
  });
  const sent = await sendMail(env, { to: data.user.email, ...mail });
  // The link is also shown to the Admin, so it can be shared another way if email is not set up.
  return { emailed: sent.ok, emailError: sent.ok ? null : sent.error, link: inviteLink(url.origin, data.invite.token), days: data.invite.days };
}

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '');
  const method = request.method;
  const client = clientInfo(request);
  const appName = env.APP_NAME || 'RMA Cloud';

  // Block cross-site writes: every non-GET must come from this site's own pages.
  if (method !== 'GET' && method !== 'HEAD') {
    const origin = request.headers.get('Origin');
    if (!origin || origin !== url.origin) return err(403, 'Request blocked: wrong origin.');
  }

  // ---------- First-run setup ----------
  if (path === '/api/setup' && method === 'GET') return json(await dcall(env, 'needsSetup', {}));
  if (path === '/api/setup' && method === 'POST') {
    if (!(await dcall(env, 'needsSetup', {})).needsSetup) return err(409, 'This app is already set up. Log in instead.');
    const b = await body(request);
    const v = new Checker(b).text('name', { required: true, max: 80, label: 'Your name' }).email('email', { required: true })
      .text('companyName', { required: true, max: 120, label: 'Company name' }).done();
    v.companyCode = companyCode(b.companyCode);
    v.ticketPrefix = companyCode(b.ticketPrefix);
    const errs = {};
    if (!CODE_RE.test(v.companyCode)) errs.companyCode = 'Company code: 2–12 letters or numbers, e.g. INF';
    if (!/^[A-Z0-9]{2,8}$/.test(v.ticketPrefix)) errs.ticketPrefix = 'Ticket prefix: 2–8 letters or numbers, e.g. INF';
    if (b.password !== b.confirm) errs.confirm = 'Passwords do not match';
    if (Object.keys(errs).length) throw new ValidationError(errs);
    await checkNewPassword(b.password, v.email);
    return json(await dcall(env, 'setupStart', { ...v, password: b.password, ip: client.ip, origin: url.origin }));
  }

  // ---------- Finish authenticator setup (first run, invite, or login reset) ----------
  if (path === '/api/auth/enroll' && method === 'POST') {
    const b = await body(request);
    if (!/^\d{6}$/.test(String(b.code || ''))) throw new ValidationError({ code: 'Enter the 6-digit code from your authenticator app' });
    const data = await dcall(env, 'enrollFinish', { setupToken: b.setupToken, code: String(b.code).trim(), client });
    return json({ recoveryCodes: data.recoveryCodes, user: data.user, idleMinutes: Number(env.IDLE_MINUTES || 5) },
      200, { 'Set-Cookie': sessionCookie(data.token) });
  }

  // ---------- Invites ----------
  if (path === '/api/auth/invite/check' && method === 'POST') {
    const b = await body(request);
    return json(await dcall(env, 'inviteCheck', { token: String(b.token || '') }));
  }
  if (path === '/api/auth/invite/accept' && method === 'POST') {
    const b = await body(request);
    const inv = await dcall(env, 'inviteCheck', { token: String(b.token || '') });
    if (b.password !== b.confirm) throw new ValidationError({ confirm: 'Passwords do not match' });
    await checkNewPassword(b.password, inv.email);
    return json(await dcall(env, 'inviteStart', { token: String(b.token), password: b.password, ip: client.ip }));
  }

  // ---------- Login ----------
  if (path === '/api/auth/login' && method === 'POST') {
    const b = await body(request);
    const v = new Checker(b).email('email', { required: true }).text('password', { required: true, max: 128, label: 'Password' }).done();
    const code = companyCode(b.companyCode);
    if (!code) throw new ValidationError({ companyCode: 'Enter your company code' });
    return json(await dcall(env, 'loginPassword', { companyCode: code, email: v.email, password: b.password, client }));
  }
  if (path === '/api/auth/login/verify' && method === 'POST') {
    const b = await body(request);
    const data = await dcall(env, 'loginVerify', {
      loginToken: b.loginToken, code: String(b.code || '').trim(), recoveryCode: b.recoveryCode,
      endOther: b.endOther === true, client, origin: url.origin,
    });
    return json({ user: data.user, endedOther: data.endedOther, idleMinutes: Number(env.IDLE_MINUTES || 5) },
      200, { 'Set-Cookie': sessionCookie(data.token) });
  }

  // ---------- Forgot / reset password ----------
  if (path === '/api/auth/forgot' && method === 'POST') {
    const b = await body(request);
    const v = new Checker(b).email('email', { required: true }).done();
    const r = await dcall(env, 'forgotStart', { companyCode: companyCode(b.companyCode), email: v.email, ip: client.ip });
    if (r) {
      const sent = await sendMail(env, { to: r.email, ...resetEmail({ appName, appUrl: url.origin, name: r.name, token: r.token, minutes: r.minutes }) });
      if (!sent.ok) console.error('reset email', sent.error);
      if (env.DEV_SHOW_RESET_LINK === '1' && url.hostname === 'localhost') return json({ ok: true, devToken: r.token });
    }
    return json({ ok: true });
  }
  if (path === '/api/auth/reset/check' && method === 'POST') {
    const b = await body(request);
    return json(await dcall(env, 'resetCheck', { token: String(b.token || '') }));
  }
  if (path === '/api/auth/reset' && method === 'POST') {
    const b = await body(request);
    await dcall(env, 'resetCheck', { token: String(b.token || '') });
    await checkNewPassword(b.password, null);
    if (b.password !== b.confirm) throw new ValidationError({ confirm: 'Passwords do not match' });
    if (!b.recoveryCode && !/^\d{6}$/.test(String(b.code || ''))) throw new ValidationError({ code: 'Enter the 6-digit code from your authenticator app' });
    const r = await dcall(env, 'resetFinish', { token: String(b.token), password: b.password, code: String(b.code || '').trim(), recoveryCode: b.recoveryCode, client });
    ctx.waitUntil(sendMail(env, { to: r.email, ...passwordChangedEmail({ appName, appUrl: url.origin, name: r.name, how: 'reset', client }) }));
    return json({ ok: true }, 200, { 'Set-Cookie': clearCookie() });
  }

  if (path === '/api/auth/logout' && method === 'POST') {
    await dcall(env, 'logout', { token: readCookie(request) });
    return json({ ok: true }, 200, { 'Set-Cookie': clearCookie() });
  }

  // ---------- Everything below needs a live session ----------
  const session = await dcall(env, 'touch', { token: readCookie(request) });
  if (!session) return err(401, 'Your session ended. Please log in again.', { code: 'session_ended' });
  const user = {
    userId: session.userId, sessionId: session.sessionId, email: session.email, name: session.name, role: session.role,
    isOwner: session.isOwner, dupOverride: session.dupOverride, companyId: session.companyId, companyName: session.companyName,
    companyCode: session.companyCode, ticketPrefix: session.ticketPrefix,
  };
  const withCookie = (headers = {}) => (session.newToken ? { ...headers, 'Set-Cookie': sessionCookie(session.newToken) } : headers);
  const respond = (data, status = 200) => json(data, status, withCookie());
  const raw = (data, headers) => new Response(data, { headers: withCookie({ ...SECURITY_HEADERS, ...headers }) });
  const isAdmin = user.role === 'Admin';

  if (path === '/api/auth/me' && method === 'GET') {
    return respond({ user: await dcall(env, 'publicUser', { userId: user.userId }), idleMinutes: Number(env.IDLE_MINUTES || 5) });
  }
  if (path === '/api/session/ping' && method === 'POST') return respond({ ok: true });

  if (path === '/api/auth/change-password' && method === 'POST') {
    const b = await body(request);
    const errs = {};
    if (!b.current) errs.current = 'Enter your current password';
    if (!/^\d{6}$/.test(String(b.code || ''))) errs.code = 'Enter the 6-digit code from your authenticator app';
    if (b.password !== b.confirm) errs.confirm = 'Passwords do not match';
    if (Object.keys(errs).length) throw new ValidationError(errs);
    await checkNewPassword(b.password, user.email);
    const r = await dcall(env, 'changePassword', {
      userId: user.userId, sessionId: user.sessionId, current: b.current, password: b.password, code: String(b.code).trim(), client,
    });
    ctx.waitUntil(sendMail(env, { to: r.email, ...passwordChangedEmail({ appName, appUrl: url.origin, name: r.name, how: 'change', client }) }));
    return respond({ ok: true });
  }
  if (path === '/api/auth/recovery-codes' && method === 'POST') {
    const b = await body(request);
    if (!/^\d{6}$/.test(String(b.code || ''))) throw new ValidationError({ code: 'Enter the 6-digit code from your authenticator app' });
    return respond(await dcall(env, 'newRecoveryCodes', { userId: user.userId, code: String(b.code).trim() }));
  }

  // ---------- RMA data ----------
  if (path === '/api/bootstrap' && method === 'GET') return respond(await ccall(env, user, 'bootstrap'));
  if (path === '/api/dashboard' && method === 'GET') return respond(await ccall(env, user, 'dashboard'));
  if (path === '/api/reminders' && method === 'GET') return respond(await ccall(env, user, 'reminders'));

  if (path === '/api/rma' && method === 'GET') return respond(await ccall(env, user, 'listTickets', Object.fromEntries(url.searchParams)));
  if (path === '/api/rma' && method === 'POST') {
    const b = await body(request);
    return respond(await ccall(env, user, 'createTicket', { ticket: b.ticket, overrideReason: b.overrideReason, addToCarePack: b.addToCarePack }));
  }
  if (path === '/api/rma/check-duplicates' && method === 'POST') {
    const b = await body(request);
    return respond(await ccall(env, user, 'checkDuplicates', b));
  }

  let m = path.match(/^\/api\/rma\/(\d{1,12})$/);
  if (m && method === 'GET') return respond(await ccall(env, user, 'getTicket', { id: m[1] }));
  if (m && method === 'POST') {
    const b = await body(request);
    return respond(await ccall(env, user, 'updateTicket', { id: m[1], ticket: b.ticket }));
  }
  if (m && method === 'DELETE') {
    const r = await ccall(env, user, 'deleteTicket', { id: m[1] });
    if (env.FILES) for (const pid of r.r2Photos) ctx.waitUntil(env.FILES.delete(`co/${user.companyId}/photo/${pid}`));
    return respond({ ok: true });
  }

  m = path.match(/^\/api\/rma\/(\d{1,12})\/action$/);
  if (m && method === 'POST') {
    const b = await body(request);
    return respond(await ccall(env, user, 'ticketAction', { id: m[1], action: String(b.action || ''), data: b.data || {} }));
  }
  m = path.match(/^\/api\/rma\/(\d{1,12})\/excel$/);
  if (m && method === 'POST') return respond(await ccall(env, user, 'markExcel', { id: m[1] }));
  m = path.match(/^\/api\/rma\/(\d{1,12})\/email$/);
  if (m && method === 'GET') return respond(await ccall(env, user, 'emailContext', { id: m[1] }));
  if (m && method === 'POST') {
    // The browser builds the filled-in OEM Excel (with photos) and sends it here to attach.
    if (user.role === 'Viewer') return respond({ error: 'Your role can only view records.' }, 403);
    const b = await body(request, 14 * 1024 * 1024);
    const ctxData = await ccall(env, user, 'emailContext', { id: m[1] });
    const v = new Checker(b).text('subject', { required: true, max: 300, label: 'Subject' }).text('body', { required: true, max: 10000, label: 'Message' }).done();
    const to = splitEmails(b.to || ctxData.to.join(','));
    const cc = splitEmails(b.cc ?? ctxData.cc.join(','));
    const bad = [...to, ...cc].find((e) => !/^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(e));
    if (!to.length) throw new ValidationError({ to: 'Enter at least one recipient' });
    if (bad) throw new ValidationError({ to: `Not a valid email: ${bad}` });
    if (to.length + cc.length > 10) throw new ValidationError({ to: 'At most 10 recipients' });
    if (typeof b.excelBase64 !== 'string' || b.excelBase64.length < 100) throw new ValidationError({ _: 'The OEM Excel file is missing. Generate it first.' });
    const sent = await sendMail(env, {
      to, cc, replyTo: ctxData.replyTo, subject: v.subject, text: v.body, html: oemEmailHtml(v.body),
      attachments: [{ filename: ctxData.fileName, content: b.excelBase64 }],
    });
    if (!sent.ok) return respond({ error: sent.error }, 502);
    await ccall(env, user, 'recordOemEmail', { id: m[1], to: [...to, ...cc] });
    return respond({ ok: true, to, cc });
  }

  m = path.match(/^\/api\/rma\/(\d{1,12})\/challan$/);
  if (m && method === 'POST') return respond(await ccall(env, user, 'createChallan', { id: m[1] }));

  // ---------- Care Pack ----------
  if (path.startsWith('/api/carepack')) {
    const q = Object.fromEntries(url.searchParams);
    if (path === '/api/carepack' && method === 'GET') return respond(await ccall(env, user, 'cpList', q));
    if (path === '/api/carepack/registry' && method === 'GET') return respond(await ccall(env, user, 'cpRegistry', q));
    if (path === '/api/carepack/serial' && method === 'GET') return respond(await ccall(env, user, 'cpFindSerial', { sn: q.sn, loose: q.loose !== '0' }));
    if (path === '/api/carepack/customers' && method === 'GET') return respond(await ccall(env, user, 'cpCustomers', q));
    if (path === '/api/carepack/serials' && method === 'GET') return respond(await ccall(env, user, 'cpSerials', q));
    if (path === '/api/carepack/pending' && method === 'GET') return respond(await ccall(env, user, 'cpPending'));
    if (path === '/api/carepack/overrides' && method === 'GET') return respond(await ccall(env, user, 'cpOverrideLog'));
    if (path === '/api/carepack/register' && method === 'POST') return respond(await ccall(env, user, 'cpRegister', await body(request, 1024 * 1024)));
    if (path === '/api/carepack/zoho-preview' && method === 'POST') return respond(await ccall(env, user, 'cpZohoPreview', await body(request)));
    if (path === '/api/carepack/zoho-pos' && method === 'GET') return respond(await ccall(env, user, 'cpZohoPos', q));
    if (path === '/api/carepack/po-preview' && method === 'POST') return respond(await ccall(env, user, 'cpPoPreview', await body(request, 1024 * 1024)));
    if (path === '/api/carepack/po-confirm' && method === 'POST') return respond(await ccall(env, user, 'cpPoConfirm', await body(request, 1024 * 1024)));
    if (path === '/api/carepack/delete' && method === 'POST') return respond(await ccall(env, user, 'cpDelete', await body(request)));
    if (path === '/api/carepack/draft') {
      if (method === 'GET') return respond({ draft: await ccall(env, user, 'cpDraftGet') });
      if (method === 'POST') return respond(await ccall(env, user, 'cpDraftSave', { data: (await body(request, 512 * 1024)).data }));
      if (method === 'DELETE') return respond(await ccall(env, user, 'cpDraftClear'));
    }
    m = path.match(/^\/api\/carepack\/(\d{1,12})$/);
    if (m && method === 'GET') return respond(await ccall(env, user, 'cpGet', { id: m[1] }));
    m = path.match(/^\/api\/carepack\/(\d{1,12})\/po-candidates$/);
    if (m && method === 'GET') return respond(await ccall(env, user, 'cpPoCandidates', { id: m[1] }));
    m = path.match(/^\/api\/carepack\/(\d{1,12})\/(header|product|override|serials|oem|paid|remove)$/);
    if (m && method === 'POST') {
      const fn = { header: 'cpUpdateHeader', product: 'cpUpdateProduct', override: 'cpOverride', serials: 'cpReplaceSerials', oem: 'cpOemDetails', paid: 'cpSetPaid', remove: 'cpRemoveDoc' }[m[2]];
      return respond(await ccall(env, user, fn, { ...(await body(request, 256 * 1024)), id: m[1] }));
    }
    m = path.match(/^\/api\/carepack\/(\d{1,12})\/pdf$/);
    if (m && method === 'GET') {
      const r = await ccall(env, user, 'cpGetPdf', { id: m[1] });
      return raw(r.bytes, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${r.name.replace(/"/g, '')}"`,
        'Content-Security-Policy': "default-src 'none'; object-src 'self'; frame-ancestors 'self'" });
    }
    if (m && method === 'POST') {
      const bytes = await request.arrayBuffer();
      if (bytes.byteLength > 15 * 1024 * 1024) throw new ValidationError({ file: 'PDF is larger than 15 MB' });
      if (String.fromCharCode(...new Uint8Array(bytes.slice(0, 5))) !== '%PDF-') throw new ValidationError({ file: 'Only PDF files are accepted for OEM invoices.' });
      const name = decodeURIComponent(request.headers.get('X-File-Name') || 'oem-invoice.pdf').replace(/[^\w .()-]/g, '_').slice(0, 120);
      return respond(await ccall(env, user, 'cpPutPdf', { id: m[1], name, bytes }));
    }
    return err(404, 'Not found');
  }

  // Photos
  m = path.match(/^\/api\/rma\/(\d{1,12})\/photos$/);
  if (m && method === 'POST') {
    const len = Number(request.headers.get('Content-Length') || 0);
    if (len > MAX_PHOTO) throw new ValidationError({ file: 'Photo is larger than 10 MB' });
    const bytes = await request.arrayBuffer();
    if (!bytes.byteLength) throw new ValidationError({ file: 'Photo is empty' });
    if (bytes.byteLength > MAX_PHOTO) throw new ValidationError({ file: 'Photo is larger than 10 MB' });
    const mime = sniff(bytes);
    if (!mime || !mime.startsWith('image/')) throw new ValidationError({ file: 'Only JPG, PNG or WEBP photos can be uploaded' });
    const direction = request.headers.get('X-Direction') === 'OUTBOUND' ? 'OUTBOUND' : 'INBOUND';
    const name = decodeURIComponent(request.headers.get('X-File-Name') || 'photo').replace(/[^\w .()-]/g, '_').slice(0, 120);
    const args = { ticketId: m[1], direction, name, mime, bytes };
    if (env.FILES) {
      const id = uuid();
      const key = `co/${user.companyId}/photo/${id}`;
      await env.FILES.put(key, bytes, { httpMetadata: { contentType: mime } });
      try {
        return respond(await ccall(env, user, 'putPhoto', { ...args, bytes: bytes.byteLength, r2Id: id }));
      } catch (e) {
        await env.FILES.delete(key);
        throw e;
      }
    }
    return respond(await ccall(env, user, 'putPhoto', args));
  }
  m = path.match(/^\/api\/photos\/([0-9a-f-]{36})$/);
  if (m && method === 'GET') {
    const r = await ccall(env, user, 'getPhoto', { id: m[1] });
    let data = r.bytes;
    if (r.meta.store === 'r2') {
      if (!env.FILES) return err(500, 'Photo storage is not connected');
      const obj = await env.FILES.get(`co/${user.companyId}/photo/${r.meta.id}`);
      if (!obj) return err(404, 'Photo not found');
      data = obj.body;
    }
    return raw(data, {
      'Content-Type': r.meta.mime,
      'Content-Disposition': `inline; filename="${r.meta.name.replace(/"/g, '')}"`,
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'; sandbox",
      'Cache-Control': 'private, max-age=3600',
    });
  }
  if (m && method === 'DELETE') {
    const r = await ccall(env, user, 'deletePhoto', { id: m[1] });
    if (r.store === 'r2' && env.FILES) ctx.waitUntil(env.FILES.delete(`co/${user.companyId}/photo/${m[1]}`));
    return respond({ ok: true });
  }

  // OEM Excel template: company's own upload, else the built-in TSC form.
  if (path === '/api/template' && method === 'GET') {
    const t = await ccall(env, user, 'getTemplate');
    return raw(t ? t.bytes : defaultTemplate, {
      'Content-Type': XLSX_MIME,
      'Content-Disposition': `attachment; filename="${(t?.name || 'RMA_EXCEL_TEMPLATE.xlsx').replace(/"/g, '')}"`,
    });
  }
  if (path === '/api/template' && method === 'POST') {
    if (!isAdmin) return respond({ error: 'Only an Admin can do this.' }, 403);
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > MAX_TEMPLATE) throw new ValidationError({ template: 'Template is larger than 5 MB' });
    if (sniff(bytes) !== 'application/zip') throw new ValidationError({ template: 'Upload an .xlsx file' });
    const name = decodeURIComponent(request.headers.get('X-File-Name') || 'template.xlsx').replace(/[^\w .()-]/g, '_').slice(0, 120);
    return respond(await ccall(env, user, 'putTemplate', { name, bytes }));
  }
  if (path === '/api/template' && method === 'DELETE') return respond(await ccall(env, user, 'deleteTemplate'));

  // Batches
  if (path === '/api/batches' && method === 'GET') return respond({ batches: await ccall(env, user, 'listBatches'), candidates: await ccall(env, user, 'batchCandidates') });
  if (path === '/api/batches' && method === 'POST') return respond(await ccall(env, user, 'createBatch', await body(request)));
  m = path.match(/^\/api\/batches\/(BATCH-[0-9]{6}(?:-[0-9]{1,3})?)$/);
  if (m && method === 'GET') return respond(await ccall(env, user, 'getBatch', { code: m[1] }));

  // Import
  if (path === '/api/import/rma' && method === 'POST') return respond(await ccall(env, user, 'importTickets', await body(request, 4 * 1024 * 1024)));
  if (path === '/api/import/log' && method === 'GET') return respond(await ccall(env, user, 'importLog'));
  if (path === '/api/import/customers' && method === 'POST') return respond(await ccall(env, user, 'importCustomers', await body(request, 4 * 1024 * 1024)));

  // Masters
  m = path.match(/^\/api\/masters\/(oems|products|models|customers|cp_types)$/);
  if (m && method === 'POST') return respond(await ccall(env, user, 'saveMaster', { kind: m[1], record: await body(request) }));
  m = path.match(/^\/api\/masters\/(oems|products|models|customers|cp_types)\/(\d{1,12})$/);
  if (m && method === 'DELETE') return respond(await ccall(env, user, 'deleteMaster', { kind: m[1], id: m[2] }));

  // Settings
  if (path === '/api/settings' && method === 'GET') return respond(await ccall(env, user, 'getSettings'));
  if (path === '/api/settings' && method === 'POST') {
    const b = await body(request);
    const out = await ccall(env, user, 'saveSettings', b);
    if (b.companyName !== undefined || b.ticketPrefix !== undefined) {
      const v = new Checker(b).text('companyName', { required: true, max: 120, label: 'Company name' }).done();
      const prefix = companyCode(b.ticketPrefix);
      if (!/^[A-Z0-9]{2,8}$/.test(prefix)) throw new ValidationError({ ticketPrefix: 'Ticket prefix: 2–8 letters or numbers' });
      await dcall(env, 'updateCompany', { actor: user, name: v.companyName, ticketPrefix: prefix });
    }
    return respond(out);
  }

  if (path === '/api/settings/carepack' && method === 'POST') return respond(await ccall(env, user, 'cpSaveSettings', await body(request)));
  if (path === '/api/settings/zoho' && method === 'POST') return respond(await ccall(env, user, 'zohoSaveConfig', await body(request)));
  if (path === '/api/settings/zoho' && method === 'DELETE') return respond(await ccall(env, user, 'zohoDisconnect'));
  if (path === '/api/settings/zoho/connect' && method === 'POST') return respond(await ccall(env, user, 'zohoConnect', await body(request)));
  if (path === '/api/settings/zoho/test' && method === 'POST') return respond(await ccall(env, user, 'zohoTest'));

  // Reminder email now (to me), for checking email works
  if (path === '/api/reminders/test' && method === 'POST') {
    const d = await ccall(env, { ...user, role: 'System' }, 'reminderDigest');
    const all = [...d.items, ...cpItems(d.carePack)];
    const mail = all.length
      ? reminderEmail({ appName, appUrl: url.origin, companyName: user.companyName, items: all, recipientName: user.name })
      : { subject: `${appName} test email`, html: `<p>Hello ${user.name}, emails from ${appName} are working. No RMAs need attention right now.</p>`, text: 'Emails are working.' };
    const sent = await sendMail(env, { to: user.email, ...mail });
    if (!sent.ok) return respond({ ok: false, error: sent.error }, 502);
    return respond({ ok: true, to: user.email, items: all.length });
  }

  // ---------- Admin: users, sessions, logs (own company only) ----------
  if (path === '/api/admin/users' && method === 'GET') return respond({ users: await dcall(env, 'listUsers', { actor: user }), roles: ROLES });
  if (path === '/api/admin/users' && method === 'POST') {
    const b = await body(request);
    const v = new Checker(b).text('name', { required: true, max: 80, label: 'Name' }).email('email', { required: true })
      .oneOf('role', ROLES, { required: true, label: 'Role' }).bool('dupOverride').done();
    const data = await dcall(env, 'inviteUser', { actor: user, name: v.name, email: v.email, role: v.role, dupOverride: !!v.dupOverride });
    return respond({ user: data.user, ...(await emailInvite(env, url, user, data)) });
  }
  m = path.match(/^\/api\/admin\/users\/([0-9a-f-]{36})$/);
  if (m && method === 'POST') {
    const b = await body(request);
    const args = { actor: user, userId: m[1] };
    if (b.role !== undefined) args.role = String(b.role);
    if (b.dupOverride !== undefined) args.dupOverride = b.dupOverride === true;
    if (b.disabled !== undefined) args.disabled = b.disabled === true;
    if (b.name !== undefined) args.name = new Checker(b).text('name', { required: true, max: 80, label: 'Name' }).done().name;
    return respond(await dcall(env, 'updateUser', args));
  }
  if (m && method === 'DELETE') return respond(await dcall(env, 'removeUser', { actor: user, userId: m[1] }));
  m = path.match(/^\/api\/admin\/users\/([0-9a-f-]{36})\/(resend-invite|reset-login)$/);
  if (m && method === 'POST') {
    const reset = m[2] === 'reset-login';
    const data = await dcall(env, reset ? 'resetSignIn' : 'resendInvite', { actor: user, userId: m[1] });
    return respond({ user: data.user, ...(await emailInvite(env, url, user, data, { reset })) });
  }
  if (path === '/api/admin/sessions' && method === 'GET') return respond(await dcall(env, 'listSessions', { actor: user }));
  m = path.match(/^\/api\/admin\/sessions\/([0-9a-f-]{36})$/);
  if (m && method === 'DELETE') return respond(await dcall(env, 'endSession', { actor: user, id: m[1] }));
  if (path === '/api/admin/login-log' && method === 'GET') return respond(await dcall(env, 'authLog', { actor: user }));
  if (path === '/api/admin/audit' && method === 'GET') return respond(await ccall(env, user, 'auditLog', {}));

  // ---------- Owner: companies ----------
  if (path === '/api/owner/companies' && method === 'GET') return respond(await dcall(env, 'listCompanies', { actor: user }));
  if (path === '/api/owner/companies' && method === 'POST') {
    const b = await body(request);
    const v = new Checker(b).text('name', { required: true, max: 120, label: 'Company name' })
      .text('adminName', { required: true, max: 80, label: 'Admin name' }).email('adminEmail', { required: true, label: 'Admin email' }).done();
    const code = companyCode(b.code);
    const prefix = companyCode(b.ticketPrefix) || code;
    const errs = {};
    if (!CODE_RE.test(code)) errs.code = 'Company code: 2–12 letters or numbers';
    if (!/^[A-Z0-9]{2,8}$/.test(prefix)) errs.ticketPrefix = 'Ticket prefix: 2–8 letters or numbers';
    if (Object.keys(errs).length) throw new ValidationError(errs);
    const data = await dcall(env, 'createCompany', { actor: user, name: v.name, code, ticketPrefix: prefix, adminName: v.adminName, adminEmail: v.adminEmail });
    return respond({ company: data.company, user: data.user, ...(await emailInvite(env, url, user, data, { companyName: v.name })) });
  }
  m = path.match(/^\/api\/owner\/companies\/([0-9a-f-]{36})$/);
  if (m && method === 'POST') {
    const b = await body(request);
    return respond(await dcall(env, 'setCompanyActive', { actor: user, companyId: m[1], active: b.active === true }));
  }

  return err(404, 'Not found');
}

const cpItems = (list = []) => list.map((i) => ({ ...i, ticket_no: i.invoice, serial: '', part: i.detail, href: `/care-packs/${i.id}`, age: null }));

// Daily job: one digest per company to its Admins and Managers (plus any extra addresses set).
async function runReminders(env, appUrl) {
  const appName = env.APP_NAME || 'RMA Cloud';
  const companies = await dcall(env, 'reminderRecipients', {});
  const report = [];
  for (const c of companies) {
    const sys = { userId: null, name: 'System', role: 'System', companyId: c.companyId, companyName: c.name, ticketPrefix: c.ticketPrefix };
    const d = await ccall(env, sys, 'reminderDigest');
    const items = [...d.items, ...cpItems(d.carePack)];
    if (!d.enabled || !items.length) continue;
    const people = [...c.people, ...d.extraTo.map((email) => ({ email, name: '' }))];
    const seen = new Set();
    const sentTo = [];
    for (const p of people) {
      if (seen.has(p.email)) continue;
      seen.add(p.email);
      const r = await sendMail(env, { to: p.email, ...reminderEmail({ appName, appUrl, companyName: c.name, items, recipientName: p.name }) });
      sentTo.push({ to: p.email, ok: r.ok, error: r.error });
    }
    report.push({ company: c.code, items: items.length, sentTo });
  }
  console.log('reminders', JSON.stringify(report));
  return report;
}

export default {
  async fetch(request, env, ctx) {
    try {
      if (!env.ENC_KEY) return err(500, 'Server is not configured yet: the ENC_KEY secret is missing.');
      return await handle(request, env, ctx);
    } catch (e) {
      if (e instanceof ValidationError) return err(422, e.message, { fields: e.fields });
      if (e.status && e.more?.field) {
        const { field, ...rest } = e.more;
        return err(e.status, e.message, { ...rest, fields: { [field]: e.message } });
      }
      if (e.status) return err(e.status, e.message, e.more || {});
      console.error(e);
      return err(500, 'Something went wrong on the server. Please try again.');
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const appUrl = env.APP_URL || (await dcall(env, 'appUrl', {})) || 'https://rma-cloud.workers.dev';
      await runReminders(env, appUrl);
    })());
  },
};

