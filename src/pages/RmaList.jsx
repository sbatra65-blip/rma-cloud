import { useEffect, useState } from 'react';
import { get, post, qs } from '../api.js';
import { Dialog, Empty, RECEIVED_STAGES, ErrorPanel, Field, Icon, Link, ShowToggle, Skeleton, Status, ageDays, can, fmtMs, navigate, query, useShow, useToast } from '../ui.jsx';

// Saved views: one click for the lists people ask for most. "Active only / All" applies on top.
const VIEWS = [
  ['', 'All RMAs'],
  ['late', 'At OEM over 30 days'],
  ['mine', 'Raised by me'],
  ['heads', 'Head limit overridden'],
  ['closedmonth', 'Closed this month'],
];

export default function RmaList({ user, boot }) {
  const toast = useToast();
  const q0 = query();
  const [show] = useShow();
  const [f, setF] = useState({ q: q0.q || '', status: q0.status || '', view: q0.view || '', category: q0.category || '' });
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [sel, setSel] = useState(() => new Set());
  const [closing, setClosing] = useState(false);
  const [tick, setTick] = useState(0);
  const cats = (boot.masters.categories || []).filter((c) => c.active);
  const bulk = can.manage(user);

  useEffect(() => {
    const t = setTimeout(() => {
      history.replaceState({}, '', `/rma?${qs(f)}`);
      get(`/api/rma?${qs({ ...f, show, limit: 500 })}`).then((r) => { setData(r); setError(null); }).catch(setError);
    }, f.q ? 250 : 0);
    return () => clearTimeout(t);
  }, [f, show, tick]);
  useEffect(() => { setSel(new Set()); }, [f, show]);

  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const toggle = (id) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const closable = (data?.rows || []).filter((t) => !t.closed_at);
  const allOn = closable.length > 0 && closable.every((t) => sel.has(t.id));
  const filtered = f.q || f.status || f.view || f.category;
  return (
    <>
      <div className="page-head">
        <div><h1>RMAs</h1><p className="muted">{data ? `${data.rows.length}${data.more ? '+' : ''} ${show === 'active' && !f.status && f.view !== 'closedmonth' ? 'active' : 'shown'}` : 'Loading…'}</p></div>
        <div className="row head-actions">
          <Link to="/devices" className="btn ghost" aria-label="Device history"><Icon name="history" size={18} /> <span>Device history</span></Link>
          <Link to="/reports" className="btn ghost" aria-label="Export"><Icon name="download" size={18} /> <span>Export</span></Link>
          {can.edit(user) && <Link to="/rma/new" className="btn primary wide-only"><Icon name="plus" size={18} /> New RMA</Link>}
        </div>
      </div>

      <div className="spread" style={{ gap: 10, marginBottom: 12, alignItems: 'center' }}>
        <ShowToggle />
        <span className="muted small">{show === 'active' ? 'Hiding RMAs sent back to the customer or closed' : 'Showing every RMA, including completed'}</span>
      </div>
      <div className="views scroll-sm" role="group" aria-label="Saved views" style={{ marginBottom: 12 }}>
        {VIEWS.map(([k, label]) => <button key={k || 'all'} type="button" aria-pressed={!f.status && f.view === k} onClick={() => setF((x) => ({ ...x, status: '', view: k }))}>{label}</button>)}
      </div>

      <div className="filterbar">
        <div className="search">
          <Icon name="search" size={18} />
          <input type="search" placeholder="Search RMA, serial, customer, part…" value={f.q} onChange={(e) => set('q', e.target.value)} aria-label="Search RMAs" />
        </div>
        <label className="small filter">Stage
          <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value, view: '' })}>
            <option value="">Any</option>
            {boot.statuses.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </label>
        {cats.length > 1 && (
          <label className="small filter">Device
            <select value={f.category} onChange={(e) => set('category', e.target.value)}>
              <option value="">All devices</option>
              {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        )}
      </div>

      {bulk && sel.size > 0 && (
        <div className="selbar" role="region" aria-label="Selected RMAs">
          <b>{sel.size} selected</b>
          <button type="button" className="linkbtn" onClick={() => setSel(new Set())}>Clear</button>
          <button type="button" className="btn primary small" style={{ marginLeft: 'auto' }} onClick={() => setClosing(true)}><Icon name="check" size={16} /> Close selected</button>
        </div>
      )}

      {error && <ErrorPanel error={error} />}
      {!data ? <Skeleton rows={6} /> : !data.rows.length ? (
        <Empty title={filtered ? 'No matching RMAs' : show === 'active' ? 'No active RMAs' : 'No RMAs yet'}>
          {filtered ? 'Try a different search, view or stage.' : show === 'active' ? 'Everything is sent back or closed. Choose “All” to see them.' : 'Raise a new RMA when a faulty part comes in.'}
        </Empty>
      ) : (
        <>
          <div className="tlist mobile-only">
            {data.rows.map((t) => (
              <div key={t.id} className={`tcard-wrap ${bulk ? 'has-check' : ''}`}>
                {bulk && !t.closed_at && <input type="checkbox" className="tcheck" checked={sel.has(t.id)} onChange={() => toggle(t.id)} aria-label={`Select ${t.ticket_no}`} />}
                <Link to={`/rma/${t.id}`} className="tcard" data-s={t.status}>
                  <div className="top"><span className="no">{t.ticket_no}</span><Status s={t.status} /></div>
                  <h3>{t.customer_company || '—'}</h3>
                  <span className="meta">{[t.category !== 'Printer' ? t.category : null, t.printer_model, t.printer_sn].filter(Boolean).join(' · ')}</span>
                  <span className="meta">{t.faulty_part || '—'}{t.oem_rma_number ? ` · OEM ${t.oem_rma_number}` : ''} · {ageDays(t.created_at)}d old</span>
                  <SnPair t={t} />
                </Link>
              </div>
            ))}
          </div>
          <div className="tablewrap desktop-only">
            <table className="data">
              <thead><tr>
                {bulk && <th style={{ width: 36 }}><input type="checkbox" checked={allOn} disabled={!closable.length} aria-label="Select all shown that are not closed"
                  onChange={() => setSel(allOn ? new Set() : new Set(closable.map((t) => t.id)))} /></th>}
                <th>RMA</th><th>Customer</th><th>Device</th><th>Part · serial sent → received</th><th>Stage</th><th>OEM RMA</th><th>Photos</th><th style={{ textAlign: 'right' }}>Age</th></tr></thead>
              <tbody>
                {data.rows.map((t) => {
                  const age = ageDays(t.created_at);
                  return (
                    <tr key={t.id} onClick={(e) => { if (!['A', 'INPUT'].includes(e.target.tagName)) navigate(`/rma/${t.id}`); }} style={{ cursor: 'pointer' }} className={sel.has(t.id) ? 'selected' : ''}>
                      {bulk && <td>{!t.closed_at && <input type="checkbox" checked={sel.has(t.id)} onChange={() => toggle(t.id)} aria-label={`Select ${t.ticket_no}`} />}</td>}
                      <td className="nowrap"><Link to={`/rma/${t.id}`} className="mono">{t.ticket_no}</Link>{t.is_imported ? <div className="tiny muted">Imported</div> : null}</td>
                      <td style={{ fontWeight: 600 }}>{t.customer_company || '—'}<div className="tiny muted" style={{ fontWeight: 500 }}>{t.customer_city}</div></td>
                      <td>{t.printer_model || '—'}<div className="tiny muted mono">{t.printer_sn}{t.category && t.category !== 'Printer' ? ` · ${t.category}` : ''}</div></td>
                      <td>{t.faulty_part || '—'}{t.head_override_reason ? <span className="pill warn" style={{ marginLeft: 6 }} title={t.head_override_reason}>Head limit</span> : null}
                        <SnPair t={t} /></td>
                      <td><Status s={t.status} /></td>
                      <td className="mono" style={{ color: 'var(--text-2)' }}>{t.oem_rma_number || '—'}</td>
                      <td className="num">{t.inbound_photos}{t.outbound_photos ? ` / ${t.outbound_photos}` : ''}</td>
                      <td className="nowrap num" style={{ textAlign: 'right', fontWeight: 600, color: age > 30 && !t.closed_at ? 'var(--rust)' : undefined }}>
                        {t.closed_at ? <span className="muted" style={{ fontWeight: 500 }}>{fmtMs(t.closed_at)}</span> : `${age} d`}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {data.more && <p className="muted small" style={{ marginTop: 10 }}>Showing the newest 500. Search or filter to narrow down, or use Reports.</p>}
          {bulk && <p className="muted small desktop-only" style={{ marginTop: 10 }}>Tip: to clear old finished RMAs, pick Stage “Dispatched to customer”, tick the box at the top of the list, then Close selected.</p>}
        </>
      )}
      {closing && <BulkClose ids={[...sel]} rows={data?.rows || []} onClose={() => setClosing(false)}
        onDone={(r) => { setClosing(false); setSel(new Set()); setTick((n) => n + 1); toast(`${r.closed} RMA${r.closed === 1 ? '' : 's'} closed${r.skipped.length ? `, ${r.skipped.length} already closed` : ''}`); }} />}
    </>
  );
}

// Faulty part serial sent to the OEM → serial of the part received back.
function SnPair({ t }) {
  if (!t.faulty_part_sn && !t.received_part_sn && !RECEIVED_STAGES.includes(t.status)) return null;
  return (
    <div className="snpair">
      {t.faulty_part_sn || '—'}
      {RECEIVED_STAGES.includes(t.status) && <><span className="arrow" aria-label="received">→</span>
        {t.received_part_sn ? <span className="new">{t.received_part_sn}</span> : <span style={{ color: 'var(--amber)', fontFamily: 'var(--font)' }}>received serial missing</span>}</>}
      {t.part_sn_note && <span className="pill warn" style={{ marginLeft: 6, fontFamily: 'var(--font)' }} title={t.part_sn_note}>Serial differs</span>}
    </div>
  );
}

function BulkClose({ ids, rows, onClose, onDone }) {
  const [type, setType] = useState('close');
  const [remarks, setRemarks] = useState('');
  const [err, setErr] = useState({});
  const [busy, setBusy] = useState(false);
  const byStage = {};
  for (const t of rows) if (ids.includes(t.id)) byStage[t.status_label || t.status] = (byStage[t.status_label || t.status] || 0) + 1;
  async function go(e) {
    e.preventDefault();
    setBusy(true);
    try { onDone(await post('/api/rma/bulk-close', { ids, type, remarks })); } catch (x) { setErr({ form: Object.keys(x.fields || {}).length ? null : x.message, ...(x.fields || {}) }); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} title={`Close ${ids.length} RMA${ids.length === 1 ? '' : 's'}`}>
      <form className="stack" onSubmit={go} noValidate>
        {err.form && <div className="formerror">{err.form}</div>}
        <p className="small">{Object.entries(byStage).map(([s, n]) => `${n} ${s}`).join(' · ')}. They move to Closed and drop out of “Active only”. Each RMA's history records the bulk close with your name.</p>
        <Field label="Close as">
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="close">Closed — repaired / replaced</option>
            <option value="close_returned">Closed — returned without repair</option>
          </select>
        </Field>
        <Field label="Remark" required error={err.remarks} hint="Saved on every RMA closed">
          <input type="text" maxLength={500} value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="e.g. Delivered to customer; old RMAs closed" />
        </Field>
        <div className="row end">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy}>{busy ? 'Closing…' : `Close ${ids.length}`}</button>
        </div>
      </form>
    </Dialog>
  );
}
