import { useState } from 'react';
import { get, post } from '../api.js';
import { Empty, ErrorPanel, Icon, Link, Skeleton, can, useLoad, useToast } from '../ui.jsx';

export default function Reminders({ user }) {
  const toast = useToast();
  const [data, reload, error] = useLoad(() => get('/api/reminders'));
  const [busy, setBusy] = useState(false);
  if (error && !data) return <ErrorPanel error={error} retry={reload} />;
  if (!data) return <Skeleton rows={5} />;
  const groups = new Map();
  for (const i of data.items) {
    const k = i.kind.replace(/\s*\(\d+ days\)$/, '');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(i);
  }
  const cpGroups = new Map();
  for (const i of data.carePack || []) {
    if (!cpGroups.has(i.kind)) cpGroups.set(i.kind, []);
    cpGroups.get(i.kind).push(i);
  }
  async function test() {
    setBusy(true);
    try {
      const r = await post('/api/reminders/test');
      toast(`Sent to ${r.to} (${r.items} item${r.items === 1 ? '' : 's'})`);
    } catch (e) {
      toast(e.message, true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-head">
        <div><h1>Reminders</h1><p className="muted">RMAs and care packs waiting for their next step. Admins and Managers get this list by email at 9 am each day.</p></div>
        {can.manage(user) && <button className="btn ghost" disabled={busy} onClick={test}><Icon name="mail" size={18} /> {busy ? 'Sending…' : 'Email me this list now'}</button>}
      </div>
      {!data.items.length && !cpGroups.size ? <Empty icon="check" title="All caught up">No RMA is waiting on you right now.</Empty> : (
        [...groups].map(([kind, list]) => (
          <section key={kind} className="panel">
            <div className="spread" style={{ marginBottom: 10 }}><h2>{kind}</h2><span className="pill accent">{list.length}</span></div>
            <div className="tlist">
              {list.map((i) => (
                <Link key={i.id} to={`/rma/${i.id}`} className="tcard" style={{ '--c': i.tone === 'late' ? 'var(--rust)' : 'var(--amber)' }}>
                  <div className="top"><span className="no">{i.ticket_no}</span><span className={`pill ${i.tone === 'late' ? 'bad' : 'warn'}`}>{i.age} days old</span></div>
                  <h3>{i.customer}</h3>
                  <span className="meta">{[i.model, i.serial, i.part].filter(Boolean).join(' · ')}</span>
                </Link>
              ))}
            </div>
          </section>
        ))
      )}
      {[...cpGroups].map(([kind, list]) => (
        <section key={kind} className="panel">
          <div className="spread" style={{ marginBottom: 10 }}><h2>{kind}</h2><span className="pill accent">{list.length}</span></div>
          <div className="tlist">
            {list.map((i) => (
              <Link key={`${kind}${i.id}`} to={`/care-packs/${i.id}`} className="tcard" style={{ '--c': i.tone === 'late' ? 'var(--rust)' : 'var(--amber)' }}>
                <div className="top"><span className="no">{i.invoice}</span>{i.tone === 'late' && <span className="pill bad">Overdue</span>}</div>
                <h3>{i.customer}</h3>
                <span className="meta">{i.detail}</span>
              </Link>
            ))}
          </div>
        </section>
      ))}
      <p className="muted small" style={{ marginTop: 12 }}>"Awaiting OEM RMA #" shows after {data.awaitingDays} days — change this in Company settings.</p>
    </>
  );
}
