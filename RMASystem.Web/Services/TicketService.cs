using Microsoft.EntityFrameworkCore;
using RMASystem.Data;
using RMASystem.Models;

namespace RMASystem.Services;

public class TicketService(AppDbContext db, UserSessionService session, CompanyService companies, AuthService auth)
{
    async Task ScopeAsync() => await companies.ApplyFilterAsync(db);

    /// <summary>Generates {TicketPrefix}-RMA-YYYYMM-XXXX for the given date (defaults to today).</summary>
    public async Task<string> GenerateTicketNumberAsync(DateTime? forDate = null)
    {
        await ScopeAsync();
        var dt       = forDate ?? DateTime.Now;
        var ym       = dt.ToString("yyyyMM");
        var company  = await companies.GetActiveCompanyAsync();
        var prefix   = string.IsNullOrWhiteSpace(company.TicketPrefix)
            ? await db.GetSettingAsync("ticket_prefix", "INF")
            : company.TicketPrefix;
        var pattern  = $"{prefix}-RMA-{ym}-%";

        var count = await db.RMATickets
            .CountAsync(t => EF.Functions.Like(t.InternalTicketNo, pattern));

        var seq      = count + 1;
        var ticketNo = $"{prefix}-RMA-{ym}-{seq:D4}";

        while (await db.RMATickets.AnyAsync(t => t.InternalTicketNo == ticketNo))
        {
            seq++;
            ticketNo = $"{prefix}-RMA-{ym}-{seq:D4}";
        }
        return ticketNo;
    }

    /// <summary>For imported records with no date, uses IMPORT prefix.</summary>
    public async Task<string> GenerateImportTicketNumberAsync(DateTime? originalDate)
    {
        await ScopeAsync();
        if (originalDate.HasValue)
            return await GenerateTicketNumberAsync(originalDate);

        var company  = await companies.GetActiveCompanyAsync();
        var prefix   = string.IsNullOrWhiteSpace(company.TicketPrefix)
            ? await db.GetSettingAsync("ticket_prefix", "INF")
            : company.TicketPrefix;
        var pattern  = $"{prefix}-RMA-IMPORT-%";
        var count    = await db.RMATickets
            .CountAsync(t => EF.Functions.Like(t.InternalTicketNo, pattern));

        var seq      = count + 1;
        var ticketNo = $"{prefix}-RMA-IMPORT-{seq:D4}";

        while (await db.RMATickets.AnyAsync(t => t.InternalTicketNo == ticketNo))
        {
            seq++;
            ticketNo = $"{prefix}-RMA-IMPORT-{seq:D4}";
        }
        return ticketNo;
    }

    /// <summary>
    /// Poka-yoke: RMA delete only while the OEM dispatch / challan chain has not started.
    /// Blocked after batch dispatch, goods from OEM, customer dispatch, or closed.
    /// </summary>
    public async Task<(bool Ok, string Reason)> CanDeleteTicketAsync(int ticketId)
    {
        var ticket = await db.RMATickets
            .AsNoTracking()
            .FirstOrDefaultAsync(t => t.Id == ticketId);
        if (ticket == null) return (false, "Ticket not found.");

        var (_, role) = await session.GetCurrentAsync();
        if (!AppRoles.CanEditSerials(role))
            return (false, "Your role cannot delete RMA tickets.");

        // Irreversible / chain started — fail closed
        if (!string.IsNullOrWhiteSpace(ticket.BatchDispatchId))
            return (false, "Cannot delete — ticket is in a monthly OEM batch (" + ticket.BatchDispatchId + ").");

        if (ticket.OemDispatchDate != null)
            return (false, "Cannot delete — OEM dispatch date is recorded.");

        if (!string.IsNullOrWhiteSpace(ticket.ZohoChallanId) ||
            !string.IsNullOrWhiteSpace(ticket.ZohoChallanNumber) ||
            ticket.ChallanCreatedAt != null)
            return (false, "Cannot delete — delivery challan already created.");

        if (ticket.DispatchToCustomerDate != null)
            return (false, "Cannot delete — already dispatched to customer.");

        if (ticket.ClosedAt != null ||
            ticket.Status is RMAStatus.Closed or RMAStatus.ClosedReturned)
            return (false, "Cannot delete — ticket is closed.");

        if (ticket.Status is RMAStatus.DispatchedToOem
            or RMAStatus.GoodsReceivedFromOem
            or RMAStatus.DispatchedToCustomer)
            return (false, $"Cannot delete — status is {RMAStatus.Label(ticket.Status)} (OEM chain started).");

        // OEM RMA assigned: Admin only
        if (ticket.Status == RMAStatus.OemRmaReceived ||
            !string.IsNullOrWhiteSpace(ticket.OemRmaNumber))
        {
            if (!AppRoles.CanOverride(role))
                return (false, "Cannot delete — OEM RMA # is assigned. Ask an Admin to delete.");
            return (true, "Admin may delete (OEM RMA assigned — confirm carefully).");
        }

        // OPEN / AWAITING_OEM_RMA — editors may delete
        if (ticket.Status is RMAStatus.Open or RMAStatus.AwaitingOemRma)
            return (true, "Safe to delete — not yet dispatched to OEM.");

        return (false, $"Cannot delete — status is {RMAStatus.Label(ticket.Status)}.");
    }

    public async Task DeleteTicketAsync(int ticketId)
    {
        var (ok, reason) = await CanDeleteTicketAsync(ticketId);
        if (!ok) throw new InvalidOperationException(reason);

        var ticket = await db.RMATickets
            .Include(t => t.Photos)
            .FirstOrDefaultAsync(t => t.Id == ticketId)
            ?? throw new InvalidOperationException("Ticket not found.");

        // Remove photo files from disk
        foreach (var p in ticket.Photos.ToList())
        {
            try
            {
                if (!string.IsNullOrWhiteSpace(p.FilePath) && File.Exists(p.FilePath))
                    File.Delete(p.FilePath);
            }
            catch { /* keep going — DB delete still required */ }
        }

        // Remove generated Excel if present
        try
        {
            if (!string.IsNullOrWhiteSpace(ticket.ExcelFilePath) && File.Exists(ticket.ExcelFilePath))
                File.Delete(ticket.ExcelFilePath);
        }
        catch { /* ignore */ }

        db.RMATickets.Remove(ticket); // cascade photos
        await db.SaveChangesAsync();
    }

    /// <summary>
    /// Classifies open (non-closed) RMAs against a proposed new RMA.
    /// One machine may have several open RMAs as long as each is for a different part.
    /// </summary>
    public async Task<RmaDuplicateCheck> CheckOpenDuplicatesAsync(
        string? printerSn, string? faultyPart, string? faultyPartNo, string? faultyPartSn,
        int? excludeTicketId = null)
    {
        var productSn = NormSn(printerSn);
        var partSn = NormSn(faultyPartSn);
        if (productSn == null && partSn == null) return RmaDuplicateCheck.Empty;

        await ScopeAsync();
        var closed = new[] { RMAStatus.Closed, RMAStatus.ClosedReturned };
        var q = db.RMATickets.AsNoTracking()
            .Where(t => t.ClosedAt == null && !closed.Contains(t.Status)
                        && (t.PrinterSn != null || t.FaultyPartSn != null));

        if (excludeTicketId is > 0)
            q = q.Where(t => t.Id != excludeTicketId.Value);

        var open = await q.OrderByDescending(t => t.CreatedAt).Take(2000).ToListAsync();
        var partKey = NormPart(faultyPart);
        var partNo = NormPart(faultyPartNo);

        var blocks = new List<RmaConflict>();
        var sameMachine = new List<RMATicket>();

        foreach (var t in open)
        {
            var tProductSn = NormSn(t.PrinterSn);
            var tPartSn = NormSn(t.FaultyPartSn);
            var label = $"{t.InternalTicketNo} ({RMAStatus.Label(t.Status)})";

            if (partSn != null && tPartSn != null &&
                string.Equals(partSn, tPartSn, StringComparison.OrdinalIgnoreCase))
            {
                blocks.Add(new RmaConflict(t, RmaConflictKind.SamePartSerial,
                    $"Part serial {tPartSn} is already on open RMA {label} " +
                    $"for printer {t.PrinterSn ?? "—"}. One physical part should not be on two open RMAs."));
                continue;
            }

            var sameProductSn = productSn != null && tProductSn != null
                && string.Equals(productSn, tProductSn, StringComparison.OrdinalIgnoreCase);
            if (!sameProductSn) continue;

            if (IsSamePartOnMachine(partKey, partNo, partSn, t))
                blocks.Add(new RmaConflict(t, RmaConflictKind.SamePartOnMachine,
                    SamePartReason(t, label, partSn)));
            else
                sameMachine.Add(t);
        }

        return new RmaDuplicateCheck(blocks.Take(20).ToList(), sameMachine.Take(20).ToList());
    }

    static string SamePartReason(RMATicket t, string label, string? partSn)
    {
        if (NormPart(t.FaultyPart) == null)
            return $"Open RMA {label} on this printer has no faulty part recorded, so it may be for the same part.";

        var reason = $"This printer already has open RMA {label} for {t.FaultyPart}";
        var tPartSn = NormSn(t.FaultyPartSn);
        if (partSn == null || tPartSn == null)
            reason += ", and the part serial is blank on " +
                      (partSn == null && tPartSn == null ? "both tickets" : partSn == null ? "this RMA" : "the open RMA") +
                      ", so they cannot be told apart.";
        else
            reason += $" with the same part serial {tPartSn}.";
        return reason;
    }

    /// <summary>
    /// Same part type on the same machine. Treated as a duplicate unless both tickets carry
    /// different part serials or different part numbers (fail closed when blank).
    /// </summary>
    static bool IsSamePartOnMachine(string? partKey, string? partNo, string? partSn, RMATicket t)
    {
        var tPartKey = NormPart(t.FaultyPart);
        if (partKey == null || tPartKey == null)
            return true;
        if (!string.Equals(partKey, tPartKey, StringComparison.OrdinalIgnoreCase))
            return false;

        var tPartNo = NormPart(t.FaultyPartNo);
        if (partNo != null && tPartNo != null &&
            !string.Equals(partNo, tPartNo, StringComparison.OrdinalIgnoreCase))
            return false;

        var tPartSn = NormSn(t.FaultyPartSn);
        if (partSn != null && tPartSn != null &&
            !string.Equals(partSn, tPartSn, StringComparison.OrdinalIgnoreCase))
            return false;

        return true;
    }

    /// <summary>
    /// Poka-yoke gate for creating an RMA. Any duplicate (same part serial, or same part on the
    /// same machine) is blocked with its reason unless an Admin or a user granted the
    /// duplicate-RMA override supplies a reason, which is stamped on the ticket
    /// (DuplicateOpenReason / By / At) with the block reasons.
    /// </summary>
    public async Task EnsureNoOpenDuplicateAsync(RMATicket ticket, string? adminOverrideReason)
    {
        var check = await CheckOpenDuplicatesAsync(
            ticket.PrinterSn, ticket.FaultyPart, ticket.FaultyPartNo, ticket.FaultyPartSn,
            ticket.Id > 0 ? ticket.Id : null);

        if (!check.IsBlocked) return;

        var reasons = string.Join(" ", check.Blocks.Take(3).Select(b => b.Reason));
        if (string.IsNullOrWhiteSpace(adminOverrideReason))
        {
            throw new InvalidOperationException(
                "Duplicate RMA blocked. " + reasons +
                " Close the existing ticket, or ask an Admin or authorised user to override with a reason.");
        }

        var (name, role) = await session.GetCurrentAsync();
        var userId = await session.GetUserIdAsync();
        if (!await auth.CanOverrideDuplicateRmaAsync(userId, role))
            throw new InvalidOperationException(
                "Duplicate RMA blocked. " + reasons +
                " Only an Admin or a user granted 'Duplicate RMA override' can override this.");

        ticket.DuplicateOpenReason =
            adminOverrideReason.Trim() + " [overrode: " +
            string.Join("; ", check.Blocks.Select(b => b.Reason)) + "]";
        ticket.DuplicateOpenBy = (string.IsNullOrWhiteSpace(name) ? "User" : name) + $" ({role})";
        ticket.DuplicateOpenAt = DateTime.Now;
    }

    /// <summary>Other open RMAs on the same printer serial (for the detail page).</summary>
    public async Task<List<RMATicket>> ListOpenOnSameMachineAsync(string? printerSn, int excludeTicketId)
    {
        var sn = NormSn(printerSn);
        if (sn == null) return [];

        await ScopeAsync();
        var closed = new[] { RMAStatus.Closed, RMAStatus.ClosedReturned };
        var candidates = await db.RMATickets.AsNoTracking()
            .Where(t => t.Id != excludeTicketId && t.ClosedAt == null && !closed.Contains(t.Status)
                        && t.PrinterSn != null)
            .OrderByDescending(t => t.CreatedAt)
            .Take(2000)
            .ToListAsync();

        return candidates
            .Where(t => string.Equals(NormSn(t.PrinterSn), sn, StringComparison.OrdinalIgnoreCase))
            .Take(20)
            .ToList();
    }

    static string? NormSn(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        return SerialNumberParser.CleanToken(raw, out _) ?? raw.Trim().ToUpperInvariant();
    }

    static string? NormPart(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        return string.Join(' ', raw.Trim().ToUpperInvariant()
            .Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
    }
}

public enum RmaConflictKind
{
    /// <summary>Same faulty part serial already on an open RMA (any machine).</summary>
    SamePartSerial,
    /// <summary>Same part type on the same machine, not distinguishable by part serial / number.</summary>
    SamePartOnMachine,
}

public record RmaConflict(RMATicket Ticket, RmaConflictKind Kind, string Reason);

/// <param name="Blocks">Duplicates that block creation; each carries a user-facing reason. Admin may override.</param>
/// <param name="SameMachineOpen">Other open RMAs on the same machine for different parts — warning only.</param>
public record RmaDuplicateCheck(
    List<RmaConflict> Blocks,
    List<RMATicket> SameMachineOpen)
{
    public static RmaDuplicateCheck Empty { get; } = new([], []);
    public bool IsBlocked => Blocks.Count > 0;
}
