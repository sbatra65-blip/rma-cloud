using System.ComponentModel.DataAnnotations;
using System.ComponentModel.DataAnnotations.Schema;

namespace RMASystem.Models;

/// <summary>OEM / vendor master. Products belong to an OEM.</summary>
public class OemVendor
{
    [Key]
    public int Id { get; set; }

    public int CompanyId { get; set; } = CompanyIds.InfiniteSolutions;

    [Required, MaxLength(40)]
    public string Code { get; set; } = "";

    [Required, MaxLength(200)]
    public string Name { get; set; } = "";

    public bool IsActive { get; set; } = true;

    [Column(TypeName = "datetime")]
    public DateTime CreatedAt { get; set; } = DateTime.Now;

    public ICollection<Product> Products { get; set; } = new List<Product>();
}

/// <summary>Product master under an OEM. Models belong to a product.</summary>
public class Product
{
    [Key]
    public int Id { get; set; }

    public int CompanyId { get; set; } = CompanyIds.InfiniteSolutions;

    public int OemVendorId { get; set; }

    [Required, MaxLength(40)]
    public string Code { get; set; } = "";

    [Required, MaxLength(200)]
    public string Name { get; set; } = "";

    public bool IsActive { get; set; } = true;

    [Column(TypeName = "datetime")]
    public DateTime CreatedAt { get; set; } = DateTime.Now;

    public OemVendor OemVendor { get; set; } = null!;
    public ICollection<ProductModel> Models { get; set; } = new List<ProductModel>();
}

/// <summary>Model master under a product. Serials / Care Pack devices link here.</summary>
public class ProductModel
{
    [Key]
    public int Id { get; set; }

    public int CompanyId { get; set; } = CompanyIds.InfiniteSolutions;

    public int ProductId { get; set; }

    [Required, MaxLength(40)]
    public string Code { get; set; } = "";

    [Required, MaxLength(200)]
    public string Name { get; set; } = "";

    public bool IsActive { get; set; } = true;

    [Column(TypeName = "datetime")]
    public DateTime CreatedAt { get; set; } = DateTime.Now;

    public Product Product { get; set; } = null!;
}

/// <summary>Customer master (company-scoped).</summary>
public class Customer
{
    [Key]
    public int Id { get; set; }

    public int CompanyId { get; set; } = CompanyIds.InfiniteSolutions;

    [Required, MaxLength(40)]
    public string Code { get; set; } = "";

    [Required, MaxLength(200)]
    public string Name { get; set; } = "";

    [MaxLength(100)] public string? State { get; set; }
    [MaxLength(100)] public string? City { get; set; }
    public string? Address { get; set; }
    [MaxLength(20)] public string? Postal { get; set; }
    [MaxLength(100)] public string? Country { get; set; } = "India";
    [MaxLength(150)] public string? ContactName { get; set; }
    [MaxLength(200)] public string? Email { get; set; }
    [MaxLength(50)] public string? Phone { get; set; }
    [MaxLength(20)] public string? Gstin { get; set; }

    public bool IsActive { get; set; } = true;

    [Column(TypeName = "datetime")]
    public DateTime CreatedAt { get; set; } = DateTime.Now;
}

/// <summary>Care pack cover period / type master (1 Year, 3 Year, …).</summary>
public class CarePackTypeMaster
{
    [Key]
    public int Id { get; set; }

    public int CompanyId { get; set; } = CompanyIds.InfiniteSolutions;

    [Required, MaxLength(80)]
    public string Name { get; set; } = "";

    /// <summary>Duration in years used for warranty end calculation.</summary>
    public int DurationYears { get; set; } = 5;

    public bool IsActive { get; set; } = true;

    [Column(TypeName = "datetime")]
    public DateTime CreatedAt { get; set; } = DateTime.Now;
}
