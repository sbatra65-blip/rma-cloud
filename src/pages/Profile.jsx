import { useState } from 'react';
import { post } from '../api.js';
import { Field, Icon, Strength, ThemePicker, VersionLabel, passwordScore, useToast } from '../ui.jsx';

export default function Profile({ user, idleMinutes, onLogout }) {
  return (
    <>
      <div className="page-head"><div><h1>{user.name}</h1><p className="muted">{user.email} · {user.role}{user.isOwner ? ' · Owner' : ''}</p></div></div>
      <div className="grid2">
        <ThemePicker />
        <section className="panel">
          <h2>This login</h2>
          <dl className="kv">
            <dt>Company</dt><dd>{user.company.name}</dd>
            <dt>Company code</dt><dd className="mono">{user.company.code}</dd>
            <dt>Role</dt><dd>{user.role}{user.dupOverride && user.role !== 'Admin' ? ' · can override duplicates' : ''}</dd>
            <dt>Recovery codes left</dt><dd>{user.recoveryLeft}</dd>
            <dt>Auto sign-out</dt><dd>After {idleMinutes} minutes without activity</dd>
          </dl>
          <p className="muted small" style={{ marginTop: 12 }}>This login, its password and its authenticator entry work only for {user.company.name}. A login at another company is separate.</p>
          <button className="btn ghost" style={{ marginTop: 14 }} onClick={onLogout}><Icon name="logout" size={18} /> Log out</button>
        </section>
        <ChangePassword user={user} />
        <RecoveryCodes user={user} />
      </div>
      <VersionLabel />
    </>
  );
}

function ChangePassword({ user }) {
  const toast = useToast();
  const [f, setF] = useState({ current: '', password: '', confirm: '', code: '' });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const pw = passwordScore(f.password, user.email);
  async function submit(e) {
    e.preventDefault();
    const errs = {};
    if (!f.current) errs.current = 'Enter your current password';
    if (pw.score < 3) errs.password = pw.msg || 'Choose a new password';
    if (f.confirm !== f.password) errs.confirm = 'Passwords do not match';
    if (!/^\d{6}$/.test(f.code)) errs.code = 'Enter the 6-digit code from your authenticator app';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      await post('/api/auth/change-password', f);
      setF({ current: '', password: '', confirm: '', code: '' });
      toast('Password changed. Other devices were signed out.');
    } catch (err) {
      setErrors(Object.keys(err.fields || {}).length ? err.fields : { form: err.message });
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="panel stack" onSubmit={submit} noValidate>
      <h2>Change password</h2>
      {errors.form && <div className="formerror">{errors.form}</div>}
      <input type="email" autoComplete="username" value={user.email} readOnly hidden />
      <Field label="Current password" error={errors.current}><input type="password" autoComplete="current-password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} /></Field>
      <Field label="New password" error={errors.password} hint={pw.msg || 'At least 10 characters'}>
        <input type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /><Strength score={pw.score} /></Field>
      <Field label="Confirm new password" error={errors.confirm}><input type="password" autoComplete="new-password" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} /></Field>
      <Field label="Authenticator code" error={errors.code}><input className="otp" inputMode="numeric" maxLength={6} autoComplete="one-time-code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.replace(/\D/g, '') })} /></Field>
      <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Change password'}</button>
    </form>
  );
}

function RecoveryCodes({ user }) {
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) return setError('Enter the 6-digit code from your authenticator app');
    setBusy(true);
    setError('');
    try {
      const r = await post('/api/auth/recovery-codes', { code });
      setCodes(r.recoveryCodes);
      setCode('');
    } catch (err) {
      setError(err.fields?.code || err.message);
    } finally {
      setBusy(false);
    }
  }
  function download() {
    const text = `RMA Cloud recovery codes\nCompany: ${user.company.name} (${user.company.code})\nLogin: ${user.email}\n\n${codes.join('\n')}\n\nEach code works once.\n`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = `rma-recovery-codes-${user.company.code}.txt`;
    a.click();
  }
  return (
    <form className="panel stack" onSubmit={submit} noValidate>
      <h2>Recovery codes</h2>
      <p className="muted small">You have {user.recoveryLeft} unused. Making new ones cancels all the old ones.</p>
      {codes ? (
        <>
          <div className="codes">{codes.map((c) => <span key={c}>{c}</span>)}</div>
          <button type="button" className="btn ghost" onClick={download}><Icon name="download" size={18} /> Download codes</button>
        </>
      ) : (
        <>
          <Field label="Authenticator code" error={error}><input className="otp" inputMode="numeric" maxLength={6} autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} /></Field>
          <button className="btn ghost" disabled={busy}>{busy ? 'Making…' : 'Make new recovery codes'}</button>
        </>
      )}
    </form>
  );
}
