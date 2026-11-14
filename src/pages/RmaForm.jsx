import { useEffect, useMemo, useRef, useState } from 'react';
import { get, post, uploadPhoto } from '../api.js';
import { Dialog, ErrorPanel, Field, Icon, Link, Skeleton, Status, can, fmtDate, navigate, query, todayISO, useToast } from '../ui.jsx';
import { CarePackPicker, CoverNote } from './CarePackLink.jsx';

// Fields shared by every part raised for this printer.
const SHARED = {
  customer_id: '', customer_company: '', customer_contact_name: '', customer_email: '', customer_phone: '', po_number: '',
  customer_address: '', customer_city: '', customer_state: '', customer_postal: '', customer_country: 'India',
  ship_to_company: '', ship_to_address: '', ship_to_contact_name: '', ship_to_email: '', ship_to_phone: '',
  category_id: '', model_id: '', printer_model: '', printer_sn: '', printer_mileage: '', fw_version: '', flash_initialized: '',
  purchase_date: '', delivery_to_user_date: '',
};
// Fields that belong to one faulty part (one RMA each).
const PART = { faulty_part: '', faulty_part_sn: '', faulty_part_no: '', tph_mileage: '', failure_description: '' };
const PARTS = ['Head', 'Platen roller', 'Main board', 'Power supply', 'Cutter', 'Peeler', 'Motor', 'Sensor', 'Display', 'Whole printer'];
const newPart = () => ({ ...PART, key: Math.random().toString(36).slice(2), photos: [] });
const norm = (s) => String(s || '').trim().toUpperCase().replace(/\s+/g, ' ');
const normSn = (s) => String(s || '').replace(/\s+/g, '').toUpperCase();

export default function RmaForm({ user, boot, reloadBoot, id, onChange }) {
  const toast = useToast();
  const editing = !!id;
  const [f, setF] = useState(SHARED);
  const [parts, setParts] = useState([newPart()]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [ticketNo, setTicketNo] = useState('');
  const [status, setStatus] = useState('');
  const [errors, setErrors] = useState({});
  const [addCust, setAddCust] = useState(false);
  const [busy, setBusy] = useState('');
  const [dups, setDups] = useState({});
  const [override, setOverride] = useState({ on: false, reason: '' });
  const [showShip, setShowShip] = useState(false);
  const [cover, setCover] = useState(null);
  const [cpAdd, setCpAdd] = useState({ reason: '', batchId: '' });
  const [headReason, setHeadReason] = useState({});
  const [snNote, setSnNote] = useState({});

  // Load the ticket (edit) or copy customer + printer from another RMA (?from=ID, "raise another part").
  useEffect(() => {
    const src = editing ? id : query().from;
    if (!src) { setLoaded(true); return; }
    get(`/api/rma/${src}`).then((r) => {
      const t = r.ticket;
      const next = {};
      for (const k of Object.keys(SHARED)) next[k] = t[k] === null || t[k] === undefined ? '' : String(t[k]);
      if (!next.category_id) next.category_id = '';
      setF(next);
      setShowShip(!!(t.ship_to_company || t.ship_to_address));
      if (editing) {
        const p = newPart();
        for (const k of Object.keys(PART)) p[k] = t[k] === null || t[k] === undefined ? '' : String(t[k]);
        setParts([p]);
        setTicketNo(t.ticket_no);
        setStatus(t.status);
      }
      setLoaded(true);
    }).catch(setLoadError);
  }, [id, editing]);

  // Care pack cover for this serial (blocks expired cover). Only when the company has the care pack module.
  const cpOn = (user.company.modules || ['carepack']).includes('carepack');
  useEffect(() => {
    if (!f.printer_sn.trim() || !cpOn) { setCover(null); return undefined; }
    const t = setTimeout(() => {
      get(`/api/carepack/serial?sn=${encodeURIComponent(f.printer_sn)}`).then((r) => setCover(r.device || false)).catch(() => setCover(null));
    }, 400);
    return () => clearTimeout(t);
  }, [f.printer_sn]);

  // Live duplicate check per part while typing (new RMAs only).
  const dupKey = `${f.category_id}|${f.model_id}|${parts.map((p) => `${p.key}|${p.faulty_part}|${p.faulty_part_no}|${p.faulty_part_sn}`).join('§')}`;
  useEffect(() => {
    if (editing || !f.printer_sn.trim()) { setDups({}); return undefined; }
    const t = setTimeout(async () => {
      const out = {};
      for (const p of parts) {
        try {
          out[p.key] = await post('/api/rma/check-duplicates', { printer_sn: f.printer_sn, faulty_part: p.faulty_part, faulty_part_no: p.faulty_part_no, faulty_part_sn: p.faulty_part_sn,
            category_id: f.category_id || defaultCat?.id || null, model_id: f.model_id || null });
        } catch { /* ignore while typing */ }
      }
      setDups(out);
    }, 450);
    return () => clearTimeout(t);
  }, [f.printer_sn, dupKey, editing]); // eslint-disable-line react-hooks/exhaustive-deps

  const masters = boot.masters;
  const cats = (masters.categories || []).filter((c) => c.active || String(c.id) === String(f.category_id));
  const defaultCat = cats.find((c) => c.code === 'PRN') || cats[0];
  const cat = cats.find((c) => String(c.id) === String(f.category_id)) || defaultCat;
  const hasHead = cat ? !!cat.has_head : true;
  const devWord = cat && !cat.has_head ? (cat.name || 'Device') : 'Printer';
  const modelOptions = useMemo(() => {
    const prod = new Map(masters.products.map((p) => [p.id, p]));
    const oem = new Map(masters.oems.map((o) => [o.id, o]));
    return masters.models.filter((m) => m.active && (!m.category_id || !cat || m.category_id === cat.id)).map((m) => {
      const p = prod.get(m.product_id);
      return { ...m, label: m.code, sub: [oem.get(p?.oem_id)?.name, p?.name, m.name].filter(Boolean).join(' · ') };
    });
  }, [masters, cat?.id]);

  if (loadError) return <ErrorPanel error={loadError} />;
  if (!loaded) return <Skeleton rows={6} />;

  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const setPart = (key, k, v) => setParts((ps) => ps.map((p) => (p.key === key ? { ...p, [k]: v } : p)));
  const pickCustomer = (c) => setF({
    ...f, customer_id: String(c.id), customer_company: c.name,
    customer_contact_name: c.contact_name || f.customer_contact_name, customer_email: c.email || f.customer_email,
    customer_phone: c.phone || f.customer_phone, customer_address: c.address || f.customer_address, customer_city: c.city || f.customer_city,
    customer_state: c.state || f.customer_state, customer_postal: c.postal || f.customer_postal, customer_country: c.country || 'India',
  });
  const customers = masters.customers.filter((c) => c.active);
  const pickDevice = (d) => {
    // Care pack customer → the matching entry in the customer list, if there is one.
    const c = customers.find((x) => norm(x.name) === norm(d.customer_name));
    setF((x) => ({
      ...x, ...(c ? { customer_id: String(c.id), customer_company: c.name, customer_city: c.city || d.customer_city || x.customer_city } : {}),
      printer_sn: d.serial_number, printer_model: d.printer_model || x.printer_model, purchase_date: x.purchase_date || d.invoice_date || '',
    }));
    if (!c && d.customer_name) toast(`"${d.customer_name}" is not in the customer list — choose the customer in step 1.`, true);
  };
  const chooseCustomer = (val) => {
    if (val === '__new') { setAddCust(true); return; }
    if (val === '__name') return;
    const c = customers.find((x) => String(x.id) === val);
    if (c) pickCustomer(c); else setF({ ...f, customer_id: '', customer_company: '' });
  };

  const blocked = parts.filter((p) => dups[p.key]?.blocks?.length);
  const sameMachine = editing ? [] : [...new Map(Object.values(dups).flatMap((d) => d?.sameMachine || []).map((t) => [t.id, t])).values()]
    .filter((t) => !blocked.some((p) => dups[p.key].blocks.some((b) => b.ticket.id === t.id)));
  const expired = cover && cover.expired;
  const notInCarePack = cover === false;

  async function submit(e) {
    e.preventDefault();
    const errs = {};
    if (!editing && !f.customer_id) errs.customer_company = 'Choose the customer from the list';
    else if (!f.customer_company.trim()) errs.customer_company = 'Customer is required';
    if (!editing && !f.customer_email.trim()) errs.customer_email = 'Customer email is required (status updates go there)';
    else if (f.customer_email.trim() && !/^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(f.customer_email.trim())) errs.customer_email = 'Enter a valid email address';
    if (!f.printer_model.trim()) errs.printer_model = 'Product model is required';
    if (!f.printer_sn.trim()) errs.printer_sn = 'Product serial number is required';
    parts.forEach((p, i) => {
      if (!p.faulty_part.trim()) errs[`p${i}_faulty_part`] = 'Faulty part is required';
      if (!p.failure_description.trim()) errs[`p${i}_failure_description`] = 'Failure description is required';
    });
    // The same physical part twice in one form (same part, and no different part serial / number to tell them apart).
    for (let i = 0; i < parts.length; i++) {
      for (let j = i + 1; j < parts.length; j++) {
        const a = parts[i]; const b = parts[j];
        if (!norm(a.faulty_part) || norm(a.faulty_part) !== norm(b.faulty_part)) continue;
        const diffSn = normSn(a.faulty_part_sn) && normSn(b.faulty_part_sn) && normSn(a.faulty_part_sn) !== normSn(b.faulty_part_sn);
        const diffNo = norm(a.faulty_part_no) && norm(b.faulty_part_no) && norm(a.faulty_part_no) !== norm(b.faulty_part_no);
        if (!diffSn && !diffNo) errs[`p${j}_faulty_part`] = `Same as part ${i + 1}. If they really are two separate ${a.faulty_part} units, enter each one's part serial number.`;
      }
      if (normSn(parts[i].faulty_part_sn)) {
        const k = parts.findIndex((q, j) => j > i && normSn(q.faulty_part_sn) === normSn(parts[i].faulty_part_sn));
        if (k > 0) errs[`p${k}_faulty_part_sn`] = `Part serial already used on part ${i + 1}`;
      }
    }
    parts.forEach((p, i) => {
      if (dups[p.key]?.heads && !String(headReason[p.key] || '').trim()) errs[`p${i}_head`] = 'Give a reason to raise another print-head RMA for this printer';
      if (dups[p.key]?.partCheck?.match === false && !String(snNote[p.key] || '').trim()) errs[`p${i}_snnote`] = 'Check the serial, or say why it differs';
    });
    if (expired) errs.printer_sn = `Care pack / warranty for this serial ended on ${fmtDate(cover.warranty_end)}. Expired cover cannot start a new RMA.`;
    if (Object.keys(errs).length) errs.form = 'Please fix the highlighted fields.';
    if (!errs.form && !editing && blocked.length && !(override.on && override.reason.trim())) {
      errs.form = user.dupOverride ? 'A part here is already on an open RMA. Tick the override box and give a reason, or remove that part.'
        : 'A part here is already on an open RMA. Remove it, close the other RMA, or ask an Admin.';
    }
    if (!errs.form && !editing && notInCarePack && cpAdd.on && !cpAdd.reason.trim()) errs.form = 'Give a reason for adding this serial to the care pack registry, or untick the box.';
    setErrors(errs);
    if (Object.keys(errs).length) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }

    if (editing) {
      setBusy('save');
      try {
        const r = await post(`/api/rma/${id}`, { ticket: { ...f, category_id: f.category_id || defaultCat?.id || '', ...strip(parts[0]) } });
        onChange?.();
        toast('RMA saved');
        navigate(`/rma/${r.ticket.id}`, { replace: true });
      } catch (err) {
        setErrors({ form: err.message, ...prefixFields(err.fields, 0) });
      } finally {
        setBusy('');
      }
      return;
    }

    // One RMA per part, raised one after another. Stops at the first failure so nothing is half-done silently.
    const created = [];
    let photoFails = 0;
    try {
      for (let i = 0; i < parts.length; i++) {
        setBusy(`Raising ${i + 1} of ${parts.length}…`);
        const p = parts[i];
        const body = {
          ticket: { ...f, category_id: f.category_id || defaultCat?.id || '', ...strip(p) },
          headReason: headReason[p.key] || undefined,
          partSnNote: snNote[p.key] || undefined,
          overrideReason: override.on && dups[p.key]?.blocks?.length ? override.reason : undefined,
          addToCarePack: i === 0 && notInCarePack && cpAdd.on ? { reason: cpAdd.reason, batchId: cpAdd.batchId || null } : undefined,
        };
        const r = await post('/api/rma', body);
        created.push(r.ticket);
        for (const ph of p.photos) {
          try { await uploadPhoto(r.ticket.id, ph.file, 'INBOUND'); } catch { photoFails++; }
        }
      }
    } catch (err) {
      const i = created.length;
      if (err.data?.code === 'part_serial_mismatch') setDups((d) => ({ ...d, [parts[i].key]: { ...(d[parts[i].key] || { blocks: [], sameMachine: [] }), partCheck: err.data.partCheck } }));
      if (err.data?.code === 'head_limit') setDups((d) => ({ ...d, [parts[i].key]: { ...(d[parts[i].key] || { blocks: [], sameMachine: [] }), heads: err.data.heads } }));
      setErrors({ form: `${created.length ? `Raised ${created.map((t) => t.ticket_no).join(', ')}. ` : ''}Part ${i + 1} (${parts[i].faulty_part}) was not raised: ${err.message}`, ...prefixFields(err.fields, i) });
      if (created.length) { setParts((ps) => ps.slice(created.length)); onChange?.(); }
      window.scrollTo({ top: 0, behavior: 'smooth' });
      setBusy('');
      return;
    }
    setBusy('');
    onChange?.();
    if (photoFails) toast(`${photoFails} photo${photoFails === 1 ? '' : 's'} could not be uploaded. Add them on the RMA.`, true);
    if (created.length === 1) {
      toast(`RMA ${created[0].ticket_no} raised`);
      navigate(`/rma/${created[0].id}`, { replace: true });
    } else {
      toast(`${created.length} RMAs raised: ${created.map((t) => t.ticket_no).join(', ')}`);
      navigate(`/rma?q=${encodeURIComponent(created[0].printer_sn)}`, { replace: true });
    }
  }

  return (
    <>
    <form onSubmit={submit} noValidate>
      <div className="page-head">
        <div>
          <Link to={editing ? `/rma/${id}` : '/rma'} className="small muted" style={{ textDecoration: 'none' }}>← {editing ? ticketNo : 'RMAs'}</Link>
          <h1>{editing ? 'Edit RMA' : 'New RMA'}</h1>
          {!editing && <p className="muted">Several faulty parts from one device? Add each part below — each gets its own RMA number and OEM form.</p>}
          {editing && status && <p style={{ marginTop: 6 }}><Status s={status} /></p>}
        </div>
      </div>
      {errors.form && <div className="formerror" role="alert" style={{ marginBottom: 14 }}>{errors.form}</div>}

      {!editing && (blocked.length > 0 || sameMachine.length > 0) && (
        <div className="stack" style={{ marginBottom: 14 }}>
          {blocked.length > 0 && (
            <div className="dupbox" role="alert">
              <b><Icon name="alert" size={18} style={{ verticalAlign: '-3px' }} /> Possible duplicate — blocked</b>
              <ul>{blocked.flatMap((p) => dups[p.key].blocks.map((b) => (
                <li key={`${p.key}${b.ticket.id}`}><b>{p.faulty_part || 'Part'}:</b> {b.reason} <Link to={`/rma/${b.ticket.id}`}>Open {b.ticket.ticket_no}</Link></li>)))}</ul>
              {user.dupOverride ? (
                <>
                  <label className="check"><input type="checkbox" checked={override.on} onChange={(e) => setOverride({ ...override, on: e.target.checked })} />
                    I've checked this is a different physical part and want to raise it anyway</label>
                  {override.on && (
                    <Field label="Override reason" required hint="Saved on the RMA with your name">
                      <input type="text" maxLength={500} value={override.reason} onChange={(e) => setOverride({ ...override, reason: e.target.value })} />
                    </Field>
                  )}
                </>
              ) : <p className="small">Only an Admin or a user allowed to override duplicates can raise this part.</p>}
            </div>
          )}
          {sameMachine.length > 0 && (
            <div className="warnbox">
              This printer already has open RMA{sameMachine.length === 1 ? '' : 's'} for other parts:{' '}
              {sameMachine.map((t, i) => <span key={t.id}>{i ? ', ' : ''}<Link to={`/rma/${t.id}`}>{t.ticket_no}</Link> ({t.faulty_part || 'part not set'})</span>)}. That's allowed.
            </div>
          )}
        </div>
      )}

      <section className="panel formsec">
        <div className="section-title"><i>1</i><h2>Customer</h2></div>
        <div className="fields">
          <Field label="Customer" required error={errors.customer_company} className="wide"
            hint={f.customer_id ? 'Details below are filled from the customer list. You can still change them for this RMA.'
              : can.manage(user) ? 'Not in the list? Choose “+ Add a new customer” at the bottom.' : 'Not in the list? Ask an Admin or Manager to add the customer (Masters).'}>
            <select value={f.customer_id || (f.customer_company ? '__name' : '')} onChange={(e) => chooseCustomer(e.target.value)}>
              <option value="">Choose a customer…</option>
              {!f.customer_id && f.customer_company && <option value="__name">{f.customer_company} (not in customer list)</option>}
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name}{c.city ? ` — ${c.city}` : ''}</option>)}
              {can.manage(user) && <option value="__new">+ Add a new customer…</option>}
            </select>
          </Field>
          <Field label="Contact name"><input type="text" value={f.customer_contact_name} onChange={set('customer_contact_name')} /></Field>
          <Field label="Phone" error={errors.customer_phone}><input type="tel" value={f.customer_phone} onChange={set('customer_phone')} /></Field>
          <Field label="Email" required={!editing} error={errors.customer_email} hint="Status updates and the tracking link go here"><input type="email" inputMode="email" value={f.customer_email} onChange={set('customer_email')} /></Field>
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

      <section className="panel formsec">
        <div className="section-title"><i>2</i><h2>Device</h2></div>
        {cats.length > 1 && (
          <div className="views" role="radiogroup" aria-label="Device category" style={{ marginBottom: 14 }}>
            {cats.map((c) => (
              <button key={c.id} type="button" role="radio" aria-checked={cat?.id === c.id} aria-pressed={cat?.id === c.id}
                onClick={() => setF({ ...f, category_id: String(c.id), ...(f.model_id && masters.models.find((m) => String(m.id) === f.model_id)?.category_id !== c.id ? { model_id: '', printer_model: '' } : {}) })}>
                <Icon name={c.has_head ? 'printer' : 'box'} size={16} /> {c.name}</button>
            ))}
          </div>
        )}
        {!editing && cpOn && hasHead && <div style={{ marginBottom: 12 }}><CarePackPicker onPick={pickDevice} /></div>}
        <div className="fields three">
          <Field label="Product model" required error={errors.printer_model}>
            <Suggest value={f.printer_model} onChange={(v) => setF({ ...f, printer_model: v, model_id: '' })} options={modelOptions}
              onPick={(m) => setF({ ...f, printer_model: m.code, model_id: String(m.id) })} placeholder="e.g. TE310" />
          </Field>
          <Field label={`${devWord} serial number`} required error={errors.printer_sn} hint="Spaces are removed; letters made capital">
            <input type="text" className="upper" autoCapitalize="characters" value={f.printer_sn} onChange={set('printer_sn')} />
          </Field>
          <Field label="Purchase date" error={errors.purchase_date}><input type="date" max={todayISO()} value={f.purchase_date} onChange={set('purchase_date')} /></Field>
          {hasHead && <Field label="Printer mileage (m)" error={errors.printer_mileage}><input type="number" inputMode="decimal" min="0" step="0.01" value={f.printer_mileage} onChange={set('printer_mileage')} /></Field>}
          <Field label="Firmware version"><input type="text" value={f.fw_version} onChange={set('fw_version')} /></Field>
          {hasHead && <Field label="Flash initialised">
            <select value={f.flash_initialized} onChange={set('flash_initialized')}><option value="">—</option><option>Yes</option><option>No</option></select>
          </Field>}
          <Field label="Delivery to user date" error={errors.delivery_to_user_date}><input type="date" max={todayISO()} value={f.delivery_to_user_date} onChange={set('delivery_to_user_date')} /></Field>
        </div>
        <CoverNote cover={cover} />
        {!editing && notInCarePack && f.printer_sn.trim().length >= 4 && (
          <div className="stack" style={{ marginTop: 10 }}>
            <label className="check small"><input type="checkbox" checked={!!cpAdd.on} onChange={(e) => setCpAdd({ ...cpAdd, on: e.target.checked })} />
              Also add this serial to the care pack registry (it's missing from the import)</label>
            {cpAdd.on && <Field label="Reason" required hint="Stored on the care pack device with your name">
              <input type="text" value={cpAdd.reason} onChange={(e) => setCpAdd({ ...cpAdd, reason: e.target.value })} placeholder="e.g. SN missing from import — confirmed on printer label" />
            </Field>}
          </div>
        )}
      </section>

      {parts.map((p, i) => (
        <section key={p.key} className="panel">
          <div className="spread" style={{ marginBottom: 12 }}>
            <div className="section-title" style={{ margin: 0 }}><i>{editing ? 3 : i + 3}</i><h2>{editing ? 'Faulty part' : parts.length > 1 ? `Faulty part ${i + 1}` : 'Faulty part'}</h2></div>
            {!editing && parts.length > 1 && <button type="button" className="btn danger small" onClick={() => setParts(parts.filter((x) => x.key !== p.key))}><Icon name="trash" size={16} /> Remove part</button>}
          </div>
          <div className="fields three">
            <Field label="Faulty part" required error={errors[`p${i}_faulty_part`]}>
              <Suggest value={p.faulty_part} onChange={(v) => setPart(p.key, 'faulty_part', v)} options={PARTS.map((x) => ({ id: x, label: x }))}
                onPick={(x) => setPart(p.key, 'faulty_part', x.label)} placeholder="e.g. Head" />
            </Field>
            <Field label="Faulty part serial number" error={errors[`p${i}_faulty_part_sn`]}><input type="text" className="upper" autoCapitalize="characters" value={p.faulty_part_sn} onChange={(e) => setPart(p.key, 'faulty_part_sn', e.target.value)} /></Field>
            <Field label="Faulty part number" error={errors[`p${i}_faulty_part_no`]}><input type="text" value={p.faulty_part_no} onChange={(e) => setPart(p.key, 'faulty_part_no', e.target.value)} /></Field>
            {hasHead && <Field label="TPH mileage (m)" error={errors[`p${i}_tph_mileage`]}><input type="number" inputMode="decimal" min="0" step="0.01" value={p.tph_mileage} onChange={(e) => setPart(p.key, 'tph_mileage', e.target.value)} /></Field>}
            <Field label="Failure description" required error={errors[`p${i}_failure_description`]} className="wide" hint="Goes into this part's OEM Excel form and email">
              <textarea value={p.failure_description} onChange={(e) => setPart(p.key, 'failure_description', e.target.value)} />
            </Field>
          </div>
          {!editing && dups[p.key]?.partCheck && <PartSerialCheck c={dups[p.key].partCheck} error={errors[`p${i}_snnote`]} value={snNote[p.key] || ''}
            onNote={(v) => setSnNote((x) => ({ ...x, [p.key]: v }))} onUse={(sn) => setPart(p.key, 'faulty_part_sn', sn)} />}
          {!editing && dups[p.key]?.heads && <HeadBox h={dups[p.key].heads} serial={f.printer_sn} error={errors[`p${i}_head`]}
            value={headReason[p.key] || ''} onChange={(v) => setHeadReason((x) => ({ ...x, [p.key]: v }))} />}
          {!editing && <PartPhotos part={p} onChange={(photos) => setPart(p.key, 'photos', photos)} />}
        </section>
      ))}
      {!editing && (
        <button type="button" className="btn ghost block" style={{ marginTop: 14 }} onClick={() => setParts([...parts, newPart()])}>
          <Icon name="plus" size={18} /> Add another faulty part from this {devWord.toLowerCase()}</button>
      )}

      <div className="savebar">
        <Link to={editing ? `/rma/${id}` : '/rma'} className="btn ghost">Cancel</Link>
        <button className="btn primary" disabled={!!busy}>{busy ? (busy === 'save' ? 'Saving…' : busy) : editing ? 'Save changes' : parts.length > 1 ? `Raise ${parts.length} RMAs` : 'Raise RMA'}</button>
      </div>
    </form>
      {addCust && <AddCustomer onClose={() => setAddCust(false)} onAdded={async (rec) => {
        const b = await reloadBoot();
        const c = b.masters.customers.find((x) => norm(x.name) === norm(rec.name));
        setAddCust(false);
        if (c) pickCustomer(c);
        toast(`${rec.name} added to the customer list`);
      }} />}
    </>
  );
}

// Cross-check: the faulty part should be the one last received from the OEM for this printer.
function PartSerialCheck({ c, value, onNote, onUse, error }) {
  const l = c.last;
  const from = <><Link to={`/rma/${l.id}`}>{l.ticket_no}</Link>{l.goods_received_date ? `, received ${fmtDate(l.goods_received_date)}` : ''}</>;
  if (c.match === true) return <p className="small" style={{ marginTop: 10, color: 'var(--ok)' }}><Icon name="check" size={16} style={{ verticalAlign: '-3px' }} /> Matches the {l.faulty_part.toLowerCase()} received from the OEM on {from}.</p>;
  if (c.match === null) {
    return (
      <div className="callout" style={{ marginTop: 12, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <span className="small">Last {l.faulty_part.toLowerCase()} received for this printer: <span className="mono">{l.received_part_sn}</span> ({from}).</span>
        <button type="button" className="btn ghost small" onClick={() => onUse(l.received_part_sn)}>Use this serial</button>
      </div>
    );
  }
  return (
    <div className="headbox" role="alert" style={{ marginTop: 14 }}>
      <b className="t"><Icon name="alert" size={18} style={{ verticalAlign: '-3px' }} /> Part serial does not match</b>
      <span className="small">The last {l.faulty_part.toLowerCase()} received from the OEM for this printer was <span className="mono">{l.received_part_sn}</span> ({from}). You entered <span className="mono">{c.entered}</span>.</span>
      <div className="row"><button type="button" className="btn ghost small" onClick={() => onUse(l.received_part_sn)}>Use {l.received_part_sn}</button></div>
      <Field label="Or say why it differs" required error={error} hint="Saved on the RMA, e.g. head bought locally, or swapped from another printer">
        <input type="text" maxLength={500} value={value} onChange={(e) => onNote(e.target.value)} />
      </Field>
    </div>
  );
}

// Print-head claim limit reached on this printer: warn, and ask for a reason (saved on the RMA).
function HeadBox({ h, serial, value, onChange, error }) {
  return (
    <div className="headbox" role="alert" style={{ marginTop: 14 }}>
      <b className="t"><Icon name="alert" size={18} style={{ verticalAlign: '-3px' }} /> Print-head limit reached</b>
      <span className="small">Printer <span className="mono">{normSn(serial)}</span> already has {h.count} print-head RMA{h.count === 1 ? '' : 's'} (the limit is {h.limit}):{' '}
        {h.tickets.map((t, i) => <span key={t.id}>{i ? ', ' : ''}<Link to={`/rma/${t.id}`}>{t.ticket_no}</Link> ({fmtDate(new Date(t.created_at).toISOString().slice(0, 10))})</span>)}.{' '}
        <Link to={`/devices/${encodeURIComponent(normSn(serial))}`}>See device history</Link></span>
      <Field label="Reason to raise another head RMA" required error={error} hint="Saved on the RMA with your name, and shown to Admins">
        <input type="text" maxLength={500} value={value} onChange={(e) => onChange(e.target.value)} placeholder="e.g. OEM confirmed head failure under warranty; customer approved" />
      </Field>
    </div>
  );
}

function strip(p) {
  const o = {};
  for (const k of Object.keys(PART)) o[k] = p[k];
  return o;
}
function prefixFields(fields, i) {
  const o = {};
  for (const [k, v] of Object.entries(fields || {})) o[k in PART ? `p${i}_${k}` : k] = v;
  return o;
}

function PartPhotos({ part, onChange }) {
  const ref = useRef(null);
  const add = (list) => onChange([...part.photos, ...[...list].slice(0, 20 - part.photos.length).map((file) => ({ file, url: URL.createObjectURL(file) }))]);
  return (
    <div style={{ marginTop: 14 }}>
      <div className="spread">
        <span className="small"><b>Inbound photos</b> <span className="muted">— the first five go into this part's OEM form</span></span>
        <div className="row tight">
          <button type="button" className="btn ghost small" onClick={() => { ref.current.setAttribute('capture', 'environment'); ref.current.click(); }}><Icon name="camera" size={16} /> Take photo</button>
          <button type="button" className="btn ghost small" onClick={() => { ref.current.removeAttribute('capture'); ref.current.click(); }}><Icon name="upload" size={16} /> Choose</button>
        </div>
        <input ref={ref} type="file" accept="image/*" multiple hidden onChange={(e) => { add(e.target.files); e.target.value = ''; }} />
      </div>
      {part.photos.length > 0 && (
        <div className="photos" style={{ marginTop: 10 }}>
          {part.photos.map((ph, i) => (
            <div key={ph.url} className="photo">
              <img src={ph.url} alt={`Photo ${i + 1}`} />
              {i < 5 && <span className="n">{i + 1}</span>}
              <button type="button" className="iconbtn" aria-label="Remove photo" onClick={() => onChange(part.photos.filter((x) => x !== ph))}
                style={{ position: 'absolute', top: 4, right: 4, background: 'rgba(0,0,0,.55)', color: '#fff', padding: 4 }}><Icon name="x" size={16} /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Quick add to the customer list without leaving the RMA form (Admin / Manager).
function AddCustomer({ onClose, onAdded }) {
  const [f, setF] = useState({ name: '', city: '', contact_name: '', phone: '', email: '', gstin: '' });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function save(e) {
    e.preventDefault();
    e.stopPropagation();
    if (!f.name.trim()) { setErrors({ name: 'Enter the customer name' }); return; }
    setBusy(true);
    try {
      await post('/api/masters/customers', { ...f, active: true });
      await onAdded(f);
    } catch (err) {
      setErrors({ form: Object.keys(err.fields || {}).length ? null : err.message, ...(err.fields || {}) });
    } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} title="Add a new customer">
      <form className="stack" onSubmit={save} noValidate>
        {errors.form && <div className="formerror">{errors.form}</div>}
        <Field label="Customer name" required error={errors.name}><input type="text" autoFocus value={f.name} onChange={set('name')} /></Field>
        <div className="fields">
          <Field label="City" error={errors.city}><input type="text" value={f.city} onChange={set('city')} /></Field>
          <Field label="Contact name" error={errors.contact_name}><input type="text" value={f.contact_name} onChange={set('contact_name')} /></Field>
          <Field label="Phone" error={errors.phone}><input type="tel" value={f.phone} onChange={set('phone')} /></Field>
          <Field label="Email" error={errors.email}><input type="email" value={f.email} onChange={set('email')} /></Field>
          <Field label="GSTIN" error={errors.gstin}><input type="text" className="upper" maxLength={15} value={f.gstin} onChange={set('gstin')} /></Field>
        </div>
        <p className="tiny muted">More details (address, state) can be added later in Masters → Customers.</p>
        <div className="row end"><button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Add customer'}</button></div>
      </form>
    </Dialog>
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
