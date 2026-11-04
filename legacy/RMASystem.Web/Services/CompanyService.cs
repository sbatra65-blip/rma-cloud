using Microsoft.EntityFrameworkCore;
using RMASystem.Data;
using RMASystem.Models;

namespace RMASystem.Services;

/// <summary>Company profiles + active-company resolution for Phase B.</summary>
public class CompanyService(
    IDbContextFactory<AppDbContext> dbFactory,
    UserSessionService session)
{
    /// <summary>Ensure seed companies exist (Infinite Solutions + Demo for testing).</summary>
    public async Task EnsureSeedAsync()
    {
        await using var db = await dbFactory.CreateDbContextAsync();
        db.BypassCompanyFilter = true;

        if (!await db.Companies.AnyAsync(c => c.Code == "INF"))
        {
            var name = await db.GetSettingAsync("company_name", "INFINITE SOLUTIONS");
            db.Companies.Add(new Company
            {
                Code = "INF",
                Name = string.IsNullOrWhiteSpace(name) ? "INFINITE SOLUTIONS" : name,
                InvoicePrefix = "IS-GST-2627-",
                TicketPrefix = await db.GetSettingAsync("ticket_prefix", "INF"),
                City = await db.GetSettingAsync("company_city", "New Delhi"),
                Address = await db.GetSettingAsync("company_address", ""),
                ContactName = await db.GetSettingAsync("company_contact", ""),
                Email = await db.GetSettingAsync("company_email", ""),
                Phone = await db.GetSettingAsync("company_phone", ""),
                IsActive = true,
                CreatedAt = DateTime.Now,
            });
            await db.SaveChangesAsync();
        }

        if (!await db.Companies.AnyAsync(c => c.Code == "DEMO"))
        {
            db.Companies.Add(new Company
            {
                Code = "DEMO",
                Name = "Demo / Test Company",
                InvoicePrefix = "DEMO-INV-",
                TicketPrefix = "DEMO",
                City = "Test City",
                IsActive = true,
                CreatedAt = DateTime.Now,
            });
            await db.SaveChangesAsync();
        }
    }

    public async Task<List<Company>> ListActiveAsync()
    {
        await using var db = await dbFactory.CreateDbContextAsync();
        db.BypassCompanyFilter = true;
        return await db.Companies.AsNoTracking()
            .Where(c => c.IsActive)
            .OrderBy(c => c.Id)
            .ToListAsync();
    }

    public async Task<Company?> GetAsync(int id)
    {
        await using var db = await dbFactory.CreateDbContextAsync();
        db.BypassCompanyFilter = true;
        return await db.Companies.AsNoTracking().FirstOrDefaultAsync(c => c.Id == id);
    }

    public async Task<Company> GetRequiredAsync(int id) =>
        await GetAsync(id) ?? throw new InvalidOperationException($"Company #{id} not found.");

    public async Task<Company> GetActiveCompanyAsync()
    {
        var id = await session.GetActiveCompanyIdAsync();
        if (id <= 0)
            throw new InvalidOperationException("No company selected. Sign in again.");
        var c = await GetAsync(id);
        if (c != null) return c;
        throw new InvalidOperationException($"Company #{id} not found. Sign out and choose a company at login.");
    }

    public async Task<string> GetActiveInvoicePrefixAsync()
    {
        var c = await GetActiveCompanyAsync();
        return string.IsNullOrWhiteSpace(c.InvoicePrefix) ? "IS-GST-2627-" : c.InvoicePrefix;
    }

    public async Task ApplyFilterAsync(AppDbContext db)
    {
        var id = await session.GetActiveCompanyIdAsync();
        if (id <= 0)
            throw new InvalidOperationException("No company selected. Sign out and choose a company at login.");
        db.TenantCompanyId = id;
        db.BypassCompanyFilter = false;
    }
}
