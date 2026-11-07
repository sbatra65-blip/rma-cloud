import { Children, cloneElement, createContext, isValidElement, useContext, useEffect, useId, useRef, useState } from 'react';
import { post as apiPost } from './api.js';

// ---------- Version (filled in at build time from package.json) ----------
export function VersionLabel() {
  const date = new Date(__BUILD_DATE__ + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  return (
    <div className="version">
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
export const can = {
  edit: (u) => ['Admin', 'Manager', 'Technician'].includes(u?.role),
  manage: (u) => ['Admin', 'Manager'].includes(u?.role),
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
  // Infinite Solutions infinity mark (brand gradient) on a white tile. Same mark as the app icon and favicon.
  const id = useId().replace(/:/g, '');
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden="true" className="brandmark-svg">
      <defs>
        <linearGradient id={`la${id}`} x1="0" y1="0" x2="1" y2="0.3"><stop offset="0" stopColor="#5b6fd0" /><stop offset="0.55" stopColor="#7a4fb0" /><stop offset="1" stopColor="#cc4f8f" /></linearGradient>
        <linearGradient id={`lb${id}`} x1="0" y1="0.2" x2="1" y2="0"><stop offset="0" stopColor="#e0558e" /><stop offset="0.45" stopColor="#18a9d6" /><stop offset="1" stopColor="#b9d65a" /></linearGradient>
      </defs>
      <rect width="512" height="512" rx="120" fill="#fff" stroke="#e7e5f0" strokeWidth="8" />
      <g transform="translate(256 256) scale(0.92) translate(-256 -256)">
        <path className="logo-arc" pathLength="60" d="M256.0 256.0 L253.2 252.5 L250.4 249.0 L247.5 245.5 L244.7 242.0 L241.8 238.5 L239.0 235.0 L236.1 231.5 L233.2 228.1 L230.2 224.6 L227.2 221.2 L224.2 217.9 L221.1 214.5 L218.0 211.2 L214.8 208.0 L211.6 204.7 L208.3 201.6 L205.0 198.5 L201.6 195.4 L198.1 192.4 L194.6 189.5 L191.0 186.7 L187.3 183.9 L183.5 181.3 L179.6 178.8 L175.7 176.3 L171.6 174.1 L167.5 171.9 L163.3 169.9 L159.0 168.1 L154.6 166.4 L150.2 165.0 L145.6 163.7 L141.0 162.7 L136.3 161.8 L131.5 161.3 L126.7 161.0 L121.9 161.0 L116.9 161.3 L112.0 161.9 L107.0 162.9 L102.1 164.2 L97.2 165.9 L92.3 167.9 L87.5 170.3 L82.7 173.1 L78.1 176.3 L73.7 179.9 L69.3 183.9 L65.2 188.3 L61.4 193.0 L57.7 198.1 L54.4 203.6 L51.4 209.4 L48.7 215.5 L46.4 221.8 L44.5 228.4 L43.0 235.1 L41.9 242.0 L41.2 249.0 L41.0 256.0 L41.2 263.0 L41.9 270.0 L43.0 276.9 L44.5 283.6 L46.4 290.2 L48.7 296.5 L51.4 302.6 L54.4 308.4 L57.7 313.9 L61.4 319.0 L65.2 323.7 L69.3 328.1 L73.7 332.1 L78.1 335.7 L82.7 338.9 L87.5 341.7 L92.3 344.1 L97.2 346.1 L102.1 347.8 L107.0 349.1 L112.0 350.1 L116.9 350.7 L121.9 351.0 L126.7 351.0 L131.5 350.7 L136.3 350.2 L141.0 349.3 L145.6 348.3 L150.2 347.0 L154.6 345.6 L159.0 343.9 L163.3 342.1 L167.5 340.1 L171.6 337.9 L175.7 335.7 L179.6 333.2 L183.5 330.7 L187.3 328.1 L191.0 325.3 L194.6 322.5 L198.1 319.6 L201.6 316.6 L205.0 313.5 L208.3 310.4 L211.6 307.3 L214.8 304.0 L218.0 300.8 L221.1 297.5 L224.2 294.1 L227.2 290.8 L230.2 287.4 L233.2 283.9 L236.1 280.5 L239.0 277.0 L241.8 273.5 L244.7 270.0 L247.5 266.5 L250.4 263.0 L253.2 259.5 L256.0 256.0" fill="none" stroke={`url(#la${id})`} strokeWidth="70" strokeLinecap="round" strokeLinejoin="round" />
        <path className="logo-arc" pathLength="60" d="M256.0 256.0 L258.8 252.5 L261.6 249.0 L264.5 245.5 L267.3 242.0 L270.2 238.5 L273.0 235.0 L275.9 231.5 L278.8 228.1 L281.8 224.6 L284.8 221.2 L287.8 217.9 L290.9 214.5 L294.0 211.2 L297.2 208.0 L300.4 204.7 L303.7 201.6 L307.0 198.5 L310.4 195.4 L313.9 192.4 L317.4 189.5 L321.0 186.7 L324.7 183.9 L328.5 181.3 L332.4 178.8 L336.3 176.3 L340.4 174.1 L344.5 171.9 L348.7 169.9 L353.0 168.1 L357.4 166.4 L361.8 165.0 L366.4 163.7 L371.0 162.7 L375.7 161.8 L380.5 161.3 L385.3 161.0 L390.1 161.0 L395.1 161.3 L400.0 161.9 L405.0 162.9 L409.9 164.2 L414.8 165.9 L419.7 167.9 L424.5 170.3 L429.3 173.1 L433.9 176.3 L438.3 179.9 L442.7 183.9 L446.8 188.3 L450.6 193.0 L454.3 198.1 L457.6 203.6 L460.6 209.4 L463.3 215.5 L465.6 221.8 L467.5 228.4 L469.0 235.1 L470.1 242.0 L470.8 249.0 L471.0 256.0 L470.8 263.0 L470.1 270.0 L469.0 276.9 L467.5 283.6 L465.6 290.2 L463.3 296.5 L460.6 302.6 L457.6 308.4 L454.3 313.9 L450.6 319.0 L446.8 323.7 L442.7 328.1 L438.3 332.1 L433.9 335.7 L429.3 338.9 L424.5 341.7 L419.7 344.1 L414.8 346.1 L409.9 347.8 L405.0 349.1 L400.0 350.1 L395.1 350.7 L390.1 351.0 L385.3 351.0 L380.5 350.7 L375.7 350.2 L371.0 349.3 L366.4 348.3 L361.8 347.0 L357.4 345.6 L353.0 343.9 L348.7 342.1 L344.5 340.1 L340.4 337.9 L336.3 335.7 L332.4 333.2 L328.5 330.7 L324.7 328.1 L321.0 325.3 L317.4 322.5 L313.9 319.6 L310.4 316.6 L307.0 313.5 L303.7 310.4 L300.4 307.3 L297.2 304.0 L294.0 300.8 L290.9 297.5 L287.8 294.1 L284.8 290.8 L281.8 287.4 L278.8 283.9 L275.9 280.5 L273.0 277.0 L270.2 273.5 L267.3 270.0 L264.5 266.5 L261.6 263.0 L258.8 259.5 L256.0 256.0" fill="none" stroke={`url(#lb${id})`} strokeWidth="70" strokeLinecap="round" strokeLinejoin="round" style={{ animationDelay: '0.45s' }} />
      </g>
    </svg>
  );
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
