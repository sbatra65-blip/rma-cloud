// Online payments with Razorpay (UPI, cards, netbanking, wallets).
// Flow: Admin picks a plan and period -> server works out the price (+ GST, minus any trial advance) and
// creates a Razorpay order -> Razorpay Checkout in the app -> server checks the payment signature and
// extends access. A webhook (order.paid) does the same in case the browser closes before it reports back.
// Secrets: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET.

export const GST_PCT = 18;
export const PLANS = [
  { id: 'starter', name: 'Starter', users: 3, monthly: 1499, note: 'A small service desk' },
  { id: 'business', name: 'Business', users: 10, monthly: 3999, note: 'A busy service centre' },
  { id: 'unlimited', name: 'Unlimited', users: 0, monthly: 7999, note: 'Several branches or teams' },
];
export const PERIODS = { month: { label: '1 month', months: 1, factor: 1 }, year: { label: '1 year', months: 12, factor: 10 } };

export function onlineReady(env) {
  return !!(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);
}

// Rupees, whole numbers. GST is added on top of the plan price; any trial advance is taken off first.
export function quote(plan, period, credit = 0) {
  const p = PLANS.find((x) => x.id === plan);
  const per = PERIODS[period];
  if (!p || !per) return null;
  const base = p.monthly * per.factor;
  const used = Math.min(Math.max(0, Math.round(credit)), base);
  const taxable = base - used;
  const gst = Math.round((taxable * GST_PCT) / 100);
  return { plan: p.id, planName: p.name, users: p.users, period, periodLabel: per.label, months: per.months, base, credit: used, taxable, gst, total: taxable + gst };
}

export async function createOrder(env, { amountPaise, receipt, notes }) {
  // RAZORPAY_API lets the local test suite point at a stand-in server.
  const res = await fetch(`${env.RAZORPAY_API || 'https://api.razorpay.com'}/v1/orders`, {
    method: 'POST',
    headers: { Authorization: `Basic ${btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: amountPaise, currency: 'INR', receipt, notes }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`Payment service: ${d?.error?.description || res.status}`), { status: 502 });
  return d;
}

async function hmacHex(secret, text) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function sameText(a, b) {
  a = String(a || '');
  b = String(b || '');
  if (a.length !== b.length || !a.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}
export async function checkPaymentSignature(env, { orderId, paymentId, signature }) {
  return sameText(await hmacHex(env.RAZORPAY_KEY_SECRET, `${orderId}|${paymentId}`), signature);
}
export async function checkWebhookSignature(env, rawBody, signature) {
  if (!env.RAZORPAY_WEBHOOK_SECRET) return false;
  return sameText(await hmacHex(env.RAZORPAY_WEBHOOK_SECRET, rawBody), signature);
}
