# Create empty RMASystem database (tables are applied by the app via EF migrations).
# Also grants Windows login access for the current user and NT AUTHORITY\SYSTEM (service).
# Called from Inno Setup when the user accepts the "Create database" task.
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallRoot,
    [string]$SqlServer = "",
    [string]$DatabaseName = "RMASystem",
    [string]$WindowsUser = ""
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
    Write-Host "  Granted db_owner to $login"
}

$iniPath = Join-Path $InstallRoot "config.ini"
if ([string]::IsNullOrWhiteSpace($SqlServer)) {
    $SqlServer = Get-IniValue $iniPath "Database" "Server"
}
if ([string]::IsNullOrWhiteSpace($SqlServer)) { $SqlServer = ".\SQLEXPRESS01" }
$fromIniDb = Get-IniValue $iniPath "Database" "Database"
if (-not [string]::IsNullOrWhiteSpace($fromIniDb)) { $DatabaseName = $fromIniDb }

if ($DatabaseName -notmatch '^[A-Za-z0-9_]+$') {
    throw "Invalid database name: $DatabaseName"
}

if ([string]::IsNullOrWhiteSpace($WindowsUser)) {
    $WindowsUser = "$env:USERDOMAIN\$env:USERNAME"
}

Write-Host "Creating database if missing..."
Write-Host "  Server=$SqlServer"
Write-Host "  Database=$DatabaseName"

$cs = "Server=$SqlServer;Database=master;Integrated Security=True;TrustServerCertificate=True;Encrypt=False;Connect Timeout=15"
$conn = New-Object System.Data.SqlClient.SqlConnection $cs
try {
    $conn.Open()
    $cmd = $conn.CreateCommand()
    $cmd.CommandText = @"
IF DB_ID(N'$DatabaseName') IS NULL
BEGIN
    CREATE DATABASE [$DatabaseName];
END
"@
    $cmd.ExecuteNonQuery() | Out-Null
    Write-Host "Database ensured."

    Write-Host "Granting Windows SQL access..."
    foreach ($login in @($WindowsUser, "NT AUTHORITY\SYSTEM")) {
        try {
            Grant-WindowsDbAccess $conn $DatabaseName $login
        } catch {
            Write-Warning "Could not grant access to ${login}: $($_.Exception.Message)"
        }
    }
} catch {
    Write-Warning "Could not create database: $($_.Exception.Message)"
    Write-Warning "The app will ask for permission at http://localhost:5000/setup on first open."
    Write-Warning "Or run Tools\ensure-sql-access.ps1 as Administrator."
    exit 0
} finally {
    if ($conn.State -eq 'Open') { $conn.Close() }
}

# Consent flag — app may migrate tables on first service start without another prompt
$consent = Join-Path $InstallRoot ".db_create_consented"
@"
consented=$((Get-Date).ToString('o'))
source=installer-create-database.ps1
server=$SqlServer
database=$DatabaseName
windowsUser=$WindowsUser
"@ | Set-Content -Path $consent -Encoding UTF8
Write-Host "Wrote consent flag: $consent"
exit 0
