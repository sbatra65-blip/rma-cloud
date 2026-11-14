# Walks a fictional service centre ("Sharma Printer Care") through TrackMyRMA on a FRESH local database and saves:
#   <out>/frames/NNN.jpg  1920x1080 frames for the tutorial video, with <out>/timeline.json (captions, highlight boxes)
#   <out>/img/<name>.jpg  pictures for the user guide (full screen or cropped to a panel / dialog)
# All names, emails, serials and documents are made up. Needs the local mail stand-in (scripts/mail-mock.mjs on 8797)
# and wrangler dev started with RESEND_API=http://127.0.0.1:8797 and a dummy RESEND_API_KEY.
# Usage: python3 scripts/guide/capture.py <base_url> <assets_dir> <out_dir>
import base64, hashlib, hmac, json, os, re, struct, sys, time, datetime, urllib.request
from PIL import Image
from playwright.sync_api import sync_playwright

BASE, ASSETS, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
FR, IMG = f'{OUT}/frames', f'{OUT}/img'
os.makedirs(FR, exist_ok=True); os.makedirs(IMG, exist_ok=True)
MAIL = 'http://127.0.0.1:8797'
SCALE = 1.2  # 1600x900 viewport → 1920x1080 pictures
PW = 'Bright-Harbour-6152!'
used = {}
timeline = []
chapter = ['']
TODAY = datetime.date.today().isoformat()

def totp(secret):
    key = base64.b32decode(secret + '=' * (-len(secret) % 8))
    while True:
        now = int(time.time() // 30)
        c = max(now, used.get(secret, -1) + 1)
        if c <= now + 1:
            used[secret] = c
            break
        time.sleep(2)
    mac = hmac.new(key, struct.pack('>Q', c), hashlib.sha1).digest()
    o = mac[-1] & 15
    return str((struct.unpack('>I', mac[o:o + 4])[0] & 0x7fffffff) % 1000000).zfill(6)

def mails():
    return json.loads(urllib.request.urlopen(f'{MAIL}/__mail').read())

def mail_html(i):
    return urllib.request.urlopen(f'{MAIL}/__mail/{i}.html').read().decode()

def A(name):
    return os.path.join(ASSETS, name)

def ch(title):
    chapter[0] = title
    print('==', title)

def box_of(page, target):
    if target is None:
        return None
    loc = page.locator(target) if isinstance(target, str) else target
    try:
        loc.first.scroll_into_view_if_needed(timeout=3000)
        b = loc.first.bounding_box()
    except Exception:
        return None
    if not b:
        return None
    return [round(b['x'] * SCALE), round(b['y'] * SCALE), round(b['width'] * SCALE), round(b['height'] * SCALE)]

def frame(page, caption, target=None, hold=3.2, img=None, crop=None, pad=24, click=False):
    """Save one video frame (+ optional guide picture). target = what to point at; crop = what the guide picture shows."""
    page.wait_for_timeout(350)
    box = box_of(page, target)
    n = len(timeline)
    path = f'{FR}/{n:03d}.jpg'
    page.screenshot(path=path, type='jpeg', quality=92)
    timeline.append({'chapter': chapter[0], 'caption': caption, 'file': os.path.basename(path), 'box': box, 'hold': hold, 'click': click})
    if img:
        im = Image.open(path)
        if crop is not None:
            cb = box_of(page, crop)
            if cb:
                page.screenshot(path=path + '.tmp.jpg', type='jpeg', quality=92)
                im = Image.open(path + '.tmp.jpg')
                x, y, w, h = cb
                p = round(pad * SCALE)
                im = im.crop((max(0, x - p), max(0, y - p), min(im.width, x + w + p), min(im.height, y + h + p)))
                os.remove(path + '.tmp.jpg')
        im.convert('RGB').save(f'{IMG}/{img}.jpg', 'JPEG', quality=84, optimize=True)
    return box

def point(page, caption, target, hold=2.6, img=None, crop=None):
    """Frame that points at a button before it is clicked."""
    return frame(page, caption, target, hold=hold, img=img, crop=crop, click=True)

def full(page, name):
    """Full-page guide picture (not a video frame)."""
    page.wait_for_timeout(300)
    page.screenshot(path=f'{IMG}/{name}.png', full_page=True)
    im = Image.open(f'{IMG}/{name}.png').convert('RGB')
    os.remove(f'{IMG}/{name}.png')
    im.save(f'{IMG}/{name}.jpg', 'JPEG', quality=82, optimize=True)

def pick(sel, text):
    """Choose the option whose text contains `text`."""
    v = sel.evaluate("(s, t) => { const o = [...s.options].find(o => o.text.includes(t)); return o ? o.value : null }", text)
    sel.select_option(v)

HIDE_DEV = """for (const el of document.querySelectorAll('a,button')) if (/local test only/i.test(el.textContent)) el.style.display='none';"""

with sync_playwright() as p:
    browser = p.chromium.launch()
    def new_ctx(**kw):
        return browser.new_context(viewport={'width': 1600, 'height': 900}, device_scale_factor=SCALE, accept_downloads=True, **kw)

    # ---- provider's own first-run setup (not filmed) ----
    c0 = new_ctx(); s = c0.new_page()
    s.goto(BASE + '/'); s.wait_for_selector('text=Set up TrackMyRMA')
    s.fill('#cn', 'TrackMyRMA Demo'); s.fill('#ccode', 'DEMO'); s.fill('#nm', 'Demo Provider'); s.fill('#em', 'provider@demo.example')
    s.fill('#npw', PW); s.fill('#npw2', PW); s.click('text=Continue to two-step login')
    s.wait_for_selector('text=Set up two-step login'); s.click('summary')
    sec0 = s.inner_text('.secret').replace(' ', ''); s.fill('#ecode', totp(sec0)); s.click('text=Verify and continue')
    s.wait_for_selector('text=Save your recovery codes'); s.check('input[type=checkbox]'); s.click('text=Open TrackMyRMA'); s.wait_for_selector('.pipe')
    c0.close()

    ctx = new_ctx(); page = ctx.new_page(); page.set_default_timeout(12000)

    # ================= 1. Start the free trial =================
    ch('Start your free trial')
    page.goto(BASE + '/login'); page.wait_for_selector('#cc')
    frame(page, 'Open TrackMyRMA in any browser — computer, tablet or phone.', None, img='login')
    point(page, 'New here? Start a free 30-day trial. No card needed.', 'text=/free trial|Create a new company|Start/i >> nth=0')
    page.goto(BASE + '/signup'); page.wait_for_selector('#su-co')
    page.fill('#su-co', 'Sharma Printer Care'); page.fill('#su-code', 'SPC'); page.fill('#su-name', 'Rohit Sharma')
    page.fill('#su-email', 'rohit@sharmaprintercare.example'); page.fill('#su-phone', '9810000000')
    frame(page, 'Enter your company name, a short company code, your name and work email.', '#su-co', img='signup', crop='form')
    point(page, 'Press Create my company.', 'button:has-text("Create my company")')
    page.click('button:has-text("Create my company")'); page.wait_for_selector('text=/Check your email|Your company is ready/')
    page.evaluate(HIDE_DEV)
    frame(page, 'Done. A setup link is emailed to you, and you become the Admin.', 'text=/Check your email/', img='signup-done', crop='main')
    link = re.search(r'href="([^"]*invite#token=[^"]+)"', mail_html(len(mails()) - 1)).group(1).replace('&amp;', '&')

    page.goto(link); page.wait_for_selector('#npw')
    page.fill('#npw', PW); page.fill('#npw2', PW)
    frame(page, 'Open the link from the email and choose a strong password.', '#npw', img='set-password', crop='form')
    page.click('text=Continue to two-step login'); page.wait_for_selector('text=Set up two-step login')
    frame(page, 'Scan the QR code with Google Authenticator, Microsoft Authenticator or similar.', 'canvas, svg.qr, img[alt*="QR"], .qr', img='twostep', crop='form')
    page.click('summary'); secret = page.inner_text('.secret').replace(' ', '')
    page.fill('#ecode', totp(secret))
    point(page, 'Type the 6-digit code from the app and verify.', 'text=Verify and continue')
    page.click('text=Verify and continue'); page.wait_for_selector('text=Save your recovery codes')
    frame(page, 'Save your recovery codes somewhere safe. Each one works once if you lose your phone.', None, img='recovery-codes')
    page.check('input[type=checkbox]'); page.click('text=Open TrackMyRMA'); page.wait_for_selector('.pipe'); page.wait_for_timeout(900)
    frame(page, 'You are in. This is your dashboard — empty for now.', '.pipe', img='dashboard-empty')

    # ================= 2. Company settings =================
    ch('Company settings')
    page.goto(BASE + '/settings'); page.wait_for_selector('text=Company logo')
    page.set_input_files('input[type=file][accept^="image/png"]', A('logo.png'))
    page.wait_for_selector('.logo-preview img.companylogo')
    page.get_by_label('Contact person').fill('Rohit Sharma')
    page.get_by_label('Email', exact=True).first.fill('service@sharmaprintercare.example')
    page.get_by_label('Phone', exact=True).first.fill('011 4000 1234')
    page.get_by_label('City').first.fill('New Delhi')
    page.get_by_label('Address').first.fill('Plot 21, Okhla Industrial Area Phase II, New Delhi 110020')
    frame(page, 'Company settings: upload your logo and fill in your contact details. They appear on printouts and customer emails.', '.logo-preview', img='settings-company')
    to = page.get_by_label(re.compile(r'^To\*?$')).first
    to.fill('rma@oem-service.example')
    frame(page, 'Email to the OEM: who receives RMA emails, and the message. {{FIELDS}} fill in from each RMA.', to, img='settings-oem-email')
    page.locator('text=OEM Excel form').scroll_into_view_if_needed()
    frame(page, 'OEM Excel form: the built-in TSC form, or upload your OEM\'s own template with @@MARKS@@.', 'text=OEM Excel form', img='settings-excel')
    page.locator('text=Customer status updates').scroll_into_view_if_needed()
    frame(page, 'Customer status updates: customers get an email with a private link at every step.', 'text=Customer status updates', img='settings-customer-updates')
    page.locator('h2:has-text("Backups")').scroll_into_view_if_needed()
    frame(page, 'Backups: a weekly data backup by email, and a full download with photos and PDFs any time.', 'h2:has-text("Backups")', img='settings-backups')
    point(page, 'Press Save settings.', 'button:has-text("Save settings")')
    page.click('button:has-text("Save settings")'); page.wait_for_timeout(900)

    # ================= 3. Your team =================
    ch('Add your team')
    page.goto(BASE + '/users'); page.wait_for_selector('h1:has-text("Users")')
    point(page, 'Users & security: add the people who will use TrackMyRMA.', 'text=Add user')
    page.click('text=Add user')
    page.fill('dialog input[type=text]', 'Amit Verma'); page.fill('dialog input[type=email]', 'amit@sharmaprintercare.example')
    try:
        page.locator('dialog select').first.select_option(label='Technician')
    except Exception:
        pass
    frame(page, 'Name, email and role. Technicians raise and update RMAs; Managers also run masters, import and reports.', 'dialog[open] .dlg', img='add-user', crop='dialog[open] .dlg')
    page.click('text=Add and send invite'); page.wait_for_selector('dialog >> text=Invite ready')
    frame(page, 'An invite is emailed. They set their own password and two-step login.', 'dialog[open] .dlg', img='invite-ready', crop='dialog[open] .dlg')
    page.click('dialog >> [aria-label=Close]')
    page.locator('text=Auto sign-out').scroll_into_view_if_needed()
    frame(page, 'Auto sign-out after a set time without activity keeps shared computers safe.', 'text=Auto sign-out', img='users')

    # ================= 4. Masters =================
    ch('Masters')
    page.goto(BASE + '/masters'); page.wait_for_selector('h1:has-text("Masters")')
    page.click('role=tab[name=/OEMs/]'); page.click('text=Add OEM')
    page.locator('dialog input').nth(0).fill('TSC'); page.locator('dialog input').nth(1).fill('TSC Auto ID')
    frame(page, 'Masters → OEMs: add each brand you service.', 'dialog[open] .dlg', img='master-oem', crop='dialog[open] .dlg')
    page.click('dialog >> text=Save'); page.wait_for_selector('.mrow >> text=TSC Auto ID')
    for code, name in [('PTX', 'Printronix'), ('HON', 'Honeywell')]:
        page.click('text=Add OEM'); page.locator('dialog input').nth(0).fill(code); page.locator('dialog input').nth(1).fill(name)
        page.click('dialog >> text=Save'); page.wait_for_selector(f'.mrow >> text={name}')
    page.click('role=tab[name=/Products/]')
    for oem, code, name in [('TSC Auto ID', 'DESKTOP', 'Desktop printers'), ('TSC Auto ID', 'INDUSTRIAL', 'Industrial printers'), ('Printronix', 'LINEMATRIX', 'Line matrix printers')]:
        page.click('text=Add product'); page.locator('dialog select').select_option(label=oem)
        page.locator('dialog input').nth(0).fill(code); page.locator('dialog input').nth(1).fill(name)
        page.click('dialog >> text=Save'); page.wait_for_selector(f'.mrow >> text={name}')
    frame(page, 'Products group models under an OEM.', '.mrow >> nth=0', img='master-products')
    page.click('role=tab[name=/Models/]')
    for prod, cat, code, name in [(1, 'Printer', 'TE310', 'TE310 300 dpi desktop printer'), (1, 'Printer', 'TTP-244 Pro', 'TTP-244 Pro desktop printer'), (2, 'Printer', 'MH261T', 'MH261T industrial printer'), (3, 'Printer', 'P8000', 'P8000 line matrix printer')]:
        page.click('text=Add model'); page.locator('dialog select').first.select_option(index=prod)
        page.get_by_label('Device category').select_option(label=cat)
        page.locator('dialog input').nth(0).fill(code); page.locator('dialog input').nth(1).fill(name)
        if code == 'MH261T':
            frame(page, 'Models: pick the product and device category. Printers get print-head rules and device history.', 'dialog[open] .dlg', img='master-model', crop='dialog[open] .dlg')
        page.click('dialog >> text=Save'); page.wait_for_selector(f'.mrow >> text={code}')
    frame(page, 'Your models are ready. Typing a model on an RMA now suggests these.', '.mrow >> nth=0', img='master-models')
    page.click('role=tab[name=/^Customers/]'); page.click('text=Add customer')
    page.locator('dialog input').nth(0).fill('Northline Logistics Pvt Ltd')
    page.locator('dialog input').nth(3).fill('Priya Nair'); page.locator('dialog input').nth(4).fill('9876543210')
    page.locator('dialog input[type=email]').first.fill('it@northline.example') if page.locator('dialog input[type=email]').count() else None
    page.locator('dialog input').nth(6).fill('Gurugram')
    frame(page, 'Customers: name, contact person, phone, email and city. New RMAs fill these in for you.', 'dialog[open] .dlg', img='master-customer', crop='dialog[open] .dlg')
    page.click('dialog >> text=Save'); page.wait_for_selector('text=Northline Logistics Pvt Ltd')
    page.click('text=Add customer'); page.locator('dialog input').nth(0).fill('Apex Pharma Distributors')
    page.locator('dialog input').nth(3).fill('Vikram Joshi'); page.locator('dialog input').nth(4).fill('9811122233')
    page.locator('dialog input[type=email]').first.fill('stores@apexpharma.example') if page.locator('dialog input[type=email]').count() else None
    page.locator('dialog input').nth(6).fill('Noida'); page.click('dialog >> text=Save'); page.wait_for_selector('text=Apex Pharma Distributors')

    # import more customers from a spreadsheet
    page.goto(BASE + '/import'); page.wait_for_selector('h1:has-text("Import")')
    page.click('role=tab[name="Customers"]')
    page.set_input_files('input[type=file]', A('customers.csv')); page.wait_for_selector('text=Match columns')
    frame(page, 'Many customers? Import → Customers reads your Excel or CSV. Match the columns…', 'text=Match columns', img='import-customers')
    imp = page.locator('button:has-text("Import")').last
    point(page, '…and import. Existing customers are updated, not duplicated.', imp)
    imp.click(); page.wait_for_timeout(1500)
    page.goto(BASE + '/masters'); page.wait_for_selector('text=Sunrise Garments')
    frame(page, 'All your customers in one list.', '.mrow >> nth=0', img='master-customers')

    # ================= 5. Care packs =================
    ch('Care packs')
    page.goto(BASE + '/care-packs'); page.wait_for_selector('text=No care packs yet')
    point(page, 'Care packs: register printers you sold with an OEM care pack.', 'text=Register care pack >> nth=0')
    page.click('text=Register care pack >> nth=0'); page.wait_for_selector('h1:has-text("Register care pack")')
    page.click('role=tab[name="From invoice PDF"]')
    frame(page, 'Import the sales invoice PDF — or load it from Zoho Books, or type it in.', 'text=Sales invoice PDF', img='cp-register-empty')
    page.set_input_files('input[type=file][accept*="pdf"]', A('sales-invoice-SPC-0118.pdf'))
    page.wait_for_function("() => [...document.querySelectorAll('input')].some(i => i.value === 'SPC/2627/0118')", timeout=20000)
    page.wait_for_timeout(600)
    frame(page, 'The invoice number, date, customer, model, care pack length and serial numbers are read for you. Check them.', 'text=Printer serial numbers', img='cp-register-filled')
    point(page, 'Press Register care pack.', 'text=Register care pack >> nth=-1')
    page.click('text=Register care pack >> nth=-1'); page.wait_for_selector('h1.cp-head')
    cp_url = page.url
    frame(page, 'Registered as Unverified. Next: link your OEM purchase order.', 'text=Link OEM PO', img='cp-detail-new')
    page.click('text=Link OEM PO'); page.wait_for_selector('h1:has-text("Link OEM PO")')
    page.get_by_label('PO number').fill('PO-TSC-2611-07'); page.get_by_label('Vendor (OEM)').fill('TSC Auto ID')
    page.get_by_label('PO serials').fill('T3EA2611001\nT3EA2611002\nT3EA2611003')
    page.click('text=Check against invoice'); page.wait_for_selector('text=All invoice serials are on this PO')
    frame(page, 'Paste the PO serials and check: every printer on the invoice must be on the PO.', 'text=All invoice serials are on this PO', img='cp-po-check')
    page.click('text=/Link PO to/'); page.wait_for_selector('text=All serials on PO')
    page.get_by_label('OEM invoice number').fill('TSC-INV-88214'); page.get_by_label('OEM invoice date').fill(TODAY); page.get_by_label('Amount').fill('450')
    point(page, 'Enter the OEM invoice and save.', 'text=Save OEM invoice')
    page.click('text=Save OEM invoice'); page.wait_for_selector('text=OEM invoice saved')
    page.set_input_files('input[type=file][accept^="application/pdf"]', A('oem-invoice-TSC-88214.pdf'))
    page.wait_for_selector('.flowline span.done:has-text("Verified")')
    page.click('text=Mark paid'); page.wait_for_selector('.pill.ok:has-text("Paid")')
    frame(page, 'With the OEM invoice PDF uploaded the care pack is 100% verified. Mark it paid when you pay the OEM.', '.flowline', img='cp-verified')
    full(page, 'cp-detail-full')
    # a second invoice entered by hand, left unverified
    page.goto(BASE + '/care-packs/new'); page.wait_for_selector('h1:has-text("Register care pack")')
    page.get_by_label('Invoice number').fill('SPC/2627/0124'); page.get_by_label('Sales invoice date').fill(TODAY)
    page.get_by_label('Customer').fill('Apex Pharma Distributors'); page.get_by_label('OEM brand').select_option('TSC Auto ID')
    page.get_by_label('Printer model').fill('MH261T'); page.get_by_label('Care pack length').select_option('5 Year')
    page.get_by_label('Printer serial numbers').fill('S/N: M2AB2611010, M2AB2611011')
    page.click('text=Register care pack >> nth=-1'); page.wait_for_selector('h1.cp-head')
    page.goto(BASE + '/care-packs'); page.wait_for_selector('role=group[name="Care pack status"]')
    frame(page, 'The status buttons show what is still Unverified, PO validated or 100% verified.', 'role=group[name="Care pack status"]', img='cp-list')

    # ================= 6. Raise an RMA =================
    ch('Raise an RMA')
    page.goto(BASE + '/rma/new'); page.wait_for_selector('h1:has-text("New RMA")')
    point(page, 'A customer reports a fault. Press New RMA.', 'a.addbtn')
    pick(page.get_by_label(re.compile(r'^Customer\*?$')), 'Northline Logistics')
    em = page.get_by_label(re.compile(r'^Email\*?$')).first
    if not em.input_value():
        em.fill('it@northline.example')
    page.locator('.suggest input').nth(0).fill('TE31'); page.click('.suggest li >> text=TE310')
    page.get_by_label('Printer serial number').fill('T3EA2611002')
    page.wait_for_timeout(1500)
    frame(page, 'Pick the customer and printer. TrackMyRMA tells you at once that this printer is under a care pack.', 'text=/cover till/ >> nth=0', img='rma-new-cover')
    page.locator('.suggest input').nth(1).fill('Print head')
    page.get_by_label('Faulty part serial number').fill('PH-T310-55821')
    page.get_by_label('TPH mileage (m)').fill('18.4')
    page.get_by_label('Failure description').fill('White vertical lines on every label after about 18 km. Cleaning the head did not help.')
    page.set_input_files('input[type=file]', [A('head-1.jpg'), A('head-2.jpg'), A('head-3.jpg')])
    page.wait_for_selector('.photo img')
    frame(page, 'Enter the faulty part, its serial, mileage and the fault. Add photos — they go into the OEM form too.', '.photo >> nth=0', img='rma-new-filled')
    full(page, 'rma-new-full')
    point(page, 'Press Raise RMA.', 'button:has-text("Raise RMA")')
    page.click('button:has-text("Raise RMA")'); page.wait_for_selector('h1.mono')
    rma_url = page.url; rma_id = rma_url.rstrip('/').split('/')[-1]
    page.wait_for_timeout(700)
    frame(page, 'The RMA gets its number, and the customer is emailed a private status link.', '.nextstep', img='rma-detail-open')
    full(page, 'rma-detail-full')

    # two more RMAs so lists look real
    for cust, model, sn, part, fault in [('Apex Pharma Distributors', 'MH261T', 'M2AB2611010', 'Platen roller', 'Labels skew to the left; roller worn.'),
                                        ('Sunrise Garments', 'TTP-244 Pro', 'T2PS2509876', 'Main board', 'Printer does not power on.')]:
        page.goto(BASE + '/rma/new'); page.wait_for_selector('h1:has-text("New RMA")')
        pick(page.get_by_label(re.compile(r'^Customer\*?$')), cust)
        em = page.get_by_label(re.compile(r'^Email\*?$')).first
        if not em.input_value():
            em.fill('service@customer.example')
        page.locator('.suggest input').nth(0).fill(model); page.keyboard.press('Escape')
        page.get_by_label('Printer serial number').fill(sn)
        page.locator('.suggest input').nth(1).fill(part); page.keyboard.press('Escape')
        page.get_by_label('Failure description').fill(fault)
        page.wait_for_timeout(900)
        page.click('button:has-text("Raise RMA")'); page.wait_for_selector('h1.mono')
    second_url = page.url

    # ================= 7. Send to the OEM =================
    ch('Send it to the OEM')
    page.goto(rma_url); page.wait_for_selector('h1.mono')
    point(page, 'Generate OEM Excel fills your OEM\'s RMA form, photos included.', 'text=Generate OEM Excel')
    with page.expect_download() as dl:
        page.click('text=Generate OEM Excel')
    xl = f'{OUT}/oem-form.xlsx'; dl.value.save_as(xl)
    point(page, 'Email OEM sends the email with the Excel attached, from TrackMyRMA.', 'text=Email OEM')
    page.click('text=Email OEM'); page.wait_for_selector('dialog >> text=Email the OEM')
    frame(page, 'Check the email. Everything is filled in from the RMA.', 'dialog[open] .dlg', img='rma-email-oem', crop='dialog[open] .dlg')
    page.click('dialog >> button:has-text("Send email")'); page.wait_for_timeout(1500)
    if page.locator('dialog[open]').count():
        page.keyboard.press('Escape')
    page.wait_for_selector('.nextstep:has-text("OEM RMA number")')
    point(page, 'When the OEM replies with their RMA number, enter it.', 'text=Enter OEM RMA #')
    page.click('text=Enter OEM RMA #'); page.fill('dialog input[type=text]', 'TSC-RMA-26110457')
    frame(page, 'Type the OEM RMA number.', 'dialog[open] .dlg', img='rma-oem-number', crop='dialog[open] .dlg')
    page.click('dialog >> button:has-text("Save")'); page.wait_for_selector('.st:has-text("OEM RMA Received")')
    page.goto(second_url); page.wait_for_selector('h1.mono')
    page.click('text=/Mark sent to OEM/'); page.click('dialog >> button:has-text("Save")'); page.wait_for_timeout(800)
    page.click('text=Enter OEM RMA #'); page.fill('dialog input[type=text]', 'TSC-RMA-26110462')
    page.click('dialog >> button:has-text("Save")'); page.wait_for_selector('.st:has-text("OEM RMA Received")')

    # ================= 8. OEM batch =================
    ch('Dispatch to the OEM')
    page.goto(BASE + '/batches'); page.wait_for_selector('text=/Ready to dispatch/')
    page.check('text=Select all')
    page.get_by_label('Courier').fill('Blue Dart'); page.get_by_label('Docket / AWB number').fill('BD7712093345')
    page.set_input_files('form input[type=file][accept^="application/pdf"]', A('challan-oem.pdf'))
    frame(page, 'OEM batches: tick the RMAs going in one box, add courier, docket and your delivery challan PDF.', 'text=Select all', img='batch-new')
    with page.expect_download() as dl:
        page.click('text=/Dispatch .* to OEM/')
    page.wait_for_selector('h1.mono:has-text("BATCH-")'); page.wait_for_timeout(800)
    frame(page, 'The packing list downloads and every RMA in the batch moves to Dispatched to OEM.', 'text=Delivery challan', img='batch-detail')

    # ================= 9. Back to the customer =================
    ch('Back to the customer')
    page.goto(rma_url); page.wait_for_selector('h1.mono')
    point(page, 'When the part comes back from the OEM: Goods received from OEM.', 'text=Goods received from OEM')
    page.click('text=Goods received from OEM')
    page.locator('dialog input[type=text]').first.fill('PH-T310-60990')
    frame(page, 'Note the serial of the new part — it shows in the printer\'s device history.', 'dialog[open] .dlg', img='rma-goods-received', crop='dialog[open] .dlg')
    page.click('dialog >> button:has-text("Save")'); page.wait_for_selector('.st:has-text("Goods Received")')
    page.click('text=Dispatched to customer')
    page.get_by_label('Delivery challan number').fill('DC/2627/0342')
    page.set_input_files('dialog input[type=file]', A('challan-customer.pdf'))
    page.get_by_label('Courier / docket number').fill('DTDC D44120987')
    frame(page, 'Dispatched to customer: challan number, the challan PDF and the docket.', 'dialog[open] .dlg', img='rma-dispatch-customer', crop='dialog[open] .dlg')
    page.click('dialog >> button:has-text("Save")'); page.wait_for_selector('.st:has-text("Dispatched to Customer")'); page.wait_for_timeout(1200)
    page.click('role=tab[name=/Photos/]'); page.wait_for_timeout(600)
    frame(page, 'Photos tab: inbound photos, the delivery challan and the OEM batch challan, all on the RMA.', '.photo >> nth=0', img='rma-photos')
    # the customer's view
    tok = page.evaluate(f"fetch('/api/rma/{rma_id}/track').then(r => r.json()).then(d => d.url)")
    c2 = new_ctx(); cp = c2.new_page()
    cp.goto(tok.replace('http://localhost:8787', BASE)); cp.wait_for_selector('.track-steps')
    frame(cp, 'What your customer sees: a private page with the live status — no login.', '.track-steps', img='customer-status')
    c2.close()
    sent = [m for m in mails() if 'it@northline.example' in json.dumps(m['to'])]
    if sent:
        mp = ctx.new_page(); mp.set_content(mail_html(sent[-1]['i']).replace('https://localhost:8787', BASE)); mp.wait_for_timeout(800)
        mp.set_viewport_size({'width': 1600, 'height': 900})
        frame(mp, 'And the email they receive at each step.', 'a >> nth=0', img='customer-email')
        mp.close()
    page.click('text=Close — repaired'); page.click('dialog >> button:has-text("Save")'); page.wait_for_selector('.st:has-text("Closed")')
    frame(page, 'Once the customer confirms: Close — repaired. The RMA is complete.', '.st:has-text("Closed")')
    page.click('role=tab[name=/History/]'); page.wait_for_timeout(500)
    frame(page, 'History: every step with who did it and when.', None, img='rma-history')

    # ================= 10. Daily work =================
    ch('Dashboard, reminders & reports')
    page.goto(BASE + '/'); page.wait_for_selector('.pipe'); page.wait_for_timeout(900)
    frame(page, 'The dashboard shows every step at a glance. Click any step to see those RMAs.', '.pipe', img='dashboard')
    page.fill('input[aria-label="Check printer cover"]', 'T3EA2611001'); page.press('input[aria-label="Check printer cover"]', 'Enter')
    page.wait_for_selector('.notice:has-text("cover till")')
    frame(page, 'Check printer cover: type any serial to see if a care pack covers it.', '.notice:has-text("cover till")', img='dashboard-cover')
    page.goto(BASE + '/rma'); page.wait_for_selector('table.data')
    frame(page, 'RMAs: search and filter every RMA.', 'table.data', img='rma-list')
    page.goto(BASE + '/reminders'); page.wait_for_selector('h1:has-text("Reminders")')
    frame(page, 'Reminders: what is waiting on you. Admins and Managers also get it by email at 9 am.', 'h1', img='reminders')
    page.goto(BASE + '/devices/T3EA2611002'); page.wait_for_timeout(1200)
    frame(page, 'Device history: every RMA for one printer, ready to print or export.', 'main h1', img='device-history')
    page.goto(BASE + '/reports'); page.wait_for_selector('table.data')
    frame(page, 'Reports: filter and export to Excel.', 'text=Export to Excel', img='reports')

    # ================= 11. Backups & privacy =================
    ch('Backups & privacy')
    page.goto(BASE + '/settings#privacy'); page.wait_for_selector('text=TrackMyRMA support access')
    page.locator('#privacy').scroll_into_view_if_needed()
    frame(page, 'Privacy & data: support cannot download your data unless you switch on support access. Every copy is listed.', '#privacy', img='privacy', crop='#privacy')
    page.goto(BASE + '/'); page.wait_for_selector('text=Your data stays private')
    page.locator('.privacy-note').scroll_into_view_if_needed()
    frame(page, 'Your data stays private — and the dashboard says exactly how.', '.privacy-note', img='privacy-note', crop='.privacy-note')
    page.goto(BASE + '/billing'); page.wait_for_selector('h1:has-text("Plan")')
    frame(page, 'Plan & billing: pay online by UPI, card or netbanking when your trial ends.', 'h1', img='billing')
    page.goto(BASE + '/rma/' + rma_id); page.wait_for_selector('h1.mono')
    page.click('.helplink'); page.wait_for_selector('dialog >> text=Help: RMA details')
    frame(page, 'Stuck? "Help on this page" explains every screen.', 'dialog[open] .dlg', img='help-dialog', crop='dialog[open] .dlg')
    page.keyboard.press('Escape')
    full(page, 'rma-detail-closed')

    # ---- phone ----
    ph = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    ph.add_cookies(ctx.cookies()); m = ph.new_page()
    m.goto(BASE + '/'); m.wait_for_selector('.pipe'); m.wait_for_timeout(800); m.screenshot(path=f'{IMG}/phone-dashboard.png')
    m.goto(BASE + '/rma/new'); m.wait_for_selector('h1:has-text("New RMA")'); m.wait_for_timeout(1500); m.screenshot(path=f'{IMG}/phone-new-rma.png')
    m.goto(BASE + '/more'); m.wait_for_selector('h1:has-text("More")'); m.screenshot(path=f'{IMG}/phone-more.png')
    for n in ['phone-dashboard', 'phone-new-rma', 'phone-more']:
        Image.open(f'{IMG}/{n}.png').convert('RGB').save(f'{IMG}/{n}.jpg', 'JPEG', quality=82); os.remove(f'{IMG}/{n}.png')
    ph.close()
    browser.close()

json.dump(timeline, open(f'{OUT}/timeline.json', 'w'), indent=1)
print(len(timeline), 'frames;', len(os.listdir(IMG)), 'guide pictures')
