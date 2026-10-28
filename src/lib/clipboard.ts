/**
 * Reliable "copy to clipboard" for track links.
 *
 * `navigator.clipboard` is unavailable in insecure contexts and rejects on
 * older iOS Safari unless it is called from a real user gesture. Every caller
 * here is inside a click, but the API is still not dependable on phones, so:
 *
 *  - it resolves only when the text really landed in the clipboard, so a toast
 *    can never claim a copy that silently failed;
 *  - it falls back to a hidden textarea + `execCommand("copy")` instead of
 *    throwing, which is what still works on those browsers.
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied or a non-secure context — fall through.
    }
  }

  if (typeof document === "undefined") return false;
  const area = document.createElement("textarea");
  area.value = text;
  // Keep it off-screen but still focusable: `display: none` or
  // `visibility: hidden` make iOS Safari refuse the selection.
  area.setAttribute("readonly", "");
  area.style.cssText =
    "position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;pointer-events:none;";
  document.body.appendChild(area);
  const previous = document.activeElement as HTMLElement | null;
  try {
    area.focus();
    area.select();
    area.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
    previous?.focus?.();
  }
}
