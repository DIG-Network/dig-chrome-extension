import type { BaseQueryFn } from '@reduxjs/toolkit/query';
import { sendAction, type ActionMessage } from '@/lib/messaging';

/** A normalized baseQuery error the four-state error UI renders. */
export interface ChromeQueryError {
  /** A short machine code (`RUNTIME`, `ACTION_FAILED`) for agent-driveable branching. */
  code: string;
  /** A human message (mapped to react-intl copy at the call site). */
  message: string;
}

/**
 * The service-worker seam: an RTK Query baseQuery that speaks `chrome.runtime.sendMessage`
 * (a `messages.mjs` ACTIONS envelope) instead of `fetch`, so React gets idiomatic generated hooks
 * while the background SW stays the authority. A reply carrying `success:false` is surfaced as an
 * RTK Query `error` (→ the `isError` four-state branch); anything else is `data`.
 */
export const chromeBaseQuery: BaseQueryFn<ActionMessage, unknown, ChromeQueryError> = async (arg) => {
  try {
    const res = await sendAction<{ success?: boolean; error?: string; message?: string } | unknown>(arg);
    if (res && typeof res === 'object' && (res as { success?: boolean }).success === false) {
      const r = res as { error?: string; message?: string; code?: string };
      return { error: { code: r.code || 'ACTION_FAILED', message: r.message || r.error || 'Request failed' } };
    }
    return { data: res };
  } catch (e) {
    return { error: { code: 'RUNTIME', message: e instanceof Error ? e.message : String(e) } };
  }
};
