# Convenience wrapper — runs installer\backup-database.ps1 from the solution root.
param(
    [string]$InstallRoot = "",
    [string]$ConfigPath = "",
    [string]$SqlServer = "",
    [string]$DatabaseName = "",
    [string]$BackupDir = "",
    [int]$KeepDays = 0
)

$script = Join-Path $PSScriptRoot "installer\backup-database.ps1"
if (-not (Test-Path -LiteralPath $script)) {
    throw "Missing $script"
}

& $script `
    -InstallRoot $InstallRoot `
    -ConfigPath $ConfigPath `
    -SqlServer $SqlServer `
    -DatabaseName $DatabaseName `
    -BackupDir $BackupDir `
    -KeepDays $KeepDays
