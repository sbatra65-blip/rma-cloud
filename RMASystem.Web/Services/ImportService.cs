using System.Data;
using ExcelDataReader;
using Microsoft.EntityFrameworkCore;
using RMASystem.Data;
using RMASystem.Models;

namespace RMASystem.Services;

public class ImportResult
{
    public int TotalRows      { get; set; }
    public int Imported       { get; set; }
    public int Duplicates     { get; set; }
    public int Errors         { get; set; }
    public List<string> DuplicateList { get; set; } = new();
    public List<string> ErrorList     { get; set; } = new();
}

public class ImportPreview
{
    public List<string> Columns    { get; set; } = new();
    public List<Dictionary<string, string>> SampleRows { get; set; } = new();
    public int TotalRows { get; set; }
}

public static class ImportSystemFields
{
    public static readonly List<(string Key, string Label, bool Required)> Fields =
    [
        ("printer_sn",            "Printer Serial Number *", true),
        ("printer_model",         "Printer Model",           false),
        ("customer_company",      "Customer Company",        false),
        ("customer_address",      "Customer Address",        false),
        ("customer_city",         "Customer City",           false),
        ("customer_contact_name", "Customer Contact Name",   false),
        ("customer_email",        "Customer Email",          false),
        ("customer_phone",        "Customer Phone",          false),
        ("po_number",             "PO Number",               false),
        ("shipto_company",        "Ship-To Company",         false),
        ("shipto_address",        "Ship-To Address",         false),
        ("faulty_part",           "Faulty Part",             false),
        ("faulty_part_sn",        "Faulty Part SN",          false),
        ("faulty_part_no",        "Faulty Part Number",      false),
        ("failure_description",   "Failure Description",     false),
        ("tph_mileage",           "TPH Mileage (M)",         false),
        ("printer_mileage",       "Printer Mileage (M)",     false),
        ("fw_version",            "FW Version",              false),
        ("flash_initialized",     "Flash Initialized",       false),
        ("purchase_date",         "Purchase Date",           false),
        ("oem_rma_number",        "OEM RMA Number",          false),
        ("oem_rma_assign_date",   "OEM RMA Assign Date",     false),
        ("status",                "Status",                  false),
        ("created_at",            "Date RMA Raised",         false),
    ];
}

public class ImportService(AppDbContext db, TicketService ticketSvc)
{
    private static readonly Dictionary<string, string> StatusMap = new(
        StringComparer.OrdinalIgnoreCase)
    {
        ["open"]                    = RMAStatus.Open,
        ["new"]                     = RMAStatus.Open,
        ["raised"]                  = RMAStatus.Open,
        ["pending"]                 = RMAStatus.Open,
        ["sent to tsc"]             = RMAStatus.AwaitingOemRma,
        ["awaiting rma"]            = RMAStatus.AwaitingOemRma,
        ["email sent"]              = RMAStatus.AwaitingOemRma,
        ["sent to oem"]             = RMAStatus.AwaitingOemRma,
        ["rma received"]            = RMAStatus.OemRmaReceived,
        ["tsc approved"]            = RMAStatus.OemRmaReceived,
        ["oem rma received"]        = RMAStatus.OemRmaReceived,
        ["dispatched to tsc"]       = RMAStatus.DispatchedToOem,
        ["shipped to oem"]          = RMAStatus.DispatchedToOem,
        ["dispatched to oem"]       = RMAStatus.DispatchedToOem,
        ["received from tsc"]       = RMAStatus.GoodsReceivedFromOem,
        ["goods in"]                = RMAStatus.GoodsReceivedFromOem,
        ["received from oem"]       = RMAStatus.GoodsReceivedFromOem,
        ["sent to customer"]        = RMAStatus.DispatchedToCustomer,
        ["challan done"]            = RMAStatus.DispatchedToCustomer,
        ["dispatched to customer"]  = RMAStatus.DispatchedToCustomer,
        ["closed"]                  = RMAStatus.Closed,
        ["done"]                    = RMAStatus.Closed,
        ["complete"]                = RMAStatus.Closed,
        ["returned"]                = RMAStatus.ClosedReturned,
        ["rejected"]                = RMAStatus.ClosedReturned,
        ["customer returned"]       = RMAStatus.ClosedReturned,
    };

    public ImportPreview Preview(Stream fileStream)
    {
        System.Text.Encoding.RegisterProvider(System.Text.CodePagesEncodingProvider.Instance);
        using var reader = ExcelReaderFactory.CreateReader(fileStream);
        var ds = reader.AsDataSet(new ExcelDataSetConfiguration
        {
            ConfigureDataTable = _ => new ExcelDataTableConfiguration { UseHeaderRow = true }
        });
        var table = ds.Tables[0];
        var preview = new ImportPreview
        {
            TotalRows = table.Rows.Count,
            Columns   = table.Columns.Cast<DataColumn>()
                             .Select(c => c.ColumnName).ToList()
        };
        foreach (DataRow row in table.Rows.Cast<DataRow>().Take(5))
        {
            var dict = new Dictionary<string, string>();
            foreach (DataColumn col in table.Columns)
                dict[col.ColumnName] = row[col]?.ToString() ?? "";
            preview.SampleRows.Add(dict);
        }
        return preview;
    }

    public async Task<ImportResult> RunImportAsync(
        Stream fileStream,
        string filename,
        Dictionary<string, string> mapping) // {systemField: excelColumn}
    {
        System.Text.Encoding.RegisterProvider(System.Text.CodePagesEncodingProvider.Instance);
        using var reader = ExcelReaderFactory.CreateReader(fileStream);
        var ds = reader.AsDataSet(new ExcelDataSetConfiguration
        {
            ConfigureDataTable = _ => new ExcelDataTableConfiguration { UseHeaderRow = true }
        });
        var table = ds.Tables[0];
        var result = new ImportResult { TotalRows = table.Rows.Count };

        string Col(DataRow row, string field)
        {
            if (!mapping.TryGetValue(field, out var col)) return "";
            if (!table.Columns.Contains(col)) return "";
            return row[col]?.ToString()?.Trim() ?? "";
        }

        DateOnly? SafeDate(string val)
        {
            if (string.IsNullOrWhiteSpace(val)) return null;
            return DateTime.TryParse(val, out var d) ? DateOnly.FromDateTime(d) : null;
        }

        decimal? SafeDecimal(string val) =>
            decimal.TryParse(val, out var d) ? d : null;

        int rowNum = 1;
        foreach (DataRow row in table.Rows)
        {
            rowNum++;
            var printerSn = Col(row, "printer_sn");

            // Duplicate check — Printer SN
            if (!string.IsNullOrEmpty(printerSn))
            {
                var exists = await db.RMATickets
                    .AnyAsync(t => t.PrinterSn == printerSn);
                if (exists)
                {
                    result.Duplicates++;
                    result.DuplicateList.Add(
                        $"Row {rowNum}: Printer SN '{printerSn}' already exists");
                    continue;
                }
            }

            // Duplicate check — OEM RMA#
            var oemRma = Col(row, "oem_rma_number");
            if (!string.IsNullOrEmpty(oemRma))
            {
                var exists = await db.RMATickets
                    .AnyAsync(t => t.OemRmaNumber == oemRma);
                if (exists)
                {
                    result.Duplicates++;
                    result.DuplicateList.Add(
                        $"Row {rowNum}: OEM RMA# '{oemRma}' already exists");
                    continue;
                }
            }

            try
            {
                var rawDate = Col(row, "created_at");
                DateTime? originalDate = DateTime.TryParse(rawDate, out var pd) ? pd : null;

                var ticketNo = await ticketSvc.GenerateImportTicketNumberAsync(originalDate);
                var statusRaw = Col(row, "status");
                var status = StatusMap.TryGetValue(statusRaw, out var s)
                    ? s : RMAStatus.Open;

                var ticket = new RMATicket
                {
                    InternalTicketNo    = ticketNo,
                    Status              = status,
                    IsImported          = true,
                    CreatedAt           = originalDate ?? DateTime.Now,
                    UpdatedAt           = DateTime.Now,
                    CustomerCompany     = Col(row, "customer_company").NullIfEmpty(),
                    CustomerAddress     = Col(row, "customer_address").NullIfEmpty(),
                    CustomerCity        = Col(row, "customer_city").NullIfEmpty(),
                    CustomerContactName = Col(row, "customer_contact_name").NullIfEmpty(),
                    CustomerEmail       = Col(row, "customer_email").NullIfEmpty(),
                    CustomerPhone       = Col(row, "customer_phone").NullIfEmpty(),
                    PoNumber            = Col(row, "po_number").NullIfEmpty(),
                    ShipToCompany       = Col(row, "shipto_company").NullIfEmpty(),
                    ShipToAddress       = Col(row, "shipto_address").NullIfEmpty(),
                    PrinterModel        = Col(row, "printer_model").NullIfEmpty(),
                    PrinterSn           = printerSn.NullIfEmpty(),
                    FaultyPart          = Col(row, "faulty_part").NullIfEmpty(),
                    FaultyPartSn        = Col(row, "faulty_part_sn").NullIfEmpty(),
                    FaultyPartNo        = Col(row, "faulty_part_no").NullIfEmpty(),
                    FailureDescription  = Col(row, "failure_description").NullIfEmpty(),
                    TphMileage          = SafeDecimal(Col(row, "tph_mileage")),
                    PrinterMileage      = SafeDecimal(Col(row, "printer_mileage")),
                    FwVersion           = Col(row, "fw_version").NullIfEmpty(),
                    FlashInitialized    = Col(row, "flash_initialized").NullIfEmpty(),
                    PurchaseDate        = SafeDate(Col(row, "purchase_date")),
                    OemRmaNumber        = oemRma.NullIfEmpty(),
                    OemRmaAssignDate    = SafeDate(Col(row, "oem_rma_assign_date")),
                };
                db.RMATickets.Add(ticket);
                await db.SaveChangesAsync();
                result.Imported++;
            }
            catch (Exception ex)
            {
                result.Errors++;
                result.ErrorList.Add($"Row {rowNum}: {ex.Message}");
            }
        }

        // Save import log
        db.ImportLogs.Add(new ImportLog
        {
            Filename       = filename,
            TotalRows      = result.TotalRows,
            ImportedCount  = result.Imported,
            DuplicateCount = result.Duplicates,
            ErrorCount     = result.Errors,
            SummaryText    = string.Join("\n",
                result.DuplicateList.Concat(result.ErrorList)),
        });
        await db.SaveChangesAsync();
        return result;
    }
}

file static class StringExtensions
{
    public static string? NullIfEmpty(this string? s) =>
        string.IsNullOrWhiteSpace(s) ? null : s;
}
