import { useRef, useState } from 'react';
import { get, post } from '../api.js';
import { readTable } from '../excel.js';
import { Field, Icon, fmtMs, useLoad, useToast } from '../ui.jsx';

// The fields an RMA can take from a sheet, with the column headings they usually have
// (old Excel tracker and the SQL Server RMATickets table from the desktop version).
const RMA_FIELDS = [
  ['printer_sn', 'Printer serial number', true, ['printer sn', 'printersn', 'printer serial', 'serial no', 'serial number', 'product serial', 'sn', 's/n']],
  ['printer_model', 'Printer model', false, ['printer model', 'printermodel', 'model', 'product model']],
  ['customer_company', 'Customer company', false, ['customer company', 'customercompany', 'customer', 'customer name', 'company', 'client', 'party']],
  ['customer_city', 'Customer city', false, ['customer city', 'customercity', 'city']],
  ['customer_address', 'Customer address', false, ['customer address', 'customeraddress', 'address']],
  ['customer_contact_name', 'Contact name', false, ['customer contact name', 'customercontactname', 'contact', 'contact name', 'contact person']],
  ['customer_email', 'Customer email', false, ['customer email', 'customeremail', 'email']],
  ['customer_phone', 'Customer phone', false, ['customer phone', 'customerphone', 'phone', 'mobile']],
  ['po_number', 'PO number', false, ['po number', 'ponumber', 'po no', 'po']],
  ['ship_to_company', 'Ship-to company', false, ['ship to company', 'shiptocompany']],
  ['ship_to_address', 'Ship-to address', false, ['ship to address', 'shiptoaddress']],
  ['faulty_part', 'Faulty part', false, ['faulty part', 'faultypart', 'part', 'problematic part', 'defective part']],
  ['faulty_part_sn', 'Faulty part serial', false, ['faulty part sn', 'faultypartsn', 'part sn', 'part serial', 'head sn', 'tph sn']],
  ['faulty_part_no', 'Faulty part number', false, ['faulty part no', 'faultypartno', 'part no', 'part number', 'part code']],
  ['failure_description', 'Failure description', false, ['failure description', 'failuredescription', 'fault', 'problem', 'issue', 'fault description', 'remarks']],
  ['tph_mileage', 'TPH mileage', false, ['tph mileage', 'tphmileage', 'tph milage', 'head mileage']],
  ['printer_mileage', 'Printer mileage', false, ['printer mileage', 'printermileage', 'printer milage']],
  ['fw_version', 'Firmware version', false, ['fw version', 'fwversion', 'firmware']],
  ['flash_initialized', 'Flash initialised', false, ['flash initialized', 'flashinitialized']],
  ['purchase_date', 'Purchase date', false, ['purchase date', 'purchasedate', 'invoice date']],
  ['oem_rma_number', 'OEM RMA number', false, ['oem rma number', 'oemrmanumber', 'oem rma', 'rma no', 'rma number', 'tsc rma']],
  ['oem_rma_assign_date', 'OEM RMA date', false, ['oem rma assign date', 'oemrmaassigndate', 'rma date']],
  ['status', 'Status', false, ['status', 'stage']],
  ['created_at', 'Date raised', false, ['created at', 'createdat', 'date raised', 'date', 'rma raised', 'raised on']],
  ['ticket_no', 'Keep old ticket number', false, ['internal ticket no', 'internalticketno', 'ticket no', 'ticket', 'ticket number']],
  ['oem_dispatch_date', 'Dispatched to OEM', false, ['oem dispatch date', 'oemdispatchdate', 'dispatch to oem']],
  ['batch_code', 'Batch', false, ['batch dispatch id', 'batchdispatchid', 'batch', 'batch id']],
  ['challan_number', 'Challan number', false, ['zoho challan number', 'zohochallannumber', 'challan', 'challan no', 'dc no']],
  ['dispatch_to_customer_date', 'Dispatched to customer', false, ['dispatch to customer date', 'dispatchtocustomerdate']],
  ['closed_at', 'Closed on', false, ['closed at', 'closedat', 'closed on', 'closing date']],
  ['closure_remarks', 'Closing remarks', false, ['closure remarks', 'closureremarks']],
];
const CUSTOMER_FIELDS = [
  ['name', 'Name', true, ['name', 'customer', 'customer name', 'company', 'party']],
  ['code', 'Code', false, ['code', 'customer code']],
  ['city', 'City', false, ['city']],
  ['state', 'State', false, ['state']],
  ['address', 'Address', false, ['address']],
  ['postal', 'Postal code', false, ['postal', 'pin', 'pincode', 'pin code', 'zip']],
  ['contact_name', 'Contact name', false, ['contact', 'contact name', 'contactname', 'contact person']],
  ['email', 'Email', false, ['email', 'e-mail']],
  ['phone', 'Phone', false, ['phone', 'mobile', 'contact no']],
  ['gstin', 'GSTIN', false, ['gstin', 'gst', 'gst no', 'gst number']],
];
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9/ ]/g, ' ').replace(/\s+/g, ' ').trim();
function autoMap(fields, columns) {
  const map = {};
  const used = new Set();
  for (const [key, , , aliases] of fields) {
    const hit = columns.find((c) => !used.has(c) && aliases.includes(norm(c))) || columns.find((c) => !used.has(c) && norm(c).replace(/ /g, '') === key.replace(/_/g, ''));
    if (hit) { map[key] = hit; used.add(hit); }
  }
  return map;
}

export default function Import({ user, reloadBoot, onChange }) {
  const [kind, setKind] = useState('rma');
  return (
    <>
      <div className="page-head"><div><h1>Import</h1>
        <p className="muted">Bring in RMAs and customers from Excel (.xlsx) or CSV — your old tracker sheet or tables exported from the desktop version's SQL Server (in SSMS: right-click the table → Select Top 1000 → select all results → Copy with Headers → paste into Excel).</p></div></div>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={kind === 'rma'} onClick={() => setKind('rma')}>RMAs</button>
        <button role="tab" aria-selected={kind === 'customers'} onClick={() => setKind('customers')}>Customers</button>
      </div>
      {kind === 'rma' ? <Importer key="rma" kind="rma" fields={RMA_FIELDS} onDone={onChange} />
        : <Importer key="c" kind="customers" fields={CUSTOMER_FIELDS} onDone={reloadBoot} />}
      {kind === 'rma' && <ImportLog />}
    </>
  );
}

function Importer({ kind, fields, onDone }) {
  const toast = useToast();
  const ref = useRef(null);
  const [sheet, setSheet] = useState(null);
  const [map, setMap] = useState({});
  const [result, setResult] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  async function pick(file) {
    setError(''); setResult(null); setPreview(null);
    try {
      const t = await readTable(file);
      t.fileName = file.name;
      setSheet(t);
      setMap(autoMap(fields, t.columns));
    } catch (e) {
      setError(e.message);
    }
  }
  const rowsFor = () => sheet.rows.map((r) => {
    const o = { _row: r._row };
    for (const [key] of fields) if (map[key]) o[key] = r[map[key]];
    return o;
  });
  async function run(dryRun) {
    const required = fields.filter((f) => f[2] && !map[f[0]]);
    if (required.length) { setError(`Choose a column for: ${required.map((f) => f[1]).join(', ')}`); return; }
    setError('');
    setBusy(dryRun ? 'check' : 'import');
    try {
      const rows = rowsFor();
      if (kind === 'customers') {
        const r = await post('/api/import/customers', { rows });
        setResult({ imported: r.added + r.updated, text: `${r.added} added, ${r.updated} updated`, errorList: r.errors, errors: r.errors.length, duplicates: 0, duplicateList: [] });
        await onDone?.();
        return;
      }
      const total = { total: 0, imported: 0, duplicates: 0, errors: 0, duplicateList: [], errorList: [] };
      for (let i = 0; i < rows.length; i += 500) {
        const r = await post('/api/import/rma', { rows: rows.slice(i, i + 500), fileName: sheet.fileName, dryRun });
        for (const k of ['total', 'imported', 'duplicates', 'errors']) total[k] += r[k];
        total.duplicateList.push(...r.duplicateList);
        total.errorList.push(...r.errorList);
      }
      if (dryRun) setPreview(total); else { setResult(total); setPreview(null); onDone?.(); toast(`${total.imported} RMAs imported`); }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  }

  return (
    <section className="panel stack">
      {!sheet ? (
        <div className="dropzone" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files[0]) pick(e.dataTransfer.files[0]); }}>
          <Icon name="upload" size={30} />
          <p>Drop an .xlsx or .csv file here, or</p>
          <button className="btn ghost" onClick={() => ref.current.click()}>Choose file</button>
          <input ref={ref} type="file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={(e) => { if (e.target.files[0]) pick(e.target.files[0]); e.target.value = ''; }} />
          <p className="muted small">The first row must hold the column headings.{kind === 'rma' ? ' Duplicates (same OEM RMA #, same old ticket number, or same printer + part already imported) are skipped.' : ' Existing customers (same code, or same name) are updated.'}</p>
        </div>
      ) : (
        <>
          <div className="spread">
            <div><b>{sheet.fileName}</b><div className="muted small">{sheet.rows.length} rows{sheet.sheet ? ` · sheet "${sheet.sheet}"` : ''} · {sheet.columns.length} columns</div></div>
            <button className="btn ghost small" onClick={() => { setSheet(null); setResult(null); setPreview(null); }}>Choose another file</button>
          </div>
          <h3>Match columns</h3>
          <div className="fields three">
            {fields.map(([key, label, req]) => (
              <Field key={key} label={label} required={req}>
                <select value={map[key] || ''} onChange={(e) => setMap({ ...map, [key]: e.target.value })}>
                  <option value="">— skip —</option>
                  {sheet.columns.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </Field>
            ))}
          </div>
          {kind === 'rma' && <p className="muted small">Dates can be 18-07-2026, 18/07/2026, 18-Jul-2026 or 2026-07-18 (day first). Words like "sent to TSC", "rma received", "challan done", "closed" become statuses; anything else is Open. Without "Keep old ticket number", RMAs are numbered by the month they were raised.</p>}
          <details>
            <summary className="small" style={{ cursor: 'pointer', fontWeight: 700 }}>First rows as read</summary>
            <div className="tablewrap" style={{ marginTop: 8 }}>
              <table className="data"><thead><tr>{fields.filter(([k]) => map[k]).map(([k, l]) => <th key={k}>{l}</th>)}</tr></thead>
                <tbody>{sheet.rows.slice(0, 5).map((r) => <tr key={r._row}>{fields.filter(([k]) => map[k]).map(([k]) => <td key={k}>{r[map[k]]}</td>)}</tr>)}</tbody></table>
            </div>
          </details>
          {error && <div className="formerror">{error}</div>}
          {preview && <Summary r={preview} title="Check — nothing saved yet" />}
          {result && <Summary r={result} title="Imported" done />}
          {!result && (
            <div className="row end">
              {kind === 'rma' && <button className="btn ghost" disabled={!!busy} onClick={() => run(true)}>{busy === 'check' ? 'Checking…' : 'Check first'}</button>}
              <button className="btn primary" disabled={!!busy} onClick={() => run(false)}>{busy === 'import' ? 'Importing…' : `Import ${sheet.rows.length} rows`}</button>
            </div>
          )}
        </>
      )}
      {!sheet && error && <div className="formerror">{error}</div>}
    </section>
  );
}

function Summary({ r, title, done }) {
  return (
    <div className={done ? 'notice' : 'warnbox'} style={{ display: 'grid', gap: 6 }}>
      <b>{title}: {r.text || `${r.imported} to import, ${r.duplicates} duplicates skipped, ${r.errors} errors`}</b>
      {r.errorList.length > 0 && <details><summary>Errors ({r.errorList.length})</summary><ul className="small">{r.errorList.slice(0, 100).map((e) => <li key={e}>{e}</li>)}</ul></details>}
      {r.duplicateList.length > 0 && <details><summary>Duplicates ({r.duplicateList.length})</summary><ul className="small">{r.duplicateList.slice(0, 100).map((e) => <li key={e}>{e}</li>)}</ul></details>}
    </div>
  );
}

function ImportLog() {
  const [log] = useLoad(() => get('/api/import/log'));
  if (!log?.length) return null;
  return (
    <section className="panel">
      <h2>Past imports</h2>
      <div className="tablewrap" style={{ boxShadow: 'none' }}>
        <table className="data"><thead><tr><th>When</th><th>By</th><th>File</th><th>Rows</th><th>Imported</th><th>Duplicates</th><th>Errors</th></tr></thead>
          <tbody>{log.map((l) => <tr key={l.id}><td className="nowrap">{fmtMs(l.at, true)}</td><td>{l.by_name}</td><td>{l.file_name}</td>
            <td className="num">{l.total}</td><td className="num">{l.imported}</td><td className="num">{l.duplicates}</td><td className="num">{l.errors}</td></tr>)}</tbody></table>
      </div>
    </section>
  );
}
