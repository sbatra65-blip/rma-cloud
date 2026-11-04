// Server-side validation. Every value from the browser passes through here.
export class ValidationError extends Error {
  constructor(fields) {
    super('Please fix the highlighted fields');
    this.fields = fields; // { fieldName: message }
  }
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[A-Za-z]{2,}$/;
const PHONE = /^[+0-9 ()-]{6,20}$/;
const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function today() {
  // India-time "today" so reminders and statuses match the user's calendar.
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}
// India time now as 'YYYY-MM-DD HH:MM' style parts.
export function istParts(ms = Date.now()) {
  const iso = new Date(ms + 5.5 * 3600 * 1000).toISOString();
  return { date: iso.slice(0, 10), ym: iso.slice(0, 4) + iso.slice(5, 7) };
}
export function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

export class Checker {
  constructor(src) {
    this.src = src && typeof src === 'object' ? src : {};
    this.out = {};
    this.errors = {};
  }
  fail(key, msg) {
    if (!this.errors[key]) this.errors[key] = msg;
  }
  raw(key) {
    const v = this.src[key];
    return v === undefined || v === null ? '' : v;
  }
  text(key, { required = false, max = 200, label = key } = {}) {
    const v = String(this.raw(key)).trim();
    if (!v) {
      if (required) this.fail(key, `${label} is required`);
      this.out[key] = null;
      return this;
    }
    if (v.length > max) this.fail(key, `${label} must be ${max} characters or fewer`);
    this.out[key] = v;
    return this;
  }
  email(key, { required = false, label = 'Email' } = {}) {
    this.text(key, { required, max: 254, label });
    const v = this.out[key];
    if (v && !EMAIL.test(v)) this.fail(key, `${label} is not a valid email address`);
    if (v) this.out[key] = v.toLowerCase();
    return this;
  }
  phone(key, { label = 'Phone' } = {}) {
    this.text(key, { max: 40, label });
    const v = this.out[key];
    if (v && !PHONE.test(v)) this.fail(key, `${label} can contain digits, spaces, +, - and brackets only`);
    return this;
  }
  url(key, { label = 'Link' } = {}) {
    this.text(key, { max: 500, label });
    const v = this.out[key];
    if (v) {
      try {
        const u = new URL(v);
        if (!['https:', 'http:'].includes(u.protocol)) throw new Error();
      } catch {
        this.fail(key, `${label} must start with https://`);
      }
    }
    return this;
  }
  gstin(key) {
    this.text(key, { max: 15, label: 'GSTIN' });
    const v = this.out[key];
    if (v) {
      this.out[key] = v.toUpperCase();
      if (!GSTIN.test(this.out[key])) this.fail(key, 'GSTIN must be 15 characters, e.g. 07AAACX1234Q1Z5');
    }
    return this;
  }
  date(key, { required = false, label = 'Date', notFuture = false } = {}) {
    const v = String(this.raw(key)).trim();
    if (!v) {
      if (required) this.fail(key, `${label} is required`);
      this.out[key] = null;
      return this;
    }
    if (!DATE.test(v) || Number.isNaN(Date.parse(v))) {
      this.fail(key, `${label} is not a valid date`);
    } else if (notFuture && v > today()) {
      this.fail(key, `${label} cannot be in the future`);
    } else if (v < '1980-01-01') {
      this.fail(key, `${label} looks too old`);
    }
    this.out[key] = v;
    return this;
  }
  number(key, { required = false, min = 0, max = 1e10, int = false, label = key } = {}) {
    const rawV = this.raw(key);
    if (rawV === '') {
      if (required) this.fail(key, `${label} is required`);
      this.out[key] = null;
      return this;
    }
    const n = Number(String(rawV).replace(/,/g, ''));
    if (!Number.isFinite(n)) this.fail(key, `${label} must be a number`);
    else if (n < min || n > max) this.fail(key, `${label} must be between ${min} and ${max}`);
    else if (int && !Number.isInteger(n)) this.fail(key, `${label} must be a whole number`);
    this.out[key] = n;
    return this;
  }
  oneOf(key, options, { required = false, label = key } = {}) {
    const v = String(this.raw(key)).trim();
    if (!v) {
      if (required) this.fail(key, `${label} is required`);
      this.out[key] = null;
      return this;
    }
    if (!options.includes(v)) this.fail(key, `${label} has an unknown value`);
    this.out[key] = v;
    return this;
  }
  bool(key) {
    const v = this.raw(key);
    this.out[key] = v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0;
    return this;
  }
  int(key, { required = false, label = key } = {}) {
    const v = String(this.raw(key)).trim();
    if (!v || v === '0') {
      if (required) this.fail(key, `${label} is required`);
      this.out[key] = null;
      return this;
    }
    if (!/^\d{1,12}$/.test(v)) this.fail(key, `${label} is invalid`);
    this.out[key] = Number(v);
    return this;
  }
  id(key, { required = false, label = key } = {}) {
    const v = String(this.raw(key)).trim();
    if (!v) {
      if (required) this.fail(key, `${label} is required`);
      this.out[key] = null;
      return this;
    }
    if (!/^[0-9a-f-]{36}$/.test(v)) this.fail(key, `${label} is invalid`);
    this.out[key] = v;
    return this;
  }
  done() {
    if (Object.keys(this.errors).length) throw new ValidationError(this.errors);
    return this.out;
  }
}

export function checkPassword(pw, email) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Password must be at least 10 characters';
  if (pw.length > 128) return 'Password must be 128 characters or fewer';
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  if (kinds < 3) return 'Use at least three of: lowercase, uppercase, numbers, symbols';
  if (email && pw.toLowerCase().includes(email.split('@')[0].toLowerCase())) return 'Password must not contain your email name';
  if (/^(.)\1+$/.test(pw) || /password|12345|qwerty/i.test(pw)) return 'This password is too easy to guess';
  return null;
}
