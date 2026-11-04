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
    `);
  }

  // RPC entry point. Errors come back as plain data because custom error
  // fields do not survive the trip between the Worker and the Durable Object.
  async call(method, args) {
    if (args && args.origin) this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('app_url', ?)", String(args.origin).slice(0, 200));
    const allowed = [
      'appUrl', 'needsSetup', 'setupStart', 'enrollFinish', 'inviteCheck', 'inviteStart',
      'forgotStart', 'resetCheck', 'resetFinish', 'changePassword', 'newRecoveryCodes',
      'loginPassword', 'loginVerify', 'touch', 'logout', 'publicUser',
      'listUsers', 'inviteUser', 'updateUser', 'resendInvite', 'resetSignIn', 'removeUser',
      'listSessions', 'endSession', 'authLog',
      'listCompanies', 'createCompany', 'updateCompany', 'setCompanyActive', 'reminderRecipients',
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
  get appName() { return this.env.APP_NAME || 'RMA Cloud'; }

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
    this.sql.exec('DELETE FROM sessions WHERE last_active < ? OR created_at < ?', now - this.idleMs, now - this.maxMs);
  }

  companyByCode(code) {
    const c = this.one('SELECT * FROM companies WHERE code = ?', String(code || '').trim());
    return c && c.active ? c : null;
  }

  otpauth(user, company) {
    // Shows as e.g. "RMA Cloud (INF): name@x.com" so people with logins in two companies can tell them apart.
    const issuer = `${this.appName} (${company.code})`;
    return `otpauth://totp/${encodeURIComponent(`${issuer}:${user.email}`)}?secret=${'{SECRET}'}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
  }

  async newRecovery(userId) {
    const recovery = Array.from({ length: 10 }, () => newToken(6).replace(/[-_]/g, 'x').slice(0, 8).toUpperCase());
    const hashes = await Promise.all(recovery.map((c) => sha256(c)));
    this.sql.exec('UPDATE users SET recovery = ? WHERE id = ?', JSON.stringify(hashes), userId);
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

    // One active session per login.
    this.cleanup();
    const active = this.one('SELECT * FROM sessions WHERE user_id = ? ORDER BY last_active DESC LIMIT 1', user.id);
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
      this.sql.exec('UPDATE users SET recovery = ? WHERE id = ?', JSON.stringify(hashes), user.id);
      return;
    }
    const secret = await decryptSecret(user.totp_enc, this.env.ENC_KEY);
    const counter = await verifyTotp(secret, code, user.totp_last);
    if (counter === null) {
      this.recordFailure(user);
      throw new AuthError(401, 'That code did not match. Use the latest 6-digit code from your authenticator app.', { field: 'code' });
    }
    this.sql.exec('UPDATE users SET totp_last = ? WHERE id = ?', counter, user.id);
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
    if (!user || !user.totp_enabled || user.disabled) return null;
    const recent = this.all("SELECT expires FROM pending WHERE user_id = ? AND purpose = 'reset'", user.id);
    if (recent.some((r) => r.expires - RESET_MINUTES * MIN > Date.now() - 2 * MIN) || recent.length >= 5) return null;
    const token = newToken();
    this.sql.exec('INSERT INTO pending (token_hash, user_id, purpose, expires) VALUES (?,?,?,?)',
      await sha256(token), user.id, 'reset', Date.now() + RESET_MINUTES * MIN);
    this.log('reset_requested', { companyId: company.id, userId: user.id, email: user.email });
    return { email: user.email, name: user.name, token, minutes: RESET_MINUTES, company: company.name };
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
      }[purpose] || 'This step expired. Please start again.';
      throw new AuthError(400, msg);
    }
    if (p.passed && !allowPassed) throw new AuthError(400, 'This step was already used.');
    return p;
  }

  checkLock(user) {
    const fresh = this.one('SELECT locked_until FROM users WHERE id = ?', user.id);
    if (fresh && fresh.locked_until > Date.now()) {
      const mins = Math.ceil((fresh.locked_until - Date.now()) / MIN);
      throw new AuthError(423, `Too many wrong attempts. Login locked for ${mins} more minute${mins === 1 ? '' : 's'}.`);
    }
  }
  recordFailure(user) {
    const failed = (this.one('SELECT failed FROM users WHERE id = ?', user.id)?.failed || 0) + 1;
    const lock = failed >= LOCK_AFTER ? Date.now() + LOCK_MINUTES * MIN : 0;
    this.sql.exec('UPDATE users SET failed = ?, locked_until = ? WHERE id = ?', lock ? 0 : failed, lock, user.id);
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
    if (now - s.last_active > this.idleMs || now - s.created_at > this.maxMs) {
      this.sql.exec('DELETE FROM sessions WHERE id = ?', s.id);
      return null;
    }
    const u = this.one(
      `SELECT u.id, u.email, u.name, u.role, u.dup_override, u.is_owner, u.disabled, c.id AS company_id, c.name AS company_name,
              c.code AS company_code, c.ticket_prefix, c.active FROM users u JOIN companies c ON c.id = u.company_id WHERE u.id = ?`, s.user_id);
    if (!u || u.disabled || !u.active) {
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
      role: u.role, dupOverride: !!u.dup_override || u.role === 'Admin',
      newToken: newTok, expiresIn: this.idleMs,
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
      `SELECT u.id, u.email, u.name, u.role, u.dup_override, u.is_owner, u.recovery, c.id AS cid, c.name AS cname, c.code, c.ticket_prefix
       FROM users u JOIN companies c ON c.id = u.company_id WHERE u.id = ?`, userId);
    if (!u) return null;
    return {
      id: u.id, email: u.email, name: u.name, role: u.role, isOwner: !!u.is_owner,
      dupOverride: !!u.dup_override || u.role === 'Admin',
      company: { id: u.cid, name: u.cname, code: u.code, ticketPrefix: u.ticket_prefix },
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
    const online = new Set(this.all('SELECT user_id FROM sessions WHERE last_active > ?', now - this.idleMs).map((r) => r.user_id));
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
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.company_id = ? ORDER BY s.last_active DESC`, actor.companyId)
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

  // ---------- Companies ----------
  // The owner (the login created at first setup) can add companies. Each new company
  // gets its own first Admin through an invite; the owner does NOT get access to its data.
  listCompanies({ actor }) {
    if (!actor.isOwner) throw new AuthError(403, 'Only the owner can see all companies.');
    return this.all(`SELECT c.id, c.code, c.name, c.ticket_prefix, c.active, c.created_at,
      (SELECT COUNT(*) FROM users u WHERE u.company_id = c.id AND u.disabled = 0) AS users,
      (SELECT COUNT(*) FROM users u WHERE u.company_id = c.id AND u.role = 'Admin' AND u.totp_enabled = 1) AS admins_ready
      FROM companies c ORDER BY c.name`);
  }

  async createCompany({ actor, name, code, ticketPrefix, adminName, adminEmail }) {
    if (!actor.isOwner) throw new AuthError(403, 'Only the owner can add companies.');
    if (this.one('SELECT 1 AS x FROM companies WHERE code = ?', code)) throw new AuthError(409, 'Another company already uses this code.', { field: 'code' });
    if (this.one('SELECT 1 AS x FROM companies WHERE name = ?', name)) throw new AuthError(409, 'A company with this name already exists.', { field: 'name' });
    const id = uuid();
    const userId = uuid();
    const now = Date.now();
    this.sql.exec('INSERT INTO companies (id, code, name, ticket_prefix, created_at) VALUES (?,?,?,?,?)', id, code, name, ticketPrefix, now);
    this.sql.exec("INSERT INTO users (id, company_id, email, name, role, dup_override, created_at, created_by) VALUES (?,?,?,?, 'Admin', 1, ?,?)",
      userId, id, adminEmail, adminName, now, actor.userId);
    const inv = await this.makeInvite(userId);
    this.log('company_created', { companyId: id, userId: actor.userId, email: actor.email, detail: `${name} (${code}) by ${actor.email}` });
    this.log('user_invited', { companyId: id, userId, email: adminEmail, detail: `Admin by ${actor.email} (owner)` });
    return { company: { id, code, name, ticketPrefix }, invite: inv, user: { id: userId, email: adminEmail, name: adminName } };
  }

  setCompanyActive({ actor, companyId, active }) {
    if (!actor.isOwner) throw new AuthError(403, 'Only the owner can switch companies on or off.');
    if (companyId === actor.companyId && !active) throw new AuthError(422, 'You cannot switch off your own company.');
    this.sql.exec('UPDATE companies SET active = ? WHERE id = ?', active ? 1 : 0, companyId);
    if (!active) this.sql.exec('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE company_id = ?)', companyId);
    this.log(active ? 'company_enabled' : 'company_disabled', { companyId, userId: actor.userId, email: actor.email });
    return { ok: true };
  }

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
}
