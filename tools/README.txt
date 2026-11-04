# Place nssm.exe here (64-bit).
# Download: https://nssm.cc/download  → extract win64\nssm.exe into this folder.
#
# Or run: ..\build-installer.ps1  (downloads automatically)
#
# --- SQL access after restore / other PC (installed under {app}\Tools) ---
# If logs say: Cannot open database "RMASystem" ... Login failed for user "MACHINE\user"
# and the database ALREADY has data:
#   1. Elevated PowerShell
#   2. cd "C:\Program Files\RMA System\Tools"
#   3. .\grant-db-access.ps1
#      (optional: -WindowsUser "JAGDISHDELL\jagdi")
#   4. Restart-Service RMASystem → http://localhost:5000/setup → Refresh
#
# If the database does not exist yet: .\ensure-sql-access.ps1  (or /setup create)
#
# Source: installer\grant-db-access.ps1 / ensure-sql-access.ps1
