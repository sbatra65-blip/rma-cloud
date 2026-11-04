// Small API client. The session lives in an HttpOnly cookie the page cannot read.
export class ApiError extends Error {
  constructor(status, data) {
    super(data?.error || `Request failed (${status})`);
    this.status = status;
    this.fields = data?.fields || {};
    this.data = data || {};
  }
}

let onSessionEnded = () => {};
export function setSessionEndedHandler(fn) {
  onSessionEnded = fn;
}

export async function api(method, path, body, { headers = {}, raw = false } = {}) {
  let res;
  const binary = body instanceof Blob || body instanceof ArrayBuffer;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined && !binary ? { 'Content-Type': 'application/json', ...headers } : headers,
      body: body === undefined ? undefined : binary ? body : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, { error: 'No internet connection. Check your network and try again.' });
  }
  if (raw && res.ok) return res;
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : null;
  if (res.status === 401 && data?.code === 'session_ended') onSessionEnded('expired');
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export const get = (p) => api('GET', p);
export const post = (p, b = {}) => api('POST', p, b);
export const del = (p) => api('DELETE', p);
export const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v !== null && v !== undefined)).toString();

// Shrink photos before upload: max 1600px long side, JPEG (Excel can embed JPEG/PNG, not WEBP/HEIC).
// Re-drawing on a canvas also strips location (EXIF/GPS) data from phone photos.
export async function compressImage(file) {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) {
    if (/^image\/(jpeg|png)$/.test(file.type)) return file;
    throw new ApiError(422, { error: `${file.name}: this photo format can't be read here. Use JPG or PNG.` });
  }
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const g = canvas.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.84));
}

export async function uploadPhoto(ticketId, file, direction) {
  if (!/^image\//.test(file.type) && !/\.(jpe?g|png|webp|heic|heif)$/i.test(file.name)) {
    throw new ApiError(422, { error: `${file.name}: only photos can be uploaded` });
  }
  if (file.size > 25 * 1024 * 1024) throw new ApiError(422, { error: `${file.name} is larger than 25 MB` });
  const blob = await compressImage(file);
  const name = file.name.replace(/\.(heic|heif|webp|png)$/i, '.jpg');
  return api('POST', `/api/rma/${ticketId}/photos`, blob, {
    headers: { 'X-Direction': direction, 'X-File-Name': encodeURIComponent(name), 'Content-Type': 'image/jpeg' },
  });
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// Opens the phone's share sheet with the file (WhatsApp, Gmail…) when the browser supports it.
export async function shareFile(blob, name, title) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return true;
    } catch (e) {
      if (e.name === 'AbortError') return true;
    }
  }
  return false;
}
