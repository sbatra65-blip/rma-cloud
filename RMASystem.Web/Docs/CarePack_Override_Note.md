# Care Pack Override — Locked IRN Invoices
## Design Note

**For:** Infinite Solutions, New Delhi
**Date:** July 2026

---

## The Business Reality

Once an invoice is submitted to the Indian government e-invoicing system,
an IRN (Invoice Reference Number) is generated and the invoice is
**permanently locked** on the government portal. It cannot be amended,
cancelled, or corrected on the portal.

Example from invoice IS-GST-2627-0064:

```
IRN      : d7d666f48d6c022cca8248a17d3e6fdfbaefc4bef752d6497f77b5098309364b
Ack No.  : 172620170938699
Ack Date : 2026-05-07 17:08:00
```

This means if the wrong care pack item was selected in Zoho — for example
"Printronix CCP" was used when the printers are actually TSC — the invoice
cannot be fixed. The government record will always show the wrong item.

**The system must therefore allow Admin to override the detected values
and register devices with the correct information, while permanently
recording what the invoice actually said.**

---

## Who Can Override

| Role | Override Rights |
|---|---|
| **Admin** | Full override — brand, care pack type, model, duration |
| **Manager** | Cannot override — must escalate to Admin |
| **Technician** | Cannot override |

Only Admin sees the Override button. Manager and Technician see the
mismatch warning but have no way to bypass it — they must ask Admin
to process the import.

---

## What Can Be Overridden

| Field | Can Admin Override? | Example |
|---|---|---|
| OEM Brand | ✅ Yes | Invoice says Printronix → Admin sets TSC Auto ID |
| Care Pack Type | ✅ Yes | Invoice says wrong item → Admin sets correct type |
| Care Pack Duration | ✅ Yes | Invoice description unclear → Admin sets correct years |
| Printer Model | ✅ Yes | Model detected wrongly → Admin corrects |
| Serial Numbers | ✅ Yes | Any SN can be edited |
| Customer | ❌ No | Customer is from invoice header — always correct |
| Invoice Date | ❌ No | Date is from invoice — always correct |
| IRN | ❌ No | Government record — cannot be changed |

---

## Override Workflow

```
Invoice fetched — mismatch detected
          ↓
🔴 BRAND MISMATCH banner shown
"TSC CCP selected but T310 is a Printronix model"

          ↓ Two buttons shown:

[ ✏ Fix in Zoho and Re-fetch ]    [ 🔓 Admin Override ]

          ↓ Admin clicks Override

Override Panel opens:

┌─────────────────────────────────────────────────────────────────┐
│  🔓 ADMIN OVERRIDE — Care Pack Registration                     │
│  Invoice: IS-GST-2627-0064  │  IRN: d7d666f...309364b          │
│  ─────────────────────────────────────────────────────────────  │
│  This invoice is locked on the government e-invoicing portal.   │
│  You can register these devices with corrected information.     │
│  The original invoice values will be stored for audit.         │
│  ─────────────────────────────────────────────────────────────  │
│                                                                 │
│  ORIGINAL (from invoice)    CORRECTED (what to register)        │
│  ─────────────────────────  ───────────────────────────────     │
│  Brand  : TSC CCP           Brand  : [ Printronix      ▼ ]     │
│  Model  : T310              Model  : [ T310            ▼ ]  ✅  │
│  C.Pack : 5 Year            C.Pack : [ 5 Year          ▼ ]  ✅  │
│                                                                 │
│  Reason for override (mandatory):                               │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ Wrong care pack item selected in Zoho. Invoice locked   │   │
│  │ on IRN. Correct brand is Printronix. Verbal confirmed   │   │
│  │ with Sanjay.                                            │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ☑ I confirm this override is correct and take responsibility  │
│                                                                 │
│  [ Cancel ]              [ ✅ Apply Override and Proceed ]      │
└─────────────────────────────────────────────────────────────────┘

          ↓ Admin fills reason and confirms

Override recorded — import proceeds with corrected values
```

---

## What Gets Stored

Every device registered via override stores two sets of data:

### Set 1 — What the Invoice Actually Says (Permanent Record)

| Field | Stored As | Example |
|---|---|---|
| Invoice Item Name | `invoice_item_name` | "TSC CCP" |
| Invoice Brand Detected | `invoice_brand_detected` | "TSC Auto ID" |
| Invoice Description | `invoice_description_raw` | Full text block |
| IRN | `irn` | d7d666f...364b |
| IRN Ack Number | `irn_ack_no` | 172620170938699 |
| IRN Ack Date | `irn_ack_date` | 2026-05-07 17:08:00 |

### Set 2 — What Was Actually Registered (Correct Values)

| Field | Stored As | Example |
|---|---|---|
| OEM Brand | `oem_brand` | "Printronix" |
| Care Pack Type | `care_pack_type` | "5 Year" |
| Printer Model | `original_model` | "T310" |

### Set 3 — Override Audit Record

| Field | Example |
|---|---|
| `overridden` | true |
| `override_by` | "sanjay" (Admin username) |
| `override_at` | 2026-07-25 14:32:00 |
| `override_reason` | "Wrong care pack item in Zoho. Invoice locked on IRN." |
| `override_confirmed` | true |

This data is stored on every device record individually — not just as a
log entry — so when anyone opens a device record they see the full picture.

---

## How It Appears on Device Records

Every device registered via override shows a permanent banner:

```
┌────────────────────────────────────────────────────────────────┐
│  ⚠ OVERRIDE APPLIED — 25-Jul-2026 by Sanjay Batra (Admin)    │
│                                                                │
│  Invoice IS-GST-2627-0064 (IRN: d7d666f...364b) shows:       │
│    Item: "TSC CCP" — Brand: TSC Auto ID                       │
│                                                                │
│  Registered as:                                               │
│    Brand: Printronix  │  Care Pack: 5 Year                   │
│                                                                │
│  Reason: "Wrong care pack item in Zoho. Invoice locked."      │
└────────────────────────────────────────────────────────────────┘
```

This banner appears on:
- Device detail page
- Any RMA ticket linked to this device
- Any support ticket linked to this device
- Care pack expiry reports

It cannot be hidden or removed once set.

---

## Override Audit Log

A dedicated page at `/admin/override-log` (Admin only) lists all
overrides across all devices:

```
┌──────────────────────────────────────────────────────────────────────┐
│  Care Pack Override Log                                              │
├────────────────┬───────────┬──────────────┬──────────┬──────────────┤
│  Invoice       │  Devices  │  Overridden  │  By      │  Date        │
├────────────────┼───────────┼──────────────┼──────────┼──────────────┤
│  IS-GST-27-064 │  42       │  Brand/Type  │  Sanjay  │  25-Jul-2026 │
│  IS-GST-26-031 │  5        │  Duration    │  Sanjay  │  10-Jun-2026 │
└────────────────┴───────────┴──────────────┴──────────┴──────────────┘
```

Clicking any row shows the full override detail including IRN,
original values, corrected values, and reason.

---

## IRN Capture from Zoho

The Zoho API returns the IRN if it is stored against the invoice.
The system automatically extracts and stores:

```
GET /api/v3/invoices?invoice_number=IS-GST-2627-0064

Response includes (if e-invoiced):
  einvoice_details.irn          → stored as irn
  einvoice_details.ack_no       → stored as irn_ack_no
  einvoice_details.ack_date     → stored as irn_ack_date
```

If Zoho does not return IRN details via API, Admin can enter the
IRN manually during the override flow — it is shown as a reference
field with a paste button.

---

## Updated Poka-Yoke Rules — Override Specific

| Rule | Behaviour |
|---|---|
| Override reason is mandatory | Cannot confirm override with blank reason — button stays disabled |
| Confirmation checkbox required | Must tick "I confirm" before Apply button is enabled |
| Override is permanent | Once applied, cannot be removed — only a new override can update |
| IRN stored always | Even for clean imports (no mismatch), IRN is captured and stored |
| Override log cannot be deleted | Admin-only read access — no delete permission even for Admin |

---

## Summary of Permission Matrix Update

| Action | Admin | Manager | Technician |
|---|---|---|---|
| Import devices from invoice | ✅ | ✅ | ❌ |
| Override brand/care pack mismatch | ✅ | ❌ | ❌ |
| View override log | ✅ | ❌ | ❌ |
| Edit device after registration | ✅ | ✅ | ❌ |
| View override banner on device | ✅ | ✅ | ✅ |

---

*Design note — Infinite Solutions, New Delhi — July 2026*
*Admin override for IRN-locked invoices — full audit trail maintained*
