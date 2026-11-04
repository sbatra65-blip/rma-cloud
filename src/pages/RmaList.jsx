import { useEffect, useState } from 'react';
import { get, qs } from '../api.js';
import { Empty, ErrorPanel, Icon, Link, Skeleton, Status, ageDays, can, fmtMs, navigate, query } from '../ui.jsx';

export default function RmaList({ user, boot }) {
  const q0 = query();
  const [f, setF] = useState({ q: q0.q || '', status: q0.status || '', open: q0.open || (q0.status ? '' : '1') });
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const t = setTimeout(() => {
      history.replaceState({}, '', `/rma?${qs(f)}`);
      get(`/api/rma?${qs({ ...f, limit: 500 })}`).then((r) => { setData(r); setError(null); }).catch(setError);
    }, f.q ? 250 : 0);
    return () => clearTimeout(t);
  }, [f]);

  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  return (
    <>
      <div className="page-head">
        <div><h1>RMAs</h1><p className="muted">{data ? `${data.rows.length}${data.more ? '+' : ''} shown` : 'Loading…'}</p></div>
        <div className="row">
          <Link to="/reports" className="btn ghost"><Icon name="download" size={18} /> Export</Link>
          {can.edit(user) && <Link to="/rma/new" className="btn primary"><Icon name="plus" size={18} /> New RMA</Link>}
        </div>
      </div>
      <div className="filters">
        <div className="search">
          <Icon name="search" size={18} />
          <input type="search" placeholder="Ticket, serial, customer, OEM RMA #, part, PO, challan…" value={f.q} onChange={(e) => set('q', e.target.value)} aria-label="Search RMAs" />
        </div>
        <div className="chips" role="group" aria-label="Filter by status">
          <button className="chip" aria-pressed={f.open === '1' && !f.status} onClick={() => setF({ ...f, open: '1', status: '' })}>All open</button>
          <button className="chip" aria-pressed={!f.open && !f.status} onClick={() => setF({ ...f, open: '', status: '' })}>Everything</button>
          {boot.statuses.map((s) => (
            <button key={s.value} className="chip" aria-pressed={f.status === s.value} onClick={() => setF({ ...f, status: s.value, open: '' })}>
              <span className="st" data-s={s.value} style={{ padding: 0, background: 'none' }} />{s.label}
            </button>
          ))}
        </div>
      </div>
      {error && <ErrorPanel error={error} />}
      {!data ? <Skeleton rows={6} /> : !data.rows.length ? (
        <Empty title={f.q || f.status ? 'No matching RMAs' : 'No open RMAs'}>
          {f.q || f.status ? 'Try a different search or status.' : 'Raise a new RMA when a faulty part comes in.'}
        </Empty>
      ) : (
        <>
          <div className="tlist mobile-only">
            {data.rows.map((t) => (
              <Link key={t.id} to={`/rma/${t.id}`} className="tcard" data-s={t.status}>
                <div className="top"><span className="no">{t.ticket_no}</span><Status s={t.status} /></div>
                <h3>{t.customer_company || '—'}</h3>
                <span className="meta">{[t.printer_model, t.printer_sn].filter(Boolean).join(' · ')}</span>
                <span className="meta">{t.faulty_part || '—'}{t.oem_rma_number ? ` · OEM ${t.oem_rma_number}` : ''} · {ageDays(t.created_at)}d old</span>
              </Link>
            ))}
          </div>
          <div className="tablewrap desktop-only">
            <table className="data">
              <thead><tr><th>Ticket</th><th>Status</th><th>Customer</th><th>Model / serial</th><th>Faulty part</th><th>OEM RMA #</th><th>Photos</th><th>Raised</th></tr></thead>
              <tbody>
                {data.rows.map((t) => (
                  <tr key={t.id} onClick={(e) => { if (e.target.tagName !== 'A') navigate(`/rma/${t.id}`); }} style={{ cursor: 'pointer' }}>
                    <td className="nowrap"><Link to={`/rma/${t.id}`} className="mono">{t.ticket_no}</Link>{t.is_imported ? <div className="tiny muted">Imported</div> : null}</td>
                    <td><Status s={t.status} /></td>
                    <td>{t.customer_company || '—'}<div className="tiny muted">{t.customer_city}</div></td>
                    <td><span className="mono">{t.printer_sn || '—'}</span><div className="tiny muted">{t.printer_model}</div></td>
                    <td>{t.faulty_part || '—'}{t.faulty_part_sn ? <div className="tiny muted mono">{t.faulty_part_sn}</div> : null}</td>
                    <td className="mono">{t.oem_rma_number || <span className="muted">—</span>}</td>
                    <td className="num">{t.inbound_photos}{t.outbound_photos ? ` / ${t.outbound_photos}` : ''}</td>
                    <td className="nowrap">{fmtMs(t.created_at)}<div className="tiny muted">{ageDays(t.created_at)} days</div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.more && <p className="muted small" style={{ marginTop: 10 }}>Showing the newest 500. Search or filter to narrow down, or use Reports.</p>}
        </>
      )}
    </>
  );
}
