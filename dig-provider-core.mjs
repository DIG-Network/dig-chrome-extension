/**
 * Pure, testable core of the injected `window.chia` provider.
 *
 * The shipping provider (dig-provider.js) runs in the page's MAIN world where ES `import`
 * is not available, so that file INLINES this surface. This module is the source of truth
 * the IIFE mirrors, and the place the contract is unit-tested (provider.test.mjs pins both:
 * the core here AND a structural check that the IIFE stays in lockstep).
 *
 * What it defines (the agent-friendly additions):
 *   - PROVIDER_INFO         — self-describing capability object (isDIG/transport/edition)
 *   - WALLET_PROVIDER_VERSION + a `version` field
 *   - a method catalogue (window.chia.methods + a local chip0002_getMethods request)
 *   - PROVIDER_ERROR_CODES  — standard wallet error codes (4001/4100/4200/4900) replacing
 *     the old ad-hoc -1 / raw-HTTP-status sentinels, byte-aligned with the native DIG
 *     Browser provider (SYSTEM.md → keep the two providers in sync).
 *
 * Plain ES module (no DOM) so it runs under `node --test`.
 */

import { WALLET_METHODS, normalizeMethod, remapGobyParams } from './wallet-methods.mjs';

/** Contract version of the injected provider surface. */
export const WALLET_PROVIDER_VERSION = 1;

/**
 * The wallet's display name, exposed as `window.chia.name`. Goby dApps read this
 * (Goby returns "Goby", loroco "Loroco"); DIG identifies as "DIG". Kept identical
 * across the two injected providers.
 */
export const WALLET_PROVIDER_NAME = 'DIG';

/**
 * The Goby/CHIP-0002 API version string, exposed as `window.chia.apiVersion`. Goby
 * dApps feature-gate on this. "1.0.0" = the CHIP-0002 + Goby-extensions surface below.
 */
export const WALLET_API_VERSION = '1.0.0';

/** DIG operates on Chia mainnet; `window.chia.chainId` reports this once connected. */
export const WALLET_CHAIN_ID = 'mainnet';

/**
 * Self-describing capability object exposed as `window.chia.info`. An agent feature-detects
 * the transport (WalletConnect-brokered in the extension vs in-process in the native
 * browser) and edition without out-of-band knowledge.
 * @readonly
 */
export const PROVIDER_INFO = Object.freeze({
  isDIG: true,
  /** 'walletconnect' (extension brokers to Sage) — the native browser reports 'in-process'. */
  transport: 'walletconnect',
  /** 'extension' here; the native fork reports 'browser'. */
  edition: 'extension',
  providerVersion: WALLET_PROVIDER_VERSION,
});

/**
 * Standard wallet provider error codes (EIP-1193 / CHIP-0002 aligned). These replace the
 * previous ad-hoc scheme (a magic -1 for unreachable, a raw HTTP status for everything
 * else). Documented here AND in the README provider section so a dapp/agent can branch on
 * `err.code`. Kept identical to the native DIG Browser provider.
 * @readonly
 */
export const PROVIDER_ERROR_CODES = Object.freeze({
  /** 4001 — the user rejected the request (or a connect is still pending approval). */
  USER_REJECTED: 4001,
  /** 4100 — the origin/account is not authorized (call connect() first). */
  UNAUTHORIZED: 4100,
  /** 4200 — the wallet does not support the requested method. */
  UNSUPPORTED_METHOD: 4200,
  /** 4900 — the wallet is disconnected / unreachable (no Sage session, relay down). */
  DISCONNECTED: 4900,
});

/**
 * Map a broker {status, body} envelope (or its absence) to a thrown Error carrying a
 * STANDARD provider error code. The mapping:
 *   - missing envelope / 5xx  → 4900 DISCONNECTED
 *   - 202 (pending approval)  → 4001 USER_REJECTED (with `.pending = true` so connect() polls)
 *   - 401 / 403               → 4100 UNAUTHORIZED
 *   - 404                     → 4200 UNSUPPORTED_METHOD
 *   - any other non-2xx       → 4001 USER_REJECTED (a wallet-side rejection)
 *
 * @param {{status:number, body?:{error?:string}, error?:string}|null|undefined} env
 * @returns {Error & { code:number, pending?:boolean, status?:number }}
 */
export function mapEnvelopeToError(env) {
  if (!env) {
    const e = new Error('DIG wallet is not reachable');
    e.code = PROVIDER_ERROR_CODES.DISCONNECTED;
    return e;
  }
  const status = env.status || 0;
  const body = env.body || {};
  const msg = (body && body.error) || env.error || ('DIG wallet error ' + status);

  if (status === 202) {
    const e = new Error('Connection pending approval');
    e.code = PROVIDER_ERROR_CODES.USER_REJECTED;
    e.pending = true;
    e.status = status;
    return e;
  }
  let code;
  if (status === 401 || status === 403) code = PROVIDER_ERROR_CODES.UNAUTHORIZED;
  else if (status === 404) code = PROVIDER_ERROR_CODES.UNSUPPORTED_METHOD;
  else if (status >= 500 || status === 0) code = PROVIDER_ERROR_CODES.DISCONNECTED;
  else code = PROVIDER_ERROR_CODES.USER_REJECTED;

  const e = new Error(msg);
  e.code = code;
  e.status = status;
  return e;
}

/**
 * Build the provider object from an injected `bridgeCall(method, params, timeoutMs)` that
 * returns a `{status, body}` envelope. Pure: no DOM, no postMessage — the IIFE supplies a
 * real bridgeCall; tests supply a fake one.
 *
 * @param {object} deps
 * @param {(method:string, params?:object, timeoutMs?:number)=>Promise<object>} deps.bridgeCall
 * @param {string} [deps.version]  the extension version (from the manifest)
 * @param {(ev:string,data?:any)=>void} [deps.emit]  optional event emitter for 'connect'
 * @returns {object} the window.chia provider object
 */
export function buildProvider({ bridgeCall, version, emit } = {}) {
  const listeners = {};
  const fire = emit || ((ev, data) => {
    (listeners[ev] || []).slice().forEach((fn) => { try { fn(data); } catch { /* isolate */ } });
  });

  // Private session state. isConnected() is a callable (Goby convention) reading
  // `_connected`; chainId/selectedAddress are getters over the cached values.
  let _connected = false;
  let _chainId;
  let _selectedAddress;

  async function rpc(method, params) {
    const env = await bridgeCall(method, params);
    const status = (env && env.status) || 0;
    // Only a 200 is a final success. A 202 means "approval pending" — throw it as a
    // pending error so connect()'s retry loop polls (mapEnvelopeToError sets .pending);
    // any non-2xx is a real error. (Without the explicit 202 case a pending response
    // would fall through as success with body.data === undefined.)
    if (!env || status < 200 || status >= 300 || status === 202) {
      throw mapEnvelopeToError(env);
    }
    return (env.body || {}).data;
  }

  async function connect(eager) {
    const deadline = Date.now() + 120000;
    for (;;) {
      try {
        const r = await rpc('chip0002_connect', { eager: !!eager });
        _connected = true;
        _chainId = WALLET_CHAIN_ID; // DIG is Chia mainnet
        fire('connect', r);
        return r;
      } catch (e) {
        if (e && e.pending && Date.now() < deadline) {
          await new Promise((res) => setTimeout(res, 1200));
          continue;
        }
        throw e;
      }
    }
  }

  // Route a dApp-facing method (bare Goby/CHIP-0002/Sage name OR already-namespaced)
  // to the broker: alias → broker name, remap params (Goby transfer{to}→chia_send{address}).
  function callGoby(dappMethod, params) {
    return rpc(normalizeMethod(dappMethod), remapGobyParams(dappMethod, params));
  }

  // Resolve + cache the wallet's primary receive address. Goby's requestAccounts/accounts
  // return an address list; Sage's chia_getAddress returns {address} (or a bare string).
  async function fetchAddress() {
    const r = await rpc('chia_getAddress', {});
    const addr = typeof r === 'string' ? r : (r && r.address);
    if (addr) _selectedAddress = addr;
    return addr ? [addr] : [];
  }

  // Goby account helpers.
  async function requestAccounts() {
    await connect(false);       // prompts for approval if the origin isn't connected yet
    return fetchAddress();
  }
  function accounts() {
    if (!_connected) {
      const e = new Error('DIG wallet is not connected — call connect() first');
      e.code = PROVIDER_ERROR_CODES.DISCONNECTED; // 4900
      return Promise.reject(e);
    }
    return fetchAddress();
  }

  // DIG operates only on Chia mainnet. A switch TO mainnet is a no-op success; any other
  // chain is unsupported (answered locally — never forwarded to the broker).
  function walletSwitchChain(params) {
    const target = params && params.chainId;
    if (target === WALLET_CHAIN_ID || target == null) return Promise.resolve(null);
    const e = new Error('DIG wallet supports only Chia mainnet');
    e.code = PROVIDER_ERROR_CODES.UNSUPPORTED_METHOD; // 4200
    return Promise.reject(e);
  }

  const provider = {
    isDIG: true,
    // Goby identity flags — a Goby/Sage dApp feature-detects these (see loroco parity).
    isGoby: true,
    name: WALLET_PROVIDER_NAME,
    apiVersion: WALLET_API_VERSION,
    version: version || 'unknown',
    info: PROVIDER_INFO,
    /** The Sage-parity method catalogue an agent can introspect without out-of-band knowledge. */
    methods: WALLET_METHODS,
    /** Stable thrown-error code enum (documented in the README provider section). */
    errorCodes: PROVIDER_ERROR_CODES,
    get chainId() { return _chainId; },
    get selectedAddress() { return _selectedAddress; },
    isConnected() { return _connected; },
    request(args) {
      const method = args && args.method;
      const params = args && args.params;
      // Local introspection — answered without a round-trip so an agent can discover the
      // surface even before connecting.
      if (method === 'chip0002_getMethods' || method === 'chia_getMethods' || method === 'getMethods') {
        return Promise.resolve(WALLET_METHODS);
      }
      if (method === 'connect' || method === 'chip0002_connect') {
        return connect(params && params.eager);
      }
      if (method === 'requestAccounts') return requestAccounts();
      if (method === 'accounts') return accounts();
      if (method === 'walletSwitchChain') return walletSwitchChain(params);
      return callGoby(method, params);
    },
    // Goby-legacy DIRECT methods. dApps built against Goby's pre-CHIP-0002 surface
    // (dexie.space, tibetswap, …) call these on the object instead of via request().
    connect,
    walletSwitchChain,
    walletWatchAsset(params) { return callGoby('walletWatchAsset', params); },
    getPublicKeys(params) { return callGoby('getPublicKeys', params); },
    filterUnlockedCoins(params) { return callGoby('filterUnlockedCoins', params); },
    getAssetCoins(params) { return callGoby('getAssetCoins', params); },
    getAssetBalance(params) { return callGoby('getAssetBalance', params); },
    signCoinSpends(params) { return callGoby('signCoinSpends', params); },
    signMessage(params) { return callGoby('signMessage', params); },
    signMessageByAddress(params) { return callGoby('signMessageByAddress', params); },
    transfer(params) { return callGoby('transfer', params); },
    sendTransaction(params) { return callGoby('sendTransaction', params); },
    createOffer(params) { return callGoby('createOffer', params); },
    takeOffer(params) { return callGoby('takeOffer', params); },
    cancelOffer(params) { return callGoby('cancelOffer', params); },
    getNFTs(params) { return callGoby('getNFTs', params); },
    getNFTInfo(params) { return callGoby('getNFTInfo', params); },
    requestAccounts,
    accounts,
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    off(ev, fn) { listeners[ev] = (listeners[ev] || []).filter((x) => x !== fn); },
    removeListener(ev, fn) { listeners[ev] = (listeners[ev] || []).filter((x) => x !== fn); },
  };
  return provider;
}
