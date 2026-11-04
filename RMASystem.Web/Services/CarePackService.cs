using System.Text.RegularExpressions;
using ClosedXML.Excel;
using Microsoft.EntityFrameworkCore;
using RMASystem;
using RMASystem.Data;
using RMASystem.Models;
using UglyToad.PdfPig;

namespace RMASystem.Services;

public class CarePackService(AppDbContext db, ZohoService zoho, UserSessionService session, CompanyService companies)
{
    async Task ScopeAsync()
    {
        await companies.ApplyFilterAsync(db);
    }

    async Task<int> ActiveCompanyIdAsync()
    {
        await ScopeAsync();
        return db.TenantCompanyId;
    }

    // ── Preview (fetch + analyze, do not save) ────────────────────────────────
    public async Task<CarePackImportPreview> PreviewInvoiceAsync(string invoiceNumber)
    {
        await ScopeAsync();
        var inv = await zoho.GetInvoiceByNumberAsync(invoiceNumber)
            ?? throw new InvalidOperationException(
                $"Invoice '{invoiceNumber}' not found in Zoho Books.");

        var sets = InvoiceCarePackSetBuilder.Build(inv.LineItems, inv.Notes);
        if (sets.Count == 0)
            throw new InvalidOperationException("Invoice has no usable line items.");

        // Already-imported sets: allow remaining sets on multi-PO invoices
        var importedIndexes = await db.CarePackBatches
            .Where(b => b.InvoiceNumber == inv.InvoiceNumber)
            .Select(b => b.LineSetIndex)
            .ToListAsync();
        if (importedIndexes.Count > 0 && importedIndexes.Count >= sets.Count)
            throw new InvalidOperationException(
                $"Invoice {inv.InvoiceNumber} is already imported ({importedIndexes.Count} set(s)). Open from Care Packs.");

        DateTime? ackDt = null;
        if (!string.IsNullOrWhiteSpace(inv.IrnAckDate) &&
            DateTime.TryParse(inv.IrnAckDate, out var parsed))
            ackDt = parsed;

        var available = sets
            .Where(s => !importedIndexes.Contains(s.SetIndex))
            .ToList();
        if (available.Count == 0)
            throw new InvalidOperationException(
                $"All line sets on {inv.InvoiceNumber} are already imported.");

        // Default UI focus: first available set (printer SNs + care pack)
        var primary = available[0];
        var allSerials = available.SelectMany(s => s.SerialNumbers)
            .Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        var combinedDesc = string.Join("\n---\n", available.Select(s => s.CombinedDescription));
        var carePackQty = available.Sum(s => s.Qty);
        var zohoCpQty = (int)inv.LineItems
            .Where(InvoiceCarePackSetBuilder.IsCarePackLine)
            .Sum(l => l.Quantity);
        if (zohoCpQty <= 0)
            zohoCpQty = (int)inv.LineItems.Sum(l => l.Quantity);

        return new CarePackImportPreview
        {
            Invoice = inv,
            ItemName = primary.CarePackItemName ?? primary.PrinterItemName,
            DescriptionRaw = combinedDesc,
            InvoiceQty = primary.Qty,
            ZohoLineQty = zohoCpQty > 0 ? zohoCpQty : carePackQty,
            QtyFromText = SerialNumberParser.DetectQtyFromText(primary.CombinedDescription),
            Mismatch = primary.Mismatch,
            SerialParse = new SerialNumberParser.ParseResult(
                primary.SerialNumbers.ToList(), [], [], primary.SerialNumbers.Count),
            IrnAckDate = ackDt,
            DescriptionMissingFromZoho = string.IsNullOrWhiteSpace(primary.CombinedDescription),
            LineSets = available,
            AllSerialNumbers = allSerials,
        };
    }

    // ── Commit import (with optional admin override) ──────────────────────────
    public async Task<CarePackBatch> ImportAsync(CarePackImportRequest req)
    {
        await ScopeAsync();
        var companyId = await ActiveCompanyIdAsync();
        var (userName, role) = await session.GetCurrentAsync();
        if (!AppRoles.CanImport(role))
            throw new InvalidOperationException("Your role cannot import care pack invoices.");

        var preview = req.SkipPreviewFetch && req.CachedPreview != null
            ? req.CachedPreview
            : await PreviewInvoiceAsync(req.InvoiceNumber);
        var inv = preview.Invoice;

        var setIndex = req.LineSetIndex is > 0 ? req.LineSetIndex.Value : preview.LineSets.First().SetIndex;
        var set = preview.LineSets.FirstOrDefault(s => s.SetIndex == setIndex)
            ?? throw new InvalidOperationException($"Line set #{setIndex} not found or already imported.");

        var registeredInv = string.IsNullOrWhiteSpace(req.RegisteredInvoiceNumber)
            ? inv.InvoiceNumber
            : req.RegisteredInvoiceNumber.Trim();
        var sourceInv = string.IsNullOrWhiteSpace(req.SourceInvoiceNumber)
            ? inv.InvoiceNumber
            : req.SourceInvoiceNumber.Trim();

        if (await db.CarePackBatches.AnyAsync(b =>
                b.InvoiceNumber == registeredInv && b.LineSetIndex == set.SetIndex))
            throw new InvalidOperationException(
                $"Invoice {registeredInv} set #{set.SetIndex} is already imported.");

        var mismatch = set.Mismatch;
        if (mismatch.HasMismatch && !req.ApplyOverride)
            throw new InvalidOperationException(
                "Brand mismatch detected. Fix in Zoho and re-fetch, or use Admin Override / edit OEM & Model with a reason.");

        if (req.ApplyOverride && mismatch.HasMismatch)
        {
            if (!AppRoles.CanOverride(role) && string.IsNullOrWhiteSpace(req.CorrectedBrand) &&
                string.IsNullOrWhiteSpace(req.CorrectedModel))
                throw new InvalidOperationException(
                    "Only Admin can override brand/care pack mismatches without corrected values.");
            if (string.IsNullOrWhiteSpace(req.OverrideReason))
                throw new InvalidOperationException("Override / edit reason is mandatory when values change.");
            if (!req.OverrideConfirmed && mismatch.HasMismatch && AppRoles.CanOverride(role) &&
                string.IsNullOrWhiteSpace(req.CorrectedBrand))
                throw new InvalidOperationException("You must confirm the override checkbox.");
        }
        else if (req.ApplyOverride && string.IsNullOrWhiteSpace(req.OverrideReason))
        {
            // Soft override (invoice # / field edits) — reason still required when IRN present
            if (!string.IsNullOrWhiteSpace(inv.Irn) || !string.IsNullOrWhiteSpace(req.ManualIrn))
                throw new InvalidOperationException("Edit reason is mandatory when changing IRN-linked invoice fields.");
        }

        var brand = req.ApplyOverride
            ? (req.CorrectedBrand ?? mismatch.ModelBrand ?? mismatch.ItemBrand ?? set.OemBrand)
            : (!string.IsNullOrWhiteSpace(req.CorrectedBrand)
                ? req.CorrectedBrand.Trim()
                : (set.OemBrand ?? mismatch.ItemBrand ?? mismatch.ModelBrand));
        var model = req.ApplyOverride
            ? (req.CorrectedModel ?? mismatch.Model ?? set.PrinterModel)
            : (!string.IsNullOrWhiteSpace(req.CorrectedModel)
                ? req.CorrectedModel.Trim()
                : (set.PrinterModel ?? mismatch.Model));
        // Per-product care pack length may be edited without full Admin Override.
        var cpType = req.ApplyOverride
            ? (req.CorrectedCarePackType ?? req.EditedCarePackType ?? mismatch.CarePackType ?? set.CarePackType)
            : (!string.IsNullOrWhiteSpace(req.EditedCarePackType)
                ? req.EditedCarePackType.Trim()
                : (set.CarePackType ?? mismatch.CarePackType));
        var yearsFromMaster = req.DurationYears is >= 1 and <= 10 ? req.DurationYears : null;

        var irn = string.IsNullOrWhiteSpace(req.ManualIrn) ? inv.Irn : req.ManualIrn.Trim();
        var ackNo = inv.IrnAckNo;
        var ackDate = preview.IrnAckDate;

        var serials = set.SerialNumbers.ToList();
        if (!string.IsNullOrWhiteSpace(req.ManualSerialText))
        {
            var pasted = SerialNumberParser.Parse(req.ManualSerialText);
            if (pasted.SerialNumbers.Count == 0)
                pasted = SerialNumberParser.ExtractFromLooseText(req.ManualSerialText);
            if (pasted.SerialNumbers.Count == 0)
                throw new InvalidOperationException(
                    "No valid serial numbers found in the pasted text.");
            serials = pasted.SerialNumbers;
        }
        else if (req.EditedSerials is { Count: > 0 })
        {
            serials = req.EditedSerials
                .Select(s => SerialNumberParser.CleanToken(s, out _) ?? s.Trim().ToUpperInvariant())
                .Where(s => SerialNumberParser.IsValid(s))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList()!;
        }

        if (serials.Count == 0)
            throw new InvalidOperationException(
                $"Product set #{set.SetIndex}: no serial numbers. Enter a product serial number for each unit.");

        var invoiceQty = req.OverrideQty is > 0 ? req.OverrideQty.Value : set.Qty;
        if (invoiceQty <= 0) invoiceQty = serials.Count;
        if (serials.Count != invoiceQty)
            throw new InvalidOperationException(
                $"Product set #{set.SetIndex} ({model ?? set.PrinterItemName}): " +
                $"qty is {invoiceQty} but {serials.Count} serial(s) entered. Enter one serial per unit.");
        if (string.IsNullOrWhiteSpace(cpType))
            throw new InvalidOperationException(
                $"Product set #{set.SetIndex}: care pack length is required.");

        await EnsureNoDuplicateInvoiceSetAsync(registeredInv, set.SetIndex);
        await EnsureNoDuplicateSerialsAsync(serials);

        var years = yearsFromMaster ?? OemBrandCatalog.DetectDurationYears(cpType) ?? 5;
        DateOnly? warrantyEnd = null;
        if (DateOnly.TryParse(inv.Date, out var invDate))
            warrantyEnd = invDate.AddYears(years);

        EnsureWarrantyNotExpired(warrantyEnd, registeredInv, inv.Date, cpType, years);

        var itemName = !string.IsNullOrWhiteSpace(req.EditedCarePackItemName)
            ? req.EditedCarePackItemName.Trim()
            : (set.CarePackItemName ?? set.PrinterItemName);
        var printerItem = !string.IsNullOrWhiteSpace(req.EditedProductItemName)
            ? req.EditedProductItemName.Trim()
            : set.PrinterItemName;

        var batch = new CarePackBatch
        {
            CompanyId = companyId,
            InvoiceNumber = registeredInv,
            SourceInvoiceNumber = string.Equals(registeredInv, sourceInv, StringComparison.OrdinalIgnoreCase)
                ? null
                : sourceInv,
            ZohoInvoiceId = inv.InvoiceId,
            CustomerName = inv.CustomerName,
            CustomerCity = inv.CustomerCity,
            InvoiceDate = DateOnly.TryParse(inv.Date, out var d) ? d : null,
            Irn = irn,
            IrnAckNo = ackNo,
            IrnAckDate = ackDate,
            OemVendorId = req.OemVendorId is > 0 ? req.OemVendorId : null,
            ProductId = req.ProductId is > 0 ? req.ProductId : null,
            ProductModelId = req.ProductModelId is > 0 ? req.ProductModelId : null,
            CarePackTypeId = req.CarePackTypeId is > 0 ? req.CarePackTypeId : null,
            OemBrand = brand,
            CarePackType = cpType,
            PrinterModel = model,
            LineSetIndex = set.SetIndex,
            PrinterItemName = printerItem,
            InvoiceItemName = itemName,
            InvoiceDescriptionRaw = set.CombinedDescription,
            InvoiceBrandDetected = mismatch.ItemBrand ?? set.OemBrand,
            InvoiceQty = invoiceQty,
            DeviceCount = serials.Count,
            Status = CarePackBatchStatus.Imported,
            Overridden = req.ApplyOverride,
            CreatedBy = userName,
            CreatedAt = DateTime.Now,
        };

        foreach (var sn in serials)
        {
            batch.Devices.Add(new CarePackDevice
            {
                SerialNumber = sn!,
                ProductModelId = req.ProductModelId is > 0 ? req.ProductModelId : null,
                OemBrand = brand,
                CarePackType = cpType,
                OriginalModel = model,
                WarrantyEnd = warrantyEnd,
                InvoiceItemName = itemName,
                InvoiceBrandDetected = mismatch.ItemBrand ?? set.OemBrand,
                InvoiceDescriptionRaw = set.CombinedDescription,
                Irn = irn,
                IrnAckNo = ackNo,
                IrnAckDate = ackDate,
                Overridden = req.ApplyOverride,
                OverrideBy = req.ApplyOverride ? userName : null,
                OverrideAt = req.ApplyOverride ? DateTime.Now : null,
                OverrideReason = req.ApplyOverride ? req.OverrideReason : null,
                OverrideConfirmed = req.ApplyOverride && req.OverrideConfirmed,
                CreatedAt = DateTime.Now,
            });
        }

        db.CarePackBatches.Add(batch);
        await db.SaveChangesAsync();
        return batch;
    }

    /// <summary>Import every remaining product+care-pack set on the invoice (Zoho serials as detected).</summary>
    public async Task<List<CarePackBatch>> ImportAllSetsAsync(CarePackImportRequest template)
    {
        var preview = await PreviewInvoiceAsync(template.InvoiceNumber);
        return await ImportSelectedSetsAsync(new CarePackMultiImportRequest
        {
            InvoiceNumber = template.InvoiceNumber,
            ApplyOverride = template.ApplyOverride,
            OverrideReason = template.OverrideReason,
            OverrideConfirmed = template.OverrideConfirmed,
            CorrectedBrand = template.CorrectedBrand,
            CorrectedModel = template.CorrectedModel,
            CorrectedCarePackType = template.CorrectedCarePackType,
            ManualIrn = template.ManualIrn,
            Sets = preview.LineSets.Select(s => new CarePackImportSetEntry
            {
                LineSetIndex = s.SetIndex,
                Qty = s.Qty,
                CarePackType = s.CarePackType,
                Serials = s.SerialNumbers.ToList(),
            }).ToList(),
        });
    }

    /// <summary>
    /// Import one or more selected products on the same invoice.
    /// Each entry carries its own serials, qty, care pack length, and optional
    /// edited product / model / OEM (Phase A draft editor).
    /// Registered invoice # may differ from Zoho source (SourceInvoiceNumber).
    /// </summary>
    public async Task<List<CarePackBatch>> ImportSelectedSetsAsync(CarePackMultiImportRequest multi)
    {
        await ScopeAsync();
        if (multi.Sets == null || multi.Sets.Count == 0)
            throw new InvalidOperationException("Select at least one product to register.");

        var finalInv = (multi.InvoiceNumber ?? "").Trim();
        if (string.IsNullOrWhiteSpace(finalInv))
            throw new InvalidOperationException("Invoice number is required.");

        var sourceInv = string.IsNullOrWhiteSpace(multi.SourceInvoiceNumber)
            ? finalInv
            : multi.SourceInvoiceNumber.Trim();

        var allSerials = multi.Sets
            .SelectMany(s => s.Serials ?? [])
            .Where(s => !string.IsNullOrWhiteSpace(s))
            .Select(s => s.Trim())
            .ToList();
        var dup = allSerials
            .GroupBy(s => s, StringComparer.OrdinalIgnoreCase)
            .FirstOrDefault(g => g.Count() > 1);
        if (dup != null)
            throw new InvalidOperationException(
                $"Serial '{dup.Key}' is entered on more than one product. Each product serial must be unique.");

        // Fail closed before creating any set
        await EnsureNoDuplicateSerialsAsync(allSerials);
        foreach (var entry in multi.Sets)
        {
            var idx = entry.LineSetIndex > 0 ? entry.LineSetIndex : 0;
            if (idx <= 0)
                throw new InvalidOperationException("Each product needs a line set index.");
            await EnsureNoDuplicateInvoiceSetAsync(finalInv, idx);
        }

        // Fetch Zoho once by source number (original). User may register under a corrected invoice #.
        CarePackImportPreview? preview = null;
        var needsZoho = multi.Sets.Any(s => !s.IsAddedProduct);
        if (needsZoho)
            preview = await PreviewInvoiceAsync(sourceInv);

        var invoiceChanged = !string.Equals(sourceInv, finalInv, StringComparison.OrdinalIgnoreCase);
        var hasIrn = !string.IsNullOrWhiteSpace(multi.ManualIrn) ||
                     !string.IsNullOrWhiteSpace(preview?.Invoice.Irn);
        if (invoiceChanged && hasIrn && string.IsNullOrWhiteSpace(multi.InvoiceEditReason) &&
            string.IsNullOrWhiteSpace(multi.OverrideReason))
        {
            throw new InvalidOperationException(
                "Invoice number was changed on an IRN invoice. Enter an edit/override reason before register.");
        }

        await using var tx = await db.Database.BeginTransactionAsync();
        try
        {
            var results = new List<CarePackBatch>();
            var nextExtraIndex = (multi.Sets.Where(s => s.LineSetIndex > 0).Select(s => s.LineSetIndex).DefaultIfEmpty(0).Max()) + 1;

            foreach (var entry in multi.Sets.OrderBy(s => s.LineSetIndex))
            {
                if (entry.Serials == null || entry.Serials.Count == 0)
                    throw new InvalidOperationException(
                        $"Product set #{entry.LineSetIndex}: enter product serial number(s) before register.");

                if (entry.IsAddedProduct || preview == null)
                {
                    var setIndex = entry.LineSetIndex > 0 ? entry.LineSetIndex : nextExtraIndex++;
                    results.Add(await CreateManualBatchAsync(new ManualCarePackRequest
                    {
                        InvoiceNumber = finalInv,
                        SourceInvoiceNumber = invoiceChanged ? sourceInv : null,
                        LineSetIndex = setIndex,
                        CustomerName = multi.CustomerName ?? preview?.Invoice.CustomerName,
                        CustomerCity = multi.CustomerCity ?? preview?.Invoice.CustomerCity,
                        InvoiceDate = multi.InvoiceDate ??
                                      (DateOnly.TryParse(preview?.Invoice.Date, out var pd) ? pd : null),
                        PrinterItemName = entry.ProductItemName,
                        CarePackItemName = entry.CarePackItemName,
                        PrinterModel = entry.ProductModel,
                        OemBrand = entry.OemBrand,
                        CarePackType = entry.CarePackType,
                        OemVendorId = entry.OemVendorId,
                        ProductId = entry.ProductId,
                        ProductModelId = entry.ProductModelId,
                        CarePackTypeId = entry.CarePackTypeId,
                        DurationYears = entry.DurationYears,
                        Qty = entry.Qty > 0 ? entry.Qty : entry.Serials.Count,
                        Serials = entry.Serials.ToList(),
                        Irn = multi.ManualIrn ?? preview?.Invoice.Irn,
                        IrnAckNo = preview?.Invoice.IrnAckNo,
                        IrnAckDate = preview?.IrnAckDate,
                        Notes = BuildImportNotes(multi, entry, invoiceChanged, sourceInv, added: true),
                        MarkAsOverride = multi.ApplyOverride || invoiceChanged ||
                                         !string.IsNullOrWhiteSpace(entry.EditReason),
                        OverrideReason = FirstReason(entry.EditReason, multi.InvoiceEditReason, multi.OverrideReason),
                    }));
                    continue;
                }

                var set = preview.LineSets.FirstOrDefault(s => s.SetIndex == entry.LineSetIndex);
                if (set == null)
                {
                    // Zoho line missing (already imported elsewhere) — treat as added product
                    results.Add(await CreateManualBatchAsync(new ManualCarePackRequest
                    {
                        InvoiceNumber = finalInv,
                        SourceInvoiceNumber = invoiceChanged ? sourceInv : null,
                        LineSetIndex = entry.LineSetIndex,
                        CustomerName = multi.CustomerName ?? preview.Invoice.CustomerName,
                        CustomerCity = multi.CustomerCity ?? preview.Invoice.CustomerCity,
                        InvoiceDate = multi.InvoiceDate ??
                                      (DateOnly.TryParse(preview.Invoice.Date, out var pd2) ? pd2 : null),
                        PrinterItemName = entry.ProductItemName,
                        CarePackItemName = entry.CarePackItemName,
                        PrinterModel = entry.ProductModel,
                        OemBrand = entry.OemBrand,
                        CarePackType = entry.CarePackType,
                        OemVendorId = entry.OemVendorId,
                        ProductId = entry.ProductId,
                        ProductModelId = entry.ProductModelId,
                        CarePackTypeId = entry.CarePackTypeId,
                        DurationYears = entry.DurationYears,
                        Qty = entry.Qty > 0 ? entry.Qty : entry.Serials.Count,
                        Serials = entry.Serials.ToList(),
                        Irn = multi.ManualIrn ?? preview.Invoice.Irn,
                        IrnAckNo = preview.Invoice.IrnAckNo,
                        IrnAckDate = preview.IrnAckDate,
                        Notes = BuildImportNotes(multi, entry, invoiceChanged, sourceInv, added: true),
                        MarkAsOverride = true,
                        OverrideReason = FirstReason(entry.EditReason, multi.InvoiceEditReason, multi.OverrideReason)
                                         ?? "Product added / re-registered from draft editor",
                    }));
                    continue;
                }

                var brandEdited = !string.IsNullOrWhiteSpace(entry.OemBrand) &&
                    !string.Equals(entry.OemBrand.Trim(), set.OemBrand ?? "", StringComparison.OrdinalIgnoreCase);
                var modelEdited = !string.IsNullOrWhiteSpace(entry.ProductModel) &&
                    !string.Equals(entry.ProductModel.Trim(), set.PrinterModel ?? "", StringComparison.OrdinalIgnoreCase);
                var productEdited = FieldChanged(entry.ProductItemName, set.PrinterItemName);
                var anyProductEdit = brandEdited || modelEdited || productEdited ||
                                     !string.IsNullOrWhiteSpace(entry.EditReason);

                if ((anyProductEdit || invoiceChanged) && hasIrn &&
                    string.IsNullOrWhiteSpace(entry.EditReason) &&
                    string.IsNullOrWhiteSpace(multi.InvoiceEditReason) &&
                    string.IsNullOrWhiteSpace(multi.OverrideReason))
                {
                    throw new InvalidOperationException(
                        $"Product set #{entry.LineSetIndex}: values differ from Zoho/IRN source. Enter an edit reason.");
                }

                var applyOverride = multi.ApplyOverride || anyProductEdit || invoiceChanged || set.Mismatch.HasMismatch;
                if (set.Mismatch.HasMismatch && !applyOverride)
                    throw new InvalidOperationException(
                        "Brand mismatch detected. Fix in Zoho and re-fetch, or enter corrected OEM/Model with an edit reason.");

                if (set.Mismatch.HasMismatch && multi.ApplyOverride)
                {
                    var (_, role) = await session.GetCurrentAsync();
                    if (!AppRoles.CanOverride(role))
                        throw new InvalidOperationException("Only Admin can apply formal brand mismatch Override.");
                }

                results.Add(await ImportAsync(new CarePackImportRequest
                {
                    InvoiceNumber = sourceInv,
                    RegisteredInvoiceNumber = finalInv,
                    SourceInvoiceNumber = sourceInv,
                    LineSetIndex = entry.LineSetIndex,
                    ApplyOverride = applyOverride,
                    OverrideReason = FirstReason(entry.EditReason, multi.InvoiceEditReason, multi.OverrideReason),
                    OverrideConfirmed = multi.OverrideConfirmed || (applyOverride && !set.Mismatch.HasMismatch) || multi.ApplyOverride,
                    CorrectedBrand = entry.OemBrand ?? multi.CorrectedBrand,
                    CorrectedModel = entry.ProductModel ?? multi.CorrectedModel,
                    CorrectedCarePackType = multi.CorrectedCarePackType,
                    EditedCarePackType = entry.CarePackType,
                    EditedProductItemName = entry.ProductItemName,
                    EditedCarePackItemName = entry.CarePackItemName,
                    ManualIrn = multi.ManualIrn,
                    EditedSerials = entry.Serials.ToList(),
                    OverrideQty = entry.Qty > 0 ? entry.Qty : entry.Serials.Count,
                    OemVendorId = entry.OemVendorId,
                    ProductId = entry.ProductId,
                    ProductModelId = entry.ProductModelId,
                    CarePackTypeId = entry.CarePackTypeId,
                    DurationYears = entry.DurationYears,
                    SkipPreviewFetch = true,
                    CachedPreview = preview,
                }));
            }

            await tx.CommitAsync();
            return results;
        }
        catch
        {
            await tx.RollbackAsync();
            throw;
        }
    }

    static bool FieldChanged(string? edited, string? source) =>
        !string.IsNullOrWhiteSpace(edited) &&
        !string.Equals(edited.Trim(), (source ?? "").Trim(), StringComparison.OrdinalIgnoreCase);

    static string? FirstReason(params string?[] reasons) =>
        reasons.FirstOrDefault(r => !string.IsNullOrWhiteSpace(r))?.Trim();

    static string BuildImportNotes(
        CarePackMultiImportRequest multi,
        CarePackImportSetEntry entry,
        bool invoiceChanged,
        string sourceInv,
        bool added)
    {
        var parts = new List<string>();
        if (added) parts.Add("[Added product on import draft]");
        if (invoiceChanged) parts.Add($"Source invoice: {sourceInv}");
        if (!string.IsNullOrWhiteSpace(multi.InvoiceEditReason))
            parts.Add("Invoice edit: " + multi.InvoiceEditReason.Trim());
        if (!string.IsNullOrWhiteSpace(entry.EditReason))
            parts.Add("Product edit: " + entry.EditReason.Trim());
        return string.Join("\n", parts);
    }

    // ── Manual invoice (no Zoho) ───────────────────────────────────────────────

    /// <summary>
    /// Extract sales-invoice fields + serials from a PDF (text-based invoices).
    /// Pre-fills manual registration; user reviews before save.
    /// </summary>
    public SalesInvoicePdfPreview PreviewSalesInvoicePdf(Stream pdfStream)
    {
        var warnings = new List<string>();
        string? fullText;
        try
        {
            using var doc = PdfDocument.Open(pdfStream);
            fullText = string.Join("\n", doc.GetPages().Select(p => p.Text));
        }
        catch (Exception ex)
        {
            throw new InvalidOperationException("Could not read PDF: " + ex.Message);
        }

        if (string.IsNullOrWhiteSpace(fullText))
        {
            throw new InvalidOperationException(
                "This PDF has no extractable text (likely a scan). Use Manual entry or an OCR PDF.");
        }

        var snParse = SerialNumberParser.ExtractFromLooseText(fullText);
        if (snParse.SerialNumbers.Count == 0)
            snParse = SerialNumberParser.Parse(fullText);
        if (snParse.SerialNumbers.Count == 0)
            warnings.Add("No serial numbers detected. Paste them manually after review.");

        var invoiceNo = MatchFirst(fullText,
            @"\b(IS[- ]?GST[- ]?\d{2,4}[- ]?\d+)\b",
            @"Invoice\s*(?:No\.?|Number|#)\s*[:.]?\s*([A-Z0-9][-A-Z0-9/]+)",
            @"Inv\.?\s*No\.?\s*[:.]?\s*([A-Z0-9][-A-Z0-9/]+)");

        var customer = MatchFirst(fullText,
            @"(?:Bill\s*To|Buyer|Customer\s*Name|Sold\s*To)\s*[:.]?\s*([A-Za-z0-9 &.,'\-]{3,80})",
            @"M/s\.?\s+([A-Za-z0-9 &.,'\-]{3,80})");

        var city = MatchFirst(fullText,
            @"(?:City|Place)\s*[:.]?\s*([A-Za-z ]{2,40})");

        DateOnly? invDate = null;
        var dateRaw = MatchFirst(fullText,
            @"Invoice\s*Date\s*[:.]?\s*(\d{1,2}[-/]\d{1,2}[-/]\d{2,4})",
            @"Dated\s*[:.]?\s*(\d{1,2}[-/]\d{1,2}[-/]\d{2,4})",
            @"\b(\d{1,2}[-/](?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[-/]\d{2,4})\b");
        if (!string.IsNullOrWhiteSpace(dateRaw) &&
            DateTime.TryParse(dateRaw.Replace('/', '-'), out var dt))
            invDate = DateOnly.FromDateTime(dt);

        var irn = MatchFirst(fullText, @"\bIRN\s*[:.]?\s*([A-Za-z0-9]{20,100})");
        var ackNo = MatchFirst(fullText, @"Ack\s*No\.?\s*[:.]?\s*([A-Za-z0-9\-]+)");

        var model = OemBrandCatalog.DetectModelFromText(fullText)
                    ?? MatchFirst(fullText,
                        @"\b(T\d{3,4}[A-Za-z]?|TE\d{3}|MB\d{3}|T6\d{3}[A-Za-z]?)\b");
        var brand = OemBrandCatalog.DetectBrandFromText(fullText)
                    ?? OemBrandCatalog.DetectBrandFromModel(model);
        var cpType = OemBrandCatalog.CarePackTypes
            .FirstOrDefault(t => fullText.Contains(t, StringComparison.OrdinalIgnoreCase))
            ?? (Regex.IsMatch(fullText, @"\b3\s*Year", RegexOptions.IgnoreCase) ? "3 Year"
                : Regex.IsMatch(fullText, @"\b5\s*Year", RegexOptions.IgnoreCase) ? "5 Year"
                : Regex.IsMatch(fullText, @"\b1\s*Year", RegexOptions.IgnoreCase) ? "1 Year"
                : "3 Year");

        var printerItem = MatchFirst(fullText,
            @"((?:TSC|Printronix|Zebra|Honeywell)[^\n]{0,80}Printer[^\n]{0,40})",
            @"(Barcode\s+Printer[^\n]{0,60})");
        var cpItem = MatchFirst(fullText,
            @"((?:Comprehensive\s+)?Care\s*Pack[^\n]{0,80})",
            @"(YCCP[^\n]{0,60})");

        var qtyFromText = SerialNumberParser.DetectQtyFromText(fullText);
        var qty = qtyFromText ?? Math.Max(1, snParse.SerialNumbers.Count);

        if (string.IsNullOrWhiteSpace(invoiceNo))
            warnings.Add("Invoice number not found — enter it manually.");
        if (string.IsNullOrWhiteSpace(customer))
            warnings.Add("Customer name not found — enter it manually.");

        return new SalesInvoicePdfPreview
        {
            InvoiceNumber = invoiceNo ?? "",
            CustomerName = customer,
            CustomerCity = city,
            InvoiceDate = invDate,
            Irn = irn,
            IrnAckNo = ackNo,
            PrinterItemName = printerItem,
            CarePackItemName = cpItem,
            PrinterModel = model,
            OemBrand = brand,
            CarePackType = cpType,
            Qty = qty,
            SerialNumbers = snParse.SerialNumbers.ToList(),
            SerialText = string.Join("\n", snParse.SerialNumbers),
            Warnings = warnings,
            RawTextLength = fullText.Length,
        };
    }

    static string? MatchFirst(string text, params string[] patterns)
    {
        foreach (var p in patterns)
        {
            var m = Regex.Match(text, p, RegexOptions.IgnoreCase | RegexOptions.Multiline);
            if (m.Success && m.Groups.Count > 1)
            {
                var v = m.Groups[1].Value.Trim().TrimEnd('.', ',', ';');
                if (!string.IsNullOrWhiteSpace(v)) return v;
            }
        }
        return null;
    }

    public async Task<CarePackBatch> CreateManualBatchAsync(ManualCarePackRequest req)
    {
        await ScopeAsync();
        var companyId = await ActiveCompanyIdAsync();
        var (userName, role) = await session.GetCurrentAsync();
        if (!AppRoles.CanImport(role))
            throw new InvalidOperationException("Your role cannot register care pack invoices.");

        if (string.IsNullOrWhiteSpace(req.InvoiceNumber))
            throw new InvalidOperationException("Invoice number is required.");

        var setIndex = req.LineSetIndex is > 0 ? req.LineSetIndex.Value : 1;
        var invNo = req.InvoiceNumber.Trim();

        await EnsureNoDuplicateInvoiceSetAsync(invNo, setIndex);

        var serials = ParseManualSerials(req.SerialText, req.Serials);
        if (serials.Count == 0)
            throw new InvalidOperationException("Enter at least one product serial number.");

        var qty = req.Qty is > 0 ? req.Qty.Value : serials.Count;
        if (serials.Count != qty)
            throw new InvalidOperationException(
                $"Product qty is {qty} but {serials.Count} serial(s) entered. Enter one serial per unit.");
        if (string.IsNullOrWhiteSpace(req.CarePackType))
            throw new InvalidOperationException("Care pack length is required for each product.");

        await EnsureNoDuplicateSerialsAsync(serials);

        var brand = string.IsNullOrWhiteSpace(req.OemBrand) ? null : req.OemBrand.Trim();
        var model = string.IsNullOrWhiteSpace(req.PrinterModel) ? null : req.PrinterModel.Trim();
        var cpType = req.CarePackType.Trim();
        var years = req.DurationYears is >= 1 and <= 10
            ? req.DurationYears.Value
            : OemBrandCatalog.DetectDurationYears(cpType) ?? 5;

        DateOnly? invDate = req.InvoiceDate;
        DateOnly? warrantyEnd = invDate?.AddYears(years);

        EnsureWarrantyNotExpired(
            warrantyEnd,
            invNo,
            invDate?.ToString("dd-MMM-yyyy"),
            cpType,
            years);

        var desc = $"[Manual entry — no Zoho]\nProduct: {req.PrinterItemName}\nCare pack: {req.CarePackItemName}\n{req.Notes}".Trim();

        var batch = new CarePackBatch
        {
            CompanyId = companyId,
            InvoiceNumber = invNo,
            SourceInvoiceNumber = string.IsNullOrWhiteSpace(req.SourceInvoiceNumber) ||
                                  string.Equals(req.SourceInvoiceNumber.Trim(), invNo, StringComparison.OrdinalIgnoreCase)
                ? null
                : req.SourceInvoiceNumber.Trim(),
            ZohoInvoiceId = null,
            CustomerId = req.CustomerId is > 0 ? req.CustomerId : null,
            CustomerName = NullIfEmpty(req.CustomerName),
            CustomerCity = NullIfEmpty(req.CustomerCity),
            InvoiceDate = invDate,
            Irn = NullIfEmpty(req.Irn),
            IrnAckNo = NullIfEmpty(req.IrnAckNo),
            IrnAckDate = req.IrnAckDate,
            OemVendorId = req.OemVendorId is > 0 ? req.OemVendorId : null,
            ProductId = req.ProductId is > 0 ? req.ProductId : null,
            ProductModelId = req.ProductModelId is > 0 ? req.ProductModelId : null,
            CarePackTypeId = req.CarePackTypeId is > 0 ? req.CarePackTypeId : null,
            OemBrand = brand,
            CarePackType = cpType,
            PrinterModel = model,
            LineSetIndex = setIndex,
            PrinterItemName = NullIfEmpty(req.PrinterItemName),
            InvoiceItemName = NullIfEmpty(req.CarePackItemName) ?? NullIfEmpty(req.PrinterItemName),
            InvoiceDescriptionRaw = desc,
            InvoiceBrandDetected = brand,
            InvoiceQty = qty,
            DeviceCount = serials.Count,
            Status = CarePackBatchStatus.Imported,
            Overridden = req.MarkAsOverride,
            CreatedBy = userName,
            CreatedAt = DateTime.Now,
        };

        foreach (var sn in serials)
        {
            batch.Devices.Add(new CarePackDevice
            {
                SerialNumber = sn,
                ProductModelId = req.ProductModelId is > 0 ? req.ProductModelId : null,
                OemBrand = brand,
                CarePackType = cpType,
                OriginalModel = model,
                WarrantyEnd = warrantyEnd,
                InvoiceItemName = batch.InvoiceItemName,
                InvoiceBrandDetected = brand,
                InvoiceDescriptionRaw = desc,
                Irn = batch.Irn,
                IrnAckNo = batch.IrnAckNo,
                IrnAckDate = batch.IrnAckDate,
                Overridden = req.MarkAsOverride,
                OverrideBy = req.MarkAsOverride ? userName : null,
                OverrideAt = req.MarkAsOverride ? DateTime.Now : null,
                OverrideReason = req.MarkAsOverride
                    ? (NullIfEmpty(req.OverrideReason) ?? "Manual entry (Zoho unavailable)")
                    : null,
                OverrideConfirmed = req.MarkAsOverride,
                CreatedAt = DateTime.Now,
            });
        }

        db.CarePackBatches.Add(batch);
        await db.SaveChangesAsync();
        return batch;
    }

    /// <summary>
    /// Register multiple products on one manual/PDF invoice.
    /// Each product becomes its own line set with its own serials.
    /// </summary>
    public async Task<List<CarePackBatch>> CreateManualBatchesAsync(ManualCarePackMultiRequest multi)
    {
        await ScopeAsync();
        if (string.IsNullOrWhiteSpace(multi.InvoiceNumber))
            throw new InvalidOperationException("Invoice number is required.");
        if (multi.Products == null || multi.Products.Count == 0)
            throw new InvalidOperationException("Add at least one product with serial numbers.");

        var invNo = multi.InvoiceNumber.Trim();
        var invLower = invNo.ToLowerInvariant();
        var sourceInv = string.IsNullOrWhiteSpace(multi.SourceInvoiceNumber)
            ? null
            : multi.SourceInvoiceNumber.Trim();
        var invoiceChanged = !string.IsNullOrWhiteSpace(sourceInv) &&
                             !string.Equals(sourceInv, invNo, StringComparison.OrdinalIgnoreCase);

        if (invoiceChanged && !string.IsNullOrWhiteSpace(multi.Irn) &&
            string.IsNullOrWhiteSpace(multi.OverrideReason))
        {
            throw new InvalidOperationException(
                "Invoice number was changed on an IRN invoice. Enter an edit/override reason before register.");
        }

        // Re-registering an invoice that already exists is blocked (poka-yoke).
        // Multi-product on a *new* invoice is allowed in this one call (sets 1..N).
        if (await db.CarePackBatches.AsNoTracking()
                .AnyAsync(b => b.InvoiceNumber.ToLower() == invLower))
        {
            throw new InvalidOperationException(
                $"Duplicate blocked: invoice {invNo} already exists in Care Packs. " +
                "Open the existing record — do not register the same invoice again.");
        }

        var allSerials = multi.Products
            .SelectMany(p =>
            {
                var parsed = ParseManualSerials(p.SerialText, p.Serials);
                return parsed;
            })
            .ToList();
        await EnsureNoDuplicateSerialsAsync(allSerials);

        var usedIndexes = new List<int>();
        var nextIndex = 1;

        await using var tx = await db.Database.BeginTransactionAsync();
        try
        {
            var results = new List<CarePackBatch>();
            foreach (var product in multi.Products)
            {
                var setIndex = product.LineSetIndex is > 0 ? product.LineSetIndex.Value : nextIndex++;
                while (usedIndexes.Contains(setIndex) || results.Any(r => r.LineSetIndex == setIndex))
                    setIndex = nextIndex++;

                var batch = await CreateManualBatchAsync(new ManualCarePackRequest
                {
                    InvoiceNumber = invNo,
                    SourceInvoiceNumber = invoiceChanged ? sourceInv : null,
                    LineSetIndex = setIndex,
                    CustomerId = multi.CustomerId,
                    CustomerName = multi.CustomerName,
                    CustomerCity = multi.CustomerCity,
                    InvoiceDate = multi.InvoiceDate,
                    PrinterItemName = product.ProductItemName,
                    CarePackItemName = product.CarePackItemName,
                    PrinterModel = product.ProductModel,
                    OemBrand = product.OemBrand,
                    CarePackType = product.CarePackType,
                    OemVendorId = product.OemVendorId,
                    ProductId = product.ProductId,
                    ProductModelId = product.ProductModelId,
                    CarePackTypeId = product.CarePackTypeId,
                    DurationYears = product.DurationYears,
                    Qty = product.Qty,
                    SerialText = product.SerialText,
                    Serials = product.Serials,
                    Irn = multi.Irn,
                    IrnAckNo = multi.IrnAckNo,
                    IrnAckDate = multi.IrnAckDate,
                    Notes = multi.Notes,
                    MarkAsOverride = multi.MarkAsOverride || invoiceChanged,
                    OverrideReason = multi.OverrideReason,
                });
                results.Add(batch);
                usedIndexes.Add(setIndex);
            }
            await tx.CommitAsync();
            return results;
        }
        catch
        {
            await tx.RollbackAsync();
            throw;
        }
    }

    static List<string> ParseManualSerials(string? text, IEnumerable<string>? list)
    {
        var serials = new List<string>();
        if (!string.IsNullOrWhiteSpace(text))
        {
            var parsed = SerialNumberParser.Parse(text);
            if (parsed.SerialNumbers.Count == 0)
                parsed = SerialNumberParser.ExtractFromLooseText(text);
            serials.AddRange(parsed.SerialNumbers);
        }
        if (list != null)
        {
            foreach (var s in list)
            {
                var c = SerialNumberParser.CleanToken(s, out _) ?? s.Trim().ToUpperInvariant();
                if (SerialNumberParser.IsValid(c) &&
                    !serials.Contains(c, StringComparer.OrdinalIgnoreCase))
                    serials.Add(c);
            }
        }
        // Last resort: one token per line without noise filter
        if (serials.Count == 0 && !string.IsNullOrWhiteSpace(text))
        {
            foreach (var line in text.Split(['\r', '\n', ',', ';'],
                         StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                var c = SerialNumberParser.CleanToken(line, out _) ?? line.Trim().ToUpperInvariant();
                if (!string.IsNullOrWhiteSpace(c) &&
                    !serials.Contains(c, StringComparer.OrdinalIgnoreCase))
                    serials.Add(c);
            }
        }
        return serials;
    }

    static string? NullIfEmpty(string? s) =>
        string.IsNullOrWhiteSpace(s) ? null : s.Trim();

    /// <summary>
    /// Poka-yoke: refuse import when care-pack warranty end is already before today.
    /// Fail closed — no silent import of expired cover.
    /// </summary>
    static void EnsureWarrantyNotExpired(
        DateOnly? warrantyEnd,
        string invoiceNumber,
        string? invoiceDateText,
        string? carePackType,
        int years)
    {
        var today = DateOnly.FromDateTime(DateTime.Today);
        if (warrantyEnd == null)
        {
            throw new InvalidOperationException(
                $"Cannot import {invoiceNumber}: invoice date is missing, so warranty end cannot be verified. " +
                "Enter a valid sales invoice date and try again.");
        }

        if (warrantyEnd.Value < today)
        {
            throw new InvalidOperationException(
                $"Cannot import {invoiceNumber}: care pack warranty already ended on {warrantyEnd:dd-MMM-yyyy} " +
                $"(invoice {(string.IsNullOrWhiteSpace(invoiceDateText) ? "—" : invoiceDateText)} + " +
                $"{years} year(s) from {carePackType ?? "care pack"}). " +
                "Expired care packs must not be registered.");
        }
    }

    /// <summary>
    /// Poka-yoke: invoice number + line set must not already exist (case-insensitive).
    /// </summary>
    async Task EnsureNoDuplicateInvoiceSetAsync(
        string invoiceNumber, int lineSetIndex, int? excludeBatchId = null)
    {
        var inv = (invoiceNumber ?? "").Trim();
        if (string.IsNullOrEmpty(inv))
            throw new InvalidOperationException("Invoice number is required.");

        var invLower = inv.ToLowerInvariant();
        var q = db.CarePackBatches.AsNoTracking()
            .Where(b => b.LineSetIndex == lineSetIndex && b.InvoiceNumber.ToLower() == invLower);
        if (excludeBatchId is > 0)
            q = q.Where(b => b.Id != excludeBatchId.Value);

        var hit = await q.FirstOrDefaultAsync();
        if (hit != null)
        {
            throw new InvalidOperationException(
                $"Duplicate blocked: invoice {hit.InvoiceNumber} (product set #{lineSetIndex}) " +
                "already exists in Care Packs. Open the existing record — do not register again.");
        }
    }

    /// <summary>
    /// Poka-yoke: product serial numbers must be unique across the Care Pack registry.
    /// </summary>
    async Task EnsureNoDuplicateSerialsAsync(
        IEnumerable<string> serials, int? excludeBatchId = null)
    {
        var list = NormalizeSerials(serials);
        if (list.Count == 0) return;

        var rawDup = serials
            .Where(s => !string.IsNullOrWhiteSpace(s))
            .Select(s => SerialNumberParser.CleanToken(s, out _) ?? s.Trim().ToUpperInvariant())
            .GroupBy(s => s, StringComparer.OrdinalIgnoreCase)
            .Where(g => g.Count() > 1)
            .Select(g => g.Key)
            .Take(5)
            .ToList();
        if (rawDup.Count > 0)
        {
            throw new InvalidOperationException(
                "Duplicate blocked: the same product serial is entered more than once in this registration: " +
                string.Join(", ", rawDup));
        }

        var upper = list.Select(s => s.ToUpperInvariant()).ToList();
        var clashes = new List<(string Serial, string Invoice)>();

        var dbHits = await db.CarePackDevices.AsNoTracking()
            .Include(d => d.Batch)
            .Where(d => d.Batch.CompanyId == db.TenantCompanyId)
            .Where(d => excludeBatchId == null || d.CarePackBatchId != excludeBatchId.Value)
            .Where(d => upper.Contains(d.SerialNumber.ToUpper()))
            .Select(d => new { d.SerialNumber, d.Batch.InvoiceNumber })
            .Take(20)
            .ToListAsync();
        foreach (var h in dbHits)
            clashes.Add((h.SerialNumber, h.InvoiceNumber));

        if (clashes.Count == 0)
        {
            foreach (var sn in list)
            {
                var hit = await FindSerialAsync(sn);
                if (hit != null && (excludeBatchId == null || hit.BatchId != excludeBatchId.Value))
                {
                    clashes.Add((hit.SerialNumber, hit.InvoiceNumber));
                    break;
                }
            }
        }

        if (clashes.Count > 0)
        {
            var detail = string.Join("; ", clashes.Take(5).Select(e =>
                $"{e.Serial} (invoice {e.Invoice})"));
            throw new InvalidOperationException(
                "Duplicate blocked: product serial number(s) already registered in Care Packs: " + detail +
                ". Each serial can only be registered once.");
        }
    }

    // ── PO validation ─────────────────────────────────────────────────────────
    public async Task<List<ZohoPurchaseOrderSummary>> GetOemPosForInvoiceAsync(string invoiceNumber)
    {
        var all = await zoho.GetIssuedPurchaseOrdersAsync();
        return all
            .Where(p => ZohoService.IsOemVendor(p.VendorName))
            .OrderByDescending(p =>
                string.Equals(p.ReferenceNumber, invoiceNumber, StringComparison.OrdinalIgnoreCase))
            .ThenByDescending(p => p.Date)
            .ToList();
    }

    /// <summary>Fetch a single PO by number from Zoho (for one-PO lookup without loading full list).</summary>
    public async Task<ZohoPurchaseOrderSummary> GetPoSummaryByNumberAsync(string poNumber)
    {
        if (string.IsNullOrWhiteSpace(poNumber))
            throw new InvalidOperationException("Enter a PO number.");

        ZohoPurchaseOrderDetail? detail;
        try
        {
            detail = await zoho.GetPurchaseOrderByNumberAsync(poNumber.Trim());
        }
        catch (Exception ex)
        {
            throw new InvalidOperationException(
                "Zoho could not fetch that PO: " + ex.Message + " — use Manual PO entry instead.");
        }

        if (detail == null)
            throw new InvalidOperationException(
                $"PO '{poNumber.Trim()}' was not found in Zoho. Check the number or use Manual PO entry.");

        if (ZohoService.IsExcludedPoStatus(detail.Status))
            throw new InvalidOperationException(
                $"PO status '{detail.Status}' cannot be used (draft/cancelled excluded).");

        var qty = (int)detail.LineItems.Sum(l => l.Quantity);
        return new ZohoPurchaseOrderSummary(
            detail.PurchaseOrderId,
            detail.PurchaseOrderNumber,
            detail.ReferenceNumber,
            detail.VendorName,
            detail.Date,
            detail.Status,
            detail.CurrencyCode,
            detail.Total,
            qty);
    }

    /// <summary>Cross-validate using a fully manual PO (no Zoho call).</summary>
    /// <param name="linkBatchIds">All Care Pack batches to link to this PO (must include batchId or will be added).</param>
    public async Task<PoValidationPreview> PreviewManualPoValidationAsync(
        int batchId, ManualPoRequest req, IReadOnlyList<int>? linkBatchIds = null)
    {
        var batches = await LoadBatchesForPoLinkAsync(batchId, linkBatchIds, req.PurchaseOrderNumber);
        var batch = batches.First(b => b.Id == batchId);

        if (string.IsNullOrWhiteSpace(req.PurchaseOrderNumber))
            throw new InvalidOperationException("PO number is required.");

        var warnings = new List<string> { "Manual PO entry — Zoho was not used." };

        if (!string.IsNullOrWhiteSpace(req.ReferenceNumber) &&
            !batches.Any(b => string.Equals(b.InvoiceNumber, req.ReferenceNumber, StringComparison.OrdinalIgnoreCase)))
        {
            warnings.Add(
                $"PO Ref# is {req.ReferenceNumber} (not one of the selected invoices). OK when clubbing multiple invoices.");
        }

        var totalInvQty = batches.Sum(b => b.InvoiceQty > 0 ? b.InvoiceQty : b.DeviceCount);
        var poQty = req.Quantity ?? 0;
        AddClubbedQtyNotes(warnings, poQty, totalInvQty);
        AddMultiPartyClubNote(warnings, batches);

        if (!string.IsNullOrWhiteSpace(req.CurrencyCode) &&
            !string.Equals(req.CurrencyCode, "USD", StringComparison.OrdinalIgnoreCase))
            warnings.Add($"PO currency is {req.CurrencyCode} not USD. Verify this is an OEM purchase order.");

        var snParse = ParseManualSerialText(req.SerialText);

        if (snParse.SerialNumbers.Count == 0)
            warnings.Add("No PO serial numbers entered — link will record PO number only; SN match cannot be verified.");

        var batchMatches = BuildBatchMatches(batches, snParse.SerialNumbers);
        var cross = batchMatches.First(m => m.BatchId == batchId).Cross;
        AddMultiInvoiceMatchNotes(warnings, batchMatches, snParse.SerialNumbers.Count);

        var alreadyOnPo = await GetBatchesAlreadyOnPoAsync(req.PurchaseOrderNumber.Trim());
        if (alreadyOnPo.Count > 0)
        {
            warnings.Add(
                $"This PO is already linked to {alreadyOnPo.Count} other invoice(s): " +
                string.Join(", ", alreadyOnPo.Select(b => b.InvoiceNumber).Take(8)) +
                (alreadyOnPo.Count > 8 ? "…" : "") + ".");
        }

        var clubCandidates = await GetPoClubCandidatesAsync(batch.Id);
        var poDesc = req.Notes ?? "";
        var mismatch = BrandMismatchDetector.Analyze(req.ItemName, poDesc, req.VendorName);

        var po = new ZohoPurchaseOrderDetail(
            "MANUAL",
            req.PurchaseOrderNumber.Trim(),
            NullIfEmpty(req.ReferenceNumber) ?? batch.InvoiceNumber,
            NullIfEmpty(req.VendorName),
            req.Date?.ToString("yyyy-MM-dd"),
            "manual",
            NullIfEmpty(req.CurrencyCode) ?? "USD",
            0,
            [
                new ZohoLineItem(
                    req.ItemName ?? "Care Pack",
                    req.Notes,
                    poQty > 0 ? poQty : snParse.SerialNumbers.Count,
                    0)
            ]);

        var preview = new PoValidationPreview
        {
            Batch = batch,
            PurchaseOrder = po,
            PoMismatch = mismatch,
            SerialParse = snParse,
            Cross = cross,
            Warnings = warnings,
            SourceUsed = "Manual PO entry",
            IsManualPo = true,
            ClubCandidates = clubCandidates,
            AlreadyOnPo = alreadyOnPo,
            SelectedBatchIds = batches.Select(b => b.Id).ToList(),
            BatchMatches = batchMatches,
            AllSelectedMatch = batchMatches.Count > 0 && batchMatches.All(m => m.Cross.PerfectMatch),
        };
        await AttachPoDeadlineFlagsAsync(preview, batches);
        return preview;
    }

    public async Task<PoValidationPreview> PreviewPoValidationAsync(
        int batchId, string? poId, string? poNumber,
        string? snSourceText, Stream? xlsxStream, Stream? pdfStream, string sourceMode,
        IReadOnlyList<int>? linkBatchIds = null)
    {
        // Load devices first; PO ownership checked after Zoho returns the PO number
        var batches = await LoadBatchesForPoLinkAsync(batchId, linkBatchIds, enforcePoOwnership: false);
        var batch = batches.First(b => b.Id == batchId);

        ZohoPurchaseOrderDetail? po = null;
        try
        {
            if (!string.IsNullOrWhiteSpace(poId))
                po = await zoho.GetPurchaseOrderByIdAsync(poId);
            else if (!string.IsNullOrWhiteSpace(poNumber))
                po = await zoho.GetPurchaseOrderByNumberAsync(poNumber);
        }
        catch (Exception ex)
        {
            throw new InvalidOperationException(
                "Zoho PO fetch failed: " + ex.Message +
                " Use Manual PO entry below instead.");
        }

        if (po == null)
            throw new InvalidOperationException(
                "Purchase order not found in Zoho. Use Manual PO entry instead.");

        if (ZohoService.IsExcludedPoStatus(po.Status))
            throw new InvalidOperationException(
                $"PO status '{po.Status}' cannot be used. Draft and cancelled POs are excluded.");

        // Re-load with PO number so same-PO retry is allowed
        batches = await LoadBatchesForPoLinkAsync(batchId, linkBatchIds, po.PurchaseOrderNumber);
        batch = batches.First(b => b.Id == batchId);

        var warnings = new List<string>();

        if (!string.IsNullOrWhiteSpace(po.ReferenceNumber) &&
            !batches.Any(b => string.Equals(b.InvoiceNumber, po.ReferenceNumber, StringComparison.OrdinalIgnoreCase)))
        {
            warnings.Add(
                $"PO Ref# is {po.ReferenceNumber} (not one of the selected invoices). OK when clubbing multiple invoices.");
        }

        var totalInvQty = batches.Sum(b => b.InvoiceQty > 0 ? b.InvoiceQty : b.DeviceCount);
        var poQty = (int)po.LineItems.Sum(l => l.Quantity);
        AddClubbedQtyNotes(warnings, poQty, totalInvQty);
        AddMultiPartyClubNote(warnings, batches);

        if (!string.IsNullOrWhiteSpace(po.CurrencyCode) &&
            !string.Equals(po.CurrencyCode, "USD", StringComparison.OrdinalIgnoreCase))
            warnings.Add($"PO currency is {po.CurrencyCode} not USD. Verify this is an OEM purchase order.");

        var line = po.LineItems.FirstOrDefault();
        var desc = string.Join("\n", po.LineItems.Select(l => $"{l.Name}\n{l.Description}"));
        var mismatch = BrandMismatchDetector.Analyze(line?.Name, desc, po.VendorName);
        if (mismatch.HasMismatch)
            warnings.Add($"PO brand mismatch: {mismatch.Message}");

        SerialNumberParser.ParseResult snParse;
        string usedSource;

        switch (sourceMode.ToLowerInvariant())
        {
            case "xlsx" when xlsxStream != null:
                snParse = SerialNumberParser.ParseXlsx(xlsxStream);
                usedSource = "XLSX attachment";
                break;
            case "pdf" when pdfStream != null:
                snParse = ParsePdf(pdfStream, out var pdfWarn);
                usedSource = "PDF attachment";
                if (pdfWarn != null) warnings.Add(pdfWarn);
                break;
            case "manual":
                snParse = SerialNumberParser.Parse(snSourceText);
                usedSource = "Manual entry";
                break;
            default:
                snParse = SerialNumberParser.Parse(desc);
                usedSource = "PO description";
                if (snParse.SerialNumbers.Count == 0 && !string.IsNullOrWhiteSpace(snSourceText))
                {
                    snParse = SerialNumberParser.Parse(snSourceText);
                    usedSource = "Manual entry";
                }
                break;
        }

        if (snParse.SerialNumbers.Count == 0)
            warnings.Add("No serial numbers found. Please upload XLSX or PDF attachment, or enter them manually.");

        if (totalInvQty > 0 && snParse.SerialNumbers.Count > 0 &&
            snParse.SerialNumbers.Count < totalInvQty * 0.5)
        {
            warnings.Add(
                $"Only {snParse.SerialNumbers.Count} serial numbers found on PO source. " +
                $"Selected invoices expect ~{totalInvQty}. File may be incomplete.");
        }

        var batchMatches = BuildBatchMatches(batches, snParse.SerialNumbers);
        var cross = batchMatches.First(m => m.BatchId == batchId).Cross;
        AddMultiInvoiceMatchNotes(warnings, batchMatches, snParse.SerialNumbers.Count);

        var alreadyOnPo = await GetBatchesAlreadyOnPoAsync(po.PurchaseOrderNumber);
        if (alreadyOnPo.Count > 0)
        {
            warnings.Add(
                $"This PO is already linked to {alreadyOnPo.Count} other invoice(s): " +
                string.Join(", ", alreadyOnPo.Select(b => b.InvoiceNumber).Take(8)) +
                (alreadyOnPo.Count > 8 ? "…" : "") + ".");
        }

        var clubCandidates = await GetPoClubCandidatesAsync(batch.Id);

        var preview = new PoValidationPreview
        {
            Batch = batch,
            PurchaseOrder = po,
            PoMismatch = mismatch,
            SerialParse = snParse,
            Cross = cross,
            Warnings = warnings,
            SourceUsed = usedSource,
            IsManualPo = false,
            ClubCandidates = clubCandidates,
            AlreadyOnPo = alreadyOnPo,
            SelectedBatchIds = batches.Select(b => b.Id).ToList(),
            BatchMatches = batchMatches,
            AllSelectedMatch = batchMatches.Count > 0 && batchMatches.All(m => m.Cross.PerfectMatch),
        };
        await AttachPoDeadlineFlagsAsync(preview, batches);
        return preview;
    }

    static SerialNumberParser.ParseResult ParseManualSerialText(string? serialText)
    {
        var snParse = SerialNumberParser.Parse(serialText);
        if (snParse.SerialNumbers.Count == 0)
            snParse = SerialNumberParser.ExtractFromLooseText(serialText);
        if (snParse.SerialNumbers.Count == 0 && !string.IsNullOrWhiteSpace(serialText))
        {
            var raw = serialText!.Split(['\r', '\n', ',', ';'],
                StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Select(s => SerialNumberParser.CleanToken(s, out _) ?? s.Trim().ToUpperInvariant())
                .Where(s => !string.IsNullOrWhiteSpace(s))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();
            snParse = new SerialNumberParser.ParseResult(raw!, [], [], raw.Count);
        }
        return snParse;
    }

    async Task<List<CarePackBatch>> LoadBatchesForPoLinkAsync(
        int primaryBatchId, IReadOnlyList<int>? linkBatchIds,
        string? expectedPoNumber = null, bool enforcePoOwnership = true)
    {
        var ids = new List<int> { primaryBatchId };
        if (linkBatchIds != null)
        {
            foreach (var id in linkBatchIds)
            {
                if (!ids.Contains(id)) ids.Add(id);
            }
        }

        var batches = await db.CarePackBatches
            .Include(b => b.Devices)
            .Where(b => ids.Contains(b.Id))
            .ToListAsync();

        if (batches.All(b => b.Id != primaryBatchId))
            throw new InvalidOperationException("Care pack batch not found.");

        if (batches.Count != ids.Count)
        {
            var missing = ids.Except(batches.Select(b => b.Id)).ToList();
            throw new InvalidOperationException($"Batch(es) not found: {string.Join(", ", missing)}");
        }

        // Same OEM PO may cover invoices for different end customers / parties.
        // Serial match (each invoice's SNs ⊆ PO) is the gate — not customer name.

        if (enforcePoOwnership)
        {
            foreach (var b in batches)
            {
                if (string.IsNullOrWhiteSpace(b.PurchaseOrderNumber)) continue;
                if (!string.IsNullOrWhiteSpace(expectedPoNumber) &&
                    string.Equals(b.PurchaseOrderNumber, expectedPoNumber.Trim(), StringComparison.OrdinalIgnoreCase))
                    continue; // already on this OEM PO — OK for club retry
                throw new InvalidOperationException(
                    $"Invoice {b.InvoiceNumber} already has PO {b.PurchaseOrderNumber}. " +
                    "Admin can remove that PO from the invoice (reason + confirmation) before linking another.");
            }
        }

        return batches.OrderBy(b => b.Id == primaryBatchId ? 0 : 1).ThenBy(b => b.InvoiceNumber).ToList();
    }

    static List<string> NormalizeSerials(IEnumerable<string?> sns) =>
        sns.Select(s =>
            {
                if (string.IsNullOrWhiteSpace(s)) return null;
                return SerialNumberParser.CleanToken(s, out _)
                       ?? s.Trim().Replace(" ", "", StringComparison.Ordinal).ToUpperInvariant();
            })
            .Where(s => !string.IsNullOrWhiteSpace(s))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Cast<string>()
            .ToList();

    static List<PoBatchMatchRow> BuildBatchMatches(
        IEnumerable<CarePackBatch> batches, IReadOnlyList<string> poSerials)
    {
        var poNorm = NormalizeSerials(poSerials);
        var rows = new List<PoBatchMatchRow>();
        foreach (var b in batches)
        {
            var invoiceSns = NormalizeSerials(b.Devices.Select(d => d.SerialNumber));
            var cross = poNorm.Count == 0
                ? new SerialNumberParser.CrossValidationResult(invoiceSns, [], invoiceSns, 100, false, true)
                : SerialNumberParser.CrossValidate(invoiceSns, poNorm, clubbedPo: true);
            rows.Add(new PoBatchMatchRow(
                b.Id, b.InvoiceNumber, b.DeviceCount, b.CustomerName, b.PrinterModel, cross));
        }
        return rows;
    }

    async Task AttachPoDeadlineFlagsAsync(PoValidationPreview preview, List<CarePackBatch> batches)
    {
        var (poLimit, _) = await GetDeadlineLimitsAsync();
        var late = new List<string>();
        foreach (var b in batches)
        {
            var due = CarePackDeadlines.PoDueDate(b.InvoiceDate, poLimit);
            var rem = CarePackDeadlines.DaysRemaining(due);
            if (rem < 0)
            {
                late.Add($"{b.InvoiceNumber} ({-rem}d past app limit)");
                preview.Warnings.Add(
                    $"Note: {b.InvoiceNumber} is past the {poLimit}-day PO window (sales invoice {b.InvoiceDate:dd-MMM-yyyy}). " +
                    "You can still link when serials match — useful for historical imports.");
            }
        }
        // Informational only — does not block Confirm when serials match
        preview.RequiresLatePoOverride = false;
        preview.LatePoLabels = late;
    }

    static void AddMultiInvoiceMatchNotes(
        List<string> warnings, List<PoBatchMatchRow> matches, int poSnCount)
    {
        if (poSnCount <= 0) return;

        var ok = matches.Count(m => m.Cross.PerfectMatch);
        var bad = matches.Count - ok;
        if (matches.Count > 1)
        {
            warnings.Add(
                $"Selected {matches.Count} invoice(s): {ok} fully matched on PO, {bad} with missing serials.");
        }

        foreach (var m in matches.Where(x => x.Cross.PerfectMatch && x.Cross.OnlyInPo.Count > 0).Take(1))
        {
            // informational once
            warnings.Add(
                $"PO lists extra serials beyond selected invoices ({m.Cross.OnlyInPo.Count}+) — normal if more invoices share this OEM PO later.");
            break;
        }

        foreach (var m in matches.Where(x => !x.Cross.PerfectMatch && x.Cross.OnlyInInvoice.Count > 0))
        {
            if (m.Cross.MismatchPercent > 10)
            {
                warnings.Add(
                    $"Invoice {m.InvoiceNumber}: {m.Cross.OnlyInInvoice.Count} serial(s) missing from PO.");
            }
        }
    }

    static void AddClubbedQtyNotes(List<string> warnings, int poQty, int invoiceQty)
    {
        if (poQty <= 0 || invoiceQty <= 0) return;
        if (poQty < invoiceQty)
        {
            warnings.Add(
                $"PO qty ({poQty}) is less than this invoice qty ({invoiceQty}). Verify the PO covers these devices.");
        }
        else if (poQty > invoiceQty)
        {
            warnings.Add(
                $"PO qty ({poQty}) > this invoice ({invoiceQty}) — expected when multiple invoices are clubbed on one OEM PO.");
        }
    }

    static void AddMultiPartyClubNote(List<string> warnings, IReadOnlyList<CarePackBatch> batches)
    {
        if (batches.Count <= 1) return;
        var parties = batches
            .Select(b => (b.CustomerName ?? "").Trim())
            .Where(c => c.Length > 0)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
        if (parties.Count <= 1) return;
        warnings.Add(
            $"This OEM PO will link {batches.Count} invoices across {parties.Count} parties: " +
            string.Join("; ", parties) +
            ". Allowed — each invoice's serials must still appear on the PO.");
    }

    static void AddClubbedSerialNotes(
        List<string> warnings, SerialNumberParser.CrossValidationResult cross, int poSnCount)
    {
        if (poSnCount <= 0) return;

        if (cross.PerfectMatch && cross.OnlyInPo.Count > 0)
        {
            warnings.Add(
                $"All {cross.Matched.Count} invoice serial(s) are on this PO. " +
                $"PO also lists {cross.OnlyInPo.Count} other serial(s) — typically other invoices clubbed on the same OEM PO.");
        }
        else if (cross.MismatchPercent > 10 && !cross.PerfectMatch)
        {
            warnings.Add(
                $"Over 10% of this invoice's serial numbers are missing from the PO ({cross.OnlyInInvoice.Count} missing). Verify documents.");
        }
    }

    /// <summary>
    /// Other Care Pack invoices that still need an OEM PO (club candidates).
    /// Same or different customers / parties — one OEM PO can cover multiple sales invoices.
    /// </summary>
    public async Task<List<CarePackBatch>> GetPoClubCandidatesAsync(int batchId)
    {
        var batch = await db.CarePackBatches.AsNoTracking()
            .FirstOrDefaultAsync(b => b.Id == batchId);
        if (batch == null)
            return [];

        var primaryCustomer = (batch.CustomerName ?? "").Trim();

        var pending = await db.CarePackBatches.AsNoTracking()
            .Where(b => b.Id != batchId && string.IsNullOrEmpty(b.PurchaseOrderNumber))
            .OrderByDescending(b => b.InvoiceDate)
            .ThenByDescending(b => b.CreatedAt)
            .Take(300)
            .ToListAsync();

        // Prefer same customer first, then other parties (all still eligible to club).
        return pending
            .OrderByDescending(b =>
                !string.IsNullOrEmpty(primaryCustomer) &&
                string.Equals((b.CustomerName ?? "").Trim(), primaryCustomer, StringComparison.OrdinalIgnoreCase))
            .ThenByDescending(b => b.InvoiceDate)
            .ThenByDescending(b => b.CreatedAt)
            .Take(60)
            .ToList();
    }

    public async Task<List<CarePackBatch>> GetBatchesAlreadyOnPoAsync(string? poNumber)
    {
        if (string.IsNullOrWhiteSpace(poNumber)) return [];
        var po = poNumber.Trim();
        return await db.CarePackBatches.AsNoTracking()
            .Where(b => b.PurchaseOrderNumber == po)
            .OrderBy(b => b.InvoiceNumber)
            .Take(40)
            .ToListAsync();
    }

    static SerialNumberParser.ParseResult ParsePdf(Stream stream, out string? warning)
    {
        warning = null;
        try
        {
            using var doc = PdfDocument.Open(stream);
            var text = string.Join("\n", doc.GetPages().Select(p => p.Text));
            if (string.IsNullOrWhiteSpace(text))
            {
                warning =
                    "This PDF appears to be a scanned image. Text cannot be extracted automatically. " +
                    "Please type or paste the serial numbers manually, or use an XLSX file.";
                return new SerialNumberParser.ParseResult([], [], [], 0);
            }
            var parsed = SerialNumberParser.ExtractFromLooseText(text);
            if (parsed.SerialNumbers.Count == 0)
            {
                warning =
                    "No serial numbers detected in PDF. Check file format or try manual entry / XLSX.";
            }
            return parsed;
        }
        catch
        {
            warning = "Could not read PDF. Please use an XLSX file or paste serial numbers manually.";
            return new SerialNumberParser.ParseResult([], [], [], 0);
        }
    }

    public async Task<CarePackBatch> ConfirmPoValidationAsync(
        int batchId, PoValidationPreview preview, bool adminAcceptAnyway, string? acceptReason,
        IReadOnlyList<int>? alsoLinkBatchIds = null)
    {
        var ids = new List<int> { batchId };
        var fromPreview = preview.SelectedBatchIds;
        if (fromPreview is { Count: > 0 })
        {
            foreach (var id in fromPreview)
            {
                if (!ids.Contains(id)) ids.Add(id);
            }
        }
        if (alsoLinkBatchIds != null)
        {
            foreach (var id in alsoLinkBatchIds)
            {
                if (id != batchId && !ids.Contains(id))
                    ids.Add(id);
            }
        }

        // SqlServerRetryingExecutionStrategy cannot wrap raw BeginTransaction —
        // run the whole clubbed link as one retriable unit.
        var strategy = db.Database.CreateExecutionStrategy();
        CarePackBatch? primary = null;
        await strategy.ExecuteAsync(async () =>
        {
            await using var tx = await db.Database.BeginTransactionAsync();
            try
            {
                foreach (var id in ids)
                {
                    var linked = await ConfirmPoForOneBatchAsync(id, preview, adminAcceptAnyway, acceptReason);
                    if (id == batchId) primary = linked;
                }
                await tx.CommitAsync();
            }
            catch
            {
                await tx.RollbackAsync();
                throw;
            }
        });

        return primary ?? throw new InvalidOperationException("Batch not found.");
    }

    async Task<CarePackBatch> ConfirmPoForOneBatchAsync(
        int batchId, PoValidationPreview preview, bool adminAcceptAnyway, string? acceptReason)
    {
        var (userName, role) = await session.GetCurrentAsync();

        var batch = await db.CarePackBatches
            .Include(b => b.Devices)
            .FirstOrDefaultAsync(b => b.Id == batchId)
            ?? throw new InvalidOperationException($"Batch {batchId} not found.");

        // Idempotent: already linked to this same OEM PO
        if (string.Equals(batch.PurchaseOrderNumber, preview.PurchaseOrder.PurchaseOrderNumber,
                StringComparison.OrdinalIgnoreCase))
            return batch;

        if (!string.IsNullOrWhiteSpace(batch.PurchaseOrderNumber))
        {
            throw new InvalidOperationException(
                $"Invoice {batch.InvoiceNumber} already has PO {batch.PurchaseOrderNumber}. " +
                "Admin can remove that PO from the invoice (reason + confirmation) before linking another.");
        }

        // Re-check this batch's serials against the (possibly clubbed) PO serial set — normalized
        var invoiceSns = NormalizeSerials(batch.Devices.Select(d => d.SerialNumber));
        var poSns = NormalizeSerials(preview.SerialParse.SerialNumbers);
        var cross = poSns.Count == 0
            ? new SerialNumberParser.CrossValidationResult(invoiceSns, [], invoiceSns, 100, false, true)
            : SerialNumberParser.CrossValidate(invoiceSns, poSns, clubbedPo: true);

        if (!cross.PerfectMatch)
        {
            var linkPoOnly = preview.IsManualPo &&
                             poSns.Count == 0 &&
                             adminAcceptAnyway;
            if (linkPoOnly)
            {
                if (!AppRoles.CanValidatePo(role))
                    throw new InvalidOperationException("Your role cannot link a PO.");
                if (string.IsNullOrWhiteSpace(acceptReason))
                    acceptReason = "Manual PO link — serials not cross-checked (Zoho unavailable).";
            }
            else if (!adminAcceptAnyway)
            {
                throw new InvalidOperationException(
                    $"Invoice {batch.InvoiceNumber}: serial numbers do not match this PO " +
                    $"({cross.OnlyInInvoice.Count} missing from PO). Resolve, paste PO serials, or Admin Accept Anyway.");
            }
            else if (!AppRoles.CanOverride(role) && !(preview.IsManualPo && AppRoles.CanValidatePo(role) && poSns.Count == 0))
            {
                throw new InvalidOperationException("Only Admin can accept a mismatched PO validation.");
            }
            else if (!AppRoles.CanOverride(role) && preview.IsManualPo && poSns.Count > 0)
            {
                throw new InvalidOperationException(
                    "Only Admin can accept SN mismatches. Clear PO serials to link PO number only, or ask Admin.");
            }
            else if (string.IsNullOrWhiteSpace(acceptReason))
            {
                throw new InvalidOperationException("Reason is required when accepting a mismatch.");
            }
        }
        else if (!AppRoles.CanValidatePo(role))
        {
            throw new InvalidOperationException("Your role cannot validate / link an OEM PO.");
        }

        // Late PO: warn/note only — do not block when serials match (old imports are common).
        // Mismatch + late still needs Admin Accept Anyway (handled above).
        var (poLimit, _) = await GetDeadlineLimitsAsync();
        var poDue = CarePackDeadlines.PoDueDate(batch.InvoiceDate, poLimit);
        if (poDue != null && CarePackDeadlines.DaysRemaining(poDue) < 0 && !cross.PerfectMatch)
        {
            if (!adminAcceptAnyway || !AppRoles.CanOverride(role))
                throw new InvalidOperationException(
                    $"PO deadline exceeded for {batch.InvoiceNumber} and serials do not match. " +
                    "Admin must Accept Anyway with a reason.");
            if (string.IsNullOrWhiteSpace(acceptReason))
                throw new InvalidOperationException("Reason is required when accepting a late mismatched PO.");
        }

        // Write a validation report per linked invoice (clubbed siblings included)
        var reportPreview = new PoValidationPreview
        {
            Batch = batch,
            PurchaseOrder = preview.PurchaseOrder,
            PoMismatch = preview.PoMismatch,
            SerialParse = preview.SerialParse,
            Cross = cross,
            Warnings = preview.Warnings,
            SourceUsed = batch.Id == preview.Batch.Id
                ? preview.SourceUsed
                : preview.SourceUsed + " (clubbed)",
            IsManualPo = preview.IsManualPo,
        };
        var reportPath = await WriteValidationReportAsync(reportPreview, userName);

        batch.PurchaseOrderNumber = preview.PurchaseOrder.PurchaseOrderNumber;
        batch.ZohoPurchaseOrderId =
            string.Equals(preview.PurchaseOrder.PurchaseOrderId, "MANUAL", StringComparison.OrdinalIgnoreCase)
                ? null
                : preview.PurchaseOrder.PurchaseOrderId;
        batch.PoValidatedAt = DateTime.Now;
        batch.PoValidatedBy = userName;
        batch.PoMatched = cross.PerfectMatch;
        var notes = adminAcceptAnyway
            ? $"Accepted with discrepancies: {acceptReason}"
            : preview.IsManualPo
                ? (cross.PerfectMatch ? "Perfect match (manual PO, clubbed OK)" : "Manual PO linked")
                : (cross.PerfectMatch ? "Perfect match (clubbed OK)" : "Linked");
        if (cross.OnlyInPo.Count > 0 && cross.PerfectMatch)
            notes += $" | Clubbed PO: {cross.OnlyInPo.Count} other SN(s) on same OEM PO";
        if (batch.Id != preview.Batch.Id)
            notes += $" | Clubbed with invoice {preview.Batch.InvoiceNumber}";
        if (poDue != null && CarePackDeadlines.DaysRemaining(poDue) < 0)
            notes += $" | LATE PO (limit {poLimit}d from sales invoice; due {poDue:dd-MMM-yyyy})";
        batch.PoValidationNotes = notes;
        batch.ValidationReportPath = reportPath;
        ApplyVerificationState(batch, userName);

        await db.SaveChangesAsync();
        return batch;
    }

    async Task<string> WriteValidationReportAsync(PoValidationPreview preview, string validatedBy)
    {
        var baseDir = await db.GetSettingAsync("base_dir", AppPaths.DataRoot);
        var dir = Path.Combine(baseDir, "CarePack", "ValidationReports");
        Directory.CreateDirectory(dir);

        var file = Path.Combine(dir,
            $"PO-VAL-{preview.Batch.InvoiceNumber}-{DateTime.Now:yyyyMMddHHmmss}.xlsx");

        using var wb = new XLWorkbook();
        var ws = wb.Worksheets.Add("Validation");

        ws.Cell(1, 1).Value = "PO VALIDATION REPORT";
        ws.Cell(2, 1).Value = "Sales Invoice";
        ws.Cell(2, 2).Value = preview.Batch.InvoiceNumber;
        ws.Cell(3, 1).Value = "Purchase Order";
        ws.Cell(3, 2).Value = preview.PurchaseOrder.PurchaseOrderNumber;
        ws.Cell(4, 1).Value = "Vendor";
        ws.Cell(4, 2).Value = preview.PurchaseOrder.VendorName;
        ws.Cell(5, 1).Value = "Customer";
        ws.Cell(5, 2).Value = preview.Batch.CustomerName;
        ws.Cell(6, 1).Value = "Care Pack";
        ws.Cell(6, 2).Value = preview.Batch.CarePackType;
        ws.Cell(7, 1).Value = "Model";
        ws.Cell(7, 2).Value = preview.Batch.PrinterModel;
        ws.Cell(8, 1).Value = "Validation";
        ws.Cell(8, 2).Value = preview.Cross.PerfectMatch ? "MATCHED" : "DISCREPANCIES";
        ws.Cell(9, 1).Value = "Validated by";
        ws.Cell(9, 2).Value = validatedBy;
        ws.Cell(10, 1).Value = "Validated on";
        ws.Cell(10, 2).Value = DateTime.Now.ToString("dd-MMM-yyyy HH:mm:ss");

        ws.Cell(12, 1).Value = "SN";
        ws.Cell(12, 2).Value = "Serial Number";
        ws.Cell(12, 3).Value = "In Invoice";
        ws.Cell(12, 4).Value = "In PO";
        ws.Cell(12, 5).Value = "Status";

        var invSet = preview.Batch.Devices.Select(d => d.SerialNumber)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        var poSet = preview.SerialParse.SerialNumbers
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        var all = invSet.Union(poSet, StringComparer.OrdinalIgnoreCase).OrderBy(x => x).ToList();

        int row = 13, n = 1;
        foreach (var sn in all)
        {
            var inInv = invSet.Contains(sn);
            var inPo = poSet.Contains(sn);
            ws.Cell(row, 1).Value = n++;
            ws.Cell(row, 2).Value = sn;
            ws.Cell(row, 3).Value = inInv ? "YES" : "NO";
            ws.Cell(row, 4).Value = inPo ? "YES" : "NO";
            ws.Cell(row, 5).Value = inInv && inPo ? "MATCHED" :
                inPo ? "PO ONLY" : "INVOICE ONLY";
            row++;
        }

        row += 2;
        ws.Cell(row++, 1).Value = "AUTO-CORRECTIONS APPLIED";
        foreach (var s in preview.SerialParse.SpaceFixed)
            ws.Cell(row++, 1).Value = "Space removed: " + s;
        foreach (var d in preview.SerialParse.DuplicatesRemoved)
            ws.Cell(row++, 1).Value = "Duplicate: " + d;

        wb.SaveAs(file);
        return file;
    }

    public async Task UpdateOemDetailsAsync(int batchId, string? oemInvoice, DateOnly? oemDate,
        DateOnly? installDate, string? verifiedBy = null,
        decimal? oemAmount = null, string? oemCurrency = null)
    {
        var batch = await db.CarePackBatches.FindAsync(batchId)
            ?? throw new InvalidOperationException("Batch not found.");
        batch.OemInvoiceNumber = string.IsNullOrWhiteSpace(oemInvoice) ? null : oemInvoice.Trim();
        batch.OemInvoiceDate = oemDate;
        batch.InstallationDate = installDate;
        if (oemAmount.HasValue)
            batch.OemInvoiceAmount = oemAmount.Value < 0 ? null : oemAmount;
        if (!string.IsNullOrWhiteSpace(oemCurrency))
        {
            var cur = oemCurrency.Trim().ToUpperInvariant();
            if (cur is not ("USD" or "INR"))
                throw new InvalidOperationException(
                    "OEM invoice currency must be USD (overseas) or INR (local purchase).");
            batch.OemInvoiceCurrency = cur;
        }
        ApplyVerificationState(batch, verifiedBy);
        await db.SaveChangesAsync();
    }

    /// <summary>
    /// Store OEM vendor invoice PDF for the serials on this batch (final PO evidence).
    /// </summary>
    public async Task SaveOemInvoicePdfAsync(int batchId, Stream pdfStream, string originalFileName,
        string? uploadedBy = null)
    {
        var batch = await db.CarePackBatches.FindAsync(batchId)
            ?? throw new InvalidOperationException("Batch not found.");

        if (string.IsNullOrWhiteSpace(batch.PurchaseOrderNumber))
            throw new InvalidOperationException(
                "Link / validate the OEM PO first, then upload the OEM invoice PDF.");

        var ext = Path.GetExtension(originalFileName);
        if (!string.Equals(ext, ".pdf", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Only PDF files are accepted for OEM invoices.");

        var baseDir = await db.GetSettingAsync("base_dir", AppPaths.DataRoot);
        var folder = Path.Combine(baseDir, "CarePack", "OemInvoices",
            SanitizeFilePart(batch.InvoiceNumber) + "-set" + batch.LineSetIndex);
        Directory.CreateDirectory(folder);

        var oemPart = string.IsNullOrWhiteSpace(batch.OemInvoiceNumber)
            ? "pending"
            : SanitizeFilePart(batch.OemInvoiceNumber);
        var fileName = $"OEM-{oemPart}-{DateTime.Now:yyyyMMdd-HHmmss}.pdf";
        var fullPath = Path.Combine(folder, fileName);

        await using (var fs = System.IO.File.Create(fullPath))
            await pdfStream.CopyToAsync(fs);

        // Remove previous PDF if different path
        if (!string.IsNullOrWhiteSpace(batch.OemInvoicePdfPath) &&
            !string.Equals(batch.OemInvoicePdfPath, fullPath, StringComparison.OrdinalIgnoreCase) &&
            System.IO.File.Exists(batch.OemInvoicePdfPath))
        {
            try { System.IO.File.Delete(batch.OemInvoicePdfPath); } catch { /* ignore */ }
        }

        batch.OemInvoicePdfPath = fullPath;
        ApplyVerificationState(batch, uploadedBy);
        await db.SaveChangesAsync();
    }

    public async Task ClearOemInvoicePdfAsync(int batchId, string? by = null)
    {
        var batch = await db.CarePackBatches.FindAsync(batchId)
            ?? throw new InvalidOperationException("Batch not found.");
        if (!string.IsNullOrWhiteSpace(batch.OemInvoicePdfPath) &&
            System.IO.File.Exists(batch.OemInvoicePdfPath))
        {
            try { System.IO.File.Delete(batch.OemInvoicePdfPath); } catch { /* ignore */ }
        }
        batch.OemInvoicePdfPath = null;
        ApplyVerificationState(batch, by);
        await db.SaveChangesAsync();
    }

    /// <summary>
    /// Final gate: PO linked + OEM invoice number + OEM invoice PDF = 100% verified.
    /// </summary>
    public static bool IsFullyVerified(CarePackBatch batch) =>
        !string.IsNullOrWhiteSpace(batch.PurchaseOrderNumber) &&
        !string.IsNullOrWhiteSpace(batch.OemInvoiceNumber) &&
        !string.IsNullOrWhiteSpace(batch.OemInvoicePdfPath) &&
        System.IO.File.Exists(batch.OemInvoicePdfPath);

    static void ApplyVerificationState(CarePackBatch batch, string? by)
    {
        var complete = !string.IsNullOrWhiteSpace(batch.PurchaseOrderNumber) &&
                       !string.IsNullOrWhiteSpace(batch.OemInvoiceNumber) &&
                       !string.IsNullOrWhiteSpace(batch.OemInvoicePdfPath) &&
                       System.IO.File.Exists(batch.OemInvoicePdfPath);

        if (complete)
        {
            if (!batch.VerificationComplete)
            {
                batch.VerificationComplete = true;
                batch.VerificationCompletedAt = DateTime.Now;
                batch.VerificationCompletedBy = string.IsNullOrWhiteSpace(by) ? "System" : by.Trim();
            }
            batch.Status = CarePackBatchStatus.Complete;
        }
        else
        {
            batch.VerificationComplete = false;
            batch.VerificationCompletedAt = null;
            batch.VerificationCompletedBy = null;
            if (!string.IsNullOrWhiteSpace(batch.PurchaseOrderNumber))
                batch.Status = CarePackBatchStatus.PoValidated;
            else
                batch.Status = CarePackBatchStatus.Imported;
        }
    }

    static string SanitizeFilePart(string value)
    {
        var invalid = Path.GetInvalidFileNameChars();
        var chars = value.Trim().Select(c => invalid.Contains(c) ? '_' : c).ToArray();
        var s = new string(chars);
        return string.IsNullOrWhiteSpace(s) ? "unknown" : s;
    }

    public async Task<(int PoDays, int PaymentDays)> GetDeadlineLimitsAsync()
    {
        var poRaw = await db.GetSettingAsync("carepack_po_deadline_days",
            CarePackDeadlines.DefaultPoLimitDays.ToString());
        var payRaw = await db.GetSettingAsync("carepack_oem_payment_deadline_days",
            CarePackDeadlines.DefaultPaymentLimitDays.ToString());
        var po = int.TryParse(poRaw, out var p) && p > 0 ? p : CarePackDeadlines.DefaultPoLimitDays;
        var pay = int.TryParse(payRaw, out var y) && y > 0 ? y : CarePackDeadlines.DefaultPaymentLimitDays;
        return (po, pay);
    }

    public async Task SetDeadlineLimitsAsync(int poDays, int paymentDays)
    {
        if (poDays <= 0 || paymentDays <= 0)
            throw new InvalidOperationException("Deadline days must be greater than zero.");
        if (poDays > CarePackDeadlines.ContractPoDays)
            throw new InvalidOperationException(
                $"PO deadline cannot exceed contractual {CarePackDeadlines.ContractPoDays} days.");
        if (paymentDays > CarePackDeadlines.ContractPaymentDays)
            throw new InvalidOperationException(
                $"OEM payment deadline cannot exceed contractual {CarePackDeadlines.ContractPaymentDays} days.");
        await db.SetSettingAsync("carepack_po_deadline_days", poDays.ToString());
        await db.SetSettingAsync("carepack_oem_payment_deadline_days", paymentDays.ToString());
    }

    public async Task<decimal> GetAmountPaidAsync(int batchId)
    {
        await ScopeAsync();
        return await db.OemPaymentAllocations
            .Where(a => a.CarePackBatchId == batchId)
            .SumAsync(a => (decimal?)a.AllocatedAmount) ?? 0m;
    }

    public async Task<List<CarePackPendingItem>> GetPoDeadlineReportAsync()
    {
        await ScopeAsync();
        var (poDays, _) = await GetDeadlineLimitsAsync();
        var today = DateOnly.FromDateTime(DateTime.Today);
        var rows = await db.CarePackBatches
            .Where(b => string.IsNullOrEmpty(b.PurchaseOrderNumber) && b.InvoiceDate != null)
            .OrderBy(b => b.InvoiceDate)
            .ToListAsync();

        return rows.Select(b =>
        {
            var due = CarePackDeadlines.PoDueDate(b.InvoiceDate, poDays)!;
            var rem = CarePackDeadlines.DaysRemaining(due, today);
            var gap = rem < 0
                ? $"PO overdue by {-rem} day(s) (limit {poDays} from sales invoice; contract max {CarePackDeadlines.ContractPoDays})"
                : $"PO due in {rem} day(s) (by {due:dd-MMM-yyyy})";
            return ToPending(b, gap, due, rem);
        }).OrderBy(x => x.DaysRemaining).ToList();
    }

    public async Task<List<CarePackPendingItem>> GetOemPaymentDeadlineReportAsync()
    {
        await ScopeAsync();
        var (_, payDays) = await GetDeadlineLimitsAsync();
        var today = DateOnly.FromDateTime(DateTime.Today);
        var rows = await db.CarePackBatches
            .Include(b => b.PaymentAllocations)
            .Where(b => !string.IsNullOrEmpty(b.OemInvoiceNumber) &&
                        !string.IsNullOrEmpty(b.PurchaseOrderNumber) &&
                        !b.OemInvoicePaid &&
                        b.OemInvoiceDate != null)
            .ToListAsync();

        return rows
            .Select(b =>
            {
                var paid = b.PaymentAllocations.Sum(a => a.AllocatedAmount);
                var dueAmt = b.OemInvoiceAmount ?? 0m;
                var fullyPaid = dueAmt > 0 ? paid >= dueAmt - 0.01m : paid > 0 && dueAmt == 0;
                if (fullyPaid && dueAmt > 0) return null;

                var due = CarePackDeadlines.PaymentDueDate(b.OemInvoiceDate, payDays)!;
                var rem = CarePackDeadlines.DaysRemaining(due, today);
                var bal = dueAmt > 0 ? Math.Max(0, dueAmt - paid) : (decimal?)null;
                var gap = rem < 0
                    ? $"OEM payment overdue by {-rem} day(s) (limit {payDays}; contract max {CarePackDeadlines.ContractPaymentDays})"
                    : $"OEM payment due in {rem} day(s) (by {due:dd-MMM-yyyy})";
                if (bal.HasValue)
                    gap += $"; balance {bal:N2} {b.OemInvoiceCurrency ?? "USD"}";
                else if (paid == 0)
                    gap += "; no payment recorded yet";
                return ToPending(b, gap, due, rem, b.OemInvoiceAmount, paid);
            })
            .Where(x => x != null)
            .Cast<CarePackPendingItem>()
            .OrderBy(x => x.DaysRemaining)
            .ToList();
    }

    /// <summary>
    /// Record one bank/SWIFT transfer covering one or many OEM invoices.
    /// </summary>
    public async Task<OemPaymentTransfer> RecordOemPaymentAsync(
        string transferReference,
        DateOnly paymentDate,
        decimal totalAmount,
        string currency,
        IReadOnlyList<(int BatchId, decimal Amount)> allocations,
        string? bankName,
        string? swift,
        string? fromAccount,
        string? toAccount,
        string? notes,
        string? by)
    {
        if (string.IsNullOrWhiteSpace(transferReference))
            throw new InvalidOperationException("Transfer / UTR / SWIFT reference is required.");
        if (totalAmount <= 0)
            throw new InvalidOperationException("Transfer amount must be greater than zero.");
        if (allocations == null || allocations.Count == 0)
            throw new InvalidOperationException("Select at least one OEM invoice to allocate.");

        var sum = allocations.Sum(a => a.Amount);
        if (Math.Abs(sum - totalAmount) > 0.05m)
            throw new InvalidOperationException(
                $"Allocated total ({sum:N2}) must match transfer amount ({totalAmount:N2}).");

        foreach (var a in allocations)
        {
            if (a.Amount <= 0)
                throw new InvalidOperationException("Each allocation must be greater than zero.");
            var batch = await db.CarePackBatches.FindAsync(a.BatchId)
                ?? throw new InvalidOperationException($"Batch {a.BatchId} not found.");
            if (string.IsNullOrWhiteSpace(batch.OemInvoiceNumber))
                throw new InvalidOperationException(
                    $"Batch {batch.InvoiceNumber} has no OEM invoice number — cannot allocate payment.");
            if (string.IsNullOrWhiteSpace(batch.PurchaseOrderNumber))
                throw new InvalidOperationException(
                    $"Batch {batch.InvoiceNumber} has no OEM PO linked — complete PO validation before recording payment.");
        }

        var transfer = new OemPaymentTransfer
        {
            TransferReference = transferReference.Trim(),
            PaymentDate = paymentDate,
            Amount = totalAmount,
            Currency = string.IsNullOrWhiteSpace(currency) ? "USD" : currency.Trim().ToUpperInvariant(),
            BankName = NullIfEmpty(bankName),
            SwiftCode = NullIfEmpty(swift),
            FromAccount = NullIfEmpty(fromAccount),
            ToAccount = NullIfEmpty(toAccount),
            Notes = NullIfEmpty(notes),
            CreatedAt = DateTime.Now,
            CreatedBy = by,
        };
        db.OemPaymentTransfers.Add(transfer);
        await db.SaveChangesAsync();

        foreach (var a in allocations)
        {
            db.OemPaymentAllocations.Add(new OemPaymentAllocation
            {
                OemPaymentTransferId = transfer.Id,
                CarePackBatchId = a.BatchId,
                AllocatedAmount = a.Amount,
            });
        }
        await db.SaveChangesAsync();
        return transfer;
    }

    public Task<List<OemPaymentTransfer>> ListOemPaymentsAsync() =>
        db.OemPaymentTransfers
            .Include(t => t.Allocations).ThenInclude(a => a.Batch)
            .OrderByDescending(t => t.PaymentDate)
            .ThenByDescending(t => t.Id)
            .ToListAsync();

    public async Task<List<CarePackBatch>> ListUnpaidOemInvoicesAsync()
    {
        // Payments are tied to PO-validated batches that have an OEM invoice and are not marked paid
        var rows = await db.CarePackBatches
            .Include(b => b.PaymentAllocations)
            .Where(b => !string.IsNullOrEmpty(b.OemInvoiceNumber) &&
                        !string.IsNullOrEmpty(b.PurchaseOrderNumber) &&
                        !b.OemInvoicePaid)
            .OrderBy(b => b.PurchaseOrderNumber)
            .ThenBy(b => b.OemInvoiceDate)
            .ToListAsync();

        return rows.Where(b =>
        {
            var paid = b.PaymentAllocations.Sum(a => a.AllocatedAmount);
            var due = b.OemInvoiceAmount ?? 0m;
            if (due <= 0) return true; // show until marked paid
            return paid < due - 0.01m;
        }).ToList();
    }

    public async Task<List<CarePackBatch>> ListPayableOemInvoicesAsync()
    {
        return await db.CarePackBatches
            .Include(b => b.PaymentAllocations)
            .Where(b => !string.IsNullOrEmpty(b.OemInvoiceNumber) &&
                        !string.IsNullOrEmpty(b.PurchaseOrderNumber))
            .OrderBy(b => b.OemInvoicePaid)
            .ThenBy(b => b.PurchaseOrderNumber)
            .ThenBy(b => b.InvoiceNumber)
            .ToListAsync();
    }

    /// <summary>Mark OEM invoice paid / not paid — no bank or UTR details required.</summary>
    public async Task SetOemInvoicePaidAsync(int batchId, bool paid, string? by)
    {
        var (_, role) = await session.GetCurrentAsync();
        if (!AppRoles.CanValidatePo(role))
            throw new InvalidOperationException("Your role cannot update payment status.");

        var batch = await db.CarePackBatches.FindAsync(batchId)
            ?? throw new InvalidOperationException("Batch not found.");
        if (string.IsNullOrWhiteSpace(batch.PurchaseOrderNumber))
            throw new InvalidOperationException("Link an OEM PO before marking payment.");
        if (string.IsNullOrWhiteSpace(batch.OemInvoiceNumber))
            throw new InvalidOperationException("Enter the OEM invoice number before marking payment.");

        batch.OemInvoicePaid = paid;
        batch.OemInvoicePaidAt = paid ? DateTime.Now : null;
        batch.OemInvoicePaidBy = paid
            ? (string.IsNullOrWhiteSpace(by) ? "System" : by.Trim())
            : null;
        await db.SaveChangesAsync();
    }

    public async Task<List<CarePackBatch>> ListBatchesAsync()
    {
        await ScopeAsync();
        return await db.CarePackBatches.AsNoTracking().OrderByDescending(b => b.CreatedAt).ToListAsync();
    }

    public async Task<int> CountBatchesAsync()
    {
        await ScopeAsync();
        return await db.CarePackBatches.AsNoTracking().CountAsync();
    }

    /// <summary>
    /// Lean registry list — batch columns only + Max(WarrantyEnd). No full device graph.
    /// Optional search matches batch fields or device serial/model/care-pack in SQL.
    /// </summary>
    public async Task<List<CarePackBatchListItem>> ListBatchSummariesAsync(string? search = null)
    {
        await ScopeAsync();
        IQueryable<CarePackBatch> q = db.CarePackBatches.AsNoTracking();
        var s = (search ?? "").Trim();
        if (s.Length > 0)
        {
            q = q.Where(b =>
                b.InvoiceNumber.Contains(s) ||
                (b.CustomerName != null && b.CustomerName.Contains(s)) ||
                (b.PrinterItemName != null && b.PrinterItemName.Contains(s)) ||
                (b.InvoiceItemName != null && b.InvoiceItemName.Contains(s)) ||
                (b.PrinterModel != null && b.PrinterModel.Contains(s)) ||
                (b.OemBrand != null && b.OemBrand.Contains(s)) ||
                (b.OemInvoiceNumber != null && b.OemInvoiceNumber.Contains(s)) ||
                (b.CarePackType != null && b.CarePackType.Contains(s)) ||
                (b.PurchaseOrderNumber != null && b.PurchaseOrderNumber.Contains(s)) ||
                b.Devices.Any(d =>
                    d.SerialNumber.Contains(s) ||
                    (d.OriginalModel != null && d.OriginalModel.Contains(s)) ||
                    (d.CarePackType != null && d.CarePackType.Contains(s))));
        }

        return await q
            .OrderByDescending(b => b.CreatedAt)
            .Select(b => new CarePackBatchListItem(
                b.Id,
                b.InvoiceNumber,
                b.LineSetIndex,
                b.CustomerName,
                b.OemBrand,
                b.PrinterModel,
                b.CarePackType,
                b.DeviceCount,
                b.InvoiceQty,
                b.PurchaseOrderNumber,
                b.OemInvoiceNumber,
                b.OemInvoicePdfPath,
                b.VerificationComplete,
                b.Status,
                b.CreatedAt,
                b.Overridden,
                b.InvoiceDate,
                b.Devices.Where(d => d.WarrantyEnd != null).Max(d => (DateOnly?)d.WarrantyEnd)))
            .ToListAsync();
    }

    /// <summary>Batches with devices — export / callers that need serials. Untracked + split query.</summary>
    public Task<List<CarePackBatch>> ListBatchesWithDevicesAsync() =>
        db.CarePackBatches
            .AsNoTracking()
            .AsSplitQuery()
            .Include(b => b.Devices)
            .OrderByDescending(b => b.CreatedAt)
            .ToListAsync();

    /// <summary>
    /// Export registry rows (one line per serial) as CSV for Invoice, Company, Product, Model,
    /// OEM Invoice, Serial, Care Pack Length, Warranty End.
    /// </summary>
    public async Task<byte[]> ExportRegistryCsvAsync(string? search = null)
    {
        // Lean projection — avoid nvarchar(max) columns and change-tracker cost
        var batchRows = await db.CarePackBatches.AsNoTracking()
            .OrderByDescending(b => b.CreatedAt)
            .Select(b => new CarePackBatch
            {
                Id = b.Id,
                InvoiceNumber = b.InvoiceNumber,
                CustomerName = b.CustomerName,
                PrinterItemName = b.PrinterItemName,
                InvoiceItemName = b.InvoiceItemName,
                PrinterModel = b.PrinterModel,
                OemInvoiceNumber = b.OemInvoiceNumber,
                CarePackType = b.CarePackType,
                InvoiceDate = b.InvoiceDate,
            })
            .ToListAsync();

        var deviceRows = await db.CarePackDevices.AsNoTracking()
            .Select(d => new CarePackDevice
            {
                CarePackBatchId = d.CarePackBatchId,
                SerialNumber = d.SerialNumber,
                OriginalModel = d.OriginalModel,
                CarePackType = d.CarePackType,
                WarrantyEnd = d.WarrantyEnd,
            })
            .ToListAsync();

        var byBatch = deviceRows.ToLookup(d => d.CarePackBatchId);
        foreach (var b in batchRows)
            b.Devices = byBatch[b.Id].ToList();

        var rows = FlattenRegistryRows(batchRows, search);
        var sb = new System.Text.StringBuilder();
        sb.AppendLine("Invoice No,Company Name,Product,Model,OEM Invoice No,Serial No,Care Pack Length,Warranty End,Expired");
        foreach (var r in rows)
        {
            sb.AppendLine(string.Join(",",
                Csv(r.InvoiceNumber),
                Csv(r.CustomerName),
                Csv(r.Product),
                Csv(r.Model),
                Csv(r.OemInvoiceNumber),
                Csv(r.SerialNumber),
                Csv(r.CarePackLength),
                Csv(r.WarrantyEnd?.ToString("dd-MMM-yyyy")),
                r.Expired ? "Yes" : "No"));
        }
        return System.Text.Encoding.UTF8.GetPreamble()
            .Concat(System.Text.Encoding.UTF8.GetBytes(sb.ToString()))
            .ToArray();
    }

    public static List<CarePackRegistryRow> FlattenRegistryRows(
        IEnumerable<CarePackBatch> batches, string? search = null)
    {
        var q = (search ?? "").Trim();
        var list = new List<CarePackRegistryRow>();
        foreach (var b in batches)
        {
            var product = b.PrinterItemName ?? b.InvoiceItemName ?? b.PrinterModel ?? "";
            var devices = b.Devices?.OrderBy(d => d.SerialNumber).ToList() ?? [];
            if (devices.Count == 0)
            {
                var row = new CarePackRegistryRow(
                    b.Id, b.InvoiceNumber, b.CustomerName, product, b.PrinterModel,
                    b.OemInvoiceNumber, "", b.CarePackType,
                    CarePackCoverage.EffectiveWarrantyEnd(b),
                    CarePackCoverage.IsBatchExpired(b));
                if (RowMatches(row, q)) list.Add(row);
                continue;
            }
            foreach (var d in devices)
            {
                var row = new CarePackRegistryRow(
                    b.Id, b.InvoiceNumber, b.CustomerName, product,
                    d.OriginalModel ?? b.PrinterModel,
                    b.OemInvoiceNumber, d.SerialNumber,
                    d.CarePackType ?? b.CarePackType,
                    d.WarrantyEnd ?? CarePackCoverage.EffectiveWarrantyEnd(b),
                    CarePackCoverage.IsExpired(d.WarrantyEnd ?? CarePackCoverage.EffectiveWarrantyEnd(b)));
                if (RowMatches(row, q)) list.Add(row);
            }
        }
        return list;
    }

    static bool RowMatches(CarePackRegistryRow r, string q)
    {
        if (string.IsNullOrEmpty(q)) return true;
        return Contains(r.InvoiceNumber, q) || Contains(r.CustomerName, q) ||
               Contains(r.Product, q) || Contains(r.Model, q) ||
               Contains(r.OemInvoiceNumber, q) || Contains(r.SerialNumber, q) ||
               Contains(r.CarePackLength, q);
    }

    static bool Contains(string? hay, string needle) =>
        !string.IsNullOrEmpty(hay) &&
        hay.Contains(needle, StringComparison.OrdinalIgnoreCase);

    static string Csv(string? v)
    {
        var s = v ?? "";
        if (s.Contains('"') || s.Contains(',') || s.Contains('\n') || s.Contains('\r'))
            return "\"" + s.Replace("\"", "\"\"") + "\"";
        return s;
    }

    /// <summary>
    /// Admin: edit sales invoice number, customer name, and care pack item name.
    /// Invoice number + line set must stay unique. Audit note stored on devices.
    /// </summary>
    public async Task UpdateBatchHeaderAsync(
        int batchId, string invoiceNumber, string? customerName, string? carePackName, string? note = null)
    {
        var (userName, role) = await session.GetCurrentAsync();
        if (!AppRoles.CanOverride(role))
            throw new InvalidOperationException("Only Admin can edit invoice number, customer, or care pack name.");

        var inv = (invoiceNumber ?? "").Trim();
        if (string.IsNullOrEmpty(inv))
            throw new InvalidOperationException("Invoice number is required.");

        var batch = await db.CarePackBatches.Include(b => b.Devices)
            .FirstOrDefaultAsync(b => b.Id == batchId)
            ?? throw new InvalidOperationException("Batch not found.");

        var clash = await db.CarePackBatches.AnyAsync(b =>
            b.Id != batchId &&
            b.InvoiceNumber == inv &&
            b.LineSetIndex == batch.LineSetIndex);
        if (clash)
            throw new InvalidOperationException(
                $"Invoice {inv} set #{batch.LineSetIndex} already exists. Choose a different invoice number.");

        var before = $"{batch.InvoiceNumber}|{batch.CustomerName}|{batch.InvoiceItemName}";
        batch.InvoiceNumber = inv;
        batch.CustomerName = NullIfEmpty(customerName);
        if (!string.IsNullOrWhiteSpace(carePackName))
            batch.InvoiceItemName = carePackName.Trim();

        var audit = string.IsNullOrWhiteSpace(note)
            ? $"Header edited by Admin {userName} (was {before})"
            : $"Header edited by Admin {userName}: {note.Trim()} (was {before})";
        foreach (var d in batch.Devices)
        {
            d.InvoiceItemName = batch.InvoiceItemName;
            if (!d.Overridden)
            {
                d.OverrideBy = userName;
                d.OverrideAt = DateTime.Now;
                d.OverrideReason = audit;
            }
        }
        await db.SaveChangesAsync();
    }

    /// <summary>Poka-yoke: refuse RMA when care pack / warranty for this serial has ended.</summary>
    public async Task EnsureSerialEligibleForRmaAsync(string? serialNumber)
    {
        if (string.IsNullOrWhiteSpace(serialNumber)) return;
        var hit = await FindSerialAsync(serialNumber);
        if (hit == null) return; // override / non-CP path handled separately
        if (hit.IsExpired)
        {
            throw new InvalidOperationException(
                $"RMA blocked: care pack / warranty for serial {hit.SerialNumber} ended on " +
                $"{hit.WarrantyEnd:dd-MMM-yyyy}. Expired cover cannot start a new RMA.");
        }
    }

    public async Task<List<CarePackPendingItem>> GetPoNotIssuedReportAsync()
    {
        await ScopeAsync();
        var rows = await db.CarePackBatches
            .Where(b => string.IsNullOrEmpty(b.PurchaseOrderNumber))
            .OrderByDescending(b => b.CreatedAt)
            .ToListAsync();
        return rows.Select(b => ToPending(b, "OEM PO not issued / not linked")).ToList();
    }

    /// <summary>
    /// PO linked (or ready for OEM doc) but OEM invoice number missing and/or PDF not stored.
    /// </summary>
    public async Task<List<CarePackPendingItem>> GetOemInvoicePendingReportAsync()
    {
        await ScopeAsync();
        var rows = await db.CarePackBatches
            .Where(b => !string.IsNullOrEmpty(b.PurchaseOrderNumber) && !b.VerificationComplete)
            .OrderByDescending(b => b.CreatedAt)
            .ToListAsync();

        return rows.Select(b =>
        {
            var gaps = new List<string>();
            if (string.IsNullOrWhiteSpace(b.OemInvoiceNumber))
                gaps.Add("OEM invoice number not entered");
            if (string.IsNullOrWhiteSpace(b.OemInvoicePdfPath) || !System.IO.File.Exists(b.OemInvoicePdfPath))
                gaps.Add("OEM invoice PDF not received");
            if (gaps.Count == 0)
                gaps.Add("Verification incomplete");
            return ToPending(b, string.Join("; ", gaps));
        }).ToList();
    }

    static CarePackPendingItem ToPending(
        CarePackBatch b, string gap,
        DateOnly? due = null, int? daysRem = null,
        decimal? oemAmt = null, decimal? paid = null) =>
        new(
            b.Id,
            b.InvoiceNumber,
            b.LineSetIndex,
            b.CustomerName,
            b.OemBrand,
            b.PrinterModel,
            b.DeviceCount,
            b.Status,
            b.PurchaseOrderNumber,
            b.OemInvoiceNumber,
            !string.IsNullOrWhiteSpace(b.OemInvoicePdfPath) && System.IO.File.Exists(b.OemInvoicePdfPath),
            b.VerificationComplete,
            b.CreatedAt,
            gap,
            due,
            daysRem,
            oemAmt ?? b.OemInvoiceAmount,
            paid);

    public async Task<CarePackBatch?> GetBatchAsync(int id)
    {
        await ScopeAsync();
        return await db.CarePackBatches.Include(b => b.Devices)
            .Include(b => b.PaymentAllocations).ThenInclude(a => a.Transfer)
            .Include(b => b.DocumentAudits)
            .FirstOrDefaultAsync(b => b.Id == id);
    }

    public async Task<List<CarePackDevice>> GetOverrideLogAsync()
    {
        await ScopeAsync();
        return await db.CarePackDevices
            .Include(d => d.Batch)
            .Where(d => d.Overridden)
            .OrderByDescending(d => d.OverrideAt)
            .ToListAsync();
    }

    /// <summary>
    /// Safe to delete only when document chain not started:
    /// no PO linked, not PO-validated/complete, no OEM invoice.
    /// Also blocked if any device SN is used on an RMA ticket.
    /// </summary>
    public async Task<(bool Ok, string Reason)> CanDeleteBatchAsync(int batchId)
    {
        await ScopeAsync();
        var batch = await db.CarePackBatches.Include(b => b.Devices)
            .FirstOrDefaultAsync(b => b.Id == batchId);
        if (batch == null) return (false, "Batch not found.");

        if (!string.IsNullOrWhiteSpace(batch.PurchaseOrderNumber) ||
            !string.IsNullOrWhiteSpace(batch.ZohoPurchaseOrderId))
            return (false, "Cannot delete — OEM PO is linked to this invoice.");

        if (batch.Status is CarePackBatchStatus.PoValidated or CarePackBatchStatus.Complete)
            return (false, $"Cannot delete — status is {CarePackBatchStatus.Label(batch.Status)} (chain started).");

        if (batch.PoValidatedAt != null || batch.PoMatched)
            return (false, "Cannot delete — PO validation already recorded.");

        if (!string.IsNullOrWhiteSpace(batch.OemInvoiceNumber) || batch.OemInvoiceDate != null)
            return (false, "Cannot delete — OEM invoice details are entered.");

        if (!string.IsNullOrWhiteSpace(batch.OemInvoicePdfPath))
            return (false, "Cannot delete — OEM invoice PDF is stored.");

        if (batch.VerificationComplete)
            return (false, "Cannot delete — batch is 100% verified.");

        if (batch.InstallationDate != null)
            return (false, "Cannot delete — installation date is set.");

        var sns = batch.Devices.Select(d => d.SerialNumber).ToList();
        if (sns.Count > 0)
        {
            var linkedRma = await db.RMATickets
                .Where(t => t.PrinterSn != null && sns.Contains(t.PrinterSn))
                .Select(t => t.InternalTicketNo)
                .Take(5)
                .ToListAsync();
            if (linkedRma.Count > 0)
                return (false, "Cannot delete — device SN(s) linked to RMA: " + string.Join(", ", linkedRma));
        }

        return (true, "Safe to delete — no PO / OEM / RMA links.");
    }

    public async Task DeleteBatchAsync(int batchId)
    {
        var (userName, role) = await session.GetCurrentAsync();
        if (!AppRoles.CanOverride(role))
            throw new InvalidOperationException("Only Admin can delete care pack batches.");

        var (ok, reason) = await CanDeleteBatchAsync(batchId);
        if (!ok) throw new InvalidOperationException(reason);

        var batch = await db.CarePackBatches.Include(b => b.Devices)
            .FirstAsync(b => b.Id == batchId);
        db.CarePackBatches.Remove(batch); // cascade devices + document audits
        await db.SaveChangesAsync();
    }

    /// <summary>
    /// Admin document-chain unlink. Later steps must be removed first:
    /// OEM payment → OEM invoice → PO. Reason + confirmation + permanent audit required.
    /// </summary>
    public async Task<(bool Ok, string Reason)> CanRemoveOemPaymentAsync(int batchId)
    {
        await ScopeAsync();
        var batch = await db.CarePackBatches.FindAsync(batchId);
        if (batch == null) return (false, "Batch not found.");
        if (!await HasOemPaymentRecordAsync(batchId, batch))
            return (false, "No OEM payment to remove (not marked paid and no allocations).");
        return (true, "Admin can remove OEM payment from this invoice.");
    }

    public async Task<(bool Ok, string Reason)> CanRemoveOemInvoiceAsync(int batchId)
    {
        await ScopeAsync();
        var batch = await db.CarePackBatches.FindAsync(batchId);
        if (batch == null) return (false, "Batch not found.");
        if (await HasOemPaymentRecordAsync(batchId, batch))
            return (false, "Cannot remove OEM invoice — OEM payment is still recorded. Remove payment first.");
        if (!HasOemInvoiceRecord(batch))
            return (false, "No OEM invoice details to remove.");
        return (true, "Admin can remove OEM invoice from this invoice.");
    }

    public async Task<(bool Ok, string Reason)> CanRemovePoAsync(int batchId)
    {
        await ScopeAsync();
        var batch = await db.CarePackBatches.FindAsync(batchId);
        if (batch == null) return (false, "Batch not found.");
        if (await HasOemPaymentRecordAsync(batchId, batch))
            return (false, "Cannot remove PO — OEM payment is still recorded. Remove payment, then OEM invoice, then PO.");
        if (HasOemInvoiceRecord(batch))
            return (false, "Cannot remove PO — OEM invoice is still linked. Remove OEM invoice first.");
        if (!HasPoRecord(batch))
            return (false, "No OEM PO linked to this invoice.");
        return (true, "Admin can remove the OEM PO from this invoice.");
    }

    public Task RemoveOemPaymentAsync(int batchId, string reason, bool confirmed) =>
        RemoveDocumentAsync(batchId, CarePackDocumentActions.RemoveOemPayment, reason, confirmed);

    public Task RemoveOemInvoiceAsync(int batchId, string reason, bool confirmed) =>
        RemoveDocumentAsync(batchId, CarePackDocumentActions.RemoveOemInvoice, reason, confirmed);

    public Task RemovePoAsync(int batchId, string reason, bool confirmed) =>
        RemoveDocumentAsync(batchId, CarePackDocumentActions.RemovePo, reason, confirmed);

    async Task RemoveDocumentAsync(int batchId, string action, string reason, bool confirmed)
    {
        await ScopeAsync();
        var (userName, role) = await session.GetCurrentAsync();
        if (!AppRoles.CanRemoveDocuments(role))
            throw new InvalidOperationException("Only Admin can remove OEM payment, OEM invoice, or PO.");
        if (string.IsNullOrWhiteSpace(reason))
            throw new InvalidOperationException("A reason is mandatory.");
        if (!confirmed)
            throw new InvalidOperationException("Confirm the removal checkbox.");

        var (ok, gate) = action switch
        {
            CarePackDocumentActions.RemoveOemPayment => await CanRemoveOemPaymentAsync(batchId),
            CarePackDocumentActions.RemoveOemInvoice => await CanRemoveOemInvoiceAsync(batchId),
            CarePackDocumentActions.RemovePo => await CanRemovePoAsync(batchId),
            _ => (false, "Unknown document action."),
        };
        if (!ok) throw new InvalidOperationException(gate);

        var batch = await db.CarePackBatches
            .Include(b => b.PaymentAllocations).ThenInclude(a => a.Transfer)
            .FirstOrDefaultAsync(b => b.Id == batchId)
            ?? throw new InvalidOperationException("Batch not found.");

        var snapshot = BuildDocumentSnapshot(batch, action);
        var reasonTrim = reason.Trim();

        if (action == CarePackDocumentActions.RemoveOemPayment)
            await ClearOemPaymentCoreAsync(batch);
        else if (action == CarePackDocumentActions.RemoveOemInvoice)
            ClearOemInvoiceCore(batch);
        else
            ClearPoCore(batch);

        ApplyVerificationState(batch, userName);

        db.CarePackDocumentAudits.Add(new CarePackDocumentAudit
        {
            CarePackBatchId = batch.Id,
            Action = action,
            Snapshot = snapshot,
            Reason = reasonTrim.Length > 500 ? reasonTrim[..500] : reasonTrim,
            Confirmed = true,
            PerformedBy = userName,
            PerformedAt = DateTime.Now,
        });

        var label = CarePackDocumentActions.Label(action);
        db.ActivityLogs.Add(new ActivityLog
        {
            Category = "CarePack",
            Title = $"Admin removed {label} — {batch.InvoiceNumber}",
            Detail = TruncateAudit($"{userName}: {reasonTrim} | {snapshot}", 300),
            Color = "danger",
            RefLink = $"/care-packs/{batch.Id}",
            CreatedAt = DateTime.Now,
        });

        await db.SaveChangesAsync();
    }

    async Task ClearOemPaymentCoreAsync(CarePackBatch batch)
    {
        batch.OemInvoicePaid = false;
        batch.OemInvoicePaidAt = null;
        batch.OemInvoicePaidBy = null;

        var allocs = await db.OemPaymentAllocations
            .Where(a => a.CarePackBatchId == batch.Id)
            .ToListAsync();
        var transferIds = allocs.Select(a => a.OemPaymentTransferId).Distinct().ToList();
        if (allocs.Count > 0)
            db.OemPaymentAllocations.RemoveRange(allocs);

        foreach (var tid in transferIds)
        {
            var leftover = await db.OemPaymentAllocations
                .AnyAsync(a => a.OemPaymentTransferId == tid && a.CarePackBatchId != batch.Id);
            if (!leftover)
            {
                var transfer = await db.OemPaymentTransfers.FindAsync(tid);
                if (transfer != null)
                    db.OemPaymentTransfers.Remove(transfer);
            }
        }
    }

    void ClearOemInvoiceCore(CarePackBatch batch)
    {
        if (!string.IsNullOrWhiteSpace(batch.OemInvoicePdfPath) &&
            System.IO.File.Exists(batch.OemInvoicePdfPath))
        {
            try { System.IO.File.Delete(batch.OemInvoicePdfPath); } catch { /* keep going — DB must clear */ }
        }

        batch.OemInvoiceNumber = null;
        batch.OemInvoiceDate = null;
        batch.OemInvoiceAmount = null;
        batch.OemInvoiceCurrency = "USD";
        batch.OemInvoicePdfPath = null;
        batch.OemInvoicePaid = false;
        batch.OemInvoicePaidAt = null;
        batch.OemInvoicePaidBy = null;
    }

    void ClearPoCore(CarePackBatch batch)
    {
        if (!string.IsNullOrWhiteSpace(batch.ValidationReportPath) &&
            System.IO.File.Exists(batch.ValidationReportPath))
        {
            try { System.IO.File.Delete(batch.ValidationReportPath); } catch { /* keep going */ }
        }

        batch.PurchaseOrderNumber = null;
        batch.ZohoPurchaseOrderId = null;
        batch.PoValidatedAt = null;
        batch.PoValidatedBy = null;
        batch.PoMatched = false;
        batch.PoValidationNotes = null;
        batch.ValidationReportPath = null;
    }

    static bool HasOemInvoiceRecord(CarePackBatch batch) =>
        !string.IsNullOrWhiteSpace(batch.OemInvoiceNumber) ||
        batch.OemInvoiceDate != null ||
        batch.OemInvoiceAmount != null ||
        !string.IsNullOrWhiteSpace(batch.OemInvoicePdfPath);

    static bool HasPoRecord(CarePackBatch batch) =>
        !string.IsNullOrWhiteSpace(batch.PurchaseOrderNumber) ||
        !string.IsNullOrWhiteSpace(batch.ZohoPurchaseOrderId) ||
        batch.PoValidatedAt != null ||
        batch.PoMatched;

    async Task<bool> HasOemPaymentRecordAsync(int batchId, CarePackBatch batch)
    {
        if (batch.OemInvoicePaid) return true;
        return await db.OemPaymentAllocations.AnyAsync(a => a.CarePackBatchId == batchId);
    }

    static string BuildDocumentSnapshot(CarePackBatch batch, string action)
    {
        if (action == CarePackDocumentActions.RemoveOemPayment)
        {
            var paidAmt = batch.PaymentAllocations?.Sum(a => a.AllocatedAmount) ?? 0m;
            var refs = batch.PaymentAllocations?
                .Select(a => a.Transfer?.TransferReference)
                .Where(r => !string.IsNullOrWhiteSpace(r))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList() ?? [];
            return
                $"Paid={batch.OemInvoicePaid}; PaidAt={batch.OemInvoicePaidAt:dd-MMM-yyyy HH:mm}; " +
                $"PaidBy={batch.OemInvoicePaidBy ?? "—"}; Allocated={paidAmt:N2} {batch.OemInvoiceCurrency ?? "USD"}; " +
                $"Transfers={(refs.Count == 0 ? "—" : string.Join(", ", refs))}";
        }

        if (action == CarePackDocumentActions.RemoveOemInvoice)
        {
            return
                $"OEM inv={batch.OemInvoiceNumber ?? "—"}; Date={batch.OemInvoiceDate:dd-MMM-yyyy}; " +
                $"Amount={batch.OemInvoiceAmount:N2} {batch.OemInvoiceCurrency ?? "USD"}; " +
                $"PDF={(string.IsNullOrWhiteSpace(batch.OemInvoicePdfPath) ? "none" : Path.GetFileName(batch.OemInvoicePdfPath))}; " +
                $"Verified={batch.VerificationComplete}";
        }

        return
            $"PO={batch.PurchaseOrderNumber ?? "—"}; ZohoId={batch.ZohoPurchaseOrderId ?? "—"}; " +
            $"Matched={batch.PoMatched}; ValidatedAt={batch.PoValidatedAt:dd-MMM-yyyy HH:mm}; " +
            $"By={batch.PoValidatedBy ?? "—"}; Notes={batch.PoValidationNotes ?? "—"}";
    }

    static string TruncateAudit(string s, int n) =>
        s.Length <= n ? s : s[..n] + "…";

    public bool CanEditDevices(CarePackBatch batch) =>
        string.IsNullOrWhiteSpace(batch.PurchaseOrderNumber) &&
        batch.Status == CarePackBatchStatus.Imported &&
        !batch.PoMatched &&
        batch.PoValidatedAt == null;

    public async Task ReplaceSerialsAsync(int batchId, IEnumerable<string> serials, int? qty)
    {
        var (userName, role) = await session.GetCurrentAsync();
        if (!AppRoles.CanEditSerials(role))
            throw new InvalidOperationException("Viewers cannot edit serial numbers.");

        var batch = await db.CarePackBatches.Include(b => b.Devices)
            .FirstOrDefaultAsync(b => b.Id == batchId)
            ?? throw new InvalidOperationException("Batch not found.");

        if (!CanEditDevices(batch))
            throw new InvalidOperationException(
                "Serial numbers are locked after PO validation / OEM link. Delete is also blocked.");

        var list = serials
            .Select(s => SerialNumberParser.CleanToken(s, out _) ?? s.Trim().ToUpperInvariant())
            .Where(s => SerialNumberParser.IsValid(s))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList()!;

        if (list.Count == 0)
            throw new InvalidOperationException("Provide at least one valid serial number.");

        await EnsureNoDuplicateSerialsAsync(list, excludeBatchId: batchId);

        var years = OemBrandCatalog.DetectDurationYears(batch.CarePackType) ?? 5;
        DateOnly? warrantyEnd = batch.InvoiceDate?.AddYears(years);

        db.CarePackDevices.RemoveRange(batch.Devices);
        batch.Devices.Clear();
        foreach (var sn in list)
        {
            batch.Devices.Add(new CarePackDevice
            {
                SerialNumber = sn!,
                OemBrand = batch.OemBrand,
                CarePackType = batch.CarePackType,
                OriginalModel = batch.PrinterModel,
                WarrantyEnd = warrantyEnd,
                InvoiceItemName = batch.InvoiceItemName,
                InvoiceBrandDetected = batch.InvoiceBrandDetected,
                InvoiceDescriptionRaw = batch.InvoiceDescriptionRaw,
                Irn = batch.Irn,
                IrnAckNo = batch.IrnAckNo,
                IrnAckDate = batch.IrnAckDate,
                Overridden = batch.Overridden,
                OverrideBy = batch.Overridden ? userName : null,
                OverrideAt = batch.Overridden ? DateTime.Now : null,
                OverrideReason = batch.Overridden ? "Serial list updated" : null,
                OverrideConfirmed = batch.Overridden,
                CreatedAt = DateTime.Now,
            });
        }
        batch.DeviceCount = list.Count;
        if (qty is > 0) batch.InvoiceQty = qty.Value;
        await db.SaveChangesAsync();
    }

    public async Task ApplyBatchOverrideAsync(int batchId, string brand, string? model, string? carePackType,
        string reason, bool confirmed)
    {
        var (userName, role) = await session.GetCurrentAsync();
        if (!AppRoles.CanOverride(role))
            throw new InvalidOperationException("Only Admin can override.");
        if (string.IsNullOrWhiteSpace(reason))
            throw new InvalidOperationException("Override reason is mandatory.");
        if (!confirmed)
            throw new InvalidOperationException("Confirm the override checkbox.");

        var batch = await db.CarePackBatches.Include(b => b.Devices)
            .FirstOrDefaultAsync(b => b.Id == batchId)
            ?? throw new InvalidOperationException("Batch not found.");

        // Keep invoice originals; update registered values
        batch.OemBrand = brand;
        batch.PrinterModel = model;
        batch.CarePackType = carePackType;
        batch.Overridden = true;
        var years = OemBrandCatalog.DetectDurationYears(carePackType) ?? 5;
        DateOnly? warrantyEnd = batch.InvoiceDate?.AddYears(years);

        foreach (var d in batch.Devices)
        {
            d.OemBrand = brand;
            d.OriginalModel = model;
            d.CarePackType = carePackType;
            d.WarrantyEnd = warrantyEnd;
            d.Overridden = true;
            d.OverrideBy = userName;
            d.OverrideAt = DateTime.Now;
            d.OverrideReason = reason;
            d.OverrideConfirmed = true;
        }
        await db.SaveChangesAsync();
    }

    /// <summary>
    /// Correct brand / product (model) / care pack type after import.
    /// Available to all roles except Viewer (does not require Admin override).
    /// </summary>
    public async Task UpdateBatchBrandAndProductAsync(
        int batchId, string brand, string? model, string? carePackType, string? note = null)
    {
        var (userName, role) = await session.GetCurrentAsync();
        if (!AppRoles.CanEditSerials(role))
            throw new InvalidOperationException("Your role cannot change brand or product.");

        if (string.IsNullOrWhiteSpace(brand))
            throw new InvalidOperationException("Brand is required.");

        var batch = await db.CarePackBatches.Include(b => b.Devices)
            .FirstOrDefaultAsync(b => b.Id == batchId)
            ?? throw new InvalidOperationException("Batch not found.");

        var brandTrim = brand.Trim();
        var modelTrim = string.IsNullOrWhiteSpace(model) ? null : model.Trim();
        var typeTrim = string.IsNullOrWhiteSpace(carePackType) ? batch.CarePackType : carePackType.Trim();

        batch.OemBrand = brandTrim;
        batch.PrinterModel = modelTrim;
        batch.CarePackType = typeTrim;

        var years = OemBrandCatalog.DetectDurationYears(typeTrim) ?? 5;
        DateOnly? warrantyEnd = batch.InvoiceDate?.AddYears(years);
        EnsureWarrantyNotExpired(
            warrantyEnd,
            batch.InvoiceNumber,
            batch.InvoiceDate?.ToString("dd-MMM-yyyy"),
            typeTrim,
            years);
        var audit = string.IsNullOrWhiteSpace(note)
            ? $"Brand/product updated by {userName}"
            : $"Brand/product updated by {userName}: {note.Trim()}";

        foreach (var d in batch.Devices)
        {
            d.OemBrand = brandTrim;
            d.OriginalModel = modelTrim;
            d.CarePackType = typeTrim;
            d.WarrantyEnd = warrantyEnd;
            // Light audit without requiring Admin override flag
            if (!d.Overridden)
            {
                d.OverrideBy = userName;
                d.OverrideAt = DateTime.Now;
                d.OverrideReason = audit;
            }
        }
        await db.SaveChangesAsync();
    }

    /// <summary>
    /// Correct care pack period (1–5 Year / Comprehensive) on an already-imported invoice.
    /// Recalculates WarrantyEnd; blocks if the new end date is already past today (poka-yoke).
    /// </summary>
    public async Task UpdateCarePackPeriodAsync(int batchId, string carePackType, string? note = null)
    {
        var (userName, role) = await session.GetCurrentAsync();
        if (!AppRoles.CanEditSerials(role))
            throw new InvalidOperationException("Your role cannot change care pack period.");

        if (string.IsNullOrWhiteSpace(carePackType))
            throw new InvalidOperationException("Care pack period / type is required.");

        var batch = await db.CarePackBatches.Include(b => b.Devices)
            .FirstOrDefaultAsync(b => b.Id == batchId)
            ?? throw new InvalidOperationException("Batch not found.");

        var typeTrim = carePackType.Trim();
        var years = OemBrandCatalog.DetectDurationYears(typeTrim) ?? 5;
        if (batch.InvoiceDate == null)
            throw new InvalidOperationException(
                "Invoice date is missing — cannot recalculate warranty end. Set invoice date first.");

        var warrantyEnd = batch.InvoiceDate.Value.AddYears(years);
        EnsureWarrantyNotExpired(
            warrantyEnd,
            batch.InvoiceNumber,
            batch.InvoiceDate.Value.ToString("dd-MMM-yyyy"),
            typeTrim,
            years);

        batch.CarePackType = typeTrim;
        var audit = string.IsNullOrWhiteSpace(note)
            ? $"Care pack period corrected to {typeTrim} by {userName}"
            : $"Care pack period corrected to {typeTrim} by {userName}: {note.Trim()}";

        foreach (var d in batch.Devices)
        {
            d.CarePackType = typeTrim;
            d.WarrantyEnd = warrantyEnd;
            d.OverrideBy = userName;
            d.OverrideAt = DateTime.Now;
            d.OverrideReason = audit;
        }
        await db.SaveChangesAsync();
    }

    // ── RMA integration: care-pack serial picker + override add ───────────────
    public async Task<List<CarePackSerialOption>> ListCarePackSerialsAsync()
    {
        await ScopeAsync();
        var rows = await db.CarePackDevices
            .AsNoTracking()
            .Include(d => d.Batch)
            .OrderBy(d => d.SerialNumber)
            .ToListAsync();
        return rows.Select(ToSerialOption).ToList();
    }

    /// <summary>Distinct Care Pack customers for RMA client picker (type-ahead).</summary>
    public async Task<List<string>> SearchCarePackCustomersAsync(string? filter, int take = 60)
    {
        await ScopeAsync();
        take = Math.Clamp(take, 1, 200);
        var q = (filter ?? "").Trim();
        var rows = db.CarePackBatches.AsNoTracking()
            .Where(b => b.CustomerName != null && b.CustomerName != "");
        if (!string.IsNullOrEmpty(q))
        {
            var qLower = q.ToLower();
            rows = rows.Where(b => b.CustomerName!.ToLower().Contains(qLower));
        }

        return await rows
            .Select(b => b.CustomerName!)
            .Distinct()
            .OrderBy(n => n)
            .Take(take)
            .ToListAsync();
    }

    /// <summary>
    /// Type-ahead filter for printer serial picker (RMA / dashboard).
    /// When <paramref name="customerName"/> is set, returns all serials for that client (optionally filtered).
    /// </summary>
    public async Task<List<CarePackSerialOption>> SearchCarePackSerialsAsync(
        string? filter, int take = 40, string? customerName = null)
    {
        await ScopeAsync();
        take = Math.Clamp(take, 1, 500);
        var q = (filter ?? "").Trim();
        var customer = (customerName ?? "").Trim();
        var rows = db.CarePackDevices.AsNoTracking().Include(d => d.Batch).AsQueryable();

        if (!string.IsNullOrEmpty(customer))
        {
            var custLower = customer.ToLower();
            rows = rows.Where(d => d.Batch.CustomerName != null &&
                                   d.Batch.CustomerName.ToLower() == custLower);
        }

        if (!string.IsNullOrEmpty(q))
        {
            var upper = q.ToUpperInvariant();
            var qLower = q.ToLower();
            rows = rows.Where(d =>
                d.SerialNumber.ToUpper().Contains(upper) ||
                (d.Batch.InvoiceNumber != null && d.Batch.InvoiceNumber.ToLower().Contains(qLower)) ||
                (string.IsNullOrEmpty(customer) && d.Batch.CustomerName != null &&
                 d.Batch.CustomerName.ToLower().Contains(qLower)) ||
                (d.Batch.PrinterModel != null && d.Batch.PrinterModel.ToLower().Contains(qLower)) ||
                (d.OriginalModel != null && d.OriginalModel.ToLower().Contains(qLower)));
        }

        // Client selected → show all their serials (cap at take)
        var list = await rows.OrderBy(d => d.SerialNumber).Take(take).ToListAsync();
        return list.Select(ToSerialOption).ToList();
    }

    static CarePackSerialOption ToSerialOption(CarePackDevice d) =>
        new(
            d.Id,
            d.CarePackBatchId,
            d.SerialNumber,
            d.Batch.InvoiceNumber,
            d.Batch.CustomerName,
            d.OemBrand ?? d.Batch.OemBrand,
            d.OriginalModel ?? d.Batch.PrinterModel,
            d.CarePackType ?? d.Batch.CarePackType,
            d.WarrantyEnd,
            d.Overridden,
            d.Batch.OemInvoiceNumber,
            d.Batch.InvoiceDate,
            d.Batch.CustomerCity);

    public async Task<CarePackSerialOption?> FindSerialAsync(string? serial)
    {
        await ScopeAsync();
        if (string.IsNullOrWhiteSpace(serial)) return null;
        var raw = serial.Trim();
        var sn = SerialNumberParser.CleanToken(serial, out _) ?? raw.ToUpperInvariant();
        var snUpper = sn.ToUpperInvariant();
        var rawUpper = raw.ToUpperInvariant();

        // Exact / cleaned match first
        var d = await db.CarePackDevices.AsNoTracking()
            .Include(x => x.Batch)
            .FirstOrDefaultAsync(x =>
                x.SerialNumber == sn ||
                x.SerialNumber == raw ||
                x.SerialNumber.ToUpper() == snUpper ||
                x.SerialNumber.ToUpper() == rawUpper);

        // Soft fallback: contains (handles pasted SN with extra chars)
        if (d == null && snUpper.Length >= 4)
        {
            d = await db.CarePackDevices.AsNoTracking()
                .Include(x => x.Batch)
                .Where(x => x.SerialNumber.ToUpper().Contains(snUpper))
                .OrderBy(x => x.SerialNumber.Length)
                .FirstOrDefaultAsync();
        }

        return d == null ? null : ToSerialOption(d);
    }

    /// <summary>Load serial by device id (dashboard → New RMA lock).</summary>
    public async Task<CarePackSerialOption?> FindSerialByDeviceIdAsync(int deviceId)
    {
        await ScopeAsync();
        if (deviceId <= 0) return null;
        var d = await db.CarePackDevices.AsNoTracking()
            .Include(x => x.Batch)
            .FirstOrDefaultAsync(x => x.Id == deviceId);
        return d == null ? null : ToSerialOption(d);
    }

    /// <summary>
    /// Add a serial from RMA that was not in the care-pack list (override).
    /// Attaches to an existing invoice batch, or creates a small RMA-ADD batch.
    /// </summary>
    public async Task<CarePackDevice> AddRmaOverrideSerialAsync(RmaOverrideSerialRequest req)
    {
        var (userName, role) = await session.GetCurrentAsync();
        if (!AppRoles.CanEditSerials(role))
            throw new InvalidOperationException("Your role cannot add care pack serials.");

        var sn = SerialNumberParser.CleanToken(req.SerialNumber, out _)
                 ?? req.SerialNumber?.Trim().ToUpperInvariant()
                 ?? "";
        if (string.IsNullOrWhiteSpace(sn))
            throw new InvalidOperationException("Serial number is required.");

        var existing = await db.CarePackDevices
            .FirstOrDefaultAsync(d => d.SerialNumber == sn);
        if (existing != null)
            return existing;

        if (string.IsNullOrWhiteSpace(req.Reason))
            throw new InvalidOperationException("Override reason is required when adding a new serial.");

        CarePackBatch batch;
        if (req.AttachToBatchId is > 0)
        {
            batch = await db.CarePackBatches.Include(b => b.Devices)
                .FirstOrDefaultAsync(b => b.Id == req.AttachToBatchId.Value)
                ?? throw new InvalidOperationException("Selected care pack invoice not found.");
        }
        else
        {
            var inv = string.IsNullOrWhiteSpace(req.InvoiceNumber)
                ? $"RMA-ADD-{DateTime.Now:yyyyMMdd}"
                : req.InvoiceNumber.Trim();
            // Reuse same-day RMA-ADD batch for the invoice key if present
            batch = await db.CarePackBatches.Include(b => b.Devices)
                .FirstOrDefaultAsync(b => b.InvoiceNumber == inv && b.LineSetIndex == 1)
                ?? new CarePackBatch
                {
                    InvoiceNumber = inv,
                    LineSetIndex = 1,
                    CustomerName = NullIfEmpty(req.CustomerName),
                    OemBrand = NullIfEmpty(req.OemBrand),
                    PrinterModel = NullIfEmpty(req.PrinterModel),
                    CarePackType = NullIfEmpty(req.CarePackType) ?? "Comprehensive Care Pack",
                    PrinterItemName = "Added from RMA (override)",
                    InvoiceItemName = "RMA override serial",
                    InvoiceDescriptionRaw = "[Added from RMA ticket — not from Zoho import]",
                    InvoiceQty = 0,
                    DeviceCount = 0,
                    Status = CarePackBatchStatus.Imported,
                    Overridden = true,
                    CreatedBy = userName,
                    CreatedAt = DateTime.Now,
                };
            if (batch.Id == 0)
                db.CarePackBatches.Add(batch);
        }

        var years = OemBrandCatalog.DetectDurationYears(req.CarePackType ?? batch.CarePackType) ?? 5;
        DateOnly? warrantyEnd = batch.InvoiceDate?.AddYears(years) ?? DateOnly.FromDateTime(DateTime.Today).AddYears(years);

        var device = new CarePackDevice
        {
            SerialNumber = sn,
            OemBrand = NullIfEmpty(req.OemBrand) ?? batch.OemBrand,
            CarePackType = NullIfEmpty(req.CarePackType) ?? batch.CarePackType,
            OriginalModel = NullIfEmpty(req.PrinterModel) ?? batch.PrinterModel,
            WarrantyEnd = warrantyEnd,
            InvoiceItemName = batch.InvoiceItemName,
            InvoiceBrandDetected = batch.InvoiceBrandDetected,
            InvoiceDescriptionRaw = batch.InvoiceDescriptionRaw,
            Irn = batch.Irn,
            IrnAckNo = batch.IrnAckNo,
            IrnAckDate = batch.IrnAckDate,
            Overridden = true,
            OverrideBy = userName,
            OverrideAt = DateTime.Now,
            OverrideReason = req.Reason.Trim(),
            OverrideConfirmed = true,
            CreatedAt = DateTime.Now,
        };
        batch.Devices.Add(device);
        batch.DeviceCount = batch.Devices.Count;
        if (batch.InvoiceQty < batch.DeviceCount)
            batch.InvoiceQty = batch.DeviceCount;
        batch.Overridden = true;
        await db.SaveChangesAsync();
        return device;
    }
}

public record CarePackRegistryRow(
    int BatchId,
    string InvoiceNumber,
    string? CustomerName,
    string? Product,
    string? Model,
    string? OemInvoiceNumber,
    string SerialNumber,
    string? CarePackLength,
    DateOnly? WarrantyEnd,
    bool Expired);

public record CarePackSerialOption(
    int DeviceId,
    int BatchId,
    string SerialNumber,
    string InvoiceNumber,
    string? CustomerName,
    string? OemBrand,
    string? PrinterModel,
    string? CarePackType,
    DateOnly? WarrantyEnd,
    bool Overridden,
    string? OemInvoiceNumber = null,
    DateOnly? InvoiceDate = null,
    string? CustomerCity = null)
{
    public bool IsExpired => CarePackCoverage.IsExpired(WarrantyEnd);
}

public class SalesInvoicePdfPreview
{
    public string InvoiceNumber { get; set; } = "";
    public string? CustomerName { get; set; }
    public string? CustomerCity { get; set; }
    public DateOnly? InvoiceDate { get; set; }
    public string? Irn { get; set; }
    public string? IrnAckNo { get; set; }
    public string? PrinterItemName { get; set; }
    public string? CarePackItemName { get; set; }
    public string? PrinterModel { get; set; }
    public string? OemBrand { get; set; }
    public string? CarePackType { get; set; }
    public int Qty { get; set; }
    public List<string> SerialNumbers { get; set; } = [];
    public string SerialText { get; set; } = "";
    public List<string> Warnings { get; set; } = [];
    public int RawTextLength { get; set; }
}

public class RmaOverrideSerialRequest
{
    public string SerialNumber { get; set; } = "";
    public int? AttachToBatchId { get; set; }
    public string? InvoiceNumber { get; set; }
    public string? CustomerName { get; set; }
    public string? OemBrand { get; set; }
    public string? PrinterModel { get; set; }
    public string? CarePackType { get; set; }
    public string Reason { get; set; } = "";
}

public class CarePackImportPreview
{
    public ZohoInvoiceDetail Invoice { get; set; } = null!;
    public string ItemName { get; set; } = "";
    public string DescriptionRaw { get; set; } = "";
    public int InvoiceQty { get; set; }
    public int ZohoLineQty { get; set; }
    public int? QtyFromText { get; set; }
    public BrandMismatchDetector.MismatchResult Mismatch { get; set; } = null!;
    public SerialNumberParser.ParseResult SerialParse { get; set; } = null!;
    public DateTime? IrnAckDate { get; set; }
    public bool DescriptionMissingFromZoho { get; set; }
    /// <summary>Remaining printer+care-pack sets not yet imported.</summary>
    public List<InvoiceCarePackSetBuilder.LineSet> LineSets { get; set; } = [];
    public List<string> AllSerialNumbers { get; set; } = [];
}

public class CarePackImportRequest
{
    /// <summary>Zoho / source invoice number used to fetch preview.</summary>
    public string InvoiceNumber { get; set; } = "";
    /// <summary>Final invoice number stored on the batch (may differ from Zoho).</summary>
    public string? RegisteredInvoiceNumber { get; set; }
    /// <summary>Original source invoice # for audit when registered differs.</summary>
    public string? SourceInvoiceNumber { get; set; }
    /// <summary>Which product+care-pack pair to import (multi-product invoices).</summary>
    public int? LineSetIndex { get; set; }
    public bool ApplyOverride { get; set; }
    public string? OverrideReason { get; set; }
    public bool OverrideConfirmed { get; set; }
    public string? CorrectedBrand { get; set; }
    public string? CorrectedModel { get; set; }
    public string? CorrectedCarePackType { get; set; }
    /// <summary>Per-product care pack length (no Admin Override required).</summary>
    public string? EditedCarePackType { get; set; }
    public string? EditedProductItemName { get; set; }
    public string? EditedCarePackItemName { get; set; }
    public string? ManualIrn { get; set; }
    public List<string>? EditedSerials { get; set; }
    /// <summary>Paste block: one-per-line, comma, or mixed serials (any OEM format).</summary>
    public string? ManualSerialText { get; set; }
    /// <summary>Editable quantity (must match serial count).</summary>
    public int? OverrideQty { get; set; }
    /// <summary>When true, use CachedPreview instead of calling Zoho again.</summary>
    public bool SkipPreviewFetch { get; set; }
    public CarePackImportPreview? CachedPreview { get; set; }
    public int? OemVendorId { get; set; }
    public int? ProductId { get; set; }
    public int? ProductModelId { get; set; }
    public int? CarePackTypeId { get; set; }
    public int? DurationYears { get; set; }
}

public class CarePackImportSetEntry
{
    public int LineSetIndex { get; set; }
    public int Qty { get; set; }
    public string? CarePackType { get; set; }
    public List<string> Serials { get; set; } = [];
    public string? ProductItemName { get; set; }
    public string? CarePackItemName { get; set; }
    public string? ProductModel { get; set; }
    public string? OemBrand { get; set; }
    public int? OemVendorId { get; set; }
    public int? ProductId { get; set; }
    public int? ProductModelId { get; set; }
    public int? CarePackTypeId { get; set; }
    public int? DurationYears { get; set; }
    /// <summary>True when user added a product not present on the Zoho invoice.</summary>
    public bool IsAddedProduct { get; set; }
    public string? EditReason { get; set; }
}

public class CarePackMultiImportRequest
{
    /// <summary>Final invoice number to register.</summary>
    public string InvoiceNumber { get; set; } = "";
    /// <summary>Zoho / original invoice number (for fetch + audit).</summary>
    public string? SourceInvoiceNumber { get; set; }
    public string? InvoiceEditReason { get; set; }
    public string? CustomerName { get; set; }
    public string? CustomerCity { get; set; }
    public DateOnly? InvoiceDate { get; set; }
    public bool ApplyOverride { get; set; }
    public string? OverrideReason { get; set; }
    public bool OverrideConfirmed { get; set; }
    public string? CorrectedBrand { get; set; }
    public string? CorrectedModel { get; set; }
    public string? CorrectedCarePackType { get; set; }
    public string? ManualIrn { get; set; }
    public List<CarePackImportSetEntry> Sets { get; set; } = [];
}

public class ManualCarePackProductEntry
{
    public int? LineSetIndex { get; set; }
    public string? ProductItemName { get; set; }
    public string? CarePackItemName { get; set; }
    public string? ProductModel { get; set; }
    public string? OemBrand { get; set; }
    public string? CarePackType { get; set; }
    public int? OemVendorId { get; set; }
    public int? ProductId { get; set; }
    public int? ProductModelId { get; set; }
    public int? CarePackTypeId { get; set; }
    public int? DurationYears { get; set; }
    public int? Qty { get; set; }
    public string? SerialText { get; set; }
    public List<string>? Serials { get; set; }
}

public class ManualCarePackMultiRequest
{
    public string InvoiceNumber { get; set; } = "";
    public string? SourceInvoiceNumber { get; set; }
    public int? CustomerId { get; set; }
    public string? CustomerName { get; set; }
    public string? CustomerCity { get; set; }
    public DateOnly? InvoiceDate { get; set; }
    public string? Irn { get; set; }
    public string? IrnAckNo { get; set; }
    public DateTime? IrnAckDate { get; set; }
    public string? Notes { get; set; }
    public bool MarkAsOverride { get; set; }
    public string? OverrideReason { get; set; }
    public List<ManualCarePackProductEntry> Products { get; set; } = [];
}

public class PoValidationPreview
{
    public CarePackBatch Batch { get; set; } = null!;
    public ZohoPurchaseOrderDetail PurchaseOrder { get; set; } = null!;
    public BrandMismatchDetector.MismatchResult PoMismatch { get; set; } = null!;
    public SerialNumberParser.ParseResult SerialParse { get; set; } = null!;
    public SerialNumberParser.CrossValidationResult Cross { get; set; } = null!;
    public List<string> Warnings { get; set; } = [];
    public string SourceUsed { get; set; } = "";
    public bool IsManualPo { get; set; }
    /// <summary>Same-customer invoices still without a PO — can share this OEM PO.</summary>
    public List<CarePackBatch> ClubCandidates { get; set; } = [];
    /// <summary>Other invoices already linked to this PO number.</summary>
    public List<CarePackBatch> AlreadyOnPo { get; set; } = [];
    /// <summary>Invoices selected before PO fetch / serial entry — all get linked on confirm.</summary>
    public List<int> SelectedBatchIds { get; set; } = [];
    public List<PoBatchMatchRow> BatchMatches { get; set; } = [];
    public bool AllSelectedMatch { get; set; }
    /// <summary>True when any selected invoice is past the app PO deadline (Admin Accept Anyway required).</summary>
    public bool RequiresLatePoOverride { get; set; }
    public List<string> LatePoLabels { get; set; } = [];
}

public record PoBatchMatchRow(
    int BatchId,
    string InvoiceNumber,
    int DeviceCount,
    string? CustomerName,
    string? PrinterModel,
    SerialNumberParser.CrossValidationResult Cross);

public class ManualCarePackRequest
{
    public string InvoiceNumber { get; set; } = "";
    public string? SourceInvoiceNumber { get; set; }
    public int? LineSetIndex { get; set; }
    public int? CustomerId { get; set; }
    public string? CustomerName { get; set; }
    public string? CustomerCity { get; set; }
    public DateOnly? InvoiceDate { get; set; }
    public string? PrinterItemName { get; set; }
    public string? CarePackItemName { get; set; }
    public string? PrinterModel { get; set; }
    public string? OemBrand { get; set; }
    public string? CarePackType { get; set; }
    public int? OemVendorId { get; set; }
    public int? ProductId { get; set; }
    public int? ProductModelId { get; set; }
    public int? CarePackTypeId { get; set; }
    public int? DurationYears { get; set; }
    public int? Qty { get; set; }
    public string? SerialText { get; set; }
    public List<string>? Serials { get; set; }
    public string? Irn { get; set; }
    public string? IrnAckNo { get; set; }
    public DateTime? IrnAckDate { get; set; }
    public string? Notes { get; set; }
    public bool MarkAsOverride { get; set; }
    public string? OverrideReason { get; set; }
}

public class ManualPoRequest
{
    public string PurchaseOrderNumber { get; set; } = "";
    public string? VendorName { get; set; }
    public string? ReferenceNumber { get; set; }
    public string? CurrencyCode { get; set; }
    public int? Quantity { get; set; }
    public DateOnly? Date { get; set; }
    public string? ItemName { get; set; }
    public string? Notes { get; set; }
    public string? SerialText { get; set; }
}
