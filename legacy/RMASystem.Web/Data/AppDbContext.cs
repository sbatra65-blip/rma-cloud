using Microsoft.EntityFrameworkCore;
using RMASystem.Models;
using RMASystem.Services;

namespace RMASystem.Data;

/// <summary>
/// No scoped constructor deps — IDbContextFactory stays Singleton (same as Single User).
/// Scoped AppDbContext is bound to CompanyContext after create; factory-created
/// contexts set <see cref="TenantCompanyId"/> / BypassCompanyFilter explicitly.
/// </summary>
public class AppDbContext(DbContextOptions<AppDbContext> options) : DbContext(options)
{
    CompanyContext? _company;
    int _tenantCompanyId = -1;

    /// <summary>Keep query filters in sync with the circuit/request CompanyContext.</summary>
    public void BindCompany(CompanyContext company) => _company = company;

    /// <summary>-1 until company is bound or ApplyFilterAsync — fail closed.</summary>
    public int TenantCompanyId
    {
        get => _company?.CompanyId ?? _tenantCompanyId;
        set
        {
            if (_company != null)
                _company.CompanyId = value;
            else
                _tenantCompanyId = value;
        }
    }

    /// <summary>When true, company query filters are disabled (seed / admin tools).</summary>
    public bool BypassCompanyFilter { get; set; }

    public DbSet<Company>          Companies          { get; set; }
    public DbSet<RMATicket>        RMATickets         { get; set; }
    public DbSet<RMAPhoto>         RMAPhotos          { get; set; }
    public DbSet<MonthlyBatch>     MonthlyBatches     { get; set; }
    public DbSet<AppSetting>       AppSettings        { get; set; }
    public DbSet<ImportLog>        ImportLogs         { get; set; }
    public DbSet<CarePackBatch>    CarePackBatches    { get; set; }
    public DbSet<CarePackDevice>   CarePackDevices    { get; set; }
    public DbSet<UserUiPreference> UserUiPreferences  { get; set; }
    public DbSet<ActivityLog>      ActivityLogs       { get; set; }
    public DbSet<SupportTicket>    SupportTickets     { get; set; }
    public DbSet<RepairJob>        RepairJobs         { get; set; }
    public DbSet<OemNotification>  OemNotifications   { get; set; }
    public DbSet<PartMovement>     PartMovements      { get; set; }
    public DbSet<AppUser>          AppUsers           { get; set; }
    public DbSet<AppUserSession>   AppUserSessions    { get; set; }
    public DbSet<OemPaymentTransfer> OemPaymentTransfers { get; set; }
    public DbSet<OemPaymentAllocation> OemPaymentAllocations { get; set; }
    public DbSet<CarePackDocumentAudit> CarePackDocumentAudits { get; set; }
    public DbSet<OemVendor> OemVendors { get; set; }
    public DbSet<Product> Products { get; set; }
    public DbSet<ProductModel> ProductModels { get; set; }
    public DbSet<Customer> Customers { get; set; }
    public DbSet<CarePackTypeMaster> CarePackTypeMasters { get; set; }

    protected override void OnModelCreating(ModelBuilder mb)
    {
        mb.Entity<Company>()
          .HasIndex(c => c.Code)
          .IsUnique();

        mb.Entity<RMATicket>()
          .HasIndex(t => new { t.CompanyId, t.InternalTicketNo })
          .IsUnique();

        mb.Entity<RMATicket>()
          .HasOne<Company>()
          .WithMany()
          .HasForeignKey(t => t.CompanyId)
          .OnDelete(DeleteBehavior.Restrict);

        mb.Entity<MonthlyBatch>()
          .HasIndex(b => new { b.CompanyId, b.BatchId })
          .IsUnique();

        mb.Entity<MonthlyBatch>()
          .HasOne<Company>()
          .WithMany()
          .HasForeignKey(b => b.CompanyId)
          .OnDelete(DeleteBehavior.Restrict);

        mb.Entity<RMAPhoto>()
          .HasOne(p => p.Ticket)
          .WithMany(t => t.Photos)
          .HasForeignKey(p => p.RmaTicketId)
          .OnDelete(DeleteBehavior.Cascade);

        mb.Entity<CarePackDevice>()
          .HasOne(d => d.Batch)
          .WithMany(b => b.Devices)
          .HasForeignKey(d => d.CarePackBatchId)
          .OnDelete(DeleteBehavior.Cascade);

        mb.Entity<CarePackBatch>()
          .HasIndex(b => new { b.CompanyId, b.InvoiceNumber, b.LineSetIndex })
          .IsUnique();

        mb.Entity<CarePackBatch>()
          .HasIndex(b => b.CreatedAt);

        mb.Entity<CarePackBatch>()
          .HasOne<Company>()
          .WithMany()
          .HasForeignKey(b => b.CompanyId)
          .OnDelete(DeleteBehavior.Restrict);

        mb.Entity<CarePackDevice>()
          .HasIndex(d => d.SerialNumber);

        mb.Entity<UserUiPreference>()
          .HasIndex(p => p.UserName)
          .IsUnique();

        mb.Entity<SupportTicket>()
          .HasIndex(t => t.TicketNo)
          .IsUnique();

        mb.Entity<RepairJob>()
          .HasIndex(t => t.JobNo)
          .IsUnique();

        mb.Entity<ActivityLog>()
          .HasIndex(a => a.CreatedAt);

        mb.Entity<PartMovement>()
          .HasIndex(p => p.MovedAt);

        mb.Entity<AppUser>()
          .HasIndex(u => new { u.CompanyId, u.UserName })
          .IsUnique();

        mb.Entity<AppUser>()
          .HasOne<Company>()
          .WithMany()
          .HasForeignKey(u => u.CompanyId)
          .OnDelete(DeleteBehavior.Restrict);

        mb.Entity<AppUserSession>()
          .HasOne(s => s.User)
          .WithMany(u => u.Sessions)
          .HasForeignKey(s => s.UserId)
          .OnDelete(DeleteBehavior.Cascade);

        mb.Entity<AppUserSession>()
          .HasIndex(s => new { s.UserId, s.IsRevoked, s.EndedAt });

        mb.Entity<OemPaymentTransfer>()
          .HasOne<Company>()
          .WithMany()
          .HasForeignKey(t => t.CompanyId)
          .OnDelete(DeleteBehavior.Restrict);

        mb.Entity<OemPaymentAllocation>()
          .HasOne(a => a.Transfer)
          .WithMany(t => t.Allocations)
          .HasForeignKey(a => a.OemPaymentTransferId)
          .OnDelete(DeleteBehavior.Cascade);

        mb.Entity<OemPaymentAllocation>()
          .HasOne(a => a.Batch)
          .WithMany(b => b.PaymentAllocations)
          .HasForeignKey(a => a.CarePackBatchId)
          .OnDelete(DeleteBehavior.Restrict);

        mb.Entity<OemPaymentAllocation>()
          .HasIndex(a => new { a.OemPaymentTransferId, a.CarePackBatchId })
          .IsUnique();

        mb.Entity<CarePackDocumentAudit>()
          .HasOne(a => a.Batch)
          .WithMany(b => b.DocumentAudits)
          .HasForeignKey(a => a.CarePackBatchId)
          .OnDelete(DeleteBehavior.Cascade);

        mb.Entity<CarePackDocumentAudit>()
          .HasIndex(a => new { a.CarePackBatchId, a.PerformedAt });

        // ── Masters ───────────────────────────────────────────────────────────
        mb.Entity<OemVendor>()
          .HasIndex(o => new { o.CompanyId, o.Code })
          .IsUnique();
        mb.Entity<OemVendor>()
          .HasOne<Company>()
          .WithMany()
          .HasForeignKey(o => o.CompanyId)
          .OnDelete(DeleteBehavior.Restrict);

        mb.Entity<Product>()
          .HasIndex(p => new { p.CompanyId, p.Code })
          .IsUnique();
        mb.Entity<Product>()
          .HasOne(p => p.OemVendor)
          .WithMany(o => o.Products)
          .HasForeignKey(p => p.OemVendorId)
          .OnDelete(DeleteBehavior.Restrict);
        mb.Entity<Product>()
          .HasOne<Company>()
          .WithMany()
          .HasForeignKey(p => p.CompanyId)
          .OnDelete(DeleteBehavior.Restrict);

        mb.Entity<ProductModel>()
          .HasIndex(m => new { m.ProductId, m.Code })
          .IsUnique();
        mb.Entity<ProductModel>()
          .HasOne(m => m.Product)
          .WithMany(p => p.Models)
          .HasForeignKey(m => m.ProductId)
          .OnDelete(DeleteBehavior.Restrict);
        mb.Entity<ProductModel>()
          .HasOne<Company>()
          .WithMany()
          .HasForeignKey(m => m.CompanyId)
          .OnDelete(DeleteBehavior.Restrict);

        mb.Entity<Customer>()
          .HasIndex(c => new { c.CompanyId, c.Code })
          .IsUnique();
        mb.Entity<Customer>()
          .HasOne<Company>()
          .WithMany()
          .HasForeignKey(c => c.CompanyId)
          .OnDelete(DeleteBehavior.Restrict);

        mb.Entity<CarePackTypeMaster>()
          .HasIndex(t => new { t.CompanyId, t.Name })
          .IsUnique();
        mb.Entity<CarePackTypeMaster>()
          .HasOne<Company>()
          .WithMany()
          .HasForeignKey(t => t.CompanyId)
          .OnDelete(DeleteBehavior.Restrict);

        mb.Entity<CarePackBatch>()
          .HasOne<Customer>()
          .WithMany()
          .HasForeignKey(b => b.CustomerId)
          .OnDelete(DeleteBehavior.SetNull);
        mb.Entity<CarePackBatch>()
          .HasOne<OemVendor>()
          .WithMany()
          .HasForeignKey(b => b.OemVendorId)
          .OnDelete(DeleteBehavior.SetNull);
        mb.Entity<CarePackBatch>()
          .HasOne<Product>()
          .WithMany()
          .HasForeignKey(b => b.ProductId)
          .OnDelete(DeleteBehavior.SetNull);
        mb.Entity<CarePackBatch>()
          .HasOne<ProductModel>()
          .WithMany()
          .HasForeignKey(b => b.ProductModelId)
          .OnDelete(DeleteBehavior.SetNull);
        mb.Entity<CarePackBatch>()
          .HasOne<CarePackTypeMaster>()
          .WithMany()
          .HasForeignKey(b => b.CarePackTypeId)
          .OnDelete(DeleteBehavior.SetNull);

        mb.Entity<CarePackDevice>()
          .HasOne<ProductModel>()
          .WithMany()
          .HasForeignKey(d => d.ProductModelId)
          .OnDelete(DeleteBehavior.SetNull);

        mb.Entity<RMATicket>()
          .HasOne<Customer>()
          .WithMany()
          .HasForeignKey(t => t.CustomerId)
          .OnDelete(DeleteBehavior.SetNull);
        mb.Entity<RMATicket>()
          .HasOne<ProductModel>()
          .WithMany()
          .HasForeignKey(t => t.ProductModelId)
          .OnDelete(DeleteBehavior.SetNull);

        // Phase B: fail-closed company scope (include child rows — devices had no filter and leaked across companies)
        mb.Entity<CarePackBatch>()
          .HasQueryFilter(b => BypassCompanyFilter || b.CompanyId == TenantCompanyId);
        mb.Entity<CarePackDevice>()
          .HasQueryFilter(d => BypassCompanyFilter || d.Batch.CompanyId == TenantCompanyId);
        mb.Entity<RMATicket>()
          .HasQueryFilter(t => BypassCompanyFilter || t.CompanyId == TenantCompanyId);
        mb.Entity<RMAPhoto>()
          .HasQueryFilter(p => BypassCompanyFilter || p.Ticket.CompanyId == TenantCompanyId);
        mb.Entity<MonthlyBatch>()
          .HasQueryFilter(b => BypassCompanyFilter || b.CompanyId == TenantCompanyId);
        mb.Entity<OemPaymentTransfer>()
          .HasQueryFilter(t => BypassCompanyFilter || t.CompanyId == TenantCompanyId);
        mb.Entity<OemPaymentAllocation>()
          .HasQueryFilter(a => BypassCompanyFilter || a.Batch.CompanyId == TenantCompanyId);
        mb.Entity<CarePackDocumentAudit>()
          .HasQueryFilter(a => BypassCompanyFilter || a.Batch.CompanyId == TenantCompanyId);
        mb.Entity<OemVendor>()
          .HasQueryFilter(o => BypassCompanyFilter || o.CompanyId == TenantCompanyId);
        mb.Entity<Product>()
          .HasQueryFilter(p => BypassCompanyFilter || p.CompanyId == TenantCompanyId);
        mb.Entity<ProductModel>()
          .HasQueryFilter(m => BypassCompanyFilter || m.CompanyId == TenantCompanyId);
        mb.Entity<Customer>()
          .HasQueryFilter(c => BypassCompanyFilter || c.CompanyId == TenantCompanyId);
        mb.Entity<CarePackTypeMaster>()
          .HasQueryFilter(t => BypassCompanyFilter || t.CompanyId == TenantCompanyId);

        mb.Entity<AppSetting>()
          .HasKey(s => s.Key);

        mb.Entity<AppSetting>().HasData(
            S("company_name",              "INFINITE SOLUTIONS"),
            S("company_address",           "312, VISHWADEEP TOWER"),
            S("company_city",              "New Delhi"),
            S("company_postal",            "110058"),
            S("company_country",           "INDIA"),
            S("company_contact",           "Sanjay Batra"),
            S("company_email",             "sanjay@infinitesolutions.co.in"),
            S("company_phone",             "9311011467"),
            S("oem_name",                  "TSC Auto ID Technology Co., Ltd."),
            S("oem_address",               "No. 285, Shulin Dist., New Taipei City 23860, Taiwan"),
            S("oem_phone",                 "+886-2-2267-6000"),
            S("oem_fax",                   "+886-2-2267-5581"),
            S("oem_email",                 "tsc_rma@tscprinters.com"),
            S("ticket_prefix",             "INF"),
            S("base_dir",                  @"C:\Sanjay Projects\Projects\RMA Windows"),
            S("setup_complete",            "false"),
            S("zoho_client_id",            ""),
            S("zoho_client_secret",        ""),
            S("zoho_mail_refresh_token",   ""),
            S("zoho_books_refresh_token",  ""),
            S("zoho_books_org_id",         ""),
            S("zoho_poll_interval_mins",   "30")
        );
    }

    private static AppSetting S(string key, string value) =>
        new() { Key = key, Value = value };

    public async Task<string> GetSettingAsync(string key, string defaultValue = "")
    {
        var s = await AppSettings.FindAsync(key);
        return s?.Value ?? defaultValue;
    }

    public async Task SetSettingAsync(string key, string value)
    {
        var s = await AppSettings.FindAsync(key);
        if (s == null)
        {
            AppSettings.Add(new AppSetting { Key = key, Value = value });
        }
        else
        {
            s.Value = value;
            AppSettings.Update(s);
        }
        await SaveChangesAsync();
    }
}
