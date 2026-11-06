import { useState } from 'react';
import { del, post } from '../api.js';
import { Dialog, Empty, Field, Icon, can, useToast } from '../ui.jsx';

const KINDS = {
  customers: { label: 'Customers', one: 'customer' },
  oems: { label: 'OEMs', one: 'OEM' },
  products: { label: 'Products', one: 'product' },
  models: { label: 'Models', one: 'model' },
  categories: { label: 'Device categories', one: 'device category' },
  cp_types: { label: 'Care pack types', one: 'care pack type' },
};

export default function Masters({ user, boot, reloadBoot }) {
  const toast = useToast();
  const [kind, setKind] = useState('customers');
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState(null);
  const m = boot.masters;
  const editable = can.manage(user);
  const oemName = (id) => m.oems.find((o) => o.id === id)?.name || '—';
  const product = (id) => m.products.find((p) => p.id === id);

  const rows = (m[kind] || []).filter((r) => !q || JSON.stringify(r).toLowerCase().includes(q.toLowerCase()));
  const sub = (r) => ({
    customers: [r.code, r.city, r.contact_name, r.phone, r.gstin].filter(Boolean).join(' · '),
    oems: r.code,
    products: `${r.code} · ${oemName(r.oem_id)}`,
    models: `${r.name} · ${product(r.product_id)?.name || '—'} · ${oemName(product(r.product_id)?.oem_id)}${r.category_id ? ` · ${(m.categories || []).find((c) => c.id === r.category_id)?.name || ''}` : ''}`,
    categories: `${r.code} · ${r.has_head ? 'Has a print head (head-claim limit applies)' : 'No print head'}`,
    cp_types: `${r.duration_years} year${r.duration_years === 1 ? '' : 's'} of cover`,
  }[kind]);

  async function remove(r) {
    if (!confirm(`Delete ${r.name || r.code}?`)) return;
    try {
      await del(`/api/masters/${kind}/${r.id}`);
      await reloadBoot();
      toast('Deleted');
    } catch (e) {
      toast(e.message, true);
    }
  }

  return (
    <>
      <div className="page-head">
        <div><h1>Masters</h1><p className="muted">Lists that fill in RMA forms quickly. {editable ? '' : 'Only an Admin or Manager can change them.'}</p></div>
        {editable && <button className="btn primary" onClick={() => setEdit({ kind, record: { active: true } })}><Icon name="plus" size={18} /> Add {KINDS[kind].one}</button>}
      </div>
      <div className="tabs" role="tablist">
        {Object.entries(KINDS).map(([k, v]) => <button key={k} role="tab" aria-selected={kind === k} onClick={() => { setKind(k); setQ(''); }}>{v.label} ({(m[k] || []).length})</button>)}
      </div>
      <div className="search" style={{ marginBottom: 12 }}><Icon name="search" size={18} /><input type="search" placeholder={`Search ${KINDS[kind].label.toLowerCase()}`} value={q} onChange={(e) => setQ(e.target.value)} /></div>
      {kind === 'models' && !m.products.length && <div className="warnbox" style={{ marginBottom: 12 }}>Add an OEM and a product first; models belong to a product.</div>}
      {!rows.length ? <Empty icon="list" title={`No ${KINDS[kind].label.toLowerCase()} yet`}>{kind === 'customers' && editable ? 'Add them here or import a list from Excel.' : null}</Empty> : (
        <div>
          {rows.map((r) => (
            <div key={r.id} className={`mrow ${r.active ? '' : 'inactive'}`}>
              <div style={{ minWidth: 0 }}>
                <b>{kind === 'models' ? r.code : r.name}</b> {!r.active && <span className="pill">Inactive</span>}
                <div className="muted small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub(r)}</div>
              </div>
              {editable && <div className="row tight">
                <button className="iconbtn" aria-label="Edit" onClick={() => setEdit({ kind, record: { ...r, active: !!r.active } })}><Icon name="edit" size={18} /></button>
                <button className="iconbtn" aria-label="Delete" onClick={() => remove(r)}><Icon name="trash" size={18} /></button>
              </div>}
            </div>
          ))}
        </div>
      )}
      {edit && <EditDialog {...edit} masters={m} onClose={() => setEdit(null)} onSaved={async () => { await reloadBoot(); setEdit(null); toast('Saved'); }} />}
    </>
  );
}

function EditDialog({ kind, record, masters, onClose, onSaved }) {
  const [f, setF] = useState({ ...record });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const text = (k, label, opts = {}) => (
    <Field label={label} required={opts.req} error={errors[k]} className={opts.wide ? 'wide' : ''} hint={opts.hint}>
      {opts.area ? <textarea rows={2} style={{ minHeight: 60 }} value={f[k] || ''} onChange={set(k)} />
        : <input type={opts.type || 'text'} className={opts.upper ? 'upper' : ''} value={f[k] || ''} onChange={set(k)} />}
    </Field>
  );
  async function save(e) {
    e.preventDefault();
    setBusy(true);
    try {
      await post(`/api/masters/${kind}`, f);
      await onSaved();
    } catch (err) {
      setErrors({ form: Object.keys(err.fields || {}).length ? null : err.message, ...(err.fields || {}) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onClose={onClose} title={`${record.id ? 'Edit' : 'Add'} ${KINDS[kind].one}`} wide={kind === 'customers'}>
      <form className="stack" onSubmit={save} noValidate>
        {errors.form && <div className="formerror">{errors.form}</div>}
        <div className="fields">
          {kind === 'customers' && <>
            {text('name', 'Name', { req: true, wide: true })}
            {text('code', 'Code', { upper: true, hint: record.id ? '' : 'Leave empty to number automatically' })}
            {text('gstin', 'GSTIN', { upper: true })}
            {text('contact_name', 'Contact name')}
            {text('phone', 'Phone', { type: 'tel' })}
            {text('email', 'Email', { type: 'email' })}
            {text('city', 'City')}
            {text('state', 'State')}
            {text('postal', 'Postal code')}
            {text('address', 'Address', { area: true, wide: true })}
          </>}
          {kind === 'oems' && <>{text('code', 'Code', { req: true, upper: true, hint: 'e.g. TSC' })}{text('name', 'Name', { req: true })}</>}
          {kind === 'products' && <>
            <Field label="OEM" required error={errors.oem_id} className="wide">
              <select value={f.oem_id || ''} onChange={set('oem_id')}><option value="">Choose…</option>{masters.oems.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
            </Field>
            {text('code', 'Code', { req: true, upper: true, hint: 'e.g. DESKTOP' })}{text('name', 'Name', { req: true })}
          </>}
          {kind === 'models' && <>
            <Field label="Product" required error={errors.product_id} className="wide">
              <select value={f.product_id || ''} onChange={set('product_id')}><option value="">Choose…</option>
                {masters.products.map((p) => <option key={p.id} value={p.id}>{masters.oems.find((o) => o.id === p.oem_id)?.code} · {p.name}</option>)}</select>
            </Field>
            {text('code', 'Model code', { req: true, hint: 'As printed on the RMA, e.g. TE310' })}{text('name', 'Description', { req: true })}
            <Field label="Device category" hint="Picks the category on a new RMA for this model" className="wide">
              <select value={f.category_id || ''} onChange={set('category_id')}><option value="">Not set</option>
                {(masters.categories || []).filter((c) => c.active || c.id === f.category_id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
            </Field>
          </>}
          {kind === 'categories' && <>
            {text('code', 'Code', { req: true, upper: true, hint: 'e.g. MT' })}{text('name', 'Name', { req: true, hint: 'e.g. Mobile terminal, Scanner' })}
            <label className="check wide"><input type="checkbox" checked={!!f.has_head} onChange={set('has_head')} />Has a print head (asks for printer and TPH mileage, and the print-head claim limit applies)</label>
          </>}
          {kind === 'cp_types' && <>{text('name', 'Name', { req: true, hint: 'e.g. 3 Year' })}{text('duration_years', 'Cover (years)', { req: true, type: 'number', hint: 'Cover ends this many years after the sales invoice date' })}</>}
        </div>
        {record.id && <label className="check"><input type="checkbox" checked={!!f.active} onChange={set('active')} />Active (shown in pick lists)</label>}
        <div className="row end">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Dialog>
  );
}
