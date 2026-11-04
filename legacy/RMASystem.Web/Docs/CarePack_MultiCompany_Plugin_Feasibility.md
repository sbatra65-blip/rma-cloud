# Feasibility: Care Pack Edit-on-Import, Multi-Company & Import Plugins

**Status:** Research only — no code changes yet  
**Date:** 2026-08-03  
**Product:** RMA System (current Windows / Blazor install)  
**Goal:** Align Care Pack registration UX across Zoho + PDF, support multiple companies for testing, and treat Zoho (and future SAP / Busy / Tally) as pluggable import sources.

---

## 1. Executive summary

| Request | Feasible? | Effort (rough) | Notes |
|--------|-----------|----------------|--------|
| 1. Change invoice number in **all** import cases | **Yes** | Small | PDF already allows it; Zoho locks after fetch |
| 2. Change Product / Model / OEM / Period in both imports | **Yes** | Small–Medium | PDF already; Zoho needs per-line editable fields (Override today is Admin-only + shared values) |
| 3. Add / remove products on both imports | **Yes** | Medium | PDF already; Zoho needs “blank product” rows + uncheck/remove |
| 4. Multi-company (Infinite Solutions + test companies) | **Yes** | Medium → Large | Two levels: **company switcher on one install** vs **true multi-tenant SaaS** |
| 5. Zoho as plugin; PDF / SAP / Busy / Tally as plugins | **Yes (architecturally)** | Large (phased) | Start with a local **Import Source** interface; Zoho first; others later |

**Recommendation:** Ship **Phase A** (Care Pack edit parity) quickly on the current single-DB app, then **Phase B** (company profiles + plugin interface for Zoho/PDF), then **Phase C** (SAP / Busy / Tally) as paid connectors. Do **not** wait for full SaaS multi-tenancy to fix import editing.

---

## 2. What exists today (research findings)

### 2.1 Care Pack import paths

| Capability | Zoho (`CarePackImport.razor`) | PDF / manual (`CarePackPdfImportForm.razor`) |
|------------|-------------------------------|-----------------------------------------------|
| Invoice number edit before register | **No** (display-only after fetch) | **Yes** |
| Product model edit | **No** (readonly; Admin Override only) | **Yes** |
| OEM brand edit | **No** (Admin Override only) | **Yes** |
| Care pack period edit | **Yes** (per product) | **Yes** |
| Qty / serials edit | **Yes** (role-gated) | **Yes** |
| Add product not on source | **No** | **Yes** |
| Remove / skip product | Uncheck only | **Yes** (Remove) |
| Invoice prefix UX | Hardcoded `IS-GST-2627-` | Hardcoded `IS-GST-2627-` |

**Services:** `CarePackService.PreviewInvoiceAsync` / `ImportSelectedSetsAsync` (Zoho); `PreviewSalesInvoicePdf` / `CreateManualBatchesAsync` (PDF).

**Override today:** Zoho Admin Override applies **one** corrected brand/model/period to **all** selected products in one action — not per line. Post-import Admin can edit header (`UpdateBatchHeaderAsync`) and brand/product on batch detail.

### 2.2 Company branding / config

- **Settings DB:** `company_name`, address, email, phone, etc. (seeded as Infinite Solutions).
- **Actually used from settings:** mainly OEM email templates (`OemEmailService`).
- **Still hardcoded “Infinite Solutions”:** `MainLayout`, `Login`, `ChangePassword`, `Index` title, OpenTelemetry service name.
- **Zoho:** single `zoho_books_org_id` + tokens per install; OEM vendor filter hardcoded (`TSC` / `PRINTRONIX` / `HONEYWELL`).

### 2.3 Coupling

```
CarePackService ──injects──► ZohoService (always)
UI modes: "pdf" | "zoho" (string toggle, not a plugin registry)
```

PDF registration already works **without** Zoho. Zoho is tightly coupled in DI and Care Pack PO flows, but registration itself can be source-agnostic if we introduce a common “draft invoice” DTO.

---

## 3. Requested features — feasibility detail

### 3.1 Change invoice number in all cases

**Feasible: Yes.**

| Path | Change |
|------|--------|
| Zoho | After fetch, make invoice # an editable field on the draft. On register, store **edited** number as `CarePackBatch.InvoiceNumber`; keep Zoho original in a new optional field (e.g. `SourceInvoiceNumber` / `ZohoInvoiceNumber`) for audit. |
| PDF | Already editable — keep + ensure duplicate checks use the **edited** value (already do). |

**Poka-yoke:**

- Duplicate invoice + line-set index still blocked on **final** invoice number.
- If edited ≠ Zoho original, require a short reason (or Admin-only) when IRN is present — fail closed, auditable.
- Do not silently overwrite Zoho’s number in the Zoho API; only local registry.

**Risk:** Low. Users may create “corrected” numbers that no longer match GST/Zoho; mitigate with reason + audit + optional “Source invoice #” display on batch detail.

---

### 3.2 Change Product, Model, OEM, Period in both import cases

**Feasible: Yes.**

| Path | Change |
|------|--------|
| PDF | Already supported — unify labels and validation with Zoho. |
| Zoho | Per-product editable: Product line name, Model, OEM brand, Care pack period (not only Override panel). |

**Design choice (recommended):**

- Treat Zoho/PDF values as **prefill**, not locked truth.
- Always store:
  - **Source** values (as imported / detected)
  - **Registered** values (what user confirmed)
- If registered ≠ source → set `Overridden` / mismatch flag + reason (role policy: Manager+ or Admin for IRN-locked invoices).

**Poka-yoke:** Brand mismatch detector remains; registering with intentional correction requires reason when IRN locked (existing Override philosophy). Period change recalculates warranty end the same way as `UpdateCarePackPeriodAsync`.

**Risk:** Low–medium. Multi-product Zoho invoices need **per-line** corrections (today Override is shared).

---

### 3.3 Add and remove products

**Feasible: Yes.**

| Path | Change |
|------|--------|
| PDF | Already has Add / Remove. |
| Zoho | Allow **uncheck** (existing) + **Remove** from draft + **Add blank product** row (manual serials / model / period). |

**Poka-yoke:**

- Added products have no Zoho line id — mark `Source = Manual` / `AddedOnImport`.
- Removed Zoho lines are simply not registered (do not delete anything in Zoho).
- Duplicate serial checks across all products on the draft before commit.
- Multi-product register should prefer **one DB transaction** so a mid-loop failure does not leave half an invoice (current loop can partial-commit).

**Risk:** Medium (transaction wrapping + clear UI for “added vs Zoho line”).

---

### 3.4 Multi-company (testing + future)

**Feasible: Yes — two levels.**

#### Option M1 — Company profiles on one install (recommended for testing now)

- Table `Companies` (Id, Name, Code, InvoicePrefix, Active, …).
- Settings and Zoho tokens become **per company** (`CompanyId` FK).
- Users either:
  - belong to one company, or
  - Admin picks **active company** (session claim / cookie) for testing.
- Care Pack / RMA rows get `CompanyId`; all queries filter by active company.
- UI chrome reads `company_name` from active company (fix hardcoded Infinite Solutions).

**Fits:** Current Windows app + SQL Express. Good for Infinite Solutions production + a second “Demo / Test Co” without a second install.

#### Option M2 — Full multi-tenant SaaS

- Separate from this Windows build (see prior architecture canvas: Next.js + Postgres + Hostinger).
- Same plugin ideas, but different hosting and auth (2FA, etc.).

**Recommendation:** Implement **M1** in the current RMA System for testing; keep M2 as the long-term web product. Do not mix half-SaaS into the Windows service without a clear `CompanyId` model.

**Poka-yoke:**

- Never allow a query without `CompanyId` in service layer.
- Zoho org/tokens never shared across companies.
- Switching company clears Care Pack / RMA UI context (no cross-company bleed).

**Risk:** Medium–high for M1 if done without migrations and filter discipline; High if attempted as M2 inside the current Blazor Windows host.

---

### 3.5 Zoho as plugin; PDF / SAP / Busy / Tally as plugins

**Feasible: Yes**, if we introduce a thin **Import Source** abstraction first.

#### Proposed contract (conceptual)

```text
ICarePackImportSource
  Id, DisplayName, CompanyScoped
  CanFetchInvoice(companyId)
  FetchPreview(companyId, reference) → CarePackImportDraft
  Capabilities: SupportsFetch, SupportsPush, NeedsOAuth, …

CarePackImportDraft
  SourceSystem, SourceInvoiceId/Number
  InvoiceNumber, Date, Customer, IRN…
  Products[] (model, brand, period, qty, serials[], editable flags)
```

| Plugin | Role | Feasibility now |
|--------|------|-----------------|
| **PDF** | Local parse → draft | Already exists — wrap as first-class source |
| **Zoho Books** | Fetch invoice by number | Exists — extract from `CarePackService` / `ZohoService` |
| **Manual blank** | Empty draft | Trivial |
| **SAP** | OData / B1 Service Layer | Later — needs per-company credentials + discovery |
| **Busy** | Export / API / file | Later — typically file or desktop API |
| **Tally** | XML / ODBC / TallyPrime API | Later — highly version-specific |

**UI:** Import screen becomes “Choose source” (PDF | Zoho | Manual | … enabled plugins per company), then a **shared draft editor** (invoice #, products add/remove, OEM/model/period, serials) → Register (unchanged poka-yoke).

**Commercial:** Core app includes PDF + Manual; Zoho / SAP / Busy / Tally = **per-company connector** (implementation fee), matching the earlier SaaS packaging idea.

**Risks:**

- Over-engineering: do **not** build SAP/Busy/Tally until one customer needs them.
- Zoho token cache must remain **per company** once multi-company exists.
- PO validation / challan still Zoho-specific today — those become separate “Books connector” features, not part of Care Pack PDF plugin.

---

## 4. Recommended phasing

### Phase A — Care Pack draft editor parity (fast win)

1. Shared draft editor used by Zoho **and** PDF after load/fetch.  
2. Editable: invoice number, product name, model, OEM, period, qty, serials.  
3. Add / remove products on Zoho drafts.  
4. Per-product correction reason when source ≠ registered (esp. IRN).  
5. Store source vs registered fields; keep duplicate gates fail-closed.  
6. Optional: single transaction for multi-product register.

**Does not require** multi-company or full plugin framework — but design DTOs so plugins can plug in later.

### Phase B — Company profiles + Zoho/PDF plugins

1. `Companies` + `CompanyId` on Care Pack / RMA / settings / Zoho credentials.  
2. Active company switcher (Admin) for testing.  
3. `ICarePackImportSource` + register PDF + Zoho implementations.  
4. Remove Infinite Solutions hardcoding from chrome; use active company name.  
5. Configurable invoice prefix per company (replace `IS-GST-2627-`).

### Phase C — Additional ERP plugins

1. Stub registry + settings UI “Connectors”.  
2. Implement one of SAP / Busy / Tally when a real customer landscape is known.  
3. Charge implementation separately.

---

## 5. Effort sketch (current Windows app)

| Phase | Scope | Relative effort |
|-------|--------|-----------------|
| A | Edit parity + add/remove on Zoho + audit fields | ~3–7 days |
| B | Multi-company + plugin interface + Zoho/PDF adapters | ~2–4 weeks |
| C | Each new ERP plugin | ~1–4+ weeks each (discovery-dependent) |

Estimates assume one developer familiar with this codebase; exclude customer SAP discovery workshops.

---

## 6. Risks & poka-yoke checklist

| Risk | Mitigation |
|------|------------|
| Edited invoice # duplicates another batch | Keep existing unique `(InvoiceNumber, LineSetIndex)` + serial uniqueness |
| IRN-locked silent “fix” | Require reason; store source invoice # / source model |
| Partial multi-product save | Transaction around register |
| Cross-company Zoho tokens | Per-company credentials; invalidate token cache on company switch |
| Plugin scope creep | Phase A/B without SAP/Busy/Tally |
| Data migration | Backfill `CompanyId = Infinite Solutions` for existing rows |

---

## 7. Out of scope for this feasibility note

- Rewriting the whole product as Hostinger SaaS (documented separately).  
- Changing Zoho Books objects other than Care Pack invoice fetch (PO / challan stay as later connector work).  
- Implementing SAP / Busy / Tally APIs in Phase A.

---

## 8. Decision ask

1. **Approve Phase A** (edit invoice # / product / OEM / period; add/remove products on Zoho + PDF) for the next installer?  
2. For multi-company testing, prefer **Option M1 (company profiles on this install)** rather than waiting for web SaaS?  
3. Confirm plugins start as **PDF + Zoho + Manual** only, with SAP / Busy / Tally listed as future connectors?

Once approved, implementation can follow Phase A first (no multi-company required), then Phase B.

---

## 9. Key code references (current)

| Area | Location |
|------|----------|
| Zoho import UI | `RMASystem.Web/Pages/CarePackImport.razor` |
| PDF import UI | `RMASystem.Web/Shared/CarePackPdfImportForm.razor` |
| Care Pack service | `RMASystem.Web/Services/CarePackService.cs` |
| Zoho OAuth / Books | `BatchAndZohoService.cs`, `ZohoBooksCarePack.cs` |
| Company settings seed | `Data/AppDbContext.cs` |
| Override note | `Docs/CarePack_Override_Note.md` |
