// Company data backups.
//  - Admins can download a full backup (data + photos + files) from Settings any time.
//  - A data backup (every table as CSV, plus data.json) is emailed to the Admins on a schedule
//    (weekly by default; Settings > Backups) and, when an R2 bucket is bound as FILES, a copy is kept there.
// Zoho keys and other secrets are never included.
import { strToU8, zipSync } from 'fflate';

export const BACKUP_KEEP = 30; // copies kept in R2 per company

const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  const t = String(v);
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};
export function toCsv(rows) {
  if (!rows.length) return '';
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return '﻿' + [cols.join(','), ...rows.map((r) => cols.map((k) => csvCell(r[k])).join(','))].join('\r\n');
}

export function backupCounts(data) {
  const t = data.tables || {};
  return { rmas: (t.tickets || []).length, customers: (t.customers || []).length, carePacks: (t.cp_batches || t.care_packs || []).length, photos: (data.photos || []).length, rows: Object.values(t).reduce((a, r) => a + r.length, 0) };
}

// Data-only ZIP (no photos), small enough to email.
export function buildDataZip({ company, data, at }) {
  const files = {
    'README.txt': strToU8([
      `${company.name} (${company.code}) — TrackMyRMA data backup, ${at}`, '',
      'data.json   everything in one file (used to restore)',
      'tables/     one CSV per table (opens in Excel)', '',
      'Photos and PDFs are not in this emailed backup; download a full backup from Settings > Backups.',
      'Zoho keys and other secrets are not included.',
    ].join('\r\n')),
    'data.json': strToU8(JSON.stringify({ company, exportedAt: at, ...data })),
  };
  for (const [name, rows] of Object.entries(data.tables || {})) if (rows.length) files[`tables/${name}.csv`] = strToU8(toCsv(rows));
  return zipSync(files, { level: 6 });
}

export function base64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const IST = 5.5 * 3600e3;
const istDay = (ms) => new Date(ms + IST).toISOString().slice(0, 10);

export const backupMethods = {
  backupStatus() {
    const s = this.settings();
    let last = null;
    try { last = JSON.parse(this.one("SELECT value FROM meta WHERE key = 'backup:last'")?.value || 'null'); } catch { /* none */ }
    let lastDownload = null;
    try { lastDownload = JSON.parse(this.one("SELECT value FROM meta WHERE key = 'backup:download'")?.value || 'null'); } catch { /* none */ }
    return { schedule: s.backup_email || 'weekly', extraTo: s.backup_extra_to || '', last, lastDownload };
  },
  backupData(user, { download = false } = {}) {
    const data = this.exportTables();
    if (download) {
      this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('backup:download', ?)", JSON.stringify({ at: Date.now(), by: user.name }));
      this.audit(user, 'download', 'backup', null, backupCounts(data));
    }
    return data;
  },
  // Cron: is a scheduled backup due today? Weekly = Mondays (or 7+ days since the last one).
  backupDue() {
    const s = this.settings();
    const sched = s.backup_email || 'weekly';
    if (sched === 'off') return { due: false };
    const now = Date.now();
    let last = null;
    try { last = JSON.parse(this.one("SELECT value FROM meta WHERE key = 'backup:last'")?.value || 'null'); } catch { /* none */ }
    const lastOk = last && last.ok ? last.at : 0;
    if (istDay(lastOk) === istDay(now)) return { due: false };
    if (sched === 'daily') return { due: true, extraTo: s.backup_extra_to || '' };
    const monday = new Date(now + IST).getUTCDay() === 1;
    return { due: monday || now - lastOk > 7 * 86400e3, extraTo: s.backup_extra_to || '' };
  },
  backupRecord(user, { result }) {
    const r = { at: Date.now(), ok: !!result.ok, size: result.size || 0, to: (result.to || []).slice(0, 10), stored: !!result.stored, counts: result.counts || null, error: result.ok ? null : String(result.error || '').slice(0, 300), how: result.how || 'scheduled' };
    this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('backup:last', ?)", JSON.stringify(r));
    this.audit(user, r.ok ? 'backup' : 'backup_failed', 'backup', null, { how: r.how, to: r.to, size: r.size, error: r.error });
    return r;
  },
};
