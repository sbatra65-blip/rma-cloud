# Wait until SQL Server from config.ini accepts a connection (up to ~5 minutes)
param(
    [string]$InstallRoot = ""
)

$ErrorActionPreference = "Continue"
$maxAttempts = 60

function Resolve-InstallRoot {
    if ($InstallRoot -and (Test-Path $InstallRoot)) { return (Resolve-Path $InstallRoot).Path }
    if ($PSScriptRoot) {
        $parent = Split-Path -Parent $PSScriptRoot
        if (Test-Path (Join-Path $parent "config.ini")) { return $parent }
        if (Test-Path (Join-Path $parent "App\RMASystem.exe")) { return $parent }
    }
    $pf = Join-Path ${env:ProgramFiles} "RMA System"
    if (Test-Path $pf) { return $pf }
    return $null
}

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

$root = Resolve-InstallRoot
$iniPath = if ($root) { Join-Path $root "config.ini" } else { $null }
$server = if ($iniPath) { Get-IniValue $iniPath "Database" "Server" } else { $null }
if ([string]::IsNullOrWhiteSpace($server)) { $server = ".\SQLEXPRESS01" }

Add-Type -AssemblyName System.Data

function Test-Sql {
    try {
        $cs = "Server=$server;Database=master;Integrated Security=True;TrustServerCertificate=True;Encrypt=False;Connect Timeout=3"
        $conn = New-Object System.Data.SqlClient.SqlConnection $cs
        $conn.Open()
        $conn.Close()
        return $true
    } catch {
        return $false
    }
}

Write-Host "Waiting for SQL Server ($server)..."
for ($i = 1; $i -le $maxAttempts; $i++) {
    if (Test-Sql) {
        Write-Host "SQL Server is ready (attempt $i)."
        exit 0
    }
    Start-Sleep -Seconds 5
}

Write-Warning "SQL Server ($server) did not become ready in time. Check config.ini [Database] Server="
exit 0
