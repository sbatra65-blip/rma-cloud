import { useEffect, useState } from 'react';
import { get, post } from '../api.js';
import { ErrorPanel, Icon, PaymentBox, Skeleton, fmtMs, useToast } from '../ui.jsx';

// Plan & billing (Admin): pick a plan and period, pay online with Razorpay (UPI, cards, netbanking),
// and access is extended straight away. Falls back to bank / UPI details when online payment isn't set up.
const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;
const dmy = (iso) => (iso ? iso.split('-').reverse().join('-') : '—');

function loadCheckout() {
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load the payment window. Check your connection and try again.'));
    document.head.appendChild(s);
  });
}

export default function Billing({ user }) {
  const toast = useToast();
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [period, setPeriod] = useState('year');
  const [busy, setBusy] = useState('');
  const load = () => get('/api/billing').then((x) => { setD(x); setError(null); }).catch(setError);
  useEffect(() => { load(); }, []);
  if (error) return <ErrorPanel error={error} retry={load} />;
  if (!d) return <Skeleton rows={6} />;
  const a = d.access;
  const current = d.plans.find((p) => p.id === d.planId);

  async function pay(planId) {
    setBusy(planId);
    try {
      const o = await post('/api/billing/order', { plan: planId, period });
      await loadCheckout();
      await new Promise((resolve) => {
        const rz = new window.Razorpay({
          key: o.keyId, order_id: o.orderId, amount: o.amount, currency: o.currency, name: o.name, description: o.description,
          prefill: o.prefill, theme: { color: '#303090' }, notes: { company: user.company.code },
          handler: async (resp) => {
            try {
              const r = await post('/api/billing/verify', resp);
              toast(`Payment received. Access extended until ${dmy(r.validUntil)}.`);
              setTimeout(() => location.reload(), 1200);
            } catch (x) { toast(x.message); load(); }
            resolve();
          },
          modal: { ondismiss: () => { post('/api/billing/failed', { orderId: o.orderId }).catch(() => {}); resolve(); } },
        });
        rz.on('payment.failed', (r) => toast(r?.error?.description || 'Payment failed. No money was taken; try again or use another method.'));
        rz.open();
      });
    } catch (x) {
      toast(x.data?.error || x.message);
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="stack">
      <div className="page-head"><div><h1>Plan &amp; billing</h1><p className="muted">{user.company.name}</p></div></div>

      <section className="panel billing-now">
        <div>
          <span className="muted small">Current plan</span>
          <b>{a.plan === 'trial' ? 'Free trial' : current ? current.name : 'Paid plan'}</b>
        </div>
        <div>
          <span className="muted small">{a.access === 'open' ? 'Access until' : 'Access ended'}</span>
          <b>{dmy(a.validUntil)}</b>{a.access === 'open' && a.daysLeft !== null && <span className="muted small"> · {a.daysLeft} day{a.daysLeft === 1 ? '' : 's'} left</span>}
        </div>
        <div>
          <span className="muted small">Logins</span>
          <b>{d.maxUsers ? `Up to ${d.maxUsers}` : 'Unlimited'}</b>
        </div>
        {d.credit > 0 && <div><span className="muted small">Advance paid</span><b>{inr(d.credit)}</b><span className="muted small"> · taken off your plan</span></div>}
      </section>

      {d.online ? (
        <>
          <div className="row wrap spread">
            <h2 style={{ margin: 0 }}>Buy or renew</h2>
            <div className="seg" role="group" aria-label="Billing period">
              <button type="button" className={period === 'month' ? 'on' : ''} aria-pressed={period === 'month'} onClick={() => setPeriod('month')}>Monthly</button>
              <button type="button" className={period === 'year' ? 'on' : ''} aria-pressed={period === 'year'} onClick={() => setPeriod('year')}>Yearly · 2 months free</button>
            </div>
          </div>
          <div className="plan-grid">
            {d.plans.map((p) => {
              const q = d.options.find((x) => x.plan === p.id && x.period === period);
              return (
                <section key={p.id} className={`panel plan-card ${p.id === 'business' ? 'pop' : ''}`}>
                  {p.id === 'business' && <span className="plan-tag">Most popular</span>}
                  <h3>{p.name}</h3>
                  <p className="muted small">{p.note}</p>
                  <p className="plan-price"><b>{inr(q.base)}</b> <span className="muted small">/ {period === 'year' ? 'year' : 'month'} + GST</span></p>
                  <ul className="plan-feat">
                    <li><Icon name="check" size={16} />{p.users ? `Up to ${p.users} logins` : 'Unlimited logins'}</li>
                    <li><Icon name="check" size={16} />Unlimited RMAs, every feature</li>
                  </ul>
                  <dl className="plan-sum">
                    {q.credit > 0 && <><dt>Advance adjusted</dt><dd>− {inr(q.credit)}</dd></>}
                    <dt>GST {d.gstPct}%</dt><dd>{inr(q.gst)}</dd>
                    <dt><b>You pay</b></dt><dd><b>{inr(q.total)}</b></dd>
                  </dl>
                  <button className={`btn block ${p.id === 'business' ? 'primary' : 'ghost'}`} disabled={!!busy} onClick={() => pay(p.id)}>
                    {busy === p.id ? 'Opening…' : current?.id === p.id && a.plan !== 'trial' ? `Renew ${p.name}` : `Buy ${p.name}`}
                  </button>
                </section>
              );
            })}
          </div>
          <p className="muted small">Pay by UPI, card, netbanking or wallet through Razorpay. Access is extended as soon as the payment goes through; renewing early adds the time on after your current end date. A GST tax invoice follows by email.</p>
        </>
      ) : (
        <section className="panel">
          <h2>How to pay</h2>
          <p className="muted small" style={{ marginBottom: 10 }}>Online payment isn't switched on yet. Pay by bank transfer or UPI and your service provider extends your access, usually the same day.</p>
          <PaymentBox p={d.payment} />
        </section>
      )}

      {d.history.length > 0 && (
        <section className="panel">
          <h2>Payments</h2>
          <div className="tablewrap">
            <table className="data">
              <thead><tr><th>Date</th><th>Plan</th><th>Period</th><th>Paid</th><th>Access</th><th>Payment ID</th></tr></thead>
              <tbody>
                {d.history.map((h) => (
                  <tr key={h.order_id}>
                    <td>{fmtMs(h.paid_at)}</td>
                    <td>{d.plans.find((p) => p.id === h.plan)?.name || h.plan}</td>
                    <td>{h.period === 'year' ? '1 year' : '1 month'}</td>
                    <td>{inr(h.total)}</td>
                    <td>{dmy(h.valid_from)} → {dmy(h.valid_until)}</td>
                    <td className="mono small">{h.payment_id}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
