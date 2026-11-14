// The TrackMyRMA user guide (/help and the PDF manual). Pictures are in public/guide-img/, made by
// scripts/guide/capture.py with an invented demo company ("Sharma Printer Care"): no real customer data.
// Blocks: ['p', text] ['steps', [..]] ['list', [..]] ['img', name, caption, kind?] ['tip', text] ['note', text]
// kind: 'shot' (full screen), 'crop' (a dialog or panel), 'phone'.

export const FEATURES = [
  ['Made for the OEM claim loop', 'Built around how a service centre really works: customer → your bench → OEM → back to the customer, with every step, date and document on one RMA.'],
  ['Your OEM\'s own RMA form, filled for you', 'One click fills the OEM\'s Excel RMA form with the RMA details and photos, and emails it with the attachment. Use the built-in form or upload your OEM\'s template.'],
  ['Care packs checked against the OEM PO', 'Register sales from the invoice PDF or Zoho Books, check every serial against the OEM purchase order, and track the OEM invoice and payment until it is 100% verified.'],
  ['Customers see progress without calling you', 'Each RMA has a private status page and an email at every step — no login for the customer.'],
  ['Device history for every serial', 'Every RMA and every part ever replaced on a printer, with print-head claim limits and care pack cover shown when you type the serial.'],
  ['OEM batches with packing list and challans', 'Send a month\'s RMAs in one box: packing list in Excel, courier and docket, delivery challan PDF on every RMA.'],
  ['Works on the bench', 'Install it on a phone or tablet like an app, take photos of the faulty part and raise the RMA on the spot.'],
  ['Made for India', 'Prices in rupees with GST, payment by UPI, card or netbanking, Zoho Books challans and invoices, IST reminders, day-first dates.'],
  ['Private by design', 'Two-step login for everyone, a separate database for every company, support access only with your Admin\'s permission, encrypted nightly backups and a log of every copy of your data.'],
  ['Simple plans per company', 'Plans are priced per company with a set number of logins, not per user per month. Every plan has every feature.'],
];

export const DIFFERENT = [
  'Most RMA software is made for manufacturers handling their own product returns, or for online shops handling customer returns. TrackMyRMA is made for the service centre or dealer in the middle, who repairs on behalf of the OEM and has to claim from them.',
  'The OEM paperwork is the slow part of warranty work. TrackMyRMA fills the OEM\'s own form, sends the email, groups parts into batches and keeps the OEM RMA number, dates and documents on each RMA.',
  'Care packs (extended warranties) are tracked from your sales invoice through the OEM PO, OEM invoice and payment, so no printer sold with cover is left unregistered with the OEM.',
  'Everything a customer asks — "where is my printer?" — is answered by the status page and emails, without a phone call.',
  'It runs in the browser on any device, with nothing to install or maintain, and your data stays private (see "Privacy and your data").',
];

export const GUIDE = [
  {
    id: 'about', title: 'What TrackMyRMA does',
    blocks: [
      ['p', 'TrackMyRMA keeps every faulty part on one record — an RMA — from the moment a customer reports it until the repaired or replaced part is back with them. It fills your OEM\'s RMA form, keeps the OEM RMA number and dispatch details, reminds you what is waiting, tells your customer where things stand, and tracks printers you sold with OEM care packs.'],
      ['p', 'This guide follows an invented service centre, Sharma Printer Care, through a full month of work. Every name, email and serial number in the pictures is made up.'],
      ['list', [
        'You need: a computer, tablet or phone with a current browser (Chrome, Edge, Safari or Firefox) and internet.',
        'Each person needs their own email address and an authenticator app on their phone (Google Authenticator, Microsoft Authenticator or Authy).',
        'Nothing to install on a server: TrackMyRMA runs online. You can add it to your phone or computer like an app (see "Install as an app").',
      ]],
    ],
  },
  {
    id: 'signup', title: '1. Start your free trial',
    blocks: [
      ['p', 'Open the TrackMyRMA app address in your browser. On the login page choose "Start 30-day free trial". The trial has every feature, up to 3 logins and 50 new RMAs, and needs no card.'],
      ['img', 'login', 'The login page. New companies start a free trial from here.', 'shot'],
      ['steps', [
        'Enter your company name and, if you like, a short company code (letters or numbers, e.g. SPC). Your team types this code when they log in. Leave it blank and one is chosen for you.',
        'Enter your name and work email. You become the Admin of your company.',
        'Press Create my company.',
      ]],
      ['img', 'signup', 'Start your free trial.', 'crop'],
      ['img', 'signup-done', 'A setup link is emailed to you. Note your company code.', 'shot'],
      ['tip', 'No email after a couple of minutes? Look in spam or promotions.'],
    ],
  },
  {
    id: 'first-login', title: '2. Set your password and two-step login',
    blocks: [
      ['steps', [
        'Open the link in the email (it works once, for 7 days) and choose a strong password.',
        'On your phone, open your authenticator app, add an account and scan the QR code. On the same phone? Use "Enter this key in the app instead".',
        'Type the 6-digit code from the app and press Verify and continue.',
        'Save your 10 recovery codes (Download codes, or write them down). Each code lets you in once if you lose your phone. Tick the box and open TrackMyRMA.',
      ]],
      ['img', 'set-password', 'Choose your password.', 'crop'],
      ['img', 'twostep', 'Scan the QR code with your authenticator app.', 'crop'],
      ['img', 'recovery-codes', 'Keep the recovery codes somewhere safe — not only on the same phone.', 'shot'],
      ['img', 'dashboard-empty', 'Your dashboard on day one.', 'shot'],
      ['note', 'Every login needs the company code, email, password and the code from the authenticator app. This protects your customers\' data even if a password leaks.'],
    ],
  },
  {
    id: 'settings', title: '3. Company settings',
    blocks: [
      ['p', 'Admins open Company settings from the left menu (on a phone: More → Company settings). Fill this in once; you can change it any time. Press Save settings at the end of the main form.'],
      ['steps', [
        'Company logo: a PNG with a transparent background looks best. It appears in the app, on printouts and in emails to your customers.',
        'Company details: contact person, email, phone, city and address. Customer emails show these, and replies go to your email.',
        'Email to the OEM: who receives your RMA emails, the subject and the message. Words in {{DOUBLE_BRACES}} are filled in from each RMA.',
        'OEM Excel form: the built-in TSC RMA form, or upload your OEM\'s own Excel form with @@MARKS@@ where each detail goes (for example @@PRINTER_SERIAL@@, @@photo1@@).',
        'Print-head claims: how many print-head RMAs per printer before a reason is asked for.',
        'Customer status updates: email your customer a private status link when an RMA is raised, sent to the OEM, back from the OEM, dispatched and closed.',
        'Backups: a data backup emailed weekly (or daily, or off), and a full download with photos and PDFs any time.',
        'Daily reminder email: a 9 am list for Admins and Managers of RMAs that need a next step.',
      ]],
      ['img', 'settings-company', 'Logo and company details.', 'shot'],
      ['img', 'settings-oem-email', 'The email that goes to your OEM.', 'shot'],
      ['img', 'settings-excel', 'OEM Excel form and print-head rules.', 'shot'],
      ['img', 'settings-customer-updates', 'Customer status updates.', 'shot'],
      ['img', 'settings-backups', 'Backups.', 'shot'],
      ['p', 'Further down: Care packs (OEM PO and payment deadlines, delivery challan text), Zoho Books (connect your organisation to load invoices and create delivery challans), Privacy & data, and "Move data from the old system" for customers of the earlier desktop version.'],
    ],
  },
  {
    id: 'users', title: '4. Add your team',
    blocks: [
      ['steps', [
        'Open Users & security and press Add user.',
        'Enter their name, email and role, then Add and send invite. They get an email to set their own password and two-step login.',
        'Set Auto sign-out: how long without activity before people are signed out (15 minutes by default).',
      ]],
      ['list', [
        'Admin — everything, including users, settings and overriding duplicates.',
        'Manager — RMAs, batches, masters, import and reports.',
        'Technician — raise and update RMAs, photos, OEM email, batches.',
        'Viewer — read only.',
      ]],
      ['img', 'add-user', 'Add a user.', 'crop'],
      ['img', 'invite-ready', 'The invite is emailed; you can also copy the link.', 'crop'],
      ['img', 'users', 'Users & security: logins, roles, who is signed in now, login history.', 'shot'],
      ['tip', 'Someone lost their phone and recovery codes? Use Reset login next to their name: they get a new link to set a password and two-step login again.'],
    ],
  },
  {
    id: 'masters', title: '5. Masters: OEMs, products, models and customers',
    blocks: [
      ['p', 'Masters are the lists the rest of the app uses, so RMA forms fill in quickly and reports group correctly. Set them up in this order.'],
      ['steps', [
        'OEMs: each brand you service, with a short code (e.g. TSC — TSC Auto ID).',
        'Products: groups of models under an OEM (e.g. Desktop printers, Industrial printers).',
        'Models: the model code and name, its product and its device category (Printer, Terminal…). Printers get print-head rules and device history.',
        'Customers: name, contact person, phone, email and city. New RMAs fill these in for you.',
        'Device categories and Care pack types come ready-made; add your own if you need them.',
      ]],
      ['img', 'master-oem', 'Add an OEM.', 'crop'],
      ['img', 'master-products', 'Products under each OEM.', 'shot'],
      ['img', 'master-model', 'Add a model with its device category.', 'crop'],
      ['img', 'master-models', 'Your models.', 'shot'],
      ['img', 'master-customer', 'Add a customer.', 'crop'],
      ['h', 'Import customers from Excel'],
      ['steps', [
        'Open Import → Customers and choose your Excel (.xlsx) or CSV file. The first row must hold the column headings.',
        'Match each of your columns to a field (Name, Contact name, Phone, Email, City…).',
        'Press Import. Customers with the same code or name are updated, not duplicated.',
      ]],
      ['img', 'import-customers', 'Match your columns, then import.', 'shot'],
      ['img', 'master-customers', 'All customers in one list.', 'shot'],
      ['tip', 'Moving from an Excel tracker? Import → RMAs brings old RMAs in the same way; "Check first" shows what will be imported and what is skipped as a duplicate.'],
    ],
  },
  {
    id: 'carepacks', title: '6. Care packs',
    blocks: [
      ['p', 'A care pack is an OEM extended warranty you sell with a printer. TrackMyRMA records each sale, checks every serial against the purchase order you place with the OEM, and follows the OEM invoice and payment until the care pack is 100% verified.'],
      ['h', 'Register from the sales invoice PDF'],
      ['steps', [
        'Open Care packs → Register care pack and choose "From invoice PDF".',
        'Pick your sales invoice PDF (a text PDF from your billing software, not a scan). The invoice number, date, customer, model, OEM, care pack length and serial numbers are read for you.',
        'Check every field and correct anything read wrongly. Serial numbers can be one per line, separated by commas, or with "S/N:" in front — the count is shown as you type.',
        'Press Register care pack. It starts as Unverified.',
      ]],
      ['img', 'cp-register-empty', 'Choose how to register: type it in, from the invoice PDF, or from Zoho Books.', 'shot'],
      ['img', 'cp-register-filled', 'Everything read from the PDF, ready to check.', 'shot'],
      ['img', 'cp-detail-new', 'Registered. Next: link the OEM PO.', 'shot'],
      ['note', 'With Zoho Books connected (Company settings → Zoho Books), choose "From Zoho Books", type the invoice number and press Load invoice. Or "Type it in" for anything else. The same serial can never be registered twice — you are told which invoice already has it.'],
      ['h', 'Link the OEM purchase order'],
      ['steps', [
        'On the care pack, press Link OEM PO.',
        'Enter the PO number and vendor, and paste (or read from a file) the serial numbers on the PO.',
        'Press Check against invoice: you see which serials match, which are missing and which are extra. Then Link PO. One PO can cover several sales invoices.',
      ]],
      ['img', 'cp-po-check', 'Every invoice serial is on the PO.', 'shot'],
      ['h', 'OEM invoice, PDF and payment'],
      ['steps', [
        'Enter the OEM invoice number, date and amount, and Save OEM invoice.',
        'Upload the OEM invoice PDF. With the PO matched, the care pack is now 100% verified.',
        'Press Mark paid when you pay the OEM.',
      ]],
      ['img', 'cp-verified', 'Registered → OEM PO → OEM invoice → PDF → Verified → Paid.', 'shot'],
      ['h', 'The care pack list'],
      ['p', 'The status buttons above the list show how many care packs are Unverified, PO validated, 100% verified or Expired; click one to see only those. Export CSV exports what is shown. "Pending & payments" lists OEM POs, invoices and payments still due.'],
      ['img', 'cp-list', 'Status buttons with counts.', 'shot'],
    ],
  },
  {
    id: 'rma-new', title: '7. Raise an RMA',
    blocks: [
      ['p', 'A customer reports a faulty part. Press New RMA (top left on a computer, the + button on a phone).'],
      ['steps', [
        'Customer: pick from the list, or "+ Add a new customer". Contact details fill in from the customer master. The customer email is required — it is where status updates go.',
        'Device: type the model (suggestions come from your masters) and the printer serial number. If this printer already has RMAs, or is covered by a care pack, you are told straight away.',
        'Faulty part: the part, its serial number, mileage (for print heads) and a clear failure description.',
        'Photos: take photos or choose files — up to 40 photos or PDFs. The first five photos also go into the OEM Excel form.',
        'Press Raise RMA. The RMA gets its number (e.g. SPC-RMA-202611-0001) and, with customer updates on, the customer gets an email with a private status link.',
      ]],
      ['img', 'rma-new-cover', 'Type the serial: care pack cover is shown at once.', 'shot'],
      ['img', 'rma-new-filled', 'Faulty part, failure and photos.', 'shot'],
      ['img', 'rma-detail-open', 'The new RMA. The "Next step" card always tells you what to do now.', 'shot'],
      ['tip', 'Two faulty parts on one printer? Add another faulty part on the same form, or later use "Another part, same device" on the RMA — each part gets its own RMA number and OEM form.'],
    ],
  },
  {
    id: 'rma-oem', title: '8. Send it to the OEM',
    blocks: [
      ['steps', [
        'Generate OEM Excel: your OEM\'s RMA form, filled with this RMA\'s details and photos. Download or Share it.',
        'Email OEM: the email from Company settings, filled in, with the Excel attached. Replies go to your company email.',
        'Emailing from your own mailbox instead? Use Copy email text, then Mark sent to OEM.',
        'When the OEM replies with their RMA number, press Enter OEM RMA # and type it.',
      ]],
      ['img', 'rma-email-oem', 'Email the OEM with the form attached.', 'crop'],
      ['img', 'rma-oem-number', 'Enter the OEM RMA number.', 'crop'],
    ],
  },
  {
    id: 'rma-batch', title: '9. Dispatch to the OEM in a batch',
    blocks: [
      ['p', 'RMAs with an OEM RMA number are ready to go to the OEM. Most service centres send them together, for example in the last week of the month.'],
      ['steps', [
        'Open OEM batches. "Ready to dispatch" lists the RMAs waiting.',
        'Tick the RMAs going in this box (or Select all), and enter the dispatch date, courier and docket / AWB number.',
        'Attach your delivery challan PDF (optional) — it is kept on the batch and shown on every RMA in it.',
        'Press Dispatch to OEM. The packing list (Excel) downloads, and every RMA moves to "Dispatched to OEM".',
      ]],
      ['img', 'batch-new', 'Pick the RMAs and add courier details and challan.', 'shot'],
      ['img', 'batch-detail', 'The batch: packing list, challan PDF and the RMAs in it.', 'shot'],
      ['tip', '"Add to OEM batch" on an RMA takes you straight to OEM batches.'],
    ],
  },
  {
    id: 'rma-back', title: '10. Back from the OEM, to the customer, closed',
    blocks: [
      ['steps', [
        'Goods received from OEM: when the repaired or replacement part arrives. Enter the serial of the part received — it shows in the printer\'s device history.',
        'Dispatched to customer: dispatch date, delivery challan number and date, the challan PDF (optional) and the courier / docket number. With Zoho Books connected you can create the delivery challan in Zoho from here; its PDF is attached for you.',
        'Close — repaired once the customer confirms. Use Close — returned to customer if the OEM rejected the claim or the goods went back unrepaired.',
      ]],
      ['img', 'rma-goods-received', 'Goods received from the OEM.', 'crop'],
      ['img', 'rma-dispatch-customer', 'Dispatch to the customer with the challan PDF.', 'crop'],
      ['img', 'rma-photos', 'Photos tab: inbound photos, outbound documents and the OEM batch challan.', 'shot'],
      ['img', 'rma-history', 'History: every change, who made it and when — including each customer email.', 'shot'],
    ],
  },
  {
    id: 'customer-view', title: '11. What your customer sees',
    blocks: [
      ['p', 'With customer status updates on, your customer gets an email at each step with a "See live status" button. The status page shows only that one RMA — its steps, item, serial and docket — with your name, logo and contact buttons. No login is needed, and the link cannot be guessed.'],
      ['img', 'customer-email', 'The email your customer receives.', 'shot'],
      ['img', 'customer-status', 'The private status page.', 'shot'],
      ['tip', 'To send the link again (or to someone else at the customer), use Send tracking email on the RMA.'],
    ],
  },
  {
    id: 'daily', title: '12. Everyday screens',
    blocks: [
      ['h', 'Dashboard'],
      ['p', 'Open RMAs at each step (click a step to see them), what needs your next step, recently updated RMAs, customer and care pack stats, and "Check printer cover" for any serial.'],
      ['img', 'dashboard', 'The dashboard.', 'shot'],
      ['img', 'dashboard-cover', 'Check printer cover: is this serial under a care pack?', 'shot'],
      ['h', 'RMAs'],
      ['p', 'Search by RMA number, serial, customer or OEM RMA number; filter by stage and device. "Active only" hides RMAs already dispatched to the customer or closed. Tick several RMAs to close them together.'],
      ['img', 'rma-list', 'The RMA list.', 'shot'],
      ['h', 'Reminders'],
      ['p', 'Everything waiting on you: RMAs to send, OEMs to chase, parts to dispatch, care pack POs and payments due. Admins and Managers also get this list by email at 9 am.'],
      ['img', 'reminders', 'Reminders.', 'shot'],
      ['h', 'Device history'],
      ['p', 'Type a serial number to see every RMA for that printer, parts returned and parts fitted, with care pack cover. Print it or download it to Excel.'],
      ['img', 'device-history', 'Device history for one printer.', 'shot'],
      ['h', 'Reports'],
      ['p', 'Filter RMAs by customer, date range and status, see the totals, and export to Excel.'],
      ['img', 'reports', 'Reports.', 'shot'],
    ],
  },
  {
    id: 'privacy', title: '13. Backups and privacy',
    blocks: [
      ['list', [
        'Settings → Backups: choose emailed data backups (weekly by default) and download a full backup with photos and PDFs any time.',
        'Every night an encrypted copy of your data is also kept in separate backup storage, used only to restore your data after a mistake or failure.',
        'Settings → Privacy & data: TrackMyRMA support cannot download your data from their console unless your Admin turns on support access. It switches itself off after 24 hours.',
        'Data activity lists every copy made of your data: your backups, the nightly backup and any support download.',
      ]],
      ['img', 'privacy', 'Privacy & data: support access and data activity.', 'crop'],
      ['img', 'privacy-note', 'The dashboard explains how your data is protected.', 'crop'],
      ['p', 'The full Privacy policy and Terms of service are linked at the bottom of the login page.'],
    ],
  },
  {
    id: 'billing', title: '14. Plan and billing',
    blocks: [
      ['p', 'Admins open Plan & billing to see the current plan, when access ends, and to buy or renew. Pick monthly or yearly (yearly costs 10 months), choose a plan and pay by UPI, card, netbanking or wallet. Access is extended as soon as the payment goes through, and renewing early adds the time after your current end date.'],
      ['img', 'billing', 'Plan & billing.', 'shot'],
      ['note', 'After the trial ends the app is read-only for 7 days, so you can still see and export everything while you decide.'],
    ],
  },
  {
    id: 'install', title: 'Install as an app (phone, tablet, computer)',
    blocks: [
      ['list', [
        'Android (Chrome): open TrackMyRMA, tap ⋮ → Install app (or Add to Home screen).',
        'iPhone / iPad (Safari): tap Share → Add to Home Screen.',
        'Windows / Mac (Chrome or Edge): click the install icon at the right of the address bar, or ⋮ → Install TrackMyRMA.',
      ]],
      ['p', 'It opens full screen like an app, the camera button takes photos straight into an RMA, and the bottom bar gives Home, RMAs, New, Reminders and More.'],
      ['imgrow', ['phone-dashboard', 'phone-new-rma', 'phone-more'], 'On a phone: dashboard, new RMA, and the More menu.'],
    ],
  },
  {
    id: 'help', title: 'Help inside the app',
    blocks: [
      ['p', 'On every screen, "Help on this page" (left menu on a computer, the ? button on a phone) explains what the screen is for and the steps, with a link to the matching part of this guide.'],
      ['img', 'help-dialog', 'Help for the RMA screen.', 'crop'],
    ],
  },
  {
    id: 'faq', title: 'Questions',
    blocks: [
      ['qa', 'I lost my phone with the authenticator app.', 'Log in with one of your recovery codes instead of the 6-digit code. To use a new phone, ask your Admin for Reset login: you get a link to set a new password and scan a new QR code.'],
      ['qa', 'I forgot my password.', 'Use "Forgot password?" on the login page. A reset link is emailed to you.'],
      ['qa', 'The PDF import read nothing.', 'The PDF is probably a scan (a picture). Use "Type it in", or export a text PDF from your billing software.'],
      ['qa', 'The OEM gave one RMA number for several parts.', 'Enter it on each RMA; you are asked to confirm that the same number is used again.'],
      ['qa', 'A customer says they did not get the status email.', 'Check the customer email on the RMA, then use Send tracking email. Ask them to look in spam.'],
      ['qa', 'Can my team use it on their own phones?', 'Yes. Each person has their own login; give Technicians the Technician role.'],
      ['qa', 'How do I get my data out?', 'Company settings → Backups → Download full backup gives a ZIP with every table as a CSV (opens in Excel), data.json, photos and PDFs.'],
    ],
  },
];
