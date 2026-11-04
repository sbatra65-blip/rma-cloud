# Building & deploying the RMA System installer

**Target:** new Windows 11 PC (admin rights)  
**Includes:** application + Windows service + optional SQL Server Express (`SQLEXPRESS`)

---

## One-time setup on the build PC

1. Install [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0)
2. Install [Inno Setup 6](https://jrsoftware.org/isinfo.php)
3. (Recommended for offline installs) Download **SQL Server 2022 Express**  
   - https://www.microsoft.com/en-us/sql-server/sql-server-downloads  
   - Save as `installer\redist\SQLEXPR_x64_ENU.exe`

---

## Build the installer

From the `RMASystem` folder in PowerShell:

```powershell
.\build-installer.ps1
```

This will:

1. `dotnet publish` self-contained `win-x64` → `publish\`
2. Download **NSSM** into `tools\` if missing
3. Compile `setup.iss` → `Output\RMA_System_v1.1.0_Setup.exe`

---

## Install on a new Windows 11 machine

1. Copy `Output\RMA_System_v1.1.0_Setup.exe` to the PC  
2. **Right-click → Run as administrator**  
3. Choose install folder (default: `C:\Program Files\RMA System`)  
4. Leave **Install SQL Server Express** checked if SQL is not already present  
5. Finish — browser opens at http://localhost:5000  

The database `RMASystem` is created automatically on first service start (EF migrations).

### After install

| Item | Location |
|------|----------|
| App binaries | `{install}\App\` |
| Photos / Excel / Logs | `{install}\Photos`, `Excel`, `Logs`, … |
| Windows service | `RMASystem` (auto-start) |
| UI | http://localhost:5000 |
| LAN | http://&lt;PC-IP&gt;:5000 |

---

## SQL Express notes

- **Bundled media** (`installer\redist\SQLEXPR_x64_ENU.exe`): silent install of instance `SQLEXPRESS`
- **No media**: tries **winget** (`Microsoft.SQLServer.2022.Express`)
- If both fail: install Express manually with instance name **SQLEXPRESS**, then restart the **RMASystem** service

Silent SQL install can take **5–15 minutes**. A reboot may be required on some PCs (exit code 3010).

---

## Uninstall

Use Windows **Apps → RMA System → Uninstall**, or the Start Menu uninstall shortcut.  
This removes the Windows service and app files. SQL Express is left installed (shared database engine).

---

## Troubleshooting

| Symptom | Check |
|---------|--------|
| Browser blank / connection refused | Services.msc → **RMASystem** → Start; see `{install}\Logs\` |
| Migration / DB errors | Confirm `MSSQL$SQLEXPRESS` service is running |
| Port blocked | Firewall rule “RMA System Port 5000” |
| Wrong data folder | Env `RMA_DATA_DIR` or `appsettings.json` → `DataRoot` |
