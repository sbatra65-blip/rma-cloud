using System.Security.Claims;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Data.SqlClient;
using RMASystem;
using RMASystem.Data;
using RMASystem.Models;
using RMASystem.Services;
using Serilog;
using Serilog.Events;

IniConfig.EnsureDefaultFile();
AppPaths.Initialize();

Log.Logger = new LoggerConfiguration()
    .MinimumLevel.Information()
    .MinimumLevel.Override("Microsoft", LogEventLevel.Warning)
    .MinimumLevel.Override("Microsoft.AspNetCore", LogEventLevel.Warning)
    .MinimumLevel.Override("Microsoft.EntityFrameworkCore", LogEventLevel.Warning)
    .MinimumLevel.Override("Microsoft.EntityFrameworkCore.Database.Command", LogEventLevel.Fatal)
    .MinimumLevel.Override("Microsoft.EntityFrameworkCore.Database.Connection", LogEventLevel.Warning)
    // Soften Microsoft.Data.SqlClient TLS/protocol chatter (Encrypt=False already in cs).
    .MinimumLevel.Override("Microsoft.Data.SqlClient", LogEventLevel.Error)
    .MinimumLevel.Override("System", LogEventLevel.Warning)
    .Enrich.FromLogContext()
    .WriteTo.Console(restrictedToMinimumLevel: LogEventLevel.Information,
        outputTemplate: "[{Timestamp:HH:mm:ss} {Level:u3}] {Message:lj}{NewLine}{Exception}")
    .WriteTo.File(
        Path.Combine(AppPaths.Logs, "rma-.log"),
        rollingInterval: RollingInterval.Day,
        retainedFileCountLimit: 30,
        restrictedToMinimumLevel: LogEventLevel.Information)
    .CreateLogger();

// Process-level: log unexpected faults; observe unobserved tasks so they don't tear down the host.
AppDomain.CurrentDomain.UnhandledException += (_, e) =>
{
    try
    {
        Log.Fatal(e.ExceptionObject as Exception,
            "Unhandled exception (IsTerminating={Terminating})", e.IsTerminating);
    }
    catch { /* logging may be unavailable */ }
};
TaskScheduler.UnobservedTaskException += (_, e) =>
{
    try
    {
        Log.Error(e.Exception, "Unobserved task exception — observed to avoid process tear-down");
        e.SetObserved();
    }
    catch { /* ignore */ }
};

try
{
    Log.Information("RMA System starting...");
    Log.Information("Data root: {DataRoot}", AppPaths.DataRoot);
    Log.Information("RMA_DATA_DIR={DataDir}; RMA_CONFIG_PATH={ConfigEnv}",
        Environment.GetEnvironmentVariable("RMA_DATA_DIR") ?? "(unset)",
        Environment.GetEnvironmentVariable("RMA_CONFIG_PATH") ?? "(unset)");

    var configPath = IniConfig.ResolveConfigPath();
    var configuredServer = IniConfig.GetConfiguredSqlServer(configPath);
    Log.Information("Config: {ConfigPath}", configPath);
    Log.Information("config.ini Server={Server}",
        string.IsNullOrWhiteSpace(configuredServer) ? "(blank — will probe SQLEXPRESS01 first)" : configuredServer);
    Log.Information("AutoMigrate={AutoMigrate} (false = use existing tables, no EF schema changes)",
        IniConfig.GetAutoMigrate(configPath));

    var (conn, sqlServer, sqlReadyAtStart) = await ResolveSqlConnectionAsync(configPath);
    Log.Information("SQL Server: {Server} (reachable at start: {Ready})", sqlServer, sqlReadyAtStart);

    var builder = WebApplication.CreateBuilder(args);
    AppPaths.Initialize(builder.Configuration);

    // Serilog owns logging — do not spam UI/console with EF SQL.
    builder.Logging.ClearProviders();
    builder.Host.UseSerilog();

    builder.Host.UseWindowsService(opts =>
        opts.ServiceName = "RMA System");

    void ConfigureSql(DbContextOptionsBuilder opts) =>
        opts.UseSqlServer(conn, sql =>
            {
                sql.EnableRetryOnFailure(
                    maxRetryCount: 6,
                    maxRetryDelay: TimeSpan.FromSeconds(15),
                    errorNumbersToAdd: SqlResilience.ExtraTransientErrorNumbers);
                sql.CommandTimeout(60);
            })
            .EnableSensitiveDataLogging(false)
            .EnableDetailedErrors(false);

    // Singleton factory (same as Single User) — AppDbContext has no scoped constructor deps.
    // Scoped AppDbContext shares CompanyContext so Blazor circuits keep tenant filters.
    builder.Services.AddDbContextFactory<AppDbContext>(ConfigureSql);
    builder.Services.AddScoped(sp =>
    {
        var db = sp.GetRequiredService<IDbContextFactory<AppDbContext>>().CreateDbContext();
        db.BindCompany(sp.GetRequiredService<CompanyContext>());
        return db;
    });

    builder.Services.AddHttpContextAccessor();
    builder.Services.AddSingleton<IPasswordHasher<AppUser>, PasswordHasher<AppUser>>();
    builder.Services.AddSingleton<DatabaseSetupState>();
    builder.Services.AddSingleton<DatabaseSetupService>();
    builder.Services.AddHostedService<SqlWatchdogService>();
    builder.Services.AddScoped<DatabaseBackupService>();
    builder.Services.AddScoped<CompanyContext>();
    builder.Services.AddScoped<AuthService>();
    builder.Services.AddScoped<CompanyService>();
    builder.Services.AddScoped<MasterDataService>();
    builder.Services.AddScoped<TicketService>();
    builder.Services.AddScoped<PhotoService>();
    builder.Services.AddScoped<ExcelService>();
    builder.Services.AddScoped<ImportService>();
    builder.Services.AddScoped<BatchService>();
    builder.Services.AddScoped<ZohoService>();
    builder.Services.AddScoped<UserSessionService>();
    builder.Services.AddScoped<CarePackService>();
    builder.Services.AddScoped<ICarePackImportSource, ManualCarePackImportSource>();
    builder.Services.AddScoped<ICarePackImportSource, PdfCarePackImportSource>();
    builder.Services.AddScoped<ICarePackImportSource, ZohoCarePackImportSource>();
    builder.Services.AddScoped<CarePackImportSourceRegistry>();
    builder.Services.AddScoped<CarePackDraftStore>();
    builder.Services.AddScoped<UiPreferenceService>();
    builder.Services.AddScoped<OemEmailService>();
    builder.Services.AddScoped<DashboardService>();

    builder.Services.AddDataProtection()
        .PersistKeysToFileSystem(new DirectoryInfo(Path.Combine(AppPaths.DataRoot, "Keys")))
        .SetApplicationName("RMASystem");

    builder.Services.AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
        .AddCookie(options =>
        {
            options.LoginPath = "/login";
            options.AccessDeniedPath = "/login";
            options.SlidingExpiration = true;
            // Long-lived for LAN workstations — renews while the user is active
            options.ExpireTimeSpan = TimeSpan.FromDays(7);
            // Critical for LAN HTTP (http://192.168.x.x:5000) — do not require HTTPS-only cookies
            options.Cookie.Name = ".RMA.Auth";
            options.Cookie.HttpOnly = true;
            options.Cookie.SecurePolicy = CookieSecurePolicy.SameAsRequest;
            options.Cookie.SameSite = SameSiteMode.Lax;
            options.Cookie.Path = "/";
            options.Cookie.IsEssential = true;
            options.Events.OnValidatePrincipal = ValidateSessionPrincipalAsync;
            options.Events.OnRedirectToLogin = ctx =>
            {
                // API/SignalR: return 401 instead of HTML redirect (breaks remote Blazor negotiate)
                if (ctx.Request.Path.StartsWithSegments("/_blazor") ||
                    ctx.Request.Path.StartsWithSegments("/api"))
                {
                    ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
                    return Task.CompletedTask;
                }
                ctx.Response.Redirect(ctx.RedirectUri);
                return Task.CompletedTask;
            };
        });

    builder.Services.AddAuthorization(options =>
    {
        // Default: authenticated. Blazor hub / _Host are explicitly AllowAnonymous
        // so remote clients can open /login before a cookie exists.
        options.FallbackPolicy = new AuthorizationPolicyBuilder()
            .RequireAuthenticatedUser()
            .Build();
    });
    builder.Services.AddCascadingAuthenticationState();

    builder.Services.AddHttpClient();
    builder.Services.AddControllers();
    builder.Services.AddRazorPages(options =>
    {
        options.Conventions.AllowAnonymousToPage("/_Host");
    });
    builder.Services.AddServerSideBlazor(opts =>
    {
        // Hide exception/SQL internals from the browser error banner
        opts.DetailedErrors = false;
        // Lower retention than LAN defaults — repeated F5/Hot Reload must not OOM the process
        opts.DisconnectedCircuitMaxRetained = 50;
        opts.DisconnectedCircuitRetentionPeriod = TimeSpan.FromMinutes(3);
        opts.JSInteropDefaultCallTimeout = TimeSpan.FromMinutes(2);
        opts.MaxBufferedUnacknowledgedRenderBatches = 10;
    });
    builder.Services.AddSignalR(opts =>
    {
        // Generous timeouts for remote LAN / LongPolling clients
        opts.ClientTimeoutInterval = TimeSpan.FromMinutes(2);
        opts.HandshakeTimeout = TimeSpan.FromSeconds(30);
        opts.KeepAliveInterval = TimeSpan.FromSeconds(15);
        opts.EnableDetailedErrors = false;
    });

    // Bind all interfaces so LAN PCs can connect by IP (do not use localhost-only).
    // Clear conflicting UseUrls / appsettings Kestrel endpoints that fight each other.
    builder.WebHost.UseSetting(WebHostDefaults.ServerUrlsKey, "");
    builder.WebHost.ConfigureKestrel(k =>
    {
        k.ListenAnyIP(5000);
        k.Limits.MaxRequestBodySize = 52_428_800; // 50 MB uploads
        k.Limits.KeepAliveTimeout = TimeSpan.FromMinutes(2);
        k.Limits.RequestHeadersTimeout = TimeSpan.FromSeconds(60);
    });

    var app = builder.Build();

    if (!sqlReadyAtStart)
    {
        // Mark degraded only; BootstrapDatabaseAsync / RefreshStateAsync re-probes master and
        // distinguishes unreachable vs missing DB vs access denied (do not force SqlUnreachable).
        var st = app.Services.GetRequiredService<DatabaseSetupState>();
        st.SqlServer = sqlServer;
        st.DatabaseName = IniConfig.GetDatabaseName(configPath);
        st.LastError ??= SqlResilience.CannotOpenConfiguredServerMessage(sqlServer,
            "Open /setup and click Refresh after fixing SQL / permissions.");
    }

    await BootstrapDatabaseAsync(app.Services);

    app.UseExceptionHandler(errApp =>
    {
        errApp.Run(async ctx =>
        {
            var feat = ctx.Features.Get<Microsoft.AspNetCore.Diagnostics.IExceptionHandlerFeature>();
            var ex = feat?.Error;
            Log.Error(ex, "Unhandled HTTP exception on {Path}", ctx.Request.Path);
            ctx.Response.StatusCode = StatusCodes.Status500InternalServerError;
            ctx.Response.ContentType = "text/plain; charset=utf-8";
            var msg = SqlResilience.IsTransient(ex)
                ? SqlResilience.UserMessage(ex)
                : "An unexpected error occurred. Check RMA logs and try again.";
            await ctx.Response.WriteAsync(msg);
        });
    });

    app.UseStaticFiles();
    app.UseRouting();
    app.UseAuthentication();
    app.UseAuthorization();

    app.MapControllers();
    app.MapRazorPages();
    // Anonymous hub access required so /login can render before cookie exists.
    // WebSockets + LongPolling so LAN clients behind strict firewalls still work.
    app.MapBlazorHub(opts =>
    {
        opts.Transports = HttpTransportType.WebSockets
                          | HttpTransportType.ServerSentEvents
                          | HttpTransportType.LongPolling;
    }).AllowAnonymous();
    app.MapFallbackToPage("/_Host").AllowAnonymous();
    app.MapGet("/health", () =>
        {
            var st = app.Services.GetRequiredService<DatabaseSetupState>();
            return Results.Ok(new
            {
                status = st.IsReady ? "ok" : (st.NeedsConsent ? "needs_db_setup" : "degraded"),
                dataRoot = AppPaths.DataRoot,
                sql = sqlServer,
                listen = "0.0.0.0:5000",
                databaseExists = st.DatabaseExists,
                hasTables = st.HasTables,
                needsConsent = st.NeedsConsent,
                sqlUnreachable = st.SqlUnreachable,
                sqlMemoryPressure = st.SqlMemoryPressure,
                lastError = st.LastError,
            });
        })
        .AllowAnonymous();

    Log.Information("RMA System listening on http://0.0.0.0:5000 (all network interfaces)");
    try
    {
        var host = System.Net.Dns.GetHostEntry(System.Net.Dns.GetHostName());
        foreach (var ip in host.AddressList.Where(a => a.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork))
            Log.Information("LAN URL: http://{Ip}:5000", ip);
    }
    catch { /* ignore */ }

    await app.RunAsync();
}
catch (IOException ex) when (ex.Message.Contains("address already in use", StringComparison.OrdinalIgnoreCase) ||
                             ex.Message.Contains("Only one usage of each socket", StringComparison.OrdinalIgnoreCase))
{
    Log.Fatal(ex,
        "RMA System failed to start — port 5000 is already in use. Stop the other RMASystem process/service, then restart.");
    // Cannot bind — exit so Windows Service / NSSM can restart after the other instance is stopped.
    Environment.ExitCode = 1;
}
catch (Exception ex)
{
    Log.Fatal(ex, "RMA System failed to start");
    Environment.ExitCode = 1;
}
finally
{
    Log.CloseAndFlush();
}

static async Task<(string ConnectionString, string Server, bool Reachable)> ResolveSqlConnectionAsync(string configPath)
{
    Exception? last = null;
    string? bestServer = null;
    string? bestCs = null;
    var bestScore = -1;

    // Explicit Server= in config.ini — use exclusively (never invent SQLEXPRESS / LocalDB).
    var configured = IniConfig.GetConfiguredSqlServer(configPath)?.Trim();
    var candidates = IniConfig.EnumerateSqlServerCandidates(configPath).ToList();

    async Task<(bool Ok, int Score, string? Cs, Exception? Err)> ProbeAsync(string server, int timeoutSec)
    {
        // Probe master first — opening RMASystem while RECOVERING causes post-login hangs.
        var masterCs = IniConfig.BuildMasterConnectionString(configPath, server, timeoutSec);
        try
        {
            await using var master = new SqlConnection(masterCs);
            await master.OpenAsync();

            var dbName = IniConfig.GetDatabaseName(configPath);
            int dbExistsFlag;
            string? stateDesc;
            await using (var stateCmd = master.CreateCommand())
            {
                stateCmd.CommandTimeout = timeoutSec;
                stateCmd.CommandText = """
                    SELECT
                        CASE WHEN DB_ID(@n) IS NULL THEN 0 ELSE 1 END,
                        CONVERT(nvarchar(60), DATABASEPROPERTYEX(@n, 'Status'))
                    """;
                stateCmd.Parameters.AddWithValue("@n", dbName);
                await using var r = await stateCmd.ExecuteReaderAsync();
                if (!await r.ReadAsync())
                {
                    dbExistsFlag = 0;
                    stateDesc = null;
                }
                else
                {
                    dbExistsFlag = r.GetInt32(0);
                    stateDesc = r.IsDBNull(1) ? null : r.GetString(1);
                }
            }

            if (dbExistsFlag == 0)
            {
                var msg = SqlResilience.DatabaseMissingMessage(dbName);
                Log.Warning("SQL probe {Server}: master OK — {Msg}", server, msg);
                return (false, -1, null, new InvalidOperationException(msg));
            }

            if (!string.IsNullOrWhiteSpace(stateDesc) &&
                !string.Equals(stateDesc, "ONLINE", StringComparison.OrdinalIgnoreCase))
            {
                var msg = SqlResilience.DatabaseNotOnlineMessage(dbName, stateDesc);
                Log.Warning("SQL probe {Server}: {Msg}", server, msg);
                return (false, -1, null, new InvalidOperationException(msg));
            }

            var cs = IniConfig.BuildConnectionString(configPath, server, timeoutSec);
            try
            {
                await using var cnn = new SqlConnection(cs);
                await cnn.OpenAsync();
                var score = 0;
                try
                {
                    await using var cmd = cnn.CreateCommand();
                    cmd.CommandTimeout = timeoutSec;
                    cmd.CommandText =
                        "SELECT ISNULL((SELECT COUNT(*) FROM dbo.CarePackDevices),0) " +
                        "+ ISNULL((SELECT COUNT(*) FROM dbo.RMATickets),0)";
                    score = Convert.ToInt32(await cmd.ExecuteScalarAsync());
                }
                catch
                {
                    score = 0;
                }

                Log.Information("SQL probe {Server}: reachable, data score={Score}", server, score);
                return (true, score, cs, null);
            }
            catch (Exception openEx) when (SqlResilience.IsDatabaseMissingOrInaccessible(openEx))
            {
                var identity = Environment.UserDomainName + @"\" + Environment.UserName;
                var msg = SqlResilience.DatabaseAccessDeniedMessage(dbName, identity);
                SqlProblemLog.Write("Cannot open RMASystem on configured instance", openEx, server, configPath, msg);
                Log.Warning("SQL probe {Server}: {Msg} ({Detail})", server, msg, openEx.Message);
                return (false, -1, null, new InvalidOperationException(msg, openEx));
            }
        }
        catch (Exception ex)
        {
            var (num, state, cls) = SqlResilience.SqlErrorParts(ex);
            SqlProblemLog.Write("SQL probe failed", ex, server, configPath);
            Log.Warning(
                "SQL probe failed for {Server}: Number={Number} State={State} Class={Class} {Message}",
                server, num, state, cls, ex.Message);
            return (false, -1, null, ex);
        }
    }

    // ── Explicit Server= : probe that instance only; fail closed on that name ──
    if (!string.IsNullOrWhiteSpace(configured))
    {
        var (ok, _, cs, err) = await ProbeAsync(configured!, 5);
        if (ok && cs != null)
            return (IniConfig.BuildConnectionString(configPath, configured!, 30), configured!, true);

        var detail = err?.Message ?? "unknown error";
        SqlProblemLog.Write(
            "Configured SQL instance not usable — no fallback to another instance",
            err, configured, configPath, detail);
        Log.Error(err,
            "Cannot open DB on configured server {Server} (config: {ConfigPath}). " +
            "Will not fall back to another SQL instance. Fix Server= (must be SQLEXPRESS01) / permissions, then Restart-Service RMASystem. Detail: {Detail}",
            configured, configPath, detail);
        // Degraded: keep host alive for /setup — connection string still targets configured server.
        return (IniConfig.BuildConnectionString(configPath, configured!, 15), configured!, false);
    }

    // ── Blank Server= : discover among common local instances ──
    Log.Information("config.ini Server= blank — probing common SQL Express instances");
    foreach (var server in candidates)
    {
        var (ok, score, cs, err) = await ProbeAsync(server, 4);
        if (err != null) last = err;
        if (!ok || cs == null) continue;

        if (score > bestScore)
        {
            bestScore = score;
            bestServer = server;
            bestCs = cs;
        }

        if (score > 0)
            break;
    }

    if (bestServer == null || bestCs == null)
    {
        var fallback = @".\SQLEXPRESS01";
        SqlProblemLog.Write(
            "SQL unreachable at startup — degraded mode, still targeting SQLEXPRESS01",
            last, fallback, configPath);
        Log.Warning(
            last,
            "SQL unreachable at startup — starting in degraded mode with Server={Server}. " +
            "Set Server=localhost\\SQLEXPRESS01 in {ConfigPath}, then restart.",
            fallback, configPath);
        return (IniConfig.BuildConnectionString(configPath, fallback, 15), fallback, false);
    }

    // Persist discovery only when Server= was blank (TryUpdateSqlServer refuses overwrite).
    Log.Information("Discovered SQL '{Server}' (data score {Score}); writing Server= into blank config.ini.",
        bestServer, bestScore);
    IniConfig.TryUpdateSqlServer(bestServer, configPath);

    return (IniConfig.BuildConnectionString(configPath, bestServer, 30), bestServer, true);
}

static async Task ValidateSessionPrincipalAsync(CookieValidatePrincipalContext context)
{
    try
    {
        var sid = context.Principal?.FindFirstValue(AuthService.ClaimSessionId);
        var uid = context.Principal?.FindFirstValue(AuthService.ClaimUserId);
        if (!Guid.TryParse(sid, out var sessionId) || !int.TryParse(uid, out var userId))
        {
            context.RejectPrincipal();
            await context.HttpContext.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme);
            return;
        }

        var dbFactory = context.HttpContext.RequestServices.GetRequiredService<IDbContextFactory<AppDbContext>>();
        await using var db = await dbFactory.CreateDbContextAsync();
        var session = await db.AppUserSessions.AsNoTracking()
            .Include(s => s.User)
            .FirstOrDefaultAsync(s => s.Id == sessionId);
        if (session == null || session.UserId != userId || session.IsRevoked || session.EndedAt != null ||
            !session.User.IsEnabled)
        {
            context.RejectPrincipal();
            await context.HttpContext.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme);
            return;
        }

        // Poka-yoke: cookie company must match the user's home company
        if (int.TryParse(context.Principal!.FindFirstValue(AuthService.ClaimCompanyId), out var claimCid) &&
            claimCid != session.User.CompanyId)
        {
            context.RejectPrincipal();
            await context.HttpContext.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme);
            return;
        }

        var identity = (ClaimsIdentity)(context.Principal.Identity
            ?? throw new InvalidOperationException("Authenticated principal missing identity."));
        var existingCid = identity.FindFirst(AuthService.ClaimCompanyId);
        if (existingCid == null)
            identity.AddClaim(new Claim(AuthService.ClaimCompanyId, session.User.CompanyId.ToString()));

        // Touch LastSeen; allow sliding cookie renewal occasionally so remote
        // sessions stay alive without rewriting the cookie on every SignalR poll.
        if (session.LastSeenAt < DateTime.Now.AddMinutes(-2))
        {
            await db.AppUserSessions
                .Where(s => s.Id == sessionId)
                .ExecuteUpdateAsync(s => s.SetProperty(x => x.LastSeenAt, DateTime.Now));
            context.ShouldRenew = true;
        }
        else
        {
            context.ShouldRenew = false;
        }

        var auth = context.HttpContext.RequestServices.GetRequiredService<AuthService>();
        var globalDays = await auth.GetGlobalPasswordExpiryDaysAsync();
        var mustChange = AuthService.IsPasswordExpired(session.User, globalDays);
        var existing = identity.FindFirst(AuthService.ClaimMustChange);
        if (existing != null) identity.RemoveClaim(existing);
        identity.AddClaim(new Claim(AuthService.ClaimMustChange, mustChange ? "1" : "0"));
    }
    catch (Exception ex) when (SqlResilience.IsTransient(ex))
    {
        // Keep the existing principal through SQL blips — do not sign everyone out.
        Log.Warning(ex, "Session validation skipped due to transient SQL error");
        context.ShouldRenew = false;
        try
        {
            var st = context.HttpContext.RequestServices.GetService<DatabaseSetupState>();
            if (st != null)
            {
                st.SqlMemoryPressure = SqlResilience.IsMemoryPressure(ex);
                st.LastError = SqlResilience.UserMessage(ex);
            }
        }
        catch { /* ignore */ }
    }
    catch (Exception ex)
    {
        Log.Warning(ex, "Session validation failed — rejecting principal");
        context.RejectPrincipal();
        try
        {
            await context.HttpContext.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme);
        }
        catch { /* ignore */ }
    }
}

static async Task BootstrapDatabaseAsync(IServiceProvider services)
{
    var setup = services.GetRequiredService<DatabaseSetupService>();
    var state = services.GetRequiredService<DatabaseSetupState>();

    // Cap unreachable retries so Kestrel can listen in /setup mode quickly (watchdog recovers).
    // Long bootstrap before Listen looks like a hard crash after backup/SQL recovery.
    const int maxAttempts = 20;
    const int maxUnreachableAttempts = 3;
    for (var attempt = 1; attempt <= maxAttempts; attempt++)
    {
        try
        {
            await setup.RefreshStateAsync();
            Log.Information(
                "DB probe {Attempt}/{Max}: sql={Sql} dbExists={Db} tables={Tables} consent={Consent}",
                attempt, maxAttempts, !state.SqlUnreachable, state.DatabaseExists, state.HasTables,
                setup.HasConsentFlag());

            if (state.HasTables && !state.SqlUnreachable)
            {
                var autoMigrate = IniConfig.GetAutoMigrate();
                if (autoMigrate)
                {
                    Log.Information("AutoMigrate=true — applying EF migrations on {Server}/{Db}",
                        state.SqlServer, state.DatabaseName);
                    await setup.MigrateAndSeedAsync();
                }
                else
                {
                    Log.Information(
                        "AutoMigrate=false — skipping EF migrations. Using existing database on {Server}/{Db}.",
                        state.SqlServer, state.DatabaseName);
                    await setup.PrepareExistingDatabaseAsync();
                }
                Log.Information(autoMigrate
                    ? "Database ready (migrations applied)."
                    : "Database ready (existing schema, migrations skipped).");
                return;
            }

            if (state.SqlUnreachable)
            {
                if (attempt >= maxUnreachableAttempts)
                {
                    Log.Warning(
                        "SQL/RMASystem not ready after {N} attempts (e.g. recovering after backup). " +
                        "Starting in setup mode. Error: {Err}",
                        maxUnreachableAttempts, state.LastError);
                    return;
                }
                await Task.Delay(TimeSpan.FromSeconds(2));
                continue;
            }

            // SQL reachable, no tables yet
            if (setup.HasConsentFlag())
            {
                Log.Information("Installer/user consent found — creating database and applying migrations...");
                await setup.ConsentAndInitializeAsync("startup-consent-flag");
                return;
            }

            state.NeedsConsent = true;
            Log.Warning(
                "RMA database/tables not found. Waiting for user permission at /setup " +
                "(or re-run installer with 'Create database' task).");
            return;
        }
        catch (Exception ex)
        {
            SqlProblemLog.Write($"Database bootstrap attempt {attempt} failed", ex, state.SqlServer);
            Log.Warning(ex, "Database bootstrap attempt {Attempt} failed", attempt);
            state.LastError = SqlResilience.UserMessage(ex);
            state.SqlMemoryPressure = SqlResilience.IsMemoryPressure(ex);
            if (SqlResilience.IsDatabaseOfflineOrRecovering(ex) || SqlResilience.IsTransient(ex))
                state.SqlUnreachable = true;

            // Recovering/offline: fail closed immediately — do not burn 20 migrate retries.
            if (SqlResilience.IsDatabaseOfflineOrRecovering(ex))
            {
                state.HasTables = state.DatabaseExists; // may still exist; just not usable yet
                Log.Error(
                    "RMASystem not ONLINE during bootstrap. Open http://localhost:5000/setup — {Err}",
                    state.LastError);
                return;
            }

            if (SqlResilience.IsDatabaseMissingOrInaccessible(ex))
            {
                state.SqlUnreachable = false;
                state.NeedsConsent = !setup.HasConsentFlag() && !state.DatabaseExists;
                state.AccessDenied = state.DatabaseExists;
                Log.Error(
                    "RMASystem missing or Windows login cannot open it. Open /setup or run Tools\\grant-db-access.ps1 (if DB exists) — {Err}",
                    state.LastError);
                return;
            }

            if (attempt == maxAttempts ||
                (state.SqlUnreachable && attempt >= maxUnreachableAttempts))
            {
                state.NeedsConsent = !state.HasTables && !state.SqlUnreachable && !state.AccessDenied;
                Log.Error(
                    "Could not initialize database after {Max} attempts. Open http://localhost:5000/setup",
                    attempt);
                return; // do not crash the service — setup UI / watchdog can retry
            }
            await Task.Delay(TimeSpan.FromSeconds(3));
        }
    }
}
