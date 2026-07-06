# DIG Network Browser Extension — SPEC

Normative specification for the DIG Network browser extension (Chromium Manifest V3). This is
the authoritative contract an independent reimplementation can be built against. It defines the
extension's public surfaces — the `chia://` read path and its wire calls, the internal
`chrome.runtime` message protocol, the injected `window.chia` provider, the loader error
taxonomy, the node-resolution ladder, configuration, and the security invariants — with
byte-level detail where a surface is a cross-system contract.

Key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are used per RFC 2119.

Cross-system contracts referenced here (the URN scheme, the retrieval key, the crypto tags, the
`dig.getContent` JSON-RPC shape, the canonical `dig-loader` error subset, and the
`@dignetwork/chia-provider` surface) are shared with the hub, digstore, the dig-node, and the
native DIG Browser. Where this SPEC and those shared definitions disagree, the shared definition
governs and this SPEC is the defect.

---

## 1. Purpose & scope

The extension delivers the DIG Network experience on any Chromium browser:

1. **`chia://` resolution** — intercept `chia://` URIs and page-embedded `chia://` resource
   references, resolve them to verified + decrypted bytes, and hand them to the page.
2. **`window.chia` wallet provider** — inject a CHIP-0002 / Goby-compatible provider backed by the
   extension's own **self-custody wallet** (§18): connect + reads are served from the offscreen key
   vault; sign/message requests are approved in a dedicated window. There is no WalletConnect.
3. **DIG Shields** — a per-resource inclusion-proof ledger surfaced in the popup.
4. **DIG Control Panel** — detect a local dig-node and expose manage-vs-install actions.
5. **DIG Home / omnibox / search** — a new-tab surface and a `dig`-keyword omnibox.

The primary surface is a **dark-themed 4-tab popup** (§2.1): **Resolver · Wallet · Shield ·
Control Panel** (§2.1). It carries an **Explore DIG Network** action → `explore.dig.net`, a
bug-report funnel → `bugreport.dig.net` (repo + version scoped), and exposes the extension's
version in three forms for build attribution (§2.2).

All content verification and decryption happen **client-side**. The extension is a **pure
RPC-consumer read client** in the DIG ecosystem: it does not write stores, spend on-chain, run
P2P/DHT/gossip/sync, or cache resolved content. The client-side verify+decrypt path (§5, §6) is
the trustless read tier and is NOT a node responsibility — every implementation that reads DIG
content this way (this extension, the native DIG Browser, the hub, digstore) verifies and
decrypts locally against blind ciphertext the node serves; the node never needs to be trusted.

Out of scope (dig-node responsibilities this extension MUST NOT reimplement): on-chain spends
(the hub owns those), P2P/DHT/gossip/peer discovery, chain-watch/subscriptions, serving content
to peers, and **caching resolved/decrypted content** — every read re-fetches, re-verifies, and
re-decrypts (§15).

---

## 2. Runtime model & platform requirements

- The extension is **Manifest V3** (`manifest.json` → `"manifest_version": 3`).
- The background context is an **ES-module service worker**: `background.service_worker`
  with `"type": "module"`. This is REQUIRED — the read-crypto WASM (`dig_client.js`) is a
  `wasm-bindgen` ES module using `import.meta.url` and MUST NOT be loaded via
  `importScripts()`.
- `content_security_policy.extension_pages` MUST permit `'wasm-unsafe-eval'` (WASM
  instantiation) and MUST restrict `script-src`/`object-src` to `'self'`. It MUST additionally
  declare an explicit `connect-src` enumerating every network egress (the chain host(s)
  `rpc.dig.net`/`*.dig.net`/`coinset.org`, the CAT-price host `api.dexie.space`, and
  `api.bugreport.dig.net`), `frame-src 'self' https:` (the in-window
  dApp app-view frames curated store `link`s over https, §2.4a), `font-src 'self'` (the vendored Space
  Grotesk / Space Mono woff2), and `img-src 'self' data: https://explore.dig.net` (the native
  dApp-launcher icons, §2.4).
- Content scripts (`middleware.js`, then `content.js`) run at `document_start`,
  `all_frames: true`, matching `<all_urls>`.
- The injected provider (`dist/dig-provider.js`) and the page fetch bridge (`page-script.js`)
  are `web_accessible_resources` injected into the page's MAIN world.
- Required permissions: `storage`, `webNavigation`, `tabs`, `declarativeNetRequest`,
  `scripting`, `omnibox`, `search`, `notifications`, `offscreen`, `idle`, `alarms` (the last three
  power the self-custody offscreen-document key custody, `chrome.idle` auto-lock, and the
  `chrome.alarms` unlock-TTL sweep — §18.3). Host permissions
  MUST include the local node hosts (`localhost`, `127.0.0.1`, `dig.local`, `*.dig.local`), the
  hosted read tier (`rpc.dig.net`, `*.dig.net`), the wallet chain source (`coinset.org`), the
  CAT-price host (`api.dexie.space`), the bug-report service (`api.bugreport.dig.net`), and the
  dApp-store catalog host (`explore.dig.net`, §2.4).

An implementation targeting a browser without MV3 module service workers MUST provide an
equivalent long-lived module context able to instantiate WASM.

### 2.1 UI shell — one React app, two surfaces, a mobile-OS (#65)

The UI is a **single React + TypeScript application** (`src/`) mounted by **two HTML entry
points**, built by Vite into `dist-web/` and copied into `dist/` (§13), presented as a **mobile OS**:

- **`popup.html`** → `App surface="popup"` — a **compact phone**: a status-bar-feel header, ONE
  scrolling content area, and a **STICKY phone bottom nav** pinned to the viewport bottom (only the
  content scrolls; the nav is always visible; the scroll area reserves bottom padding = nav height +
  `env(safe-area-inset-bottom)`). A soft DIG violet→magenta ambient wallpaper sits behind the chrome;
  switching screens plays a mobile-OS app-open transition.
- **`app.html`** → `App surface="fullpage"` — a **tablet/desktop-OS**: the SAME app + route tree in
  the expanded sidebar-rail layout at ≥960px (a wider multi-column widget board), degrading to the
  compact phone in a narrow window (`useLayoutMode`).

The nav is an **ARIA `tablist` of four screens** (`src/app/tabs.ts` is the source of truth for the
set, order, default, and hash deep-link) following the Fable **Home · Wallet · Apps · Network**
grouping; the **default landing is Home**. Every surface stays reachable:

0. **Home** (default landing) — the mobile-OS launcher above the nav: a glanceable wallet-balance
   widget (→ Wallet), Send · Receive · Trade quick-action tiles (→ the wallet on the right sub-view),
   the native dApp launcher grid (§2.4, first N + "see all" → Apps), and status widgets (lock state,
   local-node/gateway status → Network, a recent-activity peek → the ledger). Four states drive the
   launcher; the wallet widgets degrade gracefully when the wallet is locked/absent.
1. **Wallet** — the **self-custody wallet** (§18) and the ONLY wallet path: the extension holds its
   own key, so there is no WalletConnect/Sage pairing. The `CustodyGate` lands first on the SW's
   authoritative lock state — no wallet → onboarding (create / import a 24-word phrase), locked →
   unlock, unlocked → the custody wallet body, a segmented control over:
   - **Assets** — portfolio hero (the XCH balance + an honest "fiat unavailable" `≈ $—`; no
     fabricated fiat/delta), a Send · Receive · Trade action bar, and the assets list (XCH + `$DIG` +
     each tracked CAT) from the offscreen HD balance scan (`getCustodyBalances`, both HD schemes).
     Send/Receive open shared modals; tracked CATs persist in `chrome.storage.local`
     `wallet.watchedCats` (`wallet-assets.mjs`).
   - **Activity** — the transaction ledger reconstructed from chain by the offscreen indexer
     (`getActivity`; §18.9).
   - **Trade** — make / take / cancel a `offer1…` string, built + signed in the offscreen vault
     (`makeOffer` / `inspectOffer` / `prepareTrade` / `confirmTrade`; §18.10).
   - **Collectibles** — the wallet's NFTs, discovered + transferred via the vault (§18.11).
   Key custody, signing, and coin selection all happen in the offscreen vault — the decrypted key
   never leaves it (§18); a custom node/RPC endpoint is configured on the options page (§8.3).
2. **Apps** (§2.4) — the curated DIG dApp store as a native in-extension launcher.
3. **Network** — the Fable grouping that hosts the three ambient/pull-on-failure surfaces behind one
   nav item via a `Resolver | Shield | Node` segmented sub-control (`ui.networkView`):
   - **Resolver** — open a `chia://` address, an on/off resolution toggle, the §5.3 "Resolving via"
     verdict (`resolve-status.mjs` over the `getDigNodeStatus` probe: custom > `dig.local` >
     `localhost` > `rpc.dig.net`), and a custom-node override that persists to `server.host`.
   - **Shield** — the active tab's verification verdict + per-resource proof ledger (§10),
     `getShieldLedger` → `dig-ledger.mjs` grouping.
   - **Node** (control) — manage a detected local dig-node, else pitch installing one
     (`getControlStatus` → `dig-control.mjs`); full token-gated management deep-links to the DIG
     Browser (§11).

- Each tab is a `role="tab"` with `aria-selected` + a roving `tabindex` and a stable `data-testid`
  (`tab-<name>`, where name ∈ `home|wallet|apps|network`); the active screen's content is a
  `role="tabpanel"`, rendered with `key={tab}` so the app-open transition replays on switch.
- A `#<tab>` / `#wallet/<view>` / `#network/<view>` location hash deep-links the opening screen + its
  sub-view. **Legacy `#resolver`/`#shield`/`#control` deep-links still resolve** (→ the Network
  screen on that sub-view) for back-compat with the pop-out + external links. The route is kept in
  sync with the hash so **⤢ pop-out** (`popup` surface only) opens `app.html` carrying the current
  route (singleton — an existing tab is focused, not duplicated).
- Every async surface renders the four states (loading / error / empty / success — `FourState`);
  all copy flows through **react-intl** (`src/i18n`, the 14-locale ecosystem set; Phase 0 ships a
  complete `en` catalog with the others falling back to English); a footer language selector
  persists the choice to `wallet.settings.locale`.

### 2.2 State & data architecture

- **Redux Toolkit + RTK Query**, one store per document (`src/app/store.ts`). The single `api`
  slice (`src/api/api.ts`) owns all chain/custody reads/writes with tag-based cache invalidation.
- **`chromeBaseQuery`** (`src/api/baseQuery.ts`) is the service-worker seam: it speaks
  `chrome.runtime.sendMessage` (a `messages.mjs` ACTIONS envelope) instead of `fetch`, so the
  background SW stays the authority for every endpoint — resolver/shield/control AND the self-custody
  wallet (`custodyApi`, which routes to the offscreen key vault). There is no page-resident wallet
  transport (no WalletConnect); the store injects no transport.
- **Cross-document convergence** (§3.4 of the design): durable client state lives in
  `chrome.storage.local`; a `chrome.storage.onChanged` → store bridge (`src/app/storageSync.ts`)
  re-hydrates settings and turns a connection change or a `walletCache.epoch.<tag>` bump into an
  RTK Query `invalidateTags`, so the popup + `app.html` converge. The SW-authoritative read cache
  is the pure `sw-cache.mjs` mechanism (bounded epoch-aware LRU; wired into the SW in a later phase).

### 2.3 App version exposure (§6.7)

Every entry MUST surface the extension version (from `package.json`, injected at build time in
place of the `__APP_VERSION__` placeholder — in the HTML `<meta>` by `build.js`, in the JS bundle
by Vite `define`) in three forms: a visible footer (`data-testid="app-version"`, `vX.Y.Z`), a
`<meta name="app-version">` tag, and the `window.__APP_VERSION__` global. The embedded
`<BugReportButton repo="dig-chrome-extension">` auto-detects it so a report records its build.

### 2.4 Apps tab — native dApp launcher (#65)

The Apps tab is the extension's OWN native launcher for the curated DIG dApp store — NOT an iframe.
It fetches explore.dig.net's public catalog manifest `https://explore.dig.net/store.json` (the
normative contract in explore's SPEC §5.1 + the superproject `SYSTEM.md`; CORS `*`) directly (the
host is in `connect-src` + `host_permissions`), normalizes it (validate + featured-first order), and
renders a mobile-OS icon grid: a squircle icon per app (`icon`, an absolute URL — hence
`img-src https://explore.dig.net`), the `name` as its label, tinted by the app's `accentColor`, and
tapping a tile opens the app's absolute `link` in a new tab. The manifest is cached in
`chrome.storage.local` (`appsCache.store`) for **stale-while-revalidate**: a network success refreshes
the cache and renders fresh; a failure falls back to the cached catalog (flagged offline) so the
launcher still paints and works offline. The tab renders four states (loading skeleton grid / error +
retry / empty / success) and always offers a "browse the full store" affordance to `explore.dig.net`.

The `/store.json` entry shape is `{ slug, name, icon, link, category, featured, accentColor? }` with
`icon` + `link` absolute https URLs; featured entries come first. Entries missing a slug/name or a
valid absolute icon/link are dropped defensively.

### 2.4a In-window dApp app-view (#65)

Tapping a launcher icon (on the Apps screen OR the Home launcher widget) LAUNCHES the dApp INSIDE the
extension frame like a phone app (`ui.openApp`), rather than opening a new tab. `AppView` is a
full-surface overlay (over either layout) with an app-open transition and a top bar: **back** (→ the
launcher), the app name, and **⤢ expand** (promote the dApp to a full browser tab via
`chrome.tabs.create`). The dApp's `link` is framed in a sandboxed `<iframe>`
(`allow-scripts allow-forms allow-popups allow-modals allow-same-origin allow-downloads`); the CSP
allows `frame-src 'self' https:` (the app-view only ever frames curated store links). `Escape` closes it.

It renders THREE states, and NEVER leaves a blank frame:
- **loading** — a spinner over the frame until the frame's `load` fires or a timeout elapses;
- **ready** — the framed dApp;
- **blocked** — a refused/unreachable embed. Detection: an `error` event, a no-`load` timeout, or a
  `load` that resolves to a readable `about:blank` (a refused frame that never committed). On blocked,
  the dApp is **gracefully opened in a new tab** with a one-line note + an explicit "open in a new
  tab" button. NOTE: an `X-Frame-Options`/`frame-ancestors` refusal that fires `load` on a cross-origin
  error document is INDISTINGUISHABLE from success in pure JS (both fire `load` and throw on
  cross-origin access); for that case the browser shows its own "refused to connect" page inside the
  frame and the always-present ⤢ expand / back give the user an escape.

### 2.4b Inline bug-report entry (#65)

The shared `@dignetwork/components` `<BugReportButton>` (the full reporting flow — challenge/honeypot/
timing anti-spam + screenshot + console/network capture, filing to `api.bugreport.dig.net` against
`repo="dig-chrome-extension"`) is surfaced as a **quiet inline "Report a bug" item in the footer**, not
a floating overlay: the component's floating launcher FAB is hidden (`.digbr-launcher { display:none }`)
and the inline item opens the same panel by programmatically clicking the (still-mounted) launcher.

---

## 3. Identifiers & terminology

- **Store** — a mutable DIG datastore identified by a 64-hex `storeId` (a Chia singleton
  launcher id). A store is a sequence of immutable generations (commits).
- **Capsule** — one immutable store generation, the pair `(storeId, rootHash)`, written
  `storeId:rootHash`. This is the canonical ecosystem term. A **rooted** URN pins a specific
  capsule; a **rootless** URN references the store's **latest** capsule.
- **`rootHash`** — a 64-hex commit/generation root.
- **`resourceKey`** — the path of a resource inside a capsule (e.g. `index.html`,
  `assets/app.js`); empty means the capsule root. When resolving content, an empty
  `resourceKey` defaults to `index.html`.
- **retrieval key** — `SHA-256(canonical rootless URN)`, hex. Computed by the WASM
  (`retrievalKey(storeId, resourceKey)`); it is the wire key a node is queried by, and it is
  identical across all DIG implementations.
- **`salt`** — an optional lowercase-hex private-store salt supplied as `?salt=<hex>`; `null`
  means a public store.

---

## 4. URN grammar (`dig-urn.mjs`)

There MUST be exactly one URN parser (`parseURN`) in the extension; no call site may inline a
second copy.

### 4.1 Canonical form

```
urn:dig:<chain>:<storeID>[:<rootHash>][/<resourceKey>][?salt=<hex>]
```

- `<chain>` — lowercase network name; defaults to `chia` when absent.
- `<storeID>`, `<rootHash>` — exactly 64 hex characters; normalized to lowercase.
- `<resourceKey>` — everything after the first `/`; MAY be empty.
- `?salt=<hex>` — optional; lowercased; stripped from the path before component parsing.

### 4.2 Accepted inputs

`parseURN(input)` MUST accept the union of forms callers pass and normalize them:

1. A `chia://` scheme prefix (stripped, case-insensitive).
2. Leading slashes (stripped).
3. A `urn:dig:` prefix (stripped, case-insensitive).
4. A bare `<chain>:<storeID>[:<rootHash>][/<resourceKey>]`.
5. A chainless `<storeID>[:<rootHash>][/<resourceKey>]` (chain defaults to `chia`).
6. Any of the above with a `?salt=<hex>` query param.

### 4.3 Result

`parseURN` returns `null` for unparseable input, otherwise:

```
{ chain: string, storeId: string, roothash: string|null, resourceKey: string, salt: string|null }
```

`storeId`, `roothash`, `salt`, `chain` are lowercased. `roothash === null` denotes the latest
capsule. `salt` is ALWAYS present in the result object (value `null` when absent).

### 4.4 Base36 store-id codec & host mapping

- `encodeStoreId(hex64)` / `decodeStoreId(base36)` map a 64-hex store id to/from base36 (≤ 50
  chars) for use in subdomain labels. `encodeStoreId` MUST reject any input not matching
  `^[a-f0-9]{64}$`.
- `resolveHostToURN(hostname, pathname)` maps a local-node host to a URN. Base domains are
  `dig.local`, `localhost`, `127.0.0.1`. Subdomain forms:
  - `<encStoreId>.<base>/<resourceKey>` → latest capsule.
  - `<encStoreId>.<encRootHash>.<base>/<resourceKey>` → specific capsule.
  - the bare base with a `/urn:dig:…` or `/<hex64>[/<resourceKey>]` path.
- `urnToContentServerUrl(urn, {host, port})` is the inverse: it renders a base36 subdomain
  URL, omitting the port when it is 80.

---

## 5. Content read path

The primary read is `chrome.runtime` action `proxyRequest` (§7). Given a `chia://` URL the
service worker MUST execute, in order:

1. `parseURN` the URL; a `null` result is `DIG_ERR_INVALID_URN`.
2. Select the capsule: `root = roothash || 'latest'`; `resourceKey = resourceKey || 'index.html'`.
3. Load + SRI-verify the WASM (§6). A digest mismatch fails closed.
4. Resolve the RPC endpoint (§8).
5. `retrieval_key = retrievalKey(storeId, resourceKey)`.
6. Fetch ciphertext via chunked `dig.getContent` (§5.1).
7. `verifyInclusion(ciphertext, proof, root)` — non-throwing; a decoy/false verdict yields
   `verified: false` but MUST NOT throw.
8. `deriveKey(storeId, resourceKey, salt)`.
9. Decrypt (§5.2). A GCM-SIV tag failure means decoy/wrong-key and surfaces
   `DIG_ERR_DECRYPT_TAG`.
10. Encode decrypted bytes to a `data:<contentType>;base64,…` URL (content type inferred from
    `resourceKey`) and return.

### 5.1 `dig.getContent` JSON-RPC wire

Requests are JSON-RPC 2.0 `POST` to the resolved endpoint:

```json
{ "jsonrpc": "2.0", "id": 1, "method": "dig.getContent",
  "params": { "store_id": "<hex64>", "root": "<hex64|latest>",
              "retrieval_key": "<hex64>", "offset": <int>, "length": <int> } }
```

The reader fetches in windows of at most **3 MiB** (`length`). The result object provides:

| Field | Meaning |
|---|---|
| `total_length` | total ciphertext length in bytes (present on the first window) |
| `ciphertext` | base64 of this window's ciphertext bytes |
| `offset` | the byte offset this window's bytes belong at |
| `chunk_lens` | array of per-chunk CIPHERTEXT byte lengths (present on the first window) |
| `inclusion_proof` | the merkle inclusion proof for the capsule root |
| `complete` / `next_offset` | loop control: stop when `complete` is truthy or `next_offset` is null |

The reader reassembles windows into a single buffer of `total_length` and passes
`chunk_lens` to the decryptor.

### 5.2 Multi-chunk decryption

- `chunk_lens` are per-chunk CIPHERTEXT lengths. A single-chunk resource (empty/1-element
  `chunk_lens`) decrypts in one `decryptChunk` call.
- For multiple chunks, the sum of `chunk_lens` MUST equal the ciphertext length; a mismatch is
  a proof/integrity failure (`DIG_ERR_PROOF_MISMATCH`). Each chunk is decrypted independently
  and the plaintext concatenated in order.

### 5.3 Store rendering & relative-reference resolution (in-page interceptor)

When the loader renders an HTML document from a store, that document's relative links and asset
references (`./style.css`, `/img/x.png`, a relative `<a href>`, a relative `fetch()`/XHR) MUST
resolve back to reads of the SAME capsule through the node — never against the (opaque) frame
origin, which would break them. This mirrors the `*.on.dig.net` loader's service-worker request
interception; because MV3 cannot register a page service worker onto the rendered document, the
extension uses an equivalent IN-PAGE interceptor (parity with the on.dig.net loader's Tier-2
in-page path):

1. The viewer reads the entry URN from its `?urn=` query parameter and MUST fully URL-decode it
   (decode percent-escapes until stable — a valid URN has no literal `%`), because some navigation
   paths encode the `chia://` URL more than once and `URLSearchParams` decodes only once; a
   still-encoded value would fail `parseURN` and never load. It then renders store HTML inside a
   SANDBOXED, opaque-origin `data:` frame (isolated from the extension — the frame has no `chrome.*`
   access and holds no keys) that boots the interceptor with the entry capsule config
   `{ storeId, root, salt, entryKey }`.
2. The interceptor patches `window.fetch` + `XMLHttpRequest` and rewrites DOM `src`/`href` on
   injection and on mutation. Each reference is classified as:
   - a **relative** ref — resolved against the CURRENT document's resource key into the same
     capsule (a root-absolute `/x` resolves against the store root; `./x`/`../x` against the
     current document's directory), so a multi-page store's per-page relative assets resolve
     correctly;
   - an absolute **`chia://`/`urn:dig:chia:`** ref — read as given (a rootless/saltless ref
     inherits the current capsule's root/salt);
   - **external** (http(s)/protocol-relative/`data:`/`mailto:`/in-page `#anchor`) — left untouched.
3. Each resolved DIG reference is read via a `read` request to the parent viewer, which serves it
   through the standard `proxyRequest` (§5, §8 ladder + verify + decrypt) and replies with a
   `data:` URL. The interceptor holds NO keys and runs NO crypto — the single decrypt path stays
   in the background service worker.
4. A relative `<a>` navigation is intercepted (a native navigation would escape the interceptor)
   and the target document is swapped in-page; the current resource key updates so subsequent
   relative references resolve against the new document.

The reference→`chia://` mapping is normative and shared (`store-refs.mjs`): a resolved reference is
emitted CHAIN-PREFIXED as `chia://chia:<storeId>[:<root>]/<resourceKey>[?salt=<hex>]` (a `latest`
root is emitted rootless), which `parseURN` (§4) parses to the correct `{ storeId, roothash }` — a
bare `chia://<storeId>:<root>/…` would be mis-parsed (the storeId taken as the chain).

---

## 6. Crypto & verification invariants

- The read-crypto is the SRI-pinned WASM artifact `dig_client_bg.wasm` (+ `dig_client.js`
  bindings), byte-identical to the artifact the hub and digstore use. It MUST NOT be edited
  in this repo.
- Before ANY crypto runs, the WASM bytes MUST be hashed (`SHA-256`) and compared to the pinned
  digest `DIG_CLIENT_WASM_SHA256`. A mismatch MUST throw and refuse to run unverified crypto
  (fail-closed). The pin MUST equal the hub/digstore pin.
- The WASM exposes `retrievalKey`, `deriveKey`, `verifyInclusion`, `decryptChunk`. Content is
  AES-256-GCM-SIV; a tag failure is indistinguishable from a decoy and MUST surface as
  `DIG_ERR_DECRYPT_TAG`, never as verified content.
- `verified` (merkle inclusion against the on-chain root) is reported truthfully. A failed or
  absent proof MUST NOT be rendered as verified.

---

## 7. Internal message protocol (`messages.mjs`)

Every `chrome.runtime` `message.action` the service worker handles is enumerated in the frozen
`ACTIONS` object, documented in `MESSAGE_CATALOGUE`, and versioned by
`MESSAGE_PROTOCOL_VERSION` (currently `13`). Consumers MUST reference `ACTIONS.<name>` rather
than raw strings. Adding a handler without a catalogue entry is a contract violation (guarded
by `messages.test.mjs`).

`MESSAGE_PROTOCOL_VERSION` `3` (#56) added the self-custody actions — `createWallet`,
`importWallet`, `unlockWallet`, `lockWallet`, `revealPhrase`, `getLockState` — which the SW routes
to the offscreen keystore vault (§18.3), plus the `OFFSCREEN_TARGET` discriminator on the
SW→offscreen messages (those messages are handled by the offscreen document; the SW's own
`onMessage` listener ignores them). `4` (#56) added `getReceiveAddress` + `getCustodyBalances`
(§18.6): the SW forwards them to the offscreen vault, which derives and scans coinset. `5` (#56)
added `prepareSend` (build + decode summary), `confirmSend` (sign + broadcast — the approved step),
and `sendStatus` (poll confirmation) (§18.8). `6` (#56) added `getActivity` (§18.9): the SW routes
it to the offscreen vault, which reconstructs the transaction ledger from coinset. `7` (#56) added the
trade-offer actions — `makeOffer`, `inspectOffer`, `prepareTrade`, `confirmTrade` (§18.10). `8` (#56)
added the NFT / Collectibles actions — `listNfts`, `prepareNftTransfer`, `confirmNftTransfer` (§18.11).
`9` (#56 §5.5) made `walletRpc` route to the self-custody wallet when one exists (connect + reads → the
offscreen vault; sign/message → the approval window) and added the approval-window channel
`dappApprovalList` + `dappApprovalResolve` (§18.12). `10` (#66) added `appViewFraming` — install/remove
the in-window app-view framing bypass (§9.1). `11` (#67 P0-4) had `walletRpc` also answer the
EIP-2255-shaped permission methods (`wallet_getPermissions` / `wallet_revokePermissions`) from the
shared per-origin consent store, and added the Connected-sites actions `listConnectedSites`,
`revokeConnectedSite`, `revokeAllConnectedSites` (§18.12). `13` (#119) had `walletRpc` route the
asset-generic reads (`getAssetBalance`, `getAssetCoins`, `filterUnlockedCoins`, `getNFTs`) and the
value-moving writes (`chia_send`/`transfer`, `sendTransaction`, `createOffer`, `takeOffer`,
`cancelOffer`) to the vault instead of the `4004` stub — writes join the approval-window queue
(§18.12) — and made a user reject surface as CHIP-0002 `4002`.

`MESSAGE_PROTOCOL_VERSION` MUST be bumped on any breaking change to the action set or a DTO
shape.

### 9.1 In-window app-view framing bypass (`*.on.dig.net`)

The extension's in-window app-view embeds a launched DIG dApp in an iframe. DIG's own subdomain
resolver `*.on.dig.net` serves `X-Frame-Options: DENY` + CSP `frame-ancestors 'none'` (clickjacking
protection for the arbitrary user content it hosts), which would refuse that embed and force the dApp
into a browser tab. To render it in-window WITHOUT weakening on.dig.net's protection against other
embedders, the app-view uses a **declarativeNetRequest `modifyHeaders` session rule** that removes the
`X-Frame-Options` and `Content-Security-Policy` response headers, scoped as tightly as DNR allows and
installed EPHEMERALLY:

- `requestDomains: ['on.dig.net']` — DIG's own resolver content only (subdomains included);
- `resourceTypes: ['sub_frame']` — iframe embeds only, never a top-level navigation;
- `tabIds: [<app-view tab>]` when the app-view runs in a tab (the expanded layout), pinning the strip
  to that one tab; the popup app-view (no tab id) is domain + sub-frame scoped.

The rule (session rule id `2`; id `1` is the legacy dig.local cleanup rule) is added via the
`appViewFraming` action when the app-view opens an on.dig.net dApp and REMOVED the moment it closes,
so at all other times on.dig.net keeps full framing protection against every embedder. Non-DIG dApps
are embedded unchanged (iframe, with a graceful open-in-tab fallback when they refuse framing). The
fix is entirely extension-side — on.dig.net's headers are not modified.

### 7.1 Actions (summary)

| Action | Purpose |
|---|---|
| `proxyRequest` | Resolve a `chia://` URL to verified, decrypted content (primary read, no caching). |
| `convertDigUrl` | Resolve a `chia://` URL to a `data:` URL (one-shot, no caching). |
| `navigateToDigUrl` | Open a `chia://` URL in the dig-viewer for the sender/active tab. |
| `navigate` | Navigate the active tab to a URL. |
| `toggleExtension` | Toggle `chia://` resolution on/off. |
| `updateServerConfig` | Persist the dig-node/RPC host config. |
| `updateRpcHost` | Background→content broadcast that the RPC host changed. |
| `walletRpc` | Route one `window.chia` CHIP-0002 RPC to the self-custody wallet (per-origin gated): connect + reads (getAddress/getPublicKeys/getAssetBalance/getAssetCoins/filterUnlockedCoins/getNFTs) → the offscreen vault; sign/message + writes (transfer/sendTransaction/createOffer/takeOffer/cancelOffer) → the SW-summoned approval window. No WalletConnect fallback. |
| `walletConsent` | Popup approves/revokes a dapp origin for wallet access. |
| `dappApprovalList` / `dappApprovalResolve` | Approval-window channel (§18.12): read the pending dApp signing-request queue (decoded summaries) / return the user's approve-reject decision. |
| `reportVerification` / `getVerification` | Record/read the active tab's verification state. |
| `getDigNodeStatus` | Probe whether a local dig-node is reachable; report the chosen base. |
| `recordLedgerEntry` / `getShieldLedger` | DIG Shields per-resource proof ledger (§10). |
| `getControlStatus` | DIG Control Panel status (manage vs install) (§11). |
| `reportError` / `reportSuccess` | Rolling resolution-strategy diagnostics buffer. |
| `addSearchEngine` / `getDefaultSearchEngine` / `isDigSearchDefault` / `updateSearchConfig` | Omnibox/search-engine config. |
| `getCapabilities` | Self-describe: version + actions + wallet methods + error codes + bridge. |

Deprecated (kept for backward compatibility, MUST continue to be handled):
`navigateToDataUrl`, `getDataUrl`.

Removed in `MESSAGE_PROTOCOL_VERSION` 2 (#43 / #41 SoC audit — the extension does not cache
resolved content): `preloadResources`, `getCacheStats`, `clearCache`. An implementation MUST
NOT reintroduce a content-caching action.

### 7.2 Loader response envelope

The loader actions (`proxyRequest`, `convertDigUrl`, `getDataUrl`) return, on failure, the
coded envelope `{ success: false, code: <DIG_ERR_*>, message: <human string> }` (§9). On
success `proxyRequest` returns `{ success: true, data: <dataUrl>, contentType, verified? }`.
There is no `cached` field — the response never reflects a cache hit, because there is no cache.

### 7.3 Page↔extension provider bridge (`BRIDGE`)

The injected MAIN-world provider talks to the content script over `window.postMessage`:

- `DIG_WALLET_REQUEST` (page → content): `{ type, id, method, params }`.
- `DIG_WALLET_RESPONSE` (content → page): `{ type, id, status, body, error }`.

The content script forwards requests to the service worker (`walletRpc`), which routes them to the
self-custody wallet — connect + reads to the offscreen vault, sign/message to the SW-summoned
approval window (§18.12). `status` is HTTP-like: `200` ok, `202` pending consent, `4xx`/`5xx` error.
A timeout or missing bridge MUST resolve as a disconnected-class envelope (mapped by the provider to
error `4900`).

### 7.4 `getCapabilities`

`buildCapabilities(version)` returns
`{ version, messageProtocol, actions[], walletMethods[], stateChangingMethods[], errorCodes[], bridge }`.
This is the machine-readable self-description; it is also emitted at build time to
`dist/agent-surface.json` (a `web_accessible_resource`) and printable with `node build.js --json`.

---

## 8. Node-resolution ladder & configuration

The extension resolves the content RPC endpoint per the ecosystem-wide client→node resolution
order: **explicit config > `dig.local` > `localhost` > the hosted read tier**. An
explicitly-configured node always wins; absent one, the extension prefers the user's own
machine, falling back to the hosted read tier only when no local node is reachable.

### 8.1 Local dig-node candidates (`server-config.mjs`)

`digNodeCandidates(host)` returns the ordered try-list, computed from the parsed
`{ url, port }` (§8.3):

1. **An explicitly-configured custom host wins ENTIRELY.** When `url` names something other
   than a standard local alias (`localhost`, `127.0.0.1`, `::1`, `dig.local` — case-insensitive),
   the try-list is the single candidate `['http://<url>:<port>']`; `dig.local` and `localhost`
   are NOT probed. This is the override precedence: a configured node is a deliberate choice
   and MUST actually be contacted, never silently ignored in favor of the local-alias ladder.
2. **Otherwise** (no host configured, or one of the local aliases) the ladder is
   `['http://dig.local', 'http://localhost:<port>']`:
   - `http://dig.local` (port 80, branded) — tried FIRST.
   - `http://localhost:<port>` — the always-on fallback (`<port>` from the configured
     `server.host`, default **8080**).

An implementation MUST NOT destructure only `{ port }` from the parsed host and discard `url` —
doing so silently drops a configured custom host and is a conformance defect (the historical
bug this SPEC section closes: #43 / #41 SoC audit).

`probeDigNode(baseUrl, {fetch, timeoutMs})` MUST use a `no-cors` GET with a short timeout
(default 1500 ms) and treat ANY resolved fetch (even opaque) as reachable; a thrown/aborted
fetch is unreachable. `resolveDigNode(host)` returns the first reachable candidate or `null`.

### 8.2 Endpoint selection (`background.js`)

`getRpcEndpoint()` MUST:

1. Resolve a local dig-node (§8.1 — a configured custom host, or the `dig.local`/`localhost`
   ladder), briefly caching the resolved base URL (default TTL 10 s), and use its JSON-RPC POST
   root (trailing slash) when reachable.
2. Otherwise fall back to the hosted endpoint from `digRpcEndpoint`, defaulting to
   `https://rpc.dig.net/`.

This is the client→node resolution order, in full: **explicit `server.host` override >
`dig.local` > `localhost:<port>` > `digRpcEndpoint` (default `rpc.dig.net`)**. The 10 s
endpoint-resolution memo MUST be invalidated immediately when `server.host` / `server.url` /
`server.port` change; it caches WHICH endpoint answered, never resolved/decrypted content.

### 8.3 User-facing custom node (mandatory)

The extension MUST expose a first-class, persisted way for the user to set a custom endpoint:

- `server.host` (options page) — the local dig-node host (`host`, `host:port`, or
  `http(s)://host[:port]`), parsed by `parseServerHost` into `{ url, port }` with an
  out-of-range/absent port falling back to 8080. A value naming something other than a local
  alias (§8.1) overrides the `dig.local`/`localhost` ladder entirely.
- `digRpcEndpoint` (options page) — the hosted fallback endpoint, overriding `rpc.dig.net`.

A configured value takes precedence over the auto-defaults for its tier.

### 8.4 Storage keys

State persists in `chrome.storage.local`. Canonical keys:

| Key | Meaning |
|---|---|
| `server.host` | dig-node host (canonical). `server.url` / `server.port` are legacy inputs folded into it. |
| `digRpcEndpoint` | hosted fallback RPC endpoint (default `https://rpc.dig.net/`). |
| `wallet.pendingOrigins` | origins awaiting per-origin wallet consent. |
| `wallet.origins` | per-origin wallet consent / connected-sites permissions (§18.12). |

---

## 9. Loader error taxonomy (`error-codes.mjs`)

Every read-path failure MUST carry a stable UPPER_SNAKE `code` alongside the human `message`.
`makeError(input, codeOverride?)` builds `{ success: false, code, message }`; `classifyError`
maps a raw message/Error to a code (a coded Error keeps its `.code`; an unrecognized message
falls back to `DIG_ERR_NETWORK`).

### 9.1 Canonical `dig-loader` subset (cross-surface)

These four codes MUST stay byte-identical with docs.dig.net's `static/error-codes.json` and the
native DIG Browser loader:

| Code | Meaning |
|---|---|
| `DIG_ERR_PROOF_MISMATCH` | Served content did not verify against the on-chain root. |
| `DIG_ERR_DECRYPT_TAG` | AES-256-GCM-SIV tag failed — wrong key/salt, corrupt bytes, or a decoy. |
| `DIG_ERR_NOT_FOUND` | Blind miss (decoy) — no resource at this retrieval key under this generation. |
| `DIG_ERR_NETWORK` | Node/CDN unreachable or transport failed. |

### 9.2 Extension-local codes (`canonical: false`)

| Code | Meaning |
|---|---|
| `DIG_ERR_INVALID_URN` | The `chia://` address / URN was malformed. |
| `DIG_ERR_DIGNODE_REQUIRED` | A local dig-node is configured/required but not reachable. |

The human `message` MUST NOT leak crypto internals (retrieval keys, merkle, decoy strings);
the error page maps to friendly copy. The code is the machine discriminant and is exposed to
the viewer document as `data-dig-error`.

A `DIG_ERR_DIGNODE_REQUIRED` failure SHOULD surface the install prompt from `dig-node-status.mjs`
(`digNodeInstallPrompt()` → `{ title, body, installLabel, installUrl }`, installer at the
dig-installer releases page) rather than the generic network error. `isDigNodeRequiredError`
decides this from the raw message.

---

## 10. DIG Shields — per-resource proof ledger (`dig-ledger.mjs`)

For each resolved resource the viewer records an inclusion verdict into the active tab's ledger
(`recordLedgerEntry`); the popup Shield panel lists it (`getShieldLedger`). The ledger is a
byte-mirror of the native browser's shields ledger.

- An entry carries `{ storeId, rootHash, resourcePath, inclusionProofPassed, errorCode?, executionProofStatus? }`.
- `groupLedger` groups entries into passed/failed with counts and an `allPassed` aggregate.
- Execution proofs MUST be reported honestly: never green-checked when mock or absent.

---

## 11. DIG Control Panel (`dig-control.mjs`)

`getControlStatus` (mirroring the native `dig://control`) returns
`{ mode: 'manage'|'install', localNode, base, controlEndpoint, readFallback, status, authRequired, controlMethods }`.

- `decideControlView` picks `manage` when a local dig-node is detected, else `install`.
- `CONTROL_METHODS` (`control.*`) and `CONTROL_ERR` MUST be byte-consistent with the dig-node
  control RPC contract.
- When only the hosted read tier is reachable, the view falls back honestly (no fabricated
  manage state).

---

## 12. Injected `window.chia` provider

The MAIN-world `window.chia` is BUILT FROM the shared `@dignetwork/chia-provider` package — the
single source of truth for the DIG provider contract, consumed identically by the native DIG
Browser. `build.js` esbuild-bundles `dig-provider.entry.mjs` (which wraps the package's
`buildProvider` with this extension's `window.postMessage` transport, §7.3) into
`dist/dig-provider.js` as a self-contained IIFE. There MUST be no hand-copied provider surface.

- The provider MUST NOT clobber an existing `window.chia`.
- Method namespacing (from the package's `normalizeMethod`): `chip0002_*` and `chia_*` pass
  through; Goby/Sage method aliases map to their canonical names; any other bare name is namespaced to
  `chip0002_<name>`. `wallet-methods.mjs` re-exports the package's catalogue
  (`WALLET_METHODS`, `STATE_CHANGING_METHODS`, `GOBY_ALIASES`, `normalizeMethod`,
  `remapGobyParams`, `isSupportedMethod`, `isStateChanging`) unchanged.
- The surface is a Goby/CHIP-0002/Sage-WC2 superset (`isDIG`, `isGoby`, `request`, `connect`,
  `on`/`off`, `requestAccounts`/`accounts`, `walletSwitchChain` mainnet-only, callable
  `isConnected()`), and is self-describing (`version`, `info`, `methods`, and
  `request({ method: 'chip0002_getMethods' })` answered locally).
- Thrown errors MUST carry the CHIP-0002 wallet codes: `4000` invalid-params, `4001`
  unauthorized, `4002` user-rejected, `4003` spendable-balance-exceeded, `4004` method-not-found,
  `4005` no-secret-key, `4029` rate-limited, `4900` disconnected/not-connected.
- Wallet access is **per-origin gated**: a site's `connect()` receives `202` (pending) until
  the user approves the origin in the popup's connection-requests list; a pending request MAY
  raise a toolbar badge + notification.

The normative provider contract is the `@dignetwork/chia-provider` package `SPEC.md`; this
extension MUST NOT diverge from it.

---

## 13. Build contract (`build.js`)

- `node build.js` validates required source files and copies them into `dist/`, **builds the React
  UI shell with Vite** (`vite build` → `dist-web/{popup.html,app.html,assets/*}` incl. the vendored
  Space Grotesk / Space Mono woff2, then copies `dist-web/*` into `dist/` — plain Vite is used ONLY
  for the React pages so `build.js` keeps owning the SW/content/provider/zip path
  unchanged), esbuild-bundles `dig-provider.entry.mjs` → `dist/dig-provider.js`, esbuild-bundles
  `wallet-methods.mjs` into a
  self-contained ESM (inlining `@dignetwork/chia-provider` — browsers + MV3 SWs cannot resolve the
  bare specifier, so the raw re-export would break every consumer's module graph), esbuild-bundles
  `store-interceptor.entry.mjs` → `dist/store-interceptor.js` (a self-contained IIFE with the
  unit-tested `store-refs.mjs` inlined, since the opaque store frame can neither import a module nor
  fetch a cross-origin script — §5.3), esbuild-bundles the MV3 service worker + content-script layer,
  injects the `package.json` version into the `__APP_VERSION__` placeholder of `popup.html` +
  `app.html` + `approval.html` (§2.3), and emits `dist/agent-surface.json`. There is NO WalletConnect
  vendoring — the extension is a self-custody wallet.
- The bundled `dist/wallet-methods.mjs` MUST retain the same named exports and contain NO surviving
  bare `@dignetwork/*` import; the build fails loudly otherwise.
- `node build.js --zip` additionally produces a versioned `.zip` for distribution.
- `node build.js --json` emits one JSON result on stdout (machine mode), prose on stderr.
- Exit codes: `0` success · `2` a required source file is missing (validation) · `3` a build
  step failed (bundling / artifact write).
- The build MUST fail if any required source file is missing.

---

## 14. Configuration reference

| Setting | Storage key / source | Default | Effect |
|---|---|---|---|
| Local dig-node host | `server.host` | `localhost:8080` | a local-alias host (`localhost`/`dig.local`) keeps the `dig.local`-first ladder; a genuinely custom host wins ENTIRELY over that ladder (§8.1) |
| Hosted RPC endpoint | `digRpcEndpoint` | `https://rpc.dig.net/` | fallback when no local node is reachable |
| Resolution on/off | popup (`toggleExtension`) | on | disables `chia://` resolution |
| Search engine | `updateSearchConfig` | DIG omnibox (`dig`) | omnibox/search config |

---

## 15. Security properties

- **Fail-closed crypto** — unverified WASM (SRI mismatch) refuses to run (§6).
- **No forged verification** — a failed/absent inclusion proof is never rendered as verified;
  a GCM-SIV tag failure is never rendered as content (§5, §6).
- **No leaked internals** — user-facing error copy never exposes crypto strings; the machine
  code is separate (§9).
- **Per-origin wallet consent** — no site gets wallet access without explicit popup approval; the
  self-custody key never leaves the offscreen vault, and every sign/message request is approved in the
  SW-summoned approval window (§7.3, §18.12). There is no WalletConnect session.
- **Privacy-preferring endpoint** — the user's local dig-node is preferred over the hosted
  gateway; the gateway is the fallback, not the default (§8).
- **Read-only** — the extension performs no on-chain spends and serves no content to peers.
- **No content cache** — the extension does not persist or memory-cache resolved/decrypted
  content; every `proxyRequest`/`convertDigUrl` call re-fetches, re-verifies, and re-decrypts.
  Caching (and any node-config UI) is a dig-node responsibility, never the extension's (§1).

---

## 16. Machine-consumable surface

The extension is agent-navigable and machine-consumable:

- `getCapabilities` / `dist/agent-surface.json` / `node build.js --json` self-describe the
  action set, wallet methods, state-changing methods, error codes, and bridge.
- The frozen `ACTIONS`, `DIG_ERR`, and `WALLET_METHODS` catalogues are stable contracts;
  UI/agent code branches on codes and IDs, not on human prose.
- Popup/options/viewer surfaces carry stable `data-testid` and ARIA attributes; the viewer
  document exposes `data-dig-error`.

---

## 17. Conformance

An implementation conforms to this SPEC iff it:

1. Parses and normalizes every URN form in §4 to the §4.3 result shape.
2. Executes the §5 read path with the §5.1 `dig.getContent` wire and §5.2 reassembly.
3. Enforces the §6 SRI-pin + fail-closed crypto and never forges verification.
4. Handles every non-deprecated `ACTIONS` entry with its catalogued DTO and returns the §7.2
   coded envelope on loader failure.
5. Resolves the endpoint in the §8 order with the §8.3 user-facing custom-node overrides.
6. Emits the §9 canonical `dig-loader` codes byte-identically with the shared catalogue.
7. Builds the `window.chia` provider from `@dignetwork/chia-provider` unchanged (§12).

The test suite (`node --test tests/`, coverage-gated ≥ 80% via c8 / `.c8rc.json`) pins these
contracts; a change that breaks a pinned contract without updating this SPEC in the same unit
of work is incomplete.

8. Derives self-custody wallet keys per §18.1 (both hardened AND unhardened, byte-identical to
   `dig-l1-wallet` for a given seed) and stores keys only as the §18.2 `DIGWX1` encrypted record.

---

## 18. Self-custody wallet (#56)

The extension holds its OWN keys and signs locally: this self-custody wallet is the ONLY wallet path
(there is no WalletConnect/Sage broker). The decrypted key and the signer live ONLY in a long-lived
offscreen document (never the service worker, never `chrome.storage` beyond the encrypted blob);
§18.3+ specify that lifecycle. This section is the normative contract for the custody CRYPTO CORE —
key derivation (§18.1) and the at-rest keystore (§18.2).

### 18.1 Key derivation (normative)

For a given BIP-39 mnemonic the extension MUST reproduce the SAME wallet as `dig-l1-wallet` / Sage.
The chain is, step for step:

```
mnemonic → seed = mnemonic.to_seed("")            (BIP-39, EMPTY passphrase — the Chia convention)
         → master = SecretKey.fromSeed(seed)       (= chia_rs SecretKey::from_seed)
         → account = master.deriveUnhardenedPath([12381,8444,2,index])   (= master_to_wallet_unhardened)
                   | master.deriveHardenedPath([12381,8444,2,index])     (= master_to_wallet_hardened)
         → synthetic = account.deriveSynthetic()   (= DeriveSynthetic::derive_synthetic)
         → puzzleHash = standardPuzzleHash(synthetic.publicKey())   (= StandardArgs::curry_tree_hash)
         → address = Address(puzzleHash, "xch").encode()            (CHIP-0002 bech32m)
```

- The BIP-39 passphrase is ALWAYS the empty string; it is NOT configurable.
- Entropy is 256 bits → a 24-word English mnemonic. The extension persists the ENTROPY (not the
  seed/scalar), so "reveal recovery phrase" regenerates the exact 24 words byte-for-byte.
- A wallet MUST derive and scan BOTH the unhardened and the hardened path forms, each to its own gap
  limit. Scanning only one scheme would make funds on the other scheme's addresses invisible.
- The extension MUST NOT use `dig-keystore`'s `L1WalletBls` sign path (it double-derives — a latent
  upstream inconsistency).
- Conformance is pinned by a golden parity fixture (`src/lib/keystore/derive.golden.json`) of the
  canonical all-zeros-entropy mnemonic (`abandon … art`): identical synthetic pubkey + puzzle hash +
  `xch1…` address across the extension, `dig-l1-wallet`, and Sage, for BOTH schemes across MULTIPLE
  indexes. The fixture's BIP-39 seed equals the published all-zeros test vector (`408b285c…80840`),
  anchoring the chain to a public vector.

### 18.2 At-rest keystore — `DIGWX1` v1

The wallet entropy is stored ONLY as an encrypted `DIGWX1` record under `chrome.storage.local`
(`wallet.keystore`). No plaintext secret is ever written to any storage area.

- **KDF:** Argon2id (via the in-package `hash-wasm`) at the DEFAULT cost 64 MiB / 3 iterations /
  4 lanes (a STRONG 256 MiB preset is offered for high-value wallets), with a fresh 16-byte random
  salt. A `kdf.id` field allows versioned migration.
- **Cipher:** AES-256-GCM (native WebCrypto), fresh 12-byte nonce, 128-bit tag. The record HEADER —
  `{version, magic, full kdf params, cipher id + nonce}` — is bound as GCM AAD, so tampering with any
  KDF param, the salt, or the nonce fails the tag CLOSED with no separate MAC.
- **Key handle:** the derived AES key is a NON-EXTRACTABLE `CryptoKey` (`extractable:false`), never
  serialized.
- **PBKDF2 fallback (bounded, never silent):** PBKDF2-HMAC-SHA-512 (≥600 000 iters, `kdf.id=pbkdf2`)
  engages ONLY when the Argon2 wasm fails to instantiate; the wallet surfaces a warning and schedules
  forced re-encryption to Argon2 on the next unlock.
- **Error opacity:** any decrypt failure (wrong password OR tampered blob) collapses to a single
  opaque `UNLOCK_FAILED`; only a structurally-invalid record yields `BAD_RECORD`.
- **Record shape** (base64 fields):
  ```json
  { "version":1, "magic":"DIGWX1",
    "kdf":{ "id":"argon2id","memKiB":65536,"iters":3,"lanes":4,"salt":"<b64 16B>" },
    "cipher":{ "id":"aes-256-gcm","nonce":"<b64 12B>" },
    "ciphertext":"<b64 entropy‖tag>", "createdAt":<ms>, "label":"<optional>" }
  ```
- **Additive versioning:** newer readers keep decoding every prior `version`/`kdf.id`; ids are never
  removed or repurposed.

Fresh salt + nonce are drawn on every (re)encryption; RNG is `crypto.getRandomValues`.

### 18.3 Custody lifecycle & session

The decrypted key lives ONLY in a long-lived `chrome.offscreen` document (`offscreen.html` →
`src/entries/offscreen.ts`), which hosts one in-memory vault (`src/offscreen/vault.ts`). The service
worker coordinates but NEVER holds the key: it creates the offscreen document on demand, forwards
custody requests, owns storage, and enforces auto-lock.

- **SW ↔ vault messaging.** The SW forwards `chrome.runtime.sendMessage({ target: OFFSCREEN_TARGET,
  request })`; ONLY the offscreen document handles messages carrying `OFFSCREEN_TARGET`, and the SW's
  own `onMessage` listener ignores them. Requests carry the password IN and public results (lock
  state, the encrypted record to persist, or the once-shown mnemonic) OUT — never the persisted key.
- **create / import.** The vault generates or validates the phrase, encrypts the entropy (DIGWX1),
  holds the entropy in memory, and returns the record; the SW persists it to `wallet.keystore` and
  starts the unlock window. Create additionally returns the 24-word phrase for ONE-TIME display
  (backup); it is never stored — this transient pass-through to the UI is inherent to backup.
- **unlock.** The SW reads the record and forwards it with the password; the vault runs Argon2id +
  AES-GCM decrypt and holds the entropy. Failure is the opaque `UNLOCK_FAILED`.
- **reveal recovery phrase.** Re-runs the FULL password decrypt in the vault (never from the TTL
  window); returns the phrase for one-time display without changing the held-key state.
- **lock.** The vault zeroizes + drops the entropy (best-effort); the SW clears the unlock window.
- **unlock window (TTL).** A NON-SECRET expiry timestamp is stored in `chrome.storage.session`
  (`wallet.unlockExpiry`) — never key material. Default TTL 10 minutes, clamped to 1–60, from
  `wallet.settings.unlockTtlMinutes`.
- **auto-lock triggers (all lock the vault + clear the window):** explicit lock; a `chrome.alarms`
  minute sweep once the TTL lapses; `chrome.idle` reporting `idle`/`locked`; all-windows-close (the
  offscreen document tears down, dropping the in-memory key).
- **lock state.** `getLockState` derives the snapshot PURELY from persisted storage — `none` (no
  keystore blob) / `locked` (blob present but the unlock window is absent or lapsed) / `unlocked`
  (blob + a fresh unlock window) — with NO round-trip to the offscreen vault, so it ALWAYS resolves
  immediately. A no-wallet user (who has no offscreen document at all) resolves instantly to `none`
  → onboarding, never blocking on a vault that will never answer. Auto-lock (the TTL sweep alarm +
  `chrome.idle`) independently zeroizes the vault and clears the unlock window when the TTL lapses,
  so a lapsed window reads as `locked` without a vault call; the SW spawns the offscreen document
  only to unlock / use the key, never to read state.

### 18.4 Storage schema (custody)

| Key | Area | Secret? | Contents |
|---|---|---|---|
| `wallet.keystore` | `storage.local` | encrypted only | the DIGWX1 record (§18.2) — the only at-rest secret |
| `wallet.activeId` | `storage.local` | no | active wallet id (multi-wallet switcher) |
| `wallet.settings` | `storage.local` | no | durable settings (`unlockTtlMinutes`, `chainRpcUrl`, `chainPrivacyAck`, fee default…) |
| `walletCache.balances` | `storage.local` | no | last balance scan (`{ balances, at }`) for cached-first paint |
| `walletCache.activity` | `storage.local` | no | last activity ledger (`{ events, cursorHeight, at }`) for cached-first paint |
| `wallet.unlockExpiry` | `storage.session` | no | non-secret unlock-expiry timestamp (ms); never key material |

`storage.sync` is NEVER used for any wallet key (it would exfiltrate the encrypted seed).

### 18.5 Custody UI & landing

The wallet surface lands on a state-driven custody gate BEFORE the balances view:

- **no wallet** (`lockState=none`): the fullscreen surface (`app.html`) runs the full onboarding flow
  (create → back up the recovery phrase behind the accessible reveal → confirm one word, OR import a
  phrase); the compact popup shows a single CTA card that opens fullscreen onboarding. There is no
  "use a Sage wallet instead" escape — self-custody is the only path.
- **locked**: a password unlock screen.
- **unlocked**: the wallet (Balances & Intents).

The recovery-phrase reveal MUST be accessible (§5.6): tap-to-reveal, a screen-reader-navigable
numbered word list, an explicit Copy that AUTO-CLEARS the clipboard after a short delay, and an
auto-hide of the on-screen phrase. The phrase is shown once for backup and never persisted.
The revealed word list MUST render inside a **closed shadow root** (`attachShadow({mode:'closed'})`)
so the secret is not reachable from the light DOM — a co-installed extension, an injected page
script, or any other part of the wallet UI cannot scrape it via `document.querySelector` or
`textContent` harvesting (the host's `shadowRoot` is `null`; screen readers and keyboard navigation
still traverse the subtree). The same DOM-isolation primitive applies to any future private-key
export.

### 18.6 Balance scan & chain source

Read-only balances come from an HD scan run in the offscreen vault (it has the key + the wasm):

- **Derivation + scan.** Derive standard p2 puzzle hashes for BOTH schemes (§18.1) to a gap limit,
  then sum UNSPENT coins from coinset: native XCH at those hashes, and each watched CAT at its CAT
  puzzle hash (`catPuzzleHash(tail, innerPh)`). Balances are POOLED across all derivations.
- **Chain source.** The wasm coinset `RpcClient` fetches the configured chain endpoint from the
  offscreen document (extensions bypass CORS). Default `https://api.coinset.org`; an explicit
  `wallet.settings.chainRpcUrl` override wins (§5.3 — a user-facing custom node, settable +
  persisted). The pooled `dig.local`/`localhost` tiers are NOT used for the wallet chain reads (a DIG
  node does not expose coinset-shape chain reads today).
- **Privacy.** The wallet DISCLOSES, once (until acknowledged, `wallet.settings.chainPrivacyAck`),
  that a scan reveals the wallet's full address set to the configured operator, and offers the
  override so a privacy-minded user can point at their own node.
- **Caching.** The last scan is cached (`walletCache.balances`, non-secret); a transient scan failure
  returns the cached snapshot flagged `cached` (cached-first paint).
- **Receive.** The pooled receive address is index 0, unhardened (`getReceiveAddress`).

### 18.7 Spend signing

Signing runs in the offscreen vault (it holds the key) using the shipped `chia-wallet-sdk-wasm` — NO
bespoke crypto crate is required, for own OR foreign (dApp-supplied) spends:

- **Required signatures** are reconstructed from ANY coin spends by running each puzzle against its
  solution and parsing the output conditions (`Program.run().value.toList()` +
  `parseAggSigMe()` / `parseAggSigUnsafe()`).
- **The signed message** for an AGG_SIG_ME is `rawMessage ‖ coinId ‖ AGG_SIG_ME_ADDITIONAL_DATA`
  (the network genesis — mainnet `ccd5bb…`); AGG_SIG_UNSAFE signs the raw message unchanged.
- Each is signed with the matching key (raw or its synthetic form — `SecretKey.sign`) and combined
  with `Signature.aggregate`. A required signer with no matching key fails loudly (`MISSING_KEY`)
  rather than producing an invalid bundle.
- Own spends may also be signed directly by the wasm. Both paths are proven consensus-valid against
  the wasm simulator (a reconstructed signature is accepted by `Simulator.newTransaction`).
- This module BUILDS + VALIDATES signatures only; broadcasting a spend is a separate, per-signature
  user-approved step (§5.5). Mainnet spends are never auto-broadcast in tests.

### 18.8 Spend construction (Send)

An XCH send is built with the `Spends`/`Action` driver in the offscreen vault:

- Add the wallet's unspent XCH coins, `apply([Action.send(Id.xch(), recipient, amount), Action.fee])`
  to select coins, then provide each selected coin's standard inner spend
  (`standardSpend(syntheticKey, delegatedSpend(conditions))`) keyed by the coin's puzzle hash —
  `MISSING_KEY` if the wallet doesn't own a selected coin — and finalize to the coin spends.
- **The confirmation summary is decoded FROM THE BUILT SPEND** (§5.5): the CREATE_COINs are read
  back into `sent` (to the recipient) + `change` (the rest); the fee is the applied fee. The summary
  is never taken from caller/page text (tamper resistance).
- The built coin spends are signed via §18.7, aggregated into a `SpendBundle`, and broadcast via
  coinset `pushTx` ONLY after user approval. Proven consensus-valid against the wasm simulator.
- **CAT sends** reuse the same prepare/confirm/approval/poll flow (`prepareSend` with an `assetId`).
  The wallet's CAT coins are reconstructed with their lineage proofs by computing the CAT puzzle
  hashes over the keyring, fetching those coins, and parsing each parent's spend
  (`Puzzle.parseChildCats`); XCH coins are added to cover the fee; the driver builds via
  `Action.send(Id.existing(assetId), …)`. Amounts use the CAT's decimals; the fee is XCH.

### 18.9 Activity indexer

There is no transaction-history endpoint, so the ledger is reconstructed (read-only) in the offscreen
vault (`getActivity`):

- Derive the HD puzzle hashes (both schemes) + the watched-CAT puzzle hashes; fetch their coin
  records INCLUDING spent (`getCoinRecordsByPuzzleHashes`).
- **RECEIVED** = a coin created to us whose parent is NOT one of our coins (our own change is skipped).
- **SENT / TRADE** = a coin of ours that was spent → decode its spend's CREATE_COINs
  (`getPuzzleAndSolution`); outputs to others = sent (recipient resolved to an address), outputs to
  the settlement puzzle hash = a trade. The first coin carries the outputs (§18.8), so multi-coin
  sends dedupe naturally.
- Classification covers XCH + watched CATs + offer-settlement trades; the events normalize to
  human-sentence rows + SpaceScan links. Results are cached (`walletCache.activity`) for cached-first
  paint; the height cursor is persisted for a future incremental scan (v1 re-scans fully for
  correctness — a coin created before a cursor may be spent after it).

### 18.10 Trade offers

Offers are assembled from `chia-wallet-sdk-wasm` primitives to match the canonical `chia-sdk-driver`
offer construction byte-for-byte, so they interoperate with Sage / dexie. All money paths are proven
consensus-valid by a two-party simulator settlement test. v1 supports a SINGLE offered asset and a
SINGLE requested asset, each XCH or a CAT (covering every XCH↔token trade); the offered and requested
assets MUST differ.

- **Nonce.** `nonce = tree_hash(coin_ids sorted ascending)` over the maker's offered coin ids.
  Make and take derive the same notarized-payment tree hash, so the announcements match.
- **MAKE** (`makeOffer` → `prepareTrade`-free, no broadcast): spend the OFFERED coins into the
  settlement puzzle (`Action.send(offeredId, SETTLEMENT_PAYMENT_HASH, amount)`), add the REQUESTED
  payment ASSERTION (`AssertPuzzleAnnouncement(sha256(settlementPuzzleHash ‖ tree_hash(notarized_payment)))`,
  where the settlement puzzle hash is `SETTLEMENT_PAYMENT_HASH` for XCH or `CatInfo(asset_id, hidden,
  SETTLEMENT_PAYMENT_HASH).puzzle_hash()` for a CAT), and append a PHANTOM requested-payment carrier —
  a coin spend with a ZERO parent and amount 0 whose puzzle is the (CAT-wrapped) settlement puzzle and
  whose solution is the notarized payments. The maker NEVER funds the requested side (the offered coin
  keeps full change). The bundle is `encodeOffer`-encoded to an `offer1…` string.
- **INSPECT** (`inspectOffer`, read-only): `decodeOffer`, split real coin spends (`parent != 0`) from
  phantom carriers (`parent == 0`), parse the requested payments from the carriers, and reconstruct the
  offered legs (XCH from the real spends' CREATE_COINs to settlement; CATs via `offerSettlementCats`).
- **TAKE** (`prepareTrade` `take` → `confirmTrade`): add the offered settlement coins (the taker
  receives them) + the wallet's coins to fund the requested payments, apply the requested settle
  actions (`RequestedPayments::actions()` = `Action.settle(id, notarized_payment)` — which create the
  requested payments to the maker + the matching announcements), and concatenate the maker's REAL coin
  spends (phantoms dropped) with the taker's spends into one aggregated `SpendBundle`. The taker pays
  the network fee.
- **CANCEL** (`prepareTrade` `cancel` → `confirmTrade`): re-spend the maker's original offered coins
  back to self, invalidating the offer (its settlement coins can no longer be created).
- `prepareTrade` builds + signs but does NOT broadcast; the signed bundle is held under a pending id;
  `confirmTrade` is the ONLY place a trade is pushed (the user-approved step). Offers are mainnet-only
  (signed with the mainnet AGG_SIG_ME genesis).

### 18.11 NFTs / Collectibles

NFTs are read and transferred from `chia-wallet-sdk-wasm` primitives so the spends match the canonical
`chia-sdk-driver` construction byte-for-byte (they interoperate with Sage / dexie). The transfer money
path is proven consensus-valid by a Simulator test (mint → list → transfer → assert the NFT moves and
the recipient can rediscover it). The decrypted key never leaves the offscreen vault.

- **Discovery model.** An NFT is a singleton whose OUTER coin puzzle hash is the singleton/ownership
  puzzle — NOT the wallet's inner (p2/standard) puzzle hash — so it is NOT found by a puzzle-hash scan.
  The transfer that delivered it HINTS the recipient's inner p2 puzzle hash, so the wallet finds its NFT
  coins via coinset `get_coin_records_by_hints` over its derived inner puzzle hashes (both HD schemes,
  to the scan gap limit). For each hinted unspent coin, the PARENT spend is fetched and
  `Puzzle.parseChildNft(parentCoin, parentSolution)` reconstructs the child `Nft` (parallel to
  `Puzzle.parseChildCats` for CATs). A coin is one of the wallet's NFTs iff the reconstructed child IS
  that coin and its `info.p2PuzzleHash` is one of the wallet's derived inner puzzle hashes.
- **LIST** (`listNfts`, read-only): returns, per NFT, `{ launcherId, coinId, p2PuzzleHash, collectionId
  (the current-owner DID hex, or null), editionNumber, editionTotal, royaltyBasisPoints,
  royaltyPuzzleHash, dataUris, dataHash, metadataUris, metadataHash, licenseUris }` — deduped by
  launcher id. `collectionId` groups NFTs minted under the same DID; the collectibles UI groups by it.
- **Same-allocator invariant (MUST).** The reconstructed `Nft` carries a `metadata` CLVM `Program`
  bound to the `Clvm` allocator that produced it. It MUST be reconstructed in the SAME `Clvm` that the
  `Spends` driver later consumes (`addNft`), else the wasm traps (`unreachable`) on a cross-arena handle.
- **PREPARE** (`prepareNftTransfer`, no broadcast): reconstruct the target NFT (by launcher id) in the
  driver's `Clvm`, `Spends.addNft(nft)`, add XCH coins for the fee, then
  `Action.send(Id.existing(launcherId), destP2, 1, memos)` — a singleton is amount `1`; `memos` carries
  the recipient's inner p2 puzzle hash as the create-coin hint so the recipient can discover it. Insert a
  standard inner spend for each pending coin. The unsigned coin spends are held under a pending id with
  the decoded summary `{ launcherId, recipientPuzzleHashHex, fee, coinCount }`.
- **CONFIRM** (`confirmNftTransfer`): signs + broadcasts the held spend — reusing the vault's
  `confirmSend` broadcast path (an NFT transfer is a coin spend). It is the ONLY place the transfer is
  pushed (the user-approved step); confirmation is polled via the shared `sendStatus`. Mainnet-only
  (signed with the mainnet AGG_SIG_ME genesis).

### 18.12 dApp `window.chia` requests & the SW-summoned approval window (§5.5)

A webpage's injected `window.chia` provider reaches the wallet as a `walletRpc` message (§7.3).
`walletRpc` ALWAYS routes to the self-custody wallet (`dapp-approval.mjs`) — connect + reads to the
offscreen vault, sign/message to the approval window; there is no WalletConnect/Sage fallback. A
request with no/locked wallet resolves to `202` (pending) or a `401`-class error, prompting the user
to create/unlock a wallet. The committed page origin (the SW prefers the unspoofable `sender.origin`)
gates every request.

- **Consent (`chip0002_connect`).** Reuses the per-origin consent store (`wallet.origins`): an
  unapproved origin is recorded pending + returns `202` (the provider polls while the user approves
  out-of-band); an approved origin returns `{ address, network }` from the offscreen vault (or a
  `401`-class error when the wallet is locked). Every non-connect method REQUIRES an already-approved
  origin (else `401`).
- **Phishing / malicious-origin protection (P0-2).** Every request's origin is assessed by
  `assessOrigin` (`src/lib/phishing.ts`, pure) against a DIG-curated blocklist (refreshed on a 6-hour
  alarm from `rpc.dig.net/phishing-blocklist.json` into `chrome.storage.local` under
  `phishing.blocklist`, best-effort — a failed/absent fetch keeps the last list; a bundled seed is
  always unioned in) plus DIG-lookalike heuristics (a homoglyph whose IDN-decoded confusable skeleton
  resolves to a legit DIG surface, or a subdomain-spoof placing a real DIG domain left of the true
  attacker registrable domain). A `block` verdict REFUSES the origin `403` before it can connect — it
  is never recorded pending, never approved (enforced in the custody router's `connect` gate).
  A `warn` (lookalike) verdict lets the flow proceed but rides the approval queue so the window shows
  an interstitial the user must acknowledge. All original code, evaluated on-device — no imported
  Ethereum phishing list.
- **Granular revocable permissions + Connected sites (P0-4).** Per-origin consent is a CAPABILITY
  record, not a bare boolean: `wallet.origins[origin] = { approved, ts (grantedAt), addresses[],
  methods[], lastUsed }` — backwards compatible (a legacy `{ approved, ts }` record still reads as
  connected). On a served request the SW records `lastUsed` + the invoked method (+ the connect
  address). Two EIP-2255-shaped (Chia-mapped) `window.chia` methods are answered from this shared store
  (independent of the request path): `wallet_getPermissions` → an array of `{ invoker, parentCapability:
  'chia_connect', caveats:[{ type:'restrictReturnedAddresses', value: addresses }], date }` (empty when
  none); `wallet_revokePermissions` → clears the origin's consent (a revoked site must re-request). A
  **Connected-sites** screen (Settings/Advanced) lists every origin (addresses, granted/last-used,
  methods) with per-site **revoke** + **revoke-all** over the `listConnectedSites` /
  `revokeConnectedSite` / `revokeAllConnectedSites` SW actions.
- **Reads** route straight to the offscreen vault — no approval window (nothing is authorized):
  `chip0002_chainId` (→ `"mainnet"`), `chip0002_getPublicKeys` (the wallet's synthetic public keys,
  both HD schemes, deduped), `chia_getAddress` (→ `{ address }`), `chip0002_getAssetBalance`
  (`{ type, assetId }` → `{ confirmed, spendable, spendableCoinCount }`, asset-generic: any CAT by
  assetId or native XCH, both HD schemes; `confirmed === spendable` — the wallet holds no cross-call
  coin reservation), `chip0002_getAssetCoins` (→ the wallet's spendable coins, `{ coin, coinName,
  locked:false }[]`), `chip0002_filterUnlockedCoins` (echoes the supplied coins — none are cross-call
  locked), and `chia_getNfts` (the wallet's NFTs, discovered by hint across both HD schemes). Asset
  routing is by `assetId` end-to-end (a CAT is never treated as native XCH).
- **Signing** (`chip0002_signCoinSpends`), **message signing** (`chip0002_signMessage`,
  `chia_signMessageByAddress`), and the value-moving **writes** — `chia_send`/`transfer` (build → sign
  → broadcast), `chia_sendTransaction` (broadcast a dApp-built, already-signed bundle), and the trade
  offers `chia_createOffer` / `chia_takeOffer` / `chia_cancelOffer` — are APPROVAL-GATED. The SW enqueues the request and SUMMONS a dedicated
  approval window via `chrome.windows.create` (NOT `action.openPopup`, which needs a user gesture the
  background lacks). The `walletRpc` response stays pending until the user decides; a keepalive port
  (`dapp-approval-keepalive`) from the window keeps the MV3 SW + the offscreen vault alive through review.
- **The decoded summary is derived FROM THE BUILT SPEND** (§5.5 tamper resistance), never from
  page-supplied text: `decodeDappSpend` (offscreen) reconstructs the coin spends, runs each
  puzzle+solution, and reports the inputs/outputs (classified self-vs-external against the wallet's own
  HD puzzle-hash set), the reserved fee (Σ inputs − Σ outputs; trustworthy when every input is the
  wallet's own standard XCH), and the required signers (+ how many the wallet can satisfy). A message
  request shows the exact bytes to be signed. A locked wallet is flagged `needsUnlock` (the window shows
  the unlock gate, never a fabricated summary); an undecodable request is flagged `decodeError` (only
  Reject is offered).
- **Anti-drainer risk layer (P0-3).** Before the user approves a coin-spend request, `assessSpendRisk`
  (`src/lib/spend-risk.ts`, pure) inspects the decoded summary and flags high-risk patterns with stable
  machine codes: `DRAIN_ALL` (value leaves the wallet with ≤1% kept back as change — the drainer
  pattern), `HIGH_FEE` (reserved fee exceeds the amount sent, or ≥ 0.1 XCH absolute), `CANNOT_SIGN` (a
  required signer the wallet cannot satisfy), `FOREIGN_INPUTS` (the spend mixes in coins the wallet does
  not own, so the mojo amounts are untrusted). Mojo-based flags (`DRAIN_ALL`/`HIGH_FEE`) are computed
  ONLY when every input is the wallet's own (`allInputsSelf`) — the only case the amounts are
  trustworthy; otherwise `FOREIGN_INPUTS` is raised instead. The assessment is `none` / `caution` /
  `high`; a `high` assessment renders a red risk banner (`role="alert"`) and GATES Approve behind an
  explicit "I understand the risk" acknowledgement. All heuristics are Chia-native and evaluated
  on-device — nothing is sent off the device, no external list is consulted.
- **Writes build in the vault; the summary is decoded FROM THE BUILT ARTIFACT.** For each write the
  approval window's `enrich` step calls the vault to BUILD (not broadcast): `prepareSend` (send —
  routing XCH vs CAT by `assetId`), `prepareTrade` (take/cancel), `makeOffer` (create), or
  `decodeDappSpend` (sendTransaction's bundle). The build holds the prepared spend under a `pendingId`
  (or the built offer string) so the EXACT artifact whose summary was shown is the one acted on. A
  malformed or multi-leg-offer request is refused `400` (→ `4000`) BEFORE any window is summoned.
- **Approve** performs the built action in the offscreen vault and the `walletRpc` promise resolves:
  signing (`signDappSpend` reuses the §18.7 signer → aggregated signature; the dApp broadcasts a
  signed spend), message signing (BLS over the raw bytes), `confirmSend` (send → `{ id }`),
  `confirmTrade` (take/cancel → `{ id }`), the released offer string (createOffer → `{ offer }`), or
  `broadcastDappBundle` (sendTransaction reassembles the wasm `SpendBundle` from the wire coin spends +
  aggregated signature and pushes it → `[{ status: 1 }]`; the wallet relays, holds no key for it). The
  key never leaves the offscreen document. **Reject** resolves with a CHIP-0002 `4002 USER_REJECTED`
  error (distinct from the `4001` a locked/not-connected wallet returns) and nothing is broadcast.
- **Anti-drainer risk (P0-3) applies to dApp-BUILT spends** (`signCoinSpends` + `sendTransaction`),
  where a page could hide a drain; a wallet-built send/offer's summary IS the explicit request.
- **Queue.** Multiple requests queue; the window reviews one at a time and self-closes when the queue
  drains. Genuinely unimplemented wallet methods (DID/mint/…) return an honest `404` (→ CHIP-0002
  `4004 METHOD_NOT_FOUND`), never a silent sign. The provider's bridge timeout (120 s) bounds how long
  a request may await a decision.

### 18.13 Fiat prices & portfolio value (#86)

The wallet shows real fiat value beside each balance — a per-asset USD value, a total-portfolio value,
and a 24h delta — sourced from public price feeds. Prices are non-custodial, read-only market data and
therefore ride a SEPARATE data path from the balance/custody SW seam: they are fetched DIRECTLY over
HTTPS from the React surface (a dedicated RTK Query slice with its own `baseQuery`), never through the
offscreen vault. Prices NEVER block the wallet — an outage degrades to an honest "value unavailable"
while balances render unchanged.

- **Sources.** Two public endpoints, combined into a `PriceMap` (`{ [assetKey]: { usd, change24h } }`,
  keyed `'xch'` or a CAT's lowercased 64-hex TAIL):
  - **XCH→USD + 24h change** — CoinGecko `simple/price?ids=chia&vs_currencies=usd&include_24hr_change=true`
    (`{ chia: { usd, usd_24h_change } }`). The only clean USD anchor.
  - **CAT→XCH** — dexie v2 tickers (`GET https://api.dexie.space/v2/prices/tickers`); each XCH-quoted
    ticker's `last_price` is the CAT price IN XCH. A CAT's USD value is `rate × XCH-USD`; dexie does not
    report a clean per-CAT 24h change, so CAT `change24h` is null.
  Both hosts are in `host_permissions` + the CSP `connect-src`.
- **Graceful degradation.** Parsing is pure + tolerant (a malformed row drops that entry). A partial
  outage still prices what it can (dexie down → XCH still priced). Only when the XCH anchor itself is
  unavailable is the whole map unavailable (CATs have no USD without it) → the query surfaces an error.
- **Cache.** Short-TTL (`PRICE_TTL_SECONDS`, 120 s): the slice keeps the map that long after the last
  subscriber and treats it stale after the TTL, so repeated popup opens don't hammer the rate-limited
  upstreams.
- **Portfolio value.** `totalUsd` = Σ per-asset USD over PRICED assets (null when none can be priced).
  The 24h delta is computed over the subset of priced assets carrying a known change (24h-ago value =
  `now / (1 + change/100)`); `change24hPct` is expressed relative to that subset's prior value. A value
  is only ever computed from a KNOWN balance AND a KNOWN price — never a fabricated 0.
- **UI (four states, §6.4).** Success: the fiat total (hero) + a green-up/red-down 24h chip + the native
  crypto amount as a muted subline, and `≈ $x.xx` per asset row. Loading: the native amount + "loading
  value" (per-row muted placeholder). Error/empty: the native amount + "value unavailable" + retry, and
  `≈ $—` per row. All copy is react-intl across the 14 locales. USD is the default currency (a currency
  preference is a follow-up, #112).
