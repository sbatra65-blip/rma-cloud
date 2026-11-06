import { useState } from 'react';
import { get, qs } from '../api.js';
import { CoverNote } from './CarePackLink.jsx';
import { ErrorPanel, FLOW, Icon, Link, SHORT, Skeleton, Status, ago, can, navigate, useLoad } from '../ui.jsx';

const STAGE_COLOR = {
  OPEN: 'var(--s-open)', AWAITING_OEM_RMA: 'var(--s-await)', OEM_RMA_RECEIVED: 'var(--s-oem)', DISPATCHED_TO_OEM: 'var(--s-toem)',
  GOODS_RECEIVED_FROM_OEM: 'var(--s-back)', DISPATCHED_TO_CUSTOMER: 'var(--s-tocust)',
};

export default function Dashboard({ user }) {
  const [d, reload, error] = useLoad(() => get('/api/dashboard'));
  if (error && !d) return <ErrorPanel error={error} retry={reload} />;
  if (!d) return <Skeleton rows={6} />;
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const openStages = FLOW.filter((s) => s !== 'CLOSED');
  const cpOn = d.carePack && user.company.modules?.includes('carepack');
  return (
    <>
      <div className="page-head">
        <div>
          <p className="muted small" style={{ fontWeight: 650 }}>{new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
          <h1 style={{ fontSize: '1.85rem', letterSpacing: '-0.02em' }}>{greet}, {user.name.split(' ')[0]}</h1>
        </div>
        <div className="row head-actions">
          <Link to="/devices" className="btn ghost" aria-label="Device history"><Icon name="history" size={18} /> <span>Device history</span></Link>
          {can.edit(user) && <Link to="/rma/new" className="btn primary wide-only"><Icon name="plus" size={18} /> New RMA</Link>}
        </div>
      </div>

      <section className="pipe" aria-labelledby="pipe-h">
        <div className="head">
          <h2 id="pipe-h">{d.open} open RMA{d.open === 1 ? '' : 's'}</h2>
          <span className="muted small">{d.closedThisMonth} closed this month · {d.createdThisMonth} raised · {d.avgCloseDays ?? '—'} days average to close</span>
        </div>
        <div className="bar" aria-hidden="true">
          {openStages.map((s) => d.counts[s] ? <span key={s} style={{ flex: d.counts[s], background: STAGE_COLOR[s] }} /> : null)}
        </div>
        <div className="segs">
          {openStages.map((s) => (
            <Link key={s} to={`/rma?status=${s}`} className={d.counts[s] ? '' : 'zero'} style={{ '--c': STAGE_COLOR[s] }}>
              <span>{SHORT[s]}</span><b>{d.counts[s]}</b>
            </Link>
          ))}
        </div>
      </section>

      {d.batchReady > 0 && d.lastWeekOfMonth && (
        <Link to="/batches" className="callout" style={{ marginTop: 14 }}><Icon name="truck" />
          <span>Last week of the month: {d.batchReady} RMA{d.batchReady === 1 ? ' has' : 's have'} an OEM RMA number and can go in this month's batch.</span></Link>
      )}

      <div className="dash-cols">
        <section className="queue main" aria-labelledby="q-h">
          <div className="qhead">
            <div><h2 id="q-h">Needs your next step</h2><p className="muted small">Late ones first. The button opens the RMA at that step.</p></div>
            {d.queueTotal > 0 && <Link to="/reminders" className="small" style={{ fontWeight: 700 }}>All {d.queueTotal} reminders</Link>}
          </div>
          {d.queue.length ? d.queue.map((q) => (
            <div key={`${q.id}${q.kind}`} className="qrow">
              <div><Link to={`/rma/${q.id}`} className="no">{q.ticket_no}</Link><div className="sub">{q.age === 0 ? 'Raised today' : `${q.age} day${q.age === 1 ? '' : 's'} open`}</div></div>
              <div><b>{q.customer}</b><div className="sub">{[q.model, q.serial, q.part].filter((x) => x && x !== '—').join(' · ')}</div></div>
              <div><span className={`qtag ${q.tone === 'late' ? 'late' : 'due'}`}>{q.kind}</span></div>
              <button type="button" className="btn ghost small" onClick={() => navigate(`/rma/${q.id}`)}>{q.action}</button>
            </div>
          )) : (
            <div className="empty" style={{ padding: '28px 20px' }}><Icon name="check" size={32} /><p className="muted">Nothing waiting on you. Nice.</p></div>
          )}
        </section>

        <div className="side">
          {cpOn && <CarePackBox cp={d.carePack} />}
          <section className="panel">
            <h2>Open RMAs by age</h2>
            <AgeBars ages={d.ages} />
            {d.topParts.length > 0 && <p className="muted small" style={{ marginTop: 14 }}>Most returned part (12 months): <b style={{ color: 'var(--text)' }}>{d.topParts[0].name} ({d.topParts[0].n})</b></p>}
          </section>
          <section className="panel">
            <div className="spread" style={{ marginBottom: 6 }}><h2>Recently updated</h2><Link to="/rma" className="small">All RMAs</Link></div>
            {d.recent.length ? d.recent.slice(0, 5).map((t) => (
              <Link key={t.id} to={`/rma/${t.id}`} className="linkrow">
                <span style={{ display: 'grid', minWidth: 0 }}><span className="mono" style={{ fontSize: '0.82rem' }}>{t.ticket_no}</span>
                  <span className="muted small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.customer_company || '—'} · {ago(t.updated_at)}</span></span>
                <Status s={t.status} />
              </Link>
            )) : (
              <div className="empty"><Icon name="ticket" size={32} /><p className="muted">No RMAs yet.</p>
                {can.manage(user) && <Link to="/import" className="btn ghost small">Import your old RMA sheet</Link>}</div>
            )}
          </section>
        </div>
      </div>
    </>
  );
}

function CarePackBox({ cp }) {
  const [sn, setSn] = useState('');
  const [cover, setCover] = useState(undefined);
  async function look(e) {
    e.preventDefault();
    if (sn.trim().length < 3) return;
    try { setCover((await get(`/api/carepack/serial?${qs({ sn: sn.trim() })}`)).device || false); } catch { setCover(false); }
  }
  const rows = [
    ['/care-packs/pending?tab=po', 'OEM PO overdue or due in 5 days', cp.poOverdue + cp.poDueSoon, cp.poOverdue ? 'bad' : ''],
    ['/care-packs/pending?tab=docs', 'OEM documents pending', cp.docsPending, ''],
    ['/care-packs/pending?tab=pay', 'OEM payment overdue or due in 5 days', cp.payOverdue + cp.payDueSoon, cp.payOverdue ? 'bad' : ''],
    ['/care-packs', 'Cover ends in 30 days', cp.expiring30, cp.expiring30 ? 'warn' : ''],
  ];
  return (
    <section className="panel">
      <div className="spread"><h2>Care packs</h2><Link to="/care-packs" className="small">{cp.devices} printers covered</Link></div>
      <form onSubmit={look} style={{ margin: '12px 0 8px', display: 'grid', gap: 6 }}>
        <label htmlFor="cp-sn" className="small" style={{ fontWeight: 750, color: 'var(--text-2)' }}>Is this printer covered?</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input id="cp-sn" type="search" placeholder="Printer serial" value={sn} onChange={(e) => { setSn(e.target.value); setCover(undefined); }} aria-label="Check printer cover" style={{ flex: 1, minWidth: 0 }} />
          <button className="btn ghost">Check</button>
        </div>
      </form>
      {cover !== undefined && <CoverNote cover={cover} />}
      <div style={{ marginTop: 8 }}>
        {rows.map(([to, label, n, tone]) => (
          <Link key={label} to={to} className="linkrow"><span>{label}</span><span className={`pill ${tone}`}>{n}</span></Link>
        ))}
      </div>
    </section>
  );
}

function AgeBars({ ages }) {
  const rows = [['Under 7 days', ages.under7, 'var(--ok)'], ['7–30 days', ages.d7to30, 'var(--s-await)'], ['Over 30 days', ages.over30, 'var(--rust)']];
  const max = Math.max(1, ...rows.map((r) => r[1]));
  return (
    <div style={{ display: 'grid', gap: 10, marginTop: 12 }}>
      {rows.map(([label, n, c]) => (
        <div key={label} style={{ display: 'grid', gridTemplateColumns: '100px 1fr 32px', gap: 10, alignItems: 'center', fontSize: '0.88rem' }}>
          <span style={{ fontWeight: 650, color: 'var(--text-2)' }}>{label}</span>
          <span style={{ height: 8, borderRadius: 999, background: 'var(--mist)', overflow: 'hidden' }}>
            <i style={{ display: 'block', height: '100%', width: `${(n / max) * 100}%`, background: c, borderRadius: 999 }} />
          </span>
          <b className="num" style={{ textAlign: 'right' }}>{n}</b>
        </div>
      ))}
    </div>
  );
}
