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
| `messages.mjs` | **Versioned MESSAGE catalogue** — the frozen `ACTIONS` enum + JSDoc-typed request/response DTOs for every `chrome.runtime` action, plus the `getCapabilities` self-description. Imported by `background.js` / `dig-viewer.js`. |
| `error-codes.mjs` | **Catalogued chia:// loader error codes** (`DIG_ERR_*`) + `classifyError`/`makeError`. The four canonical codes mirror docs.dig.net `error-codes.json` `dig-loader`. |
| `dig-provider-core.mjs` | Unit-tested core of the injected `window.chia` provider (version/info/methods + standard error codes). `dig-provider.js` inlines this surface. |
| `agent-surface.mjs` → `dist/agent-surface.json` | Machine-readable self-description (actions + wallet methods + error codes + provider surface) generated at build time from the modules above. |
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

## Machine-readable contracts (agent-friendly surface)

The extension exposes three stable, versioned, machine-consumable contracts so an agent (or
the popup / viewer themselves) can drive it without reading 90 KB of `background.js`. All
three are generated from single-source modules and surfaced as one JSON artifact at
`dist/agent-surface.json` (a `web_accessible_resource`) — also printable with
`node build.js --json`.

### 1. The background MESSAGE protocol — `messages.mjs`

Every `chrome.runtime` `message.action` the service worker handles is enumerated in the
frozen `ACTIONS` enum, documented in `MESSAGE_CATALOGUE` (one entry per action with a
`summary` + request/response field shapes), and versioned by `MESSAGE_PROTOCOL_VERSION`.
Consumers import `ACTIONS.proxyRequest` instead of the raw string. The
`getCapabilities` action returns the whole self-description
(`{ version, messageProtocol, actions, walletMethods, stateChangingMethods, errorCodes, bridge }`).
The page↔extension provider bridge is `BRIDGE.WALLET_REQUEST` / `BRIDGE.WALLET_RESPONSE`
(window.postMessage). `messages.test.mjs` fails if a handler is added without a catalogue
entry (drift guard).

### 2. chia:// loader error codes — `error-codes.mjs`

Every read-path failure carries a stable `DIG_ERR_*` code alongside the friendly human
message — `proxyRequest` / `convertDigUrl` / `getDataUrl` return
`{ success:false, code, message }`, and the viewer exposes the code on the document as
`data-dig-error`. The **four canonical codes** are the cross-surface `dig-loader` subset and
are kept byte-identical with docs.dig.net's `static/error-codes.json`:

| Code | Meaning |
|---|---|
| `DIG_ERR_PROOF_MISMATCH` | Served content didn't verify against the on-chain root (tamper / wrong root). |
| `DIG_ERR_DECRYPT_TAG` | AES-256-GCM-SIV tag failed — wrong key/salt, corrupt bytes, or a decoy. |
| `DIG_ERR_NOT_FOUND` | Blind miss (decoy) — no resource at this retrieval key under this generation. |
| `DIG_ERR_NETWORK` | Node/CDN unreachable or transport failed. |

Two extension-local codes (not part of the shared subset): `DIG_ERR_INVALID_URN`,
`DIG_ERR_DIGNODE_REQUIRED`. The friendly human copy is unchanged (the error page still never
leaks crypto strings — see `error-page.mjs`); the code is purely the machine discriminant.

### 3. The injected `window.chia` provider — `dig-provider.js` / `dig-provider-core.mjs`

Besides `isDIG`/`request`/`connect`/`on`/`off`, the provider is self-describing:
`window.chia.version`, `window.chia.info` (`{ isDIG, transport:'walletconnect',
edition:'extension', providerVersion }`), and `window.chia.methods` (the `WALLET_METHODS`
catalogue) — also discoverable at runtime via
`request({ method:'chip0002_getMethods' })` (answered locally). Thrown errors carry the
**standard wallet codes**: `4001` user-rejected, `4100` unauthorized, `4200` unsupported,
`4900` disconnected (replacing the old ad-hoc `-1` / raw-HTTP-status sentinels). This surface
is kept byte-aligned with the native DIG Browser's `window.chia` (see `../../SYSTEM.md`).

## Build

```bash
npm run build         # node build.js  → dist/ (+ dist/agent-surface.json)
npm run build:zip     # same, plus a versioned .zip for distribution
node build.js --json  # machine mode: ONE JSON result on stdout, prose on stderr
```

Build exit codes: `0` success · `2` validation failed (a required source file is missing) ·
`3` a build step failed (vendoring / artifact write).

`build.js` fails if any required file is missing. Load the unpacked extension from
`dist/` via `chrome://extensions` → Developer mode → Load unpacked.

## Tests

```bash
node --test tests/   # pinning tests for the shared URN parser
```
