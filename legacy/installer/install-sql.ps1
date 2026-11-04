# Install SQL Server Express (SQLEXPRESS) for RMA System
# Prefer local media; then download; then winget.
param(
    [string]$RedistPath = "",
    [switch]$DownloadIfMissing
)

$ErrorActionPreference = "Continue"

function Test-SqlExpress {
    $svc = Get-Service -Name "MSSQL`$SQLEXPRESS" -ErrorAction SilentlyContinue
    if ($svc) { return $true }
    $any = Get-Service | Where-Object {
        $_.Name -eq "MSSQL`$SQLEXPRESS" -or $_.DisplayName -like "*SQL Server*(SQLEXPRESS)*"
    }
    return [bool]$any
}

function Start-SqlExpress {
    $svc = Get-Service -Name "MSSQL`$SQLEXPRESS" -ErrorAction SilentlyContinue
    if ($svc -and $svc.Status -ne "Running") {
        try { Start-Service "MSSQL`$SQLEXPRESS" -ErrorAction Stop; return $true } catch { return $false }
    }
    return [bool]$svc
}

if (Test-SqlExpress) {
    Write-Host "SQL Server Express (SQLEXPRESS) already installed."
    Start-SqlExpress | Out-Null
    exit 0
}

Write-Host "SQL Server Express not found. Installing (this can take 5-15 minutes)..."

function Invoke-SilentSqlInstall([string]$exePath) {
    if (-not (Test-Path $exePath)) { return $false }
    Write-Host "Running silent install: $exePath"
    # Extract+install pattern: Express ENU is often a self-extractor
    $args = @(
        "/Q",
        "/ACTION=Install",
        "/FEATURES=SQLENGINE",
        "/INSTANCENAME=SQLEXPRESS",
        "/SQLSVCACCOUNT=`"NT AUTHORITY\NETWORK SERVICE`"",
        "/SQLSYSADMINACCOUNTS=`"BUILTIN\Administrators`"",
        "/AGTSVCACCOUNT=`"NT AUTHORITY\NETWORK SERVICE`"",
        "/IACCEPTSQLSERVERLICENSETERMS",
        "/UpdateEnabled=False",
        "/TCPENABLED=1",
        "/NPENABLED=1",
        "/INDICATEPROGRESS"
    )
    $p = Start-Process -FilePath $exePath -ArgumentList $args -Wait -PassThru -NoNewWindow
    Write-Host "SQL Express installer exit code: $($p.ExitCode)"
    # 0 success, 3010 success reboot required
    return ($p.ExitCode -in 0, 3010)
}

$local = $RedistPath
if (-not $local -or -not (Test-Path $local)) {
    foreach ($cand in @(
        (Join-Path $PSScriptRoot "SQLEXPR_x64_ENU.exe"),
        (Join-Path $PSScriptRoot "..\installer\redist\SQLEXPR_x64_ENU.exe"),
        (Join-Path $env:TEMP "SQLEXPR_x64_ENU.exe")
    )) {
        if (Test-Path $cand) { $local = $cand; break }
    }
}

$installed = $false
if ($local -and (Test-Path $local)) {
    $installed = Invoke-SilentSqlInstall $local
}

# Download Express media if requested / still missing
if (-not $installed -and ($DownloadIfMissing -or -not (Test-SqlExpress))) {
    $dest = Join-Path $env:TEMP "SQLEXPR_x64_ENU.exe"
    if (-not (Test-Path $dest) -or (Get-Item $dest).Length -lt 1MB) {
        Write-Host "Downloading SQL Server Express (large file - please wait)..."
        $urls = @(
            "https://go.microsoft.com/fwlink/?linkid=2215158",
            "https://go.microsoft.com/fwlink/?LinkID=866658"
        )
        foreach ($u in $urls) {
            try {
                Write-Host "Trying $u"
                Invoke-WebRequest -Uri $u -OutFile $dest -UseBasicParsing
                if ((Test-Path $dest) -and (Get-Item $dest).Length -gt 1MB) { break }
            } catch {
                Write-Warning "Download failed: $($_.Exception.Message)"
            }
        }
    }
    if ((Test-Path $dest) -and (Get-Item $dest).Length -gt 1MB) {
        $installed = Invoke-SilentSqlInstall $dest
    }
}

# Winget fallback
if (-not (Test-SqlExpress)) {
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget) {
        Write-Host "Trying winget..."
        & winget install -e --id Microsoft.SQLServer.2022.Express `
            --accept-package-agreements --accept-source-agreements --disable-interactivity 2>&1 | Out-Host
        Start-Sleep -Seconds 8
        if (-not (Test-SqlExpress)) {
            & winget search "SQL Server Express" 2>&1 | Out-Host
        }
    }
}

Start-Sleep -Seconds 3
Start-SqlExpress | Out-Null

if (Test-SqlExpress) {
    Write-Host "SQL Server Express is installed." -ForegroundColor Green
    exit 0
}

Write-Warning @"
Could not install SQL Server Express automatically.
1) Download Express: https://www.microsoft.com/en-us/sql-server/sql-server-downloads
2) Install with instance name: SQLEXPRESS
3) Run the RMA System shortcut again.
"@
exit 1
