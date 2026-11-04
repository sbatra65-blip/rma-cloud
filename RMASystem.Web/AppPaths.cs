using Microsoft.Extensions.Configuration;

namespace RMASystem;

/// <summary>
/// Resolves the writable data root (Photos, Excel, Logs, etc.) for both
/// development and installed layouts ({install}\App\ binaries, {install}\ data).
/// </summary>
public static class AppPaths
{
    public static string DataRoot { get; private set; } =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "RMA System");

    public static string Logs => Path.Combine(DataRoot, "Logs");
    public static string Photos => Path.Combine(DataRoot, "Photos");
    public static string Excel => Path.Combine(DataRoot, "Excel");

    public static void Initialize(IConfiguration? config = null)
    {
        DataRoot = ResolveDataRoot(config);
        foreach (var sub in new[] { "Logs", "Photos", "Excel", "Challans", "Batches", "Imports", "Backups", "CarePack", "Keys", "Reports", "Drafts",
                     Path.Combine("CarePack", "OemInvoices"), Path.Combine("CarePack", "ValidationReports") })
            Directory.CreateDirectory(Path.Combine(DataRoot, sub));
    }

    public static string ResolveDataRoot(IConfiguration? config = null)
    {
        var fromEnv = Environment.GetEnvironmentVariable("RMA_DATA_DIR");
        if (!string.IsNullOrWhiteSpace(fromEnv))
            return Path.GetFullPath(fromEnv.Trim());

        var fromIni = IniConfig.GetDataRootOverride();
        if (!string.IsNullOrWhiteSpace(fromIni))
            return Path.GetFullPath(fromIni);

        var fromCfg = config?["DataRoot"];
        if (!string.IsNullOrWhiteSpace(fromCfg))
            return Path.GetFullPath(fromCfg.Trim());

        var baseDir = AppContext.BaseDirectory.TrimEnd(
            Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);

        // Installer layout: {install}\App\RMASystem.exe → data at {install}\
        if (string.Equals(Path.GetFileName(baseDir), "App", StringComparison.OrdinalIgnoreCase))
        {
            var parent = Path.GetDirectoryName(baseDir);
            if (!string.IsNullOrEmpty(parent))
                return Path.GetFullPath(parent);
        }

        // Dev machine with existing project data folder
        var legacy = @"C:\Sanjay Projects\Projects\RMA Windows";
        if (Directory.Exists(legacy))
            return legacy;

        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
            "RMA System");
    }
}
