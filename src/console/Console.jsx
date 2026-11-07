// RMA Cloud Console — the service provider's website. Separate login (operators, 2FA), separate cookie.
// Operators create companies, set limits and modules, and manage each company's logins. No RMA data here.
import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { del, get, post, setSessionEndedHandler } from '../api.js';
import {
  Dialog, Empty, ErrorPanel, Field, Icon, Link, Logo, Skeleton, Strength, ToastProvider, VersionLabel, copyText, fmtDate, fmtMs,
  navigate, passwordScore, todayISO, useLoad, usePath, useToast,
} from '../ui.jsx';

const EMAIL = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/;
const MODULE_INFO = {
  carepack: ['Care packs', 'Care pack registry, OEM PO, OEM invoice and payment tracking'],
  zoho: ['Zoho Books', 'Load invoices / POs from Zoho, create delivery challans'],
  batches: ['OEM batches', 'Monthly dispatch batches with packing list'],
  import: ['Import', 'Bring in old RMAs and customers from Excel / CSV'],
  reports: ['Reports', 'Filter RMAs and export to Excel'],
};
const ALL_MODULES = Object.keys(MODULE_INFO);

export default function Console() {
  return <ToastProvider><Shell /></ToastProvider>;
}

function Shell() {
  const path = usePath();
  const toast = useToast();
  const [state, setState] = useState({ phase: 'loading' });
  const phase = useRef('loading');
  phase.current = state.phase;

  const signOut = useCallback(async (reason) => {
    if (reason !== 'expired') await post('/api/console/logout').catch(() => {});
    setState({ phase: 'out', reason: reason === 'idle' ? 'Signed out after a few minutes without activity.' : reason === 'expired' ? 'Your console session ended. Please log in again.' : null });
    navigate('/console', { replace: true });
  }, []);

  useEffect(() => {
    setSessionEndedHandler(() => { if (phase.current === 'in') signOut('expired'); });
    if (path.startsWith('/console/invite')) { setState({ phase: 'out' }); return; }
    get('/api/console/me').then((r) => setState({ phase: 'in', op: r.op, idle: r.idleMinutes, appUrl: r.appUrl }))
      .catch(() => setState({ phase: 'out' }));
  }, [signOut]); // eslint-disable-line react-hooks/exhaustive-deps

  useIdleTimer(state.phase === 'in', state.idle || 15, () => signOut('idle'));

  if (state.phase === 'loading') return <div className="loading" style={{ paddingTop: '30vh' }}><Logo size={56} /></div>;
  if (state.phase === 'out') {
    return <ConsoleAuth reason={state.reason} onIn={async (note) => {
      const r = await get('/api/console/me');
      setState({ phase: 'in', op: r.op, idle: r.idleMinutes, appUrl: r.appUrl });
      navigate('/console', { replace: true });
      if (note) toast(note);
    }} />;
  }

  const route = path.split('?')[0].replace(/\/+$/, '');
  let page;
  let m;
  if (route === '/console' || route === '/console/companies') page = <Companies />;
  else if (route === '/console/companies/new') page = <NewCompany appUrl={state.appUrl} />;
  else if ((m = route.match(/^\/console\/companies\/([0-9a-f-]{36})$/))) page = <CompanyPage id={m[1]} key={m[1]} appUrl={state.appUrl} />;
  else if (route === '/console/operators') page = <Operators />;
  else if (route === '/console/log') page = <ActivityLog />;
  else if (route === '/console/profile') page = <ConsoleProfile op={state.op} onLogout={() => signOut('logout')} />;
  else page = <div className="panel"><h1>Page not found</h1><p className="muted"><Link to="/console">Back to companies</Link></p></div>;

  const nav = [['/console', 'building', 'Companies'], ['/console/operators', 'users', 'Operators'], ['/console/log', 'history', 'Activity log']];
  const cur = (to) => (to === '/console' ? route === '/console' || route.startsWith('/console/companies') : route.startsWith(to));
  return (
    <div className="app">
      <aside className="sidenav" aria-label="Console">
        <Link to="/console" className="brand"><Logo size={34} /><span className="co"><span>RMA Cloud</span><small>Service console</small></span></Link>
        <Link to="/console/companies/new" className="btn primary block addbtn"><Icon name="plus" size={18} /> New company</Link>
        {nav.map(([to, icon, label]) => <Link key={to} to={to} className="navlink" aria-current={cur(to) ? 'page' : undefined}><Icon name={icon} size={19} /> {label}</Link>)}
        <div className="foot">
          <Link to="/console/profile" className="navlink" aria-current={route === '/console/profile' ? 'page' : undefined}><Icon name="user" size={19} />
            <span style={{ display: 'grid', lineHeight: 1.2 }}><b>{state.op.name}</b><small style={{ opacity: 0.7 }}>Operator</small></span></Link>
          <button type="button" className="navlink" onClick={() => signOut('logout')}><Icon name="logout" size={19} /> Log out</button>
          <VersionLabel />
        </div>
      </aside>
      <header className="topbar">
        <Link to="/console" className="brand"><Logo size={30} /><span className="co"><span>RMA Cloud</span><small>Service console</small></span></Link>
        <div className="row" style={{ flexWrap: 'nowrap', gap: 4 }}>
          <Link to="/console/profile" className="iconbtn" aria-label="My profile"><Icon name="user" /></Link>
          <button type="button" className="iconbtn" onClick={() => signOut('logout')} aria-label="Log out"><Icon name="logout" /></button>
        </div>
      </header>
      <main><div className="page" key={route}>{page}</div></main>
      <nav className="bottomnav" aria-label="Console">
        {nav.map(([to, icon, label]) => <Link key={to} to={to} aria-current={cur(to) ? 'page' : undefined}><Icon name={icon} /><span>{label.split(' ')[0]}</span></Link>)}
        <Link to="/console/companies/new" aria-current={route === '/console/companies/new' ? 'page' : undefined}><Icon name="plus" /><span>New</span></Link>
      </nav>
    </div>
  );
}

function useIdleTimer(enabled, minutes, onTimeout) {
  const cb = useRef(onTimeout);
  cb.current = onTimeout;
  useEffect(() => {
    if (!enabled) return undefined;
    let last = Date.now();
    let ping = Date.now();
    const act = () => {
      last = Date.now();
      if (Date.now() - ping > 60_000) { ping = Date.now(); post('/api/console/ping').catch(() => {}); }
    };
    const ev = ['pointerdown', 'keydown', 'scroll', 'touchstart'];
    ev.forEach((e) => window.addEventListener(e, act, { passive: true }));
    const t = setInterval(() => { if (Date.now() - last > minutes * 60_000) cb.current(); }, 10_000);
    return () => { ev.forEach((e) => window.removeEventListener(e, act)); clearInterval(t); };
  }, [enabled, minutes]);
}

// ======================= Sign in / setup / invite =======================
function ConsoleAuth({ reason, onIn }) {
  const [token] = useState(() => new URLSearchParams(location.hash.slice(1)).get('token') || '');
  const [mode, setMode] = useState(location.pathname.startsWith('/console/invite') ? 'invite' : 'login');
  const [setupInfo, setSetupInfo] = useState(null);
  useEffect(() => {
    if (mode === 'invite') history.replaceState({}, '', '/console/invite');
    get('/api/console/setup').then((r) => { setSetupInfo(r); if (r.needsSetup && mode === 'login') setMode('setup'); }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="auth">
      <div className="auth-art">
        <div className="brand"><Logo size={38} /><span style={{ fontSize: '1.15rem' }}>RMA Cloud Console</span></div>
        <div>
          <h1>Companies, limits and logins — in one place.</h1>
          <p>For the service provider only. Create companies, set how many people may use them, switch modules on or off, and help their users get in.</p>
        </div>
        <ul>
          <li><Icon name="building" /> Each company keeps its own data — operators never see it</li>
          <li><Icon name="users" /> User and signed-in-at-once limits per company</li>
          <li><Icon name="shield" /> Two-step login for every operator</li>
        </ul>
      </div>
      <div className="auth-card">
        {mode === 'login' && <Login reason={reason} onIn={onIn} canSetup={setupInfo?.needsSetup} toSetup={() => setMode('setup')} />}
        {mode === 'setup' && <Setup info={setupInfo} onIn={onIn} toLogin={() => setMode('login')} />}
        {mode === 'invite' && <InviteAccept token={token} onIn={onIn} toLogin={() => { history.replaceState({}, '', '/console'); setMode('login'); }} />}
        <VersionLabel />
      </div>
    </div>
  );
}

function CodeInput({ value, onChange, error, recovery, id = 'code' }) {
  return (
    <Field label={recovery ? 'Recovery code' : 'Authenticator code'} htmlFor={id} error={error}>
      <input id={id} className="otp" type="text" autoComplete="one-time-code" inputMode={recovery ? 'text' : 'numeric'} maxLength={recovery ? 8 : 6} value={value} autoFocus={id === 'code' || id === 'ecode'}
        onChange={(e) => onChange(recovery ? e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') : e.target.value.replace(/\D/g, ''))} />
    </Field>
  );
}

function Login({ reason, onIn, canSetup, toSetup }) {
  const [f, setF] = useState({ email: '', password: '' });
  const [step, setStep] = useState('password');
  const [token, setToken] = useState('');
  const [code, setCode] = useState('');
  const [rec, setRec] = useState(false);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  async function pw(e) {
    e.preventDefault();
    const errs = {};
    if (!EMAIL.test(f.email.trim())) errs.email = 'Enter a valid email address';
    if (!f.password) errs.password = 'Enter your password';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      const r = await post('/api/console/login', { email: f.email.trim(), password: f.password });
      setToken(r.loginToken);
      setStep('code');
    } catch (err) { setErrors({ form: err.message, ...(err.fields || {}) }); } finally { setBusy(false); }
  }
  async function verify(e) {
    e.preventDefault();
    if (!rec && !/^\d{6}$/.test(code)) return setErrors({ code: 'Enter the 6-digit code from your authenticator app' });
    setBusy(true);
    setErrors({});
    try {
      const r = await post('/api/console/login/verify', rec ? { loginToken: token, recoveryCode: code } : { loginToken: token, code });
      onIn(rec ? `Recovery code used — ${r.op.recoveryLeft} left.` : null);
    } catch (err) {
      if (/expired|start again/i.test(err.message)) { setStep('password'); setErrors({ form: err.message }); } else { setErrors({ code: err.message }); setCode(''); }
    } finally { setBusy(false); }
  }
  return (
    <>
      <h2 style={{ fontSize: '1.5rem' }}>Console log in</h2>
      {reason && step === 'password' && <div className="warnbox">{reason}</div>}
      {errors.form && <div className="formerror" role="alert">{errors.form}</div>}
      {step === 'password' ? (
        <form className="stack" onSubmit={pw} noValidate>
          <Field label="Email" htmlFor="email" error={errors.email}><input id="email" type="email" autoComplete="username" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Field label="Password" htmlFor="password" error={errors.password}><input id="password" type="password" autoComplete="current-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
          <button className="btn primary block" disabled={busy}>{busy ? 'Checking…' : 'Continue'}</button>
          {canSetup && <button type="button" className="btn ghost block" onClick={toSetup}>First time? Set up the console</button>}
          <p className="muted small">Forgot your password or lost your phone? Ask another operator to reset your login.</p>
        </form>
      ) : (
        <form className="stack" onSubmit={verify} noValidate>
          <p className="muted">{rec ? 'Enter one of your saved recovery codes.' : 'Enter the 6-digit code for RMA Cloud Console from your authenticator app.'}</p>
          <CodeInput value={code} onChange={setCode} error={errors.code} recovery={rec} />
          <button className="btn primary block" disabled={busy}>{busy ? 'Verifying…' : 'Log in'}</button>
          <button type="button" className="btn ghost block" onClick={() => { setRec(!rec); setCode(''); setErrors({}); }}>{rec ? 'Use authenticator code instead' : 'Lost your phone? Use a recovery code'}</button>
        </form>
      )}
    </>
  );
}

function PasswordPair({ f, setF, errors, email }) {
  const pw = passwordScore(f.password, email);
  return (
    <>
      <Field label="Password" required htmlFor="npw" error={errors.password} hint={pw.msg || 'At least 10 characters, three kinds of characters'}>
        <input id="npw" type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
        <Strength score={pw.score} />
      </Field>
      <Field label="Confirm password" required htmlFor="npw2" error={errors.confirm}>
        <input id="npw2" type="password" autoComplete="new-password" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} />
      </Field>
    </>
  );
}

function Setup({ info, onIn, toLogin }) {
  const owner = info?.owner || null;
  const [f, setF] = useState({ key: '', name: '', email: owner?.email || '', password: '', confirm: '' });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [enroll, setEnroll] = useState(null);
  useEffect(() => { if (owner && !f.email) setF((x) => ({ ...x, email: owner.email })); }, [owner]); // eslint-disable-line react-hooks/exhaustive-deps
  async function submit(e) {
    e.preventDefault();
    const errs = {};
    if (!owner && !f.key) errs.key = 'Enter the setup key';
    if (!owner && !f.name.trim()) errs.name = 'Enter your name';
    if (!EMAIL.test(f.email.trim())) errs.email = 'Enter a valid email address';
    if (passwordScore(f.password, f.email).score < 3) errs.password = passwordScore(f.password, f.email).msg || 'Choose a stronger password';
    if (f.password !== f.confirm) errs.confirm = 'Passwords do not match';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try { setEnroll(await post('/api/console/setup', owner ? { email: f.email, password: f.password, confirm: f.confirm } : f)); } catch (err) {
      if (err.status === 409) { toLogin(); return; }
      setErrors({ form: Object.keys(err.fields || {}).length ? null : err.message, ...(err.fields || {}) });
    } finally { setBusy(false); }
  }
  if (enroll) return <Enroll enroll={enroll} onIn={onIn} />;
  return (
    <form className="stack" onSubmit={submit} noValidate>
      <div className="steps"><i className="on" /><i /><i /></div>
      <div><h2 style={{ fontSize: '1.5rem' }}>Set up the console</h2>
        <p className="muted" style={{ marginTop: 6 }}>{owner
          ? <>You are signed in to RMA Cloud as <b>{owner.name}</b>, who set the system up, so no setup key is needed. Choose the console login: email, password, then your authenticator app.</>
          : <>Create the first console login. Easiest: log in to the RMA app (<a href="/">open it</a>) with the account that did the first setup, then come back here — you'll only need an email and password. Otherwise use the <b>CONSOLE_SETUP_KEY</b> secret.</>}</p></div>
      {!owner && info && !info.keyConfigured && <div className="warnbox">No setup key is configured, so log in to the RMA app as the account that did the first setup and open this page again.</div>}
      {errors.form && <div className="formerror" role="alert">{errors.form}</div>}
      {!owner && <Field label="Setup key" required htmlFor="key" error={errors.key}><input id="key" type="password" autoComplete="off" value={f.key} onChange={(e) => setF({ ...f, key: e.target.value })} /></Field>}
      {!owner && <Field label="Your name" required htmlFor="nm" error={errors.name}><input id="nm" type="text" autoComplete="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>}
      <Field label="Console email" required htmlFor="em" error={errors.email}><input id="em" type="email" autoComplete="username" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
      <PasswordPair f={f} setF={setF} errors={errors} email={f.email} />
      <button className="btn primary block" disabled={busy}>{busy ? 'Creating…' : 'Continue to two-step login'}</button>
      <button type="button" className="btn ghost block" onClick={toLogin}>I already have a console login</button>
    </form>
  );
}

function InviteAccept({ token, onIn, toLogin }) {
  const [info, setInfo] = useState(null);
  const [problem, setProblem] = useState(token ? '' : 'This invite link is not complete. Open the link from your email again.');
  const [f, setF] = useState({ password: '', confirm: '' });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [enroll, setEnroll] = useState(null);
  useEffect(() => { if (token) post('/api/console/invite/check', { token }).then(setInfo).catch((e) => setProblem(e.message)); }, [token]);
  async function submit(e) {
    e.preventDefault();
    const errs = {};
    if (passwordScore(f.password, info.email).score < 3) errs.password = passwordScore(f.password, info.email).msg || 'Choose a stronger password';
    if (f.password !== f.confirm) errs.confirm = 'Passwords do not match';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try { setEnroll(await post('/api/console/invite/accept', { token, ...f })); } catch (err) { setErrors({ form: err.message, ...(err.fields || {}) }); } finally { setBusy(false); }
  }
  if (enroll) return <Enroll enroll={enroll} onIn={onIn} />;
  if (problem) return <div className="stack"><div className="formerror">{problem}</div><button className="btn ghost block" onClick={toLogin}>Go to log in</button></div>;
  if (!info) return <Skeleton rows={3} />;
  return (
    <form className="stack" onSubmit={submit} noValidate>
      <div className="steps"><i className="on" /><i /><i /></div>
      <div><h2 style={{ fontSize: '1.5rem' }}>Welcome, {info.name}</h2><p className="muted" style={{ marginTop: 6 }}>Choose a password for <b>{info.email}</b>, then set up two-step login.</p></div>
      {errors.form && <div className="formerror">{errors.form}</div>}
      <PasswordPair f={f} setF={setF} errors={errors} email={info.email} />
      <button className="btn primary block" disabled={busy}>{busy ? 'Saving…' : 'Continue'}</button>
    </form>
  );
}

function Enroll({ enroll, onIn }) {
  const [qr, setQr] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { QRCode.toDataURL(enroll.otpauth, { margin: 0, width: 400, color: { dark: '#1e1b4b', light: '#ffffff' } }).then(setQr); }, [enroll.otpauth]);
  async function submit(e) {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) return setError('Enter the 6-digit code shown in your app');
    setBusy(true);
    try { setDone(await post('/api/console/enroll', { setupToken: enroll.setupToken, code })); } catch (err) { setError(err.fields?.code || err.message); setCode(''); } finally { setBusy(false); }
  }
  if (done) {
    return (
      <div className="stack">
        <div className="steps"><i className="on" /><i className="on" /><i className="on" /></div>
        <h2 style={{ fontSize: '1.5rem' }}>Save your recovery codes</h2>
        <p className="muted">Each code lets you log in once if you lose your phone. They are shown only now.</p>
        <div className="codes">{done.recoveryCodes.map((c) => <span key={c}>{c}</span>)}</div>
        <button className="btn ghost block" onClick={() => {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(new Blob([`RMA Cloud Console recovery codes (${done.op.email})\n\n${done.recoveryCodes.join('\n')}\n`], { type: 'text/plain' }));
          a.download = 'rma-console-recovery-codes.txt';
          a.click();
        }}><Icon name="download" size={18} /> Download codes</button>
        <label className="check"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />I have saved these codes somewhere safe</label>
        <button className="btn primary block" disabled={!saved} onClick={() => onIn('Welcome to the console.')}>Open the console</button>
      </div>
    );
  }
  return (
    <form className="stack" onSubmit={submit} noValidate>
      <div className="steps"><i className="on" /><i className="on" /><i /></div>
      <div><h2 style={{ fontSize: '1.5rem' }}>Set up two-step login</h2>
        <p className="muted" style={{ marginTop: 6 }}>Scan with your authenticator app. It will show as <b>RMA Cloud Console</b>.</p></div>
      <div className="qr">{qr && <img src={qr} alt="QR code for your authenticator app" />}</div>
      <details><summary className="small muted" style={{ cursor: 'pointer' }}>On this phone? Enter this key instead</summary><p className="secret" style={{ marginTop: 8 }}>{enroll.secret.match(/.{1,4}/g).join(' ')}</p></details>
      <CodeInput value={code} onChange={setCode} error={error} id="ecode" />
      <button className="btn primary block" disabled={busy}>{busy ? 'Verifying…' : 'Verify and continue'}</button>
    </form>
  );
}

// ======================= Companies =======================
function statusOf(c) {
  if (!c.active) return ['Suspended', 'bad'];
  if (c.expired) return ['Expired', 'bad'];
  if (c.daysLeft !== null && c.daysLeft <= 15) return [`Ends in ${c.daysLeft} d`, 'warn'];
  if (!c.adminsReady) return ['Admin not set up', 'warn'];
  return ['Active', 'ok'];
}
const limit = (n, max) => `${n} / ${max || '∞'}`;

function Companies() {
  const [data, reload, error] = useLoad(() => get('/api/console/companies'));
  const [q, setQ] = useState('');
  if (error && !data) return <ErrorPanel error={error} retry={reload} />;
  if (!data) return <Skeleton rows={5} />;
  const rows = data.companies.filter((c) => !q || `${c.name} ${c.code} ${c.contactName} ${c.contactEmail}`.toLowerCase().includes(q.toLowerCase()));
  const totals = data.companies.reduce((a, c) => ({ users: a.users + c.users, online: a.online + c.online, active: a.active + (c.active && !c.expired ? 1 : 0) }), { users: 0, online: 0, active: 0 });
  return (
    <>
      <div className="page-head"><div><h1>Companies</h1><p className="muted">Each company has its own logins and data. Set limits and modules here.</p></div>
        <Link to="/console/companies/new" className="btn primary"><Icon name="plus" size={18} /> New company</Link></div>
      <div className="stats" style={{ marginBottom: 14 }}>
        <div className="stat"><b>{data.companies.length}</b><span>Companies</span></div>
        <div className="stat"><b>{totals.active}</b><span>Active</span></div>
        <div className="stat"><b>{totals.users}</b><span>Active logins</span></div>
        <div className="stat"><b>{totals.online}</b><span>Signed in now</span></div>
      </div>
      <div className="search" style={{ marginBottom: 12 }}><Icon name="search" size={18} /><input type="search" placeholder="Search name, code, contact" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search companies" /></div>
      {!rows.length ? <Empty icon="building" title={q ? 'No match' : 'No companies yet'} action={!q && <Link to="/console/companies/new" className="btn primary">Create the first company</Link>} /> : (
        <>
          <div className="tlist mobile-only">{rows.map((c) => {
            const [label, tone] = statusOf(c);
            return (
              <Link key={c.id} to={`/console/companies/${c.id}`} className="tcard" style={{ '--c': tone === 'ok' ? 'var(--ok)' : tone === 'warn' ? 'var(--amber)' : 'var(--rust)' }}>
                <div className="top"><span className="no">{c.code}</span><span className={`pill ${tone}`}>{label}</span></div>
                <h3>{c.name}</h3>
                <span className="meta">Users {limit(c.users, c.maxUsers)} · signed in {limit(c.online, c.maxConcurrent)} · until {c.validUntil ? fmtDate(c.validUntil) : 'no end'}</span>
              </Link>);
          })}</div>
          <div className="tablewrap desktop-only"><table className="data">
            <thead><tr><th>Company</th><th>Code</th><th>Status</th><th>Users</th><th>Signed in</th><th>Valid until</th><th>Modules</th><th>Last login</th></tr></thead>
            <tbody>{rows.map((c) => {
              const [label, tone] = statusOf(c);
              return (
                <tr key={c.id} onClick={() => navigate(`/console/companies/${c.id}`)} style={{ cursor: 'pointer' }}>
                  <td><Link to={`/console/companies/${c.id}`}><b>{c.name}</b></Link><div className="tiny muted">{[c.contactName, c.contactEmail].filter(Boolean).join(' · ')}</div></td>
                  <td className="mono">{c.code}</td><td><span className={`pill ${tone}`}>{label}</span></td>
                  <td className="num">{limit(c.users, c.maxUsers)}</td><td className="num">{limit(c.online, c.maxConcurrent)}</td>
                  <td className="nowrap">{c.validUntil ? fmtDate(c.validUntil) : '—'}</td>
                  <td className="small">{c.modules.map((m) => MODULE_INFO[m][0]).join(', ') || 'RMA only'}</td>
                  <td className="nowrap small">{c.lastLogin ? fmtMs(c.lastLogin, true) : '—'}</td>
                </tr>);
            })}</tbody></table></div>
        </>
      )}
    </>
  );
}

const blankCompany = () => ({ name: '', code: '', ticketPrefix: '', gstin: '', contactName: '', contactEmail: '', contactPhone: '', address: '', notes: '',
  maxUsers: '10', maxConcurrent: '5', validUntil: '', idleMinutes: '', emailDomains: '', modules: [...ALL_MODULES] });

function CompanyForm({ f, setF, errors, creating }) {
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const up = (k) => (e) => setF({ ...f, [k]: e.target.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase() });
  const num = (k) => (e) => setF({ ...f, [k]: e.target.value.replace(/\D/g, '') });
  return (
    <>
      <section className="panel">
        <h2>Company</h2>
        <div className="fields">
          <Field label="Company name" required error={errors.name} className="wide"><input type="text" value={f.name} onChange={set('name')} /></Field>
          <Field label="Login code" required={creating} error={errors.code} hint={creating ? 'People type this when they log in. Cannot be changed later.' : 'Fixed'}>
            <input type="text" className="upper" maxLength={12} value={f.code} onChange={up('code')} disabled={!creating} /></Field>
          <Field label="RMA number prefix" error={errors.ticketPrefix} hint={`${f.ticketPrefix || f.code || 'INF'}-RMA-YYYYMM-0001`}>
            <input type="text" className="upper" maxLength={8} placeholder={f.code} value={f.ticketPrefix} onChange={up('ticketPrefix')} /></Field>
          <Field label="GSTIN" error={errors.gstin}><input type="text" className="upper" maxLength={15} value={f.gstin} onChange={set('gstin')} /></Field>
        </div>
      </section>
      <section className="panel">
        <h2>Contact</h2>
        <div className="fields">
          <Field label="Contact person" error={errors.contactName}><input type="text" value={f.contactName} onChange={set('contactName')} /></Field>
          <Field label="Contact email" error={errors.contactEmail} hint="For billing / renewal; not a login"><input type="email" value={f.contactEmail} onChange={set('contactEmail')} /></Field>
          <Field label="Contact phone" error={errors.contactPhone}><input type="tel" value={f.contactPhone} onChange={set('contactPhone')} /></Field>
          <Field label="Address" error={errors.address} className="wide"><textarea rows={2} value={f.address} onChange={set('address')} /></Field>
        </div>
      </section>
      <section className="panel">
        <h2>Plan and limits</h2>
        <div className="fields">
          <Field label="Maximum users" error={errors.maxUsers} hint="Active logins allowed. 0 = no limit"><input type="text" inputMode="numeric" value={f.maxUsers} onChange={num('maxUsers')} /></Field>
          <Field label="Signed in at the same time" error={errors.maxConcurrent} hint="Extra logins are refused until someone logs out. 0 = no limit"><input type="text" inputMode="numeric" value={f.maxConcurrent} onChange={num('maxConcurrent')} /></Field>
          <Field label="Valid until" error={errors.validUntil} hint="Logins stop after this date. Empty = no end date"><input type="date" min={creating ? todayISO() : undefined} value={f.validUntil} onChange={set('validUntil')} /></Field>
          <Field label="Sign out after idle (minutes)" error={errors.idleMinutes} hint="2–60. Empty = app default (5)"><input type="text" inputMode="numeric" value={f.idleMinutes} onChange={num('idleMinutes')} /></Field>
          <Field label="Allowed email domains" error={errors.emailDomains} className="wide" hint="Logins must use these domains, e.g. infinite.co.in. Empty = any email">
            <input type="text" value={f.emailDomains} onChange={set('emailDomains')} /></Field>
        </div>
      </section>
      <section className="panel">
        <h2>Modules</h2>
        <p className="muted small" style={{ marginBottom: 10 }}>RMA tickets, photos, OEM Excel, email, reminders, masters and users are always included.</p>
        <div className="stack">{ALL_MODULES.map((m) => (
          <label key={m} className="check"><input type="checkbox" checked={f.modules.includes(m)}
            onChange={(e) => setF({ ...f, modules: e.target.checked ? [...f.modules, m] : f.modules.filter((x) => x !== m) })} />
            <span><b>{MODULE_INFO[m][0]}</b><span className="muted small" style={{ display: 'block', fontWeight: 500 }}>{MODULE_INFO[m][1]}</span></span></label>))}</div>
      </section>
      <section className="panel">
        <h2>Notes</h2>
        <Field label="Internal notes" error={errors.notes} hint="Only operators see these"><textarea rows={3} value={f.notes} onChange={set('notes')} /></Field>
      </section>
    </>
  );
}

const toBody = (f) => ({ ...f, maxUsers: Number(f.maxUsers) || 0, maxConcurrent: Number(f.maxConcurrent) || 0, idleMinutes: Number(f.idleMinutes) || 0, validUntil: f.validUntil || null });

function NewCompany({ appUrl }) {
  const [f, setF] = useState(blankCompany);
  const [admin, setAdmin] = useState({ name: '', email: '' });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  async function submit(e) {
    e.preventDefault();
    const errs = {};
    if (!f.name.trim()) errs.name = 'Enter the company name';
    if (!/^[A-Z0-9]{2,12}$/.test(f.code)) errs.code = '2–12 letters or numbers, e.g. INF';
    if (!admin.name.trim()) errs.adminName = 'Enter the Admin\'s name';
    if (!EMAIL.test(admin.email.trim())) errs.adminEmail = 'Enter a valid email';
    setErrors(errs);
    if (Object.keys(errs).length) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    setBusy(true);
    try {
      setResult(await post('/api/console/companies', { company: toBody(f), admin }));
    } catch (err) {
      const fl = err.fields || {};
      setErrors({ form: err.message, ...fl, adminName: fl.name && !f.name ? fl.name : undefined, adminEmail: fl.adminEmail || fl.email });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally { setBusy(false); }
  }
  return (
    <form onSubmit={submit} noValidate>
      <div className="page-head"><div><Link to="/console" className="small muted" style={{ textDecoration: 'none' }}>← Companies</Link><h1>New company</h1>
        <p className="muted">The company gets its own login code, its own data, and a first Admin who sets up their own password and authenticator.</p></div></div>
      {errors.form && <div className="formerror" role="alert">{errors.form}</div>}
      <CompanyForm f={f} setF={setF} errors={errors} creating />
      <section className="panel">
        <h2>First Admin login</h2>
        <p className="muted small" style={{ marginBottom: 10 }}>An invite link is emailed (and shown to you). The Admin chooses a password and sets up two-step login, then adds the rest of their team.</p>
        <div className="fields">
          <Field label="Admin name" required error={errors.adminName}><input type="text" value={admin.name} onChange={(e) => setAdmin({ ...admin, name: e.target.value })} /></Field>
          <Field label="Admin email" required error={errors.adminEmail}><input type="email" value={admin.email} onChange={(e) => setAdmin({ ...admin, email: e.target.value })} /></Field>
        </div>
      </section>
      <div className="savebar"><Link to="/console" className="btn ghost">Cancel</Link><button className="btn primary" disabled={busy}>{busy ? 'Creating…' : 'Create company'}</button></div>
      {result && <InviteResult result={result} company={result.company} appUrl={appUrl} onClose={() => navigate(`/console/companies/${result.company.id}`)} />}
    </form>
  );
}

function InviteResult({ result, company, appUrl, onClose }) {
  const toast = useToast();
  const text = `You've been added to ${company.name} on RMA Cloud.\nApp: ${appUrl}\nCompany code: ${company.code}\nSet up your login (works once, for ${result.days} days): ${result.link}`;
  return (
    <Dialog open onClose={onClose} title="Login invite ready">
      <div className="stack">
        {result.emailed ? <div className="notice">Emailed to {result.user.email}.</div>
          : <div className="warnbox">Email not sent: {result.emailError} Share the details below yourself.</div>}
        <dl className="kv">
          <dt>Person</dt><dd>{result.user.name} · {result.user.email}</dd>
          <dt>App address</dt><dd>{appUrl}</dd>
          <dt>Company code</dt><dd className="mono">{company.code}</dd>
        </dl>
        <p className="secret">{result.link}</p>
        <p className="tiny muted">The link works once, for {result.days} days. They choose their own password and scan a QR code — no password is ever sent.</p>
        <div className="row end">
          <button className="btn ghost" onClick={async () => toast(await copyText(text) ? 'Copied with instructions' : 'Copy the link by hand')}><Icon name="copy" size={18} /> Copy</button>
          <button className="btn primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </Dialog>
  );
}

function CompanyPage({ id, appUrl }) {
  const toast = useToast();
  const [data, reload, error] = useLoad(() => get(`/api/console/companies/${id}`), [id]);
  const [tab, setTab] = useState('users');
  const [f, setF] = useState(null);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState('');
  const [dlg, setDlg] = useState(null);
  const [result, setResult] = useState(null);
  useEffect(() => {
    if (data && !f) {
      const c = data.company;
      setF({ name: c.name, code: c.code, ticketPrefix: c.ticketPrefix, gstin: c.gstin, contactName: c.contactName, contactEmail: c.contactEmail, contactPhone: c.contactPhone,
        address: c.address, notes: c.notes, maxUsers: String(c.maxUsers || ''), maxConcurrent: String(c.maxConcurrent || ''), validUntil: c.validUntil,
        idleMinutes: c.idleMinutes ? String(c.idleMinutes) : '', emailDomains: c.emailDomains, modules: c.modules });
    }
  }, [data, f]);
  if (error && !data) return <ErrorPanel error={error} retry={reload} />;
  if (!data || !f) return <Skeleton rows={6} />;
  const c = data.company;
  const [label, tone] = statusOf(c);

  async function run(key, fn, ok) {
    setBusy(key);
    try { const r = await fn(); if (ok) toast(typeof ok === 'function' ? ok(r) : ok); await reload(); return r; } catch (e) { toast(e.message, true); return null; } finally { setBusy(''); }
  }
  async function save(e) {
    e.preventDefault();
    setErrors({});
    setBusy('save');
    try {
      await post(`/api/console/companies/${id}`, toBody(f));
      toast('Company saved');
      setF(null);
      await reload();
    } catch (err) { setErrors({ form: err.message, ...(err.fields || {}) }); window.scrollTo({ top: 0, behavior: 'smooth' }); } finally { setBusy(''); }
  }
  async function setActive(active, reason) {
    await run('active', () => post(`/api/console/companies/${id}`, { ...toBody(f), active, suspendReason: reason }), active ? 'Company activated' : 'Company suspended — everyone was signed out');
    setF(null);
    setDlg(null);
  }
  const userAct = async (u, action) => {
    const map = {
      disable: [() => post(`/api/console/companies/${id}/users/${u.id}`, { disabled: true }), `${u.name} disabled and signed out`],
      enable: [() => post(`/api/console/companies/${id}/users/${u.id}`, { disabled: false }), `${u.name} enabled`],
      resend: [() => post(`/api/console/companies/${id}/users/${u.id}/resend-invite`), null],
      reset: [() => post(`/api/console/companies/${id}/users/${u.id}/reset-login`), null],
      remove: [() => del(`/api/console/companies/${id}/users/${u.id}`), `${u.name} removed`],
    }[action];
    const r = await run(`${action}${u.id}`, map[0], map[1]);
    if (r?.link) setResult(r);
  };

  return (
    <>
      <div className="page-head">
        <div><Link to="/console" className="small muted" style={{ textDecoration: 'none' }}>← Companies</Link>
          <h1 className="cp-head">{c.name} <span className="pill mono">{c.code}</span> <span className={`pill ${tone}`}>{label}</span></h1>
          <p className="muted">Users {limit(c.users, c.maxUsers)} · signed in now {limit(c.online, c.maxConcurrent)} · {c.validUntil ? `valid until ${fmtDate(c.validUntil)}` : 'no end date'} · created {fmtMs(c.createdAt)}</p>
          {!c.active && c.suspendReason && <p className="small" style={{ marginTop: 4 }}>Reason: {c.suspendReason}</p>}
        </div>
        <div className="row">
          <button className="btn ghost small" disabled={!c.online || busy === 'signout'} onClick={() => setDlg('signout')}><Icon name="logout" size={16} /> Sign out everyone</button>
          {c.active ? <button className="btn danger small" onClick={() => setDlg('suspend')}>Suspend</button>
            : <button className="btn primary small" disabled={busy === 'active'} onClick={() => setActive(true)}>Activate</button>}
        </div>
      </div>

      <div className="tabs" role="tablist">
        {[['users', `Users (${data.users.length})`], ['sessions', `Signed in (${data.sessions.length})`], ['settings', 'Settings & limits'], ['log', 'Login history'], ['changes', 'Changes']].map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>))}
      </div>

      {tab === 'users' && (
        <section className="panel">
          <div className="spread" style={{ marginBottom: 10 }}><h2>Logins</h2>
            <button className="btn primary small" disabled={c.maxUsers > 0 && c.users >= c.maxUsers} title={c.maxUsers > 0 && c.users >= c.maxUsers ? 'User limit reached' : ''} onClick={() => setDlg('add')}><Icon name="plus" size={16} /> Add user</button></div>
          {c.maxUsers > 0 && c.users >= c.maxUsers && <div className="warnbox small" style={{ marginBottom: 10 }}>User limit reached ({c.maxUsers}). Raise it under Settings &amp; limits, or disable a login.</div>}
          <div className="tablewrap" style={{ boxShadow: 'none' }}><table className="data">
            <thead><tr><th>Name</th><th>Role</th><th>Status</th><th>Last login</th><th /></tr></thead>
            <tbody>{data.users.map((u) => (
              <tr key={u.id}>
                <td><b>{u.name}</b>{u.online && <span className="pill ok" style={{ marginLeft: 6 }}>Online</span>}<div className="tiny muted">{u.email}</div></td>
                <td><select value={u.role} aria-label={`Role of ${u.name}`} disabled={!!busy}
                  onChange={(e) => run(`role${u.id}`, () => post(`/api/console/companies/${id}/users/${u.id}`, { role: e.target.value }), `${u.name} is now ${e.target.value}`)}>
                  {data.roles.map((r) => <option key={r}>{r}</option>)}</select></td>
                <td><span className={`pill ${u.status === 'Active' ? 'ok' : u.status === 'Disabled' || u.status === 'Locked' ? 'bad' : 'warn'}`}>{u.status}</span></td>
                <td className="nowrap small">{u.lastLogin ? fmtMs(u.lastLogin, true) : '—'}</td>
                <td><div className="row tight" style={{ justifyContent: 'flex-end' }}>
                  {!u.disabled && u.status !== 'Active' && u.status !== 'Locked' && <button className="btn ghost small" disabled={!!busy} onClick={() => userAct(u, 'resend')}>New invite link</button>}
                  {!u.disabled && (u.status === 'Active' || u.status === 'Locked') && <button className="btn ghost small" disabled={!!busy} onClick={() => setDlg({ kind: 'reset', u })}>Reset login</button>}
                  {u.disabled ? <button className="btn ghost small" disabled={!!busy} onClick={() => userAct(u, 'enable')}>Enable</button>
                    : <button className="btn ghost small" disabled={!!busy} onClick={() => userAct(u, 'disable')}>Disable</button>}
                  <button className="iconbtn" aria-label={`Remove ${u.name}`} disabled={!!busy} onClick={() => setDlg({ kind: 'remove', u })}><Icon name="trash" size={18} /></button>
                </div></td>
              </tr>))}</tbody></table></div>
          <p className="tiny muted" style={{ marginTop: 10 }}>Company Admins can also manage these logins themselves in the RMA app (Users &amp; security). Operators cannot see RMA or care pack data.</p>
        </section>
      )}

      {tab === 'sessions' && (
        <section className="panel">
          <h2>Signed in now</h2>
          <p className="muted small" style={{ margin: '4px 0 10px' }}>{c.maxConcurrent ? `${c.online} of ${c.maxConcurrent} seats in use.` : 'No limit on people signed in at once.'}</p>
          {!data.sessions.length ? <p className="muted">Nobody is signed in.</p> : (
            <div className="tablewrap" style={{ boxShadow: 'none' }}><table className="data">
              <thead><tr><th>Person</th><th>Device</th><th>Since</th><th>Last active</th><th /></tr></thead>
              <tbody>{data.sessions.map((s) => (
                <tr key={s.id}><td><b>{s.name}</b><div className="tiny muted">{s.email} · {s.role}</div></td><td className="small">{s.ua}{s.place ? ` · ${s.place}` : ''}</td>
                  <td className="nowrap small">{fmtMs(s.created_at, true)}</td><td className="nowrap small">{fmtMs(s.last_active, true)}</td>
                  <td><button className="btn ghost small" disabled={!!busy} onClick={() => run(`s${s.id}`, () => del(`/api/console/companies/${id}/sessions/${s.id}`), `${s.name} signed out`)}>Sign out</button></td></tr>))}</tbody>
            </table></div>)}
        </section>
      )}

      {tab === 'settings' && (
        <form onSubmit={save} noValidate>
          {errors.form && <div className="formerror" role="alert">{errors.form}</div>}
          <CompanyForm f={f} setF={setF} errors={errors} creating={false} />
          <div className="savebar"><button type="button" className="btn ghost" onClick={() => { setF(null); setErrors({}); }}>Undo changes</button>
            <button className="btn primary" disabled={busy === 'save'}>{busy === 'save' ? 'Saving…' : 'Save settings'}</button></div>
        </form>
      )}

      {tab === 'log' && (
        <section className="panel"><h2>Login history</h2>
          <div className="tablewrap" style={{ boxShadow: 'none' }}><table className="data">
            <thead><tr><th>When</th><th>Event</th><th>Who</th><th>Detail</th><th>Where</th></tr></thead>
            <tbody>{data.log.map((l, i) => (
              <tr key={i}><td className="nowrap small">{fmtMs(l.at, true)}</td><td><span className={`pill ${/failed|locked|refused/.test(l.event) ? 'bad' : ''}`}>{l.event.replace(/_/g, ' ')}</span></td>
                <td className="small">{l.email}</td><td className="small">{l.detail}</td><td className="small">{[l.ua, l.ip].filter(Boolean).join(' · ')}</td></tr>))}</tbody>
          </table></div></section>
      )}

      {tab === 'changes' && (
        <section className="panel"><h2>Changes made from the console</h2>
          {!data.consoleLog.length ? <p className="muted">None yet.</p> : (
            <div className="tablewrap" style={{ boxShadow: 'none' }}><table className="data">
              <thead><tr><th>When</th><th>Operator</th><th>Action</th><th>Detail</th></tr></thead>
              <tbody>{data.consoleLog.map((l) => <tr key={l.id}><td className="nowrap small">{fmtMs(l.at, true)}</td><td className="small">{l.op_email}</td><td>{l.action.replace(/_/g, ' ')}</td><td className="small">{l.detail}</td></tr>)}</tbody>
            </table></div>)}
        </section>
      )}

      {dlg === 'add' && <AddUser id={id} roles={data.roles} domains={c.emailDomains} onClose={() => setDlg(null)} onDone={(r) => { setDlg(null); setResult(r); reload(); }} />}
      {dlg === 'suspend' && <SuspendDialog company={c} busy={busy === 'active'} onClose={() => setDlg(null)} onConfirm={(reason) => setActive(false, reason)} />}
      <Dialog open={dlg === 'signout'} onClose={() => setDlg(null)} title="Sign out everyone?">
        <p>All {c.online} people signed in to {c.name} will be signed out now. They can log in again.</p>
        <div className="row end"><button className="btn ghost" onClick={() => setDlg(null)}>Cancel</button>
          <button className="btn danger" disabled={busy === 'signout'} onClick={async () => { await run('signout', () => post(`/api/console/companies/${id}/signout-all`), (r) => `${r.ended} session(s) ended`); setDlg(null); }}>Sign out everyone</button></div>
      </Dialog>
      {dlg?.kind === 'reset' && (
        <Dialog open onClose={() => setDlg(null)} title={`Reset ${dlg.u.name}'s login?`}>
          <p>Their password and authenticator are cleared and they are signed out. A new invite link lets them set up again — use this when they lost their phone and recovery codes.</p>
          <div className="row end"><button className="btn ghost" onClick={() => setDlg(null)}>Cancel</button>
            <button className="btn danger" disabled={!!busy} onClick={async () => { const u = dlg.u; setDlg(null); await userAct(u, 'reset'); }}>Reset login</button></div>
        </Dialog>
      )}
      {dlg?.kind === 'remove' && (
        <Dialog open onClose={() => setDlg(null)} title={`Remove ${dlg.u.name}?`}>
          <p>The login is deleted. Their past work in RMAs stays. To keep the login for later, disable it instead.</p>
          <div className="row end"><button className="btn ghost" onClick={() => setDlg(null)}>Cancel</button>
            <button className="btn danger" disabled={!!busy} onClick={async () => { const u = dlg.u; setDlg(null); await userAct(u, 'remove'); }}>Remove</button></div>
        </Dialog>
      )}
      {result && <InviteResult result={result} company={c} appUrl={appUrl} onClose={() => setResult(null)} />}
    </>
  );
}

function AddUser({ id, roles, domains, onClose, onDone }) {
  const [f, setF] = useState({ name: '', email: '', role: 'Technician', dupOverride: false });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    const errs = {};
    if (!f.name.trim()) errs.name = 'Enter the name';
    if (!EMAIL.test(f.email.trim())) errs.email = 'Enter a valid email';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try { onDone(await post(`/api/console/companies/${id}/users`, f)); } catch (err) { setErrors({ form: err.message, ...(err.fields || {}) }); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} title="Add a user">
      <form className="stack" onSubmit={submit} noValidate>
        {errors.form && <div className="formerror">{errors.form}</div>}
        <Field label="Name" required error={errors.name}><input type="text" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Email" required error={errors.email} hint={domains ? `Must be at: ${domains}` : null}><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Role"><select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{roles.map((r) => <option key={r}>{r}</option>)}</select></Field>
        <label className="check"><input type="checkbox" checked={f.dupOverride} onChange={(e) => setF({ ...f, dupOverride: e.target.checked })} />Can override duplicate RMA warnings</label>
        <div className="row end"><button type="button" className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy}>{busy ? 'Adding…' : 'Add and create invite'}</button></div>
      </form>
    </Dialog>
  );
}

function SuspendDialog({ company, busy, onClose, onConfirm }) {
  const [reason, setReason] = useState('');
  return (
    <Dialog open onClose={onClose} title={`Suspend ${company.name}?`}>
      <div className="stack">
        <p>Everyone is signed out and nobody can log in until you activate it again. Data is kept.</p>
        <Field label="Reason (shown to people who try to log in)"><input type="text" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Subscription renewal pending" /></Field>
        <div className="row end"><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn danger" disabled={busy} onClick={() => onConfirm(reason)}>Suspend</button></div>
      </div>
    </Dialog>
  );
}

// ======================= Operators, log, profile =======================
function Operators() {
  const toast = useToast();
  const [data, reload, error] = useLoad(() => get('/api/console/operators'));
  const [dlg, setDlg] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  if (error && !data) return <ErrorPanel error={error} retry={reload} />;
  if (!data) return <Skeleton rows={4} />;
  async function act(fn, ok) {
    setBusy(true);
    try { const r = await fn(); if (r?.link) setResult(r); else if (ok) toast(ok); reload(); } catch (e) { toast(e.message, true); } finally { setBusy(false); }
  }
  return (
    <>
      <div className="page-head"><div><h1>Operators</h1><p className="muted">People who can use this console. Each has their own password and authenticator.</p></div>
        <button className="btn primary" onClick={() => setDlg('add')}><Icon name="plus" size={18} /> Invite operator</button></div>
      <div className="tablewrap"><table className="data">
        <thead><tr><th>Name</th><th>Status</th><th>Last login</th><th>Added</th><th /></tr></thead>
        <tbody>{data.operators.map((o) => (
          <tr key={o.id}><td><b>{o.name}</b>{o.id === data.you && <span className="pill" style={{ marginLeft: 6 }}>You</span>}{o.online && <span className="pill ok" style={{ marginLeft: 6 }}>Online</span>}<div className="tiny muted">{o.email}</div></td>
            <td><span className={`pill ${o.status === 'Active' ? 'ok' : o.status === 'Disabled' ? 'bad' : 'warn'}`}>{o.status}</span></td>
            <td className="nowrap small">{o.lastLogin ? fmtMs(o.lastLogin, true) : '—'}</td><td className="small">{fmtMs(o.createdAt)}{o.createdBy ? ` · ${o.createdBy}` : ''}</td>
            <td>{o.id !== data.you && <div className="row tight" style={{ justifyContent: 'flex-end' }}>
              <button className="btn ghost small" disabled={busy} onClick={() => act(() => post(`/api/console/operators/${o.id}/reset`))}>{o.status === 'Active' || o.status === 'Locked' ? 'Reset login' : 'New invite link'}</button>
              <button className="btn ghost small" disabled={busy} onClick={() => act(() => post(`/api/console/operators/${o.id}`, { disabled: o.status !== 'Disabled' }), o.status === 'Disabled' ? 'Enabled' : 'Disabled and signed out')}>{o.status === 'Disabled' ? 'Enable' : 'Disable'}</button>
            </div>}</td></tr>))}</tbody>
      </table></div>
      {dlg === 'add' && <InviteOperator onClose={() => setDlg(null)} onDone={(r) => { setDlg(null); setResult(r); reload(); }} />}
      {result && (
        <Dialog open onClose={() => setResult(null)} title="Operator invite ready">
          <div className="stack">
            {result.emailed ? <div className="notice">Emailed to {result.user.email}.</div> : <div className="warnbox">Email not sent: {result.emailError} Share the link yourself.</div>}
            <p className="secret">{result.link}</p>
            <p className="tiny muted">Works once, for {result.days} days.</p>
            <div className="row end"><button className="btn ghost" onClick={async () => toast(await copyText(result.link) ? 'Link copied' : 'Copy by hand')}><Icon name="copy" size={18} /> Copy</button>
              <button className="btn primary" onClick={() => setResult(null)}>Done</button></div>
          </div>
        </Dialog>
      )}
    </>
  );
}

function InviteOperator({ onClose, onDone }) {
  const [f, setF] = useState({ name: '', email: '' });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    if (!f.name.trim() || !EMAIL.test(f.email.trim())) { setErrors({ name: !f.name.trim() ? 'Enter the name' : null, email: !EMAIL.test(f.email.trim()) ? 'Enter a valid email' : null }); return; }
    setBusy(true);
    try { onDone(await post('/api/console/operators', f)); } catch (err) { setErrors({ form: err.message, ...(err.fields || {}) }); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} title="Invite an operator">
      <form className="stack" onSubmit={submit} noValidate>
        {errors.form && <div className="formerror">{errors.form}</div>}
        <p className="small muted">Operators can create and change companies and their logins. Give this only to people in your own team.</p>
        <Field label="Name" required error={errors.name}><input type="text" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Email" required error={errors.email}><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <div className="row end"><button type="button" className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy}>{busy ? 'Inviting…' : 'Invite'}</button></div>
      </form>
    </Dialog>
  );
}

function ActivityLog() {
  const [data, reload, error] = useLoad(() => get('/api/console/log'));
  const [q, setQ] = useState('');
  if (error && !data) return <ErrorPanel error={error} retry={reload} />;
  if (!data) return <Skeleton rows={5} />;
  const rows = data.filter((l) => !q || JSON.stringify(l).toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <div className="page-head"><div><h1>Activity log</h1><p className="muted">Every console login and change. Entries cannot be edited or deleted.</p></div></div>
      <div className="search" style={{ marginBottom: 12 }}><Icon name="search" size={18} /><input type="search" placeholder="Search operator, company, action" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search log" /></div>
      <div className="tablewrap"><table className="data">
        <thead><tr><th>When</th><th>Operator</th><th>Action</th><th>Company</th><th>Detail</th></tr></thead>
        <tbody>{rows.map((l) => (
          <tr key={l.id}><td className="nowrap small">{fmtMs(l.at, true)}</td><td className="small">{l.op_email}</td>
            <td><span className={`pill ${/failed/.test(l.action) ? 'bad' : ''}`}>{l.action.replace(/_/g, ' ')}</span></td>
            <td className="small">{l.company_id ? <Link to={`/console/companies/${l.company_id}`}>{l.company || 'open'}</Link> : '—'}</td><td className="small">{l.detail}</td></tr>))}</tbody>
      </table></div>
    </>
  );
}

function ConsoleProfile({ op, onLogout }) {
  const toast = useToast();
  const [f, setF] = useState({ current: '', password: '', confirm: '', code: '' });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState('');
  const [rcode, setRcode] = useState('');
  const [codes, setCodes] = useState(null);
  async function change(e) {
    e.preventDefault();
    setBusy('pw');
    setErrors({});
    try { await post('/api/console/change-password', f); setF({ current: '', password: '', confirm: '', code: '' }); toast('Password changed. Other sessions were signed out.'); }
    catch (err) { setErrors({ form: err.message, ...(err.fields || {}) }); } finally { setBusy(''); }
  }
  async function newCodes(e) {
    e.preventDefault();
    setBusy('rc');
    try { setCodes((await post('/api/console/recovery-codes', { code: rcode })).recoveryCodes); setRcode(''); } catch (err) { toast(err.fields?.code || err.message, true); } finally { setBusy(''); }
  }
  return (
    <>
      <div className="page-head"><div><h1>{op.name}</h1><p className="muted">{op.email} · {op.recoveryLeft} recovery codes left</p></div>
        <button className="btn ghost" onClick={onLogout}><Icon name="logout" size={18} /> Log out</button></div>
      <div className="grid2">
        <form className="panel stack" onSubmit={change} noValidate>
          <h2>Change password</h2>
          {errors.form && <div className="formerror">{errors.form}</div>}
          <Field label="Current password" error={errors.current}><input type="password" autoComplete="current-password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} /></Field>
          <PasswordPair f={f} setF={setF} errors={errors} email={op.email} />
          <CodeInput value={f.code} onChange={(v) => setF({ ...f, code: v })} error={errors.code} id="pcode" />
          <button className="btn primary" disabled={busy === 'pw'}>{busy === 'pw' ? 'Saving…' : 'Change password'}</button>
        </form>
        <form className="panel stack" onSubmit={newCodes} noValidate>
          <h2>Recovery codes</h2>
          <p className="muted small">New codes replace all old ones.</p>
          {codes ? <div className="codes">{codes.map((c) => <span key={c}>{c}</span>)}</div> : <>
            <CodeInput value={rcode} onChange={setRcode} id="rcode" />
            <button className="btn ghost" disabled={busy === 'rc'}>Make new recovery codes</button></>}
        </form>
      </div>
    </>
  );
}
