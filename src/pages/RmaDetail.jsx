import { useRef, useState } from 'react';
import { api, del, downloadBlob, get, post, shareFile, uploadPhoto } from '../api.js';
import { blobToBase64, fillOemTemplate } from '../excel.js';
import {
  Dialog, ErrorPanel, Field, Icon, Link, Skeleton, Status, Stepper, ageDays, can, copyText, fmtDate, fmtMs, navigate, todayISO, useLoad, useToast, ReceivedPartSn, RECEIVED_STAGES, isHeadPart,
} from '../ui.jsx';
import { CoverNote } from './CarePackLink.jsx';

// Private status page for the customer: copy the link or email it to them.
function CustomerStatusLink({ ticket, editable, onSent }) {
  const toast = useToast();
  const [link, setLink] = useState(null);
  const [busy, setBusy] = useState('');
  async function load() {
    if (link) return link;
    const r = await get(`/api/rma/${ticket.id}/track`);
    setLink(r);
    return r;
  }
  async function copy() {
    setBusy('copy');
    try { const r = await load(); await copyText(r.url); toast('Status link copied'); } catch (e) { toast(e.message); } finally { setBusy(''); }
  }
  async function email() {
    setBusy('email');
    try { const r = await post(`/api/rma/${ticket.id}/track/email`, {}); toast(`Status link emailed to ${r.to}`); onSent?.(); } catch (e) { toast(e.data?.error || e.message); } finally { setBusy(''); }
  }
  const to = ticket.customer_email || ticket.ship_to_email;
  return (
    <div className="track-share">
      <div>
        <b>Customer status page</b>
        <p className="muted small">A private link where the customer sees where this RMA is. {to ? 'They also get an email at each main step if customer updates are on in Settings.' : 'Add a customer email to send it by email.'}</p>
      </div>
      <div className="row wrap">
        <button className="btn ghost small" onClick={copy} disabled={!!busy}><Icon name="link" />{busy === 'copy' ? 'Copying…' : 'Copy link'}</button>
        {link && <a className="btn ghost small" href={link.url} target="_blank" rel="noopener">Open</a>}
        {editable && to && <button className="btn ghost small" onClick={email} disabled={!!busy}><Icon name="mail" />{busy === 'email' ? 'Sending…' : `Email to ${to}`}</button>}
      </div>
    </div>
  );
}

// What happens next, in words, for the pinned card at the top of an RMA.
function nextStep(t) {
  const since = (d) => (d ? Math.max(0, Math.round((Date.now() - Date.parse(`${d}T00:00:00+05:30`)) / 86400000)) : null);
  switch (t.status) {
    case 'OPEN': return ['Next step: send it to the OEM', t.excel_generated_at ? 'OEM Excel is ready. Email it to the OEM, or mark it sent.' : 'Make the OEM Excel, then email it to the OEM.'];
    case 'AWAITING_OEM_RMA': return ['Next step: OEM RMA number', t.oem_email_sent_at ? `Emailed to the OEM ${fmtMs(t.oem_email_sent_at)}. Enter the OEM RMA number when it arrives.` : 'Enter the OEM RMA number when the OEM replies.'];
    case 'OEM_RMA_RECEIVED': return ['Next step: dispatch to the OEM', `OEM RMA ${t.oem_rma_number || ''} received. Add it to this month's OEM batch.`];
    case 'DISPATCHED_TO_OEM': { const d = since(t.oem_dispatch_date); return ['Next step: goods back from the OEM', d !== null ? `At the OEM for ${d} day${d === 1 ? '' : 's'}${t.oem_rma_number ? ` (OEM RMA ${t.oem_rma_number})` : ''}.` : 'Waiting for the OEM to send it back.']; }
    case 'GOODS_RECEIVED_FROM_OEM': return ['Next step: send it to the customer', 'Create the delivery challan and dispatch.'];
    case 'DISPATCHED_TO_CUSTOMER': return ['Next step: close the RMA', 'Close it once the customer confirms.'];
    default: return null;
  }
}

const ACTIONS = {
  mark_sent: { label: 'Mark sent to OEM', icon: 'mail', cls: 'ghost', help: 'Use this if you emailed the OEM outside the app.' },
  oem_rma: { label: 'Enter OEM RMA #', icon: 'edit', cls: 'primary' },
  goods_received: { label: 'Goods received from OEM', icon: 'box', cls: 'primary' },
  dispatch_customer: { label: 'Dispatched to customer', icon: 'truck', cls: 'primary' },
  close: { label: 'Close — repaired', icon: 'check', cls: 'ok' },
  close_returned: { label: 'Close — returned to customer', icon: 'back', cls: 'ghost' },
};

// Builds the filled-in OEM Excel in the browser (template + ticket details + first five inbound photos).
export async function buildOemExcel(ticketId, inboundPhotos) {
  const [tplRes, ctx] = await Promise.all([api('GET', '/api/template', undefined, { raw: true }), get(`/api/rma/${ticketId}/email`)]);
  const photos = [];
  for (const p of inboundPhotos.slice(0, 5)) {
    const r = await api('GET', `/api/photos/${p.id}`, undefined, { raw: true });
    photos.push(await r.blob());
  }
  const out = await fillOemTemplate(await tplRes.arrayBuffer(), ctx.tokens, photos);
  await post(`/api/rma/${ticketId}/excel`);
  return { ...out, fileName: ctx.fileName, ctx };
}

export default function RmaDetail({ user, boot, id, onChange }) {
  const toast = useToast();
  const [data, reload, error] = useLoad(() => get(`/api/rma/${id}`), [id]);
  const [tab, setTab] = useState('details');
  const [dlg, setDlg] = useState(null);
  const [busy, setBusy] = useState('');
  if (error && !data) return <ErrorPanel error={error} retry={reload} />;
  if (!data) return <Skeleton rows={6} />;
  const { ticket: t, photos, events, sameMachine } = data;
  const inbound = photos.filter((p) => p.direction === 'INBOUND');
  const outbound = photos.filter((p) => p.direction === 'OUTBOUND');
  const editable = can.edit(user);
  const cat = (boot?.masters?.categories || []).find((c) => c.id === t.category_id);
  const isPrinter = cat ? !!cat.has_head : !t.category || t.category === 'Printer';
  const after = async (msg) => { await reload(); onChange?.(); if (msg) toast(msg); };

  async function excel(mode) {
    setBusy('excel');
    try {
      const { blob, fileName, embedded, missingTokens } = await buildOemExcel(t.id, inbound);
      if (mode === 'share' && await shareFile(blob, fileName, t.ticket_no)) { /* shared */ } else downloadBlob(blob, fileName);
      await after(`OEM Excel ready${embedded ? ` with ${embedded} photo${embedded === 1 ? '' : 's'}` : ''}`);
      if (missingTokens.length) toast(`Template has fields this app doesn't fill: ${missingTokens.join(', ')}`, true);
    } catch (e) {
      toast(`Could not build the Excel: ${e.message}`, true);
    } finally {
      setBusy('');
    }
  }
  async function remove() {
    setBusy('delete');
    try {
      await del(`/api/rma/${t.id}`);
      onChange?.();
      toast(`${t.ticket_no} deleted`);
      navigate('/rma', { replace: true });
    } catch (e) {
      toast(e.message, true);
      setBusy('');
      setDlg(null);
    }
  }

  return (
    <>
      <div className="page-head">
        <div style={{ minWidth: 0 }}>
          <Link to="/rma" className="small muted" style={{ textDecoration: 'none' }}>← RMAs</Link>
          <h1 className="mono" style={{ fontSize: '1.35rem' }}>{t.ticket_no}</h1>
          <p className="row tight" style={{ marginTop: 6 }}>
            <Status s={t.status} label={t.status_label} />
            <span className="small" style={{ fontWeight: 600 }}>{t.customer_company}</span>
            <span className="muted small">{[t.category, t.printer_model, t.faulty_part].filter(Boolean).join(' · ')} · raised {fmtMs(t.created_at)} by {t.created_by || '—'} · {ageDays(t.created_at)} days</span>
            {t.is_imported ? <span className="pill">Imported</span> : null}
          </p>
        </div>
        <div className="row noprint">
          {t.printer_sn && <Link to={`/devices/${encodeURIComponent(t.printer_sn)}`} className="btn ghost small"><Icon name="history" size={16} /> Device history</Link>}
          {editable && <Link to={`/rma/new?from=${t.id}`} className="btn ghost small" title="Same device, another faulty part"><Icon name="plus" size={16} /> Another part, same device</Link>}
          {editable && <Link to={`/rma/${t.id}/edit`} className="btn ghost small"><Icon name="edit" size={16} /> Edit</Link>}
          {data.canDelete && <button className="btn danger small" onClick={() => setDlg('delete')}><Icon name="trash" size={16} /> Delete</button>}
        </div>
      </div>

      <section className="panel">
        <Stepper status={t.status} />
        {nextStep(t) && (
          <div className="nextstep" style={{ marginTop: 16 }}>
            <div><h2>{nextStep(t)[0]}</h2><p>{nextStep(t)[1]}</p></div>
            {editable && data.nextActions.length > 0 && (
              <div className="row">
                {t.status === 'OEM_RMA_RECEIVED' && <Link to="/batches" className="btn ghost"><Icon name="truck" size={18} /> Add to OEM batch</Link>}
                {[...data.nextActions].reverse().map((a) => (
                  <button key={a} className={`btn ${ACTIONS[a].cls}`} onClick={() => setDlg(a)} title={ACTIONS[a].help}>
                    <Icon name={ACTIONS[a].icon} size={18} /> {ACTIONS[a].label}</button>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="actionbar" style={{ marginTop: 10 }}>
          <button className="btn ghost small" disabled={!!busy} onClick={() => excel('download')}><Icon name="file" size={16} />
            {busy === 'excel' ? 'Building…' : t.excel_generated_at ? 'Download OEM Excel' : 'Generate OEM Excel'}</button>
          {'share' in navigator && <button className="btn ghost small" disabled={!!busy} onClick={() => excel('share')}><Icon name="share" size={16} /> Share Excel</button>}
          {editable && <button className="btn ghost small" onClick={() => setDlg('email')}><Icon name="mail" size={16} /> Email OEM</button>}
          <button className="btn ghost small" onClick={() => setDlg('draft')}><Icon name="copy" size={16} /> Copy email text</button>
          <button className="btn ghost small" onClick={() => window.print()}><Icon name="printer" size={16} /> Print</button>
        </div>
        <p className="muted tiny" style={{ marginTop: 10 }}>
          {t.excel_generated_at ? `OEM Excel last made ${fmtMs(t.excel_generated_at, true)}. ` : 'OEM Excel not made yet. '}
          {t.oem_email_sent_at ? `Emailed to OEM ${fmtMs(t.oem_email_sent_at, true)} by ${t.oem_email_sent_by}.` : 'Not emailed to OEM yet.'}
        </p>
      </section>

      {data.cover !== undefined && t.printer_sn && <CoverNote cover={data.cover || false} />}
      {sameMachine.length > 0 && (
        <div className="warnbox" style={{ marginTop: 14 }}>
          Other open RMAs on this printer: {sameMachine.map((s, i) => <span key={s.id}>{i ? ', ' : ''}<Link to={`/rma/${s.id}`}>{s.ticket_no}</Link> ({s.faulty_part || '—'}, {s.status_label})</span>)}
        </div>
      )}
      {t.head_override_reason && (
        <div className="warnbox" style={{ marginTop: 14 }}>Print-head limit overridden by {t.head_override_by} on {fmtMs(t.head_override_at, true)}: {t.head_override_reason}</div>
      )}
      {t.dup_reason && (
        <div className="warnbox" style={{ marginTop: 14 }}>Raised with a duplicate override by {t.dup_by} on {fmtMs(t.dup_at, true)}: {t.dup_reason}</div>
      )}

      <div className="tabs" role="tablist" style={{ marginTop: 14 }}>
        {[['details', 'Details'], ['photos', `Photos (${photos.length})`], ['oem', 'OEM & dispatch'], ['history', 'History']].map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>

      {tab === 'details' && (
        <div className="grid2">
          <section className="panel">
            <h2>Device and fault</h2>
            <dl className="kv">
              <dt>Device</dt><dd>{t.category || 'Printer'}</dd>
              <dt>Model</dt><dd>{t.printer_model || '—'}</dd>
              <dt>Serial number</dt><dd className="mono">{t.printer_sn || '—'}{data.otherTicketsOnPrinter ? <Link to={`/devices/${encodeURIComponent(t.printer_sn)}`} className="small" style={{ marginLeft: 8 }}>{data.otherTicketsOnPrinter} other RMA{data.otherTicketsOnPrinter === 1 ? '' : 's'}</Link> : null}</dd>
              <dt>Faulty part</dt><dd>{t.faulty_part || '—'}</dd>
              <dt>Part serial</dt><dd className="mono">{t.faulty_part_sn || '—'}</dd>
              {RECEIVED_STAGES.includes(t.status) && <><dt>Received part serial</dt><dd><ReceivedPartSn ticket={t} canEdit={editable} onSaved={() => after('Received part serial saved')} /></dd></>}
              <dt>Part number</dt><dd>{t.faulty_part_no || '—'}</dd>
              {(isPrinter || t.tph_mileage != null) && <><dt>TPH mileage</dt><dd>{t.tph_mileage ?? '—'}</dd></>}
              {(isPrinter || t.printer_mileage != null) && <><dt>Printer mileage</dt><dd>{t.printer_mileage ?? '—'}</dd></>}
              <dt>Firmware</dt><dd>{t.fw_version || '—'}</dd>
              {(isPrinter || t.flash_initialized) && <><dt>Flash initialised</dt><dd>{t.flash_initialized || '—'}</dd></>}
              <dt>Purchase date</dt><dd>{fmtDate(t.purchase_date)}</dd>
              <dt>Delivered to user</dt><dd>{fmtDate(t.delivery_to_user_date)}</dd>
              <dt>Failure</dt><dd>{t.failure_description || '—'}</dd>
            </dl>
          </section>
          <section className="panel">
            <h2>Customer</h2>
            <dl className="kv">
              <dt>Company</dt><dd>{t.customer_company || '—'}</dd>
              <dt>Contact</dt><dd>{t.customer_contact_name || '—'}</dd>
              <dt>Phone</dt><dd>{t.customer_phone ? <a href={`tel:${t.customer_phone}`}>{t.customer_phone}</a> : '—'}</dd>
              <dt>Email</dt><dd>{t.customer_email ? <a href={`mailto:${t.customer_email}`}>{t.customer_email}</a> : '—'}</dd>
              <dt>PO number</dt><dd>{t.po_number || '—'}</dd>
              <dt>Address</dt><dd>{[t.customer_address, t.customer_city, t.customer_state, t.customer_postal, t.customer_country].filter(Boolean).join(', ') || '—'}</dd>
              {(t.ship_to_company || t.ship_to_address) && <>
                <dt>Ship to</dt><dd>{[t.ship_to_company, t.ship_to_contact_name, t.ship_to_phone, t.ship_to_address].filter(Boolean).join('\n')}</dd>
              </>}
            </dl>
            <CustomerStatusLink ticket={t} editable={editable} onSent={() => after()} />
          </section>
        </div>
      )}

      {tab === 'photos' && (
        <div className="grid2">
          <PhotoSet title="Inbound — from customer" hint="The first five go into the OEM Excel." direction="INBOUND" list={inbound} ticket={t} user={user} after={after} numbered />
          <PhotoSet title="Outbound — back from OEM" direction="OUTBOUND" list={outbound} ticket={t} user={user} after={after} />
        </div>
      )}

      {tab === 'oem' && (
        <section className="panel">
          <dl className="kv">
            <dt>OEM RMA #</dt><dd className="mono">{t.oem_rma_number || 'Not yet assigned'}</dd>
            <dt>Received on</dt><dd>{fmtDate(t.oem_rma_assign_date)}</dd>
            <dt>OEM email sent</dt><dd>{t.oem_email_sent_at ? `${fmtMs(t.oem_email_sent_at, true)} by ${t.oem_email_sent_by}` : '—'}</dd>
            <dt>Dispatched to OEM</dt><dd>{fmtDate(t.oem_dispatch_date)}</dd>
            <dt>Batch</dt><dd>{t.batch_code ? <Link to={`/batches/${t.batch_code}`}>{t.batch_code}</Link> : '—'}</dd>
            <dt>Goods back from OEM</dt><dd>{fmtDate(t.goods_received_date)}</dd>
            <dt>Received part serial</dt><dd><ReceivedPartSn ticket={t} canEdit={editable} onSaved={() => after('Received part serial saved')} /></dd>
            <dt>Delivery challan</dt><dd>{t.challan_number ? `${t.challan_number} · ${fmtDate(t.challan_date)}` : '—'}</dd>
            <dt>Dispatched to customer</dt><dd>{fmtDate(t.dispatch_to_customer_date)}{t.dispatch_docket ? ` · ${t.dispatch_docket}` : ''}</dd>
            <dt>Closed</dt><dd>{t.closed_at ? `${fmtMs(t.closed_at, true)} · ${t.closure_type === 'REPAIRED' ? 'Repaired' : 'Returned'}` : '—'}</dd>
            <dt>Closing remarks</dt><dd>{t.closure_remarks || '—'}</dd>
          </dl>
        </section>
      )}

      {tab === 'history' && (
        <section className="panel">
          <ul className="events">
            {events.map((e, i) => (
              <li key={i}><span><b>{e.action}</b>{e.detail ? <span> — {e.detail}</span> : null}
                <div className="tiny muted">{fmtMs(e.at, true)} · {e.by_name}</div></span></li>
            ))}
          </ul>
        </section>
      )}

      {Object.keys(ACTIONS).includes(dlg) && <ActionDialog action={dlg} ticket={t} settings={user.company.modules?.includes('zoho') ? boot?.settings : null} onClose={() => setDlg(null)} after={after} />}
      {dlg === 'email' && <EmailDialog ticket={t} inbound={inbound} onClose={() => setDlg(null)} after={after} />}
      {dlg === 'draft' && <DraftDialog ticket={t} onClose={() => setDlg(null)} />}
      <Dialog open={dlg === 'delete'} onClose={() => setDlg(null)} title={`Delete ${t.ticket_no}?`}>
        <p>{data.deleteHint}</p>
        <p className="muted small">The RMA, its photos and history are removed for good.</p>
        <div className="row end">
          <button className="btn ghost" onClick={() => setDlg(null)}>Keep it</button>
          <button className="btn danger" disabled={busy === 'delete'} onClick={remove}>{busy === 'delete' ? 'Deleting…' : 'Delete RMA'}</button>
        </div>
      </Dialog>
    </>
  );
}

function ActionDialog({ action, ticket, settings, onClose, after }) {
  const headPart = isHeadPart(ticket.faulty_part);
  const toast = useToast();
  const [challanBusy, setChallanBusy] = useState(false);
  const challanOk = settings?.challan_enabled !== '0' && settings?.zoho_connected;
  async function makeChallan() {
    setChallanBusy(true);
    try {
      const r = await post(`/api/rma/${ticket.id}/challan`);
      if (r.autoDispatch) setD((x) => ({ ...x, challan_number: r.number, challan_date: todayISO() }));
      toast(`Delivery challan ${r.number} created in Zoho Books${r.autoDispatch ? ' and filled in' : ''}.`);
    } catch (e) {
      toast(e.message, true);
    } finally { setChallanBusy(false); }
  }
  const [d, setD] = useState({
    oem_rma_number: '', oem_rma_assign_date: todayISO(), goods_received_date: todayISO(), received_part_sn: '', noSerial: false,
    dispatch_to_customer_date: todayISO(), challan_number: '', challan_date: todayISO(), dispatch_docket: '', closure_remarks: '',
  });
  const [errors, setErrors] = useState({});
  const [confirmSame, setConfirmSame] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setD({ ...d, [k]: e.target.value });
  async function go(e) {
    e.preventDefault();
    if (action === 'oem_rma' && !d.oem_rma_number.trim()) return setErrors({ oem_rma_number: 'Enter the OEM RMA number' });
    if (action === 'goods_received' && headPart && !d.received_part_sn.trim() && !d.noSerial) return setErrors({ received_part_sn: 'Enter the serial number of the head received from the OEM' });
    setBusy(true);
    try {
      await post(`/api/rma/${ticket.id}/action`, { action, data: { ...d, allowSame: confirmSame } });
      onClose();
      await after(`${ACTIONS[action].label} — saved`);
    } catch (err) {
      if (err.data?.code === 'oem_rma_used') setConfirmSame(false);
      setErrors({ form: err.message, ...(err.fields || {}) });
      if (err.data?.code === 'oem_rma_used') setErrors({ oem_rma_number: err.message, sameAsk: true });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onClose={onClose} title={ACTIONS[action].label}>
      <form className="stack" onSubmit={go} noValidate>
        {errors.form && !errors.sameAsk && <div className="formerror">{errors.form}</div>}
        {action === 'mark_sent' && <p>Status changes to <b>Awaiting OEM RMA</b>. {ACTIONS.mark_sent.help}</p>}
        {action === 'oem_rma' && <>
          <Field label="OEM RMA number" required error={errors.oem_rma_number} hint="From the OEM's reply email, e.g. TEBT25160178-RMA">
            <input type="text" className="upper" autoFocus value={d.oem_rma_number} onChange={set('oem_rma_number')} />
          </Field>
          {errors.sameAsk && <label className="check"><input type="checkbox" checked={confirmSame} onChange={(e) => setConfirmSame(e.target.checked)} />The OEM gave one RMA # for several tickets — use it anyway</label>}
          <Field label="Received on"><input type="date" max={todayISO()} value={d.oem_rma_assign_date} onChange={set('oem_rma_assign_date')} /></Field>
        </>}
        {action === 'goods_received' && <>
          <Field label={headPart ? 'Serial number of the head received' : 'Serial number of the part received'} required={headPart && !d.noSerial} error={errors.received_part_sn}
            hint={`Faulty part sent was ${ticket.faulty_part || 'the part'}${ticket.faulty_part_sn ? ` ${ticket.faulty_part_sn}` : ''}. Shows in the device history.`}>
            <input type="text" className="upper" autoFocus value={d.received_part_sn} onChange={set('received_part_sn')} disabled={d.noSerial} />
          </Field>
          {headPart && <label className="check"><input type="checkbox" checked={d.noSerial} onChange={(e) => setD({ ...d, noSerial: e.target.checked, received_part_sn: '' })} />No serial on the received head — I'll add it later</label>}
          <Field label="Received from OEM on" error={errors.goods_received_date}>
            <input type="date" max={todayISO()} value={d.goods_received_date} onChange={set('goods_received_date')} /></Field>
        </>}
        {action === 'dispatch_customer' && <>
          <Field label="Dispatched on"><input type="date" max={todayISO()} value={d.dispatch_to_customer_date} onChange={set('dispatch_to_customer_date')} /></Field>
          <div className="fields">
            <Field label="Delivery challan number" hint="From Zoho Books or your challan book"><input type="text" value={d.challan_number} onChange={set('challan_number')} /></Field>
            <Field label="Challan date"><input type="date" max={todayISO()} value={d.challan_date} onChange={set('challan_date')} /></Field>
          </div>
          {challanOk && <div><button type="button" className="btn ghost small" disabled={challanBusy} onClick={makeChallan}><Icon name="file" size={16} /> {challanBusy ? 'Creating…' : 'Create delivery challan in Zoho Books'}</button></div>}
          <Field label="Courier / docket number"><input type="text" value={d.dispatch_docket} onChange={set('dispatch_docket')} /></Field>
        </>}
        {(action === 'close' || action === 'close_returned') && <>
          <p>{action === 'close' ? 'The repaired or replaced part reached the customer.' : 'The OEM rejected the claim or the customer took the goods back unrepaired.'}</p>
          <Field label="Remarks"><textarea value={d.closure_remarks} onChange={set('closure_remarks')} /></Field>
        </>}
        <div className="row end">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className={`btn ${ACTIONS[action].cls === 'ghost' ? 'primary' : ACTIONS[action].cls}`} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Dialog>
  );
}

function EmailDialog({ ticket, inbound, onClose, after }) {
  const [ctx, , error] = useLoad(() => get(`/api/rma/${ticket.id}/email`), [ticket.id]);
  const [f, setF] = useState(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState({});
  if (ctx && !f) setF({ to: ctx.to.join(', '), cc: ctx.cc.join(', '), subject: ctx.subject, body: ctx.body });
  async function send(e) {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    try {
      const { blob } = await buildOemExcel(ticket.id, inbound);
      const r = await post(`/api/rma/${ticket.id}/email`, { ...f, excelBase64: await blobToBase64(blob) });
      onClose();
      await after(`Emailed ${r.to.join(', ')}${r.cc.length ? ` (cc ${r.cc.join(', ')})` : ''}`);
    } catch (err) {
      setErrors({ form: err.message, ...(err.fields || {}) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onClose={onClose} title="Email the OEM" wide>
      {error && <div className="formerror">{error.message}</div>}
      {!f ? <Skeleton rows={3} /> : (
        <form className="stack" onSubmit={send} noValidate>
          {errors.form && <div className="formerror">{errors.form}</div>}
          {ctx.sentAt && <div className="warnbox">Already emailed {fmtMs(ctx.sentAt, true)} by {ctx.sentBy}. Sending again sends a second email.</div>}
          <Field label="To" error={errors.to}><input type="text" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
          <Field label="Cc"><input type="text" value={f.cc} onChange={(e) => setF({ ...f, cc: e.target.value })} /></Field>
          <Field label="Subject" error={errors.subject}><input type="text" value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></Field>
          <Field label="Message" error={errors.body}><textarea rows={10} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></Field>
          <p className="muted small"><Icon name="file" size={14} /> Attached: <b>{ctx.fileName}</b> (made now, with {Math.min(inbound.length, 5)} photo{Math.min(inbound.length, 5) === 1 ? '' : 's'}). Replies go to {ctx.replyTo || 'the sending address'}.</p>
          <div className="row end">
            <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
            <button className="btn primary" disabled={busy}><Icon name="mail" size={18} /> {busy ? 'Sending…' : 'Send email'}</button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function DraftDialog({ ticket, onClose }) {
  const toast = useToast();
  const [ctx, , error] = useLoad(() => get(`/api/rma/${ticket.id}/email`), [ticket.id]);
  const copy = async (text, what) => {
    const ok = await copyText(text);
    toast(ok ? `${what} copied` : 'Could not copy — select the text and copy it', !ok);
  };
  return (
    <Dialog open onClose={onClose} title="Email text for Zoho Mail / Gmail" wide>
      {error && <div className="formerror">{error.message}</div>}
      {!ctx ? <Skeleton rows={3} /> : (
        <div className="stack">
          <p className="muted small">Paste into a new email to {ctx.to.join(', ')}{ctx.cc.length ? `, cc ${ctx.cc.join(', ')}` : ''}. Attach the OEM Excel ({ctx.fileName}).</p>
          <Field label="Subject"><div className="row" style={{ flexWrap: 'nowrap' }}><input type="text" readOnly value={ctx.subject} />
            <button className="btn ghost small" onClick={() => copy(ctx.subject, 'Subject')}>Copy</button></div></Field>
          <Field label="Message"><textarea readOnly rows={10} value={ctx.body} /></Field>
          <div className="row end">
            <a className="btn ghost" href={`mailto:${ctx.to.join(',')}?cc=${encodeURIComponent(ctx.cc.join(','))}&subject=${encodeURIComponent(ctx.subject)}&body=${encodeURIComponent(ctx.body)}`}>Open in mail app</a>
            <button className="btn primary" onClick={() => copy(ctx.body, 'Message')}><Icon name="copy" size={18} /> Copy message</button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function PhotoSet({ title, hint, direction, list, ticket, user, after, numbered }) {
  const toast = useToast();
  const ref = useRef(null);
  const [busy, setBusy] = useState(0);
  const [view, setView] = useState(null);
  const editable = can.edit(user) && (!['CLOSED', 'CLOSED_RETURNED'].includes(ticket.status) || user.role === 'Admin');
  async function add(files) {
    setBusy(files.length);
    let ok = 0;
    for (const file of files) {
      try { await uploadPhoto(ticket.id, file, direction); ok++; } catch (e) { toast(e.message, true); }
      setBusy((n) => n - 1);
    }
    setBusy(0);
    if (ok) await after(`${ok} photo${ok === 1 ? '' : 's'} added${direction === 'INBOUND' && ticket.excel_generated_at ? ' — download the OEM Excel again to include them' : ''}`);
  }
  async function remove(p) {
    try {
      await del(`/api/photos/${p.id}`);
      setView(null);
      await after('Photo removed');
    } catch (e) {
      toast(e.message, true);
    }
  }
  return (
    <section className="panel">
      <div className="spread" style={{ marginBottom: 6 }}><h2>{title}</h2><span className="muted small">{list.length}</span></div>
      {hint && <p className="muted small" style={{ marginBottom: 10 }}>{hint}</p>}
      {editable && (
        <div className="row" style={{ marginBottom: 12 }}>
          <button className="btn ghost small" disabled={!!busy} onClick={() => { ref.current.setAttribute('capture', 'environment'); ref.current.click(); }}><Icon name="camera" size={16} /> Take photo</button>
          <button className="btn ghost small" disabled={!!busy} onClick={() => { ref.current.removeAttribute('capture'); ref.current.click(); }}><Icon name="upload" size={16} /> Choose</button>
          {busy > 0 && <span className="muted small">Uploading {busy}…</span>}
          <input ref={ref} type="file" accept="image/*" multiple hidden onChange={(e) => { add([...e.target.files]); e.target.value = ''; }} />
        </div>
      )}
      {list.length ? (
        <div className="photos">
          {list.map((p, i) => (
            <button key={p.id} className="photo" onClick={() => setView(p)} aria-label={`Open photo ${p.name}`}>
              <img src={`/api/photos/${p.id}`} alt="" loading="lazy" />
              {numbered && i < 5 && <span className="n">{i + 1}</span>}
              <span className="cap">{fmtMs(p.captured_at)}</span>
            </button>
          ))}
        </div>
      ) : <p className="muted small">No photos yet.</p>}
      <Dialog open={!!view} onClose={() => setView(null)} title={view?.name || 'Photo'} wide>
        {view && <div className="viewer stack">
          <img src={`/api/photos/${view.id}`} alt={view.name} />
          <div className="spread"><span className="muted small">{fmtMs(view.captured_at, true)} · {view.captured_by}</span>
            {editable && <button className="btn danger small" onClick={() => remove(view)}><Icon name="trash" size={16} /> Remove</button>}</div>
        </div>}
      </Dialog>
    </section>
  );
}
