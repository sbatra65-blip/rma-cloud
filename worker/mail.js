// Email through Resend (https://resend.com). Needs the RESEND_API_KEY secret.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function sendMail(env, { to, cc, replyTo, subject, html, text, attachments }) {
  if (!env.RESEND_API_KEY) return { ok: false, error: 'Email is not set up yet: the RESEND_API_KEY secret is missing.' };
  const toList = Array.isArray(to) ? to : [to];
  const payload = { from: env.MAIL_FROM || 'RMA Cloud <onboarding@resend.dev>', to: toList, subject, html, text };
  if (cc && cc.length) payload.cc = cc;
  if (replyTo) payload.reply_to = replyTo;
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

function shell(appName, title, bodyHtml, host) {
  return `<!doctype html><html><body style="margin:0;background:#eef1f5;font-family:Segoe UI,Roboto,Arial,sans-serif">
    <div style="max-width:600px;margin:0 auto;padding:24px">
      <div style="background:#16263d;color:#fff;border-radius:14px 14px 0 0;padding:18px 24px">
        <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.7">${esc(appName)}</div>
        <div style="font-size:18px;font-weight:700;margin-top:2px">${esc(title)}</div>
      </div>
      <div style="background:#fff;border-radius:0 0 14px 14px;padding:8px 24px 24px;color:#16263d">${bodyHtml}
        <p style="color:#5b6b7f;font-size:12px;margin-top:20px">We never ask for your password by email. Links only go to ${esc(host)}.</p>
      </div>
    </div></body></html>`;
}
const button = (href, text) =>
  `<p style="margin:24px 0"><a href="${esc(href)}" style="background:#e4572e;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:700">${esc(text)}</a></p>`;

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
    <p style="color:#5b6b7f;font-size:13px">This link works once and expires in ${days} days. After that, ask your admin for a new one.</p>`, host);
  const text = `Hello ${name},\n\n${reset ? 'Your login was reset.' : `You have been added to ${where} on ${appName}.`}\nSet up your login here (works once, expires in ${days} days):\n${link}`;
  return { subject: reset ? `${appName}: set up your login again` : `${appName}: you're invited to ${where}`, html, text };
}

export function resetEmail({ appName, appUrl, name, token, minutes }) {
  const link = `${appUrl}/reset-password#token=${encodeURIComponent(token)}`;
  const host = new URL(appUrl).host;
  const html = shell(appName, 'Reset your password', `
    <p>Hello ${esc(name)},</p>
    <p>Someone asked to reset the password for your ${esc(appName)} account. If it was you, use the button below.
      You will also need your authenticator code (or a recovery code).</p>
    ${button(link, 'Choose a new password')}
    <p style="color:#5b6b7f;font-size:13px">This link works once and expires in ${minutes} minutes.</p>
    <p style="color:#5b6b7f;font-size:13px">If you didn't ask for this, ignore this email. Your password stays the same.</p>`, host);
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
    <h3 style="margin:20px 0 6px;font-size:14px;color:#16263d">${esc(kind)} <span style="color:#5b6b7f;font-weight:400">(${list.length})</span></h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px">${list.slice(0, 40).map((i) => `
      <tr><td style="padding:6px 0;border-bottom:1px solid #e3e8ee">
        <a href="${esc(appUrl)}/rma/${i.id}" style="color:#16263d;font-weight:700;text-decoration:none">${esc(i.ticket_no)}</a>
        <span style="color:#5b6b7f"> · ${esc(i.customer)} · ${esc([i.model, i.serial].filter(Boolean).join(' '))}${i.part ? ' · ' + esc(i.part) : ''}</span>
      </td><td style="padding:6px 0;border-bottom:1px solid #e3e8ee;text-align:right;color:${i.tone === 'late' ? '#c0392b' : '#5b6b7f'};white-space:nowrap">${i.age} d old</td></tr>`).join('')}
    </table>${list.length > 40 ? `<p style="color:#5b6b7f;font-size:12px">…and ${list.length - 40} more</p>` : ''}`).join('');
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
