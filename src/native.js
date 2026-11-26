// Inside the iPhone / Android app (Capacitor shell around this site) a web page cannot download files or open
// new tabs. This file makes those work there, and does nothing in a normal browser or the desktop app.
//   - downloads (Excel, ZIP, PDF, backups) are saved to the app's files and the phone's share sheet opens
//   - links that open in a new tab: files from /api are downloaded the same way, other app pages open in place,
//     links to other websites open in the phone's browser
const cap = () => (typeof window !== 'undefined' ? window.Capacitor : null);
export const isNativeApp = () => !!cap()?.isNativePlatform?.();

let plugins = null;
function native() {
  if (!plugins) {
    const C = cap();
    plugins = { Filesystem: C.registerPlugin('Filesystem'), Share: C.registerPlugin('Share') };
  }
  return plugins;
}

function toBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// Saves the file in the app's cache and opens the share sheet (Save to Files, WhatsApp, Gmail, open in Excel…).
export async function nativeSaveFile(blob, name, title) {
  const { Filesystem, Share } = native();
  const path = `${Date.now()}-${String(name || 'file').replace(/[\\/:*?"<>|]+/g, '_')}`;
  const { uri } = await Filesystem.writeFile({ path, data: await toBase64(blob), directory: 'CACHE' });
  await Share.share({ title: title || name, files: [uri], dialogTitle: title || name });
}

// Opens a file served by /api (a PDF, photo or challan) in the app.
export async function nativeOpenUrl(url, name) {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`Could not open the file (${res.status})`);
  const cd = res.headers.get('Content-Disposition') || '';
  const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  const file = name || (m ? decodeURIComponent(m[1]) : url.split('/').pop() || 'file');
  await nativeSaveFile(await res.blob(), file);
}

// One click handler for the whole app: links that would open a new tab.
export function installNativeLinks(onError) {
  if (!isNativeApp()) return;
  document.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[href]');
    if (!a || e.defaultPrevented) return;
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('blob:') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
    const url = new URL(href, location.href);
    const sameSite = url.origin === location.origin;
    if (sameSite && url.pathname.startsWith('/api/')) {
      e.preventDefault();
      nativeOpenUrl(url.href).catch((err) => onError?.(err.message));
    } else if (a.target === '_blank') {
      e.preventDefault();
      location.href = url.href; // other app pages open in place; other websites open in the phone's browser
    }
  }, true);
}
