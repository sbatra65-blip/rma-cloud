import { useState } from 'react';
import { get, qs } from '../api.js';
import { CoverNote } from './CarePackLink.jsx';
import { ErrorPanel, FLOW, Icon, Link, SHORT, Skeleton, Status, ago, can, useLoad } from '../ui.jsx';

export default function Dashboard({ user }) {
  const [d, reload, error] = useLoad(() => get('/api/dashboard'));
  if (error && !d) return <ErrorPanel error={error} retry={reload} />;
  if (!d) return <Skeleton rows={6} />;
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{greet}, {user.name.split(' ')[0]}</h1>
          <p className="muted">{d.open} open RMA{d.open === 1 ? '' : 's'} at {user.company.name}</p>
        </div>
        {can.edit(user) && <Link to="/rma/new" className="btn primary"><Icon name="plus" size={18} /> New RMA</Link>}
      </div>

      <section aria-label="RMAs by stage" className="track" style={{ marginBottom: 14 }}>
        {FLOW.map((s) => {
          const n = s === 'CLOSED' ? d.counts.CLOSED + d.counts.CLOSED_RETURNED : d.counts[s];
          return (
            <Link key={s} to={`/rma?status=${s}`} className={`stage ${n ? '' : 'zero'}`} data-s={s}>
              <b>{n}</b><span>{SHORT[s]}</span>
            </Link>
          );
        })}
      </section>

      <div className="stack">
        {d.reminders > 0 && (
          <Link to="/reminders" className="callout"><Icon name="bell" />
            <span>{d.reminders} RMA{d.reminders === 1 ? ' needs' : 's need'} a next step — Excel, OEM email, dispatch or follow-up.</span></Link>
        )}
        {d.batchReady > 0 && d.lastWeekOfMonth && (
          <Link to="/batches" className="callout"><Icon name="truck" />
            <span>Last week of the month: {d.batchReady} RMA{d.batchReady === 1 ? ' has' : 's have'} an OEM RMA # and can go in this month's batch.</span></Link>
        )}
      </div>

      <div className="stats" style={{ margin: '14px 0' }}>
        <div className="stat"><b>{d.createdThisMonth}</b><span>Raised this month</span></div>
        <div className="stat"><b>{d.closedThisMonth}</b><span>Closed this month</span></div>
        <div className={`stat ${d.ages.over30 ? 'hot' : ''}`}><b>{d.ages.over30}</b><span>Open over 30 days</span></div>
        <div className="stat"><b>{d.avgCloseDays ?? '—'}</b><span>Avg days to close (6 mo)</span></div>
      </div>

      {d.carePack && <CarePackTiles cp={d.carePack} />}

      <div className="grid2">
        <section className="panel">
          <div className="spread" style={{ marginBottom: 12 }}><h2>Recently updated</h2><Link to="/rma" className="small">All RMAs</Link></div>
          {d.recent.length ? (
            <div className="tlist">
              {d.recent.map((t) => (
                <Link key={t.id} to={`/rma/${t.id}`} className="tcard" data-s={t.status}>
                  <div className="top"><span className="no">{t.ticket_no}</span><Status s={t.status} /></div>
                  <h3>{t.customer_company || '—'}</h3>
                  <span className="meta">{[t.printer_model, t.printer_sn, t.faulty_part].filter(Boolean).join(' · ')} · {ago(t.updated_at)}</span>
                </Link>
              ))}
            </div>
          ) : (
            <div className="empty"><Icon name="ticket" size={36} /><p className="muted">No RMAs yet.</p>
              {can.manage(user) && <Link to="/import" className="btn ghost small">Import your old RMA sheet</Link>}</div>
          )}
        </section>
        <section className="panel">
          <h2>Open RMAs by age</h2>
          <AgeBars ages={d.ages} />
          <h2 style={{ marginTop: 22 }}>Most returned parts (12 months)</h2>
          {d.topParts.length ? (
            <ul className="events" style={{ marginTop: 10 }}>
              {d.topParts.map((p) => <li key={p.name}><span><b>{p.name}</b> <span className="muted">· {p.n}</span></span></li>)}
            </ul>
          ) : <p className="muted small" style={{ marginTop: 8 }}>Nothing yet.</p>}
        </section>
      </div>
    </>
  );
}

function CarePackTiles({ cp }) {
  const [sn, setSn] = useState('');
  const [cover, setCover] = useState(undefined);
  async function look(e) {
    e.preventDefault();
    if (sn.trim().length < 3) return;
    try { setCover((await get(`/api/carepack/serial?${qs({ sn: sn.trim() })}`)).device || false); } catch { setCover(false); }
  }
  return (
    <section className="panel" style={{ marginBottom: 14 }}>
      <div className="spread"><h2>Care packs</h2><Link to="/care-packs" className="small">Registry</Link></div>
      <form className="search" style={{ margin: '10px 0' }} onSubmit={look}><Icon name="search" size={18} />
        <input type="search" placeholder="Is this printer covered? Type its serial and press Enter" value={sn} onChange={(e) => { setSn(e.target.value); setCover(undefined); }} aria-label="Check printer cover" /></form>
      {cover !== undefined && <CoverNote cover={cover} />}
      <div className="stats" style={{ marginTop: 12 }}>
        <Link to="/care-packs" className="stat"><b>{cp.devices}</b><span>Printers covered ({cp.batches} invoices)</span></Link>
        <Link to="/care-packs/pending?tab=po" className={`stat ${cp.poOverdue ? 'hot' : ''}`}><b>{cp.poOverdue + cp.poDueSoon}</b><span>OEM PO overdue / due ≤5d</span></Link>
        <Link to="/care-packs/pending?tab=docs" className="stat"><b>{cp.docsPending}</b><span>OEM documents pending</span></Link>
        <Link to="/care-packs/pending?tab=pay" className={`stat ${cp.payOverdue ? 'hot' : ''}`}><b>{cp.payOverdue + cp.payDueSoon}</b><span>OEM payment overdue / due ≤5d</span></Link>
        <div className="stat"><b>{cp.expiring30}</b><span>Cover ends in 30 days</span></div>
        <div className="stat"><b>{cp.expired}</b><span>Cover ended</span></div>
      </div>
    </section>
  );
}

function AgeBars({ ages }) {
  const rows = [['Under 7 days', ages.under7, 'var(--ok)'], ['7–30 days', ages.d7to30, 'var(--amber)'], ['Over 30 days', ages.over30, 'var(--rust)']];
  const max = Math.max(1, ...rows.map((r) => r[1]));
  return (
    <div style={{ display: 'grid', gap: 10, marginTop: 12 }}>
      {rows.map(([label, n, c]) => (
        <div key={label} style={{ display: 'grid', gridTemplateColumns: '110px 1fr 36px', gap: 10, alignItems: 'center', fontSize: '0.88rem' }}>
          <span className="muted" style={{ fontWeight: 650 }}>{label}</span>
          <span style={{ height: 10, borderRadius: 999, background: 'var(--mist)', overflow: 'hidden' }}>
            <i style={{ display: 'block', height: '100%', width: `${(n / max) * 100}%`, background: c, borderRadius: 999 }} />
          </span>
          <b className="num" style={{ textAlign: 'right' }}>{n}</b>
        </div>
      ))}
    </div>
  );
}
