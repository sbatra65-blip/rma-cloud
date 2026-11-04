using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using RMASystem.Data;
using RMASystem.Services;

namespace RMASystem.Controllers;

[ApiController]
[Authorize]
public class DownloadController(AppDbContext db, ExcelService excel) : ControllerBase
{
    [HttpGet("/api/excel/{ticketId:int}")]
    public async Task<IActionResult> DownloadExcel(int ticketId, [FromQuery] bool regenerate = false)
    {
        var ticket = await db.RMATickets
            .Include(t => t.Photos)
            .FirstOrDefaultAsync(t => t.Id == ticketId);
        if (ticket == null)
            return NotFound("Ticket not found.");

        if (regenerate || string.IsNullOrWhiteSpace(ticket.ExcelFilePath) || !System.IO.File.Exists(ticket.ExcelFilePath))
            await excel.GenerateRmaFormAsync(ticket);

        var (bytes, filename) = await excel.GetOemExcelBytesAsync(ticket);
        return File(bytes,
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            filename);
    }

    [HttpGet("/api/photo/{photoId:int}")]
    public async Task<IActionResult> DownloadPhoto(int photoId)
    {
        var photo = await db.RMAPhotos.FindAsync(photoId);
        if (photo == null || !System.IO.File.Exists(photo.FilePath))
            return NotFound("Photo not found.");

        var bytes = await System.IO.File.ReadAllBytesAsync(photo.FilePath);
        var ext = Path.GetExtension(photo.FilePath).ToLowerInvariant();
        var contentType = ext switch
        {
            ".png" => "image/png",
            ".gif" => "image/gif",
            ".webp" => "image/webp",
            ".bmp" => "image/bmp",
            _ => "image/jpeg",
        };
        return File(bytes, contentType);
    }

    [HttpGet("/api/batch-download/{batchId}")]
    public async Task<IActionResult> DownloadBatch(string batchId)
    {
        var batch = await db.MonthlyBatches
            .FirstOrDefaultAsync(b => b.BatchId == batchId);
        if (batch?.ExcelPath == null || !System.IO.File.Exists(batch.ExcelPath))
            return NotFound("Batch file not found.");

        var bytes    = await System.IO.File.ReadAllBytesAsync(batch.ExcelPath);
        var filename = Path.GetFileName(batch.ExcelPath);
        return File(bytes,
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            filename);
    }

    [HttpGet("/api/carepack/{batchId:int}/oem-invoice-pdf")]
    public async Task<IActionResult> DownloadOemInvoicePdf(int batchId)
    {
        var batch = await db.CarePackBatches.FindAsync(batchId);
        if (batch?.OemInvoicePdfPath == null || !System.IO.File.Exists(batch.OemInvoicePdfPath))
            return NotFound("OEM invoice PDF not found.");

        var bytes = await System.IO.File.ReadAllBytesAsync(batch.OemInvoicePdfPath);
        var filename = Path.GetFileName(batch.OemInvoicePdfPath);
        return File(bytes, "application/pdf", filename);
    }

    [HttpGet("/api/carepack/{batchId:int}/validation-report")]
    public async Task<IActionResult> DownloadValidationReport(int batchId)
    {
        var batch = await db.CarePackBatches.FindAsync(batchId);
        if (batch?.ValidationReportPath == null || !System.IO.File.Exists(batch.ValidationReportPath))
            return NotFound("Validation report not found.");

        var bytes = await System.IO.File.ReadAllBytesAsync(batch.ValidationReportPath);
        var filename = Path.GetFileName(batch.ValidationReportPath);
        return File(bytes,
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            filename);
    }
}
