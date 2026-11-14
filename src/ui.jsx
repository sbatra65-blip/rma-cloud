import { Children, cloneElement, createContext, Fragment, isValidElement, useContext, useEffect, useId, useRef, useState } from 'react';
import { post as apiPost } from './api.js';

// ---------- Version (filled in at build time from package.json) ----------
export function VersionLabel() {
  const date = new Date(__BUILD_DATE__ + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  return (
    <div className="version">
      <span className="brandlogo"><Mark size={44} still /></span>
      <p>Designed and Developed by{' '}
        <a href="https://www.infinitesolutions.co.in" target="_blank" rel="noopener noreferrer">Infinite Solutions</a></p>
      <p>Version {__APP_VERSION__} · built {date}{__BUILD_COMMIT__ ? ` · ${__BUILD_COMMIT__}` : ''}</p>
    </div>
  );
}

// ---------- Tiny router ----------
export function navigate(to, { replace = false } = {}) {
  if (replace) history.replaceState({}, '', to);
  else history.pushState({}, '', to);
  window.dispatchEvent(new Event('rma-nav'));
  window.scrollTo(0, 0);
}
export function usePath() {
  const [path, setPath] = useState(location.pathname + location.search);
  useEffect(() => {
    const on = () => setPath(location.pathname + location.search);
    window.addEventListener('popstate', on);
    window.addEventListener('rma-nav', on);
    return () => {
      window.removeEventListener('popstate', on);
      window.removeEventListener('rma-nav', on);
    };
  }, []);
  return path;
}
export function Link({ to, children, ...rest }) {
  return (
    <a href={to} onClick={(e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      navigate(to);
    }} {...rest}>
      {children}
    </a>
  );
}
export const query = () => Object.fromEntries(new URLSearchParams(location.search));

// ---------- Formatting ----------
const IN = 'en-IN';
export const fmtDate = (iso) => (iso ? new Date(iso + 'T00:00:00').toLocaleDateString(IN, { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
export const fmtMs = (ms, time = false) => (ms ? new Date(ms).toLocaleString(IN, time
  ? { day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }
  : { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
export const ago = (ms) => {
  if (!ms) return '—';
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d < 60 ? `${d} day${d === 1 ? '' : 's'} ago` : fmtMs(ms);
};
export const todayISO = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
export const ageDays = (ms) => Math.max(0, Math.floor((Date.now() - ms) / 86400000));

// ---------- Workflow ----------
export const FLOW = ['OPEN', 'AWAITING_OEM_RMA', 'OEM_RMA_RECEIVED', 'DISPATCHED_TO_OEM', 'GOODS_RECEIVED_FROM_OEM', 'DISPATCHED_TO_CUSTOMER', 'CLOSED'];
export const SHORT = {
  OPEN: 'Open', AWAITING_OEM_RMA: 'Awaiting OEM', OEM_RMA_RECEIVED: 'OEM RMA #', DISPATCHED_TO_OEM: 'At OEM',
  GOODS_RECEIVED_FROM_OEM: 'Back from OEM', DISPATCHED_TO_CUSTOMER: 'To customer', CLOSED: 'Closed', CLOSED_RETURNED: 'Returned',
};
export function Status({ s, label }) {
  return <span className="st" data-s={s}>{label || SHORT[s] || s}</span>;
}
export function Stepper({ status }) {
  const idx = status === 'CLOSED_RETURNED' ? FLOW.length - 1 : FLOW.indexOf(status);
  return (
    <div data-s={status}>
      <div className="stepper" aria-hidden="true">
        {FLOW.map((s, i) => <i key={s} className={`${i <= idx ? 'done' : ''} ${i === idx && i < FLOW.length - 1 ? 'now' : ''}`} />)}
      </div>
      <div className="steplabels" aria-label={`Step ${idx + 1} of ${FLOW.length}`}>
        <span>Raised</span><span>OEM RMA</span><span>At OEM</span><span>Back</span><span>{status === 'CLOSED_RETURNED' ? 'Returned' : 'Closed'}</span>
      </div>
    </div>
  );
}

// ---------- Permissions (mirror of the server rules) ----------
// Read-only (access date passed, 7-day grace): nobody can add or change anything; viewing and exports still work.
const readOnly = (u) => u?.company?.billing?.access === 'readonly';
export const can = {
  edit: (u) => ['Admin', 'Manager', 'Technician'].includes(u?.role) && !readOnly(u),
  manage: (u) => ['Admin', 'Manager'].includes(u?.role) && !readOnly(u),
  admin: (u) => u?.role === 'Admin',
};

// ---------- Icons ----------
const paths = {
  home: 'M3 11l9-8 9 8M5 10v10h14V10',
  ticket: 'M4 7a2 2 0 012-2h12a2 2 0 012 2v2a2 2 0 000 4v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2a2 2 0 000-4zM13 5v2M13 11v2M13 17v2',
  plus: 'M12 5v14M5 12h14',
  truck: 'M1 3h15v13H1zM16 8h4l3 3v5h-7M5.5 21a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM18.5 21a2.5 2.5 0 100-5 2.5 2.5 0 000 5z',
  bell: 'M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0',
  chart: 'M3 3v18h18M7 15l4-4 3 3 5-6',
  upload: 'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12',
  download: 'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  users: 'M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75',
  building: 'M3 21h18M5 21V5a2 2 0 012-2h10a2 2 0 012 2v16M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2',
  gear: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1.08-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1.08 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z',
  user: 'M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z',
  search: 'M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.35-4.35',
  back: 'M15 18l-6-6 6-6',
  mail: 'M4 4h16a2 2 0 012 2v12a2 2 0 01-2 2H4a2 2 0 01-2-2V6a2 2 0 012-2zM22 6l-10 7L2 6',
  link: 'M10 13a5 5 0 007.5.5l3-3a5 5 0 00-7-7l-1.7 1.7M14 11a5 5 0 00-7.5-.5l-3 3a5 5 0 007 7l1.7-1.7',
  file: 'M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6',
  camera: 'M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2zM12 17a4 4 0 100-8 4 4 0 000 8z',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 113 3L7 19l-4 1 1-4z',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6',
  x: 'M18 6L6 18M6 6l12 12',
  check: 'M20 6L9 17l-5-5',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 018 0v4',
  logout: 'M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9',
  more: 'M4 6h16M4 12h16M4 18h16',
  copy: 'M9 9h11v11H9zM5 15H4a1 1 0 01-1-1V4a1 1 0 011-1h10a1 1 0 011 1v1',
  share: 'M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8M16 6l-4-4-4 4M12 2v13',
  alert: 'M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0zM12 9v4M12 17h.01',
  printer: 'M6 9V2h12v7M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2M6 14h12v8H6z',
  box: 'M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8M12 13v8',
  history: 'M3 12a9 9 0 109-9 9.75 9.75 0 00-6.74 2.74L3 8M3 3v5h5M12 7v5l4 2',
};
export function Icon({ name, size = 22, ...rest }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      <path d={paths[name]} />
    </svg>
  );
}
export function Logo({ size = 30 }) {
  // TrackMyRMA mark: the same artwork as the app icon and favicon.
  return <img className="brandmark-img" src="/icons/favicon.svg" width={size} height={size} alt="" />;
}

// TrackMyRMA mark: a circular track from the start dot, ending in an arrowhead that returns to it.
// Animates once when it appears (dot pops, track draws, arrowhead snaps on, ring pulses); CSS turns
// the animation off for people who ask for reduced motion. `loop` repeats it (loading screens).
export function Mark({ size = 48, still = false, loop = false, className = '' }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg className={`tmr-mark ${still ? '' : 'anim'} ${loop ? 'loop' : ''} ${className}`} viewBox="0 0 512 512" width={size} height={size} role="img" aria-label="TrackMyRMA">
      <defs>
        <linearGradient id={`${id}b`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#3a3aa6" /><stop offset="1" stopColor="#1e1b4b" /></linearGradient>
        <linearGradient id={`${id}s`} x1="0" y1="1" x2="1" y2="0.2"><stop offset="0" stopColor="#19aec6" /><stop offset=".55" stopColor="#8f7ee0" /><stop offset="1" stopColor="#e05bb5" /></linearGradient>
      </defs>
      <rect width="512" height="512" rx="116" fill={`url(#${id}b)`} />
      <g transform="translate(-25 -18)">
        <path className="tmr-track" d="M212.2 382.3 A128 128 0 1 1 384.0 262.0" pathLength="100" fill="none" stroke={`url(#${id}s)`} strokeWidth="56" strokeLinecap="round" />
        <path className="tmr-head" d="M432.2 256.5 L384.0 310.0 L335.8 256.5" fill="none" stroke="#e05bb5" strokeWidth="56" strokeLinecap="round" strokeLinejoin="round" />
        <circle className="tmr-ring" cx="212.2" cy="382.3" r="40" fill="none" stroke="#19aec6" strokeWidth="6" />
        <g className="tmr-dot"><circle cx="212.2" cy="382.3" r="40" fill="#fff" /><circle cx="212.2" cy="382.3" r="17" fill="#19aec6" /></g>
      </g>
    </svg>
  );
}
export function BrandLogo({ height = 48, className = '', loop = false }) {
  return <Mark size={height} loop={loop} className={`brandlogo-top ${className}`} />;
}
export function Wordmark() {
  return <span className="wordmark">trackmy<b>RMA</b></span>;
}

// ---------- Form field ----------
export function Field({ label, required, hint, error, children, className = '', htmlFor }) {
  // Link the label to the first control so tapping the label focuses it and screen readers read it.
  const auto = useId();
  let id = htmlFor;
  let linked = false;
  const kids = Children.map(children, (c) => {
    if (linked || !isValidElement(c) || c.type === 'div') return c;
    linked = true;
    id = c.props.id || htmlFor || auto;
    return c.props.id ? c : cloneElement(c, { id });
  });
  return (
    <div className={`field ${error ? 'invalid' : ''} ${className}`}>
      {label && <label htmlFor={id}>{label}{required && <span className="req" aria-hidden="true">*</span>}</label>}
      {kids}
      {error ? <span className="error" role="alert">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

// ---------- Dialog ----------
export function Dialog({ open, onClose, title, children, wide }) {
  const ref = useRef(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} onCancel={(e) => { e.preventDefault(); onClose?.(); }} style={wide ? { width: 'min(760px, 100vw)' } : undefined}>
      {open && (
        <div className="dlg">
          <div className="head">
            <h2>{title}</h2>
            {onClose && <button className="iconbtn" onClick={onClose} aria-label="Close"><Icon name="x" /></button>}
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}

// ---------- Toasts ----------
const ToastCtx = createContext(() => {});
export function ToastProvider({ children }) {
  const [toast, setToast] = useState(null);
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), toast.error ? 6000 : 3200);
    return () => clearTimeout(t);
  }, [toast]);
  return (
    <ToastCtx.Provider value={(msg, error = false) => setToast({ msg, error, at: Date.now() })}>
      {children}
      {toast && (
        <div key={toast.at} className={`toast ${toast.error ? 'error' : ''}`} role="status">
          {!toast.error && <Icon name="check" size={18} />}
          {toast.msg}
        </div>
      )}
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

export function Empty({ icon = 'ticket', title, children, action }) {
  return (
    <div className="empty panel">
      <Icon name={icon} size={40} />
      <h2>{title}</h2>
      {children && <p className="muted">{children}</p>}
      {action}
    </div>
  );
}
export function Skeleton({ rows = 4 }) {
  return <div aria-busy="true" aria-label="Loading">{Array.from({ length: rows }, (_, i) => <div key={i} className="skel" />)}</div>;
}

// Loads data on mount and when deps change; returns [data, reload, error].
export function useLoad(fn, deps = []) {
  const [state, setState] = useState({ data: null, error: null });
  const n = useRef(0);
  const load = async () => {
    const my = ++n.current;
    try {
      const data = await fn();
      if (my === n.current) setState({ data, error: null });
    } catch (e) {
      if (my === n.current) setState((s) => ({ data: s.data, error: e }));
    }
  };
  useEffect(() => { load(); }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return [state.data, load, state.error];
}

export function ErrorPanel({ error, retry }) {
  return (
    <div className="panel stack">
      <div className="formerror">{error?.message || 'Could not load this page.'}</div>
      {retry && <button className="btn ghost" onClick={retry}>Try again</button>}
    </div>
  );
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// Password strength shown while typing (the server applies the same rules).
export function passwordScore(pw, email) {
  if (!pw) return { score: 0, msg: '' };
  if (pw.length < 10) return { score: 1, msg: 'At least 10 characters' };
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  if (kinds < 3) return { score: 2, msg: 'Mix three of: lowercase, uppercase, numbers, symbols' };
  if (email && pw.toLowerCase().includes(email.split('@')[0].toLowerCase())) return { score: 2, msg: 'Do not use your email name' };
  return { score: pw.length >= 14 ? 4 : 3, msg: pw.length >= 14 ? 'Strong password' : 'Good password' };
}
export function Strength({ score }) {
  return (
    <div className="strength" aria-hidden="true">
      <i style={{ width: `${score * 25}%`, background: score >= 3 ? 'var(--ok)' : score === 2 ? 'var(--amber)' : 'var(--rust)' }} />
    </div>
  );
}

// "Active only" or "All": one choice for the whole app, remembered on this device.
// Completed = sent back to the customer or closed.
export const COMPLETED = ['DISPATCHED_TO_CUSTOMER', 'CLOSED', 'CLOSED_RETURNED'];
const SHOW_KEY = 'rma.show';
function readShow() {
  try { return localStorage.getItem(SHOW_KEY) === 'all' ? 'all' : 'active'; } catch { return 'active'; }
}
let showNow = readShow();
export function useShow() {
  const [v, setV] = useState(showNow);
  useEffect(() => {
    const on = () => setV(showNow);
    window.addEventListener('rma-show', on);
    return () => window.removeEventListener('rma-show', on);
  }, []);
  const set = (x) => {
    showNow = x === 'all' ? 'all' : 'active';
    try { localStorage.setItem(SHOW_KEY, showNow); } catch { /* private mode */ }
    window.dispatchEvent(new Event('rma-show'));
  };
  return [v, set];
}
export function ShowToggle({ className = '' }) {
  const [v, set] = useShow();
  return (
    <div className={`seg ${className}`} role="radiogroup" aria-label="Which RMAs to show">
      <button type="button" role="radio" aria-checked={v === 'active'} onClick={() => set('active')}>Active only</button>
      <button type="button" role="radio" aria-checked={v === 'all'} onClick={() => set('all')}>All</button>
    </div>
  );
}

// Same rule as the server (worker/devices.js): "Head", "Print head", "TPH"… but not "Head cable".
export function isHeadPart(part) {
  const p = String(part || '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!p) return false;
  if (/\b(cable|sensor|bracket|spring|cover|lever|connector|cleaner|pen)\b/.test(p)) return false;
  if (/\btph\b/.test(p)) return true;
  const core = p.replace(/\b(assy|assembly|unit|kit|module|replacement|new|set|dpi|mm|inch|for|the|of|and)\b/g, ' ').replace(/\s+/g, ' ').trim();
  return /^(thermal )?(print ?)?head$/.test(core);
}
export const RECEIVED_STAGES = ['GOODS_RECEIVED_FROM_OEM', 'DISPATCHED_TO_CUSTOMER', 'CLOSED', 'CLOSED_RETURNED'];

// Serial of the part received back from the OEM: shows it, and lets editors add or correct it.
export function ReceivedPartSn({ ticket, canEdit, onSaved, compact = false }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(ticket.received_part_sn || '');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const back = RECEIVED_STAGES.includes(ticket.status);
  if (!back) return compact ? null : <span className="muted">Not back from the OEM yet</span>;
  async function save(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await apiPost(`/api/rma/${ticket.id}/received-part`, { received_part_sn: v });
      setEditing(false); setErr(null);
      onSaved?.(r.ticket);
    } catch (x) { setErr(x.fields?.received_part_sn || x.message); } finally { setBusy(false); }
  }
  if (!editing && ticket.received_part_sn) {
    return (
      <span className="rsn"><span className="mono">{ticket.received_part_sn}</span>
        {canEdit && <button type="button" className="linkbtn small" onClick={() => setEditing(true)}>Change</button>}</span>
    );
  }
  if (!canEdit) return <span className="pill warn">Serial not recorded</span>;
  return (
    <form className="rsn-form" onSubmit={save}>
      <input type="text" className="upper" value={v} onChange={(e) => setV(e.target.value)} placeholder={isHeadPart(ticket.faulty_part) ? 'New head serial' : 'Received part serial'}
        aria-label={`Received part serial for ${ticket.ticket_no}`} autoFocus={editing} />
      <button className="btn primary small" disabled={busy || !v.trim()}>{busy ? 'Saving…' : 'Save'}</button>
      {editing && <button type="button" className="btn ghost small" onClick={() => { setEditing(false); setV(ticket.received_part_sn || ''); setErr(null); }}>Cancel</button>}
      {err && <span className="small" style={{ color: 'var(--rust)', flexBasis: '100%' }}>{err}</span>}
    </form>
  );
}

// Counts up from 0 (or the previous value) to n. Instant when the user prefers less motion.
export function CountUp({ n, ms = 700 }) {
  const target = Number(n) || 0;
  const [v, setV] = useState(target);
  const from = useRef(0);
  useEffect(() => {
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || !target) { setV(target); from.current = target; return undefined; }
    const start = performance.now(); const a = from.current;
    let raf = 0;
    const step = (t) => {
      const k = Math.min(1, (t - start) / ms);
      const e = 1 - Math.pow(1 - k, 3);
      setV(Math.round(a + (target - a) * e));
      if (k < 1) raf = requestAnimationFrame(step); else from.current = target;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return <data className="countup" value={target}>{v}</data>;
}

// ---------- Appearance (per device): light by default ----------
const THEME_KEY = 'rma.theme';
export function getTheme() {
  try { const t = localStorage.getItem(THEME_KEY); return t === 'dark' || t === 'system' ? t : 'light'; } catch { return 'light'; }
}
export function applyTheme(t = getTheme()) {
  document.documentElement.dataset.theme = t;
  const dark = t === 'dark' || (t === 'system' && typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0e0d24' : '#ffffff');
}
export function ThemePicker() {
  const [t, setT] = useState(getTheme);
  const pick = (v) => { setT(v); try { localStorage.setItem(THEME_KEY, v); } catch { /* private mode */ } applyTheme(v); };
  return (
    <section className="panel">
      <h2>Appearance</h2>
      <p className="muted small" style={{ margin: '4px 0 12px' }}>Saved on this phone or computer.</p>
      <div className="seg" role="radiogroup" aria-label="Theme">
        {[['light', 'Light'], ['dark', 'Dark'], ['system', 'Match this device']].map(([v, l]) => (
          <button key={v} type="button" role="radio" aria-checked={t === v} onClick={() => pick(v)}>{l}</button>))}
      </div>
    </section>
  );
}

// The company's own logo (uploaded in Company settings), or nothing.
export function CompanyLogo({ boot, height = 40, className = '' }) {
  const at = boot?.settings?.logoAt;
  if (!at) return null;
  return <img className={`companylogo ${className}`} src={`/api/company/logo?v=${at}`} alt="" style={{ height, width: 'auto', maxWidth: height * 3.2 }} />;
}

// Shrinks an image file to fit max x max and returns a PNG/JPEG blob (keeps transparency as PNG).
export async function shrinkImage(file, max = 512) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('That file is not an image we can read')); i.src = url; });
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * k)); c.height = Math.max(1, Math.round(img.naturalHeight * k));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const type = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    return await new Promise((res) => c.toBlob(res, type, 0.9));
  } finally { URL.revokeObjectURL(url); }
}

// ---------- Plan: trial banner, how to buy ----------
const dmyUi = (iso) => (iso ? iso.split('-').reverse().join('-') : '');
export function PaymentBox({ p, compact = false }) {
  if (!p || !Object.keys(p).length) return <p className="small muted">Please contact your service provider to buy a plan.</p>;
  const rows = [['Account name', p.payeeName], ['Bank', p.bankName], ['Account no.', p.accountNo], ['IFSC', p.ifsc], ['UPI', p.upiId]].filter(([, v]) => v);
  return (
    <div className="stack" style={{ gap: 10 }}>
      {rows.length > 0 && <dl className="paybox">{rows.map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd className={k === 'Account no.' || k === 'IFSC' ? 'mono' : ''}>{v}</dd></Fragment>)}</dl>}
      {p.payLink && <a className="btn primary" href={p.payLink} target="_blank" rel="noopener noreferrer"><Icon name="share" size={18} /> Pay online</a>}
      {!compact && p.priceNote && <p className="small" style={{ whiteSpace: 'pre-line' }}>{p.priceNote}</p>}
      {(p.contactPhone || p.contactEmail) && <p className="small muted">Questions: {[p.contactPhone, p.contactEmail].filter(Boolean).join(' · ')}</p>}
    </div>
  );
}
export function TrialBar({ user, boot }) {
  const [open, setOpen] = useState(false);
  const b = user?.company?.billing;
  if (!b) return null;
  const trial = b.plan === 'trial';
  const ro = b.access === 'readonly';
  const soon = !trial && b.access === 'open' && b.daysLeft !== null && b.daysLeft <= 15;
  if (!trial && !ro && !soon) return null;
  const used = boot?.settings?.trialRmasUsed ?? null;
  const left = Math.max(0, b.daysLeft ?? 0);
  return (
    <>
      <div className={`trialbar ${ro ? 'ro' : trial && left <= 7 ? 'warn' : ''}`} role="status">
        {ro ? (
          <span><b>{trial ? 'Free trial ended' : 'Access ended'} on {dmyUi(b.validUntil)}.</b> Read-only until {dmyUi(b.readOnlyUntil)}: you can view, print and export, but not add or change anything.{trial && b.keepDataUntil ? ` Data kept until ${dmyUi(b.keepDataUntil)}.` : ''}</span>
        ) : trial ? (
          <>
            <span><b>Free trial</b> · {left === 0 ? 'ends today' : `${left} day${left === 1 ? '' : 's'} left`} (until {dmyUi(b.validUntil)})</span>
            {used !== null && <span className="small" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>{used} of {b.trialRmas} new RMAs
              <span className="meter" aria-hidden="true"><i style={{ width: `${Math.min(100, (used / b.trialRmas) * 100)}%` }} /></span></span>}
          </>
        ) : (
          <span><b>Access ends in {b.daysLeft} day{b.daysLeft === 1 ? '' : 's'}</b> ({dmyUi(b.validUntil)}). Renew to continue without a break.</span>
        )}
        <button type="button" className="btn primary small" style={{ marginLeft: 'auto' }} onClick={() => setOpen(true)}>{trial ? 'How to buy' : 'How to renew'}</button>
      </div>
      {open && (
        <Dialog open onClose={() => setOpen(false)} title={trial ? 'Buy TrackMyRMA' : 'Renew TrackMyRMA'}>
          <div className="stack">
            <p>{trial ? 'Everything you have entered during the trial stays as it is when you buy.' : 'Your data and settings carry on as they are.'} After payment, your service provider switches the plan on, usually the same day.</p>
            <PaymentBox p={b.payment} />
            {trial && !b.extended && <div className="notice small">Need more time? Pay a {b.trial.advancePct}% advance and the trial is extended by {b.trial.extendDays} days. The advance is adjusted against your purchase.</div>}
            <div className="row end"><button className="btn ghost" onClick={() => setOpen(false)}>Close</button></div>
          </div>
        </Dialog>
      )}
    </>
  );
}
