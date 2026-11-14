# TrackMyRMA — installation guide for the service provider

This guide is for the person who runs TrackMyRMA as a service (the provider). Service centres that use TrackMyRMA
install nothing: they sign up in the browser — see the user guide at `/help`.

TrackMyRMA is one Cloudflare Worker. It serves the web app, the API, the customer status pages and the provider
console, and keeps data in Cloudflare Durable Objects (one SQLite database for logins and companies, and one private
SQLite database per company). There is no server to manage.

## 1. What you need

| Item | Why | Cost |
|---|---|---|
| Cloudflare account | Runs the app and stores the data | Free plan works; Workers Paid (about $5/month) raises request limits |
| GitHub account | Holds the code; Cloudflare deploys every push | Free |
| A domain | e.g. `app.yourdomain.com` for the app, `console.yourdomain.com` for the console | Your registrar |
| Resend account | Sends every email (invites, resets, reminders, OEM and customer emails) | Free tier to start |
| Razorpay account (optional) | Online payment of plans by UPI / card / netbanking | Per-transaction fee |
| Backblaze B2 or other S3 storage (recommended) | Encrypted nightly offsite backup | A few rupees a month to start |
| Node.js 20+ on your computer (optional) | Only to run it locally or deploy by hand | Free |

## 2. Put the code on GitHub and connect Cloudflare

1. Keep the code in a private GitHub repository.
2. Cloudflare dashboard → **Workers & Pages → Create → Import a repository** → pick the repository.
    - Build command: `npm run build`
    - Deploy command: `npx wrangler deploy`
3. Every push to `main` now builds and deploys. The version shown at the bottom of the app's menu tells you which
   commit is live.

Deploying by hand instead: `npm install`, `npx wrangler login`, then `npm run deploy`.

## 3. Secrets and settings

Cloudflare → your Worker → **Settings → Variables and Secrets**. Anything marked *Secret* must be added as type
**Secret**, never Text. `keep_vars` in `wrangler.jsonc` stops deploys from wiping what you add here.

### Required

| Name | Type | Value |
|---|---|---|
| `ENC_KEY` | Secret | 32 random bytes, base64. Mac/Linux: `openssl rand -base64 32`. Windows PowerShell: `$b=New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b)` |
| `RESEND_API_KEY` | Secret | resend.com → API Keys (sending access) |
| `MAIL_FROM` | Text | e.g. `TrackMyRMA <hello@yourdomain.com>` on a domain verified in Resend |
| `APP_URL` | Text | the app's main address, e.g. `https://app.yourdomain.com`. Email links point here; other attached domains redirect here |

> **Never change `ENC_KEY`.** It encrypts every two-step login secret and Zoho connection. A new key locks
> everyone out of two-step login. Keep a copy offline.

### Optional

| Name | Type | Value |
|---|---|---|
| `MAIL_REPLY_TO` | Text | where replies to system emails go, e.g. `support@yourdomain.com` (OEM and customer emails reply to each company's own email) |
| `CONSOLE_HOST` | Text | e.g. `console.yourdomain.com` — the console then answers only there |
| `CONSOLE_SETUP_KEY` | Secret | only needed to create the first console operator when you are not signed in to the app |
| `RAZORPAY_KEY_ID` | Text | Razorpay key id — turns on online payment |
| `RAZORPAY_KEY_SECRET` | Secret | Razorpay key secret |
| `RAZORPAY_WEBHOOK_SECRET` | Secret | Razorpay webhook to `https://<app>/api/billing/webhook`, events `order.paid` and `payment.captured` |
| `OFFSITE_ENDPOINT` | Text | S3 endpoint, e.g. `https://s3.us-east-005.backblazeb2.com` |
| `OFFSITE_BUCKET` | Text | bucket name |
| `OFFSITE_REGION` | Text | e.g. `us-east-005` (R2: `auto`) |
| `OFFSITE_KEY_ID` | Secret | access key id for that bucket only |
| `OFFSITE_SECRET` | Secret | secret access key |
| `OFFSITE_PASSPHRASE` | Secret | long passphrase; every backup file is encrypted with it. Keep a copy offline — without it the backups cannot be read |
| `IDLE_MINUTES` | Text | default sign-out after inactivity (15); each company's Admin can change theirs |
| `SIGNUP_OFF` | Text | `1` pauses "Start free trial" |

## 4. Domains and email

1. Add your domain to Cloudflare (Cloudflare nameservers).
2. Worker → **Settings → Domains & Routes → Add custom domain**: the app address (e.g. `app.yourdomain.com`) and,
   if you want, the console address (`console.yourdomain.com`). If Cloudflare says the hostname "already has externally
   managed DNS records", delete the existing A / CNAME record for that name in DNS first.
3. Resend → **Domains → Add domain**, add the DNS records it shows (SPF and DKIM) in Cloudflare DNS, and wait for
   *Verified*. Also add a DMARC record, e.g. TXT `_dmarc` = `v=DMARC1; p=none; rua=mailto:you@yourdomain.com`.
   Without SPF, DKIM and DMARC, emails often land in spam.
4. Set `MAIL_FROM` and `APP_URL` (section 3).

## 5. First start

1. Open the app address straight after the first deploy. The first screen creates the **first company** and its
   Admin login (password + authenticator app). Setup closes as soon as this is done, so do it straight away.
   Use it for your own company, or a demo company.
2. While still signed in, open `/console` (or the console domain). Create the first **console operator** with an
   email, password and authenticator code. Invite other operators from inside the console.
3. In the console, **Payment details**: type your bank / UPI details (shown to companies that pay by transfer).
4. Other service centres now sign up themselves with **Start 30-day free trial** on the login page. You get an email
   for each sign-up and a daily summary.

## 6. Online payments (Razorpay)

1. Razorpay dashboard → API keys → generate keys (test mode first).
2. Add `RAZORPAY_KEY_ID` (Text) and `RAZORPAY_KEY_SECRET` (Secret).
3. Razorpay → Webhooks → add `https://<app>/api/billing/webhook` with events `order.paid` and `payment.captured`,
   and the same secret as `RAZORPAY_WEBHOOK_SECRET`.
4. Companies now pay on **Plan & billing**; access is extended as soon as the payment is confirmed. Raise the GST
   invoice from your billing software when you get the payment email.

## 7. Offsite backup

1. Create a private bucket with Backblaze B2 (or S3, Wasabi, or R2 in a *different* Cloudflare account), with default
   encryption on and lifecycle "keep prior versions for 30 days".
2. Create an application key limited to that bucket, read and write. Copy the key id and the secret at once — the
   secret is shown only once.
3. Add the six `OFFSITE_*` settings (section 3).
4. Console → **Offsite backup → Run now**. Each night from 01:30 to 05:30 IST it runs every 10 minutes and copies new
   data, photos and PDFs. On the Workers Free plan one run copies about 45 files, so the first full copy may take a
   night or two.
5. To read a backup: `node scripts/offsite-download.mjs` (with the same `OFFSITE_*` values as environment variables)
   lists companies and dates, and `node scripts/offsite-download.mjs CODE [YYYY-MM-DD]` rebuilds that company's
   backup as a ZIP.

## 8. Day-to-day

- **Console → Companies**: plan, logins, access end date, suspend / reactivate, sign-out, email a payment reminder.
- **Download a company's data** only works while that company's Admin has turned on *support access*
  (Settings → Privacy & data, 24 hours). The download is shown to their Admins.
- **Updates**: push to `main`; Cloudflare deploys in a minute or two.
- **Logs**: Worker → Observability.

## 9. Run it on your computer (for testing)

```
npm install
npm run build
npx wrangler dev          # http://localhost:8787
node scripts/smoke-test.mjs   # API tests on a fresh local database (rm -rf .wrangler/state first)
```

Local stand-ins: `scripts/mail-mock.mjs` (email, set `RESEND_API=http://127.0.0.1:8797`),
`scripts/razorpay-mock.mjs` (payments), `scripts/s3-mock.mjs` (offsite storage).

## 10. Troubleshooting

| Problem | Fix |
|---|---|
| Emails go to spam | Check SPF, DKIM and DMARC for the `MAIL_FROM` domain; set `MAIL_REPLY_TO` |
| Emails not sent at all | `RESEND_API_KEY` missing, or `MAIL_FROM` on a domain not verified in Resend |
| "Hostname already has externally managed DNS records" | Delete the old A / CNAME record for that name, then add the custom domain again |
| Login says "exceeded resource limits" on the Free plan | Lower `PBKDF2_ITERATIONS` (default 100000) |
| Offsite backup "Too many subrequests" | Normal on the Free plan; runs carry on where they stopped |
| Online payment button missing | `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` not set |
| A setting disappeared after deploy | Make sure `keep_vars` is `true` in `wrangler.jsonc` and the setting is in the dashboard, not only in `.dev.vars` |
