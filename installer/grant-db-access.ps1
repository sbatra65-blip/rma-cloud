# Grant Windows SQL access to an EXISTING RMASystem database.
# Use this after restore/copy from another PC when data is present but a new
# Windows user (e.g. JAGDISHDELL\jagdi) gets:
#   Cannot open database "RMASystem" ... Login failed for user "..."
#
# Connects to master with Integrated Security. Requires a Windows identity that
# already has SQL rights (typically Run as Administrator — BUILTIN\Administrators
# is sysadmin on default SQL Express installs).
#
# Safe to re-run (idempotent CREATE LOGIN / USER / db_owner).
#
# Usage (elevated PowerShell):
#   cd "C:\Program Files\RMA System\Tools"
#   .\grant-db-access.ps1
#   .\grant-db-access.ps1 -SqlServer "localhost\SQLEXPRESS" -WindowsUser "JAGDISHDELL\jagdi"
#
# Then: Restart-Service RMASystem → http://localhost:5000/setup → Refresh

param(
    [string]$InstallRoot = "",
    [string]$SqlServer = "",
    [string]$DatabaseName = "RMASystem",
    [string]$WindowsUser = "",
    [switch]$SkipSystemAccount
)

$ErrorActionPreference = "Stop"

function Get-IniValue([string]$path, [string]$section, [string]$key) {
    if (-not (Test-Path $path)) { return $null }
    $current = ""
    foreach ($line in Get-Content $path) {
        $t = $line.Trim()
        if ($t -match '^\[(.+)\]$') { $current = $Matches[1]; continue }
        if ($t -match '^;' -or $t -match '^#' -or $t -eq "") { continue }
        if ($current -eq $section -and $t -match '^([^=]+)=(.*)$') {
            if ($Matches[1].Trim() -eq $key) { return $Matches[2].Trim() }
        }
    }
    return $null
}

function Grant-WindowsDbAccess([System.Data.SqlClient.SqlConnection]$conn, [string]$db, [string]$login) {
    if ([string]::IsNullOrWhiteSpace($login)) { return }
    $loginSql = $login.Replace("'", "''")
    $loginBr = $login.Replace("]", "]]")
    $dbBr = $db.Replace("]", "]]")
    $cmd = $conn.CreateCommand()
    $cmd.CommandText = @"
IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'$loginSql')
BEGIN
    CREATE LOGIN [$loginBr] FROM WINDOWS;
END
ELSE
BEGIN
    -- Re-enable if someone disabled the login after restore
    IF EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'$loginSql' AND is_disabled = 1)
        ALTER LOGIN [$loginBr] ENABLE;
END
DECLARE @sql nvarchar(max) = N'
USE [$dbBr];
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N''$loginSql'')
BEGIN
    CREATE USER [$loginBr] FOR LOGIN [$loginBr];
END
IF NOT EXISTS (
    SELECT 1
    FROM sys.database_role_members rm
    INNER JOIN sys.database_principals r ON rm.role_principal_id = r.principal_id
    INNER JOIN sys.database_principals m ON rm.member_principal_id = m.principal_id
    WHERE r.name = N''db_owner'' AND m.name = N''$loginSql''
)
BEGIN
    ALTER ROLE [db_owner] ADD MEMBER [$loginBr];
END
';
EXEC sys.sp_executesql @sql;
"@
    $cmd.ExecuteNonQuery() | Out-Null
    Write-Host "  OK: login + db_owner for $login"
}

if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    $here = Split-Path -Parent $MyInvocation.MyCommand.Path
    $candidate = Split-Path -Parent $here
    if (Test-Path (Join-Path $candidate "config.ini")) {
        $InstallRoot = $candidate
    } elseif (Test-Path "C:\Program Files\RMA System\config.ini") {
        $InstallRoot = "C:\Program Files\RMA System"
    } else {
        $InstallRoot = $candidate
    }
}

$iniPath = Join-Path $InstallRoot "config.ini"
$fromIniServer = Get-IniValue $iniPath "Database" "Server"
if ([string]::IsNullOrWhiteSpace($SqlServer)) {
    $SqlServer = $fromIniServer
}
if ([string]::IsNullOrWhiteSpace($SqlServer)) {
    $SqlServer = ".\SQLEXPRESS01"
    Write-Warning "config.ini has no Server= — defaulting to $SqlServer."
}
$fromIniDb = Get-IniValue $iniPath "Database" "Database"
if (-not [string]::IsNullOrWhiteSpace($fromIniDb)) { $DatabaseName = $fromIniDb }

if ($DatabaseName -notmatch '^[A-Za-z0-9_]+$') {
    throw "Invalid database name: $DatabaseName"
}

if ([string]::IsNullOrWhiteSpace($WindowsUser)) {
    $WindowsUser = "$env:USERDOMAIN\$env:USERNAME"
}

Write-Host "RMA grant-db-access (existing database)"
Write-Host "  InstallRoot = $InstallRoot"
Write-Host "  Config      = $iniPath"
Write-Host "  Server      = $SqlServer$(if ($fromIniServer) { ' (from config.ini)' } else { '' })"
Write-Host "  Database    = $DatabaseName"
Write-Host "  WindowsUser = $WindowsUser"
if (-not $SkipSystemAccount) {
    Write-Host "  Also grant  = NT AUTHORITY\SYSTEM (Windows service)"
}

$cs = "Server=$SqlServer;Database=master;Integrated Security=True;TrustServerCertificate=True;Encrypt=False;Connect Timeout=15"
$conn = New-Object System.Data.SqlClient.SqlConnection $cs
try {
    $conn.Open()
    Write-Host "Connected to master as Windows identity."

    $check = $conn.CreateCommand()
    $check.CommandText = "SELECT CASE WHEN DB_ID(@n) IS NULL THEN 0 ELSE 1 END, CONVERT(nvarchar(60), DATABASEPROPERTYEX(@n, 'Status'))"
    $null = $check.Parameters.AddWithValue("@n", $DatabaseName)
    $r = $check.ExecuteReader()
    $exists = $false
    $status = $null
    if ($r.Read()) {
        $exists = ([int]$r.GetValue(0) -eq 1)
        if (-not $r.IsDBNull(1)) { $status = [string]$r.GetValue(1) }
    }
    $r.Close()

    if (-not $exists) {
        throw "Database '$DatabaseName' does not exist on $SqlServer. Use ensure-sql-access.ps1 or /setup to create it — this script only grants access to an existing DB (data is not invented)."
    }
    if ($status -and $status -ne "ONLINE") {
        throw "Database '$DatabaseName' exists but status is '$status' (not ONLINE). Wait for recovery/restore, then re-run this script."
    }
    Write-Host "Database present and ONLINE — granting access (no data changes)."

    $logins = @($WindowsUser)
    if (-not $SkipSystemAccount) { $logins += "NT AUTHORITY\SYSTEM" }
    foreach ($login in ($logins | Select-Object -Unique)) {
        Grant-WindowsDbAccess $conn $DatabaseName $login
    }
} catch {
    $instHint = if ($SqlServer -match '\\([^\\]+)$') { $Matches[1] } else { "SQLEXPRESS" }
    Write-Error @"
Failed: $($_.Exception.Message)

Fix:
  1. Run elevated PowerShell (Run as Administrator).
  2. Confirm SQL Express is running (Services: MSSQL`$$instHint) for Server=$SqlServer.
  3. The account running this script must already be a SQL sysadmin (typical for local Admin on Express).
  4. Optional: -WindowsUser 'JAGDISHDELL\jagdi' if granting for another account.
  5. Edit Server= in $iniPath if the instance name is wrong (e.g. .\SQLEXPRESS01).
"@
    exit 1
} finally {
    if ($conn.State -eq 'Open') { $conn.Close() }
}

Write-Host ""
Write-Host "Verify (optional):"
Write-Host "  sqlcmd -S `"$SqlServer`" -E -Q `"SELECT SUSER_SNAME(); USE [$DatabaseName]; SELECT DB_NAME();\""
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Restart-Service RMASystem"
Write-Host "  2. Open http://localhost:5000/setup → Refresh"
Write-Host "  3. Sign in when tables are ready (data is unchanged by this grant)"
Write-Host "Done."
exit 0
