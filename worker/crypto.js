// Crypto helpers: password hashing, tokens, TOTP (RFC 6238), AES-GCM for secrets.
const enc = new TextEncoder();

export function b64(buf) {
  let s = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
export function unb64(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
function b64url(buf) {
  return b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}
export function newToken(bytes = 32) {
  return b64url(randomBytes(bytes));
}
export function uuid() {
  return crypto.randomUUID();
}

export async function sha256(text) {
  return b64(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// --- Passwords: PBKDF2-SHA256 with per-user salt ---
export async function hashPassword(password, saltB64, iterations) {
  const salt = saltB64 ? unb64(saltB64) : randomBytes(16);
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return { hash: b64(bits), salt: b64(salt), iterations };
}

// --- AES-GCM for stored secrets (TOTP keys) ---
async function aesKey(keyB64) {
  if (!keyB64) throw new Error('ENC_KEY secret is not set');
  const raw = unb64(keyB64);
  if (raw.length !== 32) throw new Error('ENC_KEY must be 32 bytes, base64-encoded');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function encryptSecret(plain, keyB64) {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(keyB64), enc.encode(plain));
  return b64(iv) + '.' + b64(ct);
}
export async function decryptSecret(blob, keyB64) {
  const [iv, ct] = blob.split('.');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await aesKey(keyB64), unb64(ct));
  return new TextDecoder().decode(pt);
}

// --- TOTP ---
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(bytes) {
  let bits = 0, value = 0, out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  const clean = str.replace(/=+$/, '').toUpperCase();
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}
async function hotp(secretB32, counter) {
  const key = await crypto.subtle.importKey('raw', base32Decode(secretB32), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const msg = new ArrayBuffer(8);
  const view = new DataView(msg);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const off = mac[mac.length - 1] & 15;
  const code = ((mac[off] & 127) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(code % 1_000_000).padStart(6, '0');
}
export function newTotpSecret() {
  return base32Encode(randomBytes(20));
}
// Returns the matched time-step counter (to block replay), or null.
export async function verifyTotp(secretB32, code, lastCounter = -1, now = Date.now()) {
  if (!/^\d{6}$/.test(code || '')) return null;
  const current = Math.floor(now / 1000 / 30);
  for (const drift of [0, -1, 1]) {
    const c = current + drift;
    if (c <= lastCounter) continue;
    if (timingSafeEqual(await hotp(secretB32, c), code)) return c;
  }
  return null;
}
export async function totpNow(secretB32) {
  return hotp(secretB32, Math.floor(Date.now() / 1000 / 30));
}
