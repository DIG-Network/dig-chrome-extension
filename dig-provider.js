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
(function () {
  if (window.chia) return; // never clobber an already-present provider
  var listeners = {};
  var pending = {}; // id -> { resolve, reject, timer }

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
        e.code = -1;
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

  // One CHIP-0002 RPC. Maps the {status, body} envelope to the resolve/reject + error
  // shapes the dapp ecosystem expects (mirrors the native provider + the WC→Sage path).
  async function rpc(method, params) {
    var env = await bridgeCall(method, params);
    if (!env) {
      var ne = new Error('DIG wallet is not reachable');
      ne.code = -1;
      throw ne;
    }
    var status = env.status || 0;
    var body = env.body || {};
    if (status === 202) {
      var pe = new Error('Connection pending approval');
      pe.code = 4001;
      pe.pending = true;
      throw pe;
    }
    if (status < 200 || status >= 300) {
      var fe = new Error((body && body.error) || env.error || ('DIG wallet error ' + status));
      fe.code = status || -1;
      throw fe;
    }
    return body.data;
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
    // CHIP-0002 entrypoint. Accepts bare ("getPublicKeys"), chip0002_-namespaced, and
    // chia_-namespaced method names (normalised on the broker side too).
    request: function (args) {
      var method = args && args.method;
      var params = args && args.params;
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
