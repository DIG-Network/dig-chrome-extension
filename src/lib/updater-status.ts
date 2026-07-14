import type { PillTone } from '@/components/StatusPill';

/**
 * dig-updater status model (dig-updater SPEC §13.2, #504-K / #516) — the PURE, DOM-free view model
 * behind the fullscreen Updates tab. `control.updater.status` forwards the beacon's `status.json`
 * VERBATIM (dig-node never types the beacon's wire shape, #515) — this module is the ONE place the
 * extension shapes that opaque, schema-versioned JSON for display. Every field defaults defensively
 * rather than throwing: `status.json` is INFORMATIONAL (never security-load-bearing, unlike the
 * node's own trust-state — dig-updater SPEC §13.2), so a future beacon schema bump or a field this
 * reader doesn't yet know about must never break the tab, only omit that one detail.
 */

/** One component's last-observed decision (dig-updater SPEC §13.2 `components[]`). */
export interface UpdaterComponentStatus {
  /** The component name, e.g. `dig-node` / `digstore` / `dig-updater`. */
  component: string;
  /** The plan action: `install` / `update` / `skip` (a full pass) or `would_fetch` (a dry check). */
  action: string | null;
  /** The outcome: `installed` / `skipped` / `deferred` / `rolled_back` (full) or `staged` (dry). */
  result: string | null;
  /** Human-readable detail, e.g. `"0.25.0 -> 0.26.0"`. */
  detail: string | null;
}

/** The beacon's status snapshot (dig-updater SPEC §13.2), camelCased for the extension's model. */
export interface UpdaterStatus {
  /** The beacon binary version that wrote this snapshot. */
  version: string | null;
  /** The update channel this beacon tracks (only `"alpha"` is servable today). */
  channel: string | null;
  /** The EFFECTIVE pause state — a lapsed timed pause already reports `false` here. */
  paused: boolean;
  /** The most recent check/run, in unix seconds, or `null` if never checked. */
  lastCheckUnixSec: number | null;
  /** Whether that check was a dry probe or a full pass, or `null` if never checked. */
  lastCheckKind: 'dry' | 'run' | null;
  /** `"verified" | "rejected" | "applied" | "nothing_applied"`, or `null` if never checked. */
  lastOutcome: string | null;
  /** A stable code explaining a non-plain-success outcome (e.g. `"paused"`), or `null`. */
  lastReason: string | null;
  /** Human-readable detail for the last outcome, or `null`. */
  lastDetail: string | null;
  /** The last-observed per-component decisions. */
  components: UpdaterComponentStatus[];
  /** A best-effort estimate of the next scheduled wake, in unix seconds, or `null` if unscheduled. */
  nextWakeUnixSec: number | null;
}

/** The full `control.updater.status` result: whether the beacon is installed, and its status. */
export interface UpdaterStatusResponse {
  /** `false` when the beacon has never been installed on this machine — a NORMAL outcome, never an error. */
  installed: boolean;
  /** Present only when `installed` is `true`. */
  status: UpdaterStatus | null;
}

const asString = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const asNumber = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Normalize one raw `components[]` entry, tolerating any field being absent or malformed. */
function normalizeComponent(raw: unknown): UpdaterComponentStatus {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    component: asString(c.component) ?? 'unknown',
    action: asString(c.action),
    result: asString(c.result),
    detail: asString(c.detail),
  };
}

/**
 * Normalize a raw `control.updater.status` result into a trusted {@link UpdaterStatusResponse}.
 * `{ installed: false }` (the beacon was never installed) is reported as-is — the tab renders this
 * as a real empty state, never an error (family #516 requirement).
 */
export function normalizeUpdaterStatus(raw: unknown): UpdaterStatusResponse {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (r.installed !== true) return { installed: false, status: null };

  const s = (r.status && typeof r.status === 'object' ? r.status : {}) as Record<string, unknown>;
  const lastCheckKind = s.last_check_kind === 'dry' || s.last_check_kind === 'run' ? s.last_check_kind : null;

  return {
    installed: true,
    status: {
      version: asString(s.version),
      channel: asString(s.channel),
      paused: s.paused === true,
      lastCheckUnixSec: asNumber(s.last_check),
      lastCheckKind,
      lastOutcome: asString(s.last_outcome),
      lastReason: asString(s.last_reason),
      lastDetail: asString(s.last_detail),
      nextWakeUnixSec: asNumber(s.next_wake),
      components: Array.isArray(s.components) ? s.components.map(normalizeComponent) : [],
    },
  };
}

/** Message-catalog id for a component's plan `action` (dig-updater SPEC §13.2), forward-compat safe. */
export function updaterActionLabelId(action: string | null): string {
  switch (action) {
    case 'install':
      return 'updates.action.install';
    case 'update':
      return 'updates.action.update';
    case 'skip':
      return 'updates.action.skip';
    case 'would_fetch':
      return 'updates.action.wouldFetch';
    default:
      return 'updates.action.unknown';
  }
}

/** Message-catalog id for the overall `lastOutcome` (dig-updater SPEC §13.2), forward-compat safe. */
export function updaterOutcomeLabelId(outcome: string | null): string {
  switch (outcome) {
    case 'verified':
      return 'updates.outcome.verified';
    case 'rejected':
      return 'updates.outcome.rejected';
    case 'applied':
      return 'updates.outcome.applied';
    case 'nothing_applied':
      return 'updates.outcome.nothingApplied';
    default:
      return 'updates.outcome.unknown';
  }
}

/** Message-catalog id for a component's `result` (dig-updater SPEC §13.2), forward-compat safe. */
export function updaterResultLabelId(result: string | null): string {
  switch (result) {
    case 'installed':
      return 'updates.result.installed';
    case 'updated':
      return 'updates.result.updated';
    case 'skipped':
      return 'updates.result.skipped';
    case 'deferred':
      return 'updates.result.deferred';
    case 'rolled_back':
      return 'updates.result.rolledBack';
    case 'staged':
      return 'updates.result.staged';
    default:
      return 'updates.result.unknown';
  }
}

/** The {@link StatusPill} tone for a component's `result`, so the list scans at a glance. Never
 *  meaning-by-color-alone: the pill always pairs with the {@link updaterResultLabelId} text. */
export function updaterResultTone(result: string | null): PillTone {
  switch (result) {
    case 'installed':
    case 'updated':
    case 'staged':
      return 'good';
    case 'deferred':
    case 'rolled_back':
      return 'warn';
    case 'skipped':
      return 'neutral';
    default:
      return 'neutral';
  }
}

/** The {@link StatusPill} tone for the paused/active headline pill. */
export function updaterPausedTone(paused: boolean): PillTone {
  return paused ? 'warn' : 'good';
}
