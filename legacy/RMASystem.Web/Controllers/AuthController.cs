using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using RMASystem.Services;

namespace RMASystem.Controllers;

[ApiController]
[Route("api/auth")]
[IgnoreAntiforgeryToken]
public class AuthController(AuthService auth) : ControllerBase
{
    public record LoginRequest(string UserName, string Password);

    [HttpPost("login")]
    [AllowAnonymous]
    public async Task<IActionResult> Login(
        [FromForm] int companyId,
        [FromForm] string userName,
        [FromForm] string password)
    {
        var ip = HttpContext.Connection.RemoteIpAddress?.ToString();
        var ua = Request.Headers.UserAgent.ToString();
        var (ok, error, _, mustChange) = await auth.LoginAsync(companyId, userName, password, ip, ua);
        if (!ok)
            return Redirect($"/login?error={Uri.EscapeDataString(error)}");

        // Full browser navigation so the auth cookie is applied before Blazor reconnects
        if (mustChange)
            return Redirect("/change-password");
        return Redirect("/");
    }

    [HttpPost("change-password")]
    [Authorize]
    public async Task<IActionResult> ChangePassword(
        [FromForm] string currentPassword,
        [FromForm] string newPassword,
        [FromForm] string confirmPassword)
    {
        if (!string.Equals(newPassword, confirmPassword, StringComparison.Ordinal))
            return Redirect("/change-password?error=" + Uri.EscapeDataString("New password and confirmation do not match."));
        try
        {
            await auth.ChangePasswordAsync(currentPassword, newPassword);
            return Redirect("/");
        }
        catch (Exception ex)
        {
            return Redirect("/change-password?error=" + Uri.EscapeDataString(ex.Message));
        }
    }

    [HttpPost("logout")]
    [Authorize]
    public async Task<IActionResult> Logout()
    {
        await auth.LogoutAsync();
        return Redirect("/login");
    }

    [HttpGet("logout")]
    [AllowAnonymous]
    public async Task<IActionResult> LogoutGet()
    {
        await auth.LogoutAsync();
        return Redirect("/login");
    }
}
