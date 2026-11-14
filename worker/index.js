// API router. Static PWA files are served by Cloudflare's asset handler; only /api/* reaches here.
import { Directory, ROLES, MODULES } from './directory.js';
import { Company, splitEmails } from './company.js';
import { Checker, ValidationError, checkPassword } from './validate.js';
import { companyFromToken } from './track.js';
import { BACKUP_KEEP, backupCounts, base64, buildDataZip } from './backup.js';
import { GST_PCT, PERIODS, PLANS, checkPaymentSignature, checkWebhookSignature, createOrder, onlineReady, quote } from './billing.js';
import { backupEmail, paymentAlertEmail, paymentReceiptEmail, accessEmail, consoleInviteEmail, inviteEmail, inviteLink, oemEmailHtml, passwordChangedEmail, customerStatusEmail, providerDigestEmail, reminderEmail, resetEmail, sendMail, signupAlertEmail, signupEmail } from './mail.js';
import { timingSafeEqual, uuid } from './crypto.js';
import defaultTemplate from './default-template.xlsx';

export { Directory, Company };

const COOKIE = '__Host-rma_sid';
const CCOOKIE = '__Host-rma_csid'; // console: a different cookie, so the two logins never mix
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
function sessionCookie(token, name = COOKIE) {
  // No Max-Age: the cookie ends when the browser closes; the server also ends it after the idle limit.
  return `${name}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict`;
}
function clearCookie(name = COOKIE) {
  return `${name}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
}
function readCookie(request, name = COOKIE) {
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
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
  if (ascii(0, 5) === '%PDF-') return 'application/pdf';
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
    appName: env.APP_NAME || 'TrackMyRMA', appUrl: url.origin, name: data.user.name, token: data.invite.token,
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
  const appName = env.APP_NAME || 'TrackMyRMA';

  // Migration tool (old Windows RMA System → cloud): Bearer key, no cookie, so no cross-site risk.
  if (path.startsWith('/api/migrate/')) {
    if (env.CONSOLE_HOST && url.hostname === env.CONSOLE_HOST) return err(404, 'Not found');
    return handleMigrate(request, env, url, path, method);
  }

  // Razorpay webhook (server to server, signed): confirms payments even if the browser closed early.
  if (path === '/api/billing/webhook' && method === 'POST') {
    const text = await request.text();
    if (!(await checkWebhookSignature(env, text, request.headers.get('X-Razorpay-Signature')))) return err(400, 'Bad signature');
    let ev = {};
    try { ev = JSON.parse(text); } catch { return err(400, 'Bad JSON'); }
    const pay = ev?.payload?.payment?.entity;
    const orderId = ev?.payload?.order?.entity?.id || pay?.order_id;
    if (['order.paid', 'payment.captured'].includes(ev.event) && orderId && pay?.id) {
      try {
        const r = await dcall(env, 'billingApply', { orderId, paymentId: pay.id, via: 'webhook', plans: PLANS });
        if (!r.already) ctx.waitUntil(paymentEmails(env, await appOrigin(env, url), r));
      } catch (e) { if (e.status !== 404) throw e; }
    }
    return json({ ok: true });
  }

  // Block cross-site writes: every non-GET must come from this site's own pages.
  if (method !== 'GET' && method !== 'HEAD') {
    const origin = request.headers.get('Origin');
    if (!origin || origin !== url.origin) return err(403, 'Request blocked: wrong origin.');
  }

  // ---------- Console (service provider) ----------
  const onConsoleHost = !!env.CONSOLE_HOST && url.hostname === env.CONSOLE_HOST;
  if (path.startsWith('/api/console')) {
    if (env.CONSOLE_HOST && !onConsoleHost) return err(404, 'Not found');
    return handleConsole(request, env, ctx, url, path, method, client);
  }
  if (onConsoleHost) return err(404, 'Not found');

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
    return json({ recoveryCodes: data.recoveryCodes, user: data.user, idleMinutes: data.user.idleMinutes },
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
    return json({ user: data.user, endedOther: data.endedOther, idleMinutes: data.user.idleMinutes },
      200, { 'Set-Cookie': sessionCookie(data.token) });
  }

  // ---------- Customer status page (public, no login) ----------
  const tm = path.match(/^\/api\/track\/([A-Za-z0-9_-]{37,38})(\/logo)?$/);
  if (tm && method === 'GET') {
    await dcall(env, 'trackLimit', { ip: client.ip, max: 240 });
    const companyId = companyFromToken(tm[1]);
    const co = companyId && (await dcall(env, 'companyPublic', { id: companyId }));
    if (!co) return err(404, 'This status link is not valid.');
    if (tm[2]) {
      const l = (await company(env, co.id).publicCall('getLogo', {})).data;
      if (!l) return err(404, 'No logo');
      return new Response(l.bytes, { headers: { ...SECURITY_HEADERS, 'Content-Type': l.mime, 'Cache-Control': 'public, max-age=3600' } });
    }
    const r = await company(env, co.id).publicCall('trackView', { token: tm[1], companyName: co.name });
    if (r.error || !r.data) return err(404, 'This status link is not valid.');
    return json(r.data, 200, { 'Cache-Control': 'no-store' });
  }
  if (path.startsWith('/api/track/') && method === 'GET') return err(404, 'This status link is not valid.');
  if (path === '/api/track/lookup' && method === 'POST') {
    const b = await body(request);
    const no = String(b.rma || '').trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9/_-]{3,40}$/.test(no)) throw new ValidationError({ rma: 'Enter the RMA number as shown on your receipt, e.g. ABC-RMA-202611-0001' });
    await dcall(env, 'trackLimit', { ip: client.ip, max: 10 });
    const prefix = no.split('-')[0];
    for (const co of await dcall(env, 'companiesByPrefix', { prefix })) {
      const d = (await company(env, co.id).publicCall('trackLookup', { rmaNumber: no, companyId: co.id, companyName: co.name })).data;
      if (!d) continue;
      if (d.to) {
        const app = await appOrigin(env, url);
        ctx.waitUntil(sendMail(env, { to: d.to, ...customerStatusEmail({ appUrl: app, centre: d.centre, view: d.view, token: d.token, contact: d.contact, kind: 'link' }) }));
      }
      break;
    }
    // Same answer whether or not the RMA exists, so the form can't be used to find RMA numbers or emails.
    return json({ ok: true, message: 'If this RMA number is right and has an email address on file, we have emailed the status link to it. It can take a few minutes; check spam too.' });
  }

  // ---------- Self sign-up: new company on the free trial ----------
  if (path === '/api/signup' && method === 'POST') {
    if (env.SIGNUP_OFF === '1') return err(403, 'New sign-ups are paused. Contact us to start a trial.');
    if (env.CONSOLE_HOST && url.hostname === env.CONSOLE_HOST) return err(404, 'Not found');
    const b = await body(request);
    if (b.website) return json({ ok: true, emailed: true, company: { code: '', name: '' } }); // bots fill the hidden field
    const v = new Checker(b).text('companyName', { required: true, max: 120, label: 'Company name' }).text('name', { required: true, max: 80, label: 'Your name' })
      .email('email', { required: true, label: 'Work email' }).phone('phone', { label: 'Phone' }).done();
    const code = companyCode(b.code);
    if (code && !CODE_RE.test(code)) throw new ValidationError({ code: 'Use 2–12 letters or numbers, e.g. ACME' });
    const r = await dcall(env, 'signup', { data: { name: v.companyName, code, phone: v.phone }, admin: { name: v.name, email: v.email }, ip: client.ip });
    const app = await appOrigin(env, url);
    const sent = await sendMail(env, { to: v.email, ...signupEmail({ appName, appUrl: app, name: v.name, token: r.invite.token, days: r.invite.days, company: r.company }) });
    if (!sent.ok) console.error('signup email', sent.error);
    await dcall(env, 'mailResult', { companyId: r.company.id, userId: r.user.id, email: v.email, kind: 'signup', ok: sent.ok, error: sent.error }).catch(() => {});
    ctx.waitUntil((async () => {
      for (const o of await dcall(env, 'operatorEmails', {})) {
        await sendMail(env, { to: o.email, ...signupAlertEmail({ appName, consoleUrl: consoleUrlOf(env, app), company: r.company, name: v.name, email: v.email, phone: v.phone }) });
      }
    })().catch((e) => console.error('signup alert', e)));
    const out = { ok: true, emailed: sent.ok, company: { code: r.company.code, name: r.company.name } };
    if (env.DEV_SHOW_RESET_LINK === '1' && url.hostname === 'localhost') out.devLink = `/invite#token=${encodeURIComponent(r.invite.token)}`;
    return json(out);
  }

  // ---------- Forgot / reset password ----------
  if (path === '/api/auth/forgot' && method === 'POST') {
    const b = await body(request);
    const v = new Checker(b).email('email', { required: true }).done();
    const r = await dcall(env, 'forgotStart', { companyCode: companyCode(b.companyCode), email: v.email, ip: client.ip });
    if (r) {
      const sent = await sendMail(env, { to: r.email, ...resetEmail({ appName, appUrl: url.origin, name: r.name, token: r.token, minutes: r.minutes }) });
      if (!sent.ok) console.error('reset email', sent.error);
      await dcall(env, 'mailResult', { companyId: r.companyId, userId: r.userId, email: r.email, kind: 'reset', ok: sent.ok, error: sent.error }).catch(() => {});
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
    companyCode: session.companyCode, ticketPrefix: session.ticketPrefix, modules: session.modules,
    plan: session.plan, access: session.access, trialStarted: session.trialStarted,
  };
  // Parts of the app the service provider has switched off for this company.
  const needs = moduleFor(path);
  if (needs && !session.modules.includes(needs)) {
    return json({ error: `${MODULE_LABEL[needs]} is not enabled for ${session.companyName}. Ask your service provider.`, code: 'module_off' }, 403,
      session.newToken ? { 'Set-Cookie': sessionCookie(session.newToken) } : {});
  }
  const withCookie = (headers = {}) => (session.newToken ? { ...headers, 'Set-Cookie': sessionCookie(session.newToken) } : headers);
  const respond = (data, status = 200) => json(data, status, withCookie());
  const raw = (data, headers) => new Response(data, { headers: withCookie({ ...SECURITY_HEADERS, ...headers }) });
  const isAdmin = user.role === 'Admin';

  // Access date passed: up to 7 days of read-only use (view, export, print). Logging out and own-login changes still work.
  const READ_ONLY_OK = ['/api/auth/logout', '/api/auth/change-password', '/api/auth/recovery-codes', '/api/session/ping', '/api/backup/email', '/api/billing/order', '/api/billing/verify', '/api/billing/failed'];
  if (user.access === 'readonly' && !['GET', 'HEAD'].includes(method) && !READ_ONLY_OK.includes(path)) {
    return json({ error: user.plan === 'trial'
      ? 'Your free trial has ended, so the app is read-only for now. You can still view, print and export. Buy a plan to keep working.'
      : 'Access has ended, so the app is read-only for now. You can still view, print and export. Renew to keep working.', code: 'read_only' }, 403, withCookie());
  }

  if (path === '/api/auth/me' && method === 'GET') {
    return respond({ user: await dcall(env, 'publicUser', { userId: user.userId }), idleMinutes: session.idleMinutes });
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
  if (path === '/api/dashboard' && method === 'GET') return respond(await ccall(env, user, 'dashboard', { show: url.searchParams.get('show') || '' }));
  { const rp = path.match(/^\/api\/rma\/(\d+)\/received-part$/);
    if (rp && method === 'POST') return respond(await ccall(env, user, 'setReceivedPart', { ...(await body(request)), id: rp[1] })); }
  if (path === '/api/rma/bulk-close' && method === 'POST') {
    const r = await ccall(env, user, 'bulkClose', await body(request));
    ctx.waitUntil(flushCustomerNotices(env, user, url));
    return respond(r);
  }
  if (path === '/api/reminders' && method === 'GET') return respond(await ccall(env, user, 'reminders'));

  if (path === '/api/rma' && method === 'GET') return respond(await ccall(env, user, 'listTickets', Object.fromEntries(url.searchParams)));
  if (path === '/api/rma' && method === 'POST') {
    const b = await body(request);
    const r = await ccall(env, user, 'createTicket', { ticket: b.ticket, overrideReason: b.overrideReason, addToCarePack: b.addToCarePack, headReason: b.headReason, partSnNote: b.partSnNote });
    ctx.waitUntil(flushCustomerNotices(env, user, url));
    return respond(r);
  }
  if (path === '/api/devices' && method === 'GET') return respond(await ccall(env, user, 'searchDevices', { q: url.searchParams.get('q') }));
  if (path === '/api/devices/history' && method === 'GET') return respond(await ccall(env, user, 'deviceHistory', { sn: url.searchParams.get('sn') }));
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
    const r = await ccall(env, user, 'ticketAction', { id: m[1], action: String(b.action || ''), data: b.data || {} });
    ctx.waitUntil(flushCustomerNotices(env, user, url));
    return respond(r);
  }

  // ---------- Plan & billing (Admin): pay online ----------
  if (path.startsWith('/api/billing/') || path === '/api/billing') {
    if (!isAdmin) return err(403, 'Only an Admin can buy or renew the plan.');
    if (path === '/api/billing' && method === 'GET') {
      const info = await dcall(env, 'billingInfo', { companyId: user.companyId });
      const options = PLANS.flatMap((p) => Object.keys(PERIODS).map((per) => quote(p.id, per, info.credit)));
      return respond({ ...info, online: onlineReady(env), plans: PLANS, periods: PERIODS, gstPct: GST_PCT, options });
    }
    if (path === '/api/billing/order' && method === 'POST') {
      if (!onlineReady(env)) return err(503, 'Online payment is not set up yet. Use the bank / UPI details instead.');
      const b = await body(request);
      const info = await dcall(env, 'billingInfo', { companyId: user.companyId });
      const q = quote(String(b.plan || ''), String(b.period || ''), info.credit);
      if (!q) throw new ValidationError({ plan: 'Choose a plan and period' });
      const order = await createOrder(env, { amountPaise: q.total * 100, receipt: `${user.companyCode}-${Date.now().toString(36)}`.slice(0, 40),
        notes: { company: user.companyCode, plan: q.plan, period: q.period } });
      await dcall(env, 'billingCreate', { companyId: user.companyId, email: user.email, q, orderId: order.id });
      return respond({ keyId: env.RAZORPAY_KEY_ID, orderId: order.id, amount: order.amount, currency: order.currency, quote: q,
        name: env.APP_NAME || 'TrackMyRMA', description: `${q.planName} plan · ${q.periodLabel} · ${user.companyName}`, prefill: { name: user.name, email: user.email } });
    }
    if (path === '/api/billing/verify' && method === 'POST') {
      const b = await body(request);
      const orderId = String(b.razorpay_order_id || '');
      const paymentId = String(b.razorpay_payment_id || '');
      if (!(await checkPaymentSignature(env, { orderId, paymentId, signature: b.razorpay_signature }))) return err(400, 'We could not confirm this payment. If money was taken, it will be confirmed automatically within a few minutes; otherwise contact us.');
      const r = await dcall(env, 'billingApply', { orderId, paymentId, via: 'checkout', plans: PLANS });
      if (r.company.id !== user.companyId) return err(403, 'This payment belongs to another company.');
      if (!r.already) ctx.waitUntil(paymentEmails(env, await appOrigin(env, url), r));
      return respond({ ok: true, validUntil: r.company.validUntil });
    }
    if (path === '/api/billing/failed' && method === 'POST') {
      const b = await body(request);
      await dcall(env, 'billingFailed', { orderId: String(b.orderId || '') });
      return respond({ ok: true });
    }
  }

  // ---------- Backups (Admin) ----------
  if (path === '/api/backup' && method === 'GET') return respond({ ...(await ccall(env, user, 'backupStatus')), r2: !!env.FILES });
  if (path === '/api/backup/data' && method === 'GET') {
    const data = await ccall(env, user, 'backupData', { download: true });
    return respond({ company: { name: user.companyName, code: user.companyCode }, exportedAt: new Date().toISOString(), ...data });
  }
  { const bm = path.match(/^\/api\/backup\/(photo|file)\/([A-Za-z0-9_.:-]{1,80})$/);
    if (bm && method === 'GET') {
      const f = await ccall(env, user, 'backupFile', { kind: bm[1], id: bm[2] });
      if (!f) return err(404, 'Not found');
      let b = f.bytes;
      if (f.store === 'r2') {
        const o = env.FILES ? await env.FILES.get(`co/${user.companyId}/photo/${bm[2]}`) : null;
        if (!o) return err(404, 'Photo file missing');
        b = o.body;
      }
      return raw(b, { 'Content-Type': f.mime, 'Cache-Control': 'no-store' });
    }
  }
  if (path === '/api/backup/email' && method === 'POST') {
    const r = await sendBackup(env, user, await appOrigin(env, url), [user.email], 'now');
    if (!r.ok) return respond({ error: `Backup not sent: ${r.error}` }, 502);
    return respond({ ok: true, ...r });
  }

  // Customer status link for one RMA: get it, or email it to the customer.
  m = path.match(/^\/api\/rma\/(\d{1,12})\/track$/);
  if (m && method === 'GET') {
    const r = await ccall(env, user, 'trackLink', { id: m[1] });
    return respond({ ...r, url: `${await appOrigin(env, url)}/t/${r.token}` });
  }
  m = path.match(/^\/api\/rma\/(\d{1,12})\/track\/email$/);
  if (m && method === 'POST') {
    const b = await body(request);
    const d = await ccall(env, user, 'trackLinkMail', { id: m[1], to: b.to });
    const sent = await sendMail(env, { to: d.to, ...customerStatusEmail({ appUrl: await appOrigin(env, url), centre: d.centre, view: d.view, token: d.token, contact: d.contact, kind: 'link' }) });
    if (!sent.ok) return respond({ error: `Could not send: ${sent.error}` }, 502);
    return respond({ ok: true, to: d.to });
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
    if (!mime || !(mime.startsWith('image/') || mime === 'application/pdf')) throw new ValidationError({ file: 'Only photos (JPG, PNG, WEBP) or PDF files can be uploaded' });
    const direction = request.headers.get('X-Direction') === 'OUTBOUND' ? 'OUTBOUND' : 'INBOUND';
    const name = decodeURIComponent(request.headers.get('X-File-Name') || 'photo').replace(/[^\w .()-]/g, '_').slice(0, 120);
    const kind = request.headers.get('X-Kind') === 'challan' ? 'challan' : undefined;
    const args = { ticketId: m[1], direction, name, mime, bytes, kind };
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
      'Content-Security-Policy': r.meta.mime === 'application/pdf' ? "default-src 'none'; frame-ancestors 'self'" : "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'; sandbox",
      'Cache-Control': 'private, max-age=3600',
    });
  }
  if (m && method === 'DELETE') {
    const r = await ccall(env, user, 'deletePhoto', { id: m[1] });
    if (r.store === 'r2' && env.FILES) ctx.waitUntil(env.FILES.delete(`co/${user.companyId}/photo/${m[1]}`));
    return respond({ ok: true });
  }

  // Company logo
  if (path === '/api/company/logo' && method === 'GET') {
    const l = await ccall(env, user, 'getLogo');
    if (!l) return err(404, 'No logo');
    return raw(l.bytes, { 'Content-Type': l.mime, 'Cache-Control': 'private, max-age=604800', 'X-Content-Type-Options': 'nosniff' });
  }
  if (path === '/api/company/logo' && method === 'POST') {
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > 1024 * 1024) throw new ValidationError({ logo: 'Logo must be under 1 MB' });
    const mime = sniff(bytes);
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) throw new ValidationError({ logo: 'Upload a PNG, JPG or WebP image' });
    return respond(await ccall(env, user, 'putLogo', { bytes, mime }));
  }
  if (path === '/api/company/logo' && method === 'DELETE') return respond(await ccall(env, user, 'deleteLogo'));

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
  if (path === '/api/batches' && method === 'POST') {
    const r = await ccall(env, user, 'createBatch', await body(request));
    ctx.waitUntil(flushCustomerNotices(env, user, url));
    return respond(r);
  }
  m = path.match(/^\/api\/batches\/(BATCH-[0-9]{6}(?:-[0-9]{1,3})?)$/);
  if (m && method === 'GET') return respond(await ccall(env, user, 'getBatch', { code: m[1] }));
  m = path.match(/^\/api\/batches\/(BATCH-[0-9]{6}(?:-[0-9]{1,3})?)\/challan$/);
  if (m && method === 'POST') {
    const bytes = await request.arrayBuffer();
    if (!bytes.byteLength || bytes.byteLength > MAX_PHOTO) throw new ValidationError({ file: 'Choose a PDF up to 10 MB' });
    if (sniff(bytes) !== 'application/pdf') throw new ValidationError({ file: 'The challan must be a PDF file' });
    const name = decodeURIComponent(request.headers.get('X-File-Name') || 'challan.pdf').replace(/[^\w .()-]/g, '_').slice(0, 120);
    return respond(await ccall(env, user, 'putBatchChallan', { code: m[1], bytes, name }));
  }
  if (m && method === 'GET') {
    const f = await ccall(env, user, 'getBatchChallan', { code: m[1] });
    if (!f) return err(404, 'No challan for this batch');
    return raw(f.bytes, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${f.name.replace(/"/g, '')}"`, 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'self'", 'Cache-Control': 'private, no-store' });
  }
  if (m && method === 'DELETE') return respond(await ccall(env, user, 'deleteBatchChallan', { code: m[1] }));

  // Import
  if (path === '/api/import/rma' && method === 'POST') {
    const b = await body(request, 4 * 1024 * 1024);
    const r = await ccall(env, user, 'importTickets', b);
    if (user.plan === 'trial' && !b.dryRun && r.imported) await dcall(env, 'importSignal', { companyId: user.companyId, rows: r.imported }).catch(() => {});
    return respond(r);
  }
  if (path === '/api/import/log' && method === 'GET') return respond(await ccall(env, user, 'importLog'));
  if (path === '/api/import/customers' && method === 'POST') return respond(await ccall(env, user, 'importCustomers', await body(request, 4 * 1024 * 1024)));

  // Masters
  m = path.match(/^\/api\/masters\/(oems|products|models|customers|cp_types|categories)$/);
  if (m && method === 'POST') return respond(await ccall(env, user, 'saveMaster', { kind: m[1], record: await body(request) }));
  m = path.match(/^\/api\/masters\/(oems|products|models|customers|cp_types|categories)\/(\d{1,12})$/);
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
  if (path === '/api/admin/migration-key' && method === 'GET') return respond(await dcall(env, 'migrateKeyStatus', { actor: user }));
  if (path === '/api/admin/migration-key' && method === 'POST') {
    if (user.plan === 'trial') await dcall(env, 'importSignal', { companyId: user.companyId, rows: 0 }).catch(() => {});
    return respond(await dcall(env, 'migrateKeyCreate', { actor: user }));
  }
  if (path === '/api/admin/migration-key' && method === 'DELETE') return respond(await dcall(env, 'migrateKeyRevoke', { actor: user }));
  if (path === '/api/admin/security' && method === 'GET') return respond(await dcall(env, 'securityGet', { actor: user }));
  if (path === '/api/admin/security' && method === 'POST') {
    const b = await body(request);
    return respond(await dcall(env, 'securitySet', { actor: user, idleMinutes: b.idleMinutes, client }));
  }
  if (path === '/api/admin/sessions' && method === 'GET') return respond(await dcall(env, 'listSessions', { actor: user }));
  m = path.match(/^\/api\/admin\/sessions\/([0-9a-f-]{36})$/);
  if (m && method === 'DELETE') return respond(await dcall(env, 'endSession', { actor: user, id: m[1] }));
  if (path === '/api/admin/login-log' && method === 'GET') return respond(await dcall(env, 'authLog', { actor: user }));
  if (path === '/api/admin/audit' && method === 'GET') return respond(await ccall(env, user, 'auditLog', {}));

  return err(404, 'Not found');
}

const MODULE_LABEL = { carepack: 'Care packs', zoho: 'Zoho Books', batches: 'OEM batches', import: 'Import', reports: 'Reports' };
function moduleFor(path) {
  if (/^\/api\/(carepack\/zoho-|settings\/zoho|rma\/\d+\/challan)/.test(path)) return 'zoho';
  if (path.startsWith('/api/carepack') || path === '/api/settings/carepack') return 'carepack';
  if (path.startsWith('/api/batches')) return 'batches';
  if (path.startsWith('/api/import')) return 'import';
  return null;
}

// ======================= Migration from the old Windows RMA System =======================
async function handleMigrate(request, env, url, path, method) {
  const auth = request.headers.get('Authorization') || '';
  const user = await dcall(env, 'migrateTouch', { token: auth.replace(/^Bearer\s+/i, '').trim() });
  if (!user) return err(401, 'Migration key is missing, wrong or expired. An Admin can create a new one in Settings → Move data from the old system.');
  const hdr = (k) => decodeURIComponent(request.headers.get(k) || '');
  if (path === '/api/migrate/status' && method === 'GET') {
    return json({ company: { name: user.companyName, code: user.companyCode }, by: user.name, expires: user.expires, counts: await ccall(env, user, 'migrateStatus', {}) });
  }
  if (path === '/api/migrate/masters' && method === 'POST') return json(await ccall(env, user, 'migrateMasters', await body(request, 8 * 1024 * 1024)));
  if (path === '/api/migrate/tickets' && method === 'POST') {
    const r = await ccall(env, user, 'migrateTickets', await body(request, 8 * 1024 * 1024));
    if (r.created) await dcall(env, 'importSignal', { companyId: user.companyId, rows: r.created }).catch(() => {});
    return json(r);
  }
  if (path === '/api/migrate/batches' && method === 'POST') return json(await ccall(env, user, 'migrateBatches', await body(request, 8 * 1024 * 1024)));
  if (path === '/api/migrate/carepacks' && method === 'POST') return json(await ccall(env, user, 'migrateCarePacks', await body(request, 8 * 1024 * 1024)));
  if (path === '/api/migrate/photo' && method === 'HEAD') {
    const r = await ccall(env, user, 'migratePhotoCheck', { ticketNo: hdr('X-Ticket-No'), direction: hdr('X-Direction') === 'OUTBOUND' ? 'OUTBOUND' : 'INBOUND', name: hdr('X-File-Name') });
    return new Response(null, { status: !r.ticket ? 404 : r.exists ? 200 : 204 });
  }
  if (path === '/api/migrate/photo' && method === 'POST') {
    const bytes = await request.arrayBuffer();
    if (!bytes.byteLength || bytes.byteLength > MAX_PHOTO) throw new ValidationError({ file: 'Photo is empty or larger than 10 MB' });
    const mime = sniff(bytes);
    if (!mime || !mime.startsWith('image/')) throw new ValidationError({ file: 'Not a JPG, PNG or WEBP photo' });
    const args = {
      ticketNo: hdr('X-Ticket-No'), direction: hdr('X-Direction') === 'OUTBOUND' ? 'OUTBOUND' : 'INBOUND',
      name: hdr('X-File-Name').replace(/[^\w .()-]/g, '_').slice(0, 120) || 'photo.jpg', mime, capturedAt: hdr('X-Captured-At'), capturedBy: hdr('X-Captured-By'), notes: hdr('X-Notes'),
    };
    if (env.FILES) {
      const check = await ccall(env, user, 'migratePhotoCheck', args);
      if (!check.ticket) throw new ValidationError({ ticket_no: `RMA ${args.ticketNo} is not in the cloud yet.` });
      if (check.exists) return json({ skipped: true });
      const id = uuid();
      const key = `co/${user.companyId}/photo/${id}`;
      await env.FILES.put(key, bytes, { httpMetadata: { contentType: mime } });
      try { return json(await ccall(env, user, 'migratePhoto', { ...args, bytes: bytes.byteLength, r2Id: id })); } catch (e) { await env.FILES.delete(key); throw e; }
    }
    return json(await ccall(env, user, 'migratePhoto', { ...args, bytes }));
  }
  if (path === '/api/migrate/carepack-pdf' && method === 'POST') {
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > 15 * 1024 * 1024) throw new ValidationError({ file: 'PDF larger than 15 MB' });
    if (new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-') throw new ValidationError({ file: 'Not a PDF' });
    return json(await ccall(env, user, 'migrateCpPdf', { invoice: hdr('X-Invoice'), set: hdr('X-Set'), name: hdr('X-File-Name').replace(/[^\w .()-]/g, '_').slice(0, 120) || 'oem-invoice.pdf', bytes }));
  }
  return err(404, 'Not found');
}

// ======================= Console (service provider website) =======================
const COMPANY_CODE_RE = CODE_RE;
function companyData(b, creating) {
  const c = new Checker(b).text('name', { required: true, max: 120, label: 'Company name' })
    .text('contactName', { max: 80, label: 'Contact person' }).email('contactEmail', { label: 'Contact email' }).phone('contactPhone', { label: 'Contact phone' })
    .text('address', { max: 400, label: 'Address' }).gstin('gstin').text('notes', { max: 2000, label: 'Notes' })
    .number('maxUsers', { min: 0, max: 10000, int: true, label: 'Maximum users' }).number('maxConcurrent', { min: 0, max: 10000, int: true, label: 'Signed in at once' })
    .date('validUntil', { label: 'Valid until' }).number('idleMinutes', { min: 0, max: 60, int: true, label: 'Idle sign-out minutes' })
    .text('emailDomains', { max: 300, label: 'Email domains' }).text('suspendReason', { max: 300, label: 'Reason' });
  const v = c.out;
  const errs = {};
  v.code = companyCode(b.code);
  v.ticketPrefix = companyCode(b.ticketPrefix) || (creating ? v.code : '');
  if (creating && !COMPANY_CODE_RE.test(v.code)) errs.code = 'Login code: 2–12 letters or numbers, e.g. INF';
  if (v.ticketPrefix && !/^[A-Z0-9]{2,8}$/.test(v.ticketPrefix)) errs.ticketPrefix = 'RMA prefix: 2–8 letters or numbers';
  if (v.idleMinutes && v.idleMinutes < 2) errs.idleMinutes = 'Use 2–60 minutes, or 0 for the default';
  if (v.maxUsers && v.maxConcurrent && v.maxConcurrent > v.maxUsers) errs.maxConcurrent = 'Cannot be more than the maximum users';
  const doms = String(v.emailDomains || '').split(/[\s,;]+/).map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
  if (doms.some((d) => !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d))) errs.emailDomains = 'List domains like infinite.co.in, separated by commas';
  v.emailDomains = doms.join(', ');
  v.modules = Array.isArray(b.modules) ? b.modules.filter((m) => MODULES.includes(m)) : MODULES;
  if (typeof b.active === 'boolean') v.active = b.active;
  if (creating) v.plan = b.plan === 'trial' ? 'trial' : 'paid';
  try { c.done(); } catch (e) { Object.assign(errs, e.fields || {}); }
  if (Object.keys(errs).length) throw new ValidationError(errs);
  return v;
}

// Receipt to the company's Admins, alert to the service provider.
async function paymentEmails(env, appUrl, r) {
  const appName = env.APP_NAME || 'TrackMyRMA';
  for (const a of r.admins || []) await sendMail(env, { to: a.email, ...paymentReceiptEmail({ appName, appUrl, r, name: a.name }) });
  const consoleUrl = env.CONSOLE_HOST ? `https://${env.CONSOLE_HOST}/console` : `${appUrl}/console`;
  for (const o of r.operators || []) await sendMail(env, { to: o.email, ...paymentAlertEmail({ appName, consoleUrl, r }) });
}

// Builds a company's data backup ZIP, emails it (attached when under 15 MB), keeps a copy in R2 when bound.
async function sendBackup(env, user, appUrl, to, how) {
  const at = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const data = await ccall(env, user, 'backupData', {});
  const company = { name: user.companyName, code: user.companyCode };
  const zip = buildDataZip({ company, data, at });
  const counts = backupCounts(data);
  const fileName = `${company.code}_backup_${at.slice(0, 10)}.zip`;
  let stored = false;
  if (env.FILES) {
    try {
      const prefix = `co/${user.companyId}/backups/`;
      await env.FILES.put(`${prefix}${at.slice(0, 10)}.zip`, zip, { httpMetadata: { contentType: 'application/zip' } });
      stored = true;
      const list = (await env.FILES.list({ prefix })).objects.map((o) => o.key).sort();
      for (const k of list.slice(0, Math.max(0, list.length - BACKUP_KEEP))) await env.FILES.delete(k);
    } catch (e) { console.error('backup r2', e); }
  }
  const attached = zip.length < 15 * 1048576;
  const mail = backupEmail({ appName: env.APP_NAME || 'TrackMyRMA', appUrl, company, at, counts, size: zip.length, attached });
  const seen = new Set();
  const sentTo = [];
  let error = null;
  for (const email of to) {
    const k = String(email).toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    const r = await sendMail(env, { to: email, ...mail, attachments: attached ? [{ filename: fileName, content: base64(zip) }] : undefined });
    if (r.ok) sentTo.push(email); else error = r.error;
  }
  const result = { ok: sentTo.length > 0, size: zip.length, to: sentTo, stored, counts, error: sentTo.length ? null : error || 'No one to send to', how };
  await ccall(env, user, 'backupRecord', { result });
  return result;
}

async function runBackups(env, appUrl) {
  const companies = await dcall(env, 'reminderRecipients', {});
  const report = [];
  for (const c of companies) {
    const sys = { userId: null, name: 'System', role: 'System', companyId: c.companyId, companyName: c.name, companyCode: c.code, ticketPrefix: c.ticketPrefix };
    try {
      const d = await ccall(env, sys, 'backupDue');
      if (!d.due) continue;
      const to = [...c.people.filter((p) => p.role === 'Admin').map((p) => p.email), ...String(d.extraTo || '').split(/[,;\s]+/).filter(Boolean)];
      const r = await sendBackup(env, sys, appUrl, to, 'scheduled');
      report.push({ company: c.code, ok: r.ok, size: r.size, error: r.error });
    } catch (e) {
      report.push({ company: c.code, ok: false, error: e.message });
    }
  }
  if (report.length) console.log('backups', JSON.stringify(report));
  return report;
}

// Sends the customer step emails queued by the last change (customer_updates setting) and records the results.
async function flushCustomerNotices(env, user, url) {
  try {
    const r = await ccall(env, user, 'takeCustomerNotices', {});
    if (!r.items?.length) return;
    const app = await appOrigin(env, url);
    const results = [];
    for (const n of r.items) {
      const s = await sendMail(env, { to: n.to, ...customerStatusEmail({ appUrl: app, centre: r.centre, view: n.view, token: n.token, contact: n.contact }) });
      results.push({ noticeId: n.noticeId, to: n.to, ok: s.ok, error: s.error });
    }
    await ccall(env, user, 'customerNoticeResults', { results });
  } catch (e) {
    console.error('customer notices', e);
  }
}

async function appOrigin(env, url) {
  if (env.APP_URL) return env.APP_URL.replace(/\/+$/, '');
  if (env.CONSOLE_HOST && url.hostname === env.CONSOLE_HOST) return (await dcall(env, 'appUrl', {})) || url.origin;
  return url.origin;
}

async function handleConsole(request, env, ctx, url, path, method, client) {
  const appName = env.APP_NAME || 'TrackMyRMA';
  const cookie = (t) => ({ 'Set-Cookie': sessionCookie(t, CCOOKIE) });

  // ---- before login ----
  // First console operator. Two ways, both secure:
  //  1. Signed in to the RMA app as the owner (the login that did the very first setup, already protected by 2FA):
  //     just email + password, then the authenticator. No setup key needed.
  //  2. Otherwise (e.g. console on its own domain): the CONSOLE_SETUP_KEY secret.
  const ownerSession = async () => {
    const s = await dcall(env, 'touch', { token: readCookie(request) });
    return s && s.isOwner ? s : null;
  };
  if (path === '/api/console/setup' && method === 'GET') {
    const st = await dcall(env, 'consoleNeedsSetup', {});
    const owner = st.needsSetup ? await ownerSession() : null;
    return json({ ...st, keyConfigured: !!env.CONSOLE_SETUP_KEY, owner: owner ? { name: owner.name, email: owner.email } : null },
      200, owner?.newToken ? { 'Set-Cookie': sessionCookie(owner.newToken) } : {});
  }
  if (path === '/api/console/setup' && method === 'POST') {
    const b = await body(request);
    const owner = await ownerSession();
    let name = owner?.name;
    if (!owner) {
      if (!env.CONSOLE_SETUP_KEY) return err(403, 'To set up the console, first log in to the RMA app with the account that did the first setup, then open /console again.');
      if (!timingSafeEqual(String(b.key || ''), env.CONSOLE_SETUP_KEY)) {
        await new Promise((r) => setTimeout(r, 800));
        throw new ValidationError({ key: 'Setup key is not correct' });
      }
      name = new Checker(b).text('name', { required: true, max: 80, label: 'Your name' }).done().name;
    }
    const v = new Checker(b).email('email', { required: true }).done();
    if (b.password !== b.confirm) throw new ValidationError({ confirm: 'Passwords do not match' });
    await checkNewPassword(b.password, v.email);
    return json(await dcall(env, 'consoleSetupStart', { name: name || v.email.split('@')[0], email: v.email, password: b.password, ip: client.ip }),
      200, owner?.newToken ? { 'Set-Cookie': sessionCookie(owner.newToken) } : {});
  }
  if (path === '/api/console/enroll' && method === 'POST') {
    const b = await body(request);
    if (!/^\d{6}$/.test(String(b.code || ''))) throw new ValidationError({ code: 'Enter the 6-digit code from your authenticator app' });
    const d = await dcall(env, 'consoleEnrollFinish', { setupToken: b.setupToken, code: String(b.code), client });
    return json({ recoveryCodes: d.recoveryCodes, op: d.op }, 200, cookie(d.token));
  }
  if (path === '/api/console/invite/check' && method === 'POST') return json(await dcall(env, 'consoleInviteCheck', { token: String((await body(request)).token || '') }));
  if (path === '/api/console/invite/accept' && method === 'POST') {
    const b = await body(request);
    const inv = await dcall(env, 'consoleInviteCheck', { token: String(b.token || '') });
    if (b.password !== b.confirm) throw new ValidationError({ confirm: 'Passwords do not match' });
    await checkNewPassword(b.password, inv.email);
    return json(await dcall(env, 'consoleInviteStart', { token: String(b.token), password: b.password, ip: client.ip }));
  }
  if (path === '/api/console/login' && method === 'POST') {
    const b = await body(request);
    const v = new Checker(b).email('email', { required: true }).text('password', { required: true, max: 128, label: 'Password' }).done();
    return json(await dcall(env, 'consoleLogin', { email: v.email, password: b.password, client }));
  }
  if (path === '/api/console/login/verify' && method === 'POST') {
    const b = await body(request);
    const d = await dcall(env, 'consoleVerify', { loginToken: b.loginToken, code: String(b.code || '').trim(), recoveryCode: b.recoveryCode, client });
    return json({ op: d.op }, 200, cookie(d.token));
  }
  if (path === '/api/console/logout' && method === 'POST') {
    await dcall(env, 'consoleLogout', { token: readCookie(request, CCOOKIE) });
    return json({ ok: true }, 200, { 'Set-Cookie': clearCookie(CCOOKIE) });
  }

  // ---- signed in ----
  const s = await dcall(env, 'consoleTouch', { token: readCookie(request, CCOOKIE) });
  if (!s) return err(401, 'Your console session ended. Please log in again.', { code: 'session_ended' });
  const op = { opId: s.opId, email: s.email, name: s.name, sessionId: s.sessionId };
  const respond = (data, status = 200) => json(data, status, s.newToken ? cookie(s.newToken) : {});
  const app = await appOrigin(env, url);
  const sendInvite = async (data, companyName, reset = false) => {
    const mail = inviteEmail({ appName, appUrl: app, name: data.user.name, token: data.invite.token, days: data.invite.days, companies: [companyName], invitedBy: op.name, reset });
    const sent = await sendMail(env, { to: data.user.email, ...mail });
    return { emailed: sent.ok, emailError: sent.ok ? null : sent.error, link: inviteLink(app, data.invite.token), days: data.invite.days, companyCode: data.companyCode };
  };

  if (path === '/api/console/me' && method === 'GET') return respond({ op: await dcall(env, 'consoleMe', { op }), idleMinutes: s.idleMinutes, appUrl: app });
  if (path === '/api/console/ping' && method === 'POST') return respond({ ok: true });
  if (path === '/api/console/change-password' && method === 'POST') {
    const b = await body(request);
    const errs = {};
    if (!b.current) errs.current = 'Enter your current password';
    if (!/^\d{6}$/.test(String(b.code || ''))) errs.code = 'Enter the 6-digit code from your authenticator app';
    if (b.password !== b.confirm) errs.confirm = 'Passwords do not match';
    if (Object.keys(errs).length) throw new ValidationError(errs);
    await checkNewPassword(b.password, op.email);
    const r = await dcall(env, 'consoleChangePassword', { op, current: b.current, password: b.password, code: String(b.code) });
    ctx.waitUntil(sendMail(env, { to: r.email, ...passwordChangedEmail({ appName: `${appName} Console`, appUrl: url.origin, name: r.name, how: 'change', client }) }));
    return respond({ ok: true });
  }
  if (path === '/api/console/recovery-codes' && method === 'POST') {
    const b = await body(request);
    if (!/^\d{6}$/.test(String(b.code || ''))) throw new ValidationError({ code: 'Enter the 6-digit code from your authenticator app' });
    return respond(await dcall(env, 'consoleRecoveryCodes', { op, code: String(b.code) }));
  }

  if (path === '/api/console/companies' && method === 'GET') return respond(await dcall(env, 'consoleCompanies', {}));
  if (path === '/api/console/companies' && method === 'POST') {
    const b = await body(request);
    const data = companyData(b.company || {}, true);
    const admin = new Checker(b.admin || {}).text('name', { required: true, max: 80, label: 'Admin name' }).email('email', { required: true, label: 'Admin email' }).done();
    const r = await dcall(env, 'consoleCreateCompany', { op, data, admin, ip: client.ip });
    return respond({ company: r.company, user: r.user, ...(await sendInvite(r, r.company.name)) });
  }
  let m = path.match(/^\/api\/console\/companies\/([0-9a-f-]{36})$/);
  if (m && method === 'GET') {
    const d = await dcall(env, 'consoleCompany', { op, id: m[1] });
    return respond({ ...d, transactions: await company(env, m[1]).transactionCounts() });
  }
  if (m && method === 'POST') return respond(await dcall(env, 'consoleUpdateCompany', { op, id: m[1], data: companyData(await body(request), false), ip: client.ip }));
  m = path.match(/^\/api\/console\/companies\/([0-9a-f-]{36})\/export$/);
  if (m && method === 'GET') {
    const data = await company(env, m[1]).exportTables();
    const rows = Object.values(data.tables).reduce((a, t) => a + t.length, 0);
    const co = await dcall(env, 'consoleExportLog', { op, id: m[1], detail: `${rows} rows, ${data.photos.length} photos, ${data.files.length} files`, ip: client.ip });
    return respond({ company: co, exportedAt: new Date().toISOString(), ...data });
  }
  m = path.match(/^\/api\/console\/companies\/([0-9a-f-]{36})\/export\/(photo|file)\/([A-Za-z0-9_.:-]{1,80})$/);
  if (m && method === 'GET') {
    const f = await company(env, m[1]).exportFile({ kind: m[2], id: m[3] });
    if (!f) return err(404, 'Not found');
    let body = f.bytes;
    if (f.store === 'r2') {
      const o = env.FILES ? await env.FILES.get(`co/${m[1]}/photo/${m[3]}`) : null;
      if (!o) return err(404, 'Photo file missing');
      body = o.body;
    }
    return new Response(body, { headers: { 'Content-Type': f.mime, 'Cache-Control': 'no-store' } });
  }
  m = path.match(/^\/api\/console\/companies\/([0-9a-f-]{36})\/logo$/);
  if (m) {
    const sys = { userId: null, name: `${op.name} (console)`, role: 'Admin', companyId: m[1] };
    if (method === 'GET') {
      const l = await ccall(env, sys, 'getLogo');
      return l ? new Response(l.bytes, { headers: { 'Content-Type': l.mime, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } }) : err(404, 'No logo');
    }
    if (method === 'POST') {
      const bytes = await request.arrayBuffer();
      if (bytes.byteLength > 1024 * 1024) throw new ValidationError({ logo: 'Logo must be under 1 MB' });
      const mime = sniff(bytes);
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) throw new ValidationError({ logo: 'Upload a PNG, JPG or WebP image' });
      const r = await ccall(env, sys, 'putLogo', { bytes, mime });
      await dcall(env, 'consoleExportLog', { op, id: m[1], detail: 'company logo uploaded', ip: client.ip }).catch(() => {});
      return respond({ logoAt: r.logoAt });
    }
    if (method === 'DELETE') { const r = await ccall(env, sys, 'deleteLogo'); return respond({ logoAt: r.logoAt }); }
  }
  if (path === '/api/console/payment' && method === 'GET') return respond(await dcall(env, 'consolePaymentGet', {}));
  if (path === '/api/console/payment' && method === 'POST') return respond(await dcall(env, 'consolePaymentSave', { op, payment: (await body(request)).payment, ip: client.ip }));
  m = path.match(/^\/api\/console\/companies\/([0-9a-f-]{36})\/(extend-trial|mark-paid)$/);
  if (m && method === 'POST') {
    const b = await body(request);
    const d = m[2] === 'extend-trial'
      ? await dcall(env, 'consoleExtendTrial', { op, id: m[1], amount: b.amount, ref: b.ref, ip: client.ip })
      : await dcall(env, 'consoleMarkPaid', { op, id: m[1], validUntil: b.validUntil, amount: b.amount, ref: b.ref, ip: client.ip });
    return respond({ ...d, transactions: await company(env, m[1]).transactionCounts() });
  }
  m = path.match(/^\/api\/console\/companies\/([0-9a-f-]{36})\/remind$/);
  if (m && method === 'POST') {
    const n = await dcall(env, 'consoleRemindInfo', { op, id: m[1], ip: client.ip });
    const sent = [];
    for (const p of n.people) {
      const r = await sendMail(env, { to: p.email, ...accessEmail({ appName, appUrl: app, kind: n.kind, company: n.company, info: n.info, payment: n.payment, recipientName: p.name }) });
      sent.push({ to: p.email, ok: r.ok, error: r.ok ? null : r.error });
    }
    return respond({ sent });
  }
  m = path.match(/^\/api\/console\/companies\/([0-9a-f-]{36})\/delete$/);
  if (m && method === 'POST') {
    const b = await body(request);
    // Only a company with no RMAs, OEM batches or care packs can be deleted (or a trial past its 60-day data period).
    const tx = await company(env, m[1]).transactionCounts();
    const chk = await dcall(env, 'consoleDeleteCheck', { op, id: m[1], confirmCode: b.confirmCode, code: b.code, tx, ip: client.ip });
    await company(env, m[1]).wipeAll();
    if (env.FILES) {
      let cursor;
      do {
        const page = await env.FILES.list({ prefix: `co/${m[1]}/`, cursor });
        if (page.objects.length) await env.FILES.delete(page.objects.map((o) => o.key));
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
    }
    return respond(await dcall(env, 'consoleDeleteFinish', { op, id: m[1], token: chk.token, ip: client.ip }));
  }
  m = path.match(/^\/api\/console\/companies\/([0-9a-f-]{36})\/signout-all$/);
  if (m && method === 'POST') return respond(await dcall(env, 'consoleSignOutAll', { op, id: m[1] }));
  m = path.match(/^\/api\/console\/companies\/([0-9a-f-]{36})\/users$/);
  if (m && method === 'POST') {
    const b = await body(request);
    const v = new Checker(b).text('name', { required: true, max: 80, label: 'Name' }).email('email', { required: true })
      .oneOf('role', ROLES, { required: true, label: 'Role' }).bool('dupOverride').done();
    const data = await dcall(env, 'consoleAct', { op, companyId: m[1], action: 'inviteUser', args: { name: v.name, email: v.email, role: v.role, dupOverride: !!v.dupOverride } });
    const co = await dcall(env, 'consoleCompany', { op, id: m[1] });
    return respond({ user: data.user, ...(await sendInvite(data, co.company.name)) });
  }
  m = path.match(/^\/api\/console\/companies\/([0-9a-f-]{36})\/users\/([0-9a-f-]{36})$/);
  if (m && method === 'POST') {
    const b = await body(request);
    const args = { userId: m[2] };
    if (b.role !== undefined) args.role = String(b.role);
    if (b.dupOverride !== undefined) args.dupOverride = b.dupOverride === true;
    if (b.disabled !== undefined) args.disabled = b.disabled === true;
    return respond(await dcall(env, 'consoleAct', { op, companyId: m[1], action: 'updateUser', args }));
  }
  if (m && method === 'DELETE') return respond(await dcall(env, 'consoleAct', { op, companyId: m[1], action: 'removeUser', args: { userId: m[2] } }));
  m = path.match(/^\/api\/console\/companies\/([0-9a-f-]{36})\/users\/([0-9a-f-]{36})\/(resend-invite|reset-login)$/);
  if (m && method === 'POST') {
    const reset = m[3] === 'reset-login';
    const data = await dcall(env, 'consoleAct', { op, companyId: m[1], action: reset ? 'resetSignIn' : 'resendInvite', args: { userId: m[2] } });
    const co = await dcall(env, 'consoleCompany', { op, id: m[1] });
    return respond({ user: data.user, ...(await sendInvite(data, co.company.name, reset)) });
  }
  m = path.match(/^\/api\/console\/companies\/([0-9a-f-]{36})\/sessions\/([0-9a-f-]{36})$/);
  if (m && method === 'DELETE') return respond(await dcall(env, 'consoleAct', { op, companyId: m[1], action: 'endSession', args: { id: m[2] } }));

  if (path === '/api/console/operators' && method === 'GET') return respond({ operators: await dcall(env, 'consoleOperators', {}), you: op.opId });
  if (path === '/api/console/operators' && method === 'POST') {
    const v = new Checker(await body(request)).text('name', { required: true, max: 80, label: 'Name' }).email('email', { required: true }).done();
    const d = await dcall(env, 'consoleInviteOperator', { op, name: v.name, email: v.email });
    const mail = consoleInviteEmail({ appName, consoleUrl: url.origin, name: d.user.name, token: d.invite.token, days: d.invite.days, invitedBy: op.name });
    const sent = await sendMail(env, { to: d.user.email, ...mail });
    return respond({ user: d.user, emailed: sent.ok, emailError: sent.ok ? null : sent.error, link: `${url.origin}/console/invite#token=${encodeURIComponent(d.invite.token)}`, days: d.invite.days });
  }
  m = path.match(/^\/api\/console\/operators\/([0-9a-f-]{36})$/);
  if (m && method === 'POST') return respond(await dcall(env, 'consoleUpdateOperator', { op, id: m[1], disabled: (await body(request)).disabled === true }));
  m = path.match(/^\/api\/console\/operators\/([0-9a-f-]{36})\/reset$/);
  if (m && method === 'POST') {
    const d = await dcall(env, 'consoleResetOperator', { op, id: m[1] });
    const mail = consoleInviteEmail({ appName, consoleUrl: url.origin, name: d.user.name, token: d.invite.token, days: d.invite.days, invitedBy: op.name, reset: true });
    const sent = await sendMail(env, { to: d.user.email, ...mail });
    return respond({ user: d.user, emailed: sent.ok, emailError: sent.ok ? null : sent.error, link: `${url.origin}/console/invite#token=${encodeURIComponent(d.invite.token)}`, days: d.invite.days });
  }
  if (path === '/api/console/log' && method === 'GET') return respond(await dcall(env, 'consoleLogView', { limit: url.searchParams.get('limit') }));
  return err(404, 'Not found');
}

function mainHost(env) {
  try { return env.APP_URL ? new URL(env.APP_URL).hostname : ''; } catch { return ''; }
}
function isLocalHost(h) {
  return h === 'localhost' || h === '127.0.0.1' || h.endsWith('.workers.dev');
}

// Pages: the RMA app and the console are two single-page sites in one Worker.
// With CONSOLE_HOST set, the console answers only on that hostname; /console on the app hostname redirects there.
async function serveStatic(request, env, url) {
  const host = env.CONSOLE_HOST;
  const onConsoleHost = !!host && url.hostname === host;
  // Extra domains (old address, .in / .co.in, www) send pages to the main address in APP_URL.
  // /api and /sw.js still answer everywhere, so an app installed from the old address can update itself.
  const main = mainHost(env);
  if (main && url.hostname !== main && !onConsoleHost && !isLocalHost(url.hostname) && url.pathname !== '/sw.js'
      && (request.method === 'GET' || request.method === 'HEAD')) {
    return Response.redirect(new URL(url.pathname + url.search, env.APP_URL).toString(), 301);
  }
  const isConsolePath = url.pathname === '/console' || url.pathname.startsWith('/console/');
  const consolePage = () => env.ASSETS.fetch(new Request(new URL('/console', url), { headers: request.headers }));
  if (onConsoleHost) {
    if (isConsolePath) return consolePage();
    if (/\.[a-z0-9]{2,8}$/i.test(url.pathname)) return env.ASSETS.fetch(request);
    return Response.redirect(new URL('/console', url), 302);
  }
  // Console moved to its own hostname: send old bookmarks there instead of a bare "Not found".
  if (isConsolePath) return host ? Response.redirect(`https://${host}/console`, 302) : consolePage();
  return env.ASSETS.fetch(request);
}

function consoleUrlOf(env, appUrl) {
  return env.CONSOLE_HOST ? `https://${env.CONSOLE_HOST}/console` : `${appUrl.replace(/\/+$/, '')}/console`;
}

const cpItems = (list = []) => list.map((i) => ({ ...i, ticket_no: i.invoice, serial: '', part: i.detail, href: `/care-packs/${i.id}`, age: null }));

// Daily job: one digest per company to its Admins and Managers (plus any extra addresses set).
async function runReminders(env, appUrl) {
  const appName = env.APP_NAME || 'TrackMyRMA';
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
  // Trial / access reminders to each company's Admins.
  const { notices, payment } = await dcall(env, 'accessNotices', {});
  for (const n of notices) {
    for (const p of n.people) {
      const r = await sendMail(env, { to: p.email, ...accessEmail({ appName, appUrl, kind: n.kind, company: n.company, info: n.info, payment, recipientName: p.name }) });
      report.push({ company: n.company.code, access: n.kind, to: p.email, ok: r.ok, error: r.error });
    }
  }
  // Daily summary for the service provider: sign-ups, buying signals, access ending / ended.
  const d = await dcall(env, 'providerDigest', {});
  if (d.signups.length + d.hot.length + d.ending.length + d.readOnly.length + d.ended.length) {
    const sentToCustomers = report.filter((r) => r.access);
    for (const o of d.to) {
      const r = await sendMail(env, { to: o.email, ...providerDigestEmail({ appName, consoleUrl: consoleUrlOf(env, appUrl), d, sentToCustomers }) });
      report.push({ provider: o.email, ok: r.ok, error: r.error });
    }
  }
  console.log('reminders', JSON.stringify(report));
  return report;
}

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      if (!url.pathname.startsWith('/api/')) return await serveStatic(request, env, url);
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
      await runBackups(env, appUrl);
    })());
  },
};

