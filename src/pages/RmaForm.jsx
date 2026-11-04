import { useEffect, useMemo, useRef, useState } from 'react';
import { get, post, uploadPhoto } from '../api.js';
import { ErrorPanel, Field, Icon, Link, Skeleton, Status, navigate, todayISO, useToast } from '../ui.jsx';

const EMPTY = {
  customer_id: '', customer_company: '', customer_contact_name: '', customer_email: '', customer_phone: '', po_number: '',
  customer_address: '', customer_city: '', customer_state: '', customer_postal: '', customer_country: 'India',
  ship_to_company: '', ship_to_address: '', ship_to_contact_name: '', ship_to_email: '', ship_to_phone: '',
  model_id: '', printer_model: '', printer_sn: '', faulty_part: '', faulty_part_sn: '', faulty_part_no: '',
  failure_description: '', tph_mileage: '', printer_mileage: '', fw_version: '', flash_initialized: '',
  purchase_date: '', delivery_to_user_date: '',
};
const PARTS = ['Head', 'Platen roller', 'Main board', 'Power supply', 'Cutter', 'Peeler', 'Motor', 'Sensor', 'Display', 'Whole printer'];

export default function RmaForm({ user, boot, id, onChange }) {
  const toast = useToast();
  const editing = !!id;
  const [f, setF] = useState(EMPTY);
  const [loaded, setLoaded] = useState(!editing);
  const [loadError, setLoadError] = useState(null);
  const [ticketNo, setTicketNo] = useState('');
  const [status, setStatus] = useState('');
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [dup, setDup] = useState({ blocks: [], sameMachine: [] });
  const [override, setOverride] = useState({ on: false, reason: '' });
  const [photos, setPhotos] = useState([]);
  const [showShip, setShowShip] = useState(false);
  const fileRef = useRef(null);

  useEffect(() => {
    if (!editing) return;
    get(`/api/rma/${id}`).then((r) => {
      const t = r.ticket;
      const next = {};
      for (const k of Object.keys(EMPTY)) next[k] = t[k] === null || t[k] === undefined ? '' : String(t[k]);
      setF(next);
      setTicketNo(t.ticket_no);
      setStatus(t.status);
      setShowShip(!!(t.ship_to_company || t.ship_to_address));
      setLoaded(true);
    }).catch(setLoadError);
  }, [id, editing]);

  // Live duplicate check while typing the serial / part (new RMAs only).
  useEffect(() => {
    if (editing || !(f.printer_sn.trim() || f.faulty_part_sn.trim())) { setDup({ blocks: [], sameMachine: [] }); return undefined; }
    const t = setTimeout(() => {
      post('/api/rma/check-duplicates', { printer_sn: f.printer_sn, faulty_part: f.faulty_part, faulty_part_no: f.faulty_part_no, faulty_part_sn: f.faulty_part_sn })
        .then(setDup).catch(() => {});
    }, 400);
    return () => clearTimeout(t);
  }, [f.printer_sn, f.faulty_part, f.faulty_part_no, f.faulty_part_sn, editing]);

  const masters = boot.masters;
  const modelOptions = useMemo(() => {
    const prod = new Map(masters.products.map((p) => [p.id, p]));
    const oem = new Map(masters.oems.map((o) => [o.id, o]));
    return masters.models.filter((m) => m.active).map((m) => {
      const p = prod.get(m.product_id);
      return { ...m, label: m.code, sub: [oem.get(p?.oem_id)?.name, p?.name, m.name].filter(Boolean).join(' · ') };
    });
  }, [masters]);

  if (loadError) return <ErrorPanel error={loadError} />;
  if (!loaded) return <Skeleton rows={6} />;

  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const pickCustomer = (c) => setF({
    ...f, customer_id: String(c.id), customer_company: c.name,
    customer_contact_name: c.contact_name || f.customer_contact_name, customer_email: c.email || f.customer_email,
    customer_phone: c.phone || f.customer_phone, customer_address: c.address || f.customer_address, customer_city: c.city || f.customer_city,
    customer_state: c.state || f.customer_state, customer_postal: c.postal || f.customer_postal, customer_country: c.country || 'India',
  });

  function addPhotos(list) {
    const next = [...photos];
    for (const file of list) {
      if (next.length >= 20) break;
      next.push({ file, url: URL.createObjectURL(file) });
    }
    setPhotos(next);
  }

  async function submit(e) {
    e.preventDefault();
    const errs = {};
    if (!f.customer_company.trim()) errs.customer_company = 'Company name is required';
    if (!f.printer_model.trim()) errs.printer_model = 'Product model is required';
    if (!f.printer_sn.trim()) errs.printer_sn = 'Product serial number is required';
    if (!f.faulty_part.trim()) errs.faulty_part = 'Faulty part is required';
    if (!f.failure_description.trim()) errs.failure_description = 'Failure description is required';
    if (Object.keys(errs).length) errs.form = 'Please fill in the highlighted fields.';
    if (!editing && dup.blocks.length && !(override.on && override.reason.trim())) {
      errs.form = user.dupOverride ? 'This looks like a duplicate open RMA. Tick the override box and give a reason, or close the other RMA first.'
        : 'This looks like a duplicate open RMA. Close the other RMA first, or ask an Admin to raise it with an override.';
    }
    setErrors(errs);
    if (Object.keys(errs).length) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    setBusy(true);
    try {
      const body = { ticket: f, overrideReason: override.on ? override.reason : undefined };
      const r = await post(editing ? `/api/rma/${id}` : '/api/rma', body);
      const tid = r.ticket.id;
      let failed = 0;
      for (const p of photos) {
        try { await uploadPhoto(tid, p.file, 'INBOUND'); } catch { failed++; }
      }
      onChange?.();
      toast(editing ? 'RMA saved' : `RMA ${r.ticket.ticket_no} raised${photos.length ? ` with ${photos.length - failed} photo${photos.length - failed === 1 ? '' : 's'}` : ''}`);
      if (failed) toast(`${failed} photo${failed === 1 ? '' : 's'} could not be uploaded. Add them again on the RMA.`, true);
      navigate(`/rma/${tid}`, { replace: true });
    } catch (err) {
      if (err.data?.code === 'duplicate') setDup(err.data.duplicates);
      setErrors({ form: err.message, ...(err.fields || {}) });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      <div className="page-head">
        <div>
          <Link to={editing ? `/rma/${id}` : '/rma'} className="small muted" style={{ textDecoration: 'none' }}>← {editing ? ticketNo : 'RMAs'}</Link>
          <h1>{editing ? 'Edit RMA' : 'New RMA'}</h1>
          {!editing && <p className="muted">Number given on save: {user.company.ticketPrefix}-RMA-{todayISO().slice(0, 7).replace('-', '')}-…</p>}
          {editing && status && <p style={{ marginTop: 6 }}><Status s={status} /></p>}
        </div>
      </div>
      {errors.form && <div className="formerror" role="alert" style={{ marginBottom: 14 }}>{errors.form}</div>}

      {!editing && (dup.blocks.length > 0 || dup.sameMachine.length > 0) && (
        <div className="stack" style={{ marginBottom: 14 }}>
          {dup.blocks.length > 0 && (
            <div className="dupbox" role="alert">
              <b><Icon name="alert" size={18} style={{ verticalAlign: '-3px' }} /> Possible duplicate — blocked</b>
              <ul>{dup.blocks.map((b) => <li key={b.ticket.id}>{b.reason} <Link to={`/rma/${b.ticket.id}`}>Open {b.ticket.ticket_no}</Link></li>)}</ul>
              {user.dupOverride ? (
                <>
                  <label className="check"><input type="checkbox" checked={override.on} onChange={(e) => setOverride({ ...override, on: e.target.checked })} />
                    I've checked this is a different physical part and want to raise it anyway</label>
                  {override.on && (
                    <Field label="Override reason" required error={errors.overrideReason} hint="Saved on the RMA with your name">
                      <input type="text" maxLength={500} value={override.reason} onChange={(e) => setOverride({ ...override, reason: e.target.value })} />
                    </Field>
                  )}
                </>
              ) : <p className="small">Only an Admin or a user allowed to override duplicates can raise this.</p>}
            </div>
          )}
          {dup.sameMachine.length > 0 && (
            <div className="warnbox">
              This printer already has {dup.sameMachine.length} open RMA{dup.sameMachine.length === 1 ? '' : 's'} for other parts:{' '}
              {dup.sameMachine.map((t, i) => <span key={t.id}>{i ? ', ' : ''}<Link to={`/rma/${t.id}`}>{t.ticket_no}</Link> ({t.faulty_part || 'part not set'})</span>)}. That's allowed.
            </div>
          )}
        </div>
      )}

      <section className="panel">
        <div className="section-title"><i>1</i><h2>Customer</h2></div>
        <div className="fields">
          <Field label="Company name" required error={errors.customer_company} className="wide">
            <Suggest value={f.customer_company} onChange={(v) => setF({ ...f, customer_company: v, customer_id: '' })}
              options={masters.customers.filter((c) => c.active).map((c) => ({ ...c, label: c.name, sub: [c.code, c.city, c.contact_name].filter(Boolean).join(' · ') }))}
              onPick={pickCustomer} placeholder="Type to search the customer list" autoComplete="organization" />
            {f.customer_id && <span className="hint">Linked to customer master — details filled in. You can still change them for this RMA.</span>}
          </Field>
          <Field label="Contact name"><input type="text" value={f.customer_contact_name} onChange={set('customer_contact_name')} /></Field>
          <Field label="Phone" error={errors.customer_phone}><input type="tel" value={f.customer_phone} onChange={set('customer_phone')} /></Field>
          <Field label="Email" error={errors.customer_email}><input type="email" value={f.customer_email} onChange={set('customer_email')} /></Field>
          <Field label="PO number"><input type="text" value={f.po_number} onChange={set('po_number')} /></Field>
          <Field label="Address" className="wide"><textarea rows={2} style={{ minHeight: 60 }} value={f.customer_address} onChange={set('customer_address')} /></Field>
          <Field label="City"><input type="text" value={f.customer_city} onChange={set('customer_city')} /></Field>
          <Field label="State"><input type="text" value={f.customer_state} onChange={set('customer_state')} /></Field>
          <Field label="Postal code"><input type="text" inputMode="numeric" value={f.customer_postal} onChange={set('customer_postal')} /></Field>
          <Field label="Country"><input type="text" value={f.customer_country} onChange={set('customer_country')} /></Field>
        </div>
        <div style={{ marginTop: 14 }}>
          {!showShip ? <button type="button" className="linkbtn" onClick={() => setShowShip(true)}>+ Different ship-to address</button> : (
            <div className="fields">
              <Field label="Ship-to company"><input type="text" value={f.ship_to_company} onChange={set('ship_to_company')} /></Field>
              <Field label="Ship-to contact"><input type="text" value={f.ship_to_contact_name} onChange={set('ship_to_contact_name')} /></Field>
              <Field label="Ship-to phone"><input type="tel" value={f.ship_to_phone} onChange={set('ship_to_phone')} /></Field>
              <Field label="Ship-to email" error={errors.ship_to_email}><input type="email" value={f.ship_to_email} onChange={set('ship_to_email')} /></Field>
              <Field label="Ship-to address" className="wide"><textarea rows={2} style={{ minHeight: 60 }} value={f.ship_to_address} onChange={set('ship_to_address')} /></Field>
            </div>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="section-title"><i>2</i><h2>Product and fault</h2></div>
        <div className="fields three">
          <Field label="Product model" required error={errors.printer_model}>
            <Suggest value={f.printer_model} onChange={(v) => setF({ ...f, printer_model: v, model_id: '' })} options={modelOptions}
              onPick={(m) => setF({ ...f, printer_model: m.code, model_id: String(m.id) })} placeholder="e.g. TE310" />
          </Field>
          <Field label="Product serial number" required error={errors.printer_sn} hint="Spaces are removed; letters made capital">
            <input type="text" className="upper" autoCapitalize="characters" value={f.printer_sn} onChange={set('printer_sn')} />
          </Field>
          <Field label="Purchase date" error={errors.purchase_date}><input type="date" max={todayISO()} value={f.purchase_date} onChange={set('purchase_date')} /></Field>
          <Field label="Faulty part" required error={errors.faulty_part}>
            <Suggest value={f.faulty_part} onChange={(v) => setF({ ...f, faulty_part: v })} options={PARTS.map((p) => ({ id: p, label: p }))}
              onPick={(p) => setF({ ...f, faulty_part: p.label })} placeholder="e.g. Head" />
          </Field>
          <Field label="Faulty part serial number"><input type="text" className="upper" autoCapitalize="characters" value={f.faulty_part_sn} onChange={set('faulty_part_sn')} /></Field>
          <Field label="Faulty part number"><input type="text" value={f.faulty_part_no} onChange={set('faulty_part_no')} /></Field>
          <Field label="TPH mileage (m)" error={errors.tph_mileage}><input type="number" inputMode="decimal" min="0" step="0.01" value={f.tph_mileage} onChange={set('tph_mileage')} /></Field>
          <Field label="Printer mileage (m)" error={errors.printer_mileage}><input type="number" inputMode="decimal" min="0" step="0.01" value={f.printer_mileage} onChange={set('printer_mileage')} /></Field>
          <Field label="Firmware version"><input type="text" value={f.fw_version} onChange={set('fw_version')} /></Field>
          <Field label="Flash initialised">
            <select value={f.flash_initialized} onChange={set('flash_initialized')}><option value="">—</option><option>Yes</option><option>No</option></select>
          </Field>
          <Field label="Delivery to user date" error={errors.delivery_to_user_date}><input type="date" max={todayISO()} value={f.delivery_to_user_date} onChange={set('delivery_to_user_date')} /></Field>
          <Field label="Failure description" required error={errors.failure_description} className="wide" hint="Goes into the OEM Excel form and email">
            <textarea value={f.failure_description} onChange={set('failure_description')} />
          </Field>
        </div>
      </section>

      {!editing && (
        <section className="panel">
          <div className="section-title"><i>3</i><h2>Inbound photos</h2></div>
          <p className="muted small" style={{ marginBottom: 12 }}>Photos of the faulty part as received. The first five go into the OEM Excel form. You can add more later.</p>
          <div className="dropzone">
            <Icon name="camera" size={30} />
            <div className="row" style={{ justifyContent: 'center' }}>
              <button type="button" className="btn ghost" onClick={() => { fileRef.current.setAttribute('capture', 'environment'); fileRef.current.click(); }}>
                <Icon name="camera" size={18} /> Take photo</button>
              <button type="button" className="btn ghost" onClick={() => { fileRef.current.removeAttribute('capture'); fileRef.current.click(); }}>
                <Icon name="upload" size={18} /> Choose photos</button>
            </div>
            <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => { addPhotos([...e.target.files]); e.target.value = ''; }} />
          </div>
          {photos.length > 0 && (
            <div className="photos" style={{ marginTop: 12 }}>
              {photos.map((p, i) => (
                <div key={p.url} className="photo">
                  <img src={p.url} alt={`Photo ${i + 1}`} />
                  {i < 5 && <span className="n">{i + 1}</span>}
                  <button type="button" className="iconbtn" aria-label="Remove photo" onClick={() => setPhotos(photos.filter((x) => x !== p))}
                    style={{ position: 'absolute', top: 4, right: 4, background: 'rgba(0,0,0,.55)', color: '#fff', padding: 4 }}><Icon name="x" size={16} /></button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <div className="savebar">
        <Link to={editing ? `/rma/${id}` : '/rma'} className="btn ghost">Cancel</Link>
        <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Raise RMA'}</button>
      </div>
    </form>
  );
}

// Text input with a pick list under it (customers, models, parts).
export function Suggest({ id, value, onChange, options, onPick, placeholder, autoComplete = 'off' }) {
  const [open, setOpen] = useState(false);
  const q = value.trim().toLowerCase();
  const list = (q ? options.filter((o) => o.label.toLowerCase().includes(q) || (o.sub || '').toLowerCase().includes(q)) : options).slice(0, 30);
  return (
    <div className="suggest">
      <input id={id} type="text" value={value} placeholder={placeholder} autoComplete={autoComplete}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} />
      {open && list.length > 0 && !(list.length === 1 && list[0].label === value) && (
        <ul role="listbox">
          {list.map((o) => (
            <li key={o.id}><button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => { onPick(o); setOpen(false); }}>
              <span>{o.label}</span>{o.sub && <small>{o.sub}</small>}
            </button></li>
          ))}
        </ul>
      )}
    </div>
  );
}
