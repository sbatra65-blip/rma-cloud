namespace RMASystem.Services;

/// <summary>Scoped active-company holder used by EF query filters (Phase B).</summary>
public class CompanyContext
{
    /// <summary>-1 until resolved — fail closed (no rows leak across companies).</summary>
    public int CompanyId { get; set; } = -1;
}
