/**
 * DIG Control Panel — the control-token PAIRING controller (#280/#281). Pure, DOM-free,
 * chrome-free state machine the service worker drives so an MV3 extension (which cannot read the
 * node's `<config_dir>/control-token` file) can obtain a SCOPED, revocable controller token.
 *
 * # Flow (dig-node SPEC §7.11 — compare-codes consent)
 *
 *   unpaired → (startPairing) → requesting → awaiting → (operator approves) → paired
 *
 * 1. `pairing.request { client_name }` (OPEN) → `{ pairing_id, pairing_code, expires_ms }`. The UI
 *    shows the 6-digit `pairing_code`; the operator runs `dig-node pair approve <pairing_id>` on the
 *    machine and confirms the code matches.
 * 2. `pairing.poll { pairing_id }` (OPEN) is polled on an interval until it returns
 *    `{ status:"approved", token }` (delivered once), `expired`, or the deadline passes.
 * 3. The token is persisted (injected `saveToken`) and presented as `X-Dig-Control-Token` on
 *    `control.*` calls. `unpair()` clears it locally (node-side revocation is the operator's
 *    `dig-node pair revoke`).
 *
 * Every dependency (the two RPCs, token storage, clock, scheduler) is injected, so the whole
 * machine is unit-testable with fakes (mirrors `createNodeWsController`). The SW wires the real
 * `controlRpc` + `chrome.storage.local` + `setTimeout`.
 */

/** The pairing lifecycle phase the UI renders. */
export type PairingPhase =
  | 'unpaired'
  | 'requesting'
  | 'awaiting'
  | 'paired'
  | 'expired'
  | 'error';

/** The public pairing state (the token itself is NEVER surfaced beyond `phase:"paired"`). */
export interface PairingState {
  phase: PairingPhase;
  /** The pairing_id the operator approves (shown so they can `dig-node pair approve <id>`). */
  pairingId: string | null;
  /** The 6-digit compare-codes value the operator confirms. */
  pairingCode: string | null;
  expiresMs: number | null;
  /** A short human error message when `phase:"error"`. */
  error: string | null;
  updatedAt: number;
}

/** The `pairing.request` result shape (dig-node SPEC §7.11). */
export interface PairingRequestResult {
  pairing_id: string;
  pairing_code: string;
  expires_ms: number;
}

/** The `pairing.poll` result shape. */
export interface PairingPollResult {
  status: 'pending' | 'approved' | 'expired' | 'unknown';
  token?: string;
}

export interface PairingControllerDeps {
  /** OPEN `pairing.request` — returns the pending pairing, or null on transport failure. */
  requestPairing: (clientName: string) => Promise<PairingRequestResult | null>;
  /** OPEN `pairing.poll` — returns the current pairing state, or null on transport failure. */
  pollPairing: (pairingId: string) => Promise<PairingPollResult | null>;
  /** Load a previously-stored controller token (hydration). */
  loadToken: () => Promise<string | null>;
  /** Persist (or, with null, clear) the controller token. */
  saveToken: (token: string | null) => Promise<void>;
  /** Called with a COPY of the state on every change. */
  onChange?: (state: PairingState) => void;
  now?: () => number;
  scheduleTimeout?: (fn: () => void, ms: number) => unknown;
  clearScheduledTimeout?: (handle: unknown) => void;
  /** Poll cadence (ms) while awaiting approval. */
  pollIntervalMs?: number;
  /** The label shown to the operator in `dig-node pair` (defaults to "DIG Chrome Extension"). */
  clientName?: string;
}

export interface PairingController {
  /** Load any stored token → `paired` or `unpaired`. Call once at startup. */
  hydrate(): Promise<void>;
  /** Begin a pairing: request → await approval → poll → paired. */
  startPairing(): Promise<void>;
  /** Cancel an in-flight pairing (returns to `unpaired`). */
  cancel(): void;
  /** Clear the stored token locally → `unpaired`. */
  unpair(): Promise<void>;
  /** The current state, synchronously. */
  getState(): PairingState;
  /** The current controller token (for the SW to attach to control.* calls), or null. */
  getToken(): string | null;
  /** Subscribe to state changes; returns an unsubscribe fn. */
  subscribe(listener: (state: PairingState) => void): () => void;
}

/** The frozen "never paired" starting state. */
export function initialPairingState(now: number = Date.now()): PairingState {
  return {
    phase: 'unpaired',
    pairingId: null,
    pairingCode: null,
    expiresMs: null,
    error: null,
    updatedAt: now,
  };
}

export function createPairingController(deps: PairingControllerDeps): PairingController {
  const {
    requestPairing,
    pollPairing,
    loadToken,
    saveToken,
    onChange,
    now = () => Date.now(),
    scheduleTimeout = (fn, ms) => setTimeout(fn, ms),
    clearScheduledTimeout = (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    pollIntervalMs = 3000,
    clientName = 'DIG Chrome Extension',
  } = deps;

  let state = initialPairingState(now());
  let token: string | null = null;
  let pollHandle: unknown = null;
  /** Bumped on cancel/unpair/new-start so a straggling poll from a prior attempt cannot apply. */
  let cycle = 0;
  const listeners = new Set<(state: PairingState) => void>();

  function publish(patch: Partial<PairingState>): void {
    state = { ...state, ...patch, updatedAt: now() };
    const snapshot = { ...state };
    for (const l of listeners) l(snapshot);
    onChange?.(snapshot);
  }

  function clearPollTimer(): void {
    if (pollHandle != null) {
      clearScheduledTimeout(pollHandle);
      pollHandle = null;
    }
  }

  async function pollOnce(myCycle: number): Promise<void> {
    if (myCycle !== cycle) return;
    const pairingId = state.pairingId;
    if (!pairingId) return;
    const res = await pollPairing(pairingId).catch(() => null);
    if (myCycle !== cycle) return;

    if (res && res.status === 'approved' && res.token) {
      token = res.token;
      await saveToken(res.token);
      if (myCycle !== cycle) return;
      clearPollTimer();
      publish({ phase: 'paired', pairingId: null, pairingCode: null, expiresMs: null, error: null });
      return;
    }
    if (res && (res.status === 'expired' || res.status === 'unknown')) {
      clearPollTimer();
      publish({ phase: 'expired', pairingId: null, pairingCode: null });
      return;
    }
    // still pending (or a transient null) — stop once the deadline has passed, else keep polling.
    if (state.expiresMs != null && now() > state.expiresMs) {
      clearPollTimer();
      publish({ phase: 'expired', pairingId: null, pairingCode: null });
      return;
    }
    pollHandle = scheduleTimeout(() => pollOnce(myCycle), pollIntervalMs);
  }

  return {
    async hydrate() {
      const stored = await loadToken().catch(() => null);
      token = stored || null;
      publish(token ? { phase: 'paired' } : { phase: 'unpaired' });
    },

    async startPairing() {
      cycle += 1;
      const myCycle = cycle;
      clearPollTimer();
      publish({ phase: 'requesting', error: null, pairingId: null, pairingCode: null });
      const req = await requestPairing(clientName).catch(() => null);
      if (myCycle !== cycle) return;
      if (!req || !req.pairing_id) {
        publish({ phase: 'error', error: 'pairing_request_failed' });
        return;
      }
      publish({
        phase: 'awaiting',
        pairingId: req.pairing_id,
        pairingCode: req.pairing_code,
        expiresMs: req.expires_ms,
        error: null,
      });
      pollHandle = scheduleTimeout(() => pollOnce(myCycle), pollIntervalMs);
    },

    cancel() {
      cycle += 1;
      clearPollTimer();
      publish({ phase: token ? 'paired' : 'unpaired', pairingId: null, pairingCode: null, error: null });
    },

    async unpair() {
      cycle += 1;
      clearPollTimer();
      token = null;
      await saveToken(null);
      publish({ phase: 'unpaired', pairingId: null, pairingCode: null, expiresMs: null, error: null });
    },

    getState() {
      return { ...state };
    },
    getToken() {
      return token;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * A message-id view-model for the pairing UI, from the current phase — keeps `ControlTab.tsx` a
 * thin `<FormattedMessage>` renderer (no inline English). The `pairingCode`/`pairingId` are passed
 * through for the awaiting state so the operator can confirm + approve.
 */
export function pairingViewModel(state: PairingState): {
  phase: PairingPhase;
  titleId: string;
  bodyId: string;
  code: string | null;
  pairingId: string | null;
  tone: 'good' | 'neutral' | 'warn';
  showPairButton: boolean;
  showCancelButton: boolean;
  showUnpairButton: boolean;
} {
  switch (state.phase) {
    case 'paired':
      return {
        phase: state.phase,
        titleId: 'control.pairing.paired.title',
        bodyId: 'control.pairing.paired.body',
        code: null,
        pairingId: null,
        tone: 'good',
        showPairButton: false,
        showCancelButton: false,
        showUnpairButton: true,
      };
    case 'requesting':
      return {
        phase: state.phase,
        titleId: 'control.pairing.requesting.title',
        bodyId: 'control.pairing.requesting.body',
        code: null,
        pairingId: null,
        tone: 'neutral',
        showPairButton: false,
        showCancelButton: true,
        showUnpairButton: false,
      };
    case 'awaiting':
      return {
        phase: state.phase,
        titleId: 'control.pairing.awaiting.title',
        bodyId: 'control.pairing.awaiting.body',
        code: state.pairingCode,
        pairingId: state.pairingId,
        tone: 'neutral',
        showPairButton: false,
        showCancelButton: true,
        showUnpairButton: false,
      };
    case 'expired':
      return {
        phase: state.phase,
        titleId: 'control.pairing.expired.title',
        bodyId: 'control.pairing.expired.body',
        code: null,
        pairingId: null,
        tone: 'warn',
        showPairButton: true,
        showCancelButton: false,
        showUnpairButton: false,
      };
    case 'error':
      return {
        phase: state.phase,
        titleId: 'control.pairing.error.title',
        bodyId: 'control.pairing.error.body',
        code: null,
        pairingId: null,
        tone: 'warn',
        showPairButton: true,
        showCancelButton: false,
        showUnpairButton: false,
      };
    case 'unpaired':
    default:
      return {
        phase: 'unpaired',
        titleId: 'control.pairing.unpaired.title',
        bodyId: 'control.pairing.unpaired.body',
        code: null,
        pairingId: null,
        tone: 'neutral',
        showPairButton: true,
        showCancelButton: false,
        showUnpairButton: false,
      };
  }
}
