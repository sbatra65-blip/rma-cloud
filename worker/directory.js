// Directory: the one shared store for companies, logins, 2FA and sessions.
// Every login belongs to exactly ONE company: its own password, its own authenticator,
// its own recovery codes. The same email can have separate logins in two companies.
// RMA data is not here — it lives in each company's own database (see company.js).
import { DurableObject } from 'cloudflare:workers';
import {
  hashPassword, timingSafeEqual, newToken, sha256, uuid, newTotpSecret, verifyTotp,
  encryptSecret, decryptSecret,
} from './crypto.js';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const LOCK_AFTER = 5;
const LOCK_MINUTES = 15;
const ROTATE_EVERY = 60_000;
const OLD_TOKEN_GRACE = 30_000;
const RESET_MINUTES = 30;
const INVITE_DAYS = 7;

export const ROLES = ['Admin', 'Manager', 'Technician', 'Viewer'];
// Optional parts of the app a service provider can switch on or off per company. RMA itself is always on.
export const MODULES = ['carepack', 'zoho', 'batches', 'import', 'reports'];
const COMPANY_COLS = [
  ['contact_name', 'TEXT'], ['contact_email', 'TEXT'], ['contact_phone', 'TEXT'], ['address', 'TEXT'], ['gstin', 'TEXT'], ['notes', 'TEXT'],
  ['max_users', 'INTEGER NOT NULL DEFAULT 0'], ['max_concurrent', 'INTEGER NOT NULL DEFAULT 0'], ['valid_until', 'TEXT'], ['modules', 'TEXT'],
  ['idle_minutes', 'INTEGER NOT NULL DEFAULT 0'], ['email_domains', 'TEXT'], ['suspend_reason', 'TEXT'], ['updated_at', 'INTEGER'],
  // Plans: 'trial' (30 days, all modules, 3 users, 50 RMAs) or 'paid'. Existing companies count as paid.
  ['plan', "TEXT NOT NULL DEFAULT 'paid'"], ['trial_started', 'TEXT'], ['extended_at', 'INTEGER'], ['advance_amount', 'INTEGER'],
  ['advance_ref', 'TEXT'], ['paid_at', 'INTEGER'], ['import_signal_at', 'INTEGER'], ['import_rows', 'INTEGER NOT NULL DEFAULT 0'],
];
// Trial and access rules (days are calendar days in IST).
export const TRIAL = { days: 30, rmas: 50, users: 3, graceDays: 7, retainDays: 60, extendDays: 15, advancePct: 25 };
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const todayIST = () => new Date(Date.now() + 19800000).toISOString().slice(0, 10);
const dmy = (iso) => (iso ? iso.split('-').reverse().join('-') : '');

export class AuthError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

export class Directory extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.ipHits = new Map();
    this.signupHits = new Map();
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  migrate() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS companies (
        id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        ticket_prefix TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, company_id TEXT NOT NULL, email TEXT NOT NULL, name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'Technician', dup_override INTEGER NOT NULL DEFAULT 0,
        pass_hash TEXT NOT NULL DEFAULT '', pass_salt TEXT NOT NULL DEFAULT '', pass_iter INTEGER NOT NULL DEFAULT 0,
        totp_enc TEXT, totp_enabled INTEGER NOT NULL DEFAULT 0, totp_last INTEGER NOT NULL DEFAULT -1,
        recovery TEXT NOT NULL DEFAULT '[]', failed INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0,
        is_owner INTEGER NOT NULL DEFAULT 0, disabled INTEGER NOT NULL DEFAULT 0,
        last_login INTEGER, created_at INTEGER NOT NULL, created_by TEXT,
        UNIQUE (company_id, email)
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL,
        prev_hash TEXT, prev_until INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, last_active INTEGER NOT NULL, rotated_at INTEGER NOT NULL,
        ua TEXT, ip TEXT, place TEXT
      );
      CREATE INDEX IF NOT EXISTS sessions_token ON sessions(token_hash);
      CREATE INDEX IF NOT EXISTS sessions_prev ON sessions(prev_hash);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS pending (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, purpose TEXT NOT NULL,
        passed INTEGER NOT NULL DEFAULT 0, expires INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, company_id TEXT, user_id TEXT, email TEXT,
        event TEXT NOT NULL, detail TEXT, ip TEXT, ua TEXT
      );
      CREATE INDEX IF NOT EXISTS auth_log_at ON auth_log(company_id, at);
      CREATE TABLE IF NOT EXISTS console_users (
        id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
        pass_hash TEXT NOT NULL DEFAULT '', pass_salt TEXT NOT NULL DEFAULT '', pass_iter INTEGER NOT NULL DEFAULT 0,
        totp_enc TEXT, totp_enabled INTEGER NOT NULL DEFAULT 0, totp_last INTEGER NOT NULL DEFAULT -1,
        recovery TEXT NOT NULL DEFAULT '[]', failed INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0,
        disabled INTEGER NOT NULL DEFAULT 0, last_login INTEGER, created_at INTEGER NOT NULL, created_by TEXT
      );
      CREATE TABLE IF NOT EXISTS console_sessions (
        id TEXT PRIMARY KEY, op_id TEXT NOT NULL, token_hash TEXT NOT NULL, prev_hash TEXT, prev_until INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, last_active INTEGER NOT NULL, rotated_at INTEGER NOT NULL, ua TEXT, ip TEXT, place TEXT
      );
      CREATE TABLE IF NOT EXISTS console_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, op_email TEXT, action TEXT NOT NULL, company_id TEXT, detail TEXT, ip TEXT
      );
    `);
    for (const [c, def] of COMPANY_COLS) {
      try { this.sql.exec(`ALTER TABLE companies ADD COLUMN ${c} ${def}`); } catch { /* already there */ }
    }
  }

  // ---------- Company limits (set from the console) ----------
  modulesOf(c) {
    try {
      const m = JSON.parse(c?.modules || 'null');
      return Array.isArray(m) ? MODULES.filter((x) => m.includes(x)) : [...MODULES];
    } catch { return [...MODULES]; }
  }
  idleFor(c) {
    const m = Number(c?.idle_minutes) || 0;
    return (m >= 2 && m <= 60 ? m : Number(this.env.IDLE_MINUTES || 5)) * MIN;
  }
  // open: normal use. readonly: up to 7 days after the access date (view and export only). ended: locked.
  access(c) {
    if (!c?.valid_until) return 'open';
    const today = todayIST();
    if (today <= c.valid_until) return 'open';
    return today <= addDays(c.valid_until, TRIAL.graceDays) ? 'readonly' : 'ended';
  }
  expired(c) { return this.access(c) === 'ended'; }
  // What the company's people see on the trial banner, the read-only screen and the locked login.
  paymentInfo() {
    try { return JSON.parse(this.one("SELECT value FROM meta WHERE key = 'payment_info'")?.value || 'null'); } catch { return null; }
  }
  accessInfo(c) {
    const acc = this.access(c);
    const days = (iso) => Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${todayIST()}T00:00:00Z`)) / DAY);
    return {
      plan: c.plan || 'paid', access: acc, validUntil: c.valid_until || null, daysLeft: c.valid_until ? days(c.valid_until) : null,
      readOnlyUntil: c.valid_until ? addDays(c.valid_until, TRIAL.graceDays) : null,
      keepDataUntil: c.valid_until && (c.plan === 'trial') ? addDays(c.valid_until, TRIAL.retainDays) : null,
      extended: !!c.extended_at, advanceAmount: c.advance_amount || 0, trialRmas: TRIAL.rmas, trial: TRIAL,
    };
  }
  domains(c) { return String(c?.email_domains || '').split(/[\s,;]+/).map((x) => x.trim().toLowerCase().replace(/^@/, '')).filter(Boolean); }
  domainOk(c, email) {
    const list = this.domains(c);
    return !list.length || list.includes(String(email).split('@')[1]?.toLowerCase());
  }
  seatsInUse(c, exceptUserId = '') {
    const now = Date.now();
    return this.one(`SELECT COUNT(*) AS n FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE u.company_id = ? AND u.id != ? AND s.last_active > ? AND s.created_at > ?`, c.id, exceptUserId, now - this.idleFor(c), now - this.maxMs).n;
  }
  activeUsers(companyId) { return this.one('SELECT COUNT(*) AS n FROM users WHERE company_id = ? AND disabled = 0', companyId).n; }
  checkUserLimit(c) {
    if (c.max_users > 0 && this.activeUsers(c.id) >= c.max_users) {
      throw new AuthError(409, `${c.name} can have at most ${c.max_users} active login${c.max_users === 1 ? '' : 's'}. Disable a login first, or ask your service provider to raise the limit.`);
    }
  }
  accessEnded(c) {
    if (!c || !c.active) return `Access for ${c?.name || 'this company'} is suspended.${c?.suspend_reason ? ` ${c.suspend_reason}` : ''} Please contact your service provider.`;
    if (this.expired(c)) {
      return c.plan === 'trial'
        ? `The free trial for ${c.name} ended on ${dmy(c.valid_until)}. Your data is kept until ${dmy(addDays(c.valid_until, TRIAL.retainDays))}. Buy a plan to continue.`
        : `Access for ${c.name} ended on ${dmy(c.valid_until)}. Please renew to continue.`;
    }
    return null;
  }

  // RPC entry point. Errors come back as plain data because custom error
  // fields do not survive the trip between the Worker and the Durable Object.
  async call(method, args) {
    if (args && args.origin) this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('app_url', ?)", String(args.origin).slice(0, 200));
    const allowed = [
      'appUrl', 'needsSetup', 'setupStart', 'enrollFinish', 'inviteCheck', 'inviteStart',
      'forgotStart', 'mailResult', 'resetCheck', 'resetFinish', 'changePassword', 'newRecoveryCodes',
      'loginPassword', 'loginVerify', 'touch', 'logout', 'publicUser',
      'listUsers', 'inviteUser', 'updateUser', 'resendInvite', 'resetSignIn', 'removeUser',
      'listSessions', 'endSession', 'authLog',
      'updateCompany', 'reminderRecipients', 'migrateKeyCreate', 'migrateKeyStatus', 'migrateKeyRevoke', 'migrateTouch',
      'consoleNeedsSetup', 'consoleSetupStart', 'consoleEnrollFinish', 'consoleLogin', 'consoleVerify', 'consoleTouch', 'consoleLogout',
      'consoleMe', 'consoleChangePassword', 'consoleRecoveryCodes', 'consoleOperators', 'consoleInviteOperator', 'consoleInviteCheck',
      'consoleInviteStart', 'consoleUpdateOperator', 'consoleResetOperator', 'consoleLogView', 'consoleCompanies', 'consoleCompany',
      'signup', 'consoleCreateCompany', 'consoleUpdateCompany', 'consoleDeleteCheck', 'consoleDeleteFinish', 'consoleExportLog', 'consoleExtendTrial', 'consoleMarkPaid', 'consolePaymentGet', 'consolePaymentSave', 'importSignal', 'accessNotices', 'consoleSignOutAll', 'consoleAct',
    ];
    if (!allowed.includes(method)) return { error: { status: 400, message: 'Unknown action' } };
    try {
      return { data: await this[method](args) };
    } catch (e) {
      if (e instanceof AuthError) return { error: { status: e.code, message: e.message, ...e.extra } };
      console.error('directory', method, e);
      return { error: { status: 500, message: 'Something went wrong on the server.' } };
    }
  }

  get idleMs() { return Number(this.env.IDLE_MINUTES || 5) * MIN; }
  get maxMs() { return Number(this.env.MAX_SESSION_HOURS || 12) * 60 * MIN; }
  get iterations() { return Number(this.env.PBKDF2_ITERATIONS || 100000); }
  get appName() { return this.env.APP_NAME || 'TrackMyRMA'; }

  one(query, ...args) { return this.sql.exec(query, ...args).toArray()[0] || null; }
  all(query, ...args) { return this.sql.exec(query, ...args).toArray(); }

  log(event, { companyId = null, userId = null, email = null, detail = null, client = {} } = {}) {
    this.sql.exec('INSERT INTO auth_log (at, company_id, user_id, email, event, detail, ip, ua) VALUES (?,?,?,?,?,?,?,?)',
      Date.now(), companyId, userId, email, event, detail ? String(detail).slice(0, 500) : null, client.ip || null, client.ua || null);
    this.sql.exec('DELETE FROM auth_log WHERE at < ?', Date.now() - 400 * DAY);
  }

  // Simple per-IP limiter for login, setup and reset attempts (30 per 15 minutes).
  limitIp(ip) {
    const now = Date.now();
    const hits = (this.ipHits.get(ip) || []).filter((t) => now - t < 15 * MIN);
    hits.push(now);
    this.ipHits.set(ip, hits);
    if (hits.length > 30) throw new AuthError(429, 'Too many attempts from this network. Try again in 15 minutes.');
  }

  cleanup() {
    const now = Date.now();
    this.sql.exec('DELETE FROM pending WHERE expires < ?', now);
    this.sql.exec('DELETE FROM sessions WHERE last_active < ? OR created_at < ?', now - Math.max(this.idleMs, 60 * MIN), now - this.maxMs);
    this.sql.exec('DELETE FROM console_sessions WHERE last_active < ? OR created_at < ?', now - this.cIdleMs, now - this.maxMs);
  }

  companyByCode(code) {
    return this.one('SELECT * FROM companies WHERE code = ?', String(code || '').trim());
  }

  otpauth(user, company) {
    // Shows as e.g. "TrackMyRMA (INF): name@x.com" so people with logins in two companies can tell them apart.
    const issuer = `${this.appName} (${company.code})`;
    return `otpauth://totp/${encodeURIComponent(`${issuer}:${user.email}`)}?secret=${'{SECRET}'}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
  }

  async newRecovery(userId, table = 'users') {
    const recovery = Array.from({ length: 10 }, () => newToken(6).replace(/[-_]/g, 'x').slice(0, 8).toUpperCase());
    const hashes = await Promise.all(recovery.map((c) => sha256(c)));
    this.sql.exec(`UPDATE ${table} SET recovery = ? WHERE id = ?`, JSON.stringify(hashes), userId);
    return recovery;
  }

  // Gives the login a fresh authenticator secret and a short-lived token to confirm it with.
  async beginEnroll(user) {
    const company = this.one('SELECT * FROM companies WHERE id = ?', user.company_id);
    const secret = newTotpSecret();
    this.sql.exec('UPDATE users SET totp_enc = ?, totp_enabled = 0, totp_last = -1 WHERE id = ?',
      await encryptSecret(secret, this.env.ENC_KEY), user.id);
    const token = newToken();
    this.sql.exec('INSERT INTO pending (token_hash, user_id, purpose, expires) VALUES (?,?,?,?)',
      await sha256(token), user.id, 'enroll', Date.now() + 15 * MIN);
    return {
      setupToken: token, secret, otpauth: this.otpauth(user, company).replace('{SECRET}', secret),
      company: { code: company.code, name: company.name },
    };
  }

  // ---------- First-run setup (only while nobody has finished setting up a login) ----------
  needsSetup() {
    return { needsSetup: !this.one('SELECT 1 AS x FROM users WHERE totp_enabled = 1 LIMIT 1') };
  }

  async setupStart({ name, email, password, companyName, companyCode, ticketPrefix, ip }) {
    this.limitIp(ip);
    this.cleanup();
    if (!this.needsSetup().needsSetup) throw new AuthError(409, 'This app is already set up. Log in instead.');
    // An abandoned setup can be restarted.
    this.sql.exec('DELETE FROM users');
    this.sql.exec('DELETE FROM companies');
    this.sql.exec('DELETE FROM pending');
    const pw = await hashPassword(password, null, this.iterations);
    const user = { id: uuid(), company_id: uuid(), email };
    const now = Date.now();
    this.sql.exec('INSERT INTO companies (id, code, name, ticket_prefix, created_at) VALUES (?,?,?,?,?)',
      user.company_id, companyCode, companyName, ticketPrefix, now);
    this.sql.exec(
      `INSERT INTO users (id, company_id, email, name, role, dup_override, pass_hash, pass_salt, pass_iter, is_owner, created_at)
       VALUES (?,?,?,?, 'Admin', 1, ?,?,?, 1, ?)`,
      user.id, user.company_id, email, name, pw.hash, pw.salt, pw.iterations, now,
    );
    this.log('setup', { companyId: user.company_id, userId: user.id, email, detail: `${companyName} (${companyCode})` });
    return this.beginEnroll(user);
  }

  // Confirms the authenticator code for setup, invite or sign-in reset; signs the person in.
  async enrollFinish({ setupToken, code, client }) {
    const p = await this.takePending(setupToken, 'enroll', false);
    const user = this.one('SELECT * FROM users WHERE id = ?', p.user_id);
    if (!user || user.disabled) throw new AuthError(400, 'This step expired. Please start again.');
    const co = this.one('SELECT * FROM companies WHERE id = ?', user.company_id);
    const ended = this.accessEnded(co);
    if (ended) throw new AuthError(403, ended, { code: 'access_ended', payment: this.paymentInfo() });
    this.cleanup();
    if (co.max_concurrent > 0 && this.seatsInUse(co, user.id) >= co.max_concurrent) {
      throw new AuthError(409, `All ${co.max_concurrent} sign-in seat${co.max_concurrent === 1 ? '' : 's'} for ${co.name} ${co.max_concurrent === 1 ? 'is' : 'are'} in use right now. Try this code again when someone logs out.`, { code: 'seats_full' });
    }
    const secret = await decryptSecret(user.totp_enc, this.env.ENC_KEY);
    const counter = await verifyTotp(secret, code, user.totp_last);
    if (counter === null) throw new AuthError(400, 'That code did not match. Check your authenticator app and try again.', { field: 'code' });
    this.sql.exec('UPDATE users SET totp_enabled = 1, totp_last = ?, failed = 0, locked_until = 0, last_login = ? WHERE id = ?', counter, Date.now(), user.id);
    const recoveryCodes = await this.newRecovery(user.id);
    this.sql.exec('DELETE FROM pending WHERE token_hash = ?', await sha256(setupToken));
    this.sql.exec('DELETE FROM sessions WHERE user_id = ?', user.id);
    const session = await this.createSession(user.id, client);
    this.log('2fa_enrolled', { companyId: user.company_id, userId: user.id, email: user.email, client });
    return { recoveryCodes, user: this.publicUser(user.id), ...session };
  }

  // ---------- Invites (an Admin adds a person; they choose a password and set up 2FA) ----------
  async inviteCheck({ token }) {
    const p = await this.takePending(token, 'invite', false);
    const u = this.one('SELECT u.email, u.name, u.disabled, c.name AS company, c.code, c.active FROM users u JOIN companies c ON c.id = u.company_id WHERE u.id = ?', p.user_id);
    if (!u || u.disabled || !u.active) throw new AuthError(400, 'This invite is no longer valid. Ask your admin for a new one.');
    return { email: u.email, name: u.name, company: { name: u.company, code: u.code } };
  }

  async inviteStart({ token, password, ip }) {
    this.limitIp(ip);
    const p = await this.takePending(token, 'invite', false);
    const u = this.one('SELECT * FROM users WHERE id = ?', p.user_id);
    if (!u || u.disabled) throw new AuthError(400, 'This invite is no longer valid. Ask your admin for a new one.');
    const pw = await hashPassword(password, null, this.iterations);
    this.sql.exec('UPDATE users SET pass_hash = ?, pass_salt = ?, pass_iter = ? WHERE id = ?', pw.hash, pw.salt, pw.iterations, u.id);
    this.sql.exec('DELETE FROM pending WHERE token_hash = ?', await sha256(token));
    this.log('invite_accepted', { companyId: u.company_id, userId: u.id, email: u.email });
    return this.beginEnroll(u);
  }

  // ---------- Login (company code + email + password, then authenticator code) ----------
  async loginPassword({ companyCode, email, password, client }) {
    this.limitIp(client.ip);
    this.cleanup();
    const company = this.companyByCode(companyCode);
    const user = company ? this.one('SELECT * FROM users WHERE company_id = ? AND email = ?', company.id, email) : null;
    // Same answer and similar timing whether the company, the email or the password is wrong.
    if (!user || !user.totp_enabled || !user.pass_hash || user.disabled) {
      await hashPassword(password || 'x', null, this.iterations);
      this.log('login_failed', { companyId: company?.id, userId: user?.id, email,
        detail: !company ? `unknown company code ${String(companyCode).slice(0, 20)}` : !user ? 'unknown email' : user.disabled ? 'disabled' : 'not set up', client });
      throw new AuthError(401, 'Company code, email or password is incorrect.');
    }
    this.checkLock(user);
    const pw = await hashPassword(password, user.pass_salt, user.pass_iter);
    if (!timingSafeEqual(pw.hash, user.pass_hash)) {
      this.recordFailure(user);
      this.log('login_failed', { companyId: company.id, userId: user.id, email, detail: 'wrong password', client });
      throw new AuthError(401, 'Company code, email or password is incorrect.');
    }
    const ended = this.accessEnded(company);
    if (ended) {
      this.log('login_refused', { companyId: company.id, userId: user.id, email, detail: 'company access ended', client });
      throw new AuthError(403, ended, { code: 'access_ended', payment: this.paymentInfo() });
    }
    const token = newToken();
    this.sql.exec('INSERT INTO pending (token_hash, user_id, purpose, expires) VALUES (?,?,?,?)',
      await sha256(token), user.id, 'login', Date.now() + 5 * MIN);
    return { loginToken: token, company: { code: company.code, name: company.name } };
  }

  async loginVerify({ loginToken, code, recoveryCode, endOther, client }) {
    const p = await this.takePending(loginToken, 'login', true);
    const user = this.one('SELECT * FROM users WHERE id = ?', p.user_id);
    if (!user || user.disabled) throw new AuthError(401, 'Login expired. Please start again.');
    this.checkLock(user);

    if (!p.passed) {
      try {
        await this.verifySecondFactor(user, { code, recoveryCode });
      } catch (e) {
        this.log('login_failed', { companyId: user.company_id, userId: user.id, email: user.email, detail: 'wrong 2FA code', client });
        throw e;
      }
      if (recoveryCode) this.log('recovery_code_used', { companyId: user.company_id, userId: user.id, email: user.email, client });
      this.sql.exec('UPDATE pending SET passed = 1 WHERE token_hash = ?', await sha256(loginToken));
    }

    const c = this.one('SELECT * FROM companies WHERE id = ?', user.company_id);
    const ended = this.accessEnded(c);
    if (ended) throw new AuthError(403, ended, { code: 'access_ended', payment: this.paymentInfo() });
    // Seats: how many people of this company may be signed in at the same time.
    this.cleanup();
    if (c.max_concurrent > 0 && this.seatsInUse(c, user.id) >= c.max_concurrent) {
      this.log('login_refused', { companyId: c.id, userId: user.id, email: user.email, detail: `all ${c.max_concurrent} seats in use`, client });
      throw new AuthError(409, `All ${c.max_concurrent} sign-in seat${c.max_concurrent === 1 ? '' : 's'} for ${c.name} ${c.max_concurrent === 1 ? 'is' : 'are'} in use right now. Try again when someone logs out, or ask your Admin to sign someone out.`, { code: 'seats_full' });
    }
    // One active session per login.
    const active = this.one('SELECT * FROM sessions WHERE user_id = ? AND last_active > ? ORDER BY last_active DESC LIMIT 1', user.id, Date.now() - this.idleFor(c));
    if (active && !endOther) {
      throw new AuthError(409, 'This login is already in use on another device.', {
        active: { device: active.ua, place: active.place, lastActive: active.last_active },
      });
    }
    let endedOther = null;
    if (active) {
      endedOther = { device: active.ua, place: active.place };
      this.sql.exec('DELETE FROM sessions WHERE user_id = ?', user.id);
    }
    this.sql.exec('UPDATE users SET failed = 0, locked_until = 0, last_login = ? WHERE id = ?', Date.now(), user.id);
    this.sql.exec('DELETE FROM pending WHERE token_hash = ?', await sha256(loginToken));
    const session = await this.createSession(user.id, client);
    this.log('login', { companyId: user.company_id, userId: user.id, email: user.email, client, detail: endedOther ? 'ended other session' : null });
    return { ...session, user: this.publicUser(user.id), endedOther };
  }

  // ---------- Second factor check shared by login, reset and change password ----------
  async verifySecondFactor(user, { code, recoveryCode }) {
    if (recoveryCode) {
      const hashes = JSON.parse(user.recovery);
      const h = await sha256(String(recoveryCode).trim().toUpperCase());
      const idx = hashes.findIndex((x) => timingSafeEqual(x, h));
      if (idx < 0) {
        this.recordFailure(user);
        throw new AuthError(401, 'That recovery code is not valid or was already used.', { field: 'code' });
      }
      hashes.splice(idx, 1);
      this.sql.exec(`UPDATE ${user._t || 'users'} SET recovery = ? WHERE id = ?`, JSON.stringify(hashes), user.id);
      return;
    }
    const secret = await decryptSecret(user.totp_enc, this.env.ENC_KEY);
    const counter = await verifyTotp(secret, code, user.totp_last);
    if (counter === null) {
      this.recordFailure(user);
      throw new AuthError(401, 'That code did not match. Use the latest 6-digit code from your authenticator app.', { field: 'code' });
    }
    this.sql.exec(`UPDATE ${user._t || 'users'} SET totp_last = ? WHERE id = ?`, counter, user.id);
  }

  async setPassword(userId, password) {
    const pw = await hashPassword(password, null, this.iterations);
    this.sql.exec('UPDATE users SET pass_hash = ?, pass_salt = ?, pass_iter = ?, failed = 0, locked_until = 0 WHERE id = ?',
      pw.hash, pw.salt, pw.iterations, userId);
    this.sql.exec("DELETE FROM pending WHERE user_id = ? AND purpose IN ('reset', 'login')", userId);
  }

  // ---------- Forgot password ----------
  // Returns what is needed to email a reset link, or null. The Worker answers the browser
  // the same way either way, so nobody can learn which logins exist.
  async forgotStart({ companyCode, email, ip }) {
    this.limitIp(ip);
    this.cleanup();
    const company = this.companyByCode(companyCode);
    if (!company) return null;
    const user = this.one('SELECT id, email, name, totp_enabled, disabled, company_id FROM users WHERE company_id = ? AND email = ?', company.id, email);
    // Skips are logged for the company's Admins (Users & security), never told to the person asking.
    const skip = (why) => { if (user) this.log('reset_skipped', { companyId: company.id, userId: user.id, email: user.email, detail: why, client: { ip } }); return null; };
    if (!user) return null;
    if (user.disabled) return skip('login is disabled');
    if (!user.totp_enabled) return skip('login not finished: two-step setup was never completed (send a new invite instead)');
    const recent = this.all("SELECT expires FROM pending WHERE user_id = ? AND purpose = 'reset'", user.id);
    if (recent.some((r) => r.expires - RESET_MINUTES * MIN > Date.now() - 2 * MIN)) return skip('asked again within 2 minutes; the earlier email is still valid');
    if (recent.length >= 5) return skip(`5 reset links already sent in the last ${RESET_MINUTES} minutes; wait, or use the newest email`);
    const token = newToken();
    this.sql.exec('INSERT INTO pending (token_hash, user_id, purpose, expires) VALUES (?,?,?,?)',
      await sha256(token), user.id, 'reset', Date.now() + RESET_MINUTES * MIN);
    this.log('reset_requested', { companyId: company.id, userId: user.id, email: user.email });
    return { email: user.email, name: user.name, token, minutes: RESET_MINUTES, company: company.name, companyId: company.id, userId: user.id };
  }

  // Outcome of an email the Worker tried to send for a login (reset, invite…), for the Admin's log.
  mailResult({ companyId, userId, email, kind, ok, error }) {
    this.log(ok ? `${kind}_email_sent` : 'email_failed', { companyId, userId, email, detail: ok ? null : `${kind}: ${String(error || '').slice(0, 400)}` });
    return { ok: true };
  }

  async resetCheck({ token }) {
    const p = await this.takePending(token, 'reset', false);
    const u = this.one('SELECT u.email, c.name AS company, c.code FROM users u JOIN companies c ON c.id = u.company_id WHERE u.id = ?', p.user_id);
    if (!u) throw new AuthError(400, 'This reset link is no longer valid. Ask for a new one.');
    const [name, domain] = u.email.split('@');
    return { email: `${name.slice(0, 2)}${'•'.repeat(Math.max(1, name.length - 2))}@${domain}`, company: { name: u.company, code: u.code }, expires: p.expires };
  }

  async resetFinish({ token, password, code, recoveryCode, client }) {
    const p = await this.takePending(token, 'reset', false);
    const user = this.one('SELECT * FROM users WHERE id = ?', p.user_id);
    if (!user || user.disabled) throw new AuthError(400, 'This reset link is no longer valid. Ask for a new one.');
    this.checkLock(user);
    // An emailed link alone is not enough: the second factor is still required.
    await this.verifySecondFactor(user, { code, recoveryCode });
    await this.setPassword(user.id, password);
    this.sql.exec('DELETE FROM sessions WHERE user_id = ?', user.id);
    this.log('password_reset', { companyId: user.company_id, userId: user.id, email: user.email, client });
    return { email: user.email, name: user.name };
  }

  // ---------- Change password / recovery codes while signed in ----------
  async changePassword({ userId, sessionId, current, password, code, client }) {
    const user = this.one('SELECT * FROM users WHERE id = ?', userId);
    if (!user) throw new AuthError(401, 'Your session ended. Please log in again.');
    this.checkLock(user);
    const pw = await hashPassword(current || '', user.pass_salt, user.pass_iter);
    if (!timingSafeEqual(pw.hash, user.pass_hash)) {
      this.recordFailure(user);
      throw new AuthError(401, 'Current password is incorrect.', { field: 'current' });
    }
    await this.verifySecondFactor(user, { code });
    const same = await hashPassword(password, user.pass_salt, user.pass_iter);
    if (timingSafeEqual(same.hash, user.pass_hash)) throw new AuthError(422, 'Choose a password different from the current one.', { field: 'password' });
    await this.setPassword(user.id, password);
    this.sql.exec('DELETE FROM sessions WHERE user_id = ? AND id != ?', user.id, sessionId);
    this.log('password_changed', { companyId: user.company_id, userId: user.id, email: user.email, client });
    return { email: user.email, name: user.name };
  }

  async newRecoveryCodes({ userId, code }) {
    const user = this.one('SELECT * FROM users WHERE id = ?', userId);
    if (!user) throw new AuthError(401, 'Your session ended. Please log in again.');
    this.checkLock(user);
    await this.verifySecondFactor(user, { code });
    const recoveryCodes = await this.newRecovery(user.id);
    this.log('recovery_codes_renewed', { companyId: user.company_id, userId: user.id, email: user.email });
    return { recoveryCodes };
  }

  async takePending(token, purpose, allowPassed) {
    if (!token) throw new AuthError(400, 'Missing token. Please start again.');
    const p = this.one('SELECT * FROM pending WHERE token_hash = ? AND purpose = ?', await sha256(token), purpose);
    if (!p || p.expires < Date.now()) {
      const msg = {
        reset: 'This reset link has expired or was already used. Ask for a new one.',
        invite: 'This invite link has expired or was already used. Ask your admin for a new one.',
        c_invite: 'This console invite has expired or was already used. Ask another operator for a new one.',
      }[purpose] || 'This step expired. Please start again.';
      throw new AuthError(400, msg);
    }
    if (p.passed && !allowPassed) throw new AuthError(400, 'This step was already used.');
    return p;
  }

  checkLock(user) {
    const fresh = this.one(`SELECT locked_until FROM ${user._t || 'users'} WHERE id = ?`, user.id);
    if (fresh && fresh.locked_until > Date.now()) {
      const mins = Math.ceil((fresh.locked_until - Date.now()) / MIN);
      throw new AuthError(423, `Too many wrong attempts. Login locked for ${mins} more minute${mins === 1 ? '' : 's'}.`);
    }
  }
  recordFailure(user) {
    const t = user._t || 'users';
    const failed = (this.one(`SELECT failed FROM ${t} WHERE id = ?`, user.id)?.failed || 0) + 1;
    const lock = failed >= LOCK_AFTER ? Date.now() + LOCK_MINUTES * MIN : 0;
    this.sql.exec(`UPDATE ${t} SET failed = ?, locked_until = ? WHERE id = ?`, lock ? 0 : failed, lock, user.id);
    if (lock) this.log('login_locked', { companyId: user.company_id, userId: user.id, email: user.email });
  }

  // ---------- Sessions ----------
  async createSession(userId, client = {}) {
    const token = newToken();
    const now = Date.now();
    this.sql.exec(
      'INSERT INTO sessions (id, user_id, token_hash, created_at, last_active, rotated_at, ua, ip, place) VALUES (?,?,?,?,?,?,?,?,?)',
      uuid(), userId, await sha256(token), now, now, now, (client.ua || '').slice(0, 200), client.ip || '', client.place || '',
    );
    return { token };
  }

  // Called on every API request. Returns who is calling and, when rotated, a new token.
  async touch({ token }) {
    if (!token) return null;
    const h = await sha256(token);
    const now = Date.now();
    let s = this.one('SELECT * FROM sessions WHERE token_hash = ?', h);
    let viaOld = false;
    if (!s) {
      s = this.one('SELECT * FROM sessions WHERE prev_hash = ? AND prev_until > ?', h, now);
      viaOld = !!s;
    }
    if (!s) return null;
    const u = this.one(
      `SELECT u.id, u.email, u.name, u.role, u.dup_override, u.is_owner, u.disabled, c.id AS company_id, c.name AS company_name,
              c.code AS company_code, c.ticket_prefix, c.active, c.valid_until, c.idle_minutes, c.modules, c.plan, c.extended_at, c.advance_amount, c.trial_started
       FROM users u JOIN companies c ON c.id = u.company_id WHERE u.id = ?`, s.user_id);
    const idle = this.idleFor(u);
    if (!u || u.disabled || !u.active || this.expired(u) || now - s.last_active > idle || now - s.created_at > this.maxMs) {
      this.sql.exec('DELETE FROM sessions WHERE id = ?', s.id);
      return null;
    }
    let newTok = null;
    if (!viaOld && now - s.rotated_at > ROTATE_EVERY) {
      newTok = newToken();
      this.sql.exec('UPDATE sessions SET prev_hash = token_hash, prev_until = ?, token_hash = ?, rotated_at = ?, last_active = ? WHERE id = ?',
        now + OLD_TOKEN_GRACE, await sha256(newTok), now, now, s.id);
    } else {
      this.sql.exec('UPDATE sessions SET last_active = ? WHERE id = ?', now, s.id);
    }
    return {
      sessionId: s.id, userId: u.id, email: u.email, name: u.name, isOwner: !!u.is_owner,
      companyId: u.company_id, companyName: u.company_name, companyCode: u.company_code, ticketPrefix: u.ticket_prefix,
      role: u.role, dupOverride: !!u.dup_override || u.role === 'Admin', modules: this.modulesOf(u),
      newToken: newTok, expiresIn: idle, idleMinutes: idle / MIN,
      plan: u.plan || 'paid', access: this.access(u), trialStarted: u.trial_started || null,
    };
  }

  async logout({ token }) {
    if (!token) return;
    const h = await sha256(token);
    const s = this.one('SELECT s.user_id, u.company_id, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? OR s.prev_hash = ?', h, h);
    this.sql.exec('DELETE FROM sessions WHERE token_hash = ? OR prev_hash = ?', h, h);
    if (s) this.log('logout', { companyId: s.company_id, userId: s.user_id, email: s.email });
  }

  publicUser(arg) {
    const userId = typeof arg === 'string' ? arg : arg.userId;
    const u = this.one(
      `SELECT u.id, u.email, u.name, u.role, u.dup_override, u.is_owner, u.recovery, c.id AS cid, c.name AS cname, c.code, c.ticket_prefix,
              c.modules, c.idle_minutes, c.valid_until, c.plan, c.extended_at, c.advance_amount
       FROM users u JOIN companies c ON c.id = u.company_id WHERE u.id = ?`, userId);
    if (!u) return null;
    return {
      id: u.id, email: u.email, name: u.name, role: u.role, isOwner: !!u.is_owner,
      dupOverride: !!u.dup_override || u.role === 'Admin',
      company: { id: u.cid, name: u.cname, code: u.code, ticketPrefix: u.ticket_prefix, modules: this.modulesOf(u), validUntil: u.valid_until,
        billing: { ...this.accessInfo(u), payment: this.paymentInfo() } },
      idleMinutes: this.idleFor(u) / MIN,
      recoveryLeft: JSON.parse(u.recovery).length,
    };
  }

  // ---------- Admin: logins in their own company ----------
  requireAdmin(actor) {
    if (actor.role !== 'Admin') throw new AuthError(403, 'Only an Admin can manage users.');
  }

  listUsers({ actor }) {
    this.requireAdmin(actor);
    const now = Date.now();
    const rows = this.all(
      `SELECT id, email, name, role, dup_override, is_owner, disabled, totp_enabled, last_login, created_at, locked_until
       FROM users WHERE company_id = ? ORDER BY disabled, name COLLATE NOCASE`, actor.companyId);
    const invites = new Set(this.all("SELECT user_id FROM pending WHERE purpose = 'invite' AND expires > ?", now).map((r) => r.user_id));
    const c = this.one('SELECT * FROM companies WHERE id = ?', actor.companyId);
    const online = new Set(this.all('SELECT user_id FROM sessions WHERE last_active > ?', now - this.idleFor(c)).map((r) => r.user_id));
    return rows.map((r) => ({
      id: r.id, email: r.email, name: r.name, role: r.role, isOwner: !!r.is_owner, disabled: !!r.disabled,
      dupOverride: !!r.dup_override, lastLogin: r.last_login, createdAt: r.created_at,
      status: r.disabled ? 'Disabled' : r.totp_enabled ? (r.locked_until > now ? 'Locked' : 'Active') : invites.has(r.id) ? 'Invited' : 'Invite expired',
      online: online.has(r.id), you: r.id === actor.userId,
    }));
  }

  adminCount(companyId, exceptUserId) {
    return this.one("SELECT COUNT(*) AS n FROM users WHERE company_id = ? AND role = 'Admin' AND disabled = 0 AND id != ?", companyId, exceptUserId).n;
  }

  async makeInvite(userId) {
    this.sql.exec("DELETE FROM pending WHERE user_id = ? AND purpose = 'invite'", userId);
    const token = newToken();
    this.sql.exec('INSERT INTO pending (token_hash, user_id, purpose, expires) VALUES (?,?,?,?)',
      await sha256(token), userId, 'invite', Date.now() + INVITE_DAYS * DAY);
    return { token, days: INVITE_DAYS };
  }

  async inviteUser({ actor, name, email, role, dupOverride }) {
    this.requireAdmin(actor);
    if (!ROLES.includes(role)) throw new AuthError(422, 'Choose a role', { field: 'role' });
    if (this.one('SELECT 1 AS x FROM users WHERE company_id = ? AND email = ?', actor.companyId, email)) {
      throw new AuthError(409, 'This email already has a login in this company.', { field: 'email' });
    }
    const c = this.one('SELECT * FROM companies WHERE id = ?', actor.companyId);
    if (!this.domainOk(c, email)) throw new AuthError(422, `Logins for ${c.name} must use an email at: ${this.domains(c).join(', ')}`, { field: 'email' });
    this.checkUserLimit(c);
    const id = uuid();
    this.sql.exec('INSERT INTO users (id, company_id, email, name, role, dup_override, created_at, created_by) VALUES (?,?,?,?,?,?,?,?)',
      id, actor.companyId, email, name, role, dupOverride ? 1 : 0, Date.now(), actor.userId);
    const inv = await this.makeInvite(id);
    this.log('user_invited', { companyId: actor.companyId, userId: id, email, detail: `${role} by ${actor.email}` });
    return { invite: inv, user: { id, email, name } };
  }

  userIn(actor, userId) {
    const row = this.one('SELECT * FROM users WHERE id = ? AND company_id = ?', userId, actor.companyId);
    if (!row) throw new AuthError(404, 'User not found in this company.');
    return row;
  }

  updateUser({ actor, userId, role, dupOverride, disabled, name }) {
    this.requireAdmin(actor);
    const u = this.userIn(actor, userId);
    const losingAdmin = u.role === 'Admin' && ((role && role !== 'Admin') || disabled === true);
    if (userId === actor.userId && (disabled === true || (role && role !== 'Admin'))) {
      throw new AuthError(422, 'You cannot remove your own Admin access or disable yourself.');
    }
    if (losingAdmin && this.adminCount(actor.companyId, u.id) === 0) {
      throw new AuthError(422, 'A company needs at least one active Admin. Make someone else Admin first.');
    }
    if (u.is_owner && disabled === true) throw new AuthError(422, 'The owner login cannot be disabled.');
    const changes = [];
    if (role && role !== u.role) {
      if (!ROLES.includes(role)) throw new AuthError(422, 'Unknown role');
      this.sql.exec('UPDATE users SET role = ? WHERE id = ?', role, userId);
      changes.push(`role ${u.role} → ${role}`);
    }
    if (typeof dupOverride === 'boolean' && dupOverride !== !!u.dup_override) {
      this.sql.exec('UPDATE users SET dup_override = ? WHERE id = ?', dupOverride ? 1 : 0, userId);
      changes.push(`duplicate override ${dupOverride ? 'on' : 'off'}`);
    }
    if (typeof disabled === 'boolean' && disabled !== !!u.disabled) {
      if (!disabled) this.checkUserLimit(this.one('SELECT * FROM companies WHERE id = ?', actor.companyId));
      this.sql.exec('UPDATE users SET disabled = ? WHERE id = ?', disabled ? 1 : 0, userId);
      if (disabled) {
        this.sql.exec('DELETE FROM sessions WHERE user_id = ?', userId);
        this.sql.exec('DELETE FROM pending WHERE user_id = ?', userId);
      }
      changes.push(disabled ? 'disabled' : 'enabled');
    }
    if (name && name !== u.name) {
      this.sql.exec('UPDATE users SET name = ? WHERE id = ?', name, userId);
      changes.push('name changed');
    }
    if (changes.length) this.log('user_updated', { companyId: actor.companyId, userId, email: u.email, detail: `${changes.join(', ')} by ${actor.email}` });
    return { ok: true };
  }

  async resendInvite({ actor, userId }) {
    this.requireAdmin(actor);
    const u = this.userIn(actor, userId);
    if (u.totp_enabled) throw new AuthError(422, 'This person has already set up their login. Use "Reset login" instead.');
    if (u.disabled) throw new AuthError(422, 'Enable this user first.');
    const inv = await this.makeInvite(userId);
    this.log('invite_resent', { companyId: actor.companyId, userId, email: u.email, detail: `by ${actor.email}` });
    return { invite: inv, user: { id: u.id, email: u.email, name: u.name } };
  }

  // Lost phone and no recovery codes: clears password and 2FA, signs out, issues a new invite link.
  async resetSignIn({ actor, userId }) {
    this.requireAdmin(actor);
    const u = this.userIn(actor, userId);
    if (u.id === actor.userId) throw new AuthError(422, 'Use your profile to change your own password or recovery codes.');
    if (u.disabled) throw new AuthError(422, 'Enable this user first.');
    this.sql.exec("UPDATE users SET pass_hash = '', pass_salt = '', pass_iter = 0, totp_enc = NULL, totp_enabled = 0, totp_last = -1, recovery = '[]', failed = 0, locked_until = 0 WHERE id = ?", userId);
    this.sql.exec('DELETE FROM sessions WHERE user_id = ?', userId);
    this.sql.exec('DELETE FROM pending WHERE user_id = ?', userId);
    const inv = await this.makeInvite(userId);
    this.log('login_reset', { companyId: actor.companyId, userId, email: u.email, detail: `by ${actor.email}` });
    return { invite: inv, user: { id: u.id, email: u.email, name: u.name } };
  }

  removeUser({ actor, userId }) {
    this.requireAdmin(actor);
    const u = this.userIn(actor, userId);
    if (userId === actor.userId) throw new AuthError(422, 'You cannot remove yourself.');
    if (u.is_owner) throw new AuthError(422, 'The owner login cannot be removed.');
    if (u.role === 'Admin' && this.adminCount(actor.companyId, u.id) === 0) throw new AuthError(422, 'A company needs at least one active Admin.');
    this.sql.exec('DELETE FROM sessions WHERE user_id = ?', userId);
    this.sql.exec('DELETE FROM pending WHERE user_id = ?', userId);
    this.sql.exec('DELETE FROM users WHERE id = ?', userId);
    this.log('user_removed', { companyId: actor.companyId, userId, email: u.email, detail: `by ${actor.email}` });
    return { ok: true };
  }

  listSessions({ actor }) {
    this.requireAdmin(actor);
    this.cleanup();
    return this.all(
      `SELECT s.id, s.created_at, s.last_active, s.ua, s.ip, s.place, u.name, u.email, u.role
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.company_id = ? AND s.last_active > ? ORDER BY s.last_active DESC`,
      actor.companyId, Date.now() - this.idleFor(this.one('SELECT * FROM companies WHERE id = ?', actor.companyId)))
      .map((s) => ({ ...s, current: s.id === actor.sessionId }));
  }

  endSession({ actor, id }) {
    this.requireAdmin(actor);
    const s = this.one('SELECT s.id, s.user_id, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND u.company_id = ?', id, actor.companyId);
    if (!s) throw new AuthError(404, 'Session not found.');
    if (s.id === actor.sessionId) throw new AuthError(422, 'Use Log out to end your own session.');
    this.sql.exec('DELETE FROM sessions WHERE id = ?', id);
    this.log('session_ended_by_admin', { companyId: actor.companyId, userId: s.user_id, email: s.email, detail: `by ${actor.email}` });
    return { ok: true };
  }

  authLog({ actor, limit = 300 }) {
    this.requireAdmin(actor);
    return this.all('SELECT at, event, email, detail, ip, ua FROM auth_log WHERE company_id = ? ORDER BY at DESC LIMIT ?',
      actor.companyId, Math.min(Number(limit) || 300, 1000));
  }

  // ---------- Companies (created and limited from the console; an Admin can rename their own) ----------
  updateCompany({ actor, name, ticketPrefix }) {
    this.requireAdmin(actor);
    if (this.one('SELECT 1 AS x FROM companies WHERE name = ? AND id != ?', name, actor.companyId)) {
      throw new AuthError(409, 'Another company already uses this name.', { field: 'name' });
    }
    this.sql.exec('UPDATE companies SET name = ?, ticket_prefix = ? WHERE id = ?', name, ticketPrefix, actor.companyId);
    this.log('company_updated', { companyId: actor.companyId, userId: actor.userId, email: actor.email, detail: `${name} / prefix ${ticketPrefix}` });
    return { ok: true };
  }

  // For the daily reminder job: each active company and its Admins / Managers.
  reminderRecipients() {
    const rows = this.all(`
      SELECT c.id AS company_id, c.name AS company_name, c.code, c.ticket_prefix, u.email, u.name, u.role
      FROM companies c JOIN users u ON u.company_id = c.id
      WHERE c.active = 1 AND u.disabled = 0 AND u.totp_enabled = 1 AND u.role IN ('Admin', 'Manager')`);
    const by = new Map();
    for (const r of rows) {
      if (!by.has(r.company_id)) by.set(r.company_id, { companyId: r.company_id, name: r.company_name, code: r.code, ticketPrefix: r.ticket_prefix, people: [] });
      by.get(r.company_id).people.push({ email: r.email, name: r.name, role: r.role });
    }
    return [...by.values()];
  }

  appUrl() {
    return this.one("SELECT value FROM meta WHERE key = 'app_url'")?.value || null;
  }

  // ---------- Migration key (moving data from the old Windows RMA System) ----------
  // An Admin creates a key; the PowerShell migration tool sends it as a Bearer token. Valid 48 hours, revocable.
  async migrateKeyCreate({ actor }) {
    this.requireAdmin(actor);
    this.sql.exec("DELETE FROM pending WHERE purpose = 'migrate' AND user_id IN (SELECT id FROM users WHERE company_id = ?)", actor.companyId);
    const token = `rmk_${newToken(32)}`;
    const expires = Date.now() + 2 * DAY;
    this.sql.exec('INSERT INTO pending (token_hash, user_id, purpose, expires) VALUES (?,?,?,?)', await sha256(token), actor.userId, 'migrate', expires);
    this.log('migration_key_created', { companyId: actor.companyId, userId: actor.userId, email: actor.email });
    return { key: token, expires };
  }
  migrateKeyStatus({ actor }) {
    this.requireAdmin(actor);
    const p = this.one(`SELECT p.expires, u.name FROM pending p JOIN users u ON u.id = p.user_id
      WHERE p.purpose = 'migrate' AND u.company_id = ? AND p.expires > ?`, actor.companyId, Date.now());
    return p ? { active: true, expires: p.expires, by: p.name } : { active: false };
  }
  migrateKeyRevoke({ actor }) {
    this.requireAdmin(actor);
    this.sql.exec("DELETE FROM pending WHERE purpose = 'migrate' AND user_id IN (SELECT id FROM users WHERE company_id = ?)", actor.companyId);
    this.log('migration_key_revoked', { companyId: actor.companyId, userId: actor.userId, email: actor.email });
    return { ok: true };
  }
  async migrateTouch({ token }) {
    if (!/^rmk_[\w-]{20,}$/.test(String(token || ''))) return null;
    const p = this.one("SELECT * FROM pending WHERE token_hash = ? AND purpose = 'migrate' AND expires > ?", await sha256(token), Date.now());
    if (!p) return null;
    const u = this.one(`SELECT u.id, u.name, u.email, u.role, u.disabled, c.id AS cid, c.name AS cname, c.code, c.ticket_prefix, c.active, c.valid_until
      FROM users u JOIN companies c ON c.id = u.company_id WHERE u.id = ?`, p.user_id);
    if (!u || u.disabled || u.role !== 'Admin' || !u.active || this.expired({ valid_until: u.valid_until })) return null;
    return { userId: u.id, name: `Migration (${u.name})`, email: u.email, role: 'Admin', companyId: u.cid, companyName: u.cname, companyCode: u.code, ticketPrefix: u.ticket_prefix, expires: p.expires };
  }

  // =====================================================================
  // Console: the service provider's own website. Separate accounts (console_users), separate sessions,
  // mandatory 2FA. Operators create companies, set their limits and rights, and manage their logins.
  // Operators never see a company's RMA or care pack data.
  // =====================================================================
  get cIdleMs() { return Number(this.env.CONSOLE_IDLE_MINUTES || 15) * MIN; }

  cLog(op, action, { companyId = null, detail = null, ip = null } = {}) {
    this.sql.exec('INSERT INTO console_log (at, op_email, action, company_id, detail, ip) VALUES (?,?,?,?,?,?)',
      Date.now(), op?.email || null, action, companyId, detail ? String(detail).slice(0, 1000) : null, ip);
  }
  cOp(id) {
    const op = this.one('SELECT * FROM console_users WHERE id = ?', id);
    return op ? { ...op, _t: 'console_users' } : null;
  }
  cPublic(id) {
    const o = this.one('SELECT id, email, name, recovery, last_login FROM console_users WHERE id = ?', id);
    return o && { id: o.id, email: o.email, name: o.name, recoveryLeft: JSON.parse(o.recovery).length, lastLogin: o.last_login };
  }

  consoleNeedsSetup() {
    return { needsSetup: !this.one('SELECT 1 AS x FROM console_users WHERE totp_enabled = 1 LIMIT 1') };
  }
  async consoleSetupStart({ name, email, password, ip }) {
    this.limitIp(ip);
    if (!this.consoleNeedsSetup().needsSetup) throw new AuthError(409, 'The console is already set up. Log in instead.');
    this.sql.exec('DELETE FROM console_users WHERE totp_enabled = 0');
    const pw = await hashPassword(password, null, this.iterations);
    const id = uuid();
    this.sql.exec('INSERT INTO console_users (id, email, name, pass_hash, pass_salt, pass_iter, created_at) VALUES (?,?,?,?,?,?,?)',
      id, email, name, pw.hash, pw.salt, pw.iterations, Date.now());
    this.cLog({ email }, 'setup', { ip });
    return this.cBeginEnroll(this.cOp(id));
  }
  async cBeginEnroll(op) {
    const secret = newTotpSecret();
    this.sql.exec('UPDATE console_users SET totp_enc = ?, totp_enabled = 0, totp_last = -1 WHERE id = ?', await encryptSecret(secret, this.env.ENC_KEY), op.id);
    const token = newToken();
    this.sql.exec('INSERT INTO pending (token_hash, user_id, purpose, expires) VALUES (?,?,?,?)', await sha256(token), op.id, 'c_enroll', Date.now() + 15 * MIN);
    const issuer = `${this.appName} Console`;
    return { setupToken: token, secret, otpauth: `otpauth://totp/${encodeURIComponent(`${issuer}:${op.email}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30` };
  }
  async consoleEnrollFinish({ setupToken, code, client }) {
    const p = await this.takePending(setupToken, 'c_enroll', false);
    const op = this.cOp(p.user_id);
    if (!op || op.disabled) throw new AuthError(400, 'This step expired. Please start again.');
    const counter = await verifyTotp(await decryptSecret(op.totp_enc, this.env.ENC_KEY), code, op.totp_last);
    if (counter === null) throw new AuthError(400, 'That code did not match. Check your authenticator app and try again.', { field: 'code' });
    this.sql.exec('UPDATE console_users SET totp_enabled = 1, totp_last = ?, failed = 0, locked_until = 0, last_login = ? WHERE id = ?', counter, Date.now(), op.id);
    const recoveryCodes = await this.newRecovery(op.id, 'console_users');
    this.sql.exec('DELETE FROM pending WHERE token_hash = ?', await sha256(setupToken));
    this.sql.exec('DELETE FROM console_sessions WHERE op_id = ?', op.id);
    const token = await this.cCreateSession(op.id, client);
    this.cLog(op, '2fa_enrolled', { ip: client?.ip });
    return { recoveryCodes, op: this.cPublic(op.id), token };
  }
  async cCreateSession(opId, client = {}) {
    const token = newToken();
    const now = Date.now();
    this.sql.exec('INSERT INTO console_sessions (id, op_id, token_hash, created_at, last_active, rotated_at, ua, ip, place) VALUES (?,?,?,?,?,?,?,?,?)',
      uuid(), opId, await sha256(token), now, now, now, (client.ua || '').slice(0, 200), client.ip || '', client.place || '');
    return token;
  }
  async consoleLogin({ email, password, client }) {
    this.limitIp(client.ip);
    this.cleanup();
    const row = this.one('SELECT id FROM console_users WHERE email = ?', email);
    const op = row ? this.cOp(row.id) : null;
    if (!op || !op.totp_enabled || !op.pass_hash || op.disabled) {
      await hashPassword(password || 'x', null, this.iterations);
      this.cLog({ email }, 'login_failed', { detail: op ? 'not active' : 'unknown email', ip: client.ip });
      throw new AuthError(401, 'Email or password is incorrect.');
    }
    this.checkLock(op);
    const pw = await hashPassword(password, op.pass_salt, op.pass_iter);
    if (!timingSafeEqual(pw.hash, op.pass_hash)) {
      this.recordFailure(op);
      this.cLog(op, 'login_failed', { detail: 'wrong password', ip: client.ip });
      throw new AuthError(401, 'Email or password is incorrect.');
    }
    const token = newToken();
    this.sql.exec('INSERT INTO pending (token_hash, user_id, purpose, expires) VALUES (?,?,?,?)', await sha256(token), op.id, 'c_login', Date.now() + 5 * MIN);
    return { loginToken: token };
  }
  async consoleVerify({ loginToken, code, recoveryCode, client }) {
    const p = await this.takePending(loginToken, 'c_login', false);
    const op = this.cOp(p.user_id);
    if (!op || op.disabled) throw new AuthError(401, 'Login expired. Please start again.');
    this.checkLock(op);
    try {
      await this.verifySecondFactor(op, { code, recoveryCode });
    } catch (e) {
      this.cLog(op, 'login_failed', { detail: 'wrong 2FA code', ip: client.ip });
      throw e;
    }
    this.sql.exec('DELETE FROM pending WHERE token_hash = ?', await sha256(loginToken));
    // One console session per operator; a new login ends the old one.
    this.sql.exec('DELETE FROM console_sessions WHERE op_id = ?', op.id);
    this.sql.exec('UPDATE console_users SET failed = 0, locked_until = 0, last_login = ? WHERE id = ?', Date.now(), op.id);
    const token = await this.cCreateSession(op.id, client);
    this.cLog(op, recoveryCode ? 'login (recovery code)' : 'login', { detail: [client.ua, client.place].filter(Boolean).join(', '), ip: client.ip });
    return { token, op: this.cPublic(op.id) };
  }
  async consoleTouch({ token }) {
    if (!token) return null;
    const h = await sha256(token);
    const now = Date.now();
    let s = this.one('SELECT * FROM console_sessions WHERE token_hash = ?', h);
    let viaOld = false;
    if (!s) { s = this.one('SELECT * FROM console_sessions WHERE prev_hash = ? AND prev_until > ?', h, now); viaOld = !!s; }
    if (!s) return null;
    const op = this.cOp(s.op_id);
    if (!op || op.disabled || now - s.last_active > this.cIdleMs || now - s.created_at > this.maxMs) {
      this.sql.exec('DELETE FROM console_sessions WHERE id = ?', s.id);
      return null;
    }
    let newTok = null;
    if (!viaOld && now - s.rotated_at > ROTATE_EVERY) {
      newTok = newToken();
      this.sql.exec('UPDATE console_sessions SET prev_hash = token_hash, prev_until = ?, token_hash = ?, rotated_at = ?, last_active = ? WHERE id = ?',
        now + OLD_TOKEN_GRACE, await sha256(newTok), now, now, s.id);
    } else {
      this.sql.exec('UPDATE console_sessions SET last_active = ? WHERE id = ?', now, s.id);
    }
    return { opId: op.id, email: op.email, name: op.name, sessionId: s.id, newToken: newTok, idleMinutes: this.cIdleMs / MIN };
  }
  async consoleLogout({ token }) {
    if (!token) return;
    const h = await sha256(token);
    const s = this.one('SELECT op_id FROM console_sessions WHERE token_hash = ? OR prev_hash = ?', h, h);
    this.sql.exec('DELETE FROM console_sessions WHERE token_hash = ? OR prev_hash = ?', h, h);
    if (s) this.cLog(this.cOp(s.op_id), 'logout');
  }
  consoleMe({ op }) { return this.cPublic(op.opId); }
  async consoleChangePassword({ op, current, password, code }) {
    const o = this.cOp(op.opId);
    this.checkLock(o);
    const pw = await hashPassword(current || '', o.pass_salt, o.pass_iter);
    if (!timingSafeEqual(pw.hash, o.pass_hash)) { this.recordFailure(o); throw new AuthError(401, 'Current password is incorrect.', { field: 'current' }); }
    await this.verifySecondFactor(o, { code });
    const next = await hashPassword(password, null, this.iterations);
    this.sql.exec('UPDATE console_users SET pass_hash = ?, pass_salt = ?, pass_iter = ?, failed = 0 WHERE id = ?', next.hash, next.salt, next.iterations, o.id);
    this.sql.exec('DELETE FROM console_sessions WHERE op_id = ? AND id != ?', o.id, op.sessionId);
    this.cLog(o, 'password_changed');
    return { email: o.email, name: o.name };
  }
  async consoleRecoveryCodes({ op, code }) {
    const o = this.cOp(op.opId);
    this.checkLock(o);
    await this.verifySecondFactor(o, { code });
    this.cLog(o, 'recovery_codes_renewed');
    return { recoveryCodes: await this.newRecovery(o.id, 'console_users') };
  }

  // ---------- Operators ----------
  consoleOperators() {
    const now = Date.now();
    const invites = new Set(this.all("SELECT user_id FROM pending WHERE purpose = 'c_invite' AND expires > ?", now).map((r) => r.user_id));
    const online = new Set(this.all('SELECT op_id FROM console_sessions WHERE last_active > ?', now - this.cIdleMs).map((r) => r.op_id));
    return this.all('SELECT id, email, name, totp_enabled, disabled, last_login, created_at, created_by, locked_until FROM console_users ORDER BY disabled, name COLLATE NOCASE')
      .map((o) => ({ id: o.id, email: o.email, name: o.name, lastLogin: o.last_login, createdAt: o.created_at, createdBy: o.created_by, online: online.has(o.id),
        status: o.disabled ? 'Disabled' : o.totp_enabled ? (o.locked_until > now ? 'Locked' : 'Active') : invites.has(o.id) ? 'Invited' : 'Invite expired' }));
  }
  async cInvite(id) {
    this.sql.exec("DELETE FROM pending WHERE user_id = ? AND purpose = 'c_invite'", id);
    const token = newToken();
    this.sql.exec('INSERT INTO pending (token_hash, user_id, purpose, expires) VALUES (?,?,?,?)', await sha256(token), id, 'c_invite', Date.now() + 2 * DAY);
    return { token, days: 2 };
  }
  async consoleInviteOperator({ op, name, email }) {
    if (this.one('SELECT 1 AS x FROM console_users WHERE email = ?', email)) throw new AuthError(409, 'This email is already a console operator.', { field: 'email' });
    const id = uuid();
    this.sql.exec('INSERT INTO console_users (id, email, name, created_at, created_by) VALUES (?,?,?,?,?)', id, email, name, Date.now(), op.email);
    this.cLog(op, 'operator_invited', { detail: email });
    return { invite: await this.cInvite(id), user: { id, email, name } };
  }
  async consoleInviteCheck({ token }) {
    const p = await this.takePending(token, 'c_invite', false);
    const o = this.cOp(p.user_id);
    if (!o || o.disabled) throw new AuthError(400, 'This console invite is no longer valid.');
    return { email: o.email, name: o.name };
  }
  async consoleInviteStart({ token, password, ip }) {
    this.limitIp(ip);
    const p = await this.takePending(token, 'c_invite', false);
    const o = this.cOp(p.user_id);
    if (!o || o.disabled) throw new AuthError(400, 'This console invite is no longer valid.');
    const pw = await hashPassword(password, null, this.iterations);
    this.sql.exec('UPDATE console_users SET pass_hash = ?, pass_salt = ?, pass_iter = ? WHERE id = ?', pw.hash, pw.salt, pw.iterations, o.id);
    this.sql.exec('DELETE FROM pending WHERE token_hash = ?', await sha256(token));
    this.cLog(o, 'invite_accepted', { ip });
    return this.cBeginEnroll(o);
  }
  consoleUpdateOperator({ op, id, disabled }) {
    const o = this.cOp(id);
    if (!o) throw new AuthError(404, 'Operator not found.');
    if (id === op.opId) throw new AuthError(422, 'You cannot disable yourself.');
    if (disabled && this.one('SELECT COUNT(*) AS n FROM console_users WHERE disabled = 0 AND totp_enabled = 1 AND id != ?', id).n === 0) {
      throw new AuthError(422, 'At least one active operator is needed.');
    }
    this.sql.exec('UPDATE console_users SET disabled = ? WHERE id = ?', disabled ? 1 : 0, id);
    if (disabled) { this.sql.exec('DELETE FROM console_sessions WHERE op_id = ?', id); this.sql.exec('DELETE FROM pending WHERE user_id = ?', id); }
    this.cLog(op, disabled ? 'operator_disabled' : 'operator_enabled', { detail: o.email });
    return { ok: true };
  }
  async consoleResetOperator({ op, id }) {
    const o = this.cOp(id);
    if (!o) throw new AuthError(404, 'Operator not found.');
    if (id === op.opId) throw new AuthError(422, 'Use your profile to change your own password or recovery codes.');
    this.sql.exec("UPDATE console_users SET pass_hash = '', pass_salt = '', pass_iter = 0, totp_enc = NULL, totp_enabled = 0, totp_last = -1, recovery = '[]', failed = 0, locked_until = 0, disabled = 0 WHERE id = ?", id);
    this.sql.exec('DELETE FROM console_sessions WHERE op_id = ?', id);
    this.cLog(op, 'operator_reset', { detail: o.email });
    return { invite: await this.cInvite(id), user: { id, email: o.email, name: o.name } };
  }
  consoleLogView({ companyId, limit = 500 }) {
    const lim = Math.min(Number(limit) || 500, 2000);
    return companyId
      ? this.all('SELECT * FROM console_log WHERE company_id = ? ORDER BY at DESC LIMIT ?', companyId, lim)
      : this.all('SELECT l.*, c.name AS company FROM console_log l LEFT JOIN companies c ON c.id = l.company_id ORDER BY l.at DESC LIMIT ?', lim);
  }

  // ---------- Companies ----------
  cCompanyOut(c) {
    const now = Date.now();
    return {
      id: c.id, code: c.code, name: c.name, ticketPrefix: c.ticket_prefix, active: !!c.active, createdAt: c.created_at, updatedAt: c.updated_at,
      contactName: c.contact_name || '', contactEmail: c.contact_email || '', contactPhone: c.contact_phone || '', address: c.address || '',
      gstin: c.gstin || '', notes: c.notes || '', maxUsers: c.max_users || 0, maxConcurrent: c.max_concurrent || 0, validUntil: c.valid_until || '',
      modules: this.modulesOf(c), idleMinutes: c.idle_minutes || 0, emailDomains: c.email_domains || '', suspendReason: c.suspend_reason || '',
      expired: this.expired(c), users: this.activeUsers(c.id), online: this.seatsInUse(c),
      adminsReady: this.one("SELECT COUNT(*) AS n FROM users WHERE company_id = ? AND role = 'Admin' AND totp_enabled = 1 AND disabled = 0", c.id).n,
      lastLogin: this.one('SELECT MAX(last_login) AS t FROM users WHERE company_id = ?', c.id).t,
      daysLeft: c.valid_until ? Math.round((Date.parse(`${c.valid_until}T00:00:00Z`) - Date.parse(`${todayIST()}T00:00:00Z`)) / DAY) : null,
      checkedAt: now,
      ...this.accessInfo(c), advanceRef: c.advance_ref || '', paidAt: c.paid_at || null, trialStarted: c.trial_started || null,
      hotLead: c.plan === 'trial' && !!c.import_signal_at, importSignalAt: c.import_signal_at || null, importRows: c.import_rows || 0,
      canPurge: c.plan === 'trial' && !!c.valid_until && todayIST() > addDays(c.valid_until, TRIAL.retainDays),
    };
  }
  consoleCompanies() {
    this.cleanup();
    return { companies: this.all('SELECT * FROM companies ORDER BY name COLLATE NOCASE').map((c) => this.cCompanyOut(c)), modules: MODULES };
  }
  cCompany(id) {
    const c = this.one('SELECT * FROM companies WHERE id = ?', id);
    if (!c) throw new AuthError(404, 'Company not found.');
    return c;
  }
  cActor(op, companyId) {
    return { role: 'Admin', companyId, userId: `console:${op.opId}`, email: `${op.email} (console)`, name: op.name, sessionId: null };
  }
  consoleCompany({ op, id }) {
    const c = this.cCompany(id);
    const actor = this.cActor(op, id);
    return {
      company: this.cCompanyOut(c), modules: MODULES, roles: ROLES,
      users: this.listUsers({ actor }), sessions: this.listSessions({ actor }),
      log: this.authLog({ actor, limit: 200 }), consoleLog: this.consoleLogView({ companyId: id, limit: 100 }),
    };
  }
  cFields(d) {
    const mods = Array.isArray(d.modules) ? MODULES.filter((m) => d.modules.includes(m)) : [...MODULES];
    return {
      contact_name: d.contactName || null, contact_email: d.contactEmail || null, contact_phone: d.contactPhone || null, address: d.address || null,
      gstin: d.gstin || null, notes: d.notes || null, max_users: Number(d.maxUsers) || 0, max_concurrent: Number(d.maxConcurrent) || 0,
      valid_until: d.validUntil || null, modules: JSON.stringify(mods), idle_minutes: Number(d.idleMinutes) || 0, email_domains: d.emailDomains || null,
    };
  }
  // Self sign-up from the website: a new company on the 30-day free trial, with the person signing up as
  // its first Admin. They get an invite email (proves the address) to choose a password and set up 2FA.
  freeCode(name) {
    const words = String(name || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
    let base = words.length > 1 ? words.map((w) => w[0]).join('').slice(0, 6) : (words[0] || '').slice(0, 6);
    if (base.length < 2) base = (base + 'CO').slice(0, 2);
    if (!this.one('SELECT 1 AS x FROM companies WHERE code = ?', base)) return base;
    for (let i = 2; i < 1000; i++) {
      const c = `${base.slice(0, 12 - String(i).length)}${i}`;
      if (!this.one('SELECT 1 AS x FROM companies WHERE code = ?', c)) return c;
    }
    throw new AuthError(409, 'Choose a company code.', { field: 'code' });
  }
  async signup({ data, admin, ip }) {
    const now = Date.now();
    const hits = (this.signupHits.get(ip || '-') || []).filter((t) => now - t < 60 * MIN);
    if (hits.length >= 3) throw new AuthError(429, 'Too many sign-ups from this network. Try again in an hour.');
    hits.push(now);
    this.signupHits.set(ip || '-', hits);
    const today = this.one("SELECT COUNT(*) AS n FROM auth_log WHERE event = 'company_signup' AND at > ?", now - DAY).n;
    if (today >= 50) throw new AuthError(429, 'Sign-ups are busy right now. Please try again tomorrow or contact us.');
    if (this.one('SELECT 1 AS x FROM companies WHERE lower(name) = lower(?)', data.name)) {
      throw new AuthError(409, 'A company with this name is already registered. If it is yours, log in or ask its Admin to invite you.', { field: 'companyName' });
    }
    let code = data.code;
    if (code && this.one('SELECT 1 AS x FROM companies WHERE code = ?', code)) throw new AuthError(409, 'This company code is taken. Try another.', { field: 'code' });
    if (!code) code = this.freeCode(data.name);
    const id = uuid();
    const userId = uuid();
    const f = {
      contact_name: admin.name, contact_email: admin.email, contact_phone: data.phone || null, notes: 'Self sign-up from the website',
      plan: 'trial', trial_started: todayIST(), valid_until: addDays(todayIST(), TRIAL.days), modules: JSON.stringify([...MODULES]),
      max_users: TRIAL.users, max_concurrent: 0, idle_minutes: 0,
    };
    this.sql.exec(`INSERT INTO companies (id, code, name, ticket_prefix, active, created_at, updated_at, ${Object.keys(f).join(', ')})
      VALUES (?,?,?,?,1,?,?, ${Object.keys(f).map(() => '?').join(',')})`, id, code, data.name, code.slice(0, 8), now, now, ...Object.values(f));
    this.sql.exec("INSERT INTO users (id, company_id, email, name, role, dup_override, created_at, created_by) VALUES (?,?,?,?, 'Admin', 1, ?, 'signup')",
      userId, id, admin.email, admin.name, now);
    const invite = await this.makeInvite(userId);
    this.log('company_signup', { companyId: id, userId, email: admin.email, detail: `${data.name} (${code}) self sign-up`, client: { ip } });
    this.cLog({ email: admin.email }, 'company_signup', { companyId: id, detail: `${data.name} (${code}): self sign-up, 30-day trial; Admin ${admin.name} <${admin.email}>${data.phone ? `, ${data.phone}` : ''}`, ip });
    return { company: { id, code, name: data.name }, user: { id: userId, email: admin.email, name: admin.name }, invite };
  }
  async consoleCreateCompany({ op, data, admin, ip }) {
    if (this.one('SELECT 1 AS x FROM companies WHERE code = ?', data.code)) throw new AuthError(409, 'Another company already uses this login code.', { field: 'code' });
    if (this.one('SELECT 1 AS x FROM companies WHERE name = ?', data.name)) throw new AuthError(409, 'A company with this name already exists.', { field: 'name' });
    const id = uuid();
    const userId = uuid();
    const now = Date.now();
    const f = this.cFields(data);
    if (data.plan === 'trial') {
      // Free trial: everything switched on, 3 logins, 30 days. No card needed.
      Object.assign(f, { plan: 'trial', trial_started: todayIST(), valid_until: addDays(todayIST(), TRIAL.days), modules: JSON.stringify([...MODULES]),
        max_users: f.max_users && f.max_users < TRIAL.users ? f.max_users : TRIAL.users });
    } else {
      f.plan = 'paid';
    }
    const tmp = { ...f, email_domains: f.email_domains };
    if (!this.domainOk(tmp, admin.email)) throw new AuthError(422, `The first Admin's email must be at: ${this.domains(tmp).join(', ')}`, { field: 'adminEmail' });
    this.sql.exec(`INSERT INTO companies (id, code, name, ticket_prefix, active, created_at, updated_at, ${Object.keys(f).join(', ')})
      VALUES (?,?,?,?,1,?,?, ${Object.keys(f).map(() => '?').join(',')})`, id, data.code, data.name, data.ticketPrefix, now, now, ...Object.values(f));
    this.sql.exec("INSERT INTO users (id, company_id, email, name, role, dup_override, created_at, created_by) VALUES (?,?,?,?, 'Admin', 1, ?,?)",
      userId, id, admin.email, admin.name, now, `console:${op.opId}`);
    const invite = await this.makeInvite(userId);
    this.log('company_created', { companyId: id, email: op.email, detail: `${data.name} (${data.code}) by ${op.email} (console)` });
    this.log('user_invited', { companyId: id, userId, email: admin.email, detail: `Admin by ${op.email} (console)` });
    this.cLog(op, 'company_created', { companyId: id, detail: `${data.name} (${data.code}); first Admin ${admin.email}; users ${f.max_users || '∞'}, seats ${f.max_concurrent || '∞'}, until ${f.valid_until || '—'}`, ip });
    return { company: this.cCompanyOut(this.cCompany(id)), invite, user: { id: userId, email: admin.email, name: admin.name } };
  }
  // Deleting a company, step 1: checks it is suspended, the typed code matches and the operator's
  // authenticator code is right. Returns a one-time token (5 minutes) for step 2.
  async consoleDeleteCheck({ op, id, confirmCode, code, tx, ip }) {
    const c = this.one('SELECT * FROM companies WHERE id = ?', id);
    if (!c) throw new AuthError(404, 'Company not found.');
    // Companies with RMAs, batches or care packs are kept, except a trial whose 60-day data period has passed.
    const purge = c.plan === 'trial' && c.valid_until && todayIST() > addDays(c.valid_until, TRIAL.retainDays);
    if (tx?.total && !purge) {
      const parts = [[tx.rmas, 'RMA'], [tx.oemBatches, 'OEM batch'], [tx.carePacks, 'care pack']].filter(([n]) => n).map(([n, w]) => `${n} ${w}${n === 1 ? '' : w.endsWith('h') ? 'es' : 's'}`);
      throw new AuthError(409, `${parts.join(', ')} recorded. A company with transactions cannot be deleted; suspend it instead.`, { code: 'has_transactions', transactions: tx });
    }
    if (c.active && !purge) throw new AuthError(409, 'Suspend the company first. Only a suspended company can be deleted.');
    if (String(confirmCode || '').trim().toUpperCase() !== c.code) throw new AuthError(422, `Type the company code ${c.code} exactly.`, { fields: { confirmCode: `Type the company code ${c.code} exactly` } });
    const me = this.cOp(op.opId);
    if (!me || !me.totp_enabled) throw new AuthError(403, 'Your console login needs two-step setup first.');
    const counter = await verifyTotp(await decryptSecret(me.totp_enc, this.env.ENC_KEY), String(code || ''), me.totp_last);
    if (counter === null) {
      this.cLog(op, 'company_delete_refused', { companyId: id, detail: `${c.name} (${c.code}): wrong authenticator code`, ip });
      throw new AuthError(422, 'That code did not match. Use the current code from your authenticator app.', { fields: { code: 'That code did not match. Use the current code from your authenticator app.' } });
    }
    this.sql.exec('UPDATE console_users SET totp_last = ? WHERE id = ?', counter, me.id);
    this.sql.exec("DELETE FROM pending WHERE purpose = 'c_delete' AND user_id = ?", id);
    const token = newToken();
    this.sql.exec('INSERT INTO pending (token_hash, user_id, purpose, expires) VALUES (?,?,?,?)', await sha256(token), id, 'c_delete', Date.now() + 5 * MIN);
    return { token, company: { id: c.id, name: c.name, code: c.code } };
  }
  // One 15-day extension of a trial, after a 25% advance that is adjusted against the purchase.
  consoleExtendTrial({ op, id, amount, ref, ip }) {
    const c = this.one('SELECT * FROM companies WHERE id = ?', id);
    if (!c) throw new AuthError(404, 'Company not found.');
    if (c.plan !== 'trial') throw new AuthError(409, 'Only a trial can be extended. For a paid company, change "Access until".');
    if (c.extended_at) throw new AuthError(409, 'This trial was already extended once.');
    const amt = Math.round(Number(amount));
    if (!Number.isFinite(amt) || amt <= 0) throw new AuthError(422, 'Enter the advance received (25% of the plan price).', { fields: { amount: 'Enter the amount received' } });
    const from = c.valid_until && c.valid_until > todayIST() ? c.valid_until : todayIST();
    const until = addDays(from, TRIAL.extendDays);
    this.sql.exec('UPDATE companies SET valid_until = ?, extended_at = ?, advance_amount = ?, advance_ref = ?, active = 1, suspend_reason = NULL, updated_at = ? WHERE id = ?',
      until, Date.now(), amt, String(ref || '').trim().slice(0, 120) || null, Date.now(), id);
    this.cLog(op, 'trial_extended', { companyId: id, detail: `${c.name} (${c.code}): +${TRIAL.extendDays} days to ${dmy(until)}; advance ₹${amt.toLocaleString('en-IN')}${ref ? ` (${ref})` : ''} to adjust against purchase`, ip });
    return this.consoleCompany({ op, id });
  }
  // Trial (or lapsed company) has paid: becomes a paid plan with a new access date.
  consoleMarkPaid({ op, id, validUntil, amount, ref, ip }) {
    const c = this.one('SELECT * FROM companies WHERE id = ?', id);
    if (!c) throw new AuthError(404, 'Company not found.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(validUntil || '')) || validUntil <= todayIST()) throw new AuthError(422, 'Choose the date the payment covers access until.', { fields: { validUntil: 'Pick a future date' } });
    this.sql.exec("UPDATE companies SET plan = 'paid', paid_at = ?, valid_until = ?, active = 1, suspend_reason = NULL, updated_at = ? WHERE id = ?", Date.now(), validUntil, Date.now(), id);
    const adv = c.advance_amount ? `; advance ₹${Number(c.advance_amount).toLocaleString('en-IN')} adjusted` : '';
    const amt = Number(amount) > 0 ? `; ₹${Math.round(Number(amount)).toLocaleString('en-IN')} received` : '';
    this.cLog(op, 'company_paid', { companyId: id, detail: `${c.name} (${c.code}): paid until ${dmy(validUntil)}${amt}${ref ? ` (${ref})` : ''}${adv}`, ip });
    return this.consoleCompany({ op, id });
  }
  // Bank / UPI details shown to companies on the trial banner, read-only screen and locked login.
  consolePaymentGet() { return { payment: this.paymentInfo() || {}, trial: TRIAL }; }
  consolePaymentSave({ op, payment, ip }) {
    const keep = ['payeeName', 'bankName', 'accountNo', 'ifsc', 'upiId', 'payLink', 'contactEmail', 'contactPhone', 'priceNote'];
    const clean = Object.fromEntries(keep.map((k) => [k, String(payment?.[k] || '').trim().slice(0, k === 'priceNote' ? 600 : 120)]).filter(([, v]) => v));
    if (clean.ifsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/i.test(clean.ifsc)) throw new AuthError(422, 'IFSC looks wrong (11 characters, e.g. HDFC0001234).', { fields: { ifsc: 'Check the IFSC' } });
    if (clean.payLink && !/^https:\/\//.test(clean.payLink)) throw new AuthError(422, 'Payment link must start with https://', { fields: { payLink: 'Must start with https://' } });
    if (clean.ifsc) clean.ifsc = clean.ifsc.toUpperCase();
    this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('payment_info', ?)", JSON.stringify(clean));
    this.cLog(op, 'payment_details_saved', { detail: Object.keys(clean).join(', '), ip });
    return { payment: clean };
  }
  // A trial company importing its old data is a strong sign it will buy: flag it for the console.
  importSignal({ companyId, rows }) {
    const c = this.one('SELECT id, plan, import_signal_at FROM companies WHERE id = ?', companyId);
    if (!c || c.plan !== 'trial') return { ok: true };
    this.sql.exec('UPDATE companies SET import_signal_at = COALESCE(import_signal_at, ?), import_rows = import_rows + ? WHERE id = ?', Date.now(), Number(rows) || 0, companyId);
    if (!c.import_signal_at) this.log('trial_import', { companyId, detail: `imported ${rows || 0} rows during trial` });
    return { ok: true };
  }
  // Daily: trial / access reminders to the company's Admins (7 and 1 days before, and when read-only starts).
  accessNotices() {
    const today = todayIST();
    const out = [];
    for (const c of this.all("SELECT * FROM companies WHERE active = 1 AND valid_until IS NOT NULL")) {
      let kind = null;
      if (c.valid_until === addDays(today, 7)) kind = 'ends7';
      else if (c.valid_until === addDays(today, 1)) kind = 'ends1';
      else if (addDays(c.valid_until, 1) === today) kind = 'readonly';
      if (!kind) continue;
      const people = this.all("SELECT email, name FROM users WHERE company_id = ? AND role = 'Admin' AND disabled = 0", c.id);
      if (people.length) out.push({ kind, company: { name: c.name, code: c.code }, people, info: this.accessInfo(c) });
    }
    return { notices: out, payment: this.paymentInfo() };
  }

  // Operators normally never see company data, so every download is written to the console log.
  consoleExportLog({ op, id, detail, ip }) {
    const c = this.one('SELECT name, code FROM companies WHERE id = ?', id);
    if (!c) throw new AuthError(404, 'Company not found.');
    this.cLog(op, 'company_data_downloaded', { companyId: id, detail: `${c.name} (${c.code}): ${detail}`, ip });
    return { name: c.name, code: c.code };
  }
  // Step 2, after the company's own database has been wiped: removes its logins, sessions, invites and login history.
  async consoleDeleteFinish({ op, id, token, ip }) {
    const p = await this.takePending(token, 'c_delete', false);
    if (p.user_id !== id) throw new AuthError(400, 'This delete step expired. Please start again.');
    const c = this.one('SELECT * FROM companies WHERE id = ?', id);
    if (!c) throw new AuthError(404, 'Company not found.');
    const users = this.one('SELECT COUNT(*) AS n FROM users WHERE company_id = ?', id).n;
    this.sql.exec('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE company_id = ?)', id);
    this.sql.exec('DELETE FROM pending WHERE user_id IN (SELECT id FROM users WHERE company_id = ?) OR user_id = ?', id, id);
    this.sql.exec('DELETE FROM auth_log WHERE company_id = ?', id);
    this.sql.exec('DELETE FROM users WHERE company_id = ?', id);
    this.sql.exec('DELETE FROM companies WHERE id = ?', id);
    this.cLog(op, 'company_deleted', { companyId: id, detail: `${c.name} (${c.code}) deleted with ${users} login${users === 1 ? '' : 's'} and all its data`, ip });
    return { name: c.name, code: c.code, users };
  }

  consoleUpdateCompany({ op, id, data, ip }) {
    const c = this.cCompany(id);
    if (data.name && this.one('SELECT 1 AS x FROM companies WHERE name = ? AND id != ?', data.name, id)) throw new AuthError(409, 'A company with this name already exists.', { field: 'name' });
    const f = this.cFields(data);
    const active = typeof data.active === 'boolean' ? (data.active ? 1 : 0) : c.active;
    const before = this.cCompanyOut(c);
    this.sql.exec(`UPDATE companies SET name = ?, ticket_prefix = ?, active = ?, suspend_reason = ?, updated_at = ?, ${Object.keys(f).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
      data.name || c.name, data.ticketPrefix || c.ticket_prefix, active, active ? null : (data.suspendReason || c.suspend_reason || null), Date.now(), ...Object.values(f), id);
    const after = this.cCompany(id);
    if (!after.active || this.expired(after)) this.sql.exec('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE company_id = ?)', id);
    const out = this.cCompanyOut(after);
    const changed = ['name', 'ticketPrefix', 'active', 'maxUsers', 'maxConcurrent', 'validUntil', 'idleMinutes', 'emailDomains', 'contactName', 'contactEmail', 'contactPhone', 'address', 'gstin', 'notes']
      .filter((k) => String(before[k]) !== String(out[k])).map((k) => `${k}: ${before[k] === '' ? '—' : before[k]} → ${out[k] === '' ? '—' : out[k]}`);
    if (before.modules.join() !== out.modules.join()) changed.push(`modules: ${before.modules.join(' ') || '—'} → ${out.modules.join(' ') || '—'}`);
    if (changed.length) {
      this.cLog(op, before.active !== out.active ? (out.active ? 'company_activated' : 'company_suspended') : 'company_updated', { companyId: id, detail: changed.join('; '), ip });
      this.log('company_updated', { companyId: id, email: op.email, detail: `by ${op.email} (console): ${changed.join('; ')}`.slice(0, 500) });
    }
    return out;
  }
  consoleSignOutAll({ op, id }) {
    this.cCompany(id);
    const n = this.one('SELECT COUNT(*) AS n FROM sessions WHERE user_id IN (SELECT id FROM users WHERE company_id = ?)', id).n;
    this.sql.exec('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE company_id = ?)', id);
    this.cLog(op, 'signed_out_everyone', { companyId: id, detail: `${n} session(s)` });
    this.log('session_ended_by_admin', { companyId: id, email: op.email, detail: `all sessions, by ${op.email} (console)` });
    return { ended: n };
  }
  // Runs one of the company Admin's user actions on behalf of a console operator, and logs it.
  async consoleAct({ op, companyId, action, args = {} }) {
    const allowed = ['inviteUser', 'updateUser', 'resendInvite', 'resetSignIn', 'removeUser', 'endSession'];
    if (!allowed.includes(action)) throw new AuthError(400, 'Unknown action');
    this.cCompany(companyId);
    const r = await this[action]({ ...args, actor: this.cActor(op, companyId) });
    const who = args.email || (args.userId && this.one('SELECT email FROM users WHERE id = ?', args.userId)?.email) || args.id || '';
    const what = action === 'updateUser' ? Object.entries(args).filter(([k]) => k !== 'userId').map(([k, v]) => `${k}=${v}`).join(', ') : '';
    this.cLog(op, action, { companyId, detail: [who, what].filter(Boolean).join(' · ') });
    return r;
  }
}
