using Microsoft.AspNetCore.Components.Authorization;
using Microsoft.AspNetCore.Http;
using RMASystem.Models;
using System.Security.Claims;

namespace RMASystem.Services;

/// <summary>
/// Current user from authenticated cookie / Blazor auth state
/// (falls back only before first login seed).
/// </summary>
public class UserSessionService(
    IHttpContextAccessor httpContextAccessor,
    AuthenticationStateProvider authStateProvider,
    AuthService auth,
    CompanyContext companyContext)
{
    public const string ClaimCompanyId = "cid";

    int? _cachedCompanyId;

    public async Task EnsureSettingsAsync()
    {
        await auth.EnsureSeedAsync();
    }

    public async Task<(string Name, string Role)> GetCurrentAsync()
    {
        var user = await ResolveUserAsync();
        if (user?.Identity?.IsAuthenticated == true)
        {
            var name = user.Identity?.Name
                       ?? user.FindFirstValue(ClaimTypes.Name)
                       ?? "User";
            var role = user.FindFirstValue(ClaimTypes.Role) ?? AppRoles.Viewer;
            if (!AppRoles.All.Contains(role, StringComparer.OrdinalIgnoreCase))
                role = AppRoles.Viewer;
            return (name, role);
        }

        return ("", AppRoles.Viewer);
    }

    /// <summary>Active company for this session — set at login from the user's home company.</summary>
    public async Task<int> GetActiveCompanyIdAsync()
    {
        if (_cachedCompanyId is int cached && cached > 0)
        {
            companyContext.CompanyId = cached;
            return cached;
        }

        var user = await ResolveUserAsync();
        if (user?.Identity?.IsAuthenticated == true &&
            int.TryParse(user.FindFirstValue(ClaimCompanyId), out var cid) &&
            cid > 0)
        {
            _cachedCompanyId = cid;
            companyContext.CompanyId = cid;
            return cid;
        }

        // Fail closed — no authenticated company means no tenant rows
        _cachedCompanyId = null;
        companyContext.CompanyId = -1;
        return -1;
    }

    public void InvalidateCompanyCache()
    {
        _cachedCompanyId = null;
        companyContext.CompanyId = -1;
    }

    public string? GetUserName()
    {
        var httpUser = httpContextAccessor.HttpContext?.User;
        if (httpUser?.Identity?.IsAuthenticated == true)
            return httpUser.FindFirstValue(ClaimTypes.NameIdentifier);
        return null;
    }

    public int? GetUserId()
    {
        var httpUser = httpContextAccessor.HttpContext?.User;
        if (httpUser?.Identity?.IsAuthenticated == true &&
            int.TryParse(httpUser.FindFirstValue(AuthService.ClaimUserId), out var uid))
            return uid;
        return null;
    }

    /// <summary>Signed-in user id from the HTTP request or the Blazor circuit auth state.</summary>
    public async Task<int?> GetUserIdAsync()
    {
        var user = await ResolveUserAsync();
        if (user?.Identity?.IsAuthenticated == true &&
            int.TryParse(user.FindFirstValue(AuthService.ClaimUserId), out var uid))
            return uid;
        return null;
    }

    async Task<ClaimsPrincipal?> ResolveUserAsync()
    {
        var httpUser = httpContextAccessor.HttpContext?.User;
        if (httpUser?.Identity?.IsAuthenticated == true)
            return httpUser;

        try
        {
            var state = await authStateProvider.GetAuthenticationStateAsync();
            if (state.User?.Identity?.IsAuthenticated == true)
                return state.User;
        }
        catch
        {
            // Outside a circuit (e.g. background) — ignore
        }

        return httpUser;
    }

    public async Task SetCurrentAsync(string name, string role)
    {
        await Task.CompletedTask;
        throw new InvalidOperationException(
            "User identity is set by login. Use Admin → Users to manage accounts.");
    }

    public async Task<bool> IsAdminAsync()
    {
        var (_, role) = await GetCurrentAsync();
        return AppRoles.CanOverride(role);
    }

    public async Task<bool> CanImportAsync()
    {
        var (_, role) = await GetCurrentAsync();
        return AppRoles.CanImport(role);
    }

    public async Task<bool> CanEditSerialsAsync()
    {
        var (_, role) = await GetCurrentAsync();
        return AppRoles.CanEditSerials(role);
    }
}
