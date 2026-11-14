import { useEffect } from 'react';
import { Mark, Wordmark } from '../ui.jsx';

// Public Privacy Policy (/privacy) and Terms of Service (/terms). Every statement here should match how the
// software works; change the text whenever the behaviour changes. Have a lawyer review before relying on it.
const UPDATED = '14 November 2026';
const CONTACT = 'support@trackmyrma.com';

export default function Legal({ path }) {
  const page = path.startsWith('/terms') ? 'terms' : 'privacy';
  useEffect(() => { document.title = `${page === 'terms' ? 'Terms of service' : 'Privacy policy'} · TrackMyRMA`; }, [page]);
  return (
    <div className="legal">
      <header className="legal-head">
        <a href="/" className="legal-brand"><Mark size={34} still /><Wordmark /></a>
        <nav><a href="/privacy" aria-current={page === 'privacy' ? 'page' : undefined}>Privacy</a><a href="/terms" aria-current={page === 'terms' ? 'page' : undefined}>Terms</a></nav>
      </header>
      <main id="main">{page === 'terms' ? <Terms /> : <Privacy />}</main>
      <footer className="legal-foot">TrackMyRMA is a product of Infinite Solutions, New Delhi, India · <a href={`mailto:${CONTACT}`}>{CONTACT}</a></footer>
    </div>
  );
}

function Privacy() {
  return (
    <article>
      <h1>Privacy policy</h1>
      <p className="muted">Last updated {UPDATED}</p>
      <p>TrackMyRMA is run by Infinite Solutions, New Delhi, India (“we”). Service centres (“you”, “the company”) use it to manage repair and return (RMA) work. This page explains what data the service holds, who can reach it, and the rules we follow. We have tried to write only what the software actually does.</p>

      <h2>In short</h2>
      <ul>
        <li>Your company's data belongs to you. We use it only to run the service for you, keep backups, and give support when you ask.</li>
        <li>Each company's data is kept in its own separate database. Other companies using TrackMyRMA cannot see it.</li>
        <li>Our support console cannot download your RMAs, customers, photos or PDFs unless your Admin turns on <b>support access</b>, which ends by itself after 24 hours.</li>
        <li>Every backup and every support download is listed for your Admins under <b>Settings › Privacy &amp; data</b>.</li>
        <li>We do not sell your data, show advertising, or use it to market to your customers.</li>
      </ul>

      <h2>What data the service holds</h2>
      <ul>
        <li><b>Your team's logins:</b> name, email, role, password (stored only as a one-way hash), authenticator (2FA) secret (encrypted), sign-in history with IP address and device.</li>
        <li><b>Your work records:</b> RMAs, your customers' names, phone numbers, emails and addresses, printer and part serials, photos and PDFs you upload, care packs, OEM batches, masters and settings.</li>
        <li><b>Billing:</b> your plan, payment amounts and the payment reference from Razorpay. Card and bank details are entered on Razorpay's own window; we never receive them.</li>
        <li><b>Connected apps:</b> if you connect Zoho Books, the access keys are stored encrypted and are never included in any backup or download.</li>
      </ul>

      <h2>Who can reach your data, and why</h2>
      <p><b>Your own team.</b> Only people your Admin invites can sign in, each with a password and an authenticator code (or a one-time recovery code). Roles limit what each person can do.</p>
      <p><b>Other companies on TrackMyRMA.</b> No. Every request is checked against the signed-in company, and each company's records are in a separate database.</p>
      <p><b>TrackMyRMA support.</b> Our console shows your company name, plan, logins and the number of records you have, so we can manage your account. It does not show your RMAs, customers, photos or PDFs. Downloading them from the console only works while your Admin has turned on support access (Settings › Privacy &amp; data, for 24 hours). Each such download is listed for your Admins.</p>
      <p><b>To be fully open:</b> like every online service, the people who run the servers can technically reach the stored data, and we keep the key needed to restore backups. That is why we bind ourselves to the rules on this page and record access where the software can. We open your data only to run the service, to restore it after a mistake or failure, when you ask for help, or when Indian law requires it; in the last case we will tell you unless the law forbids it.</p>

      <h2>Backups</h2>
      <ul>
        <li><b>Backups you control:</b> Admins can download a full backup and choose emailed data backups (weekly, daily or off). Emailed backups go only to the addresses your Admin sets; once in those mailboxes they are under your control.</li>
        <li><b>Nightly backup by us:</b> every night a copy of each company's data, photos and PDFs is saved to separate backup storage (Backblaze B2), encrypted with AES-256 before it leaves our servers. It is used only to restore data after a mistake or failure.</li>
        <li><b>How long:</b> daily copies for 30 days, plus one copy a month for 12 months. A photo or file you delete stays in backup storage for 12 months, then is removed. When a company is deleted, its backup copies are removed within 30 days; older monthly copies of the company list (company name and login emails) expire within 12 months.</li>
      </ul>

      <h2>Your customers' data</h2>
      <p>The details you enter about your own customers are yours. You decide what to record and you are responsible for having a reason to hold it. We act on your instructions: we store it, show it to your team, and send the RMA status emails and links you choose to send. Customer status pages show only that one RMA's progress and your contact details, through a private link that cannot be guessed.</p>

      <h2>Service providers we use</h2>
      <ul>
        <li><b>Cloudflare</b>: runs the app and stores the databases and files.</li>
        <li><b>Backblaze</b>: stores the encrypted nightly backups.</li>
        <li><b>Resend</b>: delivers the app's emails (invites, reminders, backups, customer status emails).</li>
        <li><b>Razorpay</b>: takes online payments.</li>
        <li><b>Zoho Books</b>: only if your Admin connects it.</li>
      </ul>
      <p>These providers may store data in data centres outside India.</p>

      <h2>How long we keep data</h2>
      <ul>
        <li>While your plan is active, your data is kept until you delete it.</li>
        <li>After a free trial ends, data is kept for 60 days; after that it may be deleted.</li>
        <li>You can ask us to delete your company and all its data at any time; backups then expire as described above.</li>
      </ul>

      <h2>Your choices</h2>
      <ul>
        <li>Download all your data at any time (Settings › Backups).</li>
        <li>Keep support access off; turn it on only when you want our help with your data.</li>
        <li>Ask us to correct or delete data, or to explain anything here: <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.</li>
      </ul>

      <h2>Security</h2>
      <p>All traffic is encrypted (HTTPS). Sign-in needs a password and an authenticator code; sessions end after a period of inactivity your Admin sets. Passwords are hashed, 2FA secrets and connected-app keys are encrypted. No system is perfectly secure; if we learn of a breach affecting your data we will tell your Admins promptly.</p>

      <h2>Grievances</h2>
      <p>Grievance officer: Sanjay Batra, Infinite Solutions, New Delhi. Email <a href={`mailto:${CONTACT}`}>{CONTACT}</a>. We aim to reply within 7 working days.</p>

      <h2>Changes</h2>
      <p>If we change this policy in a way that affects how your data is used, we will email your Admins before the change takes effect.</p>
    </article>
  );
}

function Terms() {
  return (
    <article>
      <h1>Terms of service</h1>
      <p className="muted">Last updated {UPDATED}</p>
      <p>These terms are between Infinite Solutions, New Delhi, India (“we”), which provides TrackMyRMA, and the company that signs up (“you”). By using TrackMyRMA you agree to them.</p>

      <h2>1. The service</h2>
      <p>TrackMyRMA is online software for managing RMAs, OEM claims, care packs and related records. We may improve or change features over time; we will not remove a core feature you rely on without notice.</p>

      <h2>2. Accounts</h2>
      <ul>
        <li>Your Admin controls who has a login and what role they have. You are responsible for what happens under your logins.</li>
        <li>Keep passwords and authenticator devices safe, and tell us at once if you think a login is misused.</li>
      </ul>

      <h2>3. Your data</h2>
      <ul>
        <li>You own the data you put into TrackMyRMA. You give us permission only to store, process, back up and transmit it to provide the service.</li>
        <li>We handle it as described in our <a href="/privacy">Privacy policy</a>. In particular, our support downloads your data only while your Admin has turned on support access, and every such download is shown to your Admins.</li>
        <li>You are responsible for having the right to hold your customers' details and for the messages you choose to send them.</li>
        <li>You can export all your data at any time, including after your plan ends, while it is still kept.</li>
      </ul>

      <h2>4. Acceptable use</h2>
      <p>Do not use the service for anything unlawful, to send spam, to upload malicious files, or to try to reach another company's data or break the service's security.</p>

      <h2>5. Trial, plans and payment</h2>
      <ul>
        <li>The free trial lasts 30 days. Afterwards the app is read-only for 7 days, then sign-in stops until a plan is bought. Trial data is kept for 60 days after the trial ends.</li>
        <li>Plans are paid in advance, monthly or yearly, plus GST. Prices are shown on the Plan &amp; billing page. Access is extended when the payment is confirmed.</li>
        <li>Payments are not refundable except where the law requires or we agree in writing.</li>
      </ul>

      <h2>6. Availability and backups</h2>
      <p>We work to keep the service available and keep nightly backups, but we do not promise it will never be interrupted or that no data can ever be lost. Keep your own copy of important data using Settings › Backups.</p>

      <h2>7. Liability</h2>
      <p>The service is provided “as is”. To the extent the law allows, we are not liable for indirect or consequential losses, and our total liability for any claim is limited to the fees you paid us in the 12 months before the claim.</p>

      <h2>8. Ending the service</h2>
      <p>You can stop using TrackMyRMA at any time and ask us to delete your data. We may suspend an account for non-payment or misuse after notice. Before deleting data we will give your Admins a chance to download it, except where the law requires otherwise.</p>

      <h2>9. Law</h2>
      <p>These terms are governed by the laws of India. Courts in New Delhi have jurisdiction.</p>

      <h2>10. Contact</h2>
      <p><a href={`mailto:${CONTACT}`}>{CONTACT}</a></p>
    </article>
  );
}
