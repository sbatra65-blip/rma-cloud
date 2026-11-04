using System.Text.RegularExpressions;
using ExcelDataReader;
using System.Text;
using RMASystem.Models;

namespace RMASystem.Services;

/// <summary>
/// Unified serial-number parser with poka-yoke cleaning.
/// Accepts any realistic printer SN (TEBT…, T6EV…, etc.) — formats vary by OEM/model/year.
/// Prefers labeled blocks (S.No# / Serial) then line/comma tokens.
/// </summary>
public static class SerialNumberParser
{
    /// <summary>Legacy TEBT + 8 digits (still recognized).</summary>
    public static readonly Regex TeBtPattern = new(
        @"^TEBT\d{8}$", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    public static readonly Regex TeBtLoose = new(
        @"\bTEB\s*T?\s*\d{8}\b", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    /// <summary>Labeled serial block on printer lines, e.g. S.No#: T6EV…, T6EV…</summary>
    public static readonly Regex LabeledSerialBlock = new(
        @"(?:S\.?\s*No\.?\s*#?|Serial\s*(?:No\.?|Number|#)?|S/?N)\s*[:#]?\s*(.+?)(?=(?:\r?\n\s*(?:PART|HSN|Qty|Rate|Amount|Comprehensive|Care\s*Pack|#\s*\d)|\r?\n\r?\n|$))",
        RegexOptions.IgnoreCase | RegexOptions.Compiled | RegexOptions.Singleline);

    static readonly HashSet<string> RejectTokens = new(StringComparer.OrdinalIgnoreCase)
    {
        "PCS", "PC", "NOS", "NO", "QTY", "QUANTITY", "HSN", "SAC", "GST", "GSTIN",
        "IGST", "CGST", "SGST", "TOTAL", "RATE", "AMOUNT", "PART", "SEE", "NOTES",
        "TERMS", "AND", "CONDITIONS", "YEAR", "YEARS", "PRINTER", "PRINTERS",
        "COMPREHENSIVE", "CARE", "PACK", "FOR", "THE", "THIS", "INVOICE",
        "PRINTRONIX", "HONEYWELL", "TSC", "BARCODE", "MODEL",
    };

    public record ParseResult(
        List<string> SerialNumbers,
        List<string> SpaceFixed,
        List<string> DuplicatesRemoved,
        int RawCount);

    public static ParseResult Parse(string? text)
    {
        if (string.IsNullOrWhiteSpace(text))
            return new ParseResult([], [], [], 0);

        // Prefer explicit S.No# / Serial: blocks (printer line pattern)
        var fromLabels = ExtractLabeledSerials(text);
        if (fromLabels.Count > 0)
            return Finalize(fromLabels);

        return Finalize(TokenizeAll(text));
    }

    /// <summary>Extract serials from free text — labeled blocks, TEBT, then general tokens.</summary>
    public static ParseResult ExtractFromLooseText(string? text)
    {
        if (string.IsNullOrWhiteSpace(text))
            return new ParseResult([], [], [], 0);

        var labeled = ExtractLabeledSerials(text);
        if (labeled.Count > 0)
            return Finalize(labeled);

        var bag = new List<string>();
        foreach (Match m in TeBtLoose.Matches(text))
            bag.Add(m.Value);

        // Alphanumeric tokens (no length gate — user owns correctness)
        foreach (Match m in Regex.Matches(text, @"\b[A-Za-z0-9][A-Za-z0-9\-]*\b"))
        {
            var c = CleanToken(m.Value, out _);
            if (c != null && !IsInvoiceNoise(c)) bag.Add(c);
        }

        return Finalize(bag);
    }

    static List<(string Token, bool SpaceFixed)> ExtractLabeledSerials(string text)
    {
        var list = new List<(string, bool)>();
        foreach (Match block in LabeledSerialBlock.Matches(text))
        {
            var body = block.Groups[1].Value;
            // Stop at PART # / HSN if captured in same line run
            body = Regex.Split(body, @"\bPART\s*#|\bHSN\b|\bSAC\b|\d{8}\s*PCS\b", RegexOptions.IgnoreCase)[0];
            // Also cut trailing 8-digit HSN glued without separator: …718184433290
            body = Regex.Replace(body, @"(\d)(84\d{6})(?!\d)", "$1");
            foreach (var piece in body.Split([',', ';', '\r', '\n', '\t'],
                         StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                var cleaned = CleanToken(piece, out var fixedSp);
                if (cleaned != null)
                    list.Add((cleaned, fixedSp));
            }
        }
        return list;
    }

    static List<(string Token, bool SpaceFixed)> TokenizeAll(string text)
    {
        var list = new List<(string, bool)>();
        var lines = text.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries);
        foreach (var line in lines)
        {
            foreach (var token in line.Split([',', ';'], StringSplitOptions.RemoveEmptyEntries))
            {
                var cleaned = CleanToken(token, out var fixedSp);
                if (cleaned != null && !IsInvoiceNoise(cleaned))
                    list.Add((cleaned, fixedSp));
            }
        }
        return list;
    }

    static ParseResult Finalize(List<(string Token, bool SpaceFixed)> raw)
    {
        var spaceFixed = new List<string>();
        var duplicates = new List<string>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var result = new List<string>();
        var rawCount = 0;

        foreach (var (token, wasFixed) in raw)
        {
            rawCount++;
            if (wasFixed)
                spaceFixed.Add($"→ {token}");
            if (!seen.Add(token))
            {
                if (!duplicates.Contains(token, StringComparer.OrdinalIgnoreCase))
                    duplicates.Add(token);
                continue;
            }
            result.Add(token);
        }
        return new ParseResult(result, spaceFixed, duplicates, rawCount);
    }

    static ParseResult Finalize(List<string> tokens) =>
        Finalize(tokens.Select(t => (t, false)).ToList());

    public static string? CleanToken(string token, out bool wasSpaceFixed)
    {
        wasSpaceFixed = false;
        if (string.IsNullOrWhiteSpace(token)) return null;

        var stripped = token.Trim().TrimEnd('.', ':');
        var noSpaces = Regex.Replace(stripped, @"\s+", "");
        if (stripped.Any(char.IsWhiteSpace))
            wasSpaceFixed = true;

        noSpaces = noSpaces.ToUpperInvariant();
        if (string.IsNullOrEmpty(noSpaces)) return null;

        // Normalize classic TEB Txxxxxxxx → TEBTxxxxxxxx (format help only, not a length rule)
        if (Regex.IsMatch(noSpaces, @"^TEBT?\d+$", RegexOptions.IgnoreCase) ||
            Regex.IsMatch(noSpaces, @"^TEB\s*T?\d+$", RegexOptions.IgnoreCase))
        {
            noSpaces = Regex.Replace(noSpaces, @"^TEB\s*T?", "TEBT", RegexOptions.IgnoreCase);
        }

        // Peel trailing HSN/PCS often glued in PDF text (e.g. …7181844332904PCS) — not a length check
        var peelHsn = Regex.Match(noSpaces, @"^(.+?)(84\d{6,})(?:PCS)?$", RegexOptions.IgnoreCase);
        if (peelHsn.Success && peelHsn.Groups[1].Value.Any(char.IsLetter))
            noSpaces = peelHsn.Groups[1].Value.ToUpperInvariant();

        return noSpaces;
    }

    /// <summary>Non-empty after clean — no length / pattern rules (user ensures correctness).</summary>
    public static bool IsValid(string? sn)
    {
        if (string.IsNullOrWhiteSpace(sn)) return false;
        var cleaned = CleanToken(sn, out _) ?? sn.Trim();
        return !string.IsNullOrWhiteSpace(cleaned);
    }

    /// <summary>Skip obvious invoice words when auto-scanning free text (not a length rule).</summary>
    public static bool IsInvoiceNoise(string? sn)
    {
        if (string.IsNullOrWhiteSpace(sn)) return true;
        var s = sn.Trim().ToUpperInvariant();
        if (RejectTokens.Contains(s)) return true;
        // Pure HSN-like digit runs often appear next to serials in PDF dumps
        if (Regex.IsMatch(s, @"^\d{6,12}$")) return true;
        return false;
    }

    /// <summary>Kept for callers; same as IsValid (no length checks).</summary>
    public static bool IsValidSerialShape(string? sn) => IsValid(sn);

    public static int? DetectQtyFromText(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;

        var patterns = new[]
        {
            @"\b(?:qty|quantity)\s*[:=]?\s*(\d{1,4})\b",
            @"\b(\d{1,4})\s*(?:pcs|pc|nos|no\.?|units?|printers?)\b",
            @"\b(?:pcs|pc|nos|units?)\s*[:=]?\s*(\d{1,4})\b",
        };
        foreach (var p in patterns)
        {
            var m = Regex.Match(text, p, RegexOptions.IgnoreCase);
            if (m.Success && int.TryParse(m.Groups[1].Value, out var q) && q is > 0 and < 10000)
                return q;
        }
        return null;
    }

    public static ParseResult ParseXlsx(Stream stream)
    {
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
        using var reader = ExcelReaderFactory.CreateReader(stream);
        var ds = reader.AsDataSet();
        var sb = new StringBuilder();

        foreach (System.Data.DataTable table in ds.Tables)
        {
            int? snCol = null;
            if (table.Rows.Count > 0)
            {
                var header = table.Rows[0];
                for (int c = 0; c < table.Columns.Count; c++)
                {
                    var h = header[c]?.ToString()?.Trim() ?? "";
                    if (Regex.IsMatch(h, @"^(serial|sn|serial\s*number|s\.?n\.?)$",
                            RegexOptions.IgnoreCase))
                    {
                        snCol = c;
                        break;
                    }
                }
            }

            int startRow = snCol.HasValue ? 1 : 0;
            for (int r = startRow; r < table.Rows.Count; r++)
            {
                if (snCol.HasValue)
                {
                    var v = table.Rows[r][snCol.Value]?.ToString();
                    if (!string.IsNullOrWhiteSpace(v)) sb.AppendLine(v);
                }
                else
                {
                    for (int c = 0; c < table.Columns.Count; c++)
                    {
                        var v = table.Rows[r][c]?.ToString();
                        if (!string.IsNullOrWhiteSpace(v)) sb.AppendLine(v);
                    }
                }
            }
        }

        return ExtractFromLooseText(sb.ToString());
    }

    /// <param name="clubbedPo">
    /// When true (default), one OEM PO may cover multiple sales invoices:
    /// extra PO serials are informational, not mismatches. Match = all invoice SNs ⊆ PO.
    /// </param>
    public static CrossValidationResult CrossValidate(
        IEnumerable<string> invoiceSns, IEnumerable<string> poSns, bool clubbedPo = true)
    {
        var inv = new HashSet<string>(invoiceSns, StringComparer.OrdinalIgnoreCase);
        var po  = new HashSet<string>(poSns, StringComparer.OrdinalIgnoreCase);

        var matched   = inv.Intersect(po, StringComparer.OrdinalIgnoreCase).OrderBy(x => x).ToList();
        var onlyInPo  = po.Except(inv, StringComparer.OrdinalIgnoreCase).OrderBy(x => x).ToList();
        var onlyInInv = inv.Except(po, StringComparer.OrdinalIgnoreCase).OrderBy(x => x).ToList();

        var totalUnique = Math.Max(inv.Count, 1);
        // Clubbed: only missing invoice serials count toward mismatch %
        var mismatchPct = clubbedPo
            ? onlyInInv.Count * 100.0 / totalUnique
            : (onlyInPo.Count + onlyInInv.Count) * 100.0 / totalUnique;

        var perfect = clubbedPo
            ? onlyInInv.Count == 0 && inv.Count > 0 && po.Count > 0
            : onlyInPo.Count == 0 && onlyInInv.Count == 0 && inv.Count > 0;

        return new CrossValidationResult(
            matched, onlyInPo, onlyInInv, mismatchPct, perfect, clubbedPo);
    }

    public record CrossValidationResult(
        List<string> Matched,
        List<string> OnlyInPo,
        List<string> OnlyInInvoice,
        double MismatchPercent,
        bool PerfectMatch,
        bool ClubbedPo = true);
}

/// <summary>
/// Groups Zoho invoice lines into printer + care-pack sets.
/// Serials/model come from printer line(s); care-pack line has type/years (often no SNs).
/// Multiple sets = one invoice covering multiple POs.
/// </summary>
public static class InvoiceCarePackSetBuilder
{
    public record LineSet(
        int SetIndex,
        string PrinterItemName,
        string? CarePackItemName,
        string? PrinterModel,
        string? OemBrand,
        string? CarePackType,
        int Qty,
        List<string> SerialNumbers,
        string CombinedDescription,
        BrandMismatchDetector.MismatchResult Mismatch);

    public static bool IsCarePackLine(ZohoLineItem line)
    {
        var t = $"{line.Name} {line.Description}".ToUpperInvariant();
        return t.Contains("CARE PACK") || t.Contains("CAREPACK") ||
               t.Contains("YCCP") || Regex.IsMatch(t, @"\b\d\s*Y\s*CCP\b") ||
               (t.Contains("CCP") && (t.Contains("COMPREHENSIVE") || t.Contains("YEAR")));
    }

    public static bool IsPrinterLine(ZohoLineItem line)
    {
        if (IsCarePackLine(line)) return false;
        var t = $"{line.Name} {line.Description}".ToUpperInvariant();
        if (t.Contains("PRINTER") || t.Contains("BARCODE")) return true;
        // Has labeled serials → treat as printer/hardware line
        var sns = SerialNumberParser.Parse($"{line.Name}\n{line.Description}");
        return sns.SerialNumbers.Count > 0;
    }

    public static List<LineSet> Build(IReadOnlyList<ZohoLineItem> lines, string? invoiceNotes = null)
    {
        var sets = new List<LineSet>();
        var pending = new List<ZohoLineItem>();
        var index = 1;

        void Flush(ZohoLineItem? carePack)
        {
            if (pending.Count == 0 && carePack == null) return;

            // One invoice can have any number of products. Prefer one LineSet per
            // product line so serials are entered/stored against that product.
            if (pending.Count <= 1)
            {
                sets.Add(BuildOne(index++, pending.ToList(), carePack, invoiceNotes));
                pending.Clear();
                return;
            }

            foreach (var printer in pending)
            {
                sets.Add(BuildOne(index++, [printer], carePack, invoiceNotes,
                    qtyOverride: Math.Max(1, (int)printer.Quantity)));
            }
            pending.Clear();
        }

        foreach (var line in lines)
        {
            if (IsCarePackLine(line))
            {
                // Care pack closes the current product group (typical: product then CP)
                if (pending.Count > 0)
                    Flush(line);
                else
                    // Orphan care pack — still a set (SNs may be in notes only)
                    sets.Add(BuildOne(index++, [], line, invoiceNotes));
            }
            else if (IsPrinterLine(line))
            {
                // Start a new product when the previous pending product already has
                // its own serials / qty — keep consecutive hardware lines separate
                // once we already have one pending (pair with next care pack or flush).
                pending.Add(line);
            }
            // ignore unrelated lines (labels, ribbons, etc.)
        }

        if (pending.Count > 0)
            Flush(null);

        // Fallback: no structured sets — treat whole invoice as one set
        if (sets.Count == 0 && lines.Count > 0)
        {
            var allText = string.Join("\n", lines.Select(l => $"{l.Name}\n{l.Description}")) +
                          "\n" + (invoiceNotes ?? "");
            var sns = SerialNumberParser.Parse(allText);
            if (sns.SerialNumbers.Count == 0)
                sns = SerialNumberParser.ExtractFromLooseText(allText);
            var first = lines[0];
            var cp = lines.FirstOrDefault(IsCarePackLine);
            var mismatch = BrandMismatchDetector.Analyze(
                cp?.Name ?? first.Name, allText);
            sets.Add(new LineSet(
                1,
                first.Name,
                cp?.Name,
                mismatch.Model,
                mismatch.ItemBrand ?? mismatch.ModelBrand,
                mismatch.CarePackType,
                Math.Max(1, (int)(cp?.Quantity ?? first.Quantity)),
                sns.SerialNumbers,
                allText,
                mismatch));
        }

        return sets;
    }

    static LineSet BuildOne(
        int setIndex,
        List<ZohoLineItem> printers,
        ZohoLineItem? carePack,
        string? notes,
        int? qtyOverride = null)
    {
        var parts = new List<string>();
        foreach (var p in printers)
        {
            if (!string.IsNullOrWhiteSpace(p.Name)) parts.Add(p.Name);
            if (!string.IsNullOrWhiteSpace(p.Description)) parts.Add(p.Description!);
        }
        if (carePack != null)
        {
            if (!string.IsNullOrWhiteSpace(carePack.Name)) parts.Add(carePack.Name);
            if (!string.IsNullOrWhiteSpace(carePack.Description)) parts.Add(carePack.Description!);
        }
        if (!string.IsNullOrWhiteSpace(notes) && setIndex == 1)
            parts.Add(notes!);

        var combined = string.Join("\n", parts);

        // Serials primarily from printer lines (care pack usually has none)
        var printerText = string.Join("\n", printers.Select(p => $"{p.Name}\n{p.Description}"));
        var sns = SerialNumberParser.Parse(printerText);
        if (sns.SerialNumbers.Count == 0)
            sns = SerialNumberParser.ExtractFromLooseText(printerText);
        if (sns.SerialNumbers.Count == 0 && carePack != null)
        {
            var cpText = $"{carePack.Name}\n{carePack.Description}";
            sns = SerialNumberParser.Parse(cpText);
            if (sns.SerialNumbers.Count == 0)
                sns = SerialNumberParser.ExtractFromLooseText(cpText);
        }
        if (sns.SerialNumbers.Count == 0 && !string.IsNullOrWhiteSpace(notes))
        {
            sns = SerialNumberParser.Parse(notes);
            if (sns.SerialNumbers.Count == 0)
                sns = SerialNumberParser.ExtractFromLooseText(notes);
        }

        var printerName = printers.FirstOrDefault()?.Name
            ?? carePack?.Name
            ?? "Line item";
        var modelText = printerText;
        var model = OemBrandCatalog.DetectModelFromText(modelText)
                 ?? OemBrandCatalog.DetectModelFromText(printerName);
        var brandFromPrinter = OemBrandCatalog.DetectBrandFromText(printerName)
                            ?? OemBrandCatalog.DetectBrandFromText(modelText)
                            ?? OemBrandCatalog.DetectBrandFromModel(model);
        var cpName = carePack?.Name;
        var cpDesc = carePack != null ? $"{carePack.Name}\n{carePack.Description}" : combined;
        var years = OemBrandCatalog.DetectDurationYears(cpDesc)
                 ?? OemBrandCatalog.DetectDurationYears(combined);
        var cpType = OemBrandCatalog.CarePackTypeFromYears(years);
        var itemBrand = OemBrandCatalog.DetectBrandFromText(cpName)
                     ?? OemBrandCatalog.DetectBrandFromText(cpDesc)
                     ?? brandFromPrinter;

        // Mismatch: care pack brand vs printer model brand
        var mismatch = BrandMismatchDetector.Analyze(cpName ?? printerName, combined);
        // Prefer model from printer line when detector missed
        if (string.IsNullOrWhiteSpace(mismatch.Model) && !string.IsNullOrWhiteSpace(model))
        {
            mismatch = mismatch with
            {
                Model = model,
                ModelBrand = OemBrandCatalog.DetectBrandFromModel(model) ?? mismatch.ModelBrand,
            };
        }

        int qty;
        if (qtyOverride is > 0)
            qty = qtyOverride.Value;
        else if (printers.Count == 1 && printers[0].Quantity > 0)
            qty = (int)printers[0].Quantity;
        else
            qty = (int)(carePack?.Quantity > 0 ? carePack.Quantity
                : printers.Sum(p => p.Quantity));
        if (qty <= 0) qty = sns.SerialNumbers.Count > 0 ? sns.SerialNumbers.Count : 1;
        if (sns.SerialNumbers.Count > 0 && qty <= 1)
            qty = sns.SerialNumbers.Count;

        return new LineSet(
            setIndex,
            printerName,
            cpName,
            mismatch.Model ?? model,
            itemBrand ?? mismatch.ItemBrand ?? mismatch.ModelBrand,
            mismatch.CarePackType ?? cpType,
            qty,
            sns.SerialNumbers,
            combined,
            mismatch);
    }
}

/// <summary>Brand / model / care-pack mismatch detection (poka-yoke).</summary>
public static class BrandMismatchDetector
{
    public record MismatchResult(
        bool HasMismatch,
        string? ItemBrand,
        string? ModelBrand,
        string? Model,
        string? CarePackType,
        string Message);

    public static MismatchResult Analyze(string? itemName, string? description, string? vendorName = null)
    {
        var itemBrand  = OemBrandCatalog.DetectBrandFromText(itemName)
                      ?? OemBrandCatalog.DetectBrandFromText(description);
        var model      = OemBrandCatalog.DetectModelFromText(description)
                      ?? OemBrandCatalog.DetectModelFromText(itemName);
        var modelBrand = OemBrandCatalog.DetectBrandFromModel(model);
        var years      = OemBrandCatalog.DetectDurationYears(description)
                      ?? OemBrandCatalog.DetectDurationYears(itemName);
        var cpType     = OemBrandCatalog.CarePackTypeFromYears(years);

        if (itemBrand != null && modelBrand != null &&
            !string.Equals(itemBrand, modelBrand, StringComparison.OrdinalIgnoreCase))
        {
            return new MismatchResult(true, itemBrand, modelBrand, model, cpType,
                $"{itemBrand} care pack selected but {model} is a {modelBrand} model");
        }

        _ = vendorName; // reserved for future vendor vs item checks

        return new MismatchResult(false, itemBrand, modelBrand, model, cpType,
            "Brand and model are consistent");
    }
}
