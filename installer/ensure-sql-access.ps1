# Create RMASystem (if missing) and grant Windows SQL access for the current user
# plus NT AUTHORITY\SYSTEM (RMA Windows service via NSSM).
#
# Run as Administrator on the PC (e.g. JAGDISHDELL) when logs show:
#   Cannot open database "RMASystem" ... Login failed for user "MACHINE\user"
# or "RMASystem missing or inaccessible".
#
# Usage:
#   cd "C:\Program Files\RMA System\Tools"
#   .\ensure-sql-access.ps1
#   .\ensure-sql-access.ps1 -SqlServer "localhost\SQLEXPRESS" -WindowsUser "JAGDISHDELL\jagdi"
#
# Then restart the RMASystem service and open http://localhost:5000/setup → Refresh.

param(
    [string]$InstallRoot = "",
    [string]$SqlServer = "",
    [string]$DatabaseName = "RMASystem",
    [string]$WindowsUser = "",
    [switch]$SkipConsentFlag
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
    Write-Host "  OK: db_owner for $login"
}

# Resolve install root (Program Files or script location)
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

Write-Host "RMA SQL access ensure"
Write-Host "  InstallRoot = $InstallRoot"
Write-Host "  Config      = $iniPath"
Write-Host "  Server      = $SqlServer$(if ($fromIniServer) { ' (from config.ini)' } else { '' })"
Write-Host "  Database    = $DatabaseName"
Write-Host "  WindowsUser = $WindowsUser"
Write-Host "  Also grant  = NT AUTHORITY\SYSTEM (Windows service)"

$cs = "Server=$SqlServer;Database=master;Integrated Security=True;TrustServerCertificate=True;Encrypt=False;Connect Timeout=15"
$conn = New-Object System.Data.SqlClient.SqlConnection $cs
try {
    $conn.Open()
    Write-Host "Connected to master."

    $cmd = $conn.CreateCommand()
    $cmd.CommandText = @"
IF DB_ID(N'$DatabaseName') IS NULL
BEGIN
    CREATE DATABASE [$DatabaseName];
END
"@
    $cmd.ExecuteNonQuery() | Out-Null
    Write-Host "Database ensured (created if missing)."

    foreach ($login in @($WindowsUser, "NT AUTHORITY\SYSTEM") | Select-Object -Unique) {
        Grant-WindowsDbAccess $conn $DatabaseName $login
    }
} catch {
    $instHint = if ($SqlServer -match '\\([^\\]+)$') { $Matches[1] } else { "SQLEXPRESS" }
    Write-Error @"
Failed: $($_.Exception.Message)

Fix:
  1. Run this script in elevated PowerShell (Run as Administrator).
  2. Confirm SQL Express is running (Services: MSSQL`$$instHint) for Server=$SqlServer.
  3. Confirm Windows Authentication is enabled on the instance.
  4. If you are not a SQL sysadmin, ask an admin to run this script.
  5. Edit Server= in $iniPath if the instance name is wrong.
"@
    exit 1
} finally {
    if ($conn.State -eq 'Open') { $conn.Close() }
}

if (-not $SkipConsentFlag) {
    $consent = Join-Path $InstallRoot ".db_create_consented"
    @"
consented=$((Get-Date).ToString('o'))
source=ensure-sql-access.ps1
server=$SqlServer
database=$DatabaseName
windowsUser=$WindowsUser
"@ | Set-Content -Path $consent -Encoding UTF8
    Write-Host "Wrote consent flag: $consent"
}

Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Restart-Service RMASystem   (or Services.msc → RMASystem → Restart)"
Write-Host "  2. Open http://localhost:5000/setup  → Refresh"
Write-Host "  3. If tables are still missing, check Create database & tables (consent)"
Write-Host "Done."
exit 0
