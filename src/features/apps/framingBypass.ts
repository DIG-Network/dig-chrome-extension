import { ACTIONS } from '@/lib/messages';
import { sendAction, hasRuntime } from '@/lib/messaging';
import { FRAMED_HOST } from '@/lib/framing-rule';

/**
 * True when `rawUrl` points at DIG's own subdomain resolver (`on.dig.net` or `*.on.dig.net`), whose
 * responses carry `X-Frame-Options: DENY` + CSP `frame-ancestors 'none'`. Such a URL cannot be
 * iframed in the app-view without the extension-side framing bypass (#66). Only DIG's OWN resolver
 * host qualifies — a lookalike such as `evilon.dig.net` (a plain `dig.net` subdomain) does NOT.
 */
export function isFramedDigHost(rawUrl: string | undefined | null): boolean {
  if (!rawUrl) return false;
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === FRAMED_HOST || host.endsWith(`.${FRAMED_HOST}`);
}

/**
 * Ask the service worker to install the app-view framing bypass (strip on.dig.net's framing headers
 * for the app-view iframe). Resolves `true` on success, `false` if the runtime is unavailable or the
 * SW declined — the caller can still attempt the embed (it will simply fall back to a tab if refused).
 * The SW derives the tab to scope to from the message sender, so no tab id is passed here.
 */
export async function enableFramingBypass(): Promise<boolean> {
  if (!hasRuntime()) return false;
  try {
    const r = await sendAction<{ success?: boolean }>({ action: ACTIONS.appViewFraming, enable: true });
    return !!r?.success;
  } catch {
    return false;
  }
}

/** Ask the service worker to remove the app-view framing bypass (best-effort). */
export async function disableFramingBypass(): Promise<void> {
  if (!hasRuntime()) return;
  try {
    await sendAction({ action: ACTIONS.appViewFraming, enable: false });
  } catch {
    /* best-effort teardown — a dropped message just leaves an ephemeral session rule to expire */
  }
}
