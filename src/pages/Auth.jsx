import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { get, post } from '../api.js';
import { Field, Icon, BrandLogo, Logo, Wordmark, Strength, VersionLabel, passwordScore, PaymentBox } from '../ui.jsx';

const EMAIL = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/;
const CODE_KEY = 'rma.companyCode';
const savedCode = () => { try { return localStorage.getItem(CODE_KEY) || ''; } catch { return ''; } };
const saveCode = (c) => { try { localStorage.setItem(CODE_KEY, c); } catch { /* private mode */ } };

function initialMode() {
  return { '/setup': 'setup', '/invite': 'invite', '/forgot-password': 'forgot', '/reset-password': 'reset', '/signup': 'signup' }[location.pathname] || 'login';
}

function Art() {
  return (
    <div className="auth-art">
      <div className="brand"><BrandLogo height={52} /><span style={{ fontSize: '1.35rem' }}><Wordmark /></span></div>
      <div>
        <h1>Every faulty part, from customer to OEM and back.</h1>
        <p>Raise RMAs with photos, generate the OEM form, batch dispatches and close the loop — from the office or the service bench.</p>
      </div>
      <div className="line" aria-hidden="true">
        {['--s-open', '--s-await', '--s-oem', '--s-toem', '--s-back', '--s-tocust', '--s-closed'].map((c) => <i key={c} style={{ '--c': `var(${c})` }} />)}
      </div>
      <ul>
        <li><Icon name="building" /> Separate login and data for every company</li>
        <li><Icon name="shield" /> Two-step login with an authenticator app</li>
        <li><Icon name="camera" /> Install on Android or iPhone, take photos on the spot</li>
      </ul>
    </div>
  );
}

export default function Auth({ onSignedIn, reason }) {
  const [mode, setMode] = useState(initialMode);
  // Read the token once, then remove it from the address bar and history.
  const [token] = useState(() => new URLSearchParams(location.hash.slice(1)).get('token') || '');
  const [notice, setNotice] = useState('');
  const [needsSetup, setNeedsSetup] = useState(false);
  useEffect(() => {
    const paths = { setup: '/setup', invite: '/invite', forgot: '/forgot-password', reset: '/reset-password', login: '/login', signup: '/signup' };
    history.replaceState({}, '', paths[mode]);
  }, [mode]);
  useEffect(() => {
    get('/api/setup').then((r) => {
      setNeedsSetup(r.needsSetup);
      if (r.needsSetup && mode === 'login') setMode('setup');
    }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="auth">
      <Art />
      <div className="auth-card">
        {mode === 'login' && <Login onSignedIn={onSignedIn} reason={reason} notice={notice} toForgot={() => setMode('forgot')} needsSetup={needsSetup} toSetup={() => setMode('setup')} toSignup={() => setMode('signup')} />}
        {mode === 'signup' && <Signup toLogin={() => setMode('login')} />}
        {mode === 'setup' && <Setup onSignedIn={onSignedIn} toLogin={() => setMode('login')} />}
        {mode === 'invite' && <Invite token={token} onSignedIn={onSignedIn} toLogin={() => setMode('login')} />}
        {mode === 'forgot' && <Forgot toLogin={() => setMode('login')} />}
        {mode === 'reset' && <Reset token={token} toForgot={() => setMode('forgot')} onDone={() => { setNotice('Password changed. Log in with your new password.'); setMode('login'); }} />}
        <VersionLabel />
      </div>
    </div>
  );
}

function CodeField({ value, onChange, error, useRecovery, id = 'code', autoFocus = true }) {
  return (
    <Field label={useRecovery ? 'Recovery code' : 'Authenticator code'} htmlFor={id} error={error}>
      <input id={id} className="otp" type="text" autoComplete="one-time-code" inputMode={useRecovery ? 'text' : 'numeric'}
        maxLength={useRecovery ? 8 : 6} value={value} autoFocus={autoFocus}
        onChange={(e) => onChange(useRecovery ? e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') : e.target.value.replace(/\D/g, ''))} />
    </Field>
  );
}

function Login({ onSignedIn, reason, notice, toForgot, needsSetup, toSetup, toSignup }) {
  const [step, setStep] = useState('password');
  const [f, setF] = useState({ companyCode: savedCode(), email: '', password: '' });
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [loginToken, setLoginToken] = useState('');
  const [company, setCompany] = useState(null);
  const [active, setActive] = useState(null);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);

  async function submitPassword(e) {
    e.preventDefault();
    const errs = {};
    if (!/^[A-Za-z0-9]{2,12}$/.test(f.companyCode.trim())) errs.companyCode = 'Enter your company code (ask your admin)';
    if (!EMAIL.test(f.email.trim())) errs.email = 'Enter a valid email address';
    if (!f.password) errs.password = 'Enter your password';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      const r = await post('/api/auth/login', { companyCode: f.companyCode.trim(), email: f.email.trim(), password: f.password });
      saveCode(f.companyCode.trim().toUpperCase());
      setLoginToken(r.loginToken);
      setCompany(r.company);
      setStep('code');
      setF((x) => ({ ...x, password: '' }));
    } catch (err) {
      setErrors({ form: err.message, ...(err.fields || {}), payment: err.data?.code === 'access_ended' ? (err.data.payment || {}) : null });
    } finally {
      setBusy(false);
    }
  }
  async function submitCode(e, endOther = false) {
    e?.preventDefault();
    if (!endOther) {
      if (!useRecovery && !/^\d{6}$/.test(code)) return setErrors({ code: 'Enter the 6-digit code from your authenticator app' });
      if (useRecovery && !/^[A-Z0-9]{8}$/.test(code)) return setErrors({ code: 'Recovery codes have 8 letters and numbers' });
    }
    setErrors({});
    setBusy(true);
    try {
      const r = await post('/api/auth/login/verify', endOther ? { loginToken, endOther: true }
        : useRecovery ? { loginToken, recoveryCode: code } : { loginToken, code });
      const note = r.endedOther ? `Signed out the other session (${r.endedOther.device}).`
        : useRecovery ? `Recovery code used — ${r.user.recoveryLeft} left. Make new ones in your profile.` : null;
      onSignedIn(r.user, r.idleMinutes, note);
    } catch (err) {
      if (err.status === 409 && err.data.active) {
        setActive(err.data.active);
        setStep('active');
      } else if (err.status === 403 || err.data?.code === 'seats_full') {
        setErrors({ form: err.message, payment: err.data?.code === 'access_ended' ? (err.data.payment || {}) : null });
        setCode('');
      } else if (err.status === 400 && /expired|start again/i.test(err.message)) {
        setStep('password');
        setErrors({ form: err.message });
      } else {
        setErrors({ code: err.message });
        setCode('');
      }
    } finally {
      setBusy(false);
    }
  }
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  return (
    <>
      <div>
        <h2 style={{ fontSize: '1.5rem' }}>{step === 'active' ? 'Already signed in elsewhere' : 'Log in'}</h2>
        {step === 'code' && company && <p style={{ marginTop: 8 }}><span className="cochip"><b>{company.code}</b>{company.name}</span></p>}
      </div>
      {notice && step === 'password' && <div className="notice" role="status">{notice}</div>}
      {!notice && reason && step === 'password' && <div className="warnbox">{reason}</div>}
      {errors.form && <div className="formerror" role="alert">{errors.form}</div>}
      {errors.payment && <div className="panel" style={{ padding: 14 }}><h2 style={{ fontSize: '1rem', marginBottom: 10 }}>How to pay</h2><PaymentBox p={errors.payment} /></div>}
      {step === 'password' && (
        <form className="stack" onSubmit={submitPassword} noValidate>
          <Field label="Company code" htmlFor="cc" error={errors.companyCode} hint="Each company has its own logins. Your admin gives you the code.">
            <input id="cc" className="upper" type="text" autoCapitalize="characters" autoComplete="organization" maxLength={12}
              value={f.companyCode} onChange={(e) => setF({ ...f, companyCode: e.target.value.replace(/[^A-Za-z0-9]/g, '') })} />
          </Field>
          <Field label="Email" htmlFor="email" error={errors.email}>
            <input id="email" type="email" autoComplete="username" inputMode="email" value={f.email} onChange={set('email')} />
          </Field>
          <Field label="Password" htmlFor="password" error={errors.password}>
            <input id="password" type="password" autoComplete="current-password" value={f.password} onChange={set('password')} />
            <button type="button" className="linkbtn" style={{ justifySelf: 'end' }} onClick={toForgot}>Forgot password?</button>
          </Field>
          <button className="btn primary block" disabled={busy}>{busy ? 'Checking…' : 'Continue'}</button>
          {needsSetup && <button type="button" className="btn ghost block" onClick={toSetup}>First time? Set up the app</button>}
          {!needsSetup && (
            <div className="signup-cta">
              <span>New to TrackMyRMA?</span>
              <button type="button" className="btn ghost block" onClick={toSignup}>Start 30-day free trial</button>
            </div>
          )}
        </form>
      )}
      {step === 'code' && (
        <form className="stack" onSubmit={submitCode} noValidate>
          <div className="steps" aria-hidden="true"><i className="on" /><i className="on" /></div>
          <p className="muted">{useRecovery ? 'Enter one of your saved recovery codes for this company. Each code works once.'
            : `Open your authenticator app and enter the 6-digit code for TrackMyRMA (${company?.code}).`}</p>
          <CodeField value={code} onChange={setCode} error={errors.code} useRecovery={useRecovery} />
          <button className="btn primary block" disabled={busy}>{busy ? 'Verifying…' : 'Log in'}</button>
          <button type="button" className="btn ghost block" onClick={() => { setUseRecovery(!useRecovery); setCode(''); setErrors({}); }}>
            {useRecovery ? 'Use authenticator code instead' : 'Lost your phone? Use a recovery code'}
          </button>
        </form>
      )}
      {step === 'active' && active && (
        <div className="stack">
          <p>This login is in use on <b>{active.device}</b>{active.place ? <> in <b>{active.place}</b></> : null}, last active at{' '}
            <b>{new Date(active.lastActive).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}</b>.</p>
          <p className="muted">Only one session per login is allowed. It frees up when that device logs out or after a few minutes without activity.</p>
          <div className="warnbox">If this wasn't you, end that session now and change your password.</div>
          <button className="btn primary block" disabled={busy} onClick={() => submitCode(null, true)}>End that session and log in here</button>
          <button className="btn ghost block" onClick={() => { setStep('password'); setCode(''); }}>Cancel</button>
        </div>
      )}
    </>
  );
}

// Shared last two steps: scan QR + confirm code, then save recovery codes.
function Enroll({ setup, onSignedIn, stepBase = 1, total = 3, welcome }) {
  const [qr, setQr] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    QRCode.toDataURL(setup.otpauth, { margin: 0, width: 400, color: { dark: '#1e1b4b', light: '#ffffff' } }).then(setQr);
  }, [setup.otpauth]);
  async function submit(e) {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) return setError('Enter the 6-digit code shown in your app');
    setBusy(true);
    setError('');
    try {
      const r = await post('/api/auth/enroll', { setupToken: setup.setupToken, code });
      if (setup.company?.code) saveCode(setup.company.code);
      setDone(r);
    } catch (err) {
      setError(err.fields?.code || err.message);
      setCode('');
    } finally {
      setBusy(false);
    }
  }
  function download() {
    const text = `TrackMyRMA recovery codes\nCompany: ${setup.company?.name} (${setup.company?.code})\n\n${done.recoveryCodes.join('\n')}\n\nEach code works once. Keep them somewhere safe.\n`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = `rma-recovery-codes-${setup.company?.code || 'login'}.txt`;
    a.click();
  }
  const stepIdx = done ? stepBase + 1 : stepBase;
  return (
    <>
      <div className="steps" aria-label={`Step ${stepIdx} of ${total}`}>{Array.from({ length: total }, (_, i) => <i key={i} className={i < stepIdx ? 'on' : ''} />)}</div>
      {!done && (
        <form className="stack" onSubmit={submit} noValidate>
          <div>
            <h2 style={{ fontSize: '1.5rem' }}>Set up two-step login</h2>
            <p className="muted" style={{ marginTop: 6 }}>Scan with Google Authenticator, Microsoft Authenticator or Authy, then enter the 6-digit code.
              It will show as <b>TrackMyRMA ({setup.company?.code})</b>.</p>
          </div>
          <div className="qr">{qr && <img src={qr} alt="QR code for your authenticator app" />}</div>
          <details>
            <summary className="small muted" style={{ cursor: 'pointer' }}>On this phone? Enter this key in the app instead</summary>
            <p className="secret" style={{ marginTop: 8 }}>{setup.secret.match(/.{1,4}/g).join(' ')}</p>
          </details>
          <CodeField value={code} onChange={setCode} error={error} useRecovery={false} id="ecode" autoFocus={false} />
          <button className="btn primary block" disabled={busy}>{busy ? 'Verifying…' : 'Verify and continue'}</button>
        </form>
      )}
      {done && (
        <div className="stack">
          <div>
            <h2 style={{ fontSize: '1.5rem' }}>Save your recovery codes</h2>
            <p className="muted" style={{ marginTop: 6 }}>If you lose your phone, each code lets you log in to <b>{setup.company?.name}</b> once. They are shown only now.</p>
          </div>
          <div className="codes">{done.recoveryCodes.map((c) => <span key={c}>{c}</span>)}</div>
          <button className="btn ghost block" onClick={download}><Icon name="download" size={18} /> Download codes</button>
          <label className="check"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />I have saved these codes somewhere safe</label>
          <button className="btn primary block" disabled={!saved} onClick={() => onSignedIn(done.user, done.idleMinutes, welcome)}>Open TrackMyRMA</button>
        </div>
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

function Setup({ onSignedIn, toLogin }) {
  const [f, setF] = useState({ name: '', email: '', password: '', confirm: '', companyName: '', companyCode: '', ticketPrefix: '' });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function submit(e) {
    e.preventDefault();
    const errs = {};
    if (!f.name.trim()) errs.name = 'Enter your name';
    if (!EMAIL.test(f.email.trim())) errs.email = 'Enter a valid email address';
    if (!f.companyName.trim()) errs.companyName = 'Enter the company name';
    if (!/^[A-Za-z0-9]{2,12}$/.test(f.companyCode)) errs.companyCode = '2–12 letters or numbers, e.g. INF';
    if (f.ticketPrefix && !/^[A-Za-z0-9]{2,8}$/.test(f.ticketPrefix)) errs.ticketPrefix = '2–8 letters or numbers';
    if (passwordScore(f.password, f.email).score < 3) errs.password = passwordScore(f.password, f.email).msg || 'Choose a password';
    if (f.confirm !== f.password) errs.confirm = 'Passwords do not match';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      setSetup(await post('/api/setup', { ...f, ticketPrefix: f.ticketPrefix || f.companyCode }));
    } catch (err) {
      if (err.status === 409) { toLogin(); return; }
      setErrors({ form: Object.keys(err.fields || {}).length ? null : err.message, ...(err.fields || {}) });
    } finally {
      setBusy(false);
    }
  }
  if (setup) return <Enroll setup={setup} onSignedIn={onSignedIn} stepBase={2} total={3} welcome="All set. Raise your first RMA or import your old sheet." />;
  return (
    <form className="stack" onSubmit={submit} noValidate>
      <div className="steps" aria-label="Step 1 of 3"><i className="on" /><i /><i /></div>
      <div>
        <h2 style={{ fontSize: '1.5rem' }}>Set up TrackMyRMA</h2>
        <p className="muted" style={{ marginTop: 6 }}>Create the first company and its Admin login. More companies, their limits and logins are managed from the separate console website.</p>
      </div>
      {errors.form && <div className="formerror" role="alert">{errors.form}</div>}
      <Field label="Company name" required htmlFor="cn" error={errors.companyName}>
        <input id="cn" type="text" autoComplete="organization" value={f.companyName} onChange={set('companyName')} />
      </Field>
      <div className="fields">
        <Field label="Company code" required htmlFor="ccode" error={errors.companyCode} hint="Typed at every login">
          <input id="ccode" className="upper" type="text" maxLength={12} value={f.companyCode} onChange={(e) => setF({ ...f, companyCode: e.target.value.replace(/[^A-Za-z0-9]/g, '') })} />
        </Field>
        <Field label="RMA number prefix" htmlFor="tp" error={errors.ticketPrefix} hint={`${(f.ticketPrefix || f.companyCode || 'INF').toUpperCase()}-RMA-YYYYMM-0001`}>
          <input id="tp" className="upper" type="text" maxLength={8} placeholder={f.companyCode.toUpperCase()} value={f.ticketPrefix} onChange={(e) => setF({ ...f, ticketPrefix: e.target.value.replace(/[^A-Za-z0-9]/g, '') })} />
        </Field>
      </div>
      <Field label="Your name" required htmlFor="nm" error={errors.name}>
        <input id="nm" type="text" autoComplete="name" value={f.name} onChange={set('name')} />
      </Field>
      <Field label="Your email" required htmlFor="em" error={errors.email}>
        <input id="em" type="email" autoComplete="username" inputMode="email" value={f.email} onChange={set('email')} />
      </Field>
      <PasswordPair f={f} setF={setF} errors={errors} email={f.email} />
      <button className="btn primary block" disabled={busy}>{busy ? 'Creating…' : 'Continue to two-step login'}</button>
    </form>
  );
}

function Invite({ token, onSignedIn, toLogin }) {
  const [state, setState] = useState(token ? 'checking' : 'invalid');
  const [info, setInfo] = useState(null);
  const [problem, setProblem] = useState('');
  const [f, setF] = useState({ password: '', confirm: '' });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState(null);
  useEffect(() => {
    if (!token) return;
    post('/api/auth/invite/check', { token }).then((r) => { setInfo(r); setState('form'); })
      .catch((e) => { setProblem(e.message); setState('invalid'); });
  }, [token]);
  async function submit(e) {
    e.preventDefault();
    const pw = passwordScore(f.password, info.email);
    const errs = {};
    if (pw.score < 3) errs.password = pw.msg || 'Choose a password';
    if (f.confirm !== f.password) errs.confirm = 'Passwords do not match';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      setSetup(await post('/api/auth/invite/accept', { token, ...f }));
    } catch (err) {
      if (err.status === 400) { setProblem(err.message); setState('invalid'); return; }
      setErrors(Object.keys(err.fields || {}).length ? err.fields : { form: err.message });
    } finally {
      setBusy(false);
    }
  }
  if (setup) return <Enroll setup={setup} onSignedIn={onSignedIn} stepBase={2} total={3} welcome={`Welcome to ${info.company.name}.`} />;
  if (state === 'checking') return <p className="muted">Checking your invite…</p>;
  if (state === 'invalid') {
    return (
      <div className="stack">
        <h2 style={{ fontSize: '1.5rem' }}>Invite not valid</h2>
        <div className="warnbox">{problem || 'This invite link is missing or incomplete. Open the link from your email again.'}</div>
        <p className="muted">Invite links work once and expire after 7 days. Ask your admin to send a new one.</p>
        <button className="btn ghost block" onClick={toLogin}>Go to log in</button>
      </div>
    );
  }
  return (
    <form className="stack" onSubmit={submit} noValidate>
      <div className="steps" aria-label="Step 1 of 3"><i className="on" /><i /><i /></div>
      <div>
        <h2 style={{ fontSize: '1.5rem' }}>Hello {info.name.split(' ')[0]}</h2>
        <p className="muted" style={{ marginTop: 6 }}>Choose a password for your login at</p>
        <p style={{ marginTop: 8 }}><span className="cochip"><b>{info.company.code}</b>{info.company.name}</span></p>
        <p className="muted small" style={{ marginTop: 8 }}>You'll log in with company code <b>{info.company.code}</b> and {info.email}. This login works only for this company.</p>
      </div>
      {errors.form && <div className="formerror" role="alert">{errors.form}</div>}
      <input type="email" autoComplete="username" value={info.email} readOnly hidden />
      <PasswordPair f={f} setF={setF} errors={errors} email={info.email} />
      <button className="btn primary block" disabled={busy}>{busy ? 'Saving…' : 'Continue to two-step login'}</button>
    </form>
  );
}

// Suggests a short login code from the company name: initials of several words, or the first letters.
function suggestCode(name) {
  const words = name.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words.map((w) => w[0]).join('') : words[0] || '').slice(0, 6);
}

// New company on the 30-day free trial. The person signing up becomes its first Admin; the emailed link
// proves the address, then they choose a password and set up two-step login like any invite.
function Signup({ toLogin }) {
  const [f, setF] = useState({ companyName: '', code: '', name: '', email: '', phone: '', website: '' });
  const [codeTouched, setCodeTouched] = useState(false);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  function setName(e) {
    const companyName = e.target.value;
    setF((x) => ({ ...x, companyName, code: codeTouched ? x.code : suggestCode(companyName) }));
  }
  async function submit(e) {
    e.preventDefault();
    const errs = {};
    if (!f.companyName.trim()) errs.companyName = 'Enter your company name';
    if (f.code && !/^[A-Za-z0-9]{2,12}$/.test(f.code)) errs.code = 'Use 2–12 letters or numbers, e.g. ACME';
    if (!f.name.trim()) errs.name = 'Enter your name';
    if (!EMAIL.test(f.email.trim())) errs.email = 'Enter a valid email address';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      setDone(await post('/api/signup', { ...f, companyName: f.companyName.trim(), name: f.name.trim(), email: f.email.trim(), phone: f.phone.trim() }));
    } catch (err) {
      setErrors(Object.keys(err.fields || {}).length ? err.fields : { form: err.message });
    } finally {
      setBusy(false);
    }
  }
  if (done) {
    return (
      <div className="stack">
        <h2 style={{ fontSize: '1.5rem' }}>{done.emailed ? 'Check your email' : 'Your company is ready'}</h2>
        {done.company.code && <p><span className="cochip"><b>{done.company.code}</b>{done.company.name}</span></p>}
        {done.emailed
          ? <p className="muted">We've sent a link to <b>{f.email.trim()}</b>. Open it to choose your password and set up two-step login. It works once and expires in 7 days.</p>
          : <div className="warnbox">We couldn't send the email just now. Please contact us and we'll send your setup link.</div>}
        {done.company.code && <p className="muted small">Note your company code <b>{done.company.code}</b>: you and your team log in with it.</p>}
        {done.emailed && <p className="muted small">No email? Check spam or promotions, and wait a couple of minutes.</p>}
        {done.devLink && <a className="btn ghost block" href={done.devLink}>Open setup link (local test only)</a>}
        <button className="btn primary block" onClick={toLogin}>Back to log in</button>
      </div>
    );
  }
  return (
    <form className="stack" onSubmit={submit} noValidate>
      <div>
        <h2 style={{ fontSize: '1.5rem' }}>Start your free trial</h2>
        <p className="muted" style={{ marginTop: 6 }}>30 days, every feature, up to 3 logins and 50 RMAs. No card needed.</p>
      </div>
      {errors.form && <div className="formerror" role="alert">{errors.form}</div>}
      <Field label="Company name" htmlFor="su-co" required error={errors.companyName}>
        <input id="su-co" type="text" autoComplete="organization" maxLength={120} value={f.companyName} onChange={setName} />
      </Field>
      <Field label="Company code" htmlFor="su-code" error={errors.code} hint="Short code your team types when logging in. Leave blank and we'll pick one.">
        <input id="su-code" className="upper" type="text" autoCapitalize="characters" maxLength={12} value={f.code}
          onChange={(e) => { setCodeTouched(true); setF((x) => ({ ...x, code: e.target.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase() })); }} />
      </Field>
      <Field label="Your name" htmlFor="su-name" required error={errors.name}>
        <input id="su-name" type="text" autoComplete="name" maxLength={80} value={f.name} onChange={set('name')} />
      </Field>
      <Field label="Work email" htmlFor="su-email" required error={errors.email} hint="You'll be the Admin. We send the setup link here.">
        <input id="su-email" type="email" autoComplete="email" inputMode="email" value={f.email} onChange={set('email')} />
      </Field>
      <Field label="Phone (optional)" htmlFor="su-phone" error={errors.phone}>
        <input id="su-phone" type="tel" autoComplete="tel" inputMode="tel" value={f.phone} onChange={set('phone')} />
      </Field>
      <input type="text" name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" className="hp" value={f.website} onChange={set('website')} />
      <button className="btn primary block" disabled={busy}>{busy ? 'Creating…' : 'Create my company'}</button>
      <button type="button" className="btn ghost block" onClick={toLogin}>I already have a login</button>
    </form>
  );
}

function Forgot({ toLogin }) {
  const [f, setF] = useState({ companyCode: savedCode(), email: '' });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [devLink, setDevLink] = useState('');
  async function submit(e) {
    e.preventDefault();
    const errs = {};
    if (!/^[A-Za-z0-9]{2,12}$/.test(f.companyCode)) errs.companyCode = 'Enter your company code';
    if (!EMAIL.test(f.email.trim())) errs.email = 'Enter your login email';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      const r = await post('/api/auth/forgot', { companyCode: f.companyCode, email: f.email.trim() });
      if (r.devToken) setDevLink(`/reset-password#token=${encodeURIComponent(r.devToken)}`);
      setSent(true);
    } catch (err) {
      setErrors({ form: err.message, ...(err.fields || {}) });
    } finally {
      setBusy(false);
    }
  }
  if (sent) {
    return (
      <div className="stack">
        <h2 style={{ fontSize: '1.5rem' }}>Check your email</h2>
        <p className="muted">If <b>{f.email.trim()}</b> has a login at <b>{f.companyCode.toUpperCase()}</b>, a reset link is on its way. It works once and expires in 30 minutes.</p>
        <p className="muted small">No email? Check spam, wait 2 minutes and try again, or ask your admin to reset your login.</p>
        {devLink && <a className="btn ghost block" href={devLink}>Open reset link (local test only)</a>}
        <button className="btn primary block" onClick={toLogin}>Back to log in</button>
      </div>
    );
  }
  return (
    <form className="stack" onSubmit={submit} noValidate>
      <div>
        <h2 style={{ fontSize: '1.5rem' }}>Forgot your password?</h2>
        <p className="muted" style={{ marginTop: 6 }}>We'll email a link to choose a new one. You'll also need your authenticator app or a recovery code.</p>
      </div>
      {errors.form && <div className="formerror">{errors.form}</div>}
      <Field label="Company code" htmlFor="fcc" error={errors.companyCode}>
        <input id="fcc" className="upper" type="text" maxLength={12} value={f.companyCode} onChange={(e) => setF({ ...f, companyCode: e.target.value.replace(/[^A-Za-z0-9]/g, '') })} />
      </Field>
      <Field label="Email" htmlFor="femail" error={errors.email}>
        <input id="femail" type="email" autoComplete="username" inputMode="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
      </Field>
      <button className="btn primary block" disabled={busy}>{busy ? 'Sending…' : 'Send reset link'}</button>
      <button type="button" className="btn ghost block" onClick={toLogin}>Back to log in</button>
    </form>
  );
}

function Reset({ token, onDone, toForgot }) {
  const [state, setState] = useState(token ? 'checking' : 'invalid');
  const [account, setAccount] = useState(null);
  const [f, setF] = useState({ password: '', confirm: '' });
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  useEffect(() => {
    if (!token) return;
    post('/api/auth/reset/check', { token }).then((r) => { setAccount(r); setState('form'); })
      .catch((e) => { setProblem(e.message); setState('invalid'); });
  }, [token]);
  async function submit(e) {
    e.preventDefault();
    const pw = passwordScore(f.password, '');
    const errs = {};
    if (pw.score < 3) errs.password = pw.msg || 'Choose a password';
    if (f.confirm !== f.password) errs.confirm = 'Passwords do not match';
    if (!useRecovery && !/^\d{6}$/.test(code)) errs.code = 'Enter the 6-digit code from your authenticator app';
    if (useRecovery && !/^[A-Z0-9]{8}$/.test(code)) errs.code = 'Recovery codes have 8 letters and numbers';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      await post('/api/auth/reset', { token, ...f, ...(useRecovery ? { recoveryCode: code } : { code }) });
      onDone();
    } catch (err) {
      if (err.status === 400) { setProblem(err.message); setState('invalid'); return; }
      setErrors(Object.keys(err.fields || {}).length ? err.fields : { form: err.message });
      if (err.fields?.code) setCode('');
    } finally {
      setBusy(false);
    }
  }
  if (state === 'checking') return <p className="muted">Checking your reset link…</p>;
  if (state === 'invalid') {
    return (
      <div className="stack">
        <h2 style={{ fontSize: '1.5rem' }}>Link not valid</h2>
        <div className="warnbox">{problem || 'This reset link is missing or incomplete. Open the link from your email again, or ask for a new one.'}</div>
        <button className="btn primary block" onClick={toForgot}>Send a new link</button>
      </div>
    );
  }
  return (
    <form className="stack" onSubmit={submit} noValidate>
      <div>
        <h2 style={{ fontSize: '1.5rem' }}>Choose a new password</h2>
        <p className="muted" style={{ marginTop: 6 }}>For {account?.email} at <b>{account?.company?.name}</b>. You'll be signed out on all devices.</p>
      </div>
      {errors.form && <div className="formerror" role="alert">{errors.form}</div>}
      <PasswordPair f={f} setF={setF} errors={errors} email="" />
      <CodeField value={code} onChange={setCode} error={errors.code} useRecovery={useRecovery} id="rcode" autoFocus={false} />
      <button className="btn primary block" disabled={busy}>{busy ? 'Saving…' : 'Save new password'}</button>
      <button type="button" className="btn ghost block" onClick={() => { setUseRecovery(!useRecovery); setCode(''); setErrors({}); }}>
        {useRecovery ? 'Use authenticator code instead' : 'Lost your phone? Use a recovery code'}
      </button>
    </form>
  );
}
