# Demo files for the user-guide screenshots and tutorial video: a fictional company's logo, a sales invoice PDF
# (for care pack import), OEM invoice / challan PDFs, and photos of a faulty print head.
# Usage: python3 scripts/guide/make-assets.py <out_dir>
import sys, os, math, random
from PIL import Image, ImageDraw, ImageFont, ImageFilter
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.lib import colors

OUT = sys.argv[1] if len(sys.argv) > 1 else 'guide-assets'
os.makedirs(OUT, exist_ok=True)
FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
FONT_R = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'

def font(size, bold=True):
    try:
        return ImageFont.truetype(FONT if bold else FONT_R, size)
    except OSError:
        return ImageFont.load_default()

# ---- logo for the fictional "Sharma Printer Care" ----
im = Image.new('RGBA', (512, 512), (0, 0, 0, 0))
d = ImageDraw.Draw(im)
d.rounded_rectangle([16, 16, 496, 496], radius=110, fill=(15, 118, 110, 255))
d.ellipse([130, 120, 382, 372], outline=(255, 255, 255, 255), width=34)
d.rectangle([236, 96, 276, 200], fill=(15, 118, 110, 255))
d.text((256, 420), 'SPC', font=font(84), fill=(255, 255, 255, 255), anchor='mm')
im.save(f'{OUT}/logo.png')

# ---- photos of a faulty print head ----
def photo(path, seed, label):
    random.seed(seed)
    w, h = 1600, 1200
    im = Image.new('RGB', (w, h), (214, 210, 202))
    d = ImageDraw.Draw(im)
    for y in range(h):  # soft table-top gradient
        c = int(200 + 30 * y / h)
        d.line([(0, y), (w, y)], fill=(c, c - 6, c - 16))
    # the print head body
    d.rounded_rectangle([260, 420, 1340, 760], radius=26, fill=(48, 52, 60))
    d.rectangle([300, 560, 1300, 600], fill=(150, 120, 60))  # heater line
    for x in range(320, 1290, 18):
        d.line([(x, 470), (x, 530)], fill=(90, 96, 106), width=4)
    d.rounded_rectangle([1160, 640, 1300, 740], radius=10, fill=(30, 110, 60))  # connector
    # damage: scratches / burn marks across the heater line
    for _ in range(6):
        x = random.randint(420, 1180)
        d.line([(x, 548), (x + random.randint(-20, 20), 612)], fill=(25, 25, 25), width=random.randint(3, 7))
    d.ellipse([700, 560, 760, 604], fill=(60, 38, 20))
    im = im.filter(ImageFilter.GaussianBlur(1.2))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([40, 1080, 760, 1160], radius=16, fill=(0, 0, 0))
    d.text((60, 1120), label, font=font(40), fill=(255, 255, 255), anchor='lm')
    im.save(path, 'JPEG', quality=86)

photo(f'{OUT}/head-1.jpg', 1, 'Print head – heater line')
photo(f'{OUT}/head-2.jpg', 2, 'Print head – burn mark')
photo(f'{OUT}/head-3.jpg', 3, 'Test print – white lines')

# ---- PDFs ----
def pdf(path, title, lines, table=None, foot=None):
    c = canvas.Canvas(path, pagesize=A4)
    w, h = A4
    c.setFillColor(colors.HexColor('#0f766e'))
    c.rect(0, h - 70, w, 70, fill=1, stroke=0)
    c.setFillColor(colors.white)
    c.setFont('Helvetica-Bold', 18)
    c.drawString(40, h - 44, title[0])
    c.setFont('Helvetica', 10)
    c.drawRightString(w - 40, h - 44, title[1])
    c.setFillColor(colors.black)
    y = h - 110
    for ln in lines:
        c.setFont('Helvetica-Bold' if ln.startswith('#') else 'Helvetica', 11)
        c.drawString(40, y, ln.lstrip('#'))
        y -= 18
    if table:
        y -= 10
        c.setFillColor(colors.HexColor('#eef2f2'))
        c.rect(36, y - 6, w - 72, 22, fill=1, stroke=0)
        c.setFillColor(colors.black)
        c.setFont('Helvetica-Bold', 10)
        c.drawString(44, y, 'Description')
        y -= 26
        c.setFont('Helvetica', 10)
        for ln in table:
            c.drawString(44, y, ln)
            y -= 18
    if foot:
        c.setFont('Helvetica-Oblique', 9)
        c.drawString(40, 60, foot)
    c.showPage()
    c.save()

pdf(f'{OUT}/sales-invoice-SPC-0118.pdf', ('SHARMA PRINTER CARE', 'Tax Invoice'), [
    'Sharma Printer Care, Okhla Phase II, New Delhi 110020 · GSTIN 07AAAAA0000A1Z5 (sample)',
    '',
    '#Invoice No: SPC/2627/0118',
    'Invoice Date: 02/11/2026',
    '',
    'Bill To: Northline Logistics Pvt Ltd',
    'City: Gurugram',
], table=[
    'TSC TE310 Barcode Printer 300 dpi',
    'Qty: 3 Nos',
    'TSC 3 Year Comprehensive Care Pack for TE310',
    'S/N: T3EA2611001, T3EA2611002, T3EA2611003',
], foot='Sample invoice made for the TrackMyRMA user guide. Not a real document.')

pdf(f'{OUT}/oem-invoice-TSC-88214.pdf', ('TSC AUTO ID (SAMPLE)', 'Invoice'), [
    '#Invoice: TSC-INV-88214', 'Date: 05/11/2026', 'To: Sharma Printer Care', 'PO: PO-TSC-2611-07',
], table=['3 Year Comprehensive Care Pack TE310 × 3', 'Serials: T3EA2611001 T3EA2611002 T3EA2611003'],
    foot='Sample document made for the TrackMyRMA user guide.')

pdf(f'{OUT}/challan-customer.pdf', ('SHARMA PRINTER CARE', 'Delivery Challan'), [
    '#Challan No: DC/2627/0342', 'Date: 14/11/2026', 'To: Northline Logistics Pvt Ltd, Gurugram',
], table=['Replacement print head TE310 (RMA return)', 'Not for sale – warranty replacement'],
    foot='Sample document made for the TrackMyRMA user guide.')

pdf(f'{OUT}/challan-oem.pdf', ('SHARMA PRINTER CARE', 'Delivery Challan'), [
    '#Challan No: DC/2627/0331', 'Date: 08/11/2026', 'To: TSC Auto ID service centre',
], table=['Faulty parts sent for RMA – see packing list', 'Returnable – warranty claim'],
    foot='Sample document made for the TrackMyRMA user guide.')

# Customer list to import
with open(f'{OUT}/customers.csv', 'w') as fh:
    fh.write('Customer Name,Contact Person,Phone,Email,City\n')
    fh.write('Sunrise Garments,Harpreet Singh,9876500011,stores@sunrise-garments.example,Ludhiana\n')
    fh.write('Coastal Seafoods Exports,Anil Menon,9846000022,it@coastalseafoods.example,Kochi\n')
    fh.write('Metro Retail Stores,Neha Kapoor,9810400033,support@metroretail.example,New Delhi\n')
print('assets in', OUT)
