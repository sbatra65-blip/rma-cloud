import { useState } from 'react';
import { downloadBlob, get, post } from '../api.js';
import { writeTable } from '../excel.js';
import { Empty, ErrorPanel, Field, Icon, Link, Skeleton, Status, can, fmtDate, fmtMs, navigate, todayISO, useLoad, useToast } from '../ui.jsx';

export async function packingList(batch, tickets, companyName) {
  const d = fmtDate(batch.dispatch_date);
  const blob = await writeTable({
    sheet: 'Packing List',
    title: `Monthly OEM Batch Packing List — ${batch.batch_code}`,
    subtitle: `${companyName} · Dispatch date: ${d}${batch.courier ? ` · ${batch.courier}` : ''}${batch.docket ? ` ${batch.docket}` : ''} · Generated ${new Date().toLocaleString('en-IN')}`,
    headers: ['S.No.', 'Internal Ticket #', 'OEM RMA #', 'Printer Model', 'Printer SN', 'Faulty Part', 'Faulty Part SN', 'Failure Description', 'Customer Name', 'Date Raised', 'Dispatch Date'],
    widths: [6, 22, 20, 15, 18, 15, 15, 30, 20, 15, 15],
    rows: tickets.map((t, i) => [i + 1, t.ticket_no, t.oem_rma_number || '', t.printer_model || '', t.printer_sn || '', t.faulty_part || '',
      t.faulty_part_sn || '', t.failure_description || '', t.customer_company || '', fmtMs(t.created_at), d]),
    total: `Total RMAs in batch: ${tickets.length}`,
  });
  downloadBlob(blob, `${batch.batch_code}_PackingList.xlsx`);
}

export default function Batches(props) {
  return props.code ? <BatchDetail {...props} /> : <BatchList {...props} />;
}

function BatchList({ user, onChange }) {
  const toast = useToast();
  const [data, reload, error] = useLoad(() => get('/api/batches'));
  const [picked, setPicked] = useState(new Set());
  const [f, setF] = useState({ dispatch_date: todayISO(), courier: '', docket: '', remarks: '' });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  if (error && !data) return <ErrorPanel error={error} retry={reload} />;
  if (!data) return <Skeleton rows={5} />;
  const all = data.candidates.length > 0 && picked.size === data.candidates.length;
  const toggle = (id) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  async function create(e) {
    e.preventDefault();
    if (!picked.size) return setErrors({ form: 'Tick the RMAs going in this dispatch.' });
    setBusy(true);
    setErrors({});
    try {
      const r = await post('/api/batches', { ...f, ticketIds: [...picked] });
      onChange?.();
      toast(`${r.batch.batch_code} created — ${r.tickets.length} RMA${r.tickets.length === 1 ? '' : 's'} dispatched to OEM`);
      await packingList(r.batch, r.tickets, user.company.name).catch(() => {});
      navigate(`/batches/${r.batch.batch_code}`);
    } catch (err) {
      setErrors({ form: err.message, ...(err.fields || {}) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-head">
        <div><h1>OEM batches</h1><p className="muted">RMAs with an OEM RMA # are sent to the OEM together, usually in the last week of the month.</p></div>
      </div>
      <div className="grid2">
        <section className="panel">
          <h2>Ready to dispatch ({data.candidates.length})</h2>
          {!data.candidates.length ? <p className="muted">Nothing waiting. RMAs appear here once their OEM RMA # is entered.</p> : (
            <form className="stack" onSubmit={create} noValidate>
              {errors.form && <div className="formerror">{errors.form}</div>}
              <label className="check"><input type="checkbox" checked={all} onChange={() => setPicked(all ? new Set() : new Set(data.candidates.map((c) => c.id)))} />Select all</label>
              <div className="tlist">
                {data.candidates.map((t) => (
                  <label key={t.id} className="tcard" data-s="OEM_RMA_RECEIVED" style={{ gridTemplateColumns: 'auto 1fr', display: 'grid', alignItems: 'center', gap: 12, cursor: 'pointer' }}>
                    <input type="checkbox" checked={picked.has(t.id)} onChange={() => toggle(t.id)} style={{ width: 20, height: 20, accentColor: 'var(--accent)' }} />
                    <span style={{ minWidth: 0 }}>
                      <span className="no">{t.ticket_no}</span> <span className="muted small">· OEM {t.oem_rma_number}</span>
                      <span className="meta" style={{ display: 'block' }}>{t.customer_company} · {[t.printer_model, t.printer_sn, t.faulty_part].filter(Boolean).join(' · ')}</span>
                    </span>
                  </label>
                ))}
              </div>
              {can.edit(user) && <>
                <div className="fields">
                  <Field label="Dispatch date" required error={errors.dispatch_date}><input type="date" max={todayISO()} value={f.dispatch_date} onChange={(e) => setF({ ...f, dispatch_date: e.target.value })} /></Field>
                  <Field label="Courier"><input type="text" value={f.courier} onChange={(e) => setF({ ...f, courier: e.target.value })} /></Field>
                  <Field label="Docket / AWB number"><input type="text" value={f.docket} onChange={(e) => setF({ ...f, docket: e.target.value })} /></Field>
                  <Field label="Remarks"><input type="text" value={f.remarks} onChange={(e) => setF({ ...f, remarks: e.target.value })} /></Field>
                </div>
                <button className="btn primary block" disabled={busy || !picked.size}><Icon name="truck" size={18} />
                  {busy ? 'Creating…' : `Dispatch ${picked.size || ''} to OEM and download packing list`}</button>
              </>}
            </form>
          )}
        </section>
        <section className="panel">
          <h2>Past batches</h2>
          {!data.batches.length ? <p className="muted">No batches yet.</p> : (
            <div className="tlist">
              {data.batches.map((b) => (
                <Link key={b.id} to={`/batches/${b.batch_code}`} className="tcard" data-s="DISPATCHED_TO_OEM">
                  <div className="top"><span className="no">{b.batch_code}</span><span className="pill">{b.total} RMA{b.total === 1 ? '' : 's'}</span></div>
                  <span className="meta">Dispatched {fmtDate(b.dispatch_date)}{b.courier ? ` · ${b.courier}` : ''}{b.docket ? ` ${b.docket}` : ''} · by {b.created_by}</span>
                </Link>
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  );
}

function BatchDetail({ code, user }) {
  const toast = useToast();
  const [data, reload, error] = useLoad(() => get(`/api/batches/${code}`), [code]);
  if (error && !data) return <ErrorPanel error={error} retry={reload} />;
  if (!data) return <Skeleton rows={4} />;
  const { batch: b, tickets } = data;
  return (
    <>
      <div className="page-head">
        <div>
          <Link to="/batches" className="small muted" style={{ textDecoration: 'none' }}>← OEM batches</Link>
          <h1 className="mono">{b.batch_code}</h1>
          <p className="muted">Dispatched {fmtDate(b.dispatch_date)}{b.courier ? ` · ${b.courier}` : ''}{b.docket ? ` · ${b.docket}` : ''} · created by {b.created_by}</p>
          {b.remarks && <p style={{ marginTop: 4 }}>{b.remarks}</p>}
        </div>
        <button className="btn primary" onClick={() => packingList(b, tickets, user.company.name).catch((e) => toast(e.message, true))}>
          <Icon name="download" size={18} /> Packing list</button>
      </div>
      {!tickets.length ? <Empty title="No RMAs in this batch" /> : (
        <div className="tablewrap">
          <table className="data">
            <thead><tr><th>#</th><th>Ticket</th><th>Status now</th><th>OEM RMA #</th><th>Model / serial</th><th>Part</th><th>Customer</th></tr></thead>
            <tbody>
              {tickets.map((t, i) => (
                <tr key={t.id}>
                  <td className="num">{i + 1}</td>
                  <td><Link to={`/rma/${t.id}`} className="mono">{t.ticket_no}</Link></td>
                  <td><Status s={t.status} /></td>
                  <td className="mono">{t.oem_rma_number}</td>
                  <td>{t.printer_model}<div className="tiny muted mono">{t.printer_sn}</div></td>
                  <td>{t.faulty_part}<div className="tiny muted mono">{t.faulty_part_sn}</div></td>
                  <td>{t.customer_company}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
