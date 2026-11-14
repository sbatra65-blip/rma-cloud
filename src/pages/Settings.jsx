import { useEffect, useRef, useState } from 'react';
import { api, del, downloadBlob, get, post } from '../api.js';
import { CompanyLogo, Field, Icon, copyText, fmtMs, shrinkImage, useToast } from '../ui.jsx';

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
    head_claim_limit: s0.head_claim_limit ?? '2', customer_updates: s0.customer_updates !== '0',
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
    <>
    <form onSubmit={save} noValidate>
      <div className="page-head"><div><h1>Company settings</h1><p className="muted">Only for {user.company.name}. Other companies have their own settings.</p></div></div>
      {errors.form && <div className="formerror" style={{ marginBottom: 14 }}>{errors.form}</div>}

      <LogoPanel boot={boot} reloadBoot={reloadBoot} />

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
        <h2>Print-head claims</h2>
        <div className="fields">
          <Field label="Print-head RMAs per printer before a reason is needed" error={errors.head_claim_limit}
            hint="From the next one, the person raising the RMA sees a warning and must give a reason. 0 turns it off. Only for device categories with a print head.">
            <input type="number" min="0" max="20" value={f.head_claim_limit} onChange={set('head_claim_limit')} />
          </Field>
        </div>
      </section>

      <section className="panel">
        <h2>Customer status updates</h2>
        <div className="stack">
          <label className="check"><input type="checkbox" checked={f.customer_updates} onChange={set('customer_updates')} />Email customers a status link when an RMA is raised, sent to the OEM, back from the OEM, dispatched and closed</label>
          <p className="muted small">Uses the customer email on each RMA. Emails show your company name, and replies come to your company email above. Customers can also check any time at <b>{location.origin}/track</b> with the RMA number.</p>
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
    {user.company.modules?.includes('carepack') && <CarePackSettings s0={s0} reloadBoot={reloadBoot} />}
    {user.company.modules?.includes('zoho') && <ZohoSettings s0={s0} reloadBoot={reloadBoot} />}
    <MigrationPanel />
    </>
  );
}

function CarePackSettings({ s0, reloadBoot }) {
  const toast = useToast();
  const [f, setF] = useState({
    invoice_prefix: s0.invoice_prefix || '', carepack_po_deadline_days: s0.carepack_po_deadline_days || '25', carepack_oem_payment_deadline_days: s0.carepack_oem_payment_deadline_days || '40',
    challan_enabled: s0.challan_enabled !== '0', challan_auto_dispatch: s0.challan_auto_dispatch !== '0',
    challan_line_description: s0.challan_line_description || '', challan_notes: s0.challan_notes || '',
  });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    try {
      await post('/api/settings/carepack', f);
      await reloadBoot();
      toast('Care pack settings saved');
    } catch (err) {
      setErrors({ form: err.message, ...(err.fields || {}) });
    } finally { setBusy(false); }
  }
  return (
    <form onSubmit={save} noValidate style={{ marginTop: 16 }}>
      <section className="panel">
        <h2>Care packs</h2>
        {errors.form && <div className="formerror">{errors.form}</div>}
        <div className="fields">
          <Field label="Sales invoice prefix" error={errors.invoice_prefix} hint="Shown as a hint when loading from Zoho"><input type="text" value={f.invoice_prefix} onChange={set('invoice_prefix')} /></Field>
          <span />
          <Field label="OEM PO deadline (days after sales invoice)" error={errors.carepack_po_deadline_days} hint="Contract maximum is 30"><input type="number" min="1" max="30" value={f.carepack_po_deadline_days} onChange={set('carepack_po_deadline_days')} /></Field>
          <Field label="OEM payment deadline (days after OEM bill)" error={errors.carepack_oem_payment_deadline_days} hint="Contract maximum is 45"><input type="number" min="1" max="45" value={f.carepack_oem_payment_deadline_days} onChange={set('carepack_oem_payment_deadline_days')} /></Field>
        </div>
        <h3 style={{ marginTop: 18 }}>Delivery challan (Zoho Books)</h3>
        <div className="stack">
          <label className="check"><input type="checkbox" checked={f.challan_enabled} onChange={set('challan_enabled')} />Show "Create delivery challan" when sending goods back to the customer</label>
          <label className="check"><input type="checkbox" checked={f.challan_auto_dispatch} onChange={set('challan_auto_dispatch')} />Fill the challan number into the dispatch form automatically</label>
          <div className="fields">
            <Field label="Challan line description" error={errors.challan_line_description} className="wide" hint="Fill-ins like {{INTERNAL_TICKET}}, {{PRINTER_MODEL}}, {{PRINTER_SERIAL}}, {{FAULTY_PART}}"><textarea rows={2} value={f.challan_line_description} onChange={set('challan_line_description')} /></Field>
            <Field label="Challan notes" error={errors.challan_notes} className="wide"><textarea rows={2} value={f.challan_notes} onChange={set('challan_notes')} /></Field>
          </div>
        </div>
        <div className="row end" style={{ marginTop: 12 }}><button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Save care pack settings'}</button></div>
      </section>
    </form>
  );
}

function ZohoSettings({ s0, reloadBoot }) {
  const toast = useToast();
  const [f, setF] = useState({ dc: s0.zoho_dc || 'in', org_id: s0.zoho_org_id || '', client_id: s0.zoho_client_id || '', client_secret: '' });
  const [st, setSt] = useState({ connected: !!s0.zoho_connected, secret: !!s0.zoho_secret_set });
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function act(kind, fn) {
    setBusy(kind);
    setMsg(null);
    try {
      const r = await fn();
      if (r && 'zoho_connected' in r) setSt({ connected: !!r.zoho_connected, secret: !!r.zoho_secret_set });
      if (r?.message) setMsg({ ok: true, text: r.message });
      await reloadBoot();
      return r;
    } catch (err) {
      setMsg({ ok: false, text: err.message });
      return null;
    } finally { setBusy(''); }
  }
  return (
    <section className="panel" style={{ marginTop: 16 }}>
      <div className="spread"><h2>Zoho Books</h2><span className={`pill ${st.connected ? 'ok' : 'warn'}`}>{st.connected ? 'Connected' : 'Not connected'}</span></div>
      <p className="muted small">Used to load sales invoices and OEM POs for care packs, and to create delivery challans. Each company connects its own Zoho organisation.
        In <a href="https://api-console.zoho.com" target="_blank" rel="noreferrer">api-console.zoho.com</a> create a <b>Self Client</b>, copy its Client ID and Secret here, then generate a grant code with scope
        <code className="mono"> ZohoBooks.invoices.READ,ZohoBooks.purchaseorders.READ,ZohoBooks.contacts.READ,ZohoBooks.deliverychallans.CREATE,ZohoBooks.settings.READ</code> and paste it below.</p>
      {msg && <div className={msg.ok ? 'notice' : 'formerror'} style={{ marginTop: 10 }}>{msg.text}</div>}
      <form className="fields" style={{ marginTop: 12 }} onSubmit={(e) => { e.preventDefault(); act('save', () => post('/api/settings/zoho', f)).then((r) => { if (r) { toast('Zoho details saved'); setF({ ...f, client_secret: '' }); } }); }}>
        <Field label="Data centre"><select value={f.dc} onChange={set('dc')}>{[['in', 'India (.in)'], ['com', 'US (.com)'], ['eu', 'Europe (.eu)'], ['au', 'Australia (.com.au)'], ['jp', 'Japan (.jp)'], ['ca', 'Canada (.ca)'], ['sa', 'Saudi (.sa)']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
        <Field label="Organisation ID" hint="Zoho Books → Settings → Organisation profile"><input type="text" value={f.org_id} onChange={set('org_id')} /></Field>
        <Field label="Client ID"><input type="text" value={f.client_id} onChange={set('client_id')} autoComplete="off" /></Field>
        <Field label="Client secret" hint={st.secret ? 'Saved (encrypted). Type to replace.' : 'Stored encrypted'}><input type="password" value={f.client_secret} onChange={set('client_secret')} autoComplete="new-password" /></Field>
        <div className="wide row"><button className="btn ghost" disabled={busy === 'save'}>{busy === 'save' ? 'Saving…' : 'Save Zoho details'}</button></div>
      </form>
      <div className="row" style={{ alignItems: 'flex-end', marginTop: 14 }}>
        <Field label="Grant code (valid a few minutes)" className="wide"><input type="text" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" /></Field>
        <button type="button" className="btn primary" disabled={busy === 'connect' || !code.trim()} onClick={() => act('connect', () => post('/api/settings/zoho/connect', { grant_code: code })).then((r) => r && setCode(''))}>{busy === 'connect' ? 'Connecting…' : 'Connect'}</button>
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <button type="button" className="btn ghost small" disabled={!st.connected || busy === 'test'} onClick={() => act('test', () => post('/api/settings/zoho/test'))}>{busy === 'test' ? 'Testing…' : 'Test connection'}</button>
        {(st.connected || st.secret) && <button type="button" className="btn danger small" disabled={busy === 'dis'} onClick={() => { if (confirm('Disconnect Zoho Books for this company? The saved secret and token are deleted.')) act('dis', () => del('/api/settings/zoho')); }}>Disconnect</button>}
      </div>
    </section>
  );
}

// Move data from the old Windows RMA System (SQL Server + photo folders) with the PowerShell tool.
function MigrationPanel() {
  const toast = useToast();
  const [st, setSt] = useState(null);
  const [key, setKey] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => get('/api/admin/migration-key').then(setSt).catch(() => {});
  useEffect(() => { load(); }, []);
  const origin = location.origin;
  const cmd = key ? `Unblock-File .\\migrate-rma.ps1; powershell -NoProfile -ExecutionPolicy Bypass -File .\\migrate-rma.ps1 -Url ${origin} -Key ${key.key}` : '';
  async function create() {
    setBusy(true);
    try { setKey(await post('/api/admin/migration-key')); load(); } catch (e) { toast(e.message, true); } finally { setBusy(false); }
  }
  async function revoke() {
    setBusy(true);
    try { await del('/api/admin/migration-key'); setKey(null); load(); toast('Migration key cancelled'); } catch (e) { toast(e.message, true); } finally { setBusy(false); }
  }
  return (
    <section className="panel" style={{ marginTop: 16 }}>
      <h2>Move data from the old system</h2>
      <p className="muted small" style={{ marginTop: 4 }}>
        Copies RMAs, their photos (from the photo folders), OEM batches, customers, models and care packs from the old Windows RMA System into this company.
        It only reads the old system, and can be run again safely — anything already here is skipped.
      </p>
      <ol className="small" style={{ margin: '12px 0 12px 18px', lineHeight: 1.7 }}>
        <li>On the PC where the old RMA System and SQL Server run, <a href="/migrate-rma.ps1" download>download the migration tool</a> (migrate-rma.ps1).</li>
        <li>Create a migration key below (valid 48 hours) and copy the command.</li>
        <li>On that PC, open PowerShell in the folder with the tool and paste the command. Add <code>-DryRun</code> first to only count.
          The command starts with <code>Unblock-File</code> because Windows blocks scripts downloaded from the internet.</li>
      </ol>
      {key ? (
        <div className="stack">
          <div className="warnbox small">This key is shown only now. Anyone with it can add data to this company until it expires or you cancel it.</div>
          <p className="secret" style={{ wordBreak: 'break-all' }}>{cmd}</p>
          <div className="row">
            <button className="btn primary small" onClick={async () => toast(await copyText(cmd) ? 'Command copied' : 'Copy it by hand')}><Icon name="copy" size={16} /> Copy command</button>
            <button className="btn ghost small" disabled={busy} onClick={revoke}>Cancel key</button>
          </div>
        </div>
      ) : (
        <div className="row">
          <button className="btn primary small" disabled={busy} onClick={create}>{st?.active ? 'Create a new key' : 'Create migration key'}</button>
          {st?.active && <><span className="small muted">A key made by {st.by} is active until {new Date(st.expires).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}.</span>
            <button className="btn ghost small" disabled={busy} onClick={revoke}>Cancel key</button></>}
        </div>
      )}
    </section>
  );
}

// Company logo: shown in the header, on the dashboard and on printouts.
function LogoPanel({ boot, reloadBoot }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const input = useRef(null);
  async function upload(file) {
    if (!file) return;
    setBusy(true); setError(null);
    try {
      const blob = await shrinkImage(file, 512);
      if (blob.size > 1024 * 1024) throw new Error('Logo is still over 1 MB after shrinking; use a simpler image');
      await api('POST', '/api/company/logo', blob, { headers: { 'Content-Type': blob.type } });
      await reloadBoot();
      toast('Logo saved');
    } catch (e) { setError(e.fields?.logo || e.message); } finally { setBusy(false); if (input.current) input.current.value = ''; }
  }
  async function remove() {
    setBusy(true);
    try { await del('/api/company/logo'); await reloadBoot(); toast('Logo removed'); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  const has = !!boot.settings?.logoAt;
  return (
    <section className="panel">
      <h2>Company logo</h2>
      <p className="muted small" style={{ margin: '4px 0 12px' }}>Shown at the top of the app, on the dashboard and on printouts. PNG with a transparent background works best; it is resized to 512 px.</p>
      <div className="row" style={{ alignItems: 'center', gap: 16 }}>
        <div className="logo-preview">{has ? <CompanyLogo boot={boot} height={64} /> : <span className="muted small">No logo yet</span>}</div>
        <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => upload(e.target.files?.[0])} />
        <button type="button" className="btn ghost" disabled={busy} onClick={() => input.current?.click()}><Icon name="upload" size={18} /> {busy ? 'Saving…' : has ? 'Change logo' : 'Upload logo'}</button>
        {has && <button type="button" className="btn ghost danger-text" disabled={busy} onClick={remove}>Remove</button>}
      </div>
      {error && <p className="small" style={{ color: 'var(--rust)', marginTop: 8 }}>{error}</p>}
    </section>
  );
}
