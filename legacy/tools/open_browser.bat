@echo off
REM Visible launcher — installs/checks SQL, starts service, opens browser
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-rma.ps1"
if errorlevel 1 pause
endlocal
