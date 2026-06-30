// Type declarations for dig-control.mjs — the DIG Control Panel decision logic (dig://control
// parity). Byte-consistent with the dig-node control RPC contract (dig-companion control.rs).

/** The hosted DIG RPC the read path transparently falls back to when no local node is present. */
export const HOSTED_RPC_FALLBACK: string;

/** The request header the dig-node expects the local control token in. */
export const CONTROL_TOKEN_HEADER: string;

/** The catalogued CONTROL/admin JSON-RPC methods the dig-node serves (frozen). */
export const CONTROL_METHODS: readonly string[];

/** The stable control-plane error codes the dig-node mints (frozen). */
export const CONTROL_ERR: Readonly<{
  UNAUTHORIZED: number;
  NOT_SUPPORTED: number;
  CONTROL_ERROR: number;
}>;

/** Is `method` a CONTROL/admin method (the gated `control.*` namespace)? */
export function isControlMethod(method: string | null | undefined): boolean;

/** True when a dig-node JSON-RPC response is the UNAUTHORIZED control-gate reply (-32020). */
export function isUnauthorizedControlResult(
  resp: { error?: { code?: number } } | null | undefined
): boolean;

/** The Control Panel view decision. */
export interface ControlView {
  mode: 'manage' | 'install';
  localNode: boolean;
  base: string | null;
  controlEndpoint: string | null;
  readFallback: string;
}

/** Decide what the Control Panel renders (detect a local dig-node → manage vs install). */
export function decideControlView(opts: {
  resolveNode: () => Promise<string | null>;
  hostedFallback?: string;
}): Promise<ControlView>;

/** Plain-language landing copy shown when NO local dig-node is reachable (install mode). */
export function controlInstallPrompt(): {
  title: string;
  body: string;
  installLabel: string;
  installUrl: string;
};

/** The pure view model the Control Panel renders, built from a getControlStatus response. */
export function controlPanelViewModel(view: {
  mode?: 'manage' | 'install';
  localNode?: boolean;
  base?: string | null;
  controlEndpoint?: string | null;
  readFallback?: string;
  status?: Record<string, unknown> | null;
  authRequired?: boolean;
}): {
  mode: 'manage' | 'install';
  nodeOnline: boolean;
  base: string | null;
  authRequired: boolean;
  hasStats: boolean;
  stats: {
    hostedStores: number | string;
    cachedCapsules: number | string;
    cacheUsedBytes: number | null;
    syncOn: boolean;
  } | null;
  upstream: string;
  deepLinkBrowser: boolean;
  note: string;
  install: { title: string; body: string; installLabel: string; installUrl: string };
  readFallbackLine: string;
};
