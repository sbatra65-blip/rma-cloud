# Purchase Order Fetch, Validation & Serial Number Matching
## Design Document — Poka-Yoke Throughout

**For:** Infinite Solutions, New Delhi
**Date:** July 2026
**Based on:** Actual PO-2627-0087 vs Sales Invoice IS-GST-2627-0064

---

## 1. What Was Found in the Sample PO

Analysing PO-2627-0087 reveals exactly how it relates to the sales invoice.

### PO Structure

```
PO Number    : PO-2627-0087
Date         : 24/07/2026
Ref#         : IS-GST-2627-0064    ← LINKS DIRECTLY to the sales invoice
Vendor       : TSC AUTO ID TECHNOLOGY CO. LTD, Taiwan
Contact      : Mr. Allen Lin  +886-3-990-6677 #5605
Currency     : USD
Deliver To   : Infinite Solutions, Delhi

Item Name    : Comprehensive Care Pack for TSC Printers
               (Item says TSC — but T310 is a Printronix model → MISMATCH)
Customer     : HOLOSTIK INDIA LIMITED
Invoice Ref  : IS-GST-2627-0064
Model        : T310
Qty          : 42 PCS
Rate         : $57.75 per unit
Total        : $2,425.50
```

### Three Key Observations

**1. The Ref# field is the linking key.**
The PO Ref# (`IS-GST-2627-0064`) is the same as the sales invoice number.
The system uses this to auto-link POs to their corresponding sales invoices.

**2. Serial numbers are in a different format to the sales invoice.**
Sales invoice: one SN per line.
PO: comma-separated, three SNs per line.
Both formats parsed by the same algorithm.

**3. Same data quality issues appear in both documents.**
Typo `TEB T25513548` (space) and duplicate `TEBT26070096` are in both the
PO and the sales invoice. After cleaning, both yield exactly 41 unique SNs
and cross-validate as a **perfect match**.

---

## 2. PO Fetch from Zoho Books

### Zoho PO Status Mapping

The user refers to POs with status **"sent"**. In Zoho Books, the
equivalent status is **"issued"** (the term Zoho uses when a PO has
been confirmed and sent to the vendor).

| User Term | Zoho Status | Meaning |
|---|---|---|
| Draft | `draft` | Not yet sent to vendor |
| **Sent** | `issued` | Confirmed and sent to vendor |
| Received | `billed` | Goods/service received, vendor invoice matched |
| Cancelled | `cancelled` | PO cancelled |

The system fetches POs with status `issued` from Zoho.

### Zoho API Call

```
GET /api/v3/purchaseorders
    ?status=issued
    &organization_id={org_id}

Authorization: Zoho-oauthtoken {access_token}
```

Optional additional filters applied in the app (not in the API call):

| Filter | Purpose |
|---|---|
| Vendor name contains "TSC" or "Printronix" or "Honeywell" | Show only OEM POs |
| Date range | Last 90 days / custom range |
| Reference number contains invoice number | Auto-match |

### What the API Returns

Zoho returns a list of POs. Each includes:

```json
{
  "purchaseorder_id":     "...",
  "purchaseorder_number": "PO-2627-0087",
  "reference_number":     "IS-GST-2627-0064",
  "date":                 "2026-07-24",
  "vendor_name":          "TSC AUTO ID TECHNOLOGY CO. LTD",
  "status":               "issued",
  "currency_code":        "USD",
  "total":                2425.50,
  "line_items": [
    {
      "name":        "Comprehensive Care Pack for TSC Printers",
      "description": "Comprehensive Care Pack 5 Years (5YCCP)...[SNs]",
      "quantity":    42,
      "rate":        57.75
    }
  ]
}
```

---

## 3. Auto-Linking PO to Sales Invoice

### The Linking Key

```
PO Ref# field       = IS-GST-2627-0064
Sales Invoice No.   = IS-GST-2627-0064
→ MATCH — auto-linked
```

When the user is working with a registered care pack batch
(imported from sales invoice IS-GST-2627-0064), and clicks
"Verify against OEM PO", the system:

1. Fetches all sent POs to OEM vendors from Zoho
2. Scans the `reference_number` field of each PO
3. If `reference_number` = current sales invoice number → **auto-highlight** that PO
4. User sees the list with the matching PO pre-selected

```
┌──────────────────────────────────────────────────────────────────────┐
│  Select OEM Purchase Order to Validate Against                       │
│  Showing: Sent POs to OEM vendors                                    │
├────────────────┬──────────────┬──────────┬──────────────────────────┤
│  PO Number     │  Vendor      │  Qty     │  Ref → Invoice           │
├────────────────┼──────────────┼──────────┼──────────────────────────┤
│ ★ PO-2627-0087 │ TSC Auto ID  │ 42 PCS   │ IS-GST-2627-0064 ✅ Match│← auto-selected
│   PO-2627-0081 │ TSC Auto ID  │ 10 PCS   │ IS-GST-2627-0058        │
│   PO-2627-0075 │ Printronix   │  5 PCS   │ IS-GST-2627-0051        │
└────────────────┴──────────────┴──────────┴──────────────────────────┘
  ★ = Auto-matched by Ref# to current invoice

  [ Use Selected PO ] [ Enter PO Number Manually ]
```

---

## 4. Serial Number Extraction from PO

### Two Formats — One Algorithm

The PO uses a different SN format to the sales invoice but the
same parsing algorithm handles both.

| Document | SN Format | Example |
|---|---|---|
| Sales Invoice | One per line | `TEBT25513533` |
| Purchase Order | Comma-separated, multiple per line | `TEBT25513533, TEBT25513545,TEBT25513546` |

### How It Works

```
Step 1: Split description by NEWLINES → get lines
Step 2: Split each line by COMMAS → get individual tokens
Step 3: Strip all whitespace from each token
Step 4: Remove all INTERNAL SPACES (handles TEB T25513548)
Step 5: Test against pattern TEBT + 8 digits
Step 6: Collect matching tokens as serial numbers
Step 7: Remove duplicates, keep first occurrence
```

This single algorithm correctly parses:
- `TEBT25513533` (clean — one per line)
- `TEBT25513533,TEBT25513545,TEBT25513546` (comma, no spaces)
- `TEBT25513533, TEBT25513545,TEBT25513546` (comma, inconsistent spaces)
- `TEB T25513548` (internal space — auto-corrected)

### Verified Results — PO-2627-0087

```
Raw SNs extracted   : 42
Space-fixed         : 1  (TEB T25513548 → TEBT25513548)
Duplicates removed  : 1  (TEBT26070096 × 2 → kept once)
Final unique SNs    : 41
```

---

## 5. Cross-Validation — PO vs Sales Invoice

### The Validation

After extracting SNs from both documents, the system compares them:

```
Sales Invoice SNs (cleaned) : 41 unique
PO SNs (cleaned)            : 41 unique
─────────────────────────────────────────
Matched in both             : 41
In PO but not in invoice    :  0
In invoice but not in PO    :  0
─────────────────────────────────────────
Result: ✅ PERFECT MATCH
```

### Result Display

**Perfect match:**
```
┌─────────────────────────────────────────────────────────────────┐
│  ✅ PO Validation Successful                                    │
│                                                                 │
│  PO-2627-0087  ↔  Invoice IS-GST-2627-0064                     │
│  41 serial numbers — perfect match in both documents           │
│                                                                 │
│  ℹ  Auto-corrections applied to PO (same as invoice):          │
│     • 1 space removed: TEB T25513548 → TEBT25513548           │
│     • 1 duplicate removed: TEBT26070096                        │
│                                                                 │
│  [ Confirm PO Linked ] [ Download Validation Report ]          │
└─────────────────────────────────────────────────────────────────┘
```

**Mismatch found:**
```
┌─────────────────────────────────────────────────────────────────┐
│  ⚠ PO Validation — Discrepancies Found                         │
│                                                                 │
│  PO-2627-0087  ↔  Invoice IS-GST-2627-0064                     │
│  38 serial numbers match. 3 discrepancies:                     │
│                                                                 │
│  IN PO but NOT in Sales Invoice (2):                           │
│    TEBT26099001  ← may be a different batch                    │
│    TEBT26099002  ← may be a different batch                    │
│                                                                 │
│  IN Sales Invoice but NOT in PO (1):                           │
│    TEBT25513547  ← missing from PO                            │
│                                                                 │
│  [ Admin Override — Accept Anyway ]  [ Cancel ]                │
└─────────────────────────────────────────────────────────────────┘
```

---

## 6. Serial Number Attachment Scenarios

When the number of printers is large, serial numbers may not be
typed into the PO description. Instead they are in an attached file.
The system handles three sources — inline description, XLSX, and PDF.

---

### Scenario A — SNs Inline in Description (Standard)

Serial numbers are typed directly in the Zoho PO description.
Both comma-separated (PO format) and one-per-line (invoice format) work.
This is the case in PO-2627-0087.

---

### Scenario B — SNs in an Attached XLSX File

User receives or creates an Excel file with serial numbers.

**What the Excel looks like** (common formats all handled):

```
Format 1 — Single column:      Format 2 — Multiple columns:
A                               A           B           C
TEBT25513533                    TEBT25513533 TEBT26070029 TEBT25513542
TEBT25513545                    TEBT25513545 TEBT25513555 TEBT26070092
TEBT25513546                    TEBT25513546 TEBT25513510 TEBT26070072
...                             ...
```

**Upload flow:**

```
On PO validation screen:
  Source of serial numbers:
  ( ) From PO description  (selected by default)
  ( ) From attached XLSX
  ( ) From attached PDF

User selects "From attached XLSX"
→ File picker appears: [ Browse XLSX file ]
→ User selects file
→ System reads every cell in every sheet
→ Extracts cells matching TEBT pattern
→ Same cleaning (spaces, duplicates) applied
→ Same cross-validation against sales invoice runs
```

**Poka-Yoke for XLSX upload:**
- If XLSX has a header row with "Serial Number" or "SN" → system uses that column only
- If no header detected → scans ALL cells in the sheet for TEBT pattern
- Empty cells, formula errors, dates → silently skipped
- Any cell value after space removal matching `TEBT\d{8}` → included
- Number of SNs found shown before validation: "Found 42 serial numbers in XLSX"

---

### Scenario C — SNs in an Attached PDF File

User uploads a PDF containing serial numbers (printed list, scanned document, or computer-generated PDF).

**Upload flow:**

```
User selects "From attached PDF"
→ File picker: [ Browse PDF file ]
→ System extracts all text from PDF
→ Splits by newlines AND commas (same as inline algorithm)
→ Extracts TEBT pattern matches
→ Same cleaning and cross-validation runs
```

**Poka-Yoke for PDF upload:**
- If PDF is scanned (image-only, no text layer) → system shows:
  "⚠ This PDF appears to be a scanned image. Text cannot be extracted automatically.
   Please type or paste the serial numbers manually, or use an XLSX file."
- If PDF text extraction finds 0 SNs → same message
- If PDF has multiple pages → all pages scanned
- Minimum: if fewer than 5 SNs found in a PDF claiming to have 42 units →
  warn: "Only 3 serial numbers found in PDF. Expected ~42. The PDF may be a scanned image."

---

### Scenario D — Manual Entry (Fallback)

If no document is available, user can type or paste serial numbers
into a text area. Accepts any format:
- One per line
- Comma-separated
- Space-separated
- Mixed

```
┌─────────────────────────────────────────────────────────────┐
│  Paste or type serial numbers (any format):                 │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ TEBT25513533, TEBT25513545                           │  │
│  │ TEBT25513546 TEBT26070029                            │  │
│  │ TEBT25513555                                         │  │
│  └───────────────────────────────────────────────────────┘  │
│  [ Extract Serial Numbers ]                                 │
└─────────────────────────────────────────────────────────────┘
```

Same algorithm applied on submission.

---

### Source Priority and Auto-detection

When a PO is fetched, the system checks automatically:

```
1. Does the description contain TEBT pattern?
   → Yes: use description (Scenario A)
   → No: continue

2. Does the PO have an XLSX attachment in Zoho?
   → Yes: auto-download and parse (Scenario B)
   → No: continue

3. Does the PO have a PDF attachment in Zoho?
   → Yes: auto-download and attempt text extraction (Scenario C)
   → No: continue

4. No SNs found anywhere:
   → Show manual entry (Scenario D)
   → Note: "No serial numbers found in this PO.
             Please attach a file or enter them manually."
```

---

## 7. PO Brand Mismatch — Same Rules Apply

The PO item name says **"Comprehensive Care Pack for TSC Printers"**
but the model in the description is **T310 (Printronix)**.

This is the same mismatch as the sales invoice. The same Poka-Yoke
rules apply to the PO:

```
PO Item Name : "Comprehensive Care Pack for TSC Printers"
Brand in name: TSC Auto ID
Model in desc: T310 → Printronix
Result       : 🔴 MISMATCH

PO Vendor    : TSC AUTO ID TECHNOLOGY CO. LTD
Brand match  : PO vendor = TSC, item brand = TSC → consistent with each other
But model    : T310 = Printronix → still flagged
```

**Additional check specific to PO:** PO vendor should be consistent
with the care pack brand in the item name.

| Scenario | Flag? |
|---|---|
| Vendor = TSC, Item = "TSC CCP", Model = TE310 | ✅ All consistent |
| Vendor = TSC, Item = "Printronix CCP", Model = T310 | ✅ Item and model match (Printronix) |
| Vendor = TSC, Item = "TSC CCP", Model = T310 | ⚠ Item says TSC, model is Printronix |
| Vendor = TSC, Item = "Printronix CCP", Model = TE310 | ⚠ Item says Printronix, model is TSC |

---

## 8. Validation Report

After successful cross-validation, a Validation Report can be downloaded
(Excel format) for records:

```
PO VALIDATION REPORT
───────────────────────────────────────────────────────
Sales Invoice  : IS-GST-2627-0064  (07/05/2026)
Purchase Order : PO-2627-0087      (24/07/2026)
Vendor         : TSC AUTO ID TECHNOLOGY CO. LTD
Customer       : HOLOSTIK INDIA LIMITED
Care Pack      : 5 Year Comprehensive
Model          : T310
Qty            : 42 (Invoice) / 41 unique (after cleaning)
Validation     : ✅ MATCHED
Validated by   : Sanjay Batra (Admin)
Validated on   : 25-Jul-2026 14:35:00
───────────────────────────────────────────────────────
SN  | Serial Number   | In Invoice | In PO | Status
 1    TEBT25513533      ✅           ✅      MATCHED
 2    TEBT25513545      ✅           ✅      MATCHED
...
41    TEBT26070076      ✅           ✅      MATCHED
───────────────────────────────────────────────────────
AUTO-CORRECTIONS APPLIED (same in both documents):
  Space removed : TEB T25513548 → TEBT25513548
  Duplicate     : TEBT26070096 (appeared twice — kept once)
───────────────────────────────────────────────────────
```

This report is stored against the care pack batch record and
can be re-downloaded at any time.

---

## 9. Poka-Yoke Rules — PO Specific

### Rule Category — PO Status

| Rule | Behaviour |
|---|---|
| Only "issued/sent" POs shown | Draft and cancelled POs filtered out — cannot be selected |
| PO must be for an OEM vendor | Non-OEM vendor POs not shown in the list |
| Cancelled PO cannot be used | If PO status changes to cancelled after selection — error on re-validate |

### Rule Category — Auto-linking

| Rule | Behaviour |
|---|---|
| Ref# mismatch warning | If user selects a PO whose Ref# ≠ current invoice → "⚠ This PO references a different invoice. Proceed?" |
| Qty mismatch between PO and invoice | "PO qty: 40. Invoice qty: 42. Difference: 2. Please verify." |
| Currency must be USD for OEM POs | If currency ≠ USD → "⚠ PO currency is [X] not USD. Verify this is an OEM purchase order." |

### Rule Category — Cross-validation

| Rule | Behaviour |
|---|---|
| Perfect match | Green banner — all SNs confirmed |
| SNs in PO not in invoice | Listed with count — may indicate wrong PO selected |
| SNs in invoice not in PO | Listed with count — missing from OEM order, needs attention |
| More than 10% mismatch | Upgrade to HIGH warning — "Over 10% of serial numbers differ. Verify correct documents." |
| 0 SNs extracted from PO | "No serial numbers found. Please upload XLSX or PDF attachment." |

### Rule Category — Attachment Upload

| Rule | Behaviour |
|---|---|
| XLSX file size limit | Max 10 MB — "File too large. Please split into multiple uploads." |
| PDF scanned image detected | Clear message + suggest XLSX alternative |
| 0 SNs found in uploaded file | "No serial numbers detected. Check file format or try manual entry." |
| SNs found < 50% of invoice qty | "Only [X] serial numbers found in file. Expected ~[Y]. File may be incomplete." |
| Wrong file type | Only .xlsx, .xls, .pdf accepted — other types rejected with message |

---

## 10. Updated Screen — Care Pack Batch Record

After validation is complete, the care pack batch record shows:

```
Care Pack Batch — IS-GST-2627-0064
─────────────────────────────────────────────────────────────────
Customer     : HOLOSTIK INDIA LIMITED, Greater Noida
Model        : T310  │  Care Pack: 5 Year  │  Devices: 41
Invoice Date : 07/05/2026  │  Warranty End: ~May 2031
─────────────────────────────────────────────────────────────────
DOCUMENTS
  Sales Invoice  : IS-GST-2627-0064       ✅ Imported
  Purchase Order : PO-2627-0087           ✅ Validated — 41/41 match
  OEM Invoice    : [Not yet entered]       ⚪ Pending
─────────────────────────────────────────────────────────────────
AUTO-CORRECTIONS (applied to both documents)
  ℹ  Space removed: TEB T25513548 → TEBT25513548
  ⚠  Duplicate removed: TEBT26070096
  ⚠  41 unique devices registered. Invoice shows 42.
     Missing SN: [ Enter correct serial number ]
─────────────────────────────────────────────────────────────────
DEVICES: 41 registered  │  [ View All ]  [ Export ]
─────────────────────────────────────────────────────────────────
```

---

## 11. Summary — What the System Handles Automatically

| Task | Manual | Automatic |
|---|---|---|
| Fetch sent POs from Zoho | ❌ | ✅ API call |
| Link PO to sales invoice via Ref# | ❌ | ✅ Ref# match |
| Parse SNs from PO description (comma format) | ❌ | ✅ |
| Parse SNs from PO description (one-per-line) | ❌ | ✅ |
| Remove spaces from SNs | ❌ | ✅ |
| Remove duplicate SNs | ❌ | ✅ |
| Extract SNs from XLSX attachment | ❌ | ✅ |
| Extract SNs from PDF attachment (text layer) | ❌ | ✅ |
| Cross-validate PO SNs vs invoice SNs | ❌ | ✅ |
| Generate validation report | ❌ | ✅ |
| Detect brand/model mismatch in PO | ❌ | ✅ |
| Detect scanned PDF (no text layer) | ❌ | ✅ |

| Task | Always Manual |
|---|---|
| Enter OEM Invoice No. and date | ✅ |
| Enter Installation Date | ✅ |
| Resolve the 1 missing SN (after duplicate removed) | ✅ |
| Override if brand mismatch cannot be fixed | ✅ Admin only |

---

*Document prepared for Infinite Solutions, New Delhi — July 2026*
*Tested against actual PO-2627-0087 and Invoice IS-GST-2627-0064*
*Cross-validation result: 41/41 perfect match after auto-cleaning*
