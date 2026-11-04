import { useState } from 'react';
import { get, post, qs } from '../api.js';
import { readTable } from '../excel.js';
import { pdfText } from '../pdftext.js';
import { serialsFromAnything } from '../../worker/catalog.js';
import { ErrorPanel, Field, Icon, Link, Skeleton, can, fmtDate, navigate, useLoad, useToast } from '../ui.jsx';

export default function CarePackPo({ user, id }) {
  const toast = useToast();
  const [data, reload, error] = useLoad(() => get(`/api/carepack/${id}/po-candidates`), [id]);
  const [mode, setMode] = useState('manual');
  const [links, setLinks] = useState(new Set());
  const [po, setPo] = useState({ number: '', vendor: '', ref: '', currency: 'USD', qty: '', date: '' });
  const [zq, setZq] = useState('');
  const [zpos, setZpos] = useState(null);
  const [zpick, setZpick] = useState(null);
  const [serialText, setSerialText] = useState('');
  const [serialSource, setSerialSource] = useState('Manual entry');
  const [preview, setPreview] = useState(null);
  const [accept, setAccept] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState('');
  const [formError, setFormError] = useState('');
  if (error && !data) return <ErrorPanel error={error} retry={reload} />;
  if (!data) return <Skeleton rows={5} />;
  const { batch: b, candidates } = data;
  if (b.po_number) return <div className="panel"><p>This invoice already has PO <b>{b.po_number}</b>. <Link to={`/care-packs/${b.id}`}>Back to the care pack</Link></p></div>;
  const serials = serialsFromAnything(serialText);
  const reset = () => { setPreview(null); setAccept(false); };

  async function findZoho(number) {
    setBusy('zoho');
    setFormError('');
    try {
      const r = await get(`/api/carepack/zoho-pos?${qs({ number, invoice: b.invoice_number })}`);
      setZpos(r.pos);
      if (number && r.pos.length === 1) setZpick(r.pos[0]);
    } catch (e) { setFormError(e.message); } finally { setBusy(''); }
  }
  async function readFile(file) {
    if (!file) return;
    setBusy('file');
    try {
      let text;
      if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') text = await pdfText(file);
      else {
        const t = await readTable(file);
        text = [t.columns.join('\n'), ...t.rows.map((r) => Object.values(r).join('\n'))].join('\n');
      }
      const found = serialsFromAnything(text);
      if (!found.length) throw new Error('No serial numbers found in that file. Paste them instead.');
      setSerialText(found.join('\n'));
      setSerialSource(file.name);
      reset();
      toast(`${found.length} serial(s) read from ${file.name}.`);
    } catch (e) { toast(e.message, true); } finally { setBusy(''); }
  }
  const payload = () => ({ batchId: b.id, linkIds: [...links], mode, po: { ...po, qty: po.qty ? Number(po.qty) : undefined }, zohoPoId: zpick?.id,
    serials, serialSource: serials.length ? serialSource : undefined });
  async function doPreview() {
    setBusy('preview');
    setFormError('');
    try { setPreview(await post('/api/carepack/po-preview', payload())); } catch (e) { setFormError(e.message); setPreview(null); } finally { setBusy(''); }
  }
  async function confirm() {
    setBusy('confirm');
    setFormError('');
    try {
      const r = await post('/api/carepack/po-confirm', { ...payload(), acceptAnyway: accept, reason });
      toast(`PO ${r.po} linked to ${r.linked} invoice(s).`);
      navigate(`/care-packs/${b.id}`);
    } catch (e) { setFormError(e.message); } finally { setBusy(''); }
  }
  const poOnly = mode === 'manual' && !serials.length;
  const needAccept = preview && !preview.allMatch;
  return (
    <>
      <div className="page-head"><div>
        <Link to={`/care-packs/${b.id}`} className="small muted" style={{ textDecoration: 'none' }}>← {b.invoice_number}</Link>
        <h1>Link OEM PO</h1>
        <p className="muted">{b.customer_name} · {b.oem_brand} {b.printer_model} · {b.device_count} printer(s). The printer serials on the invoice are checked against the PO.</p>
      </div></div>
      {formError && <div className="formerror" role="alert">{formError}</div>}

      <section className="panel">
        <h2>Other invoices on the same OEM PO</h2>
        <p className="small muted">Tick invoices that the OEM clubbed on this PO. Same-customer invoices are listed first.</p>
        {!candidates.length ? <p className="muted small">No other invoices without a PO.</p> : (
          <div className="tablewrap" style={{ boxShadow: 'none', maxHeight: 260 }}><table className="data"><tbody>{candidates.map((c) => (
            <tr key={c.id}><td><input type="checkbox" aria-label={`Club ${c.invoice_number}`} checked={links.has(c.id)} onChange={(e) => {
              const s = new Set(links); if (e.target.checked) s.add(c.id); else s.delete(c.id); setLinks(s); reset();
            }} /></td><td className="mono">{c.invoice_number}{c.line_set_index > 1 ? ` #${c.line_set_index}` : ''}</td><td>{c.customer_name}</td><td>{c.printer_model}</td>
              <td className="num">{c.device_count}</td><td className="nowrap">{fmtDate(c.invoice_date)}</td></tr>))}</tbody></table></div>)}
      </section>

      <section className="panel">
        <div className="tabs" role="tablist">
          {[['manual', 'Enter PO details'], ['zoho', 'Pick from Zoho Books']].map(([k, l]) => <button type="button" key={k} role="tab" aria-selected={mode === k} onClick={() => { setMode(k); reset(); }}>{l}</button>)}
        </div>
        {mode === 'manual' ? (
          <div className="fields">
            <Field label="PO number" required><input type="text" value={po.number} onChange={(e) => { setPo({ ...po, number: e.target.value }); reset(); }} /></Field>
            <Field label="Vendor (OEM)"><input type="text" value={po.vendor} onChange={(e) => { setPo({ ...po, vendor: e.target.value }); reset(); }} /></Field>
            <Field label="PO date"><input type="date" value={po.date} onChange={(e) => { setPo({ ...po, date: e.target.value }); reset(); }} /></Field>
            <Field label="PO qty"><input type="text" inputMode="numeric" value={po.qty} onChange={(e) => { setPo({ ...po, qty: e.target.value.replace(/\D/g, '') }); reset(); }} /></Field>
            <Field label="Reference #"><input type="text" value={po.ref} onChange={(e) => { setPo({ ...po, ref: e.target.value }); reset(); }} /></Field>
            <Field label="Currency"><select value={po.currency} onChange={(e) => { setPo({ ...po, currency: e.target.value }); reset(); }}><option>USD</option><option>INR</option></select></Field>
          </div>
        ) : (
          <div className="stack">
            <div className="row" style={{ alignItems: 'flex-end' }}>
              <Field label="PO number (blank = list recent OEM POs)" className="wide"><input type="text" value={zq} onChange={(e) => setZq(e.target.value)} /></Field>
              <button type="button" className="btn primary" disabled={busy === 'zoho'} onClick={() => findZoho(zq.trim())}>{busy === 'zoho' ? 'Searching…' : 'Find'}</button>
            </div>
            {zpos && (
              <div className="tablewrap" style={{ boxShadow: 'none', maxHeight: 300 }}><table className="data">
                <thead><tr><th /><th>PO</th><th>Vendor</th><th>Ref</th><th>Date</th><th>Qty</th><th>Status</th></tr></thead>
                <tbody>{zpos.map((p) => (
                  <tr key={p.id}><td><input type="radio" name="zpo" checked={zpick?.id === p.id} onChange={() => { setZpick(p); reset(); }} aria-label={`Use ${p.number}`} /></td>
                    <td className="mono">{p.number}</td><td>{p.vendorName}</td><td>{p.reference}</td><td className="nowrap">{fmtDate(p.date)}</td><td className="num">{p.quantity || ''}</td><td>{p.status}</td></tr>))}</tbody>
              </table></div>)}
          </div>
        )}
      </section>

      <section className="panel">
        <h2>Serial numbers on the PO</h2>
        <p className="small muted">Paste them, or read them from the PO's XLSX / CSV / PDF attachment.{mode === 'zoho' ? ' Leave blank to use serials written in the Zoho PO lines.' : ''}</p>
        <label className="btn ghost small" style={{ cursor: 'pointer', margin: '8px 0' }}><Icon name="upload" size={16} /> {busy === 'file' ? 'Reading…' : 'Read from file'}
          <input type="file" accept=".xlsx,.csv,.pdf,application/pdf" hidden onChange={(e) => { readFile(e.target.files?.[0]); e.target.value = ''; }} /></label>
        <Field label={`PO serials (${serials.length} found)`}><textarea rows={6} className="mono" value={serialText} onChange={(e) => { setSerialText(e.target.value); setSerialSource('Manual entry'); reset(); }} /></Field>
        <div className="row" style={{ marginTop: 10 }}><button type="button" className="btn primary" disabled={busy === 'preview' || (mode === 'manual' ? !po.number.trim() : !zpick)} onClick={doPreview}>
          {busy === 'preview' ? 'Checking…' : 'Check against invoice'}</button></div>
      </section>

      {preview && (
        <section className="panel">
          <h2>Check — PO {preview.po.number}</h2>
          {preview.allMatch ? <div className="notice">All invoice serials are on this PO.</div> : null}
          {preview.warnings.map((w) => <div key={w} className="warnbox small" style={{ marginTop: 6 }}>{w}</div>)}
          <div className="tablewrap" style={{ boxShadow: 'none', marginTop: 10 }}><table className="data">
            <thead><tr><th>Invoice</th><th>Customer</th><th>Printers</th><th>On PO</th><th>Missing from PO</th></tr></thead>
            <tbody>{preview.matches.map((m) => (
              <tr key={m.id}><td className="mono">{m.invoice_number}{m.late && <span className="pill warn" style={{ marginLeft: 6 }}>Late</span>}</td><td>{m.customer_name}</td>
                <td className="num">{m.device_count}</td><td>{m.perfect ? <span className="pill ok">{m.matched} ✓</span> : m.matched}</td>
                <td className="mono small">{m.missing.slice(0, 20).join(', ')}{m.missing.length > 20 ? ` …+${m.missing.length - 20}` : ''}</td></tr>))}</tbody>
          </table></div>
          {needAccept && (
            <div className="stack" style={{ marginTop: 12 }}>
              <label className="check"><input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} />
                {poOnly ? ' Link the PO number only (serials not checked)' : ` Accept anyway — Admin only${can.admin(user) ? '' : ' (ask an Admin)'}`}</label>
              {accept && <Field label="Reason" required><input type="text" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
            </div>
          )}
          <div className="row end" style={{ marginTop: 12 }}>
            <button type="button" className="btn primary" disabled={busy === 'confirm' || (needAccept && (!accept || !reason.trim()))} onClick={confirm}>
              {busy === 'confirm' ? 'Linking…' : `Link PO to ${preview.matches.length} invoice(s)`}</button>
          </div>
        </section>
      )}
    </>
  );
}
