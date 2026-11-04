# RMA System launcher - ensures SQL, service, DB tables, then opens browser.
# SQL Server name is read from config.ini (not hard-coded).
param(
    [string]$InstallRoot = ""
)

$ErrorActionPreference = "Continue"
$Url = "http://localhost:5000"
$ServiceName = "RMASystem"

function Get-InstallRoot {
    if ($InstallRoot -and (Test-Path $InstallRoot)) { return (Resolve-Path $InstallRoot).Path }
    if ($PSScriptRoot) {
        $parent = Split-Path -Parent $PSScriptRoot
        if (Test-Path (Join-Path $parent "App\RMASystem.exe")) { return $parent }
    }
    $pf = Join-Path ${env:ProgramFiles} "RMA System"
    if (Test-Path (Join-Path $pf "App\RMASystem.exe")) { return $pf }
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

function Get-SqlInstanceName([string]$server) {
    # .\SQLEXPRESS01  or  HOST\SQLEXPRESS01  ->  SQLEXPRESS01
    if ($server -match '\\([^\\]+)$') { return $Matches[1] }
    return "SQLEXPRESS01"
}

function Write-Step($msg) {
    Write-Host ""
    Write-Host ">>> $msg" -ForegroundColor Cyan
}

function Test-SqlConnection([string]$server) {
    try {
        Add-Type -AssemblyName System.Data -ErrorAction SilentlyContinue
        $cs = "Server=$server;Database=master;Integrated Security=True;TrustServerCertificate=True;Encrypt=False;Connect Timeout=3"
        $conn = New-Object System.Data.SqlClient.SqlConnection $cs
        $conn.Open()
        $conn.Close()
        return $true
    } catch { return $false }
}

function Test-Http {
    try {
        $r = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 3
        return ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500)
    } catch { return $false }
}

$root = Get-InstallRoot
if (-not $root) {
    Write-Host "ERROR: Could not find RMA System install folder." -ForegroundColor Red
    Write-Host "Expected: C:\Program Files\RMA System\App\RMASystem.exe"
    pause
    exit 1
}

$tools = Join-Path $root "Tools"
$logs = Join-Path $root "Logs"
$iniPath = Join-Path $root "config.ini"
New-Item -ItemType Directory -Force -Path $logs | Out-Null

if (-not (Test-Path $iniPath)) {
    Write-Host "config.ini missing - creating default..."
    $cfg = Join-Path $tools "configure-app.ps1"
    if (Test-Path $cfg) {
        & powershell -NoProfile -ExecutionPolicy Bypass -File $cfg -InstallRoot $root
    }
}

$sqlServer = Get-IniValue $iniPath "Database" "Server"
if ([string]::IsNullOrWhiteSpace($sqlServer)) { $sqlServer = ".\SQLEXPRESS01" }
$instance = Get-SqlInstanceName $sqlServer
$sqlServiceName = "MSSQL`$$instance"

Write-Host "========================================" -ForegroundColor Green
Write-Host "  RMA System - starting..." -ForegroundColor Green
Write-Host "  Install: $root" -ForegroundColor Green
Write-Host "  Config:  $iniPath" -ForegroundColor Green
Write-Host "  SQL:     $sqlServer" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green

# 1) SQL Express
Write-Step "Checking SQL Server ($sqlServer)..."
$sqlSvc = Get-Service -Name $sqlServiceName -ErrorAction SilentlyContinue
if ($sqlSvc -and $sqlSvc.Status -ne "Running") {
    Write-Host "Starting $sqlServiceName..."
    try { Start-Service $sqlServiceName -ErrorAction Stop } catch { Write-Warning $_.Exception.Message }
}

$waitSql = Join-Path $tools "wait-sql.ps1"
if (Test-Path $waitSql) {
    & powershell -NoProfile -ExecutionPolicy Bypass -File $waitSql -InstallRoot $root
}

if (-not (Test-SqlConnection $sqlServer)) {
    Write-Host ""
    Write-Host "ERROR: Cannot connect to $sqlServer" -ForegroundColor Red
    Write-Host "Edit this file and set the correct instance:" -ForegroundColor Yellow
    Write-Host "  $iniPath"
    Write-Host "  [Database]"
    Write-Host "  Server=.\YOUR_INSTANCE_NAME"
    Write-Host "Then restart and run this shortcut again."
    Write-Host "Logs: $logs"
    pause
    exit 1
}
Write-Host "SQL Server is ready." -ForegroundColor Green

# 2) Windows service
Write-Step "Starting RMA System Windows service..."
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $svc) {
    Write-Host "Service not registered - starting app directly..."
    $exe = Join-Path $root "App\RMASystem.exe"
    $env:RMA_DATA_DIR = $root
    Start-Process -FilePath $exe -WorkingDirectory (Join-Path $root "App") -WindowStyle Hidden
} else {
    if ($svc.Status -ne "Running") {
        try {
            Start-Service $ServiceName -ErrorAction Stop
        } catch {
            Write-Warning "Start-Service failed: $($_.Exception.Message)"
            Write-Host "Trying NSSM restart..."
            $nssm = Join-Path $tools "nssm.exe"
            if (Test-Path $nssm) {
                & $nssm restart $ServiceName
            }
        }
    } else {
        Write-Host "Service already running."
    }
}

# 3) Wait for HTTP (migrations run on app start - may take a bit)
Write-Step "Waiting for application (creating database / tables if needed)..."
$ok = $false
for ($i = 1; $i -le 60; $i++) {
    if (Test-Http) { $ok = $true; break }
    Write-Host "  attempt $i/60..."
    if ($i -eq 15 -or $i -eq 30) {
        $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if ($svc -and $svc.Status -ne "Running") {
            Write-Host "  Service stopped - restarting..."
            try { Start-Service $ServiceName } catch {}
        }
    }
    Start-Sleep -Seconds 2
}

if (-not $ok) {
    Write-Host ""
    Write-Host "ERROR: App did not respond on $Url" -ForegroundColor Red
    Write-Host "Check:"
    Write-Host "  1. Services.msc -> RMASystem (should be Running)"
    Write-Host "  2. config.ini Server= must match your SQL instance"
    Write-Host "     $iniPath"
    Write-Host "  3. $logs\rma-*.log"
    Write-Host "  4. $logs\service-stderr.log"
    $stderr = Join-Path $logs "service-stderr.log"
    if (Test-Path $stderr) {
        Write-Host ""
        Write-Host "--- Last stderr lines ---" -ForegroundColor Yellow
        Get-Content $stderr -Tail 30 -ErrorAction SilentlyContinue
    }
    pause
    exit 1
}

Write-Host "Application is ready." -ForegroundColor Green
Write-Step "Opening browser..."
Start-Process $Url
Write-Host ""
Write-Host "Done. You can close this window." -ForegroundColor Green
Start-Sleep -Seconds 3
