using System.Text.Json;
using RMASystem.Data;

namespace RMASystem.Services;

/// <summary>
/// Temporary Care Pack registration drafts on disk (survives page refresh / Zoho blips).
/// Not a registered batch — real save still runs all poka-yoke checks.
/// </summary>
public class CarePackDraftStore(AppDbContext db)
{
    static readonly JsonSerializerOptions JsonOpts = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    async Task<string> DraftDirAsync()
    {
        var baseDir = await db.GetSettingAsync("base_dir", AppPaths.DataRoot);
        var dir = Path.Combine(baseDir, "Drafts");
        Directory.CreateDirectory(dir);
        return dir;
    }

    static string SafeUser(string? userName)
    {
        var u = string.IsNullOrWhiteSpace(userName) ? "user" : userName.Trim();
        foreach (var c in Path.GetInvalidFileNameChars())
            u = u.Replace(c, '_');
        return u;
    }

    async Task<string> PdfPathAsync(string userName) =>
        Path.Combine(await DraftDirAsync(), $"carepack-pdf-{SafeUser(userName)}.json");

    async Task<string> ZohoPathAsync(string userName) =>
        Path.Combine(await DraftDirAsync(), $"carepack-zoho-{SafeUser(userName)}.json");

    public async Task SavePdfDraftAsync(string userName, CarePackPdfDraft draft)
    {
        draft.SavedAt = DateTime.Now;
        draft.UserName = userName;
        var path = await PdfPathAsync(userName);
        await File.WriteAllTextAsync(path, JsonSerializer.Serialize(draft, JsonOpts));
    }

    public async Task<CarePackPdfDraft?> LoadPdfDraftAsync(string userName)
    {
        var path = await PdfPathAsync(userName);
        if (!File.Exists(path)) return null;
        try
        {
            var json = await File.ReadAllTextAsync(path);
            return JsonSerializer.Deserialize<CarePackPdfDraft>(json, JsonOpts);
        }
        catch
        {
            return null;
        }
    }

    public async Task ClearPdfDraftAsync(string userName)
    {
        var path = await PdfPathAsync(userName);
        if (File.Exists(path)) File.Delete(path);
    }

    public async Task SaveZohoDraftAsync(string userName, CarePackZohoDraft draft)
    {
        draft.SavedAt = DateTime.Now;
        draft.UserName = userName;
        var path = await ZohoPathAsync(userName);
        await File.WriteAllTextAsync(path, JsonSerializer.Serialize(draft, JsonOpts));
    }

    public async Task<CarePackZohoDraft?> LoadZohoDraftAsync(string userName)
    {
        var path = await ZohoPathAsync(userName);
        if (!File.Exists(path)) return null;
        try
        {
            var json = await File.ReadAllTextAsync(path);
            return JsonSerializer.Deserialize<CarePackZohoDraft>(json, JsonOpts);
        }
        catch
        {
            return null;
        }
    }

    public async Task ClearZohoDraftAsync(string userName)
    {
        var path = await ZohoPathAsync(userName);
        if (File.Exists(path)) File.Delete(path);
    }
}

public class CarePackPdfDraft
{
    public string? UserName { get; set; }
    public DateTime SavedAt { get; set; }
    public string InvoiceNumber { get; set; } = "";
    public string? SourceInvoiceNumber { get; set; }
    public string? InvoiceEditReason { get; set; }
    public string? CustomerName { get; set; }
    public string? CustomerCity { get; set; }
    public DateTime? InvoiceDate { get; set; }
    public string? Irn { get; set; }
    public string? IrnAckNo { get; set; }
    public string? Notes { get; set; }
    public bool MarkAsOverride { get; set; }
    public string? OverrideReason { get; set; }
    public List<CarePackPdfDraftProduct> Products { get; set; } = new();
}

public class CarePackPdfDraftProduct
{
    public string ProductItemName { get; set; } = "";
    public string CarePackItemName { get; set; } = "";
    public string ProductModel { get; set; } = "";
    public string OemBrand { get; set; } = "";
    public string CarePackType { get; set; } = "";
    public int Qty { get; set; } = 1;
    public List<string> SerialSlots { get; set; } = new();
    public string PasteBlock { get; set; } = "";
}

public class CarePackZohoDraft
{
    public string? UserName { get; set; }
    public DateTime SavedAt { get; set; }
    public string InvoiceNumber { get; set; } = "";
    public string? ManualIrn { get; set; }
    public string? CorrBrand { get; set; }
    public string? CorrModel { get; set; }
    public string? CorrType { get; set; }
    public List<CarePackZohoDraftProduct> Products { get; set; } = new();
}

public class CarePackZohoDraftProduct
{
    public int LineSetIndex { get; set; }
    public bool Selected { get; set; } = true;
    public int Qty { get; set; }
    public string CarePackType { get; set; } = "";
    public List<string> SerialSlots { get; set; } = new();
    public string PasteBlock { get; set; } = "";
}
