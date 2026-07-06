/**
 * store-interceptor.entry.ts — the DIG store IN-PAGE INTERCEPTOR (issue #55).
 *
 * WHERE THIS RUNS: inside the SANDBOXED, opaque-origin `data:` iframe that dig-viewer renders a
 * store's HTML into. Because the frame has an opaque origin, a store document's relative links +
 * asset references (`./style.css`, `/img/x.png`, a relative `<a href>`, a relative `fetch()`) have
 * no real origin to resolve against and would break. This interceptor is the extension's mirror of
 * the *.on.dig.net loader's request interception: MV3 can't register a page service worker onto the
 * rendered document, so it monkey-patches `fetch` + `XMLHttpRequest` and rewrites DOM `src`/`href`
 * on injection + on mutation, resolving each DIG-bound reference back to a `chia://` read against
 * the SAME capsule.
 *
 * HOW THE READ HAPPENS: every read is DELEGATED to the parent (dig-viewer) over `postMessage`; the
 * parent calls the background `proxyRequest`, which resolves the node endpoint via the §5.3 ladder
 * and verifies + decrypts with the SRI-pinned read-crypto WASM. The store sandbox holds NO keys and
 * runs NO crypto (the extension stays a pure RPC consumer), keeping ONE decrypt path.
 *
 * The parent injects `window.__DIG_CFG = { storeId, root, salt, entryKey }` in a script BEFORE this
 * one. Pure ref classification/resolution lives in `#shared/store-refs.mjs` (unit-tested); esbuild
 * inlines it into a self-contained IIFE (`dist/store-interceptor.js`) so this runs in the opaque
 * frame with no module loading or cross-origin fetch.
 */
import {
  classifyReference,
  contentType,
  type StoreRef,
  type ClassifiedRef,
  type ClassifyContext,
} from '@/lib/store-refs';

/** The capsule config the parent injects on `window` before this script. */
interface FrameConfig {
  storeId?: string;
  root?: string;
  salt?: string | null;
  entryKey?: string;
}

/** The parent's `read-result` reply for one delegated capsule read. */
interface ReadResult {
  __dig?: boolean;
  type?: string;
  id?: number;
  ok?: boolean;
  dataUrl?: string;
  contentType?: string;
  verified?: boolean;
  code?: string;
  message?: string;
}

declare global {
  interface Window {
    __DIG_CFG?: FrameConfig;
  }
  interface XMLHttpRequest {
    /** The interceptor's per-request classification, stashed in open() for send() to act on. */
    __digCls?: ClassifiedRef;
  }
  interface Element {
    /** Marks an element whose DIG-bound src/href/click this interceptor already rewrote. */
    __digDone?: boolean;
  }
}

(function () {
  'use strict';

  const CFG: FrameConfig = (typeof window !== 'undefined' && window.__DIG_CFG) || {};
  const STORE_ID = CFG.storeId || '';
  const CFG_ROOT = CFG.root || 'latest';
  const CFG_SALT = CFG.salt || null;
  // The current document's resource key — the base relative refs resolve against. Updated on an
  // in-page <a> navigation so `../x` on a sub-page resolves relative to THAT page (multi-page store).
  let currentKey = CFG.entryKey || 'index.html';

  const parentWin = window.parent;
  const origFetch = window.fetch ? window.fetch.bind(window) : null;

  // --- Parent bridge --------------------------------------------------------------------------
  // Every DIG-bound read is a request to the parent (dig-viewer), which serves decrypted, verified
  // bytes as a `data:` URL via the background proxyRequest. Requests are correlated by an id.
  const pending = new Map<number, (r: ReadResult) => void>();
  let seq = 0;

  function onBridgeMessage(e: MessageEvent): void {
    if (e.source !== parentWin) return; // only trust our embedder
    const d = e.data as ReadResult | null;
    if (!d || d.__dig !== true || d.type !== 'read-result' || d.id === undefined) return;
    const resolve = pending.get(d.id);
    if (!resolve) return;
    pending.delete(d.id);
    resolve(d);
  }

  // NOTE: document.open()/write() (used by swapDocument) drops window event listeners in the
  // opaque frame, so this MUST be re-armed after every document swap — see armBridge() calls below.
  function armBridge(): void {
    window.removeEventListener('message', onBridgeMessage);
    window.addEventListener('message', onBridgeMessage);
  }
  armBridge();

  function requestRead(ref: StoreRef): Promise<ReadResult> {
    return new Promise<ReadResult>((resolve) => {
      const id = ++seq;
      pending.set(id, resolve);
      parentWin.postMessage({ __dig: true, type: 'read', id, ref }, '*');
    });
  }

  function notify(type: string, extra?: Record<string, unknown>): void {
    try {
      parentWin.postMessage(Object.assign({ __dig: true, type }, extra || {}), '*');
    } catch {
      /* parent gone */
    }
  }

  function ctx(): ClassifyContext {
    return {
      cfg: { storeId: STORE_ID, root: CFG_ROOT, salt: CFG_SALT },
      baseKey: currentKey,
      pageOrigin: location.origin,
    };
  }

  // Fetch a resolved DIG ref → a real Response. The parent hands back a `data:` URL (decrypted,
  // correct content-type); materialising it with the ORIGINAL fetch yields a Response the store's
  // own code consumes normally.
  function fetchRef(ref: StoreRef): Promise<Response> {
    return requestRead(ref).then((r) => {
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
    window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url =
        typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      const cls = classifyReference(url, ctx());
      if (cls.kind === 'external') return origFetch(input, init);
      return fetchRef(cls.ref);
    };
  }

  // --- XMLHttpRequest patch -------------------------------------------------------------------
  // A DIG-bound GET is deferred to send(), then fulfilled from the parent-served bytes (decrypt is
  // async, so we can't resolve to an object URL synchronously in open()). Mirrors dig-embed Tier-2.
  const XHR = window.XMLHttpRequest;
  if (XHR) {
    const origOpen = XHR.prototype.open as unknown as (this: XMLHttpRequest, ...a: unknown[]) => void;
    const origSend = XHR.prototype.send as unknown as (this: XMLHttpRequest, ...a: unknown[]) => void;
    XHR.prototype.open = function (
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      ...rest: unknown[]
    ): void {
      const isGet = !!method && String(method).toUpperCase() === 'GET';
      this.__digCls = isGet ? classifyReference(url, ctx()) : { kind: 'external' };
      if (this.__digCls.kind === 'external') origOpen.call(this, method, url, ...rest);
      // else: defer to send()
    } as typeof XHR.prototype.open;
    XHR.prototype.send = function (this: XMLHttpRequest, ...sendArgs: unknown[]): void {
      const cls = this.__digCls;
      if (!cls || cls.kind === 'external') {
        origSend.apply(this, sendArgs);
        return;
      }
      // The .then/.catch callbacks are arrow fns, so `this` stays the XMLHttpRequest instance.
      fetchRef(cls.ref)
        .then((res) => res.text().then((t) => ({ status: res.status, text: t })))
        .then((r) => {
          try {
            Object.defineProperty(this, 'responseText', { value: r.text, configurable: true });
            Object.defineProperty(this, 'response', { value: r.text, configurable: true });
            Object.defineProperty(this, 'status', { value: r.status, configurable: true });
            Object.defineProperty(this, 'readyState', { value: 4, configurable: true });
          } catch {
            /* read-only in some engines */
          }
          if (typeof this.onreadystatechange === 'function') {
            this.onreadystatechange.call(this, new Event('readystatechange'));
          }
          this.dispatchEvent(new Event('readystatechange'));
          this.dispatchEvent(new Event(r.status >= 200 && r.status < 300 ? 'load' : 'error'));
          this.dispatchEvent(new Event('loadend'));
        })
        .catch(() => {
          this.dispatchEvent(new Event('error'));
        });
    } as typeof XHR.prototype.send;
  }

  // --- DOM src/href rewriting (initial scan + MutationObserver) -------------------------------
  // For subresources we set the attribute to the parent-served `data:` URL (works directly in the
  // opaque frame — no object-URL bookkeeping). For <a> we hijack the click (a native navigation
  // would escape the interceptor) and swap the document in-page.
  function rewriteEl(el: Element): void {
    if (!el || el.nodeType !== 1 || el.__digDone) return;
    const tag = el.tagName;
    if (
      tag === 'IMG' ||
      tag === 'SCRIPT' ||
      tag === 'SOURCE' ||
      tag === 'VIDEO' ||
      tag === 'AUDIO' ||
      tag === 'IFRAME' ||
      tag === 'TRACK' ||
      tag === 'EMBED'
    ) {
      const val = el.getAttribute('src');
      if (val) {
        const cls = classifyReference(val, ctx());
        if (cls.kind !== 'external') {
          el.__digDone = true;
          requestRead(cls.ref)
            .then((r) => {
              if (r && r.ok && r.dataUrl) el.setAttribute('src', r.dataUrl);
            })
            .catch(() => {});
        }
      }
    } else if (tag === 'LINK') {
      const rel = (el.getAttribute('rel') || '').toLowerCase();
      const href = el.getAttribute('href');
      if (
        href &&
        (rel.indexOf('stylesheet') !== -1 ||
          rel.indexOf('icon') !== -1 ||
          rel.indexOf('preload') !== -1 ||
          rel.indexOf('manifest') !== -1)
      ) {
        const clsL = classifyReference(href, ctx());
        if (clsL.kind !== 'external') {
          el.__digDone = true;
          requestRead(clsL.ref)
            .then((r) => {
              if (r && r.ok && r.dataUrl) el.setAttribute('href', r.dataUrl);
            })
            .catch(() => {});
        }
      }
    } else if (tag === 'A' || tag === 'AREA') {
      const ah = el.getAttribute('href');
      if (ah) {
        const clsA = classifyReference(ah, ctx());
        if (clsA.kind !== 'external') {
          el.__digDone = true;
          el.addEventListener('click', (ev) => {
            ev.preventDefault();
            navigateInPage(clsA.ref);
          });
        }
      }
    }
  }

  function scan(root: ParentNode | null): void {
    if (!root || !root.querySelectorAll) return;
    const nodes = root.querySelectorAll('img,script,source,video,audio,iframe,track,embed,link,a,area');
    for (let i = 0; i < nodes.length; i++) rewriteEl(nodes[i]);
  }

  let observer: MutationObserver | null = null;
  function installObserver(): void {
    if (observer) {
      try {
        observer.disconnect();
      } catch {
        /* ignore */
      }
    }
    observer = new MutationObserver((muts) => {
      for (let i = 0; i < muts.length; i++) {
        const added = muts[i].addedNodes;
        for (let j = 0; j < added.length; j++) {
          const n = added[j];
          if (n.nodeType === 1) {
            rewriteEl(n as Element);
            scan(n as Element);
          }
        }
      }
    });
    // Observe the document node (not documentElement) so the observer survives a document.write
    // that replaces documentElement on an in-page navigation.
    try {
      observer.observe(document, { childList: true, subtree: true });
    } catch {
      /* ignore */
    }
  }

  // --- Document swap (initial entry + in-page <a> navigation) ---------------------------------
  function swapDocument(html: string): void {
    document.open();
    document.write(html);
    document.close();
    // document.open() dropped the window 'message' listener + the observer's target was replaced —
    // re-arm BOTH, then rewrite the just-parsed tree (the observer covers nodes inserted AFTER this).
    armBridge();
    installObserver();
    scan(document);
  }

  function navigateInPage(ref: StoreRef): void {
    notify('nav-start', {});
    requestRead(ref)
      .then((r) => {
        if (!r || !r.ok || !r.dataUrl) {
          notify('nav-error', { code: r && r.code, message: r && r.message });
          return;
        }
        currentKey = ref.resourceKey || 'index.html';
        const ct = r.contentType || contentType(currentKey);
        if (ct.indexOf('text/html') === 0) {
          // HTML target: swap the document in-page. Fetch the data: URL to get the HTML text.
          (origFetch ? origFetch(r.dataUrl) : fetch(r.dataUrl))
            .then((res) => res.text())
            .then((html) => {
              swapDocument(html);
              notify('nav', { verified: !!r.verified, urn: buildUrn(ref) });
            })
            .catch(() => notify('nav-error', {}));
        } else {
          // Non-HTML target: navigate the frame straight to the decrypted data: URL.
          location.href = r.dataUrl;
        }
      })
      .catch(() => notify('nav-error', {}));
  }

  // A URN string for the parent's badge/ledger (informational only; the parent re-derives its own).
  function buildUrn(ref: StoreRef): string {
    const root = ref.root && ref.root !== 'latest' ? ':' + ref.root : '';
    return 'chia://chia:' + ref.storeId + root + '/' + (ref.resourceKey || 'index.html');
  }

  // --- Boot: render the entry, then let the interceptor serve everything it references ---------
  installObserver();
  const entryRef: StoreRef = { storeId: STORE_ID, root: CFG_ROOT, resourceKey: currentKey, salt: CFG_SALT };
  requestRead(entryRef)
    .then((r) => {
      if (!r || !r.ok || !r.dataUrl) {
        notify('entry-error', { code: r && r.code, message: r && r.message });
        return;
      }
      const ct = r.contentType || contentType(currentKey);
      if (ct.indexOf('text/html') === 0) {
        (origFetch ? origFetch(r.dataUrl) : fetch(r.dataUrl))
          .then((res) => res.text())
          .then((html) => {
            swapDocument(html);
            notify('ready', { verified: !!r.verified });
          })
          .catch(() => notify('entry-error', {}));
      } else {
        // A non-HTML entry (e.g. a direct image URN): show it directly.
        location.href = r.dataUrl;
        notify('ready', { verified: !!r.verified });
      }
    })
    .catch(() => notify('entry-error', {}));
})();

export {};
