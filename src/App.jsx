import { useCallback, useEffect, useRef, useState } from 'react';
import { get, post, setSessionEndedHandler } from './api.js';
import { broadcastLogout, useIdle } from './idle.js';
import { Dialog, Icon, Link, BrandLogo, Logo, Skeleton, ToastProvider, VersionLabel, can, navigate, usePath, useToast } from './ui.jsx';
import Auth from './pages/Auth.jsx';
import Dashboard from './pages/Dashboard.jsx';
import RmaList from './pages/RmaList.jsx';
import RmaForm from './pages/RmaForm.jsx';
import RmaDetail from './pages/RmaDetail.jsx';
import Batches from './pages/Batches.jsx';
import Reminders from './pages/Reminders.jsx';
import Reports from './pages/Reports.jsx';
import Import from './pages/Import.jsx';
import Masters from './pages/Masters.jsx';
import Settings from './pages/Settings.jsx';
import Users from './pages/Users.jsx';
import Profile from './pages/Profile.jsx';
import CarePacks, { CarePackPending, OverrideLog } from './pages/CarePacks.jsx';
import CarePackRegister from './pages/CarePackRegister.jsx';
import CarePackDetail from './pages/CarePackDetail.jsx';
import CarePackPo from './pages/CarePackPo.jsx';
import DeviceHistory from './pages/DeviceHistory.jsx';

export default function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}

const AUTH_PATHS = ['/login', '/setup', '/invite', '/forgot-password', '/reset-password'];

function Shell() {
  const toast = useToast();
  const path = usePath();
  const [state, setState] = useState({ phase: 'loading' }); // loading | out | in
  const [boot, setBoot] = useState(null);
  const [reminderCount, setReminderCount] = useState(0);
  const phaseRef = useRef('loading');
  phaseRef.current = state.phase;

  const loadBoot = useCallback(async () => {
    const b = await get('/api/bootstrap');
    setBoot(b);
    return b;
  }, []);
  const refreshReminders = useCallback(() => {
    get('/api/reminders').then((r) => setReminderCount(r.items.length + (r.carePack?.length || 0))).catch(() => {});
  }, []);

  const signOut = useCallback(async (reason) => {
    if (reason !== 'expired') await post('/api/auth/logout').catch(() => {});
    if (reason !== 'logout-remote') broadcastLogout();
    setBoot(null);
    setState({
      phase: 'out',
      reason: reason === 'idle' ? 'You were signed out after a few minutes without activity.'
        : reason === 'expired' ? 'Your session ended. Please log in again.'
        : reason === 'logout-remote' ? 'You logged out in another tab.' : null,
    });
    navigate('/login', { replace: true });
  }, []);

  useEffect(() => {
    setSessionEndedHandler(() => { if (phaseRef.current === 'in') signOut('expired'); });
    if (AUTH_PATHS.includes(location.pathname) && location.pathname !== '/login') {
      setState({ phase: 'out' });
      return;
    }
    get('/api/auth/me')
      .then(async (r) => {
        await loadBoot();
        setState({ phase: 'in', user: r.user, idleMinutes: r.idleMinutes });
        refreshReminders();
        if (AUTH_PATHS.includes(location.pathname)) navigate('/', { replace: true });
      })
      .catch(() => setState({ phase: 'out' }));
  }, [loadBoot, signOut, refreshReminders]);

  useEffect(() => { if (state.phase === 'in') refreshReminders(); }, [path, state.phase, refreshReminders]);

  const { secondsLeft, stay } = useIdle(state.phase === 'in', state.idleMinutes || 5, (why) => signOut(why === 'logout' ? 'logout-remote' : 'idle'));

  if (state.phase === 'loading') return <div className="loading" style={{ paddingTop: '30vh' }}><BrandLogo height={96} /></div>;
  if (state.phase === 'out') {
    return (
      <Auth reason={state.reason} onSignedIn={async (user, idleMinutes, note) => {
        await loadBoot();
        setState({ phase: 'in', user, idleMinutes });
        navigate('/', { replace: true });
        if (note) toast(note);
      }} />
    );
  }
  if (!boot) return <main><Skeleton rows={5} /></main>;

  const { user } = state;
  const route = path.split('?')[0];
  const common = { user, boot, reloadBoot: loadBoot, path, onChange: refreshReminders };
  const mods = user.company.modules || ['carepack', 'zoho', 'batches', 'import', 'reports'];
  const has = (m) => mods.includes(m);

  let page;
  let m;
  if (route === '/' || route === '') page = <Dashboard {...common} key={path} />;
  else if (route === '/rma') page = <RmaList {...common} />;
  else if (route === '/rma/new' && can.edit(user)) page = <RmaForm {...common} key="new" />;
  else if ((m = route.match(/^\/rma\/(\d+)\/edit$/)) && can.edit(user)) page = <RmaForm {...common} id={m[1]} key={`e${m[1]}`} />;
  else if ((m = route.match(/^\/rma\/(\d+)$/))) page = <RmaDetail {...common} id={m[1]} key={m[1]} />;
  else if ((route === '/batches' || route.startsWith('/batches/')) && has('batches')) page = <Batches {...common} code={route.split('/')[2]} key={route} />;
  else if (route === '/care-packs' && has('carepack')) page = <CarePacks {...common} />;
  else if (route === '/care-packs/new' && has('carepack') && can.manage(user)) page = <CarePackRegister {...common} />;
  else if (route === '/care-packs/pending' && has('carepack')) page = <CarePackPending {...common} />;
  else if (route === '/care-packs/overrides' && has('carepack') && can.admin(user)) page = <OverrideLog {...common} />;
  else if (has('carepack') && (m = route.match(/^\/care-packs\/(\d+)\/po$/)) && can.edit(user)) page = <CarePackPo {...common} id={m[1]} key={`po${m[1]}`} />;
  else if (has('carepack') && (m = route.match(/^\/care-packs\/(\d+)$/))) page = <CarePackDetail {...common} id={m[1]} key={`cp${m[1]}`} />;
  else if (route === '/reminders') page = <Reminders {...common} />;
  else if (route === '/reports' && has('reports')) page = <Reports {...common} />;
  else if (route === '/import' && can.manage(user) && has('import')) page = <Import {...common} />;
  else if (route === '/devices') page = <DeviceHistory {...common} key="devices" />;
  else if ((m = route.match(/^\/devices\/([^/]+)$/))) page = <DeviceHistory {...common} sn={decodeURIComponent(m[1])} key={`dev${m[1]}`} />;
  else if (route === '/masters') page = <Masters {...common} />;
  else if (route === '/settings' && can.admin(user)) page = <Settings {...common} onUserChange={(u) => setState((s) => ({ ...s, user: u }))} />;
  else if (route === '/users' && can.admin(user)) page = <Users {...common} />;
  else if (route === '/profile') page = <Profile {...common} idleMinutes={state.idleMinutes} onLogout={() => signOut('logout')} />;
  else if (route === '/more') page = <More user={user} onLogout={() => signOut('logout')} />;
  else page = <div className="panel"><h1>Page not found</h1><p className="muted" style={{ marginTop: 8 }}><Link to="/">Go to the dashboard</Link></p></div>;

  const nav = [
    { to: '/', icon: 'home', label: 'Dashboard' },
    { to: '/rma', icon: 'ticket', label: 'RMAs' },
    has('batches') && { to: '/batches', icon: 'truck', label: 'OEM batches' },
    has('carepack') && { to: '/care-packs', icon: 'shield', label: 'Care packs' },
    { to: '/reminders', icon: 'bell', label: 'Reminders', count: reminderCount },
    { to: '/devices', icon: 'history', label: 'Device history' },
    has('reports') && { to: '/reports', icon: 'chart', label: 'Reports' },
    { group: 'Data' },
    { to: '/masters', icon: 'list', label: 'Masters' },
    can.manage(user) && has('import') && { to: '/import', icon: 'upload', label: 'Import' },
    can.admin(user) && { group: 'Admin' },
    can.admin(user) && { to: '/users', icon: 'users', label: 'Users & security' },
    can.admin(user) && { to: '/settings', icon: 'gear', label: 'Company settings' },
  ].filter(Boolean);
  const current = (to) => (to === '/' ? route === '/' : route === to || (route.startsWith(to + '/') && route !== '/rma/new'));

  return (
    <div className="app">
      <aside className="sidenav" aria-label="Main">
        <Link to="/" className="brand"><BrandLogo height={56} />
          <span className="co"><span>RMA Cloud</span><small>{user.company.name}</small></span></Link>
        <form role="search" className="navsearch" onSubmit={(e) => { e.preventDefault(); const q = new FormData(e.currentTarget).get('q').trim(); if (q) navigate(`/rma?q=${encodeURIComponent(q)}`); }}>
          <Icon name="search" size={16} /><input name="q" type="search" placeholder="RMA, serial, customer" aria-label="Search RMAs" />
        </form>
        {can.edit(user) && <Link to="/rma/new" className="btn primary block addbtn"><Icon name="plus" size={18} /> New RMA</Link>}
        {nav.map((n, i) => n.group
          ? <div key={`g${i}`} className="group">{n.group}</div>
          : <Link key={n.to} to={n.to} className="navlink" aria-current={current(n.to) ? 'page' : undefined}>
            <Icon name={n.icon} size={19} /> {n.label}{n.count ? <span className="count">{n.count}</span> : null}
          </Link>)}
        <div className="foot">
          <Link to="/profile" className="navlink" aria-current={route === '/profile' ? 'page' : undefined}><Icon name="user" size={19} />
            <span style={{ display: 'grid', lineHeight: 1.2 }}><b>{user.name}</b><small style={{ opacity: 0.7 }}>{user.role} · {user.company.code}</small></span>
          </Link>
          <button type="button" className="navlink" onClick={() => signOut('logout')}><Icon name="logout" size={19} /> Log out</button>
          <VersionLabel />
        </div>
      </aside>
      <header className="topbar">
        <Link to="/" className="brand"><BrandLogo height={38} /><span className="co"><span>RMA Cloud</span><small>{user.company.name}</small></span></Link>
        <div className="row" style={{ flexWrap: 'nowrap', gap: 4 }}>
          <Link to="/profile" className="iconbtn" aria-label="My profile"><Icon name="user" /></Link>
          <button type="button" className="iconbtn" onClick={() => signOut('logout')} aria-label="Log out" title="Log out"><Icon name="logout" /></button>
        </div>
      </header>
      <main><div className="page" key={route}>{page}</div></main>
      <nav className="bottomnav" aria-label="Main">
        <Link to="/" aria-current={current('/') ? 'page' : undefined}><Icon name="home" /><span>Home</span></Link>
        <Link to="/rma" aria-current={route === '/rma' || /^\/rma\/\d/.test(route) ? 'page' : undefined}><Icon name="ticket" /><span>RMAs</span></Link>
        {can.edit(user)
          ? <Link to="/rma/new" className="add" aria-label="New RMA" aria-current={route === '/rma/new' ? 'page' : undefined}><Icon name="plus" size={28} /><span>New</span></Link>
          : <Link to="/devices" aria-current={route.startsWith('/devices') ? 'page' : undefined}><Icon name="history" /><span>Devices</span></Link>}
        <Link to="/reminders" aria-current={current('/reminders') ? 'page' : undefined}><Icon name="bell" /><span>Reminders</span>
          {reminderCount ? <i className="badge-dot">{reminderCount > 99 ? '99+' : reminderCount}</i> : null}</Link>
        <Link to="/more" aria-current={route === '/more' ? 'page' : undefined}><Icon name="more" /><span>More</span></Link>
      </nav>

      <Dialog open={secondsLeft !== null} onClose={stay} title="Still there?">
        <p>For your security you'll be signed out in <b className="num">{secondsLeft}</b> seconds because there has been no activity.</p>
        <div className="row end">
          <button className="btn ghost" onClick={() => signOut('logout')}>Log out now</button>
          <button className="btn primary" onClick={stay}>Stay signed in</button>
        </div>
      </Dialog>
    </div>
  );
}

function More({ user, onLogout }) {
  const has = (m) => (user.company.modules || ['carepack', 'zoho', 'batches', 'import', 'reports']).includes(m);
  const items = [
    has('batches') && ['/batches', 'truck', 'OEM batches', 'Dispatch RMAs to the OEM together, packing list'],
    has('carepack') && ['/care-packs', 'shield', 'Care packs', 'Printers sold with care packs, OEM PO, OEM invoice, payment'],
    has('reports') && ['/reports', 'chart', 'Reports', 'Filter RMAs and export to Excel'],
    ['/devices', 'history', 'Device history', 'Every RMA for one printer or terminal, with Excel / print'],
    ['/masters', 'list', 'Masters', 'Customers, device categories, OEMs, products, models, care pack types'],
    can.manage(user) && has('import') && ['/import', 'upload', 'Import', 'Bring in RMAs and customers from Excel'],
    can.admin(user) && ['/users', 'users', 'Users & security', 'Logins, roles, sessions, login history'],
    can.admin(user) && ['/settings', 'gear', 'Company settings', 'Company details, OEM email, Excel template, care packs, Zoho Books'],
    ['/profile', 'user', 'My profile', 'Password, recovery codes'],
  ].filter(Boolean);
  return (
    <>
      <div className="page-head"><div><h1>More</h1><p className="muted">{user.company.name} · {user.role}</p></div></div>
      <div className="tlist">
        {items.map(([to, icon, label, sub]) => (
          <Link key={to} to={to} className="tcard" style={{ '--c': 'var(--line)', gridTemplateColumns: 'auto 1fr', display: 'grid', alignItems: 'center', gap: 14 }}>
            <Icon name={icon} /><span><h3>{label}</h3><span className="meta">{sub}</span></span>
          </Link>
        ))}
        <button className="btn ghost block" onClick={onLogout}><Icon name="logout" size={18} /> Log out</button>
      </div>
      <VersionLabel />
    </>
  );
}
