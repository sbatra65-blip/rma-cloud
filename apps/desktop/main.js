// TrackMyRMA for Windows and Mac: a window that opens www.trackmyrma.com.
// The app itself lives on the website, so every update reaches the desktop app straight away.
// - Downloads (Excel, ZIP, PDF, backups) ask where to save, like a browser.
// - PDFs and photos that open in a new tab open in a new app window (same login).
// - Links to other websites open in your normal browser.
// - Window size and position are remembered; only one copy of the app runs at a time.
const { app, BrowserWindow, Menu, shell, dialog, session } = require('electron');
const fs = require('fs');
const path = require('path');

const HOME = 'https://www.trackmyrma.com/';
const OURS = new Set(['www.trackmyrma.com', 'trackmyrma.com']);
const isOurs = (u) => { try { const x = new URL(u); return x.protocol === 'https:' && OURS.has(x.hostname); } catch { return false; } };

const stateFile = () => path.join(app.getPath('userData'), 'window.json');
const loadState = () => { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return { width: 1280, height: 860 }; } };
const saveState = (win) => {
  try { if (!win.isMinimized()) fs.writeFileSync(stateFile(), JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() })); } catch { /* not important */ }
};

const offlinePage = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8"><title>TrackMyRMA</title>
<style>body{margin:0;height:100vh;display:grid;place-items:center;background:#1e1b4b;color:#e9e8fb;font-family:system-ui,Segoe UI,sans-serif;text-align:center}
h1{font-size:1.3rem;margin:0 0 8px}p{color:#c9c7ef;margin:0 0 20px}button{font:inherit;font-weight:700;padding:11px 22px;border-radius:10px;border:0;background:#fff;color:#1e1b4b;cursor:pointer}</style></head>
<body><main><h1>Cannot reach TrackMyRMA</h1><p>Check your internet connection, then try again.</p>
<button onclick="location.href='${HOME}'">Try again</button></main></body></html>`)}`;

let main = null;

function secure(win) {
  const wc = win.webContents;
  // New tabs: our files open in an app window; other sites in the normal browser.
  wc.setWindowOpenHandler(({ url }) => {
    if (isOurs(url)) return { action: 'allow', overrideBrowserWindowOptions: { width: 1000, height: 800, autoHideMenuBar: true, webPreferences: webPrefs() } };
    if (/^(https?|mailto|tel):/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // Leaving our site in the same window: open it in the normal browser instead.
  wc.on('will-navigate', (e, url) => {
    if (!isOurs(url) && !url.startsWith('data:')) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); }
  });
  wc.on('did-create-window', (child) => secure(child));
}

function webPrefs() {
  return { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true };
}

function createWindow() {
  const st = loadState();
  main = new BrowserWindow({
    x: st.x, y: st.y, width: st.width || 1280, height: st.height || 860, minWidth: 380, minHeight: 500,
    title: 'TrackMyRMA', backgroundColor: '#1e1b4b', show: false, autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: webPrefs(),
  });
  if (st.maximized) main.maximize();
  secure(main);
  main.once('ready-to-show', () => main.show());
  main.webContents.on('did-fail-load', (_e, code, _desc, url, isMain) => {
    if (isMain && code !== -3 && isOurs(url)) main.loadURL(offlinePage);
  });
  for (const ev of ['resize', 'move', 'close']) main.on(ev, () => saveState(main));
  main.on('closed', () => { main = null; });
  main.loadURL(HOME);
}

function menu() {
  const isMac = process.platform === 'darwin';
  const go = (p) => () => main?.loadURL(new URL(p, HOME).href);
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [{ label: 'Home', accelerator: 'CmdOrCtrl+Shift+H', click: go('/') }, { label: 'New RMA', accelerator: 'CmdOrCtrl+N', click: go('/rma/new') },
      { type: 'separator' }, isMac ? { role: 'close' } : { role: 'quit' }] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'forceReload' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { type: 'separator' }, { role: 'togglefullscreen' }] },
    { label: 'Go', submenu: [{ label: 'Back', accelerator: 'Alt+Left', click: () => main?.webContents.navigationHistory.goBack() },
      { label: 'Forward', accelerator: 'Alt+Right', click: () => main?.webContents.navigationHistory.goForward() }] },
    { role: 'windowMenu' },
    { role: 'help', submenu: [{ label: 'User guide', click: go('/help') }, { label: 'Privacy', click: go('/privacy') },
      { label: `About TrackMyRMA ${app.getVersion()}`, click: () => dialog.showMessageBox({ message: 'TrackMyRMA', detail: `Version ${app.getVersion()}\nwww.trackmyrma.com` }) }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (main) { if (main.isMinimized()) main.restore(); main.focus(); } });
  app.whenReady().then(() => {
    // Camera / microphone etc. are only for our own site.
    session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(isOurs(wc.getURL()) && ['media', 'clipboard-sanitized-write', 'fullscreen'].includes(permission)));
    menu();
    createWindow();
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
