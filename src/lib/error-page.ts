/**
 * Branded, plain-language error page for failed chia:// loads.
 *
 * Replaces the old raw dark `Error: <message>` pages that leaked internal crypto strings
 * (e.g. "decrypt failed (decoy or wrong key)") straight to users. This module renders ONE
 * white-themed page — matching welcome.html / the DIG Home NTP / hub.dig.net — with:
 *   - a plain-language explanation of what happened,
 *   - friendly causes (unreachable network / address doesn't exist),
 *   - a recovery action (try again, or go to DIG Home),
 * and it NEVER surfaces the internal failure string to the user.
 *
 * Plain ES module (no chrome.* / DOM) so the module SW (background.js) can import it and it
 * is unit-testable under `node --test`. The viewer page builds the same DOM from this copy
 * (kept in lockstep — see dig-viewer.js).
 */

/**
 * Internal strings that must never be shown to a user. If a raw failure message matches one
 * of these, we substitute a friendly cause instead of echoing it. (Defence in depth: the
 * page template also never interpolates the raw message into visible copy.)
 */
export const INTERNAL_LEAK_PATTERNS = [
  /decoy/i,
  /wrong key/i,
  /decrypt/i,
  /merkle/i,
  /inclusion proof/i,
  /integrity check/i,
  /wasm/i,
  /retrieval[_\s-]?key/i,
];

/** HTML-escape a string for safe interpolation into the page. */
function escapeHtml(s: unknown): string {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Map a raw failure message to a friendly, non-leaking, plain-language cause.
 * Never returns any of the INTERNAL_LEAK_PATTERNS strings.
 */
export function friendlyCause(rawMessage: string | null | undefined): string {
  const m = String(rawMessage || '');
  // Network-shaped failures.
  if (/failed to fetch|networkerror|load failed|ECONN|ENOTFOUND|timeout|timed out|offline|fetch failed/i.test(m)) {
    return 'The DIG Network may be unreachable. Check your connection and try again.';
  }
  // Anything that smells like the crypto/verification path — do NOT echo it.
  if (INTERNAL_LEAK_PATTERNS.some((p) => p.test(m))) {
    return 'This address may not exist, or its content has changed. Double-check the address and try again.';
  }
  // Generic fallback.
  return 'The network may be unreachable, or this address may not exist.';
}

/**
 * Build the full HTML document for the branded error page.
 *
 * @param {object} opts
 * @param {string} opts.url         the chia:// URL the user tried to open (shown, escaped)
 * @param {string} [opts.rawMessage] the internal failure message (used ONLY to pick a
 *                                    friendly cause — never shown verbatim)
 * @param {string} [opts.homeUrl]    recovery destination for "DIG Home" (defaults to dig.net)
 * @param {{installLabel: string, installUrl: string}} [opts.installPrompt] when the failure was
 *        caused by an unreachable LOCAL dig-node, the caller passes this so the page offers an
 *        "Install dig-node" action linking to the universal installer. Omit it for generic
 *        (non-dig-node) errors so the installer link never shows spuriously.
 * @returns {string} a complete `<!DOCTYPE html> … </html>` document
 */
export interface ErrorPageOptions {
  url?: string;
  rawMessage?: string;
  homeUrl?: string;
  installPrompt?: { installLabel?: string; installUrl?: string };
}

export function buildErrorPageHtml({
  url,
  rawMessage,
  homeUrl = 'https://dig.net',
  installPrompt,
}: ErrorPageOptions = {}): string {
  const safeUrl = escapeHtml(url);
  const cause = escapeHtml(friendlyCause(rawMessage));
  const safeHome = escapeHtml(homeUrl);
  const installBtn =
    installPrompt && installPrompt.installUrl
      ? `<a class="btn btn-primary" href="${escapeHtml(installPrompt.installUrl)}" target="_blank" rel="noopener">${escapeHtml(installPrompt.installLabel || 'Install dig-node')}</a>`
      : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>This DIG page couldn't be loaded</title>
<style>
  :root {
    --dig-bg: #f7f7fb; --dig-surface: #ffffff; --dig-text: #14122b;
    --dig-muted: #5e5a7c; --dig-border: #e4e1f0; --dig-purple: #5800D6; --dig-magenta: #FF00DE;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: var(--dig-bg); color: var(--dig-text); padding: 32px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
  }
  .card {
    max-width: 520px; width: 100%; text-align: center; background: var(--dig-surface);
    border: 1px solid var(--dig-border); border-radius: 16px; padding: 40px 36px;
    box-shadow: 0 8px 32px rgba(20, 18, 43, 0.08);
  }
  .mark {
    width: 56px; height: 56px; margin: 0 auto 20px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    background: linear-gradient(135deg, #5800D6 0%, #FF00DE 100%); color: #fff;
    font-size: 28px; font-weight: 700;
  }
  h1 { font-size: 22px; font-weight: 700; margin-bottom: 10px; }
  p.lead { font-size: 15px; line-height: 1.6; color: var(--dig-muted); margin-bottom: 18px; }
  .addr {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px;
    color: var(--dig-text); background: var(--dig-bg); border: 1px solid var(--dig-border);
    border-radius: 8px; padding: 8px 10px; word-break: break-all; margin-bottom: 24px;
  }
  .actions { display: flex; flex-wrap: wrap; gap: 12px; justify-content: center; }
  .btn {
    flex: 1 1 180px; padding: 13px 18px; border-radius: 10px; font-size: 15px; font-weight: 600;
    text-decoration: none; cursor: pointer; border: none;
  }
  .btn-primary {
    background: linear-gradient(135deg, #5800D6 0%, #FF00DE 100%); color: #fff;
    box-shadow: 0 4px 14px rgba(88, 0, 214, 0.35);
  }
  .btn-secondary { background: var(--dig-surface); color: var(--dig-purple); border: 1px solid var(--dig-purple); }
</style>
</head>
<body>
  <div class="card">
    <div class="mark" aria-hidden="true">DIG</div>
    <h1>This DIG page couldn't be loaded</h1>
    <p class="lead">${cause}</p>
    ${safeUrl ? `<div class="addr">${safeUrl}</div>` : ''}
    <div class="actions">
      ${installBtn}
      <a class="btn ${installBtn ? 'btn-secondary' : 'btn-primary'}" href="javascript:location.reload()">Try again</a>
      <a class="btn btn-secondary" href="${safeHome}">Go to DIG Home</a>
    </div>
  </div>
</body>
</html>`;
}
