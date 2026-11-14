// Offsite backup (service provider): every night, a copy of every company's data, photos and PDFs goes to
// S3-compatible storage outside this Cloudflare account (Backblaze B2, Amazon S3, Wasabi, or R2 in another account).
//
// Settings (Cloudflare dashboard → Worker → Settings → Variables and Secrets):
//   OFFSITE_ENDPOINT    Text    e.g. https://s3.us-east-005.backblazeb2.com
//   OFFSITE_BUCKET      Text    bucket name
//   OFFSITE_REGION      Text    optional (default "auto"; B2 = the part after "s3." e.g. us-east-005)
//   OFFSITE_KEY_ID      Secret  access key id
//   OFFSITE_SECRET      Secret  secret access key
//   OFFSITE_PASSPHRASE  Secret  optional but recommended: encrypts every object (AES-256-GCM) before upload.
//                               Keep a copy somewhere safe: without it the backup cannot be read.
//
// Layout in the bucket:
//   directory/YYYY-MM-DD.json.gz             companies, users (no passwords / 2FA secrets), payments
//   companies/<id>/data/YYYY-MM-DD.json.gz   every table of one company (same as the Settings backup data.json)
//   companies/<id>/photos/<photoId>          each RMA photo / PDF, uploaded once
//   companies/<id>/files/<fileId>            care pack PDFs, challans, template, logo (uploaded again when replaced)
// Encrypted objects end in ".enc". Daily snapshots: last 30 days + one per month for 12 months.
// Photos and files are never deleted offsite, so something deleted by mistake can still be recovered.
import { AwsClient } from 'aws4fetch';

const MAGIC = new TextEncoder().encode('TMRB1');
const KDF_ITER = 200000;
const IST = 5.5 * 3600e3;
export const istDay = (ms = Date.now()) => new Date(ms + IST).toISOString().slice(0, 10);

export function offsiteConfig(env) {
  const endpoint = String(env.OFFSITE_ENDPOINT || '').replace(/\/+$/, '');
  const bucket = String(env.OFFSITE_BUCKET || '');
  const ready = !!(endpoint && bucket && env.OFFSITE_KEY_ID && env.OFFSITE_SECRET);
  let host = '';
  try { host = endpoint ? new URL(endpoint).host : ''; } catch { /* bad URL */ }
  return { ready: ready && !!host, host, bucket, encrypted: !!env.OFFSITE_PASSPHRASE, target: `${host}/${bucket}` };
}

// ---------- encryption ----------
async function deriveKey(pass, salt) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: KDF_ITER, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
// Format: "TMRB1" | salt (16) | iv (12) | AES-256-GCM ciphertext+tag. One key per run (same salt), new IV per object.
export async function makeSealer(pass) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(pass, salt);
  return async (bytes) => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
    const out = new Uint8Array(MAGIC.length + 28 + ct.length);
    out.set(MAGIC, 0); out.set(salt, 5); out.set(iv, 21); out.set(ct, 33);
    return out;
  };
}
export async function openSealed(pass, bytes, cache = new Map()) {
  const b = new Uint8Array(bytes);
  if (new TextDecoder().decode(b.subarray(0, 5)) !== 'TMRB1') throw new Error('Not an encrypted TrackMyRMA backup file');
  const salt = b.subarray(5, 21);
  const k = [...salt].join(',');
  if (!cache.has(k)) cache.set(k, await deriveKey(pass, salt));
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.subarray(21, 33) }, cache.get(k), b.subarray(33)));
  } catch {
    throw new Error('Cannot decrypt: OFFSITE_PASSPHRASE is wrong (or the file is damaged)');
  }
}

export async function gunzip(bytes) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
}
export async function gzip(text) {
  return new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
}

// Which dated snapshots to delete: keep the last 30 days, plus the earliest snapshot of each of the last 12 months.
export function snapshotsToDelete(dates, today) {
  const age = (d) => (Date.parse(today) - Date.parse(d)) / 86400e3;
  const keep = new Set(dates.filter((d) => age(d) < 30));
  const firstOfMonth = new Map();
  for (const d of [...dates].sort()) if (age(d) <= 366 && !firstOfMonth.has(d.slice(0, 7))) firstOfMonth.set(d.slice(0, 7), d);
  for (const d of firstOfMonth.values()) keep.add(d);
  return dates.filter((d) => !keep.has(d));
}

// ---------- S3 ----------
export class Offsite {
  constructor(env) {
    this.cfg = offsiteConfig(env);
    this.base = `${String(env.OFFSITE_ENDPOINT).replace(/\/+$/, '')}/${encodeURIComponent(this.cfg.bucket)}`;
    this.aws = new AwsClient({ accessKeyId: env.OFFSITE_KEY_ID, secretAccessKey: env.OFFSITE_SECRET, service: 's3', region: env.OFFSITE_REGION || 'auto', retries: 2 });
    this.pass = env.OFFSITE_PASSPHRASE || '';
    this.requests = 0;
    this.bytes = 0;
  }
  url(key) { return `${this.base}/${key.split('/').map(encodeURIComponent).join('/')}`; }
  async fetch(url, init) {
    this.requests++;
    const res = await this.aws.fetch(url, init);
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      const code = t.match(/<Code>([^<]+)<\/Code>/)?.[1];
      const msg = t.match(/<Message>([^<]+)<\/Message>/)?.[1];
      throw new Error(`Storage ${res.status}${code ? ` ${code}` : ''}${msg ? `: ${msg}` : ''}`.slice(0, 200));
    }
    return res;
  }
  async put(key, bytes, contentType) {
    let body = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (this.pass) {
      this.seal ||= await makeSealer(this.pass);
      body = await this.seal(body);
      key += '.enc';
      contentType = 'application/octet-stream';
    }
    await this.fetch(this.url(key), { method: 'PUT', body, headers: { 'Content-Type': contentType || 'application/octet-stream' } });
    this.bytes += body.length;
    return key;
  }
  async list(prefix) {
    const keys = [];
    let token = '';
    do {
      const q = new URLSearchParams({ 'list-type': '2', prefix, 'max-keys': '1000', ...(token ? { 'continuation-token': token } : {}) });
      const xml = await (await this.fetch(`${this.base}?${q}`, { method: 'GET' })).text();
      for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(m[1].replace(/&amp;/g, '&'));
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1] || '' : '';
    } while (token);
    return keys;
  }
  async get(key) {
    const bytes = new Uint8Array(await (await this.fetch(this.url(key), { method: 'GET' })).arrayBuffer());
    return key.endsWith('.enc') ? openSealed(this.pass, bytes, (this.keys ||= new Map())) : bytes;
  }
  async remove(key) { await this.fetch(this.url(key), { method: 'DELETE' }); }
  // Puts today's snapshot under prefix/YYYY-MM-DD.json.gz and thins out the old ones.
  async snapshot(prefix, day, obj) {
    const key = await this.put(`${prefix}${day}.json.gz`, await gzip(JSON.stringify(obj)), 'application/gzip');
    const dated = (await this.list(prefix)).map((k) => [k, k.slice(prefix.length, prefix.length + 10)]).filter(([, d]) => /^\d{4}-\d{2}-\d{2}$/.test(d));
    const drop = new Set(snapshotsToDelete([...new Set(dated.map(([, d]) => d))], day));
    let deleted = 0;
    for (const [k, d] of dated) if (drop.has(d)) { await this.remove(k); deleted++; }
    return { key, deleted };
  }
}
