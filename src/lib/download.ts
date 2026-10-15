/**
 * File downloads for user-facing exports.
 *
 * Both the CSV and the JSON export go through the same shape: build a string,
 * hand it to a blob, click a throwaway anchor. The parts that are easy to get
 * wrong — revoking the object URL too early (Safari cancels the download) and
 * dropping the UTF-8 BOM (Excel reads accented names as mojibake) — are the
 * reason this lives in one place instead of inline at each call site.
 */

/** Trigger a download of `contents` as `filename`. */
export function downloadFile(
  filename: string,
  contents: string,
  mime: string,
): boolean {
  if (typeof document === "undefined") return false;
  const blob = new Blob([contents], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoked on the next tick: revoking synchronously can cancel the download
  // in Safari before it has read the blob.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

/**
 * Download a value as pretty-printed JSON.
 *
 * `JSON.stringify(value, null, 2)` rather than a hand-rolled join: the export
 * is meant to be read by whoever downloads it, and a single-line dump of a few
 * thousand history rows is unusable in any text editor.
 */
export function downloadJson(filename: string, value: unknown): boolean {
  return downloadFile(
    filename,
    JSON.stringify(value, null, 2),
    "application/json",
  );
}
