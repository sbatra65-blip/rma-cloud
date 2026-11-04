import { useRef, useState } from 'react';
import { api, del, downloadBlob, get, post } from '../api.js';
import { Field, Icon, fmtMs, useToast } from '../ui.jsx';

const TOKENS = ['INTERNAL_TICKET', 'CUSTOMER', 'PRINTER_MODEL', 'PRINTER_SERIAL', 'FAULTY_PART', 'FAULTY_PART_SERIAL', 'PART_CODE', 'FAULT_DESCRIPTION',
  'TPH_MILAGE', 'PRINTER_MILAGE', 'FW_VERSION', 'OEM_RMA', 'PO_NUMBER', 'EXCEL_FILE_STEM', 'COMPANY_NAME', 'COMPANY_EMAIL', 'COMPANY_PHONE'];

export default function Settings({ user, boot, reloadBoot, onUserChange }) {
  const toast = useToast();
  const s0 = boot.settings;
  const [f, setF] = useState({
    companyName: user.company.name, ticketPrefix: user.company.ticketPrefix,
    company_email: s0.company_email, company_phone: s0.company_phone, company_contact: s0.company_contact,
    company_address: s0.company_address, company_city: s0.company_city,
    oem_rma_email_to: s0.oem_rma_email_to, oem_rma_email_cc: s0.oem_rma_email_cc,
    oem_rma_email_subject: s0.oem_rma_email_subject, oem_rma_email_body: s0.oem_rma_email_body,
    reminder_emails: s0.reminder_emails !== '0', reminder_extra_to: s0.reminder_extra_to, awaiting_days: s0.awaiting_days,
  });
  const [tpl, setTpl] = useState(s0.template);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState('');
  const fileRef = useRef(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  async function save(e) {
    e.preventDefault();
    setBusy('save');
    setErrors({});
    try {
      await post('/api/settings', f);
      await reloadBoot();
      const me = await get('/api/auth/me');
      onUserChange(me.user);
      toast('Settings saved');
    } catch (err) {
      setErrors({ form: Object.keys(err.fields || {}).length ? 'Please fix the highlighted fields' : err.message, ...(err.fields || {}) });
    } finally {
      setBusy('');
    }
  }
  async function upload(file) {
    setBusy('tpl');
    try {
      const r = await api('POST', '/api/template', file, { headers: { 'X-File-Name': encodeURIComponent(file.name) } });
      setTpl(r.template);
      await reloadBoot();
      toast('Template uploaded. New OEM Excel files use it from now on.');
    } catch (err) {
      toast(err.fields?.template || err.message, true);
    } finally {
      setBusy('');
    }
  }
  async function revert() {
    if (!confirm('Go back to the built-in TSC RMA form?')) return;
    const r = await del('/api/template');
    setTpl(r.template);
    await reloadBoot();
    toast('Using the built-in template');
  }
  async function downloadTpl() {
    const res = await api('GET', '/api/template', undefined, { raw: true });
    downloadBlob(await res.blob(), tpl?.name || 'RMA_EXCEL_TEMPLATE.xlsx');
  }
  async function test() {
    setBusy('test');
    try {
      const r = await post('/api/reminders/test');
      toast(`Test email sent to ${r.to}`);
    } catch (err) {
      toast(err.message, true);
    } finally {
      setBusy('');
    }
  }

  return (
    <form onSubmit={save} noValidate>
      <div className="page-head"><div><h1>Company settings</h1><p className="muted">Only for {user.company.name}. Other companies have their own settings.</p></div></div>
      {errors.form && <div className="formerror" style={{ marginBottom: 14 }}>{errors.form}</div>}

      <section className="panel">
        <h2>Company</h2>
        <div className="fields">
          <Field label="Company name" required error={errors.companyName}><input type="text" value={f.companyName} onChange={set('companyName')} /></Field>
          <Field label="Login company code" hint="Fixed. People type it when they log in."><input type="text" className="upper" value={user.company.code} readOnly disabled /></Field>
          <Field label="RMA number prefix" error={errors.ticketPrefix} hint={`New RMAs: ${(f.ticketPrefix || '').toUpperCase()}-RMA-YYYYMM-0001. Old numbers don't change.`}>
            <input type="text" className="upper" maxLength={8} value={f.ticketPrefix} onChange={(e) => setF({ ...f, ticketPrefix: e.target.value.replace(/[^A-Za-z0-9]/g, '') })} /></Field>
          <Field label="Contact person" error={errors.company_contact}><input type="text" value={f.company_contact} onChange={set('company_contact')} /></Field>
          <Field label="Email" error={errors.company_email} hint="Shown in OEM emails; OEM replies come here"><input type="email" value={f.company_email} onChange={set('company_email')} /></Field>
          <Field label="Phone" error={errors.company_phone}><input type="tel" value={f.company_phone} onChange={set('company_phone')} /></Field>
          <Field label="City" error={errors.company_city}><input type="text" value={f.company_city} onChange={set('company_city')} /></Field>
          <Field label="Address" error={errors.company_address} className="wide"><textarea rows={2} style={{ minHeight: 60 }} value={f.company_address} onChange={set('company_address')} /></Field>
        </div>
      </section>

      <section className="panel">
        <h2>Email to the OEM</h2>
        <div className="fields">
          <Field label="To" required error={errors.oem_rma_email_to} hint="Separate several with commas"><input type="text" value={f.oem_rma_email_to} onChange={set('oem_rma_email_to')} /></Field>
          <Field label="Cc" error={errors.oem_rma_email_cc}><input type="text" value={f.oem_rma_email_cc} onChange={set('oem_rma_email_cc')} /></Field>
          <Field label="Subject" error={errors.oem_rma_email_subject} className="wide"><input type="text" value={f.oem_rma_email_subject} onChange={set('oem_rma_email_subject')} /></Field>
          <Field label="Message" error={errors.oem_rma_email_body} className="wide"><textarea rows={12} value={f.oem_rma_email_body} onChange={set('oem_rma_email_body')} /></Field>
        </div>
        <p className="muted small" style={{ marginTop: 8 }}>Fill-ins: {TOKENS.map((t) => <code key={t} className="mono" style={{ marginRight: 6, whiteSpace: 'nowrap' }}>{`{{${t}}}`}</code>)}</p>
      </section>

      <section className="panel">
        <h2>OEM Excel form</h2>
        <p className="muted small" style={{ marginBottom: 12 }}>The form is copied for each RMA and these marks are filled in: @@PRINTER_MODEL@@, @@PRINTER_SERIAL@@, @@FAULTY_PART@@, @@FAULTY_PART_SERIAL@@, @@PART_CODE@@, @@FAULT_DESCRIPTION@@,
          @@TPH_MILAGE@@, @@PRINTER_MILAGE@@ (and any fill-in above). Up to five inbound photos go where @@photo1@@ … @@photo5@@ are.</p>
        <div className="spread">
          <div><b>{tpl ? tpl.name : 'Built-in TSC RMA form'}</b>{tpl && <div className="muted small">Uploaded {fmtMs(tpl.updated_at, true)} by {tpl.updated_by}</div>}</div>
          <div className="row">
            <button type="button" className="btn ghost small" onClick={downloadTpl}><Icon name="download" size={16} /> Download</button>
            <button type="button" className="btn ghost small" disabled={busy === 'tpl'} onClick={() => fileRef.current.click()}><Icon name="upload" size={16} /> {busy === 'tpl' ? 'Uploading…' : 'Upload your own'}</button>
            {tpl && <button type="button" className="btn danger small" onClick={revert}>Use built-in</button>}
            <input ref={fileRef} type="file" accept=".xlsx" hidden onChange={(e) => { if (e.target.files[0]) upload(e.target.files[0]); e.target.value = ''; }} />
          </div>
        </div>
      </section>

      <section className="panel">
        <h2>Daily reminder email</h2>
        <div className="stack">
          <label className="check"><input type="checkbox" checked={f.reminder_emails} onChange={set('reminder_emails')} />Email Admins and Managers at 9 am when RMAs need a next step</label>
          <div className="fields">
            <Field label="Also send to" error={errors.reminder_extra_to} hint="Optional, separate with commas"><input type="text" value={f.reminder_extra_to} onChange={set('reminder_extra_to')} /></Field>
            <Field label="Chase OEM after (days)" error={errors.awaiting_days}><input type="number" min="1" max="60" value={f.awaiting_days} onChange={set('awaiting_days')} /></Field>
          </div>
          <div><button type="button" className="btn ghost small" disabled={busy === 'test'} onClick={test}><Icon name="mail" size={16} /> {busy === 'test' ? 'Sending…' : `Send me a test (${user.email})`}</button></div>
        </div>
      </section>

      <div className="savebar"><button className="btn primary" disabled={busy === 'save'}>{busy === 'save' ? 'Saving…' : 'Save settings'}</button></div>
    </form>
  );
}
