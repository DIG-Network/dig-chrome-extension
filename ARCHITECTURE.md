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
dist/background.js  ── module service worker ("type":"module"),
  │                     esbuild-bundled from src/background/index.ts
  │  parseURN()            (shared, from src/lib/dig-urn.ts)
  │  retrievalKey()        ┐
  │  verifyInclusion()     │  dig_client.js + dig_client_bg.wasm
  │  deriveKey()           │  (SRI-pinned read-crypto WASM)
  │  decryptChunk()        ┘
  ▼
rpc.dig.net  ── JSON-RPC 2.0 dig.getContent  →  ciphertext + inclusion proof
  ▼
verified + decrypted bytes  →  data: URL  →  returned to the requesting page
```

`src/background/index.ts` is the heart of the extension. `build.js`'s `bundleBackground()`
esbuild-bundles it into `dist/background.js`, loaded as an **ES module service worker**
(`manifest.json` → `background.service_worker` with `"type": "module"`), which is required
because `dig_client.js` is a `wasm-bindgen` ES module that uses `import.meta.url` and cannot
be loaded via `importScripts()`. `./dig_client.js` is kept an EXTERNAL runtime import (never
inlined — the wasm URL + SRI pin depend on it staying a sibling file); everything else the
service worker needs is bundled in. The WASM binary is integrity-checked (SHA-256) against a
pinned digest before any crypto runs — a mismatch fails closed.

## File map (what actually ships)

`build.js` (`node build.js`) builds and assembles these into `dist/`:

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest: module SW, content scripts, permissions, omnibox, web-accessible resources |
| `dist/background.js` ← `src/background/index.ts` | Module service worker, esbuild-bundled by `bundleBackground()` — URN parse, RPC fetch, WASM verify + decrypt, caching. `src/background/app-sign-handlers.ts` holds the AppSign-pairing message handlers. |
| `src/lib/dig-urn.ts` | **Shared** URN parser + base36 store-id helpers (single source of truth), pinned by `src/lib/dig-urn-codec.test.ts` |
| `src/lib/*` (dig-loader, dig-node-*, dig-dns*, dig-control, dig-ledger, dig-cache, dig-pairing, dig-serve-headers, apps, dexie, autoTip, download, activity-log, clipboard, custody-session, dapp-approval, …) | The extension's TypeScript logic layer — one focused module per concern, each with a co-located `*.test.ts`. `dig-control.ts` is the **DIG Control Panel** decision logic (the `dig://control` parity surface, byte-consistent with the dig-node control RPC contract); `dig-ledger.ts` is the **DIG Shields per-resource proof ledger** (#134), a byte-mirror of the native browser's `dig/shields/dig_ledger.mjs`. |
| `src/offscreen/*` | The offscreen-document wallet vault — coin selection/control, signing, sends, NFTs/DIDs, CAT issuance/discovery, options/clawback, real-WASM chain calls — each module with a co-located test |
| `src/api/*`, `src/app/*`, `src/features/*` | Redux Toolkit + RTK Query store (`src/app/store.ts`), the app shell (`AppHeader`/`AppFooter`/`ActiveTabPanel`/routing/theme), and the feature-sliced UI (wallet, security, toolbar, control, …) per the `react-app-architecture` skill (§6.4) |
| `dig-provider-core.ts` / `wallet-methods` re-exports | Thin re-exports of the canonical **`@dignetwork/chia-provider`** package (the single source of truth for the `window.chia` surface, shared byte-for-byte with the native DIG Browser). Kept as import points so the SW/UI/agent-surface/tests import them unchanged. |
| `src/entries/dig-provider.entry.ts` → `dist/dig-provider.js` | The MAIN-world injected provider: `build.js`'s `bundleProvider()` esbuild-bundles this entry (which wraps the package's `buildProvider` with the extension's postMessage transport) into a self-contained IIFE. NOT a hand-copied surface. |
| `src/agent-surface.ts` → `dist/agent-surface.json` | Machine-readable self-description (actions + wallet methods + error codes + provider surface) generated at build time by `generateAgentSurface()` from the modules above. |
| `dig_client.js` + `dig_client_bg.wasm` | SRI-pinned read-crypto WASM (`retrievalKey`, `deriveKey`, `verifyInclusion`, `decryptChunk`). **Do not edit** — it is the byte-identical cross-system crypto artifact (see `../../SYSTEM.md`). Kept as an external runtime import by `bundleBackground()` (never inlined). |
| `src/content/content.ts` → `dist/content.js` | Content script — rewrites `chia://` resource references (img/script/link/srcset/etc.) on every page |
| `src/content/middleware.ts` → `dist/middleware.js` | Content script — fallback-strategy ordering for resolving `chia://` requests |
| `src/content/page-script.ts` → `dist/page-script.js` | Injected into the page (main world) to intercept `chia://` before the browser fetches it |
| `src/entries/store-interceptor.entry.ts` → `dist/store-interceptor.js` | Self-contained IIFE (esbuild-bundled by `bundleStoreInterceptor()`) loaded as an external same-origin script by the sandboxed `dig-store-frame.html` |
| `popup.html` + `app.html` (React shell, `src/entries/popup.tsx` / `app.tsx`) | Toolbar popup + full-page wallet — the React/TypeScript shell built by `vite build` (Wallet · Shield · Control Panel · Apps, mobile-OS layout), copied into `dist/` by `buildWebApp()`. Owns the wallet, the DIG Shields proof-ledger, the Control Panel, open-`chia://`, the resolution toggle, and ecosystem funnels. |
| `dig-viewer.html` / `src/entries/dig-viewer.ts` | Standalone viewer iframe (Vite-built) that fetches + embeds DIG content via the SW |
| `src/icons/icon-{16,32,48,128}.png` | The DIG Mark manifest icon set (#153) — one crisp file per size (toolbar `action.default_icon` + extension-management/store-listing `icons`), sourced from the canonical DIG icon set (dig-browser's `dig/branding/product_logo_*.png`). Every shipped extension page also links `src/icons/icon-32.png` as its `<link rel="icon">` tab favicon. |
| `src/favicon.png`, `src/logo.png` | Notification/omnibox icon (regenerated crisp from the same DIG Mark, #153) + popup logo |

The Node test server in `server/` and the root `stub-server.js`
are **development-only** and are not part of the shipped extension. The dev server
imports the URN parser (via dynamic `import()`, since it runs as CommonJS) so it
shares the exact same implementation as the extension.

## Shared URN parser (`src/lib/dig-urn.ts`)

There is exactly **one** `parseURN` implementation, in `src/lib/dig-urn.ts`. It accepts the
union of inputs every caller passes — a `chia://` scheme prefix, leading slashes, the
`urn:dig:` prefix, and an optional `?salt=<hex>` private-store param — and returns
`{ chain, storeId, roothash, resourceKey, salt }`. The module service worker bundle imports
it directly; the dev server imports it via dynamic `import()`. The parser is pinned by
`src/lib/dig-urn-codec.test.ts` (`npm run test:web`).

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

### 1. The background MESSAGE protocol — `src/lib/messages.ts`

Every `chrome.runtime` `message.action` the service worker handles is enumerated in the
frozen `ACTIONS` enum, documented in `MESSAGE_CATALOGUE` (one entry per action with a
`summary` + request/response field shapes), and versioned by `MESSAGE_PROTOCOL_VERSION`.
Consumers import `ACTIONS.proxyRequest` instead of the raw string. The
`getCapabilities` action returns the whole self-description
(`{ version, messageProtocol, actions, walletMethods, stateChangingMethods, errorCodes, bridge }`).
The page↔extension provider bridge is `BRIDGE.WALLET_REQUEST` / `BRIDGE.WALLET_RESPONSE`
(window.postMessage). `src/lib/messages.test.ts` fails if a handler is added without a
catalogue entry (drift guard).

### 2. chia:// loader error codes — `src/lib/error-codes.ts`

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
leaks crypto strings — see `src/lib/error-page.ts`); the code is purely the machine discriminant.

### 3. The injected `window.chia` provider — `@dignetwork/chia-provider`

The injected `window.chia` is BUILT FROM the shared **`@dignetwork/chia-provider`** package —
the single source of truth for the DIG provider contract, consumed identically by the native DIG
Browser and this extension so the two can never drift. `build.js` esbuild-bundles
`dig-provider.entry.mjs` (which wraps the package's `buildProvider` with the extension's
`window.postMessage` → content-script → background-SW transport, which routes to the self-custody
wallet — the offscreen vault + the SW-summoned approval window; no WalletConnect) into
`dist/dig-provider.js` as a self-contained MAIN-world IIFE.

The surface is a Goby/CHIP-0002/Sage-WC2 superset: besides `isDIG`/`request`/`connect`/`on`/`off`
it advertises `isGoby`, Goby-legacy direct methods (`transfer`, `createOffer`, `getPublicKeys`, …),
`requestAccounts`/`accounts`, `walletSwitchChain` (mainnet-only), a callable `isConnected()`, and is
self-describing: `window.chia.version`, `window.chia.info`
(`{ isDIG, transport:'walletconnect', edition:'extension', providerVersion }`), and
`window.chia.methods` (the `WALLET_METHODS` catalogue) — also discoverable via
`request({ method:'chip0002_getMethods' })` (answered locally). Thrown errors carry the
**standard wallet codes**: `4001` user-rejected, `4100` unauthorized, `4200` unsupported,
`4900` disconnected. See the package `SPEC.md` for the normative contract.

## Build

```bash
npm run build         # node build.js  → dist/ (+ dist/agent-surface.json)
npm run build:zip     # same, plus a versioned .zip for distribution
npm run build:store   # node build.js --store  → CWS-mode dist/ (key/update_url stripped)
node build.js --json  # machine mode: ONE JSON result on stdout, prose on stderr
```

`build.js` orchestrates the whole pipeline: `bundleBackground()` (the module service worker),
`bundleContentScript()`/`bundlePageScript()` (the three content-script-layer entries),
`bundleProvider()` (the injected `window.chia`), `bundleStoreInterceptor()`, `generateAgentSurface()`,
then `buildWebApp()` (`vite build` for the popup/full-page/viewer React surfaces) copies its
`dist-web/` output into `dist/`. Build exit codes: `0` success · `2` validation failed (a required
source file is missing) · `3` a build step failed (bundling / artifact write).

`build.js` fails if any required file is missing. Load the unpacked extension from
`dist/` via `chrome://extensions` → Developer mode → Load unpacked.

## Tests

```bash
npm run test:node      # node --test tests/            — repo-shape/build/manifest/wiring tests
npm run test:web       # vitest run --coverage          — the TS logic + React suite, gated at >=80%
npm run test:coverage  # npm run test:node && npm run test:web — the full gate (both suites)
```

The `test:web` (vitest) suite pins every shared-module contract (URN parser, message protocol,
error codes, wallet surface, node resolution, shields ledger, control panel) via each module's
co-located `*.test.ts`, plus the React/Redux UI (`@testing-library/react`). Coverage is measured
by vitest's V8 provider over `src/**` and CI-gated at >=80% on lines, branches, functions, and
statements — a run below the floor fails the build. `test:node` covers repo-shape checks that
don't need a DOM (manifest wiring, icon/branding consistency, release-workflow shape, supply
chain). CI (`deploy.yml` + `publish-chrome-web-store.yml`) runs `npm run test:coverage`.

The repo's normative contract lives in [`SPEC.md`](./SPEC.md) — the authoritative,
implementation-independent spec for the `chia://` read path + `dig.getContent` wire, the
internal message protocol, the loader error taxonomy, the `window.chia` provider, the
node-resolution ladder, configuration, and the security invariants. `src/test/spec-consistency.test.ts`
guards SPEC.md against drift from the code.
