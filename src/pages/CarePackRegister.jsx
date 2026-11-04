import { useEffect, useMemo, useRef, useState } from 'react';
import { del, get, post } from '../api.js';
import { pdfText } from '../pdftext.js';
import { detectBrandFromModel, eqCI, parseInvoicePdfText, serialsFromAnything } from '../../worker/catalog.js';
import { Field, Icon, Link, ago, can, navigate, todayISO, useToast } from '../ui.jsx';

const blankProduct = () => ({ printer_item_name: '', care_pack_item_name: '', printer_model: '', oem_brand: '', care_pack_type: '', qty: '', serial_text: '', edit_reason: '', added: false });
const blankHeader = () => ({ invoice_number: '', source_invoice_number: '', customer_name: '', customer_city: '', invoice_date: '', irn: '', irn_ack_no: '', irn_ack_date: '', notes: '', edit_reason: '', admin_override: false, override_confirmed: false });

export default function CarePackRegister({ user, boot }) {
  const toast = useToast();
  const [mode, setMode] = useState('manual'); // manual | pdf | zoho
  const [h, setH] = useState(blankHeader);
  const [products, setProducts] = useState([blankProduct()]);
  const [zohoNo, setZohoNo] = useState('');
  const [zohoInfo, setZohoInfo] = useState(null);
  const [busy, setBusy] = useState('');
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState('');
  const [warnings, setWarnings] = useState([]);
  const [draft, setDraft] = useState(null);
  const [savedAt, setSavedAt] = useState(null);
  const touched = useRef(false);
  const types = boot.masters.cp_types?.filter((t) => t.active) || [];
  const brands = boot.carePack?.brands || ['TSC Auto ID', 'Printronix', 'Honeywell'];
  const models = useMemo(() => boot.masters.models.filter((m) => m.active).map((m) => m.code), [boot]);
  const admin = can.admin(user);

  useEffect(() => { get('/api/carepack/draft').then((r) => r.draft && setDraft(r.draft)).catch(() => {}); }, []);
  // Autosave to the server so a refresh or a dropped phone connection does not lose a long serial list.
  useEffect(() => {
    if (!touched.current) return undefined;
    const t = setTimeout(() => {
      post('/api/carepack/draft', { data: { mode, h, products, zohoNo } }).then(() => setSavedAt(Date.now())).catch(() => {});
    }, 1500);
    return () => clearTimeout(t);
  }, [mode, h, products, zohoNo]);

  const setHead = (k, v) => { touched.current = true; setH((x) => ({ ...x, [k]: v })); };
  const setProd = (i, k, v) => { touched.current = true; setProducts((ps) => ps.map((p, j) => (j === i ? { ...p, [k]: v } : p))); };
  const pickType = (i, name) => {
    setProd(i, 'care_pack_type', name);
  };

  function restore() {
    const d = draft.data || {};
    setMode(d.mode || 'manual');
    setH({ ...blankHeader(), ...(d.h || {}) });
    setProducts(d.products?.length ? d.products : [blankProduct()]);
    setZohoNo(d.zohoNo || '');
    setDraft(null);
    touched.current = true;
    toast('Draft restored.');
  }
  async function discard() {
    await del('/api/carepack/draft').catch(() => {});
    setDraft(null);
  }

  async function readPdf(file) {
    if (!file) return;
    setBusy('pdf');
    setWarnings([]);
    try {
      const text = await pdfText(file);
      if (text.replace(/\s/g, '').length < 40) throw new Error('This PDF has no readable text (probably a scan). Enter the invoice manually.');
      const r = parseInvoicePdfText(text);
      touched.current = true;
      setH((x) => ({ ...x, invoice_number: r.invoiceNumber || x.invoice_number, source_invoice_number: r.invoiceNumber || '', customer_name: r.customerName || x.customer_name,
        customer_city: r.customerCity || x.customer_city, invoice_date: r.invoiceDate || x.invoice_date, irn: r.irn || '', irn_ack_no: r.irnAckNo || '' }));
      setProducts([{ ...blankProduct(), printer_item_name: r.printerItemName || '', care_pack_item_name: r.carePackItemName || '', printer_model: r.printerModel || '',
        oem_brand: r.oemBrand || '', care_pack_type: r.carePackType || '', qty: String(r.qty || ''), serial_text: r.serials.join('\n') }]);
      setWarnings(['Read from the PDF — check every field before you register.', ...r.warnings]);
    } catch (e) {
      toast(e.message || 'Could not read that PDF.', true);
    } finally { setBusy(''); }
  }

  async function loadZoho() {
    if (!zohoNo.trim()) { setErrors({ zoho: 'Enter the sales invoice number' }); return; }
    setBusy('zoho');
    setErrors({});
    setFormError('');
    try {
      const r = await post('/api/carepack/zoho-preview', { invoice_number: zohoNo.trim() });
      const inv = r.invoice;
      touched.current = true;
      setZohoInfo({ ...inv, alreadyImported: r.alreadyImported });
      setH({ ...blankHeader(), invoice_number: inv.invoiceNumber, source_invoice_number: inv.invoiceNumber, customer_name: inv.customerName || '', customer_city: inv.customerCity || '',
        invoice_date: inv.date || '', irn: inv.irn || '', irn_ack_no: inv.irnAckNo || '', irn_ack_date: inv.irnAckDate || '' });
      setProducts(r.sets.map((s) => ({ ...blankProduct(), line_set_index: s.setIndex, printer_item_name: s.printerItemName || '', care_pack_item_name: s.carePackItemName || '',
        printer_model: s.printerModel || '', oem_brand: s.oemBrand || '', care_pack_type: s.carePackType || '', qty: String(s.qty || ''), serial_text: (s.serials || []).join('\n'),
        source: { brand: s.oemBrand, model: s.printerModel, mismatch: s.mismatch?.hasMismatch ? s.mismatch.message : null } })));
      setWarnings([r.alreadyImported?.length ? `Product set(s) ${r.alreadyImported.join(', ')} of this invoice are already registered and are not shown.` : null,
        ...r.sets.filter((s) => s.mismatch?.hasMismatch).map((s) => `Set #${s.setIndex}: ${s.mismatch.message}`)].filter(Boolean));
    } catch (e) {
      setFormError(e.message);
    } finally { setBusy(''); }
  }

  async function submit(e) {
    e.preventDefault();
    setBusy('save');
    setErrors({});
    setFormError('');
    try {
      const body = { ...h, source: mode, products: products.map((p) => ({ ...p, qty: p.qty ? Number(p.qty) : undefined, source: undefined,
        cp_type_id: types.find((t) => t.name === p.care_pack_type)?.id })) };
      const r = await post('/api/carepack/register', body);
      toast(`Registered ${r.ids.length} product set(s).`);
      navigate(`/care-packs/${r.ids[0]}`);
    } catch (err) {
      setErrors({ ...err.fields, ...(err.data?.field ? { [err.data.field]: err.message } : {}) });
      setFormError(err.fields?._ || err.message);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally { setBusy(''); }
  }

  const invoiceChanged = h.source_invoice_number && !eqCI(h.source_invoice_number, h.invoice_number);
  const total = products.reduce((a, p) => a + serialsFromAnything(p.serial_text).length, 0);

  return (
    <form onSubmit={submit} noValidate>
      <div className="page-head"><div>
        <Link to="/care-packs" className="small muted" style={{ textDecoration: 'none' }}>← Care packs</Link>
        <h1>Register care pack</h1>
        <p className="muted">One sales invoice, one or more printer + care pack sets, one serial per unit. {savedAt && <span className="tiny">Draft saved {ago(savedAt)}.</span>}</p>
      </div></div>

      {draft && (
        <div className="notice row" style={{ justifyContent: 'space-between' }}>
          <span>You have an unfinished registration from {ago(draft.savedAt)}.</span>
          <span className="row"><button type="button" className="btn primary small" onClick={restore}>Restore draft</button>
            <button type="button" className="btn ghost small" onClick={discard}>Discard</button></span>
        </div>
      )}
      {formError && <div className="formerror" role="alert">{formError}</div>}
      {warnings.map((w) => <div key={w} className="warnbox small">{w}</div>)}

      <section className="panel">
        <div className="tabs" role="tablist" style={{ marginBottom: 14 }}>
          {[['manual', 'Type it in'], ['pdf', 'From invoice PDF'], ['zoho', 'From Zoho Books']].map(([k, l]) => (
            <button type="button" key={k} role="tab" aria-selected={mode === k} onClick={() => { setMode(k); touched.current = true; }}>{l}</button>))}
        </div>
        {mode === 'pdf' && (
          <Field label="Sales invoice PDF" hint="Text PDFs only. Everything read from it can be corrected below.">
            <input type="file" accept="application/pdf,.pdf" disabled={busy === 'pdf'} onChange={(e) => readPdf(e.target.files?.[0])} />
          </Field>
        )}
        {mode === 'zoho' && (
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <Field label="Sales invoice number in Zoho Books" error={errors.zoho} className="wide">
              <input type="text" value={zohoNo} onChange={(e) => { setZohoNo(e.target.value); touched.current = true; }} placeholder={`${boot.settings?.invoice_prefix || boot.settings?.cpSettings?.invoice_prefix || 'IS-GST-2627-'}0001`} />
            </Field>
            <button type="button" className="btn primary" disabled={busy === 'zoho'} onClick={loadZoho}>{busy === 'zoho' ? 'Loading…' : 'Load invoice'}</button>
          </div>
        )}
        {mode === 'zoho' && zohoInfo && <p className="small muted" style={{ marginTop: 8 }}>Zoho invoice {zohoInfo.invoiceNumber} · {zohoInfo.status} · total {zohoInfo.total?.toLocaleString('en-IN')}{zohoInfo.irn ? ' · has IRN' : ''}</p>}
      </section>

      <section className="panel">
        <h2>Sales invoice</h2>
        <div className="fields">
          <Field label="Invoice number" required error={errors.invoice_number}><input type="text" value={h.invoice_number} onChange={(e) => setHead('invoice_number', e.target.value)} /></Field>
          <Field label="Sales invoice date" required error={errors.invoice_date}><input type="date" max={todayISO()} value={h.invoice_date} onChange={(e) => setHead('invoice_date', e.target.value)} /></Field>
          <Field label="Customer" error={errors.customer_name}><input type="text" value={h.customer_name} onChange={(e) => setHead('customer_name', e.target.value)} list="cp-customers" /></Field>
          <Field label="City" error={errors.customer_city}><input type="text" value={h.customer_city} onChange={(e) => setHead('customer_city', e.target.value)} /></Field>
          <Field label="IRN" hint="E-invoice reference, if any" error={errors.irn}><input type="text" value={h.irn} onChange={(e) => setHead('irn', e.target.value)} className="mono" /></Field>
          <Field label="Ack no." error={errors.irn_ack_no}><input type="text" value={h.irn_ack_no} onChange={(e) => setHead('irn_ack_no', e.target.value)} /></Field>
        </div>
        <datalist id="cp-customers">{boot.masters.customers.filter((c) => c.active).map((c) => <option key={c.id} value={c.name} />)}</datalist>
        <Field label="Notes" error={errors.notes} className="wide"><textarea rows={2} value={h.notes} onChange={(e) => setHead('notes', e.target.value)} /></Field>
        {(invoiceChanged || mode === 'zoho' || h.irn) && (
          <Field label={`Edit reason${invoiceChanged && h.irn ? ' (required — invoice number changed on an IRN invoice)' : ''}`} error={errors.edit_reason}
            hint="Needed when you change anything that came from Zoho / the IRN invoice.">
            <input type="text" value={h.edit_reason} onChange={(e) => setHead('edit_reason', e.target.value)} />
          </Field>
        )}
      </section>

      {products.map((p, i) => {
        const n = serialsFromAnything(p.serial_text).length;
        const qty = Number(p.qty) || 0;
        const modelBrand = detectBrandFromModel(p.printer_model);
        const contradiction = modelBrand && p.oem_brand && !eqCI(modelBrand, p.oem_brand);
        const changed = p.source && (!eqCI(p.source.brand, p.oem_brand) || !eqCI(p.source.model, p.printer_model));
        return (
          <section className="panel" key={i}>
            <div className="spread"><h2>Product set {p.line_set_index ? `#${p.line_set_index}` : i + 1}{p.added && <span className="pill warn" style={{ marginLeft: 8 }}>Added</span>}</h2>
              {products.length > 1 && <button type="button" className="btn ghost small" onClick={() => { touched.current = true; setProducts((ps) => ps.filter((_, j) => j !== i)); }}><Icon name="trash" size={16} /> Remove</button>}</div>
            {p.source?.mismatch && <div className="formerror small">{p.source.mismatch}</div>}
            <div className="fields">
              <Field label="Printer item (as on invoice)"><input type="text" value={p.printer_item_name} onChange={(e) => setProd(i, 'printer_item_name', e.target.value)} /></Field>
              <Field label="Care pack item (as on invoice)"><input type="text" value={p.care_pack_item_name} onChange={(e) => setProd(i, 'care_pack_item_name', e.target.value)} /></Field>
              <Field label="OEM brand" required error={errors[`p${i}_oem_brand`]}>
                <select value={p.oem_brand} onChange={(e) => setProd(i, 'oem_brand', e.target.value)}><option value="">Choose…</option>{brands.map((b) => <option key={b}>{b}</option>)}</select>
              </Field>
              <Field label="Printer model" required error={errors[`p${i}_printer_model`]} hint={contradiction ? `${p.printer_model} is a ${modelBrand} model — fix it, or Admin override below.` : null}>
                <input type="text" value={p.printer_model} onChange={(e) => setProd(i, 'printer_model', e.target.value)} list="cp-models" />
              </Field>
              <Field label="Care pack length" required error={errors[`p${i}_care_pack_type`]}>
                <select value={p.care_pack_type} onChange={(e) => pickType(i, e.target.value)}>
                  <option value="">Choose…</option>
                  {(types.length ? types.map((t) => t.name) : boot.carePack?.types || []).map((t) => <option key={t}>{t}</option>)}
                  {p.care_pack_type && !types.some((t) => t.name === p.care_pack_type) && <option>{p.care_pack_type}</option>}
                </select>
              </Field>
              <Field label="Qty (units)" hint="Leave blank to use the serial count"><input type="text" inputMode="numeric" value={p.qty} onChange={(e) => setProd(i, 'qty', e.target.value.replace(/\D/g, ''))} /></Field>
            </div>
            <Field label="Printer serial numbers" className="wide" required error={errors[`p${i}_serials`]}
              hint={<span className={qty && qty !== n ? "warntext" : ""}>{n} serial{n === 1 ? '' : 's'} found{qty ? ` · qty ${qty}` : ''}. One per line, or separated by commas/spaces. Labels like “S/N:” are ignored.</span>}>
              <textarea rows={Math.min(10, Math.max(3, n + 1))} className="mono" value={p.serial_text} onChange={(e) => setProd(i, 'serial_text', e.target.value)} />
            </Field>
            {(changed || p.added) && (
              <Field label="Reason for change from Zoho" error={errors[`p${i}_edit_reason`]}><input type="text" value={p.edit_reason} onChange={(e) => setProd(i, 'edit_reason', e.target.value)} /></Field>
            )}
          </section>
        );
      })}
      <datalist id="cp-models">{models.map((m) => <option key={m} value={m} />)}</datalist>
      <button type="button" className="btn ghost" onClick={() => { touched.current = true; setProducts((ps) => [...ps, { ...blankProduct(), added: mode === 'zoho' }]); }}>
        <Icon name="plus" size={18} /> Add another product set</button>

      {admin && (
        <section className="panel" style={{ marginTop: 16 }}>
          <label className="check"><input type="checkbox" checked={h.admin_override} onChange={(e) => setHead('admin_override', e.target.checked)} /> Admin override (brand does not match model / invoice wording)</label>
          {h.admin_override && (
            <>
              <Field label="Override reason" required error={errors.edit_reason}><input type="text" value={h.edit_reason} onChange={(e) => setHead('edit_reason', e.target.value)} /></Field>
              <label className="check"><input type="checkbox" checked={h.override_confirmed} onChange={(e) => setHead('override_confirmed', e.target.checked)} /> I confirm this override. It is logged with my name.</label>
            </>
          )}
        </section>
      )}

      <div className="savebar">
        <Link to="/care-packs" className="btn ghost">Cancel</Link><span className="muted small" style={{ flex: 1 }}>{products.length} set(s) · {total} serial(s)</span>
        <button className="btn primary" disabled={busy === 'save'}>{busy === 'save' ? 'Registering…' : 'Register care pack'}</button>
      </div>
    </form>
  );
}
