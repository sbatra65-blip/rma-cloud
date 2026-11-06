import { useEffect, useState } from 'react';
import { downloadBlob, get, qs } from '../api.js';
import { writeTable } from '../excel.js';
import { CoverNote } from './CarePackLink.jsx';
import { Empty, ErrorPanel, Icon, Link, SHORT, Skeleton, Status, fmtDate, fmtMs, navigate, todayISO } from '../ui.jsx';

const STAGE_COLOR = {
  OPEN: 'var(--s-open)', AWAITING_OEM_RMA: 'var(--s-await)', OEM_RMA_RECEIVED: 'var(--s-oem)', DISPATCHED_TO_OEM: 'var(--s-toem)',
  GOODS_RECEIVED_FROM_OEM: 'var(--s-back)', DISPATCHED_TO_CUSTOMER: 'var(--s-tocust)', CLOSED: 'var(--ok)',
};

// RMA history for one device serial: search, then a printable / downloadable report.
export default function DeviceHistory({ sn }) {
  return sn ? <History sn={sn} /> : <Search />;
}

function Search() {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    const key = q.replace(/[^a-z0-9]/gi, '');
    if (key.length < 3) { setRows(null); return undefined; }
    const t = setTimeout(() => get(`/api/devices?${qs({ q })}`).then((r) => { setRows(r); setError(null); }).catch(setError), 250);
    return () => clearTimeout(t);
  }, [q]);
  const go = (e) => { e.preventDefault(); if (q.trim().length >= 3) navigate(`/devices/${encodeURIComponent(q.trim())}`); };
  return (
    <>
      <div className="page-head"><div><h1>Device history</h1><p className="muted">Every RMA raised for one printer, mobile terminal or other device.</p></div></div>
      <form onSubmit={go} className="search" style={{ maxWidth: 560, marginBottom: 16 }}>
        <Icon name="search" size={18} />
        <input type="search" autoFocus placeholder="Device serial number" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Device serial number" />
      </form>
      {error && <ErrorPanel error={error} />}
      {rows === null ? <p className="muted small">Type at least 3 letters or digits of the serial.</p> : !rows.length ? (
        <Empty icon="search" title="No device found">No RMA or care pack has this serial. <button type="button" className="linkbtn" onClick={go}>Open the history anyway</button></Empty>
      ) : (
        <div className="panel" style={{ padding: 6 }}>
          {rows.map((r) => (
            <Link key={r.serial} to={`/devices/${encodeURIComponent(r.serial)}`} className="linkrow" style={{ padding: '10px 12px' }}>
              <span style={{ display: 'grid', minWidth: 0 }}>
                <span className="mono">{r.serial}</span>
                <span className="muted small">{[r.category, r.model, r.customer].filter(Boolean).join(' · ') || '—'}</span>
              </span>
              <span className={`pill ${r.rmas ? '' : 'ok'}`}>{r.rmas ? `${r.rmas} RMA${r.rmas === 1 ? '' : 's'}` : 'Care pack, no RMA'}</span>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}

function History({ sn }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { get(`/api/devices/history?${qs({ sn })}`).then(setD).catch(setError); }, [sn]);
  if (error) return <ErrorPanel error={error} />;
  if (!d) return <Skeleton rows={6} />;
  const s = d.summary;
  const overHeads = s.headLimit && s.heads >= s.headLimit;

  async function excel() {
    setBusy(true);
    try {
      const rows = d.tickets.map((t) => [t.ticket_no, fmtDate(new Date(t.created_at).toISOString().slice(0, 10)), t.customer_company || '', t.category || '', t.printer_model || '',
        t.faulty_part || '', t.faulty_part_sn || '', t.tph_mileage ?? '', t.failure_description || '', t.oem_rma_number || '', t.oem_dispatch_date || '',
        SHORT[t.status] || t.status, t.closed_at ? fmtDate(new Date(t.closed_at).toISOString().slice(0, 10)) : '', t.days ?? '', t.head_override_reason || t.dup_reason || '']);
      for (const t of d.asPart) rows.push([t.ticket_no, fmtDate(new Date(t.created_at).toISOString().slice(0, 10)), t.customer_company || '', t.category || '', t.printer_model || '',
        `${t.faulty_part || ''} (this serial was the part, in device ${t.printer_sn || '?'})`, t.faulty_part_sn || '', '', t.failure_description || '', t.oem_rma_number || '', t.oem_dispatch_date || '',
        SHORT[t.status] || t.status, '', t.days ?? '', '']);
      const blob = await writeTable({ sheet: 'Device history', title: `RMA history — ${d.serial}`,
        subtitle: `${[s.categories.join('/'), s.models.join(', '), s.customers.join(', ')].filter(Boolean).join(' · ')} · ${s.total} RMAs, ${s.heads} print-head · generated ${fmtDate(todayISO())}`,
        headers: ['RMA', 'Raised', 'Customer', 'Device', 'Model', 'Faulty part', 'Part serial', 'TPH mileage', 'Failure', 'OEM RMA', 'To OEM', 'Stage', 'Closed', 'Days', 'Notes'],
        rows, widths: [22, 12, 24, 14, 14, 22, 18, 10, 36, 14, 12, 16, 12, 6, 36] });
      downloadBlob(blob, `Device_History_${d.serial}_${todayISO()}.xlsx`.replace(/[^\w.-]/g, '_'));
    } finally { setBusy(false); }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <Link to="/devices" className="small noprint">← Device history</Link>
          <h1 className="mono" style={{ fontSize: '1.5rem', fontWeight: 600 }}>{d.serial}</h1>
          <p className="muted">{[s.categories.join(' / '), s.models.join(', '), s.customers.join(', ')].filter(Boolean).join(' · ') || 'No RMAs yet'}</p>
        </div>
        <div className="row noprint">
          <button className="btn ghost" onClick={() => window.print()}><Icon name="printer" size={18} /> Print</button>
          <button className="btn primary" disabled={busy || (!d.tickets.length && !d.asPart.length)} onClick={excel}><Icon name="download" size={18} /> {busy ? 'Preparing…' : 'Download Excel'}</button>
        </div>
      </div>

      <div className="kpis" style={{ marginBottom: 14 }}>
        <div><b>{s.total}</b><span>RMAs</span></div>
        <div><b>{s.open}</b><span>Open now</span></div>
        <div style={overHeads ? { borderColor: 'var(--amber)', background: 'var(--amber-tint)' } : undefined}><b style={overHeads ? { color: 'var(--amber)' } : undefined}>{s.heads}{s.headLimit ? <small className="muted" style={{ fontSize: '0.85rem' }}> / {s.headLimit}</small> : null}</b><span>Print-head claims</span></div>
        <div><b>{s.avgDays ?? '—'}</b><span>Average days to close</span></div>
        <div><b style={{ fontSize: '1rem' }}>{s.first ? fmtMs(s.first) : '—'}</b><span>First RMA</span></div>
        <div><b style={{ fontSize: '1rem' }}>{s.last ? fmtMs(s.last) : '—'}</b><span>Latest RMA</span></div>
      </div>

      {overHeads && <div className="warnbox" style={{ marginBottom: 14 }}>This device has reached the print-head limit ({s.headLimit}). A new print-head RMA will need a reason.</div>}
      {d.cover !== undefined && <div style={{ marginBottom: 14 }}><CoverNote cover={d.cover || false} /></div>}

      <div className="dash-cols" style={{ marginTop: 0 }}>
        <section className="panel main">
          <h2 style={{ marginBottom: 14 }}>Timeline</h2>
          {d.tickets.length ? (
            <ol className="timeline">
              {[...d.tickets].reverse().map((t) => (
                <li key={t.id} style={{ '--c': STAGE_COLOR[t.status] }}>
                  <div style={{ display: 'grid', gap: 4 }}>
                    <div className="spread" style={{ gap: 8 }}>
                      <span><Link to={`/rma/${t.id}`} className="mono">{t.ticket_no}</Link> <span className="muted small">· {fmtMs(t.created_at)}</span></span>
                      <Status s={t.status} />
                    </div>
                    <b>{t.faulty_part || 'Part not set'}{t.head ? <span className="pill warn" style={{ marginLeft: 6 }}>Print head</span> : null}</b>
                    <span className="muted small">{[t.customer_company, t.printer_model, t.faulty_part_sn && `part ${t.faulty_part_sn}`, t.tph_mileage != null && `TPH ${t.tph_mileage}`,
                      t.oem_rma_number && `OEM RMA ${t.oem_rma_number}`, t.days != null && `closed in ${t.days} days`].filter(Boolean).join(' · ')}</span>
                    {t.failure_description && <span className="small">{t.failure_description}</span>}
                    {t.head_override_reason && <span className="small" style={{ color: 'var(--amber)' }}>Head limit override: {t.head_override_reason}</span>}
                  </div>
                </li>
              ))}
            </ol>
          ) : <p className="muted">No RMA has been raised for this device.</p>}
        </section>
        <div className="side">
          <section className="panel">
            <h2>Parts returned</h2>
            {s.parts.length ? s.parts.map((p) => (
              <div key={p.part} className="linkrow"><span>{p.part}</span><b className="num">{p.n}</b></div>
            )) : <p className="muted small" style={{ marginTop: 8 }}>None yet.</p>}
          </section>
          {d.asPart.length > 0 && (
            <section className="panel">
              <h2>As a faulty part</h2>
              <p className="muted small">This serial was the faulty part in another device.</p>
              {d.asPart.map((t) => (
                <Link key={t.id} to={`/rma/${t.id}`} className="linkrow">
                  <span style={{ display: 'grid' }}><span className="mono" style={{ fontSize: '0.82rem' }}>{t.ticket_no}</span>
                    <span className="muted small">{t.faulty_part} in {t.printer_sn || '—'}</span></span>
                  <Status s={t.status} />
                </Link>
              ))}
            </section>
          )}
        </div>
      </div>
    </>
  );
}
