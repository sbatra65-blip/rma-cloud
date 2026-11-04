using System.ComponentModel.DataAnnotations;
using System.ComponentModel.DataAnnotations.Schema;

namespace RMASystem.Models;

/// <summary>
/// Company profile (Phase B). One install can hold Infinite Solutions + other companies.
/// Users belong to one company (chosen at login). Care Pack / RMA rows are scoped by CompanyId.
/// </summary>
public class Company
{
    [Key]
    public int Id { get; set; }

    [Required, MaxLength(20)]
    public string Code { get; set; } = "";

    [Required, MaxLength(200)]
    public string Name { get; set; } = "";

    /// <summary>Prefill for sales invoice numbers (e.g. IS-GST-2627-).</summary>
    [MaxLength(40)]
    public string InvoicePrefix { get; set; } = "";

    /// <summary>RMA ticket prefix (e.g. INF → INF-RMA-…).</summary>
    [MaxLength(20)]
    public string TicketPrefix { get; set; } = "INF";

    [MaxLength(200)] public string? City { get; set; }
    [MaxLength(200)] public string? Address { get; set; }
    [MaxLength(100)] public string? ContactName { get; set; }
    [MaxLength(200)] public string? Email { get; set; }
    [MaxLength(50)] public string? Phone { get; set; }

    /// <summary>Optional per-company Zoho Books org. Empty = use global AppSettings (legacy).</summary>
    [MaxLength(50)] public string? ZohoBooksOrgId { get; set; }
    [MaxLength(20)] public string? ZohoDc { get; set; }
    [MaxLength(200)] public string? ZohoClientId { get; set; }
    [MaxLength(200)] public string? ZohoClientSecret { get; set; }
    public string? ZohoBooksRefreshToken { get; set; }

    public bool IsActive { get; set; } = true;

    [Column(TypeName = "datetime")]
    public DateTime CreatedAt { get; set; } = DateTime.Now;
}

public static class CompanyIds
{
    /// <summary>Seeded Infinite Solutions — all pre-Phase-B rows backfill to this.</summary>
    public const int InfiniteSolutions = 1;
}
