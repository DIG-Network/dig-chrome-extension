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
  declare a `connect-src` naming the KNOWN, fixed network egress hosts (the chain host(s)
  `rpc.dig.net`/`*.dig.net`/`coinset.org`, the CAT price + token-metadata host `api.dexie.space`, and
  `api.bugreport.dig.net`) **plus `https:`** (any HTTPS host — required for `getNftMetadata`, §18.11c,
  to reach an arbitrary off-chain metadata host not enumerable in advance), `frame-src 'self' https:`
  (the in-window dApp app-view frames curated store `link`s over https, §2.4a), `font-src 'self'`
  (the vendored Space Grotesk / Space Mono woff2), and `img-src 'self' data: https:` (any HTTPS host —
  the native dApp-launcher icons §2.4, the auto-discovered CAT token icons §18.6, and remote NFT art
  §18.11). `host_permissions` correspondingly includes an all-hosts HTTPS pattern (needed for the
  extension's CORS-bypass fetch elevation — most off-chain metadata hosts won't send
  `Access-Control-Allow-Origin`).
  - **A Manifest V3 background SERVICE WORKER's own `fetch()` IS subject to `connect-src`** —
    empirically verified (`DEVELOPMENT_LOG.md`) building `getNftMetadata` (§18.11c): a fetch to a host
    outside `connect-src` failed before ever reaching the network layer, the signature of a CSP block,
    not a CORS failure. Do not assume the SW is exempt from the page CSP when adding a new SW-side
    fetch — verify against the manifest's actual `connect-src`.
  - An `<img>` load or a JSON-only `fetch()`+parse cannot execute script, so allowing arbitrary HTTPS
    hosts here is not a script-injection risk; the tradeoff is PRIVACY (the host observes the
    requester's IP) and a wider POST/readable-response surface than `img-src` alone grants, which
    §18.11/§18.11c document and which every other NFT wallet (Sage included) accepts by rendering art
    by default.
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
- **`app.html`** → `App surface="fullpage"` — a **desktop wallet workspace**: the SAME app + route
  tree presented at ≥960px (`useLayoutMode`, `EXPANDED_MIN_WIDTH`) as a persistent left **sidebar**
  (`WalletSidebar`) beside a content column with a **`WalletTopbar`** app-bar and the width-using main
  pane; it degrades to the compact phone in a narrow window. The sidebar (`src/layouts/desktopNav.ts`)
  **flattens the wallet's segmented sub-views into first-class, one-click sections** — Home · Wallet ·
  Activity · Trade · Collectibles · Identity · Apps · Network — each mapping to the SHARED route
  (`tab` + optional `walletView`), so it dispatches the same `setTab`/`setWalletView` the popup uses
  (one store, no forked navigation). Because the sidebar IS the wallet-view nav on this surface, the
  in-content wallet segmented control is hidden here (CSS-scoped to `.dig-shell-expanded`); the
  content still renders the SAME `ActiveTabPanel` feature containers as the popup. The app-bar names
  the active section as the page-level `<h1>`. Copy reuses the shared catalog (one added id,
  `shell.nav.label`, for the sidebar's accessible name).

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
     entry is gated). On the fullscreen desktop workspace the in-content segmented control is hidden
     and the **sidebar** carries every section, Identity included (there is no popup sidebar, so the
     Identity entry stays fullscreen-only).
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
- **loading** (#157) — the shared `DigLoader` branded card (`src/components/DigLoader.tsx`) over the
  frame until the frame's `load` fires or a timeout elapses. `DigLoader` matches the visual language
  of the `*.on.dig.net` resolver loader shell (`services/on.dig.net/assets/loader.html`) — a dark
  card on a contained radial-glow backdrop with the DIG Network wordmark, a purple spinner, and a
  title/subtitle pair — so the SAME "DIG is loading your content" experience appears whether content
  resolves via a subdomain or inside the extension. The spinner honors `prefers-reduced-motion:
  reduce` (no rotation). `DigLoader` is presentational only (the caller supplies react-intl copy) and
  is the loader the open-by-URN content view (#172) reuses;
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
a floating overlay, on the popup/fullscreen shell (`AppFooter`/`BugReportLink`): the component's
floating launcher FAB is hidden (`.digbr-launcher { display:none }`) and the inline item opens the
same panel by programmatically clicking the (still-mounted) launcher. The settings page
(`options.html`, #212) is not space-constrained the way the shell footer is, so it mounts the SAME
component as its normal, VISIBLE floating launcher (no hide-and-forward) — a separate tiny React root
just for the widget, since `options.html` otherwise has no React app of its own.

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
`MESSAGE_PROTOCOL_VERSION` (currently `27`). Consumers MUST reference `ACTIONS.<name>` rather
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

`MESSAGE_PROTOCOL_VERSION` `24` (#98) added `getNftMetadata` (§18.11c) — fetches + JSON-decodes the
off-chain CHIP-0007 metadata document a `metadataUri` points at, handled directly by the service
worker (not the offscreen vault) since the target host is arbitrary and not enumerable in the
extension-pages CSP `connect-src` allowlist. Purely additive — no existing action/shape changed.

`MESSAGE_PROTOCOL_VERSION` `25` (#99) added the Collectibles bulk assign-DID actions —
`prepareNftBulkDidAssign` + `confirmNftBulkDidAssign` (§18.11a) — assigning the wallet's DID as the
owner of MULTIPLE selected NFTs in one spend bundle, each confirm reusing the `confirmSend` broadcast
path. Purely additive — no existing action/shape changed.

`MESSAGE_PROTOCOL_VERSION` `26` (#105/#106 send/receive trio) added an optional `memo` on
`prepareSend` (§18.8b) and an optional `memoText` on its response summary, plus the
`listDerivedAddresses` action (§18.1b) — a read-only page of the active wallet's derived addresses
for viewing/copying. Purely additive — no existing action/shape changed. (#107's QR camera scanner
is client-side only and adds no message action.)

`MESSAGE_PROTOCOL_VERSION` `27` (#95/#96/#115 — accounts, watch-only wallets + private-key export,
keystore file backup/restore) added: `addAccount` / `renameAccount` / `removeAccount` — named
sub-accounts (§18.18) are a friendly LABEL over one HD derivation index within a wallet's existing
single-active-index model (§165 unchanged — never a second scan dimension); `listWallets`'s per-wallet
metadata additively gained `accounts` (always populated, defaulted for a pre-existing wallet) and,
for a watch-only entry, `kind:'watch'` + `watchFingerprint`. `importWatchWallet` adds a spend-less
watch-only wallet from a master/root BLS public key only — no password, never locked (§18.19);
`getReceiveAddress` / `scanBalances` / `listDerivedAddresses` additively accept `watchPublicKeyHex` to
derive from it directly (UNHARDENED ONLY — hardened is unreachable from a public key alone), and
`getReceiveAddress`'s response additively gained `fingerprint`. Every signing-required action
(`prepareSend`, `prepareSplit`/`prepareCombine`, `makeOffer`/`prepareTrade`, every NFT/DID prepare
action, `prepareClawbackAction`, `revealPhrase`, `exportPrivateKey`, `signDappSpend`/`signMessage`)
rejects a watch-only active wallet with `WATCH_ONLY` (a dApp sign/write request against a watch-only
wallet also fails closed, via the pre-existing never-cached-key guarantee — §18.19). `exportPrivateKey`
reveals the raw (pre-synthetic) account secret key at the active index, both HD schemes, behind the
same full-password re-auth as `revealPhrase` (§18.20). `exportWalletBackup` / `importWalletBackup` move a
wallet's existing encrypted DIGWX1 record as a downloadable JSON file (§18.21) — the SW never decrypts
it either way; restoring lands the wallet LOCKED (no password was ever supplied) so the normal unlock
screen gates it. Purely additive — no existing action/shape changed.

`MESSAGE_PROTOCOL_VERSION` `28` (#97 CAT issuance) added `prepareCatIssuance` / `confirmCatIssuance`
(§18.22) — mint a brand-new CAT (single fixed-supply genesis-by-coin-id TAIL, or multi
signature-gated TAIL curried with the wallet's own synthetic key). `confirmCatIssuance` reuses the
vault's existing `confirmSend` broadcast path. Purely additive — no existing action/shape changed.

`MESSAGE_PROTOCOL_VERSION` `29` (#104 option contracts) added `prepareOptionMint`/`confirmOptionMint`,
`prepareOptionExercise`/`confirmOptionExercise`, and `getOptions` (§18.23) — mint + exercise an
XCH-denominated option contract, with a local option registry (mirrors #101's offer-log) since a
bare on-chain option carries no recoverable terms. Both confirm actions reuse the vault's existing
`confirmSend` broadcast path. Purely additive — no existing action/shape changed.

`MESSAGE_PROTOCOL_VERSION` `30` (#222 auto-detect a running local dig-node) added
`getChainSourceStatus` (§18.6c) — resolves the §5.3 ladder for the WALLET-data read path and reports
the selected mode + the resolved source, backing the "Local dig-node detected" indicator. Purely
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
| `getChainSourceStatus` | Wallet-data source auto-detect (#222, §18.6c): resolve the §5.3 ladder for the WALLET read path; report the selected mode + the resolved source. |
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

The injected MAIN-world provider talks to the content script over `window.postMessage`. Because that
pipe is observable by any script on the page, the channel is hardened (the shared, unit-tested
`provider-channel` module both sides use):

- `DIG_WALLET_REQUEST` (page → content): `{ channel:'dig-wallet/1', type, id, method, params }`.
- `DIG_WALLET_RESPONSE` (content → page): `{ channel:'dig-wallet/1', type, id, status, body, error }`.

Both sides MUST:
- ignore any message whose `channel` tag or `type` direction does not match (unrelated postMessage
  traffic is dropped, not mis-parsed);
- validate the delivered `MessageEvent.origin` equals the document's own origin AND
  `event.source === window` — a cross-origin / foreign-frame message is never processed;
- drop a malformed payload (missing/oversized `id`/`method`, non-object body) WITHOUT throwing;
- mint request `id`s from the CSPRNG (`crypto.getRandomValues`), never a predictable source;
- correlate a response to its request through a BOUNDED registry that settles each `id` EXACTLY once
  — a forged reply for an unknown `id` is dropped, a duplicate/replayed reply is a no-op, concurrent
  multiplexed requests never cross, and a request flood cannot grow the pending map past its cap.

An opaque (sandboxed / `data:`) document reports origin `"null"`; a reply is then posted with
targetOrigin `"*"` (`"null"` is an invalid targetOrigin), the same-window `event.source` guard still
applying. The content script forwards requests to the service worker (`walletRpc`), which routes them
to the self-custody wallet — connect + reads to the offscreen vault, sign/message to the SW-summoned
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
- **`controlPanelViewModel` returns react-intl message ids, not prose (#82).** The view model stays
  a plain, DOM-free ES module (no `react-intl`/JSX dependency) importable by the background script;
  every piece of copy it selects is a `{ id, values? }` pair (`noteId`, `readFallback`,
  `install.titleId`/`install.bodyId`) that `ControlTab.tsx` — the sole `<FormattedMessage>`
  consumer — renders. The actual English source lives in `src/i18n/messages/en.ts` (content-quality
  guarded by `dig-control-copy.test.ts`) and is translated across all 14 locales (completeness
  guarded by `locales.test.ts`).

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

## 15. Security model

The extension has two blast surfaces, hardened independently: the **content-read path** (§1-§9,
§12 — resolving/decrypting public `.dig` content, no keys involved) and the **self-custody
wallet** (§18 — holding real key material and signing real spends). §15.1 covers the former;
§15.2-§15.12 are the wallet's normative, consolidated security model — the output of the #67
hardening program (P0 supply-chain/phishing/drainer/permissions, P1 provider-channel/address-
poisoning/signer-hardening/session, P2 clear-signing/onboarding/DOM-isolation). Every subsection
below cross-references the fuller §18.x contract that specifies it; this section is the map + the
invariants that MUST hold, not a restatement of the implementation.

### 15.1 Content-read path properties

- **Fail-closed crypto** — unverified WASM (SRI mismatch) refuses to run (§6).
- **No forged verification** — a failed/absent inclusion proof is never rendered as verified;
  a GCM-SIV tag failure is never rendered as content (§5, §6).
- **No leaked internals** — user-facing error copy never exposes crypto strings; the machine
  code is separate (§9).
- **Privacy-preferring endpoint** — the user's local dig-node is preferred over the hosted
  gateway; the gateway is the fallback, not the default (§8).
- **Read-only** — the content-read path performs no on-chain spends and serves no content to peers.
- **No content cache** — the extension does not persist or memory-cache resolved/decrypted
  content; every `proxyRequest`/`convertDigUrl` call re-fetches, re-verifies, and re-decrypts.
  Caching (and any node-config UI) is a dig-node responsibility, never the extension's (§1).

### 15.2 Wallet threat model

The self-custody wallet (§18) holds real Chia key material and authorizes real spends, so it is
held to a stricter standard than the read-only content path. The design assumes NONE of the
following are trustworthy on their own: an npm dependency's install-time behavior; a web page the
user visits, including its self-reported origin, method arguments, and any postMessage traffic
it can observe; a dApp's connect/sign request, however it is worded; another extension or script
sharing the same page; or a merely-present attacker with momentary UI access to an unlocked
session (no password, no re-auth). The one thing the model trusts is the password the user
supplies at unlock/reveal/export time and the entropy the vault generates. Studied
`MetaMask/metamask-extension`'s architecture for proven concepts (per the #67 design report); no
MetaMask code, no LavaMoat/SES runtime, and no Ethereum-specific tooling or data (e.g. no
`eth-phishing-detect`) is used — every defense below is Chia-native, original code, evaluated
on-device.

### 15.3 Supply-chain hardening (build-time perimeter, #67 P0-1a)

A hot wallet's build is itself an attack surface: a malicious or compromised transitive
dependency's `postinstall` script runs with full ambient authority in the same install as the
seed-holding offscreen bundle and could exfiltrate keys before a single line of wallet code runs.
The extension denies this by default rather than trusting the dependency tree:

- `.npmrc` sets `ignore-scripts=true` — NO dependency lifecycle script (`preinstall`/`install`/
  `postinstall`) runs on `npm install`/`npm ci` by default.
- `allowed-install-scripts.json` is a hand-reviewed allowlist of the few packages with a genuine,
  benign install script (native/platform-binary setup, e.g. `esbuild`, `@swc/core`); ONLY these
  are re-run afterwards via `npm run allow-scripts` (`scripts/allow-scripts.mjs`).
- The same script is a **drift gate**: it fails the build/CI if any INSTALLED dependency ships an
  install script that is not on the allowlist, so a new transitive dependency can never silently
  gain install-time code execution — it forces an explicit, reviewed decision to add it.
- This is a minimal, dependency-free, Chia/DIG-native denylist-by-default approach — no LavaMoat,
  no SES `lockdown`/Compartments/policy files, no runtime sandboxing of already-loaded code (§15.2).
  It closes the install-time vector; it does not sandbox a dependency's behavior once loaded and
  invoked (§15.12 lists this as a residual gap, not a claimed guarantee).

### 15.4 Key custody core (vault + at-rest keystore)

Normative contract: §18.1 (key derivation) + §18.2 (`DIGWX1` at-rest keystore, V2 current /
V1 legacy decode-only, dig_ecosystem #147 Phase B) + §18.3 (custody lifecycle & session). Summary
of the invariants those sections specify:

- The decrypted key/entropy exists ONLY inside the long-lived offscreen document's memory — never
  the service worker, never `chrome.storage`, never persisted or logged in plaintext anywhere.
- At rest, the entropy is encrypted as a single `DIGWX1` record. The CURRENT (V2) writer delegates
  to the canonical `dig-keystore` crate's wasm binding (`@dignetwork/dig-keystore-wasm`): Argon2id
  (memory-hard) at a DEFAULT cost of 64 MiB / 3 iterations / 4 lanes, with a STRONG 256 MiB preset
  offered for high-value wallets (surfaced as an onboarding toggle, §15.9), feeding AES-256-GCM with
  the full header (KDF params, salt, cipher id, nonce) bound as AAD inside the wasm binding's own
  self-describing container — tampering with any of them fails the GCM tag closed. An OLDER V1
  record (written before this migration) decodes via the extension's original hand-rolled path
  (native WebCrypto AES-256-GCM, same AAD binding) — see §18.2 for the full V1/V2 split. Either
  path's derived AES key is a non-extractable `CryptoKey`, never serialized. Any decrypt failure
  (wrong password OR a tampered blob) collapses to one opaque `UNLOCK_FAILED` — the wallet never
  tells an attacker which one.
- A bounded PBKDF2-HMAC-SHA-512 (≥600,000 iterations) fallback was part of the legacy V1 writer,
  engaging ONLY if the Argon2 wasm failed to instantiate; `decryptEntropy` still opens a
  PBKDF2-fallback V1 record forever (§18.2). The V2 writer has no analogous fallback — see §18.2's
  `EncryptResult.usedFallback` note for why.
- `storage.sync` is NEVER used for wallet key material (§18.4) — it would replicate the encrypted
  seed to every device signed into the browser profile, widening the at-rest attack surface beyond
  what the user chose.

### 15.5 Provider-channel isolation (page ↔ content ↔ background, #67 P1-1)

Normative contract: §7.3. The injected MAIN-world provider talks to the content script over
`window.postMessage` — a pipe any script on the page can observe — so the channel is hardened
rather than trusted: a namespaced, versioned channel tag (`dig-wallet/1`) rejects unrelated
traffic; both directions validate `MessageEvent.origin` against the document's own origin AND
`event.source === window`; request ids are minted from a CSPRNG, never a predictable source; and
a bounded per-id correlation registry settles each request EXACTLY once, so a forged reply for an
unknown id is dropped, a duplicate/replayed reply is a no-op, concurrent multiplexed requests
cannot cross, and a request flood cannot grow the pending map without bound. Downstream, the
background NEVER trusts a page-self-reported origin string for authorization — it uses the
unspoofable `sender.origin` (§18.12) at every gate.

### 15.6 dApp request perimeter (connect / sign gate)

Normative contract: §18.12. Every request from an injected `window.chia` provider crosses this
perimeter before it can see wallet data or move funds:

- **Phishing / malicious-origin protection (P0-2).** `assessOrigin` checks the requesting origin
  against a DIG-curated, periodically-refreshed blocklist plus on-device lookalike/homoglyph
  heuristics BEFORE connect. A `block` verdict refuses the origin outright — it is never recorded
  pending and never approved. A `warn` verdict lets the flow proceed but forces an interstitial
  acknowledgement in the approval window.
- **Granular, revocable permissions + Connected sites (P0-4).** Per-origin consent is a capability
  record (addresses exposed, methods used, granted/last-used timestamps), not a bare boolean, with
  EIP-2255-shaped (Chia-mapped) `wallet_getPermissions`/`wallet_revokePermissions` and a
  Connected-sites settings screen for per-site or revoke-all — consent is inspectable and
  revocable, not a permanent grant.
- **Anti-drainer spend-risk heuristics (P0-3).** Before a sign/spend approval, `assessSpendRisk`
  inspects the summary DECODED FROM THE BUILT SPEND (never from page-supplied text, §5.5) and
  flags high-risk patterns (draining nearly all value, an anomalous fee, an unaccountable signer,
  untrusted foreign inputs) with a red, acknowledgement-gated banner — no one-click approval on a
  flagged spend.
- **Signer accountability + never-sign-a-decode-failure (#75).** Every required signer MUST map to
  a wallet-derived key; the self-custody signer is all-or-nothing (refuses to contribute a partial
  signature to a bundle it cannot fully sign), and a request whose spend could not be decoded is
  REJECT-only end to end (UI hides Approve; the resolver enforces the same gate independently) — a
  user can never authorize a spend they could not see decoded.
- **The unlock TTL cannot be outlived by a held approval window (#76).** The dApp router re-checks
  the live lock snapshot from storage on every call — not a cached/pass-through check — so a
  request that sat open in the approval window (its keepalive port deliberately keeps the SW +
  vault alive so review isn't rushed) can never be signed after the session has actually expired.
- **Clear-signing (#77).** Every rendered summary shows a fiat equivalent and resolved CAT
  name/ticker (never a raw truncated asset id) beside on-chain amounts, plus an expandable raw
  JSON view of the exact decoded request for a reviewer who wants full detail.

### 15.7 Address-poisoning defenses (send-path perimeter, #74)

Normative contract: §18.14. On every Send, the entered recipient is classified against the
address book and recent recipients; a `lookalike` — an address that is NOT already known but
shares the same truncation prefix/suffix the UI displays while differing in the middle (the
address-poisoning attack signature) — MUST raise a blocking, explicitly-acknowledged warning
before the spend can be built. A never-seen address gets a lighter first-time notice. The
classifier runs entirely on-device over locally-held contact/recipient data.

### 15.8 Session lifecycle & auto-lock (#76)

Normative contract: §18.3. The vault auto-locks (zeroizing the held entropy and clearing the
unlock window) on: an explicit Lock action; a TTL sweep once the configurable idle window
(default 15 minutes, clamped 1-60) lapses with no renewing activity; `chrome.idle` reporting
idle/locked at an explicit detection interval; all extension windows closing (the offscreen
document tears down); and a lock-on-wake check that runs the moment the service worker restarts
(OS sleep/wake, browser restart, SW eviction) rather than waiting for the next timer tick. Session
renewal is a compare-and-swap over the persisted expiry, not an unconditional extend, so an
explicit lock or a TTL lapse always wins over a slower in-flight call that started before it.

### 15.9 Onboarding security nudges (#79)

Before a NEW-or-imported recovery phrase is ever shown, the Create/Import flow requires an
explicit acknowledgement of a phishing-education step (DIG never asks for the recovery phrase,
anywhere, including anyone claiming to be DIG support). After a freshly created wallet's phrase is
confirmed, a backup-reminder step points at the encrypted keystore backup file (§15.10) as a
second recovery method before proceeding to the wallet. The keystore KDF's STRONG 256 MiB Argon2id
preset (§15.4) is exposed as a user-facing toggle for a high-value wallet. Watch-only import and
restore-from-encrypted-backup skip the phishing step — neither path ever exposes a raw phrase.

### 15.10 Secret-reveal DOM isolation (#67 P1-5)

Normative contract: §18.5 (recovery-phrase reveal) and §18.20 (private-key export). Any UI that
reveals wallet secret material — the 24-word recovery phrase or an exported raw private key —
renders the secret text inside a **closed shadow root** (`attachShadow({ mode: 'closed' })`) so
neither a co-installed extension, an injected page script, nor any other part of the wallet's own
UI can scrape it via `document.querySelector`/`textContent` harvesting; the host element's
`shadowRoot` reads back `null` to any outside caller. Screen readers and keyboard navigation still
traverse the subtree (§5.6). This primitive is REQUIRED for every current and future
secret-reveal surface, not a one-off.

### 15.11 Reduced-custody & backup paths

- **Watch-only wallets (#96, §18.19)** hold no secret material and can NEVER sign or spend — every
  signing-required action (reveal, export, send, offer, NFT/DID prepare, clawback) is refused
  `WATCH_ONLY` before it ever reaches the vault, and a watch-only wallet's id is simply never given
  a cached key, so a dApp sign/write request against it fails closed identically to a locked wallet.
- **Private-key export (#96, §18.20)** requires the SAME full-password re-authentication as
  revealing the recovery phrase — never served from the cached unlock-window TTL — so momentary UI
  access to an already-unlocked session cannot exfiltrate the signing key without the password.
  The revealed key uses the §15.10 DOM isolation and an explicit copy action that auto-clears the
  clipboard after a short delay.
- **Encrypted keystore file backup/restore (#115, §18.21)** moves a wallet between devices without
  ever decrypting it: the exported file embeds the wallet's own `DIGWX1` record byte-for-byte, so
  this path introduces no new cryptographic primitive and never touches the secret key. A restored
  wallet comes back `locked` — no password is ever seen during restore.

### 15.12 Residual risk / non-goals

This model does not claim to defend against everything:

- **A compromised OS, browser, or a co-installed extension with debugger-level access.** DOM
  isolation (§15.10) and offscreen-only key residency (§15.4) raise the bar against DOM-scraping
  and cross-context reads; they do not defend against an attacker who can already instrument the
  browser process itself.
- **No runtime sandboxing of loaded dependency code.** §15.3 closes the install-time script vector;
  it does not constrain what an already-loaded, invoked dependency can do at runtime (no LavaMoat/
  SES compartments — a deliberate scope decision, §15.2).
- **No hardware-wallet support.** Deferred, then dropped for this Chia wallet (#67 P2-2, tracked as
  not-planned in #78).
- **No independent transaction-simulation/scoring service.** §15.6's anti-drainer heuristics are
  on-device pattern matching, not a full simulation; an optional hosted scoring tier is a deferred,
  opt-in future addition (#67 P2-4), never a default or a requirement for approving a spend.
- **Finality of informed consent.** A spend the user approves after seeing every warning this model
  raises (risk banner, lookalike warning, unaccountable-signer flag) is intentionally allowed to
  proceed — the model surfaces risk, it does not override user intent once acknowledged.
- **§15.1's content-read path is a separate, lower-privilege surface** (no keys involved) and is
  unaffected by anything in §15.2-§15.11 above.

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
9. Holds the decrypted wallet key ONLY in the offscreen document (never the service worker, never
   `chrome.storage`, never `storage.sync`) and gates every dApp connect/sign request through the
   full §15.6 perimeter (origin/phishing check, revocable per-origin consent, spend-risk
   heuristics, signer accountability, live TTL re-check) before it can see wallet data or move
   funds — per the §15 security model.
10. Denies dependency install scripts by default and drift-gates any unlisted one (§15.3), and
    renders any secret-reveal UI inside a closed shadow root (§15.10).

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

### 18.1b Derived-address list — view/copy only, not a scan (#106)

An ADVANCED-tier list (`DerivedAddressList`, rendered alongside the chain-node override / auto-lock
/ connected-sites settings) shows a PAGE of the active wallet's derived addresses, BOTH HD schemes,
for indexes `0..count-1`, for VIEWING and COPYING — never for balance/activity scanning:

- **Pure local derivation.** `listDerivedAddresses` (§7) derives via the SAME `deriveAccounts`
  primitive §18.1a's single-index model uses, but over a RANGE (`start:0, count`) instead of one
  index — it makes NO chain query and touches NO balance/activity/coin state. It does not read or
  change the active index (§18.1a); it is a strictly read-only, display-only view.
  - **Does NOT reintroduce multi-index scanning.** §18.1a's "no multi-index gap-limit sweep" rule
    governs SCANS (balance/CAT/NFT/DID discovery, coinset round-trips per index) — deriving an
    address for display is a cheap, local, no-network computation; deriving 100 of them costs
    nothing a browser need worry about. `count` defaults to a small page (5) and is clamped
    server-side (100) so even a maximal request stays a bounded, instant local computation.
- **"Generate fresh" extends the page, never replaces it** — clicking "Show more" re-requests with
  a larger `count`; previously-shown/copied addresses stay visible (RTK Query serves the same
  `Address`-tagged cache key family, re-fetched with the new arg).
- **Copy copies the FULL address**, never the shortened display text (`shortenAddress` is
  presentational only).

### 18.2 At-rest keystore — `DIGWX1` v2 (current), v1 (legacy, decode-only)

The wallet entropy is stored ONLY as an encrypted `DIGWX1` record under `chrome.storage.local`
(`wallet.keystore`). No plaintext secret is ever written to any storage area. Two record versions
share the `DIGWX1` magic (`src/lib/keystore/digwx1.ts`):

**V2 (current writer, dig_ecosystem #147 Phase B).** ALL crypto delegates to the canonical
`dig-keystore` crate's `opaque` module via its wasm binding, `@dignetwork/dig-keystore-wasm`
(consumed as a vendored `file:` dependency at `third_party/dig-keystore-wasm/` pending its npm
publish — see the directory's `PROVENANCE.md`) — the SAME audited Argon2id + AES-256-GCM
implementation every other DIG binary's keystore file uses, instead of hand-rolling the primitives
in JS:

- **`seal(password, secret)` / `sealStrong(password, secret)`** — DEFAULT (64 MiB/3/4) or STRONG
  (256 MiB/4/4) Argon2id preset, drawn from OS randomness (`getrandom`'s "js" backend), producing a
  self-describing container (its own header carries the KDF params, salt, nonce; AES-256-GCM
  ciphertext+tag; CRC-32).
- **`open(password, blob)`** — re-derives the key from the blob's own header and AES-GCM-verifies;
  ANY failure (wrong password, tampering, or a non-opaque blob) throws, collapsed by the vault to
  the same opaque `UNLOCK_FAILED` as v1.
- **Record shape** (base64 field): `kdf`/`cipher` are placeholders — the real parameters live inside
  the wasm binding's container, not the JS-side record:
  ```json
  { "version":2, "magic":"DIGWX1",
    "kdf":{ "id":"dig-keystore-opaque" },
    "cipher":{ "id":"dig-keystore-opaque" },
    "ciphertext":"<b64 dig-keystore-wasm seal/sealStrong output>", "createdAt":<ms>, "label":"<optional>" }
  ```
- The real wasm module is loaded ONLY at the offscreen-document runtime edge
  (`src/entries/offscreen.ts`'s `getKeystoreWasm()`, mirroring `getChia()`/`loadChiaWasm`) and
  injected into `src/offscreen/vault.ts` via `VaultDeps.keystoreWasm` — `digwx1.ts` itself never
  imports the wasm binding directly, staying chrome-free/wasm-import-free and unit-testable with an
  injected fake (`src/test/keystoreWasmFake.ts`).

**V1 (legacy, DECODE-ONLY).** The extension's original hand-rolled writer — kept readable FOREVER
per §5.1's backwards-compatibility spirit for permanent at-rest formats; an existing user's vault,
encrypted before this extension migrated to V2, MUST keep opening. NO production call site writes
this format anymore (`encryptEntropyLegacyV1` still exists, exported for test-fixture generation and
decode-path regression coverage only):

- **KDF:** Argon2id (via the in-package `hash-wasm`) at the DEFAULT cost 64 MiB / 3 iterations /
  4 lanes (a STRONG 256 MiB preset was offered for high-value wallets), with a fresh 16-byte random
  salt.
- **Cipher:** AES-256-GCM (native WebCrypto), fresh 12-byte nonce, 128-bit tag. The record HEADER —
  `{version, magic, full kdf params, cipher id + nonce}` — is bound as GCM AAD, so tampering with any
  KDF param, the salt, or the nonce fails the tag CLOSED with no separate MAC.
- **Key handle:** the derived AES key is a NON-EXTRACTABLE `CryptoKey` (`extractable:false`), never
  serialized.
- **PBKDF2 fallback (bounded, never silent):** PBKDF2-HMAC-SHA-512 (≥600 000 iters, `kdf.id=pbkdf2`)
  engaged ONLY when the Argon2 wasm failed to instantiate; `decryptEntropy` still opens a
  PBKDF2-fallback V1 record.
- **Record shape** (base64 fields):
  ```json
  { "version":1, "magic":"DIGWX1",
    "kdf":{ "id":"argon2id","memKiB":65536,"iters":3,"lanes":4,"salt":"<b64 16B>" },
    "cipher":{ "id":"aes-256-gcm","nonce":"<b64 12B>" },
    "ciphertext":"<b64 entropy‖tag>", "createdAt":<ms>, "label":"<optional>" }
  ```

**Shared across both versions:**

- **Error opacity:** any decrypt failure (wrong password OR tampered blob) collapses to a single
  opaque `UNLOCK_FAILED`; only a structurally-invalid record yields `BAD_RECORD`.
- **Version dispatch:** `decryptEntropy` reads `record.version` and routes to the V2 (wasm-binding)
  or V1 (legacy JS) decode path — never both. `needsUpgrade(record)` reports `true` for ANY V1
  record (nothing currently forces re-encryption to V2; V1 stays readable forever regardless).
- **Additive versioning:** newer readers keep decoding every prior `version`; ids are never removed
  or repurposed. A golden-fixture test (`digwx1.test.ts`) pins a REAL V1 record (captured once from
  the pre-migration writer) and asserts it still decrypts to the exact original entropy — the
  concrete backwards-compatibility proof.
- Fresh salt + nonce (V1) / fresh salt + nonce inside the wasm container (V2) are drawn on every
  (re)encryption; RNG is `crypto.getRandomValues` (V1) / `getrandom`'s "js" backend (V2, inside the
  wasm binding).

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
  (user-configurable in the fullscreen Wallet Settings, §145, alongside the chain-node override).
  "Unlocked for the session" means unlocked for as long as the wallet is ACTIVELY used,
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
  switcher's Lock control, `wallet-lock`, reachable from both popup and fullscreen, and the
  Settings-panel `SessionStatus` "Lock now" button, §18.5a); a `chrome.alarms` minute sweep once the
  TTL lapses with no renewing activity; `chrome.idle` reporting `idle`/`locked` at an EXPLICIT
  60-second detection interval (`chrome.idle.setDetectionInterval`, matching the alarm's 1-minute
  granularity rather than an implicit platform default, #76); all-windows-close (the offscreen
  document tears down, dropping the in-memory key); a lock-on-wake check that recomputes the
  snapshot the moment the service worker (re)executes its top-level module code — which happens on
  every SW (re)start (OS sleep/wake, browser restart, SW eviction) — rather than waiting for the
  next alarm tick, #76.
- **lock state.** `getLockState` derives the snapshot PURELY from persisted storage — `none` (no
  keystore blob) / `locked` (blob present but the unlock window is absent or lapsed) / `unlocked`
  (blob + a fresh unlock window) — with NO round-trip to the offscreen vault, so it ALWAYS resolves
  immediately. A no-wallet user (who has no offscreen document at all) resolves instantly to `none`
  → onboarding, never blocking on a vault that will never answer. Auto-lock (the TTL sweep alarm +
  `chrome.idle`) independently zeroizes the vault and clears the unlock window when the TTL lapses,
  so a lapsed window reads as `locked` without a vault call; the SW spawns the offscreen document
  only to unlock / use the key, never to read state.
- **TTL cannot be outlived by a held approval window (#76).** The dApp `walletRpc` router's vault
  call (§18.12) is NOT a raw pass-through: it re-checks `getLockStateSnapshot()` — freshly, from
  storage, on every single call — before ever forwarding to the offscreen vault, and refuses with
  `{ success:false, code:'LOCKED' }` (tidying up the vault via `lockVaultNow()`) when the snapshot
  is not `unlocked`. This closes the specific race where a queued sign/spend can sit in the approval
  window for a long time (its keepalive port deliberately keeps the SW + vault alive so review isn't
  rushed) — without this check, the TTL number could say "expired" for up to a minute before the
  periodic alarm/idle listener got around to zeroizing the vault, during which the vault would still
  physically hold the key and happily sign. Proven end-to-end in `e2e/sw/approval-ttl-race.spec.ts`.

### 18.4 Storage schema (custody)

| Key | Area | Secret? | Contents |
|---|---|---|---|
| `wallet.registry` | `storage.local` | encrypted only | the multi-wallet registry (§18.16) — an array of `{ id, label, record (DIGWX1, §18.2), createdAt }`, one encrypted record per wallet |
| `wallet.keystore` | `storage.local` | encrypted only | the ACTIVE wallet's DIGWX1 record (§18.2) — a mirror of the active registry entry, so every single-wallet read path keeps working; the only at-rest secret alongside the registry |
| `wallet.activeId` | `storage.local` | no | active wallet id (multi-wallet switcher, §18.16) |
| `wallet.settings` | `storage.local` | no | durable settings (`unlockTtlMinutes`, `chainRpcUrl`, `chainPrivacyAck`, `locale`, `theme`, `network`, `chainSourceMode`, `chainSourceUrl`, fee default…) |
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

Two security nudges bracket the phrase-handling paths (Create/Import — #79):
- **Before the form.** Choosing Create or Import from Welcome routes through a phishing-education
  step first (DIG never asks for the recovery phrase anywhere; a phishing warning; never share it,
  including with someone claiming to be DIG support), requiring an explicit Continue before either
  form renders. Watch-only (a public key only, §18.19) and restore-from-backup (an existing
  ENCRYPTED file, not a typed phrase, §18.21) skip it — neither path exposes a raw phrase.
- **After a NEW phrase is confirmed.** Once the confirm-word gate succeeds for a freshly CREATED
  wallet, a backup reminder — pointing at the encrypted backup-file export (reachable from the
  wallet switcher, §18.21) as a second recovery method — renders BEFORE the gate proceeds to the
  wallet. Import skips it: an imported phrase is already backed up by definition, so `doImport`
  still finishes straight to the wallet.

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
- **Chain source (coinset tier).** This coinset path is the FALLBACK tier of the wallet-data source
  abstraction (§18.6c): the wasm coinset `RpcClient` fetches the configured chain endpoint from the
  offscreen document (extensions bypass CORS). Default `https://api.coinset.org`; an explicit
  `wallet.settings.chainRpcUrl` override wins (§5.3 — a user-facing custom node, settable +
  persisted; discoverable via `ChainNodeSetting` in the fullscreen Wallet Settings, §145 — the
  everyday popup never needs it); absent an override, the selected network's default applies
  (§18.6b). When a dig-node is the resolved source (§18.6c), these coinset reads are bypassed in
  favor of the node's Sage-parity `get_*` — the `dig.local`/`localhost` ladder now DOES feed wallet
  reads through that node surface (#217), superseding the prior "a DIG node does not expose
  coinset-shape chain reads" limitation.
- **Privacy.** The wallet DISCLOSES, once (until acknowledged, `wallet.settings.chainPrivacyAck`),
  that a scan reveals the wallet's full address set to the configured operator, and offers the
  override so a privacy-minded user can point at their own node.
- **Caching.** The last scan is cached (`walletCache.balances`, non-secret); a transient scan failure
  returns the cached snapshot flagged `cached` (cached-first paint).
- **Receive.** The receive address is the ACTIVE index's unhardened address (§18.1a,
  `getReceiveAddress`) — navigating the index changes which address Receive shows. Since one address
  serves every asset (XCH, `$DIG`, every CAT), the Receive screen needs no per-asset selector (§2.1a)
  — it shows that single QR/address, full stop.

### 18.6a Assets list — value ordering + a pinned header block above the live filter (#167, #202, #204)

The Home Assets list is a VIEW transform over `custodyAssetBalances` (§18.6) — it never changes the
scan/discovery, only how the resolved rows are ordered, which are pinned, and which are shown:

- **Ordering (`orderAssetsByValue`).** XCH is the hero/prominent row (`pickHeroBalance`) and always
  renders first, unmoved. `$DIG` renders second, ALSO unconditionally (#202) — regardless of its own
  or any other row's USD value, because it is the network's own token, not just another CAT. Every
  remaining CAT sorts beneath those two, highest value first, in two tiers:
  1. Rows with a KNOWN USD value (`assetUsdValue`, §18.13 pricing) sort by that value, descending.
  2. Rows with NO known price sort after every priced row: a "known" token (a CAT whose ticker
     resolved via the registry — i.e. NOT the generic `CAT` fallback, §18.6) outranks a
     generic-unknown one, then within a tier by held amount (normalized by decimals), descending. A
     null/unknown balance sorts last within its tier. Ties preserve the original discovery order
     (a stable sort) — never a re-shuffle on every render for equal-value rows.
- **Pinned header block (`splitPinnedAssets`, #204).** XCH and $DIG (in that order, whichever are
  held) render as a FIXED block ABOVE the filter input — `splitPinnedAssets` partitions
  `orderAssetsByValue`'s output into `{ pinned, filterable }`, where `pinned` is exactly `[xch?,
  dig?]` and `filterable` is every other CAT. The filter predicate is applied ONLY to `filterable`;
  `pinned` is rendered unconditionally before the `AssetFilterField` and is NEVER hidden or reordered
  by a filter query, including a query that matches nothing in the CAT list (the CAT-list empty state
  renders beneath the still-visible pinned block, never replacing it).
- **Live filter (`filterAssetsByQuery` + `AssetFilterField`).** The search field renders directly
  below the pinned XCH+$DIG block: it narrows the filterable CAT rows live by a case-insensitive
  substring match against EITHER the ticker or the display name. A blank query shows every filterable
  row unchanged; a query matching nothing shows a dedicated empty-state line
  (`wallet.assets.filter.empty`) rather than silently rendering nothing — Clear restores the full
  filterable list (the pinned block was never affected either way).
- **Autocomplete (`assetAutocompleteSuggestions`).** The filter field's native `<datalist>` suggests
  candidates from BOTH the currently-held FILTERABLE rows AND the full known-CAT registry (so a
  recognized name/ticker not currently held still autocompletes — filtering on it then honestly shows
  the empty state, never a silent no-op). Deduped by ticker (a held row wins over a registry
  duplicate), a prefix match ranks above a mere substring match, capped to 8 suggestions.
- **Scope.** Every other consumer of `custodyAssetBalances` (`SendPanel`'s asset picker,
  `ManageTokens`, `CoinControlPanel`, `TradePanel`) receives the UNSORTED, UNFILTERED, UNPINNED array
  — this ordering/pinning/filtering is local to the Home Assets list's own render.

### 18.6b Network selection — mainnet/testnet11 (#108)

A user-facing switcher (`NetworkSetting`, fullscreen-only §145, alongside the chain-node override)
selects which Chia network the wallet's balance/activity/coin reads resolve against:

- **Config (`src/lib/network.ts`).** Two networks, `mainnet` (default) and `testnet` (Chia's
  testnet11), each carrying the three things that differ between them: the bech32(m) address prefix
  (`xch`/`txch`), the AGG_SIG_ME additional data (§18.7's network genesis), and the default coinset
  endpoint (`https://api.coinset.org` / `https://testnet11.api.coinset.org`). Persisted to
  `wallet.settings.network`; missing/unrecognized resolves to `mainnet` — the honest, funds-safe
  default for every caller written before this switcher existed.
- **Read-path wiring.** `resolveCoinsetUrl` (`src/lib/custody-session.ts`) resolves the effective
  coinset endpoint: an explicit `chainRpcUrl` override ALWAYS wins (§5.3, unchanged); absent that,
  the selected network's default applies. Every existing SW→vault call site already funnels through
  this one function, so balances/activity/coins/NFTs/DIDs genuinely read from the selected network
  with no per-call-site change.
- **Guardrail (mainnet is real funds).** Switching networks requires an explicit two-step confirm
  (`NetworkSetting` shows the target network + what changes before persisting); a persistent
  `AppHeader` badge names the active network whenever it is NOT mainnet, visible on both popup and
  fullscreen, so a user is never unsure which network a balance/activity view reflects. A confirmed
  switch invalidates the network-dependent RTK Query tags (`Balances`/`Activity`/`Address`/
  `Collectibles`/`Coins`) so the UI re-fetches against the new endpoint immediately.
- **Known limitation (tracked, not silent).** Spend SIGNING (§18.7's `MAINNET_AGG_SIG_ME`, used by
  `confirmSend`/`decodeDappSpend`/`signDappSpend` in the offscreen vault) and address DERIVATION
  (§18.1, the `xch` bech32m prefix) are currently pinned to mainnet regardless of the selected
  network — threading the network choice through those paths touches the SW's send/dApp-signing
  dispatch (`src/background/index.ts`), which is out of this change's scope. A signed testnet spend
  therefore fails safely at broadcast (a mainnet-domain signature is simply invalid on testnet) rather
  than at risk of moving real funds. `NETWORKS.testnet.aggSigMeHex`/`.addressPrefix` are already
  defined and tested (`network.test.ts`) — wiring them through is a scoped follow-up, not a design gap.

### 18.6c Wallet-data source — node-first, coinset fallback (#217, phase 3 of #205)

The wallet READS (balances, tokens, NFTs, DIDs, coins, activity) resolve through a **source
abstraction**: the extension prefers a running **dig-node's Sage-parity `get_*` RPC** (private, fast,
the user's own machine) and falls back to the coinset path (§18.6) otherwise. Signing is NEVER part
of this — the dig-node is a **read-only** chain-data source for the extension; every key stays in the
offscreen DIGWX1 vault and the node never receives one.

- **Source resolution (`src/lib/wallet-source.ts`, pure).** `resolveWalletSource(setting, deps)`
  maps the persisted 4-state selection to a resolved source over the injected §5.3 ladder:
  - `auto` (default) — the ladder node when reachable (non-strict: a read error falls back to
    coinset), else coinset.
  - `node` — force the ladder node (strict): unreachable ⇒ `unavailable` (surfaced as an error UI),
    never a silent coinset downgrade.
  - `coinset` — force the coinset path; the node is not consulted for wallet data.
  - `custom` — force an explicit node RPC base URL (overrides the ladder entirely, §5.3); blank ⇒
    `custom-missing`, unreachable ⇒ `custom-unreachable`.
  Persisted to `wallet.settings.chainSourceMode` + `.chainSourceUrl`; missing ⇒ `auto` (a pre-#217
  wallet keeps today's node-first-then-coinset behavior with no migration).
- **Node client (`src/lib/node-wallet.ts`, pure, READ-ONLY).** `makeNodeWalletClient(base)` POSTs the
  Sage v0.12.11 method surface (`POST {base}/{method}`, snake_case; design
  `docs/design/dig-node-sage-parity-rpc.md` Part A) to the node's browser-facing plain-HTTP + CORS
  mirror (port 9778, transport #2) and MAPS each response into the vault's OWN result shapes so the
  RTK Query layer + UI are source-agnostic:
  - `get_sync_status.selectable_balance` (XCH) + `get_cats[].balance` → `{ xch, cats }` (§18.6).
  - `get_nfts` → `WalletNft[]`; `get_dids` → `WalletDid[]`; `get_coins` → `{ coinId, amount,
    confirmedHeight }[]`; `get_transactions` → confirmed `LocalActivityEntry[]` (block-time net own
    flow per asset: created-to-own minus spent-from-own → received/sent).
  - The `WalletNft`/`WalletDid` `p2PuzzleHash` (and `WalletDid.numVerificationsRequired`) have no
    field in the Sage records and are display-only for the node-sourced list — they are blank/default
    (the local signing/transfer path re-derives them from chain in the vault; it never trusts a
    listed value). It follows that the node source reflects the wallet the **node** tracks; the
    integration premise is that the user's node tracks the user's wallet.
- **SW wiring (`src/background/index.ts`).** `resolveWalletDataSource()` injects the cached §5.3
  resolver + a direct probe into the pure resolver; `readFromNodeSource(nodeFn)` runs the node read
  when the source is a node and returns `{ handled }` so the five read handlers
  (`getCustodyBalances`/`listNfts`/`listDids`/`listCoins`/`getActivity`) branch node-first and fall
  through to the existing coinset/vault path when the source is coinset or an `auto` node read fails.
  A forced (node/custom) source that fails returns `NODE_UNAVAILABLE`/`NODE_READ_FAILED` (four-state
  error), never a silent downgrade.
- **Settings switch (`ChainSourceSetting`, fullscreen §145).** The user-facing 4-state control
  (Auto / My dig-node / coinset.org / Custom node URL), persisted + mirrored into the `ui` slice,
  react-intl'd across all 14 locales, a11y-labelled, four RTK-Query states; a change invalidates the
  wallet-data tags so every view re-reads from the new source. Satisfies §5.3's "custom-node config
  must be user-facing on every client" for the wallet-data path.
- **Auto-detect indicator (#222).** The extension does not wait for a wallet-data fetch to discover a
  local node: `resolveLocalDigNode()` (the shared §5.3 cache backing both the content path and this
  wallet path) is warmed proactively on SW `onStartup`/`onInstalled`, and `ChainSourceSetting` queries
  `getChainSourceStatus` on mount (+ a 15s poll while open) to show the result immediately. When Auto
  mode's ladder resolves to a reachable node, the panel renders a **"Local dig-node detected"**
  indicator naming the resolved endpoint (`src/lib/wallet-source-status.ts`
  `walletSourceIndicatorView`, a pure `{mode, resolved} → {visible, tone, labelId, endpoint}`
  mapping) — zero-config, no `server.host`/custom-URL entry required. The indicator is scoped to
  `mode === 'auto'` with a `resolved.kind === 'node'` result; a user-forced mode (node/custom/coinset)
  relies on its own `custody.source.hint.*` copy + the four-state error UI instead, so the two never
  disagree.

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

### 18.8b Memo — an optional note on a send (#105)

`prepareSend` accepts an optional `memo` (plain UTF-8 text, ≤512 bytes) attached to the recipient's
CREATE_COIN as a SINGLE-atom memo list — built via `clvm.alloc([bytes])` against the SAME `Clvm`
instance the send driver allocates internally (`send.ts`'s `buildMemos` hook, the same seam
§18.8a's clawback memo uses). **Memos are PUBLIC on chain** — the UI states this next to the field;
it is a payment reference, never a place for secrets.

- **Mutually exclusive with `clawbackSeconds` in v1** — a clawback send's memo slot already carries
  `[receiverPuzzleHash, clawback.memo()]` (the reconstruction params); combining the two is rejected
  `BAD_REQUEST` rather than silently dropped or merged.
- **Decoded back from the built spend, never echoed from caller input** (§5.5): `send.ts`'s
  `decodePlainMemo` reads the recipient's actual CREATE_COIN memo list and requires it be EXACTLY
  ONE atom (the shape this feature builds) before decoding it as UTF-8 — a clawback's 2-element list
  is structurally distinct and never mistaken for a plain memo. The decoded value is
  `summary.memoText`, shown in the review step so the user sees exactly what will land on chain.
  CAT sends echo `opts.memo` directly into `summary.memoText` instead (matching that path's existing
  echo-not-decode rigor for `sent`/`change`).
- **Gotcha:** `TextEncoder().encode(...)` output can fail the wasm boundary's `instanceof
  Uint8Array` check under Vitest/jsdom (a cross-realm typed array) — always normalize with
  `Uint8Array.from(...)` before passing bytes to `chia-wallet-sdk-wasm` (`sendFlow.ts`'s
  `buildPlainMemo`).
- Available in BOTH the popup and fullscreen `SendPanel` (not gated behind `full`, unlike clawback)
  — an optional note is basic functionality, not an advanced/rare operation.

### 18.8c QR camera scanner (#107)

`QrScanner` (`features/wallet/custody/QrScanner.tsx`) scans a recipient address (or an `offer1…`
string) via the device camera and reports the decoded text to its caller. No new wasm — decoding is
`jsqr` (a small pure-JS QR decoder, no native/wasm binding), kept behind the pure
`lib/qrScan.ts#decodeQrFromImageData` seam so the decode + camera-error classification are
unit-tested without a real camera or `HTMLCanvasElement` 2D rendering (jsdom has neither).

- **Lifecycle:** `requesting` (a `getUserMedia({video:{facingMode:'environment'}})` prompt is in
  flight) → `scanning` (a live `<video>` preview + a `requestAnimationFrame` loop that draws each
  frame to an offscreen `<canvas>`, reads its `ImageData`, and calls `decodeQrFromImageData`) → on a
  decode, the camera stops and `onScan(text)` fires exactly once. `error` renders instead of
  `requesting`/`scanning` when the camera can't be used at all.
- **Camera NEVER left running.** Every exit path — a successful decode, clicking Cancel, or the
  component unmounting — stops every `MediaStreamTrack` and cancels the pending animation frame.
  Cancel stops the camera directly (not merely via the unmount cleanup) — a privacy-sensitive
  resource like a live camera must not depend on unmount timing to turn off.
- **Graceful camera-access failures** (`lib/qrScan.ts#classifyCameraError`): `NotAllowedError`/
  `SecurityError` → permission-denied copy (points at browser settings); `NotFoundError`/
  `OverconstrainedError` → no-camera-found copy; no `navigator.mediaDevices.getUserMedia` at all
  (checked BEFORE ever prompting) → unsupported copy; anything else → a generic retry-able message.
  Cancel always works from the error state.
- **FULLSCREEN-ONLY** (§145, mirroring the clawback advanced option, §18.8a): the popup surface
  never renders the Scan button — a live camera preview needs more room than the compact popup, and
  the OS permission prompt can steal focus and close a popup mid-request. Wired into `SendPanel`'s
  recipient field; a decode calls the SAME `updateRecipient` the manual input and contact picker use
  (so the #74 address-poisoning check, §18.14, still runs against a scanned address).

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

**Entry shape:** `{ id, kind, asset, amount, counterparty, coinId, timestamp, status, clawback?, fee?, memo? }` —
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
- `fee` (#113) — the network fee paid, in XCH mojos (fees are ALWAYS paid in XCH regardless of the
  transferred asset). `memo` (#113) — an optional user-supplied note. Both are ADDITIVE + OPTIONAL:
  absent on a `received` entry and on any entry logged before these fields existed; the detail view
  (below) renders each only when present, never fabricating a fee/memo for an entry that recorded
  none.

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
registry actually knows.

**Transaction detail view (#113).** Tapping an activity row expands it in place
(`data-testid="activity-receipt-<id>"`) into a full receipt built purely from the row's own
already-formatted fields (`activityRows.ts`, no new wasm, no on-chain reconstruction): amount +
ticker, the counterparty (when one exists), status (`Confirmed`/`Pending` — a local-log entry carries
no block height, so status IS the confirmation signal; there is no separate confirmation COUNT),
timestamp (locale-formatted via `intl.formatDate`), the recorded fee (formatted in XCH — ALWAYS XCH,
independent of the transferred asset's own decimals) and memo, each shown ONLY when the entry
actually recorded one (§5.1-style additive honesty — never a fabricated fee/memo), and the coin id.

**Block-explorer link coverage (#114).** Every explorer link in the extension is built from the ONE
centralized set of `lib/links.ts` SpaceScan URL builders — `spaceScanCoinUrl` (a coin/transaction),
`spaceScanAddressUrl` (a bech32 `xch1…` address), `spaceScanTokenUrl` (a CAT's `/token/<TAIL>` page,
accepts an id with or without a `0x` prefix), and `spaceScanNftUrl` (an NFT's `/nft/<nft1…>` page) —
each opened via the shared `ExternalLink` component (a real `<a target="_blank">`, `chrome.tabs.create`
inside the extension) so link behavior is consistent everywhere. The Activity receipt surfaces up to
THREE distinct links, each only when applicable:
  - the per-spend coin/transaction link (`spaceScanCoinUrl`) — shown ONLY once `status === 'confirmed'`
    (a still-pending or coinId-less coin may not resolve on the block explorer yet);
  - a counterparty ADDRESS link (`spaceScanAddressUrl`, built from the entry's FULL, unshortened
    address — distinct from the row's own shortened DISPLAY text) — shown whenever a counterparty
    exists, independent of the spend's own confirmation state (an address is valid to look up
    regardless);
  - a CAT TOKEN link (`spaceScanTokenUrl`) — shown for any CAT-class asset (excludes `XCH` and the
    synthetic `NFT`/`DID` labels; $DIG counts too, since it is a CAT under the hood).
`spaceScanNftUrl` is defined for ecosystem-wide reuse (e.g. a future Collectibles NFT-detail view)
but is not yet wired into any surface — Activity has no NFT-asset rows to link today (a mint/transfer
entry uses the synthetic `NFT` label, not a specific token id).

### 18.10 Trade offers

Offers are assembled from `chia-wallet-sdk-wasm` primitives to match the canonical `chia-sdk-driver`
offer construction byte-for-byte, so they interoperate with Sage / dexie. All money paths are proven
consensus-valid by a two-party simulator settlement test. v1 supported a SINGLE offered asset and a
SINGLE requested asset, each XCH or a CAT (covering every XCH↔token trade); v2 (#94) additionally
supports offering an NFT (selling a self-custody NFT for XCH/CAT), with CHIP-0011 royalty; v3 (#100)
generalizes `offered`/`requested` to ARRAYS — 1 or more legs per side, any mix of XCH/CAT on EITHER
side plus at most one offered NFT (the NFT-per-offer cap is unchanged). No asset may appear more than
once on the same side (`DUPLICATE_ASSET`), and no asset may appear on BOTH sides (`SAME_ASSET`,
generalized from the v1 single-pair check). The offer's `Offer::nonce` is computed once, over the
ascending-sorted coin ids of EVERY offered coin across every offered asset, and every requested
leg's `NotarizedPayment` shares that same nonce — one notarized payment + one phantom carrier +
one `AssertPuzzleAnnouncement` per requested leg. `INSPECT`/`TAKE`/`CANCEL` already parsed/handled an
arbitrary number of legs per side (the array shape was latent in their coin-spend reconstruction);
#100's change is concentrated in `makeOffer`'s construction loop + the wire/UI plumbing.

- **Surface tiering (#169, refining #145; extended by #100).** A BASIC maker/taker renders on BOTH
  the compact popup AND fullscreen — a single give leg + a single get leg, one asset each. Taking an
  offer has no advanced variant (accepting fixed, already-built terms is basic by nature) and is
  IDENTICAL on both surfaces. Two capabilities are ADVANCED — fullscreen (ExpandedLayout) ONLY:
  offering one of the wallet's own NFTs (the give-kind toggle, #94), and composing MULTIPLE assets
  per side via "+ Add another asset" (`trade-give-add-asset`/`trade-get-add-asset`, #100 — each added
  row gets its own `trade-give-asset-{i}`/`trade-give-amount-{i}` pair and a
  `trade-give-remove-asset-{i}` control, mirrored on the get side). The popup keeps a persistent
  "open full screen" link (`trade-open-fullscreen`) for both. This SUPERSEDES the earlier #145 rule
  that gated the entire Trade surface to fullscreen.
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

### 18.10a Saved/active offer management + status (#101)

The local "your offers" log (`lib/offer-log.ts`) persists every offer this wallet has MADE via
`makeOffer`, so the **Offers** tab (`trade-mode-offers`, a third mode alongside Make/Take) lists them
with a derived status, lets the maker re-share a still-open one, and cancel it — a
MetaMask/dexie-"My offers"-style ledger, NOT a marketplace/network scan. Storage mirrors the #154
local activity log's idiom exactly: `chrome.storage.local[OFFER_LOG_KEY]`, a flat map keyed by
`"<walletId>:<activeIndex>"` → that scope's own ring-buffered entry array (newest first, capped at
200), never cleared on wallet switch or index navigation.

- **Recording.** The SW appends an entry the moment `makeOffer` succeeds (there is no broadcast to
  hang this on — an offer is only a promise until someone takes it): `{ id, offer, summary,
  coinIdHex, createdAt, status:'open' }`, where `coinIdHex` is the first of `makeOffer`'s
  {@link MadeOffer.offeredCoinIdsHex} (#100) — any ONE of the offer's real offered coin ids suffices,
  since the maker's spend consumes them all atomically together whether taken or cancelled.
- **Status is derived, not pushed** (Chia has no "someone took my offer" event):
  - `open` — the initial state; the offered coin(s) are still unspent.
  - `taken` — `getOffers` reconciles every still-`open` entry against the chain first (the SAME
    `sendStatus` vault op the send/trade confirm-poll uses, one cheap coin-spent check per entry) —
    a coin observed spent that this wallet did NOT itself cancel flips to `taken`.
  - `cancelled` — `confirmTrade` returns `tradeKind:'take'|'cancel'` (#101 addition to its response)
    so the SW can EAGERLY flip the matching entry the moment a cancel broadcasts, rather than waiting
    for the next `getOffers` poll (which would otherwise misclassify the spend as `taken`).
  - `expired` — RESERVED (mirrors `activity-log.ts`'s reserved `offer`/`clawback`/`melt` kinds); the
    offer engine does not set an on-chain expiry timestamp yet, so this is never currently emitted.
  A terminal status (`taken`/`cancelled`) is never re-flipped by a later poll.
- **Surface tiering, extending §18.10's advanced-capability gating.** BOTH surfaces render the SAME
  list + status — the log itself is not fullscreen-gated. Only fullscreen renders the per-offer
  ACTIONS (re-share via copy, and cancel for a still-open offer, reusing the existing
  `prepareTrade('cancel')` → `confirmTrade` path); the popup is VIEW-ONLY (status only), matching its
  persistent `trade-open-fullscreen` link for "go manage it".
- Read-only listing is proven end-to-end in Playwright against the built extension
  (`e2e/sw/offer-management.spec.ts` — the empty state, deterministic and network-free since
  reconciliation only calls the chain for `open` entries). The append/status-flip/ring-buffer logic
  is unit-tested (`lib/offer-log.test.ts`); the full copy/cancel/status UI is unit-tested with a
  mocked SW (`OffersPanel.test.tsx`) — a live-coinset-dependent full make→list→cancel round trip is
  not exercised in CI (no live chain access), matching the existing `offers.spec.ts` split.

### 18.10b dexie marketplace integration (#102)

A thin client (`lib/dexie.ts`, chrome-free — `fetch` injected) for the public `api.dexie.space/v1`
REST API — an offer AGGREGATOR, not a counterparty: this wallet's own offer bytes are already
dexie-compatible (the same `chia-sdk-driver` construction, §18.10's module doc), so posting is a
plain upload of bytes `makeOffer` already built. `api.dexie.space` is pre-granted in both
`host_permissions` and the extension-pages CSP `connect-src` (`manifest.json`).

- **Post** (`dexiePost` → `postOfferToDexie`): upload an already-built `offer1…` string. Fullscreen
  ONLY — a "Post to Dexie" button on the MAKE deal card, alongside the existing copy/QR/cancel
  actions. Returns dexie's own id; `known:true` when dexie had already indexed the exact bytes.
- **Browse** (`dexieBrowse` → `searchDexieOffers`): list currently-open offers (`status:0`),
  optionally filtered by offered/requested asset. Fullscreen ONLY — a "Browse Dexie" toggle on the
  TAKE paste form, listing each row's dexie-reported `<amount> <code>` legs (DISPLAY only, see the
  amount caveat below) with an "Import" button.
- **Resolve / import** (`dexieResolve` → `fetchDexieOffer`): given a `dexie.space/offers/<id>` URL
  or a bare id, fetch the underlying `offer1…` bytes. Wired into the Take paste box itself: pasting
  input that doesn't start with `offer1` is tried as a dexie link/id FIRST (before the normal
  invalid-offer rejection) — so a user can paste either a raw offer string or a dexie link
  interchangeably. Importing from the Browse list skips the resolve round trip (the search response
  already embeds the full offer bytes) and goes straight to the shared `inspectOffer` step.
- **Fail-closed: dexie's own decoded fields are DISPLAY-only, never trusted for the actual take.**
  Every dexie response embeds its own `offered`/`requested` arrays with HUMAN-decimal `amount`
  numbers (dexie normalizes server-side; confirmed against the LIVE API — no formal OpenAPI spec is
  published, see DEVELOPMENT_LOG.md) — these are used ONLY to render the browse list. The instant a
  user imports/resolves an offer, its raw `offer1…` bytes are fed into this wallet's OWN
  `inspectOffer`, which re-derives the two-sided summary from scratch exactly like a pasted or
  dropped offer (§18.10) — dexie is never a source of truth for what a spend actually does.
- `dexiePost`/`dexieBrowse`/`dexieResolve` are NOT custody actions (no wallet key involved) —
  handled directly by the SW, mirroring `getNftMetadata`'s off-chain-fetch pattern (§18.11c) rather
  than routing through the offscreen vault.
- The pure client is unit-tested (`lib/dexie.test.ts`) with an injected fetch stub; the full
  post/browse/import UI incl. failure paths is unit-tested with a mocked SW (`tradePanel.test.tsx`).
  `e2e/sw/dexie-integration.spec.ts` proves REAL wiring against the live `api.dexie.space` API
  (reachable from CI, unlike coinset) — a real browse read, a real post-rejection for a garbage
  offer, and a real "no such id" resolve — never posting an actual wallet-built offer (that needs a
  live coinset read to build, out of scope here, matching the `offers.spec.ts` split) and never
  broadcasting a mainnet spend.

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
  - **Loaded via `<img crossOrigin="anonymous">` + canvas, NOT `fetch()`.** Predates #98's
    `connect-src` widening to `https:` (§2, needed for `getNftMetadata`, §18.11c) and is kept this
    way on purpose even though a raw `fetch(url)` is no longer CSP-blocked here: reading a JSON
    response back into script is a materially bigger exfiltration surface for a compromised page
    script than `<img>` bytes are (a plain `<img>` load without `crossOrigin` never exposes its
    pixels to script at all), so image bytes stay on the narrower `img-src`-only path.
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

### 18.11a Collectibles multi-select — bulk transfer, assign-DID & destructive burn (#171, #99)

The Collectibles grid supports selecting MULTIPLE NFTs at once and moving, re-owning, or destroying all
of them in ONE spend bundle (one broadcast, one aggregated signature) — the same discovery/
reconstruction/same-allocator rules as §18.11 apply to every selected NFT.

- **Fullscreen-only, mirroring mint/assign (§6.1/#145).** Selection mode (`CollectiblesPanel.tsx`)
  exists ONLY on the fullscreen surface — a "Select" control toggles it, tapping a tile in selection
  mode toggles membership instead of opening the detail view, and a selection bar shows the live count
  + select-all/clear + Transfer / Assign DID / Burn actions once ≥1 NFT is selected. The popup surface
  stays view-only: it NEVER enters selection mode, offering an "open full screen" link instead, exactly
  like the existing mint/assign popup affordances.
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
- **Bulk assign-DID (#99, `prepareNftBulkDidAssign` / `confirmNftBulkDidAssign`).** Generalizes the
  single-NFT §18.11 assign-owner CHIP-0011 handshake to the whole selected set in ONE spend bundle:
  each selected NFT emits its own `TransferNft` condition and its own
  `assignment_puzzle_announcement_id`, and the wallet's chosen DID is spent EXACTLY ONCE — asserting
  every NFT's announcement id and creating one puzzle announcement per NFT launcher id in return, so
  all N handshakes settle atomically (`src/offscreen/didAssign.ts`, Simulator-validated in
  `didAssign.test.ts`). Neither the NFTs' nor the DID's custody changes; only each NFT's on-chain
  `currentOwner` is set to the DID. `launcherIds` is deduped + MUST be non-empty (`NO_NFTS_SELECTED`);
  any selected NFT the wallet does not hold fails the WHOLE prepare (`NFT_NOT_FOUND`) — builds
  completely or not at all. A fee is paid ONCE from a separate wallet-owned XCH coin. The UI
  (`BulkNftActions.tsx` `assign` mode) is a pick-DID → review → confirm flow with the four states;
  `confirmNftBulkDidAssign` reuses the vault's `confirmSend` broadcast path and is logged as the
  `did` activity kind.

### 18.11b NFT picker — XL modal multi-select grid (#170)

`NftPickerModal.tsx` (`src/features/collectibles/`) is a reusable XL modal for CHOOSING NFTs from the
wallet's collectibles — a scrollable, searchable, multi-select grid used wherever a flow needs the
user to pick from their NFTs. It fetches its own data (`useListCollectiblesQuery`) so any caller can
drop it in without separately wiring the collectibles query.

- **Reuses the §18.11a selection primitive, not a re-implementation.** The grid is the exact `NftGrid`
  component #171's Collectibles bulk-select established (tile + checkbox overlay + `aria-pressed` +
  "Select {name}" label), exported from `CollectiblesPanel.tsx` and imported here — only the
  surrounding chrome (title, search, select-all/clear, pagination, the "Add N selected" confirm
  footer) is new.
- **Multi-select is the default, generic behavior; a single-select mode caps it to one.** `multiple`
  (default `true`) allows choosing any number of NFTs, with select-all/clear controls and a live "N
  selected" count. `multiple={false}` hides select-all/clear (they have no meaning for one pick) and
  makes tapping a NEW tile REPLACE the current pick rather than adding to it. The NFT-trade give side
  (§18.10) opens the modal with `multiple={false}`, because `makeOffer`'s v1 model supports at most
  ONE offered NFT per trade — the modal itself stays generically multi-select-capable for any future
  caller that needs more than one (a bundled multi-NFT offer, when the offer engine supports it,
  changes only its call site's `multiple` prop, not the modal).
- **Search** matches the displayed name, the full launcher id, or the collection id
  (case-insensitive substring). A search that matches nothing shows a distinct "no results" message —
  never the empty-wallet state (`FourState`'s `isEmpty` reflects the WALLET having zero NFTs, not the
  current filter).
- **Pagination, not virtualization.** The grid renders `PAGE_SIZE` (24) tiles at a time with a "Load
  more" button revealing the rest, so a wallet with hundreds of NFTs never mounts every tile at once.
- **Accessible like `Sheet`/`NftImageLightbox`.** `role="dialog"` + `aria-modal`, focus moves into the
  dialog on open and restores to the trigger on close, Tab is TRAPPED within the dialog, Escape
  closes, a backdrop click closes (a click on the dialog itself does not). Sized "XL" (`.dig-modal-xl`,
  `theme.css`) — larger than `Sheet`, since a browsable grid needs real estate; on narrow viewports it
  becomes a full-screen sheet (no page horizontal scroll, #163).
- **Portaled to `document.body` (`createPortal`) — NOT rendered inline in the component tree.** This
  sidesteps a real, pre-existing layout trap discovered while building this modal: the mobile-OS
  screen wrapper (`.dig-screen`) plays a permanent (`animation-fill-mode: both`) entrance animation
  whose resolved `transform` never reverts to the literal `none` keyword, which establishes a CSS
  containing block for `position: fixed` descendants; separately, the compact layout's
  `.dig-app[data-layout='compact'] > *` rule forces equal `z-index` onto the header/content/tab-bar
  siblings, so the bottom tab bar (later in DOM order) paints ABOVE anything nested inside the content
  area regardless of that content's own z-index. Together these would silently confine an ordinarily-
  rendered fixed modal to the current screen's scrolled box AND stack it below the tab bar
  (intercepting its clicks) on a narrow fullscreen viewport. A portal to `document.body` escapes that
  ancestor chain entirely (for both positioning and stacking) without touching the shared layout CSS
  other modals still rely on; see `DEVELOPMENT_LOG.md` for the full gotcha. `Sheet`
  (`components/Sheet.tsx`, the Send/Receive/wallet-switcher modal) and `NftImageLightbox` are ALSO
  portaled to `document.body` the same way (#200) — every overlay in this codebase renders through a
  portal, none inline in the `.dig-screen` tree.
- **Wired into Trade (§18.10).** `MakeTrade`'s NFT give-kind replaces the plain `<select>` dropdown
  with a "Select NFT" trigger that opens this modal; the chosen NFT renders as a small thumbnail +
  name chip with a "Change" affordance that reopens the modal pre-selecting the current pick. The
  wallet-empty case (`nfts.length === 0`) still shows the existing inline empty message without
  opening the modal at all.

### 18.11c NFT collection metadata + richer gallery (#98)

§18.11's `listNfts` only decodes the NFT's ON-CHAIN metadata program (edition/royalty/URIs) — no
human name, description, trait attributes, or real collection name exists on-chain. CHIP-0007 defines
those as an OFF-CHAIN JSON document at `metadataUris[0]`, which nothing in the extension parsed before
#98 (the gallery/detail showed only the shortened launcher id and the owner-DID hex as a collection
stand-in).

- **Wire shape (`src/lib/nft-offchain-metadata.ts`, `parseNftOffchainMetadata`).** Matches the
  CHIP-0007 document `chip35_dl_coin`'s `Chip0007Metadata`/`CollectionRef`/`CollectionAttribute` Rust
  types mint (the ecosystem's one schema, read-side counterpart): `{ format, name, description,
  minting_tool, sensitive_content, series_number, series_total, attributes:[{trait_type,value}],
  collection:{ id, name, attributes:[{type,value}] } }`. `collection.attributes[].type` accepts the
  legacy `trait_type` key too (parity with `chip35_dl_coin`'s #189 collection-attr fix — some older
  minted documents used it for the same field).
- **Untrusted input — never throws, always capped.** `raw` is third-party content served by whatever
  host the on-chain URI happens to name. The parser pulls only the known string/array fields, caps
  every string length (name 200, description 4000) and the attributes array (100 entries), and
  returns `null` for a non-object or a document with none of the recognized fields — the caller then
  falls back to the existing on-chain-only display exactly as if no `metadataUris` existed at all.
- **Fetched by the background service worker (`getNftMetadata`, §7), NOT the offscreen vault** — a
  simple no-vault-dependency read, matching the other non-custody SW actions (`getDigDnsStatus`,
  `getVerification`, …), not a CSP workaround (see below). The handler is GET-only, time-capped, and
  rejects a response over 200 KB (`TOO_LARGE`) before attempting to parse it — a CHIP-0007 document
  is always small.
- **`connect-src`/`host_permissions` are widened to any HTTPS host (§2) — required, not optional.**
  `metadataUris` point at arbitrary hosts (IPFS gateways, marketplace CDNs) not enumerable in
  advance. It was assumed while designing this that a Manifest V3 background SERVICE WORKER's own
  `fetch()` is NOT subject to the `extension_pages` CSP `connect-src` directive (its name suggests it
  governs only extension HTML documents — popup, options, offscreen — not the service worker
  script). **That assumption was empirically WRONG** (`DEVELOPMENT_LOG.md`): a `getNftMetadata` call
  to a host outside `connect-src` failed with a network error and the request never reached the
  network layer at all — the signature of a CSP block, not a CORS failure (which would still hit the
  network before failing to read the response). `connect-src` had to gain `https:` and
  `host_permissions` an all-hosts pattern (the latter for the extension's CORS-bypass fetch
  elevation — most off-chain metadata hosts won't send `Access-Control-Allow-Origin`) before the SW
  could reach an arbitrary host at all. This matches the breadth `img-src: https:` already grants NFT
  art (§18.11) — the same IP-disclosure privacy tradeoff, plus a wider POST/readable-response surface
  than `img-src` alone grants (a JSON `fetch()` response is readable back into script; a plain
  `<img>` load's pixels are not, without a separate `crossOrigin` opt-in). Every existing
  connect-src-scoped fetch (chain queries, price feeds) is unaffected by the widening.
- **Cache (`src/features/collectibles/nftMetadataCache.ts`).** Off-chain metadata is immutable per
  URI (same content-addressed reasoning as the #159 image cache, §18.11) — a resolved document is
  cached FOREVER, keyed by URI, in `chrome.storage.local`, reusing the #159 image cache's exact LRU
  eviction policy (`selectEvictions`) at a smaller cap (300 entries — JSON documents are far smaller
  than image bytes). A negative result (fetch failure, invalid JSON, no usable fields) is NOT cached,
  so a transient network error can resolve on a later render/session instead of failing permanently.
- **`useNftMetadata(nft)` hook (`src/features/collectibles/useNftMetadata.ts`).** Resolves the first
  embeddable (`http(s)`/gateway-rewritten `ipfs://`) `metadataUris` entry, checks the shared cache,
  else sends `getNftMetadata` and parses the raw response. Returns `{ metadata, isLoading }` — no
  explicit error state (mirroring `NftMedia`'s existing graceful degradation for third-party content,
  §18.11): a failure simply resolves `metadata: null` and the caller shows the on-chain-only
  fallback.
- **Richer gallery.** `NftGrid` tiles (`CollectiblesPanel.tsx`) show the metadata `name` in place of
  the shortened launcher id once resolved (falling back to the shortened id while loading/absent).
  Each collection group's header shows the metadata `collection.name` in place of the shortened
  owner-DID hex (sourced from the group's first NFT — CHIP-0007 does not require every NFT in a
  collection to repeat identical `collection` metadata, but in practice minters do), with a soft
  banner treatment behind the header built from that same first NFT's already-cached art (§18.11) —
  CHIP-0007 has no standardized banner/icon field, so this is a UI-only approximation, not an
  on-chain or off-chain "banner" concept.
- **Richer detail (`NftDetail.tsx`).** The header shows the resolved `name` (falling back to the
  shortened launcher id); when metadata resolves, a description paragraph and a trait-attribute list
  (`trait_type` / `value` pairs) render below the existing on-chain summary. Absent/unresolved
  metadata renders neither section — never an empty placeholder.

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
  wallet's own standard XCH), and the required signers — both how many the wallet can satisfy
  (`ownedSigners`) AND the enumerated `unaccountedSigners` (required public keys that map to NO
  wallet-derived key, raw or synthetic). A message request shows the exact bytes to be signed. A locked
  wallet is flagged `needsUnlock` (the window shows the unlock gate, never a fabricated summary); an
  undecodable request is flagged `decodeError` (only Reject is offered — see the hard gate below).
- **Signer accountability (#75).** Every required signer MUST map to a wallet-derived key; any that does
  not is surfaced in the approval window as an unaccountable (foreign / over-broad) signer. The
  self-custody signer is all-or-nothing — `signDappCoinSpends` refuses (`MISSING_KEY`) to contribute a
  partial signature to a bundle it cannot fully sign — so a spend requiring a signer the wallet cannot
  account for is either a failed request or an over-broad authorization; it is flagged HIGH-risk
  (`CANNOT_SIGN`) and requires explicit acknowledgement, never a one-click approve.
- **Never authorize a decode-failed request (#75).** A `decodeError` entry MUST NOT be signed or
  broadcast: the approval window hides Approve (offers only Reject), AND the SW `resolve` enforces the
  same gate (defense in depth) — approving a `decodeError` entry returns an explicit refusal
  (`400`, code `DECODE_ERROR`) and never calls the vault. A user can never authorize a spend they could
  not see decoded.
- **Anti-drainer risk layer (P0-3).** Before the user approves a coin-spend request, `assessSpendRisk`
  (`src/lib/spend-risk.ts`, pure) inspects the decoded summary and flags high-risk patterns with stable
  machine codes: `DRAIN_ALL` (value leaves the wallet with ≤1% kept back as change — the drainer
  pattern), `HIGH_FEE` (reserved fee exceeds the amount sent, or ≥ 0.1 XCH absolute), `CANNOT_SIGN`
  (HIGH — a required signer the wallet cannot account for; over-broad / foreign signer, #75),
  `FOREIGN_INPUTS` (the spend mixes in coins the wallet does not own, so the mojo amounts are
  untrusted — a caution). Mojo-based flags (`DRAIN_ALL`/`HIGH_FEE`) are computed
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
- **Every vault call is gated on the live lock snapshot (#76).** The injected `callVault` the router
  is constructed with is not a raw pass-through — see the TTL bullet in §18.3 — so a queued request
  can never be signed/broadcast after the unlock TTL has lapsed, regardless of how long the window
  sat open (its keepalive port keeps the SW alive on purpose).
- **Richer clear-signing (#77).** The send/spend/offer summaries render a fiat equivalent (the
  user's chosen display currency, §18.13's `PriceMap`/`FiatCode` machinery, degrading to nothing —
  never a fabricated `$0` — when a price isn't known) beside every on-chain amount, and a CAT amount
  resolves its real name/ticker/decimals from the SAME §18.6 CAT-metadata registry the Assets list
  and Activity ledger resolve through, instead of a raw truncated TAIL. An expandable "View raw
  request details" disclosure renders the exact decoded `summary` as JSON for every request kind,
  for a reviewer who wants the full detail beyond the human summary.

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
- **Address-poisoning defense (#74).** On the Send form, the entered recipient is classified against the
  saved contacts + recent recipients by the pure `address-poisoning` module: `known` / `seen` (an exact
  saved contact / prior recipient), `firstTime` (a valid, never-seen address), or `lookalike`. A
  `lookalike` is an address that is NOT a known one yet shares its first `CONFUSABLE_PREFIX = 10` AND
  last `CONFUSABLE_SUFFIX = 8` characters — the exact `shortenAddress` truncation the user reads — so it
  renders identically in the UI while differing in the middle (the address-poisoning signature). The
  form MUST raise a blocking `role="alert"` warning naming the resembled entry and REQUIRE an explicit
  acknowledgement before the spend can be built (Review disabled + the build guarded against an
  Enter-key bypass; the acknowledgement resets when the recipient changes). A `firstTime` recipient
  gets a subtle first-time notice; `known`/`seen` show neither. The classifier is Chia-native and
  evaluated on-device.
- **Purity + tests.** All types + validation + CRUD-on-array + recent-tracking + the label lookup +
  the address-poisoning classifier live in pure modules (no DOM/`chrome.*`); the `useContacts` hook is
  the storage seam and the UI is thin glue. Unit tests cover the modules + hook + components; an
  end-user Playwright e2e drives the built popup (add a contact, pick it in Send, add-on-send,
  edit/delete).

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

- **Storage model.** `wallet.registry` holds `{ id, label, record?, createdAt, activeIndex,
  previewAddress?, accounts?, kind?, watchPublicKeyHex?, watchFingerprint? }` per wallet (`id` a uuid;
  `activeIndex` — #165, default 0 — that wallet's own single active HD derivation index, §18.1a;
  `previewAddress` — #176, optional — that wallet's cached CANONICAL (index-0) receive address;
  `accounts` — #95, §18.18, optional, defaulted on read — named labels over derivation indices;
  `kind`/`watchPublicKeyHex`/`watchFingerprint` — #96, §18.19 — present only for a watch-only entry,
  which is also the ONE case `record` is absent); `wallet.activeId` names the active wallet;
  `wallet.keystore` MIRRORS the active wallet's record (absent while a watch-only wallet is active) so
  every pre-#90 single-wallet read path (unlock / reveal) works unchanged. The encrypted records live
  only in the SW — the UI receives record-FREE metadata (`{ id, label, createdAt, active, activeIndex,
  previewAddress?, accounts, kind?, watchFingerprint? }`) via `listWallets`. A registry persisted
  before #165 has entries with no `activeIndex` field; migration normalizes it to 0. A registry
  persisted before #176 has entries with no `previewAddress` at all, and before #95/#96 has none of
  `accounts`/`kind`/`watchPublicKeyHex` — all fully optional/additive, never required for a read.
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

### 18.18 Named accounts (#95)

An "account" is a user-friendly LABEL bookmarking one HD derivation index (`m/12381/8444/2/{index}`,
§18.1) within a wallet's existing single-active-index model — it does NOT add a second derivation
dimension or reintroduce a multi-index scan (§18.1a stays intact: exactly one index is ever
active/derived/scanned at a time). Switching accounts is simply "set the wallet's active index to
this account's index" under a friendly name, reusing `setActiveIndex` (§18.1a) verbatim — no new
vault op, no new crypto.

- **Storage model.** `lib/wallet-registry.ts`'s `WalletEntry.accounts?: { id, label, index }[]` — pure
  metadata, never touching key material, additive to the existing per-wallet record (a pre-#95 entry
  simply has none yet). `ensureAccounts` synthesizes ONE default account (`"Account 1"`, at the
  wallet's current `activeIndex`) on read with a DETERMINISTIC id (`${walletId}-acct-0`) so repeated
  reads are stable; `listWallets`'s per-wallet metadata (§18.16) always carries the defaulted
  `accounts` array.
- **Add** (`addAccount`, §7): appends a new account at one above the HIGHEST index any of the
  wallet's existing accounts already bookmarks (never just the account count — an account may have
  been removed, or an existing one may sit at a high index), so a fresh account never collides with
  one already in use. An optional `label` is normalized (trimmed, capped at 40 chars) or defaults to
  `"Account N"`.
- **Rename** (`renameAccount`): metadata only.
- **Remove** (`removeAccount`): refuses to drop a wallet's LAST remaining account (a wallet always
  has at least one named account). Removing the account that IS the wallet's current active index
  re-homes `activeIndex` to the first remaining account (same cache invalidation as `setActiveIndex`)
  so the wallet is never left pointed at a just-deleted account's index with nothing named there.
- **No effect on funds.** An account is purely a label — removing one does not affect any funds
  sitting at that index; the underlying index remains reachable via the index navigator (§18.1a) by
  number, same as before #95 existed.
- **UI.** An account switcher lives beside the wallet switcher (§18.16) and the index navigator
  (§18.1a) in the popup — switching accounts calls `setActiveIndex` with the target account's index;
  add/rename/remove are inline, mirroring the wallet-manager list's own affordances. Non-destructive
  (no funds at risk), so it stays in the popup rather than fullscreen-gated. Four states + react-intl
  across the 14 locales.

### 18.19 Watch-only wallets (#96)

A watch-only wallet is imported from a master/root BLS **public** key only — it holds NO secret
material, NO password, and is never "locked" (there is nothing to decrypt). It can view addresses
and balances but can NEVER sign or spend. This is possible because BLS unhardened HD derivation
(§18.1) commutes with taking the public key first: deriving child index `i` unhardened from a secret
key and then taking its public key is IDENTICAL to deriving child index `i` unhardened directly from
the parent's public key (`lib/keystore/derive.ts`'s `deriveWatchAccount`/`masterPublicKeyFromHex`,
proven against the same golden vectors §18.1's full-custody derivation uses). **Hardened derivation
has no such property** (it mixes in the parent SECRET key) — a watch-only wallet can derive/scan the
UNHARDENED chain ONLY. This is a permanent, documented limitation, not a bug: funds held only on the
hardened chain are invisible to a watch-only import of that same seed.

- **Storage model.** `WalletEntry.kind?: 'custody' | 'watch'` (absent/`'custody'` = an ordinary
  wallet) + `watchPublicKeyHex` (the imported public key, hex) + `watchFingerprint` (the
  Chia-convention key fingerprint, `PublicKey.fingerprint()` — a short, human-shareable numeric id,
  cached at import time). `record` is OPTIONAL on `WalletEntry` for exactly this reason — a watch
  entry has none. `isWatchOnly(wallet)` is the single predicate every gate below checks.
- **Import** (`importWatchWallet`, §7): validates the public key strictly (`PublicKey.fromBytes` +
  `isValid()` — a malformed key is rejected `INVALID_PUBLIC_KEY` and never added), previews its
  index-0 unhardened address + fingerprint (one offscreen-vault round trip, reusing
  `getReceiveAddress` with `watchPublicKeyHex` — see below), then adds it to the registry, ACTIVE,
  with no password step at all.
- **Reads route on `watchPublicKeyHex`, not the held seed.** `getReceiveAddress`, `scanBalances`, and
  `listDerivedAddresses` (§18.1b) each accept an optional `watchPublicKeyHex`; when the ACTIVE
  wallet is watch-only, the SW passes it (instead of relying on an unlocked vault key) and the vault
  derives directly from the public key — UNHARDENED ONLY. `listDerivedAddresses`'s page is therefore
  half the size of a custody wallet's (no hardened rows). `scanBalances` sums XCH at the unhardened
  inner puzzle hash only and supports the explicit watched/built-in CAT list (a direct puzzle-hash
  query needs no secret) but NOT hint-based CAT auto-discovery (#87, §18.6) — that reconstruction
  needs the seed, which a watch-only wallet never has.
- **Never locked, never unlocks.** `computeLockSnapshot` (`lib/custody-session.ts`) treats a
  watch-only ACTIVE wallet as unconditionally `unlocked` — no keystore blob, no TTL, no password
  prompt ever applies to it.
- **Every direct signing-required custody action is refused `WATCH_ONLY`.** Before dispatch, the SW
  checks whether the ACTIVE wallet is watch-only for: `revealPhrase`, `exportPrivateKey` (§18.20),
  `prepareSend`, `prepareSplit`/`prepareCombine`, `makeOffer`/`prepareTrade`, every NFT/DID prepare
  action, and `prepareClawbackAction` — each returns `{ success:false, code:'WATCH_ONLY', message }`
  before ever reaching the vault. A dApp `window.chia` connect/read against a watch-only active
  wallet still works (an address IS a valid read); a dApp SIGN/write request
  (`signDappSpend`/`signMessage`/`sendTransaction`/`createOffer`/…, §18.12) is refused too, but via
  the PRE-EXISTING guarantee that a watch-only wallet's id is NEVER given a cached key in the vault
  (§18.19's storage model — it is simply never created/imported/unlocked): `heldKeyring`/`heldSeed`
  resolve to `null` exactly as they do for a genuinely locked wallet, so the request fails closed with
  the same `LOCKED`-class rejection rather than the more precise `WATCH_ONLY` code. The SECURITY
  guarantee (a watch-only wallet can never sign) holds either way; giving the dApp path the sharper
  `WATCH_ONLY` code is a tracked UX-polish follow-up, not a gap.
- **UI.** The wallet switcher (§18.16) marks a watch-only entry with a distinct "Watch-only" badge
  (using its cached fingerprint as a human-shareable identity, since there is no label-worthy address
  history yet). Import is reached from the same "add wallet" flow as create/import-by-phrase/restore
  (§18.21), fullscreen-only (§2.1) alongside the other advanced onboarding paths, taking a public-key
  hex + optional label. Every destructive/spend action's UI (Send, Trade, mint, DID create/transfer,
  clawback) checks `kind==='watch'` and disables itself with an explanatory message rather than
  attempting the call and surfacing a raw `WATCH_ONLY` code. Four states + react-intl across the 14
  locales.

### 18.20 Private-key export (#96)

`exportPrivateKey` (§7) reveals the RAW (pre-synthetic) account secret key at the wallet's ACTIVE HD
derivation index, for BOTH schemes — `lib/keystore/derive.ts`'s `deriveWalletSecretKeyHex`, the key
BEFORE `deriveSynthetic()`. This is deliberately the convention `chia-blockchain`/Sage/hardware-
wallet tooling treats as "the wallet's private key for this address": every one of them re-applies
the (deterministic, non-secret) synthetic offset internally when signing. Exporting the POST-synthetic
key instead would silently produce a DIFFERENT effective signing key once re-derived by any tool that
also applies the offset — it would not actually control the shown address, so this ordering is a
correctness requirement, not a style choice (proven in `derive.test.ts` by reconstructing the
synthetic public key FROM the exported raw key and checking it lands on the same golden address §18.1
already pins).

- **Re-auth exactly like `revealPhrase`.** Requires the FULL password + the persisted record — never
  served from the cached unlock-window TTL (§18.3) — so an attacker with mere UI access during an
  unlocked session still cannot exfiltrate the signing key without the password.
- **Refused for a watch-only active wallet** (`WATCH_ONLY`, §18.19 — it holds no secret to export).
- **UI (§5.6/§67 P1-5 pattern).** Reached from an explicit, clearly-labeled "Export private key"
  action (fullscreen-only, alongside the other destructive/advanced custody actions) behind a
  password prompt and firm warnings (irreversible exposure; never share; DIG will never ask for it).
  The revealed hex renders inside the SAME closed-shadow-root `SecretPhrase` primitive the recovery
  phrase reveal uses (§18.5) — un-scrapeable from the light DOM by another extension or an injected
  page script — tap-to-reveal, auto-hide, and an explicit copy action that auto-clears the clipboard
  after a short delay. Both schemes are shown, labeled ("Unhardened (primary)" / "Hardened"), since
  funds may sit on either at the active index (§18.1a). Four states + react-intl across the 14
  locales.

### 18.21 Encrypted keystore file backup / restore (#115)

A THIRD way to move a wallet between devices, alongside the 24-word mnemonic (create/import, §18.5)
and nothing else — it introduces NO new crypto: the exported file's embedded record is the wallet's
OWN existing `DIGWX1` blob (§18.2), copied byte-for-byte. The SW never decrypts it during export or
import, so this feature never touches the wallet's secret key.

- **Envelope format (`lib/keystore/backup.ts`).** `{ magic:'DIGWBK1', version:1, label, createdAt,
  exportedAt, record }` — its OWN magic/version, independent of the embedded `Digwx1Record`'s (§18.2),
  so the FILE format can evolve later without colliding with the record's own versioning (additive
  only, mirroring the `.dig` format's backwards-compatibility discipline).
- **Export** (`exportWalletBackup`, §7): builds the envelope for one registry wallet and returns it as
  `{ filename, json }` — `filename` is `dig-wallet-<slug-of-label>-<yyyy-mm-dd>.json` (falls back to a
  generic slug when the label has no ASCII-safe characters). The UI downloads it client-side via a
  plain `<a download>` blob URL — no `chrome.downloads` permission needed. Refused `WATCH_ONLY` for a
  watch-only wallet (nothing encrypted to export).
- **Restore** (`importWalletBackup`, §7): parses + validates the envelope's magic/version/label/
  `createdAt` AND the embedded record's own DIGWX1 structural shape (`isValidDigwx1Record`, §18.2) —
  BAD_FORMAT for a malformed envelope, BAD_RECORD for a structurally-invalid embedded record — never
  attempting to decrypt either. Refuses a BYTE-IDENTICAL duplicate already in the registry
  (`ALREADY_EXISTS`, compared by the record's own ciphertext) to avoid registry clutter from
  re-importing the same file twice. A valid, novel backup is added to the registry under a FRESH id,
  ACTIVE, and comes back `locked` (no password was ever seen during restore) — the normal unlock
  screen (§18.5) then gates it exactly like switching to any not-yet-unlocked wallet (§18.16).
- **UI.** Export sits on each wallet's row in the manager list (§18.16) as an additional action
  alongside rename/remove. Restore is a THIRD option on the "add wallet" flow (§18.5/§18.19) —
  "Restore from backup file" — taking a file picker (`<input type="file">`, read via `.text()`) next
  to "Create new" and "Import from recovery phrase". Both are fullscreen-only (§2.1), alongside the
  other advanced/security-sensitive onboarding paths. Four states + react-intl across the 14 locales.

### 18.22 CAT issuance / minting (#97)

Mint a BRAND-NEW CAT (create its asset id for the first time) from the wallet's own coins, via the
`chia-wallet-sdk-wasm` `Action` system already used by NFT mint (§18.11) — no new wasm surface.
`prepareCatIssuance` (§7) builds the spend and holds it under a pending id; `confirmCatIssuance`
signs + broadcasts it, reusing the vault's shared `confirmSend` path exactly like an NFT mint.

- **Two issuance modes** (`mode`, request field on `catIssuance`):
  - `'single'` (default) — `Action.singleIssueCat(undefined, amount)`: a genesis-by-coin-id TAIL
    bound to one specific funding coin. Fixed supply from the moment of mint; this asset id can
    NEVER be re-minted, by anyone, under any circumstance.
  - `'multi'` — `Action.issueCat(tailSpend, undefined, amount)` with a hand-curried TAIL: the
    standard "everything with signature" TAIL (`Clvm.everythingWithSignature()`), curried with the
    wallet's OWN synthetic public key at the active index. Only that same key can ever authorize a
    future re-mint/melt of this asset id (via `Action.runTail` — not yet exposed as its own action;
    a tracked follow-up). The TAIL's `AGG_SIG_ME` condition is signed through the SAME generic
    `signing.ts` machinery every other spend uses — no bespoke signing path.
- **Supply + change routing.** The newly-minted CAT and any XCH change both auto-route to the
  active index's own p2 puzzle hash (the `Spends` driver's default for an unrouted new asset — the
  same behavior `Action.mintNft` relies on, §18.11). The minted asset id is read back from
  `FinishedSpends.spend()`'s `Outputs.cats()`/`cat(id)` — the wasm's OWN decode of what it just
  built, independent of any hand tree-hash math on this side.
- **UI (fullscreen-only, §6.4).** A `Trade` tab, "Issue" — a plain-language form (whole-token total
  supply at the ecosystem's standard 3-decimal CAT convention, §18.9's `CAT_DECIMALS` — issuance
  type toggle, optional network fee) → a pre-sign review decoded FROM the built spend (supply, mode,
  the new asset id, fee) → confirm (sign + broadcast) → poll to confirmed/retry (`sendStatus`, an
  issuance is a coin spend like any other). The popup omits the tab entirely — an issuance is a
  destructive/advanced spend-construction op with nothing pending to view before it is built.
- **Registering the new token.** The minted asset id is shown (+ copyable) on the confirmed screen;
  adding it to "Manage tokens" (§18.9) so it renders with a friendly name/ticker is a separate,
  already-existing "add a custom token" action — issuance does not auto-register it (a user may
  choose never to add a ticker for a token they only ever hold at the raw asset-id level).
- **Simulator-proven.** `catIssuance.test.ts` mints both modes against the wasm Simulator, asserts
  the resulting asset id is well-formed and — for the single-issuance case — that the wallet's own
  CAT-lineage reconstruction (§18.9's `reconstructCats`) finds the minted coin post-broadcast. Never
  broadcasts to mainnet in CI.

### 18.23 Token swap (#103)

A "swap" is a MARKET ORDER over dexie's public offer book (§18.10's dexie integration, #102) — NOT
an AMM, and no new wasm/backend surface (per the ticket's own scoping note). Pick what you're
paying + what you want; `bestSwapQuote` (`lib/swapQuote.ts`) is a PURE, client-side best-rate
selector over the EXISTING `browseDexieOffers` (§7) search results — display units only,
informational. Executing hands the matched offer's raw `offer1…` bytes to the wallet's OWN existing
take pipeline (`prepareTrade`/`confirmTrade`, §18.10) completely unchanged — it re-derives the real
base-unit amounts from the bytes exactly like a pasted/dropped offer (fail-closed; the dexie display
numbers are never trusted for the actual spend). No new vault op, no new message action.

- **UI (fullscreen-only, §6.4).** A `Trade` tab, "Swap" — pick "You pay" / "You receive" from the
  wallet's own asset list (§18.9) → a quote appears automatically (querying dexie filtered by the
  chosen pair) → Review decodes the REAL offer via `prepareTrade` → Confirm broadcasts via
  `confirmTrade` → poll to confirmed/retry (`sendStatus`). The popup omits the tab entirely, same
  tiering rationale as Issue (§18.22) — swap execution is a real spend.
- **Best-rate selection.** Among every open (`status:0`) dexie offer matching the chosen pair,
  `bestSwapQuote` picks the highest `buyAmount/sellAmount` ratio; ties/no-match return `null` (the
  UI's empty state). Matches by either the dexie-reported ticker `code` OR the raw CAT asset id
  `id`, so callers can search by whichever they have; the returned quote echoes the matched leg's
  OWN `code` for display (never the raw id, even when the caller searched by it).
- **Proven.** `swapQuote.test.ts` unit-tests the selector (best-rate, status filtering, malformed
  legs, same-asset rejection); `swapPanel.test.tsx` covers the picker → quote → review → confirm →
  poll flow against a mocked SW.

### 18.24 Option contracts — mint / list / exercise (#104)

Option-contract puzzle support DOES exist in the shipped `chia-wallet-sdk-wasm` (the ticket's own
"verify before scoping" flag) — but only as LOW-LEVEL primitives (`OptionInfo`/`OptionUnderlying`/
`OptionType`/`OptionMetadata`, `Clvm.spendOption`/`meltSingleton`/`sendMessage`/
`spendSettlementCoin`/`singletonLauncher`), with NO `Action`/`Spends` driver convenience (unlike
CAT/NFT — no `Action.mintOption`, no `Spends.addOption`). `optionContracts.ts` hand-rolls the
singleton launch + underlying lock/unlock exactly as the upstream `chia-wallet-sdk`'s OWN
`napi/__test__/options.spec.ts` reference test does (napi and wasm share the same
`chia-sdk-bindings` surface, so that test is a byte-for-byte authoritative usage guide).

**MVP scope, deliberately narrow** (mirrors how §18.9's offer engine documents its own gaps):
- **XCH-denominated only.** Both the underlying (locked collateral) and the strike (exercise price)
  are native XCH. `OptionType.cat`/`.revocableCat`/`.nft` exist in the wasm for a follow-up.
- **Self-mint, self-exercise round trip.** This wallet must be BOTH the writer (creator) and the
  holder to exercise — the local {@link OptionRecord} (below) carries the full off-chain terms this
  wallet needs; a third party who only sees the bare on-chain singleton has no way to learn the
  strike/expiration/creator without them being published out-of-band (e.g. a marketplace listing
  carrying the terms alongside the launcher id, analogous to how an offer string carries its own
  terms). Transferring a minted option to another wallet, and clawing it back after expiry
  (`OptionUnderlying.clawbackSpend` already ships in the wasm for exactly that), are follow-ups.

**Mint** (`prepareOptionMint`/`confirmOptionMint`, §7): the funding coin creates TWO sibling coins
in one spend — the underlying-lock coin (at `OptionUnderlying.puzzleHash()`) and the singleton
launcher (at `Constants.singletonLauncherHash()`); the launcher is spent to create the eve option
singleton (at `OptionInfo.puzzleHash()`), immediately re-spent once more to commit its REAL
(non-eve) lineage — the same "eve create, then re-spend" shape §18.19's `createEveDid`+`spendDid`
uses, except DID has a wasm helper for the launcher plumbing; options don't, so it's built explicitly.
Returns the FULL {@link OptionRecord} the caller MUST persist — `confirmOptionMint` records it into
the LOCAL option registry (mirrors §18.10's #101 offer-log shape/idioms exactly) as a side effect,
since a bare on-chain option carries no recoverable terms.

```ts
interface OptionRecord {
  launcherId: string;                  // the option singleton's stable identity (hex)
  creatorPuzzleHashHex: string;        // writer's p2 — receives the strike on exercise
  holderPuzzleHashHex: string;         // current holder's p2 — who can exercise
  expirationSeconds: string;           // absolute unix seconds (decimal string)
  underlyingAmount: string;            // locked collateral, base units (decimal string)
  strikeAmount: string;                // exercise price, base units (decimal string)
  underlyingLockParentCoinId: string;  // rebuilds the exact underlying-lock Coin object
  coinIdHex: string;                   // the option's current coin id — the #101-style poll key
}
```

**Exercise** (`prepareOptionExercise`/`confirmOptionExercise`, §7), the holder proving control by
simultaneously melting the option singleton:
1. Melt the option's OWN singleton coin via a delegated spend carrying `meltSingleton()` +
   `sendMessage(23, underlying.delegatedPuzzleHash(), [underlyingLockCoinId])` — mode `23` and the
   receiver/data shape are copied VERBATIM from the upstream reference test; this is the
   "SingletonMember" proof-of-simultaneous-spend the underlying's 1-of-N exercise path checks for.
2. Fund + settle the strike payment to the creator through the SAME settlement-puzzle mechanism
   §18.10's offer engine already uses — a `NotarizedPayment` keyed by the option's own launcher id,
   UN-hinted for XCH (`OptionType::is_hinted() == false` for XCH — a mismatch here would make the
   underlying's own `payment_assertion` fail, since it re-derives the SAME notarized-payment tree
   hash from the recorded terms).
3. Unlock the underlying (`OptionUnderlying.exerciseSpend` — the wasm builds the 1-of-N puzzle logic
   internally, no hand-rolled puzzle here) and claim the released value straight to the holder's own
   address in the SAME bundle (it lands back at the settlement puzzle un-notarized, so leaving it
   unclaimed would let ANY spend claim it later — this module claims it immediately instead).

Throws `OPTION_NOT_FOUND` when the option's live coin can't be located at its expected (fully
deterministic from the recorded terms) puzzle hash, `EXPIRED` past `expirationSeconds`,
`MISSING_KEY` when this wallet is not the recorded holder, `NO_SUITABLE_COIN` when it cannot fund
the strike + fee.

**List** (`getOptions`, §7): the LOCAL option registry for the active wallet + active index —
reconciled against the chain (a still-`'open'` entry whose `coinIdHex` is now spent flips to
`'exercised'` — the SAME cheap `sendStatus`/`coinConfirmed` poll every confirm-poll already uses;
MVP has no clawback path, so "spent" only ever means exercised). Mirrors §18.10's `getOffers`
reconciliation pattern exactly.

**UI (fullscreen-only, §6.4).** A `Trade` tab, "Options" — mint form (underlying amount, strike
amount, expiration) → review (decoded from the built spend) → confirm/poll, plus a list of minted
options (open/exercised) each with an "Exercise" action when still open and not yet expired. The
popup omits the tab entirely, same tiering rationale as Issue (§18.22).

**Simulator-proven with REALISTIC amounts.** `optionContracts.test.ts` mints AND exercises against
the wasm Simulator using non-trivial amounts (1 XCH underlying, 0.5 XCH strike) — the upstream
reference test this module mirrors uses a 1-mojo toy strike, which would hide a coin-conservation
bug a real-sized strike would expose. Covers expiration rejection, insufficient-funds rejection, and
that a second exercise attempt after the first correctly reports `OPTION_NOT_FOUND`. Never
broadcasts to mainnet in CI.
