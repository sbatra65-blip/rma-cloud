using System.Text;

namespace RMASystem;

/// <summary>
/// Reads install-time settings from config.ini (SQL Server name, etc.).
/// Prefer this over hard-coded connection strings.
/// </summary>
public static class IniConfig
{
    public static string? LastLoadedPath { get; private set; }

    public static string ResolveConfigPath()
    {
        var fromEnv = Environment.GetEnvironmentVariable("RMA_CONFIG_PATH");
        if (!string.IsNullOrWhiteSpace(fromEnv) && File.Exists(fromEnv.Trim()))
            return Path.GetFullPath(fromEnv.Trim());

        foreach (var candidate in EnumerateCandidates())
        {
            if (File.Exists(candidate))
                return candidate;
        }

        // Default write location for new installs / first run
        var installRoot = ResolveInstallRoot();
        return Path.Combine(installRoot, "config.ini");
    }

    public static Dictionary<string, Dictionary<string, string>> Load(string? path = null)
    {
        path ??= ResolveConfigPath();
        LastLoadedPath = path;
        var result = new Dictionary<string, Dictionary<string, string>>(StringComparer.OrdinalIgnoreCase);
        if (!File.Exists(path))
            return result;

        string section = "";
        foreach (var raw in File.ReadAllLines(path))
        {
            var line = raw.Trim();
            if (line.Length == 0 || line.StartsWith(';') || line.StartsWith('#'))
                continue;
            if (line.StartsWith('[') && line.EndsWith(']'))
            {
                section = line[1..^1].Trim();
                if (!result.ContainsKey(section))
                    result[section] = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                continue;
            }

            var eq = line.IndexOf('=');
            if (eq <= 0) continue;
            var key = line[..eq].Trim();
            var value = line[(eq + 1)..].Trim();
            if (!result.ContainsKey(section))
                result[section] = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            result[section][key] = value;
        }

        return result;
    }

    public static string? Get(string section, string key, string? path = null)
    {
        var ini = Load(path);
        if (ini.TryGetValue(section, out var map) && map.TryGetValue(key, out var value))
            return string.IsNullOrWhiteSpace(value) ? null : value.Trim();
        return null;
    }

    /// <summary>
    /// Server= from config.ini only (null when missing/blank). Never invents an instance.
    /// </summary>
    public static string? GetConfiguredSqlServer(string? path = null) =>
        Get("Database", "Server", path)
        ?? Get("Database", "ServerName", path)
        ?? Get("SQL", "Server", path);

    /// <summary>
    /// Configured Server=, or default .\SQLEXPRESS01 when the key is blank (fresh install only).
    /// Prefer <see cref="GetConfiguredSqlServer"/> when you must fail closed on an explicit value.
    /// </summary>
    public static string GetSqlServer(string? path = null) =>
        GetConfiguredSqlServer(path) ?? @".\SQLEXPRESS01";

    /// <summary>
    /// EF MigrateAsync at startup. Default false — existing RMASystem DB must not be altered.
    /// Set AutoMigrate=true in config.ini only when a new schema change is approved.
    /// </summary>
    public static bool GetAutoMigrate(string? path = null)
    {
        var v = Get("Database", "AutoMigrate", path);
        if (string.IsNullOrWhiteSpace(v)) return false;
        return v.Equals("true", StringComparison.OrdinalIgnoreCase)
               || v.Equals("yes", StringComparison.OrdinalIgnoreCase)
               || v == "1";
    }

    public static string GetDatabaseName(string? path = null) =>
        Get("Database", "Database", path)
        ?? Get("Database", "DatabaseName", path)
        ?? "RMASystem";

    public static string BuildConnectionString(
        string? path = null, string? serverOverride = null, int connectTimeoutSeconds = 30)
    {
        var server = serverOverride ?? GetSqlServer(path);
        var database = GetDatabaseName(path);
        var timeout = Math.Clamp(connectTimeoutSeconds, 1, 120);
        // MARS + pooling reduce Blazor "connection lost" / concurrent query failures.
        return $"Server={server};Database={database};Integrated Security=True;" +
               "TrustServerCertificate=True;Encrypt=False;" +
               // Modest pool: Blazor + SQL Express on low-RAM PCs; large pools amplify 701 OOM.
               "MultipleActiveResultSets=True;Pooling=True;Max Pool Size=50;Min Pool Size=0;" +
               $"Connect Timeout={timeout};Connection Lifetime=300;";
    }

    /// <summary>Connect to master (create-database / BACKUP) without requiring RMASystem to exist.</summary>
    public static string BuildMasterConnectionString(
        string? path = null, string? serverOverride = null, int connectTimeoutSeconds = 15)
    {
        var server = serverOverride ?? GetSqlServer(path);
        var timeout = Math.Clamp(connectTimeoutSeconds, 1, 120);
        return $"Server={server};Database=master;Integrated Security=True;" +
               "TrustServerCertificate=True;Encrypt=False;" +
               $"Connect Timeout={timeout};";
    }

    /// <summary>
    /// When Server= is set in config.ini, yields only that instance (fail closed — no silent switch).
    /// When blank, yields common local Express / LocalDB names for first-run discovery.
    /// </summary>
    public static IEnumerable<string> EnumerateSqlServerCandidates(string? path = null)
    {
        var configured = GetConfiguredSqlServer(path);
        if (!string.IsNullOrWhiteSpace(configured))
        {
            yield return configured.Trim();
            yield break;
        }

        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var s in new[]
                 {
                     @"localhost\SQLEXPRESS01",
                     @".\SQLEXPRESS01",
                     @"localhost\SQLEXPRESS",
                     @".\SQLEXPRESS",
                 })
        {
            if (string.IsNullOrWhiteSpace(s)) continue;
            var trimmed = s.Trim();
            if (seen.Add(trimmed))
                yield return trimmed;
        }
    }

    /// <summary>
    /// Writes Server= only when the key is missing/blank. Never overwrites an explicit instance
    /// (poka-yoke: do not silently switch SQLEXPRESS01 → SQLEXPRESS).
    /// </summary>
    public static void TryUpdateSqlServer(string server, string? path = null)
    {
        path ??= ResolveConfigPath();
        if (!File.Exists(path) || string.IsNullOrWhiteSpace(server)) return;
        if (!string.IsNullOrWhiteSpace(GetConfiguredSqlServer(path)))
            return; // explicit Server= — leave it alone
        try
        {
            var lines = File.ReadAllLines(path).ToList();
            var inDb = false;
            var updated = false;
            for (var i = 0; i < lines.Count; i++)
            {
                var t = lines[i].Trim();
                if (t.StartsWith('[') && t.EndsWith(']'))
                {
                    inDb = t.Equals("[Database]", StringComparison.OrdinalIgnoreCase);
                    continue;
                }
                if (!inDb) continue;
                if (t.StartsWith("Server=", StringComparison.OrdinalIgnoreCase) ||
                    t.StartsWith("ServerName=", StringComparison.OrdinalIgnoreCase))
                {
                    // Blank Server= — fill in discovered instance
                    var key = lines[i].Split('=')[0];
                    var existing = lines[i].Contains('=') ? lines[i][(lines[i].IndexOf('=') + 1)..].Trim() : "";
                    if (!string.IsNullOrWhiteSpace(existing))
                        return;
                    lines[i] = $"{key}={server}";
                    updated = true;
                    break;
                }
            }
            if (updated)
                File.WriteAllLines(path, lines, Encoding.UTF8);
        }
        catch
        {
            /* non-fatal */
        }
    }

    public static string? GetDataRootOverride(string? path = null) =>
        Get("Paths", "DataRoot", path);

    public static void EnsureDefaultFile(string? path = null)
    {
        path ??= ResolveConfigPath();
        if (File.Exists(path)) return;

        var dir = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(dir))
            Directory.CreateDirectory(dir);

        var sb = new StringBuilder();
        sb.AppendLine("; RMA System configuration — edit Server=, then restart the RMASystem service.");
        sb.AppendLine();
        sb.AppendLine("[Database]");
        sb.AppendLine(@"Server=.\SQLEXPRESS01");
        sb.AppendLine("Database=RMASystem");
        sb.AppendLine("AutoMigrate=false");
        sb.AppendLine();
        sb.AppendLine("[Paths]");
        sb.AppendLine("DataRoot=");
        File.WriteAllText(path, sb.ToString(), Encoding.UTF8);
        LastLoadedPath = path;
    }

    static IEnumerable<string> EnumerateCandidates()
    {
        var baseDir = AppContext.BaseDirectory.TrimEnd(
            Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);

        // Install layout: {install}\App\ → {install}\config.ini
        if (string.Equals(Path.GetFileName(baseDir), "App", StringComparison.OrdinalIgnoreCase))
        {
            var parent = Path.GetDirectoryName(baseDir);
            if (!string.IsNullOrEmpty(parent))
                yield return Path.Combine(parent, "config.ini");
        }

        yield return Path.Combine(baseDir, "config.ini");

        var dataEnv = Environment.GetEnvironmentVariable("RMA_DATA_DIR");
        if (!string.IsNullOrWhiteSpace(dataEnv))
            yield return Path.Combine(dataEnv.Trim(), "config.ini");

        // Dev: solution root next to RMASystem.Web
        var cwd = Directory.GetCurrentDirectory();
        yield return Path.Combine(cwd, "config.ini");
        yield return Path.Combine(cwd, "..", "config.ini");
        yield return Path.Combine(cwd, "..", "..", "..", "..", "config.ini");

        var legacy = @"C:\Sanjay Projects\Projects\RMA Windows\RMASystem\config.ini";
        if (File.Exists(legacy))
            yield return legacy;
    }

    static string ResolveInstallRoot()
    {
        var dataEnv = Environment.GetEnvironmentVariable("RMA_DATA_DIR");
        if (!string.IsNullOrWhiteSpace(dataEnv))
            return Path.GetFullPath(dataEnv.Trim());

        var baseDir = AppContext.BaseDirectory.TrimEnd(
            Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        if (string.Equals(Path.GetFileName(baseDir), "App", StringComparison.OrdinalIgnoreCase))
        {
            var parent = Path.GetDirectoryName(baseDir);
            if (!string.IsNullOrEmpty(parent))
                return parent;
        }

        return baseDir;
    }
}
