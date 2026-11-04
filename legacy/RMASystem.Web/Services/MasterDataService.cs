using ClosedXML.Excel;
using Microsoft.EntityFrameworkCore;
using RMASystem.Data;
using RMASystem.Models;

namespace RMASystem.Services;

public record MasterImportResult(int Created, int Updated, int Skipped, List<string> Errors)
{
    public int Total => Created + Updated + Skipped;
    public string Summary =>
        $"Created {Created}, updated {Updated}, skipped {Skipped}" +
        (Errors.Count == 0 ? "." : $". {Errors.Count} error(s).");
}

/// <summary>Company-scoped Customer / OEM / Product / Model / Care Pack Type masters.</summary>
public class MasterDataService(
    IDbContextFactory<AppDbContext> dbFactory,
    CompanyService companies,
    UserSessionService session)
{
    async Task<AppDbContext> ScopedDbAsync()
    {
        var db = await dbFactory.CreateDbContextAsync();
        await companies.ApplyFilterAsync(db);
        return db;
    }

    async Task EnsureCanManageAsync()
    {
        var (_, role) = await session.GetCurrentAsync();
        if (!AppRoles.CanManageMasters(role))
            throw new InvalidOperationException("Your role cannot manage masters.");
    }

    /// <summary>Seed catalog OEMs → Products → Models and Care Pack Types for every active company.</summary>
    public async Task EnsureSeedAsync()
    {
        await using var db = await dbFactory.CreateDbContextAsync();
        db.BypassCompanyFilter = true;

        var companyIds = await db.Companies.AsNoTracking()
            .Where(c => c.IsActive)
            .Select(c => c.Id)
            .ToListAsync();
        if (companyIds.Count == 0)
            companyIds = [CompanyIds.InfiniteSolutions];

        foreach (var companyId in companyIds)
            await SeedCompanyAsync(db, companyId);

        await db.SaveChangesAsync();
    }

    static async Task SeedCompanyAsync(AppDbContext db, int companyId)
    {
        // Care pack types
        foreach (var name in OemBrandCatalog.CarePackTypes)
        {
            if (await db.CarePackTypeMasters.AnyAsync(t => t.CompanyId == companyId && t.Name == name))
                continue;
            var years = OemBrandCatalog.DetectDurationYears(name) ?? 5;
            if (name.Contains("Comprehensive", StringComparison.OrdinalIgnoreCase))
                years = 5;
            db.CarePackTypeMasters.Add(new CarePackTypeMaster
            {
                CompanyId = companyId,
                Name = name,
                DurationYears = years,
                IsActive = true,
                CreatedAt = DateTime.Now,
            });
        }

        // OEM → Product (same name as brand) → Models from catalog
        foreach (var brand in OemBrandCatalog.Brands)
        {
            var code = MakeCode(brand);
            var oem = await db.OemVendors.FirstOrDefaultAsync(o => o.CompanyId == companyId && o.Code == code);
            if (oem == null)
            {
                oem = new OemVendor
                {
                    CompanyId = companyId,
                    Code = code,
                    Name = brand,
                    IsActive = true,
                    CreatedAt = DateTime.Now,
                };
                db.OemVendors.Add(oem);
                await db.SaveChangesAsync();
            }

            var product = await db.Products.FirstOrDefaultAsync(p =>
                p.CompanyId == companyId && p.OemVendorId == oem.Id && p.Code == code);
            if (product == null)
            {
                product = new Product
                {
                    CompanyId = companyId,
                    OemVendorId = oem.Id,
                    Code = code,
                    Name = brand + " Printers",
                    IsActive = true,
                    CreatedAt = DateTime.Now,
                };
                db.Products.Add(product);
                await db.SaveChangesAsync();
            }

            foreach (var kv in OemBrandCatalog.ModelBrandMap.Where(x =>
                         string.Equals(x.Value, brand, StringComparison.OrdinalIgnoreCase)))
            {
                if (await db.ProductModels.AnyAsync(m => m.ProductId == product.Id && m.Code == kv.Key))
                    continue;
                db.ProductModels.Add(new ProductModel
                {
                    CompanyId = companyId,
                    ProductId = product.Id,
                    Code = kv.Key,
                    Name = kv.Key,
                    IsActive = true,
                    CreatedAt = DateTime.Now,
                });
            }
        }
    }

    static string MakeCode(string name)
    {
        var chars = name.Where(char.IsLetterOrDigit).Take(12).ToArray();
        var code = new string(chars).ToUpperInvariant();
        return string.IsNullOrEmpty(code) ? "OEM" : code;
    }

    // ── List ─────────────────────────────────────────────────────────────────

    public async Task<List<OemVendor>> ListOemsAsync(bool activeOnly = true)
    {
        await using var db = await ScopedDbAsync();
        var q = db.OemVendors.AsNoTracking().AsQueryable();
        if (activeOnly) q = q.Where(o => o.IsActive);
        return await q.OrderBy(o => o.Name).ToListAsync();
    }

    public async Task<List<Product>> ListProductsAsync(int? oemVendorId = null, bool activeOnly = true)
    {
        await using var db = await ScopedDbAsync();
        var q = db.Products.AsNoTracking().Include(p => p.OemVendor).AsQueryable();
        if (oemVendorId is > 0) q = q.Where(p => p.OemVendorId == oemVendorId);
        if (activeOnly) q = q.Where(p => p.IsActive);
        return await q.OrderBy(p => p.Name).ToListAsync();
    }

    public async Task<List<ProductModel>> ListModelsAsync(int? productId = null, bool activeOnly = true)
    {
        await using var db = await ScopedDbAsync();
        var q = db.ProductModels.AsNoTracking().Include(m => m.Product).ThenInclude(p => p.OemVendor).AsQueryable();
        if (productId is > 0) q = q.Where(m => m.ProductId == productId);
        if (activeOnly) q = q.Where(m => m.IsActive);
        return await q.OrderBy(m => m.Code).ToListAsync();
    }

    public async Task<List<Customer>> ListCustomersAsync(string? search = null, bool activeOnly = true)
    {
        await using var db = await ScopedDbAsync();
        var q = db.Customers.AsNoTracking().AsQueryable();
        if (activeOnly) q = q.Where(c => c.IsActive);
        var s = (search ?? "").Trim();
        if (s.Length > 0)
        {
            q = q.Where(c => c.Name.Contains(s) || c.Code.Contains(s) ||
                             (c.City != null && c.City.Contains(s)));
        }
        return await q.OrderBy(c => c.Name).Take(500).ToListAsync();
    }

    public async Task<List<CarePackTypeMaster>> ListCarePackTypesAsync(bool activeOnly = true)
    {
        await using var db = await ScopedDbAsync();
        var q = db.CarePackTypeMasters.AsNoTracking().AsQueryable();
        if (activeOnly) q = q.Where(t => t.IsActive);
        return await q.OrderBy(t => t.DurationYears).ThenBy(t => t.Name).ToListAsync();
    }

    // ── Create ───────────────────────────────────────────────────────────────

    public async Task<OemVendor> CreateOemAsync(string code, string name)
    {
        await EnsureCanManageAsync();
        await using var db = await ScopedDbAsync();
        code = NormalizeCode(code, name);
        name = (name ?? "").Trim();
        if (string.IsNullOrWhiteSpace(name))
            throw new InvalidOperationException("OEM name is required.");
        if (await db.OemVendors.AnyAsync(o => o.Code == code))
            throw new InvalidOperationException($"OEM code '{code}' already exists.");

        var row = new OemVendor
        {
            CompanyId = db.TenantCompanyId,
            Code = code,
            Name = name,
            IsActive = true,
            CreatedAt = DateTime.Now,
        };
        db.OemVendors.Add(row);
        await db.SaveChangesAsync();
        return row;
    }

    public async Task<Product> CreateProductAsync(int oemVendorId, string code, string name)
    {
        await EnsureCanManageAsync();
        await using var db = await ScopedDbAsync();
        var oem = await db.OemVendors.FirstOrDefaultAsync(o => o.Id == oemVendorId)
            ?? throw new InvalidOperationException("OEM not found.");
        code = NormalizeCode(code, name);
        name = (name ?? "").Trim();
        if (string.IsNullOrWhiteSpace(name))
            throw new InvalidOperationException("Product name is required.");
        if (await db.Products.AnyAsync(p => p.Code == code))
            throw new InvalidOperationException($"Product code '{code}' already exists.");

        var row = new Product
        {
            CompanyId = db.TenantCompanyId,
            OemVendorId = oem.Id,
            Code = code,
            Name = name,
            IsActive = true,
            CreatedAt = DateTime.Now,
        };
        db.Products.Add(row);
        await db.SaveChangesAsync();
        return row;
    }

    public async Task<ProductModel> CreateModelAsync(int productId, string code, string name)
    {
        await EnsureCanManageAsync();
        await using var db = await ScopedDbAsync();
        var product = await db.Products.FirstOrDefaultAsync(p => p.Id == productId)
            ?? throw new InvalidOperationException("Product not found.");
        code = NormalizeCode(code, name);
        name = string.IsNullOrWhiteSpace(name) ? code : name.Trim();
        if (await db.ProductModels.AnyAsync(m => m.ProductId == productId && m.Code == code))
            throw new InvalidOperationException($"Model code '{code}' already exists under this product.");

        var row = new ProductModel
        {
            CompanyId = db.TenantCompanyId,
            ProductId = product.Id,
            Code = code,
            Name = name,
            IsActive = true,
            CreatedAt = DateTime.Now,
        };
        db.ProductModels.Add(row);
        await db.SaveChangesAsync();
        return row;
    }

    public async Task<Customer> CreateCustomerAsync(
        string code, string name, string? city = null, string? state = null,
        string? address = null, string? phone = null, string? email = null, string? gstin = null)
    {
        await EnsureCanManageAsync();
        await using var db = await ScopedDbAsync();
        name = (name ?? "").Trim();
        if (string.IsNullOrWhiteSpace(name))
            throw new InvalidOperationException("Customer name is required.");
        code = NormalizeCode(code, name);
        if (await db.Customers.AnyAsync(c => c.Code == code))
            throw new InvalidOperationException($"Customer code '{code}' already exists.");

        var row = new Customer
        {
            CompanyId = db.TenantCompanyId,
            Code = code,
            Name = name,
            City = NullIfEmpty(city),
            State = NullIfEmpty(state),
            Address = NullIfEmpty(address),
            Phone = NullIfEmpty(phone),
            Email = NullIfEmpty(email),
            Gstin = NullIfEmpty(gstin),
            Country = "India",
            IsActive = true,
            CreatedAt = DateTime.Now,
        };
        db.Customers.Add(row);
        await db.SaveChangesAsync();
        return row;
    }

    public async Task<CarePackTypeMaster> CreateCarePackTypeAsync(string name, int durationYears)
    {
        await EnsureCanManageAsync();
        await using var db = await ScopedDbAsync();
        name = (name ?? "").Trim();
        if (string.IsNullOrWhiteSpace(name))
            throw new InvalidOperationException("Care pack type name is required.");
        if (durationYears is < 1 or > 10)
            throw new InvalidOperationException("Duration years must be 1–10.");
        if (await db.CarePackTypeMasters.AnyAsync(t => t.Name == name))
            throw new InvalidOperationException($"Care pack type '{name}' already exists.");

        var row = new CarePackTypeMaster
        {
            CompanyId = db.TenantCompanyId,
            Name = name,
            DurationYears = durationYears,
            IsActive = true,
            CreatedAt = DateTime.Now,
        };
        db.CarePackTypeMasters.Add(row);
        await db.SaveChangesAsync();
        return row;
    }

    public async Task SetActiveAsync(string kind, int id, bool active)
    {
        await EnsureCanManageAsync();
        await using var db = await ScopedDbAsync();
        switch (kind.ToLowerInvariant())
        {
            case "oem":
                var o = await db.OemVendors.FindAsync(id) ?? throw new InvalidOperationException("OEM not found.");
                o.IsActive = active;
                break;
            case "product":
                var p = await db.Products.FindAsync(id) ?? throw new InvalidOperationException("Product not found.");
                p.IsActive = active;
                break;
            case "model":
                var m = await db.ProductModels.FindAsync(id) ?? throw new InvalidOperationException("Model not found.");
                m.IsActive = active;
                break;
            case "customer":
                var c = await db.Customers.FindAsync(id) ?? throw new InvalidOperationException("Customer not found.");
                c.IsActive = active;
                break;
            case "carepacktype":
                var t = await db.CarePackTypeMasters.FindAsync(id) ?? throw new InvalidOperationException("Type not found.");
                t.IsActive = active;
                break;
            default:
                throw new InvalidOperationException("Unknown master kind.");
        }
        await db.SaveChangesAsync();
    }

    // ── Update ───────────────────────────────────────────────────────────────

    public async Task UpdateOemAsync(int id, string code, string name)
    {
        await EnsureCanManageAsync();
        await using var db = await ScopedDbAsync();
        var row = await db.OemVendors.FindAsync(id) ?? throw new InvalidOperationException("OEM not found.");
        code = NormalizeCode(code, name);
        name = (name ?? "").Trim();
        if (string.IsNullOrWhiteSpace(name))
            throw new InvalidOperationException("OEM name is required.");
        if (await db.OemVendors.AnyAsync(o => o.Id != id && o.Code == code))
            throw new InvalidOperationException($"OEM code '{code}' already exists.");
        row.Code = code;
        row.Name = name;
        await db.SaveChangesAsync();
    }

    public async Task UpdateProductAsync(int id, int oemVendorId, string code, string name)
    {
        await EnsureCanManageAsync();
        await using var db = await ScopedDbAsync();
        var row = await db.Products.FindAsync(id) ?? throw new InvalidOperationException("Product not found.");
        _ = await db.OemVendors.FirstOrDefaultAsync(o => o.Id == oemVendorId)
            ?? throw new InvalidOperationException("OEM not found.");
        code = NormalizeCode(code, name);
        name = (name ?? "").Trim();
        if (string.IsNullOrWhiteSpace(name))
            throw new InvalidOperationException("Product name is required.");
        if (await db.Products.AnyAsync(p => p.Id != id && p.Code == code))
            throw new InvalidOperationException($"Product code '{code}' already exists.");
        row.OemVendorId = oemVendorId;
        row.Code = code;
        row.Name = name;
        await db.SaveChangesAsync();
    }

    public async Task UpdateModelAsync(int id, int productId, string code, string name)
    {
        await EnsureCanManageAsync();
        await using var db = await ScopedDbAsync();
        var row = await db.ProductModels.FindAsync(id) ?? throw new InvalidOperationException("Model not found.");
        _ = await db.Products.FirstOrDefaultAsync(p => p.Id == productId)
            ?? throw new InvalidOperationException("Product not found.");
        code = NormalizeCode(code, name);
        name = string.IsNullOrWhiteSpace(name) ? code : name.Trim();
        if (await db.ProductModels.AnyAsync(m => m.Id != id && m.ProductId == productId && m.Code == code))
            throw new InvalidOperationException($"Model code '{code}' already exists under this product.");
        row.ProductId = productId;
        row.Code = code;
        row.Name = name;
        await db.SaveChangesAsync();
    }

    public async Task UpdateCustomerAsync(
        int id, string code, string name, string? city = null, string? state = null,
        string? address = null, string? phone = null, string? email = null, string? gstin = null)
    {
        await EnsureCanManageAsync();
        await using var db = await ScopedDbAsync();
        var row = await db.Customers.FindAsync(id) ?? throw new InvalidOperationException("Customer not found.");
        name = (name ?? "").Trim();
        if (string.IsNullOrWhiteSpace(name))
            throw new InvalidOperationException("Customer name is required.");
        code = NormalizeCode(code, name);
        if (await db.Customers.AnyAsync(c => c.Id != id && c.Code == code))
            throw new InvalidOperationException($"Customer code '{code}' already exists.");
        row.Code = code;
        row.Name = name;
        row.City = NullIfEmpty(city);
        row.State = NullIfEmpty(state);
        row.Address = NullIfEmpty(address);
        row.Phone = NullIfEmpty(phone);
        row.Email = NullIfEmpty(email);
        row.Gstin = NullIfEmpty(gstin);
        await db.SaveChangesAsync();
    }

    public async Task UpdateCarePackTypeAsync(int id, string name, int durationYears)
    {
        await EnsureCanManageAsync();
        await using var db = await ScopedDbAsync();
        var row = await db.CarePackTypeMasters.FindAsync(id) ?? throw new InvalidOperationException("Type not found.");
        name = (name ?? "").Trim();
        if (string.IsNullOrWhiteSpace(name))
            throw new InvalidOperationException("Care pack type name is required.");
        if (durationYears is < 1 or > 10)
            throw new InvalidOperationException("Duration years must be 1–10.");
        if (await db.CarePackTypeMasters.AnyAsync(t => t.Id != id && t.Name == name))
            throw new InvalidOperationException($"Care pack type '{name}' already exists.");
        row.Name = name;
        row.DurationYears = durationYears;
        await db.SaveChangesAsync();
    }

    // ── Delete (only when no transactions / children) ────────────────────────

    /// <summary>Returns null if delete is allowed; otherwise a clear block reason.</summary>
    public async Task<string?> GetDeleteBlockReasonAsync(string kind, int id)
    {
        await using var db = await ScopedDbAsync();
        return await ComputeDeleteBlockAsync(db, kind, id);
    }

    public async Task DeleteAsync(string kind, int id)
    {
        await EnsureCanManageAsync();
        await using var db = await ScopedDbAsync();
        var block = await ComputeDeleteBlockAsync(db, kind, id);
        if (block != null)
            throw new InvalidOperationException(block);

        switch (kind.ToLowerInvariant())
        {
            case "oem":
                db.OemVendors.Remove(await db.OemVendors.FindAsync(id)
                    ?? throw new InvalidOperationException("OEM not found."));
                break;
            case "product":
                db.Products.Remove(await db.Products.FindAsync(id)
                    ?? throw new InvalidOperationException("Product not found."));
                break;
            case "model":
                db.ProductModels.Remove(await db.ProductModels.FindAsync(id)
                    ?? throw new InvalidOperationException("Model not found."));
                break;
            case "customer":
                db.Customers.Remove(await db.Customers.FindAsync(id)
                    ?? throw new InvalidOperationException("Customer not found."));
                break;
            case "carepacktype":
                db.CarePackTypeMasters.Remove(await db.CarePackTypeMasters.FindAsync(id)
                    ?? throw new InvalidOperationException("Type not found."));
                break;
            default:
                throw new InvalidOperationException("Unknown master kind.");
        }
        await db.SaveChangesAsync();
    }

    static async Task<string?> ComputeDeleteBlockAsync(AppDbContext db, string kind, int id)
    {
        switch (kind.ToLowerInvariant())
        {
            case "oem":
                if (!await db.OemVendors.AnyAsync(o => o.Id == id))
                    return "OEM not found.";
                var oemProducts = await db.Products.CountAsync(p => p.OemVendorId == id);
                if (oemProducts > 0)
                    return $"Cannot delete: {oemProducts} product(s) still linked. Remove products first.";
                var oemBatches = await db.CarePackBatches.CountAsync(b => b.OemVendorId == id);
                if (oemBatches > 0)
                    return $"Cannot delete: used on {oemBatches} Care Pack batch(es). Disable instead.";
                return null;

            case "product":
                if (!await db.Products.AnyAsync(p => p.Id == id))
                    return "Product not found.";
                var models = await db.ProductModels.CountAsync(m => m.ProductId == id);
                if (models > 0)
                    return $"Cannot delete: {models} model(s) still linked. Remove models first.";
                var prodBatches = await db.CarePackBatches.CountAsync(b => b.ProductId == id);
                if (prodBatches > 0)
                    return $"Cannot delete: used on {prodBatches} Care Pack batch(es). Disable instead.";
                return null;

            case "model":
                if (!await db.ProductModels.AnyAsync(m => m.Id == id))
                    return "Model not found.";
                var modelBatches = await db.CarePackBatches.CountAsync(b => b.ProductModelId == id);
                var devices = await db.CarePackDevices.CountAsync(d => d.ProductModelId == id);
                var tickets = await db.RMATickets.CountAsync(t => t.ProductModelId == id);
                if (modelBatches + devices + tickets > 0)
                    return $"Cannot delete: used on {modelBatches} batch(es), {devices} device(s), {tickets} RMA ticket(s). Disable instead.";
                return null;

            case "customer":
                if (!await db.Customers.AnyAsync(c => c.Id == id))
                    return "Customer not found.";
                var custBatches = await db.CarePackBatches.CountAsync(b => b.CustomerId == id);
                var custTickets = await db.RMATickets.CountAsync(t => t.CustomerId == id);
                if (custBatches + custTickets > 0)
                    return $"Cannot delete: used on {custBatches} Care Pack batch(es) and {custTickets} RMA ticket(s). Disable instead.";
                return null;

            case "carepacktype":
                if (!await db.CarePackTypeMasters.AnyAsync(t => t.Id == id))
                    return "Type not found.";
                var typeBatches = await db.CarePackBatches.CountAsync(b => b.CarePackTypeId == id);
                if (typeBatches > 0)
                    return $"Cannot delete: used on {typeBatches} Care Pack batch(es). Disable instead.";
                return null;

            default:
                return "Unknown master kind.";
        }
    }

    // ── Seed / Excel import ──────────────────────────────────────────────────

    /// <summary>Import catalog OEM → Product → Model and Care Pack Types for the current company only.</summary>
    public async Task SeedCurrentCompanyAsync()
    {
        await EnsureCanManageAsync();
        await using var db = await ScopedDbAsync();
        var companyId = db.TenantCompanyId;
        if (companyId <= 0)
            throw new InvalidOperationException("No company selected.");
        await SeedCompanyAsync(db, companyId);
        await db.SaveChangesAsync();
    }

    public byte[] BuildImportTemplate()
    {
        using var wb = new XLWorkbook();

        var cust = wb.AddWorksheet("Customers");
        cust.Cell(1, 1).Value = "Code";
        cust.Cell(1, 2).Value = "Name";
        cust.Cell(1, 3).Value = "City";
        cust.Cell(1, 4).Value = "State";
        cust.Cell(1, 5).Value = "Address";
        cust.Cell(1, 6).Value = "Phone";
        cust.Cell(1, 7).Value = "Email";
        cust.Cell(1, 8).Value = "Gstin";
        cust.Cell(2, 1).Value = "ACME";
        cust.Cell(2, 2).Value = "Acme Traders";
        cust.Cell(2, 3).Value = "Pune";
        cust.Cell(2, 4).Value = "Maharashtra";

        var oems = wb.AddWorksheet("OEMs");
        oems.Cell(1, 1).Value = "Code";
        oems.Cell(1, 2).Value = "Name";
        oems.Cell(2, 1).Value = "TSC";
        oems.Cell(2, 2).Value = "TSC";

        var products = wb.AddWorksheet("Products");
        products.Cell(1, 1).Value = "OemCode";
        products.Cell(1, 2).Value = "Code";
        products.Cell(1, 3).Value = "Name";
        products.Cell(2, 1).Value = "TSC";
        products.Cell(2, 2).Value = "TSC";
        products.Cell(2, 3).Value = "TSC Printers";

        var models = wb.AddWorksheet("Models");
        models.Cell(1, 1).Value = "ProductCode";
        models.Cell(1, 2).Value = "Code";
        models.Cell(1, 3).Value = "Name";
        models.Cell(2, 1).Value = "TSC";
        models.Cell(2, 2).Value = "T6304E";
        models.Cell(2, 3).Value = "T6304E";

        var types = wb.AddWorksheet("CarePackTypes");
        types.Cell(1, 1).Value = "Name";
        types.Cell(1, 2).Value = "DurationYears";
        types.Cell(2, 1).Value = "3 Year";
        types.Cell(2, 2).Value = 3;

        var notes = wb.AddWorksheet("README");
        notes.Cell(1, 1).Value =
            "Fill OEMs first, then Products (OemCode must match OEMs.Code), then Models (ProductCode must match Products.Code). " +
            "Existing Code/Name rows are updated; blanks for Code are derived from Name. City/State are free text.";

        using var ms = new MemoryStream();
        wb.SaveAs(ms);
        return ms.ToArray();
    }

    public async Task<MasterImportResult> ImportFromExcelAsync(Stream stream)
    {
        await EnsureCanManageAsync();
        var created = 0;
        var updated = 0;
        var skipped = 0;
        var errors = new List<string>();

        using var wb = new XLWorkbook(stream);
        await using var db = await ScopedDbAsync();
        var companyId = db.TenantCompanyId;
        if (companyId <= 0)
            throw new InvalidOperationException("No company selected.");

        // OEMs
        if (TrySheet(wb, "OEMs", out var oemSheet))
        {
            var map = HeaderMap(oemSheet);
            var last = oemSheet.LastRowUsed()?.RowNumber() ?? 1;
            for (var r = 2; r <= last; r++)
            {
                try
                {
                    var name = Cell(oemSheet, r, map, "Name");
                    if (string.IsNullOrWhiteSpace(name)) { skipped++; continue; }
                    var code = NormalizeCode(Cell(oemSheet, r, map, "Code"), name);
                    var row = await db.OemVendors.FirstOrDefaultAsync(o => o.Code == code);
                    if (row == null)
                    {
                        db.OemVendors.Add(new OemVendor
                        {
                            CompanyId = companyId,
                            Code = code,
                            Name = name.Trim(),
                            IsActive = true,
                            CreatedAt = DateTime.Now,
                        });
                        created++;
                    }
                    else
                    {
                        row.Name = name.Trim();
                        row.IsActive = true;
                        updated++;
                    }
                }
                catch (Exception ex) { errors.Add($"OEMs row {r}: {ex.Message}"); }
            }
            await db.SaveChangesAsync();
        }

        // Products
        if (TrySheet(wb, "Products", out var prodSheet))
        {
            var map = HeaderMap(prodSheet);
            var last = prodSheet.LastRowUsed()?.RowNumber() ?? 1;
            for (var r = 2; r <= last; r++)
            {
                try
                {
                    var name = Cell(prodSheet, r, map, "Name");
                    var oemCodeRaw = Cell(prodSheet, r, map, "OemCode");
                    if (string.IsNullOrWhiteSpace(name) || string.IsNullOrWhiteSpace(oemCodeRaw))
                    { skipped++; continue; }
                    var oemCode = NormalizeCode(oemCodeRaw, oemCodeRaw);
                    var oem = await db.OemVendors.FirstOrDefaultAsync(o => o.Code == oemCode)
                        ?? throw new InvalidOperationException($"OEM code '{oemCode}' not found.");
                    var code = NormalizeCode(Cell(prodSheet, r, map, "Code"), name);
                    var row = await db.Products.FirstOrDefaultAsync(p => p.Code == code);
                    if (row == null)
                    {
                        db.Products.Add(new Product
                        {
                            CompanyId = companyId,
                            OemVendorId = oem.Id,
                            Code = code,
                            Name = name.Trim(),
                            IsActive = true,
                            CreatedAt = DateTime.Now,
                        });
                        created++;
                    }
                    else
                    {
                        row.OemVendorId = oem.Id;
                        row.Name = name.Trim();
                        row.IsActive = true;
                        updated++;
                    }
                }
                catch (Exception ex) { errors.Add($"Products row {r}: {ex.Message}"); }
            }
            await db.SaveChangesAsync();
        }

        // Models
        if (TrySheet(wb, "Models", out var modelSheet))
        {
            var map = HeaderMap(modelSheet);
            var last = modelSheet.LastRowUsed()?.RowNumber() ?? 1;
            for (var r = 2; r <= last; r++)
            {
                try
                {
                    var productCodeRaw = Cell(modelSheet, r, map, "ProductCode");
                    var codeRaw = Cell(modelSheet, r, map, "Code");
                    if (string.IsNullOrWhiteSpace(productCodeRaw) || string.IsNullOrWhiteSpace(codeRaw))
                    { skipped++; continue; }
                    var productCode = NormalizeCode(productCodeRaw, productCodeRaw);
                    var product = await db.Products.FirstOrDefaultAsync(p => p.Code == productCode)
                        ?? throw new InvalidOperationException($"Product code '{productCode}' not found.");
                    var code = NormalizeCode(codeRaw, codeRaw);
                    var name = Cell(modelSheet, r, map, "Name");
                    name = string.IsNullOrWhiteSpace(name) ? code : name.Trim();
                    var row = await db.ProductModels.FirstOrDefaultAsync(m => m.ProductId == product.Id && m.Code == code);
                    if (row == null)
                    {
                        db.ProductModels.Add(new ProductModel
                        {
                            CompanyId = companyId,
                            ProductId = product.Id,
                            Code = code,
                            Name = name,
                            IsActive = true,
                            CreatedAt = DateTime.Now,
                        });
                        created++;
                    }
                    else
                    {
                        row.Name = name;
                        row.IsActive = true;
                        updated++;
                    }
                }
                catch (Exception ex) { errors.Add($"Models row {r}: {ex.Message}"); }
            }
            await db.SaveChangesAsync();
        }

        // Customers
        if (TrySheet(wb, "Customers", out var custSheet))
        {
            var map = HeaderMap(custSheet);
            var last = custSheet.LastRowUsed()?.RowNumber() ?? 1;
            for (var r = 2; r <= last; r++)
            {
                try
                {
                    var name = Cell(custSheet, r, map, "Name");
                    if (string.IsNullOrWhiteSpace(name)) { skipped++; continue; }
                    var code = NormalizeCode(Cell(custSheet, r, map, "Code"), name);
                    var row = await db.Customers.FirstOrDefaultAsync(c => c.Code == code);
                    if (row == null)
                    {
                        db.Customers.Add(new Customer
                        {
                            CompanyId = companyId,
                            Code = code,
                            Name = name.Trim(),
                            City = NullIfEmpty(Cell(custSheet, r, map, "City")),
                            State = NullIfEmpty(Cell(custSheet, r, map, "State")),
                            Address = NullIfEmpty(Cell(custSheet, r, map, "Address")),
                            Phone = NullIfEmpty(Cell(custSheet, r, map, "Phone")),
                            Email = NullIfEmpty(Cell(custSheet, r, map, "Email")),
                            Gstin = NullIfEmpty(Cell(custSheet, r, map, "Gstin")),
                            Country = "India",
                            IsActive = true,
                            CreatedAt = DateTime.Now,
                        });
                        created++;
                    }
                    else
                    {
                        row.Name = name.Trim();
                        row.City = NullIfEmpty(Cell(custSheet, r, map, "City")) ?? row.City;
                        row.State = NullIfEmpty(Cell(custSheet, r, map, "State")) ?? row.State;
                        row.Address = NullIfEmpty(Cell(custSheet, r, map, "Address")) ?? row.Address;
                        row.Phone = NullIfEmpty(Cell(custSheet, r, map, "Phone")) ?? row.Phone;
                        row.Email = NullIfEmpty(Cell(custSheet, r, map, "Email")) ?? row.Email;
                        row.Gstin = NullIfEmpty(Cell(custSheet, r, map, "Gstin")) ?? row.Gstin;
                        row.IsActive = true;
                        updated++;
                    }
                }
                catch (Exception ex) { errors.Add($"Customers row {r}: {ex.Message}"); }
            }
            await db.SaveChangesAsync();
        }

        // Care pack types
        if (TrySheet(wb, "CarePackTypes", out var typeSheet))
        {
            var map = HeaderMap(typeSheet);
            var last = typeSheet.LastRowUsed()?.RowNumber() ?? 1;
            for (var r = 2; r <= last; r++)
            {
                try
                {
                    var name = Cell(typeSheet, r, map, "Name");
                    if (string.IsNullOrWhiteSpace(name)) { skipped++; continue; }
                    var yearsText = Cell(typeSheet, r, map, "DurationYears");
                    if (!int.TryParse(yearsText, out var years) || years is < 1 or > 10)
                        years = OemBrandCatalog.DetectDurationYears(name) ?? 5;
                    var row = await db.CarePackTypeMasters.FirstOrDefaultAsync(t => t.Name == name.Trim());
                    if (row == null)
                    {
                        db.CarePackTypeMasters.Add(new CarePackTypeMaster
                        {
                            CompanyId = companyId,
                            Name = name.Trim(),
                            DurationYears = years,
                            IsActive = true,
                            CreatedAt = DateTime.Now,
                        });
                        created++;
                    }
                    else
                    {
                        row.DurationYears = years;
                        row.IsActive = true;
                        updated++;
                    }
                }
                catch (Exception ex) { errors.Add($"CarePackTypes row {r}: {ex.Message}"); }
            }
            await db.SaveChangesAsync();
        }

        if (created + updated + skipped + errors.Count == 0)
            errors.Add("No recognized sheets (OEMs, Products, Models, Customers, CarePackTypes).");

        return new MasterImportResult(created, updated, skipped, errors);
    }

    static bool TrySheet(XLWorkbook wb, string name, out IXLWorksheet sheet)
    {
        sheet = wb.Worksheets.FirstOrDefault(w =>
            string.Equals(w.Name, name, StringComparison.OrdinalIgnoreCase))!;
        return sheet != null;
    }

    static Dictionary<string, int> HeaderMap(IXLWorksheet sheet)
    {
        var map = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        var lastCol = sheet.LastColumnUsed()?.ColumnNumber() ?? 0;
        for (var c = 1; c <= lastCol; c++)
        {
            var h = sheet.Cell(1, c).GetString().Trim();
            if (h.Length > 0 && !map.ContainsKey(h))
                map[h] = c;
        }
        return map;
    }

    static string Cell(IXLWorksheet sheet, int row, Dictionary<string, int> map, string header)
    {
        if (!map.TryGetValue(header, out var col)) return "";
        return sheet.Cell(row, col).GetFormattedString().Trim();
    }

    public async Task<Customer?> FindCustomerByNameAsync(string? name)
    {
        if (string.IsNullOrWhiteSpace(name)) return null;
        await using var db = await ScopedDbAsync();
        var n = name.Trim();
        return await db.Customers.AsNoTracking()
            .FirstOrDefaultAsync(c => c.IsActive && c.Name == n);
    }

    public async Task<(OemVendor? Oem, Product? Product, ProductModel? Model)> ResolveOemProductModelAsync(
        string? brand, string? modelCode)
    {
        await using var db = await ScopedDbAsync();
        OemVendor? oem = null;
        Product? product = null;
        ProductModel? model = null;

        if (!string.IsNullOrWhiteSpace(brand))
        {
            var b = brand.Trim();
            oem = await db.OemVendors.AsNoTracking()
                .FirstOrDefaultAsync(o => o.IsActive && (o.Name == b || o.Code == b));
        }

        if (!string.IsNullOrWhiteSpace(modelCode))
        {
            var m = modelCode.Trim();
            model = await db.ProductModels.AsNoTracking()
                .Include(x => x.Product).ThenInclude(p => p.OemVendor)
                .FirstOrDefaultAsync(x => x.IsActive && (x.Code == m || x.Name == m));
            if (model != null)
            {
                product = model.Product;
                oem ??= model.Product.OemVendor;
            }
        }

        if (product == null && oem != null)
        {
            product = await db.Products.AsNoTracking()
                .FirstOrDefaultAsync(p => p.IsActive && p.OemVendorId == oem.Id);
        }

        return (oem, product, model);
    }

    static string NormalizeCode(string? code, string? name)
    {
        var c = (code ?? "").Trim().ToUpperInvariant();
        if (!string.IsNullOrEmpty(c)) return c.Length > 40 ? c[..40] : c;
        return MakeCode(name ?? "NEW");
    }

    static string? NullIfEmpty(string? s) =>
        string.IsNullOrWhiteSpace(s) ? null : s.Trim();
}
