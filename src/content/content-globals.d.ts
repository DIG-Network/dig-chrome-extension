/**
 * Ambient global declarations shared by the content-script-layer entries (src/content/*.ts, #68).
 *
 * middleware.ts + content.ts are two classic content scripts injected into the SAME isolated world
 * (manifest content_scripts `[middleware.js, content.js]`), so at runtime they share one global
 * object. As vanilla classic scripts they shared top-level bindings directly; once each is bundled
 * into its OWN esbuild IIFE those top-level bindings become closure-local, so the few symbols that
 * genuinely cross the boundary are promoted onto `globalThis` (middleware sets them; content reads
 * them, and vice-versa). This file types those shared globals + the custom props stashed on DOM/XHR
 * objects, so `tsc --strict` and eslint see a single, precise contract with no `any`.
 *
 * This is a declaration-only SCRIPT file (no import/export): its top-level declarations are global,
 * and `interface` blocks merge with the DOM lib types. esbuild never sees it (it is not imported at
 * runtime), so it does not affect the self-contained IIFE bundles.
 */

/** One resolved proxy response from the background service worker (`action: 'proxyRequest'`). */
interface DigProxyResponse {
  success?: boolean;
  error?: string;
  /** The decrypted resource encoded as a `data:` URL (present on a successful proxy). */
  data: string;
  contentType?: string;
}

/**
 * The result of one `DigResourceLoader` strategy attempt. Discriminated on `strategy` so a `proxy`
 * result exposes the `DigProxyResponse` object (`.data.data` is the data URL) while a `redirect`
 * result carries the converted URL string directly.
 */
type DigLoadResult =
  | { success: boolean; strategy: 'proxy' | 'proxy-retry'; data: DigProxyResponse }
  | { success: boolean; strategy: 'redirect'; data: string }
  | { success: boolean; strategy: 'fallback'; data: null };

/**
 * The subset of the middleware `DigResourceLoader` singleton that content.ts calls across the
 * isolated-world boundary (via `globalThis.digResourceLoader`).
 */
interface DigResourceLoaderApi {
  loadAndApply(element: Element, attribute: string, digUrl: string, priority?: number): Promise<void>;
  loadResource(element: Element, attribute: string, digUrl: string, priority?: number): Promise<DigLoadResult>;
  registerErrorHandler(element: Element, digUrl: string): void;
  registerLoadHandler(element: Element, digUrl: string): void;
}

// `declare var` is the required idiom for typing writable globalThis properties (middleware.ts
// assigns these); `let`/`const` can't augment globalThis, so no-var is disabled for these lines.
/** RPC host cache. Owned + kept current by middleware.ts; read live by content.ts. */
// eslint-disable-next-line no-var
declare var cachedRpcHost: string | undefined;
/** The middleware resource-loader singleton. Set by middleware.ts; used by content.ts. */
// eslint-disable-next-line no-var
declare var digResourceLoader: DigResourceLoaderApi;
/** The content-script chia:// loading-spinner injector. Set by content.ts; used by middleware.ts. */
// eslint-disable-next-line no-var
declare var injectLoadingSpinner: ((element: HTMLElement, digUrl: string) => () => void) | undefined;

interface Window {
  /** The current RPC host, published by content.ts for page-script.ts to read. */
  __DIG_RPC_HOST__?: string;
}

interface XMLHttpRequest {
  /** content.ts stashes the pending chia:// URL from open() for send() to proxy. */
  _digUrl?: string | null;
  /** content.ts stashes the request method from open() for the send() proxy path. */
  _digMethod?: string;
  /** content.ts stashes the remaining open() args to replay on the fallback path. */
  _digRest?: unknown[];
}
