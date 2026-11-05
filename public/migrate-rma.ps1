<#
.SYNOPSIS
  Moves RMAs, photos, OEM batches, masters and care packs from the old Windows RMA System
  (SQL Server Express + photo folders) into RMA Cloud.

.DESCRIPTION
  Run this on the PC where the old RMA System and its SQL Server are installed.
  Safe to run again: anything already in the cloud is skipped, so you can stop it and start it again.
  Nothing in the old system is changed - it only reads.

  1. In RMA Cloud, log in as Admin -> Settings -> "Move data from the old system" -> Create migration key.
  2. Open PowerShell on the old PC and run, for example:
       powershell -ExecutionPolicy Bypass -File .\migrate-rma.ps1 -Url https://rma.example.com -Key rmk_xxxxx
  3. Try first with -DryRun to only count what would be moved.

.PARAMETER Url             Address of RMA Cloud, e.g. https://rma-cloud.yourname.workers.dev
.PARAMETER Key             Migration key from Settings (starts with rmk_). Valid 48 hours.
.PARAMETER Server          SQL Server instance. Default: read from the old config.ini, else localhost\SQLEXPRESS01
.PARAMETER Database        Database name. Default: from config.ini, else RMASystem
.PARAMETER SqlUser         Only if SQL login is used (otherwise Windows login is used)
.PARAMETER SqlPassword     Only with -SqlUser
.PARAMETER LegacyCompanyId Which company of the old system to move (default 1 = Infinite Solutions)
.PARAMETER PhotoRoot       Photos folder. Default: C:\ProgramData\RMA System\Photos (or from AppSettings base_dir)
.PARAMETER MaxPhotoPx      Long side of uploaded photos in pixels (default 1600). Smaller = faster, less storage.
.PARAMETER Only            Move only some parts: masters, tickets, batches, photos, carepacks (comma separated)
.PARAMETER DryRun          Count only. Nothing is uploaded.
.PARAMETER Yes             Do not ask for confirmation.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Url,
  [Parameter(Mandatory = $true)][string]$Key,
  [string]$Server,
  [string]$Database,
  [string]$SqlUser,
  [string]$SqlPassword,
  [int]$LegacyCompanyId = 1,
  [string]$PhotoRoot,
  [int]$MaxPhotoPx = 1600,
  [int]$JpegQuality = 82,
  [string]$Only = 'masters,tickets,batches,photos,carepacks',
  [switch]$DryRun,
  [switch]$Yes
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.Drawing
$Url = $Url.TrimEnd('/')
$parts = $Only.ToLower().Split(',') | ForEach-Object { $_.Trim() }
$logFile = Join-Path (Get-Location) ("rma-migration-{0:yyyyMMdd-HHmmss}.log" -f (Get-Date))
function Log([string]$msg, [string]$color = 'Gray') {
  Write-Host $msg -ForegroundColor $color
  Add-Content -Path $logFile -Value ("{0:HH:mm:ss}  {1}" -f (Get-Date), $msg) -Encoding UTF8
}

# ---------- Old system settings ----------
$ini = 'C:\Program Files\RMA System\config.ini'
if (Test-Path $ini) {
  foreach ($line in Get-Content $ini) {
    if (-not $Server -and $line -match '^\s*Server\s*=\s*(.+)$') { $Server = $Matches[1].Trim() }
    if (-not $Database -and $line -match '^\s*Database\s*=\s*(.+)$') { $Database = $Matches[1].Trim() }
  }
}
if (-not $Server) { $Server = 'localhost\SQLEXPRESS01' }
if (-not $Database) { $Database = 'RMASystem' }

if ($SqlUser) { $cs = "Server=$Server;Database=$Database;User ID=$SqlUser;Password=$SqlPassword;TrustServerCertificate=True" }
else { $cs = "Server=$Server;Database=$Database;Integrated Security=True;TrustServerCertificate=True" }
$conn = New-Object System.Data.SqlClient.SqlConnection $cs
try { $conn.Open() } catch { Log "Cannot open SQL Server '$Server' database '$Database': $($_.Exception.Message)" 'Red'; Log "Use -Server and -Database, e.g. -Server 'localhost\SQLEXPRESS'." 'Yellow'; exit 1 }

function Query([string]$sql, [hashtable]$params = @{}) {
  $cmd = $conn.CreateCommand()
  $cmd.CommandText = $sql
  $cmd.CommandTimeout = 300
  foreach ($k in $params.Keys) { [void]$cmd.Parameters.AddWithValue("@$k", $params[$k]) }
  $table = New-Object System.Data.DataTable
  $table.Load($cmd.ExecuteReader())
  $rows = New-Object System.Collections.ArrayList
  foreach ($r in $table.Rows) {
    $h = [ordered]@{}
    foreach ($c in $table.Columns) {
      $v = $r[$c.ColumnName]
      if ($v -is [System.DBNull]) { $v = $null }
      elseif ($v -is [decimal]) { $v = [double]$v }
      $h[$c.ColumnName] = $v
    }
    [void]$rows.Add($h)
  }
  return ,$rows
}
function HasTable([string]$name) { return (Query "SELECT COUNT(*) AS n FROM sys.tables WHERE name = @n" @{ n = $name })[0].n -gt 0 }
function HasColumn([string]$table, [string]$col) { return (Query "SELECT COUNT(*) AS n FROM sys.columns WHERE object_id = OBJECT_ID(@t) AND name = @c" @{ t = $table; c = $col })[0].n -gt 0 }

# ---------- Cloud API ----------
$headers = @{ Authorization = "Bearer $Key" }
function ApiError($e) {
  try {
    $resp = $e.Exception.Response
    if ($resp) {
      $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
      $txt = $reader.ReadToEnd()
      try { $j = $txt | ConvertFrom-Json; if ($j.fields) { return "$($j.error) $(($j.fields | ConvertTo-Json -Compress))" }; return $j.error } catch { return $txt }
    }
  } catch { }
  return $e.Exception.Message
}
function PostJson([string]$path, $obj) {
  $json = $obj | ConvertTo-Json -Depth 8 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  for ($try = 1; $try -le 3; $try++) {
    try { return Invoke-RestMethod -Method Post -Uri "$Url$path" -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $bytes -TimeoutSec 300 }
    catch {
      $msg = ApiError $_
      if ($try -eq 3 -or $msg -match 'Migration key') { throw $msg }
      Start-Sleep -Seconds (3 * $try)
    }
  }
}
function PostBytes([string]$path, [byte[]]$bytes, [string]$type, [hashtable]$extra) {
  $h = @{}; $headers.Keys | ForEach-Object { $h[$_] = $headers[$_] }
  foreach ($k in $extra.Keys) { if ($null -ne $extra[$k] -and "$($extra[$k])" -ne '') { $h[$k] = [Uri]::EscapeDataString([string]$extra[$k]) } }
  for ($try = 1; $try -le 3; $try++) {
    try { return Invoke-RestMethod -Method Post -Uri "$Url$path" -Headers $h -ContentType $type -Body $bytes -TimeoutSec 300 }
    catch {
      $msg = ApiError $_
      if ($try -eq 3 -or $msg -match 'Migration key|not in the cloud') { throw $msg }
      Start-Sleep -Seconds (3 * $try)
    }
  }
}
function PhotoState([string]$ticketNo, [string]$direction, [string]$name) {
  $h = @{}; $headers.Keys | ForEach-Object { $h[$_] = $headers[$_] }
  $h['X-Ticket-No'] = [Uri]::EscapeDataString($ticketNo); $h['X-Direction'] = $direction; $h['X-File-Name'] = [Uri]::EscapeDataString($name)
  try { $r = Invoke-WebRequest -Method Head -Uri "$Url/api/migrate/photo" -Headers $h -UseBasicParsing -TimeoutSec 60; if ($r.StatusCode -eq 200) { return 'exists' } else { return 'missing' } }
  catch { if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 404) { return 'noticket' }; throw (ApiError $_) }
}
function Chunks($list, [int]$size) {
  $out = New-Object System.Collections.ArrayList
  for ($i = 0; $i -lt $list.Count; $i += $size) { [void]$out.Add(@($list[$i..([Math]::Min($i + $size, $list.Count) - 1)])) }
  return ,$out
}
function Iso($v) { if ($null -eq $v) { return $null }; if ($v -is [datetime]) { return $v.ToString('yyyy-MM-ddTHH:mm:ss') }; return [string]$v }
function Day($v) { if ($null -eq $v) { return $null }; if ($v -is [datetime]) { return $v.ToString('yyyy-MM-dd') }; return ([string]$v).Substring(0, [Math]::Min(10, ([string]$v).Length)) }

# ---------- Start ----------
Log "RMA Cloud migration - reading $Server / $Database, company $LegacyCompanyId" 'Cyan'
try { $status = Invoke-RestMethod -Uri "$Url/api/migrate/status" -Headers $headers -TimeoutSec 60 }
catch { Log "Cannot reach RMA Cloud: $(ApiError $_)" 'Red'; exit 1 }
Log ("Cloud company: {0} ({1}). Already there: {2} RMAs, {3} photos, {4} customers, {5} care pack invoices." -f $status.company.name, $status.company.code, $status.counts.tickets, $status.counts.photos, $status.counts.customers, $status.counts.carePacks)

$multi = HasColumn 'RMATickets' 'CompanyId'
$cw = ''; if ($multi) { $cw = "WHERE CompanyId = $LegacyCompanyId" }
$cwAnd = ''; if ($multi) { $cwAnd = "AND t.CompanyId = $LegacyCompanyId" }
if ($multi -and (HasTable 'Companies')) {
  $cos = Query "SELECT Id, Name FROM Companies ORDER BY Id"
  if ($cos.Count -gt 1) { Log ("Old system companies: " + (($cos | ForEach-Object { "$($_.Id)=$($_.Name)" }) -join ', ') + ". Moving company $LegacyCompanyId (change with -LegacyCompanyId).") 'Yellow' }
}
$counts = Query "SELECT (SELECT COUNT(*) FROM RMATickets $cw) AS tickets, (SELECT COUNT(*) FROM RMAPhotos p JOIN RMATickets t ON t.Id = p.RmaTicketId WHERE 1=1 $cwAnd) AS photos"
$cpCount = 0; if (HasTable 'CarePackBatches') { $cpCount = (Query "SELECT COUNT(*) AS n FROM CarePackBatches $cw")[0].n }
Log ("Old system: {0} RMAs, {1} photo records, {2} care pack invoices." -f $counts[0].tickets, $counts[0].photos, $cpCount)

if ($DryRun) { Log 'Dry run: nothing uploaded.' 'Green'; $conn.Close(); exit 0 }
if (-not $Yes) {
  $answer = Read-Host "Copy this into '$($status.company.name)' in RMA Cloud? Type YES to start"
  if ($answer -ne 'YES') { Log 'Stopped. Nothing uploaded.'; exit 0 }
}

# ---------- Masters ----------
if ($parts -contains 'masters') {
  Log 'Masters (OEMs, products, models, customers, care pack types)...' 'Cyan'
  $m = @{ oems = @(); products = @(); models = @(); customers = @(); cpTypes = @() }
  if (HasTable 'OemVendors') {
    $m.oems = (Query "SELECT Code AS code, Name AS name, IsActive AS active FROM OemVendors $cw")
    $m.products = (Query "SELECT o.Code AS oem_code, p.Code AS code, p.Name AS name, p.IsActive AS active FROM Products p JOIN OemVendors o ON o.Id = p.OemVendorId $(if ($multi) { "WHERE p.CompanyId = $LegacyCompanyId" })")
    $m.models = (Query "SELECT o.Code AS oem_code, p.Code AS product_code, pm.Code AS code, pm.Name AS name, pm.IsActive AS active FROM ProductModels pm JOIN Products p ON p.Id = pm.ProductId JOIN OemVendors o ON o.Id = p.OemVendorId $(if ($multi) { "WHERE pm.CompanyId = $LegacyCompanyId" })")
  }
  if (HasTable 'CarePackTypeMasters') { $m.cpTypes = (Query "SELECT Name AS name, DurationYears AS duration_years, IsActive AS active FROM CarePackTypeMasters $cw") }
  $r = PostJson '/api/migrate/masters' $m
  Log ("  added {0} OEMs, {1} products, {2} models, {3} care pack types" -f $r.oems, $r.products, $r.models, $r.cpTypes) 'Green'
  if (HasTable 'Customers') {
    $cust = Query "SELECT Code AS code, Name AS name, State AS state, City AS city, Address AS address, Postal AS postal, Country AS country, ContactName AS contact_name, Email AS email, Phone AS phone, Gstin AS gstin, IsActive AS active FROM Customers $cw ORDER BY Id"
    $added = 0
    foreach ($ch in (Chunks $cust 300)) { $r = PostJson '/api/migrate/masters' @{ customers = $ch }; $added += $r.customers }
    Log "  added $added customers (of $($cust.Count))" 'Green'
  }
}

# ---------- Tickets ----------
if ($parts -contains 'tickets') {
  Log 'RMA tickets...' 'Cyan'
  $sql = @"
SELECT InternalTicketNo AS ticket_no, Status AS status, IsImported AS is_imported, CreatedAt AS created_at, UpdatedAt AS updated_at,
  CustomerCompany AS customer_company, CustomerAddress AS customer_address, CustomerCity AS customer_city, CustomerState AS customer_state,
  CustomerPostal AS customer_postal, CustomerCountry AS customer_country, CustomerContactName AS customer_contact_name, CustomerEmail AS customer_email,
  CustomerPhone AS customer_phone, PoNumber AS po_number, ShipToCompany AS ship_to_company, ShipToAddress AS ship_to_address,
  ShipToContactName AS ship_to_contact_name, ShipToEmail AS ship_to_email, ShipToPhone AS ship_to_phone,
  PrinterModel AS printer_model, PrinterSn AS printer_sn, FaultyPart AS faulty_part, FaultyPartSn AS faulty_part_sn, FaultyPartNo AS faulty_part_no,
  FailureDescription AS failure_description, TphMileage AS tph_mileage, PrinterMileage AS printer_mileage, FwVersion AS fw_version,
  FlashInitialized AS flash_initialized, PurchaseDate AS purchase_date, DeliveryToUserDate AS delivery_to_user_date,
  OemRmaNumber AS oem_rma_number, OemRmaAssignDate AS oem_rma_assign_date, OemEmailSentAt AS oem_email_sent_at, OemEmailSentBy AS oem_email_sent_by,
  OemDispatchDate AS oem_dispatch_date, BatchDispatchId AS batch_code, ZohoChallanNumber AS challan_number, ChallanCreatedAt AS challan_date,
  DispatchToCustomerDate AS dispatch_to_customer_date, ClosedAt AS closed_at, ClosureType AS closure_type, ClosureRemarks AS closure_remarks,
  DuplicateOpenReason AS dup_reason, DuplicateOpenAt AS dup_at, DuplicateOpenBy AS dup_by
FROM RMATickets $cw ORDER BY Id
"@
  $tickets = Query $sql
  foreach ($t in $tickets) {
    foreach ($k in @('created_at', 'updated_at', 'oem_email_sent_at', 'closed_at', 'dup_at')) { $t[$k] = Iso $t[$k] }
    foreach ($k in @('purchase_date', 'delivery_to_user_date', 'oem_rma_assign_date', 'oem_dispatch_date', 'challan_date', 'dispatch_to_customer_date')) { $t[$k] = Day $t[$k] }
  }
  $created = 0; $skipped = 0; $errs = 0; $done = 0
  foreach ($ch in (Chunks $tickets 100)) {
    $r = PostJson '/api/migrate/tickets' @{ rows = $ch }
    $created += $r.created; $skipped += $r.skipped; $errs += $r.errors.Count; $done += $ch.Count
    foreach ($e in $r.errors) { Log "  ! $($e.ticket_no): $($e.error)" 'Yellow' }
    Write-Progress -Activity 'RMA tickets' -Status "$done of $($tickets.Count)" -PercentComplete ([int](100 * $done / [Math]::Max(1, $tickets.Count)))
  }
  Write-Progress -Activity 'RMA tickets' -Completed
  Log "  $created moved, $skipped already there, $errs with problems" 'Green'
}

# ---------- OEM batches ----------
if ($parts -contains 'batches' -and (HasTable 'MonthlyBatches')) {
  Log 'OEM dispatch batches...' 'Cyan'
  $b = Query "SELECT BatchId AS batch_code, BatchMonth AS batch_month, DispatchDate AS dispatch_date, Remarks AS remarks, TotalRmas AS total, CreatedAt AS created_at FROM MonthlyBatches $cw"
  foreach ($x in $b) { $x.dispatch_date = Day $x.dispatch_date; $x.created_at = Iso $x.created_at }
  if ($b.Count) { $r = PostJson '/api/migrate/batches' @{ rows = $b }; Log "  $($r.created) moved" 'Green' }
}

# ---------- Photos ----------
function Get-UploadBytes([string]$file) {
  $info = Get-Item -LiteralPath $file
  $img = $null
  try { $img = [System.Drawing.Image]::FromFile($file) } catch { return $null }
  try {
    # Turn phone photos the right way up (EXIF orientation) before resizing.
    if ($img.PropertyIdList -contains 274) {
      switch ($img.GetPropertyItem(274).Value[0]) { 3 { $img.RotateFlip('Rotate180FlipNone') } 6 { $img.RotateFlip('Rotate90FlipNone') } 8 { $img.RotateFlip('Rotate270FlipNone') } }
    }
    $long = [Math]::Max($img.Width, $img.Height)
    if ($long -le $MaxPhotoPx -and $info.Length -le 1.5MB -and $info.Extension -match '^\.jpe?g$') { return [IO.File]::ReadAllBytes($file) }
    $scale = [Math]::Min(1.0, $MaxPhotoPx / $long)
    $w = [int]($img.Width * $scale); $h = [int]($img.Height * $scale)
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = 'HighQualityBicubic'; $g.Clear([System.Drawing.Color]::White); $g.DrawImage($img, 0, 0, $w, $h); $g.Dispose()
    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
    $ep = New-Object System.Drawing.Imaging.EncoderParameters 1
    $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), ([long]$JpegQuality)
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, $codec, $ep); $bmp.Dispose()
    return $ms.ToArray()
  } finally { $img.Dispose() }
}

if ($parts -contains 'photos') {
  if (-not $PhotoRoot) {
    $base = $null
    if (HasTable 'AppSettings') { $s = Query "SELECT [Value] AS v FROM AppSettings WHERE [Key] = 'base_dir'"; if ($s.Count) { $base = $s[0].v } }
    if (-not $base) { $base = Join-Path $env:ProgramData 'RMA System' }
    $PhotoRoot = Join-Path $base 'Photos'
  }
  Log "Photos (from $PhotoRoot)..." 'Cyan'
  $list = New-Object System.Collections.ArrayList
  $seen = @{}
  $rows = Query "SELECT t.InternalTicketNo AS ticket_no, p.Direction AS direction, p.Filename AS name, p.FilePath AS path, p.CapturedAt AS captured_at, p.CapturedBy AS captured_by, p.Notes AS notes FROM RMAPhotos p JOIN RMATickets t ON t.Id = p.RmaTicketId WHERE 1=1 $cwAnd ORDER BY t.Id, p.Id"
  foreach ($p in $rows) {
    $dir = ([string]$p.direction).ToUpper(); if ($dir -ne 'OUTBOUND') { $dir = 'INBOUND' }
    $file = $p.path
    if (-not $file -or -not (Test-Path -LiteralPath $file)) {
      $tn = [string]$p.ticket_no; $seg = $tn.Split('-')
      if ($seg.Length -ge 3 -and $seg[2].Length -eq 6) { $file = Join-Path $PhotoRoot (Join-Path $seg[2].Substring(0, 4) (Join-Path $seg[2].Substring(4, 2) (Join-Path $tn (Join-Path $dir $p.name)))) }
      if (-not (Test-Path -LiteralPath $file)) { $hit = Get-ChildItem -Path $PhotoRoot -Recurse -Filter $p.name -ErrorAction SilentlyContinue | Where-Object { $_.FullName -match [regex]::Escape($tn) } | Select-Object -First 1; if ($hit) { $file = $hit.FullName } }
    }
    $key = ("{0}|{1}|{2}" -f $p.ticket_no, $dir, $p.name).ToUpper()
    $seen[$key] = $true
    [void]$list.Add(@{ ticket_no = [string]$p.ticket_no; direction = $dir; name = [string]$p.name; file = $file; captured_at = (Iso $p.captured_at); captured_by = $p.captured_by; notes = $p.notes })
  }
  # Photos that are in the folders but were never recorded in the database.
  if (Test-Path $PhotoRoot) {
    $known = @{}; foreach ($t in (Query "SELECT InternalTicketNo AS n FROM RMATickets $cw")) { $known[[string]$t.n] = $true }
    Get-ChildItem -Path $PhotoRoot -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.Extension -match '^\.(jpe?g|png|webp)$' } | ForEach-Object {
      $dirName = $_.Directory.Name.ToUpper(); $tn = $_.Directory.Parent.Name
      if (($dirName -eq 'INBOUND' -or $dirName -eq 'OUTBOUND') -and $known.ContainsKey($tn)) {
        $key = ("{0}|{1}|{2}" -f $tn, $dirName, $_.Name).ToUpper()
        if (-not $seen.ContainsKey($key)) { $seen[$key] = $true; [void]$list.Add(@{ ticket_no = $tn; direction = $dirName; name = $_.Name; file = $_.FullName; captured_at = $_.LastWriteTime.ToString('yyyy-MM-ddTHH:mm:ss'); captured_by = $null; notes = $null }) }
      }
    }
  } else { Log "  Photo folder not found: $PhotoRoot (use -PhotoRoot)" 'Yellow' }

  $up = 0; $skip = 0; $missing = 0; $fail = 0; $i = 0; $bytesSent = 0
  foreach ($p in $list) {
    $i++
    Write-Progress -Activity 'Photos' -Status "$i of $($list.Count) - $($p.ticket_no)" -PercentComplete ([int](100 * $i / [Math]::Max(1, $list.Count)))
    if (-not $p.file -or -not (Test-Path -LiteralPath $p.file)) { $missing++; Log "  ! file not found: $($p.ticket_no) $($p.direction) $($p.name)" 'Yellow'; continue }
    try {
      $state = PhotoState $p.ticket_no $p.direction $p.name
      if ($state -eq 'exists') { $skip++; continue }
      if ($state -eq 'noticket') { $fail++; Log "  ! $($p.ticket_no) not in the cloud - run tickets first" 'Yellow'; continue }
      $bytes = Get-UploadBytes $p.file
      if (-not $bytes) { $fail++; Log "  ! not a readable image: $($p.file)" 'Yellow'; continue }
      $type = 'image/jpeg'; if ($p.name -match '\.png$' -and $bytes[0] -eq 0x89) { $type = 'image/png' }
      [void](PostBytes '/api/migrate/photo' $bytes $type @{ 'X-Ticket-No' = $p.ticket_no; 'X-Direction' = $p.direction; 'X-File-Name' = $p.name; 'X-Captured-At' = $p.captured_at; 'X-Captured-By' = $p.captured_by; 'X-Notes' = $p.notes })
      $up++; $bytesSent += $bytes.Length
    } catch { $fail++; Log "  ! $($p.ticket_no) $($p.name): $_" 'Yellow' }
  }
  Write-Progress -Activity 'Photos' -Completed
  Log ("  {0} uploaded ({1:N0} MB), {2} already there, {3} files missing, {4} problems" -f $up, ($bytesSent / 1MB), $skip, $missing, $fail) 'Green'
}

# ---------- Care packs ----------
if ($parts -contains 'carepacks' -and (HasTable 'CarePackBatches')) {
  Log 'Care packs...' 'Cyan'
  $batches = Query @"
SELECT Id AS legacy_id, InvoiceNumber AS invoice_number, LineSetIndex AS line_set_index, SourceInvoiceNumber AS source_invoice_number, ZohoInvoiceId AS zoho_invoice_id,
  CustomerName AS customer_name, CustomerCity AS customer_city, InvoiceDate AS invoice_date, Irn AS irn, IrnAckNo AS irn_ack_no, IrnAckDate AS irn_ack_date,
  OemBrand AS oem_brand, CarePackType AS care_pack_type, PrinterModel AS printer_model, PrinterItemName AS printer_item_name, InvoiceItemName AS invoice_item_name,
  InvoiceDescriptionRaw AS invoice_description, InvoiceBrandDetected AS invoice_brand_detected, InvoiceQty AS invoice_qty, Status AS status,
  PurchaseOrderNumber AS po_number, ZohoPurchaseOrderId AS zoho_po_id, PoValidatedAt AS po_validated_at, PoValidatedBy AS po_validated_by, PoMatched AS po_matched,
  PoValidationNotes AS po_notes, OemInvoiceNumber AS oem_invoice_number, OemInvoiceDate AS oem_invoice_date, InstallationDate AS installation_date,
  OemInvoiceAmount AS oem_amount, OemInvoiceCurrency AS oem_currency, OemInvoicePaid AS oem_paid, OemInvoicePaidAt AS oem_paid_at, OemInvoicePaidBy AS oem_paid_by,
  OemInvoicePdfPath AS pdf_path, VerificationComplete AS verified, VerificationCompletedAt AS verified_at, VerificationCompletedBy AS verified_by,
  Overridden AS overridden, CreatedAt AS created_at, CreatedBy AS created_by
FROM CarePackBatches $cw ORDER BY Id
"@
  $devs = Query "SELECT d.CarePackBatchId AS batch, d.SerialNumber AS serial_number, d.OemBrand AS oem_brand, d.CarePackType AS care_pack_type, d.OriginalModel AS original_model, d.WarrantyEnd AS warranty_end, d.Overridden AS overridden FROM CarePackDevices d JOIN CarePackBatches b ON b.Id = d.CarePackBatchId $(if ($multi) { "WHERE b.CompanyId = $LegacyCompanyId" }) ORDER BY d.Id"
  $byBatch = @{}
  foreach ($d in $devs) { $d.warranty_end = Day $d.warranty_end; $k = [string]$d.batch; if (-not $byBatch.ContainsKey($k)) { $byBatch[$k] = New-Object System.Collections.ArrayList }; [void]$byBatch[$k].Add($d) }
  $pdfs = New-Object System.Collections.ArrayList
  foreach ($b in $batches) {
    foreach ($k in @('po_validated_at', 'oem_paid_at', 'verified_at', 'created_at', 'irn_ack_date')) { $b[$k] = Iso $b[$k] }
    foreach ($k in @('invoice_date', 'oem_invoice_date', 'installation_date')) { $b[$k] = Day $b[$k] }
    $list = $byBatch[[string]$b.legacy_id]; if (-not $list) { $list = @() }
    $b['devices'] = @($list)
    if ($b.pdf_path) { [void]$pdfs.Add(@{ invoice = $b.invoice_number; set = $b.line_set_index; path = $b.pdf_path }) }
    $b.Remove('pdf_path'); $b.Remove('legacy_id')
  }
  $created = 0; $skipped = 0; $dc = 0
  foreach ($ch in (Chunks $batches 50)) {
    $r = PostJson '/api/migrate/carepacks' @{ rows = $ch }
    $created += $r.created; $skipped += $r.skipped; $dc += $r.devices
    foreach ($e in $r.errors) { Log "  ! $($e.invoice): $($e.error)" 'Yellow' }
  }
  Log "  $created invoices ($dc printer serials) moved, $skipped already there" 'Green'
  $pu = 0
  foreach ($p in $pdfs) {
    if (-not (Test-Path -LiteralPath $p.path)) { Log "  ! OEM invoice PDF not found: $($p.path)" 'Yellow'; continue }
    try { $r = PostBytes '/api/migrate/carepack-pdf' ([IO.File]::ReadAllBytes($p.path)) 'application/pdf' @{ 'X-Invoice' = $p.invoice; 'X-Set' = $p.set; 'X-File-Name' = (Split-Path $p.path -Leaf) }; if (-not $r.skipped) { $pu++ } }
    catch { Log "  ! PDF $($p.invoice): $_" 'Yellow' }
  }
  Log "  $pu OEM invoice PDFs uploaded" 'Green'
}

$conn.Close()
$final = Invoke-RestMethod -Uri "$Url/api/migrate/status" -Headers $headers -TimeoutSec 60
Log ("Done. RMA Cloud now has {0} RMAs, {1} photos, {2} customers, {3} care pack invoices ({4} printers)." -f $final.counts.tickets, $final.counts.photos, $final.counts.customers, $final.counts.carePacks, $final.counts.carePackDevices) 'Green'
Log "Log saved to $logFile. You can run this again at any time: it only adds what is missing." 'Cyan'
