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
2. **`window.chia` wallet provider** — inject a CHIP-0002 / Goby-compatible provider that
   brokers wallet RPCs over WalletConnect to a Sage wallet.
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
  instantiation) and MUST restrict `script-src`/`object-src` to `'self'`.
- Content scripts (`middleware.js`, then `content.js`) run at `document_start`,
  `all_frames: true`, matching `<all_urls>`.
- The injected provider (`dist/dig-provider.js`) and the page fetch bridge (`page-script.js`)
  are `web_accessible_resources` injected into the page's MAIN world.
- Required permissions: `storage`, `webNavigation`, `tabs`, `declarativeNetRequest`,
  `scripting`, `omnibox`, `search`, `notifications`. Host permissions MUST include the local
  node hosts (`localhost`, `127.0.0.1`, `dig.local`, `*.dig.local`) and the hosted read tier
  (`rpc.dig.net`, `*.dig.net`).

An implementation targeting a browser without MV3 module service workers MUST provide an
equivalent long-lived module context able to instantiate WASM.

### 2.1 Popup UI surface (4 tabs)

The popup (`popup.html`, `popup.js` classic + `popup-wallet.js` module) is a dark-themed
**ARIA `tablist` of four tabs**, in this order (`tabs.mjs` is the source of truth for the set,
order, default, and hash deep-link):

1. **Resolver** (default) — open a `chia://` address, an on/off resolution toggle, the §5.3
   "Resolving via" verdict (`resolve-status.mjs` over the `getDigNodeStatus` probe: custom >
   `dig.local` > `localhost` > `rpc.dig.net`), and a custom-node override that persists to
   `server.host` (which wins over the ladder, §8.1).
2. **Wallet** — a full Chia wallet brokered over WalletConnect → Sage, at parity with the native
   DIG Browser wallet within MV3 limits (the extension holds no keys and never signs; every write
   is handed to Sage to sign). All balances are Sage's wallet-wide AGGREGATE (across every HD
   address) — the extension does NOT enumerate addresses. Five subviews (one shown at a time):
   - **Assets** (default) — every balance (XCH + `$DIG` + each tracked CAT) via CHIP-0002
     `getAssetBalance` (`{type,assetId}`), plus track/untrack a CAT by its 32-byte TAIL. The
     tracked-CAT list persists in `chrome.storage.local` `wallet.watchedCats`; a tracked CAT uses
     the Chia CAT convention of 3 decimals (`wallet-assets.mjs`).
   - **Send** — asset picker (XCH / `$DIG` / any tracked CAT) + recipient + amount + optional XCH
     fee → `chia_send` (`{assetId, amount, address, fee}`; `assetId:null` for XCH). Validation +
     per-asset unit conversion in `wallet-view.mjs`.
   - **Receive** — the address + a scannable QR (`qr.mjs`, black-on-white SVG) + copy + a SpaceScan
     address link.
   - **Activity** — paged history via `chia_getTransactions` (`{page}`) → `activityViewModel`, each
     item carrying direction, amount, fee, confirmed/pending status, memo, and a SpaceScan coin link.
   - **Offers** — make (`chia_createOffer` `{offerAssets, requestAssets, fee}`), inspect
     (`chia_getOfferSummary` `{offer}` → `offerSummaryViewModel`), take (`chia_takeOffer`), and
     cancel (`chia_cancelOffer`) a pasted `offer1…` string (`wallet-offers.mjs`).
   Every subview renders the four states (loading / error / empty / success). WalletConnect pairing,
   per-origin dapp consent, and Disconnect live in the tab; WalletConnect project id + custom node
   config live in the options page (linked from the tab). Key custody, local signing, NFT/DID/store
   management, and the advanced `dig_*` coin types are NOT replicable in an MV3 extension (Sage owns
   the keys) and are out of scope.
3. **Shield** — the active tab's verification verdict + per-resource proof ledger (§10).
4. **Control Panel** — manage a detected local dig-node, else pitch installing one with a link to
   the full-page onboarding landing `control.html` (§11).

- Exactly one panel is shown at a time via the `[hidden]` attribute; the active tab reflects
  `aria-selected` + a roving `tabindex`, and the tablist is arrow-key navigable.
- A `#wallet`/`#shield`/`#control`/`#resolver` location hash deep-links the opening tab.
- The Shield + Control tabs carry a machine-readable status dot (`data-verified` / `data-node`);
  the Control panel carries `data-mode` (`manage`|`install`). Every primary control has a stable
  `data-testid`.

### 2.2 App version exposure (§6.7)

Every popup + full page MUST surface the extension version (from `package.json`, injected at
build time in place of the `__APP_VERSION__` placeholder) in three forms: a visible footer
(`#appVersion`), a `<meta name="app-version">` tag, and the `window.__APP_VERSION__` global. The
bug-report funnel appends this version so a report records the build it came from.

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

1. The viewer renders store HTML inside a SANDBOXED, opaque-origin `data:` frame (isolated from
   the extension — the frame has no `chrome.*` access and holds no keys). The frame boots the
   interceptor with the entry capsule config `{ storeId, root, salt, entryKey }`.
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
`MESSAGE_PROTOCOL_VERSION` (currently `2`). Consumers MUST reference `ACTIONS.<name>` rather
than raw strings. Adding a handler without a catalogue entry is a contract violation (guarded
by `messages.test.mjs`).

`MESSAGE_PROTOCOL_VERSION` MUST be bumped on any breaking change to the action set or a DTO
shape.

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
| `walletRpc` | Broker one `window.chia` CHIP-0002 RPC (per-origin gated). |
| `walletConsent` | Popup approves/revokes a dapp origin for wallet access. |
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

The content script forwards requests to the service worker (`walletRpc`), which brokers them to
the WalletConnect session running in the popup page. `status` is HTTP-like: `200` ok, `202`
pending consent, `4xx`/`5xx` error. A timeout or missing bridge MUST resolve as a
disconnected-class envelope (mapped by the provider to error `4900`).

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
| wallet connection / consent state | the persisted WalletConnect session + per-origin approvals. |

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
  through; Goby/Sage aliases route to their broker names; any other bare name is namespaced to
  `chip0002_<name>`. `wallet-methods.mjs` re-exports the package's catalogue
  (`WALLET_METHODS`, `STATE_CHANGING_METHODS`, `GOBY_ALIASES`, `normalizeMethod`,
  `remapGobyParams`, `isSupportedMethod`, `isStateChanging`) unchanged.
- The surface is a Goby/CHIP-0002/Sage-WC2 superset (`isDIG`, `isGoby`, `request`, `connect`,
  `on`/`off`, `requestAccounts`/`accounts`, `walletSwitchChain` mainnet-only, callable
  `isConnected()`), and is self-describing (`version`, `info`, `methods`, and
  `request({ method: 'chip0002_getMethods' })` answered locally).
- Thrown errors MUST carry the standard wallet codes: `4001` user-rejected, `4100`
  unauthorized, `4200` unsupported, `4900` disconnected.
- Wallet access is **per-origin gated**: a site's `connect()` receives `202` (pending) until
  the user approves the origin in the popup's connection-requests list; a pending request MAY
  raise a toolbar badge + notification.

The normative provider contract is the `@dignetwork/chia-provider` package `SPEC.md`; this
extension MUST NOT diverge from it.

---

## 13. Build contract (`build.js`)

- `node build.js` validates required source files and copies them into `dist/`, esbuild-bundles
  `dig-provider.entry.mjs` → `dist/dig-provider.js`, esbuild-bundles `wallet-methods.mjs` into a
  self-contained ESM (inlining `@dignetwork/chia-provider` — browsers + MV3 SWs cannot resolve the
  bare specifier, so the raw re-export would break every consumer's module graph), esbuild-bundles
  `store-interceptor.entry.mjs` → `dist/store-interceptor.js` (a self-contained IIFE with the
  unit-tested `store-refs.mjs` inlined, since the opaque store frame can neither import a module nor
  fetch a cross-origin script — §5.3), vendors the WalletConnect SignClient into `dist/vendor/`,
  injects the build-time WalletConnect project id into `dist/wallet-wc.js`, injects the
  `package.json` version into the `__APP_VERSION__` placeholder of `popup.html` + `control.html`
  (§2.2), and emits `dist/agent-surface.json`.
- The bundled `dist/wallet-methods.mjs` MUST retain the same named exports and contain NO surviving
  bare `@dignetwork/*` import; the build fails loudly otherwise.
- `node build.js --zip` additionally produces a versioned `.zip` for distribution.
- `node build.js --json` emits one JSON result on stdout (machine mode), prose on stderr.
- Exit codes: `0` success · `2` a required source file is missing (validation) · `3` a build
  step failed (vendoring / artifact write).
- The build MUST fail if any required source file is missing. Absence of a WalletConnect
  project id MUST NOT fail the build (the options-page field remains the override).

---

## 14. Configuration reference

| Setting | Storage key / source | Default | Effect |
|---|---|---|---|
| Local dig-node host | `server.host` | `localhost:8080` | a local-alias host (`localhost`/`dig.local`) keeps the `dig.local`-first ladder; a genuinely custom host wins ENTIRELY over that ladder (§8.1) |
| Hosted RPC endpoint | `digRpcEndpoint` | `https://rpc.dig.net/` | fallback when no local node is reachable |
| Resolution on/off | popup (`toggleExtension`) | on | disables `chia://` resolution |
| WalletConnect project id | build-time env `WALLETCONNECT_PROJECT_ID` → `dist/wallet-wc.js`; options-page override | none | WalletConnect relay project id |
| Search engine | `updateSearchConfig` | DIG omnibox (`dig`) | omnibox/search config |

---

## 15. Security properties

- **Fail-closed crypto** — unverified WASM (SRI mismatch) refuses to run (§6).
- **No forged verification** — a failed/absent inclusion proof is never rendered as verified;
  a GCM-SIV tag failure is never rendered as content (§5, §6).
- **No leaked internals** — user-facing error copy never exposes crypto strings; the machine
  code is separate (§9).
- **Per-origin wallet consent** — no site gets wallet access without explicit popup approval;
  the WalletConnect session lives in the popup page (needs IndexedDB + a long-lived relay
  socket an MV3 SW cannot hold) and the SW brokers each request to it (§7.3, §12).
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
