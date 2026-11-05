#!/usr/bin/env python3
"""Runs public/migrate-rma.ps1 under pwsh against `wrangler dev`, with SQL Server replaced by fixture data.
Usage: python3 scripts/migrate-tool-check.py <pwsh> <migration-key-file>"""
import os, subprocess, sys, tempfile, pathlib, re

pwsh, keyfile = sys.argv[1], sys.argv[2]
key = open(keyfile).read().strip()
root = pathlib.Path(__file__).resolve().parent.parent
src = (root / 'public/migrate-rma.ps1').read_text()
work = pathlib.Path(tempfile.mkdtemp(prefix='migtest-'))
photos = work / 'Photos'
JPEG = bytes([0xff, 0xd8, 0xff, 0xe0] + [7] * 200 + [0xff, 0xd9])
def put(rel, data=JPEG):
    f = photos / rel; f.parent.mkdir(parents=True, exist_ok=True); f.write_bytes(data); return f
listed = put('2025/03/INF-RMA-202503-0101/INBOUND/INF-RMA-202503-0101_IN_01.jpg')
put('2025/03/INF-RMA-202503-0101/OUTBOUND/after-repair.jpg')          # on disk only, not in DB
put('2025/03/NOT-A-TICKET/INBOUND/stray.jpg')                         # folder of unknown ticket: ignored
pdf = work / 'oem.pdf'; pdf.write_bytes(b'%PDF-1.4\n%%EOF\n')

mock = r'''
function Query([string]$sql, [hashtable]$params = @{}) {
  $L = New-Object System.Collections.ArrayList
  function AddRow($h) { $o = [ordered]@{}; foreach ($k in $h.Keys) { $o[$k] = $h[$k] }; [void]$L.Add($o) }
  $d = [datetime]'2025-03-04 11:15:00'
  if ($sql -match 'sys\.tables') { AddRow @{ n = 1 } }
  elseif ($sql -match 'sys\.columns') { AddRow @{ n = 1 } }
  elseif ($sql -match 'FROM Companies') { AddRow @{ Id = 1; Name = 'Infinite Solutions' } }
  elseif ($sql -match '^SELECT \(SELECT COUNT') { AddRow @{ tickets = 2; photos = 2 } }
  elseif ($sql -match 'COUNT\(\*\) AS n FROM CarePackBatches') { AddRow @{ n = 1 } }
  elseif ($sql -match 'FROM ProductModels') { AddRow @{ oem_code = 'TSC'; product_code = 'DT'; code = 'TE210'; name = 'TE210'; active = $true } }
  elseif ($sql -match 'FROM Products') { AddRow @{ oem_code = 'TSC'; code = 'DT'; name = 'Desktop'; active = $true } }
  elseif ($sql -match 'FROM OemVendors') { AddRow @{ code = 'TSC'; name = 'TSC Auto ID'; active = $true } }
  elseif ($sql -match 'FROM CarePackTypeMasters') { AddRow @{ name = '3 Year'; duration_years = 3; active = $true } }
  elseif ($sql -match 'FROM Customers') { AddRow @{ code = 'MIG1'; name = 'Migrated Buyer Pvt Ltd'; state = $null; city = 'Noida'; address = $null; postal = $null; country = 'India'; contact_name = 'Amit'; email = $null; phone = '98100'; gstin = $null; active = $true } }
  elseif ($sql -match 'InternalTicketNo AS n') { AddRow @{ n = 'INF-RMA-202503-0101' }; AddRow @{ n = 'INF-RMA-202503-0102' } }
  elseif ($sql -match 'FROM RMATickets') {
    AddRow @{ ticket_no = 'INF-RMA-202503-0101'; status = 'CLOSED'; is_imported = $false; created_at = $d; updated_at = $d.AddDays(9); customer_company = 'Migrated Buyer Pvt Ltd'; printer_model = 'TE210'; printer_sn = 'TE2 1000'; faulty_part = 'Platen'; tph_mileage = [double]12.5; purchase_date = [datetime]'2024-01-02'; closed_at = $d.AddDays(9); oem_rma_number = 'RMA-MIG-77'; batch_code = 'BATCH-202503-01'; oem_email_sent_at = $null; dup_at = $null; delivery_to_user_date = $null; oem_rma_assign_date = $null; oem_dispatch_date = [datetime]'2025-03-06'; challan_date = $null; dispatch_to_customer_date = $null; failure_description = "Line 1`nLine 2 with quotes "" and unicode test" }
    $long = ('Printer prints faded on the left side, customer reports after cleaning. ' * 40)
    for ($n = 1; $n -le 60; $n++) { AddRow @{ ticket_no = ('INF-RMA-202401-{0:D4}' -f $n); status = 'CLOSED'; created_at = $d.AddDays(-400 + $n); customer_company = ('Bulk Customer {0}' -f ($n % 7)); customer_city = 'Delhi'; customer_contact_name = 'Contact'; printer_sn = ('BULK{0:D5}' -f $n); faulty_part = 'Head'; failure_description = $long; closed_at = $d.AddDays(-390 + $n) } }
    AddRow @{ ticket_no = 'INF-RMA-202503-0102'; status = 'OPEN'; is_imported = $true; created_at = $d; updated_at = $null; customer_company = 'Walk-in'; printer_sn = 'X9'; faulty_part = 'Head'; closed_at = $null; oem_email_sent_at = $null; dup_at = $null; purchase_date = $null; delivery_to_user_date = $null; oem_rma_assign_date = $null; oem_dispatch_date = $null; challan_date = $null; dispatch_to_customer_date = $null }
  }
  elseif ($sql -match 'FROM MonthlyBatches') { AddRow @{ batch_code = 'BATCH-202503-01'; batch_month = '2025-03'; dispatch_date = [datetime]'2025-03-06'; remarks = 'old batch'; total = 1; created_at = $d } }
  elseif ($sql -match "AppSettings") { AddRow @{ v = '__BASE__' } }
  elseif ($sql -match 'FROM RMAPhotos') {
    AddRow @{ ticket_no = 'INF-RMA-202503-0101'; direction = 'INBOUND'; name = 'INF-RMA-202503-0101_IN_01.jpg'; path = 'C:\old\path\gone.jpg'; captured_at = $d; captured_by = 'ravi'; notes = $null }
    AddRow @{ ticket_no = 'INF-RMA-202503-0102'; direction = 'INBOUND'; name = 'missing.jpg'; path = $null; captured_at = $d; captured_by = $null; notes = $null }
  }
  elseif ($sql -match 'FROM CarePackDevices') { AddRow @{ batch = 41; serial_number = 'TE2MIG001'; oem_brand = 'TSC Auto ID'; care_pack_type = '3 Year'; original_model = 'TE210'; warranty_end = [datetime]'2028-02-01'; overridden = $false }; AddRow @{ batch = 41; serial_number = 'TE2MIG002'; oem_brand = $null; care_pack_type = $null; original_model = $null; warranty_end = $null; overridden = $false } }
  elseif ($sql -match 'FROM CarePackBatches') { AddRow @{ legacy_id = 41; invoice_number = 'IS-GST-2425-0900'; line_set_index = 1; customer_name = 'Migrated Buyer Pvt Ltd'; invoice_date = [datetime]'2025-02-01'; oem_brand = 'TSC Auto ID'; care_pack_type = '3 Year'; printer_model = 'TE210'; invoice_qty = 2; status = 'IMPORTED'; po_validated_at = $null; oem_paid_at = $null; verified_at = $null; created_at = $d; irn_ack_date = $null; oem_invoice_date = $null; installation_date = $null; pdf_path = '__PDF__'; oem_paid = $false; verified = $false; po_matched = $false; overridden = $false } }
  return ,$L
}
function Get-UploadBytes([string]$file) { return [IO.File]::ReadAllBytes($file) }
'''.replace('__BASE__', str(work)).replace('__PDF__', str(pdf))

s = src.replace('Add-Type -AssemblyName System.Drawing', '')
s = re.sub(r'\$conn = New-Object System\.Data\.SqlClient\.SqlConnection \$cs\r?\ntry \{ \$conn\.Open\(\) \}[^\n]*\n',
           "$conn = New-Object psobject; $conn | Add-Member -MemberType ScriptMethod -Name Close -Value { }\n", s)
assert 'SqlConnection $cs' not in s, 'connection block not replaced'
# Mocks go after the real helpers so they win.
s = s.replace('# ---------- Cloud API ----------', mock + '\n# ---------- Cloud API ----------', 1)
s = s.replace("if ($parts -contains 'photos') {", "function Get-UploadBytes([string]$file) { return [IO.File]::ReadAllBytes($file) }\nif ($parts -contains 'photos') {", 1)
test = work / 'migrate-test.ps1'; test.write_text(s)

def run(*extra):
    r = subprocess.run([pwsh, '-NoProfile', '-File', str(test), '-Url', 'http://localhost:8787', '-Key', key, '-Yes', *extra],
                       cwd=work, capture_output=True, text=True, timeout=300)
    return r.returncode, r.stdout + r.stderr

fails = 0
def ok(cond, label, out=''):
    global fails
    print(('  \u2713 ' if cond else '  \u2717 ') + label)
    if not cond: fails += 1; print(out[-3000:])

code, out = run('-DryRun')
ok(code == 0 and 'Dry run' in out and '2 RMAs' in out, 'dry run counts only', out)
code, out = run()
print(out)
ok(code == 0, 'first run exits cleanly', out)
ok('62 moved, 0 already there' in out and 'customers added to the customer list from the RMAs' in out, 'tickets moved', out)
ok('added 0 OEMs, 0 products, 1 models' in out and 'added 1 customers' in out, 'masters moved (new model under existing OEM/product, new customer)', out)
ok(re.search(r'2 uploaded .*?, 0 already there, 1 files missing', out) is not None, 'photo from DB (fallback path) + photo only on disk uploaded; missing file reported', out)
ok('1 invoices (2 printer serials) moved' in out and '1 OEM invoice PDFs uploaded' in out, 'care pack + PDF moved', out)
code, out2 = run()
ok(code == 0 and '0 moved, 62 already there' in out2 and re.search(r'0 uploaded .*?, 2 already there', out2) and '0 invoices (0 printer serials) moved, 1 already there' in out2, 'second run adds nothing', out2)
code, out3 = run('-Only', 'tickets')
ok(code == 0 and 'Photos' not in out3 and 'Care packs' not in out3, '-Only limits what runs', out3)
r4 = subprocess.run([pwsh, '-NoProfile', '-File', str(test), '-Url', 'http://localhost:8787', '-Key', 'rmk_wrongwrongwrongwrongwrong', '-Yes'], cwd=work, capture_output=True, text=True)
ok(r4.returncode == 1 and 'HTTP 401 - Migration key is missing' in (r4.stdout + r4.stderr), 'wrong key: stops and shows the real reason', r4.stdout + r4.stderr)
print(f"{'all passed' if not fails else f'{fails} failed'}")
sys.exit(1 if fails else 0)
