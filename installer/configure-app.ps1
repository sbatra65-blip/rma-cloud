# Write / update config.ini at the install root (SQL Server name lives here - not hard-coded).
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallRoot,
    [string]$SqlServer = ""
)

$ErrorActionPreference = "Stop"
$iniPath = Join-Path $InstallRoot "config.ini"

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

# Keep existing Server= if present; otherwise use parameter, then first reachable Express instance
$existingServer = Get-IniValue $iniPath "Database" "Server"
if ([string]::IsNullOrWhiteSpace($SqlServer)) {
    if (-not [string]::IsNullOrWhiteSpace($existingServer)) {
        $SqlServer = $existingServer
        Write-Host "Preserving existing Server=$SqlServer from $iniPath"
    } else {
        $SqlServer = ".\SQLEXPRESS01"
        foreach ($cand in @("localhost\SQLEXPRESS01", ".\SQLEXPRESS01", "localhost\SQLEXPRESS", ".\SQLEXPRESS")) {
            try {
                $cs = "Server=$cand;Database=master;Integrated Security=True;TrustServerCertificate=True;Encrypt=False;Connect Timeout=2"
                $conn = New-Object System.Data.SqlClient.SqlConnection $cs
                $conn.Open(); $conn.Close()
                $SqlServer = $cand
                Write-Host "Discovered reachable SQL: $SqlServer"
                break
            } catch { }
        }
    }
} else {
    Write-Host "Using Server=$SqlServer from installer parameter"
}

$existingDb = Get-IniValue $iniPath "Database" "Database"
if ([string]::IsNullOrWhiteSpace($existingDb)) { $existingDb = "RMASystem" }

$content = @"
; =============================================================================
; RMA System - configuration
; =============================================================================
; Edit Server= below to match your SQL instance, then restart the RMASystem service.
; SQL instance: SQLEXPRESS01
; =============================================================================

[Database]
Server=$SqlServer
Database=$existingDb
AutoMigrate=false

[Paths]
DataRoot=$InstallRoot
"@

Set-Content -Path $iniPath -Value $content -Encoding UTF8
Write-Host "Wrote $iniPath"
Write-Host "  Server=$SqlServer"
Write-Host "  Database=$existingDb"
Write-Host "  DataRoot=$InstallRoot"

# Optional: keep DataRoot in appsettings for older builds
$settingsPath = Join-Path $InstallRoot "App\appsettings.json"
if (Test-Path $settingsPath) {
    try {
        $json = Get-Content $settingsPath -Raw | ConvertFrom-Json
        $json | Add-Member -NotePropertyName DataRoot -NotePropertyValue $InstallRoot -Force
        $json | ConvertTo-Json -Depth 8 | Set-Content -Path $settingsPath -Encoding UTF8
    } catch {
        Write-Warning "Could not update appsettings.json: $($_.Exception.Message)"
    }
}

# Unblock native/runtime DLLs (Windows Mark-of-the-Web can break clrjit.dll load)
$appDir = Join-Path $InstallRoot "App"
if (Test-Path $appDir) {
    Get-ChildItem $appDir -Recurse -File -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue
    $jit = Join-Path $appDir "clrjit.dll"
    if (-not (Test-Path $jit)) {
        Write-Warning "clrjit.dll missing under App - publish/install is incomplete."
    } else {
        Write-Host "clrjit.dll present ($((Get-Item $jit).Length) bytes)"
    }
}

# Allow LAN access to the app on TCP 5000
try {
    netsh advfirewall firewall delete rule name="RMA System HTTP 5000" | Out-Null
    netsh advfirewall firewall add rule name="RMA System HTTP 5000" dir=in action=allow protocol=TCP localport=5000 profile=any | Out-Null
    Write-Host "Firewall: allowed inbound TCP 5000 (RMA System HTTP 5000)"
} catch {
    Write-Warning "Could not add firewall rule for port 5000: $($_.Exception.Message)"
}

exit 0
