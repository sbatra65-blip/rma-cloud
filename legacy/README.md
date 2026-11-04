# RMA Ticket Management System
**Infinite Solutions, New Delhi**  
Tech Stack: C# .NET 8 · ASP.NET Core · Blazor Server · SQL Server Express · ClosedXML

---

## Prerequisites (Developer Machine)

| Tool | Download | Notes |
|---|---|---|
| Visual Studio 2022 Community | visualstudio.microsoft.com | Select "ASP.NET and web development" workload |
| SQL Server Express 2022 | microsoft.com/sql-server | Free edition |
| SQL Server Management Studio | aka.ms/ssmsfullsetup | Optional — to inspect DB |
| Inno Setup 6 | jrsoftware.org/isinfo.php | To build installer |

---

## Project Structure

```
RMASystem/
├── RMASystem.Web/           ← Main application
│   ├── Controllers/         ← File download endpoints
│   ├── Data/                ← EF Core DbContext
│   ├── Models/              ← Database entities
│   ├── Pages/               ← Blazor pages (UI)
│   ├── Services/            ← Business logic
│   ├── Shared/              ← Shared Blazor components
│   ├── wwwroot/css/         ← Stylesheet
│   ├── Program.cs           ← App startup
│   └── appsettings.json     ← Connection string
├── setup.iss                ← Inno Setup installer script
└── README.md
```

---

## Step 1 — Open in Visual Studio

1. Open Visual Studio 2022
2. File → Open → Project/Solution
3. Navigate to `RMASystem.Web\RMASystem.Web.csproj`
4. Visual Studio restores NuGet packages automatically

---

## Step 2 — Configure Database Connection

Open `appsettings.json` and verify the connection string:

```json
"DefaultConnection": "Server=.\\SQLEXPRESS;Database=RMASystem;Integrated Security=True;TrustServerCertificate=True;"
```

If your SQL Server instance has a different name, update `SQLEXPRESS` accordingly.

---

## Step 3 — Create & Apply Migrations

Open **Tools → NuGet Package Manager → Package Manager Console** and run:

```powershell
# Create the initial migration
Add-Migration InitialCreate

# Apply to database (creates DB + all tables automatically)
Update-Database
```

The database `RMASystem` is created automatically on your SQL Server Express instance.

---

## Step 4 — Run in Development

Press **F5** in Visual Studio. The browser opens at `http://localhost:5000`.

---

## Step 5 — Build Release & Installer (Windows 11)

See **[INSTALLER.md](INSTALLER.md)** for the full guide.

Quick build (from the `RMASystem` folder):

```powershell
.\build-installer.ps1
```

Output: `Output\RMA_System_v1.1.0_Setup.exe`  
On the target PC: run as Administrator. The setup can install **SQL Server Express** and register the app as a Windows service.

---

## Step 6 — Deploy on Server PC

1. Copy `RMA_System_v1.1.0_Setup.exe` to the Windows 11 PC  
2. Right-click → **Run as administrator**  
3. Keep **Install SQL Server Express** checked if SQL is not installed  
4. Browser opens at `http://localhost:5000`  
5. Service **RMASystem** starts on every boot  

Default install folder: `C:\Program Files\RMA System`

---

## Accessing from Other Machines (LAN)

1. Find the server PC's IP address (run `ipconfig` on server PC)
2. Set a static IP (Network Settings → Wi-Fi → Manual)
3. On any MacBook or other PC — open browser and go to:
   ```
   http://192.168.1.x:5000
   ```
4. Bookmark the URL

No installation needed on client machines — just a browser.

---

## Adding Future Migrations (Schema Changes)

When models change:

```powershell
Add-Migration <MigrationName>
Update-Database
```

EF Core automatically applies migrations on app startup, so deployed instances
update themselves when you replace the binaries and rebuild the installer.

---

## Key File Locations (on Server PC)

| What | Path |
|---|---|
| Application | `C:\Program Files\RMA System\App\` |
| Photos | `C:\Program Files\RMA System\Photos\` |
| Excel files | `C:\Program Files\RMA System\Excel\` |
| Challans | `C:\Program Files\RMA System\Challans\` |
| Batch lists | `C:\Program Files\RMA System\Batches\` |
| Logs | `C:\Program Files\RMA System\Logs\` |
| Database | SQL Server Express `.\SQLEXPRESS` → database `RMASystem` |

---

## NuGet Packages Used

| Package | Purpose | License |
|---|---|---|
| Microsoft.EntityFrameworkCore.SqlServer | ORM + SQL Server | MIT |
| Microsoft.Extensions.Hosting.WindowsServices | Windows Service | MIT |
| ClosedXML | Excel generation | MIT |
| ExcelDataReader | Read Excel for import | MIT |
| Serilog.AspNetCore | Application logging | Apache 2.0 |

All packages are free for commercial use.
