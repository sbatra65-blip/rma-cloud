import { useState } from 'react';
import { downloadBlob, get, qs } from '../api.js';
import { writeTable } from '../excel.js';
import { ErrorPanel, Field, Icon, Link, Skeleton, Status, ageDays, fmtDate, fmtMs, todayISO, useLoad, useToast } from '../ui.jsx';

const monthsAgo = (n) => {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};

export default function Reports({ user, boot }) {
  const toast = useToast();
  const [f, setF] = useState({ from: monthsAgo(3), to: todayISO(), status: '', customer: '' });
  const [applied, setApplied] = useState(f);
  const [data, reload, error] = useLoad(() => get(`/api/rma?${qs({ ...applied, limit: 5000 })}`), [applied]);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  async function exportXlsx() {
    setBusy(true);
    try {
      const rows = data.rows;
      const blob = await writeTable({
        sheet: 'RMA Report',
        title: `${user.company.name} — RMA report`,
        subtitle: `${fmtDate(applied.from)} to ${fmtDate(applied.to)}${applied.status ? ` · ${boot.statuses.find((s) => s.value === applied.status)?.label}` : ''}${applied.customer ? ` · customer "${applied.customer}"` : ''} · ${rows.length} RMAs`,
        headers: ['Ticket', 'Status', 'Raised', 'Age (days)', 'Customer', 'City', 'Contact', 'Phone', 'PO number', 'Model', 'Serial', 'Faulty part', 'Part serial (sent)', 'Received part serial', 'Part number',
          'Failure', 'TPH mileage', 'Printer mileage', 'FW', 'Purchase date', 'OEM RMA #', 'OEM RMA date', 'OEM email sent', 'Batch', 'Dispatched to OEM',
          'Back from OEM', 'Challan', 'Dispatched to customer', 'Closed', 'Closure', 'Remarks', 'Photos in', 'Photos out', 'Imported'],
        widths: [22, 18, 12, 9, 26, 12, 16, 14, 14, 12, 18, 16, 16, 16, 14, 34, 10, 10, 10, 12, 18, 12, 16, 16, 12, 12, 14, 12, 16, 10, 24, 8, 8, 8],
        rows: rows.map((t) => [t.ticket_no, t.status_label, fmtMs(t.created_at), ageDays(t.created_at), t.customer_company, t.customer_city, t.customer_contact_name,
          t.customer_phone, t.po_number, t.printer_model, t.printer_sn, t.faulty_part, t.faulty_part_sn, t.received_part_sn, t.faulty_part_no, t.failure_description,
          t.tph_mileage, t.printer_mileage, t.fw_version, t.purchase_date, t.oem_rma_number, t.oem_rma_assign_date, t.oem_email_sent_at ? fmtMs(t.oem_email_sent_at, true) : '',
          t.batch_code, t.oem_dispatch_date, t.goods_received_date, t.challan_number, t.dispatch_to_customer_date, t.closed_at ? fmtMs(t.closed_at) : '',
          t.closure_type, [t.closure_remarks, t.part_sn_note].filter(Boolean).join(' · '), t.inbound_photos, t.outbound_photos, t.is_imported ? 'Yes' : '']),
      });
      downloadBlob(blob, `RMA_Report_${user.company.code}_${todayISO()}.xlsx`);
    } catch (e) {
      toast(e.message, true);
    } finally {
      setBusy(false);
    }
  }

  const byStatus = {};
  for (const t of data?.rows || []) byStatus[t.status] = (byStatus[t.status] || 0) + 1;

  return (
    <>
      <div className="page-head">
        <div><h1>Reports</h1><p className="muted">Filter RMAs by date raised and export every field to Excel.</p></div>
        <button className="btn primary" disabled={busy || !data?.rows.length} onClick={exportXlsx}><Icon name="download" size={18} /> {busy ? 'Preparing…' : 'Export to Excel'}</button>
      </div>
      <form className="panel filters inline" onSubmit={(e) => { e.preventDefault(); setApplied(f); }}>
        <Field label="Customer"><input type="search" value={f.customer} onChange={set('customer')} placeholder="Any" /></Field>
        <Field label="From"><input type="date" value={f.from} max={f.to} onChange={set('from')} /></Field>
        <Field label="To"><input type="date" value={f.to} min={f.from} onChange={set('to')} /></Field>
        <Field label="Status"><select value={f.status} onChange={set('status')}><option value="">Any</option>{boot.statuses.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select></Field>
        <button className="btn ghost">Run</button>
      </form>
      {error && <ErrorPanel error={error} retry={reload} />}
      {!data ? <Skeleton rows={4} /> : (
        <>
          <div className="chips" style={{ margin: '14px 0' }}>
            <span className="chip"><b>{data.rows.length}</b>&nbsp;RMAs</span>
            {boot.statuses.filter((s) => byStatus[s.value]).map((s) => <span key={s.value} className="chip"><Status s={s.value} label={`${s.label} ${byStatus[s.value]}`} /></span>)}
          </div>
          <div className="tablewrap">
            <table className="data">
              <thead><tr><th>Ticket</th><th>Status</th><th>Customer</th><th>Model / serial</th><th>Part</th><th>OEM RMA #</th><th>Raised</th><th>Closed</th></tr></thead>
              <tbody>
                {data.rows.slice(0, 300).map((t) => (
                  <tr key={t.id}>
                    <td><Link to={`/rma/${t.id}`} className="mono">{t.ticket_no}</Link></td>
                    <td><Status s={t.status} /></td>
                    <td>{t.customer_company}</td>
                    <td>{t.printer_model}<div className="tiny muted mono">{t.printer_sn}</div></td>
                    <td>{t.faulty_part}</td>
                    <td className="mono">{t.oem_rma_number || '—'}</td>
                    <td className="nowrap">{fmtMs(t.created_at)}</td>
                    <td className="nowrap">{t.closed_at ? fmtMs(t.closed_at) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.rows.length > 300 && <p className="muted small" style={{ marginTop: 8 }}>Showing 300 of {data.rows.length} here. The Excel export has all of them.</p>}
          {data.more && <p className="warnbox" style={{ marginTop: 8 }}>More than 5000 RMAs match. Narrow the dates to export everything.</p>}
        </>
      )}
    </>
  );
}
