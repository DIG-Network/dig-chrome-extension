/**
 * store-interceptor.entry.mjs — the DIG store IN-PAGE INTERCEPTOR (issue #55).
 *
 * WHERE THIS RUNS: inside the SANDBOXED, opaque-origin `data:` iframe that dig-viewer renders a
 * store's HTML into. Because the frame has an opaque origin, a store document's relative links +
 * asset references (`./style.css`, `/img/x.png`, a relative `<a href>`, a relative `fetch()`) have
 * no real origin to resolve against and would break. This interceptor is the extension's mirror of
 * the *.on.dig.net loader's request interception (`services/on.dig.net/assets/sw.js` + the Tier-2
 * in-page path in `dig-embed.js`): MV3 can't register a page service worker onto this rendered
 * document, so — exactly like dig-embed Tier-2 — it monkey-patches `fetch` + `XMLHttpRequest` and
 * rewrites DOM `src`/`href` on injection + on mutation, resolving each DIG-bound reference back to
 * a `chia://` read against the SAME capsule.
 *
 * HOW THE READ HAPPENS (the ONE difference from dig-embed Tier-2, by design): dig-embed does the
 * fetch+decrypt in-page with its own WASM against a hard-coded `rpc.dig.net`. The extension instead
 * DELEGATES every read to its parent (dig-viewer) over `postMessage`; the parent calls the existing
 * background `proxyRequest`, which already (a) resolves the node endpoint via the §5.3 ladder
 * (dig.local → localhost → rpc.dig.net, honouring an explicit override) and (b) verifies + decrypts
 * with the SRI-pinned read-crypto WASM. This keeps the store sandbox holding NO keys and running NO
 * crypto (the extension stays a pure RPC consumer), keeps ONE decrypt path, and keeps the node
 * ladder authoritative — while reproducing on.dig.net's relative-resolution behaviour exactly.
 *
 * The parent injects `window.__DIG_CFG = { storeId, root, salt, entryKey }` in a script BEFORE this
 * one. Pure ref classification/resolution lives in store-refs.mjs (unit-tested); esbuild inlines it
 * into a self-contained IIFE (`dist/store-interceptor.js`) so this runs in the opaque frame with no
 * module loading or cross-origin fetch.
 */
import { classifyReference, contentType } from './store-refs.mjs';

(function () {
  'use strict';

  var CFG = (typeof window !== 'undefined' && window.__DIG_CFG) || {};
  var STORE_ID = CFG.storeId || '';
  var CFG_ROOT = CFG.root || 'latest';
  var CFG_SALT = CFG.salt || null;
  // The current document's resource key — the base relative refs resolve against. Updated on an
  // in-page <a> navigation so `../x` on a sub-page resolves relative to THAT page (multi-page store).
  var currentKey = CFG.entryKey || 'index.html';

  var parentWin = window.parent;
  var origFetch = window.fetch ? window.fetch.bind(window) : null;

  // --- Parent bridge --------------------------------------------------------------------------
  // Every DIG-bound read is a request to the parent (dig-viewer), which serves decrypted, verified
  // bytes as a `data:` URL via the background proxyRequest. Requests are correlated by an id.
  var pending = new Map();
  var seq = 0;
  function onBridgeMessage(e) {
    if (e.source !== parentWin) return; // only trust our embedder
    var d = e.data;
    if (!d || d.__dig !== true || d.type !== 'read-result') return;
    var resolve = pending.get(d.id);
    if (!resolve) return;
    pending.delete(d.id);
    resolve(d);
  }
  // NOTE: document.open()/write() (used by swapDocument) drops window event listeners in the
  // opaque frame, so this MUST be re-armed after every document swap — see armBridge() calls below.
  function armBridge() {
    window.removeEventListener('message', onBridgeMessage);
    window.addEventListener('message', onBridgeMessage);
  }
  armBridge();
  function requestRead(ref) {
    return new Promise(function (resolve) {
      var id = ++seq;
      pending.set(id, resolve);
      parentWin.postMessage({ __dig: true, type: 'read', id: id, ref: ref }, '*');
    });
  }
  function notify(type, extra) {
    try {
      parentWin.postMessage(Object.assign({ __dig: true, type: type }, extra || {}), '*');
    } catch (_) {}
  }
  function ctx() {
    return {
      cfg: { storeId: STORE_ID, root: CFG_ROOT, salt: CFG_SALT },
      baseKey: currentKey,
      pageOrigin: location.origin,
    };
  }

  // Fetch a resolved DIG ref → a real Response. The parent hands back a `data:` URL (decrypted,
  // correct content-type); materialising it with the ORIGINAL fetch yields a Response the store's
  // own code consumes normally.
  function fetchRef(ref) {
    return requestRead(ref).then(function (r) {
      if (!r || !r.ok || !r.dataUrl) {
        return new Response('DIG read failed: ' + ((r && (r.message || r.code)) || 'unavailable'), {
          status: 502,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        });
      }
      if (origFetch) return origFetch(r.dataUrl);
      // No native fetch (unlikely) — build a Response from the data: URL's payload directly.
      return new Response(r.dataUrl);
    });
  }

  // --- fetch() patch --------------------------------------------------------------------------
  if (origFetch) {
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : input && input.url;
      var cls = classifyReference(url, ctx());
      if (cls.kind === 'external' || !cls.ref) return origFetch(input, init);
      return fetchRef(cls.ref);
    };
  }

  // --- XMLHttpRequest patch -------------------------------------------------------------------
  // A DIG-bound GET is deferred to send(), then fulfilled from the parent-served bytes (decrypt is
  // async, so we can't resolve to an object URL synchronously in open()). Mirrors dig-embed Tier-2.
  var XHR = window.XMLHttpRequest;
  if (XHR) {
    var origOpen = XHR.prototype.open;
    var origSend = XHR.prototype.send;
    XHR.prototype.open = function (method, url) {
      var isGet = method && String(method).toUpperCase() === 'GET';
      this.__digCls = isGet ? classifyReference(url, ctx()) : { kind: 'external' };
      if (!this.__digCls || this.__digCls.kind === 'external') return origOpen.apply(this, arguments);
      return; // defer to send()
    };
    XHR.prototype.send = function () {
      var xhr = this;
      if (!xhr.__digCls || xhr.__digCls.kind === 'external') return origSend.apply(xhr, arguments);
      fetchRef(xhr.__digCls.ref)
        .then(function (res) { return res.text().then(function (t) { return { status: res.status, text: t }; }); })
        .then(function (r) {
          try {
            Object.defineProperty(xhr, 'responseText', { value: r.text, configurable: true });
            Object.defineProperty(xhr, 'response', { value: r.text, configurable: true });
            Object.defineProperty(xhr, 'status', { value: r.status, configurable: true });
            Object.defineProperty(xhr, 'readyState', { value: 4, configurable: true });
          } catch (_) {}
          if (typeof xhr.onreadystatechange === 'function') xhr.onreadystatechange();
          xhr.dispatchEvent(new Event('readystatechange'));
          xhr.dispatchEvent(new Event(r.status >= 200 && r.status < 300 ? 'load' : 'error'));
          xhr.dispatchEvent(new Event('loadend'));
        })
        .catch(function () { xhr.dispatchEvent(new Event('error')); });
    };
  }

  // --- DOM src/href rewriting (initial scan + MutationObserver) -------------------------------
  // For subresources we set the attribute to the parent-served `data:` URL (works directly in the
  // opaque frame — no object-URL bookkeeping). For <a> we hijack the click (a native navigation
  // would escape the interceptor) and swap the document in-page.
  function rewriteEl(el) {
    if (!el || el.nodeType !== 1 || el.__digDone) return;
    var tag = el.tagName;
    if (tag === 'IMG' || tag === 'SCRIPT' || tag === 'SOURCE' || tag === 'VIDEO' || tag === 'AUDIO' || tag === 'IFRAME' || tag === 'TRACK' || tag === 'EMBED') {
      var val = el.getAttribute('src');
      if (val) {
        var cls = classifyReference(val, ctx());
        if (cls.kind !== 'external' && cls.ref) {
          el.__digDone = true;
          requestRead(cls.ref).then(function (r) {
            if (r && r.ok && r.dataUrl) el.setAttribute('src', r.dataUrl);
          }).catch(function () {});
        }
      }
    } else if (tag === 'LINK') {
      var rel = (el.getAttribute('rel') || '').toLowerCase();
      var href = el.getAttribute('href');
      if (href && (rel.indexOf('stylesheet') !== -1 || rel.indexOf('icon') !== -1 || rel.indexOf('preload') !== -1 || rel.indexOf('manifest') !== -1)) {
        var clsL = classifyReference(href, ctx());
        if (clsL.kind !== 'external' && clsL.ref) {
          el.__digDone = true;
          requestRead(clsL.ref).then(function (r) {
            if (r && r.ok && r.dataUrl) el.setAttribute('href', r.dataUrl);
          }).catch(function () {});
        }
      }
    } else if (tag === 'A' || tag === 'AREA') {
      var ah = el.getAttribute('href');
      if (ah) {
        var clsA = classifyReference(ah, ctx());
        if (clsA.kind !== 'external' && clsA.ref) {
          el.__digDone = true;
          el.addEventListener('click', function (ev) {
            ev.preventDefault();
            navigateInPage(clsA.ref);
          });
        }
      }
    }
  }
  function scan(root) {
    if (!root || !root.querySelectorAll) return;
    var nodes = root.querySelectorAll('img,script,source,video,audio,iframe,track,embed,link,a,area');
    for (var i = 0; i < nodes.length; i++) rewriteEl(nodes[i]);
  }
  var observer = null;
  function installObserver() {
    if (observer) { try { observer.disconnect(); } catch (_) {} }
    observer = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var n = added[j];
          if (n.nodeType === 1) { rewriteEl(n); scan(n); }
        }
      }
    });
    // Observe the document node (not documentElement) so the observer survives a document.write
    // that replaces documentElement on an in-page navigation.
    try { observer.observe(document, { childList: true, subtree: true }); } catch (_) {}
  }

  // --- Document swap (initial entry + in-page <a> navigation) ---------------------------------
  function swapDocument(html) {
    document.open();
    document.write(html);
    document.close();
    // document.open() dropped the window 'message' listener + the observer's target was replaced —
    // re-arm BOTH, then rewrite the just-parsed tree (the observer covers nodes inserted AFTER this).
    armBridge();
    installObserver();
    scan(document);
  }
  function navigateInPage(ref) {
    notify('nav-start', {});
    requestRead(ref).then(function (r) {
      if (!r || !r.ok || !r.dataUrl) { notify('nav-error', { code: r && r.code, message: r && r.message }); return; }
      currentKey = ref.resourceKey || 'index.html';
      var ct = r.contentType || contentType(currentKey);
      if (ct.indexOf('text/html') === 0) {
        // HTML target: swap the document in-page. Fetch the data: URL to get the HTML text.
        (origFetch ? origFetch(r.dataUrl) : fetch(r.dataUrl))
          .then(function (res) { return res.text(); })
          .then(function (html) { swapDocument(html); notify('nav', { verified: !!r.verified, urn: buildUrn(ref) }); })
          .catch(function () { notify('nav-error', {}); });
      } else {
        // Non-HTML target: navigate the frame straight to the decrypted data: URL.
        location.href = r.dataUrl;
      }
    }).catch(function () { notify('nav-error', {}); });
  }

  // A URN string for the parent's badge/ledger (informational only; the parent re-derives its own).
  function buildUrn(ref) {
    var root = ref.root && ref.root !== 'latest' ? ':' + ref.root : '';
    return 'chia://chia:' + ref.storeId + root + '/' + (ref.resourceKey || 'index.html');
  }

  // --- Boot: render the entry, then let the interceptor serve everything it references ---------
  installObserver();
  var entryRef = { storeId: STORE_ID, root: CFG_ROOT, resourceKey: currentKey, salt: CFG_SALT };
  requestRead(entryRef)
    .then(function (r) {
      if (!r || !r.ok || !r.dataUrl) { notify('entry-error', { code: r && r.code, message: r && r.message }); return; }
      var ct = r.contentType || contentType(currentKey);
      if (ct.indexOf('text/html') === 0) {
        (origFetch ? origFetch(r.dataUrl) : fetch(r.dataUrl))
          .then(function (res) { return res.text(); })
          .then(function (html) { swapDocument(html); notify('ready', { verified: !!r.verified }); })
          .catch(function () { notify('entry-error', {}); });
      } else {
        // A non-HTML entry (e.g. a direct image URN): show it directly.
        location.href = r.dataUrl;
        notify('ready', { verified: !!r.verified });
      }
    })
    .catch(function () { notify('entry-error', {}); });
})();
