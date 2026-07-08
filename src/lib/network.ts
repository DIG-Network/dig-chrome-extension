/**
 * Chain network selection (#108) — mainnet/testnet11, parameterizing the three things that differ
 * between them: the bech32(m) address prefix (`xch`/`txch`), the AGG_SIG_ME additional data (the
 * network's genesis challenge, §5.8 signing), and the default coinset JSON-RPC endpoint. The AGG_SIG_ME
 * constants are the SAME ones `offscreen/signing.ts` already exports (proven against the wasm
 * simulator) — this module just names them per-network instead of hardcoding mainnet everywhere.
 *
 * Persisted to `wallet.settings.network`, read the SAME way as the `chainRpcUrl` override
 * (`src/lib/custody-session.ts`'s `resolveCoinsetUrl`, §5.3): an explicit custom node still wins;
 * absent that, the selected network's default coinset endpoint applies. Pure (no `chrome` APIs, no
 * DOM), so it is importable from the SW, the offscreen document, and the popup alike without
 * dragging in a platform dependency.
 *
 * Guardrail (mainnet is real funds, CLAUDE.md §7): switching networks is a user-facing action that
 * requires an explicit confirmation step (`NetworkSetting.tsx`) and a persistent non-mainnet
 * indicator (`NetworkBadge.tsx`) — a user must never be unsure which network they are viewing.
 */

import { MAINNET_AGG_SIG_ME, TESTNET11_AGG_SIG_ME } from '@/offscreen/signing';

/** The two selectable chain networks. */
export const NETWORK_IDS = ['mainnet', 'testnet'] as const;
export type NetworkId = (typeof NETWORK_IDS)[number];

/** The default network — mainnet, so a fresh install never silently reads/sends on testnet. */
export const DEFAULT_NETWORK_ID: NetworkId = 'mainnet';

/** The network-specific constants a chain read/sign/derive call needs. */
export interface NetworkConfig {
  id: NetworkId;
  /** The bech32(m) human-readable-part prefix for addresses on this network. */
  addressPrefix: 'xch' | 'txch';
  /** The AGG_SIG_ME additional data (the network's genesis challenge), hex, no `0x`. */
  aggSigMeHex: string;
  /** The default coinset JSON-RPC endpoint for this network (overridden by an explicit custom node). */
  coinsetUrl: string;
}

/** Every network's resolved configuration, keyed by id. */
export const NETWORKS: Record<NetworkId, NetworkConfig> = {
  mainnet: {
    id: 'mainnet',
    addressPrefix: 'xch',
    aggSigMeHex: MAINNET_AGG_SIG_ME,
    coinsetUrl: 'https://api.coinset.org',
  },
  testnet: {
    id: 'testnet',
    addressPrefix: 'txch',
    aggSigMeHex: TESTNET11_AGG_SIG_ME,
    coinsetUrl: 'https://testnet11.api.coinset.org',
  },
};

const IDS = new Set<string>(NETWORK_IDS);

/** True if `value` is one of the two supported network ids. */
export function isNetworkId(value: unknown): value is NetworkId {
  return typeof value === 'string' && IDS.has(value);
}

/** Resolve a (possibly absent/bad) persisted network id to its config, falling back to mainnet. */
export function resolveNetwork(id: string | null | undefined): NetworkConfig {
  return NETWORKS[isNetworkId(id) ? id : DEFAULT_NETWORK_ID];
}
