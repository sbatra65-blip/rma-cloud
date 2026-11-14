import { useEffect, useState } from 'react';
import { get, post } from '../api.js';
import { Field, Mark, Wordmark } from '../ui.jsx';

// Public pages for a service centre's customers (no login):
//   /t/<token>  status of one RMA (the private link from the email)
//   /track      enter an RMA number; the status link is emailed to the address on file
const dmy = (iso) => (iso ? iso.split('-').reverse().join('-') : '');

export default function Track({ path }) {
  const token = path.startsWith('/t/') ? path.slice(3).split(/[/?#]/)[0] : '';
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex';
    document.head.appendChild(meta);
    document.title = 'RMA status · TrackMyRMA';
    return () => meta.remove();
  }, []);
  return (
    <div className="trackpage">
      <main className="track-card" id="main">
        {token ? <Status token={token} /> : <Lookup />}
      </main>
      <p className="track-foot"><a href="/track">Check another RMA</a> · Powered by <a href="https://trackmyrma.com"><Wordmark /></a></p>
    </div>
  );
}

function Status({ token }) {
  const [v, setV] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    get(`/api/track/${encodeURIComponent(token)}`).then(setV).catch((e) => setError(e.status === 404 ? 'This status link is not valid or has been removed.' : e.message));
  }, [token]);
  if (error) {
    return (
      <div className="stack">
        <h1 className="track-h">Link not found</h1>
        <p className="muted">{error}</p>
        <a className="btn primary block" href="/track">Check by RMA number</a>
      </div>
    );
  }
  if (!v) return <p className="muted" aria-busy="true">Loading status…</p>;
  const c = v.centre;
  return (
    <div className="stack">
      <div className="track-centre">
        {c.logoAt ? <img src={`/api/track/${encodeURIComponent(token)}/logo?v=${c.logoAt}`} alt="" height="44" /> : <Mark size={44} still />}
        <div><b>{c.name}</b>{c.city && <span className="muted small"> · {c.city}</span>}</div>
      </div>
      <div>
        <p className="muted small">RMA {v.ticketNo}</p>
        <h1 className="track-h">{v.steps[v.step].label}</h1>
        <p className="track-msg">{v.message}</p>
      </div>
      <ol className="track-steps" aria-label="Progress">
        {v.steps.map((s, i) => (
          <li key={s.label} className={i < v.step || (i === v.step && v.step === 4) ? 'done' : i === v.step ? 'now' : ''} aria-current={i === v.step ? 'step' : undefined}>
            <span className="dot" aria-hidden="true" />
            <span className="lbl">{s.label}</span>
            {s.date && <span className="date">{dmy(s.date)}</span>}
          </li>
        ))}
      </ol>
      <dl className="track-facts">
        {v.item && <><dt>Item</dt><dd>{v.item}</dd></>}
        {v.serial && <><dt>Serial</dt><dd className="mono">{v.serial}</dd></>}
        {v.customer && <><dt>Customer</dt><dd>{v.customer}</dd></>}
        {v.docket && <><dt>Courier / docket</dt><dd>{v.docket}</dd></>}
        <dt>Last update</dt><dd>{new Date(v.updatedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</dd>
      </dl>
      {(c.phone || c.email) && (
        <div className="track-contact">
          <span className="muted small">Questions about this RMA?</span>
          <div className="row wrap">
            {c.phone && <a className="btn ghost" href={`tel:${c.phone.replace(/\s+/g, '')}`}>Call {c.phone}</a>}
            {c.email && <a className="btn ghost" href={`mailto:${c.email}?subject=${encodeURIComponent(`RMA ${v.ticketNo}`)}`}>Email {c.name || 'us'}</a>}
          </div>
        </div>
      )}
    </div>
  );
}

function Lookup() {
  const [rma, setRma] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    if (!rma.trim()) return setError('Enter your RMA number');
    setBusy(true);
    setError('');
    try {
      setDone((await post('/api/track/lookup', { rma: rma.trim() })).message);
    } catch (x) {
      setError(x.fields?.rma || x.message);
    } finally {
      setBusy(false);
    }
  }
  if (done) {
    return (
      <div className="stack">
        <h1 className="track-h">Check your email</h1>
        <p className="track-msg">{done}</p>
        <button className="btn ghost block" onClick={() => { setDone(''); setRma(''); }}>Check another RMA</button>
      </div>
    );
  }
  return (
    <form className="stack" onSubmit={submit} noValidate>
      <div className="track-centre"><Mark size={44} still /><Wordmark /></div>
      <div>
        <h1 className="track-h">Check your RMA status</h1>
        <p className="track-msg">Enter the RMA number from your service centre. We'll email a link with the live status to the email address they have on file.</p>
      </div>
      <Field label="RMA number" htmlFor="tr-rma" error={error}>
        <input id="tr-rma" className="upper" type="text" autoComplete="off" spellCheck="false" placeholder="e.g. ABC-RMA-202611-0001" value={rma} onChange={(e) => setRma(e.target.value.toUpperCase())} />
      </Field>
      <button className="btn primary block" disabled={busy}>{busy ? 'Sending…' : 'Email me the status link'}</button>
    </form>
  );
}
