# Development Log

High-signal realizations from debugging/development. Concise durable facts with context — not a
change diary. See CLAUDE.md §4.5.

## The rewards-vault / badge-staking view is hub.dig.net, NOT the extension (#409 triage)

A bug report titled "extension rewards vault (staking) fails" (`StakeView.container-*.js`,
`/v1/achievements` 401, `getStakedPositions`/`getStakeCandidates` "chain read didn't come back") is a
**hub.dig.net** bug, not an extension bug. The staking/rewards-vault feature lives at
`hub.dig.net/apps/web/features/staking/` (`StakeView.container.tsx`, `stakingApi.ts`), lazy-loaded from
hub `App.tsx`; `/v1/achievements` is the hub badge API (Sign-In-with-Chia bearer JWT). The extension
has **no** staking view, no `/v1/*` client, and no bearer-token path — its RTK Query baseQuery is the
service-worker seam (`chrome.runtime.sendMessage`). When a bug is captured on a hub page with the DIG
extension installed, the console carries **incidental** extension content-script lines —
`ObjectMultiplex - orphaned data for stream "app-init-liveness"/"background-liveness"` (the provider
bridge) and `DIG Extension: Found 0 elements with chia:// URLs` (the link scan). These are NOT errors
and NOT the cause; don't mistake them for an extension fault. Triage such reports by the FAILING
symbols' bundle/endpoint origin, not by which extension console noise rides along.

## The DIG search provider CANNOT point `search_url` at an extension page; use an HTTPS sentinel + local redirect (#362)

Chrome's `chrome_settings_overrides.search_provider.search_url` MUST be an **HTTPS URL on a
Search-Console-verified domain** — a `chrome-extension://` `search_url` is rejected (confirmed against
the Chrome + MDN manifest docs). So the DIG search provider's `search_url` is a **sentinel** on a DIG
domain (`https://dig.net/dig-search?q={searchTerms}`) that the extension intercepts LOCALLY and
rewrites to the in-extension resolver page — the query never actually hits dig.net. Two intercept
mechanisms, both converging on `dig-search.html?q=…`: a dynamic `declarativeNetRequest` redirect rule
registered at SW startup (pre-network, bounce-free; its `regexSubstitution` must embed the runtime
`chrome.runtime.getURL(...)` — DNR has NO extension-id token, so a STATIC ruleset can't target the
extension page while preserving the query), plus a `webNavigation.onBeforeNavigate` `matchDigSearchSentinel`
catch as the guaranteed fallback. `is_default:false` — forcing default triggers a disruptive prompt;
the user opts in. NOTE: for a PUBLISHED build the sentinel domain must be verified in Search Console
or the override won't apply.

## Two different `.dig` host forms — disambiguate by label shape (#362/#308)

`<x>.dig` is overloaded: (a) the **dig-dns** host form where the label is a 52-char base32 STORE ID
(`dig-dns-host.digLabelToStoreHex`, byte-mirror of the Rust `label.rs`), and (b) the **on.dig.net**
human-name shorthand (`<name>.dig` → `<name>.on.dig.net`, #308). `classifyDigInput` disambiguates by
label shape: a 52-char base32 label that decodes to 32 bytes → a dig-dns store → canonical `chia://`;
anything else → an on.dig.net shorthand → resolved HEAD→URN. `*.on.dig.net` is checked BEFORE `.dig`
so it never mis-hits the `.dig` branch. The HEAD→URN resolve (`resolveOnDigNetUrn`) MUST run from the
EXTENSION origin (SW / extension page), never a content script — a page-origin fetch can't read the
CORS-exposed `X-Dig-URN` header.

## MV3 extension SW e2e (`test:sw`) won't launch on this Windows box — it's CI (Linux) only

`playwright.sw.config.ts` uses `channel: 'chromium'` + `--load-extension` + a persistent context and
waits for the MV3 service worker to register. On this Windows dev box the SW never registers
(`waitForEvent('serviceworker')` times out) with BOTH the `chromium` channel and Playwright's bundled
chromium — a local headless-extension limitation. The suite is green in CI (`npx playwright install
--with-deps chromium` on the Linux runner). Validate SW/e2e behaviour there; locally rely on the
vitest unit suite + `npm run build`.

## chia:// content only RENDERS in an MV3 SANDBOXED page; a rootless URN's trusted root is the CHAIN-anchored root, never 'latest' (#225, #226)

Two coupled bugs that made `chia://` content NOT display in the browser window, both proven by the
live-node e2e (`e2e/sw/live-node-content-load.spec.ts`, B.1b + B.4) against 127.0.0.1:9778.

- **#225 — the extension's OWN MV3 CSP blocked the store frame.** The dig-viewer rendered store HTML
  into a `data:text/html` iframe with the interceptor + config as INLINE scripts. `extension_pages`
  CSP `frame-src 'self' https:` blocks the `data:` frame, and `script-src 'self'` blocks the inline
  scripts (MV3 forbids `'unsafe-inline'` in `extension_pages`, and a per-store inline config can't be
  hash-pinned). The READ path worked end-to-end the whole time — only the RENDER was blocked, and the
  repo's own loader e2e had explicitly DEFERRED the success-render assertion, so it went unnoticed for
  many releases. Fix = a real **MV3 sandboxed extension page** (`dig-store-frame.html` in manifest
  `sandbox.pages` + a `content_security_policy.sandbox`): opaque origin, NO `chrome.*`/keys, its own
  relaxed CSP that CAN run inline/`data:` scripts (so arbitrary decrypted store HTML/JS renders), and
  `connect-src 'self' data: blob:` so store content has no network egress. Do NOT include
  `allow-same-origin` in the sandbox directive — the opaque origin IS the isolation. The interceptor
  loads as an EXTERNAL same-origin `<script src>` (`script-src 'self'` covers it); config is delivered
  by `postMessage` (frame posts `frame-ready` → parent replies `cfg`; boot idempotent, also re-sent on
  `iframe.onload`) because the sandbox CSP forbids an inline `window.__DIG_CFG`.

- **#226 — the literal string `'latest'` was passed as the trusted root to `verifyInclusion`.** A
  folded `proof.root` (32-byte hex) can NEVER equal the string `'latest'`, so every rootless URN (the
  common case) reported `verified=false` even for genuinely valid chain-anchored content. The trusted
  root MUST come from the CHAIN: for a rootless URN, resolve it via `dig.getAnchoredRoot { store_id }`
  on the node (it walks the DataStore singleton on coinset.org SERVER-SIDE), pin the `dig.getContent`
  fetch to that root (so the proof folds to what we verify against — no `'latest'` race), and verify
  against it. FAIL-CLOSED: `rpc.dig.net` does NOT serve `dig.getAnchoredRoot` (answers `-32601`), so
  the hosted tier originally reported UNVERIFIED rather than trusting a host-asserted root. The pure
  decision lives in `src/lib/trusted-root.ts` (unit-tested); the SW just calls `resolveAnchoredRoot` +
  the helpers. **#228 closed the hosted-tier gap**: the extension now resolves the SAME anchored-root
  walk itself, directly against coinset.org, via `@dignetwork/chip35-dl-coin-wasm`'s
  `dataStoreFromSpend` (see the next entry for where that wasm can and can't load).

## `@dignetwork/chip35-dl-coin-wasm` (and any wasm-bindgen "bundler"-target package) can ONLY load in the Vite-bundled offscreen document, never the esbuild-bundled service worker (#228)

The DataLayer store-coin driver wasm (`@dignetwork/chip35-dl-coin-wasm`, same package hub.dig.net's
`lib/lineage.ts`/`driver.ts` use) ships as a wasm-bindgen **"bundler" target**:
`import * as wasm from "./chip35_dl_coin_wasm_bg.wasm"` — a bare ESM import of the `.wasm` binary
that only a bundler with wasm-ESM support (Vite + `vite-plugin-wasm`, Next/webpack) can turn into
real `WebAssembly.instantiate` code; neither a plain browser nor esbuild (no wasm loader configured
here) can resolve it. This is exactly why `dig_client.js`/`dig_client_bg.wasm` (the digstore read
crypto the SW uses) is built with the DIFFERENT wasm-bindgen **"web" target** instead (explicit
`init()` + `import.meta.url`, vendored + SRI-pinned at the repo root, kept an EXTERNAL esbuild import)
— that target is the one a hand-rolled loader in the service worker can actually run. Net: a "bundler"
-target wasm package can only be added where Vite already bundles code — the offscreen document
(`vite.config.ts`'s `wasm()` + `topLevelAwait()` plugins, `optimizeDeps.exclude`) — never the
`src/background/index.ts` SW bundle. Confirmed empirically: `node --experimental-wasm-modules` (or a
manual `WebAssembly.instantiate` against the `_bg.js` glue + `_bg.wasm` bytes, mirroring
`src/test/chiaWasm.ts`) loads it fine under Node/Vitest for tests, but that path does NOT exist in a
shipped Chrome extension's SW without a bundler transform.

## `ensureOffscreenDocument()`'s `await hasOffscreenDocument()` check-then-set race let two concurrent first-time callers both try to create the offscreen document (#228)

`ensureOffscreenDocument()` (`src/background/index.ts`) used to check `if (await hasOffscreenDocument())
return;` BEFORE checking/setting the `creatingOffscreen` in-flight guard — an `await` (a real yield
point) sits between "is anything creating it" and "start creating it". Two callers arriving within the
same window (e.g. dig-viewer.html's own initial content-load fetch racing an explicit `proxyRequest`
call to the SAME store, both needing the vault's coinset walk for the FIRST time in a session) can both
observe "no document yet, nothing in flight yet" and both proceed, producing a `chrome.runtime.
sendMessage` that lands before either document is ready to receive it — `Error: Could not establish
connection. Receiving end does not exist.` The fix: set the `creatingOffscreen` guard SYNCHRONOUSLY,
as the very first statement (no `await` before it), then do the `hasOffscreenDocument()` check INSIDE
the guarded async IIFE. Any op that is the FIRST to need the offscreen vault (not just wallet ops —
`resolveCoinsetAnchoredRoot`, #228, is keyless and can now be that first caller) can trigger this if two
call sites race; symptom is an intermittent, cold-start-only "Receiving end does not exist" that
disappears once the offscreen document is warm (a strong tell it's this race, not a logic bug).

## The dig-node wallet-data source (#217) reflects the NODE's wallet, and its reads are read-only — signing NEVER leaves the vault

Phase 3 of #205 lets the extension read balances/tokens/NFTs/DIDs/coins/activity from a running
dig-node's Sage-parity `get_*` surface (browser mirror on 9778, plain-HTTP + CORS) instead of coinset.
Sharp edges to remember:
- **The node's `get_*` return the NODE's wallet, not the extension's key.** Sage's `get_coins`/
  `get_cats`/`get_nfts`/… take no puzzle-hash/pubkey input — they answer for the wallet the node
  tracks. So the integration premise is "the user's node tracks the user's wallet." The extension's
  self-custody key is NEVER sent to the node; signing stays in the offscreen vault. The node is a
  READ-ONLY chain-data source — no spend/sign/send method is wired (`node-wallet.ts` has none).
- **Some vault shape fields have no Sage source.** `WalletNft`/`WalletDid.p2PuzzleHash` and
  `WalletDid.numVerificationsRequired` are not in the Sage `NftRecord`/`DidRecord` (only a bech32m
  `address` is), so the node mapper leaves them blank/'1'. That is safe because they are display-only
  for the list; the LOCAL transfer/sign path re-derives NFT/DID state from chain in the vault and
  never trusts a listed `p2PuzzleHash`.
- **Fall-through is strictness-gated.** `auto` falls back to coinset on a node read error (clean
  degrade); a user-FORCED `node`/`custom` source must SURFACE the failure (`NODE_UNAVAILABLE`/
  `NODE_READ_FAILED`) — silently downgrading a forced node to coinset would violate the user's intent
  (and, for a privacy-motivated pick, leak their address set to coinset without consent).
- **Keep the decision + client PURE.** The SW (`src/background/index.ts`) is `@ts-nocheck` glue
  excluded from coverage; all logic lives in unit-tested `src/lib/wallet-source.ts` +
  `src/lib/node-wallet.ts`, the SW just injects its cached §5.3 probe + a direct probe. Same pattern
  as `dig-control.ts`/`custody-session.ts`.

## A tier gate keyed on a PERSISTED PREFERENCE nobody ever sets is worse than no gate at all (#109, #145)

`CustodyWallet`'s Settings block (NetworkSetting/ChainNodeSetting/AutoLockSetting/SessionStatus/
ConnectedSites/DerivedAddressList/ExportPrivateKey) was gated on `useAppSelector(s => s.ui.advanced)`
— a Redux flag hydrated from `wallet.settings.advanced` — instead of the surface (`isFull`) every
sibling advanced feature (DidPanel, CollectiblesPanel, the Identity tab) already gates on. Nothing in
the shipped UI ever dispatched `setAdvanced(true)` or wrote `advanced: true` to settings, so the
ENTIRE block was unreachable on BOTH popup and fullscreen — not a popup leak, a total dead end. Two
e2e specs had cargo-culted an `advanced: true` seed into `wallet.settings` (or, in one case, a
`localStorage.setItem` call the app never reads — settings live in `chrome.storage.local`, not
`localStorage`) that happened to line up with the dead gate, so the tests looked meaningful but a
couple were vacuous (`if (await panel.count())` guards that never entered their body). Lesson: a
tier/feature gate should key on something the UI can actually set (a surface check, a route, a prop)
— a persisted-preference gate with no writer is a silent kill-switch. Gate fixed to `isFull`, matching
every other advanced-feature pattern in this file; `ui.advanced`/`setAdvanced` retired entirely.

## The SW e2e harness has NO default viewport, so `app.html` runs in the EXPANDED desktop layout (#85)

`playwright.sw.config.ts` sets no `use.viewport`, so pages get Playwright's default 1280×720 — which
is ≥ `EXPANDED_MIN_WIDTH` (960). Any `e2e/sw/*` spec that opens `app.html` WITHOUT calling
`setViewportSize` to a phone size is therefore driving the **expanded** (desktop workspace) layout,
not the compact popup. Consequences that bite: the bottom `TabBar` (`tab-*` testids) does NOT render
in expanded, and after #85 the in-content wallet **segmented control (`seg-*`) is CSS-hidden** on the
expanded surface (the sidebar `nav-*` is the wallet-view nav there). So navigate expanded `app.html`
via `nav-<key>` (or a `#wallet/<view>` hash), never `tab-*`/`seg-*`. The compact popup keeps `tab-*`
+ `seg-*`. (Bit #85's `background-prefetch`/`apps-personalization`/`activity-detail` specs.)

## `CompactLayout` (popup) and the desktop `ExpandedLayout` share the same route + feature containers, only the chrome differs (#85)

The fullscreen `app.html` desktop workspace and the compact popup render the SAME `ActiveTabPanel` →
feature containers from ONE RTK store; the sidebar/app-bar is just different chrome. A sidebar item
maps to `(tab + walletView)` and dispatches the existing `setTab`/`setWalletView` — do NOT fork a
second nav model or hoist per-view local state. The wallet's home sub-panels (send/receive/coins/
contacts) stay page-level actions on the wallet overview (reached via `action-*`), identical on both
surfaces. New shell copy must go through the 14-locale catalog (a bare literal fails the completeness
gate only if it is a *new id*; reuse existing ids to avoid 13 translations).

## Watch-only wallets can only ever see the UNHARDENED chain; private-key export must be PRE-synthetic (#96)

Two BLS-HD facts drive the whole #96 design, both non-obvious:

1. **Unhardened derivation commutes with taking the public key; hardened does NOT.** Deriving child
   index `i` UNHARDENED from a secret key and then taking its public key equals deriving `i`
   unhardened directly from the parent's PUBLIC key (`PublicKey.deriveUnhardenedPath` in
   chia-wallet-sdk-wasm). That is the entire mechanism behind a spend-less watch-only wallet — import
   only the master/root PUBLIC key and you reproduce every unhardened address byte-for-byte with zero
   secret material. HARDENED derivation mixes in the parent SECRET key, so it is unreachable from a
   public key alone. Consequence: a watch-only wallet (and `scanWatchBalances`/`deriveWatchAccount`)
   is UNHARDENED-ONLY by construction — funds sitting on the hardened chain of that same seed are
   invisible to a watch-only import. This is a permanent limitation, not a bug; the golden parity
   test proves the watch path lands on the exact same unhardened addresses the full-secret path does.

2. **Private-key export must hand back the PRE-synthetic account key, not the synthetic one.**
   `deriveWalletSecretKeyHex` returns the account key BEFORE `deriveSynthetic()`. Sage /
   chia-blockchain / hardware wallets all treat the pre-synthetic key as "the wallet's private key
   for this address" and re-apply the (deterministic, non-secret) synthetic offset themselves when
   signing. Exporting the POST-synthetic key would re-derive to a DIFFERENT effective signing key in
   any tool that also applies the offset — i.e. it would not control the shown address. Verified by
   reconstructing the synthetic pubkey FROM the exported hex and asserting it matches the golden
   address's `syntheticPkHex`. GOTCHA the same as `derive.ts`: `standardPuzzleHash` CONSUMES its
   PublicKey arg — never `.free()` it after.

Watch-only never gets a cached key in the offscreen vault (it is never created/imported/unlocked), so
even the dApp sign path fails closed the same way a genuinely locked wallet does; the sharper
`WATCH_ONLY` code is only wired for the direct custody actions (via `requiresSigningKey`, checked
before dispatch in the SW). An "account" (#95) is purely a label over ONE derivation index — it never
adds a second scan dimension, so #165's single-active-index model is untouched (switching an account
is literally `setActiveIndex(account.index)`).

## `CompactLayout` and `ExpandedLayout` do NOT share a header — a "global" indicator must be added to BOTH (#108)

The popup/narrow-`app.html` surface (`CompactLayout`) renders `AppHeader`; the wide `app.html`
(≥960px, `ExpandedLayout`) has its OWN hand-rolled sidebar (brand + tab list + settings/pop-out) and
never mounts `AppHeader` at all. Adding the #108 non-mainnet "Testnet" badge only to `AppHeader`
left it silently missing from the fullscreen surface — a real gap the unit suite didn't catch
(`chrome-ui.test.tsx` only renders `AppHeader` in isolation) but the Playwright screenshot pass did
(a fullscreen `network-badge` assertion timed out). Any future "show this everywhere" chrome
(banners, badges, status indicators) needs an explicit check-in-both-layouts step — grep both
`CompactLayout.tsx` and `ExpandedLayout.tsx`, don't assume one header component covers every surface.

## `aria-hidden` on a wrapper swallows a child's `role="img"` + `aria-label` (#157)

Wrapping an inline brand SVG in `<div aria-hidden="true"><svg role="img" aria-label="…">…</svg></div>`
(the instinctive move for "this is decorative") removes the WHOLE subtree from the accessibility
tree — including the SVG's own `role="img"`/`aria-label`, even though those exist specifically to
make it accessible. `getByRole('img', { name: … })` (Testing Library) and a real screen reader both
walk the accessibility tree, so both silently see nothing under an `aria-hidden` ancestor; the first
symptom is usually a confusing "no accessible elements" test failure, not a lint/type error. Rule of
thumb: if a child already carries its own accessible role + name, don't also mark an ancestor
`aria-hidden` — hide only truly decorative leaves (bare `<span>`/`<div>` glyphs with no semantics of
their own), and let a semantically-labelled child (the `DigLoader` DIG Network wordmark SVG,
`src/components/DigLoader.tsx`) be the accessible unit.

## Single active derivation index (#165) — a same-address split output must still get pairwise-distinct amounts, or duplicate CREATE_COINs collide

Migrating `prepareSplit` (coin control, `src/offscreen/coins.ts`) off the retired multi-index
gap-limit sweep removed the pool of distinct wallet addresses it used to hand one to each split
piece (`keyring[i]` for `i` in `0..outputs`). Under the single-active-index model there are only 2
addresses (unhardened + hardened at one index), so every split output now returns to the SAME
address. The naive "N equal pieces, remainder on the last" amount scheme then ties: when the split
amount divides evenly, ALL pieces get the identical amount, and `CREATE_COIN(same_ph, same_amount)`
twice in one spend collides on-chain (coin id = `hash(parent, ph, amount)` — identical inputs
produce identical, indistinguishable coin ids). The fix (`distinctSplitAmounts`) assigns
`base, base+1, …, base+outputs-2` plus a strictly-larger final piece absorbing the remainder —
algebraically provable that the final piece always exceeds the largest of the others whenever
`base > 0`, so amounts are pairwise distinct with NO per-output address diversity needed at all.
This also removes the old `SPLIT_TOO_MANY` ceiling (`outputs > keyring.length`) entirely — the
constraint was never really about "how many addresses do we have", it was "how do we keep coin ids
from colliding", and that's solvable with amounts alone.

## `buildKeyring`'s output order matters for every caller that reads `keyring[0]` as "the change/self address"

`sendFlow.ts`'s `buildKeyring` derives `[unhardened, hardened]` in that fixed order for the
requested index. A dozen call sites across `coins.ts`/`sendFlow.ts`/`offers.ts` treat `keyring[0]`
as THE self/change/destination address (never `keyring[1]`) — that convention survived the
multi-index → single-index migration (#165) unchanged only because the scheme order in the array
didn't change, just the count (was `2 × gapLimit` entries, now exactly 2). Any future change to
`buildKeyring`'s scheme ordering would silently redirect change to the wrong scheme everywhere.

## RTK Query object literals with an excess field are NOT caught by `vitest` — only `tsc --noEmit` catches them

Several existing test files (`catDiscovery.test.ts`, `coinControlVault.test.ts`, `didVault.test.ts`,
`nftMintVault.test.ts`, `nfts.test.ts`, `prepareSendRouting.test.ts`) called `buildKeyring(..., {
count: N })` / passed `gapLimit: N` in a `VaultRequest` object literal — a shape from BEFORE the
#165 rename. They kept passing at runtime (`vitest run` — plain JS, no type erasure at the call
site) even after the rename removed those fields from the real type, because the extra/renamed
field was simply ignored by the callee (which reads `opts.index`/`opts.activeIndex`, defaulting to
0 when absent) — the tests were silently exercising ONLY the default-index path regardless of what
value they thought they were passing. `npx tsc --noEmit` is the only thing that flags an excess
object-literal property (`TS2353`); a mechanical rename across many call sites is not verified
complete until typecheck is clean, not just "tests are green."

## chia-wallet-sdk-wasm's `RpcClient` has NO public JS constructor — `new RpcClient(url)` silently builds an unusable phantom instance (#148, P0: took down every wallet read)

`chia-wallet-sdk-wasm`'s wasm-bindgen-generated `RpcClient` class (`chia_wallet_sdk_wasm.d.ts`/`_bg.js`)
defines no `constructor` at all — only static factories: `RpcClient.new(coinsetUrl)`, `.mainnet()`,
`.testnet11()`. `src/offscreen/chain.ts`'s `makeWasmChainClient` called `new chia.RpcClient(coinsetUrl)`
since the coinset adapter's very first commit (#12) — this is NOT a wasm-version regression (the
resolved `chia-wallet-sdk-wasm` version + integrity hash were byte-identical across every release from
v1.39.0 through the release this shipped broken in; the bug was simply never-before-exercised, since
the whole adapter was `/* c8 ignore */`'d).

**Why it doesn't throw.** A JS class with no explicit `constructor` gets an implicit no-arg one
(`constructor(...args) {}` for a base class) — calling `new RpcClient(url)` with an argument does NOT
throw (JS never enforces arity), it just silently discards `url` and returns `Object.create(RpcClient.prototype)`
with `__wbg_ptr` never wired up (only `RpcClient.__wrap(ptr)`, called exclusively by the static
factories, sets it). Every method call on this phantom instance then dispatches into wasm with a null
self-pointer, which the Rust side rejects with `Error: null pointer passed to rust` — and that throw
happens from INSIDE a wasm-bindgen-futures async adapter callback, OUTSIDE the awaited promise's own
chain, so a `try/catch` around the call does NOT catch it in plain Node (confirmed empirically with
`--experimental-wasm-modules`: it crashes the process). In the browser/offscreen-document context it
behaves differently again — the production `withTimeout` wrapper (12s) eventually surfaces a GENERIC
vault-level error (`{code:'VAULT_ERROR', message:'vault operation failed'}`), indistinguishable at
that layer from an ordinary coinset outage, and it does NOT fire a `pageerror`/console event either.
This means an e2e/Playwright test CANNOT reliably pinpoint this exact bug by response shape or console
capture — only a real-wasm unit test (no live network, deterministic) catches it precisely; see
`src/offscreen/chain.realWasm.test.ts` for the regression test and `e2e/sw/wallet-balances.spec.ts` for
the complementary (but necessarily looser) end-user smoke test.

**Rule of thumb:** before calling `new SomeWasmBindgenClass(...)`, check the `.d.ts` for an explicit
`constructor` line — if there's only `static new(...)`/other named static factories, THAT is the real
constructor; `new` on the class itself silently builds a broken object instead of throwing.

## chia-wallet-sdk-wasm has no `Spends.addDid` / high-level DID `Action` (as of 0.33.0, confirmed at xch-dev/chia-wallet-sdk HEAD too)

The Rust driver's `Spends` struct (`crates/chia-sdk-driver`) internally tracks DIDs (`spends.dids`)
and even has an `Action::update_did` — but the wasm bindings (`crates/chia-sdk-bindings/src/action_system.rs`)
never expose a way to ADD a DID into a `Spends` session (only `addXch`/`addCat`/`addNft` exist). This
is a real, permanent bindings gap, not a version-lag issue. Every DID operation (create, transfer,
profile/metadata update, and NFT↔DID ownership assignment) must therefore be hand-built from the
low-level `Clvm.createEveDid` / `Clvm.spendDid` / `Clvm.spendNft` primitives directly, mirroring the
Rust driver's OWN internal construction (`Did::spend`, `Did::transfer`, `Did::update_with_metadata`,
`Nft::assign_owner` in `crates/chia-sdk-driver/src/primitives/{did,nft}.rs`) rather than the
`Action`/`Spends` convenience layer used for XCH/CAT/NFT-mint. See `src/offscreen/dids.ts` and
`src/offscreen/didAssign.ts`.

## A DID's `metadata` is curried into its puzzle — NOT carried by the create-coin hint — so a naive one-spend update is invisible to a chain rescan

`Did::parse_child` (`chia-sdk-driver/src/primitives/did.rs`) reconstructs a child DID's `p2PuzzleHash`
FROM THE CREATE-COIN HINT (so a transfer to a new owner is immediately observable by anyone rescanning
the chain), but reconstructs `metadata` from the PARENT coin's OWN curried value, unconditionally —
the docstring says outright: "this relies on the child... having the same metadata as the parent... If
this is not the case, the DID cannot be parsed... without additional context." A single
metadata-changing spend is therefore invisible to a hint-based rescan immediately afterward (the new
coin's parent — the coin just spent — still carries the OLD metadata in its own reveal).

**Fix (the SDK's own documented pattern, `Did::update`'s doc: "settle the DID's updated metadata and
make it parseable by wallets"):** spend TWICE — once to commit the new metadata into an EPHEMERAL
intermediate coin (built via `did.child(p2PuzzleHash, newMetadata)`, which computes the coin +
lineage proof exactly like the eve-DID commit does), then spend that ephemeral coin AGAIN self-to-self
(same target inner puzzle hash) in the SAME bundle. A later rescan reads the ephemeral coin as the
final coin's parent, whose OWN reveal now correctly carries the new metadata. See
`prepareDidProfileUpdate` in `src/offscreen/dids.ts`.

**Contrast — NFT ownership (`currentOwner`) needs no such trick.** The NFT ownership layer's
`TransferNft` condition (opcode -10) is a RUNTIME condition in the p2 spend's output — `Nft::parse_child`
reruns the transfer program from the revealed output conditions, so the new owner is directly
recoverable from one spend, same as a p2PuzzleHash hint. Only CURRIED (not condition-conveyed) state
needs the settle-spend trick.

## `chia-wallet-sdk-wasm` `Program.toString()` returns `''` for the nil atom, not `undefined` (despite the `.d.ts` signature)

`Clvm.alloc([]).toString()` (nil) is `''`; the TS binding declares `toString(): string | undefined`
but in practice never returns `undefined` for atoms tested (nil, byte atoms, string atoms). Treat a
falsy/blank string, not `=== undefined`, as "field unset" when decoding an optional on-chain metadata
value (e.g. a DID's freshly-created, never-profile-set `metadata`).

## NFT↔DID ownership-assignment announcement construction (byte-identical to `chia-sdk-driver`)

`assignment_puzzle_announcement_id(nftFullPuzzleHash, transferCondition)` =
`sha256(nftFullPuzzleHash ‖ 0xAD 0x4C ‖ treeHash(list(didLauncherId, tradePrices, didInnerPuzzleHash)))`
— note the args list for the treehash is the BARE 3-tuple `(launcherId, tradePrices, innerPuzzleHash)`,
WITHOUT the `-10` opcode prefix that the actual on-chain `TransferNft` condition carries (those are two
different encodings of related data — don't reuse one `Program` handle for both). The DID's own spend
must add BOTH `assertPuzzleAnnouncement(that id)` AND `createPuzzleAnnouncement(nftLauncherId)` — the
NFT's ownership-layer puzzle automatically creates the matching announcement the DID asserts (baked
into consensus), and automatically asserts the announcement the DID creates. Verified against
`xch-dev/chia-wallet-sdk` `crates/chia-sdk-driver/src/primitives/nft.rs` (`assign_owner`) +
`actions/update_nft.rs`. See `src/offscreen/didAssign.ts`.

## `connect-src` CSP blocks `fetch()` to arbitrary hosts even when `img-src` allows them — cache via `<img>`+canvas, not `fetch()`

The manifest's `img-src` is `'self' data: https:` (any HTTPS host, #150 — NFT art can live anywhere),
but `connect-src` is a small explicit allowlist (rpc.dig.net, coinset, dexie, coingecko, bugreport).
Reaching for `fetch(url)` to read an arbitrary NFT-art host's bytes (to cache them, #159) is CSP-
blocked for virtually every real host, REGARDLESS of the host's CORS headers — the request never
leaves the renderer. Confirmed via Playwright e2e: switching the loader from `fetch()` to an
off-screen `<img crossOrigin="anonymous">` + `canvas.drawImage`/`toBlob()` fixed it immediately,
because that request is an "image" CSP destination (`img-src`), not a "fetch" destination
(`connect-src`). Widening `connect-src` to `https:` would also fix it, but is a bigger security-surface
change (lets a compromised script READ arbitrary cross-origin responses, not just send data via a URL
like `img-src` already allows) — prefer the `<img>`+canvas route for any future "read bytes from an
arbitrary NFT-art host" need. Caveat: the canvas read needs the host to send
`Access-Control-Allow-Origin` (`crossOrigin="anonymous"` fails the load entirely otherwise) — fall back
to embedding the raw URL directly (uncached) rather than failing closed, since a PLAIN `<img src>` (no
`crossOrigin`) was never CORS-gated for display. See `src/features/collectibles/nftImageCache.ts`.

**Playwright quirk found while debugging this:** `context.route().fulfill()` does NOT enforce real
browser CORS checks on `crossOrigin="anonymous"` image loads — a mocked response with NO
`Access-Control-Allow-Origin` header still loads successfully under Playwright's CDP-based
interception (verified with an isolated probe). A CORS-rejection code path can't be e2e-proven through
route mocking; test it at the unit level (mock the loader function itself) instead.

## An `inline-flex`/`flex` row with no `overflow`/`min-width:0` silently overflows the popup sideways (#163)

`.dig-seg` (the shared wallet/network segmented control, `SegmentedControl.tsx`) was `display:
inline-flex` with no `overflow`, no `flex-shrink` handling on its buttons, and no wrap. With 5 wallet
segments (`Home | Activity | Trade | Collectibles | Identity`) it naturally sized to ~430px — wider
than the 372px popup — and neither it nor its flex-row ancestor (`.dig-toggle-row`) clipped that
overflow, so it bled into `.dig-main` (`[data-testid="popup-root"]`), which — because it already sets
`overflow-y: auto` — silently became horizontally scrollable too (per the CSS overflow spec, setting
one axis to a non-`visible` value forces the other to computed `auto`, not `visible`). Confirmed with
`el.scrollWidth - el.clientWidth` (450 vs 372 before the fix; jsdom can't catch this — `scrollWidth`/
`clientWidth` are always 0 there, so this class of bug needs a REAL layout engine: Playwright, not
vitest).

**Fix + the general pattern:** give the WIDE INNER element itself `max-width: 100%; overflow-x: auto`
(make it the scroll container, never the popup body) plus `flex: none; white-space: nowrap` on its
non-shrinking children. Bonus: setting `overflow-x` to anything but `visible` also zeroes that
element's flexbox *automatic minimum size* (normally its min-content width), which is what let it
shrink below its buttons' combined width in the first place — a plain `min-width: 0` alone would NOT
have been enough here since the element wasn't itself the overflowing flex item hitting that specific
default; the `overflow` change was necessary. Any future segmented-tab-style control (or long
mono/address row) added to a popup screen needs the same treatment, not a fixed-width guess. See
`src/styles/theme.css` (`.dig-seg`) and the Playwright guard `e2e/screenshots.spec.ts` ("has no
horizontal overflow").

## `position: sticky` headers must sit OUTSIDE the bordered card, not nested inside it (#166)

Building the shared `ViewHeader` sticky-top-bar primitive: putting it as the first child INSIDE a
screen's `.dig-card` (border + radius + shadow + background) makes the sticky strip visually clip
against the card once it pins mid-scroll — the card's rounded top edge and border scroll away
underneath the still-pinned header, leaving a visible seam. Fix: `ViewHeader` renders as a sibling
BEFORE the `.dig-card`, both wrapped in a plain (unstyled) `<div>` — so the sticky strip floats over
plain background, and the card's own border/shadow/radius scroll normally beneath it. Applies to
every future sticky in-page header, not just this one.

**Vitest/RTL trap when asserting a `.click()` navigates then asserting the closed state's absence:**
two `render()` calls of different props in the SAME `it()` (e.g. "onBack shown" then "onBack NOT
shown") both stay mounted in the same jsdom `document.body` unless you `unmount()` the first — a
`screen.queryByTestId` after the second render still finds the FIRST render's element and the
"absent" assertion passes for the wrong reason (or fails misleadingly). Either split into two `it()`s
(cleanup runs between tests automatically) or explicitly call the first render's returned `unmount()`
before the second render.

**Playwright e2e trap: `.click()` auto-scrolls the target into view before clicking**, which can leave
a scroll container's `scrollTop` non-zero afterward even though a real user click on an
already-visible element wouldn't have scrolled anything. This defeats a "reachable with ZERO
scrolling" assertion taken right after a `.click()`. Use `.click({ force: true })` (skips Playwright's
own actionability/scroll-into-view step) or explicitly reset `scrollTop = 0` before measuring — see
`e2e/sw/view-header-receive.spec.ts`.

## #154 — nearly every confirm* action already reuses `confirmSend`'s wire shape, so one enrichment fed activity-logging to nine action kinds for free

Replacing the on-chain Activity scan with a local MetaMask-style log required knowing, at broadcast
time, WHAT was just spent (asset/amount/counterparty) so the SW could write a real entry. The naive
assumption was "every action kind needs its own plumbing" — false. `confirmNftTransfer`,
`confirmNftMint`, `confirmDidCreate`, `confirmDidTransfer`, `confirmDidProfileUpdate`, and
`confirmNftDidAssign` all literally call `vault.handle({ op: 'confirmSend', pendingId })` — the SAME
vault method as a plain XCH/CAT send (`src/background/index.ts`'s case handlers just relabel the
SW-level action name; `src/offscreen/vault.ts` has exactly ONE broadcast method for all of them,
keyed off a single shared `this.pending` map). So adding ONE optional field —
`activityHint: {asset, amount, counterparty}` — captured at each `prepare*` call site (where the
real data already exists: `req.recipient` for a transfer, a synthetic `'NFT'`/`'DID'` label + null
counterparty for a self-only mint/create) and echoed back by the single shared `confirmSend` method,
gave SEVEN of the eight emitted activity kinds real data with zero new wire surface. Only
`confirmTrade` needed its own (near-identical) treatment because offers use a separate
`pendingTrades` map. The tell: before adding a new field/path per action, check whether the actions
already collapse onto one shared vault method — coin-control's `prepareSplit`/`prepareCombine` ALSO
reuse the plain `confirmSend` path, which is why a real send is distinguished from a self-only
split/combine purely by `activityHint.counterparty` being non-null, not by a separate action check.

## Receive-detection must skip the FIRST balance scan after any wallet/index switch, or a pre-existing balance reads as a fake "receive"

`walletCache.balances` already gets cleared on every wallet switch AND every `setActiveIndex` call
(`clearActiveWalletCaches`, pre-existing, unrelated to #154). Diffing "previous vs current" balance
to detect a receive (`detectReceivedEntries`) is only correct because of that existing clear: the
first `getCustodyBalances` scan after switching has NO prior snapshot, so the SW skips the delta
call entirely (`logReceivedActivity` no-ops on a missing baseline) rather than comparing against
`{xch:0, cats:{}}` and reporting the *entire* newly-active wallet's existing balance as a single
giant "received" entry. The pure `detectReceivedEntries` function itself does NOT enforce this — it
happily treats a missing baseline as zero (that's the right behavior for a genuinely brand-new
wallet) — the skip-on-first-scan policy lives entirely in the SW glue
(`src/background/index.ts`'s `getCustodyBalances` case), which is exactly the kind of policy
decision easy to accidentally omit when only unit-testing the pure function in isolation. Any future
consumer of `detectReceivedEntries` MUST replicate this "no prior snapshot → don't call it" guard,
not rely on the function to do it.

## #152 — a new VaultOp MUST be added to `src/entries/offscreen.ts`'s `NEEDS_CHIA`/`NEEDS_CHAIN` allowlists, or it silently gets empty deps and returns CHAIN_UNAVAILABLE

`Vault.handle(req, deps)` (the pure, unit-tested class in `src/offscreen/vault.ts`) is NOT what
decides whether a given op receives `deps.chia`/`deps.chain` — that's a SEPARATE, hardcoded
allowlist in the thin entry glue `src/entries/offscreen.ts` (`NEEDS_CHIA`/`NEEDS_CHAIN`, two
`Set<VaultRequest['op']>`), which is coverage-excluded (`src/entries/**`) and therefore invisible to
`npm run test:web`. Adding `listClawbacks`/`prepareClawbackAction` as new vault ops without also
adding them to BOTH sets compiled clean, passed every `vault.test.ts` unit test (those tests call
`vault.handle` directly with hand-built `deps`, bypassing `depsFor()` entirely), and passed `npx tsc`
— then failed deterministically in the real built extension with `CHAIN_UNAVAILABLE` on the very
first e2e call, because `depsFor()` returned `{}` for an op absent from `NEEDS_CHIA`. This is
precisely the class of bug e2e wiring tests exist to catch (mirroring #91/#93's own "prove it's not
the unknown-action stub" e2e pattern) — a unit-test-only verification pass would have shipped it.
**Any new `VaultOp` that reads derived keys/coinset MUST be added to both sets in
`src/entries/offscreen.ts`, and its e2e coverage MUST actually run against the built `dist/`
extension** (not just `vitest run`) before considering the op "wired."

## Chia clawback (`ClawbackV2`) is a hard on-chain CUTOVER at the deadline, not a race window

Read literally, "the recipient can only claim after the window, and the sender can reclaim before
the recipient claims" sounds like an open-ended race that could go either way after the deadline.
Verified against the real `chia-wallet-sdk-wasm` Simulator (not assumed): the underlying puzzle
enforces a STRICT, non-overlapping split at `seconds` (an absolute unix timestamp) —
`senderSpend`'s solution embeds `ASSERT_BEFORE_SECONDS_ABSOLUTE(seconds)` (valid ONLY strictly
before the deadline) and `receiverSpend`'s embeds `ASSERT_SECONDS_ABSOLUTE(seconds)` (valid ONLY
at/after it); there is no timestamp at which both are simultaneously spendable. A reclaim attempted
at/after the deadline fails on-chain (`AssertBeforeSecondsAbsoluteFailed`) exactly as reliably as an
early claim fails (`AssertSecondsAbsoluteFailed`) — confirmed empirically against a live Simulator,
not inferred from the wasm's `.d.ts` alone (the signatures alone give no hint of this; `senderSpend`/
`receiverSpend` take only a `Spend`, no explicit time parameter — the constraint is baked into the
curried puzzle from the constructor's `seconds` field). Practical upshot for any clawback UI: the
"claw back" affordance must disable/hide once the window elapses (not "race" against the receiver);
`ClawbackV2`'s own `seconds` field is always an ABSOLUTE deadline the caller computes as
`now + chosenDuration` once, never a raw duration threaded further down.

## `ClawbackV2` has a REAL public wasm constructor (unlike `RpcClient.new(...)`-only, #148) — but its memo/discovery methods split by whether they need a `Clvm`

`new chia.ClawbackV2(senderPuzzleHash, receiverPuzzleHash, seconds, amount, hinted)` is safe to call
directly (confirmed against the generated `.d.ts`: a real `constructor(...)`, not a static-`new`-only
factory) — it wraps a plain Rust data struct (`{sender_puzzle_hash, receiver_puzzle_hash, seconds,
amount, hinted}`, mirrored exactly in `xch-dev/sage`'s `child_kind.rs`), so `puzzleHash()`,
`senderSpend(spend)`, `receiverSpend(spend)`, and the static `fromMemo(...)` all take NO `Clvm`
parameter — they build/consume fully-serialized `Spend`/`Program` values that work regardless of
which `Clvm` instance's allocator produced their inputs. The ONE exception is `memo(clvm: Clvm)` —
it DOES take a `Clvm`, because the resulting memo `Program` must be curried into the SAME allocator
tree as the rest of the send driver's output (the `Spends`/`Action` machinery's `Action.send(...,
memos)` argument) for the final serialized bundle to cohere; building it against a throwaway `Clvm`
and passing the result into a different one's `Action.send` would silently produce inconsistent
output. This is why `offscreen/clawback.ts`'s `clawbackDestination()` returns a `buildMemos(clvm)`
CALLBACK rather than a pre-built memo Program — `send.ts`'s `buildXchSend` invokes it with its OWN
internal `clvm`, right before finalizing.

## `Vault.handle()`'s catch-all silently swallowed domain error codes (#179 root cause)

`vault.ts`'s `handle()` wraps every op in one `try { switch(...) } catch (e) { ... }`. The catch ONLY
special-cased `KeystoreError` (`return { code: e.code, ... }`); every OTHER thrown `Error` — including
the `CODE: message` convention used throughout `dids.ts`/`nfts.ts`/`sendFlow.ts` (`NO_XCH_COINS`,
`NO_SUITABLE_COIN`, `MISSING_KEY`, …) — fell through to a hardcoded generic `{ code: 'VAULT_ERROR',
message: 'vault operation failed' }`, discarding the real cause before it ever reached the UI. The fix
generalizes the catch to regex-extract a leading `CODE:` prefix from ANY thrown `Error.message` (the
same convention two OTHER call sites — `signDappSpend`/`signMessage` — already handled locally with
`msg.startsWith('MISSING_KEY')`), falling back to `VAULT_ERROR` only for a throw that carries no code
at all. **The regression test that should have caught this originally asserted the WRONG thing** —
`didVault.test.ts`'s `"prepareDidCreate fails NO_XCH_COINS..."` test only checked
`expect(res.code).not.toBe('NO_PENDING')`, which the generic `VAULT_ERROR` also satisfies; a test
whose name promises a specific code must assert that exact code, not merely "not some other code".
Any future vault op that throws a new domain code gets it surfaced automatically — no per-op catch
needed — but a caller-side UI still has to explicitly branch on the code to show a specific message
(the generic surfacing alone does not localize/word it); mapping it to copy is done in the feature's
own component (e.g. `CreateDid.tsx`'s `didCreateErrorMessage`).

## The Chia ecosystem's well-known "burn" address is `…dead`, not all-zero (#171)

A provably-unspendable "burn" destination for permanently destroying an asset (CAT, NFT, or plain
XCH) is NOT the all-zero puzzle hash — it is 30 zero bytes followed by `0xDE 0xAD`
(`0x000…000dead`, 32 bytes total). The mainnet bech32m address is
`xch1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqm6ks6e8mvy` (testnet:
`txch1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqm6ksh7qddh`) — documented at
docs.chia.net's Chia-burn-address FAQ entry. This is the SAME destination every Chia
wallet/explorer (Sage, Spacescan, MintGarden's "burned NFTs" graveyard) recognizes as burned, so
using it (rather than an all-zero or otherwise made-up puzzle hash) keeps a DIG-burned NFT
consistent with how the rest of the ecosystem displays/labels burns. No known preimage produces
this puzzle hash under any CLVM puzzle reveal, so a coin sent here is unspendable by anyone,
including the sender — burning is achieved by an ordinary transfer to this puzzle hash, not a
special on-chain "burn" opcode. Pinned as `NFT_BURN_PUZZLE_HASH` in
`src/offscreen/nfts.ts` (issue #171, Collectibles bulk burn) and golden-tested by decoding the
exact mainnet address string and asserting byte-identity (`nfts.test.ts`) — worth reusing verbatim
(construct as `Uint8Array(32)` with `[30]=0xde, [31]=0xad`, avoiding any hex-string transcription
risk) anywhere else in the ecosystem that needs a burn destination (CAT melt/burn, a future
dig-sdk/hub burn action, etc.) rather than re-deriving it.

## `playwright.config.ts`'s dist-web screenshot harness (`npm run screenshots`) uses a HARDCODED port shared across every parallel worktree

The dist-web static server (`python -m http.server 4173 --directory dist-web`) and `baseURL:
'http://127.0.0.1:4173'` are fixed in `playwright.config.ts`. When multiple agent lanes are working
this repo concurrently in separate git worktrees (each with its own `dist-web`, e.g. two `#16x`
issues in flight at once), every lane's `npm run screenshots` binds/serves on the SAME port — one
lane's requests silently round-robin to a SIBLING lane's server process and get its (unrelated or
absent) `dist-web` content, producing spurious 404s or wrong-build screenshots, and Playwright's own
`webServer` startup can time out (`Timed out waiting 30000ms from config.webServer`) if the port is
already bound by another lane. This is an ENVIRONMENT collision, not a code bug — `netstat -ano |
grep :4173` shows many `LISTENING` PIDs when it happens. The harness is explicitly documented as
"not part of the CI test/coverage gate" (local visual-verification only), so a blocked run here
should never block a PR; verify the underlying concern (e.g. popup horizontal-overflow risk from a
new header control) by design/inspection or via the `e2e/sw/` built-extension harness instead
(`playwright.sw.config.ts`, no static server / no shared port), and retry the dist-web harness later
when sibling lanes have quieted down. A faster local workaround when you DO need this harness NOW
(e.g. to actually run/inspect new e2e specs, not just design-review): temporarily `sed` all three
`4173` occurrences in `playwright.config.ts` to an unlikely-to-collide port, run + verify, then
revert the file to the original port before committing (git-diff the file to confirm it's back to
exactly the committed state — the port itself must never land in a real commit).

## A `position: fixed` modal nested in a mobile screen can be silently trapped — portal it (#170)

Discovered building the NFT-trade picker's XL modal: a `position: fixed` full-screen modal rendered
INLINE deep in the component tree (rather than portaled to `document.body`) can be silently confined
to a smaller ancestor box AND stacked below sibling chrome, even though `position: fixed` is supposed
to be relative to the viewport. Two independent, compounding CSS facts cause it in this codebase:

1. **A non-`none` `transform` on ANY ancestor establishes a new containing block for `position:
   fixed` descendants** — per spec this includes an ANIMATED transform that is still "in effect"
   even once its keyframe reaches `transform: none`. `.dig-screen`'s entrance animation
   (`animation: dig-screen-enter 0.22s ease both;`, `theme.css`) uses `animation-fill-mode: both`,
   which keeps the animation "in effect" (and its resolved transform reported as
   `matrix(1, 0, 0, 1, 0, 0)`, NOT the literal `none` keyword) for as long as the element exists —
   so every screen permanently carries a containing block that traps fixed descendants inside its
   own (possibly scrolled, possibly off-screen) box instead of the true viewport.
2. **Equal `z-index` + DOM order beats a high `z-index` on a deeply-nested descendant.**
   `.dig-app[data-layout='compact'] > *` forces `position: relative; z-index: 1;` onto the compact
   layout's direct children (header / `.dig-main` / the bottom `TabBar`) by SPECIFICITY (this
   universal-child selector's specificity beats `.dig-tabbar`'s own `z-index: 5` declaration, and
   `.dig-main`'s own explicit `position:relative; z-index:1` establishes ITS OWN stacking context).
   A fixed modal nested inside `.dig-main` is scoped to `.dig-main`'s LOCAL stacking context no
   matter how high its own `z-index` is — from the OUTER (`.dig-app`) context's point of view, all
   of `.dig-main`'s content paints at z-index 1 as a single unit, and the bottom `TabBar` (a LATER
   sibling at the same z-index 1) paints ON TOP of it, intercepting the modal's clicks.

Both are invisible in the compact **popup** (372×600) because the modal's "confined" box happens to
roughly fill the whole popup anyway — the bug only becomes visually obvious on a **narrow fullscreen
viewport** (`app.html` resized to a phone width), where the real browser viewport is taller than the
600px "phone frame" and a confined/mis-stacked modal leaves the real page header/nav floating outside
it. Any inline `position: fixed` modal (`Sheet`, `NftImageLightbox`) rendered from inside a
`.dig-screen` carries this same latent risk — `NftPickerModal` (#170) is the first to actually
render at true viewport-covering size on a narrow width, which is what surfaced it. **Fix: portal the
modal to `document.body`** (`createPortal` from `react-dom`) instead of relying on ordinary DOM
nesting — this escapes the ancestor chain for BOTH positioning (containing block) and stacking
(z-index context) without touching the shared layout CSS other modals still depend on. RTL's `screen`
queries and Playwright's `page.getByTestId` both search the whole document, so a portaled modal needs
no test changes. Prefer this pattern for any FUTURE full-screen/XL modal in this codebase.
`Sheet`/`NftImageLightbox` were retrofitted the same way in #200 — every overlay in this codebase now
portals to `document.body`; a NEW inline `position: fixed` overlay nested in a `.dig-screen` would
reintroduce this exact trap.

## A Manifest V3 background SERVICE WORKER's own `fetch()` IS subject to `extension_pages` CSP `connect-src` (#98)

Building `getNftMetadata` (#98 — fetching an NFT's off-chain CHIP-0007 metadata JSON from an
arbitrary `metadataUri` host), the design assumed a background service worker's own `fetch()` calls
are NOT subject to the manifest's `content_security_policy.extension_pages` directive — the
directive's NAME suggests it governs only extension HTML documents (popup, options, the offscreen
document), not the service worker script, which has no DOM/document at all. **This assumption was
empirically WRONG** in the real Chromium build this extension ships against: a `getNftMetadata` call
to a host outside `connect-src` failed with a `NETWORK_ERROR` ("Failed to fetch"), and a Playwright
`context.route()` handler registered for that exact URL was NEVER invoked — i.e. the request never
reached the network layer at all. That is the diagnostic signature of a CSP block, not a CORS
failure: a CORS-rejected request still round-trips over the real network (the browser sends it,
receives the response, and only THEN refuses to expose it to script), so `context.route()` — which
intercepts at the network layer — would still have fired. A zero-hit route with an immediate
`TypeError: Failed to fetch` is what a pre-flight CSP `connect-src` violation looks like from JS.

**Fix:** widen `connect-src` to `https:` and `host_permissions` to an all-hosts HTTPS pattern
(`manifest.json`) — the same breadth `img-src: https:` already grants remote NFT art (#150, §18.11)
— rather than trying to find an SW-specific CSP exemption that does not exist in practice. The
`host_permissions` widening is separately required for the extension's CORS-bypass fetch elevation
(most off-chain metadata hosts won't send `Access-Control-Allow-Origin`, and without
`host_permissions` covering the origin, an extension's fetch is subject to ordinary CORS like any web
page's).

**Takeaway for future SW-side network code in this extension:** do NOT assume the service worker is
exempt from the extension-pages CSP just because it isn't an HTML document. Verify empirically
(build the extension, hit a real host outside `connect-src` from the SW, check whether it reaches
the network at all) before designing around that assumption — the #122 regression test pattern
(`manifest-coinset-hosts.test.ts`) already existed for exactly this class of "the client wants a host
the manifest doesn't grant" bug, and this is the same failure mode one level more general.

## SpaceScan.io block-explorer URL formats, per entity type (#114)

SpaceScan has no published API-style spec for its human-facing page routes; the shapes below were
confirmed against LIVE indexed pages (not docs), so treat them as observed convention rather than a
guaranteed contract — re-verify before depending on a new entity type:

- Coin/transaction: `spacescan.io/coin/0x<64-hex>` — REQUIRES the `0x` prefix.
- Address: `spacescan.io/address/<xch1…>` — the bech32(m) address, unmodified.
- CAT/token: `spacescan.io/token/<64-hex>` — the bare TAIL hash, NO `0x` prefix (opposite of the coin
  route). `lib/links.ts`'s `spaceScanTokenUrl` strips a `0x` prefix if given one, so either input form
  works from a caller's perspective.
- NFT: `spacescan.io/nft/<nft1…>` — the bech32m NFT id (SpaceScan does NOT accept a raw launcher-id
  hex here); encoding a launcher id to `nft1…` is the caller's job (the wasm bech32m encoder), which
  is why `spaceScanNftUrl` only builds the URL from an already-encoded id and stays wasm-free.

## Multi-asset offers (#100) — INSPECT/TAKE/CANCEL were already array-shaped; only MAKE was single-leg

When generalizing the offer engine (`offscreen/offers.ts`) from one offered/one requested asset to
arrays of either, the read-side functions needed almost no change: `offeredSettlementLegs` (used by
`inspectOffer`/`takeOffer`/`cancelOffer`) already collected an arbitrary number of distinct CAT asset
ids into a `Set` plus XCH plus one NFT, and `parseRequested` already looped over every phantom carrier
coin — both because a chia-sdk offer's on-chain shape has NO single-asset constraint; the v1 code just
never fed more than one leg into the WRITE path (`makeOffer`). The actual multi-asset work was
concentrated entirely in `makeOffer`'s construction loop (one `Action.send`/notarized-payment/phantom
carrier per leg, all sharing one `Offer::nonce` computed over every offered coin id together) plus the
wire/UI plumbing. Lesson: when a v1 "single X" restriction is implemented as "loop once" rather than
"the format only allows one", the generalization is a pure write-path exercise — audit the read path
FIRST before assuming a full protocol rewrite is needed.

## dexie.space `api.dexie.space/v1` response shape, confirmed against the LIVE API (#102)

dexie.space has no published OpenAPI/formal spec (as of writing) — the shapes below were confirmed
against the LIVE endpoint (a `curl` against production), so treat them as observed convention rather
than a guaranteed contract:

- `GET /v1/offers/<id>` → `{success:true, offer:{id,status,offer,involved_coins,date_found,
  date_completed,date_pending,date_expiry,block_expiry,spent_block_index,price,
  offered:[{id,code,name,amount}],requested:[...],fees,mempool,related_offers,mod_version,trade_id,
  known_taker}}`.
- `GET /v1/offers?status=0&offered=<code>&requested=<code>&page=1&page_size=20` → `{success:true,
  count,page,page_size,offers:[<same per-offer shape as above>]}`.
- `POST /v1/offers` with `{offer:"offer1…"}` → success `{success:true,id,...}`; rejection (e.g. a
  non-decodable offer) → `{success:false,error_message:"Invalid Offer"}` — NOTE the field is
  `error_message`, not `error` or `message`.
- **`amount` on every offered/requested asset entry is already a HUMAN-decimal number** (e.g. `50`
  wUSDC, `33.955` XCH), NOT base units — dexie normalizes by the asset's own decimals server-side.
  Fine for display; never feed it into a spend (re-derive the real base-unit amounts from the raw
  `offer` bytes via the wallet's own offer engine instead — see `offers.ts`'s module doc on the
  offer format, and `lib/dexie.ts`'s module doc on why dexie's decoded fields are display-only).
- Offer `status` codes (undocumented, inferred from the data): `0` open, `1` pending, `2` cancelling,
  `3` cancelled, `4` completed, `5` unknown, `6` expired.

## Auto-lock TTL enforcement was alarm/idle-timing-dependent, not per-call (#76)

Before #76, EVERY point that enforces the unlock TTL — the periodic `AUTO_LOCK_ALARM` sweep, the
`chrome.idle` listener, and (critically) the dApp approval router's vault call — relied entirely on
the vault having ALREADY had its key zeroized by one of the first two triggers. Nothing checked the
unlock-expiry timestamp itself at the moment of use. Since a dApp sign/spend request can sit queued
in the SW-summoned approval window for an arbitrary time (its keepalive port deliberately keeps the
SW + vault alive so review isn't rushed), this left a real window — up to ~1 minute, the alarm's
granularity — where the TTL had numerically lapsed but the vault still held the key and would
happily sign if approved. The fix is NOT "make the alarm fire faster" (that only shrinks the window);
it's checking `getLockStateSnapshot()` fresh, from storage, at the exact point of every vault call in
the dApp router (`src/background/index.ts`'s `dappApproval` construction), refusing before ever
forwarding to the offscreen vault. **Lesson for any future auto-lock-adjacent code:** a periodic
sweep/listener is a good BACKSTOP but is never sufficient on its own for money-moving actions that
can be queued/deferred — the enforcement point has to be the actual call site, checked at call time.

## `vi.stubGlobal` is NOT undone by `vi.restoreAllMocks()` — needs `vi.unstubAllGlobals()`

`vitest.setup.ts`'s global `afterEach` calls `vi.restoreAllMocks()`, which only restores spies created
via `vi.spyOn`/`vi.fn` mocks — it does NOT touch a `vi.stubGlobal('fetch', …)` override (used to feed
a fake price/CAT-registry/etc. response into a test, e.g. `manageTokens.test.tsx`,
`approvalWindow.test.tsx`'s `mockPricesAndCatRegistry`). A `vi.stubGlobal` call PERSISTS across every
subsequent test in the file until something calls `vi.unstubAllGlobals()` — which surfaced as a real
false-negative: a "graceful degrade when fetch fails" test passed for the wrong reason (it inherited
an EARLIER test's successful fetch stub instead of hitting the real degrade path) until an explicit
`vi.unstubAllGlobals()` was added to the file's own `afterEach`. Any new test file that calls
`vi.stubGlobal` MUST pair it with `vi.unstubAllGlobals()` in its `afterEach` (see `feeField.test.tsx`
for the existing precedent) — `vi.restoreAllMocks()` alone is not enough.

## DIGWX1 vault migrated to dig-keystore-wasm (V2); wasm-bindgen "bundler" target needs Vite, not plain Node (#147 Phase B)

The vault's at-rest crypto (`src/lib/keystore/digwx1.ts`) now writes V2 records via
`@dignetwork/dig-keystore-wasm` (the canonical `dig-keystore` crate's `opaque::seal`/`sealStrong`/
`open`, consumed as a vendored `file:` dependency at `third_party/dig-keystore-wasm/` — npm publish
is blocked on an org-admin bootstrap, see that directory's `PROVENANCE.md`) instead of hand-rolled
Argon2id (`hash-wasm`) + WebCrypto AES-GCM. V1 (the old format) stays a permanent DECODE-ONLY path —
`decryptEntropy` dispatches on `record.version`; an existing user's pre-migration vault keeps
opening forever, proven by a golden-fixture test (a REAL V1 record captured once, hardcoded, never
regenerated by the current code in the same test run — a round-trip using the SAME code for both
directions would not catch two drifted implementations silently agreeing).

**Two sharp edges that will recur for any future wasm-bindgen dependency in this repo:**

1. **A wasm-pack `--target bundler` package cannot be `import()`ed in plain Node** (used by
   `wasm-pack test --node`'s harness's own Node target — different from bundler) or in Vitest
   without the `wasm()`/`topLevelAwait()` Vite plugins — it throws `ERR_UNKNOWN_FILE_EXTENSION` for
   the `.wasm` file, because the bundler target imports the wasm binary as an ES module for a
   bundler (Vite/webpack) to specially resolve, not as a file Node's loader understands natively.
   This repo's `vitest.config.ts` does NOT carry those plugins (only `vite.config.ts`, the
   production build, does). **Fix pattern (already used for `chia-wallet-sdk-wasm`, now also
   `dig-keystore-wasm`): never import the real wasm-bindgen module from a "pure" unit-tested
   module.** Define a narrow interface (`KeystoreWasm`) for exactly the calls needed, inject it via
   the module's public API, and load the REAL module only at the runtime edge
   (`src/entries/offscreen.ts`'s `getKeystoreWasm()`/`getChia()`, both `/* c8 ignore */`d — that
   file is excluded from coverage and instead proven by the real-browser Playwright e2e against the
   built extension). Vitest gets a fake (`src/test/keystoreWasmFake.ts`); the browser gets the real
   wasm binary via Vite's plugin.
2. **Vendoring a compiled wasm-pack "bundler" package as a `file:` dependency needs its own
   directory, NOT this repo's existing `vendor/`** — `vendor/` is fully `.gitignore`d (reserved for
   `scripts/bundle-walletconnect.js`'s regenerated build artifact), so anything dropped there is
   invisible to a fresh clone/CI. Use a git-TRACKED directory instead (`third_party/`) with a
   `PROVENANCE.md` recording the exact upstream commit + rebuild command, or the vendored package
   silently disappears for every consumer except the machine that created it.

## A LATER test in a `describe.serial` e2e file can find the wallet re-locked — always re-`unlockWallet` before navigating to a wallet screen (#222)

`node-wallet-source.spec.ts`'s 5th serial test ("Settings switch persists…") intermittently landed on
the "Unlock your wallet" gate instead of `ChainSourceSetting` when the WHOLE `e2e/sw` suite ran (not
when the file ran alone) — `chain-source-select` never appeared, and the `toBeVisible` wait burned
its full 20s timeout. Root cause: the offscreen vault's in-memory decrypted key (and/or the MV3
service worker itself) does not necessarily survive across the wall-clock time + real loopback I/O
several earlier serial tests take, even though `beforeAll` unlocked the wallet once at file start and
the persisted `lockState` flag says "unlocked" — the KEY material living only in the offscreen
document's memory is what actually gates the wallet screen, and that document can be torn down
independently of the flag. **Fix: call `unlockWallet` again (idempotent if already unlocked) on the
page right before navigating to any wallet-screen route**, not just once in `beforeAll` — cheap
insurance for any LATER test in a serial file, especially one following tests with real network I/O
or added waits. Applied to both `node-wallet-source.spec.ts` and `chain-source-detect.spec.ts`.

## The sandboxed e2e agent environment's headless Chromium CANNOT reach a REAL OS-level service on the host's `127.0.0.1`/`localhost` loopback — only servers started WITHIN the same test process are reachable, and only via specific literals (#222)

Tried to verify #222's auto-detect fix against an ACTUAL running dig-node at `127.0.0.1:9778` on the
agent's dev machine: `curl http://127.0.0.1:9778/` from the agent's own shell succeeds (200), but the
SAME URL fetched from the extension inside Playwright's headless Chromium (`--headless=new`) in this
sandboxed harness throws `Failed to fetch` — even a bare `fetch()` from an extension page context,
with `http://localhost:*/*` + `https://*/*` already in `host_permissions`. External network calls
(coinset.org, dexie, etc.) work fine from the SAME browser in the SAME suite, so this is loopback-only
isolation: the sandboxed browser process appears to sit in a different network namespace than the
agent's own shell/Node processes, so the host's OTHER real processes bound to `127.0.0.1`/`localhost`
are unreachable, while a Node `http.createServer` started BY THE TEST ITSELF (same process/namespace
as the browser) IS reachable — but only via the `127.0.0.5` loopback literal already adopted in
`dig-node-control.spec.ts` (binding to bare `localhost`/`127.0.0.1` still fails even for an
in-process server — see that file's header comment on Chrome's `::1`-first resolution). **Practical
rule for this harness: e2e proof of a "real dig-node" interaction MUST start its own fake server
in-process on `127.0.0.5`; it can never reach a genuinely separate real node process on
`127.0.0.1`/`localhost`, no matter how "real" that node is.** The ladder's alias-tier ORDERING
(`dig.local` before `localhost:<port>`) is instead proven at the unit level with an injected `fetch`
(`dig-node-resolve.test.ts`), which needs no real socket at all.

## Local dig-node HTTP probe blocked by extension-pages CSP `connect-src` — `ws://` local hosts were allowed but `http://` local hosts were not (#287)

A live user ran the dig-node (verified via `netstat`: `127.0.0.1:9778 LISTENING`, no `[::1]`) yet the
extension showed it permanently OFFLINE. Two contributing bugs, both in `manifest.json`/
`server-config.ts`, and BOTH were needed to actually fix connectivity — fixing only one leaves the
node unreachable:

1. **The Windows `localhost`→`::1` mismatch this entry's neighbor above already flagged in a test
   header comment** (Chrome's `::1`-first resolution) had never actually been fixed in the shipped
   default: `DEFAULT_DIG_NODE_HOST`/`parseServerHost`/`digNodeCandidates` (`server-config.ts`) all
   defaulted the local fallback to the bare word `localhost`, which Windows resolves to `::1`
   FIRST — a dig-node bound to IPv4-only `127.0.0.1` never answers there. Fixed by making the
   fallback the explicit IPv4 literal `127.0.0.1` everywhere (never a name subject to the OS
   resolver's address-family preference) — including the `middleware.ts`/`content.ts` classic
   content-script literals kept "in lockstep" with `server-config.ts`, and a second latent bug:
   `digNodeCandidates` unconditionally hardcoded the fallback candidate to the word `localhost`
   regardless of which local alias was configured, so a user who typed `127.0.0.1` to force IPv4 got
   silently rewritten back to `localhost` and hit the SAME mismatch again.
2. **The actual root cause the user's live console revealed** (this is the one that matters even
   after fixing #1): `probeDigNode()`'s `fetch('http://127.0.0.1:9778/')` was blocked by the
   extension-pages CSP `connect-src` BEFORE it ever reached the network — "Refused to connect
   because it violates the document's Content Security Policy." `connect-src` allowed the
   WebSocket variants of every local host (`ws://localhost:*`, `ws://127.0.0.1:*`, `ws://dig.local`)
   plus the unrelated `http://127.0.0.5:*` (dig-dns loopback, #175), but had NO plain-HTTP entries
   for `localhost`/`127.0.0.1`/`dig.local` at all — the trailing bare `https:` catch-all (#98, added
   for `getNftMetadata`) does not cover `http:`. So the local-node HTTP probe/JSON-RPC path was
   dead on arrival regardless of what the node bound to or what the configured default was. This is
   the SAME failure mode as the #98 entry above (an MV3 SW's own `fetch()` IS subject to
   `connect-src`) recurring one call-site later — the WS entries existing for these exact hostnames
   made it easy to assume HTTP was covered too, when CSP source lists do not fan a scheme in on any
   other scheme's behalf. Fixed by adding `http://localhost:*`, `http://127.0.0.1:*`,
   `http://127.0.0.2:*` (the dig-installer's `dig.local` hosts-entry target — dig-node binds its
   bare `dig.local` listener there, not `127.0.0.1`), and `http://dig.local` to `connect-src`, with a
   `manifest-coinset-hosts.test.ts` regression test (extended, #122's pattern) pinning that every
   host the §5.3 ladder can construct is actually in `connect-src`.

**Takeaway:** `connect-src` must list every local origin a client fetches, not just its WebSocket
sibling — a probe/health-check path and a live-status socket often target the SAME hostname over
DIFFERENT schemes, and CSP does not infer one from the other.

## Every `control.*` read is token-gated — an ext surface reading one MUST gate on pairing (#560)

The dig-node authorizes control methods with `is_authorized` (dig-node `control.rs`): **anything
matching `control.*` requires a valid paired control token**, while `dig.*` / `cache.*` /
`rpc.discover` reads are open. So `control.peerStatus` is token-gated even though the node's own
`peer.rs` comment calls it "always safe to call" — that means safe to *invoke* (won't block/crash,
returns `running:false` pre-network), NOT "needs no auth". Unpaired, the SW's `controlAuthed` handler
short-circuits with `-32030` "not paired" before the node is even reached, which RTK Query maps to an
error. Any extension surface that reads a `control.*` method (peers, upstream, hosted-stores, sync)
must therefore render behind the pairing gate (`<PairingSection>`, or `skip` the query until
`phase === 'paired'`) — the ControlTab's management sections already do. The #560 regression was the
standalone Peers tab reading `control.peerStatus` gated only on node-reachability, so an
online-but-unpaired node surfaced a dead "Couldn't load peers / try again" (retry re-fired the same
doomed query, trapping the user) instead of the pairing affordance.

**Takeaway:** node-reachable ≠ authorized. Gate any `control.*` read on pairing, not just on
`nodeOnline`; treat a `-32030` on a `control.*` query as "needs pairing" (offer the pair CTA), never
as a retryable transient error.

## The Updates tab already had a live, WS-based node version — don't build a second one (#583)

Before adding a "running dig-node version" query for #583, the obvious move (a fresh `GET /version`
fetch) turned out to be a duplicate: `getNodeLiveStatus` (#239, `nodeApi.ts`) already carries the
node's OWN reported `version` on every WS `/ws/status` snapshot — the SAME field
`LiveStatusSection.tsx` already reads for its compact "Connected · addr · vX" line — and it needs no
pairing (unlike `control.status`, which requires the token gate per the entry above). The fix was to
REUSE that existing query for `NodeVersionSection`, not add a second `getNodeVersion` action calling
`/version` — always check whether a live signal you're about to add already exists under a
differently-named query before wiring new SW plumbing (§2.0 already-shipped check applies to internal
data sources, not just whole features).

## A `*/` inside prose closes a JSDoc block comment early — esbuild fails with a confusing column error

Writing `/** … (no chrome.*/react-intl) … */` breaks: the literal `*/` inside the parenthetical ends
the `/** … */` block right there, and everything after becomes plain (broken) code — esbuild's error
points at the SECOND `*/` with "Expected \";\" but found \")\"", nowhere near the actual `*/` that
closed the comment. Any doc-comment prose mentioning a glob/wildcard immediately followed by a slash
(`chrome.*/foo`, `src/**/*.ts` is fine — three-plus stars are OK, it's specifically `*` + `/`) needs a
rewrite ("no chrome.* API, no react-intl") rather than an escape (JS block comments have no escape
for `*/`).
