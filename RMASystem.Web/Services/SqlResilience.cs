using Microsoft.Data.SqlClient;

namespace RMASystem.Services;

/// <summary>
/// Classifies SQL failures for retry / degraded-mode messaging (poka-yoke: surface, don't crash).
/// </summary>
public static class SqlResilience
{
    /// <summary>
    /// Extra numbers for EF EnableRetryOnFailure (beyond EF's built-in Azure/transient set).
    /// Includes SQL Express memory pressure (701) and common connectivity blips.
    /// </summary>
    public static readonly int[] ExtraTransientErrorNumbers =
    [
        701,   // Out of memory / resource pool 'internal'
        1204,  // Lock resources unavailable
        1222,  // Lock request timeout
        8645,  // Timeout waiting for memory resource
        8651,  // Low memory condition
        -2,    // Client timeout
        233,   // Connection initialization error
        10053, // Transport-level error
        10054, // Connection reset
        10060, // Network timeout
        40197, 40501, 40613, 49918, 49919, 49920, // Azure (harmless locally)
    ];

    public static bool IsMemoryPressure(Exception? ex)
    {
        foreach (var sql in EnumerateSqlExceptions(ex))
        {
            if (sql.Number is 701 or 8645 or 8651) return true;
            if (sql.Message.Contains("insufficient system memory", StringComparison.OrdinalIgnoreCase))
                return true;
            if (sql.Message.Contains("resource pool", StringComparison.OrdinalIgnoreCase))
                return true;
        }

        return ex?.Message.Contains("insufficient system memory", StringComparison.OrdinalIgnoreCase) == true;
    }

    /// <summary>
    /// RMASystem offline/recovering after BACKUP/RESTORE — not missing-DB or login failure.
    /// Do not treat bare 4060 ("cannot open database") as offline — that often means the DB
    /// does not exist yet or the Windows login has no user mapping.
    /// </summary>
    public static bool IsDatabaseOfflineOrRecovering(Exception? ex)
    {
        foreach (var sql in EnumerateSqlExceptions(ex))
        {
            if (sql.Message.Contains("recovering", StringComparison.OrdinalIgnoreCase))
                return true;
            if (sql.Message.Contains("RESTORE", StringComparison.OrdinalIgnoreCase) &&
                sql.Message.Contains("database", StringComparison.OrdinalIgnoreCase))
                return true;
            if (sql.Message.Contains("is OFFLINE", StringComparison.OrdinalIgnoreCase) ||
                sql.Message.Contains("is SUSPECT", StringComparison.OrdinalIgnoreCase) ||
                sql.Message.Contains("is EMERGENCY", StringComparison.OrdinalIgnoreCase))
                return true;
        }

        var text = ex?.GetBaseException().Message ?? "";
        return text.Contains("is RECOVERING", StringComparison.OrdinalIgnoreCase)
               || text.Contains("is RESTORING", StringComparison.OrdinalIgnoreCase)
               || text.Contains("is OFFLINE", StringComparison.OrdinalIgnoreCase)
               || text.Contains("is SUSPECT", StringComparison.OrdinalIgnoreCase)
               || text.Contains("(often after backup/restore)", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>SQL 4060 / "Cannot open database …" — missing DB or no permission to open it.</summary>
    public static bool IsCannotOpenDatabase(Exception? ex)
    {
        foreach (var sql in EnumerateSqlExceptions(ex))
        {
            if (sql.Number is 4060) return true;
            if (sql.Message.Contains("Cannot open database", StringComparison.OrdinalIgnoreCase))
                return true;
        }

        var text = ex?.GetBaseException().Message ?? "";
        return text.Contains("Cannot open database", StringComparison.OrdinalIgnoreCase)
               || text.Contains("does not exist yet", StringComparison.OrdinalIgnoreCase)
               || text.Contains("database is missing", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>SQL 18456 login failure (Windows or SQL auth).</summary>
    public static bool IsLoginFailed(Exception? ex)
    {
        foreach (var sql in EnumerateSqlExceptions(ex))
        {
            if (sql.Number is 18456) return true;
            if (sql.Message.Contains("Login failed for user", StringComparison.OrdinalIgnoreCase))
                return true;
        }

        var text = ex?.GetBaseException().Message ?? "";
        return text.Contains("Login failed for user", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// Master reachable but RMASystem missing or Windows identity cannot open it.
    /// Prefer /setup + create/grant guidance — not "not ONLINE".
    /// </summary>
    public static bool IsDatabaseMissingOrInaccessible(Exception? ex) =>
        !IsDatabaseOfflineOrRecovering(ex) &&
        (IsCannotOpenDatabase(ex) || IsLoginFailed(ex));

    /// <summary>SQL 2714 / 1913 — object or index already exists (do not treat as crash).</summary>
    public static bool IsObjectAlreadyExists(Exception? ex)
    {
        foreach (var sql in EnumerateSqlExceptions(ex))
        {
            if (sql.Number is 2714 or 1913) return true;
            if (sql.Message.Contains("already an object named", StringComparison.OrdinalIgnoreCase))
                return true;
        }

        var text = ex?.GetBaseException().Message ?? "";
        return text.Contains("already an object named", StringComparison.OrdinalIgnoreCase);
    }

    public static (int Number, int State, byte Class) SqlErrorParts(Exception? ex)
    {
        foreach (var sql in EnumerateSqlExceptions(ex))
            return (sql.Number, sql.State, sql.Class);
        return (0, 0, 0);
    }

    public static bool IsTransient(Exception? ex)
    {
        // Recovering/offline: fail closed — do not burn EF retry budget (looks like app hang/crash).
        if (IsDatabaseOfflineOrRecovering(ex)) return false;
        // Missing DB / access denied: not transient — needs setup or admin grant.
        if (IsDatabaseMissingOrInaccessible(ex)) return false;
        if (IsMemoryPressure(ex)) return true;
        foreach (var sql in EnumerateSqlExceptions(ex))
        {
            if (ExtraTransientErrorNumbers.Contains(sql.Number)) return true;
            // Deadlock is retried by EF by default; keep helper consistent
            if (sql.Number is 1205) return true;
        }

        return ex is TimeoutException or IOException;
    }

    public static string UserMessage(Exception? ex, string? fallback = null)
    {
        if (IsMemoryPressure(ex))
        {
            return "SQL Server is out of memory on this PC. Close other apps (Chrome/VS), " +
                   "restart the SQL Server Express service for the instance in config.ini Server=, then click Refresh. " +
                   "RMA stays online in setup mode until SQL recovers.";
        }

        if (IsDatabaseOfflineOrRecovering(ex))
        {
            return "RMASystem database is offline or recovering (common right after backup/restore). " +
                   "Wait 1–2 minutes, or restart the SQL Server Express service for the instance in config.ini Server=, then open /setup and Refresh. " +
                   "Do not hide this — the app will stay in setup mode until the database is ONLINE.";
        }

        if (IsDatabaseMissingOrInaccessible(ex) || IsLoginFailed(ex) || IsCannotOpenDatabase(ex))
        {
            var who = TryExtractLoginName(ex);
            var whoBit = string.IsNullOrEmpty(who) ? "the Windows account running RMA" : $"'{who}'";
            // Prefer permission wording — common after restore to another PC (DB exists, mapping missing).
            return $"SQL Server is reachable, but {whoBit} cannot open database 'RMASystem' " +
                   "(Windows login / user mapping missing — data may already exist). " +
                   "Run Tools\\grant-db-access.ps1 as Administrator " +
                   "(CREATE LOGIN + CREATE USER + db_owner for current user and NT AUTHORITY\\SYSTEM), " +
                   "then restart the RMASystem service and open /setup → Refresh. " +
                   "Do not re-create the database if data is already present.";
        }

        var msg = ex?.GetBaseException().Message ?? fallback ?? "Database temporarily unavailable.";
        if (msg.Length > 280) msg = msg[..277] + "…";
        return msg;
    }

    public static string DatabaseNotOnlineMessage(string dbName, string stateDesc) =>
        $"Database '{dbName}' is {stateDesc} (often after backup/restore). " +
        "Wait for recovery or restart the SQL Server Express instance named in config.ini Server=, then Refresh at /setup.";

    public static string DatabaseMissingMessage(string dbName) =>
        $"Database '{dbName}' does not exist yet on this SQL instance (Server= in config.ini). " +
        "Open /setup to create it (consent required), or run Tools\\ensure-sql-access.ps1 as Administrator.";

    public static string CannotOpenConfiguredServerMessage(string server, string? detail = null)
    {
        var bit = string.IsNullOrWhiteSpace(detail) ? "" : $" Detail: {detail}";
        return $"Cannot open database on configured SQL Server '{server}'. " +
               $"Fix Server= in config.ini or SQL permissions — the app will not use a different instance.{bit}";
    }

    public static string DatabaseAccessDeniedMessage(string dbName, string? windowsIdentity = null)
    {
        var who = string.IsNullOrWhiteSpace(windowsIdentity) ? "this Windows account" : $"'{windowsIdentity}'";
        return $"Database '{dbName}' exists but {who} cannot open it (SQL login / user mapping missing — common after restore from another PC). " +
               "Run Tools\\grant-db-access.ps1 as Administrator (grants current user + NT AUTHORITY\\SYSTEM). " +
               "Do not CREATE DATABASE again if your data is already present. Then restart RMASystem and Refresh /setup.";
    }

    static string? TryExtractLoginName(Exception? ex)
    {
        var text = ex?.GetBaseException().Message ?? "";
        // Login failed for user 'DOMAIN\user'.
        const string marker = "Login failed for user ";
        var i = text.IndexOf(marker, StringComparison.OrdinalIgnoreCase);
        if (i < 0) return null;
        var rest = text[(i + marker.Length)..].Trim();
        if (rest.StartsWith('\''))
        {
            var end = rest.IndexOf('\'', 1);
            if (end > 1) return rest[1..end];
        }
        return null;
    }

    static IEnumerable<SqlException> EnumerateSqlExceptions(Exception? ex)
    {
        for (var cur = ex; cur != null; cur = cur.InnerException)
        {
            if (cur is SqlException sql) yield return sql;
            if (cur is AggregateException agg)
            {
                foreach (var inner in agg.InnerExceptions)
                foreach (var nested in EnumerateSqlExceptions(inner))
                    yield return nested;
            }
        }
    }
}
