using System.Net.Http.Headers;
using System.Text.Json;
using RMASystem.Data;

namespace RMASystem.Services;

// DTOs for Zoho Books invoice / PO (care pack flows)
public record ZohoInvoiceSummary(
    string InvoiceId,
    string InvoiceNumber,
    string? CustomerName,
    string? Date,
    decimal Total,
    string Status);

public record ZohoInvoiceDetail(
    string InvoiceId,
    string InvoiceNumber,
    string? CustomerName,
    string? CustomerCity,
    string? Date,
    decimal Total,
    string? Status,
    string? Irn,
    string? IrnAckNo,
    string? IrnAckDate,
    string? Notes,
    List<ZohoLineItem> LineItems);

public record ZohoLineItem(
    string Name,
    string? Description,
    decimal Quantity,
    decimal Rate);

public record ZohoPurchaseOrderSummary(
    string PurchaseOrderId,
    string PurchaseOrderNumber,
    string? ReferenceNumber,
    string? VendorName,
    string? Date,
    string Status,
    string? CurrencyCode,
    decimal Total,
    decimal Quantity);

public record ZohoPurchaseOrderDetail(
    string PurchaseOrderId,
    string PurchaseOrderNumber,
    string? ReferenceNumber,
    string? VendorName,
    string? Date,
    string Status,
    string? CurrencyCode,
    decimal Total,
    List<ZohoLineItem> LineItems);

public partial class ZohoService
{
    private async Task<(HttpClient Client, string OrgId)> BooksClientAsync()
    {
        var token = await RefreshTokenAsync("books");
        var orgId = await db.GetSettingAsync("zoho_books_org_id");
        if (string.IsNullOrWhiteSpace(orgId))
            throw new InvalidOperationException(
                "Zoho Books organization ID not configured. Go to Settings → Zoho Integration.");

        var client = httpFactory.CreateClient();
        client.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue("Zoho-oauthtoken", token);
        return (client, orgId);
    }

    public async Task<ZohoInvoiceDetail?> GetInvoiceByNumberAsync(string invoiceNumber)
    {
        var (client, orgId) = await BooksClientAsync();
        var api = await BooksApiBaseAsync();
        var enc = Uri.EscapeDataString(invoiceNumber.Trim());
        var listUrl =
            $"{api}/books/v3/invoices" +
            $"?organization_id={orgId}&invoice_number={enc}";

        var listJson = await client.GetStringAsync(listUrl);
        using var listDoc = JsonDocument.Parse(listJson);
        if (!listDoc.RootElement.TryGetProperty("invoices", out var invoices) ||
            invoices.GetArrayLength() == 0)
            return null;

        var invoiceId = invoices[0].GetProperty("invoice_id").GetString()!;
        return await GetInvoiceByIdAsync(invoiceId);
    }

    public async Task<ZohoInvoiceDetail?> GetInvoiceByIdAsync(string invoiceId)
    {
        var (client, orgId) = await BooksClientAsync();
        var api = await BooksApiBaseAsync();
        var url =
            $"{api}/books/v3/invoices/{invoiceId}" +
            $"?organization_id={orgId}";

        var json = await client.GetStringAsync(url);
        using var doc = JsonDocument.Parse(json);
        if (!doc.RootElement.TryGetProperty("invoice", out var inv))
            return null;

        string? irn = null, ackNo = null, ackDate = null;
        if (inv.TryGetProperty("einvoice_details", out var einv) &&
            einv.ValueKind == JsonValueKind.Object)
        {
            irn     = GetStr(einv, "irn");
            ackNo   = GetStr(einv, "ack_no") ?? GetStr(einv, "ack_number");
            ackDate = GetStr(einv, "ack_date");
        }
        // Fallback custom fields sometimes used
        irn ??= GetStr(inv, "irn");

        var lines = new List<ZohoLineItem>();
        if (inv.TryGetProperty("line_items", out var items))
        {
            foreach (var li in items.EnumerateArray())
            {
                var name = GetStr(li, "name") ?? GetStr(li, "item_name") ?? "";
                // Zoho may put text in description, item_description, or name only
                var description =
                    FirstNonEmpty(
                        GetStr(li, "description"),
                        GetStr(li, "item_description"),
                        GetStr(li, "line_item_description"),
                        GetStr(li, "header_name"));
                lines.Add(new ZohoLineItem(
                    name,
                    description,
                    GetDec(li, "quantity"),
                    GetDec(li, "rate")));
            }
        }

        var notes = FirstNonEmpty(
            GetStr(inv, "notes"),
            GetStr(inv, "terms"),
            GetStr(inv, "customer_notes"));

        return new ZohoInvoiceDetail(
            GetStr(inv, "invoice_id")!,
            GetStr(inv, "invoice_number") ?? "",
            GetStr(inv, "customer_name"),
            GetNestedStr(inv, "billing_address", "city"),
            GetStr(inv, "date"),
            GetDec(inv, "total"),
            GetStr(inv, "status"),
            irn, ackNo, ackDate,
            notes,
            lines);
    }

    /// <summary>
    /// Fetches POs for care-pack validation: issued/open and closed/billed.
    /// Excludes draft and cancelled.
    /// </summary>
    public async Task<List<ZohoPurchaseOrderSummary>> GetIssuedPurchaseOrdersAsync()
    {
        var (client, orgId) = await BooksClientAsync();
        var api = await BooksApiBaseAsync();

        // Status.All then filter client-side — Zoho status names vary (issued/open/closed/billed)
        var url =
            $"{api}/books/v3/purchaseorders" +
            $"?organization_id={orgId}&filter_by=Status.All&per_page=200&sort_column=date&sort_order=D";

        var json = await client.GetStringAsync(url);
        using var doc = JsonDocument.Parse(json);
        var list = new List<ZohoPurchaseOrderSummary>();

        if (!doc.RootElement.TryGetProperty("purchaseorders", out var pos))
            return list;

        foreach (var po in pos.EnumerateArray())
        {
            var status = (GetStr(po, "status") ?? "").Trim().ToLowerInvariant();
            if (IsExcludedPoStatus(status))
                continue;

            list.Add(new ZohoPurchaseOrderSummary(
                GetStr(po, "purchaseorder_id")!,
                GetStr(po, "purchaseorder_number") ?? "",
                GetStr(po, "reference_number"),
                GetStr(po, "vendor_name"),
                GetStr(po, "date"),
                GetStr(po, "status") ?? status,
                GetStr(po, "currency_code"),
                GetDec(po, "total"),
                GetDec(po, "quantity") > 0 ? GetDec(po, "quantity") : GetDec(po, "total_quantity")));
        }
        return list;
    }

    /// <summary>Draft and cancelled are never offered for care-pack validation.</summary>
    public static bool IsExcludedPoStatus(string? status)
    {
        var s = (status ?? "").Trim().ToLowerInvariant();
        return s is "draft" or "cancelled" or "canceled" or "deleted";
    }

    public async Task<ZohoPurchaseOrderDetail?> GetPurchaseOrderByIdAsync(string poId)
    {
        var (client, orgId) = await BooksClientAsync();
        var api = await BooksApiBaseAsync();
        var url =
            $"{api}/books/v3/purchaseorders/{poId}" +
            $"?organization_id={orgId}";

        var json = await client.GetStringAsync(url);
        using var doc = JsonDocument.Parse(json);
        if (!doc.RootElement.TryGetProperty("purchaseorder", out var po))
            return null;

        var lines = new List<ZohoLineItem>();
        if (po.TryGetProperty("line_items", out var items))
        {
            foreach (var li in items.EnumerateArray())
            {
                lines.Add(new ZohoLineItem(
                    GetStr(li, "name") ?? "",
                    GetStr(li, "description"),
                    GetDec(li, "quantity"),
                    GetDec(li, "rate")));
            }
        }

        return new ZohoPurchaseOrderDetail(
            GetStr(po, "purchaseorder_id")!,
            GetStr(po, "purchaseorder_number") ?? "",
            GetStr(po, "reference_number"),
            GetStr(po, "vendor_name"),
            GetStr(po, "date"),
            GetStr(po, "status") ?? "issued",
            GetStr(po, "currency_code"),
            GetDec(po, "total"),
            lines);
    }

    public async Task<ZohoPurchaseOrderDetail?> GetPurchaseOrderByNumberAsync(string poNumber)
    {
        var (client, orgId) = await BooksClientAsync();
        var api = await BooksApiBaseAsync();
        var raw = poNumber.Trim();
        var enc = Uri.EscapeDataString(raw);

        // Prefer exact purchaseorder_number filter; fall back to search_text
        foreach (var listUrl in new[]
        {
            $"{api}/books/v3/purchaseorders?organization_id={orgId}&purchaseorder_number={enc}",
            $"{api}/books/v3/purchaseorders?organization_id={orgId}&search_text={enc}",
        })
        {
            var listJson = await client.GetStringAsync(listUrl);
            using var listDoc = JsonDocument.Parse(listJson);
            if (!listDoc.RootElement.TryGetProperty("purchaseorders", out var pos) ||
                pos.GetArrayLength() == 0)
                continue;

            string? id = null;
            foreach (var p in pos.EnumerateArray())
            {
                var num = GetStr(p, "purchaseorder_number") ?? "";
                if (string.Equals(num, raw, StringComparison.OrdinalIgnoreCase))
                {
                    id = GetStr(p, "purchaseorder_id");
                    break;
                }
            }
            id ??= pos[0].GetProperty("purchaseorder_id").GetString();
            if (!string.IsNullOrEmpty(id))
                return await GetPurchaseOrderByIdAsync(id!);
        }

        return null;
    }

    /// <summary>OEM vendor filter: TSC / Printronix / Honeywell in vendor name.</summary>
    public static bool IsOemVendor(string? vendorName)
    {
        if (string.IsNullOrWhiteSpace(vendorName)) return false;
        var v = vendorName.ToUpperInvariant();
        return v.Contains("TSC") || v.Contains("PRINTRONIX") || v.Contains("HONEYWELL");
    }

    static string? GetStr(JsonElement el, string prop) =>
        el.TryGetProperty(prop, out var p) && p.ValueKind != JsonValueKind.Null
            ? p.ToString() : null;

    static string? FirstNonEmpty(params string?[] values)
    {
        foreach (var v in values)
            if (!string.IsNullOrWhiteSpace(v)) return v.Trim();
        return null;
    }

    static string? GetNestedStr(JsonElement el, string parent, string child)
    {
        if (!el.TryGetProperty(parent, out var p) || p.ValueKind != JsonValueKind.Object)
            return null;
        return GetStr(p, child);
    }

    static decimal GetDec(JsonElement el, string prop)
    {
        if (!el.TryGetProperty(prop, out var p)) return 0;
        return p.ValueKind switch
        {
            JsonValueKind.Number => p.GetDecimal(),
            JsonValueKind.String when decimal.TryParse(p.GetString(), out var d) => d,
            _ => 0
        };
    }
}
