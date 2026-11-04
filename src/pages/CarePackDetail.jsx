import { useState } from 'react';
import { api, downloadBlob, get, post } from '../api.js';
import { writeTable } from '../excel.js';
import { crossValidate } from '../../worker/catalog.js';
import { Dialog, ErrorPanel, Field, Icon, Link, Skeleton, Status, can, fmtDate, fmtMs, navigate, todayISO, useLoad, useToast } from '../ui.jsx';

export default function CarePackDetail({ user, boot, id }) {
  const toast = useToast();
  const [data, reload, error] = useLoad(() => get(`/api/carepack/${id}`), [id]);
  const [dlg, setDlg] = useState(null); // product | header | override | serials | remove:<kind> | delete
  const [busy, setBusy] = useState(false);
  if (error && !data) return <ErrorPanel error={error} retry={reload} />;
  if (!data) return <Skeleton rows={6} />;
  const { batch: b, devices, audits, rmas, gates } = data;
  const edit = can.edit(user);
  const admin = can.admin(user);

  async function run(fn, ok) {
    setBusy(true);
    try {
      const r = await fn();
      if (ok) toast(ok);
      setDlg(null);
      reload();
      return r;
    } catch (e) {
      toast(e.message, true);
      return null;
    } finally { setBusy(false); }
  }
  async function uploadPdf(file) {
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) { toast('PDF is larger than 15 MB.', true); return; }
    await run(() => api('POST', `/api/carepack/${b.id}/pdf`, file, { headers: { 'X-File-Name': encodeURIComponent(file.name), 'Content-Type': 'application/pdf' } }), 'OEM invoice PDF saved.');
  }
  async function openPdf() {
    try {
      const res = await api('GET', `/api/carepack/${b.id}/pdf`, undefined, { raw: true });
      const url = URL.createObjectURL(await res.blob());
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) { toast(e.message, true); }
  }
  async function report() {
    const inv = devices.map((d) => d.serial_number);
    const cross = crossValidate(inv, b.po_serials || []);
    const onPo = new Set(cross.matched);
    const rows = [
      ...inv.map((sn) => [sn, 'Yes', onPo.has(sn) ? 'Yes' : 'No', onPo.has(sn) ? 'Matched' : 'Missing from PO']),
      ...cross.onlyInPo.map((sn) => [sn, 'No', 'Yes', 'On PO only (other invoice / clubbed)']),
    ];
    const blob = await writeTable({ sheet: 'Validation', title: `PO validation — invoice ${b.invoice_number} / PO ${b.po_number}`,
      subtitle: `${b.customer_name || ''} · ${b.oem_brand} ${b.printer_model} · ${cross.matched.length} of ${inv.length} invoice serials on PO · ${b.po_notes || ''}`,
      headers: ['Serial', 'On sales invoice', 'On OEM PO', 'Result'], rows, widths: [26, 16, 14, 40] });
    downloadBlob(blob, `PO_Validation_${b.invoice_number}_${b.po_number}.xlsx`.replace(/[^\w.-]/g, '_'));
  }

  const steps = [['Registered', true], ['OEM PO', !!b.po_number], ['OEM invoice', !!b.oem_invoice_number], ['Invoice PDF', !!b.oem_pdf_name], ['Verified', !!b.verified], ['Paid', !!b.oem_paid]];
  return (
    <>
      <div className="page-head">
        <div>
          <Link to="/care-packs" className="small muted" style={{ textDecoration: 'none' }}>← Care packs</Link>
          <h1 className="cp-head">{b.invoice_number}{b.line_set_index > 1 && <span className="muted"> · set #{b.line_set_index}</span>}
            <span className={`pill ${b.verified ? 'ok' : b.po_number ? '' : 'warn'}`}>{b.status_label}</span>
            {b.overridden ? <span className="pill warn">Override</span> : null}{b.expired && <span className="pill bad">Expired</span>}</h1>
          <p className="muted">{b.customer_name || '—'}{b.customer_city ? `, ${b.customer_city}` : ''} · {b.oem_brand} {b.printer_model} · {b.care_pack_type}</p>
          <div className="flowline">{steps.map(([l, d]) => <span key={l} className={d ? 'done' : ''}>{d ? '✓ ' : ''}{l}</span>)}</div>
        </div>
        <div className="row">
          {edit && <button className="btn ghost small" onClick={() => setDlg('product')}><Icon name="edit" size={16} /> Brand / model / period</button>}
          {admin && <button className="btn ghost small" onClick={() => setDlg('header')}>Edit invoice</button>}
          {admin && <button className="btn ghost small" onClick={() => setDlg('override')}>Override</button>}
          {admin && <button className="btn danger small" disabled={!data.canDelete} title={data.deleteHint} onClick={() => setDlg('delete')}><Icon name="trash" size={16} /> Delete</button>}
        </div>
      </div>

      {b.po_due && <div className={b.po_days < 0 ? 'formerror' : 'warnbox'}>OEM PO {b.po_days < 0 ? `overdue by ${-b.po_days} day(s)` : `due in ${b.po_days} day(s)`} — by {fmtDate(b.po_due)}.</div>}
      {b.pay_due && b.oem_invoice_number && <div className={b.pay_days < 0 ? 'formerror' : 'warnbox'} style={{ marginTop: 8 }}>OEM payment {b.pay_days < 0 ? `overdue by ${-b.pay_days} day(s)` : `due in ${b.pay_days} day(s)`} — by {fmtDate(b.pay_due)}.</div>}
      {b.overridden && data.sample?.override_reason ? <div className="warnbox" style={{ marginTop: 8 }}>Override by {data.sample.override_by} on {fmtMs(data.sample.override_at)}: {data.sample.override_reason}</div> : null}

      <div className="grid2" style={{ marginTop: 14 }}>
        <section className="panel">
          <h2>Sales invoice</h2>
          <dl className="kv">
            <dt>Invoice</dt><dd>{b.invoice_number}{b.source_invoice_number ? ` (source ${b.source_invoice_number})` : ''}</dd>
            <dt>Date</dt><dd>{fmtDate(b.invoice_date)}</dd>
            <dt>Customer</dt><dd>{b.customer_name || '—'}</dd>
            <dt>Printer item</dt><dd>{b.printer_item_name || '—'}</dd>
            <dt>Care pack item</dt><dd>{b.invoice_item_name || '—'}</dd>
            <dt>Brand on invoice</dt><dd>{b.invoice_brand_detected || '—'}</dd>
            <dt>Cover</dt><dd>{b.care_pack_type} · till <b>{fmtDate(b.warranty_end)}</b></dd>
            <dt>Qty / devices</dt><dd>{b.invoice_qty} / {b.device_count}</dd>
            {b.irn && <><dt>IRN</dt><dd className="mono small">{b.irn}</dd></>}
            <dt>Source</dt><dd>{b.source === 'zoho' ? 'Zoho Books' : b.source === 'pdf' ? 'Invoice PDF' : 'Typed in'} · {b.created_by} · {fmtMs(b.created_at)}</dd>
            {b.notes && <><dt>Notes</dt><dd>{b.notes}</dd></>}
          </dl>
        </section>

        <section className="panel">
          <div className="spread"><h2>OEM PO</h2>
            {edit && !b.po_number && <Link to={`/care-packs/${b.id}/po`} className="btn primary small">Link OEM PO</Link>}
            {b.po_number && b.po_serials?.length > 0 && <button className="btn ghost small" onClick={report}><Icon name="download" size={16} /> Validation report</button>}</div>
          {b.po_number ? (
            <dl className="kv">
              <dt>PO</dt><dd className="mono">{b.po_number}</dd>
              <dt>Vendor</dt><dd>{b.po_vendor || '—'}</dd>
              <dt>PO date</dt><dd>{fmtDate(b.po_date)}</dd>
              <dt>Serial check</dt><dd>{b.po_matched ? <span className="pill ok">All serials on PO</span> : <span className="pill warn">Not fully matched</span>}</dd>
              <dt>Linked by</dt><dd>{b.po_validated_by} · {fmtMs(b.po_validated_at)}</dd>
              <dt>Source</dt><dd>{b.po_source || '—'}</dd>
              <dt>Notes</dt><dd>{b.po_notes || '—'}</dd>
            </dl>
          ) : <p className="muted">No OEM PO linked yet. Link it within the PO deadline.</p>}
        </section>
      </div>

      <OemInvoice b={b} edit={edit} admin={admin} busy={busy} run={run} uploadPdf={uploadPdf} openPdf={openPdf} />

      <section className="panel">
        <div className="spread"><h2>Printers ({devices.length})</h2>
          {data.canEditDevices && <button className="btn ghost small" onClick={() => setDlg('serials')}><Icon name="edit" size={16} /> Change serials</button>}</div>
        {!data.canEditDevices && <p className="tiny muted">Serials are locked once an OEM PO is linked.</p>}
        <div className="tablewrap" style={{ boxShadow: 'none', maxHeight: 420 }}>
          <table className="data"><thead><tr><th>Serial</th><th>Model</th><th>Brand</th><th>Care pack</th><th>Cover till</th></tr></thead>
            <tbody>{devices.map((d) => (
              <tr key={d.id}><td className="mono">{d.serial_number}{d.overridden ? <span className="pill warn" style={{ marginLeft: 6 }}>Override</span> : null}</td>
                <td>{d.original_model}</td><td>{d.oem_brand}</td><td>{d.care_pack_type}</td>
                <td className="nowrap">{d.expired ? <span className="pill bad">Expired {fmtDate(d.warranty_end)}</span> : fmtDate(d.warranty_end)}</td></tr>))}</tbody>
          </table>
        </div>
      </section>

      {rmas.length > 0 && (
        <section className="panel"><h2>RMAs on these printers</h2>
          <div className="tlist">{rmas.map((r) => (
            <Link key={r.id} to={`/rma/${r.id}`} className="mrow"><span><b>{r.ticket_no}</b> <span className="muted small">{r.printer_sn} · {r.faulty_part}</span></span><Status s={r.status} /></Link>))}</div>
        </section>
      )}

      {admin && (
        <section className="panel"><h2>Remove OEM documents</h2>
          <p className="small muted">Order: payment → OEM invoice → PO. Each removal needs a reason and is logged permanently.</p>
          <div className="row" style={{ marginTop: 8 }}>
            {[['payment', 'Remove payment'], ['invoice', 'Remove OEM invoice'], ['po', 'Remove PO']].map(([k, l]) => (
              <button key={k} className="btn ghost small" disabled={!gates[k].ok} title={gates[k].reason} onClick={() => setDlg(`remove:${k}`)}>{l}</button>))}
          </div>
          {audits.length > 0 && (
            <div className="tablewrap" style={{ boxShadow: 'none', marginTop: 12 }}><table className="data">
              <thead><tr><th>Removed</th><th>By</th><th>When</th><th>Reason</th><th>Was</th></tr></thead>
              <tbody>{audits.map((a) => <tr key={a.id}><td>{a.action}</td><td>{a.by_name}</td><td className="nowrap">{fmtMs(a.at, true)}</td><td className="small">{a.reason}</td><td className="small mono">{a.snapshot}</td></tr>)}</tbody>
            </table></div>)}
        </section>
      )}

      <ProductDialog open={dlg === 'product'} b={b} boot={boot} busy={busy} onClose={() => setDlg(null)}
        onSave={(v) => run(() => post(`/api/carepack/${b.id}/product`, v), 'Brand, model and period updated. Cover dates recalculated.')} />
      <HeaderDialog open={dlg === 'header'} b={b} busy={busy} onClose={() => setDlg(null)}
        onSave={(v) => run(() => post(`/api/carepack/${b.id}/header`, v), 'Invoice details updated.')} />
      <OverrideDialog open={dlg === 'override'} b={b} boot={boot} busy={busy} onClose={() => setDlg(null)}
        onSave={(v) => run(() => post(`/api/carepack/${b.id}/override`, v), 'Override applied and logged.')} />
      <SerialsDialog open={dlg === 'serials'} b={b} devices={devices} busy={busy} onClose={() => setDlg(null)}
        onSave={(v) => run(() => post(`/api/carepack/${b.id}/serials`, v), 'Serial numbers updated.')} />
      {dlg?.startsWith('remove:') && <RemoveDialog kind={dlg.slice(7)} busy={busy} onClose={() => setDlg(null)}
        onSave={(v) => run(() => post(`/api/carepack/${b.id}/remove`, { ...v, kind: dlg.slice(7) }), 'Removed and logged.')} />}
      <Dialog open={dlg === 'delete'} onClose={() => setDlg(null)} title={`Delete ${b.invoice_number}?`}>
        <p>This removes the invoice set and its {devices.length} printer serial(s) from the registry.</p>
        <div className="row end"><button className="btn ghost" onClick={() => setDlg(null)}>Cancel</button>
          <button className="btn danger" disabled={busy} onClick={async () => {
            const r = await run(() => post('/api/carepack/delete', { ids: [b.id] }));
            if (r?.deleted) { toast('Deleted.'); navigate('/care-packs'); } else if (r) toast(r.skipped[0] || 'Not deleted.', true);
          }}>Delete</button></div>
      </Dialog>
    </>
  );
}

function OemInvoice({ b, edit, admin, busy, run, uploadPdf, openPdf }) {
  const [f, setF] = useState(null);
  const v = f || { oem_invoice_number: b.oem_invoice_number || '', oem_invoice_date: b.oem_invoice_date || '', installation_date: b.installation_date || '',
    oem_amount: b.oem_amount ?? '', oem_currency: b.oem_currency || 'USD' };
  const set = (k, x) => setF({ ...v, [k]: x });
  if (!b.po_number) {
    return <section className="panel" style={{ marginTop: 14 }}><h2>OEM invoice & payment</h2><p className="muted">Available after the OEM PO is linked.</p></section>;
  }
  return (
    <section className="panel" style={{ marginTop: 14 }}>
      <div className="spread"><h2>OEM invoice & payment</h2>
        {b.oem_paid ? <span className="pill ok">Paid · {fmtMs(b.oem_paid_at)} · {b.oem_paid_by}</span> : b.oem_invoice_number ? <span className="pill bad">Not paid</span> : null}</div>
      <form className="fields" onSubmit={(e) => { e.preventDefault(); run(() => post(`/api/carepack/${b.id}/oem`, { ...v, oem_amount: v.oem_amount === '' ? null : Number(v.oem_amount) }), 'OEM invoice saved.').then(() => setF(null)); }}>
        <Field label="OEM invoice number"><input type="text" value={v.oem_invoice_number} disabled={!edit} onChange={(e) => set('oem_invoice_number', e.target.value)} /></Field>
        <Field label="OEM invoice date"><input type="date" max={todayISO()} value={v.oem_invoice_date} disabled={!edit} onChange={(e) => set('oem_invoice_date', e.target.value)} /></Field>
        <Field label="Amount"><input type="text" inputMode="decimal" value={v.oem_amount} disabled={!edit} onChange={(e) => set('oem_amount', e.target.value.replace(/[^\d.]/g, ''))} /></Field>
        <Field label="Currency"><select value={v.oem_currency} disabled={!edit} onChange={(e) => set('oem_currency', e.target.value)}><option>USD</option><option>INR</option></select></Field>
        <Field label="Installation date (optional)"><input type="date" value={v.installation_date} disabled={!edit} onChange={(e) => set('installation_date', e.target.value)} /></Field>
        {edit && <div className="wide row"><button className="btn primary" disabled={busy || !f}>Save OEM invoice</button></div>}
      </form>
      <div className="row" style={{ marginTop: 14 }}>
        {b.oem_pdf_name ? <button className="btn ghost small" onClick={openPdf}><Icon name="file" size={16} /> {b.oem_pdf_name}</button> : <span className="muted small">No OEM invoice PDF yet.</span>}
        {edit && <label className="btn ghost small" style={{ cursor: 'pointer' }}><Icon name="upload" size={16} /> {b.oem_pdf_name ? 'Replace PDF' : 'Upload PDF'}
          <input type="file" accept="application/pdf,.pdf" hidden onChange={(e) => { uploadPdf(e.target.files?.[0]); e.target.value = ''; }} /></label>}
        <span style={{ flex: 1 }} />
        {edit && b.oem_invoice_number && !b.oem_paid && <button className="btn primary small" disabled={busy} onClick={() => run(() => post(`/api/carepack/${b.id}/paid`, { paid: true }), 'Marked as paid.')}>Mark paid</button>}
        {admin && b.oem_paid ? <span className="tiny muted">To undo, use Remove payment below.</span> : null}
      </div>
    </section>
  );
}

function ProductDialog({ open, b, boot, busy, onClose, onSave }) {
  const [v, setV] = useState(null);
  const x = v || { oem_brand: b.oem_brand || '', printer_model: b.printer_model || '', care_pack_type: b.care_pack_type || '', note: '' };
  const types = (boot.masters.cp_types || []).filter((t) => t.active).map((t) => t.name);
  return (
    <Dialog open={open} onClose={() => { setV(null); onClose(); }} title="Brand, model and care pack period">
      <form className="stack" onSubmit={(e) => { e.preventDefault(); onSave(x); setV(null); }}>
        <Field label="OEM brand" required><select value={x.oem_brand} onChange={(e) => setV({ ...x, oem_brand: e.target.value })}>{(boot.carePack?.brands || []).map((o) => <option key={o}>{o}</option>)}</select></Field>
        <Field label="Printer model"><input type="text" value={x.printer_model} onChange={(e) => setV({ ...x, printer_model: e.target.value })} /></Field>
        <Field label="Care pack period" required><select value={x.care_pack_type} onChange={(e) => setV({ ...x, care_pack_type: e.target.value })}>
          {[...new Set([...types, x.care_pack_type].filter(Boolean))].map((o) => <option key={o}>{o}</option>)}</select></Field>
        <Field label="Note"><input type="text" value={x.note} onChange={(e) => setV({ ...x, note: e.target.value })} /></Field>
        <p className="tiny muted">Cover end dates are recalculated from the sales invoice date.</p>
        <div className="row end"><button type="button" className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy}>Save</button></div>
      </form>
    </Dialog>
  );
}

function HeaderDialog({ open, b, busy, onClose, onSave }) {
  const [v, setV] = useState(null);
  const x = v || { invoice_number: b.invoice_number, customer_name: b.customer_name || '', invoice_item_name: b.invoice_item_name || '', invoice_date: b.invoice_date || '', note: '' };
  return (
    <Dialog open={open} onClose={() => { setV(null); onClose(); }} title="Edit sales invoice (Admin)">
      <form className="stack" onSubmit={(e) => { e.preventDefault(); onSave(x); setV(null); }}>
        <Field label="Invoice number" required><input type="text" value={x.invoice_number} onChange={(e) => setV({ ...x, invoice_number: e.target.value })} /></Field>
        <Field label="Customer"><input type="text" value={x.customer_name} onChange={(e) => setV({ ...x, customer_name: e.target.value })} /></Field>
        <Field label="Care pack item name"><input type="text" value={x.invoice_item_name} onChange={(e) => setV({ ...x, invoice_item_name: e.target.value })} /></Field>
        <Field label="Invoice date"><input type="date" max={todayISO()} value={x.invoice_date} onChange={(e) => setV({ ...x, invoice_date: e.target.value })} /></Field>
        <Field label="Note for the log"><input type="text" value={x.note} onChange={(e) => setV({ ...x, note: e.target.value })} /></Field>
        <div className="row end"><button type="button" className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy}>Save</button></div>
      </form>
    </Dialog>
  );
}

function OverrideDialog({ open, b, boot, busy, onClose, onSave }) {
  const [v, setV] = useState(null);
  const x = v || { oem_brand: b.oem_brand || '', printer_model: b.printer_model || '', care_pack_type: b.care_pack_type || '', reason: '', confirmed: false };
  return (
    <Dialog open={open} onClose={() => { setV(null); onClose(); }} title="Admin override">
      <form className="stack" onSubmit={(e) => { e.preventDefault(); onSave(x); setV(null); }}>
        <p className="small muted">Use when the brand on the sales invoice is wrong or does not match the printer. Every printer in this set is marked overridden.</p>
        <Field label="OEM brand" required><select value={x.oem_brand} onChange={(e) => setV({ ...x, oem_brand: e.target.value })}>{(boot.carePack?.brands || []).map((o) => <option key={o}>{o}</option>)}</select></Field>
        <Field label="Printer model"><input type="text" value={x.printer_model} onChange={(e) => setV({ ...x, printer_model: e.target.value })} /></Field>
        <Field label="Care pack period"><input type="text" value={x.care_pack_type} onChange={(e) => setV({ ...x, care_pack_type: e.target.value })} list="cp-types-dl" /></Field>
        <datalist id="cp-types-dl">{(boot.masters.cp_types || []).map((t) => <option key={t.id} value={t.name} />)}</datalist>
        <Field label="Reason" required><textarea rows={2} value={x.reason} onChange={(e) => setV({ ...x, reason: e.target.value })} /></Field>
        <label className="check"><input type="checkbox" checked={x.confirmed} onChange={(e) => setV({ ...x, confirmed: e.target.checked })} /> I confirm this override.</label>
        <div className="row end"><button type="button" className="btn ghost" onClick={onClose}>Cancel</button><button className="btn danger" disabled={busy || !x.reason.trim() || !x.confirmed}>Apply override</button></div>
      </form>
    </Dialog>
  );
}

function SerialsDialog({ open, b, devices, busy, onClose, onSave }) {
  const [v, setV] = useState(null);
  const x = v || { serial_text: devices.map((d) => d.serial_number).join('\n'), qty: String(b.invoice_qty || devices.length), reason: '' };
  return (
    <Dialog open={open} onClose={() => { setV(null); onClose(); }} title="Change printer serials">
      <form className="stack" onSubmit={(e) => { e.preventDefault(); onSave({ ...x, qty: Number(x.qty) || undefined }); setV(null); }}>
        <Field label="Serial numbers" hint="One per line. Replaces the full list."><textarea rows={10} className="mono" value={x.serial_text} onChange={(e) => setV({ ...x, serial_text: e.target.value })} /></Field>
        <Field label="Qty"><input type="text" inputMode="numeric" value={x.qty} onChange={(e) => setV({ ...x, qty: e.target.value.replace(/\D/g, '') })} /></Field>
        <Field label="Reason"><input type="text" value={x.reason} onChange={(e) => setV({ ...x, reason: e.target.value })} /></Field>
        <div className="row end"><button type="button" className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy}>Save serials</button></div>
      </form>
    </Dialog>
  );
}

function RemoveDialog({ kind, busy, onClose, onSave }) {
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const label = { payment: 'OEM payment', invoice: 'OEM invoice (and its PDF)', po: 'OEM PO link' }[kind];
  return (
    <Dialog open onClose={onClose} title={`Remove ${label}?`}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); onSave({ reason, confirmed }); }}>
        <Field label="Reason" required><textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <label className="check"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> I understand this is logged and cannot be undone.</label>
        <div className="row end"><button type="button" className="btn ghost" onClick={onClose}>Cancel</button><button className="btn danger" disabled={busy || !reason.trim() || !confirmed}>Remove</button></div>
      </form>
    </Dialog>
  );
}
