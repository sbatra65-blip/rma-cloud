using Microsoft.Data.SqlClient;
using System.IO.Compression;

namespace RMASystem.Services;

public record BackupResult(
    bool Ok,
    string Message,
    string? BakPath,
    string? ZipPath,
    DateTime CreatedAt);

/// <summary>SQL database backup + optional file-data zip into AppPaths Backups folder.</summary>
public class DatabaseBackupService(ILogger<DatabaseBackupService> log)
{
    public string BackupFolder => Path.Combine(AppPaths.DataRoot, "Backups");

    public async Task<BackupResult> CreateBackupAsync(
        bool includeDataFiles = true, CancellationToken ct = default)
    {
        Directory.CreateDirectory(BackupFolder);
        var stamp = DateTime.Now.ToString("yyyyMMdd_HHmmss");
        var bakName = $"RMASystem_{stamp}.bak";
        var bakPath = Path.Combine(BackupFolder, bakName);
        string? zipPath = null;

        try
        {
            await BackupDatabaseAsync(bakPath, ct);
        }
        catch (Exception ex)
        {
            log.LogError(ex, "SQL BACKUP failed");
            // Continue to file zip if requested — partial backup still useful
            if (!includeDataFiles)
            {
                return new BackupResult(false,
                    "SQL backup failed: " + ex.Message +
                    " Ensure the SQL Server service account can write to: " + BackupFolder,
                    null, null, DateTime.Now);
            }

            try
            {
                zipPath = await ZipDataFilesAsync(stamp, ct);
            }
            catch (Exception zex)
            {
                return new BackupResult(false,
                    "SQL backup failed (" + ex.Message + "). File zip also failed: " + zex.Message,
                    null, null, DateTime.Now);
            }

            return new BackupResult(false,
                "SQL backup failed: " + ex.Message +
                ". File data was still zipped to " + zipPath +
                ". Grant the SQL Server service write access to the Backups folder, or copy the .bak path under SQL's Backup directory.",
                null, zipPath, DateTime.Now);
        }

        if (includeDataFiles)
        {
            try
            {
                zipPath = await ZipDataFilesAsync(stamp, ct);
            }
            catch (Exception zex)
            {
                log.LogWarning(zex, "Data-file zip failed after successful SQL backup");
                return new BackupResult(true,
                    "SQL backup OK: " + bakPath + ". File zip failed: " + zex.Message,
                    bakPath, null, DateTime.Now);
            }
        }

        var msg = "Backup complete.\nSQL: " + bakPath;
        if (!string.IsNullOrEmpty(zipPath))
            msg += "\nFiles: " + zipPath;
        return new BackupResult(true, msg, bakPath, zipPath, DateTime.Now);
    }

    async Task BackupDatabaseAsync(string bakPath, CancellationToken ct)
    {
        var path = IniConfig.ResolveConfigPath();
        var server = IniConfig.GetSqlServer(path);
        var dbName = IniConfig.GetDatabaseName(path);
        if (!System.Text.RegularExpressions.Regex.IsMatch(dbName, @"^[A-Za-z0-9_]+$"))
            throw new InvalidOperationException("Invalid database name.");

        // SQL Server writes the file — use absolute path with forward-safe escaping
        var sqlPath = bakPath.Replace("'", "''");
        var masterCs = IniConfig.BuildMasterConnectionString(path, server, 30);
        await using var cnn = new SqlConnection(masterCs);
        await cnn.OpenAsync(ct);
        await using var cmd = cnn.CreateCommand();
        cmd.CommandTimeout = 600;
        cmd.CommandText = $"""
            BACKUP DATABASE [{dbName}]
            TO DISK = N'{sqlPath}'
            WITH COPY_ONLY, INIT, NAME = N'RMA System backup', STATS = 10;
            """;
        await cmd.ExecuteNonQueryAsync(ct);
        log.LogInformation("SQL backup written to {Path}", bakPath);
    }

    async Task<string> ZipDataFilesAsync(string stamp, CancellationToken ct)
    {
        var zipPath = Path.Combine(BackupFolder, $"RMASystem_Files_{stamp}.zip");
        if (File.Exists(zipPath)) File.Delete(zipPath);

        await Task.Run(() =>
        {
            using var zip = ZipFile.Open(zipPath, ZipArchiveMode.Create);
            foreach (var folder in new[] { "Photos", "CarePack", "Excel", "Challans", "Batches", "Drafts", "Reports" })
            {
                var dir = Path.Combine(AppPaths.DataRoot, folder);
                if (!Directory.Exists(dir)) continue;
                foreach (var file in Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories))
                {
                    ct.ThrowIfCancellationRequested();
                    var entryName = Path.GetRelativePath(AppPaths.DataRoot, file);
                    zip.CreateEntryFromFile(file, entryName, CompressionLevel.Optimal);
                }
            }

            var ini = IniConfig.ResolveConfigPath();
            if (File.Exists(ini))
                zip.CreateEntryFromFile(ini, "config.ini", CompressionLevel.Optimal);
        }, ct);

        return zipPath;
    }

    public IReadOnlyList<(string Name, long Bytes, DateTime Written)> ListBackups(int take = 30)
    {
        if (!Directory.Exists(BackupFolder)) return [];
        return Directory.EnumerateFiles(BackupFolder)
            .Select(f => new FileInfo(f))
            .OrderByDescending(f => f.LastWriteTime)
            .Take(take)
            .Select(f => (f.Name, f.Length, f.LastWriteTime))
            .ToList();
    }
}
