using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;
using RMASystem.Models;

namespace RMASystem.Data;

/// <summary>
/// Used ONLY by EF Core tooling (Add-Migration, Update-Database).
/// Connection comes from config.ini — not hard-coded.
/// </summary>
public class AppDbContextFactory : IDesignTimeDbContextFactory<AppDbContext>
{
    public AppDbContext CreateDbContext(string[] args)
    {
        IniConfig.EnsureDefaultFile();
        var connectionString = IniConfig.BuildConnectionString();

        var optionsBuilder = new DbContextOptionsBuilder<AppDbContext>();
        optionsBuilder.UseSqlServer(connectionString);

        return new AppDbContext(optionsBuilder.Options)
        {
            TenantCompanyId = CompanyIds.InfiniteSolutions,
            BypassCompanyFilter = true,
        };
    }
}
