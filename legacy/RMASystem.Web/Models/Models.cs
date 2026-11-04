using System.ComponentModel.DataAnnotations;
using System.ComponentModel.DataAnnotations.Schema;

namespace RMASystem.Models;

// ── RMA Ticket ────────────────────────────────────────────────────────────────
public class RMATicket
{
    [Key]
    public int Id { get; set; }

    /// <summary>Tenant company (Phase B).</summary>
    public int CompanyId { get; set; } = CompanyIds.InfiniteSolutions;

    [Required, MaxLength(30)]
    public string InternalTicketNo { get; set; } = "";

    [Required, MaxLength(40)]
    public string Status { get; set; } = "OPEN";

    public bool IsImported { get; set; } = false;

    // Use [Column(TypeName="datetime")] for SQL Server Express compatibility
    [Column(TypeName = "datetime")]
    public DateTime CreatedAt { get; set; } = DateTime.Now;

    [Column(TypeName = "datetime")]
    public DateTime UpdatedAt { get; set; } = DateTime.Now;

    // ── Customer / Partner ────────────────────────────────────────────────────
    /// <summary>Optional link to Customer master.</summary>
    public int? CustomerId { get; set; }
    /// <summary>Optional link to Product Model master.</summary>
    public int? ProductModelId { get; set; }

    [MaxLength(200)] public string? CustomerCompany      { get; set; }
    public string?                  CustomerAddress       { get; set; }
    [MaxLength(100)] public string? CustomerCity         { get; set; }
    [MaxLength(100)] public string? CustomerState        { get; set; }
    [MaxLength(20)]  public string? CustomerPostal       { get; set; }
    [MaxLength(100)] public string? CustomerCountry      { get; set; } = "India";
    [MaxLength(150)] public string? CustomerContactName  { get; set; }
    [MaxLength(200)] public string? CustomerEmail        { get; set; }
    [MaxLength(50)]  public string? CustomerPhone        { get; set; }
    [MaxLength(100)] public string? PoNumber             { get; set; }

    // ── Ship-To ───────────────────────────────────────────────────────────────
    [MaxLength(200)] public string? ShipToCompany       { get; set; }
    public string?                  ShipToAddress        { get; set; }
    [MaxLength(150)] public string? ShipToContactName   { get; set; }
    [MaxLength(200)] public string? ShipToEmail         { get; set; }
    [MaxLength(50)]  public string? ShipToPhone         { get; set; }

    // ── Product / Fault ───────────────────────────────────────────────────────
    [MaxLength(100)] public string?  PrinterModel         { get; set; }
    [MaxLength(100)] public string?  PrinterSn            { get; set; }
    [MaxLength(200)] public string?  FaultyPart           { get; set; }
    [MaxLength(100)] public string?  FaultyPartSn         { get; set; }
    [MaxLength(100)] public string?  FaultyPartNo         { get; set; }
    public string?                    FailureDescription   { get; set; }
    [Column(TypeName = "decimal(10,2)")] public decimal? TphMileage     { get; set; }
    [Column(TypeName = "decimal(10,2)")] public decimal? PrinterMileage { get; set; }
    [MaxLength(50)]  public string?  FwVersion            { get; set; }
    [MaxLength(20)]  public string?  FlashInitialized     { get; set; }
    public DateOnly?                  PurchaseDate         { get; set; }
    public DateOnly?                  DeliveryToUserDate   { get; set; }

    // ── OEM RMA ───────────────────────────────────────────────────────────────
    [MaxLength(100)] public string? OemRmaNumber       { get; set; }
    public DateOnly?                 OemRmaAssignDate   { get; set; }

    [Column(TypeName = "datetime")]
    public DateTime?                 OemEmailReceivedAt { get; set; }

    /// <summary>When OEM RMA email with Excel was sent from this system.</summary>
    [Column(TypeName = "datetime")]
    public DateTime?                 OemEmailSentAt { get; set; }

    [MaxLength(100)] public string? OemEmailSentBy { get; set; }

    // ── Dispatch to OEM ───────────────────────────────────────────────────────
    public DateOnly?                OemDispatchDate    { get; set; }
    [MaxLength(30)] public string? BatchDispatchId    { get; set; }

    // ── Delivery Challan ──────────────────────────────────────────────────────
    [MaxLength(100)] public string? ZohoChallanId     { get; set; }
    [MaxLength(100)] public string? ZohoChallanNumber { get; set; }

    [Column(TypeName = "datetime")]
    public DateTime?                 ChallanCreatedAt  { get; set; }
    public DateOnly?                 DispatchToCustomerDate { get; set; }

    // ── Closure ───────────────────────────────────────────────────────────────
    [Column(TypeName = "datetime")]
    public DateTime?                ClosedAt        { get; set; }
    [MaxLength(30)] public string? ClosureType     { get; set; }
    public string?                  ClosureRemarks  { get; set; }
    public string?                  ExcelFilePath   { get; set; }

    /// <summary>
    /// Required when creating an RMA while another non-closed ticket already uses
    /// the same printer SN or faulty-part SN (poka-yoke override with audit).
    /// </summary>
    public string? DuplicateOpenReason { get; set; }

    [Column(TypeName = "datetime")]
    public DateTime? DuplicateOpenAt { get; set; }

    [MaxLength(100)] public string? DuplicateOpenBy { get; set; }

    // ── Navigation ────────────────────────────────────────────────────────────
    public ICollection<RMAPhoto> Photos { get; set; } = new List<RMAPhoto>();

    // ── Computed helpers ──────────────────────────────────────────────────────
    [NotMapped] public int InboundPhotoCount  => Photos.Count(p => p.Direction == "INBOUND");
    [NotMapped] public int OutboundPhotoCount => Photos.Count(p => p.Direction == "OUTBOUND");
}

// ── RMA Photo ─────────────────────────────────────────────────────────────────
public class RMAPhoto
{
    [Key]
    public int Id { get; set; }

    public int RmaTicketId { get; set; }

    [Required, MaxLength(10)]
    public string Direction { get; set; } = "INBOUND";

    [Required, MaxLength(255)]
    public string Filename { get; set; } = "";

    [Required]
    public string FilePath { get; set; } = "";

    [Column(TypeName = "datetime")]
    public DateTime CapturedAt { get; set; } = DateTime.Now;

    [MaxLength(100)] public string? CapturedBy { get; set; }
    public string?                  Notes       { get; set; }
    public bool EmbeddedInExcel { get; set; } = false;

    public RMATicket Ticket { get; set; } = null!;
}

// ── Monthly Batch ─────────────────────────────────────────────────────────────
public class MonthlyBatch
{
    [Key]
    public int Id { get; set; }

    /// <summary>Tenant company (Phase B).</summary>
    public int CompanyId { get; set; } = CompanyIds.InfiniteSolutions;

    [Required, MaxLength(30)]
    public string BatchId { get; set; } = "";

    [MaxLength(7)]
    public string BatchMonth { get; set; } = "";

    [Column(TypeName = "datetime")]
    public DateTime CreatedAt     { get; set; } = DateTime.Now;
    public DateOnly? DispatchDate  { get; set; }
    public int TotalRmas           { get; set; }
    public string? Remarks         { get; set; }
    public string? ExcelPath       { get; set; }
}

// ── App Setting ───────────────────────────────────────────────────────────────
public class AppSetting
{
    [Key, MaxLength(100)]
    public string Key { get; set; } = "";

    public string Value { get; set; } = "";
}

// ── Import Log ────────────────────────────────────────────────────────────────
public class ImportLog
{
    [Key]
    public int Id { get; set; }

    [Column(TypeName = "datetime")]
    public DateTime ImportedAt      { get; set; } = DateTime.Now;
    [MaxLength(255)] public string? Filename       { get; set; }
    public int TotalRows             { get; set; }
    public int ImportedCount         { get; set; }
    public int DuplicateCount        { get; set; }
    public int ErrorCount            { get; set; }
    public string? SummaryText       { get; set; }
}

// ── Status Constants ──────────────────────────────────────────────────────────
public static class RMAStatus
{
    public const string Open                  = "OPEN";
    public const string AwaitingOemRma        = "AWAITING_OEM_RMA";
    public const string OemRmaReceived        = "OEM_RMA_RECEIVED";
    public const string DispatchedToOem       = "DISPATCHED_TO_OEM";
    public const string GoodsReceivedFromOem  = "GOODS_RECEIVED_FROM_OEM";
    public const string DispatchedToCustomer  = "DISPATCHED_TO_CUSTOMER";
    public const string Closed                = "CLOSED";
    public const string ClosedReturned        = "CLOSED_RETURNED";

    public static readonly Dictionary<string, string> Labels = new()
    {
        [Open]                 = "Open",
        [AwaitingOemRma]       = "Awaiting OEM RMA",
        [OemRmaReceived]       = "OEM RMA Received",
        [DispatchedToOem]      = "Dispatched to OEM",
        [GoodsReceivedFromOem] = "Goods Received from OEM",
        [DispatchedToCustomer] = "Dispatched to Customer",
        [Closed]               = "Closed",
        [ClosedReturned]       = "Closed – Returned",
    };

    public static string Label(string status) =>
        Labels.TryGetValue(status, out var l) ? l : status;

    public static readonly List<string> All = Labels.Keys.ToList();

    public static bool IsClosed(string? status) =>
        status is Closed or ClosedReturned;

    public static bool IsOpenChain(string? status) =>
        !string.IsNullOrWhiteSpace(status) && !IsClosed(status);
}
