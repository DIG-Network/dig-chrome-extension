/**
 * The APP-SIGN relay — the extension's trusted-once MEDIATOR role (dig-app `SPEC.md §5.6.1`).
 *
 * A web dapp calls the extension's injected `window.chia` provider; for an IDENTITY operation
 * (connect / sign) the extension relays the request to dig-app over the paired channel
 * ({@link AppSignController}), attaching the per-frame auth-MAC ({@link buildAuth}) keyed by the
 * stored pairing secret ({@link PairingStore}). dig-app raises the native confirm and signs; only
 * the signature returns. The extension can REQUEST but can never APPROVE — the OS-native biometric
 * confirm in dig-app is the sole sign authority (§5.6.1).
 *
 * ── The true-origin passthrough — the security crux (§5.6.1 / §7.1 "Origin spoof") ──────────────
 * Loopback cannot authenticate the calling process, so dig-app trusts exactly ONE paired extension
 * to VOUCH for the dapp's origin. That vouch is only trustworthy if the extension supplies the
 * BROWSER-COMMITTED origin — the origin the browser itself recorded for the sender tab/frame
 * (`sender.origin` in MV3), which a page CANNOT forge — never a string the page handed us. THIS
 * MODULE ENFORCES THAT AT THE TYPE LEVEL: {@link AppSignRelay.connect}/{@link AppSignRelay.sign}
 * take the committed origin as a required, first-class argument, and there is NO code path that
 * reads an origin out of the request `params`. The background SW passes `sender.origin`; a
 * page-supplied `origin` field, if any, is discarded before it reaches here.
 *
 * Chrome-free: the controller, pairing store, HMAC primitive, and clock are injected, so the whole
 * pair→connect→sign flow is unit-testable against a fake controller / in-memory store.
 */

import { AppSignController } from './app-sign-ws';
import { PairingStore } from './pairing-store';
import { AppSignError } from './errors';
import { buildAuth, base64ToBytes, NonceCounter, type HmacSha256, webCryptoHmacSha256 } from './auth-frame';

/** dig-app's `pair.begin` result (SPEC §5.6.3 step 1). */
interface PairBeginResult {
  pairing_id: string;
  channel_token_b64: string;
}

/** The `connect.request` result the `window.chia` connect contract expects (§5.6.4). */
export interface ConnectResult {
  granted: boolean;
  profile_did?: string;
  addresses?: string[];
  pubkeys?: string[];
}

/** The `sign.request` result — only the signature + signing key leave dig-app (§5.6.5). */
export interface SignResult {
  signature_b64: string;
  pubkey_hex: string;
}

/** Parameters for a relayed sign (the origin is passed separately — see the module doc). */
export interface SignParams {
  payloadType: string;
  payloadB64: string;
  /** Optional decoder input dig-app renders in the confirm window (e.g. the full spend bundle). */
  decodeHint?: unknown;
  /** Optional free-form context the confirm window may display. */
  context?: unknown;
}

/** Parameters for a relayed connect (the origin is passed separately — see the module doc). */
export interface ConnectParams {
  dappName?: string;
  dappIconUrl?: string;
  requestedPermissions?: string[];
}

export interface AppSignRelayDeps {
  controller: AppSignController;
  pairingStore: PairingStore;
  /** The pinned DIG extension id sent in `pair.begin` (must match dig-app's `Origin`/`ext_id` pin). */
  extId: string;
  /** A human label for the pairing confirm (e.g. "DIG Browser Extension"). */
  extLabel?: string;
  /** HMAC-SHA256 primitive for the auth-MAC. Defaults to WebCrypto. */
  hmac?: HmacSha256;
  now?: () => number;
}

/**
 * Build a relay over a live {@link AppSignController}. One relay instance per SW lifetime; it lazily
 * loads the pairing record + seeds the monotonic nonce counter from persisted state so nonces keep
 * strictly increasing across SW restarts (§5.6.3, `AUTH_REPLAY` bar).
 */
export class AppSignRelay {
  private readonly controller: AppSignController;
  private readonly pairingStore: PairingStore;
  private readonly extId: string;
  private readonly extLabel?: string;
  private readonly hmac: HmacSha256;
  private readonly now: () => number;
  /** Serializes authed sends so two concurrent frames can never reuse a nonce (replay-safe). */
  private authChain: Promise<unknown> = Promise.resolve();

  constructor({ controller, pairingStore, extId, extLabel, hmac = webCryptoHmacSha256, now = () => Date.now() }: AppSignRelayDeps) {
    this.controller = controller;
    this.pairingStore = pairingStore;
    this.extId = extId;
    this.extLabel = extLabel;
    this.hmac = hmac;
    this.now = now;
  }

  /** True when a pairing record is stored (the channel may still be down if dig-app isn't running). */
  async isPaired(): Promise<boolean> {
    return (await this.pairingStore.load()) !== null;
  }

  /**
   * Pair with dig-app: send `pair.begin` (the ONLY frame with no auth — it bootstraps the secret),
   * which triggers dig-app's native pairing confirm. On approval, persist `{ pairing_id,
   * channel_token }` in storage. Rejects `PAIR_DENIED`/`PAIR_TIMEOUT` on user refusal, or
   * `APP_NOT_RUNNING` when dig-app is unreachable.
   */
  async pair(): Promise<void> {
    const result = await this.controller.request<PairBeginResult>('pair.begin', {
      ext_id: this.extId,
      ext_label: this.extLabel,
      requested_at: this.now(),
    });
    if (!result || typeof result.pairing_id !== 'string' || typeof result.channel_token_b64 !== 'string') {
      throw new AppSignError('BAD_RESPONSE', 'pair.begin returned a malformed result');
    }
    await this.pairingStore.save({
      pairingId: result.pairing_id,
      channelTokenB64: result.channel_token_b64,
      pairedAt: this.now(),
    });
  }

  /** Delete the local pairing record (the local half of unpair; dig-app deletes its sealed record). */
  async unpair(): Promise<void> {
    await this.pairingStore.clear();
  }

  /**
   * Relay a dapp CONNECT. `committedOrigin` MUST be the browser-committed sender origin (never a
   * page-supplied string — see the module doc). dig-app whitelists `(origin, active_profile)` behind
   * a native modal for a first connect and returns the connection handle.
   */
  connect(committedOrigin: string, params: ConnectParams = {}): Promise<ConnectResult> {
    return this.authedRequest<ConnectResult>('connect.request', {
      origin: committedOrigin,
      dapp_name: params.dappName,
      dapp_icon_url: params.dappIconUrl,
      requested_permissions: params.requestedPermissions,
    });
  }

  /** Relay a `connect.revoke` for a committed origin (removes dig-app's whitelist entry, §5.6.4). */
  revoke(committedOrigin: string): Promise<void> {
    return this.authedRequest<void>('connect.revoke', { origin: committedOrigin });
  }

  /**
   * Relay a dapp SIGN. `committedOrigin` MUST be the browser-committed sender origin. dig-app
   * decodes + displays the transaction, requires the native biometric confirm, signs the
   * domain-separated `DIGNET-SIGN-v1` message with the in-memory key, and returns only the
   * signature (§5.6.5). Rejects with the §5.6.7 code on deny/timeout/unknown-type/bad-payload.
   */
  sign(committedOrigin: string, params: SignParams): Promise<SignResult> {
    return this.authedRequest<SignResult>('sign.request', {
      origin: committedOrigin,
      payload_type: params.payloadType,
      payload_b64: params.payloadB64,
      decode_hint: params.decodeHint,
      context: params.context,
    });
  }

  /**
   * Send an authed frame: load the pairing, mint a strictly-increasing nonce, build the auth-MAC,
   * send, and persist the nonce. Serialized through {@link authChain} so concurrent callers cannot
   * mint colliding nonces. Rejects `NOT_PAIRED` when there is no stored pairing.
   */
  private authedRequest<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const run = this.authChain.then(() => this.sendAuthed<T>(method, params));
    // Keep the chain alive regardless of this frame's outcome (a rejection must not break the chain).
    this.authChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async sendAuthed<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const record = await this.pairingStore.load();
    if (!record) throw new AppSignError('NOT_PAIRED', 'no dig-app pairing — run pair.begin first');

    const counter = new NonceCounter(record.nonce);
    const nonce = counter.next();
    const auth = await buildAuth(
      {
        pairingId: record.pairingId,
        channelSecret: base64ToBytes(record.channelTokenB64),
        nonce,
        method,
        params: params as Parameters<typeof buildAuth>[0]['params'],
      },
      this.hmac,
    );
    // Persist the nonce BEFORE sending so a crash after send never lets a nonce be reused.
    await this.pairingStore.saveNonce(nonce);
    return this.controller.request<T>(method, params, auth);
  }
}
