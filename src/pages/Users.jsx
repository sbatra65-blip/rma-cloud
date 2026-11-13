import { useState } from 'react';
import { del, get, post } from '../api.js';
import { Dialog, ErrorPanel, Field, Icon, Skeleton, ago, copyText, fmtMs, useLoad, useToast } from '../ui.jsx';

const ROLE_HELP = {
  Admin: 'Everything, including users, settings and overriding duplicates',
  Manager: 'RMAs, batches, masters, import and reports',
  Technician: 'Raise and update RMAs, photos, OEM email, batches',
  Viewer: 'Read only',
};
const EVENT = {
  login: 'Logged in', login_failed: 'Failed login', logout: 'Logged out', login_locked: 'Locked after wrong attempts', setup: 'App set up',
  '2fa_enrolled': 'Set up two-step login', invite_accepted: 'Accepted invite', user_invited: 'Invited', invite_resent: 'Invite re-sent',
  login_reset: 'Login reset by admin', user_updated: 'User changed', user_removed: 'User removed', password_changed: 'Changed password',
  password_reset: 'Reset password', reset_requested: 'Asked for password reset', reset_email_sent: 'Reset email sent', reset_skipped: 'Reset email not sent', email_failed: 'Email failed', recovery_code_used: 'Used a recovery code',
  recovery_codes_renewed: 'Made new recovery codes', session_ended_by_admin: 'Session ended by admin', company_updated: 'Company details changed',
  company_created: 'Company created', company_disabled: 'Company switched off', company_enabled: 'Company switched on',
};

export default function Users({ user }) {
  const [tab, setTab] = useState('users');
  return (
    <>
      <div className="page-head"><div><h1>Users & security</h1>
        <p className="muted">Logins for {user.company.name} ({user.company.code}) only. Each company has its own separate logins and two-step login.</p></div></div>
      <div className="tabs" role="tablist">
        {[['users', 'Users'], ['sessions', 'Signed in now'], ['log', 'Login history'], ['audit', 'Activity']].map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>))}
      </div>
      {tab === 'users' && <UserList user={user} />}
      {tab === 'sessions' && <Sessions />}
      {tab === 'log' && <LoginLog />}
      {tab === 'audit' && <Audit />}
    </>
  );
}

function UserList({ user }) {
  const toast = useToast();
  const [data, reload, error] = useLoad(() => get('/api/admin/users'));
  const [invite, setInvite] = useState(false);
  const [link, setLink] = useState(null);
  const [confirmDo, setConfirmDo] = useState(null);
  if (error && !data) return <ErrorPanel error={error} retry={reload} />;
  if (!data) return <Skeleton rows={4} />;
  async function update(u, change, msg) {
    try {
      await post(`/api/admin/users/${u.id}`, change);
      await reload();
      toast(msg);
    } catch (e) {
      toast(e.message, true);
      reload();
    }
  }
  async function act(u, what) {
    try {
      if (what === 'remove') {
        await del(`/api/admin/users/${u.id}`);
        toast(`${u.name} removed`);
      } else {
        const r = await post(`/api/admin/users/${u.id}/${what}`);
        setLink({ ...r, reset: what === 'reset-login' });
      }
      await reload();
    } catch (e) {
      toast(e.message, true);
    } finally {
      setConfirmDo(null);
    }
  }
  const pill = { Active: 'ok', Invited: 'warn', 'Invite expired': 'bad', Locked: 'bad', Disabled: '' };
  return (
    <>
      <div className="row end" style={{ marginBottom: 12 }}><button className="btn primary" onClick={() => setInvite(true)}><Icon name="plus" size={18} /> Add user</button></div>
      <div className="tlist">
        {data.users.map((u) => (
          <div key={u.id} className="panel" style={{ marginTop: 0, opacity: u.disabled ? 0.65 : 1 }}>
            <div className="spread">
              <div style={{ minWidth: 0 }}>
                <b>{u.name}</b> {u.you && <span className="pill">You</span>} {u.isOwner && <span className="pill accent">Owner</span>}
                {u.online && <span className="pill ok">Online</span>}
                <div className="muted small">{u.email} · last login {u.lastLogin ? ago(u.lastLogin) : 'never'}</div>
              </div>
              <span className={`pill ${pill[u.status]}`}>{u.status}</span>
            </div>
            <div className="row" style={{ marginTop: 12 }}>
              <select aria-label={`Role for ${u.name}`} value={u.role} disabled={u.you || u.disabled} style={{ width: 'auto', minHeight: 38 }}
                onChange={(e) => update(u, { role: e.target.value }, `${u.name} is now ${e.target.value}`)}>
                {data.roles.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
              {u.role !== 'Admin' && u.role !== 'Viewer' && (
                <label className="check small"><input type="checkbox" checked={u.dupOverride} disabled={u.disabled}
                  onChange={(e) => update(u, { dupOverride: e.target.checked }, e.target.checked ? 'Can now override duplicate RMAs' : 'Duplicate override removed')} />Can override duplicate RMAs</label>
              )}
              <span style={{ flex: 1 }} />
              {!u.you && (u.status === 'Invited' || u.status === 'Invite expired') && <button className="btn ghost small" onClick={() => act(u, 'resend-invite')}>Send invite again</button>}
              {!u.you && u.status !== 'Invited' && u.status !== 'Invite expired' && !u.disabled && <button className="btn ghost small" onClick={() => setConfirmDo({ u, what: 'reset-login' })}>Reset login</button>}
              {!u.you && !u.isOwner && <button className="btn ghost small" onClick={() => update(u, { disabled: !u.disabled }, u.disabled ? `${u.name} enabled` : `${u.name} disabled and signed out`)}>{u.disabled ? 'Enable' : 'Disable'}</button>}
              {!u.you && !u.isOwner && <button className="btn danger small" onClick={() => setConfirmDo({ u, what: 'remove' })}>Remove</button>}
            </div>
          </div>
        ))}
      </div>
      <p className="muted small" style={{ marginTop: 12 }}>{Object.entries(ROLE_HELP).map(([r, h]) => <span key={r} style={{ display: 'block' }}><b>{r}</b>: {h}</span>)}</p>

      {invite && <InviteDialog roles={data.roles} onClose={() => setInvite(false)} onDone={async (r) => { setInvite(false); setLink(r); await reload(); }} />}
      <LinkDialog result={link} company={user.company} onClose={() => setLink(null)} />
      <Dialog open={!!confirmDo} onClose={() => setConfirmDo(null)} title={confirmDo?.what === 'remove' ? `Remove ${confirmDo?.u.name}?` : `Reset login for ${confirmDo?.u.name}?`}>
        <p>{confirmDo?.what === 'remove'
          ? 'Their login for this company is deleted and they are signed out. RMAs they worked on keep their name in the history.'
          : 'Use this when they lost their phone and their recovery codes. Their password and two-step login are cleared, they are signed out, and they get a new link to set both up again.'}</p>
        <div className="row end">
          <button className="btn ghost" onClick={() => setConfirmDo(null)}>Cancel</button>
          <button className="btn danger" onClick={() => act(confirmDo.u, confirmDo.what)}>{confirmDo?.what === 'remove' ? 'Remove' : 'Reset login'}</button>
        </div>
      </Dialog>
    </>
  );
}

function InviteDialog({ roles, onClose, onDone }) {
  const [f, setF] = useState({ name: '', email: '', role: 'Technician', dupOverride: false });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      onDone(await post('/api/admin/users', f));
    } catch (err) {
      setErrors({ form: Object.keys(err.fields || {}).length ? null : err.message, ...(err.fields || {}) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onClose={onClose} title="Add a user">
      <form className="stack" onSubmit={submit} noValidate>
        {errors.form && <div className="formerror">{errors.form}</div>}
        <Field label="Name" required error={errors.name}><input type="text" autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Email" required error={errors.email} hint="They log in with this email and your company code"><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Role" error={errors.role} hint={ROLE_HELP[f.role]}>
          <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{roles.map((r) => <option key={r}>{r}</option>)}</select>
        </Field>
        {f.role !== 'Admin' && f.role !== 'Viewer' && <label className="check"><input type="checkbox" checked={f.dupOverride} onChange={(e) => setF({ ...f, dupOverride: e.target.checked })} />Can override duplicate RMAs</label>}
        <p className="muted small">They get an email with a link to choose a password and set up two-step login. The link works for 7 days.</p>
        <div className="row end"><button type="button" className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy}>{busy ? 'Adding…' : 'Add and send invite'}</button></div>
      </form>
    </Dialog>
  );
}

export function LinkDialog({ result, company, onClose }) {
  const toast = useToast();
  if (!result) return null;
  const text = `You've been added to ${company?.name || 'TrackMyRMA'}. Company code: ${company?.code || ''}. Set up your login here (link works once, for ${result.days} days): ${result.link}`;
  return (
    <Dialog open onClose={onClose} title={result.reset ? 'Login reset' : 'Invite ready'}>
      <div className="stack">
        {result.emailed ? <div className="notice">Emailed to {result.user.email}.</div>
          : <div className="warnbox">Email not sent: {result.emailError} Share the link below yourself (WhatsApp, chat).</div>}
        <p className="small">Link for <b>{result.user.name}</b> — works once, for {result.days} days. Company code: <b className="mono">{company?.code}</b></p>
        <p className="secret">{result.link}</p>
        <div className="row end">
          {navigator.share && <button className="btn ghost" onClick={() => navigator.share({ text }).catch(() => {})}><Icon name="share" size={18} /> Share</button>}
          <button className="btn primary" onClick={async () => toast(await copyText(text) ? 'Copied with instructions' : 'Copy the link by hand')}><Icon name="copy" size={18} /> Copy</button>
        </div>
      </div>
    </Dialog>
  );
}

function Sessions() {
  const toast = useToast();
  const [data, reload, error] = useLoad(() => get('/api/admin/sessions'));
  if (error && !data) return <ErrorPanel error={error} retry={reload} />;
  if (!data) return <Skeleton rows={3} />;
  async function end(s) {
    try { await del(`/api/admin/sessions/${s.id}`); toast(`Signed ${s.name} out`); reload(); } catch (e) { toast(e.message, true); }
  }
  return !data.length ? <p className="muted">Nobody is signed in.</p> : (
    <div className="tablewrap"><table className="data"><thead><tr><th>Who</th><th>Device</th><th>Where</th><th>Since</th><th>Last active</th><th /></tr></thead>
      <tbody>{data.map((s) => (
        <tr key={s.id}><td><b>{s.name}</b><div className="tiny muted">{s.email} · {s.role}</div></td><td>{s.ua}</td><td>{s.place || s.ip}</td>
          <td className="nowrap">{fmtMs(s.created_at, true)}</td><td className="nowrap">{ago(s.last_active)}</td>
          <td>{s.current ? <span className="pill">This session</span> : <button className="btn danger small" onClick={() => end(s)}>Sign out</button>}</td></tr>
      ))}</tbody></table></div>
  );
}

function LoginLog() {
  const [data, reload, error] = useLoad(() => get('/api/admin/login-log'));
  if (error && !data) return <ErrorPanel error={error} retry={reload} />;
  if (!data) return <Skeleton rows={4} />;
  return (
    <div className="tablewrap"><table className="data"><thead><tr><th>When</th><th>What</th><th>Who</th><th>Detail</th><th>From</th></tr></thead>
      <tbody>{data.map((e, i) => (
        <tr key={i}><td className="nowrap">{fmtMs(e.at, true)}</td>
          <td><span className={`pill ${/failed|locked/.test(e.event) ? 'bad' : e.event === 'login' ? 'ok' : ''}`}>{EVENT[e.event] || e.event}</span></td>
          <td>{e.email || '—'}</td><td className="small">{e.detail || ''}</td><td className="small muted">{[e.ua, e.ip].filter(Boolean).join(' · ')}</td></tr>
      ))}</tbody></table></div>
  );
}

function Audit() {
  const [data, reload, error] = useLoad(() => get('/api/admin/audit'));
  if (error && !data) return <ErrorPanel error={error} retry={reload} />;
  if (!data) return <Skeleton rows={4} />;
  return (
    <div className="tablewrap"><table className="data"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Record</th><th>Detail</th></tr></thead>
      <tbody>{data.map((a) => (
        <tr key={a.id}><td className="nowrap">{fmtMs(a.at, true)}</td><td>{a.by_name}</td><td>{a.action}</td>
          <td>{a.entity}{a.entity_id ? ` ${a.entity_id}` : ''}</td><td className="small mono" style={{ maxWidth: 360, wordBreak: 'break-word' }}>{a.detail || ''}</td></tr>
      ))}</tbody></table></div>
  );
}
