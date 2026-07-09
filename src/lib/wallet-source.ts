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
 */
export type ResolvedWalletSource =
  | { kind: 'node'; base: string; strict: boolean }
  | { kind: 'coinset' }
  | { kind: 'unavailable'; reason: 'node-unreachable' | 'custom-unreachable' | 'custom-missing' };

/** The injected node-reachability probes (the SW wires these to its cached §5.3 resolver + probe). */
export interface ResolveWalletSourceDeps {
  /**
   * Probe the §5.3 ladder (override > `dig.local` > `localhost` > … driven by the configured
   * `server.host`) and return the reachable node base URL, or `null` when none answers.
   */
  resolveLadderNode: () => Promise<string | null>;
  /** Probe ONE explicit (already-normalized) node base URL; return it if reachable, else `null`. */
  probeNode: (base: string) => Promise<string | null>;
}

/**
 * Resolve the wallet-data source for the current settings (design D.1/D.2). Pure decision — the
 * actual socket probes are injected so this is exhaustively unit-tested:
 *
 *  - **coinset** → force coinset (never probes a node).
 *  - **auto** → the §5.3 ladder node when reachable (non-strict), else coinset.
 *  - **node** → force the ladder node (strict); `unavailable` when unreachable (surfaced as error,
 *    never a silent coinset fallback).
 *  - **custom** → the explicit `customUrl` (strict, overrides the ladder entirely, §5.3); a blank
 *    url is `custom-missing`, an unreachable one `custom-unreachable`.
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
      return base ? { kind: 'node', base, strict: false } : { kind: 'coinset' };
    }
    case 'node': {
      const base = await deps.resolveLadderNode();
      return base ? { kind: 'node', base, strict: true } : { kind: 'unavailable', reason: 'node-unreachable' };
    }
    case 'custom': {
      const normalized = normalizeCustomNodeUrl(setting.customUrl);
      if (!normalized) return { kind: 'unavailable', reason: 'custom-missing' };
      const base = await deps.probeNode(normalized);
      return base ? { kind: 'node', base, strict: true } : { kind: 'unavailable', reason: 'custom-unreachable' };
    }
  }
}
