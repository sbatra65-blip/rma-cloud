import { useEffect, useState } from 'react';
import { get, qs } from '../api.js';
import { Dialog, Icon, Link, fmtDate } from '../ui.jsx';

// Cover line under the printer serial on the RMA form / RMA page.
export function CoverNote({ cover }) {
  if (cover === null || cover === undefined) return null;
  if (cover === false) return <p className="muted small" style={{ marginTop: 10 }}>This serial is not in the care pack registry.</p>;
  return (
    <div className={cover.expired ? 'formerror' : 'notice'} style={{ marginTop: 10, fontWeight: 600 }}>
      {cover.expired ? <Icon name="alert" size={16} style={{ verticalAlign: '-3px' }} /> : <Icon name="shield" size={16} style={{ verticalAlign: '-3px' }} />}{' '}
      {cover.expired ? 'Care pack ended' : 'Care pack'} — {cover.care_pack_type || '—'} · {cover.oem_brand || '—'} · cover till <b>{fmtDate(cover.warranty_end)}</b> ·{' '}
      invoice <Link to={`/care-packs/${cover.batch_id}`}>{cover.invoice_number}</Link>{cover.customer_name ? ` (${cover.customer_name})` : ''}
      {cover.overridden && <span className="pill warn" style={{ marginLeft: 6 }}>Override</span>}
      {cover.expired && <div className="small" style={{ marginTop: 4 }}>Expired cover cannot start a new RMA.</div>}
    </div>
  );
}

// "Pick from care pack": choose a client, then one of their printer serials.
export function CarePackPicker({ onPick }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [customers, setCustomers] = useState([]);
  const [client, setClient] = useState('');
  const [sq, setSq] = useState('');
  const [serials, setSerials] = useState(null);
  useEffect(() => {
    if (!open) return undefined;
    const t = setTimeout(() => get(`/api/carepack/customers?${qs({ q })}`).then(setCustomers).catch(() => {}), 200);
    return () => clearTimeout(t);
  }, [q, open]);
  useEffect(() => {
    if (!open || (!client && sq.trim().length < 3)) { setSerials(null); return undefined; }
    const t = setTimeout(() => get(`/api/carepack/serials?${qs({ customer: client, q: sq, take: 300 })}`).then(setSerials).catch(() => {}), 200);
    return () => clearTimeout(t);
  }, [client, sq, open]);
  return (
    <>
      <button type="button" className="btn ghost small" onClick={() => setOpen(true)}><Icon name="shield" size={16} /> Pick printer from care pack registry</button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Pick from care pack" wide>
        <div className="stack">
          {!client ? (
            <>
              <div className="search"><Icon name="search" size={18} /><input type="search" autoFocus placeholder="Type to filter clients… or a serial" value={q}
                onChange={(e) => { setQ(e.target.value); setSq(e.target.value); }} /></div>
              {serials && serials.length > 0 && <SerialTable rows={serials} onPick={(d) => { onPick(d); setOpen(false); }} />}
              <div className="tlist" style={{ maxHeight: 320, overflowY: 'auto' }}>
                {customers.map((c) => <button key={c} type="button" className="mrow" style={{ textAlign: 'left', border: 0, cursor: 'pointer' }} onClick={() => { setClient(c); setSq(''); }}><b>{c}</b><Icon name="back" size={16} style={{ transform: 'rotate(180deg)' }} /></button>)}
                {!customers.length && <p className="muted small">No care pack clients match.</p>}
              </div>
            </>
          ) : (
            <>
              <div className="spread"><b>{client}</b><button type="button" className="linkbtn" onClick={() => setClient('')}>Change client</button></div>
              <div className="search"><Icon name="search" size={18} /><input type="search" placeholder="Filter this client's serials — e.g. T6EV…" value={sq} onChange={(e) => setSq(e.target.value)} /></div>
              {serials === null ? <p className="muted small">Loading…</p> : serials.length ? <SerialTable rows={serials} onPick={(d) => { onPick(d); setOpen(false); }} />
                : <p className="muted small">No serials for this client — use another client or type the serial on the form.</p>}
            </>
          )}
        </div>
      </Dialog>
    </>
  );
}

function SerialTable({ rows, onPick }) {
  return (
    <div className="tablewrap" style={{ maxHeight: 360, boxShadow: 'none', border: '1px solid var(--line)' }}>
      <table className="data">
        <thead><tr><th /><th>Serial</th><th>Model</th><th>Invoice</th><th>Cover till</th></tr></thead>
        <tbody>{rows.map((d) => (
          <tr key={d.device_id}>
            <td>{d.expired ? <span className="pill bad">Expired</span> : <button type="button" className="btn primary small" onClick={() => onPick(d)}>Select</button>}</td>
            <td className="mono">{d.serial_number}{d.overridden ? ' *' : ''}</td><td>{d.printer_model}</td>
            <td>{d.invoice_number}<div className="tiny muted">{d.customer_name}</div></td><td className="nowrap">{fmtDate(d.warranty_end)}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}
