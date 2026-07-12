/**
 * Copy `text` to the system clipboard. Resolves `true` on success, `false` on any failure (a denied
 * permission, an insecure context, or no Clipboard API) — never throws, so a caller can honestly show
 * a "copied" vs "copy failed" hint without a try/catch at every call site.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* denied / insecure context — fall through to false */
  }
  return false;
}
