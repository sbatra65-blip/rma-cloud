using Microsoft.Data.SqlClient;
using Serilog;

namespace RMASystem.Services;

/// <summary>
/// Dedicated SQL problem file (Logs\sql-problems-yyyyMMdd.log) plus Serilog.
/// Does not crash if the log file cannot be written.
/// </summary>
public static class SqlProblemLog
{
    public static void Write(
        string problem,
        Exception? ex = null,
        string? server = null,
        string? configPath = null,
        string? extra = null)
    {
        configPath ??= IniConfig.LastLoadedPath ?? IniConfig.ResolveConfigPath();
        server ??= IniConfig.GetConfiguredSqlServer(configPath) ?? "(not set in config.ini)";
        var db = IniConfig.GetDatabaseName(configPath);
        var windows = Environment.UserDomainName + @"\" + Environment.UserName;
        var (number, state, cls) = SqlResilience.SqlErrorParts(ex);

        try
        {
            Log.Error(
                ex,
                "SQL PROBLEM: {Problem} | Server={Server} | Database={Db} | Config={Config} | Windows={Windows} | SqlNumber={Number} State={State} Class={Class} | {Extra}",
                problem, server, db, configPath, windows, number, state, cls, extra ?? "");
        }
        catch { /* Serilog may not be ready */ }

        try
        {
            Directory.CreateDirectory(AppPaths.Logs);
            var path = Path.Combine(AppPaths.Logs, $"sql-problems-{DateTime.Now:yyyyMMdd}.log");
            var block =
                $"===== {DateTime.Now:yyyy-MM-dd HH:mm:ss} ====={Environment.NewLine}" +
                $"Problem:  {problem}{Environment.NewLine}" +
                $"Config:   {configPath}{Environment.NewLine}" +
                $"Server=:  {server}{Environment.NewLine}" +
                $"Database: {db}{Environment.NewLine}" +
                $"Windows:  {windows}{Environment.NewLine}" +
                $"SQL#:     {number}  State={state}  Class={cls}{Environment.NewLine}" +
                $"Message:  {ex?.GetBaseException().Message ?? "(none)"}{Environment.NewLine}" +
                (string.IsNullOrWhiteSpace(extra) ? "" : $"Detail:   {extra}{Environment.NewLine}") +
                Environment.NewLine;
            File.AppendAllText(path, block);
        }
        catch
        {
            /* never throw from logging */
        }
    }
}
