// Email through Resend (https://resend.com). Needs the RESEND_API_KEY secret.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function sendMail(env, { to, cc, replyTo, subject, html, text, attachments, fromName }) {
  if (!env.RESEND_API_KEY) return { ok: false, error: 'Email is not set up yet: the RESEND_API_KEY secret is missing.' };
  const toList = Array.isArray(to) ? to : [to];
  // Every email carries a plain-text part too: HTML-only mail scores worse with spam filters.
  let from = env.MAIL_FROM || 'TrackMyRMA <onboarding@resend.dev>';
  // Emails sent on behalf of a service centre show its name: "Acme Service via TrackMyRMA <hello@…>".
  if (fromName) {
    const addr = (from.match(/<([^>]+)>/) || [null, from])[1];
    from = `${String(fromName).replace(/[<>"\r\n]/g, '').slice(0, 60)} via ${env.APP_NAME || 'TrackMyRMA'} <${addr}>`;
  }
  const payload = { from, to: toList, subject, html, text: text || htmlToText(html) };
  if (cc && cc.length) payload.cc = cc;
  // Replies go to a real mailbox (MAIL_REPLY_TO) unless the email sets its own, e.g. OEM emails reply to the company.
  const reply = replyTo || env.MAIL_REPLY_TO;
  if (reply) payload.reply_to = reply;
  if (attachments && attachments.length) payload.attachments = attachments; // [{ filename, content (base64) }]
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return { ok: false, error: `Email service said ${res.status}: ${(await res.text()).slice(0, 300)}` };
    return { ok: true, id: (await res.json().catch(() => ({}))).id };
  } catch (e) {
    return { ok: false, error: `Could not reach the email service: ${e.message}` };
  }
}

export function htmlToText(html = '') {
  return String(html)
    .replace(/<(head|style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, t) => `${t.replace(/<[^>]+>/g, '').trim()} (${href})`)
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|h[1-6]|li|table)>/gi, '\n').replace(/<li[^>]*>/gi, '- ').replace(/<\/td>/gi, '  ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .split('\n').map((l) => l.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function shell(appName, title, bodyHtml, host) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title></head><body style="margin:0;background:#f2f1f8;font-family:Segoe UI,Roboto,Arial,sans-serif">
    <div style="max-width:600px;margin:0 auto;padding:24px">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border-radius:14px 14px 0 0;overflow:hidden"><tr>
        <td style="height:4px;background:#5a80bc"></td><td style="height:4px;background:#6e68ae"></td><td style="height:4px;background:#c03a96"></td>
        <td style="height:4px;background:#19aec6"></td><td style="height:4px;background:#7fc06c"></td><td style="height:4px;background:#cfc455"></td></tr></table>
      <div style="background:#303090;color:#fff;padding:18px 24px">
        <img src="https://${esc(host)}/brand/trackmyrma-logo-white-email.png" width="168" height="36" alt="${esc(appName)}" style="display:block;border:0;margin-bottom:8px">
        <div style="font-size:18px;font-weight:700;margin-top:2px">${esc(title)}</div>
      </div>
      <div style="background:#fff;border-radius:0 0 14px 14px;padding:8px 24px 24px;color:#1e1b4b">${bodyHtml}
        <p style="color:#5f6278;font-size:12px;margin-top:20px">We never ask for your password by email. Links only go to ${esc(host)}.</p>
        <p style="margin:18px 0 0;text-align:center"><img src="https://${esc(host)}/brand/trackmyrma-mark-96.png" width="40" height="40" alt="TrackMyRMA" style="display:inline-block;border:0"></p>
      </div>
    </div></body></html>`;
}
const button = (href, text) =>
  `<p style="margin:24px 0"><a href="${esc(href)}" style="background:#303090;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:700">${esc(text)}</a></p>`;

export function inviteLink(appUrl, token) {
  // The token goes after # so it never reaches server logs or other sites.
  return `${appUrl}/invite#token=${encodeURIComponent(token)}`;
}

export function inviteEmail({ appName, appUrl, name, token, days, companies, invitedBy, reset }) {
  const link = inviteLink(appUrl, token);
  const host = new URL(appUrl).host;
  const where = companies && companies.length ? companies.join(', ') : appName;
  const html = shell(appName, reset ? 'Set up your login again' : `You're invited to ${where}`, `
    <p>Hello ${esc(name)},</p>
    <p>${reset
      ? `${esc(invitedBy)} has reset your login for <b>${esc(where)}</b>. Choose a new password and set up two-step login again with an authenticator app.`
      : `${esc(invitedBy)} has added you to <b>${esc(where)}</b> on ${esc(appName)}, the RMA ticket system. Choose a password, then set up two-step login with an authenticator app (Google Authenticator, Microsoft Authenticator or Authy).`}</p>
    ${button(link, reset ? 'Set up my login' : 'Accept invite')}
    <p style="color:#5f6278;font-size:13px">This link works once and expires in ${days} days. After that, ask your admin for a new one.</p>`, host);
  const text = `Hello ${name},\n\n${reset ? 'Your login was reset.' : `You have been added to ${where} on ${appName}.`}\nSet up your login here (works once, expires in ${days} days):\n${link}`;
  return { subject: reset ? `${appName}: set up your login again` : `${appName}: you're invited to ${where}`, html, text };
}

// Service provider: someone started a free trial.
export function signupAlertEmail({ appName, consoleUrl, company, name, email, phone }) {
  const subject = `New trial sign-up: ${company.name} (${company.code})`;
  const body = `<p><b>${esc(name)}</b> just started a 30-day free trial.</p>
    <table style="font-size:14px">${[['Company', `${company.name} (${company.code})`], ['Email', email], ['Phone', phone || '—']]
      .map(([k, v]) => `<tr><td style="padding:3px 12px 3px 0;color:#5f6278">${k}</td><td style="font-weight:600">${esc(v)}</td></tr>`).join('')}</table>
    <p>They still need to open the setup link we emailed them. A quick call in the first day helps them get going.</p>
    <p><a href="${esc(consoleUrl)}" style="color:#303090;font-weight:700">Open the console</a></p>`;
  return { subject, html: shell(`${appName} Console`, subject, body, new URL(consoleUrl).host) };
}

// Service provider: daily summary of sign-ups, buying signals and access ending.
export function providerDigestEmail({ appName, consoleUrl, d, sentToCustomers = [] }) {
  const dmy = (iso) => (iso ? iso.split('-').reverse().join('-') : '');
  const sec = (title, items, line) => (items.length ? `<h3 style="font-size:15px;margin:18px 0 6px">${title} (${items.length})</h3><ul style="padding-left:18px;margin:0">${items.map((i) => `<li style="margin:3px 0">${line(i)}</li>`).join('')}</ul>` : '');
  const who = (i) => `<b>${esc(i.name)}</b> (${esc(i.code)})${i.contact ? ` · ${esc(i.contact)}` : ''}${i.phone ? ` · ${esc(i.phone)}` : ''}`;
  const plan = (i) => (i.plan === 'trial' ? 'trial' : 'paid plan');
  const body = `<p>Here's today's summary.</p>
    ${sec('New trial sign-ups', d.signups, (i) => `${esc(i.detail || '')} · ${esc(i.email || '')}`)}
    ${sec('Buying signal: imported their data', d.hot, (i) => `<b>${esc(i.name)}</b> (${esc(i.code)})${i.import_rows ? ` · ${i.import_rows} RMAs` : ''}`)}
    ${sec('Ending within 7 days', d.ending, (i) => `${who(i)} · ${plan(i)} ends ${dmy(i.validUntil)} (${i.daysLeft === 0 ? 'today' : `${i.daysLeft} d`})`)}
    ${sec('Read-only now (not paid)', d.readOnly, (i) => `${who(i)} · ${plan(i)} ended ${dmy(i.validUntil)}, locks after ${dmy(i.readOnlyUntil)}`)}
    ${sec('Locked yesterday', d.ended, (i) => `${who(i)} · ${plan(i)} ended ${dmy(i.validUntil)}`)}
    ${sentToCustomers.length ? `<p style="color:#5f6278;font-size:13px;margin-top:18px">Reminders emailed to customers today: ${sentToCustomers.map((r) => `${esc(r.company)} ${r.ok ? '✓' : `✗ (${esc(String(r.error || '').slice(0, 80))})`}`).join(', ')}</p>` : ''}
    <p style="margin-top:18px">To record a payment: console → company → <b>Mark as paid</b> / <b>Record renewal</b>.</p>
    <p><a href="${esc(consoleUrl)}" style="color:#303090;font-weight:700">Open the console</a></p>`;
  const n = d.signups.length + d.hot.length + d.ending.length + d.readOnly.length + d.ended.length;
  return { subject: `${appName}: ${d.signups.length ? `${d.signups.length} new sign-up${d.signups.length > 1 ? 's' : ''}, ` : ''}${n} item${n === 1 ? '' : 's'} to follow up`, html: shell(`${appName} Console`, 'Daily summary', body, new URL(consoleUrl).host) };
}

export function signupEmail({ appName, appUrl, name, token, days, company }) {
  const link = inviteLink(appUrl, token);
  const host = new URL(appUrl).host;
  const html = shell(appName, `Finish setting up ${company.name}`, `
    <p>Hello ${esc(name)},</p>
    <p>Thanks for starting your 30-day free trial of ${esc(appName)}. Your company is ready:</p>
    <p style="font-size:15px;background:#f2f1f8;border-radius:10px;padding:12px 14px">Company code <b style="font-family:Consolas,monospace;font-size:17px">${esc(company.code)}</b><br>${esc(company.name)}</p>
    <p>Choose your password, then set up two-step login with an authenticator app (Google Authenticator, Microsoft Authenticator or Authy). You'll log in with the company code above and this email address.</p>
    ${button(link, 'Set up my login')}
    <p style="color:#5f6278;font-size:13px">This link works once and expires in ${days} days. Didn't sign up? Ignore this email and nothing happens.</p>`, host);
  const text = `Hello ${name},\n\nThanks for starting your 30-day free trial of ${appName}.\nCompany code: ${company.code} (${company.name})\nSet up your login here (works once, expires in ${days} days):\n${link}\n\nDidn't sign up? Ignore this email.`;
  return { subject: `${appName}: finish setting up ${company.name}`, html, text };
}

export function resetEmail({ appName, appUrl, name, token, minutes }) {
  const link = `${appUrl}/reset-password#token=${encodeURIComponent(token)}`;
  const host = new URL(appUrl).host;
  const html = shell(appName, 'Reset your password', `
    <p>Hello ${esc(name)},</p>
    <p>Someone asked to reset the password for your ${esc(appName)} account. If it was you, use the button below.
      You will also need your authenticator code (or a recovery code).</p>
    ${button(link, 'Choose a new password')}
    <p style="color:#5f6278;font-size:13px">This link works once and expires in ${minutes} minutes.</p>
    <p style="color:#5f6278;font-size:13px">If you didn't ask for this, ignore this email. Your password stays the same.</p>`, host);
  const text = `Hello ${name},\n\nReset your ${appName} password here (works once, expires in ${minutes} minutes):\n${link}\n\nYou will also need your authenticator code.\nIf you didn't ask for this, ignore this email.`;
  return { subject: `Reset your ${appName} password`, html, text };
}

export function passwordChangedEmail({ appName, appUrl, name, how, client }) {
  const host = new URL(appUrl).host;
  const when = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
  const where = [client?.ua, client?.place].filter(Boolean).join(', ');
  const html = shell(appName, 'Your password was changed', `
    <p>Hello ${esc(name)},</p>
    <p>The password for your ${esc(appName)} account was ${how === 'reset' ? 'reset using an emailed link' : 'changed from your profile'} on <b>${esc(when)}</b>${where ? ` from <b>${esc(where)}</b>` : ''}.</p>
    <p>${how === 'reset' ? 'All devices were signed out.' : 'Other devices were signed out.'}</p>
    <p style="background:#fde3dc;color:#a8362d;padding:12px;border-radius:10px;font-weight:600">If this wasn't you, reset your password now at ${esc(appUrl)}/login and tell your admin.</p>`, host);
  return { subject: `Your ${appName} password was changed`, html, text: `Your ${appName} password was changed on ${when}. If this wasn't you, reset it now at ${appUrl}/login.` };
}

export function reminderEmail({ appName, appUrl, companyName, items, recipientName }) {
  const host = new URL(appUrl).host;
  const groups = new Map();
  for (const i of items) {
    const key = i.kind.replace(/\s*\(\d+ days\)$/, '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  }
  const blocks = [...groups].map(([kind, list]) => `
    <h3 style="margin:20px 0 6px;font-size:14px;color:#1e1b4b">${esc(kind)} <span style="color:#5f6278;font-weight:400">(${list.length})</span></h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px">${list.slice(0, 40).map((i) => `
      <tr><td style="padding:6px 0;border-bottom:1px solid #e3e8ee">
        <a href="${esc(appUrl)}${esc(i.href || `/rma/${i.id}`)}" style="color:#1e1b4b;font-weight:700;text-decoration:none">${esc(i.ticket_no)}</a>
        <span style="color:#5f6278"> · ${esc(i.customer)} · ${esc([i.model, i.serial].filter(Boolean).join(' '))}${i.part ? ' · ' + esc(i.part) : ''}</span>
      </td><td style="padding:6px 0;border-bottom:1px solid #e3e8ee;text-align:right;color:${i.tone === 'late' ? '#c0392b' : '#5f6278'};white-space:nowrap">${i.age === null || i.age === undefined ? '' : `${i.age} d old`}</td></tr>`).join('')}
    </table>${list.length > 40 ? `<p style="color:#5f6278;font-size:12px">…and ${list.length - 40} more</p>` : ''}`).join('');
  const html = shell(appName, `${items.length} RMA${items.length === 1 ? '' : 's'} need attention — ${companyName}`, `
    <p>Hello ${esc(recipientName || '')},</p>
    <p>These RMAs are waiting for the next step.</p>${blocks}
    ${button(`${appUrl}/reminders`, 'Open reminders')}`, host);
  const text = items.map((i) => `${i.ticket_no} — ${i.kind} — ${i.customer} — ${i.serial}`).join('\n');
  return { subject: `${companyName}: ${items.length} RMA${items.length === 1 ? '' : 's'} need attention`, html, text };
}

export function oemEmailHtml(body) {
  // Plain text body from the template, kept as written; bullets and line breaks preserved.
  return `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#111">${esc(body).replace(/\n/g, '<br>')}</div>`;
}

export function consoleInviteEmail({ appName, consoleUrl, name, token, days, invitedBy, reset }) {
  const link = `${consoleUrl}/console/invite#token=${encodeURIComponent(token)}`;
  const host = new URL(consoleUrl).host;
  const title = reset ? 'Set up your console login again' : `You're invited to the ${appName} Console`;
  const html = shell(`${appName} Console`, title, `
    <p>Hello ${esc(name)},</p>
    <p>${esc(invitedBy)} has ${reset ? 'reset your login for' : 'added you as an operator of'} the <b>${esc(appName)} Console</b>, where companies, their limits and their logins are managed.
      Choose a password, then set up two-step login with an authenticator app.</p>
    ${button(link, reset ? 'Set up my login' : 'Accept invite')}
    <p style="color:#5f6278;font-size:13px">This link works once and expires in ${days} days.</p>`, host);
  return { subject: `${appName} Console: ${reset ? 'set up your login again' : 'you are invited'}`, html, text: `Hello ${name},\n\nSet up your ${appName} Console login (works once, expires in ${days} days):\n${link}` };
}

// Bank / UPI block for trial and renewal emails (details set by the service provider in the console).
function paymentHtml(p) {
  if (!p) return '';
  const row = (k, v) => (v ? `<tr><td style="padding:3px 12px 3px 0;color:#5f6278">${esc(k)}</td><td style="padding:3px 0;font-weight:600">${esc(v)}</td></tr>` : '');
  return `<div style="margin:18px 0;padding:14px 16px;border:1px solid #e7e5f0;border-radius:10px;background:#f6f5fa">
    <p style="margin:0 0 8px;font-weight:700">How to pay</p>
    <table style="font-size:13px;border-collapse:collapse">${row('Account name', p.payeeName)}${row('Bank', p.bankName)}${row('Account no.', p.accountNo)}${row('IFSC', p.ifsc)}${row('UPI', p.upiId)}</table>
    ${p.payLink ? `<p style="margin:10px 0 0"><a href="${esc(p.payLink)}" style="display:inline-block;background:#303090;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:600">Pay online</a></p>` : ''}
    ${p.priceNote ? `<p style="margin:10px 0 0;font-size:13px;color:#47546a">${esc(p.priceNote)}</p>` : ''}
    ${p.contactEmail || p.contactPhone ? `<p style="margin:10px 0 0;font-size:13px">Questions: ${esc([p.contactPhone, p.contactEmail].filter(Boolean).join(' · '))}</p>` : ''}
  </div>`;
}
const dmyMail = (iso) => (iso ? iso.split('-').reverse().join('-') : '');

// Trial / access reminders: 7 and 1 days before the access date, and when read-only starts.
// To the service centre's customer: where their RMA is, with the private status link.
export function customerStatusEmail({ appUrl, centre, view, token, contact, kind = 'update' }) {
  const link = `${appUrl.replace(/\/+$/, '')}/t/${token}`;
  const host = new URL(appUrl).host;
  const head = kind === 'link' ? `Status of RMA ${view.ticketNo}` : `${view.steps[Math.min(view.step, 4)].label}: RMA ${view.ticketNo}`;
  const steps = view.steps.map((s, i) => {
    const on = i <= view.step;
    return `<tr><td style="padding:5px 10px 5px 0;vertical-align:top"><span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:${on ? '#303090' : '#dcdbe8'}"></span></td>
      <td style="padding:4px 0;font-size:14px;${on ? 'font-weight:700;color:#1e1b4b' : 'color:#8a8ca3'}">${esc(s.label)}${s.date ? ` <span style="font-weight:400;color:#5f6278">· ${dmyMail(s.date)}</span>` : ''}</td></tr>`;
  }).join('');
  const body = `<p>Hello${contact ? ` ${esc(contact)}` : ''},</p>
    <p>${esc(view.message)}</p>
    <table style="font-size:14px;background:#f6f5fa;border-radius:10px;padding:10px 14px;margin:12px 0;width:100%">
      <tr><td style="color:#5f6278;padding:2px 12px 2px 0">RMA number</td><td style="font-weight:700">${esc(view.ticketNo)}</td></tr>
      ${view.item ? `<tr><td style="color:#5f6278;padding:2px 12px 2px 0">Item</td><td>${esc(view.item)}</td></tr>` : ''}
      ${view.serial ? `<tr><td style="color:#5f6278;padding:2px 12px 2px 0">Serial</td><td style="font-family:Consolas,monospace">${esc(view.serial)}</td></tr>` : ''}
      ${view.docket ? `<tr><td style="color:#5f6278;padding:2px 12px 2px 0">Courier / docket</td><td>${esc(view.docket)}</td></tr>` : ''}
    </table>
    <table role="presentation" style="margin:8px 0 4px">${steps}</table>
    ${button(link, 'See live status')}
    <p style="color:#5f6278;font-size:13px">Questions? Reply to this email or contact ${esc(centre.name)}${centre.phone ? ` on ${esc(centre.phone)}` : ''}.</p>`;
  const html = shell(centre.name || 'RMA status', head, body, host);
  const text = `Hello${contact ? ` ${contact}` : ''},\n\n${view.message}\nRMA ${view.ticketNo}${view.item ? ` · ${view.item}` : ''}${view.serial ? ` · SN ${view.serial}` : ''}${view.docket ? `\nCourier / docket: ${view.docket}` : ''}\n\nLive status: ${link}\n\n${centre.name}${centre.phone ? ` · ${centre.phone}` : ''}`;
  return { subject: `${centre.name ? `${centre.name}: ` : ''}${head}`, html, text, replyTo: centre.email || undefined, fromName: centre.name || undefined };
}

// To a company's Admins: their data backup, attached as a ZIP (or a note when it is too big to attach).
export function backupEmail({ appName, appUrl, company, at, counts, size, attached }) {
  const host = new URL(appUrl).host;
  const mb = (size / 1048576).toFixed(size < 1048576 ? 2 : 1);
  const body = `<p>Here is the data backup of <b>${esc(company.name)}</b> (${esc(company.code)}) taken on ${esc(at)}.</p>
    <table style="font-size:14px;background:#f6f5fa;border-radius:10px;padding:10px 14px;margin:12px 0">
      ${[['RMAs', counts.rmas], ['Customers', counts.customers], ['Care pack batches', counts.carePacks], ['Photos (not attached)', counts.photos], ['Size', `${mb} MB`]]
        .map(([k, v]) => `<tr><td style="color:#5f6278;padding:2px 14px 2px 0">${k}</td><td style="font-weight:700">${esc(String(v))}</td></tr>`).join('')}
    </table>
    ${attached
      ? '<p>The ZIP is attached: one CSV per table (opens in Excel) and <code>data.json</code>, which can be used to restore. Keep this email, or save the ZIP somewhere safe.</p>'
      : '<p>The backup is too big to attach. Download it from <b>Settings → Backups</b> in the app.</p>'}
    <p>For a full backup with photos and PDFs, use <b>Settings → Backups → Download full backup</b>.</p>
    ${button(`${appUrl.replace(/\/+$/, '')}/settings`, 'Backup settings')}`;
  return { subject: `${company.name}: data backup ${at.slice(0, 10)}`, html: shell(appName, 'Your data backup', body, host) };
}

export function accessEmail({ appName, appUrl, kind, company, info, payment, recipientName }) {
  const host = new URL(appUrl).host;
  const trial = info.plan === 'trial';
  const what = trial ? 'free trial' : 'access';
  const t = info.trial;
  const left = info.daysLeft;
  const when = kind === 'ends1' ? 'tomorrow' : kind === 'ends7' ? 'in 7 days' : left === 0 ? 'today' : left === 1 ? 'tomorrow' : `in ${left} days`;
  const subject = kind === 'ended'
    ? `${company.name}: ${what} has ended — renew to log in again`
    : kind === 'readonly'
    ? `${company.name}: ${what} ended — read-only until ${dmyMail(info.readOnlyUntil)}`
    : `${company.name}: ${what} ends ${when} (${dmyMail(info.validUntil)})`;
  const lines = kind === 'ended'
    ? [`The ${what} for <b>${esc(company.name)}</b> ended on ${dmyMail(info.validUntil)} and logins are paused.`,
      trial ? `Your data is kept until <b>${dmyMail(info.keepDataUntil)}</b>. Buy a plan before then and everything is back as you left it.` : 'Renew and everything is back as you left it.']
    : kind === 'readonly'
    ? [`The ${what} for <b>${esc(company.name)}</b> ended on ${dmyMail(info.validUntil)}.`,
      `Until <b>${dmyMail(info.readOnlyUntil)}</b> everyone can still log in to view, print and export, but not add or change anything. After that, logins stop.`,
      trial ? `Your data is kept until <b>${dmyMail(info.keepDataUntil)}</b>. Buy a plan any time before then and you carry on exactly where you left off.` : 'Renew to carry on exactly where you left off.']
    : [`The ${what} for <b>${esc(company.name)}</b> ends on <b>${dmyMail(info.validUntil)}</b>.`,
      trial ? `Buy a plan to keep everything you have entered and continue without a break. Need more time? Pay a ${t.advancePct}% advance and we extend the trial by ${t.extendDays} days; the advance is adjusted against your purchase.` : 'Renew before then to continue without a break.'];
  const body = `<p>Hello${recipientName ? ` ${esc(recipientName.split(' ')[0])}` : ''},</p>${lines.map((l) => `<p>${l}</p>`).join('')}${paymentHtml(payment)}
    <p><a href="${esc(appUrl)}" style="color:#303090;font-weight:700">Open ${esc(appName)}</a></p>`;
  return { subject, html: shell(appName, subject, body, host) };
}
