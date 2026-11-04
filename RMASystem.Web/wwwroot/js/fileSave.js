// Save-as helpers for OEM Excel downloads (Chrome / Edge File System Access API)
window.rmaSaveFile = async function (fileName, base64, mime) {
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: mime || "application/octet-stream" });

  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: fileName,
        types: [{
          description: "Excel workbook",
          accept: {
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"]
          }
        }]
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return { ok: true, mode: "picker" };
    } catch (err) {
      if (err && err.name === "AbortError") {
        return { ok: false, mode: "cancelled" };
      }
      // Fall through to anchor download
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return { ok: true, mode: "download" };
};

/** Copy plain text for Zoho Mail paste (no OAuth). Returns true on success. */
window.rmaCopyText = async function (text) {
  const value = text == null ? "" : String(text);
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch (_) { /* fall through */ }

  const ta = document.createElement("textarea");
  ta.value = value;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.select();
  try {
    return !!document.execCommand("copy");
  } finally {
    ta.remove();
  }
};
