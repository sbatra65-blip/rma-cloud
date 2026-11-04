namespace RMASystem.Services;

/// <summary>Process-wide DB bootstrap state (first run / installer consent).</summary>
public class DatabaseSetupState
{
    public bool NeedsConsent { get; set; }
    public bool SqlUnreachable { get; set; }
    /// <summary>SQL reported memory pressure (701) — UI should show recovery steps.</summary>
    public bool SqlMemoryPressure { get; set; }
    /// <summary>Master reachable but Windows login cannot open RMASystem — grant script required.</summary>
    public bool AccessDenied { get; set; }
    public string? LastError { get; set; }
    public string SqlServer { get; set; } = "";
    public string DatabaseName { get; set; } = "RMASystem";
    public bool DatabaseExists { get; set; }
    public bool HasTables { get; set; }
    public bool IsReady => !NeedsConsent && !SqlUnreachable && !AccessDenied && HasTables;
}

public record DatabaseProbeResult(
    bool SqlReachable,
    bool DatabaseExists,
    bool HasTables,
    string Server,
    string DatabaseName,
    string? Error);
