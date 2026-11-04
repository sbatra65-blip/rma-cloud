using System.ComponentModel.DataAnnotations;
using System.ComponentModel.DataAnnotations.Schema;

namespace RMASystem.Models;

public class AppUser
{
    [Key]
    public int Id { get; set; }

    [Required, MaxLength(80)]
    public string UserName { get; set; } = "";

    [Required, MaxLength(120)]
    public string DisplayName { get; set; } = "";

    [Required, MaxLength(200)]
    public string PasswordHash { get; set; } = "";

    [Required, MaxLength(30)]
    public string Role { get; set; } = AppRoles.Technician;

    /// <summary>When false, login is blocked and active sessions are revoked.</summary>
    public bool IsEnabled { get; set; } = true;

    public bool MustChangePassword { get; set; } = true;

    [Column(TypeName = "datetime")]
    public DateTime? PasswordChangedAt { get; set; }

    /// <summary>Null = use global password_expiry_days setting. 0 = never expires.</summary>
    public int? PasswordExpiryDays { get; set; }

    /// <summary>
    /// Home company — user belongs to exactly one company (selected at login).
    /// Username is unique per company, not globally.
    /// </summary>
    public int CompanyId { get; set; } = CompanyIds.InfiniteSolutions;

    [Column(TypeName = "datetime")]
    public DateTime CreatedAt { get; set; } = DateTime.Now;

    [MaxLength(100)] public string? CreatedBy { get; set; }

    [Column(TypeName = "datetime")]
    public DateTime? DisabledAt { get; set; }

    [MaxLength(100)] public string? DisabledBy { get; set; }

    public ICollection<AppUserSession> Sessions { get; set; } = new List<AppUserSession>();
}

public class AppUserSession
{
    [Key]
    public Guid Id { get; set; }

    public int UserId { get; set; }

    [Column(TypeName = "datetime")]
    public DateTime StartedAt { get; set; } = DateTime.Now;

    [Column(TypeName = "datetime")]
    public DateTime LastSeenAt { get; set; } = DateTime.Now;

    [Column(TypeName = "datetime")]
    public DateTime? EndedAt { get; set; }

    public bool IsRevoked { get; set; }

    [MaxLength(100)] public string? RevokedBy { get; set; }

    [MaxLength(80)] public string? IpAddress { get; set; }

    [MaxLength(300)] public string? UserAgent { get; set; }

    public AppUser User { get; set; } = null!;
}
