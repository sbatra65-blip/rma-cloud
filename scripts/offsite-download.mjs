// Download one company's backup from the offsite storage as a ZIP (same layout as Settings > Backups > Download
// full backup): data.json, tables/*.csv, photos/, pdfs/, files/. Decrypts when OFFSITE_PASSPHRASE is set.
//
// Needs the same settings as the Worker, as environment variables:
//   OFFSITE_ENDPOINT, OFFSITE_BUCKET, OFFSITE_REGION, OFFSITE_KEY_ID, OFFSITE_SECRET, OFFSITE_PASSPHRASE
//
//   node scripts/offsite-download.mjs                       list companies and the dates kept
//   node scripts/offsite-download.mjs INF                   latest backup of company INF
//   node scripts/offsite-download.mjs INF 2026-11-01 out    that day's data, saved in folder "out"
//   node scripts/offsite-download.mjs --directory           companies, users and payments (no passwords)
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { Offsite, gunzip, offsiteConfig } from '../worker/offsite.js';
import { toCsv } from '../worker/backup.js';

process.on('uncaughtException', (e) => { console.error(`\n${e.message}`); process.exit(1); });
const env = process.env;
if (!offsiteConfig(env).ready) {
  console.error('Set OFFSITE_ENDPOINT, OFFSITE_BUCKET, OFFSITE_KEY_ID and OFFSITE_SECRET (and OFFSITE_PASSPHRASE if backups are encrypted).');
  process.exit(1);
}
const off = new Offsite(env);
const readJson = async (key) => JSON.parse(new TextDecoder().decode(await gunzip(await off.get(key))));
const dateOf = (k) => k.match(/(\d{4}-\d{2}-\d{2})\.json\.gz(\.enc)?$/)?.[1];
const latest = (keys) => keys.filter(dateOf).sort((a, b) => dateOf(a).localeCompare(dateOf(b))).at(-1);
const safe = (t) => String(t || 'file').replace(/[^\w.-]+/g, '_').slice(0, 80);
const isPdf = (x) => x.mime === 'application/pdf' || /\.pdf$/i.test(x.name || '');

const [arg, wantDate, outDir = '.'] = process.argv.slice(2);
const dirKeys = await off.list('directory/');
if (!dirKeys.length) { console.error('No backups found in this bucket yet.'); process.exit(1); }
const directory = await readJson(latest(dirKeys));

if (arg === '--directory') {
  const d = wantDate ? dirKeys.find((k) => dateOf(k) === wantDate) : latest(dirKeys);
  if (!d) { console.error(`No directory copy for ${wantDate}`); process.exit(1); }
  const file = join(outDir, `directory_${dateOf(d)}.json`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(file, JSON.stringify(await readJson(d), null, 1));
  console.log(`Saved ${file}`);
  process.exit(0);
}

if (!arg) {
  console.log('Company  Name                                Data snapshots kept');
  for (const c of directory.companies) {
    const dates = (await off.list(`companies/${c.id}/data/`)).map(dateOf).filter(Boolean).sort();
    console.log(`${c.code.padEnd(8)} ${String(c.name).slice(0, 34).padEnd(35)} ${dates.length ? `${dates.length} (${dates[0]} … ${dates.at(-1)})` : 'none yet'}${c.active ? '' : '  [inactive]'}`);
  }
  process.exit(0);
}

const co = directory.companies.find((c) => c.code.toLowerCase() === arg.toLowerCase() || c.id === arg);
if (!co) { console.error(`No company "${arg}". Run without arguments to list them.`); process.exit(1); }
const dataKeys = await off.list(`companies/${co.id}/data/`);
const dk = wantDate ? dataKeys.find((k) => dateOf(k) === wantDate) : latest(dataKeys);
if (!dk) { console.error(wantDate ? `No snapshot for ${wantDate}. Kept: ${dataKeys.map(dateOf).filter(Boolean).join(', ')}` : 'No data snapshot yet.'); process.exit(1); }
const day = dateOf(dk);
console.log(`${co.code}: data of ${day}`);
const d = await readJson(dk);

const files = { 'data.json': strToU8(JSON.stringify({ ...d, company: { name: co.name, code: co.code } }, null, 1)) };
for (const [name, rows] of Object.entries(d.tables || {})) if (rows.length) files[`tables/${name}.csv`] = strToU8(toCsv(rows));
// Photos and files are stored once, by id; pick the ones this snapshot refers to.
const byId = (keys, prefix) => new Map(keys.map((k) => [k.slice(prefix.length).replace(/\.enc$/, '').replace(/\.[a-z0-9]+$/i, ''), k]));
const pPre = `companies/${co.id}/photos/`;
const fPre = `companies/${co.id}/files/`;
const photoKeys = byId(await off.list(pPre), pPre);
const fileKeys = byId(await off.list(fPre), fPre);
const cpInvoice = Object.fromEntries((d.tables?.cp_batches || []).map((b) => [`cp-oem-${b.id}`, b.invoice_number]));
const missing = [];
let n = 0;
const total = (d.photos || []).length + (d.files || []).length;
for (const p of d.photos || []) {
  process.stdout.write(`\rFiles ${++n} of ${total}`);
  const k = photoKeys.get(String(p.id));
  const rma = safe(p.ticket_no || p.ticket_id);
  const path = isPdf(p) ? `pdfs/rma/${rma}/${p.direction}-${safe(p.name || p.id)}` : `photos/${rma}/${p.direction}-${safe(p.name || p.id)}`;
  if (!k) { missing.push(path); continue; }
  files[path] = await off.get(k);
}
for (const f of d.files || []) {
  process.stdout.write(`\rFiles ${++n} of ${total}`);
  const k = fileKeys.get(String(f.id));
  const batch = f.id.match(/^batch_challan_(.+)$/);
  const path = !isPdf(f) ? `files/${safe(f.id)}-${safe(f.name)}` : cpInvoice[f.id] ? `pdfs/care-packs/${safe(cpInvoice[f.id])}-${safe(f.name)}`
    : batch ? `pdfs/oem-batches/${safe(batch[1])}-${safe(f.name)}` : `pdfs/other/${safe(f.id)}-${safe(f.name)}`;
  if (!k) { missing.push(path); continue; }
  files[path] = await off.get(k);
}
files['README.txt'] = strToU8([`${co.name} (${co.code}) — TrackMyRMA offsite backup, data of ${day}`, '',
  'data.json   everything in one file (used to restore)', 'tables/     one CSV per table (opens in Excel)', 'photos/     RMA photos by RMA number',
  'pdfs/       rma/, care-packs/, oem-batches/', 'files/      OEM template, logo and other files', '',
  missing.length ? `Not yet in offsite storage (copied on a later night): ${missing.length}\r\n${missing.join('\r\n')}` : ''].join('\r\n'));
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `${co.code}_offsite_${day}.zip`);
writeFileSync(out, zipSync(files, { level: 6 }));
console.log(`\rSaved ${out} (${n - missing.length} of ${total} photos and files${missing.length ? `, ${missing.length} not copied yet` : ''})`);
