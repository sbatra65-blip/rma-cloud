# Prints the user guide (/help) as the PDF manual.
# Usage: python3 scripts/guide/manual-pdf.py <base_url> <out.pdf>
import sys
from playwright.sync_api import sync_playwright
BASE, OUT = sys.argv[1], sys.argv[2]
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width': 1100, 'height': 1400})
    pg.goto(BASE + '/help'); pg.wait_for_selector('.g-sec')
    pg.evaluate("() => document.querySelectorAll('img[loading]').forEach(i => { i.loading = 'eager'; })")
    for _ in range(120):  # CSP blocks wait_for_function, so poll
        if pg.evaluate("() => [...document.images].every(i => i.complete && i.naturalWidth > 0)"):
            break
        pg.wait_for_timeout(500)
    pg.emulate_media(media='print')
    foot = '<div style="font-size:8px;width:100%;padding:0 14mm;color:#777;display:flex;justify-content:space-between;font-family:sans-serif"><span>TrackMyRMA user guide</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>'
    pg.pdf(path=OUT, format='A4', print_background=True, display_header_footer=True, header_template='<div></div>', footer_template=foot,
           margin={'top': '14mm', 'bottom': '16mm', 'left': '14mm', 'right': '14mm'})
    b.close()
print('saved', OUT)
