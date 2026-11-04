using ClosedXML.Excel;
using RMASystem;
using RMASystem.Data;
using RMASystem.Models;

namespace RMASystem.Services;

public class ExcelService(AppDbContext db)
{
    public const string OemTemplateFileName = "RMA_EXCEL_TEMPLATE.xlsx";

    private async Task<string> GetExcelDir(string ticketNo)
    {
        var baseDir = await db.GetSettingAsync("base_dir", AppPaths.DataRoot);
        var parts = ticketNo.Split('-');
        string year = DateTime.Now.Year.ToString();
        string month = DateTime.Now.Month.ToString("D2");
        if (parts.Length >= 3 && parts[2].Length == 6)
        {
            year  = parts[2][..4];
            month = parts[2][4..];
        }
        var dir = Path.Combine(baseDir, "Excel", year, month);
        Directory.CreateDirectory(dir);
        return dir;
    }

    /// <summary>
    /// OEM file name: PrinterModel_PrinterSerialNo_ProblematicPart.xlsx
    /// Example: TE 310_TEBT25370458_Head.xlsx
    /// </summary>
    public static string BuildOemExcelFileName(RMATicket ticket)
    {
        var model = SanitizeFilePart(ticket.PrinterModel, "Model");
        var sn = SanitizeFilePart(ticket.PrinterSn, "SN");
        var part = SanitizeFilePart(ticket.FaultyPart, "Part");
        return $"{model}_{sn}_{part}.xlsx";
    }

    static string SanitizeFilePart(string? value, string fallback)
    {
        var v = (value ?? "").Trim();
        if (string.IsNullOrWhiteSpace(v)) v = fallback;
        foreach (var c in Path.GetInvalidFileNameChars())
            v = v.Replace(c, '-');
        v = v.Replace('/', '-').Replace('\\', '-');
        while (v.Contains("  ")) v = v.Replace("  ", " ");
        return v;
    }

    /// <summary>
    /// Resolves the OEM RMA Excel template. Never writes to this path — only copies from it.
    /// </summary>
    public static string ResolveOemTemplatePath()
    {
        var candidates = new[]
        {
            Path.Combine(AppContext.BaseDirectory, "Templates", OemTemplateFileName),
            Path.Combine(Directory.GetCurrentDirectory(), "Templates", OemTemplateFileName),
            Path.Combine(AppContext.BaseDirectory, OemTemplateFileName),
        };
        foreach (var path in candidates)
        {
            if (File.Exists(path))
                return Path.GetFullPath(path);
        }
        throw new FileNotFoundException(
            $"OEM Excel template not found. Place {OemTemplateFileName} under Templates/ next to the app. " +
            $"Looked in: {string.Join("; ", candidates)}");
    }

    /// <summary>
    /// Creates OEM RMA Excel by copying <see cref="OemTemplateFileName"/> (never overwrites the template)
    /// and replacing @@placeholders@@. Photo tokens are only replaced when corresponding images exist.
    /// </summary>
    public async Task<string> GenerateRmaFormAsync(RMATicket ticket)
    {
        if (ticket.Photos == null || ticket.Photos.Count == 0)
            await db.Entry(ticket).Collection(t => t.Photos).LoadAsync();

        var templatePath = ResolveOemTemplatePath();
        var dir = await GetExcelDir(ticket.InternalTicketNo);
        var fname = BuildOemExcelFileName(ticket);
        var fpath = Path.Combine(dir, fname);

        // Never touch the template — always work on a fresh copy with OEM naming.
        File.Copy(templatePath, fpath, overwrite: true);

        if (!string.IsNullOrWhiteSpace(ticket.ExcelFilePath) &&
            !string.Equals(ticket.ExcelFilePath, fpath, StringComparison.OrdinalIgnoreCase) &&
            File.Exists(ticket.ExcelFilePath))
        {
            try { File.Delete(ticket.ExcelFilePath); } catch { /* ignore */ }
        }

        var textMap = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["@@PRINTER_MODEL@@"] = ticket.PrinterModel ?? "",
            ["@@PRINTER_SERIAL@@"] = ticket.PrinterSn ?? "",
            ["@@FAULTY_PART@@"] = ticket.FaultyPart ?? "",
            ["@@FAULTY_PART_SERIAL@@"] = ticket.FaultyPartSn ?? "",
            ["@@PART_CODE@@"] = ticket.FaultyPartNo ?? "",
            ["@@FAULTY_PART_NO@@"] = ticket.FaultyPartNo ?? "",
            ["@@FAULTY_PART_NUMBER@@"] = ticket.FaultyPartNo ?? "",
            ["@@PART_NO@@"] = ticket.FaultyPartNo ?? "",
            ["@@FAULT_DESCRIPTION@@"] = ticket.FailureDescription ?? "",
            ["@@TPH_MILAGE@@"] = FormatMileage(ticket.TphMileage),
            ["@@PRINTER_MILAGE@@"] = FormatMileage(ticket.PrinterMileage),
            ["@@FW_VERSION@@"] = ticket.FwVersion ?? "",
            ["@@FLASH_INITIALIZED@@"] = ticket.FlashInitialized ?? "",
            ["@@INTERNAL_TICKET@@"] = ticket.InternalTicketNo ?? "",
            ["@@OEM_RMA@@"] = ticket.OemRmaNumber ?? "",
            ["@@CUSTOMER@@"] = ticket.CustomerCompany ?? "",
        };

        var inboundPhotos = (ticket.Photos ?? Array.Empty<RMAPhoto>())
            .Where(p => string.Equals(p.Direction, "INBOUND", StringComparison.OrdinalIgnoreCase))
            .OrderBy(p => p.CapturedAt)
            .ThenBy(p => p.Id)
            .Take(5)
            .ToList();

        using (var wb = new XLWorkbook(fpath))
        {
            foreach (var ws in wb.Worksheets)
            {
                ReplaceTextPlaceholders(ws, textMap);
                EmbedPhotos(ws, inboundPhotos);
            }
            wb.Save();
        }

        foreach (var p in inboundPhotos)
            p.EmbeddedInExcel = File.Exists(p.FilePath);

        ticket.ExcelFilePath = Path.GetFullPath(fpath);
        ticket.UpdatedAt = DateTime.Now;
        await db.SaveChangesAsync();
        return ticket.ExcelFilePath;
    }

    static string FormatMileage(decimal? value) =>
        value.HasValue ? value.Value.ToString("0.##") : "";

    static void ReplaceTextPlaceholders(IXLWorksheet ws, Dictionary<string, string> map)
    {
        var used = ws.RangeUsed();
        if (used == null) return;

        foreach (var cell in used.CellsUsed())
        {
            string text;
            try { text = cell.GetString(); }
            catch { continue; }

            if (string.IsNullOrEmpty(text) || !text.Contains("@@", StringComparison.Ordinal))
                continue;

            // Photo tokens are handled separately — leave them for EmbedPhotos.
            var replaced = text;
            foreach (var (token, value) in map)
            {
                if (replaced.Contains(token, StringComparison.OrdinalIgnoreCase))
                    replaced = ReplaceIgnoreCase(replaced, token, value);
            }

            if (!string.Equals(replaced, text, StringComparison.Ordinal))
                cell.Value = replaced;
        }
    }

    /// <summary>
    /// Embeds up to 5 inbound photos. Only tokens with a real image file are removed;
    /// missing @@photoN@@ tokens stay in the sheet unchanged.
    /// </summary>
    static void EmbedPhotos(IXLWorksheet ws, List<RMAPhoto> photos)
    {
        if (photos.Count == 0) return;

        var used = ws.RangeUsed();
        if (used == null) return;

        // Prefer a shared photo-label cell as layout anchor; fall back to first photo token cell.
        IXLCell? layoutAnchor = null;
        foreach (var cell in used.CellsUsed())
        {
            var text = cell.GetString();
            if (text.Contains("@@photo", StringComparison.OrdinalIgnoreCase))
            {
                layoutAnchor ??= cell;
                break;
            }
        }
        if (layoutAnchor == null) return;

        const int photoW = 160;
        const int photoH = 120;
        const int gap = 12;
        var embedded = 0;

        for (var i = 0; i < 5; i++)
        {
            var token = $"@@photo{i + 1}@@";
            if (i >= photos.Count) break;

            var photo = photos[i];
            if (string.IsNullOrWhiteSpace(photo.FilePath) || !File.Exists(photo.FilePath))
                continue;

            IXLCell? tokenCell = null;
            foreach (var cell in used.CellsUsed())
            {
                if (cell.GetString().Contains(token, StringComparison.OrdinalIgnoreCase))
                {
                    tokenCell = cell;
                    break;
                }
            }
            if (tokenCell == null) continue;

            try
            {
                using var stream = File.OpenRead(photo.FilePath);
                var name = $"rma_photo_{i + 1}_{Guid.NewGuid():N}";
                ws.AddPicture(stream, name)
                    .MoveTo(layoutAnchor, embedded * (photoW + gap), 28)
                    .WithSize(photoW, photoH);

                tokenCell.Value = CollapseSpaces(ReplaceIgnoreCase(tokenCell.GetString(), token, ""));
                embedded++;
            }
            catch
            {
                // Keep placeholder token if the image cannot be embedded.
            }
        }
    }

    static string ReplaceIgnoreCase(string input, string oldValue, string newValue)
    {
        if (string.IsNullOrEmpty(oldValue)) return input;
        var sb = new System.Text.StringBuilder();
        var searchFrom = 0;
        int idx;
        var found = false;
        while ((idx = input.IndexOf(oldValue, searchFrom, StringComparison.OrdinalIgnoreCase)) >= 0)
        {
            found = true;
            sb.Append(input, searchFrom, idx - searchFrom);
            sb.Append(newValue);
            searchFrom = idx + oldValue.Length;
        }
        if (!found) return input;
        sb.Append(input, searchFrom, input.Length - searchFrom);
        return sb.ToString();
    }

    static string CollapseSpaces(string s)
    {
        while (s.Contains("  ", StringComparison.Ordinal))
            s = s.Replace("  ", " ", StringComparison.Ordinal);
        return s.Trim();
    }

    /// <summary>Read generated OEM Excel bytes (regenerates if missing / old name).</summary>
    public async Task<(byte[] Bytes, string FileName)> GetOemExcelBytesAsync(RMATicket ticket)
    {
        var fname = BuildOemExcelFileName(ticket);
        if (string.IsNullOrWhiteSpace(ticket.ExcelFilePath) || !File.Exists(ticket.ExcelFilePath) ||
            !string.Equals(Path.GetFileName(ticket.ExcelFilePath), fname, StringComparison.OrdinalIgnoreCase))
        {
            await GenerateRmaFormAsync(ticket);
        }

        var bytes = await File.ReadAllBytesAsync(ticket.ExcelFilePath!);
        return (bytes, fname);
    }

    /// <summary>Generates the monthly batch packing list Excel.</summary>
    public async Task<string> GenerateBatchExcelAsync(
        List<RMATicket> tickets, string batchId, DateOnly dispatchDate)
    {
        var baseDir = await db.GetSettingAsync("base_dir", AppPaths.DataRoot);
        var dir = Path.Combine(baseDir, "Batches", batchId);
        Directory.CreateDirectory(dir);

        using var wb = new XLWorkbook();
        var ws = wb.Worksheets.Add("Packing List");

        ws.Range("A1:K1").Merge().Value =
            $"Monthly OEM Batch Packing List — {batchId}";
        ws.Range("A1:K1").Style
            .Font.SetBold(true).Font.SetFontSize(13).Font.SetFontColor(XLColor.White)
            .Fill.SetBackgroundColor(XLColor.FromHtml("#1F4E79"))
            .Alignment.SetHorizontal(XLAlignmentHorizontalValues.Center);

        ws.Range("A2:K2").Merge().Value =
            $"Dispatch Date: {dispatchDate:dd-MMM-yyyy}   |   " +
            $"Generated: {DateTime.Now:dd MMM yyyy HH:mm}";
        ws.Range("A2:K2").Style
            .Alignment.SetHorizontal(XLAlignmentHorizontalValues.Center)
            .Font.SetFontSize(9).Font.SetFontColor(XLColor.Gray);

        var headers = new[]
        {
            "S.No.", "Internal Ticket #", "OEM RMA #", "Printer Model",
            "Printer SN", "Faulty Part", "Faulty Part SN",
            "Failure Description", "Customer Name", "Date Raised", "Dispatch Date"
        };
        var widths = new[] { 6, 22, 20, 15, 18, 15, 15, 30, 20, 15, 15 };
        for (int i = 0; i < headers.Length; i++)
        {
            ws.Column(i + 1).Width = widths[i];
            var cell = ws.Cell(3, i + 1);
            cell.Value = headers[i];
            cell.Style.Font.SetBold(true)
                .Fill.SetBackgroundColor(XLColor.FromHtml("#D9D9D9"))
                .Border.SetOutsideBorder(XLBorderStyleValues.Thin)
                .Alignment.SetHorizontal(XLAlignmentHorizontalValues.Center);
        }

        for (int i = 0; i < tickets.Count; i++)
        {
            var t   = tickets[i];
            var row = i + 4;
            var bg  = i % 2 == 0 ? XLColor.FromHtml("#EBF3FB") : XLColor.White;
            var values = new object?[]
            {
                i + 1, t.InternalTicketNo, t.OemRmaNumber ?? "",
                t.PrinterModel ?? "", t.PrinterSn ?? "",
                t.FaultyPart ?? "", t.FaultyPartSn ?? "",
                t.FailureDescription ?? "", t.CustomerCompany ?? "",
                t.CreatedAt.ToString("dd-MMM-yyyy"),
                dispatchDate.ToString("dd-MMM-yyyy")
            };
            for (int c = 0; c < values.Length; c++)
            {
                var cell = ws.Cell(row, c + 1);
                cell.Value = values[c]?.ToString() ?? "";
                cell.Style.Border.SetOutsideBorder(XLBorderStyleValues.Thin)
                    .Fill.SetBackgroundColor(bg);
            }
        }

        int sr = tickets.Count + 5;
        ws.Range($"A{sr}:K{sr}").Merge().Value = $"Total RMAs in batch: {tickets.Count}";
        ws.Range($"A{sr}:K{sr}").Style.Font.SetBold(true)
            .Alignment.SetHorizontal(XLAlignmentHorizontalValues.Right);

        var fpath = Path.Combine(dir, $"{batchId}_PackingList.xlsx");
        wb.SaveAs(fpath);
        return fpath;
    }
}
