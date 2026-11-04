#Requires -Version 5.1
<#
.SYNOPSIS
  Publishes RMA System (self-contained win-x64) and builds the Inno Setup installer.
#>
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

$Project = Join-Path $Root "RMASystem.Web\RMASystem.Web.csproj"
$PublishOut = Join-Path $Root "publish"
$Tools = Join-Path $Root "tools"

Write-Host "==> Using SDK (global.json pins .NET 8):" -ForegroundColor Cyan
dotnet --version

Write-Host "==> Publishing self-contained win-x64 (folder deploy, not single-file)..." -ForegroundColor Cyan
if (Test-Path $PublishOut) { Remove-Item $PublishOut -Recurse -Force }

# Clean previous RID builds that can leave a bad clrjit from another SDK
$bin = Join-Path $Root "RMASystem.Web\bin"
$obj = Join-Path $Root "RMASystem.Web\obj"
if (Test-Path $bin) { Remove-Item $bin -Recurse -Force -ErrorAction SilentlyContinue }
if (Test-Path $obj) { Remove-Item $obj -Recurse -Force -ErrorAction SilentlyContinue }

dotnet publish $Project -c Release -r win-x64 --self-contained true `
    -p:PublishSingleFile=false `
    -p:PublishTrimmed=false `
    -p:PublishReadyToRun=true `
    -p:IncludeNativeLibrariesForSelfExtract=false `
    --force `
    -o $PublishOut
if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed" }

# Critical native runtime files - missing/corrupt clrjit.dll crashes the app
$required = @(
    "clrjit.dll",
    "coreclr.dll",
    "hostfxr.dll",
    "hostpolicy.dll",
    "RMASystem.exe",
    "RMASystem.dll",
    "RMASystem.runtimeconfig.json"
)
Write-Host "==> Verifying native runtime files..." -ForegroundColor Cyan
foreach ($name in $required) {
    $path = Join-Path $PublishOut $name
    if (-not (Test-Path $path)) { throw "Publish incomplete: missing $name" }
    $len = (Get-Item $path).Length
    $min = if ($name -like "*.json") { 50 } else { 1024 }
    if ($len -lt $min) { throw "Publish incomplete: $name is too small ($len bytes)" }
    Write-Host ("  OK {0} ({1:N0} bytes)" -f $name, $len)
}

# Ensure files are not Zone.Identifier-blocked after copy on target PCs
Get-ChildItem $PublishOut -Recurse -File | Unblock-File -ErrorAction SilentlyContinue

# Ensure tools\nssm.exe
$Nssm = Join-Path $Tools "nssm.exe"
if (-not (Test-Path $Nssm)) {
    Write-Host "==> Downloading NSSM..." -ForegroundColor Cyan
    New-Item -ItemType Directory -Force -Path $Tools | Out-Null
    $zip = Join-Path $env:TEMP "nssm-2.24.zip"
    Invoke-WebRequest -Uri "https://nssm.cc/release/nssm-2.24.zip" -OutFile $zip
    $extract = Join-Path $env:TEMP "nssm-extract"
    if (Test-Path $extract) { Remove-Item $extract -Recurse -Force }
    Expand-Archive $zip $extract
    $src = Get-ChildItem -Path $extract -Recurse -Filter nssm.exe |
        Where-Object { $_.FullName -match "win64" } |
        Select-Object -First 1
    if (-not $src) { throw "nssm.exe (win64) not found in archive" }
    Copy-Item $src.FullName $Nssm -Force
}

if (-not (Test-Path (Join-Path $Tools "open_browser.bat"))) {
    throw "tools\open_browser.bat missing"
}

if (-not (Test-Path (Join-Path $Root "config.ini"))) {
    throw "config.ini missing at solution root"
}

# Installer no longer bundles/installs SQL Express — target PC must already have SQL + RMASystem DB.

$iscc = @(
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "${env:ProgramFiles}\Inno Setup 6\ISCC.exe",
    "iscc"
) | Where-Object {
    if ($_ -eq "iscc") { Get-Command iscc -ErrorAction SilentlyContinue } else { Test-Path $_ }
} | Select-Object -First 1

if (-not $iscc) {
    throw "Inno Setup 6 not found. Install from https://jrsoftware.org/isinfo.php"
}

Write-Host "==> Compiling setup.iss with $iscc ..." -ForegroundColor Cyan
& $iscc (Join-Path $Root "setup.iss")
if ($LASTEXITCODE -ne 0) { throw "ISCC failed" }

$out = Get-ChildItem (Join-Path $Root "Output\RMA_System_v*_Setup.exe") | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Write-Host ""
Write-Host "Installer ready:" -ForegroundColor Green
Write-Host "  $($out.FullName)"
Write-Host ""
Write-Host "Prerequisite on target PC: SQL Server/Express + RMASystem database already exist."
Write-Host "Right-click Setup -> Run as administrator. If login fails, use grant-db-access.ps1."
