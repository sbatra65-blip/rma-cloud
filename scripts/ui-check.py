# Walk through the app in a phone-sized browser (and a desktop one) and save screenshots.
# Needs a FRESH database: rm -rf .wrangler/state, then `npm run build && npx wrangler dev`.
# Usage: python3 scripts/ui-check.py [base_url] [out_dir]
import base64, hashlib, hmac, struct, sys, time, os, io, zipfile, re
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:8787'
OUT = sys.argv[2] if len(sys.argv) > 2 else 'shots'
CHROME = os.environ.get('CHROME', '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome')
os.makedirs(OUT, exist_ok=True)
used = {}

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

def make_jpeg(path, color):
    from PIL import Image, ImageDraw
    im = Image.new('RGB', (1200, 900), color)
    d = ImageDraw.Draw(im)
    for i in range(0, 1200, 60):
        d.line([(i, 0), (i, 900)], fill=(255, 255, 255), width=3)
    im.save(path, 'JPEG', quality=85)

errors = []
checks = []
def ok(cond, name):
    checks.append((bool(cond), name))
    print(('  ✓ ' if cond else '  ✗ ') + name)

photo1, photo2 = f'{OUT}/p1.jpg', f'{OUT}/p2.jpg'
make_jpeg(photo1, (180, 60, 40)); make_jpeg(photo2, (40, 90, 160))
photo3, photo4 = f'{OUT}/p3.jpg', f'{OUT}/p4.jpg'
make_jpeg(photo3, (40, 140, 80)); make_jpeg(photo4, (120, 60, 160))
PW = 'Sturdy-Lamp-4821!'

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=CHROME)
    ctx = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True, accept_downloads=True)
    page = ctx.new_page()
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    page.on('pageerror', lambda e: errors.append(str(e)))

    # ---- first-run setup ----
    page.goto(BASE + '/')
    page.wait_for_selector('text=Set up RMA Cloud')
    page.screenshot(path=f'{OUT}/01-setup.png', full_page=True)
    page.fill('#cn', 'Infinite Solutions')
    page.fill('#ccode', 'INF')
    page.fill('#nm', 'Sanjay Batra')
    page.fill('#em', 'sanjay@example.com')
    page.fill('#npw', PW)
    page.fill('#npw2', PW)
    page.click('text=Continue to two-step login')
    page.wait_for_selector('text=Set up two-step login')
    page.click('summary')
    secret = page.inner_text('.secret').replace(' ', '')
    page.screenshot(path=f'{OUT}/02-2fa.png', full_page=True)
    page.fill('#ecode', totp(secret))
    page.click('text=Verify and continue')
    page.wait_for_selector('text=Save your recovery codes')
    page.screenshot(path=f'{OUT}/03-codes.png', full_page=True)
    page.check('input[type=checkbox]')
    page.click('text=Open RMA Cloud')
    page.wait_for_selector('.track')
    page.wait_for_timeout(600)
    ok(True, 'setup → 2FA → dashboard')
    page.screenshot(path=f'{OUT}/04-dashboard-empty.png', full_page=True)

    # ---- masters: one customer, OEM, product, model ----
    page.goto(BASE + '/masters')
    page.click('text=Add customer')
    page.locator('dialog input').nth(0).fill('Acme Logistics Pvt Ltd')
    page.locator('dialog input').nth(3).fill('Ravi Kumar')
    page.locator('dialog input').nth(4).fill('9810012345')
    page.locator('dialog input').nth(6).fill('Gurugram')
    page.click('dialog >> text=Save')
    page.wait_for_selector('text=Acme Logistics Pvt Ltd')
    page.click('role=tab[name=/OEMs/]')
    page.click('text=Add OEM')
    page.locator('dialog input').nth(0).fill('TSC')
    page.locator('dialog input').nth(1).fill('TSC Auto ID')
    page.click('dialog >> text=Save')
    page.wait_for_selector('.mrow >> text=TSC Auto ID')
    page.click('role=tab[name=/Products/]')
    page.click('text=Add product')
    page.locator('dialog select').select_option(label='TSC Auto ID')
    page.locator('dialog input').nth(0).fill('DESKTOP')
    page.locator('dialog input').nth(1).fill('Desktop printers')
    page.click('dialog >> text=Save')
    page.wait_for_selector('.mrow >> text=Desktop printers')
    page.click('role=tab[name=/Models/]')
    page.click('text=Add model')
    page.locator('dialog select').select_option(index=1)
    page.locator('dialog input').nth(0).fill('TE310')
    page.locator('dialog input').nth(1).fill('TE310 300 dpi desktop')
    page.click('dialog >> text=Save')
    page.wait_for_selector('.mrow >> text=TE310')
    ok(True, 'masters: customer, OEM, product, model')

    # ---- new RMA with photos ----
    page.goto(BASE + '/rma/new')
    page.wait_for_selector('h1:has-text("New RMA")')
    page.click('text=Raise RMA')
    page.wait_for_selector('.formerror')
    page.screenshot(path=f'{OUT}/05-new-rma-errors.png', full_page=True)
    page.locator('.suggest input').nth(0).fill('acme')
    page.click('.suggest li >> text=Acme Logistics Pvt Ltd')
    page.locator('.suggest input').nth(1).fill('TE3')
    page.click('.suggest li >> text=TE310')
    page.get_by_label('Product serial number').fill('tebt 25370458')
    page.locator('.suggest input').nth(2).fill('Head')
    page.get_by_label('Faulty part serial number').fill('H-1001')
    page.get_by_label('TPH mileage (m)').fill('12.5')
    page.get_by_label('Failure description').fill('Vertical white lines across the print after 12 km')
    page.set_input_files('input[type=file]', [photo1, photo2, photo3, photo4])
    page.wait_for_selector('.photo img')
    page.screenshot(path=f'{OUT}/06-new-rma-filled.png', full_page=True)
    page.click('text=Raise RMA')
    page.wait_for_selector('h1.mono')
    no = page.inner_text('h1.mono')
    ok(re.match(r'INF-RMA-\d{6}-0001', no), f'RMA raised: {no}')
    page.screenshot(path=f'{OUT}/07-rma-detail.png', full_page=True)
    rma_url = page.url

    # ---- OEM Excel ----
    with page.expect_download() as dl:
        page.click('text=Generate OEM Excel')
    d = dl.value
    path = f'{OUT}/{d.suggested_filename}'
    d.save_as(path)
    ok(d.suggested_filename == 'TE310_TEBT25370458_Head.xlsx', f'Excel name {d.suggested_filename}')
    z = zipfile.ZipFile(path)
    sst = z.read('xl/sharedStrings.xml').decode('utf-8-sig')
    media = [n for n in z.namelist() if n.startswith('xl/media/rma_photo')]
    drawing = z.read('xl/drawings/drawing1.xml').decode()
    ok('@@PRINTER_MODEL@@' not in sst and 'TEBT25370458' in sst and 'Vertical white lines' in sst, 'Excel: tokens filled')
    ok('@@photo1@@' not in sst and '@@photo3@@' not in sst, 'Excel: photo marks removed')
    ok(len(media) == 4 and drawing.count('RMA photo') == 4, f'Excel: {len(media)} photos embedded')
    try:
        import openpyxl
        wb = openpyxl.load_workbook(path)
        ok(wb['Sheet1']['A26'].value == 'TE310' and wb['Sheet1']['B26'].value == 'TEBT25370458', 'Excel opens in openpyxl, A26/B26 right')
    except Exception as e:
        ok(False, f'openpyxl could not open: {e}')

    # ---- email draft, status steps ----
    page.click('text=Copy email text')
    page.wait_for_selector('dialog >> text=Email text for Zoho Mail')
    body = page.locator('dialog textarea').input_value()
    ok('TE310' in body and 'H-1001' in body, 'email draft filled')
    page.screenshot(path=f'{OUT}/08-email-draft.png', full_page=True)
    page.click('dialog >> [aria-label=Close]')
    page.click('text=Enter OEM RMA #')
    page.fill('dialog input[type=text]', 'TEBT25160178-RMA')
    page.click('dialog >> button:has-text("Save")')
    page.wait_for_selector('.st:has-text("OEM RMA Received")')
    ok(True, 'OEM RMA # entered')
    page.click('role=tab[name=/Photos/]')
    page.screenshot(path=f'{OUT}/09-photos.png', full_page=True)

    # ---- batch ----
    page.goto(BASE + '/batches')
    page.wait_for_selector('text=Ready to dispatch (1)')
    page.check('text=Select all')
    with page.expect_download() as dl:
        page.click('text=/Dispatch 1 to OEM/')
    ok(dl.value.suggested_filename.endswith('_PackingList.xlsx'), f'packing list {dl.value.suggested_filename}')
    page.wait_for_selector('h1.mono:has-text("BATCH-")')
    page.screenshot(path=f'{OUT}/10-batch.png', full_page=True)

    # ---- second RMA: duplicate guard ----
    page.goto(BASE + '/rma/new')
    page.locator('.suggest input').nth(0).fill('Beta Retail')
    page.locator('.suggest input').nth(1).fill('TE310')
    page.get_by_label('Product serial number').fill('TEBT25370458')
    page.locator('.suggest input').nth(2).fill('Platen roller')
    page.get_by_label('Failure description').fill('Roller worn')
    page.wait_for_timeout(900)
    page.screenshot(path=f'{OUT}/11-same-printer-warning.png', full_page=True)
    page.click('text=Raise RMA')
    page.wait_for_selector('h1.mono')

    # ---- list, reminders, reports, import, users, settings, profile ----
    page.goto(BASE + '/rma?open=')
    page.wait_for_selector('.tcard')
    ok(page.locator('.tcard').count() == 2, 'list shows 2 RMAs')
    page.screenshot(path=f'{OUT}/12-list.png', full_page=True)
    page.goto(BASE + '/reminders')
    page.wait_for_selector('h1:has-text("Reminders")')
    page.screenshot(path=f'{OUT}/13-reminders.png', full_page=True)
    page.goto(BASE + '/reports')
    page.wait_for_selector('table.data')
    with page.expect_download() as dl:
        page.click('text=Export to Excel')
    ok(dl.value.suggested_filename.startswith('RMA_Report_INF'), 'report export')

    csv = f'{OUT}/old.csv'
    with open(csv, 'w') as fh:
        fh.write('Ticket No,Printer SN,Model,Customer,Status,Date,OEM RMA\n')
        fh.write('OLD-001,TEBT2200001,TE200,Old Co,Closed,15/03/2025,OLD-1\n')
        fh.write('OLD-002,TEBT2200002,TE210,Old Co,sent to tsc,20-Apr-2025,\n')
    page.goto(BASE + '/import')
    page.set_input_files('input[type=file]', csv)
    page.wait_for_selector('text=Match columns')
    page.screenshot(path=f'{OUT}/14-import-map.png', full_page=True)
    page.click('text=Check first')
    page.wait_for_selector('text=/2 to import/')
    page.click('text=/Import 2 rows/')
    page.wait_for_selector('text=/Imported: 2 to import/')
    ok(True, 'CSV import of 2 old RMAs')

    page.goto(BASE + '/users')
    page.click('text=Add user')
    page.fill('dialog input[type=text]', 'Ravi Technician')
    page.fill('dialog input[type=email]', 'ravi@example.com')
    page.click('text=Add and send invite')
    page.wait_for_selector('dialog >> text=Invite ready')
    invite = page.inner_text('dialog .secret')
    page.screenshot(path=f'{OUT}/15-invite.png', full_page=True)
    page.click('dialog >> [aria-label=Close]')
    page.goto(BASE + '/settings')
    page.wait_for_selector('h1:has-text("Company settings")')
    page.screenshot(path=f'{OUT}/16-settings.png', full_page=True)

    # ---- invited user on another phone ----
    ctx2 = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    p2 = ctx2.new_page()
    p2.on('pageerror', lambda e: errors.append(str(e)))
    p2.goto(invite)
    p2.wait_for_selector('text=Hello Ravi')
    p2.screenshot(path=f'{OUT}/17-invite-accept.png', full_page=True)
    p2.fill('#npw', 'Quiet-River-7731!')
    p2.fill('#npw2', 'Quiet-River-7731!')
    p2.click('text=Continue to two-step login')
    p2.wait_for_selector('text=Set up two-step login')
    p2.click('summary')
    s2 = p2.inner_text('.secret').replace(' ', '')
    p2.fill('#ecode', totp(s2))
    p2.click('text=Verify and continue')
    p2.wait_for_selector('text=Save your recovery codes')
    p2.check('input[type=checkbox]')
    p2.click('text=Open RMA Cloud')
    p2.wait_for_selector('.track')
    ok(p2.locator('a[href="/users"]').count() == 0, 'technician sees no admin menu')
    p2.click('text=Log out') if p2.locator('.topbar [aria-label="Log out"]').count() == 0 else p2.click('.topbar [aria-label="Log out"]')
    p2.wait_for_selector('#cc')
    ok(p2.input_value('#cc') == 'INF', 'company code remembered on login screen')
    p2.fill('#email', 'ravi@example.com')
    p2.fill('#password', 'Quiet-River-7731!')
    p2.click('text=Continue')
    p2.wait_for_selector('.cochip')
    p2.screenshot(path=f'{OUT}/18-login-code.png', full_page=True)
    p2.fill('#code', totp(s2))
    p2.click('button:has-text("Log in")')
    p2.wait_for_selector('.track')
    ok(True, 'technician logs in with company code + password + 2FA')

    # ---- desktop views ----
    ctx3 = browser.new_context(viewport={'width': 1440, 'height': 900}, accept_downloads=True)
    ctx3.add_cookies(ctx.cookies())
    d3 = ctx3.new_page()
    d3.on('pageerror', lambda e: errors.append(str(e)))
    d3.goto(BASE + '/')
    d3.wait_for_selector('.track')
    d3.wait_for_timeout(700)
    d3.screenshot(path=f'{OUT}/20-desktop-dashboard.png', full_page=True)
    d3.goto(BASE + '/rma?open=')
    d3.wait_for_selector('table.data')
    d3.screenshot(path=f'{OUT}/21-desktop-list.png', full_page=True)
    d3.goto(rma_url)
    d3.wait_for_selector('h1.mono')
    d3.screenshot(path=f'{OUT}/22-desktop-detail.png', full_page=True)
    d3.goto(BASE + '/companies')
    d3.wait_for_selector('h1:has-text("Companies")')
    d3.screenshot(path=f'{OUT}/23-desktop-companies.png', full_page=True)
    d3.goto(BASE + '/users')
    d3.wait_for_selector('text=Ravi Technician')
    d3.click('role=tab[name="Login history"]')
    d3.wait_for_selector('table.data')
    d3.screenshot(path=f'{OUT}/24-desktop-loginlog.png', full_page=True)

    # ---- care packs ----
    import datetime
    today = datetime.date.today().isoformat()
    d3.goto(BASE + '/care-packs')
    d3.wait_for_selector('text=No care packs yet')
    d3.click('text=Register care pack >> nth=0')
    d3.wait_for_selector('h1:has-text("Register care pack")')
    d3.click('text=Register care pack >> nth=-1')
    d3.wait_for_selector('.formerror')
    ok(d3.locator('.field.invalid').count() >= 2, 'care pack: empty register shows field errors')
    d3.get_by_label('Invoice number').fill('IS-GST-2627-0042')
    d3.get_by_label('Sales invoice date').fill(today)
    d3.get_by_label('Customer').fill('Acme Logistics Pvt Ltd')
    d3.get_by_label('OEM brand').select_option('TSC Auto ID')
    d3.get_by_label('Printer model').fill('TE310')
    d3.get_by_label('Care pack length').select_option('3 Year')
    d3.get_by_label('Printer serial numbers').fill('S/N: T6EV00001\nT6EV00002, T6EV00003')
    ok(d3.locator('text=3 serials found').count() == 1, 'care pack: live serial count')
    d3.screenshot(path=f'{OUT}/30-cp-register.png', full_page=True)
    d3.click('text=Register care pack >> nth=-1')
    d3.wait_for_selector('h1.cp-head')
    ok('IS-GST-2627-0042' in d3.inner_text('h1.cp-head') and d3.locator('td.mono:has-text("T6EV00002")').count() == 1, 'care pack registered with 3 printers')
    cp_url = d3.url
    d3.click('text=Link OEM PO')
    d3.wait_for_selector('h1:has-text("Link OEM PO")')
    d3.get_by_label('PO number').fill('PO-TSC-778')
    d3.get_by_label('Vendor (OEM)').fill('TSC Auto ID Technology')
    d3.get_by_label('PO serials').fill('T6EV00001 T6EV00002 T6EV00003 T6EV00099')
    d3.click('text=Check against invoice')
    try:
        d3.wait_for_selector('text=All invoice serials are on this PO', timeout=8000)
    except Exception:
        d3.screenshot(path=f'{OUT}/err-po.png', full_page=True)
        print(d3.inner_text('main')[:1500])
        raise
    d3.screenshot(path=f'{OUT}/31-cp-po.png', full_page=True)
    d3.click('text=Link PO to 1 invoice(s)')
    d3.wait_for_selector('text=All serials on PO')
    ok(True, 'care pack: PO linked, serials matched')
    d3.get_by_label('OEM invoice number').fill('TSC-INV-5501')
    d3.get_by_label('OEM invoice date').fill(today)
    d3.get_by_label('Amount').fill('450')
    d3.click('text=Save OEM invoice')
    d3.wait_for_selector('text=OEM invoice saved')
    pdf = f'{OUT}/oem.pdf'
    open(pdf, 'wb').write(b'%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n')
    d3.set_input_files('input[type=file][accept^="application/pdf"]', pdf)
    d3.wait_for_selector('text=OEM invoice PDF saved')
    d3.wait_for_selector('.flowline span.done:has-text("Verified")')
    ok(True, 'care pack: OEM invoice + PDF → verified')
    d3.click('text=Mark paid')
    d3.wait_for_selector('text=Marked as paid')
    d3.wait_for_selector('.pill.ok:has-text("Paid")')
    ok(True, 'care pack: marked paid')
    d3.screenshot(path=f'{OUT}/32-cp-detail.png', full_page=True)
    d3.goto(BASE + '/')
    d3.wait_for_selector('input[aria-label="Check printer cover"]')
    d3.fill('input[aria-label="Check printer cover"]', 't6ev00002')
    d3.press('input[aria-label="Check printer cover"]', 'Enter')
    d3.wait_for_selector('.notice:has-text("cover till")')
    ok(True, 'dashboard: serial cover lookup')
    d3.screenshot(path=f'{OUT}/33-cp-dashboard.png', full_page=True)
    d3.goto(rma_url)
    d3.click('text=Another part, same printer')
    d3.wait_for_selector('h1:has-text("New RMA")')
    d3.wait_for_timeout(600)
    ok(d3.get_by_label('Product serial number').input_value().replace(' ', '').upper() == 'TEBT25370458', 'another part: printer details prefilled')
    d3.goto(BASE + '/masters')
    d3.click('role=tab[name*="Care pack types"]')
    d3.wait_for_selector('text=3 Year')
    ok(True, 'masters: care pack types tab')
    d3.goto(BASE + '/settings')
    d3.wait_for_selector('text=Zoho Books')
    d3.screenshot(path=f'{OUT}/34-settings-zoho.png', full_page=True)
    ok(d3.locator('text=Not connected').count() == 1, 'settings: Zoho section shows not connected')
    browser.close()

bad = [e for e in errors if 'favicon' not in e and '401' not in e and 'Failed to load resource' not in e]
print('\nConsole errors:', bad or 'none')
failed = [n for c, n in checks if not c]
print(f'{len(checks) - len(failed)} passed, {len(failed)} failed')
sys.exit(1 if failed or bad else 0)
