// Reads a printer self-test / configuration printout ("SYSTEM INFORMATION" label strip, e.g. TSC TE310) from a photo
// with a vision model on Cloudflare Workers AI (runs inside Cloudflare; the model keeps no data).
// Used by Bulk RMA from photos: after a draft is made, its photos are checked (most likely ones first) until a
// printout is found. The values are only suggestions on the draft — the operator checks them before accepting.
//
// What goes where (Sanjay, 26 Nov 2026: "fill non reset mileage"):
//   NON-RESET (TPH) → TPH mileage (m) and Printer mileage (m)  — both go to the OEM Excel
//   RESET (TPH)     → shown for reference only
//   FIRMWARE        → Firmware version
//   BAD DOT         → noted in the failure description
export const CONFIG_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';
export const CONFIG_MAX_PHOTOS = 8; // photos tried per draft

const PROMPT = `You read printer self-test printouts. The photo may be rotated sideways or upside down, slightly blurred, or show other things.
If the photo shows a thermal printer configuration / self-test printout with a "SYSTEM INFORMATION" section (lines such as MODEL, FIRMWARE, S/N, NON-RESET, RESET, BAD DOT), copy the values exactly as printed.
Answer with JSON only, no other text:
{"is_config": true, "model": "TE310", "firmware": "A2.15.125 EZD", "serial": "TEBT25301666", "date": "2026/09/10", "non_reset_m": 3029, "reset_m": 3029, "bad_dot": 4}
- non_reset_m and reset_m are the numbers on the NON-RESET and RESET lines marked (TPH) — not the (CUT) lines. Numbers only.
- Use null for any value you cannot read with certainty. Never guess digits.
If the photo is not such a printout, answer {"is_config": false}.`;

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).replace(/[,\s]/g, '').replace(/m$/i, '');
  if (!/^\d{1,9}(\.\d{1,3})?$/.test(s)) return null;
  return Number(s);
};
const str = (v, max = 60) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().slice(0, max);
  return s && !/^(null|n\/a|unknown|-)$/i.test(s) ? s : null;
};
const snNorm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// The model's answer → clean values (or null when it is not a printout). Exported for tests.
export function parseConfigAnswer(answer) {
  let obj = answer;
  if (typeof answer === 'string') {
    const m = answer.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { obj = JSON.parse(m[0]); } catch { return null; }
  }
  if (!obj || typeof obj !== 'object' || obj.is_config === false || obj.is_config === 'false') return null;
  const out = {
    model: str(obj.model, 40),
    firmware: str(obj.firmware, 60),
    serial: str(obj.serial, 40)?.toUpperCase().replace(/\s+/g, '') || null,
    date: str(obj.date, 20),
    non_reset_m: num(obj.non_reset_m),
    reset_m: num(obj.reset_m),
    bad_dot: num(obj.bad_dot),
  };
  if (!out.serial && out.non_reset_m === null && out.reset_m === null) return null;
  return out;
}

// Does the printout belong to this printer? true / false / null (serial not readable).
export function serialMatches(read, printerSn) {
  if (!read?.serial) return null;
  return snNorm(read.serial) === snNorm(printerSn);
}

function base64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

// One photo → values, or null if it is not a printout. Throws when the AI service is not available.
export async function readConfigPhoto(env, bytes, mime, name = '') {
  if (env.CONFIG_READ_MOCK) {
    // Local tests only: canned model answers keyed by photo file name ("default" for any other photo).
    const answers = JSON.parse(env.CONFIG_READ_MOCK);
    return parseConfigAnswer(answers[name] ?? answers.default ?? '{"is_config": false}');
  }
  if (!env.AI) throw Object.assign(new Error('Reading printouts is not set up on this server (Workers AI binding missing).'), { status: 503 });
  const r = await env.AI.run(CONFIG_MODEL, {
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: PROMPT },
        { type: 'image_url', image_url: { url: `data:${mime || 'image/jpeg'};base64,${base64(bytes)}` } },
      ],
    }],
    max_tokens: 200,
    temperature: 0,
  });
  return parseConfigAnswer(r?.response ?? r?.result?.response ?? r);
}
