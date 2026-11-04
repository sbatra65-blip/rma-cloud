using Microsoft.EntityFrameworkCore;
using RMASystem;
using RMASystem.Data;
using RMASystem.Models;

namespace RMASystem.Services;

public class PhotoService(AppDbContext db)
{
    private async Task<string> GetBasePhotoDir()
    {
        var baseDir = await db.GetSettingAsync("base_dir", AppPaths.DataRoot);
        return Path.Combine(baseDir, "Photos");
    }

    /// <summary>
    /// Returns the directory for a ticket's photos.
    /// e.g. ...Photos\2026\05\INF-RMA-202605-0001\INBOUND\
    /// </summary>
    public async Task<string> GetPhotoDirectoryAsync(string ticketNo, string direction)
    {
        var baseDir = await GetBasePhotoDir();
        var parts   = ticketNo.Split('-');
        string year, month;

        if (parts.Length >= 3 && parts[2].Length == 6 && parts[2].All(char.IsDigit))
        {
            year  = parts[2][..4];
            month = parts[2][4..];
        }
        else
        {
            year  = DateTime.Now.Year.ToString();
            month = DateTime.Now.Month.ToString("D2");
        }

        var dir = Path.Combine(baseDir, year, month, ticketNo, direction.ToUpper());
        Directory.CreateDirectory(dir);
        return dir;
    }

    /// <summary>Saves an uploaded photo file with the correct naming convention.</summary>
    public async Task<RMAPhoto> SavePhotoAsync(
        RMATicket ticket,
        Stream fileStream,
        string originalFileName,
        string direction,
        string capturedBy = "user",
        string? notes = null)
    {
        direction = direction.ToUpper();
        var photoDir = await GetPhotoDirectoryAsync(ticket.InternalTicketNo, direction);

        // Count existing photos to get sequence number (jpg/jpeg/png/webp)
        var existingCount = 0;
        if (Directory.Exists(photoDir))
        {
            existingCount = Directory.EnumerateFiles(photoDir)
                .Count(f =>
                {
                    var ext = Path.GetExtension(f);
                    return ext.Equals(".jpg", StringComparison.OrdinalIgnoreCase)
                        || ext.Equals(".jpeg", StringComparison.OrdinalIgnoreCase)
                        || ext.Equals(".png", StringComparison.OrdinalIgnoreCase)
                        || ext.Equals(".webp", StringComparison.OrdinalIgnoreCase)
                        || ext.Equals(".bmp", StringComparison.OrdinalIgnoreCase);
                });
        }
        var seq      = existingCount + 1;
        var filename = $"{ticket.InternalTicketNo}_{direction}_{seq:D3}.jpg";
        var fullPath = Path.Combine(photoDir, filename);

        // Persist as .jpg name (bytes kept as uploaded; browsers accept jpeg/png)
        await using var fs = new FileStream(fullPath, FileMode.Create);
        await fileStream.CopyToAsync(fs);

        var photo = new RMAPhoto
        {
            RmaTicketId = ticket.Id,
            Direction   = direction,
            Filename    = filename,
            FilePath    = fullPath,
            CapturedBy  = capturedBy,
            Notes       = notes,
            CapturedAt  = DateTime.Now,
        };
        db.RMAPhotos.Add(photo);
        await db.SaveChangesAsync();
        return photo;
    }

    public async Task<List<RMAPhoto>> GetPhotosAsync(int ticketId, string? direction = null)
    {
        var q = db.RMAPhotos.Where(p => p.RmaTicketId == ticketId);
        if (direction != null)
            q = q.Where(p => p.Direction == direction.ToUpper());
        return await q.OrderBy(p => p.CapturedAt).ToListAsync();
    }

    public async Task<bool> DeletePhotoAsync(int photoId)
    {
        var photo = await db.RMAPhotos.FindAsync(photoId);
        if (photo == null) return false;

        if (File.Exists(photo.FilePath))
            File.Delete(photo.FilePath);

        db.RMAPhotos.Remove(photo);
        await db.SaveChangesAsync();
        return true;
    }

    public async Task<byte[]?> GetPhotoBytes(int photoId)
    {
        var photo = await db.RMAPhotos.FindAsync(photoId);
        if (photo == null || !File.Exists(photo.FilePath)) return null;
        return await File.ReadAllBytesAsync(photo.FilePath);
    }
}
