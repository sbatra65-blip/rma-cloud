import { useEffect, useState } from 'react';
import { downloadBlob, get, post, qs } from '../api.js';
import { Dialog, Empty, ErrorPanel, Icon, Link, Skeleton, can, fmtDate, fmtMs, navigate, query, useLoad, useToast } from '../ui.jsx';

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const dmy = (iso) => (iso ? new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).replace(/ /g, '-') : '');

export default function CarePacks({ user }) {
  const toast = useToast();
  const [q, setQ] = useState(query().q || '');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [picked, setPicked] = useState(new Set());
  const [confirm, setConfirm] = useState(false);
  const [n, setN] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => {
      history.replaceState({}, '', `/care-packs${q ? `?${qs({ q })}` : ''}`);
      get(`/api/carepack?${qs({ q })}`).then((r) => { setData(r); setError(null); }).catch(setError);
    }, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [q, n]);
  async function exportCsv() {
    const rows = await get(`/api/carepack/registry?${qs({ q })}`);
    const head = ['Invoice No', 'Company Name', 'Product', 'Model', 'OEM Invoice No', 'Serial No', 'Care Pack Length', 'Warranty End', 'Expired'];
    const lines = [head.join(','), ...rows.map((r) => [r.invoice_number, r.customer_name, r.product, r.model, r.oem_invoice_number, r.serial_number, r.length, dmy(r.warranty_end), r.expired ? 'Yes' : 'No'].map(csvCell).join(','))];
    downloadBlob(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' }), `CarePack_Registry_${user.company.code}_${new Date().toISOString().slice(0, 10)}.csv`);
    toast('Export downloaded');
  }
  async function bulkDelete() {
    const r = await post('/api/carepack/delete', { ids: [...picked] });
    setConfirm(false);
    setPicked(new Set());
    setN(n + 1);
    toast(r.skipped.length ? `Deleted ${r.deleted}; skipped ${r.skipped.length} — ${r.skipped.slice(0, 3).join('; ')}` : `Deleted ${r.deleted} care pack invoice(s).`, r.deleted === 0);
  }
  const admin = can.admin(user);
  return (
    <>
      <div className="page-head">
        <div><h1>Care packs</h1><p className="muted">Printers sold with OEM care packs: serials, cover dates, OEM PO, OEM invoice and payment.</p></div>
        <div className="row">
          <Link to="/care-packs/pending" className="btn ghost"><Icon name="bell" size={18} /> Pending & payments</Link>
          {can.manage(user) && <Link to="/care-packs/new" className="btn primary"><Icon name="plus" size={18} /> Register care pack</Link>}
        </div>
      </div>
      <div className="filters">
        <div className="search"><Icon name="search" size={18} />
          <input type="search" placeholder="Invoice, company, product, model, OEM invoice, serial, care pack, PO…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search care packs" /></div>
        <div className="row">
          <span className="muted small">{data ? `${data.rows.length} shown · ${data.total} total` : ''}</span>
          <span style={{ flex: 1 }} />
          {admin && picked.size > 0 && <button className="btn danger small" onClick={() => setConfirm(true)}><Icon name="trash" size={16} /> Delete selected ({picked.size})</button>}
          <button className="btn ghost small" disabled={!data?.rows.length} onClick={exportCsv}><Icon name="download" size={16} /> Export CSV</button>
          {admin && <Link to="/care-packs/overrides" className="btn ghost small">Override log</Link>}
        </div>
      </div>
      {error && <ErrorPanel error={error} />}
      {!data ? <Skeleton rows={5} /> : !data.rows.length ? (
        <Empty icon="shield" title={q ? `No care packs match “${q}”` : 'No care packs yet'}
          action={!q && can.manage(user) ? <Link to="/care-packs/new" className="btn primary">Register care pack</Link> : null}>
          {!q && 'Register sales invoices with their printer serials. RMAs then show cover and block expired printers.'}</Empty>
      ) : (
        <>
          <div className="tlist mobile-only">
            {data.rows.map((b) => (
              <Link key={b.id} to={`/care-packs/${b.id}`} className="tcard" style={{ '--c': b.expired ? 'var(--rust)' : b.verified ? 'var(--ok)' : b.po_number ? 'var(--s-oem)' : 'var(--amber)' }}>
                <div className="top"><span className="no">{b.invoice_number}{b.line_set_index > 1 ? ` · set ${b.line_set_index}` : ''}</span>
                  <span className={`pill ${b.verified ? 'ok' : b.po_number ? '' : 'warn'}`}>{b.status_label}</span></div>
                <h3>{b.customer_name || '—'}</h3>
                <span className="meta">{b.oem_brand} {b.printer_model} · {b.care_pack_type} · {b.device_count} device{b.device_count === 1 ? '' : 's'}</span>
                <span className="meta">{b.expired ? 'Expired' : `Cover till ${fmtDate(b.warranty_end)}`} · PO {b.po_number || 'pending'}</span>
              </Link>
            ))}
          </div>
          <div className="tablewrap desktop-only">
            <table className="data">
              <thead><tr>{admin && <th><input type="checkbox" aria-label="Select all" checked={picked.size === data.rows.length}
                onChange={(e) => setPicked(e.target.checked ? new Set(data.rows.map((r) => r.id)) : new Set())} /></th>}
                <th>Invoice</th><th>Customer</th><th>Brand / model</th><th>Care pack</th><th>Devices</th><th>PO</th><th>OEM inv.</th><th>Status</th><th>Cover till</th></tr></thead>
              <tbody>{data.rows.map((b) => (
                <tr key={b.id} style={b.expired ? { background: 'color-mix(in srgb, var(--rust-tint) 60%, transparent)' } : undefined}>
                  {admin && <td><input type="checkbox" checked={picked.has(b.id)} onChange={(e) => { const s = new Set(picked); if (e.target.checked) s.add(b.id); else s.delete(b.id); setPicked(s); }} /></td>}
                  <td className="nowrap"><Link to={`/care-packs/${b.id}`} className="mono">{b.invoice_number}</Link>{b.line_set_index > 1 && <span className="tiny muted"> set #{b.line_set_index}</span>}
                    {b.overridden ? <span className="pill warn" style={{ marginLeft: 4 }}>Override</span> : null}</td>
                  <td>{b.customer_name || '—'}</td><td>{b.oem_brand || '—'} / {b.printer_model || '—'}</td><td>{b.care_pack_type || '—'}</td>
                  <td className="num">{b.device_count} / {b.invoice_qty}</td>
                  <td>{b.po_number ? <span className="mono" style={{ color: 'var(--ok)' }}>{b.po_number}</span> : <span className="muted">Pending</span>}</td>
                  <td>{b.oem_invoice_number ? <>{b.oem_invoice_number}{!b.has_pdf && <div className="tiny muted">no PDF</div>}</> : '—'}</td>
                  <td><span className={`pill ${b.verified ? 'ok' : b.po_number ? '' : 'warn'}`}>{b.status_label}</span></td>
                  <td className="nowrap">{b.expired ? <span className="pill bad">Expired</span> : fmtDate(b.warranty_end)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </>
      )}
      <Dialog open={confirm} onClose={() => setConfirm(false)} title={`Delete ${picked.size} invoice(s)?`}>
        <p>Batches with an OEM PO, OEM invoice, or serials used on an RMA are skipped.</p>
        <div className="row end"><button className="btn ghost" onClick={() => setConfirm(false)}>Cancel</button><button className="btn danger" onClick={bulkDelete}>Confirm delete</button></div>
      </Dialog>
    </>
  );
}

export function CarePackPending({ user }) {
  const toast = useToast();
  const [data, reload, error] = useLoad(() => get('/api/carepack/pending'));
  const [tab, setTab] = useState(query().tab || 'po');
  if (error && !data) return <ErrorPanel error={error} retry={reload} />;
  if (!data) return <Skeleton rows={5} />;
  async function paid(b, v) {
    try { await post(`/api/carepack/${b.id}/paid`, { paid: v }); toast(v ? 'Marked as paid.' : 'Marked as not paid.'); reload(); } catch (e) { toast(e.message, true); }
  }
  const lists = { po: data.noPo, docs: data.docs, pay: data.pay };
  const tone = (d) => (d === null || d === undefined ? '' : d < 0 ? 'bad' : d <= 5 ? 'warn' : '');
  return (
    <>
      <div className="page-head"><div>
        <Link to="/care-packs" className="small muted" style={{ textDecoration: 'none' }}>← Care packs</Link>
        <h1>Pending & payments</h1>
        <p className="muted">OEM PO within <b>{data.limits.po} days</b> of the sales invoice (contract 30). OEM payment within <b>{data.limits.pay} days</b> of the OEM bill (contract 45).</p>
      </div></div>
      <div className="tabs" role="tablist">
        {[['po', `PO not linked (${data.noPo.length})`], ['docs', `OEM docs pending (${data.docs.length})`], ['pay', `Payment due (${data.pay.length})`], ['payments', `OEM invoices (${data.payments.length})`]].map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>))}
      </div>
      {tab !== 'payments' ? (
        !lists[tab].length ? <Empty icon="check" title="Nothing pending in this list" /> : (
          <div className="tablewrap"><table className="data">
            <thead><tr><th>Sales invoice</th><th>Customer</th><th>Brand / model</th>{tab !== 'po' && <th>PO</th>}{tab === 'pay' && <th>OEM inv.</th>}
              {tab !== 'docs' && <th>Due</th>}<th>What's missing</th></tr></thead>
            <tbody>{lists[tab].map((b) => (
              <tr key={b.id} onClick={() => navigate(`/care-packs/${b.id}`)} style={{ cursor: 'pointer' }}>
                <td><Link to={`/care-packs/${b.id}`} className="mono">{b.invoice_number}</Link>{b.line_set_index > 1 && <span className="tiny muted"> #{b.line_set_index}</span>}</td>
                <td>{b.customer_name || '—'}</td><td>{b.oem_brand} / {b.printer_model}</td>
                {tab !== 'po' && <td className="mono">{b.po_number}</td>}{tab === 'pay' && <td>{b.oem_invoice_number}</td>}
                {tab !== 'docs' && <td className="nowrap">{b.due ? <span className={`pill ${tone(b.days)}`}>{fmtDate(b.due)}</span> : '—'}</td>}
                <td className="small">{b.gap}</td>
              </tr>))}</tbody>
          </table></div>
        )
      ) : (
        !data.payments.length ? <Empty icon="file" title="No PO-validated OEM invoices yet" /> : (
          <div className="tablewrap"><table className="data">
            <thead><tr><th>OEM PO</th><th>Sales inv.</th><th>OEM invoice</th><th>Bill date</th><th>Amount</th><th>Status</th><th /></tr></thead>
            <tbody>{data.payments.map((b) => (
              <tr key={b.id}>
                <td className="mono">{b.po_number}</td><td><Link to={`/care-packs/${b.id}`}>{b.invoice_number}</Link></td><td>{b.oem_invoice_number}</td>
                <td className="nowrap">{fmtDate(b.oem_invoice_date)}</td><td className="num">{b.oem_amount ? b.oem_amount.toLocaleString('en-IN', { minimumFractionDigits: 2 }) : '—'} {b.oem_currency}</td>
                <td>{b.oem_paid ? <span className="pill ok">Paid · {fmtMs(b.oem_paid_at)} · {b.oem_paid_by}</span> : <span className="pill bad">Not paid</span>}</td>
                <td>{can.edit(user) && (b.oem_paid ? (can.admin(user) && <button className="btn ghost small" onClick={() => paid(b, false)}>Mark not paid</button>)
                  : <button className="btn primary small" onClick={() => paid(b, true)}>Mark paid</button>)}</td>
              </tr>))}</tbody>
          </table></div>
        )
      )}
    </>
  );
}

export function OverrideLog({ user }) {
  const [data, reload, error] = useLoad(() => get('/api/carepack/overrides'));
  if (error && !data) return <ErrorPanel error={error} retry={reload} />;
  if (!data) return <Skeleton rows={4} />;
  return (
    <>
      <div className="page-head"><div><Link to="/care-packs" className="small muted" style={{ textDecoration: 'none' }}>← Care packs</Link>
        <h1>Care pack override log</h1><p className="muted">Read-only. Entries cannot be deleted.</p></div></div>
      <section className="panel"><h2>Overridden devices ({data.overrides.length})</h2>
        {!data.overrides.length ? <p className="muted">No overrides recorded yet.</p> : (
          <div className="tablewrap" style={{ boxShadow: 'none' }}><table className="data">
            <thead><tr><th>Invoice</th><th>Serial</th><th>Invoice brand</th><th>Registered brand</th><th>By</th><th>When</th><th>Reason</th></tr></thead>
            <tbody>{data.overrides.map((o, i) => (
              <tr key={i}><td><Link to={`/care-packs/${o.batch_id}`}>{o.invoice_number}</Link></td><td className="mono">{o.serial_number}</td><td>{o.invoice_brand_detected || '—'}</td>
                <td>{o.oem_brand}</td><td>{o.override_by}</td><td className="nowrap">{fmtMs(o.override_at, true)}</td><td className="small">{o.override_reason}</td></tr>))}</tbody>
          </table></div>)}
      </section>
      <section className="panel"><h2>Document removals ({data.removals.length})</h2>
        {!data.removals.length ? <p className="muted">None.</p> : (
          <div className="tablewrap" style={{ boxShadow: 'none' }}><table className="data">
            <thead><tr><th>Invoice</th><th>Removed</th><th>By</th><th>When</th><th>Reason</th><th>Was</th></tr></thead>
            <tbody>{data.removals.map((a) => (
              <tr key={a.id}><td><Link to={`/care-packs/${a.batch_id}`}>{a.invoice_number}</Link></td><td>{a.action}</td><td>{a.by_name}</td>
                <td className="nowrap">{fmtMs(a.at, true)}</td><td className="small">{a.reason}</td><td className="small mono">{a.snapshot}</td></tr>))}</tbody>
          </table></div>)}
      </section>
    </>
  );
}
