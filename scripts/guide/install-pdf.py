# Renders docs/INSTALL.md as a PDF. Usage: python3 scripts/guide/install-pdf.py <out.pdf>
import sys, markdown, pathlib, base64
from playwright.sync_api import sync_playwright
root = pathlib.Path(__file__).resolve().parents[2]
md = (root / 'docs/INSTALL.md').read_text()
body = markdown.markdown(md, extensions=['tables', 'fenced_code'])
logo = base64.b64encode((root / 'public/icons/icon-192.png').read_bytes()).decode()
html = f"""<!doctype html><meta charset="utf-8"><style>
@page {{ size: A4; margin: 16mm 15mm 18mm; }}
body {{ font: 10.5pt/1.55 -apple-system, 'Segoe UI', Roboto, sans-serif; color: #1e1b4b; }}
h1 {{ font-size: 22pt; letter-spacing: -0.02em; margin: 0 0 8px; }}
h2 {{ font-size: 14pt; margin: 22px 0 6px; border-bottom: 2px solid #ececf9; padding-bottom: 4px; break-after: avoid; }}
h3 {{ font-size: 11.5pt; margin: 14px 0 4px; }}
p, li {{ color: #333654; }}
table {{ border-collapse: collapse; width: 100%; margin: 8px 0 12px; font-size: 9.2pt; }}
th, td {{ border: 1px solid #e3e2ef; padding: 5px 7px; text-align: left; vertical-align: top; }}
th {{ background: #f3f2fa; }}
tr {{ break-inside: avoid; }}
code {{ font-family: 'JetBrains Mono', Consolas, monospace; font-size: 8.8pt; background: #f3f2fa; padding: 1px 4px; border-radius: 4px; word-break: break-all; }}
pre {{ background: #f3f2fa; padding: 10px 12px; border-radius: 8px; }} pre code {{ background: none; padding: 0; }}
blockquote {{ margin: 10px 0; padding: 8px 14px; background: #fff4e5; border-left: 4px solid #c77700; border-radius: 6px; }}
.brand {{ display: flex; align-items: center; gap: 12px; margin-bottom: 18px; }} .brand img {{ width: 44px; height: 44px; border-radius: 10px; }}
</style><div class="brand"><img src="data:image/png;base64,{logo}"><b style="font-size:14pt">TrackMyRMA</b></div>{body}"""
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(); pg.set_content(html)
    foot = '<div style="font-size:8px;width:100%;padding:0 15mm;color:#777;display:flex;justify-content:space-between;font-family:sans-serif"><span>TrackMyRMA installation guide</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>'
    pg.pdf(path=sys.argv[1], format='A4', print_background=True, display_header_footer=True, header_template='<div></div>', footer_template=foot,
           margin={'top': '16mm', 'bottom': '18mm', 'left': '15mm', 'right': '15mm'})
    b.close()
print('saved', sys.argv[1])
