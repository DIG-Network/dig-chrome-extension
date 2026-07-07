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
  `rpc.dig.net`/`*.dig.net`/`coinset.org`, the CAT price + token-metadata host `api.dexie.space`, and
  `api.bugreport.dig.net`), `frame-src 'self' https:` (the in-window
  dApp app-view frames curated store `link`s over https, §2.4a), `font-src 'self'` (the vendored Space
  Grotesk / Space Mono woff2), and `img-src 'self' data: https:` (any HTTPS host — the native
  dApp-launcher icons §2.4, the auto-discovered CAT token icons §18.6, and remote NFT art §18.11).
  An `<img>` load cannot execute script, so allowing arbitrary HTTPS image hosts is not a
  script-injection risk; the tradeoff is PRIVACY (the image host observes the requester's IP), which
  §18.11 documents and which every other NFT wallet (Sage included) accepts by rendering art by
  default.
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
  CAT price + token-metadata host (`api.dexie.space`), the CAT icon host (`icons.dexie.space`, §18.6),
  the bug-report service (`api.bugreport.dig.net`), and the
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
  switching screens plays a mobile-OS app-open transition. **The popup body never scrolls
  horizontally** (§6.6, #163): content fits the fixed 372px shell; a wide inner control (e.g. the
  wallet's segmented view switcher) scrolls WITHIN itself (`overflow-x: auto` on that control alone)
  instead of widening `.dig-main`/`[data-testid="popup-root"]`.
- **`app.html`** → `App surface="fullpage"` — a **tablet/desktop-OS**: the SAME app + route tree in
  the expanded sidebar-rail layout at ≥960px (a wider multi-column widget board), degrading to the
  compact phone in a narrow window (`useLayoutMode`).

The nav is an **ARIA `tablist` of four screens** (`src/app/tabs.ts` is the source of truth for the
set, order, default, and hash deep-link) following the Fable **Home · Wallet · Apps · Network**
grouping; the **default landing is Home**. Every surface stays reachable:

0. **Home** (default landing) — the mobile-OS launcher above the nav: a glanceable wallet-balance
   widget (→ Wallet) — a **$ ⇄ XCH swap button** beside it flips which unit is prominent, the other
   shown small underneath (§18.13a) — Send · Receive · Trade quick-action tiles (→ the wallet on the
   right sub-view), the native dApp launcher grid (§2.4, first N + "see all" → Apps), and status
   widgets (lock state, local-node/gateway status → Network, a recent-activity peek → the ledger).
   Four states drive the launcher; the wallet widgets degrade gracefully when the wallet is
   locked/absent.
1. **Wallet** — the **self-custody wallet** (§18) and the ONLY wallet path: the extension holds its
   own key, so there is no WalletConnect/Sage pairing. The `CustodyGate` lands first on the SW's
   authoritative lock state — no wallet → onboarding (create / import a 24-word phrase), locked →
   unlock, unlocked → the custody wallet body, a segmented control over:
   - **Assets** — portfolio hero (the XCH balance + an honest "fiat unavailable" `≈ $—`; no
     fabricated fiat/delta), a Send · Receive · Address-book action bar, and the assets list (XCH +
     `$DIG` + each tracked CAT) from the offscreen HD balance scan (`getCustodyBalances`, both HD
     schemes). Send/Receive/Contacts/Manage-tokens/Coins each open as their OWN screen (§2.1a
     `ViewHeader`) reached from the action bar — **Receive is its own dedicated screen** (#166): its
     sticky header + QR/address are the WHOLE body (no asset/CAT list shares it), so the QR/address
     are reachable with zero scrolling regardless of how many CATs the wallet holds. Tracked CATs
     persist in `chrome.storage.local` `wallet.watchedCats` (`wallet-assets.mjs`).
   - **Activity** — the LOCAL transaction log (MetaMask-style, NOT an on-chain scan) the extension
     writes to as it acts (`getActivity`; §18.9).
   - **Trade** — make / take / cancel a `offer1…` string, built + signed in the offscreen vault
     (`makeOffer` / `inspectOffer` / `prepareTrade` / `confirmTrade`; §18.10). A BASIC
     currency-for-currency maker/taker renders on BOTH surfaces (#169); only offering one of the
     wallet's own NFTs (the give-kind toggle, §94) is fullscreen-only.
   - **Collectibles** — the wallet's NFTs, discovered + transferred via the vault (§18.11).
   - **Identity** — the wallet's DIDs (§18.17). **This segmented-tab ENTRY is fullscreen-only**
     (`walletViewsForSurface`, `src/app/tabs.ts`, #163): Identity/DID management is ADVANCED (§145),
     so the compact popup's segmented control renders `Assets | Activity | Trade | Collectibles`
     only — it never shows an "Identity" tab. The DID list remains reachable view-only on the
     popup via a direct `#wallet/did` deep-link (the panel itself is unaffected — only its tab
     entry is gated); the fullscreen segmented control always shows all five views.
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

### 2.1a `ViewHeader` — sticky top header for screen-style sub-views (#166)

Every "screen"-style sub-view reached from a tab body (Send, Receive, the address book, Manage
tokens, Coin control, NFT/DID detail, Trade offers) renders a shared `ViewHeader`
(`src/components/ViewHeader.tsx`, class `.dig-view-header`) as the FIRST element of the view,
`position: sticky; top: 0` relative to `.dig-main` (the extension's ONE scrollable region, §2.1).
This keeps the back/close affordance reachable at ANY scroll position instead of it being pushed
below the fold at the bottom of a growable body (a long form, a coin picker, an offer summary) — the
#166 fix. Contract:

- `ViewHeader` takes an optional `title` (rendered as an `<h2>`, with a `titleId` a wrapping
  `<section aria-labelledby>` can reference) and an optional `onBack` + `backLabel` (the caller's own
  translated copy/id — e.g. `nft.detail.back`, `send.cancel` — so it renders through the caller's own
  `FormattedMessage`, not a new generic string). Omitting `onBack` renders a title-only bar.
- **Placement contract:** `ViewHeader` renders OUTSIDE/ABOVE the view's own bordered `.dig-card`
  content (never nested inside it) — nesting it inside a rounded/bordered card would visually clip
  the sticky strip against the card's background once it pins mid-scroll.
- **Back-target semantics for multi-phase flows** (Send, Coin control): the header's back action
  steps UP one level — mid-review it returns to the form (mirrors the flow's own "back" link); it is
  ABSENT while a spend is actively broadcasting (`'sending'` phase — no back mid-transaction); at
  every other phase it closes the whole screen. A phase's own bottom "Done"/"Retry" CTA is a
  separate, unrelated action (dismiss/retry), not a back affordance.
- Adopted in: `SendPanel`, `ReceiveView`, `ContactsManager`, `ManageTokens`, `CoinControlPanel`,
  `TradePanel` (both the compact and full-surface branches), `NftDetail`, `DidDetail`.

### 2.1b Home screen — open by URN or chia:// (#172)

The mobile-OS Home screen (§2.1) carries a compact "open a chia:// address or DIG URN" input
(`OpenByUrnInput`, `src/features/home/OpenByUrnInput.tsx`) — a labeled text field + a "Go"
enter-to-submit action, rendered in both the popup and fullscreen surfaces.

- **Validation (shape only, no fetch).** On submit the typed value is parsed by the single shared
  `parseURN` (§4) — the SAME parser every other entry point uses, no second copy. Empty/whitespace
  input is a silent no-op; a non-empty value that fails to parse shows an inline, translated error
  (`home.open.error.invalid`) and does NOT navigate.
- **Render-target decision.** A valid parse is handed to `resolveOpenTarget`
  (`src/lib/open-urn.ts`), which reads the ONE shared dig-dns availability signal (§8.5's
  `getDigDnsStatus` — this input NEVER probes dig-dns itself) and branches:
  1. **dig-dns reachable** (`phase` is `direct` or `proxy` — the proxy self-heal fallback counts
     too) → navigate the active tab to the native `.dig`-scheme URL (§4.5): a real, portable,
     bookmarkable address the OS resolves machine-wide.
  2. **dig-dns unreachable** (`phase: 'unavailable'`, or no signal read yet) → hand the canonical
     `chia://` form (`buildDigUrl`, §5.3) to the background `navigateToDigUrl` action, which
     redirects the SAME active tab to `dig-viewer.html` — the extension's own chrome-extension://
     content view (the branded-loader page): the existing §8 node-ladder read (dig-node →
     rpc.dig.net), verified + decrypted, rendered in-page. Never a new tab; never the resource's own
     origin.
- Both outcomes navigate the CURRENT active tab (mirrors the Resolver tab's own `openUrl`, §8);
  from a real action popup this also closes the popup so the result is immediately visible.

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

### 2.4c Apps-tab personalization — reorder + hide/show (#164)

The Apps tab layers a LOCAL, per-device, non-authoritative view on top of the server-owned catalog
(§2.4): a custom display order + a hidden-app set, both keyed by app `slug`. The catalog itself is
never mutated or re-fetched differently because of this state — it is a pure view TRANSFORM applied
only in the success state, after the four-state branches (loading/error/empty/success) resolve.

- **Storage.** `chrome.storage.local` key `apps.personalization` → `{ order: string[], hidden:
  string[] }` (both arrays of `slug`). Read/written via the shared `useStorageValue` idiom (§18.4's
  pattern), so it converges across the popup and `app.html` via `storage.onChanged` exactly like every
  other durable client setting. Default (key absent) is `{ order: [], hidden: [] }` — catalog order,
  nothing hidden.
- **Reconciliation (catalog-churn safe).** On every read, `order`/`hidden` are reconciled against the
  LIVE catalog, never persisted-and-trusted blindly: an id in `order`/`hidden` no longer present in the
  catalog is dropped silently (no ghost entries, no crash); a catalog id present but absent from
  `order` (a brand-new app, or one that predates the user ever reordering) is appended at the END, in
  the catalog's own order, and defaults VISIBLE (absent from `hidden`). No migration step is ever
  needed when explore.dig.net adds or retires a dApp.
- **Reorder.** An "Edit" toggle (an icon-only control, `dig-iconbtn`, so the header row never risks
  popup horizontal overflow — §6.6/#163 — regardless of a locale's translated string length) puts the
  grid into edit mode: each tile becomes a native HTML5 drag source/drop target (pointer reorder) AND
  gains keyboard "move up" / "move down" controls (`aria-label`led per app, `disabled` at the
  respective edge) — reordering is NEVER mouse/drag-only. A completed move recomputes the full VISIBLE
  id sequence and persists it verbatim as `order` (so the next read's reconciliation is a no-op for
  every id that was already positioned). Each move is announced via a visually-hidden
  `role="status" aria-live="polite"` region (`"{name} moved to position {position} of {total}"`) for
  screen-reader users.
- **Hide / show.** In edit mode each tile also gets a "hide" control, which adds the app's `slug` to
  `hidden` (idempotent) and removes it from the main grid immediately. A "Show hidden (N)" disclosure
  appears whenever `hidden` is non-empty; expanding it lists the hidden apps with an "Unhide" action
  each, which removes the id from `hidden` (idempotent) — the app reappears in the grid at its prior
  `order` position if it had one, else appended at the end.
- **Pure core.** All of the above (parsing, the order/hidden reconciliation, the drag/keyboard move
  math, hide/show) is implemented as pure functions with no DOM/`chrome.*` dependency
  (`src/features/apps/personalization.ts`); the `usePersonalizedApps` hook is the thin
  `chrome.storage.local` seam over it (mirrors the `contacts.ts`/`useContacts` split, §18.14).

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

### 4.5 `.dig`-scheme host codec (`dig-dns-host.mjs`, #172)

A SEPARATE codec from §4.4 — `.dig`-scheme hosts (§8.5, dig-dns) use **lowercase RFC 4648 base32,
no padding**, not base36, matching `dig-dns`'s own Rust codec (`modules/apps/dig-dns/src/label.rs`)
byte-for-byte (proven by shared golden fixtures — the all-zero 32-byte id encodes to 52 lowercase
`a` characters on both sides). Base32 (not base36/base64) because a `.dig` host is a real DNS label:
DNS labels are case-insensitive and restricted to letters/digits/hyphen (LDH), and base32's
`a-z2-7` alphabet is all-LDH and survives case-folding, unlike base36 or base64.

- `storeHexToDigLabel(hex64)` / `digLabelToStoreHex(label)` map a 64-hex store/root id to/from its
  **52-character** base32 label (`DIG_LABEL_LENGTH`; `ceil(32*8/5) = 52`). Encoding rejects anything
  not exactly 64 hex characters; decoding rejects a label of the wrong length, a character outside
  `a-z2-7`, or a non-canonical encoding whose padding bits are non-zero (mirrors
  `data_encoding::BASE32_NOPAD`'s strictness on the Rust side) — case-insensitive (DNS 0x20
  tolerant).
- `buildDigSchemeUrl(parsedUrn)` (`src/lib/open-urn.ts`) builds the browsable address from a parsed
  URN (§4.3): `http://<storeLabel>.dig/<path>` for the store's latest capsule, or the pinned
  `http://<rootLabel>.<storeLabel>.dig/<path>` when the URN carries a `rootHash` — the pinned root
  label is LEFTMOST, matching dig-dns `host.rs`'s `HostTarget::Pinned` label order. An empty
  `resourceKey` renders as the bare path `/`.

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
`MESSAGE_PROTOCOL_VERSION` (currently `23`). Consumers MUST reference `ACTIONS.<name>` rather
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
(§18.12) — and made a user reject surface as CHIP-0002 `4002`. `14` (#91) added the coin-control
actions — `listCoins`, `prepareSplit`, `prepareCombine` (§18.15) — and an optional `coinIds` on
`prepareSend` to hand-pick the funding coins. `15` (#90) added the multi-wallet actions —
`listWallets`, `switchWallet`, `renameWallet`, `removeWallet` (§18.16). `16` (#92) added the NFT-mint
actions — `prepareNftMint` (build a new NFT — CHIP-0007 metadata + royalty) and `confirmNftMint`
(sign + broadcast, reusing the `confirmSend` path) (§18.11). `17` (#93) added the DID-management
actions — `listDids`, `prepareDidCreate` + `confirmDidCreate`, `prepareDidTransfer` +
`confirmDidTransfer`, `prepareDidProfileUpdate` + `confirmDidProfileUpdate`, and
`prepareNftDidAssign` + `confirmNftDidAssign` (every confirm action reuses the `confirmSend` path)
(§18.17). `19` (#165) replaced the multi-index gap-limit sweep with the single active-derivation-
index model: added `setActiveIndex` (navigate the active wallet's active HD index — prev/next/jump,
a pure SW registry op persisted per wallet) and an `activeIndex?: number` field (replacing the
retired `gapLimit`) on every derivation-touching request — `getReceiveAddress`,
`getCustodyBalances`, `getActivity`, `listNfts`, `listDids`, `listCoins`, `prepareSend`,
`prepareSplit`, `prepareCombine`, `prepareNftTransfer`, `prepareNftMint`, `prepareDidCreate`,
`prepareDidTransfer`, `prepareDidProfileUpdate`, `prepareNftDidAssign`, `makeOffer`,
`prepareTrade` — each of which now derives ONLY the active index's puzzle hashes. `getLockState`'s
response also gained `activeIndex` (§18.1a).

`MESSAGE_PROTOCOL_VERSION` `20` (#154) replaced `getActivity`'s on-chain reconstruction with the LOCAL
activity log (§18.9): its response dropped `cursorHeight` and each event's `height` field (BREAKING —
the response is now `{ events }` only, and each event carries `status:'pending'|'confirmed'` instead
of a block height) and its request no longer takes `watchedCats`/`sinceHeight` (a synchronous
`chrome.storage.local` read needs neither). `confirmSend` and `confirmTrade` additively gained an
optional `activityHint: { asset, amount, counterparty }` (the #154 hint captured at prepare time, so
the SW can log the action without any coinset round-trip).

`MESSAGE_PROTOCOL_VERSION` `21` (#175) added `getDigDnsStatus` — the shared dig-dns Path-B
availability signal (§8.5): reachability, the bound gateway port, the PAC URL, and whether the PAC
proxy is currently engaged. Purely additive — no existing action/shape changed.

`MESSAGE_PROTOCOL_VERSION` `22` (#152) added the clawback actions — `listClawbacks`,
`prepareClawbackAction`, `confirmClawbackAction` (§18.8a) — plus an optional `clawbackSeconds` on
`prepareSend` and an optional `clawbackInfo` on its response. Purely additive — no existing
action/shape changed.

`MESSAGE_PROTOCOL_VERSION` `23` (#171) added the Collectibles multi-select bulk actions —
`prepareNftBulkTransfer` + `confirmNftBulkTransfer` and `prepareNftBulkBurn` +
`confirmNftBulkBurn` (§18.11a) — each confirm reusing the `confirmSend` broadcast path. Purely
additive — no existing action/shape changed.

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
| `getDigDnsStatus` | The shared dig-dns Path-B availability signal (§8.5) — phase, bound port, PAC URL, whether the proxy is engaged. |
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
     `server.host`, default **9778** — the canonical dig-node control port, #132).

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
  out-of-range/absent port falling back to 9778. A value naming something other than a local
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

### 8.5 dig-dns Path-B proxy fallback (#175, Component C of #174)

`dig-dns` (a separate OS service, `modules/apps/dig-dns`, installed by dig-installer) gives the
machine `*.dig` browser resolution — `http://<storeId-as-base32>.dig/<path>` — through two
INDEPENDENT paths: **Path A** (OS split-DNS routes `.dig` → its loopback IP) and **Path B** (a PAC
proxy file routes `*.dig` requests to its gateway as an HTTP proxy, no DNS involved). This is
UNRELATED to the `chia://` read path (§4-§9 above) — dig-dns resolves plain `http://<label>.dig`
URLs a user types or clicks, entirely outside the extension's own content-loader pipeline. The
extension's ONLY role is making Path B self-healing so a `.dig` URL keeps loading even when Path A
is defeated (DNS-over-HTTPS, Chrome's built-in resolver, a `:80` port conflict on the machine).

**dig-dns's loopback control contract** (dig-dns SPEC.md §4.7 — the extension is a pure consumer,
no wire change on either side):

| Endpoint | Response | Purpose |
|---|---|---|
| `GET http://<loopbackIp>:<port>/.dig/resolve-probe` | `204 No Content` | Liveness — dig-dns's gateway is up and answering, on THIS port. |
| `GET http://<loopbackIp>:<port>/.dig/health` | `200` JSON `{status, version, bound_port, loopback_ip, tld, node, paths}` | The authoritative bound port (`:80` can fall back to `:8053`) + full status. |
| `GET http://<loopbackIp>:<port>/.dig/proxy.pac` | `200 application/x-ns-proxy-autoconfig` | The PAC file `chrome.proxy` is pointed at to engage Path B. |

`loopbackIp` defaults to `127.0.0.5` (`DIG_DNS_LOOPBACK_IP`); candidate ports are tried `[80, 8053]`
in order (`DIG_DNS_GATEWAY_PORTS`) — the exact fallback order dig-dns itself uses.

**The state machine** (`src/lib/dig-dns.ts`, `createDigDnsAvailabilityController`) — pure, no
`chrome.*`, every dependency (fetch, `chrome.proxy`, the clock) injected:

- **`unknown`** — no probe has run yet (a fresh SW / fresh controller).
- **`direct`** — dig-dns answered a probe; Path A is ASSUMED to be working; the PAC proxy is NOT
  engaged (engaging it preemptively would show Chrome's "an extension is managing your proxy
  settings" banner for no reason).
- **`proxy`** — dig-dns is reachable but a REAL `.dig` navigation errored (`reportNavigationError`,
  driven by the SW's `webNavigation.onErrorOccurred` for `.dig`-TLD hosts): the controller
  immediately calls `chrome.proxy.settings.set({value:{mode:'pac_script',pacScript:{url}}, scope:
  'regular'})` pointed at `/.dig/proxy.pac` on the confirmed bound port.
- **`unavailable`** — dig-dns itself is unreachable on every candidate port (not installed / not
  running). The proxy is NEVER engaged in this phase (a PAC pointed at a dead gateway would only
  break `.dig` traffic harder); any previously-engaged proxy is cleared.

**Self-healing recovery:** a single healthy probe only proves dig-dns's gateway process is alive —
it does NOT prove the OS actually routes `.dig` there again. So while `proxy`, the controller counts
consecutive healthy probes with no further navigation error; once that streak reaches
`DIG_DNS_RECOVERY_PROBE_THRESHOLD` (3), it clears the proxy and returns to `direct`, letting Path A
prove itself — re-engaging immediately (via the next `reportNavigationError`) if it is still
actually broken. A navigation error observed while already `proxy` resets the streak (still broken).

**On uninstall/disable:** Chrome itself reverts any `chrome.proxy.settings` an extension applied —
an extension-controlled `ChromeSetting` is discarded the moment the controlling extension is
unloaded — so the extension needs NO explicit uninstall hook; `dispose()` exists only for an
explicit/graceful teardown (tests, a future manual "turn off" control).

**The ONE shared availability signal.** The SW instantiates a SINGLE controller at module scope,
probes it on startup + a `chrome.alarms` interval (2 min), and feeds it
`webNavigation.onErrorOccurred` for `.dig` hosts. Every feature reads the SAME signal via
`ACTIONS.getDigDnsStatus` (never a per-feature probe) — the Resolver tab's "using proxy fallback"
indicator (§2's Resolver sub-view) AND #172's open-by-URN dig-dns-detect branch both consume this
one message action. A read triggers a FRESH probe when the cached snapshot is older than
`DIG_DNS_STATUS_REFRESH_MS` (5 s, `shouldRefreshDigDnsSnapshot`) instead of waiting out the full
2-minute alarm interval — e.g. right after the user just started dig-dns.

```
request:  { action: 'getDigDnsStatus' }
response: { phase: 'unknown'|'direct'|'proxy'|'unavailable', boundPort: number|null,
            pacUrl: string|null, loopbackIp: string, proxyActive: boolean,
            lastProbeAt: number|null, lastError: string|null }
```

**Manifest requirements:** the `proxy` permission (to call `chrome.proxy.settings`); `host_permissions`
covering `http://127.0.0.5/*` + `http://127.0.0.5:*/*` (loopback, so the SW's probe/health fetches
are not subject to CORS); and the `extension_pages` CSP `connect-src` includes `http://127.0.0.5:*`
(regression #122 pattern — a host fetched by the extension MUST be in BOTH `host_permissions` and
CSP `connect-src`, or the real browser silently blocks the request while unit tests, which mock
fetch, do not catch it).

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
| Local dig-node host | `server.host` | `localhost:9778` | a local-alias host (`localhost`/`dig.local`) keeps the `dig.local`-first ladder; a genuinely custom host wins ENTIRELY over that ladder (§8.1) |
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
- A wallet MUST derive and read BOTH the unhardened and the hardened path forms AT THE ACTIVE INDEX
  (§18.1a) — never only one scheme, which would make funds on the other scheme's addresses invisible.
- The extension MUST NOT use `dig-keystore`'s `L1WalletBls` sign path (it double-derives — a latent
  upstream inconsistency).
- Conformance is pinned by a golden parity fixture (`src/lib/keystore/derive.golden.json`) of the
  canonical all-zeros-entropy mnemonic (`abandon … art`): identical synthetic pubkey + puzzle hash +
  `xch1…` address across the extension, `dig-l1-wallet`, and Sage, for BOTH schemes across MULTIPLE
  indexes. The fixture's BIP-39 seed equals the published all-zeros test vector (`408b285c…80840`),
  anchoring the chain to a public vector.

### 18.1a Single active derivation index (#165 — normative wallet-scan model)

The browser wallet operates on **ONE HD derivation index at a time** — the ACTIVE index (default 0)
— with **prev/next** (+ jump-to-index) to switch it. This is the canonical scan model for every
wallet view; the extension MUST NOT perform a multi-index gap-limit sweep anywhere.

- **What "active index" means.** All derivation-touching reads/writes — balance scan, CAT/NFT/DID
  discovery, activity indexing, the receive address, coin listing, and send/coin-control — derive
  puzzle hashes for ONLY the active index, both HD schemes (§18.1): a fixed set of exactly 2 puzzle
  hashes (unhardened + hardened at that one index), never a range of indexes. One cheap coinset query
  replaces a `gap-limit × 2-scheme` sweep.
- **Why (browser performance, #148/#154).** Full multi-index HD scanning (both schemes across a gap
  limit, e.g. 20 × 2 = 40 candidate addresses) is too intensive for a browser wallet — it was the
  root cause of the wallet's load/timeout problems. Scoping every op to a single, tiny, fixed
  address set makes every wallet read a single fast coinset round-trip.
- **Navigation.** `setActiveIndex` (§7) sets the ACTIVE wallet's active index to an absolute,
  non-negative value (clamped; the UI computes prev = current−1, next = current+1, or an explicit
  jump target). It is a PURE SW registry op — no vault round-trip, no key material involved — that
  drops the balance cache (scoped to the previous index — also the #154 receive-delta baseline, §18.9)
  and returns the persisted value. The LOCAL activity log (§18.9) is NOT dropped — it is durable
  history keyed per wallet+index, so navigating back to a prior index reads exactly that index's own
  log again. Every index-scoped RTK Query view (balances, activity, receive address, collectibles,
  coins) re-reads for the newly-active index, mirroring exactly how a wallet switch (§18.16)
  invalidates. On
  a CONFIRMED index change the whole RTK Query cache is also reset (`api.util.resetApiState()`, #162)
  — the same cache-reset behavior a wallet switch gets (§18.16), so no view can keep showing a stale
  value for the previous index while the new one loads.
- **Persistence.** The active index is persisted PER WALLET (`WalletEntry.activeIndex` in the
  registry, §18.16) — switching wallets restores each wallet's own place; a fresh wallet starts at 0.
- **Send / receive.** A send spends from the active index's coins; change returns to the active
  index's own (unhardened) address. The receive address shown is always the active index's
  unhardened address — navigating the index changes which address Receive shows.
- **Coin control (#91).** `prepareSplit` sends every output piece to the ACTIVE index's own address
  (never to other indexes, which the single-active-index model could then not see) with
  pairwise-DISTINCT amounts (consecutive integers plus a strictly-larger final piece absorbing the
  remainder) so same-address, same-amount `CREATE_COIN` collisions never occur — this removes any
  ceiling on split-piece count (previously bounded by how many addresses a gap-limit derivation
  produced).
- **This is EXTENSION-SPECIFIC.** The hub's full-HD-scan rule (hub backend, badge/DIG detection)
  scans ALL HD addresses both ways — that rule is UNCHANGED and applies to a different client with a
  different performance budget (a server, not a browser tab). The two models are not in conflict:
  each client uses the scan depth appropriate to where it runs.
- **Retired.** The prior multi-index `gapLimit`-sized sweep (`SCAN_GAP_LIMIT`, a fixed 20-per-scheme
  window) is removed from every scan/prepare op (§7 `MESSAGE_PROTOCOL_VERSION` `19`); a configurable
  scan-index-count setting (a superseded proposal) is INTENTIONALLY not built — there is no range to
  size once the model derives exactly one index.

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
- **unlock window (idle TTL, #155).** A NON-SECRET expiry timestamp is stored in
  `chrome.storage.session` (`wallet.unlockExpiry`) — never key material. Default TTL 15 minutes
  (a MetaMask-style idle default), clamped to 1–60, from `wallet.settings.unlockTtlMinutes`
  (user-configurable in Settings → the wallet's "advanced" section, alongside the chain-node
  override). "Unlocked for the session" means unlocked for as long as the wallet is ACTIVELY used,
  not merely for a fixed span from the original unlock: `isSessionRenewingAction` (pure,
  `src/lib/custody-session.ts`) classifies every custody action except the passive `getLockState`
  read and the explicit `lockWallet` as activity, and `handleCustodyAction` (the SW dispatcher, one
  layer above the action switch) re-arms the window (`startUnlockWindow()`) after any such action
  IF the wallet was already unlocked when the request arrived. Reopening the popup or fullscreen
  page — which reads state via `getLockState` — therefore never itself extends a session, but any
  real interaction (viewing balances/activity, sending, switching wallets, …) does. Opening the
  popup/fullscreen while a window is still fresh never re-prompts (§18.5's `getLockState`-driven
  gate resolves straight to the wallet); only a genuinely idle wallet or an explicit Lock re-prompts.
  The renewal is a compare-and-swap (`shouldApplyRenewal`, pure), not an unconditional write: the
  expiry observed when the action STARTED is captured, and the window is re-armed only if that SAME
  value is still current once the action finishes. This closes a real race — a slower renewing call
  (e.g. a balance scan) that began while unlocked must NOT resurrect the session if an explicit
  `lockWallet` (or the TTL sweep) completed while it was still in flight; an explicit lock always
  wins over an in-flight activity call.
- **auto-lock triggers (all lock the vault + clear the window):** explicit lock (the wallet
  switcher's Lock control, `wallet-lock`, reachable from both popup and fullscreen); a
  `chrome.alarms` minute sweep once the TTL lapses with no renewing activity; `chrome.idle`
  reporting `idle`/`locked`; all-windows-close (the offscreen document tears down, dropping the
  in-memory key).
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
| `wallet.registry` | `storage.local` | encrypted only | the multi-wallet registry (§18.16) — an array of `{ id, label, record (DIGWX1, §18.2), createdAt }`, one encrypted record per wallet |
| `wallet.keystore` | `storage.local` | encrypted only | the ACTIVE wallet's DIGWX1 record (§18.2) — a mirror of the active registry entry, so every single-wallet read path keeps working; the only at-rest secret alongside the registry |
| `wallet.activeId` | `storage.local` | no | active wallet id (multi-wallet switcher, §18.16) |
| `wallet.settings` | `storage.local` | no | durable settings (`unlockTtlMinutes`, `chainRpcUrl`, `chainPrivacyAck`, fee default…) |
| `walletCache.balances` | `storage.local` | no | last balance scan (`{ balances, at }`) for cached-first paint AND the #154 receive-delta baseline (§18.9); cleared on wallet/index switch |
| `wallet.activityLog` | `storage.local` | no | the #154 LOCAL activity log (§18.9) — `{ "<walletId>:<index>": LocalActivityEntry[] }`, ring-buffered at 200/scope; durable history, NEVER cleared on switch |
| `wallet.contacts` | `storage.local` | no | address book (§18.14) — array of `{ id, label, address, note?, createdAt, updatedAt }` |
| `wallet.recentRecipients` | `storage.local` | no | recent send recipients (§18.14) — newest-first `{ address, lastUsedAt }`, capped |
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

### 18.5a Background prefetch on unlock / index-switch (#168)

As soon as the wallet is UNLOCKED — and again whenever the active wallet or active derivation index
changes while unlocked (#90, §18.1a, §18.16) — the app shell proactively warms the RTK Query cache
for the views a user is most likely to open next, instead of waiting for each view to mount and fetch
lazily. This is a PERFORMANCE prefetch only; it changes when a read fires, never what is read or how
many indexes it covers.

- **Where it runs.** There is no persistent background page that can hold React/RTK Query state
  (§2.1) — the client-side authority for "should I warm the cache" is the app shell (`Shell` in
  `App.tsx`), mounted once per page (`popup.html` and `app.html` alike) for the lifetime of that page,
  regardless of which tab/segmented-view is currently showing. This matters because the mobile-OS Home
  tab (§2.1) never mounts the wallet body at all, and Collectibles (§18.11) isn't mounted until its
  segmented tab is picked — a per-view fetch alone cannot get ahead of navigation to either.
- **Trigger.** A prefetch round starts when `getLockState` (§7) reports `lockState:'unlocked'` for a
  (walletId, activeIndex) pair the shell has not already warmed. Locking (or the wallet never having
  been unlocked) resets that memory, so the NEXT unlock — even of the exact same wallet+index — runs a
  fresh round (the caches were just invalidated by the lock).
- **Order.** Four calls fire strictly IN SEQUENCE, each awaited before the next starts (never a burst):
  `getCustodyBalances` (§18.6) → `getCatRegistry` (the CAT/token-metadata registry, §18.6) →
  `listNfts` (§18.11) → `getActivity` (the LOCAL activity log, §18.9) — likely-first-viewed first.
  Every RTK Query view that later mounts (`useGetCustodyBalancesQuery`, `useListCollectiblesQuery`,
  `useGetCustodyActivityQuery`, …) shares the SAME cache entry (same endpoint + same, argument-less
  query key) as the prefetch call, so it renders the already-fulfilled result immediately instead of
  issuing a second SW round-trip.
- **Single-index scope is structural (#165), not a runtime check.** None of the four calls above takes
  an index argument — the SW resolves the ACTIVE wallet's active derivation index itself (§18.1a) from
  the registry — so there is no parameter a prefetch round could vary to sweep multiple indexes even by
  accident. One context change is exactly one round of four calls, never a range.
- **Cancellable; no stale writes.** A wallet switch or index navigation (§18.1a, §18.16) starts a NEW
  round for the new context and must not let a slow, now-stale round from the PREVIOUS context land its
  result under the new identity. Two mechanisms combine to guarantee this (the same compare-and-swap
  discipline §18.3's auto-lock renewal window uses):
  1. A generation counter is bumped on every new context; the sequence re-checks it before EVERY one of
     the four steps and stops issuing further steps the instant it is stale — a switch mid-round means
     the remaining, not-yet-started steps for the old context never fire (no needless coinset calls for
     a context the user already left).
  2. A step ALREADY in flight when the switch happens can still resolve afterward — this cannot be
     aborted over the `chrome.runtime.sendMessage` transport (no abort signal). That is safe because
     every wallet/index-switch mutation already resets the WHOLE RTK Query cache on success
     (`resetCacheOnIdentityChange`, §18.16/§18.1a) before the new round is even computed, and RTK Query
     only ever applies a fulfilled result to a cache entry that still exists — so the late write becomes
     a no-op instead of corrupting the new identity's view.
- **Loading ≠ unavailable (#158) still holds.** A view opened BEFORE its prefetch round lands still
  renders its normal loading state (the query is genuinely pending, not yet fulfilled) — this section
  only changes WHEN the fetch is kicked off, never the view's own four-state rendering contract (§2.2).
- **A step's own failure never blocks the others.** A failed/offline balance scan does not prevent the
  collectibles or activity steps from running — each step is independent best-effort priming, not a
  pipeline with hard dependencies.

### 18.6 Balance scan, CAT auto-discovery & token metadata

Read-only balances come from an HD scan run in the offscreen vault (it has the key + the wasm):

- **Derivation + scan.** Derive standard p2 puzzle hashes for BOTH schemes (§18.1) AT THE ACTIVE
  INDEX (§18.1a), then sum UNSPENT coins from coinset: native XCH at those hashes. Balances reflect
  ONLY the active index.
- **CAT auto-discovery (MUST).** The wallet surfaces EVERY CAT it holds WITHOUT a watch list, by
  hinted-coin lineage reconstruction (the same mechanism as NFT discovery §18.11): find the coins
  HINTED to the derived inner p2 hashes (`get_coin_records_by_hints`, both schemes), fetch each
  candidate's PARENT spend, `Puzzle.parseChildCats(parentCoin, parentSolution)`, and keep a coin iff a
  reconstructed child IS that coin and its `info.p2PuzzleHash` is one of the wallet's derived hashes;
  its `info.assetId` is the TAIL. Held amount is aggregated per TAIL. The coinset fan-out is
  bounded-concurrency (~4) with per-read retry+backoff (coinset degrades under parallelism).
- **Watched / built-in override.** A manual watch list (`wallet.watchedCats`) and the built-in $DIG
  TAIL are additionally queried DIRECTLY at their CAT puzzle hash (`catPuzzleHash(tail, innerPh)`) —
  an explicit override that also surfaces a zero-balance token or one held only as un-hinted change
  (which hint discovery can miss). Discovered ∪ watched, minus the user's HIDDEN set
  (`wallet.hiddenCats`), form the token list; hiding suppresses a row only (never forgets coins).
- **Token metadata.** Each discovered TAIL resolves to a human name/ticker/icon/decimals from a public
  CAT registry — dexie's swap-token list `GET https://api.dexie.space/v1/swap/tokens`
  (`{ tokens:[{ id, name, code, denom, icon }] }`; `icon` on `icons.dexie.space`). Matching is by TAIL:
  the registry response and every discovered/watched asset id are both normalized (lowercased,
  `0x`-stripped, validated 64-hex) before lookup, so case/prefix differences never cause a false miss.
  The registry is fetched DIRECTLY over HTTPS (not the SW seam) and cached with a LONG TTL (≈6 h — it
  changes slowly, unlike the 120 s price feed). A TAIL absent from the registry (or a registry fetch
  failure, or the registry not yet loaded) degrades gracefully to a short-form TAIL name + generic
  `CAT` ticker + monogram badge; the holding still lists — never a blank/broken row. $DIG keeps its
  canonical `$DIG` branding regardless of the registry (only its icon is borrowed). This is the ONE
  registry resolution every CAT-ticker display in the extension MUST consume — the Assets list
  (`custodyAssetBalances`) and the Activity ledger (§18.9) both resolve through it, so a token's ticker
  is consistent everywhere it appears (#151 fixed a regression where Activity bypassed this registry
  entirely and showed a hardcoded generic ticker).
- **XCH icon (#161).** The dexie registry is CAT-only, so the native coin has no registry `iconUrl`.
  XCH is given a dedicated, BUNDLED icon — the standard Chia Network leaf mark (`src/assets/chia-leaf.png`,
  sourced from Chia Network's own site assets, not hand-drawn) shipped in the extension bundle so it
  renders fully offline with no external fetch (unlike CAT icons, which load from
  `icons.dexie.space`). `custodyAssetBalances` sets it directly on the XCH descriptor, so XCH never
  falls back to the `AssetBadge` monogram.
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
- **Receive.** The receive address is the ACTIVE index's unhardened address (§18.1a,
  `getReceiveAddress`) — navigating the index changes which address Receive shows. Since one address
  serves every asset (XCH, `$DIG`, every CAT), the Receive screen needs no per-asset selector (§2.1a)
  — it shows that single QR/address, full stop.

### 18.6a Assets list — value ordering + live filter (#167)

The Home Assets list is a VIEW transform over `custodyAssetBalances` (§18.6) — it never changes the
scan/discovery, only how the resolved rows are ordered and which of them are shown:

- **Ordering (`orderAssetsByValue`).** XCH is the hero/prominent row (`pickHeroBalance`) and always
  renders first, unmoved. Every other row — the built-in $DIG row + discovered/watched CATs — sorts
  beneath it, highest value first, in two tiers:
  1. Rows with a KNOWN USD value (`assetUsdValue`, §18.13 pricing) sort by that value, descending.
  2. Rows with NO known price sort after every priced row: a "known" token ($DIG, or a CAT whose
     ticker resolved via the registry — i.e. NOT the generic `CAT` fallback, §18.6) outranks a
     generic-unknown one, then within a tier by held amount (normalized by decimals), descending. A
     null/unknown balance sorts last within its tier. Ties preserve the original discovery order
     (a stable sort) — never a re-shuffle on every render for equal-value rows.
- **Live filter (`filterAssetsByQuery` + `AssetFilterField`).** A search field renders directly above
  the token rows (below the pinned XCH row): it narrows the $DIG + CAT rows live by a case-insensitive
  substring match against EITHER the ticker or the display name; XCH itself is never filtered out. A
  blank query shows every row unchanged; a query matching nothing shows a dedicated empty-state line
  (`wallet.assets.filter.empty`) rather than silently rendering nothing — Clear restores the full list.
- **Autocomplete (`assetAutocompleteSuggestions`).** The filter field's native `<datalist>` suggests
  candidates from BOTH the currently-held rows AND the full known-CAT registry (so a recognized
  name/ticker not currently held still autocompletes — filtering on it then honestly shows the empty
  state, never a silent no-op). Deduped by ticker (a held row wins over a registry duplicate), a
  prefix match ranks above a mere substring match, capped to 8 suggestions.
- **Scope.** Every other consumer of `custodyAssetBalances` (`SendPanel`'s asset picker,
  `ManageTokens`, `CoinControlPanel`, `TradePanel`) receives the UNSORTED, UNFILTERED array — this
  ordering/filtering is local to the Home Assets list's own render.

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

### 18.8a Clawback — send with a reclaimable timelock (#152)

`prepareSend` accepts an optional `clawbackSeconds` (an ABSOLUTE unix timestamp, XCH only — a CAT
send with `clawbackSeconds` is rejected `BAD_REQUEST`): instead of a plain send, the built
CREATE_COIN targets the `chia-wallet-sdk-wasm` `ClawbackV2` puzzle hash (constructed
`new ClawbackV2(senderPuzzleHash, receiverPuzzleHash, seconds, amount, hinted:false)` — a REAL
public constructor, unlike the `RpcClient.new(...)`-only factory pattern, #148) with memos
`[receiverPuzzleHash, clawback.memo(clvm)]` attached to the CREATE_COIN — built against the SAME
`Clvm` instance the send driver allocates internally (`send.ts`'s `buildMemos` hook), matching the
memo shape `xch-dev/sage`'s reference wallet uses (`sage-wallet/src/wallet/xch.rs` +
`child_kind.rs`) so the coin is byte-compatible with any wallet implementing the same puzzle.
`senderPuzzleHash` is always the ACTIVE index's own (unhardened) puzzle hash — the same one
`changePuzzleHash` uses.

**Hard on-chain cutover — NOT a race.** Proven against the wasm Simulator (`clawback.test.ts`):
STRICTLY BEFORE `seconds`, only the SENDER's key can spend the locked coin (`senderSpend`,
`ASSERT_BEFORE_SECONDS_ABSOLUTE`-gated) — this is the CLAW BACK path. AT/AFTER `seconds`, only the
RECEIVER's key can (`receiverSpend`, `ASSERT_SECONDS_ABSOLUTE`-gated) — this is the CLAIM path.
There is no window where both are simultaneously valid; a claim broadcast before the deadline, or a
claw-back broadcast at/after it, is rejected by consensus
(`AssertSecondsAbsoluteFailed`/`AssertBeforeSecondsAbsoluteFailed`).

**Discovery.**
- **Outgoing** (this wallet's own clawback sends): the vault has no on-chain way to enumerate a
  wallet's past sends, so the caller supplies candidates from the LOCAL activity log's `clawback`
  field (§18.9) — the vault checks each against LIVE chain state
  (`findClawbackCoin` → `chain.unspentCoins([clawbackPuzzleHashHex])`, unique per
  sender/receiver/seconds/amount tuple) and reports back only those still actually pending.
- **Incoming** (clawbacks sent TO this wallet): `discoverIncomingClawbacks` hint-scans
  `chain.coinsByHints` at the ACTIVE index's own puzzle hashes (the memo's first entry is always the
  receiver's puzzle hash — exactly parallel to the CAT-lineage reconstruction, §18.8), fetches each
  hinted coin's PARENT spend (the memo lives on the parent's CREATE_COIN, not the coin itself), and
  reconstructs via `ClawbackV2.fromMemo(memo, receiverPuzzleHash, amount, hinted:false,
  expectedPuzzleHash)` — which VERIFIES the reconstruction against the coin's own on-chain puzzle
  hash, so a coin merely mentioning this wallet's address in an unrelated/forged memo is silently
  skipped, never trusted blind.

**Claim / claw back.** `prepareClawbackAction({ direction: 'claim'|'reclaim', clawbackInfo, fee })`
requires the ACTIVE index's keyring to own the relevant side (`receiverPuzzleHashHex` for claim,
`senderPuzzleHashHex` for reclaim — `MISSING_KEY` otherwise) and the coin to currently be pending
(`NO_CLAWBACK_COIN` otherwise). Builds directly via `Clvm.spendCoin` (not the `Spends`/`Action`
driver — there is exactly one, already-known coin/puzzle, no coin selection needed): a
`createCoin(actorOwnPuzzleHash, amount - fee)` (+ `reserveFee(fee)` when `fee > 0`) wrapped in
`standardSpend(actorPk, …)`, itself wrapped by `cb.receiverSpend(...)`/`cb.senderSpend(...)`. The
result carries a normal AGG_SIG_ME under the actor's synthetic key, so it signs via the SAME
`signing.ts`/`sendFlow.signAndBundle` used everywhere else — no bespoke signing path. Broadcasts via
the shared `confirmSend` path (`confirmClawbackAction` → vault op `confirmSend`).

**Surface tiering (#145).** Basic send stays in the popup unchanged; the clawback checkbox + window
picker (1h/1d/3d/7d presets) render ONLY in the fullscreen `SendPanel` (`full` prop). The pending-
clawback management list (`ClawbackPanel`, claim/claw-back actions) is fullscreen-only, reachable
from the Assets view's "Clawback pending (N)" link; the popup shows a lighter "N pending
clawback(s) — open full screen" hint instead of the management UI.

### 18.9 Activity — the LOCAL activity log (#154, MetaMask-style)

Activity is a LOCAL transaction log the extension writes to the moment IT performs an action —
**NOT** a reconstruction from an on-chain scan. (v1 reconstructed the ledger by fetching every coin
record, spent included, at the active index's puzzle hashes; that `includeSpent: true` full-history
scan grew unboundedly with a wallet's coin-history depth and could exceed the coinset per-request
timeout, leaving Activity permanently unable to load for a deep-history wallet — the root cause is
retired along with the scan itself, not patched.)

**Storage.** `chrome.storage.local[wallet.activityLog]` (`ACTIVITY_LOG_KEY`,
`src/lib/custody-session.ts`) is a flat map keyed `"<walletId>:<activeIndex>"` (§18.1a's single active
index — never a multi-index sweep) → that scope's own array of entries, newest-first, ring-buffered
at 200 per scope (`MAX_ACTIVITY_LOG_ENTRIES`, `src/lib/activity-log.ts`). Unlike the balance cache
(`walletCache.balances`), this key is durable history: it is NEVER cleared on a wallet switch or index
navigation (`clearActiveWalletCaches`) — per-wallet/index isolation comes from the composite key
alone, so switching back to a wallet/index later reads exactly the slice that scope wrote.

**Entry shape:** `{ id, kind, asset, amount, counterparty, coinId, timestamp, status, clawback? }` —
- `kind` ∈ `sent | received | mint | did | offer | trade | clawback | melt`. `sent` / `received` /
  `mint` / `did` / `trade` / `clawback` (#152) are EMITTED; `offer` (making one has no coin spent yet
  to poll for confirmation — the spend happens only if/when a counterparty takes it) and `melt` (no
  corresponding custody action yet) are reserved schema members the UI still renders correctly.
  `clawback` covers ONLY the sender's claw-back action (`confirmClawbackAction`, logged with
  `counterparty: null` — funds return to this wallet's own address either way); a send-WITH-clawback
  is logged as an ordinary `sent` entry (§18.8a — it's still fundamentally a send), and a receiver's
  claim is never logged explicitly — it surfaces for free via the receive-detection delta below once
  the claimed coin lands at the receiver's own address.
- `asset` is `'XCH'`, a CAT asset id (TAIL hex), or a synthetic `'NFT'`/`'DID'` label for a non-token
  spend (mint/DID actions carry no meaningful fungible amount).
- `clawback` (§18.8a) — present ONLY on a `sent` entry that used a clawback window:
  `{ senderPuzzleHashHex, receiverPuzzleHashHex, seconds, amount }`, the params the Clawback panel
  needs to recheck live chain state and later offer a claw-back.
- `status` is `pending` (logged the moment the extension broadcast the spend) or `confirmed` (the
  confirm-poll saw it on-chain); a `received` entry is logged straight to `confirmed` (a balance delta
  is already-settled by the time it's observed) with `coinId: null` (best-effort — no specific coin is
  attributed to a bare balance delta).

**Write path — an action performed BY the extension:**
- `confirmSend` / `confirmTrade` (the ONLY places a real spend broadcasts, §18.8/§18.10) return an
  `activityHint: { asset, amount, counterparty }` captured at the corresponding `prepareSend` /
  `prepareTrade` time (the counterparty is simply the user's own `recipient` input where one exists —
  no address re-derivation needed). Every action that reuses the shared `confirmSend` broadcast path
  (NFT transfer/mint, DID create/transfer/profile-update/assign) gets this back for free.
- `src/background/index.ts`'s case handlers log an entry (`logActivity`, `pending`) keyed by the
  action's OWN kind (`confirmSend`→`sent`, `confirmNftMint`→`mint`, every DID op→`did`,
  `confirmTrade`→`trade`) the moment the broadcast succeeds — EXCEPT the generic `confirmSend` case
  specifically skips logging when `activityHint.counterparty` is null, because `prepareSplit`/
  `prepareCombine` (coin control, §18.11) reuse that exact same broadcast path for a self-only spend
  that is not meaningfully any of the eight kinds.
- `sendStatus` (the existing confirm-poll, `coinConfirmed`) flips the matching entry (by `coinId`) from
  `pending` to `confirmed` the moment it reports `confirmed: true` — the ONLY place a logged entry
  transitions state after being written.

**Receive detection — balance-delta, not a scan.** `getCustodyBalances` already runs a balance scan
(§18.7) at the active index; #154 diffs its PRE-scan `walletCache.balances` snapshot against the
freshly-scanned one (`detectReceivedEntries`) and appends a `confirmed` `received` entry for every
asset whose held amount increased. No prior snapshot (right after a wallet/index switch cleared it) →
detection is skipped for that scan, which is exactly what prevents a wallet's PRE-EXISTING balance
from misreporting as a fresh "receive" the first time it's scanned after becoming active. A passive
receive while the extension is closed is caught, best-effort, by the delta on the NEXT scan — there is
no background scan while closed, and no incremental on-chain reconstruction.

**Read path.** `getActivity` is a synchronous `chrome.storage.local` read for the active wallet +
active index — no coinset round-trip, no cursor, no cached-vs-fresh distinction (the log itself always
IS the current state). This is why Activity now loads instantly regardless of a wallet's on-chain
history depth.

**Display ticker (MUST resolve through the registry, #151).** Each row's ticker/decimals resolve from
the entry's raw `asset` through the SAME §18.6 token-metadata path the Assets list uses: `XCH` is
fixed; the built-in $DIG TAIL keeps its canonical `$DIG` branding; the synthetic `NFT`/`DID` labels
render as whole-unit tickers (never through CAT decimal math); every other TAIL resolves against the
dexie registry (real ticker + decimals on a hit), degrading to the generic short-form fallback ONLY
when the registry has no entry (or hasn't loaded) — never a hardcoded/generic ticker for a token the
registry actually knows. A row's SpaceScan link is shown ONLY once `status === 'confirmed'` (a
still-pending or coinId-less coin may not resolve on the block explorer yet).

### 18.10 Trade offers

Offers are assembled from `chia-wallet-sdk-wasm` primitives to match the canonical `chia-sdk-driver`
offer construction byte-for-byte, so they interoperate with Sage / dexie. All money paths are proven
consensus-valid by a two-party simulator settlement test. v1 supports a SINGLE offered asset and a
SINGLE requested asset, each XCH or a CAT (covering every XCH↔token trade); v2 (#94) additionally
supports offering an NFT (selling a self-custody NFT for XCH/CAT), with CHIP-0011 royalty. The offered
and requested assets MUST differ.

- **Surface tiering (#169, refining #145).** A BASIC maker/taker renders on BOTH the compact popup
  AND fullscreen. Taking an offer has no advanced variant (accepting fixed, already-built terms is
  basic by nature) and is IDENTICAL on both surfaces. Making an offer is basic
  (currency-for-currency) on both surfaces too; only the ADVANCED capability — offering one of the
  wallet's own NFTs (the give-kind toggle) — is fullscreen (ExpandedLayout) ONLY. The popup keeps a
  persistent "open full screen" link (`trade-open-fullscreen`) for that and any future advanced
  option (multi-asset legs, fee tuning). This SUPERSEDES the earlier #145 rule that gated the
  entire Trade surface to fullscreen.
- **Guided review step (#169 clarity redesign).** Making an offer is a 3-step guided flow: **form**
  (pick give/get assets + amounts) → **review** (a "You give / You get" summary of the exact terms,
  computed locally — no network call yet) → **made** (the built `offer1…` deal card). The ONLY
  network call (`makeOffer`) happens on the review step's Confirm; Back returns to the form without
  losing the picks. Taking an offer already has an equivalent paste/drag → review (`TwoSided`,
  "You get" / "You pay") → confirm → broadcast flow from #94, unchanged by this redesign.
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
  offered legs (XCH from the real spends' CREATE_COINs to settlement; CATs via `offerSettlementCats`;
  an offered NFT via `parseChildNft` on each real spend, checking the child's p2 puzzle hash equals the
  settlement puzzle hash).
- **TAKE** (`prepareTrade` `take` → `confirmTrade`): add the offered settlement coins (the taker
  receives them) + the wallet's coins to fund the requested payments, apply the requested settle
  actions (`RequestedPayments::actions()` = `Action.settle(id, notarized_payment)` — which create the
  requested payments to the maker + the matching announcements), and concatenate the maker's REAL coin
  spends (phantoms dropped) with the taker's spends into one aggregated `SpendBundle`. The taker pays
  the network fee.
- **CANCEL** (`prepareTrade` `cancel` → `confirmTrade`): re-spend the maker's original offered coins
  back to self, invalidating the offer (its settlement coins can no longer be created). An offered NFT
  is re-fetched fresh (hint-scan) rather than reused from the never-broadcast offer spend.
- `prepareTrade` builds + signs but does NOT broadcast; the signed bundle is held under a pending id;
  `confirmTrade` is the ONLY place a trade is pushed (the user-approved step). Offers are mainnet-only
  (signed with the mainnet AGG_SIG_ME genesis).

**NFT offers + CHIP-0011 royalty (#94).** Offering an NFT (`{ kind: 'nft', launcherId }`, OFFERED side
only) works like offering XCH/CAT — the NFT is added to the `Spends` driver and sent to the settlement
puzzle — plus, when the NFT's on-chain `royaltyBasisPoints > 0`, the maker's spend ALSO carries
`Action.updateNft(nftId, [], TransferNftById(undefined, [TradePrice(requestedAmount,
requestedAssetSettlementPuzzleHash)]))` inserted BEFORE the claim `Action.send` — this is the CHIP-0011
"sale" signal; the NFT's ownership-layer transfer program (curried in at mint time) reacts to it by
emitting the royalty `AssertPuzzleAnnouncement` automatically (no hand-rolled puzzle logic). The taker
satisfies that assert with an EXTRA `Action.settle(requestedAssetId, royaltyNotarizedPayment)` where
`royaltyNotarizedPayment = NotarizedPayment(nftLauncherId, [Payment(royaltyPuzzleHash,
floor(tradePrice × royaltyBasisPoints ÷ 10000), memos:[royaltyPuzzleHash])])` — note the royalty
NotarizedPayment's nonce is the NFT's OWN launcher id, NOT the offer's `Offer::nonce`. Proven against
the wasm Simulator: taking an offer without the royalty payment is REJECTED with
`AssertPuzzleAnnouncementFailed` (offers.test.ts asserts this negative case explicitly, so the royalty
enforcement is proven real, not a test artifact).

**Scope limits (documented, not silent gaps).** (1) **DID is NOT an offer asset** — verified against
both the reference `chia-wallet-sdk` driver (`OfferCoins`/`RequestedPayments` in `offers/*.rs`) and
Sage wallet's offer builder: neither models a `dids` leg, a DID has no CHIP-0011-style royalty or
settlement-puzzle-hash convention any wallet's offer parser recognizes, and a hand-rolled "DID offer"
would produce an offer string NO OTHER WALLET could take — a capability-parity / interop dead end, so
it is not built. (2) **Requesting a SPECIFIC NFT** (buying, rather than selling) needs the maker to
know that NFT's full on-chain state up front (metadata/owner/royalty) to build its phantom carrier's
3-layer puzzle reveal — this needs a "read any NFT by launcher id" chain capability this wallet
doesn't have yet (only owned-NFT hint-scan); `makeOffer`/`takeOffer` reject a requested/fulfilled NFT
leg with `UNSUPPORTED_REQUEST` rather than mis-handling it silently. Both are tracked follow-ups.

**Accepting an offer — two input methods, on BOTH surfaces (§18.10, #169).** The Take flow accepts
an `offer1…` string via EITHER (a) pasting it into the text field, or (b) dragging-and-dropping an
`.offer`/text file containing it onto the dropzone (read via `FileReader.readAsText`, trimmed, then
fed into the SAME `inspectOffer` → review → `prepareTrade` → `confirmTrade` path as paste). Both
render identically on the compact popup and fullscreen (Take has no advanced variant, #169) and are
proven end-to-end in Playwright against the built extension pages (a real `DragEvent` carrying a
`DataTransfer` + `File`, and a filled textarea) — see `e2e/sw/trade-basic-surfaces.spec.ts` for the
popup path and `e2e/sw/offers.spec.ts` for the vault-wiring guard clauses.

### 18.11 NFTs / Collectibles

NFTs are read, minted, and transferred from `chia-wallet-sdk-wasm` primitives so the spends match the
canonical `chia-sdk-driver` construction byte-for-byte (they interoperate with Sage / dexie). Both money
paths are proven consensus-valid by Simulator tests (mint → list → transfer → assert the NFT moves and
the recipient can rediscover it; and mint → list → assert the minted NFT's metadata/royalty/owner). The
decrypted key never leaves the offscreen vault.

- **Discovery model.** An NFT is a singleton whose OUTER coin puzzle hash is the singleton/ownership
  puzzle — NOT the wallet's inner (p2/standard) puzzle hash — so it is NOT found by a puzzle-hash scan.
  The transfer that delivered it HINTS the recipient's inner p2 puzzle hash, so the wallet finds its NFT
  coins via coinset `get_coin_records_by_hints` over its derived inner puzzle hashes (both HD schemes
  AT THE ACTIVE INDEX, §18.1a). For each hinted unspent coin, the PARENT spend is fetched and
  `Puzzle.parseChildNft(parentCoin, parentSolution)` reconstructs the child `Nft` (parallel to
  `Puzzle.parseChildCats` for CATs). A coin is one of the wallet's NFTs iff the reconstructed child IS
  that coin and its `info.p2PuzzleHash` is one of the wallet's derived inner puzzle hashes.
- **LIST** (`listNfts`, read-only): returns, per NFT, `{ launcherId, coinId, p2PuzzleHash, collectionId
  (the current-owner DID hex, or null), editionNumber, editionTotal, royaltyBasisPoints,
  royaltyPuzzleHash, dataUris, dataHash, metadataUris, metadataHash, licenseUris }` — deduped by
  launcher id. `collectionId` groups NFTs minted under the same DID; the collectibles UI groups by it.
- **Image display (#150).** `nftImageSrc` (`src/features/collectibles/nftDisplay.ts`) resolves
  `dataUris[0]` to an `<img>`-embeddable source: an on-chain `data:` URI embeds as-is; a remote
  `http(s)` URI embeds directly (the `img-src 'self' data: https:` CSP, §2, allows any HTTPS host); a
  raw `ipfs://<cid>/<path>` URI is gateway-rewritten by `toGatewayUrl` to
  `https://ipfs.io/ipfs/<cid>/<path>` first, since browsers cannot dereference the `ipfs://` scheme
  directly. An unrecognized scheme (e.g. `ar://`) resolves to no image. `nftExternalImageUrl` offers
  the same (gateway-rewritten) URL as a "view image" link that opens the original in a normal browser
  tab. Both the Collectibles grid and the NFT detail view (`NftMedia`, `NftDetail.tsx`) render the
  resolved image through the local NFT image cache (#159, below) and fall back to a deterministic
  monogram tile if it never resolves (a dead gateway, a broken/missing URL, an offline host, or "no
  image at all") — the grid/detail never shows a broken-image icon.
- **Local NFT image cache (#159, `src/features/collectibles/nftImageCache.ts`).** A `data:` image
  passes through unchanged (already inline, no network cost). A remote (`http(s)`) image is served
  through `NftImageCache`, keyed by the resolved URL: a cache hit resolves to an object URL with NO
  network request; a miss loads the bytes, caches them, and resolves to a fresh object URL. NFT art is
  immutable per URI (an `ipfs://` CID's content never changes; a marketplace CDN URL for a minted NFT
  is likewise treated as content-addressed here), so URL-keyed caching needs no invalidation.
  - **Loaded via `<img crossOrigin="anonymous">` + canvas, NOT `fetch()`.** The manifest's
    `connect-src` CSP (§2) is a small explicit allowlist (rpc.dig.net, coinset, dexie, coingecko,
    bugreport) that deliberately excludes arbitrary NFT-art hosts, so a raw `fetch(url)` would be
    CSP-blocked for virtually every real NFT image host. `img-src` is already `https:` (any host,
    #150), so the cache loads through an `<img>` element + canvas (`canvas.toBlob()`) to stay inside
    the EXISTING CSP surface rather than widening `connect-src` to arbitrary hosts.
  - **Graceful CORS fallback.** `crossOrigin="anonymous"` requires the host to send
    `Access-Control-Allow-Origin`, or the browser refuses the load entirely. A load failure (CORS
    refusal, network error) does NOT fail closed to the monogram — it falls back to embedding the RAW
    remote URL directly (uncached, exactly the pre-#159 behavior), because a plain `<img src>` is not
    CORS-gated for display. A genuinely dead host still fails that raw `<img>` load and is caught by
    the existing `onerror` → monogram fallback.
  - **Bounded.** LRU eviction over an entry-count cap (200) AND a total-byte cap (50 MB) — the oldest
    (`lastAccessed`) entries evict first, tracked in a `chrome.storage.local` index kept alongside the
    Cache-API-stored bytes. A single file over 10 MB is never cached (skips straight to the
    graceful-fallback raw-URL path) so one huge asset can't dominate or blow past the caps.
  - **NOT the prohibited content cache** (`src/test/no-content-cache.test.ts`): that pins the absence
    of any cache for RESOLVED/DECRYPTED `chia://`/DIG-store content (caching that is the dig-node's
    job, #43/#41). This cache holds ordinary third-party image bytes referenced by on-chain NFT
    metadata — the same request category as the (still uncached) `icons.dexie.space` CAT icon fetches.
  **Privacy note:** loading a remote (non-`data:`) NFT image reveals the requester's IP address to the
  image host (an inherent property of fetching a URL — there is no way to preview remote art without
  contacting its host). This is the same tradeoff every NFT wallet that renders art by default accepts
  (Sage included); the extension does not currently gate it behind a settings toggle — a
  privacy-conscious opt-out ("render on-chain `data:` art only") is a tracked follow-up. The local
  image cache (#159) reduces this exposure in practice: once an image is cached, every later render
  (grid, detail, a reopened popup) is served from disk with NO further request to the art's host.
- **Image lightbox (#173).** On the NFT detail view only, `NftMedia`'s resolved hero image (never the
  monogram fallback) is wrapped in a click target (`enableLightbox` prop — the Collectibles grid tile
  does not set it, since its own wrapping tile button already opens the detail view) that opens
  `NftImageLightbox` (`src/features/collectibles/NftImageLightbox.tsx`): an XL modal showing the SAME
  already-resolved, already-cached (#159) image src fit-to-viewport (`max-width`/`max-height: 92vw`/
  `92vh`, `object-fit: contain`) with its aspect ratio preserved, centered on a dimmed backdrop — never
  a re-fetch. Accessible like the Send/Receive `Sheet`: `role="dialog"` + `aria-modal`, focus moves
  into the dialog on open and is restored to the trigger on close, Tab is trapped within the dialog,
  Escape closes, and a backdrop click closes (a click on the image itself does not). The entrance
  transition is skipped under `prefers-reduced-motion: reduce`.
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
- **MINT** (`prepareNftMint`, no broadcast — #92): build ONE new NFT owned by this wallet. The
  CHIP-0007 metadata (`NftMetadata`: editionNumber/editionTotal, dataUris + optional dataHash,
  metadataUris + optional metadataHash, licenseUris + optional licenseHash) is encoded via
  `Clvm.nftMetadata` in the driver's `Clvm` (same-allocator invariant), then
  `Action.mintNft(clvm, metadata, Constants.nftMetadataUpdaterDefaultHash(), royaltyPuzzleHash,
  royaltyBasisPoints, 1, undefined)` mints the singleton (amount `1`) funded from the wallet's XCH coins,
  with change AND the new NFT's inner p2 puzzle hash returning to index-0 (so the minter owns and can
  rediscover it). The royalty payout defaults to the minter's index-0 puzzle hash, or a caller-supplied
  bech32m address. A standard inner spend is inserted for each pending coin; the unsigned coin spends are
  held under a pending id with the decoded, tamper-resistant summary `{ launcherId, dataUris,
  metadataUris, licenseUris, editionNumber, editionTotal, royaltyBasisPoints, royaltyPuzzleHashHex, fee,
  coinCount }` and the new `launcherId`. A mint with no data URI is rejected `BAD_REQUEST`; a wallet with
  no XCH is rejected `NO_XCH_COINS`.
- **CONFIRM MINT** (`confirmNftMint`): signs + broadcasts the held mint — reusing the vault's
  `confirmSend` broadcast path (the ONLY place a mint is pushed); confirmation is polled via the shared
  `sendStatus`. Mainnet-only. Bulk/edition minting (many NFTs in one spend) is a follow-up (#99);
  assigning the new NFT to a DID owner at mint requires owning + co-spending that DID and is a follow-up
  with DID management (#93).

### 18.11a Collectibles multi-select — bulk transfer & destructive burn (#171)

The Collectibles grid supports selecting MULTIPLE NFTs at once and moving or destroying all of them in
ONE spend bundle (one broadcast, one aggregated signature) — the same discovery/reconstruction/
same-allocator rules as §18.11 apply to every selected NFT.

- **Fullscreen-only, mirroring mint/assign (§6.1/#145).** Selection mode (`CollectiblesPanel.tsx`)
  exists ONLY on the fullscreen surface — a "Select" control toggles it, tapping a tile in selection
  mode toggles membership instead of opening the detail view, and a selection bar shows the live count
  + select-all/clear + Transfer/Burn actions once ≥1 NFT is selected. The popup surface stays
  view-only: it NEVER enters selection mode, offering an "open full screen" link instead, exactly like
  the existing mint/assign popup affordances.
- **Bulk PREPARE** (`prepareNftBulkTransfer` / `prepareNftBulkBurn`, no broadcast): reconstruct EVERY
  selected NFT (by launcher id, deduped) in the SAME driver `Clvm`/`Spends`, add XCH coins for the fee
  once (not per NFT), then emit ONE `Action.send(Id.existing(launcherId), destPuzzleHash, 1, memo)` per
  NFT — all sharing the SAME destination and hint memo in this bulk op — before inserting a standard
  inner spend per pending coin. The unsigned coin spends are held under a pending id with the decoded
  summary `{ launcherIds, recipientPuzzleHashHex, fee, coinCount, isBurn }`. `launcherIds` MUST be
  non-empty (`NO_NFTS_SELECTED`); any selected NFT the wallet does not hold fails the WHOLE prepare
  (`NFT_NOT_FOUND`) — a bulk op either builds completely or not at all, never partially.
  - **Transfer**: `destPuzzleHash` is the caller-supplied recipient's address, decoded like a
    single-NFT transfer (`recipient` required, `BAD_REQUEST` otherwise).
  - **Burn**: `destPuzzleHash` is the FIXED well-known Chia burn puzzle hash (below) — never
    caller-supplied. `recipient` is not accepted/needed for a burn.
- **The well-known burn destination.** 30 zero bytes followed by `0xDE 0xAD` (`…dead`) — the same
  provably-unspendable puzzle hash every Chia wallet/explorer recognizes as "burned" (mainnet address
  `xch1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqm6ks6e8mvy`; see docs.chia.net's Chia-burn-address
  FAQ entry), NOT a DIG-specific invention. No known preimage produces this puzzle hash under any CLVM
  puzzle reveal, so a coin sent here can never be spent again by anyone, including the sender. Pinned
  as `NFT_BURN_PUZZLE_HASH` (`src/offscreen/nfts.ts`) and proven byte-identical to that exact address's
  decode in `nfts.test.ts`.
- **CONFIRM** (`confirmNftBulkTransfer` / `confirmNftBulkBurn`): signs + broadcasts the held bulk spend
  — reusing the vault's `confirmSend` broadcast path (the ONLY place either bundle is pushed);
  confirmation is polled via the shared `sendStatus`. Mainnet-only. `confirmNftBulkBurn` is
  IRREVERSIBLE once it broadcasts — the caller (the burn UI) MUST have already obtained the user's
  EXPLICIT, DISTINCT destructive confirmation before ever sending it (see below); the SW/vault never
  re-confirms and never invokes it automatically.
- **Destructive confirmation gate (UI, `BulkNftActions.tsx`).** The burn flow shows a permanent/
  cannot-be-undone warning naming the NFT count, then requires the user to TYPE the literal `BURN`
  into a confirmation field before "Review burn" becomes clickable — a stronger, harder-to-miss
  safeguard than a plain Yes/No step for an action with no undo. Only after that gate AND a second
  explicit "Confirm & burn" click on the review screen (which restates the destination as
  provably-unspendable + the fee) does `confirmNftBulkBurn` ever fire.
- **Activity log (§18.9 — `burn` kind, #171/#154).** A confirmed bulk transfer logs the existing `sent`
  kind (asset `'NFT'`, amount = NFT count, counterparty = the recipient). A confirmed bulk burn logs a
  DISTINCT `burn` kind (asset `'NFT'`, amount = NFT count, counterparty `null` — the burn destination
  has no spending key, so it is not a real "sent to" counterparty) so the ledger never conflates an
  irreversible burn with an ordinary transfer.

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

### 18.13a Home balance display-unit swap (#156)

The mobile-OS Home hero balance (§2.1 item 0) lets the user choose which unit is PROMINENT — `usd`
(the $ conversion) or `xch` (the native amount) — via a swap button beside the value; the other unit
renders small underneath. This is a per-device UI preference, distinct from the always-USD-when-known
Wallet-tab portfolio hero (§18.13).

- **Persistence.** `BalanceUnit = 'usd' | 'xch'`, default `'xch'` (the honest unit that never depends
  on a price feed), stored at `chrome.storage.local` key `wallet.homeBalanceUnit` via the same
  `useStorageValue` idiom as `wallet.watchedCats`/`wallet.hiddenCats` — read on mount, written on tap,
  live-synced across the popup/`app.html` via `storage.onChanged` (§3.4). An unrecognized/missing
  stored value falls back to the default rather than failing.
- **Conversion scope.** The USD side is the HERO ASSET's own value (`pickHeroBalance`'s pick — XCH
  when its balance is known, else the first asset with a known balance), not a multi-asset portfolio
  total: the prominent/secondary pair is always an honest native ⇄ fiat conversion of ONE balance.
- **Three states on the price-dependent slot** (the $ side — prominent in `usd` mode, secondary in
  `xch` mode; the native side never depends on price and is shown immediately):
  - **loading** (the price fetch has no cached data yet, and there IS a balance to price) — a
    shimmer skeleton on that slot; NEVER the word "unavailable" during this window.
  - **unavailable** (a price fetch error, a completed load with no usable price for the asset, or no
    balance to price at all) — the honest `wallet.portfolio.unavailable` note; in `usd` mode the
    prominent slot falls back to the native amount (never a broken `$—`).
  - **ready** — the real converted value.
- **Swap control.** A sibling icon button (`⇄`, `data-testid="home-balance-swap"`, aria-labelled via
  `wallet.balance.swapUnit`) beside the balance — NOT nested inside the balance's own tap target
  (which still opens the Wallet tab), so both remain independently keyboard/AT operable. Hidden when
  the wallet is locked/absent (nothing to swap).

### 18.14 Address book / contacts (#88)

The wallet keeps a local address book so a user picks a saved recipient instead of pasting a raw
`xch1…` string, and sees a recognizable name wherever a recipient is shown. Contacts are non-secret
CLIENT data stored in `chrome.storage.local` — never `storage.sync`, never the offscreen vault — and
are read live across the popup + `app.html` via `storage.onChanged` (§3.4). No new wasm and no chain
reads: the address book is pure client state. (Sibling #74 — address-poisoning defenses — builds its
lookalike-warning on this same store; the record shape is additive so #74 extends it without a migration.)

- **Records (`wallet.contacts`).** An array of `Contact = { id, label, address, note?, createdAt,
  updatedAt }`. `id` is a stable local id (`crypto.randomUUID`); `label` is a required, bounded
  (≤60 chars) display name; `address` is a normalized (trimmed + lowercased) `xch1…` bech32m string;
  `note` is optional, bounded (≤200 chars). Addresses are unique per book (a duplicate add/edit is
  rejected). All parsing is defensive — malformed stored entries are dropped, never trusted.
- **Address validity.** A contact address MUST satisfy the SAME `isChiaAddress` format gate the Send
  form uses (prefix + charset + minimum length), so the address book and the Send form never disagree
  about which strings are valid recipients. The authoritative bech32m decode still happens in the
  offscreen vault when a spend is built; the book stores the canonical string only.
- **Recent recipients (`wallet.recentRecipients`).** A newest-first, de-duplicated, capped
  (`MAX_RECENTS = 8`) list of `{ address, lastUsedAt }`, recorded when a Send broadcasts successfully.
  It surfaces recently-used addresses in the picker even before they are saved as contacts.
- **CRUD + manager.** A manager screen (reached from the wallet Home "Address book" action and from the
  Send picker's "Manage" link) adds, edits (inline), and deletes (two-step confirm) contacts, with an
  empty state and react-intl copy + per-field validation across the 14 locales.
- **Picker in Send.** The Send form offers a recipient picker (saved contacts + unsaved recents);
  choosing one fills the recipient address. When the entered recipient matches a saved contact, the
  form and the review step PREFER the label over the raw address (address shown as a muted subline).
  Trade is offer-based (make/take/cancel take an `offer1…` string, not a recipient address), so the
  picker does not apply there.
- **Add-on-send.** In the Send review step, when the recipient is a valid address that is NOT already
  saved, an inline "save this recipient" (name + Save) writes it to the address book without affecting
  the send itself.
- **Purity + tests.** All types + validation + CRUD-on-array + recent-tracking + the label lookup live
  in a pure `contacts` module (no DOM/`chrome.*`); the `useContacts` hook is the storage seam and the
  UI is thin glue. Unit tests cover the module + hook + components; an end-user Playwright e2e drives
  the built popup (add a contact, pick it in Send, add-on-send, edit/delete).

### 18.15 Coin control (#91)

The wallet gives the user visibility + control over their individual coins, built on the SAME
`Spends`/`Action` driver as Send (§18.8) — NO new spend type, NO new wasm. All of it runs in the
offscreen vault (it holds the seed) and is routed purely by `assetId` (undefined / `'xch'` = native
XCH; any other value = a CAT TAIL), guarding the #121 asset-drop class. Split/combine are proven
consensus-valid against the wasm Simulator through the real driver path (never a mock).

- **List (`listCoins`, read-only).** The wallet's UNSPENT coins for one asset — native XCH at the
  derived inner (p2) puzzle hashes, or a CAT at its CAT puzzle hash (`catPuzzleHash(tail, innerPh)`)
  over the same inner hashes — both HD schemes AT THE ACTIVE INDEX (§18.1a). Each coin carries its id
  (hex), amount (base units), and confirmed height (`get_coin_records_by_puzzle_hashes`,
  `includeSpentCoins:false`).
- **Coin selection in Send.** `prepareSend` accepts an optional `coinIds`: when present, ONLY those
  coins fund the spend (the driver's auto-selection is overridden by filtering the fetched coins to
  the selection). A selection that matches no owned coin fails loudly (`NO_SELECTED_COINS`) rather
  than silently auto-selecting.
- **Split (`prepareSplit`).** One or more coins → `outputs` (≥2) self coins, ALL returned to the
  ACTIVE index's own address (§18.1a — never spread across other indexes, which the single-active-
  index model would then be unable to see), with pairwise-DISTINCT amounts: consecutive integers
  `base..base+outputs-2` plus a strictly-larger final piece absorbing the remainder — provably
  distinct and positive whenever `base > 0` (else `SPLIT_TOO_SMALL`). Distinct amounts are REQUIRED
  because every piece shares one destination puzzle hash: two `CREATE_COIN`s with the same
  (puzzle hash, amount) pair would collide on-chain (identical coin id) — this constraint, not an
  address-count ceiling, is why split has no cap on `outputs`. For XCH the fee comes out of the split
  amount; for a CAT the amount is conserved (a CAT cannot pay an XCH fee) and XCH coins fund the fee.
  CAT outputs carry the recipient (self) inner p2 hash as the create-coin hint, keeping them
  discoverable.
- **Combine (`prepareCombine`).** Two or more coins → a SINGLE self coin (consolidate dust). For XCH
  the fee comes out of the combined amount; for a CAT the amount is conserved and XCH coins fund the fee.
- **Self-send invariant (MUST).** Split/combine summaries are decoded FROM THE BUILT SPEND (§5.5):
  every CREATE_COIN output puzzle hash MUST be a wallet-owned XCH or CAT puzzle hash — a build that
  would pay any address outside the wallet throws `SELF_SEND_VIOLATION` and is never broadcast. The
  summary reports `{ asset, kind, inputCoinCount, outputCoinCount, total, fee }`.
- **Approve + broadcast.** Split/combine build (not sign/broadcast) and are held under a pending id;
  the UI approves, and the shared `confirmSend` signs + broadcasts (the ONLY place a real coin-op
  spend is pushed) and returns an input coin id to poll via `sendStatus`.
- **UI.** A Coins panel (reached from the wallet Home) lists the selected asset's coins with
  multi-select, and offers plain-language Split ("make a coin of an exact size" / change
  denominations) and Combine ("combine small coins"), plus a "Choose coins" disclosure in Send to
  hand-pick the funding coins. Four states + react-intl across the 14 locales.

### 18.16 Multi-wallet registry & switcher (#90)

The extension holds SEVERAL self-custody wallets and switches which is active. Each wallet has its
OWN encrypted `DIGWX1` record (§18.2) — the registry reuses the existing keystore format, so NO new
crypto and NO new wasm are introduced. The registry is a pure decision layer (`lib/wallet-registry`)
over the storage keys, driven by the actions in §7 (`listWallets`, `switchWallet`, `renameWallet`,
`removeWallet`); the SW owns the `chrome.storage.*` I/O and the offscreen vault owns every decrypted
key.

- **Storage model.** `wallet.registry` holds `{ id, label, record, createdAt, activeIndex,
  previewAddress? }` per wallet (`id` a uuid; `activeIndex` — #165, default 0 — that wallet's own
  single active HD derivation index, §18.1a; `previewAddress` — #176, optional — that wallet's
  cached CANONICAL (index-0) receive address); `wallet.activeId` names the active wallet;
  `wallet.keystore` MIRRORS the active wallet's record so every pre-#90 single-wallet read path
  (unlock / reveal) works unchanged. The encrypted records live only in the SW — the UI receives
  record-FREE metadata (`{ id, label, createdAt, active, activeIndex, previewAddress? }`) via
  `listWallets`. A registry persisted before #165 has entries with no `activeIndex` field; migration
  normalizes it to 0. A registry persisted before #176 has entries with no `previewAddress` at all —
  this is fine (the field is fully optional, additive, never required for a read).
- **Preview address caching (#176).** Every `getReceiveAddress` read opportunistically caches the
  result onto the ACTIVE wallet's `previewAddress`, but ONLY when the active wallet's active
  derivation index is 0 (its canonical/default address — never whichever non-zero index the user
  happens to be viewing, §18.1a) AND the value actually changed (`shouldCachePreviewAddress`,
  `lib/wallet-registry.ts`). This is a public-data cache — an address is meant to be shared to
  receive funds, so storing it unencrypted alongside the metadata is safe (unlike the record, which
  stays encrypted) — and it is what lets the switcher show an address preview for a wallet that is
  NOT currently active/unlocked: once a wallet has been active at index 0 at least once (which
  happens automatically the first time its Home view reads its receive address), its preview
  persists across every subsequent switch, addition, or removal of other wallets. A wallet that has
  never yet been active at index 0 (rare — creating/importing a wallet makes it active immediately,
  so this only affects a registry entry from before #176 that hasn't been revisited) has no
  `previewAddress` yet; the switcher shows a graceful placeholder instead of a fabricated address.
- **Migration (once).** A pre-#90 single `wallet.keystore` is migrated ONCE into a one-entry registry
  with a fresh uuid (the legacy `wallet.activeId` held a label, not an id, and is discarded). An
  existing registry is never re-migrated.
- **Add.** `createWallet` (fresh 24-word phrase) and `importWallet` (paste a phrase) each mint a new
  registry entry with its own record, make it active, and start the unlock window. Onboarding stays
  the single-wallet default; adding more wallets is reached from the switcher.
- **Switch.** `switchWallet` activates another wallet. It is INSTANT when that wallet's key is already
  cached in the offscreen vault this session (several of the user's own wallets may be unlocked at
  once within the shared unlock window); with a password it unlocks-then-activates; without one for a
  not-yet-unlocked wallet it returns `NEEDS_UNLOCK` so the UI prompts. The active wallet drives every
  derived view — balances, receive address, send, activity, signing — and switching re-derives from
  the newly-active key AT THAT WALLET'S OWN active index (§18.1a — each wallet remembers its own
  place); the RTK Query `Wallets`/`LockState`/`Balances`/`Activity`/`Address`/`Collectibles`/`Coins`
  tags are invalidated so the whole surface re-reads the new wallet.
- **Cache reset on identity change (#162).** `invalidatesTags` alone only schedules a background
  refetch — a subscribed query keeps SERVING its last-known (stale, wrong-identity) cached value until
  the refetch resolves. So a CONFIRMED `switchWallet` / `removeWallet` (when it re-homes the active
  wallet) / `createWallet` / `importWallet` also dispatches `api.util.resetApiState()` (`onQueryStarted`
  in `custodyApi.ts`), wiping the WHOLE RTK Query cache the instant the SW confirms the change. Every
  wallet-scoped view then renders its LOADING state (never the previous wallet's data, never
  "unavailable" — #158) until the newly-active wallet's data arrives. A FAILED attempt (e.g.
  `NEEDS_UNLOCK`) leaves the cache untouched, since the active wallet never changed. `CustodyGate`
  reads `lockState` from the live query result, falling back to the durable wallet-slice mirror only
  once already hydrated, so the reset's transient uninitialized window never unmounts the wallet body
  (or, mid-onboarding, the `Onboarding` flow itself).
- **Rename.** `renameWallet` changes a wallet's display label only (metadata; no key, no password).
- **Remove.** `removeWallet` zeroizes that wallet's cached key (vault `forgetWallet`) and drops its
  record. It REFUSES the last wallet (`LAST_WALLET`) — there are never zero wallets. Removing the
  active wallet re-homes active to another entry; the session stays unlocked only if the new active
  wallet's key is still cached, else it locks so the gate prompts to unlock it.
- **Custody invariants.** The decrypted key never leaves the offscreen vault; every wallet's record
  is encrypted at rest; `storage.sync` is never used. Lock (explicit, TTL, idle, all-windows-close)
  zeroizes EVERY held wallet key together.
- **UI (redesigned #176).** A compact switcher pill (a small deterministic identicon + the active
  wallet's label) opens an accessible manager sheet with two sections: a PROMINENT current-wallet
  card (a larger identicon, the label, and the live receive address with a copy button) followed by
  the full wallet list (every wallet, the active one included and marked with the Active badge — one
  management surface, not a duplicate). Each list row shows its own identicon + label + a truncated
  address preview (`previewAddress`, or a graceful placeholder when not yet cached) + switch
  (active-aware, inline unlock when a wallet needs its password), rename (inline), and remove
  (two-step confirm, never the last); add (create / import) and lock sit below the list. Kept as ONE
  inline surface rather than a separate fullscreen-only management view — the popup's fixed 372px
  width fits it without horizontal overflow, so the simpler single-surface design was chosen over
  surface-gating the advanced actions. Keyboard: ArrowUp/ArrowDown roves focus between the list's
  switch buttons (wrapping at the ends), Enter activates the focused row natively, Escape closes the
  sheet. Four states + react-intl across the 14 locales.
  - **Identicon (`lib/wallet-registry.ts` type, `features/wallet/custody/identicon.ts` +
    `WalletIdenticon.tsx`).** A small deterministic geometric SVG avatar, purely decorative
    (`aria-hidden`) — the adjacent label/address text carries the actual identity for assistive
    tech. Keyed by PUBLIC data ONLY: the wallet's `previewAddress` when cached (itself a public
    commitment), else its opaque registry `id` (a random uuid, already sent to the UI unencrypted).
    The generator module never sees a mnemonic, private key, or decrypted record, so it structurally
    cannot leak one. Same seed → same icon, always (a plain non-cryptographic string hash — a
    decorative visual, not a security primitive).

### 18.17 DID management (#93)

DIDs (Decentralized Identifiers) are created, listed, and transferred from `chia-wallet-sdk-wasm`
primitives so the spends match the canonical `chia-sdk-driver` construction byte-for-byte (they
interoperate with Sage / dexie). Both money paths are proven consensus-valid by Simulator tests
(create → list → transfer → assert the DID moves and the recipient can rediscover it). The decrypted
key never leaves the offscreen vault. **Surface tiering (§6 hub-adjacent rule, mirrored ecosystem-wide,
#145): DID management is ADVANCED functionality and renders in the fullscreen (expanded) layout ONLY.**
The compact popup shows, at most, a view-only DID list with an "open full screen" affordance — it never
mounts the create or transfer form.

- **No `Action`/`Spends` driver support for DIDs.** Unlike NFTs/CATs, `chia-wallet-sdk-wasm` has no
  `Action.mintDid`/`Spends.addDid` — a DID is built from the lower-level `Clvm.createEveDid(
  parentCoinId, p2PuzzleHash)` / `Clvm.spendDid(did, innerSpend)` primitives directly. `createEveDid`
  needs a SINGLE parent coin id up front (the launcher's id is derived from it), so the wallet's
  LARGEST owned coin is always the "primary" — the one that creates the launcher. **Multi-coin
  funding (#179):** when the primary alone doesn't cover the DID amount (1 mojo) plus the fee,
  `prepareDidCreate` selects ADDITIONAL wallet-owned coins (largest-first) and spends them alongside
  the primary with no conditions of their own — their value folds into the primary's change/fee
  because Chia balances a spend bundle's inputs vs outputs as a WHOLE, not per coin (the same pattern
  an ordinary multi-coin Chia send uses). Only when every coin at the active index combined still
  falls short does it fail `NO_SUITABLE_COIN`; a wallet with no XCH at all fails `NO_XCH_COINS`.
- **Discovery model.** A DID is a singleton whose OUTER coin puzzle hash is the DID-layer puzzle — NOT
  the wallet's inner (p2/standard) puzzle hash — so it is NOT found by a puzzle-hash scan. Every DID
  spend (create or transfer) hints the owner's inner p2 puzzle hash via the create-coin memo, so the
  wallet finds its DID coins via coinset `get_coin_records_by_hints` over its derived inner puzzle
  hashes (both HD schemes AT THE ACTIVE INDEX, §18.1a). For each hinted unspent coin, the PARENT spend is
  fetched and `Puzzle.parseChildDid(parentCoin, parentSolution, coin)` reconstructs the child `Did`
  (parallel to `Puzzle.parseChildNft`, except the wasm binding also wants the target child coin to
  disambiguate DID recovery outputs). A coin is one of the wallet's DIDs iff the reconstructed child IS
  that coin and its `info.p2PuzzleHash` is one of the wallet's derived inner puzzle hashes.
- **LIST** (`listDids`, read-only): returns, per DID, `{ launcherId, coinId, p2PuzzleHash,
  recoveryListHash (hex, or null), numVerificationsRequired, profileName (UTF-8, or null) }` — deduped
  by launcher id. `profileName` decodes the DID's on-chain `metadata` atom as UTF-8; a nil/non-string
  metadata (a freshly created DID, or a foreign DID never profile-updated) decodes to `null`.
- **CREATE** (`prepareDidCreate`, no broadcast): builds one new "simple" DID (no recovery list,
  `numVerificationsRequired = 1`) owned by the wallet. `Clvm.createEveDid(primaryCoin.coinId(),
  primaryCoin.puzzleHash)` returns the eve `Did` plus the `parentConditions` the primary coin's spend
  must carry (the launcher creation + its binding announcement); the primary coin is spent directly via
  `Clvm.spendStandardCoin` (bypassing the `Spends`/`FinishedSpends` driver, which has no DID action).
  When the primary alone doesn't cover the amount + fee, additional wallet-owned coins are spent
  alongside it with an EMPTY delegated spend (see multi-coin funding, above). The eve DID is then spent
  once via `Clvm.spendDid` to commit its real (non-eve) lineage, re-committing to the same owner. The
  unsigned coin spends are held under a pending id with the decoded, tamper-resistant summary
  `{ launcherId, p2PuzzleHashHex, fee, coinCount }` and the new `launcherId`. A wallet with no XCH is
  rejected `NO_XCH_COINS`; a wallet whose combined XCH (every coin at the active index) still falls
  short of the amount + fee is rejected `NO_SUITABLE_COIN`. A DID with a real recovery list is a
  follow-up if a use case needs it.
  - **Error surfacing (#179).** The vault's `handle()` dispatcher maps ANY domain throw following the
    `CODE: message` convention (as `dids.ts`, `nfts.ts`, and sibling engines use) to `{ success: false,
    code, message }` — not just `KeystoreError` instances — so a caller always gets the SPECIFIC code
    a throw carries, never a generic `VAULT_ERROR` fallback. The Identity "Create DID" UI renders a
    distinct, actionable message per code (`NO_XCH_COINS` names the active derivation index;
    `NO_SUITABLE_COIN` says funds are insufficient even combined; any other/unexpected code shows the
    real underlying message) — never a generic "try again".
- **CONFIRM CREATE** (`confirmDidCreate`): signs + broadcasts the held create — reusing the vault's
  `confirmSend` broadcast path (the ONLY place a create is pushed); confirmation is polled via the
  shared `sendStatus`. Mainnet-only.
- **PREPARE TRANSFER** (`prepareDidTransfer`, no broadcast): recompute the new owner's DID-layer inner
  puzzle hash from a `DidInfo` carrying the recipient's p2 puzzle hash (same launcher id / recovery
  list / verifications / metadata as the current DID), then `Clvm.spendDid(did, standardSpend(ownerPk,
  delegatedSpend([createCoin(newInnerPuzzleHash, 1, hintMemo)])))` — the recipient's inner p2 puzzle
  hash is carried as the create-coin hint so they discover it. A fee, when given, is paid from a
  SEPARATE wallet-owned XCH coin (the DID's own coin carries only 1 mojo). The unsigned coin spends are
  held under a pending id with the decoded summary `{ launcherId, recipientPuzzleHashHex, fee,
  coinCount }`. Transferring a DID the wallet does not hold is rejected `DID_NOT_FOUND`.
- **CONFIRM TRANSFER** (`confirmDidTransfer`): signs + broadcasts the held transfer — reusing the
  vault's `confirmSend` broadcast path (the ONLY place a transfer is pushed); confirmation is polled via
  the shared `sendStatus`. Mainnet-only.
- **PREPARE PROFILE UPDATE** (`prepareDidProfileUpdate`, no broadcast): sets the DID's on-chain
  `metadata` to a plain UTF-8 `profileName` atom (`Clvm.alloc(profileName)`), keeping the same launcher
  id / owner / recovery list / verifications. Unlike a transfer, this needs **TWO chained DID spends**
  (a same-bundle ephemeral hop), not one: a chain rescan reconstructs a DID's `metadata` from its
  PARENT coin's OWN curried value — never from the create-coin hint (unlike `p2PuzzleHash`, which a
  rescan reads directly off the hint) — confirmed against `chia-sdk-driver`'s `Did::parse_child`
  (xch-dev/chia-wallet-sdk `crates/chia-sdk-driver/src/primitives/did.rs`), whose own doc states a
  metadata change "cannot be parsed... without additional context" from one spend alone. The fix
  (`Did::update`'s documented pattern — "settle the DID's updated metadata and make it parseable by
  wallets"): spend once (commits the new metadata into an EPHEMERAL intermediate coin's own reveal via
  `did.child(p2PuzzleHash, newMetadata)`), then spend that ephemeral coin again self-to-self (same
  target inner puzzle hash) — a later rescan reads the ephemeral coin as the final coin's parent and
  recovers the correct metadata. A fee, when given, is paid from a SEPARATE wallet-owned XCH coin. The
  unsigned coin spends (both hops) are held under a pending id with the decoded summary
  `{ launcherId, profileName, fee, coinCount }`. Updating a DID the wallet does not hold is rejected
  `DID_NOT_FOUND`.
- **CONFIRM PROFILE UPDATE** (`confirmDidProfileUpdate`): signs + broadcasts the held update — reusing
  the vault's `confirmSend` broadcast path; confirmation is polled via the shared `sendStatus`.
  Mainnet-only.
- **PREPARE NFT↔DID ASSIGNMENT** (`prepareNftDidAssign`, no broadcast): assigns a wallet-owned DID as
  the OWNER (`currentOwner`) of a wallet-owned NFT — the CHIP-0011 ownership-layer bonding handshake,
  byte-identical to `chia-sdk-driver`'s `Nft::assign_owner` + `UpdateNftAction` (verified against
  xch-dev/chia-wallet-sdk `crates/chia-sdk-driver/src/primitives/nft.rs` +
  `actions/update_nft.rs`, since chia-wallet-sdk-wasm 0.33 exposes no `Spends.addDid`/`Action` helper
  for it — confirmed against `crates/chia-sdk-bindings/src/action_system.rs` at HEAD too). Built from
  `Clvm.spendNft`/`spendDid` directly:
  1. The NFT re-creates itself at the SAME p2 puzzle hash (custody unchanged) and additionally emits a
     `TransferNft` condition (opcode -10): `(didLauncherId, [], didInnerPuzzleHash)` — the ownership
     layer automatically creates a matching puzzle announcement from this.
  2. The DID re-creates itself unchanged (same p2 puzzle hash AND metadata — no "settle" hop needed
     here, since neither field changes) and additionally: asserts the announcement id
     `sha256(nftFullPuzzleHash ‖ 0xAD 0x4C ‖ treeHash(list(didLauncherId, [], didInnerPuzzleHash)))`
     (`assignment_puzzle_announcement_id`, byte-identical to the Rust helper of the same name), and
     creates its OWN puzzle announcement carrying the NFT's launcher id — the exact reciprocal the
     ownership layer's automatic assertion expects.
  Both spends land in ONE bundle, so the handshake is atomic. Unlike DID metadata, NFT ownership IS
  immediately observable by a naive one-spend chain rescan — the `TransferNft` condition carries the
  new owner in plaintext in the p2 spend's output conditions (`listNfts`'s `collectionId` field
  reflects it). Neither the NFT's nor the DID's custody changes. A fee, when given, is paid from a
  SEPARATE wallet-owned XCH coin (both the NFT and DID coins carry only 1 mojo each). The unsigned coin
  spends are held under a pending id with the decoded summary
  `{ nftLauncherId, didLauncherId, fee, coinCount }`. Assigning an NFT or DID the wallet does not hold
  is rejected `NFT_NOT_FOUND` / `DID_NOT_FOUND` respectively.
- **CONFIRM NFT↔DID ASSIGNMENT** (`confirmNftDidAssign`): signs + broadcasts the held assignment —
  reusing the vault's `confirmSend` broadcast path; confirmation is polled via the shared `sendStatus`.
  Mainnet-only.
- **UI.** An Identity panel lists the wallet's DIDs (view-only in BOTH surfaces, showing the profile
  name when set). **The "Identity" segmented-tab ENTRY is fullscreen-only** (§2.1, #163) — the
  compact popup's wallet segmented control never renders it; the panel is still reachable view-only
  on the popup via a direct `#wallet/did` deep-link. In the fullscreen layout the Identity tab
  additionally offers "Create DID" and, per DID, "Transfer" and "Edit profile" — the popup shows an
  "open full screen" link for these instead of embedding the forms. The Collectibles NFT detail view
  offers "Assign DID owner" (fullscreen only), picking from the wallet's listed DIDs. Four states +
  react-intl across the 14 locales. Assigning a DID as an NFT's owner AT MINT TIME (§18.11, vs. on an
  already-minted NFT, which this section covers) remains a follow-up seam noted on #92.
