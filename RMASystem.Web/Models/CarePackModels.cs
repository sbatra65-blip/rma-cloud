using System.ComponentModel.DataAnnotations;
using System.ComponentModel.DataAnnotations.Schema;

namespace RMASystem.Models;

// ── Care Pack Batch (one sales invoice → many devices) ────────────────────────
public class CarePackBatch
{
    [Key]
    public int Id { get; set; }

    /// <summary>Tenant company (Phase B). Pre-migration rows = Infinite Solutions (1).</summary>
    public int CompanyId { get; set; } = CompanyIds.InfiniteSolutions;

    [Required, MaxLength(50)]
    public string InvoiceNumber { get; set; } = "";

    /// <summary>Original invoice # from Zoho/PDF before user edit (audit).</summary>
    [MaxLength(50)] public string? SourceInvoiceNumber { get; set; }

    [MaxLength(50)] public string? ZohoInvoiceId { get; set; }

    [MaxLength(200)] public string? CustomerName { get; set; }
    [MaxLength(200)] public string? CustomerCity { get; set; }
    [MaxLength(100)] public string? CustomerState { get; set; }

    /// <summary>Optional link to Customer master.</summary>
    public int? CustomerId { get; set; }
    /// <summary>Optional link to OEM master.</summary>
    public int? OemVendorId { get; set; }
    /// <summary>Optional link to Product master.</summary>
    public int? ProductId { get; set; }
    /// <summary>Optional link to Model master.</summary>
    public int? ProductModelId { get; set; }
    /// <summary>Optional link to Care Pack Type master.</summary>
    public int? CarePackTypeId { get; set; }

    public DateOnly? InvoiceDate { get; set; }

    [MaxLength(128)] public string? Irn { get; set; }
    [MaxLength(50)]  public string? IrnAckNo { get; set; }

    [Column(TypeName = "datetime")]
    public DateTime? IrnAckDate { get; set; }

    [MaxLength(50)]  public string? OemBrand { get; set; }
    [MaxLength(50)]  public string? CarePackType { get; set; }
    [MaxLength(100)] public string? PrinterModel { get; set; }

    /// <summary>1-based printer+care-pack pair on a multi-PO invoice (default 1).</summary>
    public int LineSetIndex { get; set; } = 1;

    [MaxLength(200)] public string? PrinterItemName { get; set; }
    [MaxLength(200)] public string? InvoiceItemName { get; set; }
    public string? InvoiceDescriptionRaw { get; set; }
    [MaxLength(50)]  public string? InvoiceBrandDetected { get; set; }

    public int InvoiceQty { get; set; }
    public int DeviceCount { get; set; }

    [Required, MaxLength(30)]
    public string Status { get; set; } = CarePackBatchStatus.Imported;

    [MaxLength(50)] public string? PurchaseOrderNumber { get; set; }
    [MaxLength(50)] public string? ZohoPurchaseOrderId { get; set; }

    [Column(TypeName = "datetime")]
    public DateTime? PoValidatedAt { get; set; }

    [MaxLength(100)] public string? PoValidatedBy { get; set; }
    public bool PoMatched { get; set; }
    public string? PoValidationNotes { get; set; }

    [MaxLength(100)] public string? OemInvoiceNumber { get; set; }
    public DateOnly? OemInvoiceDate { get; set; }
    public DateOnly? InstallationDate { get; set; }

    /// <summary>OEM vendor invoice amount (for payment tracking).</summary>
    [Column(TypeName = "decimal(18,2)")]
    public decimal? OemInvoiceAmount { get; set; }

    [MaxLength(10)] public string? OemInvoiceCurrency { get; set; } = "USD";

    /// <summary>Simple paid / not-paid flag (no bank/UTR details required — for historical imports).</summary>
    public bool OemInvoicePaid { get; set; }

    [Column(TypeName = "datetime")]
    public DateTime? OemInvoicePaidAt { get; set; }

    [MaxLength(100)] public string? OemInvoicePaidBy { get; set; }

    /// <summary>Stored OEM vendor invoice PDF covering PO serial numbers.</summary>
    [MaxLength(500)] public string? OemInvoicePdfPath { get; set; }

    /// <summary>
    /// True when PO is linked, OEM invoice number entered, and OEM invoice PDF stored
    /// (final 100% verification gate).
    /// </summary>
    public bool VerificationComplete { get; set; }

    [Column(TypeName = "datetime")]
    public DateTime? VerificationCompletedAt { get; set; }

    [MaxLength(100)] public string? VerificationCompletedBy { get; set; }

    public string? ValidationReportPath { get; set; }

    public bool Overridden { get; set; }

    [Column(TypeName = "datetime")]
    public DateTime CreatedAt { get; set; } = DateTime.Now;

    [MaxLength(100)] public string? CreatedBy { get; set; }

    public ICollection<CarePackDevice> Devices { get; set; } = new List<CarePackDevice>();
    public ICollection<OemPaymentAllocation> PaymentAllocations { get; set; } = new List<OemPaymentAllocation>();
    public ICollection<CarePackDocumentAudit> DocumentAudits { get; set; } = new List<CarePackDocumentAudit>();
}

/// <summary>
/// One bank/SWIFT transfer that can settle one or many OEM invoices
/// (to reduce bank charges).
/// </summary>
public class OemPaymentTransfer
{
    [Key]
    public int Id { get; set; }

    /// <summary>Tenant company (Phase B).</summary>
    public int CompanyId { get; set; } = CompanyIds.InfiniteSolutions;

    [Required, MaxLength(100)]
    public string TransferReference { get; set; } = "";

    public DateOnly PaymentDate { get; set; }

    [Column(TypeName = "decimal(18,2)")]
    public decimal Amount { get; set; }

    [MaxLength(10)] public string Currency { get; set; } = "USD";

    [MaxLength(120)] public string? BankName { get; set; }
    [MaxLength(40)] public string? SwiftCode { get; set; }
    [MaxLength(80)] public string? FromAccount { get; set; }
    [MaxLength(80)] public string? ToAccount { get; set; }
    public string? Notes { get; set; }

    [Column(TypeName = "datetime")]
    public DateTime CreatedAt { get; set; } = DateTime.Now;

    [MaxLength(100)] public string? CreatedBy { get; set; }

    public ICollection<OemPaymentAllocation> Allocations { get; set; } = new List<OemPaymentAllocation>();
}

public class OemPaymentAllocation
{
    [Key]
    public int Id { get; set; }

    public int OemPaymentTransferId { get; set; }
    public int CarePackBatchId { get; set; }

    [Column(TypeName = "decimal(18,2)")]
    public decimal AllocatedAmount { get; set; }

    public OemPaymentTransfer Transfer { get; set; } = null!;
    public CarePackBatch Batch { get; set; } = null!;
}

/// <summary>
/// Permanent audit for Admin document-chain removals (PO / OEM invoice / OEM payment).
/// Entries are never deleted.
/// </summary>
public class CarePackDocumentAudit
{
    [Key]
    public int Id { get; set; }

    public int CarePackBatchId { get; set; }

    /// <summary>RemovePo | RemoveOemInvoice | RemoveOemPayment</summary>
    [Required, MaxLength(40)]
    public string Action { get; set; } = "";

    /// <summary>What was on the invoice before the remove.</summary>
    [Required]
    public string Snapshot { get; set; } = "";

    [Required, MaxLength(500)]
    public string Reason { get; set; } = "";

    public bool Confirmed { get; set; }

    [MaxLength(100)] public string? PerformedBy { get; set; }

    [Column(TypeName = "datetime")]
    public DateTime PerformedAt { get; set; } = DateTime.Now;

    public CarePackBatch Batch { get; set; } = null!;
}

public static class CarePackDocumentActions
{
    public const string RemovePo = "RemovePo";
    public const string RemoveOemInvoice = "RemoveOemInvoice";
    public const string RemoveOemPayment = "RemoveOemPayment";

    public static string Label(string? action) => action switch
    {
        RemovePo => "OEM PO",
        RemoveOemInvoice => "OEM invoice",
        RemoveOemPayment => "OEM payment",
        _ => action ?? "document",
    };
}

/// <summary>
/// Contractual OEM windows vs app warning limits (stricter).
/// Contract: PO within 30 days of sales invoice; pay OEM within 45 days of OEM bill.
/// App defaults: 25 / 40 days (poka-yoke — act before the hard limit).
/// </summary>
public static class CarePackDeadlines
{
    public const int ContractPoDays = 30;
    public const int ContractPaymentDays = 45;
    public const int DefaultPoLimitDays = 25;
    public const int DefaultPaymentLimitDays = 40;

    public static DateOnly? PoDueDate(DateOnly? salesInvoiceDate, int limitDays) =>
        salesInvoiceDate?.AddDays(limitDays);

    public static DateOnly? PaymentDueDate(DateOnly? oemInvoiceDate, int limitDays) =>
        oemInvoiceDate?.AddDays(limitDays);

    public static int DaysRemaining(DateOnly? due, DateOnly? today = null)
    {
        if (due == null) return int.MaxValue;
        var t = today ?? DateOnly.FromDateTime(DateTime.Today);
        return due.Value.DayNumber - t.DayNumber;
    }

    public static string StatusLabel(int daysRemaining) =>
        daysRemaining < 0 ? "OVERDUE" :
        daysRemaining <= 5 ? "DUE SOON" :
        "OK";
}

// ── Care Pack Device (one serial) ─────────────────────────────────────────────
public class CarePackDevice
{
    [Key]
    public int Id { get; set; }

    public int CarePackBatchId { get; set; }

    /// <summary>Optional link to Product Model master (serial → model → product → OEM).</summary>
    public int? ProductModelId { get; set; }

    [Required, MaxLength(100)]
    public string SerialNumber { get; set; } = "";

    [MaxLength(50)]  public string? OemBrand { get; set; }
    [MaxLength(50)]  public string? CarePackType { get; set; }
    [MaxLength(100)] public string? OriginalModel { get; set; }

    public DateOnly? WarrantyEnd { get; set; }

    // Set 1 — permanent invoice record
    [MaxLength(200)] public string? InvoiceItemName { get; set; }
    [MaxLength(50)]  public string? InvoiceBrandDetected { get; set; }
    public string? InvoiceDescriptionRaw { get; set; }
    [MaxLength(128)] public string? Irn { get; set; }
    [MaxLength(50)]  public string? IrnAckNo { get; set; }

    [Column(TypeName = "datetime")]
    public DateTime? IrnAckDate { get; set; }

    // Set 3 — override audit (per device)
    public bool Overridden { get; set; }
    [MaxLength(100)] public string? OverrideBy { get; set; }

    [Column(TypeName = "datetime")]
    public DateTime? OverrideAt { get; set; }

    public string? OverrideReason { get; set; }
    public bool OverrideConfirmed { get; set; }

    [Column(TypeName = "datetime")]
    public DateTime CreatedAt { get; set; } = DateTime.Now;

    public CarePackBatch Batch { get; set; } = null!;
}

public static class CarePackBatchStatus
{
    public const string Imported    = "IMPORTED";
    public const string PoValidated = "PO_VALIDATED";
    public const string Complete    = "COMPLETE";

    public static readonly Dictionary<string, string> Labels = new()
    {
        [Imported]    = "Imported",
        [PoValidated] = "PO Validated",
        [Complete]    = "100% Verified",
    };

    public static string Label(string s) =>
        Labels.TryGetValue(s, out var l) ? l : s;
}

/// <summary>Care pack / warranty coverage checks (poka-yoke for RMA eligibility).</summary>
public static class CarePackCoverage
{
    /// <summary>True when warranty end date is strictly before today (valid through end date inclusive).</summary>
    public static bool IsExpired(DateOnly? warrantyEnd, DateOnly? asOf = null)
    {
        if (warrantyEnd == null) return false;
        var today = asOf ?? DateOnly.FromDateTime(DateTime.Today);
        return warrantyEnd.Value < today;
    }

    /// <summary>
    /// Batch-level expired flag for list badges: uses latest device WarrantyEnd,
    /// or invoice date + care pack years when devices have no end date.
    /// </summary>
    public static bool IsBatchExpired(CarePackBatch batch, DateOnly? asOf = null)
    {
        var ends = batch.Devices?
            .Where(d => d.WarrantyEnd != null)
            .Select(d => d.WarrantyEnd!.Value)
            .ToList() ?? [];
        if (ends.Count > 0)
            return IsExpired(ends.Max(), asOf);

        if (batch.InvoiceDate == null) return false;
        var years = OemBrandCatalog.DetectDurationYears(batch.CarePackType) ?? 5;
        return IsExpired(batch.InvoiceDate.Value.AddYears(years), asOf);
    }

    public static DateOnly? EffectiveWarrantyEnd(CarePackBatch batch)
    {
        var ends = batch.Devices?
            .Where(d => d.WarrantyEnd != null)
            .Select(d => d.WarrantyEnd!.Value)
            .ToList() ?? [];
        if (ends.Count > 0) return ends.Max();
        if (batch.InvoiceDate == null) return null;
        var years = OemBrandCatalog.DetectDurationYears(batch.CarePackType) ?? 5;
        return batch.InvoiceDate.Value.AddYears(years);
    }
}

/// <summary>
/// Lean Care Pack list row — no full device graph (fast dashboard / registry load).
/// </summary>
public record CarePackBatchListItem(
    int Id,
    string InvoiceNumber,
    int LineSetIndex,
    string? CustomerName,
    string? OemBrand,
    string? PrinterModel,
    string? CarePackType,
    int DeviceCount,
    int InvoiceQty,
    string? PurchaseOrderNumber,
    string? OemInvoiceNumber,
    string? OemInvoicePdfPath,
    bool VerificationComplete,
    string Status,
    DateTime CreatedAt,
    bool Overridden,
    DateOnly? InvoiceDate,
    DateOnly? MaxWarrantyEnd)
{
    public bool IsExpired(DateOnly? asOf = null)
    {
        if (MaxWarrantyEnd != null)
            return CarePackCoverage.IsExpired(MaxWarrantyEnd, asOf);
        if (InvoiceDate == null) return false;
        var years = OemBrandCatalog.DetectDurationYears(CarePackType) ?? 5;
        return CarePackCoverage.IsExpired(InvoiceDate.Value.AddYears(years), asOf);
    }
}

/// <summary>Pending Care Pack checklist rows for reports.</summary>
public record CarePackPendingItem(
    int BatchId,
    string InvoiceNumber,
    int LineSetIndex,
    string? CustomerName,
    string? OemBrand,
    string? PrinterModel,
    int DeviceCount,
    string Status,
    string? PurchaseOrderNumber,
    string? OemInvoiceNumber,
    bool HasOemPdf,
    bool VerificationComplete,
    DateTime CreatedAt,
    string Gap,
    DateOnly? DueDate = null,
    int? DaysRemaining = null,
    decimal? OemInvoiceAmount = null,
    decimal? AmountPaid = null);

public static class AppRoles
{
    public const string Admin       = "Admin";
    public const string Manager     = "Manager";
    public const string Technician  = "Technician";
    public const string Viewer      = "Viewer";

    public static readonly string[] All = [Admin, Manager, Technician, Viewer];

    public static bool CanOverride(string? role) =>
        string.Equals(role, Admin, StringComparison.OrdinalIgnoreCase);

    public static bool CanImport(string? role) =>
        string.Equals(role, Admin, StringComparison.OrdinalIgnoreCase) ||
        string.Equals(role, Manager, StringComparison.OrdinalIgnoreCase);

    /// <summary>Edit serials / qty on import or batch — everyone except Viewer.</summary>
    public static bool CanEditSerials(string? role) =>
        !string.IsNullOrWhiteSpace(role) &&
        !string.Equals(role, Viewer, StringComparison.OrdinalIgnoreCase) &&
        All.Contains(role, StringComparer.OrdinalIgnoreCase);

    /// <summary>Select invoices and validate/link OEM PO with serials — everyone except Viewer.</summary>
    public static bool CanValidatePo(string? role) => CanEditSerials(role);

    public static bool CanViewOverrideLog(string? role) => CanOverride(role);

    public static bool CanManageUsers(string? role) => CanOverride(role);

    /// <summary>Create/edit Customer, OEM, Product, Model, Care Pack Type masters.</summary>
    public static bool CanManageMasters(string? role) => CanImport(role);

    /// <summary>Application Settings (Zoho, company, deadlines) — Admin only.</summary>
    public static bool CanAccessSettings(string? role) => CanOverride(role);

    /// <summary>Remove OEM payment / OEM invoice / PO from a care pack invoice — Admin only.</summary>
    public static bool CanRemoveDocuments(string? role) => CanOverride(role);
}

// Known OEM brands / model → brand mapping for poka-yoke
public static class OemBrandCatalog
{
    public static readonly string[] Brands =
    [
        "TSC Auto ID",
        "Printronix",
        "Honeywell",
    ];

    public static readonly string[] CarePackTypes =
    [
        "1 Year",
        "2 Year",
        "3 Year",
        "4 Year",
        "5 Year",
        "Comprehensive Care Pack",
    ];

    /// <summary>Model prefixes / exact models → OEM brand.</summary>
    public static readonly Dictionary<string, string> ModelBrandMap =
        new(StringComparer.OrdinalIgnoreCase)
        {
            // Printronix
            ["T310"]   = "Printronix",
            ["T330"]   = "Printronix",
            ["T4000"]  = "Printronix",
            ["T6000"]  = "Printronix",
            ["T6000E"] = "Printronix",
            ["T6304"]  = "Printronix",
            ["T6304E"] = "Printronix",
            ["T8000"]  = "Printronix",
            // TSC
            ["TE310"] = "TSC Auto ID",
            ["TE210"] = "TSC Auto ID",
            ["TE200"] = "TSC Auto ID",
            ["TTP"]   = "TSC Auto ID",
            ["MB240"] = "TSC Auto ID",
            ["DA210"] = "TSC Auto ID",
            ["DA310"] = "TSC Auto ID",
            // Honeywell
            ["PM45"]  = "Honeywell",
            ["PM43"]  = "Honeywell",
            ["PX4"]   = "Honeywell",
            ["PX6"]   = "Honeywell",
        };

    public static string? DetectBrandFromText(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        var t = text.ToUpperInvariant();
        if (t.Contains("PRINTRONIX") || t.Contains("CCP") && t.Contains("PRINT"))
            return "Printronix";
        if (t.Contains("HONEYWELL"))
            return "Honeywell";
        if (t.Contains("TSC") || t.Contains("AUTO ID"))
            return "TSC Auto ID";
        return null;
    }

    public static string? DetectBrandFromModel(string? model)
    {
        if (string.IsNullOrWhiteSpace(model)) return null;
        var m = model.Trim();
        if (ModelBrandMap.TryGetValue(m, out var brand)) return brand;

        // Prefix match (longest first)
        foreach (var kv in ModelBrandMap.OrderByDescending(x => x.Key.Length))
        {
            if (m.StartsWith(kv.Key, StringComparison.OrdinalIgnoreCase))
                return kv.Value;
        }
        return null;
    }

    public static string? DetectModelFromText(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        foreach (var model in ModelBrandMap.Keys.OrderByDescending(k => k.Length))
        {
            if (System.Text.RegularExpressions.Regex.IsMatch(
                    text, $@"\b{System.Text.RegularExpressions.Regex.Escape(model)}\b",
                    System.Text.RegularExpressions.RegexOptions.IgnoreCase))
                return model;
        }
        // Printronix-style T6304e / T6000e when not in map yet
        var m = System.Text.RegularExpressions.Regex.Match(
            text, @"\b(T\d{3,4}e?)\b", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        if (m.Success) return m.Groups[1].Value.ToUpperInvariant();
        return null;
    }

    public static int? DetectDurationYears(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        var m = System.Text.RegularExpressions.Regex.Match(
            text, @"(\d)\s*[Yy]ear|\b(\d)YCCP\b|\b(\d)\s*Y\b");
        if (!m.Success) return null;
        for (int i = 1; i <= 3; i++)
            if (m.Groups[i].Success && int.TryParse(m.Groups[i].Value, out var y))
                return y;
        return null;
    }

    public static string CarePackTypeFromYears(int? years) =>
        years is >= 1 and <= 5 ? $"{years} Year" : "5 Year";
}
