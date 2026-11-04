using Microsoft.EntityFrameworkCore;
using RMASystem.Data;
using RMASystem.Models;

namespace RMASystem.Services;

public class UiPreferenceService(IDbContextFactory<AppDbContext> dbFactory)
{
    static string Key(string? userName) =>
        string.IsNullOrWhiteSpace(userName) ? "default" : userName.Trim();

    public async Task<UserUiPreference> GetAsync(string? userName = null)
    {
        var key = Key(userName);
        await using var db = await dbFactory.CreateDbContextAsync();
        var existing = await db.UserUiPreferences.AsNoTracking()
            .FirstOrDefaultAsync(p => p.UserName == key);
        if (existing != null) return existing;

        try
        {
            var pref = new UserUiPreference
            {
                UserName = key,
                DarkMode = false,
                DashboardView = DashboardViews.Cards,
                UpdatedAt = DateTime.Now,
            };
            db.UserUiPreferences.Add(pref);
            await db.SaveChangesAsync();
            return pref;
        }
        catch (DbUpdateException)
        {
            // Layout + page both created the row at once — re-read the winner
            await using var db2 = await dbFactory.CreateDbContextAsync();
            return await db2.UserUiPreferences.AsNoTracking()
                .FirstAsync(p => p.UserName == key);
        }
    }

    public async Task<UserUiPreference> SetDarkModeAsync(bool dark, string? userName = null)
    {
        var key = Key(userName);
        await GetAsync(key); // ensure row exists (race-safe)

        await using var db = await dbFactory.CreateDbContextAsync();
        var pref = await db.UserUiPreferences.FirstAsync(p => p.UserName == key);
        pref.DarkMode = dark;
        pref.UpdatedAt = DateTime.Now;
        await db.SaveChangesAsync();
        return pref;
    }

    public async Task<UserUiPreference> SetDashboardViewAsync(string view, string? userName = null)
    {
        view = view == DashboardViews.List ? DashboardViews.List : DashboardViews.Cards;
        var key = Key(userName);
        await GetAsync(key);

        await using var db = await dbFactory.CreateDbContextAsync();
        var pref = await db.UserUiPreferences.FirstAsync(p => p.UserName == key);
        pref.DashboardView = view;
        pref.UpdatedAt = DateTime.Now;
        await db.SaveChangesAsync();
        return pref;
    }
}

public class DashboardService(
    IDbContextFactory<AppDbContext> dbFactory,
    CarePackService carePack,
    CompanyService companies)
{
    public async Task<DashboardSnapshot> GetSnapshotAsync()
    {
        await using var db = await dbFactory.CreateDbContextAsync();
        await companies.ApplyFilterAsync(db);

        var today = DateTime.Today;
        var monthStart = new DateTime(today.Year, today.Month, 1);

        var rmaOpen = await db.RMATickets.CountAsync(t => t.Status == RMAStatus.Open);
        var rmaAwait = await db.RMATickets.CountAsync(t => t.Status == RMAStatus.AwaitingOemRma);
        var rmaDisp = await db.RMATickets.CountAsync(t => t.Status == RMAStatus.DispatchedToOem);
        var rmaGoods = await db.RMATickets.CountAsync(t => t.Status == RMAStatus.GoodsReceivedFromOem);
        var rmaOemRcv = await db.RMATickets.CountAsync(t => t.Status == RMAStatus.OemRmaReceived);

        var supportSla = await db.SupportTickets.CountAsync(t => t.SlaBreached && t.Status != SupportStatus.Closed);
        var supportProg = await db.SupportTickets.CountAsync(t => t.Status == SupportStatus.InProgress);
        var supportNew = await db.SupportTickets.CountAsync(t => t.Status == SupportStatus.New);
        var supportResolvedToday = await db.SupportTickets.CountAsync(t =>
            t.ResolvedAt != null && t.ResolvedAt >= today);
        var avgRes = await db.SupportTickets
            .Where(t => t.ResolutionHours != null)
            .Select(t => (double?)t.ResolutionHours)
            .AverageAsync() ?? 0;

        var repairDiag = await db.RepairJobs.CountAsync(t =>
            t.Status == RepairStatus.Received || t.Status == RepairStatus.InDiagnosis);
        var repairQuoted = await db.RepairJobs.CountAsync(t => t.Status == RepairStatus.Quoted);
        var repairReady = await db.RepairJobs.CountAsync(t =>
            t.Status == RepairStatus.Repaired || t.Status == RepairStatus.ReadyToDeliver);
        var repairInvoicedMonth = await db.RepairJobs.CountAsync(t =>
            t.Status == RepairStatus.Invoiced && t.InvoicedAt >= monthStart);

        var now = DateOnly.FromDateTime(today);
        var in30 = now.AddDays(30);
        var in60 = now.AddDays(60);
        var devices = await db.CarePackDevices.CountAsync();
        var expired = await db.CarePackDevices.CountAsync(d => d.WarrantyEnd != null && d.WarrantyEnd < now);
        var exp30 = await db.CarePackDevices.CountAsync(d =>
            d.WarrantyEnd != null && d.WarrantyEnd >= now && d.WarrantyEnd <= in30);
        var exp60 = await db.CarePackDevices.CountAsync(d =>
            d.WarrantyEnd != null && d.WarrantyEnd > in30 && d.WarrantyEnd <= in60);
        var active = await db.CarePackDevices.CountAsync(d =>
            d.WarrantyEnd == null || d.WarrantyEnd >= now);

        // Care Pack ops / deadlines (poka-yoke windows) — CarePackService scopes itself
        var (poLimit, payLimit) = await carePack.GetDeadlineLimitsAsync();
        var poNotLinked = await carePack.GetPoNotIssuedReportAsync();
        var poDeadline = await carePack.GetPoDeadlineReportAsync();
        var oemDocsPending = await carePack.GetOemInvoicePendingReportAsync();
        var oemPayDue = await carePack.GetOemPaymentDeadlineReportAsync();
        var verified = await db.CarePackBatches.CountAsync(b => b.VerificationComplete);
        var batchesTotal = await db.CarePackBatches.CountAsync();

        var poOverdue = poDeadline.Count(x => x.DaysRemaining is < 0);
        var poDueSoon = poDeadline.Count(x => x.DaysRemaining is >= 0 and <= 5);
        var payOverdue = oemPayDue.Count(x => x.DaysRemaining is < 0);
        var payDueSoon = oemPayDue.Count(x => x.DaysRemaining is >= 0 and <= 5);

        var oemUnsent = await db.OemNotifications
            .Where(n => n.Status == OemNotifyStatus.Unsent)
            .OrderByDescending(n => n.CreatedAt)
            .Take(10)
            .ToListAsync();
        var oemRecentSent = await db.OemNotifications
            .Where(n => n.Status == OemNotifyStatus.Sent)
            .OrderByDescending(n => n.SentAt)
            .Take(3)
            .ToListAsync();

        var partsToday = await db.PartMovements
            .Where(p => p.MovedAt >= today)
            .OrderByDescending(p => p.MovedAt)
            .Take(10)
            .ToListAsync();

        var activity = await db.ActivityLogs
            .OrderByDescending(a => a.CreatedAt)
            .Take(12)
            .ToListAsync();

        // Fallback activity from RMA + Care Pack if activity table empty
        if (activity.Count == 0)
        {
            var recentRma = await db.RMATickets
                .OrderByDescending(t => t.CreatedAt)
                .Take(5)
                .ToListAsync();
            foreach (var t in recentRma)
            {
                activity.Add(new ActivityLog
                {
                    Category = "RMA",
                    Title = $"RMA — {t.InternalTicketNo}",
                    Detail = $"{t.CustomerCompany ?? "—"} · {t.PrinterSn ?? "—"} · {Relative(t.CreatedAt)}",
                    Color = "accent",
                    CreatedAt = t.CreatedAt,
                });
            }
            var recentCp = await db.CarePackBatches
                .OrderByDescending(b => b.CreatedAt)
                .Take(3)
                .ToListAsync();
            foreach (var b in recentCp)
            {
                activity.Add(new ActivityLog
                {
                    Category = "CarePack",
                    Title = $"{b.DeviceCount} devices registered — {b.InvoiceNumber}",
                    Detail = $"{b.CustomerName ?? "—"} · {b.CarePackType ?? "—"} · {Relative(b.CreatedAt)}",
                    Color = "warning",
                    CreatedAt = b.CreatedAt,
                });
            }
            activity = activity.OrderByDescending(a => a.CreatedAt).Take(12).ToList();
        }

        var listRows = await BuildListRowsAsync(db);

        return new DashboardSnapshot
        {
            RmaOpen = rmaOpen,
            RmaAwaitingOem = rmaAwait,
            RmaOemReceived = rmaOemRcv,
            RmaDispatched = rmaDisp,
            RmaGoodsReceived = rmaGoods,
            SupportSlaBreached = supportSla,
            SupportInProgress = supportProg,
            SupportNew = supportNew,
            SupportResolvedToday = supportResolvedToday,
            SupportAvgHours = Math.Round(avgRes, 1),
            RepairDiagnosis = repairDiag,
            RepairQuoted = repairQuoted,
            RepairReady = repairReady,
            RepairInvoicedMonth = repairInvoicedMonth,
            CareExpired = expired,
            CareExpiring30 = exp30,
            CareExpiring60 = exp60,
            CareActive = active,
            CareDevices = devices,
            CareBatchesTotal = batchesTotal,
            CareVerified = verified,
            CarePoNotLinked = poNotLinked.Count,
            CarePoOverdue = poOverdue,
            CarePoDueSoon = poDueSoon,
            CareOemDocsPending = oemDocsPending.Count,
            CarePayOverdue = payOverdue,
            CarePayDueSoon = payDueSoon,
            CarePoLimitDays = poLimit,
            CarePayLimitDays = payLimit,
            CarePoDeadlineItems = poDeadline.Where(x => x.DaysRemaining is <= 5).Take(5).ToList(),
            CarePayDeadlineItems = oemPayDue.Where(x => x.DaysRemaining is <= 5).Take(5).ToList(),
            OemUnsentCount = oemUnsent.Count,
            OemNotifications = oemUnsent.Concat(oemRecentSent).ToList(),
            PartMovementsToday = partsToday,
            RecentActivity = activity,
            ListRows = listRows,
            ShowBatchAlert = BatchService.IsLastWeekOfMonth(),
            BatchCandidateCount = rmaOemRcv,
        };
    }

    static async Task<List<DashboardListRow>> BuildListRowsAsync(AppDbContext db)
    {
        var rows = new List<DashboardListRow>();

        var tickets = await db.RMATickets
            .OrderByDescending(t => t.UpdatedAt)
            .Take(40)
            .ToListAsync();
        foreach (var t in tickets)
        {
            rows.Add(new DashboardListRow(
                "RMA", t.InternalTicketNo, t.Status,
                t.CustomerCompany, t.PrinterSn, t.UpdatedAt,
                $"/rma/{t.Id}"));
        }

        var supports = await db.SupportTickets
            .OrderByDescending(t => t.CreatedAt).Take(20).ToListAsync();
        foreach (var t in supports)
        {
            rows.Add(new DashboardListRow(
                "Support", t.TicketNo, t.Status,
                t.CustomerName, t.SerialNumber, t.CreatedAt, "/"));
        }

        var repairs = await db.RepairJobs
            .OrderByDescending(t => t.CreatedAt).Take(20).ToListAsync();
        foreach (var t in repairs)
        {
            rows.Add(new DashboardListRow(
                "Repair", t.JobNo, t.Status,
                t.CustomerName, t.SerialNumber, t.CreatedAt, "/"));
        }

        var batches = await db.CarePackBatches
            .OrderByDescending(b => b.CreatedAt).Take(20).ToListAsync();
        foreach (var b in batches)
        {
            var status = b.VerificationComplete
                ? "100% Verified"
                : CarePackBatchStatus.Label(b.Status);
            rows.Add(new DashboardListRow(
                "Care Pack", b.InvoiceNumber, status,
                b.CustomerName, b.PrinterModel, b.CreatedAt,
                $"/care-packs/{b.Id}"));
        }

        return rows.OrderByDescending(r => r.When).Take(50).ToList();
    }

    static string Relative(DateTime dt)
    {
        var span = DateTime.Now - dt;
        if (span.TotalMinutes < 60) return $"{(int)span.TotalMinutes} min ago";
        if (span.TotalHours < 24) return $"{(int)span.TotalHours} hr ago";
        return dt.ToString("dd-MMM-yyyy");
    }
}

public record DashboardListRow(
    string Module, string Ref, string Status,
    string? Customer, string? SnOrModel, DateTime When, string Href);

public class DashboardSnapshot
{
    public int RmaOpen { get; set; }
    public int RmaAwaitingOem { get; set; }
    public int RmaOemReceived { get; set; }
    public int RmaDispatched { get; set; }
    public int RmaGoodsReceived { get; set; }

    public int SupportSlaBreached { get; set; }
    public int SupportInProgress { get; set; }
    public int SupportNew { get; set; }
    public int SupportResolvedToday { get; set; }
    public double SupportAvgHours { get; set; }

    public int RepairDiagnosis { get; set; }
    public int RepairQuoted { get; set; }
    public int RepairReady { get; set; }
    public int RepairInvoicedMonth { get; set; }

    public int CareExpired { get; set; }
    public int CareExpiring30 { get; set; }
    public int CareExpiring60 { get; set; }
    public int CareActive { get; set; }
    public int CareDevices { get; set; }

    public int CareBatchesTotal { get; set; }
    public int CareVerified { get; set; }
    public int CarePoNotLinked { get; set; }
    public int CarePoOverdue { get; set; }
    public int CarePoDueSoon { get; set; }
    public int CareOemDocsPending { get; set; }
    public int CarePayOverdue { get; set; }
    public int CarePayDueSoon { get; set; }
    public int CarePoLimitDays { get; set; } = 25;
    public int CarePayLimitDays { get; set; } = 40;
    public List<CarePackPendingItem> CarePoDeadlineItems { get; set; } = [];
    public List<CarePackPendingItem> CarePayDeadlineItems { get; set; } = [];

    public int OemUnsentCount { get; set; }
    public List<OemNotification> OemNotifications { get; set; } = [];
    public List<PartMovement> PartMovementsToday { get; set; } = [];
    public List<ActivityLog> RecentActivity { get; set; } = [];
    public List<DashboardListRow> ListRows { get; set; } = [];

    public bool ShowBatchAlert { get; set; }
    public int BatchCandidateCount { get; set; }
}
