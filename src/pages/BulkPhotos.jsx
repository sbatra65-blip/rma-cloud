// Bulk RMA from photo zips.
// 1. Upload zips named with the printer serial (TEBT25160110.zip). Photos are unpacked here in the browser.
// 2. Each line shows cover (care pack / warranty) and RMAs already raised for that serial. Tap the faulty part; remove lines.
// 3. "Create drafts" saves one draft per line with its photos. Nothing is an RMA until someone accepts the draft.
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, compressImage, get, post } from '../api.js';
import { Dialog, Empty, ErrorPanel, Icon, Link, Skeleton, ago, fmtDate, navigate, useToast } from '../ui.jsx';
import PhotoViewer from './PhotoViewer.jsx';

export const DRAFT_PARTS = ['Print head', 'Main board', 'Power supply', 'Front panel', 'Accessories', 'Other'];
const MAX_ZIPS = 50;
const MAX_PHOTOS = 40; // every photo in the zip is kept on the draft (an RMA holds up to 40)
const MAX_ZIP_MB = 100;
const IMG = /\.(jpe?g|png|webp|heic|heif)$/i;
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif' };

// The printer serial from a zip file name: "TEBT25160110.zip", "TEBT25160110 (1).zip".
export function serialFromName(name) {
  let s = String(name || '').split(/[\\/]/).pop().replace(/\.zip$/i, '');
  s = s.replace(/\s*\(\d+\)\s*$/, '').replace(/\s*-\s*copy$/i, '');
  return s.toUpperCase().replace(/[^A-Z0-9_-]/g, '').replace(/^[-_]+|[-_]+$/g, '');
}
const snKey = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

async function readZip(file) {
  const out = { photos: [], skipped: 0, over: 0, error: null };
  if (!/\.zip$/i.test(file.name)) { out.error = 'Not a .zip file'; return out; }
  if (file.size > MAX_ZIP_MB * 1024 * 1024) { out.error = `Larger than ${MAX_ZIP_MB} MB`; return out; }
  const { default: JSZip } = await import('jszip');
  let zip;
  try { zip = await JSZip.loadAsync(file); } catch { out.error = 'This zip could not be opened'; return out; }
  const entries = Object.values(zip.files)
    .filter((e) => !e.dir && !/(^|\/)__MACOSX\//.test(e.name) && !/(^|\/)\./.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  for (const e of entries) {
    if (!IMG.test(e.name)) { out.skipped++; continue; }
    if (out.photos.length >= MAX_PHOTOS) { out.over++; continue; }
    const ext = e.name.split('.').pop().toLowerCase();
    const blob = new Blob([await e.async('arraybuffer')], { type: MIME[ext] || 'image/jpeg' });
    const name = e.name.split('/').pop();
    out.photos.push({ name, blob, url: URL.createObjectURL(blob) });
  }
  return out;
}

// How much of a photo is white label paper: config printouts score high, so they are read first.
async function whiteness(blob) {
  try {
    const bmp = await createImageBitmap(blob);
    const c = document.createElement('canvas');
    c.width = 48; c.height = 48;
    const g = c.getContext('2d');
    g.drawImage(bmp, 0, 0, 48, 48);
    bmp.close?.();
    const d = g.getImageData(0, 0, 48, 48).data;
    let w = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 175 && d[i + 1] > 175 && d[i + 2] > 175 && Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]) < 40) w++;
    return w / (48 * 48);
  } catch { return 0; }
}

// Reads the printer's configuration printout from the draft's photos (server side, Workers AI).
export async function readDraftConfig(draftId, order) {
  return post(`/api/drafts/${draftId}/read-config`, { order });
}

// One line about what was read from the printout.
export function ConfigNote({ c, sn }) {
  if (!c) return null;
  if (!c.found) return <div className="small muted">{c.error || (c.tried ? `No configuration printout found in ${c.tried} photo${c.tried === 1 ? '' : 's'}` : 'No configuration printout read')}</div>;
  const r = c.read;
  const mileage = r.non_reset_m !== null && r.non_reset_m !== undefined ? `${r.non_reset_m.toLocaleString('en-IN')} m` : 'not readable';
  if (c.match === false) return <div className="small" style={{ color: 'var(--rust)', fontWeight: 650 }}>Printout S/N {r.serial} is not {sn} — not used</div>;
  return <div className="small"><span className="pill ok">Printout read</span> NON-RESET {mileage}{r.bad_dot !== null ? ` · bad dots ${r.bad_dot}` : ''}{c.match === null ? ' · S/N not readable — check' : ''}</div>;
}

export function CoverPill({ c }) {
  if (!c) return <span className="pill">Checking…</span>;
  if (c.error) return <span className="pill bad">{c.error}</span>;
  if (c.cover === 'expired') return <span className="pill bad">Expired — blocked</span>;
  if (c.cover === 'covered') return <span className="pill ok">Covered</span>;
  return <span className="pill warn">Not in care pack register</span>;
}
// RMAs already raised for this serial: likely duplicate / open RMA / repeat failure / already a draft.
export function DupNotes({ c, inUpload }) {
  if (!c || c.error) return null;
  const link = (t) => <Link key={t.id} to={`/rma/${t.id}`}>{t.ticket_no}</Link>;
  const join = (list) => list.map((t, i) => <span key={t.id}>{i ? ', ' : ''}{link(t)} ({t.faulty_part || 'part not set'}, {t.status_label})</span>);
  const others = c.open.filter((t) => !c.likely.some((l) => l.id === t.id));
  return (
    <div className="dupnotes">
      {c.likely.length > 0 && <div className="bad"><Icon name="alert" size={15} /> Likely duplicate — same part already on open RMA {join(c.likely)}</div>}
      {others.length > 0 && <div className="warn">Open RMA on this printer: {join(others)}</div>}
      {c.repeat.length > 0 && <div className="note">Repeat failure — same part closed in the last 90 days: {join(c.repeat)}</div>}
      {c.drafts?.length > 0 && <div className="warn">Already waiting in Draft RMAs</div>}
      {inUpload && <div className="warn">Same serial twice in this upload</div>}
    </div>
  );
}
// Lines that should not become drafts unless someone ticks "Make a draft anyway".
const needsKeep = (c, inUpload) => !!(c && !c.error && (c.likely.length || c.drafts?.length)) || inUpload;

export default function BulkPhotos({ boot, onChange }) {
  const toast = useToast();
  const [lines, setLines] = useState([]);
  const [reading, setReading] = useState(0);
  const [checks, setChecks] = useState({});
  const [busy, setBusy] = useState('');
  const [drag, setDrag] = useState(false);
  const [view, setView] = useState(null); // { key, i }
  const fileRef = useRef(null);
  const seq = useRef(0);

  useEffect(() => () => lines.forEach((l) => l.photos.forEach((p) => URL.revokeObjectURL(p.url))), []); // eslint-disable-line react-hooks/exhaustive-deps

  async function addFiles(list) {
    const files = [...list].filter((f) => /\.zip$/i.test(f.name));
    if (!files.length) { toast('Choose .zip files — one per printer, named with the printer serial.', true); return; }
    const room = MAX_ZIPS - lines.length;
    if (files.length > room) toast(`Only ${MAX_ZIPS} zips at a time — the first ${Math.max(room, 0)} were added.`, true);
    const take = files.slice(0, Math.max(room, 0));
    setReading(take.length);
    const added = [];
    for (const f of take) {
      const r = await readZip(f);
      added.push({ key: `l${++seq.current}`, zip: f.name, sn: serialFromName(f.name), part: 'Print head', keep: false, state: '', ...r });
      setReading((n) => n - 1);
    }
    setLines((ls) => [...ls, ...added]);
  }

  // Cover + duplicate check, again whenever a serial or part changes.
  const checkKey = lines.map((l) => `${l.key}:${l.sn}:${l.part}`).join('|');
  useEffect(() => {
    const todo = lines.filter((l) => !l.error && l.sn);
    if (!todo.length) return undefined;
    const t = setTimeout(async () => {
      try {
        const r = await post('/api/drafts/check', { items: todo.map((l) => ({ sn: l.sn, part: l.part })) });
        const next = {};
        todo.forEach((l, i) => { next[l.key] = r.items[i]; });
        setChecks(next);
      } catch (e) { toast(e.message, true); }
    }, 350);
    return () => clearTimeout(t);
  }, [checkKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const counts = useMemo(() => {
    const m = new Map();
    lines.forEach((l) => m.set(snKey(l.sn), (m.get(snKey(l.sn)) || 0) + 1));
    return m;
  }, [lines]);
  const set = (key, patch) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const remove = (key) => setLines((ls) => {
    const l = ls.find((x) => x.key === key);
    l?.photos.forEach((p) => URL.revokeObjectURL(p.url));
    return ls.filter((x) => x.key !== key);
  });
  const clear = () => { lines.forEach((l) => l.photos.forEach((p) => URL.revokeObjectURL(p.url))); setLines([]); setChecks({}); };

  const why = (l) => {
    const c = checks[l.key];
    if (l.error) return l.error;
    if (!l.sn) return 'No serial in the file name';
    if (!l.photos.length) return 'No photos in this zip';
    if (!c) return 'Still checking';
    if (c.error) return c.error;
    if (c.cover === 'expired') return 'Cover has ended';
    if (needsKeep(c, counts.get(snKey(l.sn)) > 1) && !l.keep) return 'Tick "Make a draft anyway" or remove';
    return '';
  };
  const ready = lines.filter((l) => !l.state && !why(l));
  const readCfg = boot?.settings?.config_read !== false;

  async function createDrafts() {
    let ok = 0;
    for (let i = 0; i < ready.length; i++) {
      const l = ready[i];
      setBusy(`Saving draft ${i + 1} of ${ready.length}…`);
      set(l.key, { state: 'saving' });
      try {
        const d = await post('/api/drafts', { printer_sn: l.sn, faulty_part: l.part, source_name: l.zip });
        let fails = 0;
        const scored = [];
        for (const ph of l.photos) {
          try {
            const blob = await compressImage(ph.blob);
            const up = await api('POST', `/api/drafts/${d.id}/photos`, blob, {
              headers: { 'X-File-Name': encodeURIComponent(ph.name.replace(/\.(heic|heif|webp|png)$/i, '.jpg')), 'Content-Type': 'image/jpeg' },
            });
            if (readCfg) scored.push({ id: up.id, w: await whiteness(blob) });
          } catch { fails++; }
        }
        let config = null;
        if (readCfg && scored.length) {
          setBusy(`Reading the config printout ${i + 1} of ${ready.length}…`);
          set(l.key, { state: 'reading' });
          try {
            const r = await readDraftConfig(d.id, scored.sort((a, b) => b.w - a.w).map((x) => x.id));
            config = r.draft.config;
          } catch (e) { config = { found: false, error: `Printout not read: ${e.message}` }; }
        }
        set(l.key, { state: 'done', draftId: d.id, fails, config });
        ok++;
      } catch (e) {
        set(l.key, { state: '', saveError: e.message });
      }
    }
    setBusy('');
    onChange?.();
    if (ok) {
      toast(`${ok} draft${ok === 1 ? '' : 's'} saved. Check each one and accept it as an RMA.`);
      setLines((ls) => {
        const left = ls.filter((l) => l.state !== 'done' || l.fails || (readCfg && !l.config?.found) || l.config?.match === false);
        ls.filter((l) => !left.includes(l)).forEach((l) => l.photos.forEach((p) => URL.revokeObjectURL(p.url)));
        if (!left.length) setTimeout(() => navigate('/drafts'), 0);
        return left;
      });
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Bulk RMA from photos</h1>
          <p className="muted">One zip per printer, named with the printer serial (e.g. TEBT25160110.zip). The photos inside are taken out here. Each zip becomes a draft — nothing is an RMA until you accept it.</p>
        </div>
        <Link to="/drafts" className="btn ghost"><Icon name="edit" size={18} /> Draft RMAs</Link>
      </div>

      <section className="panel">
        <div className={`dropzone${drag ? ' over' : ''}`} onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); addFiles(e.dataTransfer.files); }}>
          <Icon name="upload" size={28} />
          <b>Drop zip files here</b>
          <button type="button" className="btn" onClick={() => fileRef.current?.click()} disabled={!!busy}>Choose zip files</button>
          <span className="small muted">Up to {MAX_ZIPS} zips · {MAX_PHOTOS} photos each · {MAX_ZIP_MB} MB each · JPG, PNG, HEIC</span>
          <input ref={fileRef} type="file" accept=".zip,application/zip" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
        </div>
        {reading > 0 && <p className="small muted" style={{ marginTop: 10 }}>Reading {reading} zip{reading === 1 ? '' : 's'}…</p>}
      </section>

      {lines.length > 0 && (
        <section className="panel">
          <div className="spread" style={{ marginBottom: 10 }}>
            <b>{lines.length} zip{lines.length === 1 ? '' : 's'} · {lines.reduce((n, l) => n + l.photos.length, 0)} photos</b>
            <span className="small muted">Check the serial, tap the faulty part, remove any line you don't want</span>
          </div>
          <div className="bulklines">
            {lines.map((l) => {
              const c = checks[l.key];
              const twice = counts.get(snKey(l.sn)) > 1;
              const reason = why(l);
              return (
                <div key={l.key} className={`bulkline${l.state === 'done' ? ' done' : ''}`}>
                  <div className="bl-id">
                    <input type="text" className="upper mono" value={l.sn} aria-label={`Serial for ${l.zip}`} disabled={!!l.state}
                      onChange={(e) => set(l.key, { sn: e.target.value.toUpperCase().trim(), keep: false })} />
                    <div className="small muted">{l.zip}{l.skipped ? ` · ${l.skipped} other file${l.skipped === 1 ? '' : 's'} ignored` : ''}{l.over ? ` · ${l.over} photo${l.over === 1 ? '' : 's'} over ${MAX_PHOTOS} left out` : ''}</div>
                    {c?.device && <div className="small">{[c.device.printer_model, c.device.customer_name].filter(Boolean).join(' · ')}{c.device.warranty_end ? ` · cover till ${fmtDate(c.device.warranty_end)}` : ''}</div>}
                  </div>
                  <div className="bl-check">
                    {l.error ? <span className="pill bad">{l.error}</span> : <CoverPill c={c} />}
                    {c?.cover === 'none' && <div className="small muted">On the draft, a Manager can add it to the register with a reason.</div>}
                    <DupNotes c={c} inUpload={twice} />
                    {needsKeep(c, twice) && !l.state && (
                      <label className="check small"><input type="checkbox" checked={l.keep} onChange={(e) => set(l.key, { keep: e.target.checked })} /> Make a draft anyway</label>
                    )}
                  </div>
                  <div className="bl-photos">
                    {l.photos.slice(0, 6).map((p, i) => <button type="button" key={p.url} className="thumbbtn" onClick={() => setView({ key: l.key, i })} aria-label={`View ${p.name}`}><img src={p.url} alt={p.name} /></button>)}
                    {l.photos.length > 6 && <button type="button" className="btn ghost small" onClick={() => setView({ key: l.key, i: 6 })}>+{l.photos.length - 6}</button>}
                    {l.photos.length > 0 && <span className="small muted" style={{ flexBasis: '100%' }}>{l.photos.length} photo{l.photos.length === 1 ? '' : 's'} · all kept on the draft · tap to view</span>}
                  </div>
                  <div className="bl-part">
                    <div className="views" role="group" aria-label="Faulty part">
                      {DRAFT_PARTS.map((p) => <button type="button" key={p} aria-pressed={l.part === p} disabled={!!l.state} onClick={() => set(l.key, { part: p })}>{p}</button>)}
                    </div>
                    {l.state === 'saving' && <span className="small muted">Saving…</span>}
                    {l.state === 'reading' && <span className="small muted">Reading the config printout…</span>}
                    {l.state === 'done' && <ConfigNote c={l.config} sn={l.sn} />}
                    {l.state === 'done' && <span className="small"><span className="pill ok">Draft saved</span>{l.fails ? ` · ${l.fails} photo${l.fails === 1 ? '' : 's'} could not be added` : ''}</span>}
                    {!l.state && reason && <span className="small muted">{reason}</span>}
                    {l.saveError && <span className="small" style={{ color: 'var(--rust)' }}>{l.saveError}</span>}
                  </div>
                  <button type="button" className="iconbtn bl-x" aria-label={`Remove ${l.zip}`} title="Remove this line" disabled={l.state === 'saving'} onClick={() => remove(l.key)}><Icon name="x" size={18} /></button>
                </div>
              );
            })}
          </div>
          <div className="row" style={{ marginTop: 14 }}>
            <button type="button" className="btn primary" disabled={!ready.length || !!busy} onClick={createDrafts}>
              {busy || `Create ${ready.length} draft${ready.length === 1 ? '' : 's'}`}</button>
            <button type="button" className="btn ghost" disabled={!!busy} onClick={clear}>Clear all</button>
            {ready.length < lines.filter((l) => !l.state).length && <span className="small muted">{lines.filter((l) => !l.state).length - ready.length} line{lines.filter((l) => !l.state).length - ready.length === 1 ? '' : 's'} will be skipped — see the note on each.</span>}
          </div>
        </section>
      )}
      {(() => {
        const l = view && lines.find((x) => x.key === view.key);
        return <PhotoViewer photos={l ? l.photos : []} index={l ? view.i : null} onIndex={(i) => setView({ ...view, i })} onClose={() => setView(null)} srcOf={(p) => p.url} />;
      })()}
    </>
  );
}

// Draft RMAs: review one (opens the New RMA form, filled in), or delete one or several.
export function Drafts({ onChange }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [sel, setSel] = useState([]);
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState(null); // { d, i }
  const load = () => get('/api/drafts').then((r) => { setData(r); setSel((s) => s.filter((id) => r.drafts.some((d) => d.id === id))); }).catch(setError);
  useEffect(() => { load(); }, []);

  if (error) return <ErrorPanel error={error} retry={load} />;
  if (!data) return <Skeleton rows={4} />;
  const { drafts } = data;
  const all = drafts.length > 0 && sel.length === drafts.length;

  async function remove(ids) {
    setBusy(true);
    try {
      const r = await post('/api/drafts/delete', { ids });
      toast(`${r.deleted} draft${r.deleted === 1 ? '' : 's'} deleted`);
      setConfirm(null);
      setSel([]);
      onChange?.();
      await load();
    } catch (e) { toast(e.message, true); } finally { setBusy(false); }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Draft RMAs</h1>
          <p className="muted">Made from photo zips. A draft is not an RMA yet — no RMA number, no customer email. Drafts not accepted in {data.keepDays} days are removed.</p>
        </div>
        <Link to="/rma/bulk" className="btn primary"><Icon name="upload" size={18} /> Upload zips</Link>
      </div>
      {!drafts.length ? (
        <section className="panel"><Empty icon="edit" title="No drafts waiting" action={<Link to="/rma/bulk" className="btn primary">Upload photo zips</Link>}>
          Upload zips of photos named with the printer serial. Each one becomes a draft here.</Empty></section>
      ) : (
        <>
          <div className="row" style={{ marginBottom: 10 }}>
            <label className="check small"><input type="checkbox" checked={all} onChange={(e) => setSel(e.target.checked ? drafts.map((d) => d.id) : [])} /> Select all</label>
            {sel.length > 0 && <button type="button" className="btn danger small" onClick={() => setConfirm(sel)}><Icon name="trash" size={16} /> Delete {sel.length} selected</button>}
          </div>
          <div className="bulklines">
            {drafts.map((d) => (
              <div key={d.id} className="bulkline draftline">
                <label className="check" aria-label={`Select draft ${d.printer_sn}`}><input type="checkbox" checked={sel.includes(d.id)}
                  onChange={(e) => setSel((s) => (e.target.checked ? [...s, d.id] : s.filter((x) => x !== d.id)))} /></label>
                <div className="bl-id">
                  <b className="mono">{d.printer_sn}</b>
                  <div className="small">{d.faulty_part}{d.check?.device ? ` · ${[d.check.device.printer_model, d.check.device.customer_name].filter(Boolean).join(' · ')}` : ''}</div>
                  <div className="small muted">{d.source_name || 'photo zip'} · {d.created_by} · {ago(d.created_at)}</div>
                  <ConfigNote c={d.config} sn={d.printer_sn} />
                </div>
                <div className="bl-check"><CoverPill c={d.check} /><DupNotes c={d.check} /></div>
                <div className="bl-photos">
                  {d.photos.slice(0, 4).map((p, i) => <button type="button" key={p.id} className="thumbbtn" onClick={() => setView({ d, i })} aria-label={`View ${p.name}`}><img src={`/api/drafts/photos/${p.id}`} alt={p.name} loading="lazy" /></button>)}
                  {d.photos.length > 4 && <button type="button" className="btn ghost small" onClick={() => setView({ d, i: 4 })}>+{d.photos.length - 4}</button>}
                </div>
                <div className="row tight bl-act">
                  <Link to={`/rma/new?draft=${d.id}`} className="btn primary small">Review &amp; accept</Link>
                  <button type="button" className="iconbtn" aria-label={`Delete draft ${d.printer_sn}`} title="Delete draft" onClick={() => setConfirm([d.id])}><Icon name="trash" size={18} /></button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      <PhotoViewer photos={view ? view.d.photos : []} index={view ? view.i : null} onIndex={(i) => setView({ ...view, i })} onClose={() => setView(null)}
        srcOf={(p) => `/api/drafts/photos/${p.id}`} />
      <Dialog open={!!confirm} onClose={() => setConfirm(null)} title={confirm?.length === 1 ? 'Delete this draft?' : `Delete ${confirm?.length} drafts?`}>
        <p>{confirm?.length === 1 ? `Draft ${drafts.find((d) => d.id === confirm[0])?.printer_sn || ''} and its photos` : `These ${confirm?.length} drafts and their photos`} will be deleted for good. RMAs already raised are not affected.</p>
        <div className="row end">
          <button type="button" className="btn ghost" onClick={() => setConfirm(null)}>Keep</button>
          <button type="button" className="btn danger" disabled={busy} onClick={() => remove(confirm)}>{busy ? 'Deleting…' : confirm?.length === 1 ? 'Delete draft' : `Delete ${confirm?.length} drafts`}</button>
        </div>
      </Dialog>
    </>
  );
}
