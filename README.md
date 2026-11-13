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

- **Several parts from one printer on the same day:** the New RMA form takes one printer and any number of faulty parts;
  each part becomes its own RMA (own number, photos, OEM Excel). "Another part, same printer" on an RMA pre-fills a new one.
- **Care packs (phase 2):** register sales invoices with printer serials (typed in, read from the invoice PDF, or loaded
  from Zoho Books), cover end per printer, expired cover blocks new RMAs, RMA form shows cover and can pick a printer
  from the registry. OEM PO link with serial cross-check (clubbed POs, manual or Zoho, serials pasted or read from
  XLSX/CSV/PDF), OEM invoice + PDF → 100% verified, OEM payment, deadlines (PO 25 days, payment 40 days by default),
  pending lists, Admin override and document removal with a permanent log, validation report Excel, CSV export.
- **Service provider console** (separate website at `/console`, or its own domain): operators with their own 2FA logins
  create companies, set maximum users, people signed in at once, valid-until date, idle sign-out, allowed email domains,
  switch modules on/off, suspend/activate, and manage each company's logins (invite, reset, disable, sign out).
  Every change is logged. Operators never see a company's RMA or care pack data.
- **Zoho Books per company** (Company settings → Zoho Books): Self Client ID/secret + grant code, stored encrypted.
  Used for care pack invoices/POs and to create the delivery challan when goods go back to the customer.

## Deploy from GitHub to Cloudflare (one time)

1. **Cloudflare** — dash.cloudflare.com → Workers & Pages → Create → *Import a repository* → pick `rma-cloud`.
   - Build command: `npm run build`
   - Deploy command: `npx wrangler deploy`
2. **Secrets** — open the Worker → Settings → *Variables and Secrets* → Add → type **Secret**:
   - `ENC_KEY` — 32 random bytes, base64. Mac/Linux: `openssl rand -base64 32`. Windows PowerShell:
     `$b=New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b)`.
     Keep a copy safe: changing it later breaks everyone's two-step login and Zoho connections.
   - `CONSOLE_SETUP_KEY` — optional; only needed if you set up the console without being logged in to the app (step 4).
   - `RESEND_API_KEY` — from resend.com → API Keys (Sending access).
3. **Set up straight away** — open `https://rma-cloud.<you>.workers.dev`. The first screen creates the first company
   (e.g. *Infinite Solutions*, code `INF`) and its Admin login. Setup closes as soon as one login is complete,
   so do it right after the first deploy.
4. **Console** — while still logged in to the RMA app with that first Admin login, open `/console`. It asks only for a
   console email + password, then the authenticator QR code (no setup key needed: being signed in as the account that did
   the first setup proves it's you). Without that login (e.g. console on its own domain), the `CONSOLE_SETUP_KEY`
   secret is needed instead. After the first operator, invite others from inside the console.
   - Own address (optional): Worker → Settings → *Domains & Routes* → add custom domain e.g. `console.example.com`,
     then add variables `CONSOLE_HOST` = `console.example.com` and `APP_URL` = `https://rma.example.com` (the RMA app address,
     used in invite links). With `CONSOLE_HOST` set, the console answers only on that domain.
5. **Email sender** — until you verify your domain in Resend, mail only reaches your own Resend address.
   Verify `trackmyrma.com` in Resend, then set the Worker variable `MAIL_FROM`
   (e.g. `TrackMyRMA <noreply@trackmyrma.com>`) and use a Resend API key allowed to send from that domain.
   All mail (invites, password resets, reminders, OEM emails) uses this sender; OEM emails set Reply-To to the
   company's own email (Company settings), so OEM replies reach the company, not the sender address.
6. **Phones** — open the address in Chrome (Android: menu → *Install app*) or Safari (iPhone: Share → *Add to Home Screen*).

Every push to `main` redeploys.

### Adding people and companies

- **Users & security → Add user** — they get an invite email (and you get the link to share on WhatsApp if email isn't set up).
  They choose a password and scan a QR code. They log in with the **company code + email + password + 6-digit code**.
- Lost phone and no recovery codes: **Reset login** issues a new set-up link.
- **Console → New company** — creates the company with its limits and modules and invites its first Admin. The same email
  can have logins in several companies, each a separate authenticator entry labelled `RMA Cloud (CODE)`.
- Limits: when *maximum users* is reached, new invites are refused; when *signed in at the same time* is reached, the next
  login is refused until someone logs out (or an Admin / operator signs someone out). After *valid until*, or when
  suspended, everyone is signed out and logins show the reason.
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
| `CONSOLE_IDLE_MINUTES` | 15 | console sign-out after this many idle minutes |
| `CONSOLE_HOST` | — | serve the console only on this hostname |
| `APP_URL` | — | main app address (e.g. `https://trackmyrma.com`): email links, and other attached domains redirect here |
| `MAX_SESSION_HOURS` | 12 | longest session |
| `PBKDF2_ITERATIONS` | 100000 | lower it if login shows "exceeded resource limits" on the free plan |
| `SIGNUP_OFF` | — | set to `1` to pause self sign-up (Start free trial) on the login page |
| `MAIL_FROM` | Resend test sender | verified sender address |

Photos are stored inside each company's database. For lots of photos, create an R2 bucket `rma-photos` and uncomment
`r2_buckets` in `wrangler.jsonc`.

## Moving data from the old Windows RMA System

RMAs (with their numbers, statuses and dates), photos from the photo folders, OEM batches, customers, OEMs/products/models,
care pack types and care packs (with printer serials and OEM invoice PDFs) can be copied straight from the old SQL Server.

1. In RMA Cloud as Admin: **Company settings → Move data from the old system** → download `migrate-rma.ps1` and
   **Create migration key** (valid 48 hours; shown once; can be cancelled).
2. On the PC where the old RMA System and SQL Server Express run, open PowerShell in the folder with the tool and paste the
   copied command. Try it first with `-DryRun` (counts only):
   ```
   Unblock-File .\migrate-rma.ps1
   powershell -NoProfile -ExecutionPolicy Bypass -File .\migrate-rma.ps1 -Url https://your-rma-address -Key rmk_... -DryRun
   ```
3. Run it again without `-DryRun`. It reads the SQL Server named in `C:\Program Files\RMA System\config.ini`
   (or pass `-Server 'localhost\SQLEXPRESS01' -Database RMASystem`) with your Windows login, and the photos from
   `C:\ProgramData\RMA System\Photos` (or `-PhotoRoot`). Photos found in the folders but missing from the database are
   included too. Large photos are resized to 1600 px JPEG (`-MaxPhotoPx`).
   If Windows says the script "is not digitally signed", run the `Unblock-File` line first (Windows marks downloaded
   scripts as blocked). If your company policy still blocks it, run:
   `& ([scriptblock]::Create((Get-Content .\migrate-rma.ps1 -Raw))) -Url https://your-rma-address -Key rmk_... -DryRun`
4. It only reads the old system. It is safe to stop and run again: anything already in the cloud is skipped.
   Use `-Only tickets,photos` to run parts. A log file is written next to the tool.

Checks: `scripts/migrate-tool-check.py` runs the real tool under PowerShell 7 against `wrangler dev` with fixture data.

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
