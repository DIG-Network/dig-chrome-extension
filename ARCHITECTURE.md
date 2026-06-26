# DIG Network Extension — Architecture

A Chromium Manifest V3 extension that intercepts `chia://` URIs and resolves DIG
content via `rpc.dig.net`, performing Merkle inclusion verification and
AES-256-GCM-SIV decryption **client-side** using the `dig_client` WASM module
(the same SRI-pinned artifact the hub and digstore use).

## The shipping read path

```
chia:// URL
  │  (intercepted by content scripts / page script / omnibox / nav)
  ▼
background.js  ── module service worker ("type":"module")
  │  parseURN()            (shared, from dig-urn.mjs)
  │  retrievalKey()        ┐
  │  verifyInclusion()     │  dig_client.js + dig_client_bg.wasm
  │  deriveKey()           │  (SRI-pinned read-crypto WASM)
  │  decryptChunk()        ┘
  ▼
rpc.dig.net  ── JSON-RPC 2.0 dig.getContent  →  ciphertext + inclusion proof
  ▼
verified + decrypted bytes  →  data: URL  →  returned to the requesting page
```

`background.js` is the heart of the extension. It is loaded as an **ES module
service worker** (`manifest.json` → `background.service_worker` with
`"type": "module"`), which is required because `dig_client.js` is a
`wasm-bindgen` ES module that uses `import.meta.url` and cannot be loaded via
`importScripts()`. The WASM binary is integrity-checked (SHA-256) against a
pinned digest before any crypto runs — a mismatch fails closed.

## File map (what actually ships)

`build.js` (`node build.js`) validates and copies these files into `dist/`:

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest: module SW, content scripts, permissions, omnibox, web-accessible resources |
| `background.js` | Module service worker — URN parse, RPC fetch, WASM verify + decrypt, caching |
| `dig-urn.mjs` | **Shared** URN parser + base36 store-id helpers (single source of truth; ES module) |
| `dig_client.js` + `dig_client_bg.wasm` | SRI-pinned read-crypto WASM (`retrievalKey`, `deriveKey`, `verifyInclusion`, `decryptChunk`). **Do not edit** — it is the byte-identical cross-system crypto artifact (see `../../SYSTEM.md`). |
| `content.js` | Content script — rewrites `chia://` resource references (img/script/link/srcset/etc.) on every page |
| `middleware.js` | Content script — fallback-strategy ordering for resolving `chia://` requests |
| `page-script.js` | Injected into the page (main world) to intercept `chia://` before the browser fetches it |
| `popup.html` / `popup.css` / `popup.js` | Toolbar popup — configure the RPC endpoint, view status |
| `dig-viewer.html` / `dig-viewer.js` | Standalone viewer iframe that fetches + embeds DIG content via the SW |
| `src/favicon.png`, `src/logo.png` | Extension icon + popup logo |

The Node test server in `server/` and the root `stub-server.js` / `test-server.js`
are **development-only** and are not part of the shipped extension. The dev server
imports `dig-urn.mjs` (via dynamic `import()`, since it runs as CommonJS) so it
shares the exact same URN parser as the extension.

## Shared URN parser (`dig-urn.mjs`)

There is exactly **one** `parseURN` implementation, in `dig-urn.mjs`. It accepts the
union of inputs every caller passes — a `chia://` scheme prefix, leading slashes, the
`urn:dig:` prefix, and an optional `?salt=<hex>` private-store param — and returns
`{ chain, storeId, roothash, resourceKey, salt }`. The module service worker imports
it directly (`import { parseURN } from './dig-urn.mjs'`); the dev server imports it
via dynamic `import()`. The parser is pinned by `tests/parse-urn.test.mjs`
(`node --test tests/`).

A parsed URN **with** a `roothash` identifies a specific *capsule* — one immutable
store generation, the pair `storeId:roothash` (a store is a sequence of capsules,
one per commit). A **rootless** URN (`roothash === null`) references the store's
**latest** capsule. (Capsule is the canonical term shared across the ecosystem;
see `../../SYSTEM.md`.)

The URN scheme itself (`urn:dig:<chain>:<storeID>[:<rootHash>][/<resourceKey>]`),
the retrieval key (`SHA256(canonical_urn)`), and the crypto tags are **cross-system
contracts** defined in `../../SYSTEM.md`; the parser must keep producing the same
canonical components as the other implementations.

## Build

```bash
npm run build        # node build.js  → dist/
npm run build:zip    # same, plus a versioned .zip for distribution
```

`build.js` fails if any required file is missing. Load the unpacked extension from
`dist/` via `chrome://extensions` → Developer mode → Load unpacked.

## Tests

```bash
node --test tests/   # pinning tests for the shared URN parser
```
