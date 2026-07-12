/**
 * dig-node CUSTODY-lifecycle client (#374 / dig-node SPEC §18.20) — the extension's controller over
 * the node's node-custodied wallet provisioning. In the thin-client model (epic #365) the NODE holds
 * the key: it generates or imports the seed, encrypts it at rest via `dig-keystore`, and loads an
 * in-memory signer on unlock. The extension NEVER holds key material — it drives these `wallet.*`
 * methods over the authorized `/ws` transport (SPEC §4.8), each gated by the paired control token
 * (§7.12). The one inbound key path is {@link NodeCustodyClient.import} (the one-time migration,
 * §18.20 / see `node-migration.ts`); the mnemonic is otherwise never sent and never returned.
 *
 * This module is PURE + transport-injected (the same {@link NodeCustodyTransport} seam as
 * `node-wallet.ts`'s `sendRequest`), so the whole mapping is unit-tested against a fake transport and
 * composes with the WS controller's `request()` in `src/background/index.ts`.
 *
 * # Wire (dig-node SPEC §18.20 / rpc.rs `dispatch_custody`)
 *   wallet.status  {}                      → { state: "none"|"locked"|"unlocked", address?: string }
 *   wallet.create  { password }            → { address }
 *   wallet.import  { mnemonic, password }   → { address }   (the one-time migration import)
 *   wallet.restore { mnemonic, password }   → { address }
 *   wallet.unlock  { password }            → { address }
 *   wallet.lock    {}                      → { state: "locked" }
 *   wallet.delete  { password }            → { state: "none" }
 *
 * The seed is Argon2id + AES-256-GCM encrypted at rest on the node and is NEVER returned by any op;
 * backup/reveal is node-local only (SPEC §7.12) and is deliberately absent from this client.
 */

/**
 * Transport for one custody method — resolve the node's raw JSON result or throw. This is the WS
 * controller's `request(method, params)` (the paired token is attached by the transport, §7.12);
 * an HTTP `POST {base}/{method}` fallback shares the identical seam.
 */
export type NodeCustodyTransport = (method: string, params: Record<string, unknown>) => Promise<unknown>;

/** The custody lifecycle state the node reports (SPEC §18.20 `CustodyState`). */
export type NodeCustodyState = 'none' | 'locked' | 'unlocked';

/** The node's custody status: the state plus the receive address when unlocked. */
export interface NodeCustodyStatus {
  state: NodeCustodyState;
  /** The wallet's `xch1…` receive address; present only when `state === 'unlocked'`. */
  address: string | null;
}

/** The custody-lifecycle client surface (drives the node's `wallet.*` methods). */
export interface NodeCustodyClient {
  /** `wallet.status` — the tri-state custody status (+ address when unlocked). */
  status(): Promise<NodeCustodyStatus>;
  /** `wallet.create` — the node generates + encrypts a fresh seed; returns ONLY the receive address. */
  create(password: string): Promise<{ address: string }>;
  /** `wallet.import` — send an existing mnemonic IN once (the migration path); returns the address. */
  import(mnemonic: string, password: string): Promise<{ address: string }>;
  /** `wallet.restore` — restore from a mnemonic (encrypt + persist + load signer); returns the address. */
  restore(mnemonic: string, password: string): Promise<{ address: string }>;
  /** `wallet.unlock` — decrypt the on-disk seed + load the signer; returns the address. */
  unlock(password: string): Promise<{ address: string }>;
  /** `wallet.lock` — drop the in-memory signer (encrypted seed stays on disk). */
  lock(): Promise<{ state: NodeCustodyState }>;
  /** `wallet.delete` — verify the password, then remove the seed file + lock. */
  delete(password: string): Promise<{ state: NodeCustodyState }>;
}

/** Narrow an unknown node result into a {@link NodeCustodyState} (defaults to `none` if malformed). */
function toState(value: unknown): NodeCustodyState {
  return value === 'unlocked' || value === 'locked' ? value : 'none';
}

/** Extract a non-empty `address` string from a node result, or null. */
function toAddress(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Build a {@link NodeCustodyClient} over the injected transport. Every method maps 1:1 to a node
 * `wallet.*` method (SPEC §18.20); results are narrowed into the typed shapes above so the caller
 * never trusts raw `any` off the wire.
 */
export function makeNodeCustodyClient(send: NodeCustodyTransport): NodeCustodyClient {
  const addr = async (method: string, params: Record<string, unknown>): Promise<{ address: string }> => {
    const r = (await send(method, params)) as { address?: unknown };
    const address = toAddress(r?.address);
    if (!address) throw new Error(`${method} did not return a receive address`);
    return { address };
  };
  return {
    async status() {
      const r = (await send('wallet.status', {})) as { state?: unknown; address?: unknown };
      return { state: toState(r?.state), address: toAddress(r?.address) };
    },
    create(password) {
      return addr('wallet.create', { password });
    },
    import(mnemonic, password) {
      return addr('wallet.import', { mnemonic, password });
    },
    restore(mnemonic, password) {
      return addr('wallet.restore', { mnemonic, password });
    },
    unlock(password) {
      return addr('wallet.unlock', { password });
    },
    async lock() {
      const r = (await send('wallet.lock', {})) as { state?: unknown };
      return { state: toState(r?.state) };
    },
    async delete(password) {
      const r = (await send('wallet.delete', { password })) as { state?: unknown };
      return { state: toState(r?.state) };
    },
  };
}
