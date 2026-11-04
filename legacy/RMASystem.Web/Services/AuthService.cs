using System.Security.Claims;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using RMASystem.Data;
using RMASystem.Models;

namespace RMASystem.Services;

public class AuthService(
    IDbContextFactory<AppDbContext> dbFactory,
    IHttpContextAccessor httpContextAccessor,
    IPasswordHasher<AppUser> passwordHasher)
{
    public const string ClaimSessionId = "sid";
    public const string ClaimUserId = "uid";
    public const string ClaimMustChange = "must_change_pwd";
    public const string ClaimCompanyId = UserSessionService.ClaimCompanyId;

    /// <summary>Ensure each active company has an admin (username unique per company).</summary>
    public async Task EnsureSeedAsync()
    {
        await using var db = await dbFactory.CreateDbContextAsync();
        db.BypassCompanyFilter = true;

        if (string.IsNullOrEmpty(await db.GetSettingAsync("password_expiry_days")))
            await db.SetSettingAsync("password_expiry_days", "90");

        var companies = await db.Companies.AsNoTracking()
            .Where(c => c.IsActive)
            .Select(c => c.Id)
            .ToListAsync();
        if (companies.Count == 0)
            companies = [CompanyIds.InfiniteSolutions];

        foreach (var companyId in companies)
        {
            if (await db.AppUsers.AnyAsync(u => u.CompanyId == companyId && u.UserName == "admin"))
                continue;

            var admin = new AppUser
            {
                UserName = "admin",
                DisplayName = "Administrator",
                Role = AppRoles.Admin,
                CompanyId = companyId,
                IsEnabled = true,
                MustChangePassword = true,
                PasswordChangedAt = null,
                PasswordExpiryDays = null,
                CreatedAt = DateTime.Now,
                CreatedBy = "System",
            };
            admin.PasswordHash = passwordHasher.HashPassword(admin, "ChangeMe@123");
            db.AppUsers.Add(admin);
        }

        await db.SaveChangesAsync();
    }

    public async Task<int> GetGlobalPasswordExpiryDaysAsync()
    {
        await using var db = await dbFactory.CreateDbContextAsync();
        var raw = await db.GetSettingAsync("password_expiry_days", "90");
        return int.TryParse(raw, out var d) && d >= 0 ? d : 90;
    }

    public async Task SetGlobalPasswordExpiryDaysAsync(int days, int byAdminUserId)
    {
        if (days < 0) throw new InvalidOperationException("Expiry days cannot be negative (0 = never).");
        await using var db = await dbFactory.CreateDbContextAsync();
        await EnsureAdminAsync(db, byAdminUserId);
        await db.SetSettingAsync("password_expiry_days", days.ToString());
    }

    public static bool IsPasswordExpired(AppUser user, int globalExpiryDays)
    {
        if (user.MustChangePassword) return true;
        var days = user.PasswordExpiryDays ?? globalExpiryDays;
        if (days <= 0) return false; // 0 = never
        if (user.PasswordChangedAt == null) return true;
        return user.PasswordChangedAt.Value.Date.AddDays(days) < DateTime.Today;
    }

    public async Task<(bool Ok, string Error, Guid? SessionId, bool MustChangePassword)> LoginAsync(
        int companyId, string userName, string password, string? ip, string? userAgent)
    {
        userName = (userName ?? "").Trim();
        if (companyId <= 0)
            return (false, "Select a company before signing in.", null, false);
        if (string.IsNullOrEmpty(userName) || string.IsNullOrEmpty(password))
            return (false, "Username and password are required.", null, false);

        await using var db = await dbFactory.CreateDbContextAsync();
        db.BypassCompanyFilter = true;

        var company = await db.Companies.AsNoTracking()
            .FirstOrDefaultAsync(c => c.Id == companyId && c.IsActive);
        if (company == null)
            return (false, "Company not found or inactive.", null, false);

        var user = await db.AppUsers.FirstOrDefaultAsync(u =>
            u.CompanyId == companyId && u.UserName == userName);
        if (user == null)
            return (false, "Invalid username or password for this company.", null, false);
        if (!user.IsEnabled)
            return (false, "This account is disabled. Contact an administrator.", null, false);

        var verify = passwordHasher.VerifyHashedPassword(user, user.PasswordHash, password);
        if (verify == PasswordVerificationResult.Failed)
            return (false, "Invalid username or password for this company.", null, false);

        if (verify == PasswordVerificationResult.SuccessRehashNeeded)
        {
            user.PasswordHash = passwordHasher.HashPassword(user, password);
            await db.SaveChangesAsync();
        }

        var globalDays = int.TryParse(await db.GetSettingAsync("password_expiry_days", "90"), out var d) && d >= 0 ? d : 90;
        var mustChange = IsPasswordExpired(user, globalDays);

        var session = new AppUserSession
        {
            Id = Guid.NewGuid(),
            UserId = user.Id,
            StartedAt = DateTime.Now,
            LastSeenAt = DateTime.Now,
            IpAddress = Trunc(ip, 80),
            UserAgent = Trunc(userAgent, 300),
        };
        db.AppUserSessions.Add(session);
        await db.SaveChangesAsync();

        var http = httpContextAccessor.HttpContext
            ?? throw new InvalidOperationException("No HTTP context for login.");

        var claims = BuildClaims(user, session.Id.ToString("N"), mustChange);
        var identity = new ClaimsIdentity(claims, CookieAuthenticationDefaults.AuthenticationScheme);
        await http.SignInAsync(
            CookieAuthenticationDefaults.AuthenticationScheme,
            new ClaimsPrincipal(identity),
            new AuthenticationProperties
            {
                IsPersistent = true,
                IssuedUtc = DateTimeOffset.UtcNow,
                ExpiresUtc = DateTimeOffset.UtcNow.AddDays(7),
                AllowRefresh = true,
            });

        return (true, "", session.Id, mustChange);
    }

    public async Task LogoutAsync()
    {
        var http = httpContextAccessor.HttpContext;
        if (http == null) return;

        if (Guid.TryParse(http.User.FindFirstValue(ClaimSessionId), out var sid))
        {
            await using var db = await dbFactory.CreateDbContextAsync();
            var session = await db.AppUserSessions.FindAsync(sid);
            if (session != null && !session.IsRevoked)
            {
                session.IsRevoked = true;
                session.EndedAt = DateTime.Now;
                session.RevokedBy = "Self";
                await db.SaveChangesAsync();
            }
        }

        await http.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme);
    }

    /// <summary>
    /// Validate cookie / Blazor auth principal against AppUserSessions.
    /// Prefer passing the principal from AuthenticationStateProvider on Blazor circuits —
    /// IHttpContextAccessor is often null outside an HTTP request (e.g. Timer callbacks).
    /// </summary>
    public async Task<(bool Ok, string? FailReason, bool MustChangePassword)> ValidateCurrentSessionAsync(
        ClaimsPrincipal? principal = null)
    {
        principal ??= httpContextAccessor.HttpContext?.User;
        if (principal?.Identity?.IsAuthenticated != true)
            return (false, "not_authenticated", false);

        if (!Guid.TryParse(principal.FindFirstValue(ClaimSessionId), out var sid) ||
            !int.TryParse(principal.FindFirstValue(ClaimUserId), out var uid))
            return (false, "invalid_claims", false);

        await using var db = await dbFactory.CreateDbContextAsync();
        db.BypassCompanyFilter = true;
        var session = await db.AppUserSessions.Include(s => s.User)
            .FirstOrDefaultAsync(s => s.Id == sid);
        if (session == null || session.UserId != uid)
            return (false, "session_missing", false);
        if (session.IsRevoked || session.EndedAt != null)
            return (false, "session_ended", false);
        if (!session.User.IsEnabled)
            return (false, "user_disabled", false);

        // Poka-yoke: session company claim must match the user's home company
        if (int.TryParse(principal.FindFirstValue(ClaimCompanyId), out var claimCid) &&
            claimCid != session.User.CompanyId)
            return (false, "company_mismatch", false);

        if (session.LastSeenAt < DateTime.Now.AddMinutes(-2))
        {
            session.LastSeenAt = DateTime.Now;
            await db.SaveChangesAsync();
        }

        var globalDays = await GetGlobalPasswordExpiryDaysAsync();
        var mustChange = IsPasswordExpired(session.User, globalDays);
        return (true, null, mustChange);
    }

    public async Task ChangePasswordAsync(string currentPassword, string newPassword)
    {
        var http = httpContextAccessor.HttpContext
            ?? throw new InvalidOperationException("Not signed in.");
        if (!int.TryParse(http.User.FindFirstValue(ClaimUserId), out var uid))
            throw new InvalidOperationException("Not signed in.");

        if (string.IsNullOrWhiteSpace(newPassword) || newPassword.Length < 8)
            throw new InvalidOperationException("New password must be at least 8 characters.");

        await using var db = await dbFactory.CreateDbContextAsync();
        var user = await db.AppUsers.FindAsync(uid)
            ?? throw new InvalidOperationException("User not found.");

        if (passwordHasher.VerifyHashedPassword(user, user.PasswordHash, currentPassword)
            == PasswordVerificationResult.Failed)
            throw new InvalidOperationException("Current password is incorrect.");

        user.PasswordHash = passwordHasher.HashPassword(user, newPassword);
        user.PasswordChangedAt = DateTime.Now;
        user.MustChangePassword = false;
        await db.SaveChangesAsync();

        await RefreshSignInClaimsAsync(user);
    }

    async Task RefreshSignInClaimsAsync(AppUser user)
    {
        var http = httpContextAccessor.HttpContext;
        if (http == null) return;
        var sid = http.User.FindFirstValue(ClaimSessionId) ?? "";
        var claims = BuildClaims(user, sid, mustChange: false);
        var identity = new ClaimsIdentity(claims, CookieAuthenticationDefaults.AuthenticationScheme);
        await http.SignInAsync(
            CookieAuthenticationDefaults.AuthenticationScheme,
            new ClaimsPrincipal(identity),
            new AuthenticationProperties
            {
                IsPersistent = true,
                IssuedUtc = DateTimeOffset.UtcNow,
                ExpiresUtc = DateTimeOffset.UtcNow.AddDays(7),
                AllowRefresh = true,
            });
    }

    static List<Claim> BuildClaims(AppUser user, string sessionId, bool mustChange) =>
    [
        new(ClaimTypes.Name, user.DisplayName),
        new(ClaimTypes.NameIdentifier, user.UserName),
        new(ClaimTypes.Role, user.Role),
        new(ClaimUserId, user.Id.ToString()),
        new(ClaimSessionId, sessionId),
        new(ClaimMustChange, mustChange ? "1" : "0"),
        new(ClaimCompanyId, user.CompanyId.ToString()),
    ];

    // ── Admin: users (scoped to admin's company) ──────────────────────────────

    public async Task<List<AppUser>> ListUsersAsync(int byAdminUserId)
    {
        await using var db = await dbFactory.CreateDbContextAsync();
        var admin = await EnsureAdminAsync(db, byAdminUserId);
        return await db.AppUsers
            .Where(u => u.CompanyId == admin.CompanyId)
            .OrderBy(u => u.UserName)
            .ToListAsync();
    }

    public async Task<AppUser> CreateUserAsync(
        int byAdminUserId, string userName, string displayName, string role,
        string temporaryPassword, int? passwordExpiryDays, bool mustChangePassword = true)
    {
        await using var db = await dbFactory.CreateDbContextAsync();
        var admin = await EnsureAdminAsync(db, byAdminUserId);

        userName = userName.Trim();
        displayName = displayName.Trim();
        if (string.IsNullOrWhiteSpace(userName) || string.IsNullOrWhiteSpace(displayName))
            throw new InvalidOperationException("Username and display name are required.");
        if (!AppRoles.All.Contains(role, StringComparer.OrdinalIgnoreCase))
            throw new InvalidOperationException("Invalid role.");
        if (string.IsNullOrWhiteSpace(temporaryPassword) || temporaryPassword.Length < 8)
            throw new InvalidOperationException("Temporary password must be at least 8 characters.");
        if (await db.AppUsers.AnyAsync(u => u.CompanyId == admin.CompanyId && u.UserName == userName))
            throw new InvalidOperationException($"Username '{userName}' already exists for this company.");

        var user = new AppUser
        {
            UserName = userName,
            DisplayName = displayName,
            Role = role,
            CompanyId = admin.CompanyId,
            IsEnabled = true,
            MustChangePassword = mustChangePassword,
            PasswordChangedAt = mustChangePassword ? null : DateTime.Now,
            PasswordExpiryDays = passwordExpiryDays,
            CreatedAt = DateTime.Now,
            CreatedBy = admin.UserName,
        };
        user.PasswordHash = passwordHasher.HashPassword(user, temporaryPassword);
        db.AppUsers.Add(user);
        await db.SaveChangesAsync();
        return user;
    }

    public async Task SetUserEnabledAsync(int byAdminUserId, int userId, bool enabled)
    {
        await using var db = await dbFactory.CreateDbContextAsync();
        var admin = await EnsureAdminAsync(db, byAdminUserId);
        var user = await db.AppUsers.FindAsync(userId)
            ?? throw new InvalidOperationException("User not found.");
        if (user.CompanyId != admin.CompanyId)
            throw new InvalidOperationException("User belongs to another company.");

        if (!enabled)
        {
            if (user.Id == admin.Id)
                throw new InvalidOperationException("You cannot disable your own account.");
            if (string.Equals(user.Role, AppRoles.Admin, StringComparison.OrdinalIgnoreCase))
            {
                var otherAdmins = await db.AppUsers.CountAsync(u =>
                    u.CompanyId == admin.CompanyId &&
                    u.IsEnabled && u.Role == AppRoles.Admin && u.Id != user.Id);
                if (otherAdmins == 0)
                    throw new InvalidOperationException("Cannot disable the last enabled Admin for this company.");
            }
        }

        user.IsEnabled = enabled;
        user.DisabledAt = enabled ? null : DateTime.Now;
        user.DisabledBy = enabled ? null : admin.UserName;
        await db.SaveChangesAsync();

        if (!enabled)
            await RevokeAllSessionsForUserAsync(db, user.Id, admin.UserName);
    }

    public async Task AdminResetPasswordAsync(
        int byAdminUserId, int userId, string temporaryPassword, bool forceChange = true)
    {
        await using var db = await dbFactory.CreateDbContextAsync();
        var admin = await EnsureAdminAsync(db, byAdminUserId);
        var user = await db.AppUsers.FindAsync(userId)
            ?? throw new InvalidOperationException("User not found.");
        if (user.CompanyId != admin.CompanyId)
            throw new InvalidOperationException("User belongs to another company.");
        if (user.Id == admin.Id)
            throw new InvalidOperationException("Use Change Password for your own account.");
        if (string.IsNullOrWhiteSpace(temporaryPassword) || temporaryPassword.Length < 8)
            throw new InvalidOperationException("Password must be at least 8 characters.");

        user.PasswordHash = passwordHasher.HashPassword(user, temporaryPassword);
        user.MustChangePassword = forceChange;
        user.PasswordChangedAt = forceChange ? null : DateTime.Now;
        db.ActivityLogs.Add(new ActivityLog
        {
            Category = "Admin",
            Title = $"Password set by Admin — {user.UserName}",
            Detail = Trunc($"By {admin.UserName}; must change at next sign-in: {(forceChange ? "yes" : "no")}", 300),
            Color = "warning",
            RefLink = "/admin/users",
            CreatedAt = DateTime.Now,
        });
        await db.SaveChangesAsync();
        await RevokeAllSessionsForUserAsync(db, user.Id, admin.UserName);
    }

    public async Task SetUserPasswordPolicyAsync(
        int byAdminUserId, int userId, int? expiryDays, bool? mustChangePassword)
    {
        await using var db = await dbFactory.CreateDbContextAsync();
        var admin = await EnsureAdminAsync(db, byAdminUserId);
        var user = await db.AppUsers.FindAsync(userId)
            ?? throw new InvalidOperationException("User not found.");
        if (user.CompanyId != admin.CompanyId)
            throw new InvalidOperationException("User belongs to another company.");
        if (expiryDays is < 0)
            throw new InvalidOperationException("Expiry days cannot be negative.");
        if (expiryDays.HasValue) user.PasswordExpiryDays = expiryDays;
        if (mustChangePassword == true)
        {
            user.MustChangePassword = true;
            await RevokeAllSessionsForUserAsync(db, user.Id, admin.UserName);
        }
        await db.SaveChangesAsync();
    }

    public async Task UpdateUserAsync(int byAdminUserId, int userId, string displayName, string role)
    {
        await using var db = await dbFactory.CreateDbContextAsync();
        var admin = await EnsureAdminAsync(db, byAdminUserId);
        var user = await db.AppUsers.FindAsync(userId)
            ?? throw new InvalidOperationException("User not found.");
        if (user.CompanyId != admin.CompanyId)
            throw new InvalidOperationException("User belongs to another company.");
        if (!AppRoles.All.Contains(role, StringComparer.OrdinalIgnoreCase))
            throw new InvalidOperationException("Invalid role.");

        if (user.Id == admin.Id && !string.Equals(role, AppRoles.Admin, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("You cannot remove your own Admin role.");

        if (string.Equals(user.Role, AppRoles.Admin, StringComparison.OrdinalIgnoreCase) &&
            !string.Equals(role, AppRoles.Admin, StringComparison.OrdinalIgnoreCase))
        {
            var otherAdmins = await db.AppUsers.CountAsync(u =>
                u.CompanyId == admin.CompanyId &&
                u.IsEnabled && u.Role == AppRoles.Admin && u.Id != user.Id);
            if (otherAdmins == 0)
                throw new InvalidOperationException("Cannot demote the last enabled Admin for this company.");
        }

        user.DisplayName = displayName.Trim();
        user.Role = role;
        await db.SaveChangesAsync();
    }

    // ── Admin: sessions (same company only) ───────────────────────────────────

    public async Task<List<AppUserSession>> ListActiveSessionsAsync(int byAdminUserId)
    {
        await using var db = await dbFactory.CreateDbContextAsync();
        var admin = await EnsureAdminAsync(db, byAdminUserId);
        return await db.AppUserSessions
            .Include(s => s.User)
            .Where(s => !s.IsRevoked && s.EndedAt == null && s.User.CompanyId == admin.CompanyId)
            .OrderByDescending(s => s.LastSeenAt)
            .ToListAsync();
    }

    public async Task RevokeSessionAsync(int byAdminUserId, Guid sessionId)
    {
        await using var db = await dbFactory.CreateDbContextAsync();
        var admin = await EnsureAdminAsync(db, byAdminUserId);
        var session = await db.AppUserSessions.Include(s => s.User)
            .FirstOrDefaultAsync(s => s.Id == sessionId)
            ?? throw new InvalidOperationException("Session not found.");
        if (session.User.CompanyId != admin.CompanyId)
            throw new InvalidOperationException("Session belongs to another company.");
        if (session.IsRevoked) return;
        session.IsRevoked = true;
        session.EndedAt = DateTime.Now;
        session.RevokedBy = admin.UserName;
        await db.SaveChangesAsync();
    }

    public async Task RevokeAllSessionsForUserByAdminAsync(int byAdminUserId, int userId)
    {
        await using var db = await dbFactory.CreateDbContextAsync();
        var admin = await EnsureAdminAsync(db, byAdminUserId);
        var user = await db.AppUsers.FindAsync(userId)
            ?? throw new InvalidOperationException("User not found.");
        if (user.CompanyId != admin.CompanyId)
            throw new InvalidOperationException("User belongs to another company.");
        await RevokeAllSessionsForUserAsync(db, userId, admin.UserName);
    }

    static async Task RevokeAllSessionsForUserAsync(AppDbContext db, int userId, string by)
    {
        var sessions = await db.AppUserSessions
            .Where(s => s.UserId == userId && !s.IsRevoked && s.EndedAt == null)
            .ToListAsync();
        foreach (var s in sessions)
        {
            s.IsRevoked = true;
            s.EndedAt = DateTime.Now;
            s.RevokedBy = by;
        }
        if (sessions.Count > 0)
            await db.SaveChangesAsync();
    }

    // ── Permission: override duplicate open RMA ───────────────────────────────

    /// <summary>
    /// AppSettings key holding comma-separated AppUser ids (non-Admin) allowed to override
    /// a duplicate open RMA. Admins are always allowed. Stored as a setting so no schema change.
    /// </summary>
    public const string DuplicateRmaOverrideSettingKey = "perm_rma_duplicate_override_user_ids";

    public async Task<HashSet<int>> GetDuplicateRmaOverrideUserIdsAsync()
    {
        await using var db = await dbFactory.CreateDbContextAsync();
        return ParseIds(await db.GetSettingAsync(DuplicateRmaOverrideSettingKey, ""));
    }

    /// <summary>Admin always; otherwise only enabled users an Admin has explicitly granted.</summary>
    public async Task<bool> CanOverrideDuplicateRmaAsync(int? userId, string? role)
    {
        if (AppRoles.CanOverride(role)) return true;
        if (userId is null or <= 0) return false;

        await using var db = await dbFactory.CreateDbContextAsync();
        if (!ParseIds(await db.GetSettingAsync(DuplicateRmaOverrideSettingKey, "")).Contains(userId.Value))
            return false;
        return await db.AppUsers.AnyAsync(u => u.Id == userId.Value && u.IsEnabled);
    }

    public async Task SetDuplicateRmaOverrideAsync(int byAdminUserId, int userId, bool allowed)
    {
        await using var db = await dbFactory.CreateDbContextAsync();
        var admin = await EnsureAdminAsync(db, byAdminUserId);
        var user = await db.AppUsers.FindAsync(userId)
            ?? throw new InvalidOperationException("User not found.");
        if (user.CompanyId != admin.CompanyId)
            throw new InvalidOperationException("User belongs to another company.");
        if (AppRoles.CanOverride(user.Role))
            throw new InvalidOperationException("Admins can always override; no grant needed.");
        if (allowed && string.Equals(user.Role, AppRoles.Viewer, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Viewers are read-only and cannot be granted override.");

        var ids = ParseIds(await db.GetSettingAsync(DuplicateRmaOverrideSettingKey, ""));
        var changed = allowed ? ids.Add(user.Id) : ids.Remove(user.Id);
        if (!changed) return;

        db.ActivityLogs.Add(new ActivityLog
        {
            Category = "RMA",
            Title = $"{(allowed ? "Granted" : "Revoked")} duplicate-RMA override — {user.UserName}",
            Detail = Trunc($"By {admin.UserName} for {user.DisplayName} ({user.Role})", 300),
            Color = allowed ? "warning" : "accent",
            RefLink = "/admin/users",
            CreatedAt = DateTime.Now,
        });
        await db.SetSettingAsync(DuplicateRmaOverrideSettingKey, string.Join(",", ids.OrderBy(i => i)));
    }

    static HashSet<int> ParseIds(string? raw) =>
        (raw ?? "")
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(s => int.TryParse(s, out var i) ? i : 0)
            .Where(i => i > 0)
            .ToHashSet();

    async Task<AppUser> EnsureAdminAsync(AppDbContext db, int byAdminUserId)
    {
        var admin = await db.AppUsers.FirstOrDefaultAsync(u => u.Id == byAdminUserId);
        if (admin == null || !admin.IsEnabled || !AppRoles.CanManageUsers(admin.Role))
            throw new InvalidOperationException("Admin rights required.");
        return admin;
    }

    static string? Trunc(string? s, int n) =>
        string.IsNullOrEmpty(s) ? s : (s.Length <= n ? s : s[..n]);
}
