import { useState } from 'react';
import { get, post } from '../api.js';
import { Dialog, ErrorPanel, Field, Icon, Skeleton, fmtMs, useLoad, useToast } from '../ui.jsx';
import { LinkDialog } from './Users.jsx';

export default function Companies({ user }) {
  const toast = useToast();
  const [data, reload, error] = useLoad(() => get('/api/owner/companies'));
  const [adding, setAdding] = useState(false);
  const [link, setLink] = useState(null);
  if (error && !data) return <ErrorPanel error={error} retry={reload} />;
  if (!data) return <Skeleton rows={3} />;
  async function toggle(c) {
    if (c.active && !confirm(`Switch off ${c.name}? Everyone there is signed out and can't log in until it's switched on again. Data is kept.`)) return;
    try {
      await post(`/api/owner/companies/${c.id}`, { active: !c.active });
      toast(c.active ? `${c.name} switched off` : `${c.name} switched on`);
      reload();
    } catch (e) {
      toast(e.message, true);
    }
  }
  return (
    <>
      <div className="page-head">
        <div><h1>Companies</h1>
          <p className="muted">Each company has its own data, its own logins and two-step login, and its own Admin. You see this list because you set up the app — it does not give you access to other companies' RMAs.</p></div>
        <button className="btn primary" onClick={() => setAdding(true)}><Icon name="plus" size={18} /> Add company</button>
      </div>
      <div className="tablewrap">
        <table className="data">
          <thead><tr><th>Company</th><th>Login code</th><th>RMA prefix</th><th>Active logins</th><th>Admin ready</th><th>Created</th><th /></tr></thead>
          <tbody>{data.map((c) => (
            <tr key={c.id} style={{ opacity: c.active ? 1 : 0.55 }}>
              <td><b>{c.name}</b>{c.id === user.company.id && <span className="pill" style={{ marginLeft: 6 }}>Yours</span>}</td>
              <td className="mono">{c.code}</td><td className="mono">{c.ticket_prefix}</td><td className="num">{c.users}</td>
              <td>{c.admins_ready ? <span className="pill ok">Yes</span> : <span className="pill warn">Invite pending</span>}</td>
              <td className="nowrap">{fmtMs(c.created_at)}</td>
              <td>{c.id !== user.company.id && <button className="btn ghost small" onClick={() => toggle(c)}>{c.active ? 'Switch off' : 'Switch on'}</button>}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      {adding && <AddCompany onClose={() => setAdding(false)} onDone={(r) => { setAdding(false); setLink(r); reload(); }} />}
      <LinkDialog result={link} company={link?.company} onClose={() => setLink(null)} />
    </>
  );
}

function AddCompany({ onClose, onDone }) {
  const [f, setF] = useState({ name: '', code: '', ticketPrefix: '', adminName: '', adminEmail: '' });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const codeSet = (k, n) => (e) => setF({ ...f, [k]: e.target.value.replace(/[^A-Za-z0-9]/g, '').slice(0, n) });
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      onDone(await post('/api/owner/companies', f));
    } catch (err) {
      setErrors({ form: Object.keys(err.fields || {}).length ? null : err.message, ...(err.fields || {}) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onClose={onClose} title="Add a company">
      <form className="stack" onSubmit={submit} noValidate>
        {errors.form && <div className="formerror">{errors.form}</div>}
        <Field label="Company name" required error={errors.name}><input type="text" autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <div className="fields">
          <Field label="Login code" required error={errors.code} hint="2–12 letters/numbers, typed at login"><input type="text" className="upper" value={f.code} onChange={codeSet('code', 12)} /></Field>
          <Field label="RMA prefix" error={errors.ticketPrefix} hint={`${(f.ticketPrefix || f.code || 'XYZ').toUpperCase()}-RMA-…`}><input type="text" className="upper" placeholder={f.code.toUpperCase()} value={f.ticketPrefix} onChange={codeSet('ticketPrefix', 8)} /></Field>
        </div>
        <h3 style={{ marginTop: 6 }}>Its first Admin</h3>
        <Field label="Name" required error={errors.adminName}><input type="text" value={f.adminName} onChange={(e) => setF({ ...f, adminName: e.target.value })} /></Field>
        <Field label="Email" required error={errors.adminEmail} hint="Can be your own email — it will be a separate login with its own password and authenticator entry">
          <input type="email" value={f.adminEmail} onChange={(e) => setF({ ...f, adminEmail: e.target.value })} /></Field>
        <div className="row end"><button type="button" className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy}>{busy ? 'Creating…' : 'Create and invite Admin'}</button></div>
      </form>
    </Dialog>
  );
}
