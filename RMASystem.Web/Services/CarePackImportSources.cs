namespace RMASystem.Services;

/// <summary>
/// Pluggable Care Pack import source (Phase B).
/// Manual + PDF + Zoho ship in core; SAP/Busy/Tally arrive in Phase C.
/// </summary>
public interface ICarePackImportSource
{
    string Id { get; }
    string DisplayName { get; }
    string Description { get; }
    bool IsEnabled { get; }
    /// <summary>True when this source can fetch/prefill without typing everything.</summary>
    bool SupportsPrefill { get; }
}

public sealed class ManualCarePackImportSource : ICarePackImportSource
{
    public string Id => "manual";
    public string DisplayName => "Manual entry";
    public string Description => "Type invoice, products, and serials. No Zoho or PDF required.";
    public bool IsEnabled => true;
    public bool SupportsPrefill => false;
}

public sealed class PdfCarePackImportSource : ICarePackImportSource
{
    public string Id => "pdf";
    public string DisplayName => "Prefill from PDF";
    public string Description => "Parse a sales invoice PDF into the shared draft editor.";
    public bool IsEnabled => true;
    public bool SupportsPrefill => true;
}

public sealed class ZohoCarePackImportSource : ICarePackImportSource
{
    public string Id => "zoho";
    public string DisplayName => "From Zoho";
    public string Description => "Fetch invoice lines from Zoho Books for the active company.";
    public bool IsEnabled => true;
    public bool SupportsPrefill => true;
}

public class CarePackImportSourceRegistry(IEnumerable<ICarePackImportSource> sources)
{
    readonly List<ICarePackImportSource> _sources = sources.ToList();

    public IReadOnlyList<ICarePackImportSource> All => _sources;

    public ICarePackImportSource? Get(string? id) =>
        _sources.FirstOrDefault(s =>
            string.Equals(s.Id, id, StringComparison.OrdinalIgnoreCase));

    public ICarePackImportSource Default =>
        Get("manual") ?? _sources.First();
}
