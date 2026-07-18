/**
 * An in-process mock of the dig-app APP-SIGN endpoint (dig-app `SPEC.md §5.6`) for tests.
 *
 * The real dig-app side (SIGN-1/2/3) is not merged yet, so this simulator IS the reference the
 * extension round-trips against: it speaks the SPEC §5.6 wire, VERIFIES every post-pairing frame's
 * auth-MAC with the same `canonical-json` + HMAC construction the extension uses (proving the two
 * sides agree byte-for-byte), enforces strict nonce monotonicity (`AUTH_REPLAY`), and returns the
 * §5.6.7 symbolic error codes in `error.data`. It exposes a {@link WebSocketLike} so it drops into
 * the {@link createAppSignController} `createSocket` seam with no real network.
 *
 * It also RECORDS the origin each connect/sign frame carried, so a test can assert the extension
 * relayed the true committed origin (§7.1 "Origin spoof") — the security crux.
 *
 * TEST-ONLY: not bundled into the extension.
 */

import type { WebSocketLike } from '../../dig-node-ws';
import { canonicalFrameBytes, bytesToBase64, base64ToBytes, type HmacSha256, webCryptoHmacSha256 } from '../auth-frame';

/** Config for how the mock behaves (which outcome to simulate for connect/sign). */
export interface MockAppServerConfig {
  /** The channel secret the mock issues on `pair.begin` (base64). Defaults to a fixed test token. */
  channelTokenB64?: string;
  pairingId?: string;
  /** Outcome for `connect.request`: `grant` (default), or a §5.6.7 code to reject with. */
  connectOutcome?: 'grant' | 'CONNECT_DENIED' | 'CONNECT_TIMEOUT';
  /** Outcome for `sign.request`: `sign` (default), or a §5.6.7 code to reject with. */
  signOutcome?: 'sign' | 'SIGN_DENIED' | 'SIGN_UNKNOWN_TYPE' | 'SIGN_BAD_PAYLOAD' | 'SIGN_NO_CONFIRMER';
  /** Origins pre-whitelisted so a `sign.request` for them does not require a prior connect. */
  whitelisted?: string[];
  hmac?: HmacSha256;
}

/** A frame the mock observed, for test assertions. */
export interface ObservedFrame {
  method: string;
  params: Record<string, unknown>;
  origin?: string;
}

export class MockAppServer {
  readonly socket: WebSocketLike & { send: (data: string) => void };
  readonly observed: ObservedFrame[] = [];

  private readonly channelTokenB64: string;
  private readonly pairingId: string;
  private readonly connectOutcome: NonNullable<MockAppServerConfig['connectOutcome']>;
  private readonly signOutcome: NonNullable<MockAppServerConfig['signOutcome']>;
  private readonly whitelist: Set<string>;
  private readonly hmac: HmacSha256;
  private lastNonce = 0;
  private handlers: Pick<WebSocketLike, 'onopen' | 'onmessage' | 'onclose' | 'onerror'> = {
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };

  constructor(config: MockAppServerConfig = {}) {
    this.channelTokenB64 = config.channelTokenB64 ?? bytesToBase64(new Uint8Array(32).fill(7));
    this.pairingId = config.pairingId ?? 'mock-pairing-id';
    this.connectOutcome = config.connectOutcome ?? 'grant';
    this.signOutcome = config.signOutcome ?? 'sign';
    this.whitelist = new Set(config.whitelisted ?? []);
    this.hmac = config.hmac ?? webCryptoHmacSha256;

    const handlers = this.handlers;
    this.socket = {
      get onopen() {
        return handlers.onopen;
      },
      set onopen(fn) {
        handlers.onopen = fn;
        // Simulate an immediate successful connection on the next microtask.
        if (fn) queueMicrotask(() => fn({}));
      },
      get onmessage() {
        return handlers.onmessage;
      },
      set onmessage(fn) {
        handlers.onmessage = fn;
      },
      get onclose() {
        return handlers.onclose;
      },
      set onclose(fn) {
        handlers.onclose = fn;
      },
      get onerror() {
        return handlers.onerror;
      },
      set onerror(fn) {
        handlers.onerror = fn;
      },
      send: (data: string) => void this.receive(data),
      close: () => handlers.onclose?.({}),
    };
  }

  private reply(frame: Record<string, unknown>): void {
    queueMicrotask(() => this.handlers.onmessage?.({ data: JSON.stringify(frame) }));
  }

  private replyOk(id: unknown, result: unknown): void {
    this.reply({ jsonrpc: '2.0', id, result });
  }

  private replyErr(id: unknown, code: string, message = code): void {
    this.reply({ jsonrpc: '2.0', id, error: { code: -32000, message, data: code } });
  }

  /** Handle a client→app frame, mirroring dig-app's dispatch (auth-verify → method). */
  private async receive(data: string): Promise<void> {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    const { id, method, params = {}, auth } = frame as {
      id: unknown;
      method: string;
      params?: Record<string, unknown>;
      auth?: { pairing_id?: string; nonce?: number; mac_b64?: string };
    };
    const p = (params ?? {}) as Record<string, unknown>;
    this.observed.push({ method, params: p, origin: typeof p.origin === 'string' ? p.origin : undefined });

    if (method === 'pair.begin') {
      // The bootstrap frame carries no auth.
      this.replyOk(id, { pairing_id: this.pairingId, channel_token_b64: this.channelTokenB64 });
      return;
    }

    // Every other frame MUST carry a valid auth (§5.6.3).
    if (!auth || auth.pairing_id !== this.pairingId || typeof auth.nonce !== 'number' || typeof auth.mac_b64 !== 'string') {
      this.replyErr(id, 'AUTH_REQUIRED');
      return;
    }
    if (auth.nonce <= this.lastNonce) {
      this.replyErr(id, 'AUTH_REPLAY');
      return;
    }
    const expected = await this.hmac(base64ToBytes(this.channelTokenB64), canonicalFrameBytes(auth.nonce, method, p as never));
    if (bytesToBase64(expected) !== auth.mac_b64) {
      this.replyErr(id, 'AUTH_BAD_MAC');
      return;
    }
    this.lastNonce = auth.nonce;

    if (method === 'connect.request') {
      if (this.connectOutcome !== 'grant') return this.replyErr(id, this.connectOutcome);
      if (typeof p.origin === 'string') this.whitelist.add(p.origin);
      return this.replyOk(id, {
        granted: true,
        profile_did: 'did:chia:mock',
        addresses: ['xch1mockaddr'],
        pubkeys: ['b0mockpubkey'],
      });
    }

    if (method === 'connect.revoke') {
      if (typeof p.origin === 'string') this.whitelist.delete(p.origin);
      return this.replyOk(id, { revoked: true });
    }

    if (method === 'sign.request') {
      if (typeof p.origin !== 'string' || !this.whitelist.has(p.origin)) return this.replyErr(id, 'CONNECT_REQUIRED');
      if (this.signOutcome !== 'sign') return this.replyErr(id, this.signOutcome);
      return this.replyOk(id, { signature_b64: bytesToBase64(new Uint8Array(64).fill(3)), pubkey_hex: 'b0mockpubkey' });
    }

    this.replyErr(id, 'BAD_RESPONSE', `unknown method ${method}`);
  }
}
