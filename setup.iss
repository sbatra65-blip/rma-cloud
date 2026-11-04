; ── Inno Setup Script — RMA System Installer (Windows 11) ──────────────────
; Prerequisites to BUILD:
;   1. Run build-installer.ps1  (publishes app, prepares publish\ and tools\)
;   2. Inno Setup 6: https://jrsoftware.org/isinfo.php
; Compile: iscc setup.iss
;
; Target PC must already have SQL Server/Express and the RMASystem database.
; This installer only deploys/updates app files and the Windows service.
; It does NOT install SQL Express, back up the DB, or CREATE/DROP the database.
; App does not run EF migrations at startup (AutoMigrate=false). Uses existing RMASystem DB.
; If login fails after install, use Start Menu → Grant SQL database access
; (or Tools\grant-db-access.ps1).

#define AppName      "RMA System"
#define AppVersion   "1.3.62"
#define AppPublisher "Infinite Solutions"
#define AppURL       "https://infinitesolutions.co.in"
#define AppExeName   "RMASystem.exe"
#define ServiceName  "RMASystem"

[Setup]
AppId={{B7C3A1F2-4E9D-4F8B-A6C1-2D3E4F5A6B7C}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableDirPage=no
DisableProgramGroupPage=yes
OutputDir=Output
OutputBaseFilename=RMA_System_v{#AppVersion}_Setup
Compression=lzma
SolidCompression=no
LZMAUseSeparateProcess=yes
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
UninstallDisplayIcon={app}\App\{#AppExeName}
SetupLogging=yes
DiskSpanning=no
[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional shortcuts:"; Flags: unchecked
Name: "startupicon"; Description: "Open browser on Windows login"; GroupDescription: "Additional shortcuts:"

[Files]
; Application (self-contained publish)
Source: "publish\*"; DestDir: "{app}\App"; Flags: ignoreversion recursesubdirs createallsubdirs

; SQL / paths config — do not overwrite if already customized on upgrade
Source: "config.ini"; DestDir: "{app}"; Flags: ignoreversion onlyifdoesntexist

; Tools
Source: "tools\nssm.exe"; DestDir: "{app}\Tools"; Flags: ignoreversion
Source: "tools\open_browser.bat"; DestDir: "{app}\Tools"; Flags: ignoreversion
Source: "tools\start-rma.ps1"; DestDir: "{app}\Tools"; Flags: ignoreversion
Source: "installer\configure-app.ps1"; DestDir: "{app}\Tools"; Flags: ignoreversion
Source: "installer\grant-db-access.ps1"; DestDir: "{app}\Tools"; Flags: ignoreversion

[Dirs]
Name: "{app}\Photos"
Name: "{app}\Excel"
Name: "{app}\Challans"
Name: "{app}\Batches"
Name: "{app}\Imports"
Name: "{app}\Backups"
Name: "{app}\Logs"
Name: "{app}\Keys"
Name: "{app}\Reports"

[Icons]
Name: "{group}\Grant SQL database access"; Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\Tools\grant-db-access.ps1"" -InstallRoot ""{app}"""; WorkingDir: "{app}"
Name: "{group}\{#AppName}"; Filename: "{app}\Tools\open_browser.bat"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\Tools\open_browser.bat"; Tasks: desktopicon
Name: "{userstartup}\{#AppName}"; Filename: "{app}\Tools\open_browser.bat"; Tasks: startupicon

[Run]
; 1) Write/update config.ini (preserves existing Server= and Database=)
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\Tools\configure-app.ps1"" -InstallRoot ""{app}"""; \
  StatusMsg: "Configuring application (config.ini)..."; \
  Flags: runhidden waituntilterminated

; 2) Windows Service via NSSM (update/reinstall if already used)
Filename: "{app}\Tools\nssm.exe"; Parameters: "stop {#ServiceName}"; Flags: runhidden waituntilterminated; Check: ServiceExists
Filename: "{app}\Tools\nssm.exe"; Parameters: "remove {#ServiceName} confirm"; Flags: runhidden waituntilterminated; Check: ServiceExists
Filename: "{app}\Tools\nssm.exe"; Parameters: "install {#ServiceName} ""{app}\App\{#AppExeName}"""; Flags: runhidden waituntilterminated; StatusMsg: "Installing Windows Service..."
Filename: "{app}\Tools\nssm.exe"; Parameters: "set {#ServiceName} AppDirectory ""{app}\App"""; Flags: runhidden waituntilterminated
Filename: "{app}\Tools\nssm.exe"; Parameters: "set {#ServiceName} AppEnvironmentExtra ""RMA_DATA_DIR={app}"" ""RMA_CONFIG_PATH={app}\config.ini"" ""ASPNETCORE_ENVIRONMENT=Production"" ""DOTNET_MULTILEVEL_LOOKUP=0"" ""DOTNET_ROOT={app}\App"""; Flags: runhidden waituntilterminated
Filename: "{app}\Tools\nssm.exe"; Parameters: "set {#ServiceName} ObjectName LocalSystem"; Flags: runhidden waituntilterminated
Filename: "{app}\Tools\nssm.exe"; Parameters: "set {#ServiceName} AppExit Default Restart"; Flags: runhidden waituntilterminated
Filename: "{app}\Tools\nssm.exe"; Parameters: "set {#ServiceName} AppRestartDelay 5000"; Flags: runhidden waituntilterminated
Filename: "{app}\Tools\nssm.exe"; Parameters: "set {#ServiceName} DisplayName ""{#AppName} – {#AppPublisher}"""; Flags: runhidden waituntilterminated
Filename: "{app}\Tools\nssm.exe"; Parameters: "set {#ServiceName} Description ""Care Pack & RMA ticket system for Infinite Solutions"""; Flags: runhidden waituntilterminated
Filename: "{app}\Tools\nssm.exe"; Parameters: "set {#ServiceName} Start SERVICE_AUTO_START"; Flags: runhidden waituntilterminated
Filename: "{app}\Tools\nssm.exe"; Parameters: "set {#ServiceName} AppStdout ""{app}\Logs\service-stdout.log"""; Flags: runhidden waituntilterminated
Filename: "{app}\Tools\nssm.exe"; Parameters: "set {#ServiceName} AppStderr ""{app}\Logs\service-stderr.log"""; Flags: runhidden waituntilterminated
Filename: "{app}\Tools\nssm.exe"; Parameters: "set {#ServiceName} AppRotateFiles 1"; Flags: runhidden waituntilterminated
Filename: "{app}\Tools\nssm.exe"; Parameters: "start {#ServiceName}"; Flags: runhidden waituntilterminated; StatusMsg: "Starting RMA System service..."

; 3) Firewall
Filename: "netsh"; Parameters: "advfirewall firewall delete rule name=""RMA System Port 5000"""; Flags: runhidden waituntilterminated
Filename: "netsh"; Parameters: "advfirewall firewall add rule name=""RMA System Port 5000"" dir=in action=allow protocol=TCP localport=5000"; Flags: runhidden waituntilterminated; StatusMsg: "Opening firewall port 5000..."

; 4) Open UI
Filename: "{app}\Tools\open_browser.bat"; Flags: shellexec postinstall skipifsilent; Description: "Open RMA System in browser"

[UninstallRun]
Filename: "{app}\Tools\nssm.exe"; Parameters: "stop {#ServiceName}"; Flags: runhidden waituntilterminated
Filename: "{app}\Tools\nssm.exe"; Parameters: "remove {#ServiceName} confirm"; Flags: runhidden waituntilterminated
Filename: "netsh"; Parameters: "advfirewall firewall delete rule name=""RMA System Port 5000"""; Flags: runhidden

[Code]
function ServiceExists(): Boolean;
begin
  Result := RegKeyExists(HKLM, 'SYSTEM\CurrentControlSet\Services\{#ServiceName}');
end;

{ True when a previous install is present — stop service/app before file replace. }
function IsExistingInstall(): Boolean;
begin
  Result :=
    FileExists(ExpandConstant('{app}\config.ini')) or
    FileExists(ExpandConstant('{app}\App\{#AppExeName}')) or
    DirExists(ExpandConstant('{app}\App')) or
    ServiceExists();
end;

procedure StopRunningAppBeforeUpgrade;
var
  ResultCode: Integer;
  Nssm: String;
begin
  { Stop Windows service if present }
  if ServiceExists() then
  begin
    Nssm := ExpandConstant('{app}\Tools\nssm.exe');
    if FileExists(Nssm) then
      Exec(Nssm, 'stop {#ServiceName}', '', SW_HIDE, ewWaitUntilTerminated, ResultCode)
    else
      Exec('sc.exe', 'stop {#ServiceName}', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end;
  { Unlock app binaries for file replace }
  Exec('taskkill.exe', '/F /IM {#AppExeName}', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  NeedsRestart := False;

  if not IsExistingInstall() then
    Exit;

  WizardForm.StatusLabel.Caption := 'Stopping RMA System before upgrade...';
  WizardForm.StatusLabel.Update;
  StopRunningAppBeforeUpgrade;
  Log('Stopped existing RMA System service/process before upgrade (no database backup or recreate).');
end;
