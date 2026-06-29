// Type declarations for error-page.mjs — the branded, plain-language chia:// error page.

/** Internal failure-string patterns that must never be shown to a user. */
export const INTERNAL_LEAK_PATTERNS: readonly RegExp[];

/** Map a raw failure message to a friendly, non-leaking, plain-language cause. */
export function friendlyCause(rawMessage: string | null | undefined): string;

/** Build the full HTML document for the branded error page. */
export function buildErrorPageHtml(opts?: {
  url?: string;
  rawMessage?: string;
  homeUrl?: string;
  installPrompt?: { installLabel: string; installUrl: string };
}): string;
