// DIG injected wallet provider (CHIP-0002 `window.chia`) — extension edition.
//
// Ported from the native DIG Browser's `dig_provider.js`
// (modules/ungoogled-chromium-windows/dig/provider/dig_provider.js). Same surface a dapp
// sees — `window.chia` with isDIG, request(), connect(), on/off — so a dapp written for
// the native DIG Browser works unchanged on Chrome/Edge/Brave/Firefox with this extension.
//
// Transport difference: the native browser reaches an in-process wallet over a Mojo pipe
// (`window.__digWalletRpc`). An MV3 extension can't run an in-process wallet, so this
// provider relays each CHIP-0002 RPC to the content-script bridge over window.postMessage
// (DIG_WALLET_REQUEST → DIG_WALLET_RESPONSE), which forwards to the background service
// worker, which brokers it over WalletConnect to Sage. Per-origin connect consent + Sage's
// own per-call approval still gate key/sign methods, mirroring the browser's origin gate.
//
// Injected into the page's MAIN world at document_start by content.js.
//
// SELF-DESCRIPTION (agent-friendly): besides isDIG/request/connect/on/off this provider
// exposes `version`, an `info` capability object, and a `methods` catalogue — and answers
// `request({method:'chip0002_getMethods'})` locally — so a dapp/agent can feature-detect
// the surface without out-of-band knowledge. The thrown-error `code` uses the STANDARD
// wallet codes (4001 user-rejected, 4100 unauthorized, 4200 unsupported, 4900 disconnected)
// instead of ad-hoc sentinels. This surface is mirrored from dig-provider-core.mjs (the
// unit-tested source of truth) and kept byte-aligned with the native DIG Browser provider
// (SYSTEM.md → keep the two providers in sync). This file inlines it because the MAIN world
// cannot use ES `import`.
(function () {
  if (window.chia) return; // never clobber an already-present provider
  var listeners = {};
  var pending = {}; // id -> { resolve, reject, timer }

  // Standard wallet provider error codes (EIP-1193 / CHIP-0002 aligned). Mirrors
  // PROVIDER_ERROR_CODES in dig-provider-core.mjs.
  var ERR = { USER_REJECTED: 4001, UNAUTHORIZED: 4100, UNSUPPORTED_METHOD: 4200, DISCONNECTED: 4900 };

  // The Sage-parity method catalogue (mirrors wallet-methods.mjs WALLET_METHODS). Inlined
  // so window.chia.methods + chip0002_getMethods can answer locally with zero round-trips.
  var WALLET_METHODS = [
    'chip0002_chainId', 'chip0002_connect', 'chip0002_getPublicKeys', 'chip0002_signMessage',
    'chip0002_signCoinSpends', 'chip0002_getAssetBalance', 'chip0002_getAssetCoins',
    'chia_getAddress', 'chia_signMessageByAddress', 'chia_send', 'chia_getTransactions',
    'chia_getNfts', 'chia_transferNft', 'chia_mintNft', 'chia_bulkMintNfts', 'chia_getDids',
    'chia_createDidWallet', 'chia_transferDid', 'chia_getOfferSummary', 'chia_createOffer',
    'chia_takeOffer', 'chia_cancelOffer',
  ];

  // Extension version, read from the manifest at injection time (best-effort; the page world
  // has chrome.runtime.getManifest on Chromium MV3).
  var EXT_VERSION = 'unknown';
  try { if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest) EXT_VERSION = chrome.runtime.getManifest().version || 'unknown'; } catch (e) { /* page world */ }

  function emit(ev, data) {
    (listeners[ev] || []).slice().forEach(function (fn) {
      try { fn(data); } catch (e) { /* a listener must not break dispatch */ }
    });
  }

  // One round-trip to the content-script bridge. Resolves with the wallet's JSON
  // envelope {status, body} or rejects on timeout / bridge absence.
  function bridgeCall(method, params, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var id = Math.random().toString(36).slice(2) + Date.now().toString(36);
      var timer = setTimeout(function () {
        delete pending[id];
        var e = new Error('DIG wallet request timed out');
        e.code = ERR.DISCONNECTED; // 4900 — no reply from the wallet bridge
        reject(e);
      }, timeoutMs || 120000);
      pending[id] = { resolve: resolve, reject: reject, timer: timer };
      window.postMessage(
        { type: 'DIG_WALLET_REQUEST', id: id, method: method, params: params || {} },
        '*'
      );
    });
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var d = event.data;
    if (!d || d.type !== 'DIG_WALLET_RESPONSE') return;
    var p = pending[d.id];
    if (!p) return;
    delete pending[d.id];
    clearTimeout(p.timer);
    p.resolve({ status: d.status, body: d.body, error: d.error });
  });

  // Map a broker {status, body} envelope (or its absence) to an Error carrying a STANDARD
  // wallet code. Mirrors mapEnvelopeToError() in dig-provider-core.mjs.
  function mapEnvelopeToError(env) {
    if (!env) {
      var ne = new Error('DIG wallet is not reachable');
      ne.code = ERR.DISCONNECTED;
      return ne;
    }
    var status = env.status || 0;
    var body = env.body || {};
    var msg = (body && body.error) || env.error || ('DIG wallet error ' + status);
    if (status === 202) {
      var pe = new Error('Connection pending approval');
      pe.code = ERR.USER_REJECTED; // 4001
      pe.pending = true;
      pe.status = status;
      return pe;
    }
    var code;
    if (status === 401 || status === 403) code = ERR.UNAUTHORIZED;       // 4100
    else if (status === 404) code = ERR.UNSUPPORTED_METHOD;             // 4200
    else if (status >= 500 || status === 0) code = ERR.DISCONNECTED;    // 4900
    else code = ERR.USER_REJECTED;                                      // 4001
    var fe = new Error(msg);
    fe.code = code;
    fe.status = status;
    return fe;
  }

  // One CHIP-0002 RPC. Resolves body.data on 2xx; throws a standard-coded error otherwise.
  async function rpc(method, params) {
    var env = await bridgeCall(method, params);
    var status = env && env.status || 0;
    if (!env || status < 200 || status >= 300) {
      throw mapEnvelopeToError(env);
    }
    return (env.body || {}).data;
  }

  // connect() blocks until the user approves this origin (or rejects / times out).
  async function connect(eager) {
    var deadline = Date.now() + 120000;
    for (;;) {
      try {
        var r = await rpc('chip0002_connect', { eager: !!eager });
        window.chia.isConnected = true;
        emit('connect', r);
        return r;
      } catch (e) {
        if (e.pending && Date.now() < deadline) {
          await new Promise(function (res) { setTimeout(res, 1200); });
          continue;
        }
        throw e;
      }
    }
  }

  window.chia = {
    isDIG: true,
    isConnected: false,
    // Self-describing surface (agent-friendly): version, capability info, method catalogue.
    version: EXT_VERSION,
    info: { isDIG: true, transport: 'walletconnect', edition: 'extension', providerVersion: 1 },
    methods: WALLET_METHODS.slice(),
    // CHIP-0002 entrypoint. Accepts bare ("getPublicKeys"), chip0002_-namespaced, and
    // chia_-namespaced method names (normalised on the broker side too). Answers the
    // method-discovery call locally so an agent can introspect before connecting.
    request: function (args) {
      var method = args && args.method;
      var params = args && args.params;
      if (method === 'chip0002_getMethods' || method === 'chia_getMethods') {
        return Promise.resolve(WALLET_METHODS.slice());
      }
      if (method === 'connect' || method === 'chip0002_connect') {
        return connect(params && params.eager);
      }
      var m = /^(chip0002_|chia_)/.test(method) ? method : 'chip0002_' + method;
      return rpc(m, params);
    },
    connect: connect,
    on: function (ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    off: function (ev, fn) {
      listeners[ev] = (listeners[ev] || []).filter(function (x) { return x !== fn; });
    },
  };

  window.dispatchEvent(new Event('chia#initialized'));
})();
