using System.ComponentModel.DataAnnotations;
using System.ComponentModel.DataAnnotations.Schema;

namespace RMASystem.Models;

// ── UI preferences (dark mode, list/card dashboard) ───────────────────────────
public class UserUiPreference
{
    [Key]
    public int Id { get; set; }

    [Required, MaxLength(100)]
    public string UserName { get; set; } = "default";

    public bool DarkMode { get; set; }

    /// <summary>cards | list</summary>
    [Required, MaxLength(20)]
    public string DashboardView { get; set; } = DashboardViews.Cards;

    [Column(TypeName = "datetime")]
    public DateTime UpdatedAt { get; set; } = DateTime.Now;
}

public static class DashboardViews
{
    public const string Cards = "cards";
    public const string List  = "list";
}

// ── Activity feed ─────────────────────────────────────────────────────────────
public class ActivityLog
{
    [Key]
    public int Id { get; set; }

    [Required, MaxLength(40)]
    public string Category { get; set; } = ""; // RMA, Support, Repair, CarePack, Parts, OEM

    [Required, MaxLength(200)]
    public string Title { get; set; } = "";

    [MaxLength(300)]
    public string? Detail { get; set; }

    [MaxLength(20)]
    public string Color { get; set; } = "accent"; // accent, success, warning, danger

    [MaxLength(100)]
    public string? RefLink { get; set; }

    [Column(TypeName = "datetime")]
    public DateTime CreatedAt { get; set; } = DateTime.Now;
}

// ── Support tickets ───────────────────────────────────────────────────────────
public class SupportTicket
{
    [Key]
    public int Id { get; set; }

    [Required, MaxLength(30)]
    public string TicketNo { get; set; } = "";

    [Required, MaxLength(30)]
    public string Status { get; set; } = SupportStatus.New;

    [MaxLength(200)] public string? CustomerName { get; set; }
    [MaxLength(40)]  public string? SerialNumber { get; set; }
    public string? Subject { get; set; }

    public bool SlaBreached { get; set; }

    [Column(TypeName = "datetime")]
    public DateTime CreatedAt { get; set; } = DateTime.Now;

    [Column(TypeName = "datetime")]
    public DateTime? ResolvedAt { get; set; }

    public double? ResolutionHours { get; set; }
}

public static class SupportStatus
{
    public const string New         = "NEW";
    public const string InProgress  = "IN_PROGRESS";
    public const string Resolved    = "RESOLVED";
    public const string Closed      = "CLOSED";
}

// ── Repair jobs ───────────────────────────────────────────────────────────────
public class RepairJob
{
    [Key]
    public int Id { get; set; }

    [Required, MaxLength(30)]
    public string JobNo { get; set; } = "";

    [Required, MaxLength(40)]
    public string Status { get; set; } = RepairStatus.Received;

    [MaxLength(200)] public string? CustomerName { get; set; }
    [MaxLength(40)]  public string? SerialNumber { get; set; }
    [MaxLength(100)] public string? PrinterModel { get; set; }
    public string? FaultDescription { get; set; }

    [Column(TypeName = "decimal(12,2)")]
    public decimal? QuoteAmount { get; set; }

    [MaxLength(50)] public string? ZohoInvoiceNumber { get; set; }

    [Column(TypeName = "datetime")]
    public DateTime CreatedAt { get; set; } = DateTime.Now;

    [Column(TypeName = "datetime")]
    public DateTime? InvoicedAt { get; set; }
}

public static class RepairStatus
{
    public const string Received        = "RECEIVED";
    public const string InDiagnosis     = "IN_DIAGNOSIS";
    public const string Quoted          = "QUOTED";
    public const string Approved        = "APPROVED";
    public const string Repaired        = "REPAIRED";
    public const string ReadyToDeliver  = "READY_TO_DELIVER";
    public const string Invoiced        = "INVOICED";
    public const string Closed          = "CLOSED";
}

// ── OEM notifications queue ───────────────────────────────────────────────────
public class OemNotification
{
    [Key]
    public int Id { get; set; }

    [Required, MaxLength(40)]
    public string Kind { get; set; } = ""; // PART_EXTRACTED, PART_REPLACED, CONVERSION

    [Required, MaxLength(200)]
    public string Title { get; set; } = "";

    [MaxLength(40)]  public string? SerialNumber { get; set; }
    [MaxLength(40)]  public string? RefNumber { get; set; }

    [Required, MaxLength(20)]
    public string Status { get; set; } = OemNotifyStatus.Unsent;

    [Column(TypeName = "datetime")]
    public DateTime CreatedAt { get; set; } = DateTime.Now;

    [Column(TypeName = "datetime")]
    public DateTime? SentAt { get; set; }
}

public static class OemNotifyStatus
{
    public const string Unsent = "UNSENT";
    public const string Sent   = "SENT";
}

// ── Part movements ledger ─────────────────────────────────────────────────────
public class PartMovement
{
    [Key]
    public int Id { get; set; }

    [Required, MaxLength(10)]
    public string Direction { get; set; } = "IN"; // IN | OUT

    [Required, MaxLength(200)]
    public string Description { get; set; } = "";

    [MaxLength(40)]  public string? SerialNumber { get; set; }
    [MaxLength(100)] public string? PartName { get; set; }
    [MaxLength(40)]  public string? RefNumber { get; set; }

    [Column(TypeName = "datetime")]
    public DateTime MovedAt { get; set; } = DateTime.Now;
}
