/**
 * Wallet-data SOURCE resolution (#217, design `docs/design/dig-node-sage-parity-rpc.md` D.1/D.2) —
 * the PURE decision layer that picks WHERE the extension reads wallet data (balances, tokens, NFTs,
 * DIDs, coins, activity): the dig-node's browser-facing Sage-parity RPC (node-first, the §5.3 ladder)
 * or coinset.org (fallback). Chrome-free with the node probes INJECTED, so the SW glue
 * (`src/background/index.ts`) is a thin caller and the decision is fully unit-tested (§2.1).
 *
 * Signing NEVER routes here — this governs READS only. The dig-node is a read-only chain-data source
 * for the extension; every key stays in the offscreen DIGWX1 vault and the node never receives one
 * (issue #217 HARD gate).
 */

/** The four user-selectable wallet-data sources (design D.3; issue #217 EXT-2). Auto is the default. */
export const CHAIN_SOURCE_MODES = ['auto', 'node', 'coinset', 'custom'] as const;
export type ChainSourceMode = (typeof CHAIN_SOURCE_MODES)[number];

/** Auto = node-first (§5.3 ladder) with a clean coinset fallback. */
export const DEFAULT_CHAIN_SOURCE_MODE: ChainSourceMode = 'auto';

const MODES = new Set<string>(CHAIN_SOURCE_MODES);

/** True if `value` is one of the four supported chain-source modes. */
export function isChainSourceMode(value: unknown): value is ChainSourceMode {
  return typeof value === 'string' && MODES.has(value);
}

/** `chrome.storage` (`wallet.settings`) key: the selected wallet-data source mode. */
export const CHAIN_SOURCE_MODE_KEY = 'chainSourceMode';
/** `chrome.storage` (`wallet.settings`) key: the node RPC base URL used when mode === 'custom'. */
export const CHAIN_SOURCE_URL_KEY = 'chainSourceUrl';

/** The resolved chain-source selection read from the persisted `wallet.settings` blob. */
export interface ChainSourceSetting {
  mode: ChainSourceMode;
  /** The node RPC base URL used ONLY when `mode === 'custom'` (may be empty). */
  customUrl?: string;
}

/** A loose view of the persisted settings blob (only the two keys this module reads). */
interface ChainSourceSettingsBlob {
  [CHAIN_SOURCE_MODE_KEY]?: unknown;
  [CHAIN_SOURCE_URL_KEY]?: unknown;
  [k: string]: unknown;
}

/**
 * Normalize a persisted `wallet.settings` blob into a {@link ChainSourceSetting}. An unset or
 * unrecognized mode falls back to {@link DEFAULT_CHAIN_SOURCE_MODE} ('auto'), so a pre-#217 wallet
 * (no source key) keeps today's node-first-then-coinset behavior with zero migration.
 */
export function readChainSourceSetting(settings?: ChainSourceSettingsBlob | null): ChainSourceSetting {
  const rawMode = settings?.[CHAIN_SOURCE_MODE_KEY];
  const mode = isChainSourceMode(rawMode) ? rawMode : DEFAULT_CHAIN_SOURCE_MODE;
  const rawUrl = settings?.[CHAIN_SOURCE_URL_KEY];
  const customUrl = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  return { mode, customUrl };
}

/**
 * Normalize a user-entered custom node URL into a base URL the node client can POST `/{method}` to:
 * prepend `http://` when no scheme is given, and strip a trailing slash. Blank input → `''`.
 */
export function normalizeCustomNodeUrl(url?: string | null): string {
  const raw = (url ?? '').trim();
  if (!raw) return '';
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  return withScheme.replace(/\/+$/, '');
}

/**
 * The resolved wallet-data source. `strict` (on a node source) means the user explicitly forced a
 * node (mode node/custom): a read failure must SURFACE (error UI), NEVER silently fall back to
 * coinset. `auto` yields `strict: false`, so the SW falls through to coinset on a node read error.
 *
 * `node-not-tracking` (#399/#407): the node is reachable but is NOT verified to track the connected
 * wallet's identity — so its wallet reads would report a DIFFERENT (identity-less/unsynced) wallet
 * (0 XCH / [] CATs). A forced (node/custom) source surfaces this as an honest error; `auto` silently
 * falls through to the self-custody coinset scan (never the node's 0/0).
 */
export type ResolvedWalletSource =
  | { kind: 'node'; base: string; strict: boolean }
  | { kind: 'coinset' }
  | { kind: 'unavailable'; reason: 'node-unreachable' | 'custom-unreachable' | 'custom-missing' | 'node-not-tracking' };

/** The injected node-reachability probes (the SW wires these to its cached §5.3 resolver + probe). */
export interface ResolveWalletSourceDeps {
  /**
   * Probe the §5.3 ladder (override > `dig.local` > `localhost` > … driven by the configured
   * `server.host`) and return the reachable node base URL, or `null` when none answers.
   */
  resolveLadderNode: () => Promise<string | null>;
  /** Probe ONE explicit (already-normalized) node base URL; return it if reachable, else `null`. */
  probeNode: (base: string) => Promise<string | null>;
  /**
   * Verify the reachable node at `base` is tracking the CONNECTED self-custody wallet's identity
   * (#399/#407) — the gate that prevents sourcing the connected wallet's balances/tokens/coins/
   * activity from a node that answers for a DIFFERENT wallet. Only when this resolves `true` is a
   * node used for connected-wallet data. See {@link verifyNodeTracksConnectedWallet} for the shipped
   * default.
   */
  verifyNodeTracksWallet: (base: string) => Promise<boolean>;
}

/**
 * Resolve the wallet-data source for the current settings (design D.1/D.2). Pure decision — the
 * actual socket probes + the verified-tracking check are injected so this is exhaustively
 * unit-tested:
 *
 *  - **coinset** → force coinset (never probes a node).
 *  - **auto** → the §5.3 ladder node when reachable AND verified-tracking (non-strict), else the
 *    self-custody coinset scan (a reachable-but-untracked node is NOT used — #399).
 *  - **node** → force the ladder node (strict); `unavailable` when unreachable (`node-unreachable`)
 *    or reachable-but-not-tracking (`node-not-tracking`) — surfaced as an error, never a silent
 *    coinset fallback and never the node's 0/0.
 *  - **custom** → the explicit `customUrl` (strict, overrides the ladder entirely, §5.3); a blank
 *    url is `custom-missing`, an unreachable one `custom-unreachable`, a reachable-but-not-tracking
 *    one `node-not-tracking`.
 */
export async function resolveWalletSource(
  setting: ChainSourceSetting,
  deps: ResolveWalletSourceDeps,
): Promise<ResolvedWalletSource> {
  switch (setting.mode) {
    case 'coinset':
      return { kind: 'coinset' };
    case 'auto': {
      const base = await deps.resolveLadderNode();
      if (!base) return { kind: 'coinset' };
      return (await deps.verifyNodeTracksWallet(base))
        ? { kind: 'node', base, strict: false }
        : { kind: 'coinset' };
    }
    case 'node': {
      const base = await deps.resolveLadderNode();
      if (!base) return { kind: 'unavailable', reason: 'node-unreachable' };
      return (await deps.verifyNodeTracksWallet(base))
        ? { kind: 'node', base, strict: true }
        : { kind: 'unavailable', reason: 'node-not-tracking' };
    }
    case 'custom': {
      const normalized = normalizeCustomNodeUrl(setting.customUrl);
      if (!normalized) return { kind: 'unavailable', reason: 'custom-missing' };
      const base = await deps.probeNode(normalized);
      if (!base) return { kind: 'unavailable', reason: 'custom-unreachable' };
      return (await deps.verifyNodeTracksWallet(base))
        ? { kind: 'node', base, strict: true }
        : { kind: 'unavailable', reason: 'node-not-tracking' };
    }
  }
}

/**
 * The SHIPPED verified-tracking check (#399 P0 restore). A dig-node answers wallet reads (balances,
 * tokens, coins, activity) from the wallet IT tracks — NOT the extension's connected self-custody
 * wallet — until the client establishes an identity-scoped session: `login` with the wallet's PUBLIC
 * puzzle hashes (#217-safe) AND the node confirms that identity synced + tracking (dig-node #407).
 * That handshake is a follow-up; until it is wired, NO node is verified to track the connected
 * wallet, so this returns `false` and every connected-wallet read uses the self-custody coinset/vault
 * scan of the extension's OWN addresses. This is the guaranteed-correct default — the extension never
 * surfaces the node's identity-less 0 XCH / 0 $DIG for a wallet the node isn't tracking.
 *
 * The node remains the source for CONTENT reads (resolver/serve, `getRpcEndpoint`) — this gate is
 * ONLY about connected-wallet balance/token/coin/activity data. When the #407 handshake lands, this
 * is replaced by a real check (session established + node reports synced + tracking this identity).
 */
export function verifyNodeTracksConnectedWallet(_base: string): Promise<boolean> {
  return Promise.resolve(false);
}
