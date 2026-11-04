using Microsoft.Extensions.Hosting;

namespace RMASystem.Services;

/// <summary>
/// Background probe: when SQL is down or under memory pressure, keep retrying so the
/// process self-heals without a restart (Windows service stays up).
/// </summary>
public sealed class SqlWatchdogService(
    IServiceScopeFactory scopeFactory,
    DatabaseSetupState state,
    ILogger<SqlWatchdogService> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await Task.Delay(TimeSpan.FromSeconds(15), stoppingToken);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                if (state.IsReady && !state.SqlUnreachable)
                {
                    // Healthy enough — light sleep. Clear stale error after a successful probe.
                    if (!string.IsNullOrEmpty(state.LastError) || state.SqlMemoryPressure)
                    {
                        using var scope = scopeFactory.CreateScope();
                        var setup = scope.ServiceProvider.GetRequiredService<DatabaseSetupService>();
                        await setup.RefreshStateAsync(stoppingToken);
                    }
                    await Task.Delay(TimeSpan.FromSeconds(60), stoppingToken);
                    continue;
                }

                using var recoverScope = scopeFactory.CreateScope();
                var recoverSetup = recoverScope.ServiceProvider.GetRequiredService<DatabaseSetupService>();
                await recoverSetup.RefreshStateAsync(stoppingToken);

                if (state.HasTables && !state.SqlUnreachable)
                {
                    try
                    {
                        if (IniConfig.GetAutoMigrate())
                            await recoverSetup.MigrateAndSeedAsync(stoppingToken);
                        else
                            await recoverSetup.PrepareExistingDatabaseAsync(stoppingToken);
                        log.LogInformation("SQL watchdog: database recovered and ready.");
                    }
                    catch (Exception ex) when (SqlResilience.IsTransient(ex))
                    {
                        state.SqlUnreachable = true;
                        state.SqlMemoryPressure = SqlResilience.IsMemoryPressure(ex);
                        state.LastError = SqlResilience.UserMessage(ex);
                        SqlProblemLog.Write("SQL watchdog recover failed (transient)", ex, state.SqlServer);
                        log.LogWarning("SQL watchdog: transient failure during recover — {Msg}", state.LastError);
                    }
                }
                else if (state.SqlUnreachable)
                {
                    log.LogWarning("SQL watchdog: still unreachable — {Err}", state.LastError);
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                state.LastError = SqlResilience.UserMessage(ex);
                state.SqlMemoryPressure = SqlResilience.IsMemoryPressure(ex);
                if (SqlResilience.IsTransient(ex))
                    state.SqlUnreachable = true;
                SqlProblemLog.Write("SQL watchdog probe failed", ex, state.SqlServer);
                log.LogWarning(ex, "SQL watchdog probe failed");
            }

            var delay = state.SqlUnreachable || state.SqlMemoryPressure
                ? TimeSpan.FromSeconds(20)
                : TimeSpan.FromSeconds(45);
            await Task.Delay(delay, stoppingToken);
        }
    }
}
