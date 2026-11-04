using System.Net;
using System.Net.Mail;
using System.Text;
using Microsoft.EntityFrameworkCore;
using RMASystem.Data;
using RMASystem.Models;

namespace RMASystem.Services;

/// <summary>
/// OEM RMA email: SMTP send (optional) + copy-paste draft for Zoho Mail (no OAuth tokens).
/// </summary>
public class OemEmailService(AppDbContext db, UserSessionService session, CompanyService companies)
{
    public const string DefaultTo = "tsc_rma@tscprinters.com";

    async Task ScopeAsync() => await companies.ApplyFilterAsync(db);

    public async Task<(bool Ready, string Reason)> CanSendAsync(RMATicket ticket)
    {
        if (ticket == null) return (false, "Ticket not found.");
        if (string.IsNullOrWhiteSpace(ticket.ExcelFilePath) || !File.Exists(ticket.ExcelFilePath))
            return (false, "Generate / save OEM Excel first — email is blocked until the file exists.");

        var host = await db.GetSettingAsync("smtp_host");
        if (string.IsNullOrWhiteSpace(host))
            return (false, "SMTP host not configured (Settings → Email). Use Copy draft for Zoho Mail instead.");

        var to = await GetToAddressesAsync();
        if (to.Count == 0)
            return (false, "No OEM email recipients configured.");

        return (true, "Ready to send.");
    }

    /// <summary>Draft is always available — no SMTP / Zoho tokens required.</summary>
    public Task<(bool Ready, string Reason)> CanBuildDraftAsync(RMATicket ticket)
    {
        if (ticket == null) return Task.FromResult((false, "Ticket not found."));
        return Task.FromResult((true, "Ready."));
    }

    public async Task<List<string>> GetToAddressesAsync()
    {
        var raw = await db.GetSettingAsync("oem_rma_email_to", DefaultTo);
        return SplitEmails(raw);
    }

    public async Task<List<string>> GetCcAddressesAsync()
    {
        var raw = await db.GetSettingAsync("oem_rma_email_cc", "");
        return SplitEmails(raw);
    }

    static List<string> SplitEmails(string? raw) =>
        (raw ?? "")
            .Split(new[] { ',', ';', '\n', '\r' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(e => e.Contains('@'))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();

    public async Task<(string Subject, string Body)> BuildMessageAsync(RMATicket ticket)
    {
        var draft = await BuildCopyDraftAsync(ticket);
        return (draft.Subject, draft.PlainBody);
    }

    /// <summary>
    /// Subject + plain + HTML bodies for pasting into Zoho Mail (or any client).
    /// Subject matches OEM Excel stem (e.g. TE310_TEBT25513522_HEAD).
    /// </summary>
    public async Task<OemEmailDraft> BuildCopyDraftAsync(RMATicket ticket)
    {
        var map = await TokenMapAsync(ticket);
        string Apply(string tpl)
        {
            var s = tpl ?? "";
            foreach (var (k, v) in map)
                s = s.Replace("{{" + k + "}}", v, StringComparison.OrdinalIgnoreCase)
                     .Replace("@@" + k + "@@", v, StringComparison.OrdinalIgnoreCase);
            return s;
        }

        var subjectTpl = await db.GetSettingAsync("oem_rma_email_subject", "{{EXCEL_FILE_STEM}}");
        var bodyTpl = await db.GetSettingAsync("oem_rma_email_body", DefaultPlainBodyTemplate());
        var htmlTpl = await db.GetSettingAsync("oem_rma_email_body_html", DefaultHtmlBodyTemplate());

        var subject = Apply(subjectTpl).Trim();
        if (string.IsNullOrWhiteSpace(subject))
            subject = map.GetValueOrDefault("EXCEL_FILE_STEM") ?? ticket.InternalTicketNo ?? "RMA";

        return new OemEmailDraft(
            Subject: subject,
            PlainBody: Apply(bodyTpl).Trim(),
            HtmlBody: Apply(htmlTpl).Trim(),
            ToHint: string.Join("; ", await GetToAddressesAsync()),
            CcHint: string.Join("; ", await GetCcAddressesAsync()));
    }

    public static string DefaultPlainBodyTemplate() =>
        """
        Dear Sir,

        TSC {{PRINTER_MODEL}} printer {{FAULTY_PART}} is damaged. I sent it to you for the RMA please check it

        Gyan Pandey sir please look into these RMA and request for fast processing


        * {{FAULTY_PART}} Serial Number: {{FAULTY_PART_SERIAL}}
        * TSC Care pack Invoice No. : {{CARE_PACK_INVOICE}}
        * Printer Serial Number : {{PRINTER_SERIAL}}


        Kind regards,
        {{COMPANY_NAME}}
        {{COMPANY_EMAIL}}
        {{COMPANY_PHONE}}
        """;

    public static string DefaultHtmlBodyTemplate() =>
        """
        <p>Dear Sir,</p>
        <p>TSC <strong>{{PRINTER_MODEL}}</strong> printer <strong>{{FAULTY_PART}}</strong> is damaged. I sent it to you for the RMA please check it</p>
        <p>Gyan Pandey sir please look into these RMA and request for fast processing</p>
        <ul>
          <li><strong>{{FAULTY_PART}} Serial Number:</strong> {{FAULTY_PART_SERIAL}}</li>
          <li><strong>TSC Care pack Invoice No.:</strong> {{CARE_PACK_INVOICE}}</li>
          <li><strong>Printer Serial Number:</strong> {{PRINTER_SERIAL}}</li>
        </ul>
        <p>Kind regards,<br/>{{COMPANY_NAME}}<br/>{{COMPANY_EMAIL}}<br/>{{COMPANY_PHONE}}</p>
        """;

    public async Task<Dictionary<string, string>> TokenMapAsync(RMATicket ticket)
    {
        var excelName = !string.IsNullOrWhiteSpace(ticket.ExcelFilePath)
            ? Path.GetFileName(ticket.ExcelFilePath)
            : ExcelService.BuildOemExcelFileName(ticket);
        var stem = Path.GetFileNameWithoutExtension(excelName);

        var carePackInvoice = "";
        var sn = ticket.PrinterSn?.Trim();
        if (!string.IsNullOrEmpty(sn))
        {
            await ScopeAsync();
            var snUpper = sn.ToUpperInvariant();
            carePackInvoice = await (
                from d in db.CarePackDevices.AsNoTracking()
                join b in db.CarePackBatches.AsNoTracking() on d.CarePackBatchId equals b.Id
                where d.SerialNumber == sn || d.SerialNumber.ToUpper() == snUpper
                select b.InvoiceNumber
            ).FirstOrDefaultAsync() ?? "";
        }

        var partLabel = string.IsNullOrWhiteSpace(ticket.FaultyPart) ? "Head" : ticket.FaultyPart.Trim();
        var partSn = !string.IsNullOrWhiteSpace(ticket.FaultyPartSn)
            ? ticket.FaultyPartSn.Trim()
            : (ticket.PrinterSn ?? "");

        return new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["INTERNAL_TICKET"] = ticket.InternalTicketNo ?? "",
            ["CUSTOMER"] = ticket.CustomerCompany ?? "",
            ["PRINTER_MODEL"] = ticket.PrinterModel ?? "",
            ["PRINTER_SERIAL"] = ticket.PrinterSn ?? "",
            ["FAULTY_PART"] = partLabel,
            ["PART_CODE"] = ticket.FaultyPartNo ?? "",
            ["FAULTY_PART_SERIAL"] = partSn,
            ["FAULT_DESCRIPTION"] = ticket.FailureDescription ?? "",
            ["TPH_MILAGE"] = ticket.TphMileage?.ToString("0.##") ?? "",
            ["PRINTER_MILAGE"] = ticket.PrinterMileage?.ToString("0.##") ?? "",
            ["OEM_RMA"] = ticket.OemRmaNumber ?? "",
            ["CARE_PACK_INVOICE"] = carePackInvoice,
            ["EXCEL_FILE_NAME"] = excelName,
            ["EXCEL_FILE_STEM"] = stem,
            ["EXCEL_FILE_PATH"] = ticket.ExcelFilePath ?? "",
            ["COMPANY_NAME"] = await db.GetSettingAsync("company_name", "INFINITE SOLUTIONS"),
            ["COMPANY_EMAIL"] = await db.GetSettingAsync("company_email", ""),
            ["COMPANY_PHONE"] = await db.GetSettingAsync("company_phone", ""),
        };
    }

    public async Task<string> ApplyTemplateAsync(RMATicket ticket, string template)
    {
        var map = await TokenMapAsync(ticket);
        var s = template ?? "";
        foreach (var (k, v) in map)
            s = s.Replace("{{" + k + "}}", v, StringComparison.OrdinalIgnoreCase)
                 .Replace("@@" + k + "@@", v, StringComparison.OrdinalIgnoreCase);
        return s;
    }

    public async Task SendOemRmaEmailAsync(int ticketId)
    {
        var (userName, role) = await session.GetCurrentAsync();
        if (!AppRoles.CanEditSerials(role))
            throw new InvalidOperationException("Your role cannot send OEM email.");

        var ticket = await db.RMATickets.Include(t => t.Photos)
            .FirstOrDefaultAsync(t => t.Id == ticketId)
            ?? throw new InvalidOperationException("Ticket not found.");

        var (ok, reason) = await CanSendAsync(ticket);
        if (!ok) throw new InvalidOperationException(reason);

        var (subject, body) = await BuildMessageAsync(ticket);

        var host = (await db.GetSettingAsync("smtp_host")).Trim();
        var port = int.TryParse(await db.GetSettingAsync("smtp_port", "587"), out var p) ? p : 587;
        var user = await db.GetSettingAsync("smtp_user", "");
        var pass = await db.GetSettingAsync("smtp_pass", "");
        var ssl = !string.Equals(await db.GetSettingAsync("smtp_ssl", "true"), "false", StringComparison.OrdinalIgnoreCase);
        var fromAddr = await db.GetSettingAsync("smtp_from", "");
        if (string.IsNullOrWhiteSpace(fromAddr))
            fromAddr = string.IsNullOrWhiteSpace(user) ? await db.GetSettingAsync("company_email") : user;
        if (string.IsNullOrWhiteSpace(fromAddr))
            throw new InvalidOperationException("Set smtp_from or company_email in Settings → Email.");

        var fromName = await db.GetSettingAsync("company_name", "Infinite Solutions");

        using var msg = new MailMessage
        {
            From = new MailAddress(fromAddr, fromName),
            Subject = subject,
            Body = body,
            IsBodyHtml = false,
            BodyEncoding = Encoding.UTF8,
            SubjectEncoding = Encoding.UTF8,
        };
        foreach (var to in await GetToAddressesAsync())
            msg.To.Add(to);
        foreach (var cc in await GetCcAddressesAsync())
            msg.CC.Add(cc);

        msg.Attachments.Add(new Attachment(ticket.ExcelFilePath!));

        using var client = new SmtpClient(host, port)
        {
            EnableSsl = ssl,
            DeliveryMethod = SmtpDeliveryMethod.Network,
            Timeout = 60_000,
        };
        if (!string.IsNullOrWhiteSpace(user))
            client.Credentials = new NetworkCredential(user, pass);

        await client.SendMailAsync(msg);

        ticket.OemEmailSentAt = DateTime.Now;
        ticket.OemEmailSentBy = userName;
        if (ticket.Status == RMAStatus.Open)
            ticket.Status = RMAStatus.AwaitingOemRma;
        ticket.UpdatedAt = DateTime.Now;
        await db.SaveChangesAsync();
    }
}

public record OemEmailDraft(
    string Subject,
    string PlainBody,
    string HtmlBody,
    string ToHint,
    string CcHint);
