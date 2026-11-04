using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using RMASystem.Data;

namespace RMASystem.Services;

/// <summary>
/// First-run database create + EF migrate with explicit user/installer consent (poka-yoke).
/// Singleton — must not inject scoped services; resolve DbContext via IServiceScopeFactory.
/// </summary>
public class DatabaseSetupService(
    DatabaseSetupState state,
    IServiceScopeFactory scopeFactory,
    ILogger<DatabaseSetupService> log)
{
    public static string ConsentFilePath =>
        Path.Combine(AppPaths.DataRoot, ".db_create_consented");

    public bool HasConsentFlag() => File.Exists(ConsentFilePath);

    public void WriteConsentFlag(string source)
    {
        Directory.CreateDirectory(AppPaths.DataRoot);
        File.WriteAllText(ConsentFilePath,
            $"consented={DateTime.Now:O}\nsource={source}\n");
    }

    public async Task<DatabaseProbeResult> ProbeAsync(CancellationToken ct = default)
    {
        var path = IniConfig.ResolveConfigPath();
        var server = IniConfig.GetSqlServer(path);
        var dbName = IniConfig.GetDatabaseName(path);
        try
        {
            var masterCs = IniConfig.BuildMasterConnectionString(path, server, 5);
            await using var cnn = new SqlConnection(masterCs);
            await cnn.OpenAsync(ct);

            bool dbExists;
            string? stateDesc = null;
            await using (var cmd = cnn.CreateCommand())
            {
                cmd.CommandText = """
                    SELECT
                        CASE WHEN DB_ID(@n) IS NULL THEN 0 ELSE 1 END,
                        CONVERT(nvarchar(60), DATABASEPROPERTYEX(@n, 'Status'))
                    """;
                cmd.Parameters.AddWithValue("@n", dbName);
                await using var r = await cmd.ExecuteReaderAsync(ct);
                if (await r.ReadAsync(ct))
                {
                    dbExists = r.GetInt32(0) == 1;
                    stateDesc = r.IsDBNull(1) ? null : r.GetString(1);
                }
                else
                {
                    dbExists = false;
                }
            }

            // Fail closed: do not query into / migrate a recovering DB (post-login hangs look like a crash).
            if (dbExists &&
                !string.IsNullOrWhiteSpace(stateDesc) &&
                !string.Equals(stateDesc, "ONLINE", StringComparison.OrdinalIgnoreCase))
            {
                return new DatabaseProbeResult(
                    false, true, false, server, dbName,
                    SqlResilience.DatabaseNotOnlineMessage(dbName, stateDesc));
            }

            if (!dbExists)
            {
                return new DatabaseProbeResult(
                    true, false, false, server, dbName,
                    SqlResilience.DatabaseMissingMessage(dbName));
            }

            var hasTables = false;
            await using (var cmd = cnn.CreateCommand())
            {
                cmd.CommandText = $"""
                    SELECT CASE WHEN OBJECT_ID(N'[{dbName.Replace("]", "]]")}].dbo.__EFMigrationsHistory') IS NULL
                         AND OBJECT_ID(N'[{dbName.Replace("]", "]]")}].dbo.AppSettings') IS NULL
                    THEN 0 ELSE 1 END
                    """;
                hasTables = Convert.ToInt32(await cmd.ExecuteScalarAsync(ct)) == 1;
            }

            // Confirm the process identity can open RMASystem (master visibility ≠ USE permission).
            try
            {
                var appCs = IniConfig.BuildConnectionString(path, server, 5);
                await using var appCnn = new SqlConnection(appCs);
                await appCnn.OpenAsync(ct);
            }
            catch (Exception openEx) when (SqlResilience.IsDatabaseMissingOrInaccessible(openEx))
            {
                var identity = Environment.UserDomainName + @"\" + Environment.UserName;
                return new DatabaseProbeResult(
                    true, true, hasTables, server, dbName,
                    SqlResilience.DatabaseAccessDeniedMessage(dbName, identity));
            }

            return new DatabaseProbeResult(true, true, hasTables, server, dbName, null);
        }
        catch (Exception ex)
        {
            return new DatabaseProbeResult(
                false, false, false, server, dbName,
                SqlResilience.UserMessage(ex, ex.Message));
        }
    }

    public async Task RefreshStateAsync(CancellationToken ct = default)
    {
        try
        {
            var probe = await ProbeAsync(ct);
            state.SqlServer = probe.Server;
            state.DatabaseName = probe.DatabaseName;
            state.DatabaseExists = probe.DatabaseExists;
            state.HasTables = probe.HasTables;
            state.LastError = probe.Error;
            state.AccessDenied = probe.DatabaseExists && probe.Error != null &&
                (probe.Error.Contains("cannot open it", StringComparison.OrdinalIgnoreCase)
                 || probe.Error.Contains("login / user mapping", StringComparison.OrdinalIgnoreCase)
                 || probe.Error.Contains("grant-db-access", StringComparison.OrdinalIgnoreCase)
                 || probe.Error.Contains("ensure-sql-access", StringComparison.OrdinalIgnoreCase));
            state.SqlUnreachable = !probe.SqlReachable;
            state.SqlMemoryPressure = probe.Error != null &&
                (probe.Error.Contains("insufficient system memory", StringComparison.OrdinalIgnoreCase)
                 || probe.Error.Contains("resource pool", StringComparison.OrdinalIgnoreCase)
                 || probe.Error.Contains("out of memory", StringComparison.OrdinalIgnoreCase));

            if (probe.HasTables && probe.Error is null)
            {
                state.NeedsConsent = false;
                state.SqlUnreachable = false;
                state.SqlMemoryPressure = false;
                state.AccessDenied = false;
                state.LastError = null;
            }
            else if (!probe.SqlReachable)
            {
                state.NeedsConsent = false;
                state.SqlUnreachable = true;
            }
            else if (state.AccessDenied)
            {
                // Master OK, DB exists, but this Windows identity cannot open it — grant script required.
                state.NeedsConsent = false;
            }
            else
            {
                // SQL OK but no tables — need consent unless installer already consented
                state.NeedsConsent = !HasConsentFlag();
            }
        }
        catch (Exception ex)
        {
            state.SqlUnreachable = true;
            state.SqlMemoryPressure = SqlResilience.IsMemoryPressure(ex);
            state.AccessDenied = SqlResilience.IsDatabaseMissingOrInaccessible(ex) &&
                                 !SqlResilience.IsDatabaseOfflineOrRecovering(ex);
            state.LastError = SqlResilience.UserMessage(ex);
            state.HasTables = false;
            log.LogWarning(ex, "Database probe failed");
        }
    }

    /// <summary>CREATE DATABASE if missing (requires consent), then grant Windows logins.</summary>
    public async Task CreateDatabaseAsync(CancellationToken ct = default)
    {
        var path = IniConfig.ResolveConfigPath();
        var server = IniConfig.GetSqlServer(path);
        var dbName = IniConfig.GetDatabaseName(path);
        if (dbName.IndexOfAny(['\'', ';', '-', ' ']) >= 0 && dbName != "RMASystem")
        {
            // Allow simple names only
            if (!System.Text.RegularExpressions.Regex.IsMatch(dbName, @"^[A-Za-z0-9_]+$"))
                throw new InvalidOperationException("Invalid database name in config.ini.");
        }

        var masterCs = IniConfig.BuildMasterConnectionString(path, server, 15);
        await using var cnn = new SqlConnection(masterCs);
        await cnn.OpenAsync(ct);
        await using (var cmd = cnn.CreateCommand())
        {
            cmd.CommandText = $"""
                IF DB_ID(N'{dbName.Replace("'", "''")}') IS NULL
                BEGIN
                    CREATE DATABASE [{dbName.Replace("]", "]]")}];
                END
                """;
            await cmd.ExecuteNonQueryAsync(ct);
        }

        log.LogInformation("Ensured database {Db} exists on {Server}", dbName, server);
        await EnsureWindowsAccessAsync(cnn, dbName, ct);
    }

    /// <summary>
    /// Grant CREATE LOGIN / CREATE USER / db_owner for the current Windows identity and
    /// NT AUTHORITY\SYSTEM (NSSM service account). Best-effort; surfaces failures.
    /// </summary>
    public async Task EnsureWindowsAccessAsync(
        SqlConnection masterCnn, string dbName, CancellationToken ct = default)
    {
        var identities = new List<string>();
        var current = Environment.UserDomainName + @"\" + Environment.UserName;
        if (!string.IsNullOrWhiteSpace(current) &&
            !current.Equals(@"\", StringComparison.Ordinal))
            identities.Add(current);
        identities.Add(@"NT AUTHORITY\SYSTEM");

        foreach (var login in identities.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            try
            {
                await GrantDbOwnerAsync(masterCnn, dbName, login, ct);
                log.LogInformation("Ensured SQL access for {Login} on {Db}", login, dbName);
            }
            catch (Exception ex)
            {
                // Fail closed for the *current* identity (app cannot proceed); SYSTEM grant is best-effort.
                var isCurrent = login.Equals(current, StringComparison.OrdinalIgnoreCase);
                log.LogWarning(ex, "Could not grant SQL access to {Login} on {Db}", login, dbName);
                if (isCurrent)
                {
                    throw new InvalidOperationException(
                        SqlResilience.DatabaseAccessDeniedMessage(dbName, login) +
                        " Current process could not CREATE LOGIN/USER (run as Administrator or use Tools\\grant-db-access.ps1).",
                        ex);
                }
            }
        }
    }

    static async Task GrantDbOwnerAsync(
        SqlConnection masterCnn, string dbName, string windowsLogin, CancellationToken ct)
    {
        // Bracket-escape login / db names for dynamic SQL.
        var loginLit = windowsLogin.Replace("]", "]]");
        var dbLit = dbName.Replace("]", "]]");
        var loginSql = windowsLogin.Replace("'", "''");

        await using var cmd = masterCnn.CreateCommand();
        cmd.CommandText = $"""
            IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'{loginSql}')
            BEGIN
                CREATE LOGIN [{loginLit}] FROM WINDOWS;
            END

            DECLARE @sql nvarchar(max) = N'
            USE [{dbLit}];
            IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N''{loginSql}'')
            BEGIN
                CREATE USER [{loginLit}] FOR LOGIN [{loginLit}];
            END
            IF IS_ROLEMEMBER(N''db_owner'', N''{loginSql}'') = 0
               OR IS_ROLEMEMBER(N''db_owner'', N''{loginSql}'') IS NULL
            BEGIN
                ALTER ROLE [db_owner] ADD MEMBER [{loginLit}];
            END
            ';
            EXEC sys.sp_executesql @sql;
            """;
        await cmd.ExecuteNonQueryAsync(ct);
    }

    public async Task MigrateAndSeedAsync(CancellationToken ct = default)
    {
        // Poka-yoke: never Migrate into RECOVERING/OFFLINE — EF retries + Connect Timeout hang for minutes.
        var probe = await ProbeAsync(ct);
        if (!probe.SqlReachable)
        {
            var msg = probe.Error ?? "SQL Server / RMASystem is not ready for migrate.";
            state.SqlUnreachable = true;
            state.LastError = msg;
            throw new InvalidOperationException(msg);
        }

        if (!string.IsNullOrEmpty(probe.Error) &&
            probe.Error.Contains("cannot open it", StringComparison.OrdinalIgnoreCase))
        {
            state.AccessDenied = true;
            state.LastError = probe.Error;
            throw new InvalidOperationException(probe.Error);
        }

        using var scope = scopeFactory.CreateScope();
        var dbFactory = scope.ServiceProvider.GetRequiredService<IDbContextFactory<AppDbContext>>();
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        db.BypassCompanyFilter = true;

        try
        {
            await db.Database.MigrateAsync(ct);
        }
        catch (Exception ex) when (SqlResilience.IsObjectAlreadyExists(ex))
        {
            SqlProblemLog.Write(
                "EF migrate skipped object that already exists (2714) — continuing with existing schema",
                ex, state.SqlServer);
            log.LogWarning(ex, "EF migrate: object already exists — leaving existing tables in place.");
        }

        await SeedExistingAsync(scope, db);
        log.LogInformation("Database migrate + seed complete.");
    }

    /// <summary>
    /// Connect to the existing RMASystem DB and seed defaults. Does not run EF migrations.
    /// </summary>
    public async Task PrepareExistingDatabaseAsync(CancellationToken ct = default)
    {
        var probe = await ProbeAsync(ct);
        if (!probe.SqlReachable)
        {
            var msg = probe.Error ?? "SQL Server / RMASystem is not ready.";
            state.SqlUnreachable = true;
            state.LastError = msg;
            SqlProblemLog.Write("Prepare existing DB: SQL not reachable", null, probe.Server, extra: msg);
            throw new InvalidOperationException(msg);
        }

        using var scope = scopeFactory.CreateScope();
        var dbFactory = scope.ServiceProvider.GetRequiredService<IDbContextFactory<AppDbContext>>();
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        db.BypassCompanyFilter = true;
        await SeedExistingAsync(scope, db);
        log.LogInformation("Existing database ready (AutoMigrate=false) on {Server}/{Db}.",
            probe.Server, probe.DatabaseName);
    }

    async Task SeedExistingAsync(IServiceScope scope, Data.AppDbContext db)
    {
        var current = await db.GetSettingAsync("base_dir");
        if (string.IsNullOrWhiteSpace(current) ||
            current.Contains("Sanjay Projects", StringComparison.OrdinalIgnoreCase) ||
            !Directory.Exists(current))
        {
            await db.SetSettingAsync("base_dir", AppPaths.DataRoot);
        }

        await db.SetSettingAsync("setup_complete", "true");

        var companies = scope.ServiceProvider.GetRequiredService<CompanyService>();
        await companies.EnsureSeedAsync();
        var masters = scope.ServiceProvider.GetRequiredService<MasterDataService>();
        await masters.EnsureSeedAsync();
        var auth = scope.ServiceProvider.GetRequiredService<AuthService>();
        await auth.EnsureSeedAsync();

        state.NeedsConsent = false;
        state.SqlUnreachable = false;
        state.SqlMemoryPressure = false;
        state.AccessDenied = false;
        state.HasTables = true;
        state.DatabaseExists = true;
        state.LastError = null;
    }

    /// <summary>
    /// User or installer approved creating DB/tables.
    /// </summary>
    public async Task ConsentAndInitializeAsync(string source, CancellationToken ct = default)
    {
        WriteConsentFlag(source);
        await CreateDatabaseAsync(ct);
        await MigrateAndSeedAsync(ct);
    }
}
