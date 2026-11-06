import { useEffect, useState } from 'react';
import { get, qs } from '../api.js';
import { Empty, ErrorPanel, Icon, Link, Skeleton, Status, ageDays, can, fmtMs, navigate, query } from '../ui.jsx';

// Saved views: one click for the lists people ask for most.
const VIEWS = [
  ['open', 'All open', { open: '1' }],
  ['late', 'At OEM over 30 days', { view: 'late' }],
  ['mine', 'Raised by me', { open: '1', view: 'mine' }],
  ['closedmonth', 'Closed this month', { view: 'closedmonth' }],
  ['heads', 'Head limit overridden', { view: 'heads' }],
  ['all', 'Everything', {}],
];

export default function RmaList({ user, boot }) {
  const q0 = query();
  const [f, setF] = useState({ q: q0.q || '', status: q0.status || '', open: q0.open ?? (q0.status || q0.view ? '' : '1'), view: q0.view || '', category: q0.category || '' });
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const cats = (boot.masters.categories || []).filter((c) => c.active);

  useEffect(() => {
    const t = setTimeout(() => {
      history.replaceState({}, '', `/rma?${qs(f)}`);
      get(`/api/rma?${qs({ ...f, limit: 500 })}`).then((r) => { setData(r); setError(null); }).catch(setError);
    }, f.q ? 250 : 0);
    return () => clearTimeout(t);
  }, [f]);

  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const activeView = f.status ? null : (VIEWS.find(([, , p]) => (p.open || '') === (f.open || '') && (p.view || '') === (f.view || ''))?.[0] || null);
  const pickView = (p) => setF((x) => ({ ...x, status: '', open: p.open || '', view: p.view || '' }));
  return (
    <>
      <div className="page-head">
        <div><h1>RMAs</h1><p className="muted">{data ? `${data.rows.length}${data.more ? '+' : ''} shown` : 'Loading…'}</p></div>
        <div className="row">
          <Link to="/devices" className="btn ghost"><Icon name="history" size={18} /> Device history</Link>
          <Link to="/reports" className="btn ghost"><Icon name="download" size={18} /> Export</Link>
          {can.edit(user) && <Link to="/rma/new" className="btn primary"><Icon name="plus" size={18} /> New RMA</Link>}
        </div>
      </div>

      <div className="views" role="group" aria-label="Saved views" style={{ marginBottom: 12 }}>
        {VIEWS.map(([k, label, p]) => <button key={k} type="button" aria-pressed={activeView === k} onClick={() => pickView(p)}>{label}</button>)}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end', marginBottom: 14 }}>
        <div className="search" style={{ flex: '1 1 320px' }}>
          <Icon name="search" size={18} />
          <input type="search" placeholder="RMA no., serial, customer, OEM RMA, part, PO, challan…" value={f.q} onChange={(e) => set('q', e.target.value)} aria-label="Search RMAs" />
        </div>
        <label className="small" style={{ display: 'grid', gap: 4, fontWeight: 750, color: 'var(--text-2)' }}>Stage
          <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value, open: e.target.value ? '' : '1', view: '' })}>
            <option value="">Any</option>
            {boot.statuses.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </label>
        {cats.length > 1 && (
          <label className="small" style={{ display: 'grid', gap: 4, fontWeight: 750, color: 'var(--text-2)' }}>Device
            <select value={f.category} onChange={(e) => set('category', e.target.value)}>
              <option value="">All devices</option>
              {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        )}
      </div>

      {error && <ErrorPanel error={error} />}
      {!data ? <Skeleton rows={6} /> : !data.rows.length ? (
        <Empty title={f.q || f.status || f.view ? 'No matching RMAs' : 'No open RMAs'}>
          {f.q || f.status || f.view ? 'Try a different search, view or stage.' : 'Raise a new RMA when a faulty part comes in.'}
        </Empty>
      ) : (
        <>
          <div className="tlist mobile-only">
            {data.rows.map((t) => (
              <Link key={t.id} to={`/rma/${t.id}`} className="tcard" data-s={t.status}>
                <div className="top"><span className="no">{t.ticket_no}</span><Status s={t.status} /></div>
                <h3>{t.customer_company || '—'}</h3>
                <span className="meta">{[t.category !== 'Printer' ? t.category : null, t.printer_model, t.printer_sn].filter(Boolean).join(' · ')}</span>
                <span className="meta">{t.faulty_part || '—'}{t.oem_rma_number ? ` · OEM ${t.oem_rma_number}` : ''} · {ageDays(t.created_at)}d old</span>
              </Link>
            ))}
          </div>
          <div className="tablewrap desktop-only">
            <table className="data">
              <thead><tr><th>RMA</th><th>Customer</th><th>Device</th><th>Faulty part</th><th>Stage</th><th>OEM RMA</th><th>Photos</th><th style={{ textAlign: 'right' }}>Age</th></tr></thead>
              <tbody>
                {data.rows.map((t) => {
                  const age = ageDays(t.created_at);
                  return (
                    <tr key={t.id} onClick={(e) => { if (e.target.tagName !== 'A') navigate(`/rma/${t.id}`); }} style={{ cursor: 'pointer' }}>
                      <td className="nowrap"><Link to={`/rma/${t.id}`} className="mono">{t.ticket_no}</Link>{t.is_imported ? <div className="tiny muted">Imported</div> : null}</td>
                      <td style={{ fontWeight: 650 }}>{t.customer_company || '—'}<div className="tiny muted" style={{ fontWeight: 500 }}>{t.customer_city}</div></td>
                      <td>{t.printer_model || '—'}<div className="tiny muted mono">{t.printer_sn}{t.category && t.category !== 'Printer' ? ` · ${t.category}` : ''}</div></td>
                      <td>{t.faulty_part || '—'}{t.head_override_reason ? <span className="pill warn" style={{ marginLeft: 6 }} title={t.head_override_reason}>Head limit</span> : null}
                        {t.faulty_part_sn ? <div className="tiny muted mono">{t.faulty_part_sn}</div> : null}</td>
                      <td><Status s={t.status} /></td>
                      <td className="mono" style={{ color: 'var(--text-2)' }}>{t.oem_rma_number || '—'}</td>
                      <td className="num">{t.inbound_photos}{t.outbound_photos ? ` / ${t.outbound_photos}` : ''}</td>
                      <td className="nowrap num" style={{ textAlign: 'right', fontWeight: 700, color: age > 30 && !t.closed_at ? 'var(--rust)' : undefined }}>
                        {t.closed_at ? <span className="muted" style={{ fontWeight: 500 }}>{fmtMs(t.closed_at)}</span> : `${age} d`}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {data.more && <p className="muted small" style={{ marginTop: 10 }}>Showing the newest 500. Search or filter to narrow down, or use Reports.</p>}
        </>
      )}
    </>
  );
}
