using Microsoft.EntityFrameworkCore;
using RMASystem.Data;
using RMASystem.Models;
using System.Collections.Concurrent;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace RMASystem.Services;

// ── Batch Service ─────────────────────────────────────────────────────────────
public class BatchService(AppDbContext db, ExcelService excelSvc, CompanyService companies)
{
    public async Task<List<RMATicket>> GetCandidatesAsync()
    {
        await companies.ApplyFilterAsync(db);
        return await db.RMATickets
            .Where(t => t.Status == RMAStatus.OemRmaReceived)
            .OrderBy(t => t.CreatedAt)
            .ToListAsync();
    }

    public async Task<MonthlyBatch> CreateBatchAsync(
        List<int> ticketIds, DateOnly dispatchDate, string? remarks = null)
    {
        await companies.ApplyFilterAsync(db);
        var companyId = db.TenantCompanyId;
        var monthStr = dispatchDate.ToString("yyyyMM");
        var batchId  = $"BATCH-{monthStr}";

        if (await db.MonthlyBatches.AnyAsync(b => b.BatchId == batchId))
        {
            int suffix = 2;
            while (await db.MonthlyBatches.AnyAsync(b => b.BatchId == $"{batchId}-{suffix}"))
                suffix++;
            batchId = $"{batchId}-{suffix}";
        }

        var tickets = await db.RMATickets
            .Where(t => ticketIds.Contains(t.Id))
            .ToListAsync();

        var excelPath = await excelSvc.GenerateBatchExcelAsync(tickets, batchId, dispatchDate);

        var batch = new MonthlyBatch
        {
            CompanyId    = companyId,
            BatchId      = batchId,
            BatchMonth   = dispatchDate.ToString("yyyy-MM"),
            DispatchDate = dispatchDate,
            TotalRmas    = tickets.Count,
            Remarks      = remarks,
            ExcelPath    = excelPath,
        };
        db.MonthlyBatches.Add(batch);

        foreach (var t in tickets)
        {
            t.Status          = RMAStatus.DispatchedToOem;
            t.OemDispatchDate = dispatchDate;
            t.BatchDispatchId = batchId;
            t.UpdatedAt       = DateTime.Now;
        }

        await db.SaveChangesAsync();
        return batch;
    }

    public async Task<List<MonthlyBatch>> GetAllBatchesAsync()
    {
        await companies.ApplyFilterAsync(db);
        return await db.MonthlyBatches.OrderByDescending(b => b.CreatedAt).ToListAsync();
    }

    public static bool IsLastWeekOfMonth()
    {
        var today   = DateTime.Today;
        var lastDay = DateTime.DaysInMonth(today.Year, today.Month);
        return today.Day >= lastDay - 6;
    }
}

// ── Zoho Service ──────────────────────────────────────────────────────────────
public partial class ZohoService(AppDbContext db, IHttpClientFactory httpFactory)
{
    /// <summary>
    /// Process-wide access-token cache. Zoho access tokens last ~1 hour; refreshing on
    /// every Books/Mail call hits "too many requests" rate limits.
    /// </summary>
    static readonly ConcurrentDictionary<string, CachedZohoAccess> AccessCache = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>Refresh ~2 minutes before Zoho expiry.</summary>
    const int AccessSkewSeconds = 120;

    sealed record CachedZohoAccess(string Token, DateTimeOffset ExpiresUtc);

    /// <summary>com = global (.com), in = India (.in). Must match where the Zoho account lives.</summary>
    async Task<string> GetDcAsync()
    {
        var dc = (await db.GetSettingAsync("zoho_dc", "com")).Trim().ToLowerInvariant();
        return dc is "in" or "eu" or "au" or "jp" or "ca" or "sa" ? dc : "com";
    }

    async Task<string> AccountsBaseAsync()
    {
        var dc = await GetDcAsync();
        return dc switch
        {
            "in" => "https://accounts.zoho.in",
            "eu" => "https://accounts.zoho.eu",
            "au" => "https://accounts.zoho.com.au",
            "jp" => "https://accounts.zoho.jp",
            "ca" => "https://accounts.zohocloud.ca",
            "sa" => "https://accounts.zoho.sa",
            _    => "https://accounts.zoho.com",
        };
    }

    async Task<string> BooksApiBaseAsync()
    {
        var dc = await GetDcAsync();
        return dc switch
        {
            "in" => "https://www.zohoapis.in",
            "eu" => "https://www.zohoapis.eu",
            "au" => "https://www.zohoapis.com.au",
            "jp" => "https://www.zohoapis.jp",
            "ca" => "https://www.zohoapis.ca",
            "sa" => "https://www.zohoapis.sa",
            _    => "https://www.zohoapis.com",
        };
    }

    async Task<string> MailApiBaseAsync()
    {
        var dc = await GetDcAsync();
        return dc switch
        {
            "in" => "https://mail.zoho.in",
            "eu" => "https://mail.zoho.eu",
            "au" => "https://mail.zoho.com.au",
            "jp" => "https://mail.zoho.jp",
            "ca" => "https://mail.zohocloud.ca",
            "sa" => "https://mail.zoho.sa",
            _    => "https://mail.zoho.com",
        };
    }

    static void CacheAccessToken(string service, string token, int expiresInSeconds)
    {
        if (string.IsNullOrWhiteSpace(token)) return;
        // Zoho usually returns expires_in ≈ 3600. Fall back to 55 minutes if missing.
        var life = expiresInSeconds > 60 ? expiresInSeconds : 3300;
        var expires = DateTimeOffset.UtcNow.AddSeconds(Math.Max(60, life - AccessSkewSeconds));
        AccessCache[service.Trim().ToLowerInvariant()] = new CachedZohoAccess(token.Trim(), expires);
    }

    /// <summary>Drop cached access token (e.g. after 401 or new Connect).</summary>
    public static void InvalidateAccessToken(string service) =>
        AccessCache.TryRemove(service.Trim().ToLowerInvariant(), out _);

    /// <summary>Clear all cached Zoho tokens (call on company switch — poka-yoke).</summary>
    public static void ClearAllAccessTokenCache() => AccessCache.Clear();

    private async Task<string> RefreshTokenAsync(string service)
    {
        service = service.Trim().ToLowerInvariant();

        // Reuse cached access token until near expiry — do NOT hit accounts.zoho on every request.
        if (AccessCache.TryGetValue(service, out var cached) &&
            DateTimeOffset.UtcNow < cached.ExpiresUtc &&
            !string.IsNullOrWhiteSpace(cached.Token))
            return cached.Token;

        var clientId     = (await db.GetSettingAsync("zoho_client_id")).Trim();
        var clientSecret = (await db.GetSettingAsync("zoho_client_secret")).Trim();
        var refreshKey   = $"zoho_{service}_refresh_token";
        var stored       = (await db.GetSettingAsync(refreshKey)).Trim();

        if (string.IsNullOrEmpty(clientId) || string.IsNullOrEmpty(clientSecret)
            || string.IsNullOrEmpty(stored))
            throw new InvalidOperationException(
                $"Zoho {service} credentials not configured. " +
                "Go to Settings → Zoho Integration: save Client ID + Secret, then Connect with a fresh Self Client grant code.");

        var accounts = await AccountsBaseAsync();

        // 1) Normal path: stored value is a long-lived refresh_token
        var (access, expiresIn, err, raw) = await PostOAuthAsync(accounts, new Dictionary<string, string>
        {
            ["refresh_token"] = stored,
            ["client_id"]     = clientId,
            ["client_secret"] = clientSecret,
            ["grant_type"]    = "refresh_token",
        });
        if (!string.IsNullOrEmpty(access))
        {
            CacheAccessToken(service, access!, expiresIn);
            return access!;
        }

        // Rate-limited: if we still have a recently issued token, keep using it a bit longer
        if (IsZohoRateLimit(err, raw) &&
            AccessCache.TryGetValue(service, out var soft) &&
            !string.IsNullOrWhiteSpace(soft.Token) &&
            DateTimeOffset.UtcNow < soft.ExpiresUtc.AddMinutes(10))
            return soft.Token;

        // 2) invalid_code => stored value is a one-time GRANT CODE (common mistake).
        //    Exchange it for a real refresh_token, save it, and continue.
        if (string.Equals(err, "invalid_code", StringComparison.OrdinalIgnoreCase))
        {
            try
            {
                var (refresh, accessFromCode, expiresFromCode) =
                    await ExchangeGrantCodeCoreAsync(service, stored, clientId, clientSecret, accounts);

                if (!string.IsNullOrEmpty(accessFromCode))
                {
                    CacheAccessToken(service, accessFromCode!, expiresFromCode);
                    return accessFromCode!;
                }

                (access, expiresIn, err, raw) = await PostOAuthAsync(accounts, new Dictionary<string, string>
                {
                    ["refresh_token"] = refresh,
                    ["client_id"]     = clientId,
                    ["client_secret"] = clientSecret,
                    ["grant_type"]    = "refresh_token",
                });
                if (!string.IsNullOrEmpty(access))
                {
                    CacheAccessToken(service, access!, expiresIn);
                    return access!;
                }
            }
            catch (Exception ex)
            {
                // Clear the bad grant code so the user is forced to Connect with a fresh one
                await db.SetSettingAsync(refreshKey, "");
                InvalidateAccessToken(service);
                throw new InvalidOperationException(
                    "Zoho stored value was a grant/authorization code (not a refresh token), and it could not be exchanged " +
                    "(expired or already used). Generate a NEW code at https://api-console.zoho.com now, " +
                    "then Settings → Zoho Integration → paste under Connect → click Connect. " +
                    $"Details: {ex.Message}");
            }
        }

        throw new InvalidOperationException(
            $"Token refresh failed ({err ?? "unknown"}): {raw} — Calling {accounts}. " +
            "For Self Client: save Client ID/Secret, generate a fresh grant code, click Connect " +
            "(do not paste the grant code into Client Secret). " +
            "If you see 'too many requests', wait a few minutes — access tokens are now cached until expiry.");
    }

    static bool IsZohoRateLimit(string? err, string? raw) =>
        (raw ?? "").Contains("too many requests", StringComparison.OrdinalIgnoreCase) ||
        string.Equals(err, "Access Denied", StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// Exchanges a one-time Zoho Self Client grant code for a long-lived refresh_token
    /// and stores it under zoho_{service}_refresh_token.
    /// </summary>
    public async Task<string> ExchangeGrantCodeAsync(string service, string grantCode, string? redirectUri = null)
    {
        service = service.Trim().ToLowerInvariant();
        if (service is not ("mail" or "books"))
            throw new ArgumentException("service must be mail or books");

        grantCode = (grantCode ?? "").Trim();
        if (string.IsNullOrEmpty(grantCode))
            throw new InvalidOperationException("Grant code is empty.");

        var clientId     = (await db.GetSettingAsync("zoho_client_id")).Trim();
        var clientSecret = (await db.GetSettingAsync("zoho_client_secret")).Trim();
        if (string.IsNullOrEmpty(clientId) || string.IsNullOrEmpty(clientSecret))
            throw new InvalidOperationException("Save Client ID and Client Secret first.");

        var accounts = await AccountsBaseAsync();
        InvalidateAccessToken(service);
        var (refresh, access, expiresIn) = await ExchangeGrantCodeCoreAsync(
            service, grantCode, clientId, clientSecret, accounts, redirectUri);
        if (!string.IsNullOrEmpty(access))
            CacheAccessToken(service, access!, expiresIn);
        return refresh;
    }

    async Task<(string RefreshToken, string? AccessToken, int ExpiresIn)> ExchangeGrantCodeCoreAsync(
        string service,
        string grantCode,
        string clientId,
        string clientSecret,
        string accounts,
        string? redirectUri = null)
    {
        // Self Client: try without redirect_uri first, then common Zoho defaults.
        var redirectCandidates = new List<string?> { null };
        if (!string.IsNullOrWhiteSpace(redirectUri))
            redirectCandidates.Insert(0, redirectUri.Trim());
        redirectCandidates.Add("https://www.zoho.com");
        redirectCandidates.Add("http://www.zoho.com");

        string? lastRaw = null;
        string? lastErr = null;

        foreach (var redir in redirectCandidates.Distinct())
        {
            var form = new Dictionary<string, string>
            {
                ["code"]          = grantCode,
                ["client_id"]     = clientId,
                ["client_secret"] = clientSecret,
                ["grant_type"]    = "authorization_code",
            };
            if (!string.IsNullOrEmpty(redir))
                form["redirect_uri"] = redir;

            var (access, expiresIn, err, raw) = await PostOAuthAsync(accounts, form);
            lastRaw = raw;
            lastErr = err;

            using var doc = JsonDocument.Parse(raw);
            if (doc.RootElement.TryGetProperty("refresh_token", out var rt) &&
                !string.IsNullOrWhiteSpace(rt.GetString()))
            {
                var refresh = rt.GetString()!.Trim();
                await db.SetSettingAsync($"zoho_{service}_refresh_token", refresh);
                return (refresh, access, expiresIn);
            }

            // Some responses return access_token only — still not durable, but usable once
            if (!string.IsNullOrEmpty(access) &&
                !string.Equals(err, "invalid_code", StringComparison.OrdinalIgnoreCase))
            {
                // Keep trying other redirect variants for a refresh_token
            }
        }

        throw new InvalidOperationException(
            $"Grant code exchange failed ({lastErr ?? "unknown"}): {lastRaw} — Calling {accounts}. " +
            "Generate a brand-new code at api-console.zoho.com (unused, under 1 minute old). " +
            "Client ID/Secret must belong to that same Self Client. Data Center must be Global (.com).");
    }

    static async Task<(string? AccessToken, int ExpiresIn, string? Error, string RawJson)> PostOAuthAsync(
        string accountsBase,
        Dictionary<string, string> form)
    {
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
        using var resp = await http.PostAsync(
            $"{accountsBase.TrimEnd('/')}/oauth/v2/token",
            new FormUrlEncodedContent(form));
        var raw = await resp.Content.ReadAsStringAsync();
        try
        {
            using var doc = JsonDocument.Parse(raw);
            string? access = doc.RootElement.TryGetProperty("access_token", out var t)
                ? t.GetString()
                : null;
            string? err = doc.RootElement.TryGetProperty("error", out var e)
                ? e.GetString()
                : null;
            var expiresIn = 3600;
            if (doc.RootElement.TryGetProperty("expires_in", out var ei))
            {
                if (ei.ValueKind == JsonValueKind.Number)
                    expiresIn = ei.GetInt32();
                else if (ei.ValueKind == JsonValueKind.String && int.TryParse(ei.GetString(), out var parsed))
                    expiresIn = parsed;
            }
            return (access, expiresIn, err, raw);
        }
        catch (JsonException)
        {
            return (null, 0, "non_json", raw);
        }
    }

    /// <summary>Quick connectivity check for Books using stored refresh token.</summary>
    public async Task<string> TestBooksConnectionAsync()
    {
        var token = await RefreshTokenAsync("books");
        var orgId = (await db.GetSettingAsync("zoho_books_org_id")).Trim();
        var books = await BooksApiBaseAsync();
        var client = httpFactory.CreateClient();
        client.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue("Zoho-oauthtoken", token);

        var url = string.IsNullOrEmpty(orgId)
            ? $"{books}/books/v3/organizations"
            : $"{books}/books/v3/organizations/{orgId}";
        var resp = await client.GetAsync(url);
        var body = await resp.Content.ReadAsStringAsync();
        if (!resp.IsSuccessStatusCode)
            throw new InvalidOperationException($"Books API {(int)resp.StatusCode}: {body}");
        return "Books token OK — connected via " + books;
    }

    /// <summary>Polls Zoho Mail for OEM RMA numbers and auto-updates tickets.</summary>
    public async Task<List<string>> PollMailAsync()
    {
        try
        {
            var token  = await RefreshTokenAsync("mail");
            var mailBase = await MailApiBaseAsync();
            var client = httpFactory.CreateClient();
            client.DefaultRequestHeaders.Authorization =
                new AuthenticationHeaderValue("Zoho-oauthtoken", token);

            var oemEmail = await db.GetSettingAsync("oem_email", "tsc_rma@tscprinters.com");

            // Get account ID
            var acctResp = await client.GetStringAsync($"{mailBase}/api/accounts");
            var acctDoc  = JsonDocument.Parse(acctResp);
            var accountId = acctDoc.RootElement
                .GetProperty("data")[0].GetProperty("accountId").GetString();

            // Search for emails from OEM
            var searchResp = await client.GetStringAsync(
                $"{mailBase}/api/accounts/{accountId}/messages/search" +
                $"?searchKey=from:{oemEmail}&limit=20");
            var searchDoc  = JsonDocument.Parse(searchResp);
            var messages   = searchDoc.RootElement
                .GetProperty("data").GetProperty("list").EnumerateArray();

            var updated = new List<string>();

            foreach (var msg in messages)
            {
                var msgId    = msg.GetProperty("messageId").GetString();
                var folderId = msg.GetProperty("folderId").GetString();

                var bodyResp = await client.GetStringAsync(
                    $"{mailBase}/api/accounts/{accountId}" +
                    $"/folders/{folderId}/messages/{msgId}");
                var bodyDoc  = JsonDocument.Parse(bodyResp);
                var body     = bodyDoc.RootElement
                    .GetProperty("data").GetProperty("content").GetString() ?? "";

                // Find RMA numbers in email body
                var rmaMatches = System.Text.RegularExpressions.Regex.Matches(
                    body, @"\b(TEBT\w{6,12}|RMA[-\s]?\d{5,12})\b",
                    System.Text.RegularExpressions.RegexOptions.IgnoreCase);

                // Find serial numbers
                var snMatches = System.Text.RegularExpressions.Regex.Matches(
                    body, @"\b(TEBT\w{6,12}|[A-Z]{2,4}\d{6,12})\b");

                foreach (System.Text.RegularExpressions.Match rmaMatch in rmaMatches)
                {
                    RMATicket? matchedTicket = null;
                    foreach (System.Text.RegularExpressions.Match snMatch in snMatches)
                    {
                        var sn = snMatch.Value;
                        matchedTicket = await db.RMATickets
                            .FirstOrDefaultAsync(t => t.PrinterSn == sn);
                        if (matchedTicket != null) break;
                    }

                    if (matchedTicket != null && string.IsNullOrEmpty(matchedTicket.OemRmaNumber))
                    {
                        matchedTicket.OemRmaNumber      = rmaMatch.Value.Trim();
                        matchedTicket.OemRmaAssignDate  = DateOnly.FromDateTime(DateTime.Now);
                        matchedTicket.OemEmailReceivedAt = DateTime.Now;
                        matchedTicket.Status            = RMAStatus.OemRmaReceived;
                        matchedTicket.UpdatedAt         = DateTime.Now;
                        await db.SaveChangesAsync();
                        updated.Add(
                            $"{matchedTicket.InternalTicketNo} → OEM RMA: {rmaMatch.Value}");
                    }
                }
            }
            return updated;
        }
        catch (Exception ex)
        {
            return [$"Error: {ex.Message}"];
        }
    }

    /// <summary>Creates a Delivery Challan in Zoho Books for the given ticket.</summary>
    public async Task<(string ChallanId, string ChallanNumber)> CreateChallanAsync(
        RMATicket ticket)
    {
        var enabled = await db.GetSettingAsync("challan_enabled", "true");
        if (string.Equals(enabled.Trim(), "false", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException(
                "Delivery challan create is disabled (Settings → Delivery Challan).");

        var token  = await RefreshTokenAsync("books");
        var orgId  = await db.GetSettingAsync("zoho_books_org_id");
        if (string.IsNullOrWhiteSpace(orgId))
            throw new InvalidOperationException("Set Zoho Books Organisation ID in Settings → Zoho Integration.");

        var apiBase = await BooksApiBaseAsync();
        var client = httpFactory.CreateClient();
        client.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue("Zoho-oauthtoken", token);

        var descriptionTpl = await db.GetSettingAsync("challan_line_description",
            "{{PRINTER_MODEL}} Printer — SN: {{PRINTER_SERIAL}} — Repaired/Replaced Unit ({{FAULTY_PART}})");
        var notesTpl = await db.GetSettingAsync("challan_notes",
            "OEM RMA#: {{OEM_RMA}} | Failure: {{FAULT_DESCRIPTION}} | Ref: {{INTERNAL_TICKET}}");

        static string ApplySimple(string tpl, RMATicket t)
        {
            return (tpl ?? "")
                .Replace("{{PRINTER_MODEL}}", t.PrinterModel ?? "", StringComparison.OrdinalIgnoreCase)
                .Replace("{{PRINTER_SERIAL}}", t.PrinterSn ?? "", StringComparison.OrdinalIgnoreCase)
                .Replace("{{FAULTY_PART}}", t.FaultyPart ?? "", StringComparison.OrdinalIgnoreCase)
                .Replace("{{FAULTY_PART_SERIAL}}", t.FaultyPartSn ?? "", StringComparison.OrdinalIgnoreCase)
                .Replace("{{FAULT_DESCRIPTION}}", t.FailureDescription ?? "", StringComparison.OrdinalIgnoreCase)
                .Replace("{{OEM_RMA}}", t.OemRmaNumber ?? "", StringComparison.OrdinalIgnoreCase)
                .Replace("{{INTERNAL_TICKET}}", t.InternalTicketNo ?? "", StringComparison.OrdinalIgnoreCase)
                .Replace("{{CUSTOMER}}", t.CustomerCompany ?? "", StringComparison.OrdinalIgnoreCase);
        }

        var description = ApplySimple(descriptionTpl, ticket);
        var notes = ApplySimple(notesTpl, ticket);

        var payload = new
        {
            date             = DateTime.Now.ToString("yyyy-MM-dd"),
            reference_number = ticket.InternalTicketNo,
            notes,
            line_items = new[]
            {
                new { description, quantity = 1, unit = "Nos" }
            },
            shipping_address = new
            {
                address = ticket.ShipToAddress ?? ticket.CustomerAddress ?? "",
                city    = ticket.CustomerCity ?? "",
                zip     = ticket.CustomerPostal ?? "",
                country = ticket.CustomerCountry ?? "India",
            }
        };

        var content = new StringContent(
            JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");

        var resp = await client.PostAsync(
            $"{apiBase}/books/v3/deliverychallans?organization_id={orgId}",
            content);
        resp.EnsureSuccessStatusCode();

        var json    = await resp.Content.ReadAsStringAsync();
        var doc     = JsonDocument.Parse(json);
        var challan = doc.RootElement.GetProperty("delivery_challan");

        var challanId     = challan.GetProperty("delivery_challan_id").GetString()!;
        var challanNumber = challan.GetProperty("delivery_challan_number").GetString()!;

        ticket.ZohoChallanId           = challanId;
        ticket.ZohoChallanNumber       = challanNumber;
        ticket.ChallanCreatedAt        = DateTime.Now;

        var autoDispatch = await db.GetSettingAsync("challan_auto_dispatch", "true");
        if (!string.Equals(autoDispatch.Trim(), "false", StringComparison.OrdinalIgnoreCase))
        {
            ticket.Status                 = RMAStatus.DispatchedToCustomer;
            ticket.DispatchToCustomerDate = DateOnly.FromDateTime(DateTime.Now);
        }

        ticket.UpdatedAt = DateTime.Now;
        await db.SaveChangesAsync();

        return (challanId, challanNumber);
    }
}
