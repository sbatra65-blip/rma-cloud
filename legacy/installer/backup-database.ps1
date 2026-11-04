# =============================================================================
# RMA System — backup current SQL database (.bak)
# =============================================================================
# Usage (dev / installed):
#   .\backup-database.ps1
#   .\backup-database.ps1 -InstallRoot "C:\Program Files\RMA System"
#   .\backup-database.ps1 -BackupDir "D:\RMA-Backups"
#
# Reads Server + Database from config.ini (same as the app).
# Backup folder resolution (first match wins):
#   1) -BackupDir parameter
#   2) config.ini [Paths] BackupDir=
#   3) hard default: C:\sqlbackups
#
# Output: <BackupDir>\RMASystem_yyyyMMdd_HHmmss.bak
#
# Requires: Windows auth to SQL Express, and the SQL Server service account
# must be able to write to the backup folder (grant Modify on C:\sqlbackups).
# The script creates the folder if missing; SQL still needs NTFS write rights.
# =============================================================================
param(
    [string]$InstallRoot = "",
    [string]$ConfigPath = "",
    [string]$SqlServer = "",
    [string]$DatabaseName = "",
    [string]$BackupDir = "",
    [int]$KeepDays = 0
)

$DefaultBackupDir = "C:\sqlbackups"

$ErrorActionPreference = "Stop"

function Get-IniValue([string]$path, [string]$section, [string]$key) {
    if (-not (Test-Path $path)) { return $null }
    $current = ""
    foreach ($line in Get-Content -LiteralPath $path -ErrorAction SilentlyContinue) {
        $t = $line.Trim()
        if ($t -match '^\[(.+)\]$') { $current = $Matches[1]; continue }
        if ($t -match '^;' -or $t -match '^#' -or $t -eq "") { continue }
        if ($current -eq $section -and $t -match '^([^=]+)=(.*)$') {
            if ($Matches[1].Trim() -eq $key) { return $Matches[2].Trim() }
        }
    }
    return $null
}

function Resolve-ConfigPath {
    if ($ConfigPath -and (Test-Path -LiteralPath $ConfigPath)) {
        return (Resolve-Path -LiteralPath $ConfigPath).Path
    }
    $candidates = @()
    if ($InstallRoot) {
        $candidates += (Join-Path $InstallRoot "config.ini")
    }
    $scriptRoot = $PSScriptRoot
    if ($scriptRoot) {
        # Tools\ when installed → parent is install root
        $candidates += (Join-Path $scriptRoot "config.ini")
        $candidates += (Join-Path (Split-Path $scriptRoot -Parent) "config.ini")
        # Repo: installer\ → solution root config.ini
        $candidates += (Join-Path (Split-Path $scriptRoot -Parent) "config.ini")
    }
    $candidates += "C:\Program Files\RMA System\config.ini"
    $candidates += (Join-Path (Get-Location) "config.ini")
    foreach ($c in $candidates) {
        if ($c -and (Test-Path -LiteralPath $c)) { return (Resolve-Path -LiteralPath $c).Path }
    }
    return $null
}

function Invoke-SqlText {
    param(
        [string]$Server,
        [string]$Database = "master",
        [string]$Query,
        [int]$TimeoutSec = 600
    )

    $sqlcmd = Get-Command sqlcmd -ErrorAction SilentlyContinue
    if ($sqlcmd) {
        $out = & sqlcmd -S $Server -d $Database -E -b -l 30 -t $TimeoutSec -W -h -1 -Q $Query 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw ("sqlcmd failed (exit $LASTEXITCODE): " + ($out | Out-String).Trim())
        }
        return ($out | Out-String).Trim()
    }

    # Fallback: .NET SqlClient (loaded on most Windows with SQL tools / .NET)
    Add-Type -AssemblyName System.Data | Out-Null
    $cs = "Server=$Server;Database=$Database;Integrated Security=True;TrustServerCertificate=True;Encrypt=False;Connect Timeout=30"
    $conn = New-Object System.Data.SqlClient.SqlConnection $cs
    try {
        $conn.Open()
        $cmd = $conn.CreateCommand()
        $cmd.CommandTimeout = $TimeoutSec
        $cmd.CommandText = $Query
        $scalar = $cmd.ExecuteScalar()
        if ($null -ne $scalar) { return [string]$scalar }
        return ""
    }
    finally {
        if ($conn.State -eq 'Open') { $conn.Close() }
    }
}

function Get-SqlDefaultBackupDir([string]$Server) {
    try {
        $path = Invoke-SqlText -Server $Server -Query "SET NOCOUNT ON; SELECT CAST(SERVERPROPERTY('InstanceDefaultBackupPath') AS nvarchar(4000));"
        if ($path -and (Test-Path -LiteralPath $path)) { return $path.Trim() }
    } catch { }
    return $null
}

# ── Resolve config ────────────────────────────────────────────────────────────
$ini = Resolve-ConfigPath
if (-not $ini) {
    throw "config.ini not found. Pass -ConfigPath or -InstallRoot."
}

if ([string]::IsNullOrWhiteSpace($SqlServer)) {
    $SqlServer = Get-IniValue $ini "Database" "Server"
}
if ([string]::IsNullOrWhiteSpace($SqlServer)) { $SqlServer = ".\SQLEXPRESS01" }

if ([string]::IsNullOrWhiteSpace($DatabaseName)) {
    $DatabaseName = Get-IniValue $ini "Database" "Database"
}
if ([string]::IsNullOrWhiteSpace($DatabaseName)) { $DatabaseName = "RMASystem" }

if ($DatabaseName -notmatch '^[A-Za-z0-9_]+$') {
    throw "Invalid database name: $DatabaseName"
}

if ([string]::IsNullOrWhiteSpace($BackupDir)) {
    $cfgBackup = Get-IniValue $ini "Paths" "BackupDir"
    if (-not [string]::IsNullOrWhiteSpace($cfgBackup)) {
        $BackupDir = $cfgBackup.Trim()
    } else {
        $BackupDir = $DefaultBackupDir
    }
}

$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$bakName = "${DatabaseName}_${stamp}.bak"
$bakPath = Join-Path $BackupDir $bakName

Write-Host "RMA System database backup"
Write-Host "  Config   : $ini"
Write-Host "  Server   : $SqlServer"
Write-Host "  Database : $DatabaseName"
Write-Host "  BackupDir: $BackupDir"
Write-Host "  Target   : $bakPath"
Write-Host ""
Write-Host "Note: the SQL Server service account must have Modify on $BackupDir."
Write-Host ""

# Ensure DB exists / SQL reachable
# Exit codes for installer:
#   0 = backup OK
#   1 = failure (block upgrade unless user confirms skip)
#   2 = no database yet (fresh PC / nothing to back up — safe to continue)
try {
    $exists = Invoke-SqlText -Server $SqlServer -Query "SET NOCOUNT ON; SELECT CASE WHEN DB_ID(N'$DatabaseName') IS NULL THEN N'0' ELSE N'1' END;"
    if ($exists -ne "1") {
        Write-Host "SKIP: database '$DatabaseName' does not exist on $SqlServer (nothing to back up)."
        exit 2
    }
} catch {
    Write-Host "ERROR: Cannot connect to SQL ($SqlServer): $($_.Exception.Message)"
    exit 1
}

try {
    New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
    Write-Host "Ensured backup folder exists: $BackupDir"
} catch {
    Write-Host "ERROR: Cannot create backup folder '$BackupDir': $($_.Exception.Message)"
    exit 1
}

function New-BackupSql([string]$diskPath, [bool]$useCompression) {
    $p = $diskPath.Replace("'", "''")
    $with = if ($useCompression) {
        "WITH COPY_ONLY, INIT, COMPRESSION, NAME = N'RMA System backup $stamp', STATS = 10"
    } else {
        "WITH COPY_ONLY, INIT, NAME = N'RMA System backup $stamp', STATS = 10"
    }
    return @"
BACKUP DATABASE [$DatabaseName]
TO DISK = N'$p'
$with;
"@
}

function Try-BackupTo([string]$path) {
    $dir = Split-Path $path -Parent
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    foreach ($compress in @($true, $false)) {
        try {
            Invoke-SqlText -Server $SqlServer -Query (New-BackupSql $path $compress) -TimeoutSec 600 | Out-Null
            if (Test-Path -LiteralPath $path) { return $true }
        } catch {
            if (-not $compress) { throw }
            # Express editions often reject COMPRESSION — retry plain
        }
    }
    return $false
}

$ok = $false
$lastErr = $null
$primaryBackupDir = $BackupDir
try {
    $ok = Try-BackupTo $bakPath
    if (-not $ok) { throw "Backup file was not created at $bakPath." }
} catch {
    $lastErr = $_.Exception.Message
    Write-Warning "Backup to $primaryBackupDir failed (often SQL service write permission)."
    Write-Warning $lastErr
    Write-Host ""
    Write-Host "Retrying once after re-creating folder: $primaryBackupDir"
    try {
        New-Item -ItemType Directory -Force -Path $primaryBackupDir | Out-Null
        $ok = Try-BackupTo $bakPath
        if (-not $ok) { throw "Backup file was not created after retry." }
    } catch {
        $lastErr = $_.Exception.Message
        Write-Warning "Retry to $primaryBackupDir also failed."
        Write-Warning $lastErr

        $sqlBakDir = Get-SqlDefaultBackupDir -Server $SqlServer
        if (-not $sqlBakDir) {
            $guess = Get-ChildItem "C:\Program Files\Microsoft SQL Server" -Directory -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -match 'MSSQL.*SQLEXPRESS' } |
                ForEach-Object { Join-Path $_.FullName "MSSQL\Backup" } |
                Where-Object { Test-Path $_ } |
                Select-Object -First 1
            $sqlBakDir = $guess
        }

        if ($sqlBakDir) {
            $altPath = Join-Path $sqlBakDir $bakName
            Write-Host "Last-resort retry under SQL default backup folder:"
            Write-Host "  $altPath"
            try {
                if (Try-BackupTo $altPath) {
                    $bakPath = $altPath
                    $BackupDir = $sqlBakDir
                    $ok = $true
                    $preferred = Join-Path $primaryBackupDir $bakName
                    try {
                        New-Item -ItemType Directory -Force -Path $primaryBackupDir | Out-Null
                        Copy-Item -LiteralPath $bakPath -Destination $preferred -Force
                        Write-Host "Also copied to: $preferred"
                        $bakPath = $preferred
                        $BackupDir = $primaryBackupDir
                    } catch {
                        Write-Warning "Could not copy into $primaryBackupDir (keeping SQL Backup folder copy)."
                    }
                }
            } catch {
                $lastErr = $_.Exception.Message
            }
        }
    }
}

if (-not $ok) {
    Write-Host ""
    Write-Host "BACKUP FAILED." -ForegroundColor Red
    Write-Host $lastErr
    Write-Host ""
    Write-Host "Fix: grant the SQL Server service account Modify on:"
    Write-Host "  $primaryBackupDir"
    Write-Host "Typical service accounts: NT SERVICE\MSSQL`$SQLEXPRESS or NT AUTHORITY\NETWORK SERVICE"
    Write-Host "Then re-run, or override with:"
    Write-Host "  .\backup-database.ps1 -BackupDir `"$DefaultBackupDir`""
    exit 1
}

if (-not (Test-Path -LiteralPath $bakPath)) {
    throw "Backup reported success but file not found: $bakPath"
}

$info = Get-Item -LiteralPath $bakPath
Write-Host ""
Write-Host "BACKUP OK" -ForegroundColor Green
Write-Host ("  File : {0}" -f $info.FullName)
Write-Host ("  Size : {0:N1} MB" -f ($info.Length / 1MB))
Write-Host ("  Time : {0}" -f $info.LastWriteTime)

if ($KeepDays -gt 0) {
    $cutoff = (Get-Date).AddDays(-$KeepDays)
    Get-ChildItem -LiteralPath $BackupDir -Filter "${DatabaseName}_*.bak" -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -lt $cutoff } |
        ForEach-Object {
            Write-Host "Removing old backup: $($_.Name)"
            Remove-Item -LiteralPath $_.FullName -Force
        }
}

exit 0
