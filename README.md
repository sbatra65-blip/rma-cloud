# RMA Cloud

RMA ticket management for Infinite Solutions and other companies — the cloud version of the Windows **RMA System**
(C# / Blazor / SQL Server, kept in [`legacy/`](legacy/) for reference).
Runs on Cloudflare Workers + Durable Objects and installs as an app on Android and iPhone.

## What it does

- **Multi-company, separate logins.** Each company has its own login code (e.g. `INF`), its own users, its own data.
  A login belongs to exactly one company: own password, own authenticator entry, own recovery codes.
  The same email can have separate logins in two companies. Nobody can see another company's RMAs — not even the owner.
- **Two-step login (mandatory)** with an authenticator app, 10 recovery codes, lockout after 5 wrong tries,
  breached-password check, one active session per login, sign-out after 5 idle minutes, session token rotation.
- **Roles:** Admin, Manager, Technician, Viewer, plus a per-user "can override duplicate RMAs" permission.
- **RMA workflow:** Open → Awaiting OEM RMA → OEM RMA received → Dispatched to OEM (batch) → Goods received from OEM →
  Dispatched to customer → Closed / Closed – returned. Each step records date and who did it; full history per RMA.
- **Poka-yoke from the original app:** duplicate open RMA check (same part serial anywhere, or same part on the same printer),
  override only with a reason by permitted users; delete only before the OEM chain starts; serial numbers cleaned
  (spaces removed, `TEB T…` → `TEBT…`, glued HSN codes peeled off).
- **Photos** taken straight from the phone camera (shrunk, location data removed). Inbound and outbound sets.
- **OEM Excel form** filled in the browser from the TSC RMA template: `@@PRINTER_MODEL@@` etc. replaced, first five inbound
  photos placed in the photo area. File name `Model_Serial_Part.xlsx` as before. Each company can upload its own template.
- **Email to the OEM** with the Excel attached (via Resend), or copy the text for Zoho Mail / Gmail.
- **Monthly OEM batches** with the packing-list Excel.
- **Reminders** page and a 9 am IST daily email to Admins and Managers.
- **Reports** with Excel export of every field; **Import** of RMAs and customers from .xlsx/.csv
  (old tracker sheet or tables exported from the desktop SQL Server), with a dry-run check first.
- **Masters:** customers, OEMs, products, models. **Audit:** login history, who's signed in now, data activity log.

Not yet in this version (phase 2): Care Pack module (invoices, PO validation, OEM payments) and Zoho Books
(delivery challans). The challan number can be typed in when dispatching to the customer.

## Deploy from GitHub to Cloudflare (one time)

1. **Cloudflare** — dash.cloudflare.com → Workers & Pages → Create → *Import a repository* → pick `rma-cloud`.
   - Build command: `npm run build`
   - Deploy command: `npx wrangler deploy`
2. **Secrets** — open the Worker → Settings → *Variables and Secrets* → Add → type **Secret**:
   - `ENC_KEY` — run `openssl rand -base64 32` and paste the output. Keep a copy safe:
     changing it later breaks everyone's two-step login.
   - `RESEND_API_KEY` — from resend.com → API Keys (Sending access).
3. **Set up straight away** — open `https://rma-cloud.<you>.workers.dev`. The first screen creates the first company
   (e.g. *Infinite Solutions*, code `INF`) and your Admin login. That login is the **owner** and can add more companies.
   Setup closes as soon as one login is complete, so do it right after the first deploy.
4. **Email sender** — until you verify your domain in Resend, mail only reaches your own Resend address.
   Verify `infinitesolutions.co.in` in Resend, then set the Worker variable `MAIL_FROM`
   (e.g. `RMA Desk <rma@infinitesolutions.co.in>`). OEM emails to `tsc_rma@tscprinters.com` need this.
5. **Phones** — open the address in Chrome (Android: menu → *Install app*) or Safari (iPhone: Share → *Add to Home Screen*).

Every push to `main` redeploys.

### Adding people and companies

- **Users & security → Add user** — they get an invite email (and you get the link to share on WhatsApp if email isn't set up).
  They choose a password and scan a QR code. They log in with the **company code + email + password + 6-digit code**.
- Lost phone and no recovery codes: **Reset login** issues a new set-up link.
- **Companies → Add company** (owner only) — creates the company and invites its first Admin. Use your own email if you want
  to run it yourself: it's a separate login with its own authenticator entry, labelled `RMA Cloud (CODE)`.
- The built-in OEM form has Infinite Solutions' details in its ship-to block. Other companies should upload their own copy
  in **Company settings → OEM Excel form**.

### Moving data from the desktop version

In SSMS, run `SELECT * FROM RMATickets` (one company at a time if you used several), select all results →
*Copy with Headers* → paste into Excel → save as .xlsx → **Import → RMAs**. Columns are matched automatically
(InternalTicketNo, PrinterSn, CustomerCompany, OemRmaNumber, Status, CreatedAt…); tick *Keep old ticket number* to keep
existing numbers. Do the same with `Customers` → **Import → Customers**. Photos are not carried over.

### Settings you can change (Worker variables)

| Variable | Default | |
|---|---|---|
| `IDLE_MINUTES` | 5 | sign-out after this many idle minutes |
| `MAX_SESSION_HOURS` | 12 | longest session |
| `PBKDF2_ITERATIONS` | 100000 | lower it if login shows "exceeded resource limits" on the free plan |
| `MAIL_FROM` | Resend test sender | verified sender address |

Photos are stored inside each company's database. For lots of photos, create an R2 bucket `rma-photos` and uncomment
`r2_buckets` in `wrangler.jsonc`.

## Local development

```bash
npm install
echo "ENC_KEY=$(openssl rand -base64 32)" > .dev.vars
npm run build && npx wrangler dev        # http://localhost:8787
npm run test:api                         # 70 API checks (fresh database: rm -rf .wrangler/state first)
python3 scripts/ui-check.py              # browser walk-through with screenshots (fresh database)
```

## Layout

- `worker/index.js` — API routes, security headers, daily reminder job
- `worker/directory.js` — companies, logins, 2FA, sessions, invites, login log (one Durable Object)
- `worker/company.js` — one Durable Object per company: RMAs, photos, masters, batches, import, settings, audit
- `worker/default-template.xlsx` — built-in TSC RMA form
- `src/` — React PWA; `src/excel.js` fills the OEM form and reads/writes sheets in the browser
- `legacy/` — the original Windows application
